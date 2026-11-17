# Parity ledger

What the web client (`ui-src/`) and the Tauri desktop app (`desktop/`) do, and whether this client does it. One line per feature. The loop in `../rune-parity-loop.md` works down this list and edits it.

Marks: `[x]` done and checked, `[ ]` not built, `[~]` built in part (the line says what is missing), `[!]` blocked (the line says by what).

"Checked" means a unit test, plus a headless scripted run of the real screens, plus a live test against a fresh fake ship when the feature talks to the ship. The owner ran one build in a real window on 2026-11-17 (see the last section). Features built after that have not been seen in one.

## Pages

- [x] Sign in with the access code, stay signed in, sign out
- [x] Page tree with filter
- [x] Read Markdown: tables, code, mermaid, selectable text
- [x] Wiki links, links into the app, web links, link to a missing page offers to make it
- [x] Back and forward
- [x] Source editor with Markdown colour and live preview
- [x] Rich text editor with the exact round-trip rule
- [x] Save over a rev, refusal of a stale save
- [x] Warning when the page being edited changes elsewhere
- [x] New, rename or move, delete
- [x] Folders: view, new page here, rename or move, delete
- [x] History: list, read an old revision, restore
- [x] One-request tree with bodies, sync every 30 s by the `since` token
- [x] Ctrl+K over names and text
- [x] Share: private, over Urbit, on the web, address and copy
- [ ] Share grants: which ships and groups may read a page shared over Urbit (`ui-src/lattice/72-acl.js`, `/share-file`, `/share-groups`)
- [ ] Folder sharing (`/page-share-dir`)
- [ ] Shared with me: pages other ships shared, and opening them (`/shared-with-me`, `/browse-file`, `/remote-save`)
- [ ] Display names for pages and folders (`dname`)
- [ ] Sensitive flag: show it, set it (`/page-sensitive`)
- [ ] Comments on a page (`ui-src/lattice/` comments code, `/comments`)
- [ ] Backlinks and ghost links (pages that link here, links to pages not made)
- [ ] Quick capture
- [ ] Templates and the journal (daily pages, orrery mirror pages read-only)
- [ ] Tabs: more than one page open
- [ ] Images in pages and uploads (pick, drop, paste)
- [ ] Find in page
- [ ] Print or export a page (the desktop app's pandoc bridge)

## Page kinds

- [x] Markdown
- [~] Map (GeoJSON): shapes, pan, zoom, point card. Missing: tiles, layers, drawing tools, GPX and KML import and export, orrery detail links, icons by kind
- [~] Spreadsheet (flat ODS): read-only grid with sheet tabs. Missing: cell editing, formulas, styles, number formats
- [ ] HTML pages rendered
- [ ] Gemtext (`gmi`) rendered
- [ ] LaTeX (`tex`) rendered or at least coloured
- [ ] OpenSCAD: 3D view, includes, export
- [ ] Forms and quizzes
- [ ] Hoon and other code kinds coloured

## Memory

- [x] Browse, read, search, edit, new, delete
- [ ] Rename or move a memory (`/know-move`)
- [ ] Tags: add and remove (`/know-tag`, `/know-untag`), filter by tag
- [ ] Trash and restore (`/know-trash`, `/know-restore`)
- [ ] History and restore a revision (`/know-history`, `/know-read-at`, `/know-restore-rev`)
- [ ] Core memories and agent keys view (`/know-core-keep`, `/know-core-agents`)

## Forum

- [ ] Boards and threads: read
- [ ] Post, reply, tags, refusal notes
- [ ] Boards on other ships over `urb://`

## Around the edges

- [x] Theme switch, reopen the last page
- [ ] Offline: read from what is kept, queue writes, replay
- [ ] Settings: Mapbox token, OpenSCAD runtime, agent keys, mirror config
- [ ] `urb://` browsing of other ships' published pages
- [ ] Notifications of changes (the beacon stream, in place of the 30 s poll)
- [ ] Keyboard shortcuts on par with the web client's
- [ ] Accessibility pass with Rune's tree (`--tree`): every control named

## Desktop app extras (`desktop/`)

- [ ] Connection page: connected, signed out, unreachable, change ship
- [ ] Local ships over lick (no URL, no code)
- [ ] FUSE mounts: add, remove, remount at launch
- [ ] Backups: schedule, retention, restore
- [ ] Native menus
- [ ] Bundles: deb, AppImage, dmg

## Layout

- [ ] Make the layout like the existing lattice's (the web client's arrangement of tree, tabs, toolbar and panels). The owner asked for this once the features are in, so it comes last.

## Checked by a person

- [x] The app opened as a real window on Linux (beast, Manjaro, Wayland, 2026-11-17). The owner tried it and reported that everything tried worked and that it is very fast. The map's wheel zoom was backwards and is fixed. Opening a web link in the system browser was not tried.
