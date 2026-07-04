# Releasing lattice

Release artifacts are built by `.github/workflows/release.yml`, triggered by
pushing a `v*` tag. Each release publishes:

- **Desktop installers** (always): `.deb` (Linux), `.dmg` (macOS), `.msi`
  (Windows), and a portable `.AppImage` (Linux).
- **Android APK** (only if signing secrets are set): `lattice-<version>.apk`.

The Urbit side is the grubbery `lattice` nexus (source in `grubbery-overlay/`);
it's installed on a ship separately (see the README) and is not part of these
build artifacts.

## Cutting a release

1. Bump the version — the single source of truth is two literals in
   `app/composeApp/build.gradle.kts`:

   ```kotlin
   val latticeVersionCode = 1      // increment every release (monotonic)
   val latticeVersionName = "0.1.0"
   ```

   `versionCode` must strictly increase for Android updates. `versionName` must
   match the tag (without the `v`).

2. Commit, then tag and push:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

   The workflow checks the tag against `latticeVersionName` and fails fast on a
   mismatch. Tags containing `-rc` / `-beta` / `-alpha` publish as GitHub
   pre-releases.

## Versioning notes

- jpackage (`.dmg`/`.msi`) rejects a major version of `0`, so
  `derivePackageVersion()` maps `0.MINOR.PATCH` → `1.MINOR.PATCH` for the desktop
  installer metadata only. The Android `versionName` and the release tag keep the
  real `0.x` value. This mapping becomes identity once the project crosses 1.0.

## Android signing (optional, enables the APK)

The APK job runs only when these repository secrets are set; without them the
release ships desktop installers only.

| Secret | Meaning |
|---|---|
| `RELEASE_KEYSTORE_BASE64` | base64 of your release keystore (`base64 -w0 release.keystore`) |
| `RELEASE_STORE_PASSWORD` | keystore password |
| `RELEASE_KEY_ALIAS` | key alias |
| `RELEASE_KEY_PASSWORD` | key password |

Generate a keystore once and keep it safe (losing it means you can't ship
updates that existing installs will accept):

```bash
keytool -genkeypair -v -keystore release.keystore \
  -alias lattice -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 release.keystore   # paste into RELEASE_KEYSTORE_BASE64
```

Locally, `assembleRelease` falls back to debug signing when
`RELEASE_KEYSTORE_PROPS` is unset, so unsigned local builds still work.

## Building artifacts locally

Gradle lives in `app/`. A full JDK 17 is required (the system `java-17-openjdk`
on some distros is a JRE without `javac`/`jmods`; JDK 21 also works):

```bash
cd app
JAVA_HOME=/path/to/jdk ./gradlew :composeApp:packageReleaseDeb     # needs dpkg
JAVA_HOME=/path/to/jdk ./gradlew :composeApp:assembleRelease       # APK
# Portable Linux AppImage (run from the repo root):
JAVA_HOME=/path/to/jdk ./scripts/build-appimage.sh
```

`.deb` needs `dpkg`/`fakeroot`, `.dmg` needs macOS, `.msi` needs WiX on Windows —
which is why CI runs each on its native host.
