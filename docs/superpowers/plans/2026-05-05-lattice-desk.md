# %lattice Desk — Implementation Plan (Phase 1+2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Urbit desk (`%lattice` Gall agent + `%gmi` mark + Eyre HTTP endpoint) that publishes gemtext files for Ames remote scry and serves a fetch endpoint for the future KMP browser.

**Architecture:** Single Gall agent watches its own desk's `lib/` directory in Clay. On each commit it diffs `lib/` against its known state and uses Gall's `%grow` / `%tomb` notes to publish/unpublish each `.gmi` file at the agent's remote-scry namespace. The same agent binds an Eyre route at `/apps/lattice/fetch` which uses `%keen` to do remote scry to peers (or short-circuits to a local Clay read for self) and returns `{mark, body}` JSON.

**Tech Stack:** Hoon, Gall, Clay, Ames (`%fine` / `%keen`), Eyre. Dev ship is local `~zod` running the user's normal vere/kernel. A second fakezod (`~bus` or similar) is needed for cross-ship verification.

**Spec:** `docs/superpowers/specs/2026-05-05-lattice-design.md`

**Out of scope for this plan:** the KMP browser app (separate plan once this ships).

**Naming convention used in this plan:**
- Desk name on disk: `lattice` (in this repo: `desk/`)
- When mounted on a ship for development: `%lattice`
- Agent name: `%lattice` → `desk/app/lattice.hoon`
- Mark: `%gmi` → `desk/mar/gmi.hoon`

---

## API references locked in for this plan

These came from Urbit docs; the engineer should still verify against the kernel running on `~zod` since some shapes vary by kelvin.

**Remote scry (publishing) — Gall notes:**
- `[%pass /wire %grow =spur =page]` — publish a noun (a `[mark noun]` cell) at a path under the agent's namespace. Gall auto-versions.
- `[%pass /wire %tomb =case =spur]` — delete a specific version.
- `[%pass /wire %cull =case =spur]` — delete all versions up to a case.
- Resulting scry path shape: `/g/x/{rev}/{agent-name}//{published-path}`. The `//` is Gall's publication marker.

**Remote scry (fetching) — Ames `%keen`:**
- `[%pass /wire %keen secret=? [ship path]]`
- Path format requires a `1/` segment after `//`: e.g. `/g/x/4/lattice//1/notes/intro/gmi`.
- Gift back: `[%tune spar roar=(unit roar)]` — `roar` is `~` (no answer yet) or contains the bound page.

**Eyre `%connect`:**
- `[%pass /eyre/connect %arvo %e %connect [~ /apps/lattice] %lattice]`
- Eyre then pokes the agent with cage `%handle-http-request` containing `[@ta inbound-request:eyre]`.
- Agent responds via subscription facts on path `/http-response/{eyre-id}`:
  - first fact: `[%http-response-header response-header:http]`
  - subsequent facts: `[%http-response-data (unit octs)]`
  - then `[%kick ~]` to close.

**Clay reads (self):**
- `.^(cage %cx /=lattice=/lib/notes/intro/gmi)` — read a single file from current desk case.
- `.^(arch %cy /=lattice=/lib)` — list a directory tree.

---

## Task plan

### Task 1: Create the bare desk skeleton

**Files:**
- Create: `desk/sys.kelvin`
- Create: `desk/desk.bill`
- Create: `desk/desk.docket-0`
- Create: `desk/desk.ship`
- Create: `desk/lib/.keep`
- Create: `desk/app/.keep`
- Create: `desk/mar/.keep`
- Create: `desk/sur/.keep`

- [ ] **Step 1: Create `desk/sys.kelvin`**

```
[%zuse 415]
```

Note: `415` is the kelvin from the dalten skeleton this plan is templated on. **Before committing, replace this with whatever kelvin `~zod` reports.** Ask `~zod`:

```
> .^(@ud %cw /=base=/sys/kelvin)
```

Use the returned number.

- [ ] **Step 2: Create `desk/desk.bill`**

```
:~  %lattice
==
```

- [ ] **Step 3: Create `desk/desk.docket-0`**

```
:~  title+'lattice'
    info+'Cross-ship gemtext publishing'
    color+0x0.0000
    version+[0 0 1]
    license+'MIT'
    site+/apps/lattice
==
```

- [ ] **Step 4: Create `desk/desk.ship`**

Empty file. Some kelvins want it present, some don't — having it empty is safe.

- [ ] **Step 5: Create empty `lib/`, `app/`, `mar/`, `sur/` directories with `.keep` files so git tracks them**

Each `.keep` is just an empty file.

- [ ] **Step 6: Verify the kelvin against ~zod's actual kernel**

In dojo on `~zod`:

```
> .^(@ud %cw /=base=/sys/kelvin)
```

If it does not match `desk/sys.kelvin`, update the file to match.

- [ ] **Step 7: Commit**

```bash
git add desk/
git commit -m "lattice: scaffold empty desk"
```

---

### Task 2: Mount and install the empty desk on `~zod`

**Files:** none modified — operating on the running ship.

This task verifies the desk skeleton compiles and installs before we add code.

- [ ] **Step 1: Mount the desk on `~zod`**

In `~zod`'s dojo:

```
> |mount %lattice
```

If `%lattice` doesn't exist yet it errors — that's expected on a fresh ship. We'll create it via merge.

- [ ] **Step 2: Sync this repo's `desk/` to `~zod`'s pier**

The user's `~zod` pier is at a known location; the engineer should ask the user where (e.g. `~/urbit/zod/`). Then:

```bash
# from this repo's root, with $PIER set to the pier path
rsync -a --delete desk/ "$PIER/lattice/"
```

If `~/urbit/zod/lattice/` doesn't exist, do an initial mount with a fresh desk first:

```
> |new-desk %lattice
> |mount %lattice
```

Then rsync our content over the top.

- [ ] **Step 3: Commit and install**

In dojo:

```
> |commit %lattice
> |install our %lattice
```

Expected: no errors. `|commit` may print `>=` (no changes) on the second commit but should not error.

- [ ] **Step 4: Verify desk shows in `+vat %lattice`**

```
> +vat %lattice
```

Expected: a block of metadata showing the desk exists at kelvin matching `~zod`'s.

- [ ] **Step 5: Commit any local fixes**

If you had to fix sys.kelvin or anything else to get the install to succeed, commit that.

```bash
git add desk/
git commit -m "lattice: align desk to ~zod kelvin"
```

---

### Task 3: Define the `%gmi` mark

**Files:**
- Create: `desk/mar/gmi.hoon`

Marks are Clay's content-type system. The `%gmi` mark gives gemtext files a typed identity for both Clay storage and the noun we publish via `%grow`. For v1 we keep it minimal: gemtext is text, so we represent it as a `wain` (list of cords, one per line) and provide `mime` conversion as `text/gemini`.

- [ ] **Step 1: Write `desk/mar/gmi.hoon`**

```hoon
::  /mar/gmi - text/gemini mark
::
|_  txt=wain
++  grow
  |%
  ++  mime  [/text/gemini (as-octs:mimes:html (of-wain:format txt))]
  ++  noun  txt
  --
++  grab
  |%
  ++  mime  |=([=mite =octs] (to-wain:format q.octs))
  ++  noun  wain
  --
++  grad  %txt
--
```

- [ ] **Step 2: Sync to ~zod and commit**

```bash
rsync -a desk/ "$PIER/lattice/"
```

In dojo:

```
> |commit %lattice
```

- [ ] **Step 3: Test the mark by writing a sample file**

Drop a file to test the round-trip:

```bash
mkdir -p "$PIER/lattice/lib"
cat > "$PIER/lattice/lib/hello.gmi" <<'EOF'
# Hello from lattice

This is the first gemtext file.

=> urb://~zod/world  See more
EOF
```

In dojo:

```
> |commit %lattice
> .^(wain %cx /=lattice=/lib/hello/gmi)
```

Expected: a `wain` (list of cords) printed back, one element per line.

- [ ] **Step 4: Commit**

```bash
git add desk/mar/gmi.hoon
git commit -m "lattice: add %gmi mark"
```

---

### Task 4: Stub `%lattice` agent

**Files:**
- Create: `desk/sur/lattice.hoon`
- Create: `desk/app/lattice.hoon`

This is the canonical Gall skeleton with a versioned-state header and a helper-core (`abet:eng`) pattern. We add no logic yet — just enough to install and respond to nothing. Real logic comes in later tasks.

- [ ] **Step 1: Write `desk/sur/lattice.hoon`**

```hoon
::  /sur/lattice - structures for %lattice
::
|%
+$  state-0
  $:  %0
      published=(set path)         ::  /lib paths currently bound
      eyre-id-counter=@ud           ::  unused for now, future-proof
  ==
--
```

- [ ] **Step 2: Write `desk/app/lattice.hoon` with the canonical skeleton**

```hoon
/-  *lattice
/+  default-agent, dbug, verb
::
|%
+$  versioned-state  $%(state-0)
+$  card  card:agent:gall
--
::
%-  agent:dbug
%+  verb  &
=|  state-0
=*  state  -
^-  agent:gall
=<
  |_  =bowl:gall
  +*  this  .
      def   ~(. (default-agent this %|) bowl)
      eng   ~(. +> [bowl ~])
  ::
  ++  on-init
    ^-  (quip card _this)
    =^  cards  state  abet:init:eng
    [cards this]
  ::
  ++  on-save  !>(state)
  ::
  ++  on-load
    |=  ole=vase
    ^-  (quip card _this)
    =^  cards  state  abet:(load:eng ole)
    [cards this]
  ::
  ++  on-poke
    |=  =cage
    ^-  (quip card _this)
    =^  cards  state  abet:(poke:eng cage)
    [cards this]
  ::
  ++  on-watch  on-watch:def
  ++  on-leave  on-leave:def
  ::
  ++  on-peek
    |=  =path
    ^-  (unit (unit cage))
    (peek:eng path)
  ::
  ++  on-agent
    |=  [=wire =sign:agent:gall]
    ^-  (quip card _this)
    =^  cards  state  abet:(agent:eng wire sign)
    [cards this]
  ::
  ++  on-arvo
    |=  [=wire =sign-arvo]
    ^-  (quip card _this)
    =^  cards  state  abet:(arvo:eng wire sign-arvo)
    [cards this]
  ::
  ++  on-fail  on-fail:def
  --
::
::  -- helper core --
::
|_  [bol=bowl:gall dek=(list card)]
+*  dat  .
++  emit  |=(=card dat(dek [card dek]))
++  emil  |=(lac=(list card) dat(dek (welp lac dek)))
++  abet  ^-((quip card _state) [(flop dek) state])
::
++  init  ^+(dat dat)
::
++  load
  |=  vaz=vase
  ^+  dat
  ?>  ?=([%0 *] q.vaz)
  dat(state !<(state-0 vaz))
::
++  poke
  |=  =cage
  ^+  dat
  ~&  >  "lattice: ignored poke {<p.cage>}"
  dat
::
++  peek
  |=  =path
  ^-  (unit (unit cage))
  ~
::
++  agent
  |=  [=wire =sign:agent:gall]
  ^+  dat
  ~&  >  "lattice: agent sign on wire {<wire>}"
  dat
::
++  arvo
  |=  [=wire =sign-arvo]
  ^+  dat
  ~&  >  "lattice: arvo sign on wire {<wire>}"
  dat
--
```

- [ ] **Step 3: Add the agent to `desk.bill`**

`desk/desk.bill` already contains `%lattice`. Verify.

- [ ] **Step 4: Sync, commit, install**

```bash
rsync -a desk/ "$PIER/lattice/"
```

In dojo:

```
> |commit %lattice
> |install our %lattice
```

Expected: no errors. The agent should compile cleanly.

- [ ] **Step 5: Verify agent is running**

```
> +vat %lattice
```

Expected output should list `%lattice` as a running agent.

- [ ] **Step 6: Commit**

```bash
git add desk/sur/lattice.hoon desk/app/lattice.hoon
git commit -m "lattice: stub %lattice gall agent"
```

---

### Task 5: Read and log the contents of `lib/` on init

**Files:**
- Modify: `desk/app/lattice.hoon` — extend `++init` in helper core

Before we do any `%grow` publishing, prove we can enumerate `lib/`. We use a Clay `%y` care scry to get the directory `arch`, then walk it to find `.gmi` files.

- [ ] **Step 1: Modify the helper core to add an `++ list-gmi` arm**

In the helper core (the inner `|_` after `=<`), add:

```hoon
++  list-gmi
  ^-  (set path)
  =/  arc=arch
    .^(arch %cy /(scot %p our.bol)/[q.byk.bol]/(scot %da now.bol)/lib)
  =|  found=(set path)
  =/  stack=(list [pre=path =arch])  ~[[/lib arc]]
  |-  ^+  found
  ?~  stack  found
  =/  cur  i.stack
  =.  stack  t.stack
  ::  fil exists ↔ this is a leaf at pre.cur with content
  ?:  ?=(^ fil.arch.cur)
    ?.  ?=([%gmi *] (flop pre.cur))
      $(stack stack)
    $(found (~(put in found) pre.cur), stack stack)
  ::  otherwise descend
  =/  kids=(list [@ta arch])  ~(tap by dir.arch.cur)
  =.  stack
    %+  weld  stack
    %+  turn  kids
    |=  [name=@ta a=arch]
    [(welp pre.cur /[name]) a]
  $(stack stack)
```

Then change `++ init` to call it and log:

```hoon
++  init
  ^+  dat
  =/  files=(set path)  list-gmi
  ~&  >  "lattice: found {<~(wyt in files)>} gmi file(s) in /lib"
  ~&  >  files
  dat(published files)
```

**Note on the `?=([%gmi *] (flop pre.cur))` check:** Clay paths terminate with the file's mark as the last element. So `lib/hello.gmi` reads as path `/lib/hello/gmi`. The flip-and-test confirms the last element is `gmi`. If the flop syntax is awkward, the equivalent reverse-end pattern is `(rear pre.cur)` returning the last element.

- [ ] **Step 2: Sync, commit, reinstall**

```bash
rsync -a desk/ "$PIER/lattice/"
```

In dojo:

```
> |commit %lattice
```

Reinstalling on commit is automatic for live agents.

- [ ] **Step 3: Verify init logs**

The output of `|commit` should include the trace lines (`>` prefix) showing how many `.gmi` files were found and the set of paths. With one `lib/hello.gmi` from Task 3 you should see exactly one path `/lib/hello/gmi`.

- [ ] **Step 4: Test with multiple files**

```bash
cat > "$PIER/lattice/lib/two.gmi" <<'EOF'
# Second file
EOF
mkdir -p "$PIER/lattice/lib/notes/2026"
cat > "$PIER/lattice/lib/notes/2026/intro.gmi" <<'EOF'
# Nested
EOF
```

In dojo:

```
> |commit %lattice
```

Expected: trace logs show 3 paths, including the nested one.

- [ ] **Step 5: Commit**

```bash
git add desk/app/lattice.hoon
git commit -m "lattice: enumerate gmi files in lib/ on init"
```

---

### Task 6: Subscribe to Clay commits and re-enumerate on each commit

**Files:**
- Modify: `desk/app/lattice.hoon`

Subscribing to `clay`'s `%warp` `%next` lets the agent know when `|commit` happens. On each notification we re-enumerate `lib/` and (next task) publish the diff.

- [ ] **Step 1: Add the Clay subscription on init**

Modify `++ init`:

```hoon
++  init
  ^+  dat
  =.  dat  refresh
  watch-clay
::
++  watch-clay
  ^+  dat
  =;  =card  (emit card)
  =/  =rave:clay
    [%next %y [%da now.bol] /]
  [%pass /clay/lib %arvo %c %warp our.bol q.byk.bol `rave]
::
++  refresh
  ^+  dat
  =/  files=(set path)  list-gmi
  ~&  >  "lattice: lib/ has {<~(wyt in files)>} gmi file(s)"
  dat(published files)
```

- [ ] **Step 2: Handle the `%writ` response in `++ arvo`**

```hoon
++  arvo
  |=  [=wire =sign-arvo]
  ^+  dat
  ?+  wire  ~&  >  "lattice: unhandled arvo wire {<wire>}"  dat
      [%clay %lib ~]
    ::  Clay told us about a commit; refresh state and re-subscribe
    =.  dat  refresh
    watch-clay
  ==
```

- [ ] **Step 3: Sync, commit, reinstall**

```bash
rsync -a desk/ "$PIER/lattice/"
```

In dojo: `|commit %lattice`

- [ ] **Step 4: Verify subscription fires on a subsequent commit**

```bash
cat > "$PIER/lattice/lib/three.gmi" <<'EOF'
# Three
EOF
```

In dojo: `|commit %lattice`

Expected: the trace should print `lib/ has 4 gmi file(s)` (or whatever count is correct after adding `three.gmi`).

- [ ] **Step 5: Commit**

```bash
git add desk/app/lattice.hoon
git commit -m "lattice: subscribe to clay commits, re-enumerate"
```

---

### Task 7: Publish (`%grow`) one file as a remote-scry binding — vertical slice

**Files:**
- Modify: `desk/app/lattice.hoon`

Before generalizing, prove a single `%grow` works end-to-end. Hard-code publishing of `lib/hello.gmi` on init and verify a peer can scry it.

- [ ] **Step 1: Add a `++ publish-one` arm and call it from init**

In the helper core:

```hoon
++  publish-one
  |=  pax=path
  ^+  dat
  ::  read the gmi file's content from clay
  =/  =cage
    .^(cage %cx (welp /(scot %p our.bol)/[q.byk.bol]/(scot %da now.bol) pax))
  ::  cage = [%gmi !>(wain)] — repackage as page for %grow
  =/  =page  [p.cage q.q.cage]
  =;  =card  (emit card)
  ::  spur is path with the trailing 'gmi' element dropped
  =/  spur=path  (snip pax)
  [%pass /grow/(scot %t (spat spur)) %agent [our.bol %lattice] %grow spur page]
```

Wait — `%grow` is a *Gall note*, not an agent task. Card shape is:

```hoon
[%pass /wire %arvo %g %deal [our our] %lattice %grow spur page]
```

Actually `%grow` is sent to Gall about the *current* agent (i.e. the agent itself publishes). The correct card form is:

```hoon
[%pass wire=path note=note:agent:gall]
```

where `note` is `[%grow spur=path =page]`. **Verify this against the kernel before relying on the exact card form** — the wire is internal; the engineer should check whether `%grow` is delivered as a Gall note or via a different vane. The remote-scry doc specifies it as a `$note:agent:gall` task, meaning the card is:

```hoon
[%pass /grow/wire %grow spur page]
```

with `card` being the standard `card:agent:gall` which permits `%grow` as a note variant. Try this shape first.

So `++ publish-one` becomes:

```hoon
++  publish-one
  |=  pax=path
  ^+  dat
  =/  =cage
    .^(cage %cx (welp /(scot %p our.bol)/[q.byk.bol]/(scot %da now.bol) pax))
  =/  =page  [p.cage q.q.cage]
  =/  spur=path  (snip pax)
  =;  =card  (emit card)
  [%pass /grow %grow spur page]
```

And modify init to call it once:

```hoon
++  init
  ^+  dat
  =.  dat  refresh
  =.  dat  watch-clay
  ::  spike: publish lib/hello.gmi specifically
  (publish-one /lib/hello/gmi)
```

- [ ] **Step 2: Sync, commit, reinstall**

```bash
rsync -a desk/ "$PIER/lattice/"
```

If the build fails because the card shape is wrong, look at the error. Likely fixes:
  - The note may need to be wrapped in `[%pass wire %grow !(spur) !(page)]` with explicit cells.
  - Or `%grow` may need to go through Gall as `[%pass wire %arvo %g %deal ...]`. Check `++ note` definition in `sys/lull.hoon` if confused.

`|commit %lattice`. The agent will reinstall on commit.

- [ ] **Step 3: Trigger init by reinstalling**

If the spike code is in `++ init`, you need to re-run init. Easiest:

```
> |nuke %lattice
> |install our %lattice
```

`|nuke` removes the agent (clearing state). `|install` runs `+on-init` afresh.

- [ ] **Step 4: Verify the binding via local scry**

In dojo:

```
> .^(* %gx /=lattice=/lib/hello/gmi)
```

Hmm — local scries through `%gx` and remote scries through Ames `%fine` use different paths. To verify the *Gall publication path*:

```
> .^(* %gx /=lattice=//lib/hello/gmi)
```

**Note: the published path uses Gall's reserved namespace `//` and the engineer should test both `/g/x/0/lattice//lib/hello/gmi` style paths and the simpler `%gx` agent scries to determine which is reachable. Document what works.**

- [ ] **Step 5: Cross-ship verification**

Boot a second fakezod:

```bash
urbit -F bus  # creates fakezod ~bus
```

In `~bus`'s dojo:

```
> .^(* %gx /(scot %p ~zod)/lattice/(scot %da now)//lib/hello/gmi)
```

This is a *remote* scry — Ames will issue a `%fine` request to `~zod`. Expected: returns the wain content of `hello.gmi`.

If this fails because `~bus` doesn't know about `~zod` yet, exchange life info first:

```
~bus> |hi ~zod
```

But remote scry is supposed to work without prior contact for public bindings — a return of the value with no `|hi` is the desired outcome. **Document what the engineer observes.**

- [ ] **Step 6: Commit**

```bash
git add desk/app/lattice.hoon
git commit -m "lattice: spike — publish hello.gmi via %grow, verify cross-ship scry"
```

---

### Task 8: Generalize publishing to all of `lib/` with content hashing

**Files:**
- Modify: `desk/sur/lattice.hoon` — state becomes a content-hash map
- Modify: `desk/app/lattice.hoon`
- Create: `desk/mar/txt.hoon` — standard `%txt` mark (the `%gmi` mark's `grad` depends on it; see gotcha #2)

> **Deploy note (state migration).** Changing `state-0`'s shape means the running agent's persisted state no longer loads — committing the new code triggers a hot-reload that fails with `nest-fail %load-failed` and **rolls the commit back**. On a dev ship, deploy in the order **nuke → commit → revive** (`revive-agent` re-runs `on-init` against the fresh state). `install-app` after a `nuke` does *not* re-initialize; use `revive`.

Replace the hard-coded single-file spike with a full diff sync. The agent already subscribes to Clay with care `%z` over `/lib` (see `watch-clay-card`), so the subscription fires on **content edits** too, not just adds/removes — `%z` is the recursive hash of the subtree. The publishing logic must therefore key off content, not just the path set. We track `published=(map path @uvI)` (path → content hash); on each commit we `%grow` paths whose hash is new or changed and `%cull` paths that disappeared. This folds the old plan's "Option B / edit-detection bug" fix directly into the main design.

> **Idiom note.** The codebase uses a single `|_  =bowl:gall` agent block with helper *gates* in the head `|%` core (each takes `=bowl:gall`), **not** the `=<` / `abet:eng` / `dat` / `emit` pattern that earlier tasks in this plan assumed. All Hoon from Task 8 onward follows the gate style: agent arms call gates and assemble `[cards this(...)]` themselves. If you are reading Tasks 4–7's code, mentally translate `dat` → direct `state` access and `emit`/`emil` → returning `(list card)`.

- [ ] **Step 1: Migrate state to a content-hash map**

In `desk/sur/lattice.hoon`:

```hoon
::  /sur/lattice - structures for %lattice
::
|%
+$  state-0
  $:  %0
      published=(map path @uvH)     ::  /lib path → content hash (sham)
  ==
--
```

> **Verified gotchas (these all bit during implementation — get them right up front):**
> 1. **`sham` returns `@uvH`, not `@uvI`.** Casting it to `@uvI` is a `nest-fail` (auras don't nest). Use `@uvH` in both the state map and `file-hash`.
> 2. **The `%gmi` mark needs the `%txt` mark.** Because `mar/gmi.hoon` declares `++ grad %txt`, reading any `.gmi` file (`.^(@t %cx …/gmi)`) forces Clay to build the `%gmi` *dais*, which builds `%txt` — and a bare `new-desk` does **not** ship `/mar/txt/hoon`. Copy the standard `txt` mark from `%base` into `desk/mar/txt.hoon` or `on-init` will crash with `%error-building-mark %txt`.
> 3. **Don't `zing` over `(list card)`.** Nesting the wet gate `zing` over the deeply-recursive `card` type sends the compiler into a `fuse-loop`. Have the publish/unpublish helpers each return a single `card` and assemble with `weld`.
> 4. **`%cull`/`%tomb` need a `%ud` case = the publication's version**, not `[%da now]` (gall asserts `?=(%ud -.case)` and crashes otherwise). Don't track the version in state — it drifts from gall's farm across nukes. Instead **scry it** with care `%gw` (see Step 2's `unpublish-card`).

- [ ] **Step 2: Add the publishing helper gates to the head `|%` core**

These join the existing `base-path` / `list-gmi` / `walk-dir` / `watch-clay-card` gates. `publish-cards` from the Task 7 spike becomes the single-card `publish-card` below.

```hoon
++  file-hash
  |=  [=bowl:gall pax=path]
  ^-  @uvH
  (sham .^(@t %cx (welp (base-path bowl) pax)))
::
++  publish-card
  |=  [=bowl:gall pax=path]
  ^-  card
  =/  body=@t    .^(@t %cx (welp (base-path bowl) pax))
  =/  spur=path  (snip (slag 1 pax))   ::  drop /lib prefix and trailing /gmi
  ~&  >  "lattice: %grow {<spur>} ({<(met 3 body)>} bytes)"
  [%pass /grow %grow spur gmi+body]
::
++  unpublish-card
  |=  [=bowl:gall pax=path]
  ^-  card
  =/  spur=path  (snip (slag 1 pax))
  ::  %cull/%tomb require a %ud case = the latest published version.
  ::  Scry it from gall (%gw) rather than tracking it, so removal stays
  ::  correct across nukes/re-inits (gall's publication farm outlives
  ::  agent state).  The path MUST start with the empty `//` element after
  ::  the case — that is gall's publication-namespace marker that routes the
  ::  scry to gall's vane handler instead of the agent's on-peek.  Shape:
  ::  /<ship>/<agent>/<case>//1/<spur>  (the `1` is the path-format version).
  ::  (This same `//1/` shape is what Task 11's %keen path needs — Risk #1.)
  =/  cas=case
    .^  case  %gw
      (welp /(scot %p our.bowl)/lattice/(scot %da now.bowl)//1 spur)
    ==
  ?>  ?=(%ud -.cas)
  ~&  >  "lattice: %cull {<spur>} (v{<p.cas>})"
  [%pass /tomb %cull [%ud p.cas] spur]
::
++  sync-cards
  |=  [=bowl:gall prev=(map path @uvH)]
  ^-  [(list card) (map path @uvH)]
  =/  current=(set path)  (list-gmi bowl)
  =/  cur=(list path)  ~(tap in current)
  =/  next=(map path @uvH)
    %-  ~(gas by *(map path @uvH))
    (turn cur |=(p=path [p (file-hash bowl p)]))
  ::  to-grow: new files, or files whose content hash changed
  =/  to-grow=(list path)
    %+  skim  cur
    |=  p=path
    ?~  o=(~(get by prev) p)  &
    !=(u.o (~(got by next) p))
  ::  to-remove: previously-published paths no longer present
  =/  to-remove=(list path)
    ~(tap in (~(dif in ~(key by prev)) current))
  ~&  >  "lattice: {<(lent to-grow)>} updated, {<(lent to-remove)>} removed"
  =/  grows=(list card)  (turn to-grow |=(p=path (publish-card bowl p)))
  =/  culls=(list card)  (turn to-remove |=(p=path (unpublish-card bowl p)))
  [(weld grows culls) next]
```

`publish-card` keeps the `gmi+body` (`@t`) page shape, which matches the current `mar/gmi.hoon` (`|_ own=@t`). **Do not** revert to the `wain`-based mark/page shown in Tasks 3 and 7 — the mark was since changed to `@t` and the two must agree.

- [ ] **Step 3: Wire `on-init` and `on-arvo` to `sync-cards`**

Remove the hard-coded `(publish-cards bowl /lib/hello/gmi)` spike from `on-init`. Both arms use `=^` to thread the new map back into state:

```hoon
++  on-init
  ^-  (quip card _this)
  =^  pub-cards  published.state  (sync-cards bowl *(map path @uvH))
  [[(watch-clay-card bowl) pub-cards] this]
::
++  on-arvo
  |=  [=wire =sign-arvo]
  ^-  (quip card _this)
  ?+  wire  ~&(>>> "lattice: unhandled arvo wire {<wire>}" `this)
      [%clay %lib ~]
    =^  pub-cards  published.state  (sync-cards bowl published.state)
    [[(watch-clay-card bowl) pub-cards] this]
  ==
```

`[(watch-clay-card bowl) pub-cards]` conses the re-subscription card onto the publish cards.

- [ ] **Step 4: Sync, commit, reinstall**

```bash
rsync -a desk/ "$PIER/lattice/"
```

```
> |commit %lattice
> |nuke %lattice
> |install our %lattice
```

The `|nuke` + `|install` clears the `published` state so we get a clean diff against an empty set on init.

- [ ] **Step 5: Verify all files are bound**

For each `.gmi` file in `lib/`, scry from `~bus` (use whatever published-path shape Task 7 confirmed works):

```
~bus> .^(* %gx /(scot %p ~zod)/lattice/(scot %da now)//lib/hello/gmi)
~bus> .^(* %gx /(scot %p ~zod)/lattice/(scot %da now)//lib/two/gmi)
~bus> .^(* %gx /(scot %p ~zod)/lattice/(scot %da now)//lib/notes/2026/intro/gmi)
```

Each should return the file's content (`@t` cord, since the mark is `@t`-backed).

- [ ] **Step 6: Test removal**

```bash
rm "$PIER/lattice/lib/two.gmi"
```

In `~zod`'s dojo: `|commit %lattice`

Expected trace: `0 updated, 1 removed`.

Then on `~bus`:

```
~bus> .^(* %gx /(scot %p ~zod)/lattice/(scot %da now)//lib/two/gmi)
```

Expected: scry returns `~` (no value). The exact Hoon `.^` behavior on a missing remote scry value depends on kernel; document what you observe.

- [ ] **Step 7: Test edit — this is the case content hashing exists to handle**

```bash
cat > "$PIER/lattice/lib/hello.gmi" <<'EOF'
# Hello, edited
EOF
```

In dojo: `|commit %lattice`

Because the `%z` subscription fires on content change and `sync-cards` compares the new `(sham body)` against the stored hash, the path is in `to-update` even though it was already published.

Expected trace: `1 updated, 0 removed`. On `~bus`:

```
~bus> .^(* %gx /(scot %p ~zod)/lattice/(scot %da now)//lib/hello/gmi)
```

Expected: returns the **new** content. If it returns stale content, the `%z` warp isn't firing on edits — fall back to comparing against a `%cz` desk-hash scry, and `~&` the raw `sign-arvo` in `on-arvo` to confirm the notification arrives.

- [ ] **Step 8: Commit**

```bash
git add desk/sur/lattice.hoon desk/app/lattice.hoon
git commit -m "lattice: full diff-based publishing with content hashing"
```

---

### Task 9: Bind Eyre route at `/apps/lattice` with a hello-world response

**Files:**
- Modify: `desk/app/lattice.hoon`

Set up the HTTP plumbing before the actual `fetch` logic. We bind the agent at `/apps/lattice` and respond with a hard-coded JSON `{"ok": true}` to any request.

- [ ] **Step 0 (hard gate): Decide and verify the auth story before writing code**

Every curl in Tasks 9–13 depends on this. On a fresh fakezod, Eyre routes are authenticated by default — an unauthenticated curl gets a 302/403, not your handler. **Pick one path now and confirm it works against a trivial route before proceeding:**

- **Public route (preferred for dev):** make `/apps/lattice` a public binding so no cookie is needed. Confirm whether your kernel's `%connect` accepts a public flag or whether you need an `[%e %set-response ...]`/`|eyre` generator. Test with `curl -i` and confirm 200, not 302.
- **Session cookie:** `curl` the `+code` login flow to mint a cookie, then pass `-b cookie.txt` on every request (the Talon flow). More faithful to production but more curl boilerplate.

Do not advance to Step 1 until a bare route returns your bytes to an unauthenticated-or-cookied curl. Document which path you took at the top of the desk README.

- [ ] **Step 1: Bind Eyre on init and handle `%bound`**

Add a `bind-eyre-card` gate to the head `|%` core and call it from `on-init`:

```hoon
++  bind-eyre-card
  |=  =bowl:gall
  ^-  card
  [%pass /eyre/connect %arvo %e %connect [~ /apps/lattice] %lattice]
```

In `on-init`, cons it onto the existing cards:

```hoon
++  on-init
  ^-  (quip card _this)
  =^  pub-cards  published.state  (sync-cards bowl *(map path @uvH))
  :_  this
  :*  (watch-clay-card bowl)
      (bind-eyre-card bowl)
      pub-cards
  ==

::  Gotcha: in the wide form `~&(> "..." x)`, use a SINGLE space after the
::  priority sigil — `~&(>  "..." x)` (double space) is a syntax error.
::  Auth (Step 0): on the dev fakezod we used the session cookie path —
::  `curl -b "urbauth-~zod=…" …` — no public-route generator needed.
```

Eyre replies with a `%bound` gift on wire `/eyre/connect` — add a branch to `on-arvo`:

```hoon
      [%eyre %connect ~]
    ?>  ?=([%eyre %bound *] sign-arvo)
    ~&  >  "lattice: eyre bound at /apps/lattice (accepted={<accepted.sign-arvo>})"
    `this
```

- [ ] **Step 2: Add response gates and handle `%handle-http-request` pokes**

Add to the head `|%` core:

```hoon
++  respond-json-cards
  |=  [eyre-id=@ta status=@ud body=@t]
  ^-  (list card)
  =/  pax=path  /http-response/[eyre-id]
  =/  hdr=response-header:http
    [status ['content-type' 'application/json']~]
  :~  [%give %fact ~[pax] %http-response-header !>(hdr)]
      [%give %fact ~[pax] %http-response-data !>(`(unit octs)`(some (as-octs:mimes:html body)))]
      [%give %kick ~[pax] ~]
  ==
::
++  handle-http
  |=  [=bowl:gall eyre-id=@ta =inbound-request:eyre]
  ^-  (list card)
  ::  hello-world: 200 application/json {"ok":true}.  Task 10 replaces the body.
  (respond-json-cards eyre-id 200 '{"ok":true}')
```

Then `on-poke`:

```hoon
++  on-poke
  |=  =cage
  ^-  (quip card _this)
  ?+  p.cage  ~&(>  "lattice: ignored poke {<p.cage>}" `this)
      %handle-http-request
    =+  !<([eyre-id=@ta =inbound-request:eyre] q.cage)
    [(handle-http bowl eyre-id inbound-request) this]
  ==
```

Eyre subscribes to `/http-response/{eyre-id}` and waits for header → data → kick. `as-octs:mimes:html` builds the `octs` from the cord — no manual `(met 3 body)`.

- [ ] **Step 3: Permit `/http-response/...` in `on-watch`**

When Eyre subscribes to deliver the response, the agent must accept the watch. Replace `++  on-watch  on-watch:def` with:

```hoon
++  on-watch
  |=  =path
  ^-  (quip card _this)
  ?+  path  (on-watch:def path)
      [%http-response *]  `this
  ==
```

- [ ] **Step 4: Sync, commit, reinstall**

```bash
rsync -a desk/ "$PIER/lattice/"
```

```
> |commit %lattice
> |nuke %lattice
> |install our %lattice
```

Watch the dojo for `lattice: eyre bound at /apps/lattice`.

- [ ] **Step 5: curl the endpoint**

`~zod`'s default fakezod HTTP port is 8080 (or whatever the user configured). The user knows. Then:

```bash
curl -i http://localhost:8080/apps/lattice/anything
```

Expected: 200 with `{"ok":true}`. **Note:** Eyre may require a session cookie for non-public routes. If the response is `403`, the engineer should authenticate first by `curl`-ing `+code`-based login (same flow Talon uses) — see the Talon repo for an example. For dev, the engineer can also `|eyre-set-public-route /apps/lattice` in dojo if such a generator exists, or accept that the endpoint requires auth and pass a cookie in subsequent steps.

- [ ] **Step 6: Commit**

```bash
git add desk/app/lattice.hoon
git commit -m "lattice: bind /apps/lattice in eyre, hello-world response"
```

---

### Task 10: Implement `/apps/lattice/fetch` — local case

**Files:**
- Modify: `desk/app/lattice.hoon`

The endpoint accepts `?url=urb://~ship/path` and returns `{"mark": "gmi", "body": "...content..."}`. For this task, only handle the case where `~ship == our` (short-circuit to a local Clay read).

- [ ] **Step 1: Parse the URL parameter**

Inbound requests provide `url` field as `@t` (the path with query). Extract and parse:

```hoon
::  in the head |% core
++  parse-urb-url
  |=  raw=cord
  ^-  (unit [=ship =path])
  ::  expect "urb://~ship-name/path/segments"
  =/  s=tape  (trip raw)
  ?.  =((scag 6 s) "urb://")  ~
  =/  rest=tape  (slag 6 s)
  =/  slash=@ud  (need (find "/" rest))
  =/  ship-tape  (scag slash rest)
  =/  rest-of-path=tape  (slag slash rest)
  =/  shp=(unit ship)  (slaw %p (crip ship-tape))
  ?~  shp  ~
  =/  pax=path  (stab (crip rest-of-path))
  `[u.shp pax]
```

This is rough — `slaw %p` parses `~zod`-style names. Path parsing via `stab` handles `/foo/bar`. **Note: empty path (`urb://~ship/`) needs special handling — `stab "/"` returns `~` (empty path). That's correct.**

- [ ] **Step 2: Read query parameter from `inbound-request:eyre`**

The `inbound-request` has structure with a URL containing query params. Approach:

```hoon
++  request-url
  |=  =inbound-request:eyre
  ^-  cord
  ::  url is path+query; locate "url=" in query string
  ::  inbound-request.url is @t like "/apps/lattice/fetch?url=urb%3A%2F%2F..."
  ::  this is sketch — the actual field name and decoding
  ::  must be verified against the eyre data type.
  url.request.inbound-request
```

The exact structure of `inbound-request:eyre` differs by kernel; verify it via:

```
> =i -build-tape
::  in dojo, inspect `inbound-request:eyre` via help
> =a `inbound-request:eyre`*
```

Approach for reading `?url=`: parse the raw URL with `de-purl:html` (a stdlib URL parser) which gives a `purl` with structured query params, then look up the `url` key.

```hoon
++  query-param
  |=  [=inbound-request:eyre key=cord]
  ^-  (unit cord)
  =/  url=@t  url.request.inbound-request
  =/  =purl:eyre  (need (de-purl:html url))
  =/  q=(list [key=@t val=@t])  q.r.url.purl
  (~(get by (~(gas by *(map @t @t)) q)) key)
```

(Approximate field names; verify against the kernel's `eyre` types in `sys/zuse.hoon`.)

- [ ] **Step 3: Replace `handle-http` with the fetch dispatcher**

Reuse `respond-json-cards` from Task 9. Add `mark-and-body` and `read-local` gates and rewrite `handle-http` — all return `(list card)`:

```hoon
++  mark-and-body
  |=  [mark=@t body=@t]
  ^-  @t
  %-  en:json:html
  %-  pairs:enjs:format
  :~  ['mark' s+mark]
      ['body' s+body]
  ==
::
++  read-local
  |=  [=bowl:gall eyre-id=@ta pax=path]
  ^-  (list card)
  ::  empty path = index; handled in Task 12. For now, 404.
  ?:  =(~ pax)
    (respond-json-cards eyre-id 404 '{"error":"index not yet implemented"}')
  =/  full=path  :(welp /lib pax /gmi)
  =/  base       (base-path bowl)
  ?.  .^(? %cu (welp base full))
    (respond-json-cards eyre-id 404 '{"error":"not found"}')
  =/  body=@t  .^(@t %cx (welp base full))
  (respond-json-cards eyre-id 200 (mark-and-body 'gmi' body))
::
++  handle-http
  |=  [=bowl:gall eyre-id=@ta =inbound-request:eyre]
  ^-  (list card)
  =/  raw=(unit @t)  (query-param inbound-request 'url')
  ?~  raw
    (respond-json-cards eyre-id 400 '{"error":"missing url param"}')
  =/  parsed=(unit [=ship =path])  (parse-urb-url u.raw)
  ?~  parsed
    (respond-json-cards eyre-id 400 '{"error":"bad urb:// url"}')
  ?:  =(ship.u.parsed our.bowl)
    (read-local bowl eyre-id path.u.parsed)
  ::  remote case implemented in Task 11
  (respond-json-cards eyre-id 501 '{"error":"remote scry not yet implemented"}')
```

`mark-and-body` uses `enjs:format` + `en:json:html` (the JSON encoder is `en:json:html`, returning a cord) so the body is JSON-escaped correctly (quotes, newlines) — never concatenate strings. Because the mark is `@t`-backed, `read-local` reads the file as `@t` directly (no `of-wain`).

- [ ] **Step 4: Sync, commit, reinstall**

Same routine.

- [ ] **Step 5: Test with curl**

```bash
curl -s "http://localhost:8080/apps/lattice/fetch?url=urb://~zod/hello"
```

Expected: `{"mark":"gmi","body":"# Hello, edited again\n"}` or similar — JSON envelope with the file contents.

```bash
curl -s "http://localhost:8080/apps/lattice/fetch?url=urb://~zod/notes/2026/intro"
```

Expected: returns the nested file's contents.

```bash
curl -s "http://localhost:8080/apps/lattice/fetch?url=urb://~zod/does-not-exist"
```

Expected: `{"error":"not found"}` with 404.

- [ ] **Step 6: Commit**

```bash
git add desk/app/lattice.hoon
git commit -m "lattice: implement /apps/lattice/fetch for local ship"
```

---

### Task 11: Implement remote case via `%keen`

**Files:**
- Modify: `desk/app/lattice.hoon`

When the URL points to another ship, send a `%keen` task to Ames and respond when the `%sage` gift returns (this kernel uses `%sage`, not `%tune`).

- [ ] **Step 0 (hard gate): Get the `%keen` scry path working in dojo before writing any agent code**

This is the single trickiest piece in the plan (Risk #1). The published path uses Gall's reserved `//` namespace plus a path-format version segment. Do **not** write the `keen-path` gate until a `~bus` dojo scry against `~zod`'s live binding returns the value. Try these shapes interactively and record which works:

```
~bus> .^(@t %gx /(scot %p ~zod)/lattice/(scot %da now)//lib/hello/gmi)
~bus> .^(@t %gx /(scot %p ~zod)/lattice/(scot %da now)//1/lib/hello/gmi)
```

In a Hoon path list, the `//` is an empty atom segment (`''`, written `%$` or `~.`); the version `1` is a separate `%1` segment. Whatever shape returns the value is what `keen-path` must build. Until one works, the rest of Task 11 cannot be verified — fix the binding (Task 7/8) or the path before continuing.

- [ ] **Step 1: Add a state field for in-flight requests**

In `desk/sur/lattice.hoon` (cumulative with Task 8's `published`):

```hoon
+$  state-0
  $:  %0
      published=(map path @uvI)              ::  /lib path → content hash
      pending=(map @ta [=ship =path])        ::  eyre-id → fetch we're waiting on
  ==
```

- [ ] **Step 2: Build the keen path, and extend `handle-http` to fire `%keen`**

Add a `keen-path` gate (the spur is the bare `urb://` path — no `/lib`, no `/gmi` — matching what `publish-card` grows; the `//1` empty+version segment routes to the publication namespace, confirmed via Task 8's `%gw` scry). **The exact remote path is the one cross-ship unknown — verify it before relying on it (see Step 0).** Also add a `keen-card` gate:

```hoon
++  keen-path
  |=  spur=path
  ^-  path
  :(welp /g/x/1/lattice//1 spur)
::
++  keen-card
  |=  [eyre-id=@ta =ship spur=path]
  ^-  card
  ::  direct ames %keen task: [%keen sec=(unit [idx key]) spar]; public = ~.
  ::  response arrives as [%ames %sage [spar gage]] on wire /keen/<eyre-id>.
  [%pass /keen/[eyre-id] %arvo %a %keen ~ ship (keen-path spur)]
```

`handle-http` now needs to record `pending`, so it returns the new pending map alongside its cards. Replace the `501` remote stub:

```hoon
++  handle-http
  |=  $:  =bowl:gall  eyre-id=@ta  =inbound-request:eyre
          pending=(map @ta [=ship =path])
      ==
  ^-  [(list card) _pending]
  =/  raw=(unit @t)  (query-param inbound-request 'url')
  ?~  raw
    [(respond-json-cards eyre-id 400 '{"error":"missing url param"}') pending]
  =/  parsed=(unit [=ship =path])  (parse-urb-url u.raw)
  ?~  parsed
    [(respond-json-cards eyre-id 400 '{"error":"bad urb:// url"}') pending]
  ?:  =(ship.u.parsed our.bowl)
    [(read-local bowl eyre-id path.u.parsed) pending]
  ::  remote: send %keen, remember the eyre-id, answer on %sage (Step 3)
  :_  (~(put by pending) eyre-id u.parsed)
  ~[(keen-card eyre-id ship.u.parsed path.u.parsed)]
```

> **`%keen` task shape varies by kernel.** This kernel's ames task is `[%keen sec=(unit [idx=@ key=@]) spar]` (so `~` = public); the gall-agent note variant is `[%keen secret=? spar]`. We use the direct ames task. Verify `++ task:ames` in `sys/lull.hoon` if it differs. The wire `/keen/[eyre-id]` is what Step 3 keys on.

Thread the new pending map through `on-poke`:

```hoon
++  on-poke
  |=  =cage
  ^-  (quip card _this)
  ?+  p.cage  ~&(>  "lattice: ignored poke {<p.cage>}" `this)
      %handle-http-request
    =+  !<([eyre-id=@ta =inbound-request:eyre] q.cage)
    =^  cards  pending.state  (handle-http bowl eyre-id inbound-request pending.state)
    [cards this]
  ==
```

- [ ] **Step 3: Handle the response in `on-arvo`**

> **VERIFIED cross-ship: this kernel answers a `%keen` with `[%ames %sage …]`, not `%tune`.** `%tune` is the older gift; asserting it crashes (`on-fail %arvo-response`). The `%sage` gift carries `sage = [spar gage]` (`sage:mess:ames`), and `gage = $@(~ page)` (`~` = peer has no value, else `page = [mark noun]`). Add a `sage-cards` gate and a `[%keen @ta ~]` branch:

```hoon
++  sage-cards
  |=  [eyre-id=@ta gag=gage:mess:ames]
  ^-  (list card)
  ?@  gag
    (respond-json-cards eyre-id 404 '{"error":"remote ship has no value"}')
  (respond-json-cards eyre-id 200 (mark-and-body p.gag ;;(@t q.gag)))
```

In `on-arvo`:

```hoon
      [%keen @ta ~]
    ?>  ?=([%ames %sage *] sign-arvo)
    =/  eid=@ta  i.t.wire
    ?~  pend=(~(get by pending.state) eid)
      ~&(>>> "lattice: %sage for unknown eyre-id {<eid>}" `this)
    =.  pending.state  (~(del by pending.state) eid)
    [(sage-cards eid q.sage.sign-arvo) this]
```

**Verified** `~zod`↔`~tyr`: a fetch of an existing remote file returns its body. Two notes: (1) ships must know each other first — `|hi ~peer` (a local `%helm-send-hi` poke `[~peer ~]`) before any `%keen` will be sent, since ames only requests from known ships. (2) A missing remote path **hangs** — remote scry can't prove absence, so the peer never answers and there's no 404; add a Behn timeout if you need the HTTP request to fail fast. (The keen-path `/g/x/1/lattice//1/<spur>` was correct as-is.)

- [ ] **Step 4: Sync, commit, reinstall**

- [ ] **Step 5: Test cross-ship fetch**

From `~zod`'s shell, fetch a file `~bus` is hosting. First, install `%lattice` on `~bus`:

```bash
rsync -a desk/ "$PIER_BUS/lattice/"
```

In `~bus`'s dojo:

```
> |commit %lattice
> |install our %lattice
```

Add a file to `~bus`'s `lib/`:

```bash
cat > "$PIER_BUS/lattice/lib/from-bus.gmi" <<'EOF'
# Hello from ~bus
EOF
```

In `~bus`'s dojo: `|commit %lattice`

Then from `~zod`'s shell:

```bash
curl -s "http://localhost:8080/apps/lattice/fetch?url=urb://~bus/from-bus"
```

Expected: `{"mark":"gmi","body":"# Hello from ~bus\n"}`.

- [ ] **Step 6: Test failure case**

```bash
curl -s "http://localhost:8080/apps/lattice/fetch?url=urb://~bus/nonexistent"
```

Expected: 404 with "remote ship has no value".

- [ ] **Step 7: Commit**

```bash
git add desk/sur/lattice.hoon desk/app/lattice.hoon
git commit -m "lattice: cross-ship fetch via %keen"
```

---

### Task 12: Auto-generate index page when `lib/index.gmi` is absent

**Files:**
- Modify: `desk/app/lattice.hoon`

When `urb://~self/` is fetched (empty path), serve `lib/index.gmi` if present, else generate a gemtext listing of all `.gmi` files under `lib/`.

- [ ] **Step 1: Extend `read-local` (from Task 10) to handle the empty path**

```hoon
++  read-local
  |=  [=bowl:gall eyre-id=@ta pax=path]
  ^-  (list card)
  =/  base  (base-path bowl)
  ?:  =(~ pax)
    ::  empty path = home page: authored lib/index.gmi if present, else generated
    =/  index-path=path  /lib/index/gmi
    ?:  .^(? %cu (welp base index-path))
      =/  body=@t  .^(@t %cx (welp base index-path))
      (respond-json-cards eyre-id 200 (mark-and-body 'gmi' body))
    (respond-json-cards eyre-id 200 (mark-and-body 'gmi' (generate-index (list-gmi bowl))))
  ::  non-empty path
  =/  full=path  :(welp /lib pax /gmi)
  ?.  .^(? %cu (welp base full))
    (respond-json-cards eyre-id 404 '{"error":"not found"}')
  =/  body=@t  .^(@t %cx (welp base full))
  (respond-json-cards eyre-id 200 (mark-and-body 'gmi' body))
::
++  generate-index
  |=  paths=(set path)
  ^-  @t
  =/  lines=(list @t)
    %+  turn  ~(tap in paths)
    |=  pax=path
    ::  pax is /lib/notes/2026/intro/gmi → "=> /notes/2026/intro  notes/2026/intro"
    =/  inner=path  (snip (slag 1 pax))   ::  drop /lib prefix and trailing /gmi
    =/  shown=tape  (spud inner)          ::  "/notes/2026/intro"
    (crip "=> {shown}  {(slag 1 shown)}")  ::  relative link resolves per current ship
  =/  header=(list @t)
    ~['# Index' '' 'Files published on this ship:' '']
  (of-wain:format (welp header lines))
```

The link form here is `=> /notes/2026/intro` (relative). When the browser app loads this index from `urb://~self/`, those relative links resolve correctly to `urb://~self/notes/2026/intro`. Cross-ship access (`urb://~bus/`) generates the same content with relative links — they will resolve to `urb://~bus/...` for the reader, which is correct.

- [ ] **Step 2: Sync, commit, reinstall**

- [ ] **Step 3: Test the index without `lib/index.gmi`**

```bash
curl -s "http://localhost:8080/apps/lattice/fetch?url=urb://~zod/"
```

Expected: `{"mark":"gmi","body":"# Index of ~zod\n\nFiles published on this ship:\n\n=> /hello  hello\n=> /notes/2026/intro  notes/2026/intro\n=> /three  three\n"}` (or similar — exact list reflects current `lib/`).

- [ ] **Step 4: Test the index *with* `lib/index.gmi`**

```bash
cat > "$PIER/lattice/lib/index.gmi" <<'EOF'
# ~zod's lattice

Welcome.

=> /hello  Hello page
=> /notes/2026/intro  Notes intro
EOF
```

`|commit %lattice`

```bash
curl -s "http://localhost:8080/apps/lattice/fetch?url=urb://~zod/"
```

Expected: returns the *authored* `index.gmi`, not the auto-generated one.

- [ ] **Step 5: Commit**

```bash
git add desk/app/lattice.hoon
git commit -m "lattice: auto-generate index when lib/index.gmi absent"
```

---

### Task 13: End-to-end integration recipe

**Files:**
- Create: `docs/lattice-integration-test.md`

Document the full two-ship verification so it's reproducible.

- [ ] **Step 1: Write the integration recipe**

File: `docs/lattice-integration-test.md`

```markdown
# %lattice integration test recipe

Two fakezods (~zod, ~bus) cross-publishing and cross-fetching.

## Setup (one-time)

1. Stop any running fakezods.
2. Boot both:
   ```bash
   urbit -F zod &
   urbit -F bus &
   ```
3. Note each ship's HTTP port from its boot output (default 8080 / 8081).
   Export as `$PORT_ZOD` and `$PORT_BUS`.
4. Each pier path → export as `$PIER_ZOD`, `$PIER_BUS`.

## Install lattice on both ships

```bash
rsync -a desk/ "$PIER_ZOD/lattice/"
rsync -a desk/ "$PIER_BUS/lattice/"
```

In `~zod` dojo:
```
> |new-desk %lattice    :: only first time
> |mount %lattice
> |commit %lattice
> |install our %lattice
```

Same in `~bus` dojo.

## Add content on each ship

```bash
cat > "$PIER_ZOD/lattice/lib/welcome.gmi" <<'EOF'
# ~zod welcomes you

=> urb://~bus/  Visit ~bus
EOF

cat > "$PIER_BUS/lattice/lib/about.gmi" <<'EOF'
# About ~bus

A demo ship.

=> urb://~zod/  Back to ~zod
EOF
```

`|commit %lattice` on each.

## Fetch tests

Self-fetch:
```bash
curl -s "http://localhost:$PORT_ZOD/apps/lattice/fetch?url=urb://~zod/welcome" | jq .
```
Expected: `{"mark":"gmi","body":"# ~zod welcomes you\n..."}`

Cross-fetch (from ~zod, fetch ~bus):
```bash
curl -s "http://localhost:$PORT_ZOD/apps/lattice/fetch?url=urb://~bus/about" | jq .
```
Expected: `{"mark":"gmi","body":"# About ~bus\n..."}`

Cross-fetch index:
```bash
curl -s "http://localhost:$PORT_ZOD/apps/lattice/fetch?url=urb://~bus/" | jq .
```
Expected: index with `=> /about  about` line.

Cross-fetch missing:
```bash
curl -s "http://localhost:$PORT_ZOD/apps/lattice/fetch?url=urb://~bus/no-such" | jq .
```
Expected: 404 with `"error":"remote ship has no value"`.

## Edit-publish-refetch

```bash
echo "" >> "$PIER_BUS/lattice/lib/about.gmi"
echo "Edit at $(date)" >> "$PIER_BUS/lattice/lib/about.gmi"
```
`|commit %lattice` on `~bus`.

Re-fetch from `~zod`:
```bash
curl -s "http://localhost:$PORT_ZOD/apps/lattice/fetch?url=urb://~bus/about" | jq .body
```
Expected: includes the new edit timestamp.

## Cleanup

`urbit halt` on each ship, or just close the dojo terminals.
```

- [ ] **Step 2: Run the entire recipe top to bottom**

If any step fails, fix the agent and update the recipe. The recipe is the acceptance test for this plan.

- [ ] **Step 3: Commit**

```bash
git add docs/lattice-integration-test.md
git commit -m "lattice: integration test recipe (two fakezods)"
```

---

### Task 14: Polish — error logging, README

**Files:**
- Create: `desk/README.md`
- Modify: `desk/desk.docket-0` (color, info if needed)
- Modify: `desk/app/lattice.hoon` — add `~&` traces only at WARN/ERROR equivalent

- [ ] **Step 1: Write `desk/README.md`**

```markdown
# %lattice — gemtext over Ames

Drop `.gmi` files into `lib/` and `|commit %lattice`. Each file becomes
fetchable from any ship at `urb://~your-ship/path/to/file` (extension
omitted from URL).

## Files

- `app/lattice.hoon` — Gall agent. Watches `lib/` for commits, publishes
  via `%grow`, serves `/apps/lattice/fetch` over Eyre.
- `mar/gmi.hoon` — `%gmi` mark for `text/gemini`.
- `sur/lattice.hoon` — state structure.
- `lib/` — your gemtext content. `lib/index.gmi` is the home page;
  if absent, an auto-generated listing is served.

## Endpoint

`GET /apps/lattice/fetch?url=urb://~ship/path` →
`{"mark":"gmi","body":"..."}`

For `~ship == self`, reads from local Clay; otherwise issues `%keen`
remote scry via Ames.

## Install

```
> |mount %lattice
> |install our %lattice
```

See `../docs/lattice-integration-test.md` for the cross-ship test recipe.
```

- [ ] **Step 2: Reduce verbose `~&` traces to errors only**

Remove `~& >` traces that fire on the success path. Keep `~& >>>` for actual errors. The agent should be quiet on a healthy ship.

- [ ] **Step 3: Sync, commit, reinstall, smoke-test**

Run the recipe from Task 13 once more.

- [ ] **Step 4: Commit**

```bash
git add desk/README.md desk/app/lattice.hoon
git commit -m "lattice: docs + quieter logging"
```

---

## Final acceptance

When all tasks pass:

1. `~zod` and `~bus` both have `%lattice` running.
2. `|commit %lattice` on either ship publishes/unpublishes/edits files in O(diff) work.
3. `curl http://localhost:$PORT/apps/lattice/fetch?url=urb://~ship/path` returns `{"mark":"gmi","body":"..."}` for self or remote ships.
4. Removed files return 404; edited files return updated content.
5. `lib/index.gmi` (if present) overrides the auto-generated index.

This is the contract the future KMP browser app will rely on.

---

## Risks & known unknowns

These are flagged for the engineer to investigate as they hit them. Two of them are now **hard gates** — a step that must pass before its task's code is written:

1. **Path format for `%keen`** — *hard gate, Task 11 Step 0.* The exact insertion of the `//` namespace marker and version segment between agent name and path is the trickiest piece. Get a `~bus` dojo scry returning the value before writing `keen-path`.
2. **`%grow` card form** — *largely resolved.* The Task 7 spike landed `[%pass /grow %grow spur gmi+body]` (the direct `note:agent:gall` form) and it compiled/installed; `sync-cards` reuses it. Still confirm peers can actually scry the binding (Task 8 Step 5).
3. **Eyre auth** — *hard gate, Task 9 Step 0.* Public routes may need explicit configuration on a fresh fakezod, or the curl tests need a `+code` session cookie. Decide and prove the path on a trivial route before building handlers.
4. **`inbound-request:eyre` field names.** `url.request.inbound-request` and the `de-purl:html` query shape differ across kelvins. Inspect the type in dojo before trusting `query-param` (Task 10 Step 2).
5. **Keen response gift — RESOLVED.** This kernel answers a `%keen` with `[%ames %sage [spar gage]]`, not `%tune`; `gage = $@(~ page)`. Verified `~zod`↔`~tyr`. See Task 11 Step 3.
6. **`%keen` task shape.** `[%keen secret=? =spar]` vs `[%keen =spar]` varies — verify `++ task:ames` in `sys/lull.hoon` (Task 11 Step 2).
7. **Kernel kelvin drift.** The `sys.kelvin` value must match the running ship (checked in Task 1).

**Note on idiom:** Tasks 1–7 were drafted in a `=<` / `abet:eng` / `dat` helper-core style, but the implementation (commit `d5cf67a`) uses a single `|_  =bowl:gall` block with helper gates in the head `|%` core. Tasks 8–14 above are written in that gate style and supersede the earlier idiom. The `%gmi` mark is `@t`-backed (`|_ own=@t`), so pages are `[%gmi @t]`, not `[%gmi wain]` — ignore the `wain` shapes in Tasks 3 and 7.

Each unknown has a step flagged **hard gate**, **verify**, or **document what you observe**. Do the verification rather than assuming.
