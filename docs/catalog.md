# Catalog — federated network content index

> **Backend status.** This describes the catalog design. The catalog *code*
> (`catalog.hoon`, `catalog-analyzer.hoon`, the obelisk marks) now lives in
> [`grubbery-overlay/lib/`](../grubbery-overlay/lib/) and the read endpoints are
> served by the grubbery `lattice` nexus over the same `/apps/lattice/catalog-*`
> HTTP routes (per-request fibers, not a monolithic `handle-http` arm). The
> long-lived **crawler fiber** is still being brought up on the nexus; on the
> legacy `desk/` agent the crawler runs on the Behn sweep timer described below.
> Where this doc writes `/desk/lib/catalog.hoon` or `/lib/catalog`, read the
> catalog lib — `desk/lib/catalog.hoon` on the legacy agent,
> `grubbery-overlay/lib/catalog.hoon` in the nexus overlay. Obelisk state
> references ("lattice's own agent state") describe the legacy agent; the nexus
> keeps its knowledge in `know/vault` grubs but still pokes the external
> `%obelisk` for the catalog index.

## Why

`%lattice` lets a user follow publishers and subscribe to specific pages,
but there's no searchable index of what's *out there*. As the network
grows, "find me content about X" becomes the first thing a user wants to
do and the first thing an AI agent helping a user wants to do.

The four pieces we already have — `/manifest`, `%obelisk`, the Discover
screen, and the MCP tool server — give us everything we need to maintain
such an index without inventing new infrastructure. The catalog ties them
together.

## Pipeline

```
publishers  ─/manifest─▶  crawler  ─remote-scry─▶  analyzer
                                                       │
                                                       ▼
                                                urQL → obelisk
                                                       │
                              ┌────────────────────────┼─────────────┐
                              ▼                        ▼             ▼
                        Discover search       MCP catalog tools     urQL
                                                       │
                                                       ▲
                              external classifier (Claude Code /
                              daemon / agent SDK) polls + submits
```

Four stages, in order:

1. **Crawler** — discovers content by polling each publisher's `/manifest`
   (default every 6h, `+sweep-interval`) and walking each listed spur to
   latest via remote scry. The crawl set is the **union of the user's
   %contacts book and their per-file follows** (`+sweep-publishers`) — so the
   catalog indexes everyone in the contact book, not just publishers whose
   files we follow. The periodic sweep processes publishers **sequentially**
   (peak concurrency = one publisher's pages ≤ `manifest-max`); a one-off
   manual `/catalog-scan` is tagged `origin=%scan` so it never advances the
   sweep queue (only `%sweep` walks do). On each manifest finalize it
   **diffs** the new path set against the publisher's last-known set (cached
   in state as `catalog-pubpaths`) and DELETEs the catalog rows of any page
   that vanished from the index — but it SKIPS that diff when the manifest
   parse is empty or truncated (> `manifest-max`), so a transient/over-cap
   fetch can't wrongly delete live pages.
2. **Analyzer** — gemtext-aware structural extraction: title (first `#`),
   headings with depth, outbound links with labels, explicit `#tag` lines,
   content hash, word count. A link is marked **internal** (`is-internal`)
   iff it's an explicit `urb://` link or a `/`-rooted spur that resolves to
   a page in the publisher's manifest set — so relative intra-publisher
   links (the common case) are correctly graphed, not just `urb://` ones.
3. **Index** — pokes obelisk against the `catalog-*` tables (schema below).
   The page row uses a **two-poke upsert** (`+catalog-page-ensure-urql` +
   `+catalog-page-refresh-urql`): an INSERT that no-ops harmlessly if the
   row exists, plus an UPDATE of *content columns only*. This is what lets a
   periodic re-crawl refresh a page **without clobbering its
   classification** — critical because the sweep re-walks everything and
   carries no per-page freshness state. Child rows (headings/links/tags) are
   DELETE+re-INSERTed (pure derived content).
4. **Surface** — catalog reads are authenticated HTTP endpoints on the
   lattice agent (obelisk has no scry, so they can't be MCP); the LLM
   classifier reads its worklist over HTTP and writes back via a poke
   (HTTP or the `lattice-catalog-classify` MCP tool). Discover's search box
   (a later PR) compiles to the same read endpoints.

## Federation model

**Per-user local catalogs, federated by query.** Every ship indexes what
its own user can see (into its own obelisk). To search a friend's
catalog, remote-scry their `/catalog-query/<urql>/json` (public,
matching `/manifest` semantics). No global catalog, no shared catalog
ship.

Federation-ready from day one:
- Natural keys `(source, publisher, path)` — no autoincrement, no
  ship-local IDs that don't roundtrip.
- `source @p` column distinguishes "I crawled this" (`our`) from "I
  imported this from ~alice's catalog" (`~alice`). Same `(publisher,
  path)` can have multiple rows from different sources; identical `hash`
  values across sources is cross-corroboration and a future ranking
  signal.
- Public-by-default reads. Trust model is the same as `/manifest`: if a
  publisher publishes a catalog, anyone can query it.

## Categorization: bootstrap-from-zero, classifier-pulled

No shipped taxonomy. Pages enter the catalog with structural fields
populated (title, headings, links, hash) but `category = ''` and `tags
= []`. They're queryable from the moment they land; classification is a
parallel pipeline that fills in semantic columns over time.

The classifier is **pulled by external clients**, not pushed by the ship.
Because obelisk has no scry, the worklist + taxonomy READS are HTTP
endpoints (an MCP thread is synchronous and can't bridge obelisk's async
query); the WRITE is a poke, exposed both as HTTP and as an MCP tool:

- `GET /catalog-pending` — the worklist: every page still unclassified.
  Implemented as the computed query `WHERE category = ''` — no separate
  queue table to keep in sync. A fresh crawl INSERTs `category=''` (page
  appears); a classify sets a category (page drops off); the two-poke
  upsert preserves the category across re-sweeps (it never reappears).
- `GET /catalog-vocab` — every page's category column (the caller dedupes
  and drops `''`). The vocabulary is empty at cold start and grows as
  classifications come in; the classifier reads it to reuse established
  categories rather than coin near-duplicates.
- `POST /catalog-classify?url=&category=&cat-source=&confidence=` /
  `lattice-catalog-classify` MCP poke — set the category/cat-source/
  confidence on one page (a pure obelisk UPDATE of the classification
  columns). `cat-source` records provenance (`llm`/`rule`/`manual`).

Any external classifier can drive the loop — GET pending + vocab, decide,
POST/poke each result back:
- A **Claude Code session** the user invokes manually ("classify some
  pending catalog entries").
- A **daemon** (Python script with an LLM API key) running in the
  background.
- An **agent SDK script** writing to a self-curated taxonomy.

Categories are free-form (the "bootstrap your own taxonomy without bias"
goal): the ship suggests the live vocabulary via `/catalog-vocab`, it does
not impose a fixed enum.

**v1 scope:** classify sets the page's category (one axis); the `confidence`
signal is stored. A pending-review queue for *novel* categories, an
LLM-supplied `tags` axis, and a low-confidence review UI are deferred —
the `catalog-pending` table + `reason` column are reserved for those
explicit-requeue cases (`changed`/`requested`/`low-confidence`), which the
v1 computed worklist (`category=''`) does not yet populate.

## Obelisk schema (`/desk/lib/catalog.hoon`)

Eight tables under `catalog-*`, in the existing `lattice` obelisk database.
The schema lives in `+catalog-create-list` (one `CREATE TABLE` per element),
and the agent pokes **each statement separately** at boot — CREATE on an
*existing* table ERRORS ("duplicate key") and aborts the whole multi-statement
poke, so a single joined poke would never create a table added after the
existing ones on an in-place-upgraded ship. (`+catalog-create-urql` is the
joined form, retained only for the whole-schema tests.)

### `catalog-pages`

| Column     | Type   | Notes |
|------------|--------|-------|
| source     | @p     | The ship that vouches for this row. `our` when crawled locally; another @p for imported catalog data. Part of the composite PK. |
| publisher  | @p     | The ship that published the page (the source of the urb://). |
| path       | @t     | The path on the publisher (e.g. `/lib/notes/2026/intro`). |
| url        | @t     | Full `urb://<publisher><path>` for convenience. |
| title      | @t     | First `# ` heading, fallback to first non-blank line, fallback to last path segment. |
| fetched    | @da    | When the row was last refreshed. |
| hash       | @ud    | `sham` over the body cord (128-bit), stored as @ud (obelisk rejects @uv/@uvH value literals; @ud round-trips, aura immaterial for equality). Lets the crawler skip re-analyzing on no-change. |
| category   | @t     | `''` (empty cord) until classified. Singular: one primary category per page. |
| cat-source | @t     | `''` / `rule` / `llm` / `rule-fallback` / `manual` / `imported` / `author`. `''` = not yet classified; `author` = adopted from a publisher's `%meta category:` line (excluded from `+catalog-vocab-urql` so a peer can't seed the shared taxonomy). |
| confidence | @rs    | 0.0 by default; the LLM path writes 0.0–1.0. |
| word-count | @ud    | For ranking and excerpt sizing. |
| body-lines | @ud    | Quick "how big is this" without re-fetching. |

**Primary key:** `(source, publisher, path)`.

### `catalog-headings`

One row per heading on a page, ordered by position.

| Column   | Type | Notes |
|----------|------|-------|
| source, publisher, path | (see pages) | Composite FK to `catalog-pages`. |
| position | @ud  | Heading's ordinal position on the page (0-indexed). Part of PK. |
| depth    | @ud  | 1, 2, or 3 — matches gemtext `#`/`##`/`###`. |
| text     | @t   | Heading text minus the leading `#`s. |

**Primary key:** `(source, publisher, path, position)`.

### `catalog-links`

One row per outbound `=>` link on a page.

| Column      | Type | Notes |
|-------------|------|-------|
| source, publisher, path | (see pages) | Composite FK. |
| position    | @ud  | Link's ordinal position on the page. Part of PK. |
| target-url  | @t   | The link target (`urb://…` or `http(s)://…`). |
| label       | @t   | The link's human label (whatever followed the target on the `=>` line). |
| is-internal | @ud  | 1 if `target-url` resolves to another `catalog-pages` row, 0 otherwise. (@ud as boolean — obelisk's @f support is unverified at the schema-PR stage; will swap if confirmed.) |

**Primary key:** `(source, publisher, path, position)`.

### `catalog-tags`

Many-to-many — tags on a page. Mirrors the existing `tags` table for
knowledge items, but scoped to the catalog.

| Column | Type | Notes |
|--------|------|-------|
| source, publisher, path | (see pages) | Composite FK. |
| tag    | @t   | Normalized lower-case tag. |

**Primary key:** `(source, publisher, path, tag)`.

### `catalog-manifests`

Cache of each publisher's last-seen `/manifest` snapshot — lets the
periodic sweep skip publishers whose manifest hash hasn't changed.

| Column    | Type | Notes |
|-----------|------|-------|
| publisher | @p   | PK. |
| scanned   | @da  | When the manifest was last fetched. |
| hash      | @ud  | `sham` over the manifest body (see catalog-pages.hash note). |
| raw       | @t   | The raw gemtext manifest, kept for diffing the next sweep. |

### `catalog-pending`

The classifier queue, reserved for **explicit-requeue** reasons. In v1 the
worklist is computed (`/catalog-pending` = `WHERE category=''`), so a fresh
crawl does NOT write here — this table fills only when a future
`changed`/`requested`/`low-confidence` requeue lands (deferred, see v1
scope). The schema is in place so that work needs no migration.

| Column   | Type | Notes |
|----------|------|-------|
| source, publisher, path | (see pages) | Composite FK + PK. |
| queued   | @da  | When the row was queued. |
| attempts | @ud  | Times the classifier has tried (and either failed or come back below confidence). |
| reason   | @t   | `new` / `changed` / `requested` / `low-confidence`. |

### `catalog-terms`

The **inverted index** for body keyword search (feature B). One row per
(page, content term). The crawler tokenizes each page body — reusing the
analyzer's word-count tokenizer — into lower-cased, punctuation-trimmed,
stop-word-filtered terms, deduped to a frequency and capped at the top 512
by frequency. **No body text is stored**: a posting is an order-free
`(term, tf)` projection you can't reconstruct a page from (stop words and
all-but-top-512 terms dropped, positions gone) — strictly less recoverable
than the verbatim heading/link text obelisk already keeps. Replaced
wholesale per page on re-crawl (DELETE-then-INSERT, in its own poke).

| Column   | Type | Notes |
|----------|------|-------|
| source, publisher, path | (see pages) | Composite FK. |
| term     | @t   | A normalized content word. PK = (source, publisher, path, term). |
| tf       | @ud  | The term's in-page frequency (the TF in client-side TF-IDF). |

### `catalog-meta`

Author-declared per-page metadata (feature A). Currently just `summary` —
the author **category** is written straight onto `catalog-pages.category`,
so it has no column here. Refreshed every crawl; one row per page that
declares a summary.

| Column   | Type | Notes |
|----------|------|-------|
| source, publisher, path | (see pages) | Composite PK. |
| summary  | @t   | The `%meta summary:` value. |

## Read surface — HTTP endpoints (not MCP)

**Architecture correction.** The catalog read tools were originally specced
as MCP `lattice-catalog-*` tools, mirroring the knowledge read tools. That
turned out to be infeasible: the knowledge read tools work because the
knowledge store lives in **lattice's own agent state**, which an MCP
thread-builder can read synchronously via scry (`.^` on lattice's
on-peek). The catalog lives in **obelisk**, and **obelisk has no scry** —
it is queried only asynchronously (poke a urQL script, await a result
`%fact`). An MCP thread-builder is synchronous, so it can't bridge that
without lattice first mirroring the whole catalog back into scryable agent
state (which would defeat the point of using obelisk).

So catalog reads are **authenticated HTTP endpoints on the lattice agent**,
served from `handle-http` (owner-only; the same 403-gated path as every
`/know-*` endpoint). They compile their params to urQL in `/lib/catalog`
and run through `+kick-obelisk-query` — the same one-at-a-time async
obelisk bridge `/know-query` uses — so the response JSON shape matches
`/know-query`: `{ok, action, relation, count, columns, rows}`. The Kotlin
Discover search box (and any agent) calls these over the authenticated
session.

| Endpoint | Params | urQL compiler | Notes |
|----------|--------|---------------|-------|
| `GET /apps/lattice/catalog-list` | — | `+catalog-list-urql` | Every page, `ORDER BY fetched DESC`. No server-side LIMIT (obelisk has none) — callers paginate. |
| `GET /apps/lattice/catalog-explore` | `category?` `publisher?` `source?` | `+catalog-explore-urql` | Equality filters, AND-ed; any omitted. `publisher`/`source` are `@p` (slaw-validated, bare literal); `category` is `@t` (quoted + escaped). |
| `GET /apps/lattice/catalog-fetch` | `url` | `+catalog-fetch-urql` | The one full page row (`SELECT *`). |
| `GET /apps/lattice/catalog-by-tag` | `tag` | `+catalog-by-tag-urql` | `(source, publisher, path)` keys carrying the tag; resolve to rows via `catalog-fetch`. |
| `GET /apps/lattice/catalog-pending` | — | `+catalog-pending-list-urql` | The classifier worklist: pages with `category=''`, newest first. |
| `GET /apps/lattice/catalog-vocab` | — | `+catalog-vocab-urql` | Every page's category (one row each; caller dedupes + drops `''`). |
| `GET /apps/lattice/catalog-search` | `term` | `+catalog-search-urql` | `(source, publisher, path, tf)` for every page whose body contains `term`. The agent re-normalizes `term` server-side (the same `+normalize-term` as the index) so the client can't drift; one equality lookup (no IN/OR); the client fans out a multi-word query + ranks by TF-IDF. |
| `GET /apps/lattice/catalog-meta` | — | `+catalog-meta-list-urql` | `(source, publisher, path, summary)` for every author-declared `%meta summary:`; the client joins these onto the loaded rows as result snippets. |

**Body keyword search is server-indexed; substring search stays
client-side.** Obelisk's urQL has no `LIKE`/substring predicate (only
equality + comparison in `WHERE`), so title/path substring matching is done
locally over `/catalog-list`. But body **content** search no longer needs
`LIKE`: the crawler maintains an inverted index (`catalog-terms`), and
`/catalog-search` serves single-term equality lookups. The Discover box
normalizes each query word, fires one `/catalog-search` per word, and
combines them with TF-IDF (idf = `ln(total/docFreq)`), merging the body
matches with the instant local substring filter over already-loaded rows.

### The one MCP write (pokes DO work without scry)

`lattice-catalog-classify` is a real MCP tool (in `setup-catalog-mcp-tools.py`):
it pokes `%lattice-catalog [%classify url category cat-source confidence]`,
which an MCP thread-builder can issue synchronously (it's a write). It mirrors
`POST /catalog-classify`. Reads (`pending`/`vocab`/etc.) are HTTP, per the
scry constraint above — the original `pending`/`vocab`/`reclassify`/`delete`/
`restore` stubs were dropped (reads moved to HTTP; re-queue + soft-delete are
deferred — see v1 scope).

| Tool | Args | Returns |
|------|------|---------|
| `lattice-catalog-classify` | `url`, `category`, `cat-source?` (`llm`), `confidence?` (`"0.85"`) | `{classified}` |

## Body keyword search + author metadata (B + A)

**B — lexical body index.** The decisive property is that **the page body is
never persisted**. The crawler already walks the body to compute
`word-count`; the term index folds out of that same pass into `catalog-terms`
as `(term, tf)` postings — a lossy, irreversible bag-of-words (lower-cased,
stop-word/min-length filtered, deduped to a count, capped at the top 512 by
frequency). Re-crawl replaces a page's postings wholesale; page-delete
(manifest-diff, and an oversized-page skip) sweeps `catalog-terms` +
`catalog-meta` too, so a vanished or no-longer-indexable page leaves no ghost
search hits. Query is single-term equality (`/catalog-search`); the client
fans a multi-word query out and ranks by TF-IDF, since obelisk has no
`IN`/`OR`/`LIKE`.

**Known limits (v1):** the tokenizer is ASCII byte-level — it lower-cases and
edge-trims ASCII only and caps a term at 64 bytes, so non-ASCII (accented /
CJK) words are mangled or dropped from the body index (the instant local
title/path substring filter is still Unicode-aware). Multi-word body search is
**OR** over the query words (any word's TF-IDF contributes), whereas the local
substring filter matches the whole phrase — a deliberate recall/precision
split. Author `category`/`summary` are likewise byte-capped (64 / 280).

**A — author-declared metadata.** A page can carry a `%meta key: value`
preamble (`%meta category:`, `%meta summary:`) — a prefix that collides with
no existing gemtext syntax, so unmarked pages are unaffected, and which is
excluded from the title, term index, and word-count. Author **tags** already
flow through the existing `#tag` parse. The author **category** is adopted
onto `catalog-pages.category` via an UPDATE guarded by `category=''`
(`cat-source='author'`): it auto-classifies a new/unclassified page but
**never clobbers** an `llm`/`manual` label across re-sweeps. Precedence:
`manual > llm > author > rule > unclassified`. Summary lands in `catalog-meta`.

Neither table needs a state migration: both self-bootstrap at on-init/on-load,
where each catalog `CREATE TABLE` is poked **separately** — a joined CREATE
poke aborts at the first already-existing table (CREATE on an existing table
*errors*, "duplicate key", and a crud error aborts the whole multi-statement
poke), so it would never create the new tables on an in-place upgrade. (This
bit in live e2e testing — `catalog-terms`/`catalog-meta` silently uncreated on
~tyr — and is fixed by `+catalog-create-list` + per-statement pokes.) They
back-fill as the periodic sweep re-crawls. (`%meta` lines currently render as
visible page text, like the existing `#tag` convention — a future renderer
pass could hide both.)

## Phased delivery

| Phase | Scope | Status |
|-------|-------|--------|
| **0. Contract** | obelisk schema + MCP tool stubs + this doc | ✅ done |
| **1. Crawler core** | schema wired to agent boot, sequential manifest sweep + auto-sweep, analyzer, 4 read endpoints, **manifest-diff deletion**, **is-internal link resolution**, periodic auto-sweep | ✅ done |
| **2. Classifier pipeline** | `category=''` worklist (`/catalog-pending`), `/catalog-vocab`, `/catalog-classify` + `lattice-catalog-classify` MCP poke, **classification preserved across re-sweeps** (two-poke upsert) | ✅ done |
| **2b. Classifier UX** | pending-review queue for novel categories, low-confidence review UI, LLM `tags` axis, reference Python classifier daemon | deferred |
| **2c. Body search + author meta** | inverted index (`catalog-terms`) + `/catalog-search` + client TF-IDF; `%meta` author category/summary (`catalog-meta`) | ✅ done |
| **3. Push refresh** | publisher-side `on-watch /catalog` wire + subscriber fallback | overlaps 1 |
| **4. Federation** | `/catalog-query/<urql>/json` public scry + `lattice-catalog-import` MCP tool + source-aware UI | v2 |

The whole local-only catalog backend (phases 0–2) ships as one PR; the
Discover search UI (Kotlin client) is the remaining v1 user surface.
Phase 4 is v2.

## Open implementation questions (not blocking this PR)

1. **Obelisk type support.** ✅ Resolved (validated live): `@p` (bare,
   unquoted literal), `@rs` (`.85` float syntax), `@ud`, `@da`, `@t` all
   work. `@uv`/`@uvH` value literals do NOT parse on INSERT, so the content
   hash is typed `@ud` (`scot %ud`). No `LIKE`/`LIMIT`/`COUNT`/`DISTINCT`/
   `GROUP BY`. INSERT errors on a duplicate PK (never replaces); UPDATE
   no-ops on an absent row — together these shape the two-poke upsert.
   **`CREATE TABLE` on an existing table also errors** ("duplicate key") and
   aborts the whole poke — so the schema is poked one `CREATE` per poke, never
   joined (else adding a table never creates it on an upgraded ship).
2. **`/catalog-query` complexity cap.** Public scry means anyone can run
   urQL against any publisher's catalog. Need a complexity cap to prevent
   denial-of-service via expensive queries — likely `LIMIT 100` ceiling,
   no joins outside `catalog-*`, server-imposed timeout. Specifics in
   phase 4.
3. **Refresh-on-update wire format.** The `/catalog` SSE-style stream
   needs a diff schema (`{path, action: add|update|delete, hash}`). Goes
   with phase 3.
4. **Backoff and rate limits.** Crawl scope "every follow's full
   manifest" needs per-publisher backoff on errors and a per-publisher
   request budget so a single agent doesn't hammer a busy publisher.
   Defaults can land with phase 1.
