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

The workspace webview talks to the ship through a localhost bridge: every
request is relayed by the app with the session attached Rust-side, so the
webview itself holds no cookies and webkit cookie policies (which vary by
build and silently drop cookies on cross-site flows) can never
unauthenticate a view.

Uploads in the workspace use the OS-native file/folder picker (the web
client detects the shell and invokes the `pick_upload` command — webkit2gtk
has no `webkitdirectory`, so the browser folder picker would be dead on
Linux). Drag-and-drop upload works too; the shell's own drag-drop
interception is disabled for the workspace window so the UI's HTML5 drop
handler receives the files.

Ship links and `urb://` addresses stay in the app (`urb://` resolves through
the ship's reader); only truly external links open in your system browser. Ctrl/Cmd +/- zooms the workspace. Closing
the manager window while the workspace is open just hides it — it comes
back when the workspace closes.

If a previous run died without unmounting ("Transport endpoint is not
connected" on remount), clear the stale mountpoint with
`fusermount3 -u <dir>`.

Windows: the app itself is Tauri and would build, but mounting needs a
WinFsp backend for the `Projection` trait (`fuser` is unix-only) — planned,
not yet implemented.
