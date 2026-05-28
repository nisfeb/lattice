# Catalog — federated network content index

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

1. **Crawler** — discovers content by polling each follow's `/manifest`
   (default every 6h) and listening to a per-publisher `/catalog` update
   stream (added publisher-side in a later PR). New or changed paths get
   queued for fetch.
2. **Analyzer** — gemtext-aware structural extraction: title (first `#`),
   headings with depth, outbound links with labels, explicit `#tag` lines,
   content hash, word count.
3. **Index** — pokes obelisk with urQL `INSERT … VALUES …` and `UPDATE`
   statements against the `catalog_*` tables (schema below).
4. **Surface** — Discover gets a search box that compiles to urQL; MCP
   tools expose query + classification surfaces for agents and external
   tooling.

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
Lattice's MCP exposes a pair of tools:

- `lattice-catalog-pending` — returns N pending pages plus the current
  vocabulary (categories, tags). The vocabulary is empty at cold start
  and grows as classifications come in.
- `lattice-catalog-classify` — submit `{url, category, tags, confidence,
  reasoning?}` for one page.

Any external classifier can drive the pipeline:
- A **Claude Code session** the user invokes manually ("classify some
  pending catalog entries").
- A **daemon** (Python script with an LLM API key) running in the
  background.
- An **agent SDK script** writing to a self-curated taxonomy.

Each pending response includes the current vocabulary, which the
classifier prompts in to bias toward reuse — same `lattice-tags`-first
idiom the know-store tools already use. Novel categories or tags enter a
pending-review queue before joining the live vocabulary; the user is the
curator, the LLM is the proposer.

Confidence and reasoning are first-class:
- `confidence < threshold` (settings, default 0.7) → flagged for review.
- `reasoning` is shown next to the proposed category in the review UI so
  the user can decide approve / rename / reject with the LLM's argument
  in hand.

## Obelisk schema (`/desk/lib/catalog.hoon`)

Six tables under `catalog_*`, in the existing `lattice` obelisk database.
The CREATE TABLE generator lives in `+catalog-create-urql` and is safe to
poke at every agent boot — CREATE is atomic in obelisk and fails harmlessly
if a table already exists (same pattern as `+obelisk-create-urql` for the
knowledge/tags tables).

### `catalog_pages`

| Column     | Type   | Notes |
|------------|--------|-------|
| source     | @p     | The ship that vouches for this row. `our` when crawled locally; another @p for imported catalog data. Part of the composite PK. |
| publisher  | @p     | The ship that published the page (the source of the urb://). |
| path       | @t     | The path on the publisher (e.g. `/lib/notes/2026/intro`). |
| url        | @t     | Full `urb://<publisher><path>` for convenience. |
| title      | @t     | First `# ` heading, fallback to first non-blank line, fallback to last path segment. |
| fetched    | @da    | When the row was last refreshed. |
| hash       | @uvJ   | Sham over the body cord. Lets the crawler skip re-analyzing on no-change. |
| category   | @t     | `''` (empty cord) until classified. Singular: one primary category per page. |
| cat_source | @t     | `''` / `rule` / `llm` / `rule-fallback` / `manual` / `imported`. `''` means not yet classified. |
| confidence | @rs    | 0.0 by default; the LLM path writes 0.0–1.0. |
| word_count | @ud    | For ranking and excerpt sizing. |
| body_lines | @ud    | Quick "how big is this" without re-fetching. |

**Primary key:** `(source, publisher, path)`.

### `catalog_headings`

One row per heading on a page, ordered by position.

| Column   | Type | Notes |
|----------|------|-------|
| source, publisher, path | (see pages) | Composite FK to `catalog_pages`. |
| position | @ud  | Heading's ordinal position on the page (0-indexed). Part of PK. |
| depth    | @ud  | 1, 2, or 3 — matches gemtext `#`/`##`/`###`. |
| text     | @t   | Heading text minus the leading `#`s. |

**Primary key:** `(source, publisher, path, position)`.

### `catalog_links`

One row per outbound `=>` link on a page.

| Column      | Type | Notes |
|-------------|------|-------|
| source, publisher, path | (see pages) | Composite FK. |
| position    | @ud  | Link's ordinal position on the page. Part of PK. |
| target_url  | @t   | The link target (`urb://…` or `http(s)://…`). |
| label       | @t   | The link's human label (whatever followed the target on the `=>` line). |
| is_internal | @ud  | 1 if `target_url` resolves to another `catalog_pages` row, 0 otherwise. (@ud as boolean — obelisk's @f support is unverified at the schema-PR stage; will swap if confirmed.) |

**Primary key:** `(source, publisher, path, position)`.

### `catalog_tags`

Many-to-many — tags on a page. Mirrors the existing `tags` table for
knowledge items, but scoped to the catalog.

| Column | Type | Notes |
|--------|------|-------|
| source, publisher, path | (see pages) | Composite FK. |
| tag    | @t   | Normalized lower-case tag. |

**Primary key:** `(source, publisher, path, tag)`.

### `catalog_manifests`

Cache of each publisher's last-seen `/manifest` snapshot — lets the
periodic sweep skip publishers whose manifest hash hasn't changed.

| Column    | Type | Notes |
|-----------|------|-------|
| publisher | @p   | PK. |
| scanned   | @da  | When the manifest was last fetched. |
| hash      | @uvJ | Sham over the manifest body. |
| raw       | @t   | The raw gemtext manifest, kept for diffing the next sweep. |

### `catalog_pending`

The classifier queue. Pages enter on first crawl with `reason='new'` and
move out when `lattice-catalog-classify` arrives with sufficient
confidence.

| Column   | Type | Notes |
|----------|------|-------|
| source, publisher, path | (see pages) | Composite FK + PK. |
| queued   | @da  | When the row was queued. |
| attempts | @ud  | Times the classifier has tried (and either failed or come back below confidence). |
| reason   | @t   | `new` / `changed` / `requested` / `low-confidence`. |

## MCP tool surface (`/scripts/setup-catalog-mcp-tools.py`)

Ten tools, namespaced as `lattice-catalog-*`. Registered separately from
the knowledge-store tools (`setup-knowledge-mcp-tools.py`) so the install
order is explicit:

```
|nuke %mcp-server  →  |revive %mcp-server
  →  python3 scripts/setup-knowledge-mcp-tools.py
  →  python3 scripts/setup-catalog-mcp-tools.py
```

### Reads

| Tool | Args | Returns |
|------|------|---------|
| `lattice-catalog-list`    | `limit?`, `offset?` | `{count, pages: [...]}`. Cheap index call. |
| `lattice-catalog-search`  | `query` | `{count, matches: [...]}`. Substring across title/headings/labels. |
| `lattice-catalog-explore` | `category?`, `tag?`, `publisher?`, `source?` | `{count, matches: [...]}`. AND-ed filter. |
| `lattice-catalog-fetch`   | `url` | `{url, title, body, headings, links, tags, category, …}` — full row. |

### Classifier pipeline

| Tool | Args | Returns |
|------|------|---------|
| `lattice-catalog-pending`    | `limit?` (default 10) | `{count, pages: [...], vocab: {categories, tags}}` |
| `lattice-catalog-classify`   | `url`, `category`, `tags`, `confidence`, `reasoning?` | `{ok}` |
| `lattice-catalog-vocab`      | — | `{categories, tags}`. Read-only; doesn't pop from queue. |
| `lattice-catalog-reclassify` | `url`, `reason?` | `{ok}`. Re-queues one page. |

### Maintenance

| Tool | Args | Returns |
|------|------|---------|
| `lattice-catalog-delete`  | `url` | `{ok}`. Soft-delete. |
| `lattice-catalog-restore` | `url` | `{ok}`. Undo. |

**Stub semantics for this PR**: each tool's thread-builder returns canned
JSON with `stub: true`. MCP clients can exercise the parameter shapes and
response shapes today; the live implementations land with the crawler.

## Phased delivery

| Phase | Scope | Status |
|-------|-------|--------|
| **0. Contract** | obelisk schema + MCP tool stubs + this doc | **this PR** |
| **1. Crawler core** | `+catalog-create-urql` wired to agent boot, manifest sweep, analyzer (rule-based extraction), real implementations for the 4 read tools | next |
| **2. Classifier pipeline** | pending queue, real implementations for the classifier-pipeline tools, pending-review UI, reference Python classifier daemon | after 1 |
| **3. Push refresh** | publisher-side `on-watch /catalog` wire + subscriber fallback (manifest diff for older publishers) | overlaps 1 |
| **4. Federation** | `/catalog-query/<urql>/json` public scry + `lattice-catalog-import` MCP tool + source-aware UI | after 1, 2 |

Phases 1–3 ship as one user-visible v1 (catalog with local-only data).
Phase 4 is v2.

## Open implementation questions (not blocking this PR)

1. **Obelisk type support.** The schema uses `@p` (ship), `@rs` (single
   precision float), and `@ud` (unsigned decimal). The current
   knowledge/tags tables only exercise `@t` and `@da`. If `@p` or `@rs`
   isn't supported in obelisk's urQL, fall back to `@t` encoding and
   coerce at read time. Will validate in phase 1.
2. **`/catalog-query` complexity cap.** Public scry means anyone can run
   urQL against any publisher's catalog. Need a complexity cap to prevent
   denial-of-service via expensive queries — likely `LIMIT 100` ceiling,
   no joins outside `catalog_*`, server-imposed timeout. Specifics in
   phase 4.
3. **Refresh-on-update wire format.** The `/catalog` SSE-style stream
   needs a diff schema (`{path, action: add|update|delete, hash}`). Goes
   with phase 3.
4. **Backoff and rate limits.** Crawl scope "every follow's full
   manifest" needs per-publisher backoff on errors and a per-publisher
   request budget so a single agent doesn't hammer a busy publisher.
   Defaults can land with phase 1.
