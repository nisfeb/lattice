# lattice

A small, fast **gemtext browser and publisher for [Urbit](https://urbit.org)**.
Think Gemini, but the pages live on the Urbit network: every page is addressed
as `urb://~ship/path` and travels peer-to-peer between ships — no DNS, no web
server, no host in the middle. Native on Android, Linux, macOS, and Windows.

lattice has two parts:

- **`desk/`** — the `%lattice` Gall agent. It publishes the gemtext files in
  your ship's `/pub` directory to the Urbit namespace, serves them to other
  ships over remote scry, and follows remote files so you get notified when
  they change.
- **`app/`** — a Kotlin Multiplatform (Compose) browser/editor that talks to
  your ship over its local HTTP API.

You run the desk on your ship and point the app at it.

## What it does

- **Browse `urb://`** — fetch and read gemtext published by any ship,
  peer-to-peer over Urbit's remote scry. Browser-style tabs (`Ctrl+T`),
  bookmarks, and history.
- **Publish** — anything you drop in `/pub/*.gmi` on your ship is instantly
  readable by anyone as `urb://~you/that/path`. Edit it from inside the app.
- **Editor** — a built-in gemtext editor for your pages, with optional vim
  keybindings (off by default — it edits like a normal textarea otherwise).
- **Follow & subscribe** — follow ships to discover what they publish;
  subscribe to a specific file and get a live notification the moment it
  changes (pushed over an Eyre SSE channel).
- **Discovery** — find other lattice publishers among your `%contacts` via a
  small published manifest.
- **Copy to your ship** — like a bookmark, but real: copy a remote file onto
  your own ship at a path of your choosing.
- **Fully themeable** — colors and fonts are configurable; ships with several
  built-in themes (Lattice Dark/Light and more).

## Install

### 1. The `%lattice` desk (on your ship)

Build the desk with [`build.sh`](build.sh) and commit it to your ship. It
vendors the standard kernel deps via [peru](https://github.com/buildinspace/peru)
(so make sure `peru --version` works), assembles a complete desk under `dist/`,
and — with `-p` — copies it into a mounted desk:

```dojo
|new-desk %lattice
|mount %lattice
```
```bash
./build.sh -p ~/path/to/your-ship/lattice
```
```dojo
|commit %lattice
|install our %lattice
```

Once installed, the agent binds an HTTP endpoint at `/apps/lattice` and begins
publishing whatever is in `/pub`.

**Letting others install it from your ship.** The desk ships a docket, so you
can distribute it over the network:

```dojo
:treaty|publish %lattice
```

Anyone can then install it with `|install ~your-ship %lattice` (or `|ally
~your-ship` and find it in the App Store search). It shows up as a "Lattice"
tile in their Landscape; the tile links to this repo (the real UI is the
native app).

> Endpoints are access-controlled: only your own ship can poke or subscribe to
> the agent, and the HTTP API requires a valid ship session. Anything you put in
> `/pub/*.gmi` is **public by design** (that's the point — it's a publishing
> tool); nothing else leaves your ship.

### 2. The app

Grab your platform from the
[latest release](https://github.com/nisfeb/lattice/releases/latest):

| Platform | File | How to install |
|---|---|---|
| Android | `lattice-X.Y.Z.apk` | Tap to install; you may need to allow "Install unknown apps". Android 8+ (API 26). |
| Linux (any) | `lattice-x86_64.AppImage` | `chmod +x lattice-x86_64.AppImage && ./lattice-x86_64.AppImage`. Needs FUSE 2 (default on most desktops). |
| Debian / Ubuntu | `lattice_*_amd64.deb` | `sudo apt install ./lattice_*_amd64.deb` |
| macOS | `lattice-*.dmg` | Open the DMG, drag lattice to Applications. **First launch:** right-click → Open → Open (unsigned, so Gatekeeper blocks a plain double-click). |
| Windows | `lattice-*.msi` | Double-click. SmartScreen may warn — "More info" → "Run anyway". |

Desktop builds bundle their own JRE, so you don't need Java installed.

Open the app, enter your ship's URL and `+code`, and you're browsing. New to
Urbit? [urbit.org/overview/running-urbit](https://urbit.org/overview/running-urbit)
walks you through booting a ship.

> **Connecting to a remote ship:** lattice refuses to send your `+code` or
> session cookie in cleartext, so a non-local ship must be reached over
> `https` (loopback `http` is fine for a ship on the same machine or a tunnel).

## Connect an AI agent (MCP)

lattice keeps a **private knowledge store** that AI agents can read and write
over [MCP](https://modelcontextprotocol.io) — six tools (`lattice-save`,
`lattice-read`, `lattice-list`, `lattice-search`, `lattice-delete`,
`lattice-restore`). Anything an agent saves shows up in the app's Knowledge
screen, and vice-versa. Full details: [docs/agent-knowledge.md](docs/agent-knowledge.md).

You need the [`%mcp-server`](https://github.com/gwbtc/urbit-mcp) agent on the
ship, and the ship reachable over `https` (put it behind a reverse proxy with
TLS; don't expose the raw `--http-port`).

**Authenticating — the part that trips people up.** Two different things, don't
mix them:

- **`+code`** — the 4 hyphenated words from `+code` in the dojo. Your master
  login secret. Never paste it anywhere but a login prompt; never share it.
- **session cookie** — `urbauth-~your-ship=0v…`, what `/~/login` *returns* once
  you give it the `+code`. This is the revocable, expiring token your client and
  tools actually use.

Mint a cookie with a **verified** login — and check the status, because a *failed*
login (wrong `+code`) still hands back a `Set-Cookie` (an unauthenticated stub),
which is the #1 cause of "my cookie doesn't work":

```bash
read -rsp '+code: ' CODE && echo
curl -sS -D - -o /dev/null -X POST https://your-ship.example.com/~/login \
  --data-urlencode "password=$CODE" \
| awk 'BEGIN{IGNORECASE=1} /^HTTP/{print "status:",$2} /^set-cookie/{print}'
unset CODE
```

Only trust the cookie if `status:` is **200/204** (a `400` means a wrong `+code`).
The `+code` is read with `-s` (no echo) and never leaves your machine.

Then:

1. **`.mcp.json`** (your MCP client's config) — add the server:
   ```json
   { "mcpServers": { "myship": {
       "url": "https://your-ship.example.com/mcp",
       "headers": { "Cookie": "urbauth-~your-ship=0v…" } } } }
   ```
2. **Register the tools once** — the script prompts for the `+code` the same
   hidden way and authenticates itself:
   ```bash
   python3 scripts/setup-knowledge-mcp-tools.py myship
   ```
3. **Reconnect** your client and approve the server. Test with *"list my lattice
   knowledge."*

The cookie expires (and dies if the ship restarts) — just re-run the login to
refresh it. Re-registering tools after a lattice upgrade needs a reset first; see
[docs/agent-knowledge.md](docs/agent-knowledge.md).

## What it isn't

- **Not a host.** Bring your own ship — yours, a friend's, or a hosted one.
- **Not the HTTP web.** Pages are Urbit-native (`urb://~ship/path`) and move
  between ships over remote scry, not over DNS/HTTP.
- **Not on the app stores.** Sideload the APK / installers from GitHub Releases.
- **Desktop builds are unsigned** for now — your OS will warn on first launch.

## Building from source

Gradle lives in [`app/`](app/) (the repo root also holds the Urbit `desk/`). A
full **JDK 17** is required — note that some distros ship `java-17-openjdk` as a
JRE without `javac`; JDK 21 also works.

```bash
cd app
./gradlew :composeApp:run                  # run the desktop app
./gradlew :composeApp:assembleDebug        # debug APK
./gradlew :composeApp:assembleRelease      # release APK (signed if keystore set)
./gradlew :composeApp:packageReleaseDeb    # desktop installer (host OS only)
# Portable Linux AppImage (from the repo root):
./scripts/build-appimage.sh
```

The Hoon agent has unit tests under [`desk/tests/`](desk/tests/); the app has a
JVM test suite (`./gradlew :composeApp:desktopTest`). CI runs both on every PR.

## Releases

Tagging `v*` triggers `.github/workflows/release.yml`, which builds the desktop
installers (`.deb`/`.dmg`/`.msi`/`.AppImage`) and — when signing secrets are set
— the Android APK, then publishes a GitHub Release. See [RELEASE.md](RELEASE.md).

## Layout

```
desk/   the %lattice Gall agent (app/ lib/ sur/ mar/ tests/)
app/    Kotlin Multiplatform Compose app (Android + desktop)
web/    marketing pages (HTML + a gemtext page, fittingly)
scripts/ build helpers
```

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free to use, modify, and share for
any noncommercial purpose; commercial use requires a separate license.

---

© lattice — built by ~nisfeb. PolyForm Noncommercial 1.0.0 licensed.
