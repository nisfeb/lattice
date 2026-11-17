# lattice-rune

An experimental native client for lattice, drawn with [Rune](https://github.com/anomalyco/rune): a GPU renderer with its own text and layout, and no webview. It sits beside the shipped desktop app (`desktop/`, Tauri) and changes nothing in it.

Rune is pre-release. `Cargo.toml` pins one revision of its `dev` branch, for Rune and for each crate Rune patches.

## Run

    cd rune-ui
    cargo run

It opens on a sign-in screen: the ship's address and its access code (`+code`). The session is kept in `~/.config/lattice-rune/session.json`, readable by its owner alone, and Sign out removes it. "Browse sample pages" needs no ship. `LATTICE_URL` and `LATTICE_COOKIE` (a file holding the `cookie` header's value) open a ship without the screen. Linux needs the `libxkbcommon` and `wayland` development packages to build.

## Keys

| Key | Does |
| --- | --- |
| Ctrl+K | jump to a page by name |
| Alt+Left, Alt+Right | back and forward through the pages visited |
| Ctrl+N | new page |
| Ctrl+E | edit the open page |
| Ctrl+S | save |
| Ctrl+R | reload the page tree |
| Ctrl+Shift+B | show or hide the sidebar |

On macOS, Cmd takes the place of Ctrl.

## What works

- Signing in with the access code, and staying signed in.
- The page tree, virtualised, with a filter.
- Markdown pages rendered natively: tables, syntax-coloured code, mermaid diagrams, selectable text.
- A rich text editor for Markdown pages: bold, italic, strike, inline code, links, headings, bullet and numbered lists, quotes and code blocks, from a formatting bar or Ctrl+B and Ctrl+I. It writes Markdown back.
- On one real tree of 192 Markdown pages, 177 open rich. The rest are numbered by hand, use double backticks, or have spacing two identical lines disagree on.
- A page opens rich only when turning it into rich text and back gives the same text, byte for byte (`md::exact`). Any other page opens as source, so the rich editor never rewrites what was not edited. "Source" and "Rich text" switch between the two while editing.
- Editing a page's source, coloured as Markdown, with the rendered page beside it as it is typed.
- Saving over the rev the text was read at. The ship refuses a stale save with 409, except for a page still at rev 0, where the ship checks nothing (the web client has the same gap).
- Preferences: a theme button (the system's, dark, light), and the page that was open is opened again at the next launch. Kept in `~/.config/lattice-rune/prefs.json`.
- New page, rename or move, and delete. A name typed with capitals, spaces or punctuation ("Field Notes/Day One") becomes a path as the web client makes one (`field-notes/day-one`) and the typed name is what the tree and the title show.
- Folders: picking a folder shows the pages in it, with New page here, Rename or move, and Delete, which takes every page in it after a confirm that says how many.
- The whole tree arrives with every page's text in one request, so a page opens at once and the switcher can search text with no round trip. Every 30 seconds the tree is read again, and that read carries only what was written since. A page open in the window follows a write made elsewhere unless it is being edited.
- Wiki links (`[[name]]`, `[[name|label]]`) and links into the app open the page. A link to a page that does not exist offers to make it. Web links open in the system browser. Back and forward buttons walk the pages visited.
- History: a pane lists a page's stored revisions. An old one can be read in the page's place and restored, which saves it as the newest and loses nothing.
- When the page being edited is written somewhere else, a line across the editor says so and offers to save over the other write.
- Sharing: a page is private, shared over Urbit, or on the web for anyone with the link. The dialog shows the address and copies it. The dialog also lists the ships let in by name and can let one read or edit, or remove it. A grant can take half a minute when the other ship is not reachable. An Access screen (the sidebar's foot) lists groups of ships, makes one, changes its ships and deletes one, and the dialog sets what each group may do with the page. The same screen lists banned ships, bans one (or every comet) and unbans it.
- Sensitive: a switch in the share dialog marks a page or folder sensitive, which keeps it from agent keys without clearance and from folder and group shares.
- Comments: the toolbar's Comments button opens a side pane with the page's comments, a field to post one as the owner, Remove on each, and a switch that turns comments on or off for the page. The list is the ship's newest 200 across all pages, so an older comment on a busy ship is not shown. The Comments button under the tree shows every page's comments, and pressing a comment's page opens it. With comments on, the pane also sets what comets' comments do: open, held for your yes, or off. Held ones list at the top of the Comments screen with Approve and Reject. No real held comment has been answered from this client, since that needs a comet. The same screen, now called Inbox, lists activity notices (comments from other ships, forum replies, shares, asks to edit). Each can be marked read, alone or all at once, and the Inbox button counts what is unread or held. Open works for a notice about a page of yours, a shared page or an ask. Forum replies and followed folders have nowhere to open yet.
- Switcher: Ctrl+K or Ctrl+O. With nothing typed it lists the pages opened last on this device. Typing a name no page has adds a Create row, and Shift-Return makes that page whatever else matched. Recents hold pages only, not memories.
- Commands: Ctrl+P opens a palette of what the buttons do. The commands you ran last come first, and typing narrows the list. A command that needs a page is not offered when none is open.
- Link completion: typing `[[` in either editor lists matching pages on the line under it. Tab completes the one chosen, the arrows choose, Esc dismisses. A date such as `[[2026-11-18` offers that day's journal page even before it is written.
- Today: the Today button opens today's journal page, or starts it if there is none. A link to a page that is not written yet starts that page too, already named, with no dialog. Either is kept by its first save.
- Templates: New page, then From a template, lists the ship's templates. Pick one, name it, and the page or folder of pages is made and opened. A site's index and a guestbook are Hoon pages, which show as source here.
- Orrery's map: `orrery/map` is read-only while orrery keeps it, since the ship would refuse the save. Edit says so and points at `orrery/map-notes`.
- Capture: the Capture button above the tree starts a page in the inbox with no name asked, open in the editor. Save keeps it. Cancel, or saving it empty, leaves nothing behind.
- Autosave: while editing, text that has changed and then rested for two to four seconds is saved and the editor stays open. The Autosave switch beside Save turns it off. If the ship refuses a save, autosave waits until you press Save. What is typed in the last seconds before the window closes is not saved.
- Links: the toolbar's Links button opens a side pane with the pages that link to this one and the pages it links to. A link to a page not written yet is in italics in the text and marked in the pane. Pressing it offers to make the page. Opening a page from the pane does not move the tree's highlight.
- Asks to edit: a page another ship shared read-only has an Ask to edit button, with an optional note. Asks waiting on you list at the top of the Access screen with Approve and Deny. Neither has been run between two real ships.
- Folder sharing: the folder view's Share sets the folder's own setting, which every page in it takes, pages added later too.
- Shared with me: the sidebar lists the pages other ships shared. One opens in place of a page, read from that ship, and is edited and saved back when that ship allows it. A notice can be forgotten.
- Memory: the sidebar switches between pages and memories. Memories have the same tree, reader, editors and Ctrl+K search, show their tags and date, and can be made, edited and deleted. They are read once at sign-in and again on Ctrl+R.
- Ctrl+K also finds pages by their text (three letters or more), showing the line.
- Map pages (GeoJSON) draw natively: points with their names, lines and areas over a graticule. Drag to pan, wheel to zoom about the pointer, press a point for its note and properties, and Fit returns to the whole map. There are no tiles, and a map is edited as source.
- Spreadsheet pages (flat ODS) show as a grid: each sheet's cells as they read, with lettered columns that resize and a tab for each sheet. Read-only, with no formulas or styles, and edited as source.
- Other pages that are not Markdown (HTML, OpenSCAD) show as their source, coloured.
- Every ship call runs on a worker thread, never on the UI thread.

## What does not, yet

OpenSCAD and HTML pages have no native view, a spreadsheet cannot be edited as a grid, and a map has no tiles under it, no layers and no drawing tools. In the rich editor a heading keeps its `#`, a table its pipes and a fence its backticks, since Rune's rich text has no heading or table, and paragraphs have no space between them. No forum, memory tags, rename, trash and history, search inside pages, or offline queue.

## Check it without a window

Debug builds render headless with the same renderer:

    target/debug/lattice-rune --snap out.png --scene reading --theme dark
    target/debug/lattice-rune --list-scenes
    LATTICE_URL=.. LATTICE_COOKIE=.. target/debug/lattice-rune --script scripts/edit-and-save.json --snap saved.png --at 8

    cargo test                                             # unit tests
    LATTICE_URL=.. LATTICE_COOKIE=.. cargo test -- --ignored   # against a ship, needs a page named rune-probe
