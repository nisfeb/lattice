# Published-page marks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow each published page into the scry namespace under the mark that matches its view mode, make the reader render by that mark, and re-grow existing pages once so federated and external readers get the right format on the wire.

**Architecture:** One shared mode resolver (`+published-mode`) feeds three paths in `code/nex/lattice/app.hoon`: the publisher (`+grow-pub-page` grows under the mode's mark), the reader (the remote read path carries the mode up to the address-bar handler, which renders by mark with a `%gmi`/`+looks-html` fallback), and a once-guarded on-load migration that re-grows the latest revision of every own page under its correct mark. Ships as one desk release.

**Tech Stack:** Hoon (`code/nex/lattice/app.hoon`, `code/lib/lattice-pg.hoon`); grubbery nexus scry/keen; fake-ship integration tests via `scripts/lib/harness.mjs` and the fast-loop write-text deploy.

**Spec:** `docs/superpowers/specs/2026-10-27-published-page-marks-design.md` (mirror: lattice wiki `specs/2026-10-27-published-page-marks`). The plan argues from the spec; read both.

## Global Constraints

- Hoon only, in `code/nex/lattice/app.hoon` and `code/lib/lattice-pg.hoon`. No UI (`ui-src`) change. Desk release: bump `code/version.json` as the final step (the one thing that makes ricsul and its subscribers sync).
- No new mark files on the reading ship. `%keen-response` carries `[mark=@tas body=noun]` opaquely; `+keen-page-raw` (`app.hoon:12290`) already narrows the body to `@t`. Widening the accepted mark set is a gate change, not a new mark definition.
- Mark set = the `view-mode:pg` tags: `?(%text %html %gmi %md %js %css %noun)` (`lattice-pg.hoon:16`). The view-mode-to-mark mapping is the identity on these tags.
- One shared mode resolver `+published-mode` is the ONLY source of a page's mode for publisher, reader, and migration. Absent or malformed show grub resolves to `%gmi`, NOT `+read-show-mode`'s `%text` default.
- Keep `+looks-html` as the render fallback for exactly one case: a resolved mode of `%gmi`. A plain-`%gmi` body (legacy page, old revision, un-upgraded peer) must render exactly as today.
- The migration re-grows page bindings only, at their existing spurs. It NEVER calls `+grow-pub-index` or writes `/pub/meta`, and it runs once (guarded by a stamp written last).
- Prose and comments: no em-dashes. Commits as `nisfeb <business@nisfeb.com>`, no AI attribution, pass the Doom commit-msg lint (valid type, no scope except `ci`, subject <=72, body wrapped <=72).
- Verify on fake ships before shipping; cross-ship behavior needs two ships (one publishes, one keens). Never deploy to ~ricsul-bilwyt without an explicit go.

## Review Focus

- **Modeless own page** (published, no `/page` show grub): must render `%gmi` (today's behavior), not `%text`. If the reader took `+read-show-mode`'s default it would show escaped `<pre>` to the owner while peers saw gemtext. Pinned by Task 1's test and exercised in Task 3.
- **Legacy plain-`%gmi` page** (old revision, or a peer still on old code): the reader must keep the `+looks-html` sniff and render as today. Pinned by Task 3's legacy test.
- **Peer read that misses the keen path** and falls to the slow peek (`+peek-peer-page`, `:8434`): no mark is available, so the resolved mode must be `%gmi`. Pinned by Task 3's slow-peek test.
- **Migration idempotency**: a second boot after the stamp is current must NOT re-grow anything (no new gall cases, no cache churn). Pinned by Task 4's second-boot test.
- **`%noun` page**: grows and reads under `%noun`; the reader renders it through the text path rather than crashing or blanking. Pinned by Task 2/Task 3.

---

### Task 1: `+published-mode` shared mode resolver

**Files:**
- Modify: `code/nex/lattice/app.hoon` (add the arm near `+read-show-mode`, `:5697`)
- Test: `scripts/pubmode-test.hoon` (hoon-test-kit) for the pure mapping/fallback, if the mapping is extracted as a pure gate; otherwise a fake-ship check folded into Task 2.

**Interfaces:**
- Consumes: `+read-show-mode` (`:5697`), which returns `view-mode:pg` and already defaults to `%text` when the show grub is absent or malformed.
- Produces: `+published-mode |=(rel=path)` -> `form:m` yielding `view-mode:pg`. It reads `+read-show-mode` on `/page/<rel>`, but maps an **absent or malformed** show grub (the case `+read-show-mode` would answer `%text` by default) to `%gmi`. A page WITH an explicit `%text` show grub still resolves to `%text`; only the absent/malformed case differs. Also produce a pure helper `+mode-mark |=(view-mode:pg)` -> `@tas` = the identity tag, the single place the view-mode-to-mark mapping lives.

- [ ] **Step 1: Decide the absent-vs-explicit distinction.** `+read-show-mode` collapses "no grub" and "explicit %text" to the same `%text`. `+published-mode` needs them distinct (absent -> `%gmi`, explicit `%text` -> `%text`). Read `+read-show-mode` (`:5697`-onward) and choose: either read the show grub directly in `+published-mode` (distinguishing absent) or add an absent-aware variant. Record the choice in a comment.
- [ ] **Step 2: Write the pure-mapping test** (if `+mode-mark` is pure): assert `+mode-mark` is identity on every `view-mode:pg` tag, and that an absent show grub yields `%gmi` while an explicit `%text` yields `%text` (fixture or mocked read).
- [ ] **Step 3: Run it, expect failure** (arm undefined).
- [ ] **Step 4: Implement `+published-mode` and `+mode-mark`.**
- [ ] **Step 5: Run it, expect pass.** Then `make` / compile-check the nexus on a fake ship (`?info=1` bang null).
- [ ] **Step 6: Commit** (`feat: add published-mode resolver`).

### Task 2: Publisher grows under the view-mode mark

**Files:**
- Modify: `code/nex/lattice/app.hoon` — `+grow-pub-page` (`:11816`) and its callers (`:11628`, `:11949`); fix the stale comment at `:11814`.
- Test: `scripts/ui-pubmarks.mjs` (new), or an HTTP script, publishing on one fake ship and inspecting the grown binding's mark.

**Interfaces:**
- Consumes: `+published-mode` and `+mode-mark` (Task 1).
- Produces: `+grow-pub-page |=([salt=@ key=path body=@t rev=@ud mode=view-mode:pg])` growing `[(mode-mark mode) body]` at the unchanged `+page-spur`. Callers resolve `mode` via `+published-mode` on the page's rel before calling.

- [ ] **Step 1: Write the failing test.** On fake ship A, publish one page per format (`md`, `html`, `text`, `css`, `js`, `gmi`, and a `noun` page) via `page-save` + `page-share`. For each, read the grown spur `/pub/page/<rel>/<id>` and assert its mark equals the page's view mode (e.g. `md` -> `%md`). The id comes from `/pub/revs`; the mark-read mechanism (a grubbery ball peek with `?info=1`, or a same-ship keen) is builder's choice, named in the test.
- [ ] **Step 2: Run it, expect failure** (everything comes back `%gmi`).
- [ ] **Step 3: Add the `mode` parameter to `+grow-pub-page`**, grow under `(mode-mark mode)`, and fix the `:11814` comment to say the page rides its view-mode mark and the body is its own-format source.
- [ ] **Step 4: Update callers** (`:11628`, `:11949`) to resolve `+published-mode` and pass it.
- [ ] **Step 5: Run the test, expect pass.** Confirm the nexus compiles (`?info=1` bang null).
- [ ] **Step 6: Commit** (`feat: publish pages under their view-mode mark`).

### Task 3: Reader renders by mark

**Files:**
- Modify: `code/nex/lattice/app.hoon` — `+read-page-body-rev` (`:8400`, the `:8429` gate and return type), `+read-page-body` (`:8353`), `+read-page-or-index` (`:8365`), and the address-bar handler (`:1395`-`:1454`, the `+looks-html` branch at `:1432`).
- Test: extend `scripts/ui-pubmarks.mjs` to a two-ship read.

**Interfaces:**
- Consumes: `+keen-page-raw` (`:12290`, already returns `[mark body]`), `+published-mode` (Task 1).
- Produces: the remote read arms carry a `view-mode:pg` up with the body. Shape (builder refines): `+read-page-body-rev` -> `(unit [rev=@ud mode=view-mode:pg body=@t])`; `+read-page-or-index` -> `(unit [rel=path mode=view-mode:pg body=@t])`. The handler renders by `mode`, using `+looks-html` only when `mode` is `%gmi`.

- [ ] **Step 1: Write the failing tests** (two ships, A publishes, B keens):
  - B reads A's `md`/`text`/`css` page -> rendered as that format, NOT gemtext (assert a format-specific marker in the HTML, e.g. a `<pre>` for text, a rendered `<h1>` for md).
  - B reads A's `html` page -> framed sandboxed (peer markup untrusted), same as today.
  - Own-ship: A reads its own `md` page via the reader -> rendered as markdown (this already works after resolving mode locally; assert it).
  - **Modeless own page**: seed an own published page with no `/page` show grub, read it -> renders `%gmi` (gemtext), not escaped `<pre>`.
  - **Legacy plain-`%gmi`**: a page grown as plain `%gmi` (e.g. an old revision, or force a `%gmi` grow) with an HTML-ish body starting `<` -> still rendered HTML via `+looks-html`; with a non-`<` body -> gemtext. Behavior identical to today.
- [ ] **Step 2: Run them, expect failure** (md/text/css come back gemtext; others may pass).
- [ ] **Step 3: Widen the keen gate** at `:8429` to accept any `view-mode:pg` mark (not only `%gmi`) and carry the mark up as the mode.
- [ ] **Step 4: Plumb the mode** through `+read-page-body-rev` / `+read-page-body` / `+read-page-or-index`. For own pages resolve `+published-mode` locally (the vault is `%gmi`-keyed, so the mark there is not the mode). For the slow-peek fallback (`+peek-peer-page`, `:8434`), there is no mark: resolve the mode to `%gmi`.
- [ ] **Step 5: Render by mode** at the handler (`:1432`): dispatch on `mode` reusing the existing per-mark renderer (`+preview-inner` `:8847` / the `/x` dispatch `:9422`,`:9523`), keeping the untrusted-peer HTML sandbox logic (`:1435`-`:1449`) keyed off `mode`. Use `+looks-html` only when `mode` is `%gmi`.
- [ ] **Step 6: Run the tests, expect pass.** Confirm compile (`?info=1`).
- [ ] **Step 7: Commit** (`feat: reader renders published pages by mark`).

### Task 4: One-time migration re-grows existing pages under their mark

**Files:**
- Modify: `code/nex/lattice/app.hoon` — add a migration arm, call it from the nexus-rise path, and declare the guard stamp in `on-load`'s `%fall` block (near `/pub/meta`, `:188`).
- Test: extend the fake-ship script with a pre-seed + boot + second-boot check.

**Interfaces:**
- Consumes: `+published-mode`, `+grow-pub-page` (now mode-taking), the page enumeration (`+read-pub-index` names / the revision list), `+page-spur`.
- Produces: a migration arm that, when the stamp is behind `migration-version`, iterates own published pages, and for the LATEST revision of each re-grows `+grow-pub-page` under `(mode-mark (published-mode rel))`, then writes the stamp. No `/pub/index` or `/pub/meta` write.

- [ ] **Step 1: Write the failing test.** On a fake ship, with the OLD publisher behavior, publish a `md` page (grown `%gmi`). Deploy the new nexus. Boot. Assert the page's latest-rev spur now carries mark `%md`. Then boot a SECOND time and assert no new gall case was created for that spur (the stamp is current, nothing re-grew).
- [ ] **Step 2: Run it, expect failure** (no migration yet; spur stays `%gmi`).
- [ ] **Step 3: Declare the guard stamp** as a `%fall` nexus file in `on-load` (`:188` neighbourhood), e.g. `[/pub %marks-migrated]` holding a `@ud` version, defaulting 0.
- [ ] **Step 4: Implement the migration arm**: read the stamp; if `< migration-version`, enumerate own published pages, for each take the latest rev + id, resolve the mode, `+grow-pub-page` at the same spur under the mark; write the stamp LAST (so a crash mid-batch re-runs rather than skips). Batch through the serialized writer without wedging. Never touch the index/counter.
- [ ] **Step 5: Wire the call** into the nexus-rise / load path so it runs on upgrade.
- [ ] **Step 6: Run the test, expect pass** (first boot migrates, second boot is a no-op). Confirm compile.
- [ ] **Step 7: Commit** (`feat: re-grow published pages under correct marks on upgrade`).

### Task 5: Version bump and two-ship end-to-end verification

**Files:**
- Modify: `code/version.json` (bump to the next release number; check `git show origin/main:code/version.json` at ship time, as main moves).
- Rebuild/deploy: fast-loop deploy of `app.hoon` (and nothing in `ui-app` changed) to two fake ships.

- [ ] **Step 1: Full smoke on two fake ships.** A publishes one page per format; B keens each and renders it correctly; the modeless, legacy-`%gmi`, slow-peek, and `%noun` Review-Focus cases all pass; A's own reader renders each by mode; the migration corrected a pre-seeded `%gmi` page and was idempotent on reboot.
- [ ] **Step 2: Confirm no regression** in the existing published-read path: run any existing publish/read fake-ship suite that covers the reader, and the nexus `?info=1` bang is null on both ships.
- [ ] **Step 3: Bump `code/version.json`** to the next number above current `origin/main`.
- [ ] **Step 4: Commit** (`release: N, published pages carry their format mark`) and stop. Do NOT push, merge, or deploy to ~ricsul-bilwyt without an explicit go.

## Self-Review

- **Spec coverage:** Part 1 (reader) -> Tasks 1,3. Part 2 (publisher) -> Tasks 1,2. Part 3 (migration) -> Tasks 1,4. Stale comment -> Task 2. Version bump / one release -> Task 5. Shared resolver + `%gmi` fallbacks -> Task 1 (used everywhere). No spec section is unassigned.
- **Type consistency:** `+published-mode` -> `view-mode:pg`; `+mode-mark` -> `@tas`; `+grow-pub-page` gains `mode=view-mode:pg`; the read arms carry `mode=view-mode:pg`. Consistent across tasks.
- **Review Focus:** modeless own page (Task 1 test + Task 3), legacy `%gmi` (Task 3), slow-peek `%gmi` (Task 3), migration idempotency (Task 4), `%noun` (Task 2/3). Each has an owning task and a test.
- **Proportion:** the plan sequences and names arms/signatures/tests; it does not transcribe Hoon bodies, which the design and the implementer settle idiomatically.
- **Ordering:** 1 (resolver) before 2 (publisher) and 3 (reader); 2 before 3 (reader tests read pages the publisher grew); 4 after 2 (migration calls the mode-taking `+grow-pub-page`); 5 last. Mid-development, own-ship reads stay correct because they use the local vault, so landing 2 before 3 does not break the dev ship.
