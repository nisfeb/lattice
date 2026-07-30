# Lattice UI — Web Components Restructure Implementation Plan

> **STATUS 2026-07-30: EXECUTED.** All milestones implemented and verified on
> the tyr harness — ui-matrix 49/49 (including the new custom-element upgrade
> assertion), dark/light/mobile/know screenshots reviewed. Deviations from the
> plan as written: history file is `77-history.js` (not 67 — the plan's number
> broke its own order-preservation invariant); M4–M6 shared one deploy gate
> (the harness was contested by a concurrent session); deploys went through
> the grubbery MCP `insert_clay_file` route because the clay disk mount was
> desynced and the dojo wedged (see memory `project/lattice/deploy-loop`).
> The components also gained stale-shell guards beyond the plan (each swaps
> in for its literal markup when a cached shell predates it).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the 1687-line `ui-app/app.js` IIFE into ordered source
modules and light-DOM custom elements, one per pane, without changing behavior,
ids, CSS, or the number of files the ship serves.

**Architecture:** Source lives in `ui-app/src/NN-name.js`; a dependency-free
build script concatenates them (in filename order) into the committed
`ui-app/app.js` artifact, so `app.hoon` and the one-asset boot cost are
untouched. Custom elements own their pane's markup and event wiring in the
light DOM (no Shadow DOM); all modules share one IIFE scope, so cross-pane
calls stay plain function calls — no framework, no event bus, no registry.
Migration is strangler-style: one pane per milestone, `ui-matrix` green after
each.

**Tech Stack:** Vanilla JS, native `customElements`, Node ≥18 for the build
script (already required by CI's `node --check`), puppeteer ui-matrix against
the tyr harness.

## Global Constraints

- The ship serves exactly TWO ui-app assets (`index.html`, `app.js`) — every
  extra asset request costs ~2s on the serialized pier. The build must keep it
  that way; `app.hoon` is not modified by this plan.
- All CSS stays inlined in `index.html` (same perf decision). Therefore **no
  Shadow DOM** — components render in the light DOM so the global stylesheet,
  the Prism token rules, and the theme vars keep applying.
- Every element id referenced by CSS or by `scripts/ui-matrix.mjs` keeps its
  id (`#src`, `#hl`, `#treelist`, `#dlg`, `#dlginput`, `#dlgok`, `#pname`,
  `#status`, …). The matrix is the refactor's safety net; do not rename ids.
- No browser-native popups, ever (prompt/confirm/alert throw in the matrix;
  choice dialogs are real buttons, never a `<select>`). See memory
  `feedback/lattice-ui/no-native-browser-popups` / `style-native-controls`.
- The pier-economy rules in the current code are load-bearing and must survive
  verbatim: never refetch what the client knows, the `mutate()` echo window,
  `treeGen`/`knowGen` stale-response guards, localStorage boot snapshots,
  save serialization (`saving`/`savePending`), the hidden-pane preview skip.
- Deploy/test only against tyr (localhost:8080 harness), never ricsul.
  Dev loop per `docs/ui-migration/PLAN.md`: repo file → `sync-overlay` →
  desk commit; verify served JS with `node --check` + curl.
- sneagan commits; the implementer leaves the diff in the tree and hands over
  a suggested commit message per task.
- Visual milestones (M3–M6) are verified RENDERED: puppeteer screenshots in
  dark AND light, not by reading the stylesheet.

## Why custom elements (what this buys, concretely)

1. **Markup and behavior co-located.** Today a pane is split between
   `index.html` (structure) and `app.js` (wiring), which is why the
   service-worker HTML/JS cache-skew guards exist (`spin-css`, `dlgopt-css`
   injection, `dlgOpts` element synthesis — app.js:21–41, 94–114). When a
   component builds its own DOM, that whole failure class disappears: JS can
   never reference shell markup that isn't there, because JS makes the markup.
2. **The shell becomes a table of contents.** `index.html`'s body shrinks to
   ~15 lines of `<lat-*>` tags in the grid; the tag names document the UI.
3. **Bounded files.** Each pane is one file an editor (human or model) can
   hold in context; today every change navigates a 1687-line closure.
4. **No new runtime cost.** `customElements.define` on an already-parsed page
   upgrades synchronously; same one script, same one stylesheet.

**Deliberately NOT doing** (ponytail — add only when a need appears):
- No Shadow DOM, no templates/slots, no `attributeChangedCallback` reactivity
  — these panes are singletons configured by code, not by attributes.
- No event bus / store / registry. All modules share the build IIFE's scope;
  the existing explicit call graph (`renderTree()`, `st()`, `openPage()`)
  stays. Add a bus only if a third consumer ever needs to react to something
  its caller doesn't know about.
- No `S.*` state-object rename. Shared `let` bindings in `20-state.js` are
  already visible to every module in the shared scope; renaming ~300 call
  sites buys nothing.
- No bundler. `cat` with filename ordering is the entire build.

## File Structure

```
grubbery-overlay/nex/lattice/ui-app/
  index.html            shell: inlined CSS + grid of <lat-*> tags (M6 end-state)
  app.js                BUILT ARTIFACT — committed, header says DO NOT EDIT
  src/                  the real source, concatenated in filename order
    10-shell.js         $ helper, api const, st/stWork, prevBlank
    15-dialog.js        <lat-dialog> + ask/askConfirm/askChoice
    20-state.js         shared lets, mutate(), gen counters, snapshots
    25-editor.js        <lat-editor>: src/hl markup, Prism render, Tab, keys
    30-tree.js          <lat-tree>: markup, renderTree, node patch helpers
    35-pages.js         openPage/applyPage/newFile/newFolder/save/autosave
    40-grub.js          grub open/save overlay
    45-templates.js     newFromTemplate
    55-autocomplete.js  wikilink dropdown (lives inside <lat-editor>'s DOM)
    60-preview.js       <lat-preview>: iframe, refreshPreview, checkErrors
    65-ctl.js           <lat-ctl>: pane frame, cerr, cmd row, move/delete
    66-share.js         <lat-share>
    67-history.js       <lat-history> (+ backlinks <lat-links>)
    68-knowtags.js      <lat-knowtags>
    70-upload.js        upload logic + panel (markup owned by <lat-tree>)
    75-move.js          movePage/moveFolder
    85-layout.js        <lat-bar>, <lat-tabs>, toggles
    90-sync.js          SSE beacon / focus / 30s poll refresh
    95-know.js          knowledge mode + setMode
    98-legacy.js        legacyCheck
    99-boot.js          bootSnap + boot dispatch
scripts/build-ui.mjs    concat build (new)
```

M1 creates these files by pure motion (original statement order preserved);
M2–M6 then move markup into the components. File numbers leave gaps on
purpose; order only matters where top-level statements execute at load.

---

### Task M0: Build harness — one artifact, many sources

**Files:**
- Create: `scripts/build-ui.mjs`
- Create: `grubbery-overlay/nex/lattice/ui-app/src/10-app.js` (whole current body, temporarily)
- Modify: `grubbery-overlay/nex/lattice/ui-app/app.js` (becomes built output)
- Modify: `.github/workflows/ci.yml` (freshness check)

**Interfaces:**
- Produces: `node scripts/build-ui.mjs` — reads `ui-app/src/*.js` sorted by
  name, emits `ui-app/app.js` wrapped as
  `/* BUILT FILE — edit ui-app/src/, run scripts/build-ui.mjs */\n(function () {\n'use strict';\n…\n})();\n`.
  Later tasks rely on: shared scope across all src files, filename ordering.

- [ ] **Step 1: Write the build script**

```js
#!/usr/bin/env node
// Concatenate ui-app/src/*.js (filename order) into the served app.js.
// One IIFE, one served asset — the pier serializes requests (~2s each),
// so the client must stay a single file. No deps, no bundler.
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ui = join(dirname(fileURLToPath(import.meta.url)),
  '..', 'grubbery-overlay', 'nex', 'lattice', 'ui-app');
const srcDir = join(ui, 'src');
const files = readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
if (!files.length) { console.error('no src files'); process.exit(1); }

const body = files
  .map((f) => `// ── src/${f} ` + '─'.repeat(Math.max(1, 66 - f.length)) + '\n'
    + readFileSync(join(srcDir, f), 'utf8').trimEnd() + '\n')
  .join('\n');

writeFileSync(join(ui, 'app.js'),
  '/* BUILT FILE — do not edit. Source: ui-app/src/, build: scripts/build-ui.mjs */\n'
  + '(function () {\n\'use strict\';\n' + body + '})();\n');
console.log(`built app.js from ${files.length} src files`);
```

- [ ] **Step 2: Seed src/ with the current body, verbatim**

Copy `app.js` lines 2–1686 (everything inside the existing
`(function () { … })();` wrapper, dropping only the wrapper lines themselves
and keeping the `// lattice app` comment) into `ui-app/src/10-app.js`.

- [ ] **Step 3: Build and prove the output is equivalent**

```bash
node scripts/build-ui.mjs
node --check grubbery-overlay/nex/lattice/ui-app/app.js
# body must be byte-identical to the pre-build app.js interior:
git diff --stat grubbery-overlay/nex/lattice/ui-app/app.js  # header/wrapper only
```

Note: the original body did not declare `'use strict'`; the wrapper adds it.
The file already parses strict-clean (`node --check` on a temp copy with
`'use strict'` prepended proves it before shipping). If anything trips
(undeclared assignment), fix it in this task — it's a latent bug anyway.

- [ ] **Step 4: CI freshness gate** — in `.github/workflows/ci.yml` `static`
job, replace the `node --check …app.js` line with:

```yaml
      - name: UI builds and the artifact is current
        run: |
          node scripts/build-ui.mjs
          git diff --exit-code grubbery-overlay/nex/lattice/ui-app/app.js
          node --check grubbery-overlay/nex/lattice/ui-app/app.js
          node --check scripts/ui-matrix.mjs
```

- [ ] **Step 5: Deploy to tyr and run the matrix**

```bash
scripts/sync-overlay.sh && <desk commit per grubbery-ops docs>
node scripts/ui-matrix.mjs   # LATTICE_URL defaults to the tyr harness
```

Expected: all checks ok — behavior is byte-identical.

- [ ] **Step 6: Hand over** — suggested commit:
`build: ui-app served from a built artifact; source moves to ui-app/src/`

---

### Task M1: Mechanical split into ordered modules

**Files:**
- Delete: `ui-app/src/10-app.js`
- Create: the `src/` files listed in File Structure (except the `<lat-*>`
  markup moves — those come later; at this stage `15-dialog.js` etc. hold the
  current code for that section, unchanged)

**Interfaces:**
- Produces: section-per-file layout. Because every file is inside the one
  built IIFE, all existing names (`current`, `dirty`, `nodes`, `renderTree`,
  `st`, `openPage`, …) remain visible everywhere. NOTHING is renamed.

- [ ] **Step 1: Split at the existing `── section ──` banners, preserving
  original statement order exactly.** Mapping from current `app.js` lines:

| src file | current app.js lines | contents |
|---|---|---|
| 10-shell.js | 1–52 | `$`, `api`, element consts, `prevBlank`, spinner, `st`/`stWork` |
| 15-dialog.js | 54–159 | dialog consts + ask/askConfirm/askChoice + form wiring |
| 20-state.js | 161–212 | state lets, `qs`, `mutate`, gen counters, snapshots, `collapsed` |
| 25-editor.js | 214–250 | LMAP, `render`/`sync`/`scheduleRender`/`edited`, input listeners |
| 30-tree.js | 252–389 | loadTree, markCurrent, node patchers, renderTree, extOf, treeShare, pageCount, setCtlLabels, selectFolder |
| 35-pages.js | 391–539 | setFolderCtx, openPage, applyPage, newFile, newFolder, save, autosave |
| 40-grub.js | 541–591 | grubPath, openGrub, saveGrub |
| 45-templates.js | 593–665 | save-button click, newFromTemplate, new-file/folder clicks, Cmd+S + Tab keydown |
| 55-autocomplete.js | 667–794 | the whole wikilink dropdown |
| 60-preview.js | 796–838 | CONTENT, refreshPreview, input debounce, checkErrors |
| 65-ctl.js | 840–921 | showShare + share buttons, sendCmd, delete handler |
| 70-upload.js | 923–1027 | KMAP…drag-drop |
| 75-move.js | 1029–1069 | movePage, moveFolder |
| 67-history.js | 1071–1213 | backlinks, panel toggles, history, `$('mv')` handler |
| 85-layout.js | 1215–1243 | toggles, mobile tabs |
| 90-sync.js | 1245–1312 | refreshOpen, refreshAll, EventSource, focus/poll |
| 95-know.js | 1314–1530 | knowledge mode + setMode |
| 98-legacy.js | 1532–1644 | legacyCheck |
| 99-boot.js | 1646–1686 | bootSnap + boot dispatch |

(65-ctl / 67-history run in a different relative order than the table lists
them in File Structure — the FILENAME numbers above are chosen so sorted
order equals original statement order. Keep exactly these numbers.)

- [ ] **Step 2: Build; the artifact body must be identical to M0's output
  except the inserted `// ── src/…` banners.**

```bash
node scripts/build-ui.mjs
git diff grubbery-overlay/nex/lattice/ui-app/app.js   # banners only
node --check grubbery-overlay/nex/lattice/ui-app/app.js
```

- [ ] **Step 3: Deploy to tyr, run ui-matrix.** Expected: green.
- [ ] **Step 4: Hand over** — suggested commit:
`refactor: split ui-app source into ordered modules (no behavior change)`

---

### Task M2: `<lat-dialog>` — the worked example

The pattern every later component copies: the class renders the pane's markup
into its light DOM, assigns the SHARED module-scope element refs, and wires
its own listeners. Call sites elsewhere don't change.

**Files:**
- Modify: `ui-app/src/15-dialog.js` (full rewrite below)
- Modify: `ui-app/index.html` (replace `<div class="dlg" id="dlg">…</div>`
  block with `<lat-dialog></lat-dialog>`; add one CSS line, see Step 3)
- Modify: `scripts/ui-matrix.mjs` (one new boot assertion)

**Interfaces:**
- Consumes: `$` from 10-shell.js.
- Produces: unchanged globals `ask(msg, value, okLabel) → Promise<string|null>`,
  `askConfirm(msg, okLabel) → Promise<boolean>`,
  `askChoice(msg, options, okLabel) → Promise<string|null>`, and the shared
  refs `dlg`, `dlgIn` other modules already use (ui-matrix drives `#dlginput`
  / `#dlgok` / `#dlgcancel` directly).

- [ ] **Step 1: Rewrite 15-dialog.js as a component.** Shared refs become
`let` (assigned in `connectedCallback`), the markup moves from index.html
into the class, the `dlgopt-css` / `dlgOpts`-synthesis skew guards are
DELETED (the component builds that DOM itself now — keep the `.dlgopts` rules
in the shell stylesheet):

```js
// ── in-app dialogs — NEVER browser-native prompt/confirm/alert ───────────
let dlg, dlgMsg, dlgIn, dlgSel, dlgOpts, dlgForm;
let dlgDone = null;
const dlgClose = (v) => {
  if (!dlgDone) return;
  dlg.hidden = true;
  const d = dlgDone; dlgDone = null; d(v);
};
const dlgOpen = (msg, okLabel) => {
  dlgMsg.textContent = msg;
  $('dlgok').textContent = okLabel || 'ok';
  dlg.hidden = false;
  return new Promise((res) => { dlgDone = res; });
};
const ask = (msg, value, okLabel) => { /* body unchanged from today */ };
const askConfirm = (msg, okLabel) => { /* body unchanged */ };
const askChoice = (msg, options, okLabel) => { /* body unchanged — real
  buttons, never a <select>; arrow keys; Esc cancels */ };

customElements.define('lat-dialog', class extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
<div class="dlg" id="dlg" hidden>
  <form class="dlgbox" id="dlgform">
    <div id="dlgmsg"></div>
    <div id="dlgopts" class="dlgopts" hidden></div>
    <select id="dlgsel" hidden></select>
    <input id="dlginput" autocomplete="off" spellcheck="false">
    <div class="dlgbtns">
      <button type="button" id="dlgcancel">cancel</button>
      <button type="submit" id="dlgok">ok</button>
    </div>
  </form>
</div>`;
    dlg = $('dlg'); dlgMsg = $('dlgmsg'); dlgIn = $('dlginput');
    dlgSel = $('dlgsel'); dlgOpts = $('dlgopts'); dlgForm = $('dlgform');
    dlgForm.onsubmit = (e) => {
      e.preventDefault();
      dlgClose(!dlgSel.hidden ? dlgSel.value : dlgIn.hidden ? '' : dlgIn.value);
    };
    $('dlgcancel').onclick = () => dlgClose(null);
    dlg.onclick = (e) => { if (e.target === dlg) dlgClose(null); };
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !dlg.hidden) dlgClose(null);
    });
  }
});
```

Where a body says "unchanged", move today's code (app.js:69–150) verbatim;
only the two skew-guard blocks (app.js:94–114) are deleted.

Ordering note (applies to every component task): `customElements.define`
upgrades the already-parsed tag synchronously, so the shared refs are
assigned the moment this src file executes — before any later-numbered file
or the boot code touches them. This is why component files keep LOWER numbers
than the modules that use their refs, and why the dialog's refs must not be
read at the top level of earlier files.

- [ ] **Step 2: Shell edit.** In `index.html`, replace the whole
`<div class="dlg" id="dlg" hidden>…</div>` block (lines 355–366) with
`<lat-dialog></lat-dialog>`.

- [ ] **Step 3: Add ONE stylesheet rule** (custom elements default to
`display: inline`, which breaks grid/overlay children — this rule covers
every component this plan adds):

```css
lat-dialog, lat-bar, lat-tabs, lat-tree, lat-editor, lat-preview, lat-ctl,
lat-share, lat-history, lat-links, lat-knowtags { display: contents; }
```

`display: contents` makes the wrapper invisible to layout: `.dlg` stays a
`position: fixed` overlay, and pane components' inner divs stay direct grid
items of `.ws`. (For `<lat-editor>`'s absolutely-positioned internals the
inner `.edwrap` div remains the containing block — components keep their
existing wrapper divs INSIDE themselves for exactly this reason.)

- [ ] **Step 4: Matrix addition** — after the existing boot check in
`scripts/ui-matrix.mjs`, assert upgrades succeeded (catches a thrown
`connectedCallback`, which otherwise fails silently as a dead pane):

```js
check('boot: custom elements upgraded', await page.evaluate(() =>
  [...document.querySelectorAll('*')].filter((e) => e.tagName.includes('-'))
    .every((e) => e.constructor !== HTMLElement)));
```

- [ ] **Step 5: Build, deploy to tyr, run ui-matrix** (it drives every dialog
path: folder create, delete confirm, choice dialogs). Expected: green.
- [ ] **Step 6: Hand over** — suggested commit:
`refactor: dialog becomes <lat-dialog>, markup out of the shell`

---

### Task M3: `<lat-editor>`

**Files:**
- Modify: `ui-app/src/25-editor.js` (component + today's render logic)
- Modify: `ui-app/src/55-autocomplete.js` (only ref assignments move)
- Modify: `ui-app/index.html` (replace `.edwrap` div, app.js keeps ids)

**Interfaces:**
- Consumes: `$`, `pkind`, state lets.
- Produces: shared refs `src`, `hl`, `acEl`, `acMirror`; unchanged globals
  `render()`, `sync()`, `scheduleRender()`, `edited()`, `LMAP`, `esc`.

- [ ] **Step 1:** In 25-editor.js, change `const src = $('src'), hl = $('hl')`
(currently in 10-shell.js — move these two refs here) to component-assigned
`let`s, and define:

```js
customElements.define('lat-editor', class extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
<div class="edwrap">
  <div id="acmirror" aria-hidden="true"></div>
  <div id="ac" class="ac" hidden role="listbox" aria-label="page suggestions"></div>
  <pre id="hl" aria-hidden="true"></pre>
  <textarea id="src" spellcheck="false" placeholder="open a page from the tree, or name a new one and start typing"></textarea>
</div>`;
    src = $('src'); hl = $('hl');
    // listeners currently at app.js:243–250 move here verbatim:
    src.addEventListener('input', () => { dirty = true; scheduleRender();
      clearTimeout(autoTimer); autoTimer = setTimeout(autosave, 2000); });
    src.addEventListener('scroll', sync);
  }
});
```

`render`/`sync`/`scheduleRender`/`edited` stay module-scope functions,
verbatim. The Tab/Cmd+S keydown handler stays in 45-templates.js (it
coordinates save modes, not editor internals). `acEl`/`acMirror` assignment
moves into the class (`acEl = $('ac'); acMirror = $('acmirror');`) since the
elements now exist only after upgrade; the `src.addEventListener('input',
acScan)` trio in 55-autocomplete.js moves into a small
`wireAutocomplete()` called from `connectedCallback` (or simply relocate
those three lines into the class — either is fine, keep it to one).

CAUTION: 25-editor.js is numbered BELOW 55-autocomplete.js, so at define-time
`acScan` isn't declared yet if referenced at top level. `wireAutocomplete` is
called from `connectedCallback`, which runs at define-time — so instead wire
autocomplete's listeners at the TOP LEVEL of 55-autocomplete.js exactly as
today (they run after `src` is assigned, since 55 > 25). No forward refs.

- [ ] **Step 2:** Shell: replace the `.edwrap` div block (index.html:310–315)
with `<lat-editor></lat-editor>`.
- [ ] **Step 3:** Build, `node --check`, deploy tyr, ui-matrix green (editor
typing, Prism, Tab, autocomplete, Cmd+S are all matrix-covered).
- [ ] **Step 4:** Screenshot dark + light (editor + caret + highlight
overlay alignment — scroll a long page; the #hl/#src scroll-sync geometry is
the fragile part). Compare with pre-change screenshots.
- [ ] **Step 5:** Hand over — `refactor: editor pane becomes <lat-editor>`

---

### Task M4: `<lat-tree>`

**Files:**
- Modify: `ui-app/src/30-tree.js` (component + render fns)
- Modify: `ui-app/src/70-upload.js` (ref assignments only)
- Modify: `ui-app/index.html` (replace `<aside class="tree">` block)

**Interfaces:**
- Consumes: state lets, `ask`, actions (`newFile`, `newFolder`,
  `newFromTemplate`, `openPage`, `selectFolder`, `uploadItems`).
- Produces: shared refs `treeList`, `treePane`, `chipsEl`, upload-panel refs
  (`upPanel`, `upMsg`, `upFill`, `upErr`), pickers; unchanged globals
  `renderTree()`, `markCurrent()`, `rowByPath`, node patchers, `extOf`,
  `treeShare`, `pageCount`.

- [ ] **Step 1:** Component renders today's aside markup (index.html:289–309)
verbatim inside `<aside class="tree" id="tree">…</aside>`, assigns the shared
refs, and wires the buttons that live in the pane: `#newfile`, `#newfolder`,
`#newtmpl`, `#upfiles`, `#updir`, `#fpick`/`#dpick` `onchange`. Button
HANDLER functions stay where they are (45-templates.js, 35-pages.js) — only
the `.onclick =` wiring lines move into `connectedCallback`.
  - Numbering caution: those handlers (`newFolder`, `newFromTemplate`) are
    declared in HIGHER-numbered files. Function declarations are hoisted only
    within the whole IIFE at parse time — `function` declarations ARE visible
    (the IIFE is one script), but `newFromTemplate` is a `function` decl (ok)
    while nothing needed is a `const` arrow — verify each wired name is a
    `function` declaration; convert any that isn't (e.g. `newFolder` is
    `async function` — ok).
- [ ] **Step 2:** Drag-drop `window.addEventListener('dragover'/'drop'…)`
block (app.js:1012–1027) moves into `connectedCallback`; `treePane = this
.querySelector('#tree')`.
- [ ] **Step 3:** Shell: replace the aside block with `<lat-tree></lat-tree>`.
- [ ] **Step 4:** Build, deploy tyr, ui-matrix (tree render, collapse,
folder ops, upload, drag-drop are covered). Screenshot dark + light.
- [ ] **Step 5:** Hand over — `refactor: tree pane becomes <lat-tree>`

---

### Task M5: `<lat-ctl>` and its panels

**Files:**
- Modify: `ui-app/src/65-ctl.js` — `<lat-ctl>` frame: renders the aside
  (index.html:317–353) as nested panel tags:

```html
<aside class="ctl">
  <h3>status</h3>
  <div id="cerr" class="ok">&nbsp;</div>
  <div id="cmdrow"> … verbatim … </div>
  <lat-knowtags></lat-knowtags>
  <lat-share></lat-share>
  <lat-history></lat-history>
  <lat-links></lat-links>
  <button id="mv" class="mvbtn">move / rename</button>
  <button id="del" class="del">delete page</button>
</aside>
```

- Create: `src/66-share.js` — `<lat-share>` renders `#sharesec` markup,
  assigns `cwurl`, moves `showShare` + the share-button wiring
  (app.js:840–881) verbatim.
- Modify: `src/67-history.js` — `<lat-history>` renders `#histsec` +
  `#histview` + `#histlist`; `<lat-links>` renders `#linksec`. The functions
  (`loadHistory`, `openRev`, `exitRev`, `loadBacklinks`, `resetPanels`,
  panel toggles) stay module-scope verbatim; only ref assignment + `.onclick`
  wiring moves into the classes.
- Create: `src/68-knowtags.js` — `<lat-knowtags>` renders `#knowmeta`,
  assigns `knowMeta`/`ktagsEl`, wires `#ktagadd`; `renderKnowTags` stays in
  95-know.js (it's know-mode logic; it only touches `ktagsEl`).

**Interfaces:**
- Consumes: state, `mutate`, `ask`/`askConfirm`, actions.
- Produces: refs `cerr`, `cwurl`, `histSec`, `histList`, `histView`,
  `linkSec`, `linkList`, `knowMeta`, `ktagsEl`; globals unchanged.
- Nested-upgrade note: `<lat-ctl>`'s innerHTML contains the panel tags. The
  panel classes are DEFINED in higher-numbered files, so at `<lat-ctl>`
  define-time they parse as unknown elements and upgrade a moment later when
  their own file executes. Refs are therefore assigned in file order —
  nothing reads them at top level in between (verify: `resetPanels()` is only
  CALLED from `applyPage`/boot paths, at runtime; add such execution-order
  checks in review, not new machinery).

- [ ] **Step 1:** Implement per above; delete handler (`$('del').onclick`,
app.js:896–921) and cmd box (883–893) wiring move into `<lat-ctl>`'s
`connectedCallback`; `sendCmd`, the delete logic body stay module-scope.
- [ ] **Step 2:** Shell: replace the aside with `<lat-ctl></lat-ctl>`. Note
the `.ws.know` CSS hides panels by ID (`#sharesec`, `#histsec` …) — ids are
inside the components now, selectors unchanged, still match (light DOM).
- [ ] **Step 3:** Build, deploy tyr, ui-matrix (share, history restore,
knowledge tags, delete are covered). Screenshot dark + light, pages AND
knowledge mode.
- [ ] **Step 4:** Hand over — `refactor: controls pane becomes <lat-ctl> with panel components`

---

### Task M6: `<lat-bar>`, `<lat-tabs>`, `<lat-preview>`, shell end-state

**Files:**
- Modify: `src/85-layout.js` — `<lat-bar>` (header: home link, `#modet`,
  `#pname`, `#pkind`, `#save`, spinner + `#status`, `#wrapt`/`#treet`/`#ctlt`)
  and `<lat-tabs>` (`.mtabs`). The spinner element becomes part of the bar's
  markup (`<span id="spin"></span>` before `#status`) and its keyframes move
  into the shell stylesheet — deleting the `spin-css` injection guard
  (app.js:21–41). `applyToggles`/`flip`/`setMv`/`isMobile` stay module-scope.
- Modify: `src/60-preview.js` — `<lat-preview>` renders
  `<iframe class="prev" id="prev" title="live preview"></iframe>`, assigns
  `prev`.
- Modify: `src/10-shell.js` — the element consts that remain
  (`pname`, `pkind`, `status`) become `let`s assigned by `<lat-bar>`;
  10-shell.js keeps only `$`, `api`, `st`/`stWork`, `prevBlank`.
  ORDER FIX: `st` writes `status.…` — fine, it runs at runtime; but
  `<lat-bar>` must be defined in a file numbered BELOW any file whose
  TOP-LEVEL code calls `st()` (none do today; boot calls are in 99).
  Move the `<lat-bar>`/`<lat-tabs>` definitions to a NEW `12-bar.js` so the
  refs exist before 15-dialog and later files run their define-time code.
- Modify: `ui-app/index.html` — final body:

```html
<body>
<div class="ws" id="ws">
  <lat-bar></lat-bar>
  <lat-tabs></lat-tabs>
  <lat-tree></lat-tree>
  <lat-editor></lat-editor>
  <lat-preview></lat-preview>
  <lat-ctl></lat-ctl>
</div>
<lat-dialog></lat-dialog>
<script src="/apps/lattice/prism.js"></script>
<script>if("serviceWorker"in navigator)navigator.serviceWorker.register("/apps/lattice/sw.js",{scope:"/apps/lattice"});</script>
<script src="/apps/lattice/app/app.js"></script>
</body>
```

**Interfaces:**
- Produces: refs `ws`, `pname`, `pkind`, `status`, `prev`, `spinner`;
  everything else unchanged.

- [ ] **Step 1:** Implement; keep `#mtabs` wiring (`setMv`) as today.
- [ ] **Step 2:** Build, deploy tyr, full ui-matrix INCLUDING the mobile
viewport section (tabs, per-pane display) — this task touches it most.
- [ ] **Step 3:** Screenshot dark + light, desktop + 400px mobile.
- [ ] **Step 4:** Hand over — `refactor: shell reduced to component tags; bar/tabs/preview componentized`

---

### Task M7: Cleanup, docs, ledger

- [ ] **Step 1:** Sweep for dead code: the skew guards are gone (M2, M6);
grep for `getElementById('spin-css')`, `dlgopt-css`, `dlgOpts` synthesis —
zero hits expected. `10-shell.js` should be ≤ 30 lines.
- [ ] **Step 2:** Write `ui-app/README.md` (~30 lines): the build invariant
(one served file), the shared-IIFE-scope rule, the file-number-equals-
execution-order rule and its two caveats (component refs assigned at
define-time; only `function` declarations may be wired before their file),
the no-Shadow-DOM and keep-ids rules, and the dev loop (edit src → build →
sync-overlay → matrix).
- [ ] **Step 3:** Update `docs/ui-migration/PLAN.md` with a pointer to this
plan and the new source layout (it currently documents `ui-app/` as
index.html + app.js).
- [ ] **Step 4:** Full regression: ui-matrix green on tyr, screenshots both
themes both modes, `node --check`, CI freshness gate passes.
- [ ] **Step 5:** Hand over — `docs: ui-app structure README; migration plan pointer`

---

## Risks and their mitigations

- **TDZ / execution-order regressions** (the only real hazard of the shared-
  scope concat): mitigated by (a) M1 preserving original statement order
  byte-for-byte, (b) component tasks moving only ref-assignment + wiring, not
  logic, (c) `node --check` + matrix on every task, (d) the M2 matrix
  assertion that every `lat-*` tag actually upgraded.
- **Service-worker skew** (new app.js against cached old index.html): shrinks
  every task — by M6 the shell is only CSS + tags, and a stale shell missing
  a tag renders a blank pane rather than throwing. The existing guards are
  deleted only in the same task that moves their markup into JS. One residual:
  a stale shell missing the `lat-* { display: contents }` rule after M2 —
  ship that CSS line in the SAME desk commit as M2 and the skew window is one
  deploy.
- **CSS specificity**: none — light DOM, same ids/classes, one added rule.
- **The matrix is id-driven**: ids never change, so it keeps passing without
  edits (plus the one new upgrade assertion).

## Self-review notes

- Every current feature maps to a task (dialogs M2; editor+autocomplete M3;
  tree+upload+drag-drop M4; share/history/backlinks/knowtags/cmd/delete M5;
  bar/tabs/preview/toggles/mobile M6; grub, templates, know, sync, legacy,
  boot stay as plain modules from M1 — they are logic, not panes, and gain
  nothing from element-hood).
- Names used across tasks are today's names, unchanged — that is the plan's
  central trick; the only new names are the `lat-*` tags, `build-ui.mjs`,
  and `wireAutocomplete` (M3, optional).
- No task depends on a later task's output.
