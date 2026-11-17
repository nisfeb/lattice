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
- [x] Share grants to a ship: the share dialog lists the ships let in by name (`/share-groups`), grants read or edit (`/share-file`), and removes a grant (`/unshare-file`)
- [!] Share grants seen from the other side: blocked on a second running ship, and on a test pier whose kernel takes more than one group write (see share groups below). A grant to a ship that is not running takes about 29 s to answer
- [x] Share groups: an Access screen lists groups, makes one and deletes one, and the share dialog sets a group to none, read or edit on the page (`/share-group-save`, `/share-group-del`, `/streams` for the base path). The first group write on a fresh fake ship lands and reads back, and the screens show it
- [!] Share groups, a change or a delete seen on the ship: blocked on a test pier with the patched kernel. On the fake ships' kernel only the first group write of a pier's life changes `/share-groups`. Every later one answers ok and does nothing, with or without ships in the group
- [x] Change a group's ships after it is made, from the Access screen. The screen and the request were run on a fake ship. That the ship's list then changes falls under the blocked line above
- [x] Bans: list, ban a ship or every comet, unban (`/banlist`, `/ban`, `/unban`), on the Access screen
- [x] Folder sharing: a folder's own setting (private, over Urbit, on the web) from the folder view, taken by every page in it (`/page-share-dir`), with its address, and a ship let into the whole folder (`/share-file` on a folder)
- [x] Shared with me: a list of the pages other ships shared, opening one in place of a page, editing and saving it back when the ship lets this one, and forgetting a notice (`/shared-with-me`, `/browse-file`, `/remote-save`, `/shared-with-me-del`). The screens run on a sample notice. Against a fake ship the list is empty, and reading or saving to a ship that is not there is an error and never a page
- [!] Shared with me, read and saved between two real ships: blocked on a second running ship. Every fake ship here is the same ~zod
- [x] Display names for pages and folders: a name typed with capitals, spaces or punctuation becomes a path by the web client's own rule and is kept to show (`dname`, `dnames` on `/page-save` and `/page-move`), in the tree and the title
- [x] Sensitive flag: a switch in the share dialog shows a page's or folder's own mark and sets it (`/page-sensitive`), and says when the page is still shared by its own setting. A page that is sensitive only through its folder is not shown as such
- [x] Comments on a page: a side pane lists the page's comments, posts one, removes one, and switches comments on or off (`/comments-inbox`, `/comment`, `/comment-del`, `/page-comments`). The list comes from the ship's newest 200 across all pages
- [ ] Comments inbox across pages with an unread mark (`/comments-latest`)
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

## Web build (wasm)

Rune's web target draws one canvas through WebGPU (`~/.cache/rune-src/rune/WEB.md`, `examples/web-hello`, `scripts/web-build.sh`).

- [ ] The crate builds for `wasm32-unknown-unknown`: a `cdylib` entry beside the native `main`, and the ship client behind one trait with a browser `fetch` version (ureq does not build for wasm). Needs the wasm32 target and `wasm-bindgen-cli` at the version in Rune's Cargo.lock
- [ ] Same-origin session: served from the ship, the browser's own login cookie is used, so there is no sign-in screen and no session file
- [ ] Preferences in the browser's storage in place of the prefs file
- [ ] Served by a fake ship and checked in headless Chrome: the tree loads, a page opens, an edit saves. Needs a browser with WebGPU
- [ ] A fallback page for a browser with no WebGPU that says so and links to the existing web client
- [ ] Deployed to ~ricsul-bilwyt at its own address beside the existing web client, never in place of it. STOP before the first write to ricsul: say what will be written, where, how large it is, and how to remove it, and wait for the owner's go

## Layout

- [ ] Make the layout like the existing lattice's (the web client's arrangement of tree, tabs, toolbar and panels). The owner asked for this once the features are in, so it comes last.

## Checked by a person

- [x] The app opened as a real window on Linux (beast, Manjaro, Wayland, 2026-11-17). The owner tried it and reported that everything tried worked and that it is very fast. The map's wheel zoom was backwards and is fixed. Opening a web link in the system browser was not tried.
