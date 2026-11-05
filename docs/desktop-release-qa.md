# Desktop release QA (real devices)

Run this per release, on real hardware, before the release is announced. CI builds and unit tests do not cover any of it. Mark each box, and note the version, machine and OS at the top of the run.

Items marked **NEVER VERIFIED** have not been confirmed on a real device yet. Treat a pass on them as news and record it here.

Test data: read only. Use a disposable node (a fakezod or ~tyr) for the node login. For anonymous mode, a fresh app data dir (Linux: fresh `XDG_*` dirs; macOS: a new user account, or remove `~/Library/Application Support/<app id>`).

Addresses that work for reads:

- page: `urb://~nisfeb/site/lattice/lattice`
- a folder with its own index page: `urb://~nisfeb/site/lattice/`
- forum board: `urb://~ricsul-bilwyt/forum/test` (no posts yet, so it has no thread to open)
- a folder with no index page (for the folder listing): still needed; pick one per run and record it

## Common checks (every platform)

Login
- [ ] Node login: the ship URL and +code connect, and the workspace loads the ship UI.
- [ ] Anonymous: "Use anonymously" makes a comet and opens the start page, with "Connect a node" in the bar.

Reading
- [ ] Start page renders, and its links open.
- [ ] A page read from the address bar.
- [ ] A forum board lists its threads (or "No posts yet.").
- [ ] A forum thread shows the post, then its comments oldest first.
- [ ] A comment on a page that takes comments (on a disposable node only).
- [ ] A folder with no index page lists what is published in it.

PDF export
- [ ] Export PDF from the editor writes a file where the save dialog says, and the file opens with the page's text.

Zoom
- [ ] Ctrl/Cmd `+` zooms in, `-` zooms out, `0` resets to 100%, in both the workspace and the reader.

Settings
- [ ] Settings opens (Connection, Files, Scheduled backups), and close returns to the page.

Updater
- [ ] With the previous release installed, the app offers this release, downloads it, verifies the signature and restarts into it.

urb:// links
- [ ] A urb:// link clicked in another app (browser, chat) opens in lattice, both when lattice is closed and when it is already running.

Navigation
- [ ] Reload (button and F5 / Ctrl-Shift-R, Cmd-R on macOS) re-reads the page.
- [ ] Back and Forward step through history.

Loading indicator
- [ ] On a slow read (a ship not contacted yet), the thin line at the top runs and the Reload button spins, then both stop.

## Linux AppImage

- [ ] Starts with no FUSE (`APPIMAGE_EXTRACT_AND_RUN=1`) and with FUSE.
- [ ] Writes `~/.local/share/applications/lattice-desktop-handler.desktop` and registers `x-scheme-handler/urb` in `mimeapps.list`.
- [ ] All common checks.
- [ ] Zoom: **NEVER VERIFIED** whether the webview zoom needs a capability permission on Linux. Confirm zoom works with a node login (the ship-served workspace), not only in the reader.
- [ ] PDF export through GTK's "Print to File": the file is written and opens.

## Linux deb

- [ ] `sudo apt install ./lattice_<v>_amd64.deb` installs, and the app is in the launcher.
- [ ] The urb:// handler is registered system wide (`xdg-mime query default x-scheme-handler/urb`).
- [ ] All common checks.
- [ ] Updater: the release ships a `.deb.sig`, so the deb should update itself. Confirm it applies the update (it needs root), or says why not.
- [ ] Removal (`apt remove`) leaves no running process.

## macOS arm64 (Apple Silicon)

- [ ] The dmg opens, drag to Applications, first launch passes Gatekeeper (signed and notarized).
- [ ] All common checks, with Cmd for the shortcuts.
- [ ] PDF export: **NEVER VERIFIED**. The NSPrintOperation save job writes the file, with no print dialog, and the file opens in Preview.
- [ ] Copy and paste work in the editor (they ride the small macOS menu).
- [ ] urb:// links open from Safari and from Messages.
- [ ] Updater swaps the .app bundle and relaunches.

## macOS x86_64 (Intel)

- [ ] The dmg opens, drag to Applications, first launch passes Gatekeeper.
- [ ] All common checks, with Cmd for the shortcuts.
- [ ] PDF export: **NEVER VERIFIED**, as on arm64.
- [ ] Copy and paste work in the editor.
- [ ] urb:// links open from another app.
- [ ] Updater swaps the .app bundle and relaunches.

## Results: v1.0.24 AppImage, Linux, Xvfb (2026-11-05)

Run on this Linux machine with `lattice_1.0.24_amd64.AppImage` from the GitHub release (SHA-256 matched `SHA256SUMS-x86_64-unknown-linux-gnu.txt`), `APPIMAGE_EXTRACT_AND_RUN=1`, under Xvfb (1400x900, no DRI3, software rendering), fresh XDG dirs under `~/.cache/lf-XXXX`, no session D-Bus. Keys and clicks were sent with XTest. Reads only: nothing was posted or commented.

| Check | Result |
| --- | --- |
| First launch | Pass. Opens on Settings, Connection, with the node form and "Use anonymously". |
| Node login | Not run. No disposable node was reachable (~tyr was down), and live ships were off limits. |
| Anonymous login | Pass. Comet made in about 20 s, start page shown. |
| Start page | Pass. Renders, links open. |
| Page read | Pass. `urb://~nisfeb/site/lattice/lattice` from a start page link. |
| Forum board | Pass. `urb://~ricsul-bilwyt/forum/test` shows the board, "No posts yet.", and the comet post form. |
| Forum thread | Not run. The only readable board has no posts. |
| Comment | Not run (would be a write). |
| Folder index | Not run. Both folders tried (`~nisfeb/site/`, `~nisfeb/site/lattice/`) and `urb://~ricsul-bilwyt/` have index pages of their own, which rendered. |
| PDF export to file | Not run. Export PDF lives in the ship-served editor, which needs a node login. |
| Zoom (Ctrl `=` / `-` / `0`) | Pass in the anonymous reader. Three steps in enlarged the page, six steps out shrank it, Ctrl-0 returned to within 1% of the original pixels. Not tried in the node workspace, so the Linux zoom permission item stays open. |
| Settings | Pass for the first-launch Settings page. Not reopened from the node workspace. |
| Updater | Not run. Needs an older build installed with a newer release published. |
| urb:// handler registration | Pass. The handler `.desktop` file and the `x-scheme-handler/urb` entry in `mimeapps.list` were written. |
| urb:// link into the running app | Inconclusive. A second launch with a urb:// argument did not exit within 30 s and the open window did not navigate. The run had no session D-Bus, which single-instance forwarding needs, so retest on a real desktop. |
| Reload, Back, Forward | Pass. Back returned to the start page, Forward to the page, Reload re-read it. |
| Loading indicator | Not observed. Sampling the top 4 px every 0.3 s for 5 s during three first-contact reads saw no loading line, and a frame 0.4 s into a reload showed none either. Possibly the software-rendered Xvfb run, possibly real. Retest on a real device. |
