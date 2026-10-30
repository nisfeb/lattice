# Editor overhaul: an Obsidian-style shell

## Intent

Today the lattice editor is one page at a time, with a tree on the left, a controls pane on the right, and features scattered across the editor, the reader, the mobile sheet, the desktop menu and the settings page. Some features have two or three entry points that behave differently. Others have no way in from the editor at all. sneagan wants the editor rebuilt toward Obsidian's layout (reference screenshot: beast `~/Pictures/Screenshots/Screenshot_20261028_172508.png`). That means a ribbon, tabbed side panes, tabbed documents side by side, and a per-tab read mode. It applies to web, desktop (Tauri) and mobile, and it must respect the theming system.

**Anti-goal (sneagan's words):** "ambiguous navigation and users confused about where features are." A shell that looks like Obsidian but leaves features in two places, or buried, has failed even if it works.

## Rules that serve the anti-goal

1. Every feature has exactly one home. The placement map below is binding.
2. Every icon has a tooltip with its name and, where one exists, its shortcut.
3. The command palette and the desktop's native menus are indexes over the homes. They run the same action as the home. They never hold a feature of their own.
4. The left pane is for finding things. The ribbon is for going places, and each ribbon icon opens or focuses a center tab. The right pane is about the active tab. Settings is about the whole ship.
5. The home page is never the only way to reach anything (standing rule).

## Decisions made with sneagan

- **JS first, not Rust.** The urb-fetch Rust core (rust-core.md) is a protocol-layer port with no UI, so it neither blocks nor is blocked by this.
- **Icons:** flat SVG, `stroke="currentColor"`, colored only through theme CSS vars. No emoji, no font glyphs. One sprite of `<symbol>`s, reused everywhere.
- **Theming:** all chrome colors come from the CSS vars theme.js already sets No parallel set of vars. Shades theme.js lacks are derived (see Theme colors below).
- **Preview:** per-tab Edit / Read switch. Read is the rendered preview. It replaces today's edit / split / preview view buttons.
- **Side by side:** tab groups in a split tree. Any group can split right or down. There is no hard cap on groups. A group has a minimum width of about 360px, so a split that would go below it is refused (the split action is disabled with a tooltip saying why).
- **Reader and forum are tabs** in the shell. A **full-spread** button on any tab's header makes that tab fill the window, as the reader does today. Esc or the same button returns. A direct `urb://` link, or a reader URL opened from outside the editor, opens full-spread.
- **Mobile:** Obsidian-mobile style. The left and right panes are drawers, opened by corner buttons or an edge swipe. A slim bottom bar holds new page, search, today's brief, and an open-tabs switcher. One tab group at a time on a phone.
- **Today's brief:** a ribbon icon (agenda) that opens `journal/<today>`, the page orrery writes the brief to.

## Layout

- **Left ribbon** (top to bottom): Today's brief, Browser, Forum, Comments inbox, Access & groups, Explorer, Sync conflicts (shown only with a badge when conflicts exist), Command palette. Settings sits at the bottom of the ribbon.
- **Top corners:** a left-pane toggle and a right-pane toggle, subtle but clear, using the panel icons from the mockup.
- **Left pane tabs:** Files, Knowledge, Search, Bookmarks.
- **Center:** the split tree of tab groups. Each group has its own tab strip with a + button.
- **Right pane tabs:** Page, Outgoing links, Backlinks, Outline, Comments, History. They follow the active tab of the focused group. For tab kinds where a right-pane tab means nothing (forum, explorer, settings), that tab shows a one-line "nothing here for this tab" note instead of disappearing, so the strip never reshuffles.
- **Status bar** (desktop and web): save state and last action, offline or draining badge, vim mode and command line, compile error (clicking it focuses the Page tab).

The mockup in `.superpowers/brainstorm/2280270-1793224573/content/layout-v2.html` shows the arrangement, icons and both themes.

## Placement map (binding)

Tags: **merged** means today it is reachable 2 to 3 ways that behave differently, and now has one. **New** means buried or no UI today.

### Left pane

- **Files:** your pages tree, plus Shared with me (one folder per ship), the clearweb marker, folder folding. Toolbar: new page, new folder, new from template, upload (files or folder), sort order, collapse all.
- **Knowledge** (merged): the memory tree with tag filter chips. It replaces the pages/knowledge mode switch and the read-only `/know` reader. Toolbar: new memory, tidy (new), trash and restore (new).
- **Search** (merged): one live search over pages and memories with exposure badges. Editor Ctrl+K and the reader's index search become this one, with one engine.
- **Bookmarks:** urb:// bookmarks by folder, with filter, refile and remove.

### Ribbon

- **Today's brief:** opens `journal/<today>`.
- **Browser:** a new reader tab at your home, with the urb:// omnibar.
- **Forum** (new from the editor): board list. Boards and threads open as tabs.
- **Comments inbox:** comments from other ships, across pages.
- **Access & groups:** groups, their ships and paths, banned ships.
- **Explorer:** browse ship files (`/x`). Any file opens in a file tab.
- **Sync conflicts:** badge only when conflicts exist.
- **Command palette:** an index of every action by name.
- **Settings** (new from the editor), bottom of the ribbon.

### Tab header (per tab)

- Back and forward.
- Title or path. Click to rename or move (merged).
- Edit / Read switch (merged). It replaces edit/split/preview, the reader's "edit" button and the mobile preview tab.
- Full-spread button.
- ⋯ page menu: kind (new on desktop and phone), line wrap (new on phone), duplicate, export, convert to HTML (tex, desktop), open raw, delete.
- Reader tabs show the urb:// omnibar with suggestions and a bookmark star instead.

### Right pane

- **Page:** save and compile status, sharing (private / shared / clearweb, plus public link), give a ship access, give a group access (merged), sensitive, comments on/off (new, no UI today), send to orrery, and memory tags on memories.
- **Outgoing links** (new).
- **Backlinks** (today a folded "linked from").
- **Outline:** headings, click to jump (new).
- **Comments:** this page's thread, reply, remove.
- **History:** revisions, view one, restore, back to latest.

### Settings tab (whole ship)

Opened from the ribbon, the command palette, or the desktop's Preferences menu.

- Appearance: theme (follow Talon or a lattice theme, accent, light/dark), font, size.
- Editor: vim mode (new from the editor), wrap default, autosave.
- Publishing: reset the "don't ask again" before going public (new).
- Agent keys: make, scopes, revoke.
- Search index: reindex.
- Backup (merged): export, restore, scheduled backups. The two separate desktop implementations become one.
- Commons mirror: obelisk on/off.
- Archive a web page: the clip bookmarklets.
- Desktop only: connection and mounts (today's manager page).
- Legacy import (new; today it is gone after "never").

### One flow each

- **New page** (merged): one name + kind dialog everywhere, with the folder pre-filled when started from a folder.
- **New memory** (new): the same dialog from the Knowledge toolbar.
- **Save** (merged): pages and memories autosave, and Ctrl+S saves anything. App files (grubs) save only on Ctrl+S (sneagan's call), because autosaving half-typed hoon or JS would rebuild broken code. Closing a dirty grub tab asks first. There is no Save button anywhere. A dirty grub tab shows a dot on its tab and "unsaved, Ctrl+S" in the status bar.
- **Granting access** (merged): always through groups, always notifies the ship.
- **Conflicts** (merged): resolved only in the Sync conflicts tab.
- **Uploads:** Files toolbar, plus dropping a file anywhere as a gesture.

### Mobile and desktop

- Mobile: today's ⋯ overflow sheet, tab strip and full-screen button are removed (merged). Drawers, the tab header and full-spread cover them. The list indent and outdent keys stay on the keyboard row.
- Desktop: the File / Edit / View native menus stay as an index to the same actions, with the same shortcuts.

### Left out on purpose

Server routes with no UI today stay without UI in this overhaul: publishing memories (`/know-publish`), follows and subscriptions, and the full history list. A fresh empty tab shows today's reader home cards (recent pages, bookmarks, memories), so a new tab is never blank.

## Constraints

- Vanilla JS, no framework, no new runtime dependency. The client stays the concatenated `ui-src/lattice/*.js` built into `code/nex/lattice/ui-app/app.js` by `scripts/build-ui.mjs`, with `index.html` as the shell.
- Every save-safety guarantee in `20-state.js` (`guardDirty`, `everTyped`, the autosave flight handling, `__latUnsaved` for the service worker) must hold per tab. Closing a dirty tab, or switching tabs inside the autosave window, must never lose typed work. This is the highest-risk part of the work.
- Offline queueing (`08-offline.js`) and the vim mode (`27-vim.js`) keep working in every editor tab.
- Desktop: the Tauri app uses the same web client. Native menu items in `96-deskmenu.js` call the same actions as their homes.
- No version bump decisions are made here. Releases follow the normal lattice process, where merging to main deploys ricsul.
- Prose rules for any user-visible copy are sneagan's: no em-dashes.

## The how, as far as decided

- **Tab state, my call.** Each document tab owns its own state: path, kind, body, dirty, everTyped, scroll and cursor, Edit/Read mode, history position. What today are module globals in `20-state.js` become fields of a tab object, with the active tab's fields read through one accessor. `guardDirty` becomes per tab.
- **One tab per document, my call.** A page is open in at most one tab across all groups. Opening a page that is already open focuses its tab. This keeps exactly one buffer, one dirty flag and one autosave per document, so two tabs can never overwrite each other's typing.
- **Opening replaces or adds, my call (Obsidian's behavior).** A plain click from Files, Search, Backlinks, a wiki link or the palette opens in the active tab, replacing it, after `guardDirty`. Ctrl/Cmd+click or middle-click opens a new tab. A tab can be pinned from its context menu, and a pinned tab is never replaced (the click opens a new tab instead). Each tab's Back and Forward step through what that tab has shown.
- **URL and windows, my call.** The address bar follows the active tab (`?name=X`, kept with `history.replaceState` as today). A `?name=X` arriving at a restored shell opens or focuses that page's tab. The layout in localStorage is last-write-wins across windows. Bodies and dirty state are never persisted, so no window can restore another window's unsaved work.
- **Theme colors, my call.** The shell needs pane and ribbon shades that theme.js does not define. They are derived in CSS with `color-mix()` from theme.js's existing vars (`--bg`, `--text`, `--raised`, `--border`, `--selection`, the accent family). No new keys are added to theme.js. The builder confirms `color-mix` in the Tauri WebKitGTK webview, with a flat fallback to `--raised` if it is missing.
- **Server-rendered tabs, my call.** Settings is server-rendered today (`/settings` in app.hoon), so phase 1 hosts it in a same-origin iframe tab, and the moved items (vim, backups, legacy import, publishing reset, connection and mounts) are added to that page. The Comments inbox, Access & groups and Sync conflicts are client overlays today (`lat-comments`, `lat-acl`, `lat-conflicts`) and become client tabs. So iframe hosting starts in phase 1, not phase 3.
- **Shell and iframe bridge, my call.** The frames are same-origin, so the shell listens for clicks inside them directly. In reader tabs, urb:// links navigate inside the frame. Links to your own pages and files from the explorer open shell tabs. A reader tab showing one of your own pages has an "Edit" button in its header, which opens that page's editor tab. That is a route to the document, not a second home for a feature. Phase 3 may need small server-side changes to the reader and explorer markup, for example data attributes on links.
- **Editors in splits, my call.** Each visible group has a live editor instance (the `<lat-editor>` element made instantiable). Hidden tabs in a group keep state only, not a DOM editor, and are painted into the group's editor when selected.
- **Reader, forum and explorer tabs, my call.** These are server-rendered today. They are hosted in same-origin iframes inside the tab. Full-spread navigates the top-level window to the same URL. The reader bar's existing back link returns to the shell. This avoids rewriting the reader or the forum.
- **Persistence, my call.** The open tabs, the split tree, the pane widths, which side panes are open and the active right-pane tab all persist in localStorage per device, like today's layout toggles. Bodies are not persisted. Reopening the app reloads each tab's page from the ship (or the offline cache).
- **Command palette, my call.** It lists actions and pages, in that order, and fuzzy matches on name. Each action entry shows the action's home and shortcut, so the palette also teaches where things live.
- **Shortcuts, my call.** Ctrl+P palette, Ctrl+K search (focuses the Search tab), Ctrl+S save, Ctrl+W close tab, Ctrl+Tab next tab, Ctrl+\\ split right, Ctrl+E Edit/Read, Esc leaves full-spread. Vim keeps its own bindings inside an editor.

## Phasing, my call

Each phase ships on its own on web, desktop and mobile together, so no platform falls behind.

1. **Shell and homes.** Ribbon, the two corner toggles, tabbed left and right panes, the Settings tab, the status bar, the theme vars and the icon sprite. A single tab group with tabs, per-tab state and Edit/Read. Mobile drawers and the bottom bar. All merges and new homes in the placement map. This phase alone satisfies the anti-goal.
2. **Splits.** The split tree of tab groups, drag a tab between groups, and the min-width rule.
3. **Reader, forum and explorer as tabs, plus full-spread.**
4. **Outgoing links and Outline** in the right pane, if they did not fit in phase 1.

## Left to the builder

- Exact CSS, spacing and animation.
- Icon drawing beyond the mockup's sprite.
- How drag between groups looks.
- File split inside `ui-src/lattice/`, as long as the build order stays sane.
- Test approach, following the existing `scripts/ui-*.mjs` browser tests.
