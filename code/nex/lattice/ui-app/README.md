# ui-app: the lattice-hosted editor client

The ship serves exactly TWO assets from here: `index.html` (shell) and
`app.js` (client). Every extra asset request costs ~2s on the serialized
pier, so this never grows a third file.

## Build

`app.js` is a BUILT ARTIFACT. Never edit it. Source lives in `src/`, and
`node scripts/build-ui.mjs` concatenates `src/*.js` in filename order into
one IIFE. CI fails if the committed artifact is stale
(`git diff --exit-code` after a build). `sync-overlay.sh` excludes `src/`
from the desk. The ball never sees the source files.

## Rules the layout encodes

- **One shared scope.** All src files live inside the single build IIFE, so
  every top-level `const`/`let`/`function` is visible to every file. Nothing
  is exported or imported. Cross-file calls are plain identifiers.
- **Filename order = execution order.** A file's top-level code may only
  *execute* names from lower-numbered files (function declarations hoist
  across the whole IIFE and may be referenced from anywhere at runtime,
  while `const`/`let` initializers must have run).
- **Custom elements own pane markup.** Each `<lat-*>` class renders its
  pane's HTML in its `connectedCallback` and assigns the shared element
  refs (`src`, `hl`, `treeList`, `cerr`, …). `customElements.define`
  upgrades the already-parsed tag synchronously, so those refs exist the
  moment the defining file executes. That is why component files are
  numbered BELOW the modules that use their elements.
- **Light DOM only, ids stable.** No Shadow DOM. The shell's single inlined
  stylesheet, the Prism token rules, and `scripts/ui-matrix.mjs`'s
  id-driven checks all rely on the global DOM. Never rename an id.
- **`lat-* { display: contents }`** (in the shell CSS) keeps component
  wrappers invisible to the `.ws` grid. Each component also carries a
  stale-shell guard. If a cached `index.html` predates its tag, it removes
  the old literal markup and inserts itself, so an HTML/JS service-worker
  cache skew degrades gracefully instead of breaking.
- **No browser-native popups.** Dialogs are `<lat-dialog>`, and a choice is
  real buttons, never a `<select>` (the matrix fails the run on any
  `prompt`/`confirm`/`alert`).
- The pier-economy rules (own-write echo window, `treeGen`/`knowGen` stale
  guards, localStorage boot snapshot, never-overlap saves) live in
  `20-state.js` and `35-pages.js`. They are load-bearing. See the comments
  there before touching refresh or save paths.

## File map

| file | owns |
|---|---|
| 10-shell.js | `$`, `api`, `st`/`stWork`, `prevBlank`, shared bar/preview refs |
| 12-bar.js | `<lat-bar>` (name/kind/save/status/toggles), `<lat-tabs>` |
| 15-dialog.js | `<lat-dialog>`, `ask`/`askConfirm`/`askChoice` |
| 20-state.js | shared state lets, `mutate()`, gen counters, snapshots |
| 25-editor.js | `<lat-editor>`, Prism render/sync/scheduleRender, `edited` |
| 30-tree.js | `<lat-tree>`, renderTree, node patch helpers, folder select |
| 35-pages.js | openPage/applyPage/newFile/newFolder/save/autosave |
| 40-grub.js | ?grub= ball-file editing overlay |
| 45-templates.js | save wiring, templates, Cmd+S / Tab keydown |
| 55-autocomplete.js | wikilink `[[` dropdown |
| 60-preview.js | `<lat-preview>`, refreshPreview, checkErrors |
| 65-ctl.js | `<lat-ctl>` frame, command box, delete |
| 66-share.js | `<lat-share>`, showShare |
| 68-knowtags.js | `<lat-knowtags>` markup (logic in 95) |
| 70-upload.js | pickers, drag-drop, upload progress |
| 75-move.js | movePage/moveFolder |
| 77-history.js | `<lat-history>`/`<lat-links>`, revisions, backlinks |
| 85-layout.js | pane toggles, mobile tabs behavior |
| 90-sync.js | beacon SSE + focus + 30s poll refresh |
| 95-know.js | knowledge mode + setMode |
| 98-legacy.js | one-time legacy agent import |
| 99-boot.js | boot snapshot + URL dispatch |

## Dev loop

Edit `src/` → `node scripts/build-ui.mjs` → deploy to the tyr harness →
`node scripts/ui-matrix.mjs` (must be green) → screenshot dark AND light
before calling visual work done. Never deploy to ricsul by hand.
