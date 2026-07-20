# Lattice platform — programmable pages on grubbery

Status: design draft (2026-07-19). Supersedes the "generic explorer" framing; subsumes
the current lattice nexus rather than replacing it.

## Thesis

Hawk (`~dister-migrev-dolseg`, hawk.computer) proved a model: a tree of pages where
**page = {meta, code, data}**, the data is its own user interface, and the tree behaves
like a spreadsheet — every page a function over its subtree, updated when dependencies
change. Its weakness is distribution: sharing is clearweb-flag-or-nothing, and the whole
thing is web-first with urbit underneath.

Grubbery already provides everything hawk built *except* the programmable-page layer —
and it provides the one thing hawk lacks: **ames-native federation** (gained namespaces,
remote peeks, live remote subscriptions, per-directory ACLs bound to urbit identity).

The platform is therefore: **hawk's page model expressed in grubbery primitives, with
sharing defaulting to ames and the clearweb as an optional projection.**

One sentence: a tree-shaped programming environment for your ship, where a page you
share is *live on the other ship*, not a snapshot on a website.

## Background: the two substrates

### Hawk's model (verified against hawk.computer manual)

- Page = `{meta=info, code=mime, data=manx}`. `data` "is the ui and the data for the
  page"; `code` compiles against a command and produces a `$load` whose "ultimate aim
  is to become a $manx".
- "The state of every file is a function over the state of its subfiles"; dependencies
  eagerly resolved — a changed page passes dependents an empty command ("update if you
  need to").
- GET = peek, POST = poke. Server-side permission filtering strips elements by CSS
  class (`.need-admin`, `.unless-admin`, `.need-poke`, `.unless-poke`).
- Namespace maps directly to URLs beneath `/~~/`; trailing `/` forced so relative HTML
  links resolve.
- `?code` / `?data` / `?mime` / `?view` query params give alternate views of a node.
- Load composition: `%view` (borrow another path's data), `%twin` (borrow another
  path's code, run on the current subtree), `%lens` (recurse as if at another path),
  `%shed` (final async step, offloaded to a khan thread).
- Per-page clearweb flags: `/peek/public`, `/poke/public`. Timers via `/pulse`.

### Grubbery's primitives (verified against lib/nexus.hoon, lib/tarball.hoon)

- **Grub** = file (`[mark noun]`) + owning fiber, in a tree (`ball`/`born`) held in
  `%grubbery`'s agent state. Per-grub revision history (`hist`, clay-shaped `cass`
  cases) with `%lose` pruning and `%tag` (tags on history entries).
- **Dart** = `[%node =wire road=road:tarball =load]` — the effect vocabulary. `load`
  includes: `%make` / `%cull` / `%poke` / `%peek` (with `blot` view conversion, `case`
  historical reads, remote destinations under `/sys/ames/ships/<ship>/root/`),
  `%keep` / `%drop` (subscriptions), `%gain` (publish flag, recursive), `%sand` (set
  weir), `%lose`, `%tag`, `%firm`.
- **Weir** = per-directory ACL: `{make=(set road) poke=(set road) peek=(set road)}` —
  which *sources* may make/poke/peek here. Foreign ships enter the tree as darts from
  `/sys/ames/ships/<ship>/ship.sig`, so weirs bind permissions to urbit identity;
  usergroups compose them.
- **Fibers**: the process model (`;< bind:m`), rebuilt from grub state on reload.
  Waves (`keep` → `take-news`) are push-based invalidation. `/sys/*` bridges cover
  timers, gall, clay, dill, eyre, lick. Khan threads via spawn for heavy work.
- All state in one agent, one loom, one serial event loop (see Performance).

## Concept map

| Hawk | This platform | Status |
|---|---|---|
| axal tree of pages | grub tree | exists |
| `data.page` (manx, is its own UI) | data grub, any mark; UI derived at the edge | exists + render layer |
| `code.page` → new data on command | `.code` grub + evaluator fiber | **build (the gap)** |
| eager dependency propagation | `keep`/`take-news` waves, push-based | exists |
| peek / poke | peek surface / poke darts | exists |
| admin-vs-poke permission binary | weirs + usergroups | exists, richer |
| `/peek/public` clearweb flag | eyre public binding, per-page opt-in | build (thin) |
| sharing "on the urbit network" | `%gain` + remote peek + **remote keeps** | exists — the differentiator |
| pulse timers | `rise-wait` / sleep fibers | exists |
| `%shed` thread offload | spawn / khan | exists |
| backups | per-grub `hist` + `%lose` prune | exists, better |
| eyas (source self-hosting) | grubbery desk nexus (clay mirror) | mostly exists |
| feather/spine (styling, components) | stdlib manx helpers | build, later |

Two deliberate divergences from hawk:

1. **Data is typed, UI is derived.** Hawk stores rendered manx as the data. Here the
   data grub keeps its mark (gemtext, markdown, json, whatever) and rendering happens
   in the serve path. Pages without code are just files — the degenerate case costs
   nothing and is exactly the current lattice vault.
2. **Ames first.** Hawk's unit of sharing is a public URL. Ours is a weir grant: the
   recipient's *ship* reads (and live-subscribes to) the page over ames. Clearweb is a
   projection, not the primary surface.

## The page convention

A page is a directory:

```
notes/reading-list/
  page          <- data grub, any mark (e.g. [/gmi %page-body])
  .code         <- optional: hoon source, [/text %hoon-src]. present => programmable
  .deps         <- optional: (list road) the evaluator keeps (explicit dependencies)
```

- Meta lives in grubbery's existing history tags (`%tag`): `title=…`, `view=…`,
  `clearweb`, rather than a parallel meta file.
- No `.code` → plain file. Rendered mark-aware, versioned, shareable. All current
  lattice `know/` and `pub/` content is already this.
- Sub-pages are just subdirectories; there is no file/folder distinction to design
  because grubbery already lacks one.

## The evaluator (the one new component)

A single generic nexus arm; one fiber instance per programmable page, spawned by a
covering keep over the subtree (the same pattern as lattice's `/sub/pages`).

Loop, per page:

1. **Arm**: `keep` on `.code`, `.deps` roads, and a poke inbox.
2. **Compile** on `.code` change: `(mule |.((slap subject (ream src))))`. Failure
   writes `.error` (a grub — visible, versioned, renderable) and leaves the last good
   build running. Never crashes the fiber.
3. **Run** on command (HTTP form poke or ames dart) or on dependency wave (empty
   command = hawk's "update if you need to"):
   `(mule |.((slam build !>([cmd env]))))` → `result`.
4. **Apply**: write new data grub; emit returned darts (weir-gated like any darts).

### The subject (what page code sees)

Fixed and versioned — this is the platform's real API surface:

```hoon
::  bound into every page build
+$  env
  $:  here=rail:tarball        ::  this page's location
      cmd=(unit cage)           ::  ~ = dependency tick ("update if you need to")
      src=(unit @p)             ::  who poked (~ = self/timer)
      now=@da
      deps=(map road:tarball sage:tarball)   ::  pre-resolved declared deps
  ==
::  what page code returns
+$  result
  $:  data=(unit cage)          ::  ~ = no change (save-file suppresses no-ops anyway)
      darts=(list dart:nexus)   ::  effects, weir-gated as usual
      deps=(unit (list road:tarball))   ::  ~ = unchanged; else rewrite .deps
  ==
```

Plus library doors: manx builders (html-utils), json-utils, a `read` gate over
`deps`, and composition helpers mirroring hawk's `%view` / `%twin` / `%lens` as
functions rather than load variants.

### Dependency model: explicit, not traced

Hawk eagerly resolves discovered dependencies. We start with **declared** deps
(`.deps` grub, rewritable by the page's own result). Reasons: waves make push-based
recompute natural only for known roads; auto-tracing reads during eval requires
intercepting the subject's read gate and is a v2 refinement, not a foundation.
Cost: a page that forgets to declare a dep goes stale until poked. Acceptable;
visible; debuggable (`.deps` is readable in the explorer like everything else).

Cascade discipline: recomputes are queued, deduped per road, and budgeted per event
(N pages per activation, remainder re-queued via timer). Depth cap kills cycles with
an `.error` write instead of a loop.

## Sharing model

Three presets, all per-directory, all one poke:

| Preset | Mechanics | Who can read |
|---|---|---|
| **private** (default) | `gain=%.n`, owner-only weir | you |
| **shared** | `%gain` + weir peek granted to ships/usergroup | named ships, over ames, **live** (remote keeps) |
| **clearweb** | shared + page tagged `clearweb` → included in public eyre binding | anyone with the URL |

Notes:

- "Shared" is the platform default for *accessible* content — the recast's core
  request. The recipient's ship subscribes; edits propagate as waves; their explorer
  view is live. No accounts, no tokens: ames identity is the auth.
- Clearweb serving reuses hawk's tricks: server-rendered, permission-filtered
  (strip elements by class based on requester — owner / authorized ship via eyre
  login / anonymous), forms POST commands only where `poke` weir allows.
- Weir semantics are grubbery's, untouched. The platform only ships preset
  configurations and a UI for them.

## URLs and rendering

Adopt hawk's conventions wholesale — they are the "simple affordances" from the
original pivot idea, no browser extension required:

- Namespace maps to URL path under the app binding: `/apps/lattice/<path>/`
  (root-rebind optional, as hawk does with `/~~`).
- **Trailing slash forced** so relative links resolve.
- `?data` (raw grub, correct MIME), `?code`, `?deps`, `?history`, `?view=<blot>`
  alternate views. Blots already exist as grubbery's view-conversion mechanism —
  `?view` maps directly onto `%peek blot=…`.
- Mark-aware rendering server-side: html direct, gemtext/markdown rendered (exists in
  the nexus today), json pretty-printed, images/media via mime passthrough (hawk's
  observation that "a mime is compatible with web response types" applies to cages
  equally), unknown marks → mark-labeled raw view.
- Live views via keep-SSE (exists: `/streams`, reader auto-reload).
- Remote pages: `<path>` beginning `~ship/…` resolves through remote peek against the
  peer's gained tree — the federated dimension hawk doesn't have. `urb://` remains a
  *notation* for cross-context links; in-browser it's just a path. (`web+urb`
  registration and the mobile intent-filter wrapper stay as the optional layer-2 from
  the explorer design.)

## Performance and safety budget

User code in a single serial event loop is the hard constraint. Non-negotiables:

1. **Everything `mule`d.** A crashing page writes `.error`; the fiber survives; the
   ship never learns about it.
2. **Compile/run budget.** Long work belongs in khan threads (hawk's `%shed`
   discipline; grubbery spawn exists). The evaluator offers `spawn` in the stdlib and
   the docs say "loops and network go in threads" on page one.
3. **Metered cascades.** Queue + dedupe + per-event budget, as above.
4. **Prune by default.** Programmable pages rewrite their data constantly; default
   history cap (e.g. keep 10) applied via `%lose` on write, opt-*out* per page. The
   ship-slowdown analysis (grubbery state → loom pressure, O(state) cold-start walks)
   makes this hygiene, not preference.
5. **Cold-start discipline.** Evaluator fibers rebuild from grubs (checkpointed
   compile artifacts optional later — grubbery's `%code`/`%font` loads suggest the
   hook). No full-tree walks at boot beyond the covering keep.

Known upstream drags that this platform inherits and should keep pressure on:
validate-marks O(marks × grubs) (gwbtc/grubbery#4), startup sync sweeps (#5), dill
session mirroring growth (#9/PR #10 adjacent). Building the platform means co-owning
grubbery maintenance; that is already true in practice.

## What happens to lattice

Subsumption, not replacement:

- `know/` → private pages without code. The MCP tool surface (`lattice-*`) keeps its
  contract; it is already a thin HTTP layer over the same tree. **The memory store
  must not regress** — it is in production use by every Claude session on this
  machine.
- `pub/` → shared/clearweb pages without code.
- Catalog/obelisk → the search index over pages; the crawler's sweep targets become
  "peers whose trees I follow".
- The reader/explorer routes generalize from pub-only to any readable subtree
  (`/browse` is most of the way there).
- The Kotlin client becomes optional; the browser is the client. The Compose Android
  shell survives only as the mobile `urb://` intent-filter wrapper, if wanted.

Migration is additive: nothing in the current tree moves; `.code` shows up beside
files that want it.

## Build sequence

Each step ships something usable on ricsul; each has a verification gate.

1. **Explorer generalization** — any-subtree browsing, hawk URL conventions
   (trailing slash, `?data`/`?view`/`?history`), mark-aware rendering, SSE live.
   *Gate: browse own tree + a peer's gained tree from a phone browser (PWA).*
2. **Page convention + evaluator, explicit deps** — `.code`/`.deps`, compile-on-
   change, `.error` surfacing, budgeted recompute. First programmable page: a counter.
   *Gate: counter increments via form poke; a dependent page updates on wave; a
   deliberately broken `.code` writes `.error` and the ship stays healthy.*
3. **Command round-trip UX** — forms in rendered pages, SSE update-in-place in the
   open browser. The "it's alive" milestone.
   *Gate: two browsers open on the same page; poke in one, both update.*
4. **Sharing presets** — private/shared/clearweb pokes + explorer UI; permission-
   filtered clearweb rendering.
   *Gate: second ship live-subscribes a shared page; anonymous browser reads a
   clearweb page and cannot read a private sibling.*
5. **Stdlib + templates + manual** — the subject/`result` API frozen and documented,
   worked examples (counter, form, feed join, API-integration-via-thread). Hawk's
   lesson: the manual is half the product.
   *Gate: build a page on a phone using only the docs.*

## Decisions (settled)

- **Capped execution authority**: page code runs owner-of-its-own-subtree by default
  (`%sand` an evaluator-scoped weir at page creation); darts targeting roads outside
  the page's subtree require an explicit weir edit by the owner. Full-authority pages
  are an escalation, never a default.
- **Explicit dependencies**: `.deps` is the contract; auto-traced discovery is v2 at
  most, only if declared deps prove annoying in practice.

## Open questions

- **Command shape**: bare cage vs a small poke envelope (verb + args) — decide when
  the first two real pages exist, not before.
- **Compile artifact caching**: recompiling every `.code` at cold-start is O(pages);
  fine at tens, not at thousands. `%code`/`%font` loads hint grubbery may already
  keep artifacts — investigate before inventing.
- **Naming**: "lattice" now names the platform; whether the nexus path stays
  `/apps/lattice` or the root gets rebound is cosmetic and deferred.

## Non-goals

- Multi-language pages ("anything that compiles to nock"): hoon only. The audience is
  code-literate; the subject is the API.
- Rebuilding hawk's feather/spine styling systems up front: plain server-rendered
  HTML + one stylesheet until pages exist that need more.
- A native rendering client: the browser renders; the ship serves. Lick, native
  wrappers, and `web+urb` handlers remain optional layers from the explorer design.
- Replacing obelisk: search stays external, bridged, replaceable.
