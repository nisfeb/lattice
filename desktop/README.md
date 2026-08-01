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

The connection page reports the live state — connected (and to which ship),
signed out, or unreachable — by making a real authenticated request, not by
checking whether a URL is configured. It offers the login form only when
logging in is actually what you need; `reconnect` and `change ship` are there
when you want it anyway.

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
the ship's reader); only truly external links open in your system browser.
Ctrl/Cmd +/- zooms the workspace. The app is a single window: it opens on
the connection page until a ship is configured, then lives on the ship UI;
`lattice → connection & mounts…` in the menu returns to the settings page.

Once configured it opens straight on the editor — landing on the reader made
reaching the editor a second full page load. The bridge listens on a fixed
port (41863, or the next free one in a 16-wide range). That is deliberate and
load-bearing, not cosmetic: the port is part of the webview's origin, and all
web storage is keyed by origin, so an ephemeral port gave every launch an
empty cache and made the desktop app slower than the same UI in a browser.

## Local ships (lick)

The connection page lists urbit piers found on this machine and offers to
mount them over **lick** — the unix-socket transport — with no URL, no +code
and no cookie: the socket lives inside the pier, so being able to open it is
the authorization. This is independent of the HTTP connection, so you can
mount a local ship's tree without connecting the workspace to it.

Detection is pure filesystem, which is why it needs no process scanning and
behaves the same on macOS:

    <pier>/.urb/                          it is a pier
    <pier>/.urb/conn.sock                 vere is running
    <pier>/.urb/dev/grubbery/lattice/fs   lattice's lick port is bound

A pier missing the last two is listed with the reason rather than a button
that would fail. Only lattice page roots mount over lick — the generic ball
API is served over HTTP only.

If a previous run died without unmounting ("Transport endpoint is not
connected" on remount), clear the stale mountpoint with
`fusermount3 -u <dir>`.

Windows: the app itself is Tauri and would build, but mounting needs a
WinFsp backend for the `Projection` trait (`fuser` is unix-only) — planned,
not yet implemented.

## Releases

Push a version tag and CI builds every supported platform:

    # bump "version" in tauri.conf.json first — CI refuses a tag that
    # disagrees with it, so the bundles can never be stamped with the
    # wrong version
    git tag v0.2.0 && git push origin v0.2.0

`.github/workflows/release.yml` runs the test suites, then builds on
ubuntu-22.04 (`.deb` + `.AppImage`, x86_64), macos-14 (`.dmg`, Apple
Silicon) and macos-13 (`.dmg`, Intel), and attaches the bundles to a
**draft** release for a human to publish. `workflow_dispatch` builds the
same set without a tag.

Ubuntu 22.04 rather than the newest runner on purpose: a bundle's glibc
floor is whatever it was built against, so building on the newest image
silently drops every older distro.

macOS bundles are unsigned unless the `APPLE_*` signing secrets are set —
they work, but need right-click → Open the first time. Windows is not built
(see above); it would fail at compile, not at bundling.
