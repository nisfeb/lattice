# Lattice <-> orrery integration, lattice side

Date: 2026-10-19
Status: design, pending approval

## Intent and why

Orrery models the owner's world (people, situations, a daily brief, a Sunday review, a live digest). Lattice is the owner's pages and the shared memory their agents read. The two apps run on the same ship for the same owner. Today they barely touch: orrery can read a lattice page the owner "sends" to it, and (at version 117) orrery reads two lattice areas, the page named for a body as notes on that body, and the `orrery/preferences` memory area as rules.

This project builds the lattice side of a symmetric integration so that:

- Every agent that starts a lattice session learns what day it is and what is going on in the owner's world, in one short block, without being told.
- The owner's daily briefs and weekly reviews become durable, linkable journal pages in lattice rather than living only inside orrery.
- A page that names an orrery body (for example `person/sarah`) can show that body's current facts, pulled live from orrery.
- The owner's orrery preferences and lattice memory stay one coherent set of rules.

The design is symmetric: each app keeps its own data and serves it, and the other reads it over a consented peek road on the same ship. Orrery never writes into lattice's store (lattice's page save takes only lattice's own eval-action noun, and orrery cannot call its own ship's HTTP). Lattice likewise never writes into orrery; it reads orrery's grubs and renders them.

## Goals

- A "World, from orrery" block at the top of the session-start index, sourced from orrery's `world.json`, present only when that digest is fresh.
- Private lattice journal pages mirrored from orrery's per-day briefs and Sunday reviews, re-written only when the source record changes.
- A live facts block on the reader view of a page whose path is an orrery body id.
- One ambient, automatic peek road from lattice into orrery (no consent prompt), declared in `+weir-json`.
- Fix the `page-backlinks` bug that misses `[[name|label]]` links, which the body-page work leans on.

## Non-goals

- No consent prompt. The owner chose automatic: same ship, same owner, lattice grants itself the road. (Owner decision, 2026-10-19.)
- Orrery does not change. Everything here reads orrery's existing v117 surface. If a gap appears, it is noted, not patched from this side.
- No new general cross-app framework. This is a lattice-reads-orrery integration, built on the same `find-base` + `peek-soft` + `road:tarball` pattern orrery already uses to read lattice.

## Anti-goals (what would make this a failure even if it works)

- The world block going stale and asserting a wrong day: better absent than wrong. It must gate on freshness and degrade to nothing when orrery is quiet or absent.
- Journal pages fighting the owner's edits or duplicating on every pass: a day's page is written once per source change, and a hand edit after that is not clobbered on the next pass unless orrery's record itself moved.
- A dead `[[person/sarah]]` link or an empty facts block when orrery has no such body: the block appears only when the body exists.

## Constraints

- Orrery contract is version 117 on `nisfeb/orrery` main (e162b6a=116, 716a62a=117), live on ricsul 2026-10-19. The local orrery clone at the time of writing was stale (v103); all orrery references below are against origin/main v117.
- Instance base `R` = the dir behind `/sys/link/orrery/dest.lanes`, resolved at read time, never hardcoded.
- Grubs lattice reads (all `[/ %json]`, declared `%fall` so they survive reload):
  - `R/world.json`: `{at, day, time, zone, away, today:[{id,name,starts,time,where}], late:[{id,title,due,late_minutes}], situations:[{id,name,needs,waiting_on}] (<=12), proposed (count), text}`. `text` names the day, never the clock.
  - `R/briefs/<day>`: `{day, at, sent, tags, text, today:[{text,tags}], said, map, notes}` (same record as `brief-last.json`).
  - `R/reviews/<day>`: `{day, at, sent, text, line, notes}`.
- Browser HTTP (for the body block): `GET /apps/orrery/api/body/<kind>/<slug>` returns `body-json` `{id,kind,name,aliases,created,ship,attrs,involved,actions,observations}`; auth `%any` (owner cookie or any scoped read key).
- Peek mechanism (framework-level, stable): resolve the base through `/sys/link/<name>/dest.lanes` (mirror orrery's `+find-base`), then `peek-soft:io` with a `road:tarball` and clam the grub. A lattice page's data grub clams as a plain `@t`; a json grub clams as `json`.
- Lattice already serves `orrery.js` to the client (the "Send to orrery" button lives there). The body block extends that file.
- The session-start index is `+index-text` in `lattice-know.hoon` (pure over the know-entry map); the route that calls it is `know-index` in `app.hoon`.

## The parts, and the order

Build order: prereq, then (3) journal, (1) world, (2) body block, (4) rules. Fix the backlinks bug alongside (2).

### Prereq: the orrery read road and reader

- Declare one peek road in `+weir-json` (`app.hoon`): road `/apps/shell.shell/desks/orrery.desk/`, `why` text explaining it reads orrery's daily brief, review, and world digest so agents and journal pages stay current. This mirrors orrery's own line `/apps/shell.shell/desks/lattice.desk/`. Ambient, so a refusal is not expected; the owner's automatic grant covers it.
- Add an `orrery-base` resolver: `peek-soft:io [%& %& /sys/link/%orrery %'dest.lanes'] ~`, clam as `(list lane:tarball)` or `(set lane:tarball)`, take the first `%|` lane's path. Returns `(unit path)`, `~` when orrery is not installed. Mirror of orrery's `+find-base`.
- Add small readers over the base: `read-json` of `<base>/world.json`, a dir list of `<base>/briefs` and `<base>/reviews`, and `read-json` of a given `<base>/briefs/<day>`. All through `peek-soft`, all fail soft to `~`/empty.

### (3) Journal pages

- A scheduled pass (reuse the already-declared `/sys/behn/` road) that, when orrery is installed, lists `R/briefs` and `R/reviews`, and for each day writes a private md page via lattice's own writer (`poke-eval [%make <path> (wrap-content %md <body>)]`):
  - `journal/<day>` from a brief: body `# Brief, <day>` then the record's `text`.
  - `journal/week-<day>` from a review: body `# Review, <day>` then the record's `text`.
- Sensitivity (owner decision, 2026-10-19): the brief/review text is the owner's private day, so each journal page is marked sensitive. `%make` writes a plain page and does not set the flag, so the writer follows every `%make` with a `[%page-sensitive <path> &]` poke, and re-applies it on the idempotent rewrite path (a page read is key-scoped by path, so without this any key scoped to `journal/` would read the full brief). Only the owner and sensitivity-cleared keys see these pages.
- Idempotence: store the last-synced `at` per day (a small instance grub, `journal-synced.json` mapping day to `at`), and write a day's page again only when the source record's `at` has moved past the stored one. This is what keeps an owner's later hand edit from being clobbered on every pass, while still following a genuine orrery update.
- Rewrite bracketed ids in the text, `[situation/x]` to `[[situation/x]]`, so they become lattice wikilinks under the body-page convention in (2).
- Cadence is a builder call (see "calls I made").

### (1) World at session start

- `+index-text` gains a parameter `world=(unit @t)`; when present it emits a short section `## World, from orrery` with that text, placed before the core entries.
- The `know-index` route in `app.hoon` reads `R/world.json`, and when its `at` is within a day (fresh), passes `text` as `world`; otherwise passes `~`. No world grub, stale, or orrery absent all collapse to `~`, so the index is unchanged in those cases.
- Privacy gate (owner decision, 2026-10-19): the world `text` carries the owner's private day (calendar event names, late action titles, open situations with their needs and who they wait on), so it is treated as sensitive. The route passes `world` only when `|(?=(~ key) sensitive.scope.u.key)`, that is the owner session or a key cleared for sensitive content. A narrow-scope key gets `~`, matching how `+listed` already withholds sensitive memory from keys. Foreign ships cannot reach `/know` at all (deny-by-default), so the only exposure in question was the owner's own keys.

### (2) Body facts block

- In `orrery.js`: when the reader opens a page whose path is a valid orrery body id (`<kind>/<slug>`, two segments), fetch `GET /apps/orrery/api/body/<kind>/<slug>` under the owner's session and render a compact facts block (name, key attrs, open actions) above or beside the page body. The block appears only on a 200; a 404 (no such body) renders nothing.
- The link direction already works: `[[person/sarah]]` resolves to the page at `person/sarah`. This adds the live facts on that page.
- Backlinks bug (below) is fixed as part of this part, since the "pages that mention this body" affordance leans on `page-backlinks` catching labelled links too.

### (4) Rules (optional, lowest priority)

- The primary direction already works at orrery v117: orrery reads lattice's `orrery/preferences` area as rules.
- Optional reverse: a pass that reads orrery's `GET /api/preferences` (`{style, preferences}`) and writes them as memory entries under `user/orrery-preferences` so agents that never call orrery still see them. Marked optional because it duplicates data orrery already owns; include only if the owner wants the one-file view.

### Bugs found by the survey

1. `page-backlinks` (`app.hoon`, the `[%'GET' %page-backlinks]` route) builds `needle = "[[" name "]]"` and matches only that. A `[[name|label]]` link, which the renderer accepts, is missed. Fix: treat a link as a hit when the body contains `[[name]]` or `[[name|`. Fixed with (2).
2. The Claude plugin's `memory_read` advertises that it returns links and backlinks, but `know-read` answers only `{key, body, updated, tags}`, and there is no memory-backlinks route. Resolve by either correcting the plugin's description or adding a memory-backlinks route (memory entries wikilink with `[[name]]` too). Smaller, independent; sequence after the four asks.
3. Followed ships and page subscriptions store no content and fire no notifications. Larger and orthogonal to this integration; noted here, tracked separately, not in scope.

## Calls I made (builder's discretion, settled here)

- Consent: automatic, no prompt (owner's, 2026-10-19).
- Privacy of orrery's world data inside lattice: cleared keys and owner only (owner's, 2026-10-19). The world block and the journal pages both count as sensitive; the owner's narrow-scope keys do not see them, cleared keys and the owner session do.
- Journal pass cadence: piggyback on lattice's existing scheduled pass (the backup/mirror behn timer) rather than a new dedicated timer, so no new road and no new schedule to reason about. If that pass is too infrequent for a brief to show up promptly, fall to an hourly timer on the already-declared `/sys/behn/` road.
- Journal idempotence via a `journal-synced.json` instance grub keyed by day, rather than re-reading each page's body to diff. Cheaper and it makes "owner edited after sync" observable.
- Body block is client-side in `orrery.js` over the `%any` HTTP route, not a server-side cross-desk peek, because the route already exists, is owner-readable, and keeps orrery's `body-json` encoder as the single source of that shape.
- (4) reverse import is optional and off by default.

## Left to the builder

- The exact placement and visual density of the body facts block, within lattice's reader styling.
- The precise freshness window for the world block (default: `at` within 24h).
- Which brief fields beyond `text` (if any) are worth keeping in the journal page body.
- Whether the journal pass also mirrors `R/reviews` from day one or follows briefs first.
