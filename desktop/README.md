# lattice desktop

One app: the lattice web client (reader, browser, editor — served live from
your ship, never bundled) plus a manager for lattice-fs FUSE mounts.

## Build

Prereqs: Rust, `cargo install tauri-cli --locked`, and Tauri v2's platform
deps (<https://v2.tauri.app/start/prerequisites/> — on Linux that's the
webkit2gtk-4.1 dev package, e.g. `lib64webkit4.1-devel` on OpenMandriva).
Mounting needs fuse3 (`fusermount3`) on Linux or macFUSE
(<https://macfuse.github.io>) on macOS.

    cd desktop
    cargo tauri build        # bundles in target/release/bundle/
    cargo tauri dev          # run from source

## Use

Enter your ship's URL and +code once. That single login covers both the
workspace webview and the fuse cookie (`~/.config/lattice-fs/cookie` — the
`lattice-fs` CLI shares it). Mounts persist and remount on launch; quitting
the app unmounts cleanly.

If a previous run died without unmounting ("Transport endpoint is not
connected" on remount), clear the stale mountpoint with
`fusermount3 -u <dir>`.

Windows: the app itself is Tauri and would build, but mounting needs a
WinFsp backend for the `Projection` trait (`fuser` is unix-only) — planned,
not yet implemented.
