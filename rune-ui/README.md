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
- New page, rename or move, and delete.
- The whole tree arrives with every page's text in one request, so a page opens at once and the switcher can search text with no round trip. Every 30 seconds the tree is read again, and that read carries only what was written since. A page open in the window follows a write made elsewhere unless it is being edited.
- Wiki links (`[[name]]`, `[[name|label]]`) and links into the app open the page. A link to a page that does not exist offers to make it. Web links open in the system browser. Back and forward buttons walk the pages visited.
- Ctrl+K also finds pages by their text (three letters or more), showing the line.
- Map pages (GeoJSON) draw natively: points with their names, lines and areas over a graticule. Drag to pan, wheel to zoom about the pointer, press a point for its note and properties, and Fit returns to the whole map. There are no tiles, and a map is edited as source.
- Other pages that are not Markdown (sheets, HTML) show as their source, coloured.
- Every ship call runs on a worker thread, never on the UI thread.

## What does not, yet

Spreadsheets, OpenSCAD and HTML pages have no native view, and a map has no tiles under it, no layers and no drawing tools. In the rich editor a heading keeps its `#`, a table its pipes and a fence its backticks, since Rune's rich text has no heading or table, and paragraphs have no space between them. No folders as their own things, history, sharing, forum, memory, search inside pages, or offline queue. An edit in progress is not warned when the page changes elsewhere: the save is refused with 409.

## Check it without a window

Debug builds render headless with the same renderer:

    target/debug/lattice-rune --snap out.png --scene reading --theme dark
    target/debug/lattice-rune --list-scenes
    LATTICE_URL=.. LATTICE_COOKIE=.. target/debug/lattice-rune --script scripts/edit-and-save.json --snap saved.png --at 8

    cargo test                                             # unit tests
    LATTICE_URL=.. LATTICE_COOKIE=.. cargo test -- --ignored   # against a ship, needs a page named rune-probe
