# %lattice browser app — Implementation Plan (Phase 3: skeleton + auth + first render)

> Companion to `2026-05-05-lattice-design.md` (the spec) and the now-complete
> `2026-05-05-lattice-desk.md` (the Urbit side). This plan covers Phase 3 in
> detail and sketches Phases 4–5. The desk side is verified working: the app
> consumes `GET /apps/lattice/fetch?url=urb://~ship/path → {"mark","body"}`.

**Goal:** A Compose Multiplatform app in `app/` that signs into a ship with
`+code`, fetches a gemtext page via the ship's `%lattice` agent, and renders it
with working `urb://` links. Targets: **Android + Linux/desktop** (both from the
start).

> **Status (2026-05-22): Phase 3 complete + bookmarks + packaging pipeline.**
> Tasks 0–7 done; both targets build. Verified live against `~zod`/`~tyr`:
> `+code` login, local fetch, cross-ship fetch, gemtext render, link
> navigation, back/forward/home, bookmarks, and error states (a 404 on an
> unpublished link shows correctly). `createDistributable` produces a bundled
> desktop app-image (jpackage). Remaining: branding/icon (in progress),
> final `.deb`/AppImage (need `dpkg`/`appimagetool` — CI/Debian box), Android
> emulator smoke-test, Phase 4 polish (theming, multi-ship, tabs).

**Template:** talon at `../talon` (a KMP chat app). We **lift its auth/session
layer** (`io.nisfeb.talon.urbit.{UrbitSession,SessionStore,InMemoryCookieJar}`)
and its build scaffolding (version catalog, gradle wrapper, target setup). We do
**not** copy its chat/channel/relay/notification code. New package:
`io.nisfeb.lattice`.

**Key facts established during investigation:**
- Auth is plain OkHttp: `POST {shipUrl}/~/login` with `password=<code>` (dashes
  kept, leading `+` stripped) → `urbauth-~ship` cookie. Reuse the same client
  (cookie jar) for authenticated `fetch` GETs. (talon `UrbitSession.login`.)
- talon's "commonMain" uses OkHttp + `java.*` directly — valid because all
  targets are JVM (android + desktop). We do the same; **no `expect/actual`
  needed for the HTTP client.** Only `SessionStore` persistence is per-platform.
- **JDK build**: bytecode target is JVM 17, but `java-17-openjdk` here is
  JRE-only (no `javac`); build with a full JDK — `export
  JAVA_HOME=/usr/lib/jvm/java-21-openjdk` (LTS; Gradle 8.10.2 + AGP 8.7.3 run
  fine on it). System default JDK 11 is too old.
- **Android SDK is absent** (`~/Android/Sdk`); Task 0 installs it. Desktop needs
  only the JDK.
- Versions (from talon `gradle/libs.versions.toml`): kotlin 2.0.20, agp 8.7.3,
  composeMultiplatform 1.7.3, compose-bom 2026.04.01, okhttp 4.12.0,
  coroutines 1.8.1, kotlinx-serialization 1.7.2, compileSdk/targetSdk 35,
  minSdk 26.

---

## Task plan

### Task 0: Toolchain prerequisites
- [x] **JDK** — `java-17-openjdk` is JRE-only here; use full JDK 21
  (`/usr/lib/jvm/java-21-openjdk`) as `JAVA_HOME`. (Documented in `app/README.md`.)
- [x] **Android SDK** — installed (`~/Android/Sdk`: platform-35, build-tools 35.0.0). Steps: install command-line tools to `~/Android/Sdk`; via
  `sdkmanager` accept licenses and install `platform-tools`,
  `platforms;android-35`, `build-tools;35.0.0`. Write `app/local.properties`
  with `sdk.dir=/home/sneagan/Android/Sdk` (gitignored).
- [ ] Risk: SDK download is large / may need network + license acceptance. If it
  stalls, fall back to **desktop-only** (comment out `androidTarget` behind a
  gradle property) so Phase 3 can proceed; wire Android back in once the SDK is
  present.

### Task 1: Scaffold the `app/` KMP project
**Files:** `app/settings.gradle.kts`, `app/build.gradle.kts`,
`app/gradle.properties`, `app/gradle/libs.versions.toml`, gradle wrapper,
`app/composeApp/build.gradle.kts`, minimal sources.
- [ ] Copy talon's gradle wrapper (`gradlew`, `gradle/wrapper/*`) and
  `gradle.properties` into `app/`. Trim the version catalog to what we use
  (compose, okhttp, coroutines, serialization, activity-compose; drop room,
  coil, media3, mlkit, zxing, djl, relay, unifiedpush).
- [ ] `composeApp/build.gradle.kts`: `androidTarget` (JVM_17) + `jvm("desktop")`
  (JVM_17); `commonMain` deps = compose runtime/foundation/material3 +
  icons-extended + okhttp + coroutines-core + serialization-json; `androidMain`
  = activity-compose + coroutines-android; `desktopMain` =
  compose.desktop.currentOs + coroutines-swing. `compose.desktop` mainClass
  `io.nisfeb.lattice.MainKt`. compileSdk/targetSdk 35, minSdk 26, namespace
  `io.nisfeb.lattice`.
- [ ] Stub `App()` composable in `commonMain` (a `Text("lattice")` in a
  `MaterialTheme`); desktop `main()` (`application { Window { App() } }`);
  Android `MainActivity` + manifest (INTERNET permission).
- [ ] **Verify:** `JAVA_HOME=… ./gradlew :composeApp:run` opens a blank desktop
  window; `./gradlew :composeApp:assembleDebug` builds the APK.

### Task 2: Lift the auth/session layer
**Files:** `app/composeApp/src/commonMain/.../urbit/` (lifted) + new
`LatticeClient`.
- [ ] Copy `UrbitSession.kt`, `SessionStore.kt` (interface + `SavedSession`),
  `InMemoryCookieJar` into package `io.nisfeb.lattice.urbit`; delete the
  channel/`openChannel` parts. Keep `login`, `logout`, cookie jar, `tryRestore`.
- [ ] Per-platform `SessionStore`: Android → SharedPreferences; desktop → a JSON
  file under the user config dir. (Single active ship for v1 is fine.)
- [ ] `LatticeClient.fetch(urbUrl: String): Result<GmiDoc>` — GET
  `{baseUrl}/apps/lattice/fetch?url=<url-encoded urbUrl>` on the session's
  authenticated client; parse `{"mark","body"}` (kotlinx-serialization) into
  `GmiDoc(mark, body)`.
- [ ] **Verify (desktop):** a temporary button that logs into
  `http://localhost:8081` with the `~zod` code, then `fetch("urb://~zod/")` —
  print the body to confirm the round-trip end-to-end.

### Task 3: Auth UI
- [ ] `AddShipScreen`: fields for ship URL (default `http://localhost:8081`) and
  `+code`; on submit call `UrbitSession.login`; on success store + advance.
- [ ] App shell shows `AddShipScreen` when no active session, else the browser.
  Restore the saved session on launch.

### Task 4: Gemtext parser (commonMain)
- [ ] `GemtextParser.parse(body: String): List<GemLine>` where `GemLine` is a
  sealed type: `Heading(level,text)`, `Text(text)`, `Link(url,desc)`,
  `Bullet(text)`, `Quote(text)`, `Pre(lines)` (toggled by ```` ``` ````).
- [ ] Pure, unit-tested in `commonTest` (line-classification cases).

### Task 5: Compose renderer
- [ ] `GemtextView(lines, onNavigate)` rendering each `GemLine` with material3
  typography; `Link` lines are clickable when the URL is `urb://` (call
  `onNavigate`), otherwise shown as selectable inert text with the URL visible.
- [ ] Relative/absolute-path link resolution against the current `urb://` URL
  (per spec: `urb://~s/p`, `/abs`, `rel`).

### Task 6: Browser shell + navigation
- [ ] Address bar (type a `urb://` URL → load), content pane (`GemtextView`),
  back/forward history stack, home = `urb://~activeShip/`.
- [ ] Clicking a rendered `urb://` link pushes history and loads via
  `LatticeClient`. Loading/error states (incl. the remote-timeout case — show a
  spinner with a cancel, since unbound remote paths never answer).

### Task 7: Bookmarks (v1-minimal)
- [ ] Persist a list of `urb://` bookmarks (same per-platform storage as
  sessions); a simple list UI to add/open. (Can slip to Phase 5 if time-boxed.)

### Task 8: Run + verify end-to-end
- [ ] Desktop: log into `~zod`, load `urb://~zod/` (the index), click through to
  `urb://~zod/hello` and `urb://~zod/notes/2026/intro`; load `urb://~tyr/from-tyr`
  (cross-ship). Screenshot.
- [ ] Android: assemble + (if an emulator/device is available) smoke-test login.

---

## Phases 4–5 (sketch, separate detail later)
- **Phase 4** — renderer polish, navigation history search, multiple ships /
  switcher, theming (light/dark), tabs.
- **Phase 5** — packaging: desktop AppImage/.deb/.dmg/.msi via
  `compose.desktop` `nativeDistributions`; Android release APK/AAB signing;
  README + install docs.

## Risks / unknowns
1. **Android SDK install** (Task 0) is the main setup risk; desktop-only
   fallback keeps Phase 3 moving.
2. **Compose Multiplatform + AGP + Kotlin version alignment** — reuse talon's
   exact versions (known-good together) rather than bumping.
3. **Desktop `SessionStore`** has no SharedPreferences; a small JSON-file store
   is the v1 approach.
4. **Remote-path hangs** (desk side) surface here as loads that never resolve —
   the UI needs a cancel/timeout affordance (Task 6).
