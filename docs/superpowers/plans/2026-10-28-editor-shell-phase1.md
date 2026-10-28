# Editor Shell, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the lattice editor's bar-and-three-panes chrome with an Obsidian-style shell (ribbon, tabbed side panes, document tabs, per-tab Edit/Read, status bar, mobile drawers) where every feature has exactly one home.

**Architecture:** The client stays one shared-scope IIFE built from `ui-src/lattice/*.js`. One live editor (`#src`) remains. A new tab model (`21-tabs.js`) snapshots and restores the document globals of `20-state.js` per tab, so the existing open/save/guard code keeps working unchanged against "the active tab". New custom elements render the ribbon and the two panes, and the existing sections (tree, controls, history, links, search, ACL, comments, conflicts) are moved into them rather than rewritten.

**Tech Stack:** vanilla JS (no deps), HTML/CSS in `code/nex/lattice/ui-app/index.html`, Hoon (`code/nex/lattice/app.hoon`) for three small routes, Rust (`desktop/src/main.rs`) for menu ids, puppeteer-core browser suites in `scripts/`.

**Spec:** `docs/superpowers/specs/2026-10-28-editor-overhaul-design.md` (wiki: `specs/2026-10-28-editor-overhaul-design`). This plan covers its **phase 1** only.

## Global Constraints

- Branch `feat-editor-shell` off `feat-lattice-forum` (the Forum ribbon icon needs `/forum`, which only exists there). Commit as `nisfeb <business@nisfeb.com>`; check `git config user.email` before the first commit.
- Commits pass the Doom lint: type from `feat fix refactor test docs tweak nit perf`, no scope, subject ≤72, body wrapped ≤72, no AI trailers, never `--no-verify`.
- Every commit that touches `ui-src/lattice/` also commits the rebuilt `code/nex/lattice/ui-app/app.js` (`node scripts/build-ui.mjs`). CI diffs it.
- No framework, no new dependency. Icons are flat SVG in `currentColor` via `ICON`/`ico()` in `10-shell.js`. No emoji, no font glyphs, no new hex colors in chrome CSS: only theme.js vars and `color-mix()` of them.
- Every icon button has `title` = `"<Name> (<shortcut>)"` (shortcut part omitted if none) and a matching `aria-label`.
- User-visible copy: no em-dashes.
- Save safety (`20-state.js`) must hold per tab: no tab switch, close, reload or mode change may lose typed work. `window.__latUnsaved` and the `beforeunload` guard cover every tab.
- Deploy only to fake ships (`scripts/dev-deploy.py`). Never ricsul. Browser suites run with `LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt` (the ~mec golden; refresh the raw cookie file if stale).
- Desktop menu ids in `desktop/src/main.rs` eval-click DOM ids. Any id the menu clicks must still exist (hidden is fine) or the menu must change in the same task.

## Out of phase 1 (rulings)

These spec items are behavior merges, not homes. Each gets its own small plan after phase 1, and none blocks the anti-goal. I'm listing them so the reviewer doesn't flag them as gaps:

- One search *engine*. Phase 1 gives search one home (the left-pane Search tab, using today's client engine). The reader's `/content-search` stays in the reader until phase 3 makes the reader a tab.
- Granting access "always through groups, always notifies". Phase 1 puts ship and group access together in the Page tab, with behavior unchanged.
- Browser, Forum and Explorer as tabs, and full-spread (phase 3). In phase 1 their ribbon icons navigate the window to `/apps/lattice`, `/apps/lattice/forum` and `/apps/lattice/x`, whose reader bar already links back to the editor.
- Splits (phase 2).

## Review Focus

1. Type in tab A, switch to tab B within the 2s autosave debounce, reload. A's text is on the ship.
2. Dirty grub tab, switch away and back. The text and the dirty dot survive. Closing it asks first. Reload while dirty triggers `beforeunload`.
3. Phone width (≤820px). Both drawers open and close, and every feature in the placement map is reachable without the old `#msheet`.
4. Desktop menu items (`file-*`, `view-*`, `manager`, `backups`). Each still does its job.
5. `localStorage.appTabs` corrupt or naming deleted pages. Boot falls back to one tab and never shows a blank shell.

---

### Task 1: Icon set and shell theme vars

**Files:**
- Modify: `ui-src/lattice/10-shell.js` (`ICON`, `ico`)
- Modify: `code/nex/lattice/ui-app/index.html` (`:root` vars, ~26-40)
- Create: `scripts/ui-icons.mjs` (pure suite)

**Interfaces:**
- Produces: `ico(name)` accepts these new names, drawn as stroke icons (`fill="none" stroke="currentColor" stroke-width="1.5"`), taken from the `<symbol>`s in `.superpowers/brainstorm/2280270-1793224573/content/layout-v2.html`: `pl pr cal globe forum inbox key tree conflict term gear pen fplus tpl upload sort fold out back list hist eye x left right dots menu plus pin mark know`. An `ICON` entry becomes `[viewBox, path, 'stroke']` for stroke icons. Fill icons are unchanged.
- Produces CSS vars: `--pane: color-mix(in srgb, var(--bg) 94%, var(--text))`, `--ribbon: color-mix(in srgb, var(--bg) 90%, var(--text))`, `--sel: var(--selection, color-mix(in srgb, var(--accent) 20%, transparent))`, each preceded by a `--raised` fallback declaration for engines without `color-mix`.

- [ ] **Step 1: Write the failing test** `scripts/ui-icons.mjs` (pure, `lib/check.mjs`, `read`/`cut` pattern from `ui-shared.mjs`):
  - `every ico() name used in ui-src exists in ICON`: grep `ico\('([a-z]+)'\)` across `ui-src/lattice/*.js` and assert each key is in `ICON`.
  - `stroke icons render fill none`: eval `ICON` and `ico`, and assert `ico('gear')` contains `fill="none"` and `stroke="currentColor"`.
  - `no emoji in chrome`: assert no `/\p{Extended_Pictographic}/u` match in `ui-src/lattice/1[0-9]-*.js` outside comments.
- [ ] **Step 2:** `node scripts/ui-icons.mjs` FAILS on `gear`.
- [ ] **Step 3:** Add the icons and the `ico` stroke branch. Add the vars.
- [ ] **Step 4:** `node scripts/ui-icons.mjs` PASSES. Run `node scripts/ui-theme.mjs` and `node scripts/build-ui.mjs`.
- [ ] **Step 5:** Commit: `feat: stroke icon set and derived shell colors`. Add `ui-icons.mjs` to the pure-suite list in `.github/workflows/ci.yml` (~176-181).

### Task 2: Shell frame (ribbon, panes, status bar, corner toggles)

**Files:**
- Create: `ui-src/lattice/13-frame.js` (`lat-ribbon`, `lat-lpane`, `lat-rpane`, `lat-statusbar`, pane-tab switching)
- Modify: `code/nex/lattice/ui-app/index.html` (body markup 682-697, `.ws` grid 75-100, mobile block 374-522 left alone until Task 9)
- Modify: `ui-src/lattice/12-bar.js` (bar shrinks: see below), `ui-src/lattice/85-layout.js` (grid vars, resize handles)
- Create: `scripts/ui-shell.mjs` (browser suite, skeleton from `ui-createdialog.mjs`)

**Interfaces:**
- Produces DOM: `#ribbon`, `#lpane` with `#ltabs` (buttons `data-pt="files|know|search|marks"`) and `#lbody`, `#center`, `#rpane` with `#rtabs` (`data-pt="page|out|back|outline|comments|hist"`) and `#rbody`, `#statusbar`. Each pane tab body is a `<section data-pane="<id>">`, and only the active one is unhidden.
- Produces: `paneTab(side: 'l'|'r', id: string): void`, which shows that section, marks its button `.on` and `aria-selected`, and persists to `localStorage.appLTab` / `appRTab`. Defaults are `files` and `page`.
- Produces: `paneOpen(side: 'l'|'r', open?: boolean): boolean`, which toggles `.nt`/`.nc` and `localStorage.appNT`/`appNC` as today. **Reuse the ids `#treet` (left corner, icon `pl`) and `#ctlt` (right corner, icon `pr`)** so `view-tree` and `view-controls` in `main.rs` keep working.
- Produces: `ribbonAdd({id, icon, name, keys, run, bottom?}): HTMLButtonElement`. Later tasks register ribbon items through this, never by markup.
- Moves, unchanged: `lat-tree` → `section[data-pane=files]`; `lat-ctl` → `section[data-pane=page]`; `lat-history` → `[data-pane=hist]`; `lat-links` → `[data-pane=back]`; `#status`, `#spin`, `#offbadge`, `#vimInd` → `#statusbar`. `#pname`, `#pkind`, `#modet`, `#viewseg`, `#qt`, `#cmt`, `#cflt`, `#aclt`, `#wrapt` and `#save` stay in the DOM for now but hidden (`hidden` attribute), because later tasks re-home them and the desktop menu clicks `#save`.
- `#statusbar` also shows a compile-error chip `#errchip` while `#cerr` has text. Clicking it runs `paneOpen('r', true); paneTab('r','page')`.
- Grid (desktop): columns `var(--wrib,40px) var(--wtree,240px) minmax(0,1fr) var(--wctl,280px)`; rows `auto 1fr auto` (doc-tab strip, body, status bar). `#ph1` resizes the left pane, `#ph3` the right. `#ph2` is removed with the split view.

- [ ] **Step 1: Write failing tests** in `scripts/ui-shell.mjs` at viewport 1400x900:
  - `ribbon, panes and status bar exist`: `#ribbon,#lpane,#rpane,#statusbar` are all present and visible.
  - `left pane tabs switch`: click `#ltabs [data-pt=know]`. Then `section[data-pane=know]` is visible, `[data-pane=files]` is hidden, and `localStorage.appLTab==='know'`. Reload. It is still `know`.
  - `corner toggles hide panes`: click `#treet`. `#lpane` width is 0, `#treet[aria-pressed=false]`. Click again to restore. Same for `#ctlt`/`#rpane`.
  - `every chrome button has a tooltip`: for each `button` in `#ribbon,#ltabs,#rtabs,#treet,#ctlt`, `title` is non-empty and equals `aria-label`.
  - `tree and status moved`: `#treelist` is inside `#lpane`, and `#status` is inside `#statusbar`.
- [ ] **Step 2:** Build, deploy to ~mec (`scripts/dev-deploy.py`), run the suite. It FAILS.
- [ ] **Step 3:** Implement. Today's left and right contents move with their ids intact, so every handler that uses `$()` keeps working.
- [ ] **Step 4:** Suite PASSES. Also run `ui-boot.mjs` and `ui-deskmenu.mjs` (`view-tree` and `view-controls` still toggle), and fix any selector they used for the old bar.
- [ ] **Step 5:** Commit: `feat: ribbon, tabbed side panes and status bar`

### Task 3: Document tab model

**Files:**
- Create: `ui-src/lattice/21-tabs.js`
- Modify: `ui-src/lattice/20-state.js` (`__latUnsaved`), `35-pages.js` (`openPage`, `beforeunload`), `95-know.js` (`openKnow`), `40-grub.js` (`openGrub`), `99-boot.js` (restore), `30-tree.js` / `79-search.js` / `77-history.js` link clicks (pass the click event)
- Create: `scripts/ui-tabs.mjs`

**Interfaces:**
- Produces the tab object `{id: string, kind: 'page'|'know'|'grub'|'tool', key: string, ship?: string, pinned: boolean, read: boolean, back: string[], fwd: string[], snap: null | {body: string, dirty: boolean, everTyped: boolean, sel: [number, number], scroll: number}}`. `key` is the page name, memory key, grub path or tool id.
- Produces `tabs: Tab[]`, `activeTab: Tab`, and these functions:
  - `openIn(kind, key, opts = {ev, ship, newTab}): Promise<void>`. This is the one entry point every UI click uses. If a tab with the same `kind`+`key`(+`ship`) exists, it focuses that tab. Else a new tab when `opts.newTab`, `ev.ctrlKey||ev.metaKey`, `ev.button===1`, or `activeTab.pinned`. Else it replaces in place: `guardDirty()`, push the old key on `back`, clear `fwd`.
  - `switchTab(id): Promise<void>`, `closeTab(id): Promise<boolean>` (calls `guardDirty` on that tab first; false means kept), `tabBack()`, `tabFwd()`.
- Algorithm for `switchTab` (the only non-obvious part):
  1. Park the active tab. If `dirty` and not a grub, wait for the save flight exactly as `guardDirty` does (reuse its wait loop, factored into `flushNoAsk(): Promise<boolean>`), with no prompt. Then store `snap` from the live globals (`src.value`, `dirty`, `everTyped`, selection, scroll).
  2. Activate the target. If its `snap?.dirty`, paint `snap.body` into `src`, set `dirty = true` and `everTyped`, and set `current`/`grubPath`/`mode` via `setOpen` and `setMode` without fetching. Else call the existing `openPage`/`openKnow`/`openGrub` (fresh from ship or cache), then restore selection and scroll.
- `window.__latUnsaved = () => dirty === true || tabs.some(t => t !== activeTab && t.snap?.dirty)`. `beforeunload` uses the same.
- Persistence: `localStorage.appTabs = JSON.stringify({tabs:[{kind,key,ship,pinned,read}], active})`, written on every open, close and switch. Bodies are never stored. Boot: `?name=`/`?grub=`/`?view=know&key=` → `openIn` on top of the restored list. A parse error or an unknown key drops that entry. An empty result gives one `newFile('', false)` tab.
- Tab strip `#doctabs` (in `#center`, row 1): one `button.dtab` per tab with kind icon, title, `.dirty` dot, × close, a `+` at the end (new page), middle-click closes, and a context menu with Pin/Unpin and Close others. Ctrl+W closes, Ctrl+Tab and Ctrl+Shift+Tab cycle.

- [ ] **Step 1: Write failing tests** in `scripts/ui-tabs.mjs` (seed pages `x-<pid>/a` and `x-<pid>/b` with `seed()`; delete them in `finally`):
  - `ctrl-click opens a second tab`: open a, Ctrl+click b in the tree. Then `#doctabs .dtab` count is 2 and the active one is b.
  - `plain click replaces`: plain click a while on b. Still 2 tabs, and a's tab is focused (same doc focuses existing).
  - `switch inside autosave window keeps both`: type `AAA` in a, switch to b within 500ms, type `BBB`, wait 4s. `fetch('/apps/lattice/page-source?name=…')` bodies contain `AAA` and `BBB` respectively.
  - `dirty grub survives switching`: open grub `/apps/lattice/README`-like test grub (seed one via `/grub-save` on a scratch path), type, switch away and back. The body has the text and `.dtab.dirty` exists. `closeTab` on it shows `#dlg` (confirm). Cancel keeps it.
  - `__latUnsaved sees background tabs`: with the dirty grub in the background, `window.__latUnsaved()===true`.
  - `tabs restore after reload`: reload, and the same keys appear in the same order with the same active tab.
  - `corrupt appTabs falls back`: set `localStorage.appTabs='{'`, reload. There is 1 tab and `#treelist` rendered.
  - `per-tab back`: in one tab open a then b (plain clicks), click back. The tab shows a.
- [ ] **Step 2:** Run. It FAILS.
- [ ] **Step 3:** Implement. Route every page, memory and grub click (tree rows, Shared-with-me, search results, backlinks, history `openRev` stays in-tab) through `openIn`, passing the event. `newFile` keeps its `function` declaration (96-deskmenu.js reassigns it).
- [ ] **Step 4:** PASSES. Re-run `ui-boot.mjs`, `ui-offline.mjs`, `ui-queue.mjs`, `ui-pagecache.mjs`, `ui-modeswitch.mjs`, and update their selectors only where they clicked removed chrome.
- [ ] **Step 5:** Commit: `feat: document tabs with per-tab save safety`

### Task 4: Tab header (back/forward, path, Edit/Read, page menu)

**Files:**
- Create: `ui-src/lattice/23-tabhead.js`
- Modify: `85-layout.js` (delete `VIEWS`/`view()`/`#viewseg` handling; Edit/Read reads `activeTab.read`), `12-bar.js` (drop `#viewseg`, keep hidden `#viewedit`/`#viewprev` delegates), `desktop/src/main.rs` (View menu)
- Test: `scripts/ui-tabs.mjs` (extend), `scripts/ui-view.mjs` (rewrite to Edit/Read), `scripts/desktop-commands.mjs`

**Interfaces:**
- Consumes `activeTab`, `tabBack`, `tabFwd` (Task 3) and `ico` (Task 1).
- Produces `#tabhead` above the editor area with `#tback`, `#tfwd`, `#tpath` (click runs today's `#mv` move/rename flow), `#tread` (a segmented Edit/Read control: `button[data-r=0]` Edit, `button[data-r=1]` Read), and `#tmenu` (⋯).
- `setRead(on: boolean): void` sets `activeTab.read`, toggles `.ve`/`.vp` (Edit hides `.prevwrap`, Read hides `.edwrap`; there is no split), and calls `showPreview()` on entering Read. Ctrl+E toggles it. Tooltip `Edit / Read (Ctrl+E)`.
- `#tmenu` items, each calling the existing handler: Kind ▸ (the 8 `#pkind` values; hidden `#pkind` stays as the store), Line wrap (`appWrap` flip), Duplicate (new: `newFile` prefilled with `<name>-copy` and the body), Export (78-export.js), Convert to HTML (`#texconv`, shown only for tex on desktop), Open raw (`/apps/lattice/page-source?name=`), Delete (`#del`).
- `main.rs`: `view-editor` → eval `latSetRead(false)`, `view-preview` → `latSetRead(true)` (expose `window.latSetRead = setRead`), remove `view-split` and its Ctrl+2 accelerator.

- [ ] **Step 1: Write failing tests**:
  - `edit/read per tab` (ui-tabs): set Read on tab a, switch to b (Edit), switch back. a is in Read: `.edwrap` hidden, `.prevwrap` visible.
  - `ctrl+e toggles` (ui-view).
  - `page menu kind change` (ui-view): pick `gmi` from `#tmenu`. `#pkind.value==='gmi'` and the page saves as gmi.
  - `path click opens move` (ui-view): click `#tpath`, and the move dialog `#dlg` opens prefilled with the current name.
  - `desktop view menu` (`desktop-commands.mjs`): the menu id list has no `view-split`, and `view-editor`/`view-preview` map to `latSetRead`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS, plus `cargo check` in `desktop/`.
- [ ] **Step 5:** Commit: `feat: tab header with Edit/Read and page menu`

### Task 5: Left pane tabs (Files, Knowledge, Search, Bookmarks)

**Files:**
- Modify: `30-tree.js` (toolbar: add sort and collapse-all), `95-know.js` (Knowledge section, drop `#modet`), `79-search.js` (search moves into the pane), `97-mobar.js` (stop clicking `#modet`/`#qt`)
- Create: `ui-src/lattice/31-marks.js` (Bookmarks section)
- Modify: `code/nex/lattice/app.hoon` (new `GET /bookmarks-json`, next to `[%'GET' %marks]` ~3342)
- Test: `scripts/ui-shell.mjs` (extend), `scripts/ui-modeswitch.mjs` (rewrite: modes are now tab kinds)

**Interfaces:**
- **One new-page flow:** move the `askNameKind` wrapper of `newFile` out of `96-deskmenu.js` into `35-pages.js` so web, desktop and phone all use the same name+kind dialog, with the folder prefilled when started from a folder `+`. `96-deskmenu.js` keeps only its desktop-specific hiding. `scripts/ui-createdialog.mjs` drops its `__TAURI__` stub and still passes.
- **Files toolbar:** today's `#newfile #newfolder #newtmpl #upfiles #updir` (ids kept for the desktop menu), plus `#tsort` (cycles `name`/`name-desc`, persisted to `localStorage.appSort`, applied in `renderTree` to siblings, folders first) and `#tcoll` (collapse all: adds every folder to `paneColl`).
- **Knowledge** (`section[data-pane=know]`): `#chips` and the memory tree render here always (`renderKnowTree` targets `#knowlist`, not the shared `#treelist`). Toolbar: `#knew` (new memory: same name+kind dialog as pages, kind fixed md, saved via `saveKnow`), `#ktidy` (opens a tool tab, Task 7, `frame:/apps/lattice/know?lint=1`), and `#ktrash` (toggles a trash list from `GET /know-trash`, each row with Restore → `POST /know-restore?key=`, then `loadKnow()`). `setMode` is now called only by `openIn('know', …)`/page opens. `#modet` is deleted, and so is `ms-mode` in 97-mobar.
- **Search** (`section[data-pane=search]`): `#qinput`, `#qsum`, `#qlist` move here from `#qwrap`, which is deleted. `qOpen()` becomes `paneOpen('l', true); paneTab('l','search'); $('qinput').focus()`. Ctrl/Cmd+K calls `qOpen`. Results go through `openIn` (Task 3). `#qt` is deleted.
- **Bookmarks:** `GET /apps/lattice/bookmarks-json` returns `[{url, title, folder}]` from `read-bookmarks`. `31-marks.js` renders folders via `folderRow`, a filter input, and per row: click (navigate the window to the reader at that url: `/apps/lattice/?q=<url>`, phase 3 makes it a tab), refile (`POST /bookmark-move?url=&folder=`) and remove (`POST /unbookmark?url=`, after `askConfirm`).

- [ ] **Step 1: Write failing tests**:
  - `knowledge tab lists memories without a mode switch`: `#modet` is absent, and `[data-pane=know] #knowlist` has rows.
  - `opening a memory makes a know tab`: click a memory row, then `activeTab.kind==='know'`, and the Files tree is still rendered in its section.
  - `ctrl+k focuses search pane`: press Ctrl+K. `document.activeElement.id==='qinput'` and `#lpane` is visible.
  - `sort toggles`: click `#tsort`. The first sibling at root order is reversed.
  - `trash restore`: soft-delete a seeded memory via `/know-delete`, open `#ktrash`, click Restore. `/know-read?key=` gives 200.
  - `bookmarks json`: `fetch('/apps/lattice/bookmarks-json')` gives 200 with an array, and the Bookmarks section renders one row per entry.
- [ ] **Step 2:** FAIL. **Step 3:** implement, and rebuild the desk Hoon (deploy recompiles; confirm `?info=1` shows `bang null`). **Step 4:** PASS, plus `ui-modeswitch.mjs` rewritten and green.
- [ ] **Step 5:** Commit: `feat: Files, Knowledge, Search and Bookmarks pane tabs`

### Task 6: Right pane tabs (Page, Outgoing, Backlinks, Outline, Comments, History)

**Files:**
- Modify: `65-ctl.js` (Page section: drop history/links/move/delete, which now live elsewhere; add comments toggle), `77-history.js` (sections now in their pane tabs), `73-comments.js` (per-page thread)
- Create: `ui-src/lattice/76-outline.js` (Outgoing + Outline)
- Modify: `code/nex/lattice/app.hoon`: `GET /page-source` (~1752) JSON gains `"comments": <bool>` from `+comments-on` (~5817) for that page.
- Test: `scripts/ui-shell.mjs` (extend)

**Interfaces:**
- **Page:** what `lat-ctl` shows today minus history, links, `#mv` and `#del`, plus `#cmton` (a checkbox "Comments on this page" that posts `/page-comments?name=&on=1|0` and reflects `comments` from page-source). Hidden for memories and grubs.
- **Outgoing** (`[data-pane=out]`): `outLinks(body: string, kind: string): string[]`, the link targets the md/gmi renderer in `59-md.js` would produce, deduped, in order. Reuse 59-md.js's link parsing rather than a second regex. Each row goes through `openIn('page', target, {ev})`. Unresolved targets (not in `nodes`) render muted.
- **Outline** (`[data-pane=outline]`): `outline(body, kind): {level: number, text: string, line: number}[]` for md (`#`…`######`) and gmi (`#`…`###`). A click puts the caret at that line in `#src` and scrolls to it (in Read mode it scrolls the preview to the matching heading index).
- **Comments** (`[data-pane=comments]`): this page's thread. Reuse `renderComments` filtered to `page === current`, with reply and remove as in the inbox.
- Tabs that do not apply to the active tab kind show the line `Nothing here for this tab.` They never hide.

- [ ] **Step 1: Write failing tests**:
  - `outline lists headings`: seed `# One\n## Two\ntext` and open it. `[data-pane=outline]` has 2 rows, and a click on "Two" puts `#src.selectionStart` at line 2's offset.
  - `outgoing lists links`: seed a page linking to `x-<pid>/a` (use the md link syntax 59-md.js renders). The Outgoing row exists, and clicking it opens a.
  - `comments toggle round-trips`: tick `#cmton`, reload the page source. `comments===true`. Untick it, and it is false.
  - `inapplicable tab says so`: open a grub, click `[data-pt=comments]`. The text is `Nothing here for this tab.`
  - `outLinks` and `outline` pure cases in `scripts/ui-md.mjs` (lift with `cut`): empty body → `[]`, headings inside fenced code are ignored.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit: `feat: right pane tabs with outline, outgoing links and comments`

### Task 7: Ribbon items and tool tabs

**Files:**
- Create: `ui-src/lattice/24-tools.js` (tool tab kinds)
- Modify: `72-acl.js`, `73-comments.js`, `80-conflicts.js` (render into a tool tab instead of a fixed overlay), `12-bar.js` (delete `#cmt #cflt #aclt` and the home link; the bar element is now empty and is removed)
- Test: `scripts/ui-shell.mjs` (extend), `scripts/ui-acl-prefs.mjs` (selectors)

**Interfaces:**
- Tool tabs: `openIn('tool', id)` with `id ∈ {'inbox','access','conflicts','settings'}` or `'frame:<url>'`. A tool tab hides `.edwrap`/`.prevwrap` and shows its host `#toolhost` in the center. `inbox` moves `#cmwrap`'s content into the host and calls `loadComments()`. `access` does the same with `#aclwrap` and `aclOpen()`'s loads. `conflicts` does it with `#cfwrap` and `renderConflicts()`. The fixed-overlay CSS no longer applies inside the host (`.aclwrap.intab{position:static}`). `cmOpen`, `aclOpen` and `cfOpen` become `openIn('tool', …)` so every existing caller (for example `#aclopen` in the Page tab) lands in the tab.
- Frame tools: an `<iframe>` (same origin) of the url. On `load`, the shell injects `<style>form.bar{display:none}</style>` into the frame document, so the reader chrome is hidden. `settings` = `frame:/apps/lattice/settings`.
- Ribbon (via `ribbonAdd`, top to bottom): `brief` (icon `cal`, "Today's brief"), `browser` (`globe`, "Browser", navigates the window to `/apps/lattice`), `forum` (`forum`, "Forum", navigates to `/apps/lattice/forum`), `inbox` (`inbox`, "Comments inbox", keeps today's unread badge logic from `paintUnread`/`refreshCommentBadge`, now on this button), `access` (`key`, "Access & groups"), `explorer` (`tree`, "Explorer", navigates to `/apps/lattice/x`), `conflicts` (`conflict`, "Sync conflicts", hidden unless `cfList().length`, with a count badge via `renderConfBadge`), `palette` (`term`, "Command palette (Ctrl+P)", Task 8), and bottom `settings` (`gear`, "Settings").
- `briefKey(d: Date): string` gives the first existing name among `journal/YYYY.M.D` and `journal/YYYY.MM.DD` for local `d` (check `nodes`). If neither exists, it gives `journal/YYYY.M.D` and `openIn` opens it as a new unsaved page. Ponytail ruling: orrery's day string format is unverified, so check both forms.

- [ ] **Step 1: Write failing tests**:
  - `ribbon order and tooltips`: the ribbon button names in order equal the list above.
  - `access opens as a tab`: click ribbon `access`. `activeTab.kind==='tool'`, `#aclgrid` is inside `#toolhost`, and no fixed overlay is visible. Clicking `#aclopen` in the Page tab focuses the same tab (tab count unchanged).
  - `settings frame hides reader bar`: open `settings`. Inside the iframe, `form.bar` is not displayed and `#themeui` exists.
  - `brief opens journal`: seed `journal/<YYYY.M.D today>`, click `brief`, and `activeTab.key` equals it.
  - `inbox badge moved`: with `cmtSeen` cleared and a comment present, the ribbon `inbox` button has `.has-unread`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS, plus `ui-acl-prefs.mjs` green. **Step 5:** Commit: `feat: ribbon and tool tabs for inbox, access, conflicts, settings`

### Task 8: Command palette

**Files:**
- Create: `ui-src/lattice/26-palette.js`
- Modify: every file that registers a ribbon item, pane-tab toolbar button or page-menu item also calls `action(...)` for it (Tasks 2-7 code)
- Test: `scripts/ui-shell.mjs` (extend)

**Interfaces:**
- `action({id: string, name: string, home: string, keys?: string, run: () => void}): void` registers into `ACTIONS`. `home` is the user-visible home, for example `"Ribbon"`, `"Files toolbar"`, `"Page menu"`, `"Right pane › Page"`, `"Settings"`.
- Palette `#palette` (a modal, reusing `.dlg` styling) opens with Ctrl/Cmd+P and the ribbon `palette` button. An input does subsequence fuzzy match on `name` (actions) then page and memory names (`nodes`, `knowKeys`). An action row shows `name`, a muted `home` and `keys`. Enter runs or opens (`openIn`). Esc closes.
- Rule enforced by test: the palette has no action whose `run` isn't also reachable from its `home`. Every registered `id` must appear as a `data-action` attribute on some element in the DOM (ribbon, toolbars, menus), except ids listed in `PALETTE_ONLY = []` (empty by design).

- [ ] **Step 1: Write failing tests**:
  - `ctrl+p opens palette`. Type `acc`. The first row is "Access & groups" with home "Ribbon". Enter opens the access tool tab.
  - `pages listed after actions`: type a seeded page name. The page row is below any action rows, and Enter opens it.
  - `every action has a home in the DOM`: for each `ACTIONS` id, `document.querySelector('[data-action="'+id+'"]')` is non-null.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit: `feat: command palette as an index over action homes`

### Task 9: Mobile drawers and bottom bar

**Files:**
- Modify: `code/nex/lattice/ui-app/index.html` (mobile block 374-522: replace the `data-mv` pane switching), `85-layout.js` (delete `MV`/`setMv`/`bootMv`/`#fullt`; keep `isMobile`), `97-mobar.js` (rewrite as drawers + bottom bar), `35-pages.js` (`applyPage`'s `setMv('code')` → close drawers)
- Test: `scripts/ui-mobar.mjs` (rewrite)

**Interfaces:**
- At ≤820px: `#ribbon` is hidden. `#lpane` and `#rpane` become fixed drawers (`transform` off-screen, `.ws.ldraw`/`.ws.rdraw` slide them in) with a scrim `#scrim` that closes on tap. `#treet`/`#ctlt` toggle the drawers instead of the columns. A left-edge or right-edge swipe of 24px or more from the screen edge opens the matching drawer.
- The left drawer shows the ribbon items as a row of icons above its pane tabs (same buttons, re-parented by CSS order, not duplicated, since one home includes one element).
- `#mbar` (bottom, fixed): new page (`newFile('')`), search (`qOpen`), today's brief, and tabs (`#mtabsw`, opens a sheet listing `tabs` with close buttons). Each button is registered with `action` (Task 8).
- Deleted: `#mtabs`, `#mmore`, `#msheet`, `#mpath`, `#fullt` and their localStorage keys (`appMv`, `appFull`; boot removes them).
- Opening a document closes both drawers.

- [ ] **Step 1: Write failing tests** (viewport 390x844, `isMobile`):
  - `drawers open and close`: tap `#treet`, and `#lpane` is in the viewport. Tap `#scrim`, and it is off-screen. Same for `#ctlt`.
  - `opening a page closes the drawer`.
  - `every placement-map home reachable`: from the drawers and `#mbar`, assert these elements are reachable (visible after at most one drawer open): `#newfile`, `#qinput`, `[data-pt=know]`, `[data-pt=marks]`, `#tmenu`, `#tread`, `[data-pt=page]`, `[data-pt=hist]`, and ribbon `settings`/`access`/`inbox`.
  - `old mobile chrome gone`: `#mtabs,#msheet,#mmore,#fullt` are all null.
  - `tab switcher`: open 2 pages, tap `#mtabsw`, and 2 rows are listed. Tap the other, and it becomes active.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit: `feat: mobile drawers and bottom bar`

### Task 10: Settings additions and desktop Preferences

**Files:**
- Modify: `code/nex/lattice/app.hoon` `++ settings-html` (~11747) and its inline script (~11828)
- Modify: `desktop/ui/manager.html` (remove the `#backups` section 178-206 and its script), `desktop/src/main.rs` (`backups` menu id → eval `latOpenSettings('backup')`), `ui-src/lattice/24-tools.js` (`window.latOpenSettings = (anchor) => openIn('tool', 'settings')` then scroll the frame to `#<anchor>`)
- Test: `scripts/ui-shell.mjs` (extend), `scripts/ui-manager.mjs`

**Interfaces:**
- New settings sections, each with an `id` anchor:
  - `#editor`: holds the existing vim select (`#vimsel`, moved here from Typography), plus a "Wrap long lines by default" checkbox (`appWrap`) and an "Autosave pages" checkbox (`localStorage.latAutosave`, default on). `autosave()` in 35-pages.js returns early when `latAutosave === '0'`.
  - `#publishing`: a "Ask before making a page public" button that does `localStorage.removeItem('latPubOk')`, shown only when the key is set.
  - `#legacy`: "Import from the old editor" runs the same `POST /legacy-migrate` and reports the counts. Shown whenever `GET /legacy-status` reports pages, even after "never ask again".
  - `#connection` (desktop only, shown when `window.top.__TAURI__`): a "Connection and mounts" button that calls `window.top.__TAURI__.core.invoke('show_manager')`. Confirm the command name in `desktop/src/commands.rs:66` first.
- The Backup section (`#vaultui`) already holds the desktop schedules (vault.js:512-534), so removing the manager copy leaves one home. Scheduler semantics (`backup.rs`) are unchanged.

- [ ] **Step 1: Write failing tests**:
  - `settings has editor, publishing, legacy anchors`: in the settings frame, `#editor #vimsel` exists, along with `#publishing` and `#legacy`.
  - `pubOk reset`: set `latPubOk='1'`, click reset, and the key is gone.
  - `autosave off`: set the checkbox off, type in a page, and wait 4s. The ship body is unchanged and the tab is still dirty. Ctrl+S saves.
  - `manager has no backups section` (`ui-manager.mjs`): `#backups` is absent.
- [ ] **Step 2:** FAIL. **Step 3:** implement, and redeploy the Hoon. **Step 4:** PASS, plus `cargo check`. **Step 5:** Commit: `feat: settings gains editor, publishing, legacy and connection`

### Task 11: Grub save rule, cleanup and full regression

**Files:**
- Modify: `40-grub.js` / `21-tabs.js` (the dirty grub tab shows `.dirty` and the status bar text `unsaved, Ctrl+S`), `12-bar.js` (delete the file if empty; move `#pname`/`#pkind`/`#save` into hidden holders in `#tabhead`), `index.html` (delete dead CSS for `.bar`, `.mtabs`, `#viewseg`, `.psplit#ph2`, `#fullt`, `#msheet`)
- Test: `scripts/ui-matrix.mjs` and every browser suite

**Interfaces:**
- No new interfaces. This task removes what Tasks 2-10 left hidden-but-unused. Keep `#save`, `#pkind`, `#pname`, `#newfile`, `#newfolder`, `#newtmpl`, `#upfiles`, `#updir`, `#treet` and `#ctlt`, because the desktop menu and vim use them.

- [ ] **Step 1:** Add the test `grub autosave stays off` to `ui-tabs.mjs`: type in a grub and wait 4s. `/grub-source` is unchanged and the status bar shows `unsaved, Ctrl+S`.
- [ ] **Step 2:** Implement and delete the dead code. Run `node scripts/ui-icons.mjs` (no emoji, all icons exist).
- [ ] **Step 3:** Run the full browser set against ~mec: `for f in scripts/ui-*.mjs; do node "$f" || echo FAIL $f; done` plus `scripts/desktop-commands.mjs`. Every suite PASSES. Any suite asserting removed chrome gets updated to the new home, never deleted.
- [ ] **Step 4:** Take screenshots with `scripts/shots.mjs` at 1400x900 and 390x844, in light and dark theme, and attach them to the ledger for sneagan's review.
- [ ] **Step 5:** Commit: `refactor: remove the old editor bar and mobile chrome`
