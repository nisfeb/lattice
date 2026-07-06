# lattice — browser app

Compose Multiplatform client for the lattice gemtext network. Signs into a ship
with `+code`, fetches pages via the ship's lattice HTTP endpoint
(`GET /apps/lattice/fetch?url=urb://~ship/path`), and renders gemtext with
working `urb://` links. Targets Android + desktop (Linux/macOS/Windows). The
endpoint is served by the grubbery `lattice` nexus.

## Toolchain

- **JDK 21** — set `JAVA_HOME` to a full JDK (not a JRE). On this machine:
  `export JAVA_HOME=/usr/lib/jvm/java-21-openjdk`. (Bytecode target is JVM 17;
  `java-17-openjdk` here is JRE-only, so build with 21.)
- **Android SDK** — `export ANDROID_HOME=/home/sneagan/Android/Sdk`
  (platform-35, build-tools 35.0.0). `local.properties` carries `sdk.dir`
  (gitignored).

## Build / run

```bash
cd app
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk ANDROID_HOME=/home/sneagan/Android/Sdk

./gradlew :composeApp:run             # desktop window
./gradlew :composeApp:assembleDebug   # Android debug APK
./gradlew :composeApp:packageDistributionForCurrentOS   # desktop .deb/AppImage
```

## Layout

- `composeApp/src/commonMain` — UI, gemtext parser/renderer, fetch client, the
  lifted Urbit auth/session layer (`io.nisfeb.lattice.urbit`).
- `composeApp/src/androidMain` — `MainActivity`, manifest, Android `SessionStore`.
- `composeApp/src/desktopMain` — `main()`, desktop `SessionStore` (JSON file).

Auth is lifted from talon (`../../talon`, package `io.nisfeb.talon.urbit`).
