# Lattice <-> orrery integration (lattice side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lattice reads orrery's world digest, daily briefs, and body facts on the same ship, so every agent session is oriented, briefs become durable journal pages, and body-id pages show live facts.

**Architecture:** Lattice resolves orrery's instance through the grubbery link registry and reads its grubs over a same-ship peek road (the mirror of how orrery already reads lattice). Pure transforms (link rewrite, journal body, freshness, backlink match) live in libs and are unit-tested; the peek/write/schedule wiring lives in `app.hoon` and is verified on a live ship with orrery installed. The body facts block is client-side in `orrery.js` over orrery's existing `%any` HTTP route.

**Tech Stack:** Hoon (grubbery nexus), a small amount of browser JS. Tests via hoon-test-kit (`tests/lib/*.hoon`, `++test-*` arms). Live verification on a fake ship with orrery installed.

**Spec:** `docs/superpowers/specs/2026-10-19-lattice-orrery-integration-design.md`

## Global Constraints

- Orrery contract is version 117 on `nisfeb/orrery` main; read orrery source as `git show origin/main:<file>` (the local clone is stale at v103).
- Automatic consent, no prompt: the orrery peek road is ambient in `+weir-json`.
- Privacy: the world block and journal pages are sensitive; only the owner session and sensitivity-cleared keys see them.
- Lattice never writes into orrery. Orrery never changes in this plan.
- Resolve orrery's base at read time via `/sys/link/orrery/dest.lanes`; never hardcode it.
- Prose in comments and docs: no em-dashes. Commits pass the Doom lint (valid type, subject <=72, body wrapped <=72, no scope but `ci`), no AI attribution. Identity nisfeb.
- Each page `%make` is followed by a `[%page-sensitive <path> &]` poke for journal pages.

## Review Focus

- Orrery not installed: `+orrery-base` returns `~` and every reader and the journal pass degrade to a no-op; nothing errors. (Task 4 test.)
- Stale or missing `world.json`: `at` older than the freshness window, or no grub, yields no world block. (Task 2 `fresh-world` test; Task 5 live check.)
- Narrow-scope key at `/know-index`: no world block; owner and cleared keys get it. (Task 5 live check with a minted uncleared key.)
- Owner edits a journal page, then the pass runs again with the source record's `at` unchanged: the page is not rewritten. (Task 6 idempotence live check; Task 2 covers the `at` compare.)
- A two-segment page path that is not an orrery body (e.g. `journal/2026.10.19`): the body block's fetch 404s and renders nothing, no console error. (Task 7 test.)

---

### Task 1: Count labelled wikilinks in backlinks (bug fix)

**Files:**
- Modify: `code/lib/lattice-md.hoon` (add `+backlink-hit`)
- Modify: `code/nex/lattice/app.hoon` (the `[%'GET' %page-backlinks]` route, ~1621 and ~1645)
- Test: `tests/lib/lattice-md.hoon`

**Interfaces:**
- Produces: `++backlink-hit |=([name=tape body=tape] ^-(?))` in `lattice-md`. True when `body` contains `[[name]]` or `[[name|` (a labelled link). Exported from the `lattice-md` core so the route and tests reach it.

- [ ] **Step 1: Write failing tests** in `tests/lib/lattice-md.hoon` (`/+ md=lattice-md`): `test-backlink-plain` (`(yes (backlink-hit:md "a/b" "see [[a/b]] here"))`), `test-backlink-label` (`(yes (backlink-hit:md "a/b" "see [[a/b|Sarah]] here"))`), `test-backlink-miss` (`(yes !(backlink-hit:md "a/b" "see [[a/bc]] here"))`), `test-backlink-none` (`(yes !(backlink-hit:md "a/b" "no links"))`).
- [ ] **Step 2: Run, verify fail** — `backlink-hit` undefined. Use the run-tests MCP tool on `tests/lib/lattice-md`.
- [ ] **Step 3: Implement `++backlink-hit`** in `lattice-md.hoon`: find `[[name]]` or `[[name|` in `body` (two `find`s over the needle prefixes `"[[" name "]]"` and `"[[" name "|"`).
- [ ] **Step 4: Rewrite the route** at `app.hoon` page-backlinks: drop the local `needle`/`find` (lines ~1621, ~1645) and call `(backlink-hit:md (trip u.name) (trip bod))`.
- [ ] **Step 5: Run tests, verify pass**; confirm the hoon suite still builds.
- [ ] **Step 6: Commit** (`fix: backlinks count labelled wikilinks too`).

### Task 2: Pure orrery helpers lib

**Files:**
- Create: `code/lib/lattice-orrery.hoon`
- Test: `tests/lib/lattice-orrery.hoon`

**Interfaces:**
- Produces, all in the `lattice-orrery` core:
  - `++brief-link-rewrite |=(t=tape ^-(tape))`: rewrites each `[seg/seg]` (a bracketed token containing a `/`) to `[[seg/seg]]`, leaving `[tag]` and `[a1]` (no slash) untouched.
  - `++journal-body |=([head=tape day=@t text=@t] ^-(@t))`: returns `# <head>, <day>` then a blank line then `brief-link-rewrite`d `text`.
  - `++fresh-world |=([at=@t now=@da win=@dr] ^-(?))`: parses `at` (ISO 8601) to `@da` and returns whether `now` minus that is under `win`; malformed `at` is not fresh.

- [ ] **Step 1: Write failing tests** in `tests/lib/lattice-orrery.hoon` (`/+ lo=lattice-orrery`): `test-rewrite-id` (`[situation/x]` -> `[[situation/x]]`), `test-rewrite-skips-tag` (`[tag]` unchanged), `test-rewrite-mixed` (a line with both), `test-journal-body` (asserts the `# Brief, <day>` first line and the rewritten text are present), `test-fresh-yes` / `test-fresh-no` (an `at` inside and outside a `~d1` window against a fixed `now`), `test-fresh-malformed` (garbage `at` -> `%.n`).
- [ ] **Step 2: Run, verify fail** (core undefined).
- [ ] **Step 3: Implement the three arms** in `lattice-orrery.hoon`. For `fresh-world`, parse the ISO string with the same decoder orrery uses to emit it (`+en-iso`'s inverse; a `(unit @da)` parse, `~` -> not fresh).
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** (`feat: pure helpers for the orrery read side`).

### Task 3: index-text world block

**Files:**
- Modify: `code/lib/lattice-know.hoon` (`+index-text`, ~591)
- Test: `tests/lib/lattice-know.hoon`

**Interfaces:**
- Produces: `+index-text` gains a trailing parameter, new signature `|=([es=(map path know-entry) brief=? cap=@ud world=(unit @t)]`. When `world` is `^`, the output begins with `## World, from orrery\0a` then `u.world` then a blank line, before the memories count and the rest. When `world` is `~`, output is byte-identical to today.

- [ ] **Step 1: Write failing tests** in `tests/lib/lattice-know.hoon`: `test-index-world-present` (a small `es`, `world=`[~ 'Today is Sunday.'], asserts the output `has` "World, from orrery" and "Today is Sunday."), `test-index-world-absent` (same `es`, `world=~`, asserts the output does NOT contain "World, from orrery").
- [ ] **Step 2: Run, verify fail** (arity mismatch / missing block).
- [ ] **Step 3: Add the `world` parameter and the prepend** in `+index-text`.
- [ ] **Step 4: Update the one existing caller** at `app.hoon` know-index (~1444) to pass `~` for now (Task 5 fills it in), so the desk still builds.
- [ ] **Step 5: Run tests, verify pass; confirm build.**
- [ ] **Step 6: Commit** (`feat: index-text can lead with a world block`).

### Task 4: Orrery read road and readers (prereq, IO)

**Files:**
- Modify: `code/nex/lattice/app.hoon` (`+weir-json` ~3659; new arms near the other `io` readers)

**Interfaces:**
- Produces:
  - A new `peek` line in `+weir-json`: road `/apps/shell.shell/desks/orrery.desk/`, `why` = one sentence (no em-dash) that it reads orrery's brief, review, and world digest so agents and journal pages stay current.
  - `++orrery-base` fiber producing `(unit path)`: `peek-soft:io [%& %& /sys/link/%orrery %'dest.lanes'] ~`, clam as `(list lane:tarball)` or `(set lane:tarball)`, first `%|` lane's path; `~` when absent. Mirror of orrery's `+find-base`.
  - `++orrery-world` fiber producing `(unit json)`: read `<base>/world.json`, `~` on any failure.
  - `++orrery-days` fiber `|=(dir=@tas ...)` producing `(list @ta)`: the day grubs under `<base>/briefs` or `<base>/reviews`, `~` on failure.
  - `++orrery-doc` fiber `|=([dir=@tas day=@ta] ...)` producing `(unit json)`: read `<base>/<dir>/<day>`.

- [ ] **Step 1: Add the `+weir-json` peek line.**
- [ ] **Step 2: Implement `+orrery-base`** mirroring orrery `app.hoon:3165-3184` (read both list and set clam forms).
- [ ] **Step 3: Implement `+orrery-world`, `+orrery-days`, `+orrery-doc`** over `peek-soft:io`, each failing soft.
- [ ] **Step 4: Build and deploy to a fake ship with orrery installed** (`scripts/dev-deploy.py <url> <jar>`; orrery present, as on the spec's ~wyl). Confirm the desk builds (serves 200).
- [ ] **Step 5: Live verify via a temporary scry/debug route or dojo peek** that `+orrery-base` resolves to orrery's instance dir and `+orrery-world` returns a json with a `text` field; and that with orrery absent both return `~` (no crash). Record the check in the task notes.
- [ ] **Step 6: Commit** (`feat: read orrery over a same-ship peek road`).

### Task 5: World block at session start (part 1, IO)

**Files:**
- Modify: `code/nex/lattice/app.hoon` (the `know-index` route, ~1440)

**Interfaces:**
- Consumes: `+orrery-world` (Task 4), `fresh-world:lo` (Task 2), `+index-text` world param (Task 3), `sensitive.scope` on a key.
- Produces: no new interface; the route now passes `world=(unit @t)`.

- [ ] **Step 1: Wire the route**: read `+orrery-world`; compute `cleared=|(?=(~ key) sensitive.scope.u.key)`; set `world` to `[~ text]` only when `cleared` AND the json has a `text` string AND `(fresh-world:lo at now ~d1)`; else `~`. Pass it into `index-text:lk`.
- [ ] **Step 2: Build and deploy** to the orrery-equipped fake ship.
- [ ] **Step 3: Live verify** `GET /apps/lattice/know-index` under the owner cookie shows the "World, from orrery" block; under a minted uncleared key it does NOT; after ageing `world.json` past the window (or with orrery absent) it does not. Use `scripts/hoon-test-kit/ship-cookie.sh` for the owner jar and the key-mint route for the key.
- [ ] **Step 4: Commit** (`feat: agents see orrery's world at session start`).

### Task 6: Journal pages (part 3, IO)

**Files:**
- Modify: `code/nex/lattice/app.hoon` (new `+orrery-journal-pass` fiber; wire it into the existing scheduled mirror/behn loop ~574; a `journal-synced.json` instance grub)

**Interfaces:**
- Consumes: `+orrery-base`, `+orrery-days`, `+orrery-doc` (Task 4); `brief-link-rewrite:lo`, `journal-body:lo` (Task 2); the writer `poke-eval [%make <path> <cord>]` and `wrap-content`; the sensitive poke `[%page-sensitive <path> &]`.
- Produces: `++orrery-journal-pass` fiber producing `~`.

- [ ] **Step 1: Implement `+orrery-journal-pass`**: if `+orrery-base` is `~`, no-op. Else read `journal-synced.json` (day -> `at`); for each brief day whose record `at` is lexically greater than the stored `at` (or absent), `%make` `journal/<day>` with `(wrap-content %md (journal-body:lo "Brief" day text))`, then `[%page-sensitive /journal/<day> &]`, then update the synced map; same for reviews into `journal/week-<day>` with head `"Review"`. Write `journal-synced.json` once at the end.
- [ ] **Step 2: Wire it into the scheduled loop** that already re-arms on `/sys/behn/` (the mirror/backup pass), so each tick runs the journal pass; no new road.
- [ ] **Step 3: Build and deploy** to the orrery-equipped fake ship with at least one brief and one review present.
- [ ] **Step 4: Live verify**: after a tick, `journal/<day>` and `journal/week-<day>` exist, carry the rewritten text with `[[situation/x]]` links, and are sensitive (an uncleared key gets 404 on page-source; owner reads them). Edit a journal page by hand, run the pass again with orrery's record unchanged, confirm the page is untouched; then move orrery's record `at` and confirm the page is rewritten.
- [ ] **Step 5: Commit** (`feat: mirror orrery briefs and reviews as journal pages`).

### Task 7: Body facts block (part 2, client)

**Files:**
- Modify: `code/nex/lattice/ui-app/orrery.js`
- Test: `scripts/` puppeteer check (extend an existing ui script or add one)

**Interfaces:**
- Consumes: orrery `GET /apps/orrery/api/body/<kind>/<slug>` (`body-json`), under the owner session.

- [ ] **Step 1: Write a failing UI check** (puppeteer, model it on `scripts/ui-*.mjs`): open a reader page at a known body path (`person/<slug>`) on the orrery-equipped ship and assert a facts block with the body `name` appears; open a two-segment non-body page (`journal/<day>`) and assert NO facts block and no console error.
- [ ] **Step 2: Run, verify fail** (no block yet).
- [ ] **Step 3: Implement in `orrery.js`**: on the reader view, when the page path is two segments, `fetch` `/apps/orrery/api/body/<path>`; on 200 render a compact block (name, a few `attrs`, open `actions`) into the reader; on non-200 render nothing. Bump the SW `V`-covered shell only if `orrery.js` is part of it (it is imported as a shell asset).
- [ ] **Step 4: Run the UI check, verify pass.**
- [ ] **Step 5: Commit** (`feat: a body-id page shows live orrery facts`).

### Task 8 (optional): Reverse prefs import (part 4)

**Files:**
- Modify: `code/nex/lattice/app.hoon` (extend the journal/mirror pass)

**Interfaces:**
- Consumes: orrery `GET /api/preferences` via the same peek base or HTTP; the memory writer.

- [ ] **Step 1: Decide with the owner whether to build this** (off by default per the spec). If yes: on the scheduled pass, read orrery's preferences and write/update memory entries under `user/orrery-preferences`, skipping when unchanged.
- [ ] **Step 2: Build, deploy, live verify, commit** (`feat: orrery preferences mirrored into memory`).

---

## Self-review notes

- Spec coverage: prereq (Task 4), part 1 (Tasks 3+5), part 2 (Task 7), part 3 (Tasks 2+6), part 4 (Task 8 optional), backlinks bug (Task 1). Bug 2 (memory backlinks/plugin doc) and bug 3 (subscriptions notify) are out of scope per the spec and not tasked here.
- Pure logic is unit-tested (Tasks 1, 2, 3); IO and schedule wiring is build-plus-live-verified (Tasks 4, 5, 6) because it cannot run without a ship, which matches lattice's existing practice; the client block is puppeteer-checked (Task 7).
- Type consistency: `+index-text`'s new `world=(unit @t)` is defined in Task 3 and consumed in Task 5; `fresh-world`/`brief-link-rewrite`/`journal-body` defined in Task 2 and consumed in 5/6; `+orrery-base`/`+orrery-world`/`+orrery-days`/`+orrery-doc` defined in Task 4 and consumed in 5/6; `backlink-hit` defined and used in Task 1.
