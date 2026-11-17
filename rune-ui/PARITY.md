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
- [x] Comments inbox: a Comments screen lists every page's comments newest first, opens the page one is on, and removes one (`/comments-inbox`, `/comment-del`). The web client has no unread mark for comments either
- [x] Held comments: a page's Comments pane sets what comets' comments do (open, held, off, `/page-comets`), and the Comments screen lists what is held with Approve and Reject (`/held-comments`, `/comet-pending`). The setting was run on a fake ship. The list and its buttons run on a sample held comment
- [!] Held comments, a real one approved or rejected on a ship: blocked on a comet to write one. The fake ships here are all ~zod
- [x] Inbox activity: notices of comments, replies, shares and asks, each marked read alone or all at once, opened where this client has a screen, and counted with held comments on the Inbox button (`/notify`, `/notify-read`, `/notify-count`). The routes were run on a fake ship, which has no notices. The list runs on sample notices
- [!] Inbox activity, a real notice read and opened: blocked on a second running ship to cause one
- [x] Asks to edit: a page shared read-only has Ask to edit with an optional note (`/access-request`), and the Access screen lists the asks waiting here with Approve and Deny (`/access-requests`, `/access-answer`). The routes answer on a fake ship (no asks, an answer to none refused, asking oneself refused). Both screens run on sample data
- [!] Asks to edit, one sent to a host and one answered: blocked on a second running ship
- [x] Backlinks and ghost links: a Links pane lists the pages that link here (`/page-backlinks`) and the pages this one links to. A link to a page not written yet shows in italics in the reader and as not written in the pane, and offers to make it
- [x] Quick capture: a Capture button starts a page with nothing asked, named `inbox/YYYY-MM-DD-NNNN` by the web client's rule, and its first save makes it. An empty one is never saved and Cancel drops it.
- [x] Autosave: text that changed and then rested about two seconds is saved with the editor left open, for pages, memories and captures. A switch in the editor's toolbar turns it off and is kept. A page as it was read is never written, a refusal makes it wait for Save, and another ship's page saves only on purpose
- [ ] Recent documents first in the switcher (the web client's Ctrl+O picker), with a Create row for a name that matches nothing
- [ ] Command palette ordered by recent use
- [ ] Wiki link autocomplete after `[[`, with a date offering that day's journal page
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
