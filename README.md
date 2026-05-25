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

The agent source lives in [`desk/`](desk/). Install it onto a desk on your ship
and start the `%lattice` agent. Once it's running it binds an HTTP endpoint at
`/apps/lattice` and begins publishing whatever is in `/pub`.

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
