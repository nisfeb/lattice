# lattice-rune

An experimental native client for lattice, drawn with [Rune](https://github.com/anomalyco/rune): a GPU renderer with its own text and layout, and no webview. It sits beside the shipped desktop app (`desktop/`, Tauri) and changes nothing in it.

Rune is pre-release. `Cargo.toml` pins one revision of its `dev` branch, for Rune and for each crate Rune patches.

## Run

    cd rune-ui
    cargo run                      # sample pages, no ship needed
    LATTICE_URL=https://your.ship LATTICE_COOKIE=/path/to/cookie cargo run

`LATTICE_COOKIE` names a file holding the value of the `cookie` header for the ship's web login. Linux needs the `libxkbcommon` and `wayland` development packages to build.

## Keys

| Key | Does |
| --- | --- |
| Ctrl+K | jump to a page by name |
| Ctrl+E | edit the open page |
| Ctrl+S | save |
| Ctrl+R | reload the page tree |
| Ctrl+Shift+B | show or hide the sidebar |

On macOS, Cmd takes the place of Ctrl.

## What works

- The page tree, virtualised, with a filter.
- Markdown pages rendered natively: tables, syntax-coloured code, mermaid diagrams, selectable text.
- Editing a page's source and saving it over the rev it was read at. The ship refuses a stale save with 409.
- Pages read once are kept for the session and drawn at once on a second visit, then corrected from the ship.
- Every ship call runs on a worker thread, never on the UI thread.

## What does not, yet

Other page kinds (maps, spreadsheets, OpenSCAD, HTML) show as their source. No login screen, creating, moving or deleting pages, history, sharing, forum, memory, search inside pages, or offline queue.

## Check it without a window

Debug builds render headless with the same renderer:

    target/debug/lattice-rune --snap out.png --scene reading --theme dark
    target/debug/lattice-rune --list-scenes
    LATTICE_URL=.. LATTICE_COOKIE=.. target/debug/lattice-rune --script scripts/edit-and-save.json --snap saved.png --at 8

    cargo test                                             # unit tests
    LATTICE_URL=.. LATTICE_COOKIE=.. cargo test -- --ignored   # against a ship, needs a page named rune-probe
