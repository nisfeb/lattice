# Lattice Agent Access Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner mint an agent key scoped to read and/or write only some paths/subtrees of the lattice tree (local and foreign), with a per-page "sensitive" lock.

**Architecture:** Extend the persisted agent-key `scope` mold with independent read/write path allowlists (local `pages`, foreign `web`) plus a `sensitive` clearance and an `origin` hook. Add a pure `+may-path` prefix gate and wire it into the page read/write handlers, read-filtering the tree/search routes. Add a per-page `sensitive` marker grub that mirrors sensitive-memory clearance + taint.

**Tech Stack:** Hoon (grubbery nexus: code/lib/lattice-keys.hoon, code/nex/lattice/app.hoon), the web client (ui-src/lattice/*.js, built to app.js by scripts/build-ui.mjs), hoon-test-kit + scripts/api-matrix.sh, the ~mec lattice-dev fleet.

**Spec:** docs/superpowers/specs/2026-10-15-agent-access-control-design.md (canonical on the wiki at `specs/2026-10-15-agent-access-control`).

## Global Constraints

- Identity for every commit/push/PR: nisfeb <business@nisfeb.com>. No AI attribution (no Co-Authored-By, no "Generated with"). Obey the commit-msg lint hook; never --no-verify.
- This is a DESK change (code/): merging to nisfeb/lattice main deploys to the PRODUCTION memory store ~ricsul-bilwyt within ~15 min. Do NOT merge/release without sneagan's explicit go. Each task's verification runs on the ~mec lattice-dev fleet (http://localhost:8120) first, never ricsul.
- ~mec deploy recipe: `export VERE=~/software/vere-v4.6-linux-x86_64`; mint cookie `scripts/hoon-test-kit/ship-cookie.sh ~/fleet/piers/mec http://localhost:8120 /tmp/mec.jar`; `awk -F'\t' '$6 ~ /^urbauth-/ {print $6"="$7}' /tmp/mec.jar > /tmp/mec.cookie`; deploy `scripts/dev-deploy.py http://localhost:8120 /tmp/mec.jar`; reset after data-writing tests with `~/software/personal/hoon-development/fleet/fleet reset lattice-dev compiled`.
- hoon-test-kit run: `VERE=~/software/vere-v4.6-linux-x86_64 scripts/hoon-test-kit/hoon-test.sh ~/fleet/piers/mec [suite]`.
- Agent keys are PERSISTED rows read by noun through `upgrade:ky`. The scope mold change MUST ship with a working upgrade or every existing key breaks. This is the highest-risk change; it is Task 1 and is tested in isolation first.
- The keyed page-type allowlist stays md/gmi/text/tex/css/index (no hoon/js), even within a write grant. The private-only relaxation does NOT relax the type allowlist or the sensitive gate.
- Edit ui-src/lattice/*.js, never the built app.js; rebuild with `node scripts/build-ui.mjs` and commit both.
- Out of scope: B (linked notes), C (knowledge provenance + embeddings). A only adds the `origin=(unit @p)` field and the reusable `paths` type; do not wire them to anything.
- Plan terminal state: all tasks verified on ~mec and ONE PR opened against main, LEFT UNMERGED pending sneagan's release go. No merge in this plan.

## Review Focus

- **Segment-boundary prefix match.** `/a/b` in a grant must cover `/a/b` and `/a/b/c` but NOT `/a/bc`. A naive string-prefix leaks a sibling. Pinned in Task 2.
- **Read-filtering completeness.** A scoped key must not learn an out-of-scope page EXISTS through any list/read route (page-tree, page-search, page-source, page-history, page-backlinks). A missed route leaks existence, not just content. Pinned in Task 3.
- **Taint is cross-surface.** Reading a sensitive page must block subsequent non-sensitive MEMORY writes too (and a sensitive memory read must block non-sensitive PAGE writes). Pinned in Task 4.
- **Pre-upgrade key still works.** A key row minted before this change (no pages-scope/web-scope/origin) must upgrade to `%all` and keep functioning, not crash the auth gate. Pinned in Task 1.
- **Relaxation does not over-grant.** A write grant lifts private-only for in-scope paths, but a key still cannot write a hoon/js page, nor a sensitive page it is not cleared for, even inside the grant. Pinned in Task 3 and Task 4.

---

### Task 1: Scope mold + migration (isolated, highest risk)

**Files:**
- Modify: `code/lib/lattice-keys.hoon` (the `scope` mold ~line 18, and `upgrade:ky`)
- Test: `tests/lib/lattice-keys.hoon` (hoon-test-kit)

**Interfaces:**
- Produces: `+$ paths [read=(set path) write=(set path)]`; `+$ pages-scope $%([%all lvl=level] [%some =paths])`; `+$ web-scope $%([%off ~] [%all ~] [%some ships=(map @p paths)])`; `+$ scope $:(memory=level pages=pages-scope web=web-scope sensitive=? origin=(unit @p))`; `++ upgrade` reads any prior scope shape by noun and returns the new `scope`.

- [ ] **Step 1: Write failing tests for the mold + upgrade.** In `tests/lib/lattice-keys.hoon`, add:

```hoon
++  test-upgrade-old-flat-scope  ^-  tang
  :: old row scope was [memory=level pages=level web=? sensitive=?]
  =/  old=*  [%read %write & |]
  =/  new  (upgrade:ky old)
  ;:  weld
    (expect-eq !>(pages.new) !>([%all %write]))
    (expect-eq !>(web.new) !>([%all ~]))
    (expect-eq !>(sensitive.new) !>(|))
    (expect-eq !>(origin.new) !>(`(unit @p)`~))
  ==
++  test-upgrade-web-off  ^-  tang
  =/  new  (upgrade:ky [%none %none | |])
  (expect-eq !>(web.new) !>([%off ~]))
```

- [ ] **Step 2: Run the suite, verify it fails** (upgrade does not yet produce the new shape).

Run: `VERE=~/software/vere-v4.6-linux-x86_64 scripts/hoon-test-kit/hoon-test.sh ~/fleet/piers/mec lattice-keys`
Expected: FAIL (mold/arms absent or wrong shape).

- [ ] **Step 3: Add the new molds** in `lattice-keys.hoon` (replace the flat `+$ scope`):

```hoon
+$  paths   [read=(set path) write=(set path)]
+$  pages-scope  $%([%all lvl=level] [%some =paths])
+$  web-scope    $%([%off ~] [%all ~] [%some ships=(map @p paths)])
+$  scope
  $:  memory=level
      pages=pages-scope
      web=web-scope
      sensitive=?
      origin=(unit @p)
  ==
```

- [ ] **Step 4: Write `upgrade:ky`** to read old rows by noun. Old scope was `[level level ? ?]`; new is the struct above. Map by position, defaulting the new fields:

```hoon
++  upgrade
  |=  old=*
  ^-  scope
  =/  o  ;;([memory=level pages=* web=* sensitive=? *] old)
  :*  memory.o
      ?@  pages.o  [%all ;;(level pages.o)]  ;;(pages-scope pages.o)
      ?@  web.o    ?:(;;(? web.o) [%all ~] [%off ~])  ;;(web-scope web.o)
      sensitive.o
      ?~  +>+>.o  ~  ;;((unit @p) +>+>+.o)
  ==
```
(Reads the first four fields by their old shape; if `pages`/`web` are already the new cells, cast them through; a row that has no fifth field yields `origin=~`. Verify the exact tuple slots against the current `key-row`/`de-mint` noun layout when implementing — the shape above is the target, adjust the noun accessors to the real row.)

- [ ] **Step 5: Run the suite, verify it passes.**

Run: `VERE=~/software/vere-v4.6-linux-x86_64 scripts/hoon-test-kit/hoon-test.sh ~/fleet/piers/mec lattice-keys`
Expected: PASS (both upgrade tests green).

- [ ] **Step 6: Deploy to ~mec and confirm the nexus compiles + existing keys still authenticate.** Deploy (recipe in Global Constraints). Then mint nothing new; confirm an existing key still works: `curl -H "Authorization: Bearer <an-existing-mec-key>" http://localhost:8120/apps/lattice/know-index` returns 200 (not 500/parse-fail). If no pre-existing mec key, mint one via the owner `/key-mint` BEFORE deploying this task, so the row is old-format at upgrade time.

- [ ] **Step 7: Commit.**

```bash
git add code/lib/lattice-keys.hoon tests/lib/lattice-keys.hoon
git commit -m "feat: scoped agent-key mold with migration"
```

---

### Task 2: `+under` + `+may-path` prefix gate (pure logic)

**Files:**
- Modify: `code/lib/lattice-keys.hoon` (add `+under`, `+may-path`)
- Test: `tests/lib/lattice-keys.hoon`

**Interfaces:**
- Consumes: the Task 1 molds.
- Produces: `++ under |=([grant=path target=path] ?)` (segment-prefix test); `++ may-path |=([k=key-row realm=?(%local [%ship @p]) target=path lvl=?(%read %write)] ?)`.

- [ ] **Step 1: Write failing tests** covering the Review-Focus segment boundary:

```hoon
++  test-under-boundary  ^-  tang
  ;:  weld
    (expect !>((under /a/b /a/b)))          :: exact
    (expect !>((under /a/b /a/b/c)))        :: subtree
    (expect !>(!(under /a/b /a/bc)))        :: NOT a sibling with shared prefix
    (expect !>(!(under /a/b /a)))           :: parent is not under child
  ==
++  test-may-path-some-write  ^-  tang
  =/  k=key-row  (mk-key [%some [(sy ~[/notes]) (sy ~[/notes/out])]] [%off ~] | ~)
  ;:  weld
    (expect !>((may-path k %local /notes/out/x %write)))
    (expect !>(!(may-path k %local /notes/other %write)))  :: read-only path
    (expect !>((may-path k %local /notes/other %read)))    :: readable
    (expect !>(!(may-path k %local /elsewhere %read)))     :: ungranted
  ==
```
(`mk-key` is a tiny test helper that builds a `key-row` with the given `pages`/`web`/`sensitive`/`origin`; add it in the test file.)

- [ ] **Step 2: Run, verify fail.** `... hoon-test.sh ~/fleet/piers/mec lattice-keys` -> FAIL.

- [ ] **Step 3: Implement `+under`** (segment prefix; mirror the weir `under` in app.hoon move-grants):

```hoon
++  under
  |=  [grant=path target=path]
  ^-  ?
  =/  n  (lent grant)
  &((lte n (lent target)) =(grant (scag n target)))
```

- [ ] **Step 4: Implement `+may-path`:**

```hoon
++  may-path
  |=  [k=key-row realm=?(%local [%ship @p]) target=path lvl=?(%read %write)]
  ^-  ?
  =/  check
    |=  =paths
    (lien ~(tap in ?:(=(%write lvl) write.paths read.paths)) |=(g=path (under g target)))
  ?-    realm
      %local
    ?-  -.pages.scope.k
      %all   (level-ok lvl.pages.scope.k lvl)
      %some  (check paths.pages.scope.k)
    ==
      [%ship *]
    ?-  -.web.scope.k
      %off   |
      %all   &(=(%read lvl) &)     :: broad web is read-only across ships
      %some  =/  e  (~(get by ships.web.scope.k) +.realm)  ?~(e | (check u.e))
    ==
  ==
```
Note: a `%write` check also satisfies read (a writable path is readable) — fold that in by making the read-set check also test the write-set, or require callers to grant read where they grant write; the spec's read/write sets are independent, so document that granting write does NOT imply read unless also in the read-set. Keep them independent as written; the UI makes "write implies read" easy to express.

- [ ] **Step 5: Run, verify pass.** -> PASS.

- [ ] **Step 6: Commit.**

```bash
git add code/lib/lattice-keys.hoon tests/lib/lattice-keys.hoon
git commit -m "feat: may-path segment-prefix gate for scoped keys"
```

(No ~mec deploy needed; pure logic, covered by the suite. Deploy happens with Task 3 which uses it.)

---

### Task 3: Wire the local gate + read-filtering (behavior)

**Files:**
- Modify: `code/nex/lattice/app.hoon` — the key-request gate (~1150-1165) and handlers: handle-page-save (~765), handle-page-save-batch (~599), page-source (~1495), page-tree, page-search, page-history, page-backlinks.
- Modify: `code/lib/lattice-keys.hoon` — add `remote-save`/foreign routes to `+wants` as needed (foreign wired in Task 5; here add the local path-scoped routes' handling).
- Test: `scripts/api-matrix.sh` (extend with a scoped-key block using Bearer).

**Interfaces:**
- Consumes: `may-path` (Task 2), the key `+key-of`/auth context already in app.hoon (~1142-1162).

- [ ] **Step 1: Add a scoped-key test block to api-matrix.sh.** After the knowledge block, mint a scoped key as the owner and exercise it with Bearer:

```bash
echo "==> scoped agent key (pages)"
# mint: read = $P (the test namespace), write = $P/out
KEYJSON="$(G -X POST "$B/key-mint" -H 'content-type: application/json' --data-binary "$(python3 -c "import json,sys;print(json.dumps({'name':'apimx-scoped','by':'apimx','scope':{'memory':'none','pages':{'some':{'read':['/'+sys.argv[1]],'write':['/'+sys.argv[1]+'/out']}},'web':{'off':None},'sensitive':False}}))" "$P")")"
TOK="$(printf '%s' "$KEYJSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])')"
BR="Authorization: Bearer $TOK"
is  "scoped read granted"      200 "$(code -H "$BR" "$B/page-source?name=$P/note")"
is  "scoped read ungranted"    403 "$(code -H "$BR" "$B/page-source?name=other/page")"
is  "scoped write granted"     200 "$(code -H "$BR" -X POST "$B/page-save?name=$P/out/s1&type=md" --data-binary 'scoped write')"
is  "scoped write ungranted"   403 "$(code -H "$BR" -X POST "$B/page-save?name=$P/note&type=md" --data-binary 'nope')"
has "tree hides ungranted"     "$P/out" "$(G -H "$BR" "$B/page-tree")"
is  "tree omits other ns"      "" "$(G -H "$BR" "$B/page-tree" | python3 -c 'import json,sys;print("".join(n["path"] for n in json.load(sys.stdin).get("nodes",[]) if not n["path"].startswith(sys.argv[1])))' "$P")"
is  "scoped write hoon refused" 403 "$(code -H "$BR" -X POST "$B/page-save?name=$P/out/x&type=hoon" --data-binary '|=(x=@ x)')"
```
(The `key-mint` JSON scope shape must match whatever `de-mint` parses — update `de-mint` in Task 1/here to accept the nested `pages`/`web` objects. If mint-time parsing is larger than a line, split a Step for it.)

- [ ] **Step 2: Deploy current branch to ~mec and run api-matrix; confirm the new block FAILS** (gate not wired yet): scoped-write-ungranted returns 200, tree does not hide. Run `LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec.cookie scripts/api-matrix.sh`.

- [ ] **Step 3: Wire the write gate.** In handle-page-save (and handle-page-save-batch per item), after resolving `name`, when the request is keyed (`?=(^ key)`), require `(may-path:ky u.key %local (pax-of name) %write)` else `(send-err eyre-id 403 'outside this key\'s scope')`. Within that pass, REPLACE the blanket private-only refusal (app.hoon:~1892) with: refuse only if NOT in write scope; a write-scoped path is allowed even when shared/clearweb. Keep the type allowlist (`page-type-ok`) and (Task 4) the sensitive gate.

- [ ] **Step 4: Wire the read gate + filter.** In page-source, 403 if keyed and `!(may-path u.key %local (pax-of name) %read)`. In page-tree, page-search, page-history, page-backlinks: when keyed, filter the returned nodes/paths to those with `(may-path u.key %local path %read)`. (Enumerate all five routes; a missed one is the Review-Focus existence leak.)

- [ ] **Step 5: Redeploy to ~mec, run api-matrix; confirm the scoped block PASSES** and the rest of the matrix stays green. Reset ~mec after (it wrote data).

- [ ] **Step 6: Commit.**

```bash
git add code/nex/lattice/app.hoon code/lib/lattice-keys.hoon scripts/api-matrix.sh
git commit -m "feat: scope keyed page read/write to granted paths"
```

---

### Task 4: Sensitive pages (flag + clearance + cross-surface taint)

**Files:**
- Modify: `code/nex/lattice/app.hoon` — a `sensitive` marker grub beside `/share`; a `+page-sensitive` resolver (walk up for folder inheritance, like `+granted`); gate it in the page read/write paths; set taint on a cleared key's sensitive read.
- Modify: `code/lib/lattice-keys.hoon` — extend `+tainted` usage note; taint is already a `(unit @da)` on the row; reuse `taint-for`.
- Test: `tests/lib/lattice-keys.hoon` (taint logic) + `scripts/api-matrix.sh` (sensitive gate).

**Interfaces:**
- Consumes: `scope.sensitive`, `tainted`/`taint-for` (lattice-keys.hoon), `may-path`.
- Produces: `++ page-sensitive |=(name=path ?)` in app.hoon; a `/page/<rel>/sensitive` marker grub; a `/apps/lattice/page-sensitive` owner route to set/clear it.

- [ ] **Step 1: Add api-matrix sensitive cases** (owner marks a page sensitive; a non-cleared scoped key is blocked; a cleared key reads it but is then taint-blocked on a non-sensitive write):

```bash
echo "==> sensitive pages"
is "mark sensitive (owner)" 200 "$(sc -X POST "$B/page-sensitive?name=$P/note&on=1")"
# scoped key WITHOUT clearance (TOK from Task 3): sensitive page hidden/refused
is "sensitive read blocked (uncleared)"  403 "$(code -H "$BR" "$B/page-source?name=$P/note")"
has "tree hides sensitive (uncleared)"   "" "$(G -H "$BR" "$B/page-tree" | python3 -c 'import json,sys;print("".join(1 for n in json.load(sys.stdin).get("nodes",[]) if n["path"]==sys.argv[1]))' "$P/note")"
```
(Cleared-key + taint is exercised in the hoon-test-kit test below, which is deterministic; the HTTP taint timing is awkward to assert in api-matrix, so cover taint in the suite.)

- [ ] **Step 2: Add a hoon-test-kit taint test** (cross-surface):

```hoon
++  test-taint-cross-surface  ^-  tang
  =/  now  ~2026.1.1
  =/  k=key-row  (mk-key-sensitive now)   :: a cleared key, taint set to `now`
  ;:  weld
    (expect !>((tainted k (add now ~h1))))     :: within window: tainted
    (expect !>(!(tainted k (add now ~h13))))   :: past window: clear
  ==
```

- [ ] **Step 3: Run suite + api-matrix; verify the new cases FAIL** (no sensitive grub/route/gate yet).

- [ ] **Step 4: Implement the marker + resolver + route.** Add `/apps/lattice/page-sensitive?name=&on=0|1` (owner-only) writing a `sensitive` grub at `/page/<rel>/sensitive`. Add `+page-sensitive` that returns true if the page or any folder above it carries the marker (mirror `+granted`'s walk-up). 

- [ ] **Step 5: Gate it.** In the page read path: if `(page-sensitive name)` and the requester is a key without `sensitive.scope`, treat as not-found/forbidden (filter from tree/search too). In the read path, if the key IS cleared and reads a sensitive page, set the key's `taint` to now (persist). In every NON-sensitive write (page AND know save), if the key is `(tainted k now)`, refuse with the existing tainted message. (The know-save taint check already exists for memories; extend the page-save path to the same check, and make the sensitive-page read set taint.)

- [ ] **Step 6: Rebuild/redeploy to ~mec; run suite + api-matrix; verify PASS.** Reset ~mec after.

- [ ] **Step 7: Commit.**

```bash
git add code/nex/lattice/app.hoon code/lib/lattice-keys.hoon tests/lib/lattice-keys.hoon scripts/api-matrix.sh
git commit -m "feat: sensitive pages with clearance and cross-surface taint"
```

---

### Task 5: Foreign (ship, path) scoping

**Files:**
- Modify: `code/nex/lattice/app.hoon` — handle-remote-save (~903) and the foreign read routes; gate via `may-path k [%ship shp] target lvl`.
- Modify: `code/lib/lattice-keys.hoon` — add `remote-save` + foreign-read routes to `+wants` (area `%web`).
- Test: a 2-ship fleet test (fleet set with ~mec + a second ship), scripted under `scripts/`.

**Interfaces:**
- Consumes: `may-path` with the `[%ship @p]` realm, `web-scope`.

- [ ] **Step 1: Write a 2-ship fleet test script** `scripts/foreign-scope-test.sh`: ship B shares-for-edit a subtree to ship A (make grant); on A, mint a key with `web={some:{~B:{read:[/x], write:[/x/out]}}}`; assert `remote-save?ship=~B&path=/x/out/f` with Bearer succeeds, and `path=/x/other` is 403, and a foreign read of `/x` succeeds while `/y` is 403. (Use the hoon-development fleet to bring up the second ship; document the exact `fleet` commands at the top of the script.)

- [ ] **Step 2: Run it; verify the scoped foreign cases FAIL** (remote-save not key-path-gated yet).

- [ ] **Step 3: Gate remote-save + foreign reads.** In handle-remote-save, when keyed, require `(may-path u.key [%ship shp] (stab path) %write)`. In the foreign read routes, require `%read`. Add these routes to `+wants` as `%web` so the coarse gate still applies.

- [ ] **Step 4: Rerun the fleet test; verify PASS.** Reset the fleet after.

- [ ] **Step 5: Commit.**

```bash
git add code/nex/lattice/app.hoon code/lib/lattice-keys.hoon scripts/foreign-scope-test.sh
git commit -m "feat: scope foreign reads and remote-save by ship and path"
```

---

### Task 6: Agent-keys UI (scope builder, sensitive, origin, mark-sensitive)

**Files:**
- Modify: `ui-src/lattice/*.js` — the Agent-keys settings surface (the key-mint form) and the page controls/share panel (mark-sensitive). Rebuild to `code/nex/lattice/ui-app/app.js`.
- (No new test file; verify in the browser on ~mec.)

**Interfaces:**
- Consumes: the `/key-mint` scope JSON shape (Task 1/3) and `/page-sensitive` route (Task 4).

- [ ] **Step 1: Find the key-mint form** in ui-src (grep `key-mint`), and the share/controls panel (grep `page-share`/lat-share).

- [ ] **Step 2: Build the scope builder.** In the mint form: a toggle All vs Scoped; when Scoped, two path-list inputs (read, write) with add/remove; an optional foreign section (ship + its read/write lists); a `sensitive` clearance checkbox; an `origin` ship input (labeled "source pier, optional"). Serialize to the `/key-mint` scope JSON from Task 3.

- [ ] **Step 3: Add the mark-sensitive control** to the page controls/share panel: a checkbox that POSTs `/page-sensitive?name=<current>&on=0|1` and reflects the current state.

- [ ] **Step 4: Rebuild + syntax check.**

Run: `node scripts/build-ui.mjs && node --check code/nex/lattice/ui-app/app.js`
Expected: build ok, syntax ok.

- [ ] **Step 5: Deploy to ~mec and verify in a browser (puppeteer or manual):** mint a scoped key through the form, confirm the JSON sent matches, confirm mark-sensitive toggles the grub (re-run the Task 4 api-matrix sensitive case against the browser-minted key).

- [ ] **Step 6: Commit.**

```bash
git add ui-src/lattice code/nex/lattice/ui-app/app.js
git commit -m "feat: agent-key scope builder and mark-sensitive control"
```

---

### Task 7: Full ~mec verification + open PR (held for release go)

**Files:** none (integration/verification + PR).

- [ ] **Step 1: Deploy the full branch to ~mec.** (recipe in Global Constraints)
- [ ] **Step 2: Run the whole hoon-test-kit suite** `... hoon-test.sh ~/fleet/piers/mec` — all green (including the new lattice-keys tests).
- [ ] **Step 3: Run the full api-matrix** against ~mec — green, including the scoped-key and sensitive blocks. Reset ~mec after.
- [ ] **Step 4: Run the 2-ship foreign-scope test** — green. Reset the fleet after.
- [ ] **Step 5: Bump nothing; open the PR.** Push the branch (nisfeb), `gh pr create --base main` with a body summarizing the scope mold, the gate, read-filtering, sensitive+taint, foreign scoping, migration, UI, and the ~mec verification results. **Do NOT merge** — leave it for sneagan's release go (merge = ricsul deploy; a version.json bump to the next desk release is added at release time, not here).
- [ ] **Step 6: Report** the PR link and the verification summary; stop.

## Self-Review

- Spec coverage: scope mold (T1), may-path (T2), local gate + read-filter + relaxation (T3), sensitive + taint (T4), foreign (T5), UI (T6), migration (T1), testing (every task + T7). All spec sections map to a task.
- Review Focus: segment boundary (T2 Step 1), read-filter completeness across all five routes (T3 Step 4), cross-surface taint (T4 Step 2), pre-upgrade key (T1 Step 6), relaxation-does-not-over-grant (T3 Step 1 hoon-refused + T4 sensitive). All five pinned.
- Hoon noun details (the exact `upgrade` accessors, the `de-mint` scope JSON parse, the `key-of`/auth context names) must be matched against the live code when implementing; the plan gives the target shapes and the arms to touch. Where a step's real edit is larger than shown (de-mint parsing, the mint-form serialization), split it into its own test-first step rather than inlining a guess.
