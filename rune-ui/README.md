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
- Tabs: the + beside back and forward, or Ctrl+T, opens a new tab. Ctrl+W or a tab's × closes it. Each tab keeps its own page and its own back and forward. Tabs hold pages of this ship only and cannot be switched while editing. They open again next run. In the switcher, Ctrl-Return or a middle click opens the page in a new tab. The tree and links in a page cannot do that yet.
- Split: the Split button holds the page in front on the right, to read while you open or edit another on the left. Swap brings it to the front. The held page is read-only: a sheet there is its grid, a map its shapes, an HTML or gemtext page what it reads as, and any other kind its coloured source. The split is held again next run.
- Upload: New page, then Upload, picks a file in the system's file dialog and makes a page of it. The palette also uploads a whole folder. Text kinds only (md, gmi, html, txt, js, css, hoon, tex, fodt, fods, geojson, scad), a csv, which becomes a spreadsheet page with plain numbers as numbers and everything else as text, and LibreOffice's odt and ods, which become flat documents without their pictures and macros. An odt shows as its XML here until this client has a document view. Other files are named in the note with why they were left out. A page of the same name is written over, as on the web. The dialog needs a desktop portal on Linux and was not seen in a real window. Files and folders can also be dropped on the window, except on Wayland, where Rune is told of no file drags.
- Images: a Markdown page shows its images. An image from another site is not fetched until you press Load outside content for this page, since fetching it tells that site your address. The yes is remembered for that page. Images do not show in the editor or its preview.
- Find: Ctrl+F while reading a Markdown page opens a find bar. Matches are marked, Return goes to the next, Shift-Return to the one before, Esc closes it. It ignores case and accents you do not type. It works in both editors too, where the match it stands on is selected in the text. It works in a sheet (matching cells are coloured and the current one's row is selected) and in a page shown as its source (matches are marked, but a long page is not scrolled to them). A map has no find, and there is no replace.
- Duplicate and copy: the palette duplicates the page in front under a name you give, and copies its `urb://` link or its name.
- Download: the palette's Download saves the page in front to a file you name in the system's save dialog. It is the page's source, not a rendering.
- LaTeX: on a LaTeX page, the palette's Convert to HTML runs the pandoc installed on this machine and writes the result beside the page as `<name>-web`. Anything in the output that would run or load from another site is removed first. The html page shows as its source here until this client renders HTML.
- PDF: the palette's Export PDF prints the page as the ship renders it to a file you name. It needs a ship and Chromium or Chrome installed, since this app cannot print by itself. Images from other sites are left out of the PDF. Sheets, Writer documents and maps print as their source.
- Map tiles: a map page draws its base map under the shapes when the ship has a Mapbox token. Tiles come through the ship, which holds the token. With no token the map says so and shows its grid. The Base button goes round streets, outdoors, satellite and dark, and saves the choice in the page, in the layout the web client writes. The ship's token is set or cleared from the command palette, or from the button a map shows when there is none.
- Capture: the Capture button above the tree starts a page in the inbox with no name asked, open in the editor. Save keeps it. Cancel, or saving it empty, leaves nothing behind.
- Autosave: while editing, text that has changed and then rested for two to four seconds is saved and the editor stays open. The Autosave switch beside Save turns it off. If the ship refuses a save, autosave waits until you press Save. What is typed in the last seconds before the window closes is not saved.
- Links: the toolbar's Links button opens a side pane with the pages that link to this one and the pages it links to. A link to a page not written yet is in italics in the text and marked in the pane. Pressing it offers to make the page. Opening a page from the pane does not move the tree's highlight.
- Asks to edit: a page another ship shared read-only has an Ask to edit button, with an optional note. Asks waiting on you list at the top of the Access screen with Approve and Deny. Neither has been run between two real ships.
- Folder sharing: the folder view's Share sets the folder's own setting, which every page in it takes, pages added later too.
- Shared with me: the sidebar lists the pages other ships shared. One opens in place of a page, read from that ship, and is edited and saved back when that ship allows it. A notice can be forgotten.
- Memory: the sidebar switches between pages and memories. Memories have the same tree, reader, editors and Ctrl+K search, show their tags and date, and can be made, edited, renamed or moved, and deleted. Core rules that agent keys wrote are listed in a notice over the memories, each to be kept as your own or untagged. History shows a memory's revisions as it does a page's, and an old one can be read and restored. Trash, under the tree, lists the deleted memories the ship still holds, each with a Restore. A tag is pressed to take it off, `+ tag` puts one on, and the tags under the filter box show only the memories that carry the one pressed. They are read once at sign-in and again on Ctrl+R.
- Ctrl+K also finds pages by their text (three letters or more), showing the line.
- Map pages (GeoJSON) draw natively: points with their names, lines and areas over a graticule. Drag to pan, wheel to zoom about the pointer, press a point for its note and properties, and Fit returns to the whole map. Each feature has its own colour or its kind's, a point shows its icon, and the legend hides or shows a kind. The maps a map names in `lattice.layers` are drawn under it, dimmed. Press any shape to pick it: its card sets the icon and colour, edits the name, kind and note, and deletes it, and each change is saved at once. The Point button puts a point where the map is pressed next, and the picked point can be dragged to a new place. Line and Area draw a shape a corner at a time, finished with Done. Ring takes a centre and an edge. A feature's time, source and ring radius are set where its name is. The picked line or area has a handle on each corner to drag, and is dragged whole by pressing on it. Import adds the features of a GPX, KML or GeoJSON file, and GPX downloads the map as one. A feature orrery made has an Open in orrery button, and a source that is an address or a page opens. The rest of a map is edited as source.
- Spreadsheet pages (flat ODS) show as a grid: each sheet's cells as they read, with lettered columns that resize and a tab for each sheet. Press a cell to pick it, type text, a number, true or false in the bar above, and Enter saves it. Only that cell's row of the page is rewritten. A formula starting with = is stored and worked out, a cell with a formula shows it in the bar, and a change works out again every formula that reads it. Every function the web client has is worked out, about a hundred and forty: sums and statistics, maths, logic, text, lookup, and dates and times. A formula with a function lattice does not know, a named range, or a range across sheets keeps the value it had and is shown in red. A number is shown as its cell's number format writes it, and a number typed into a percentage, money, date or time cell takes that type. A percentage, money, a date or a time typed as one (50%, $5, 2026-11-17, 9:30) gives its cell a format for it, as does a formula that makes a date. A cell shows its style's bold, italic, underline, colours and alignment, and a column its width. The buttons under the bar set bold, italic, underline, alignment and the number format of the picked cell. With a cell picked, Row above and + row put a row in above or below it and − row takes its row out. Col left, + col and − col do the same with columns. Every formula, named range and print range that pointed past the row or the column follows it, a formula whose cells went says #REF!, and a page with a chart, a pivot table or a filter is refused whole, as is a change that would cut a merged cell. The + after the sheet tabs adds a sheet, named Sheet2, Sheet3 and so on, written as the web client writes one.
- Source is coloured by the page's kind, where a page is read as its source and in the source editor: Markdown, HTML, JavaScript and CSS by Rune's lexers, and Hoon, OpenSCAD, LaTeX and gemtext by ports of the web client's own grammars.
- Gemtext pages are read by the web client's rules: `#` to `###` headings, `=>` links to `urb://` or the web, `>` quotes, fenced text as it is, and every other line a paragraph.
- OpenSCAD pages show the parameters their source declares, by the customizer's rules, over the source: a stepper for a number or each part of a vector, a button for each choice of a list, a switch for true or false, and a typed value for a string or an exact number. A change rewrites the value in its own line and saves the page. The page is also run through the OpenSCAD on this machine, on a thread of its own, once for each revision: a line says how long it took, how big the part is and how many triangles it has, and a console under it holds what OpenSCAD said, errors and warnings marked. The pages it includes are read from the ship. A page of another ship waits for a yes first. With no OpenSCAD installed the line says so. `LATTICE_OPENSCAD` names one that is not on the path. The part is shown in 3D over a plate with its axes: drag turns it, or slides it with Pan on, the wheel steps nearer and further, and Fit brings all of it back. It is drawn without the graphics card, on a thread of its own. STL, 3MF and PNG save the part, or a picture of the view as it is turned, to a file named in the save dialog.
- LaTeX pages are read as documents when this machine has pandoc: it runs sandboxed on a thread of its own, its output is cleaned, and the reader draws it. Mathematics shows as the TeX it was written in, since nothing here sets it. With no pandoc, or a source pandoc cannot read, the page shows as its source with a line saying why.
- HTML pages are read as documents: headings, text, lists, quotes, links, tables, pictures and code, drawn by the same reader as Markdown, with find and the same rule for pictures from other sites. Scripts, styles, forms and frames are left out, and a link that would run something is plain text. Edit opens the page's own HTML, which reading never changes.
- Other pages that are not Markdown (HTML, OpenSCAD) show as their source, coloured.
- Every ship call runs on a worker thread, never on the UI thread.

## What does not, yet

An HTML page's own styles, scripts and forms are not run (Rune has no web view), and a map is not read from a dropped file yet. In the rich editor a heading keeps its `#`, a table its pipes and a fence its backticks, since Rune's rich text has no heading or table, and paragraphs have no space between them. No forum, memory tags, rename, trash and history, search inside pages, or offline queue.

## Check it without a window

Debug builds render headless with the same renderer:

    target/debug/lattice-rune --snap out.png --scene reading --theme dark
    target/debug/lattice-rune --list-scenes
    LATTICE_URL=.. LATTICE_COOKIE=.. target/debug/lattice-rune --script scripts/edit-and-save.json --snap saved.png --at 8

    cargo test                                             # unit tests
    LATTICE_URL=.. LATTICE_COOKIE=.. cargo test -- --ignored   # against a ship, needs a page named rune-probe
