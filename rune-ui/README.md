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
- A page opens rich only when turning it into rich text and back gives the same text, byte for byte (`md::exact`). Any other page opens as source, so the rich editor never rewrites what was not edited. "Source" and "Rich text" switch between the two while editing.
- Editing a page's source, coloured as Markdown, with the rendered page beside it as it is typed.
- Saving over the rev the text was read at. The ship refuses a stale save with 409, except for a page still at rev 0, where the ship checks nothing (the web client has the same gap).
- New page, rename or move, and delete.
- Pages read once are kept for the session and drawn at once on a second visit, then corrected from the ship.
- Every ship call runs on a worker thread, never on the UI thread.

## What does not, yet

Other page kinds (maps, spreadsheets, OpenSCAD, HTML) show as their source. In the rich editor a heading keeps its `#`, a table its pipes and a fence its backticks, since Rune's rich text has no heading or table, and paragraphs have no space between them. No folders as their own things, history, sharing, forum, memory, search inside pages, live updates from other windows, or offline queue.

## Check it without a window

Debug builds render headless with the same renderer:

    target/debug/lattice-rune --snap out.png --scene reading --theme dark
    target/debug/lattice-rune --list-scenes
    LATTICE_URL=.. LATTICE_COOKIE=.. target/debug/lattice-rune --script scripts/edit-and-save.json --snap saved.png --at 8

    cargo test                                             # unit tests
    LATTICE_URL=.. LATTICE_COOKIE=.. cargo test -- --ignored   # against a ship, needs a page named rune-probe
