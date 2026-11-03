# Lattice desktop on the urb-fetch engine: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let someone with no Urbit ship install lattice desktop and read lattice pages through a comet the app makes (slice 1), then route ship users' reads of other ships' published pages through the same engine with the ship still rendering the page and owning every action (slice 2). Forums and furum boards for shipless readers are slice 3, staged.

**Architecture:** urb-fetch's Rust core (`urb` with `native`, `urb-render`, `urb-gateway`'s state helpers) linked into the desktop binary, its host on a thread of its own (`desktop/src/engine.rs`). Shipless reading is a desktop-owned reader on a second loopback origin (`desktop/src/reader.rs`, `render.rs`, `history.rs`) shown in the workspace window, with every ship action visible and disabled. Slice 2 intercepts the reader route in the bridge (`proxy.rs`), reads natively, and hands the body to a new ship route (`POST /apps/lattice/reader-body`) that renders the page exactly as the GET would.

**Tech Stack:** Rust (Tauri 2 desktop crate, edition 2021), urb-fetch core at a pinned commit (edition 2024, mesa-sys builds libmesa's C with the cc crate and clang, bindgen), Hoon (`code/nex/lattice/app.hoon`), the fleet (`~/software/personal/hoon-development/fleet/fleet`).

**Spec:** `docs/superpowers/specs/2026-11-03-desktop-urb-engine-design.md` (mirror: lattice wiki `specs/2026-11-03-desktop-urb-engine-design`). It holds the hard rule, the action table, the measurements and the spike results this plan relies on.

## Global Constraints

- The hard rule: the engine is a read path for page content only. No task adds a write, a poke, or ship-side state done by the comet or kept locally in place of the ship. Shipless mode shows ship actions disabled with a one-line reason.
- One persistent comet per install, in `<app_data_dir>/urb/`. Never mine a comet per run, per test or per window.
- Tests never contact a live ship. Fleet only, always claimed first with `FLEET_WHO` set (`fleet claim SET WHO`, `fleet release SET` at the end, on failure too). Never ~ricsul-bilwyt or ~hus without a claim.
- A Tauri command is registered in three places (`src/main.rs` `generate_handler!`, `build.rs` `AppManifest::commands`, `capabilities/*.json`), then `node scripts/desktop-commands.mjs` passes.
- The urb-fetch pin is one commit for all three crates. Bumping it is its own commit.
- `cargo test`, `cargo clippy --all-targets -- -D warnings` and `cargo deny check` pass in `desktop/` after every task.
- Commits as `nisfeb <business@nisfeb.com>`, no AI attribution, Doom commit-msg lint (valid type, no scope except `ci`, subject at most 72, body wrapped at 72). No em-dashes; never hard-wrap markdown.
- Desktop release: bump `desktop/Cargo.toml` and `desktop/tauri.conf.json` versions together as the last step of a slice. Ship release (slice 2): bump `code/version.json`.

## Review Focus

- **No comet action:** grep the diff for `Request::Poke`, `Request::Peek` with a write, furum or forum write calls: none. Pinned by Task 10's strip test and Task 19's route test.
- **Reader origin has no IPC:** an `invoke` from a reader page and from its sandboxed frame is refused. Pinned in Task 11.
- **Publisher HTML stays sandboxed:** `/raw` always carries the SANDBOX CSP and the frame its sandbox attribute; gemtext and Markdown pages carry `default-src 'none'`. Pinned in Task 7 and Task 9.
- **Another local process cannot drive the comet:** `/read` without the token is a 403 before the engine is asked. Pinned in Task 9.
- **The ship page is unchanged by slice 2:** the reader page from `reader-body` is byte-identical to the GET's for the same body. Pinned in Task 18.

---

## Slice 0: the engine builds everywhere

### Task 1: CI job that builds mesa-sys for every release target

**Files:**
- Modify: `.github/workflows/ci.yml` (new job `engine-build`)

The riskiest unknown first: libmesa has never been built by mesa-sys on macOS, and the release runners' default clangs (ubuntu-22.04's 14, Xcode 15's Apple clang) predate `-std=gnu23`.

- [ ] Step 1: Add job `engine-build` with a matrix of `{ubuntu-22.04, x86_64-unknown-linux-gnu}`, `{macos-14, aarch64-apple-darwin}`, `{macos-14, x86_64-apple-darwin}`. Steps: checkout `nisfeb/urb-fetch` at `89ca9ec` with `submodules: recursive`; on Linux `wget https://apt.llvm.org/llvm.sh && sudo bash llvm.sh 18`, then `echo CC_x86_64_unknown_linux_gnu=clang-18 >> $GITHUB_ENV` and `echo LIBCLANG_PATH=/usr/lib/llvm-18/lib >> $GITHUB_ENV`; on macOS `brew install llvm@20`, then set `CC_aarch64_apple_darwin` and `CC_x86_64_apple_darwin` to `$(brew --prefix llvm@20)/bin/clang`, `LIBCLANG_PATH=$(brew --prefix llvm@20)/lib`, `SDKROOT=$(xcrun --show-sdk-path)`; `rustup target add ${{ matrix.target }}`; `sh core/mesa-sys/fetch-deps.sh` (on macOS first check `command -v sha256sum || brew install coreutils`); `cargo build --release --manifest-path core/Cargo.toml -p urb --features native --target ${{ matrix.target }}`.
- [ ] Step 2: Push the branch and watch the run (`gh run watch`). Record each target's result and build time in the PR description.
- [ ] Step 3: If a macOS target fails, fix it upstream in urb-fetch (a flag in `core/mesa-sys/build.rs`, or a libmesa warning under `-Werror`) by rule 2 of `docs/rust-core.md`, and re-pin later. If it cannot be fixed this slice, note it: Task 2's `urb-engine` feature lets that target ship without shipless reading.
- [ ] Step 4: Commit (`ci: build the urb engine for every release target`).

### Task 2: Take the engine as a dependency

**Files:**
- Modify: `desktop/Cargo.toml`, `desktop/Cargo.lock`, `deny.toml`
- Create: `desktop/.cargo/config.toml`, `desktop/scripts/mesa-deps.sh`
- Modify: `.gitignore` (ignore `desktop/target/mesa-deps` if `target/` is not already ignored there)

- [ ] Step 1: In `[dependencies]` add, with a comment pointing at the spec:
  ```toml
  urb-engine = { package = "urb", git = "https://github.com/nisfeb/urb-fetch.git", rev = "89ca9ec", features = ["native"], optional = true }
  urb-render = { git = "https://github.com/nisfeb/urb-fetch.git", rev = "89ca9ec", optional = true }
  urb-gateway = { git = "https://github.com/nisfeb/urb-fetch.git", rev = "89ca9ec", optional = true }

  [features]
  default = ["urb-engine"]
  urb-engine = ["dep:urb-engine", "dep:urb-render", "dep:urb-gateway"]
  ```
  The rename is required: `src/urb.rs` is `mod urb` and shadows a crate named `urb`.
- [ ] Step 2: Write `desktop/scripts/mesa-deps.sh`: `set -eu`; find the mesa-sys manifest with `cargo metadata --format-version 1 --manifest-path desktop/Cargo.toml | node -e '...'` (or `jq`) selecting the package named `mesa-sys`; if `sha256sum` is missing, put a shim on PATH that runs `shasum -a 256 "$@"`; run `MESA_SYS_DEPS="$here/../target/mesa-deps" sh "$(dirname "$manifest")/fetch-deps.sh"`. It is idempotent (fetch-deps.sh skips a checked folder).
- [ ] Step 3: `desktop/.cargo/config.toml`:
  ```toml
  [env]
  MESA_SYS_DEPS = { value = "target/mesa-deps", relative = true }
  ```
- [ ] Step 4: Fix the lock as the spike found: `cargo update -p cc` and `cargo update -p prettyplease --precise 0.2.37` (bindgen 0.73.2 otherwise pairs syn 2 with prettyplease 0.3 on syn 3, which fails to compile). Comment the pin in `Cargo.toml` next to the dependency.
- [ ] Step 5: `deny.toml` `[sources]`: add `allow-git = ["https://github.com/nisfeb/urb-fetch"]`. Run `cargo deny check` in `desktop/`; resolve any duplicate-version or license findings (urb crates are MIT; urcrypt MIT; SQLite public domain).
- [ ] Step 6: `sh desktop/scripts/mesa-deps.sh && cd desktop && cargo build && cargo build --no-default-features && cargo test`. Both builds pass; the second proves the feature gate.
- [ ] Step 7: Add the mesa-deps step to CI's `desktop` and `deny` jobs in `ci.yml`, before cargo runs.
- [ ] Step 8: Commit (`build: link the urb-fetch engine into the desktop`).

### Task 3: Upstream: render with a link function

**Files (in `~/software/personal/urb-fetch`, a branch off main):**
- Modify: `core/urb-render/src/gateway.rs`
- Test: `core/urb-render/tests/` (a new file `render_with.rs`)

- [ ] Step 1: Write the failing test: for every case in `conformance/gateway-go.json`'s render and rewriteHTML vectors, `render_with(url, mark, body, &page_link(url, port))` equals `render(url, mark, body, port)` and `rewrite_html_with(body, &link)` equals `rewrite_html(body, port)` byte for byte.
- [ ] Step 2: Add `pub fn render_with(url: &[u8], mark: &str, body: &[u8], link: &Linker) -> (&'static str, Vec<u8>)` and `pub fn rewrite_html_with(body: &[u8], link: &Linker) -> Vec<u8>`; make `render` and `rewrite_html` call them. No behaviour change.
- [ ] Step 3: `cd core && cargo test -p urb-render && ci/test.sh`. Open a PR on nisfeb/urb-fetch; after merge, note the merge commit.
- [ ] Step 4: In the lattice worktree, move all three pins to that commit; `cargo build && cargo test`; commit (`build: pin urb-fetch with render_with`).

### Task 4: The engine

**Files:**
- Create: `desktop/src/engine.rs`
- Modify: `desktop/src/main.rs` (`mod engine;` under `#[cfg(feature = "urb-engine")]`, `.manage(engine::Engine::new(...))`)

**Interfaces:**
- `pub struct Engine` (managed state), `Engine::new(dir: PathBuf) -> Engine` (does nothing yet), `Engine::status(&self) -> Status` with `Status::{Off, Booting, Ready { our: String }, Failed(String)}`, `Engine::read(&self, url: &str, budget: Duration, wait_boot: bool) -> Result<NativePage, ReadError>`, `NativePage { key, body, mark, how }`, `ReadError::{NotPublished, Unreachable { later: bool }, Busy, Booting, Failed(String)}`, `Engine::close(&self)` (on app exit).

- [ ] Step 1: Write failing unit tests: `fail_of`-based mapping (a `Failure` with "not published" maps to `NotPublished`; a `later` failure to `Unreachable { later: true }`; libmesa's "is in use by another process" to `Busy`); the 4 MB body cap gives `Failed`; `new` creates nothing on disk; the state dir is created 0700 on start.
- [ ] Step 2: Implement after `urb-gateway`'s `main.rs`: a lazily started thread that calls `urb_gateway::state::find(&dir, "", false, "")`, builds `GatewayUdp { fake: false, port, log, udp: None }`, `NetIo::new`, `Host::new(io, random)`, `host.open(false)`, then loops over a job channel (`Job::Read(url, Sender<Result<..>>)`, `Job::Close`) and `host.turn()`, woken with `NetIo::waker()`. Logs go to `commands::dlog` with an `engine:` prefix. A test-only constructor `Engine::fake(dir, fake_ship)` passes the fake name to `find` and `fake: true`, for Task 5.
- [ ] Step 3: Close on exit: in `main.rs`'s run event `RunEvent::Exit`, call `engine.close()` (waits up to 2 s, as libmesa wants its last save).
- [ ] Step 4: `cargo test engine && cargo clippy --all-targets -- -D warnings`.
- [ ] Step 5: Commit (`feat: run the urb engine on a thread of its own`).

### Task 5: A real native read on the fleet

**Files:**
- Modify: `desktop/src/engine.rs` (an `#[ignore]` test, `engine_reads_a_fleet_page`; the desktop has no lib target, so it lives beside the code)
- Create: `scripts/desktop-engine-fleet.sh`

- [ ] Step 1: Write `scripts/desktop-engine-fleet.sh`: require `FLEET_WHO`; `fleet claim lattice-gate-peer "$FLEET_WHO"` (exit 0 with `skipped: claimed by X` if held); `trap 'fleet release lattice-gate-peer' EXIT`; `fleet reset lattice-gate-peer lattice`; wait until the serf is over 110 s old (as urb-fetch's `core/ci/settle.mjs`); mint a cookie with `scripts/hoon-test-kit/ship-cookie.sh ~/fleet/piers/wep http://localhost:8151 "$tmp/wep.jar"` (VERE from fleet's `kernels.conf`); publish `POST /apps/lattice/save?path=desktop-engine-check` with a gemtext body holding a nonce, a link `=> urb://~wep/other` and a relative link; then `cd desktop && LATTICE_FLEET=1 FLEET_PAGE=urb://~wep/desktop-engine-check FLEET_NONCE=$nonce cargo test engine_reads_a_fleet_page -- --ignored --nocapture`.
- [ ] Step 2: The test (`#[ignore]`): skip with a printed reason unless `LATTICE_FLEET=1`; open `Engine::fake(tmp, "~bidlys-donref-dozzod-dozwep")`; read `FLEET_PAGE`; assert the body holds the nonce, the mark is `gmi`, and a second read is under 50 ms; render it with Task 7's renderer and assert the urb link became `/read?url=urb%3A%2F%2F~wep%2Fother`.
- [ ] Step 3: Run it: `FLEET_WHO=desktop-engine scripts/desktop-engine-fleet.sh`. Expected: one passing test, the claim released.
- [ ] Step 4: CI: plain `cargo test` runs it as ignored (no fleet), which is the clean skip.
- [ ] Step 5: Commit (`test: read a fleet page through the desktop engine`).

---

## Slice 1: shipless reading, end to end

### Task 6: Local reading history

**Files:**
- Create: `desktop/src/history.rs`

**Interfaces:** `History::open(dir) -> History`, `add(url, title)`, `list() -> Vec<Entry>` newest first, `clear()`. File `<dir>/history.json`, `[{url, title, at}]`, at most 500, a revisit moves the entry to the top, written atomically (temp file and rename).

- [ ] Step 1: Failing tests: cap at 500 drops the oldest; revisit dedupes and moves up; clear empties the file; a corrupt file reads as empty and is replaced on the next add; titles over 256 chars are cut.
- [ ] Step 2: Implement. `cargo test history`.
- [ ] Step 3: Commit (`feat: keep a local history of shipless reads`).

### Task 7: The reader's renderer

**Files:**
- Create: `desktop/src/render.rs`, `desktop/ui-reader/reader.css`, `desktop/ui-reader/reader.js` (compiled in with `include_str!`)

**Interfaces:** `link_for(page_url) -> impl Fn(&[u8]) -> (Vec<u8>, bool)` (urb-render's `page_link` with a dummy port, then every gateway URL mapped back to `/read?url=<percent-encoded urb://...>` via `urb_render::gateway::urb_of_host`; http, https, mailto and gemini kept; everything else empty); `page(url, native, mode) -> (csp, html)` where `mode` is `Shipless` or `ShipDown` (the action strip's reason).

- [ ] Step 1: Failing tests: each link kind (absolute urb://, relative, `..`, `//evil`, `javascript:`, a control byte, a 600-char target) gives the expected href or none; a gemtext page's CSP is `default-src 'none'; style-src 'unsafe-inline'; script-src 'self'`; a `%html` page and a `%gmi` body that looks like HTML give the outer page with `<iframe sandbox="allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation" src="/raw?...">` and never inline the markup; the action strip has Bookmark, Comment and Follow as `disabled` buttons with "Connect a ship to bookmark" (and so on), or "Your ship isn't answering" in `ShipDown`; the address field holds the url; the title is the first `#` heading or the url.
- [ ] Step 2: Implement with `urb_render::gateway::render_with` (Task 3) and `render_as`. `reader.js` holds only back, forward and the retry button, no inline script anywhere.
- [ ] Step 3: `cargo test render`.
- [ ] Step 4: Commit (`feat: render urb pages for the shipless reader`).

### Task 8: The start list

**Files:**
- Create: `desktop/ui-reader/start.gmi` (the compiled-in copy, and the text the owner publishes)
- Modify: `desktop/src/render.rs` (`START_URL` constant and `home()`)

- [ ] Step 1: Write `start.gmi`: a heading, one line on what lattice is, and links to a handful of public lattice pages and boards the owner picks (leave the list to the owner in the PR description; until then, the owner's own public index). Set `START_URL` to the owner's chosen address (placeholder `urb://~nisfeb/start`, flagged in the PR for the owner to confirm and publish).
- [ ] Step 2: `home()` renders: the address form, "Start here" (the live page read through the engine with a 3 s budget, else the compiled-in copy), and recent history (Task 6) with "Clear history". Test: with a failing fake read, the compiled-in copy shows.
- [ ] Step 3: Commit (`feat: give the shipless reader a start page`).

### Task 9: The reader origin

**Files:**
- Create: `desktop/src/reader.rs`
- Modify: `desktop/src/main.rs` (`.manage(reader::Reader(Mutex::new(None)))`)

**Interfaces:** `reader::ensure(app) -> Result<String, String>` binds `127.0.0.1:26520` (patiently, then 26521 to 26535, as `proxy::bind_stable`) and returns the base; `reader::boot_url(base, to)`. Routes as in the spec: `/`, `/read?url=`, `/raw?url=&key=`, `/assets/*`, `/boot?k=&to=`.

- [ ] Step 1: Failing tests, fed as bytes like `proxy.rs`'s: a foreign Host is 403; `Origin: http://evil` is 403; `Sec-Fetch-Site: cross-site` without a reader Referer is 403; `/read` without the token cookie is 403 and the engine is not called (a counting fake engine); `/raw` from a sandboxed frame (Origin null, reader Referer, no cookie) is served with the SANDBOX CSP; POST is 405; a url that fails `urb::parse` is 400 with a page saying so; a 2 KB+ request line is 414.
- [ ] Step 2: Implement with a small trait `Reads { fn read(&self, url, budget) -> Result<NativePage, ReadError> }` implemented by `Engine` and by the tests' fake. `/read` adds a successful read to History. `later` failures retry up to 5 times inside the request, 1 s apart, within a 20 s total.
- [ ] Step 3: `cargo test reader`.
- [ ] Step 4: Commit (`feat: serve the shipless reader on its own origin`).

### Task 10: Strip test: the comet never acts

**Files:**
- Create: `desktop/src/engine.rs` test `only_reads_are_submitted`

- [ ] Step 1: Make the host thread's submit go through one function `submit_read(url)`; add a test that greps `engine.rs`'s own source (`include_str!`) for `Request::Poke`, `Request::Peek`, `FurumCall`, `ForumCall`, `Request::Inbox` and fails if any appears. It is the hard rule as a test, so a later change has to delete it on purpose.
- [ ] Step 2: Commit (`test: the desktop engine submits reads only`).

### Task 11: Navigation and capabilities

**Files:**
- Modify: `desktop/src/commands.rs` (`nav_decision` and its tests), `desktop/capabilities/workspace-remote.json`

- [ ] Step 1: Failing tests in `commands.rs`: the reader origin is `Nav::Allow`; with no bridge, an urb:// navigation is `Nav::Rewrite` to `<reader>/read?url=...` (encoded as today's reader rewrite); with a bridge it is still the ship's reader (unchanged); the existing `workspace_commands_are_granted_only_at_the_bridge` test now asserts the remote urls are exactly `http://127.0.0.1:26500` to `:26515` and that `http://127.0.0.1:26520` matches none.
- [ ] Step 2: `nav_decision` takes a third lazy argument, the reader port. Update `workspace-remote.json`'s `remote.urls` to the 16 bridge origins and its description to say why.
- [ ] Step 3: Add to `scripts/desktop-matrix.sh` a case that loads a reader page and, through `LATTICE_PROBE_JS`, tries `window.__TAURI__.core.invoke('take_urb_links')` in the page and inside a sandboxed `/raw` frame, expecting both to reject.
- [ ] Step 4: `cargo test && scripts/desktop-matrix.sh` (with a fleet page from Task 5's script for the reader case).
- [ ] Step 5: Commit (`fix: grant workspace commands to the bridge ports only`), then (`feat: keep urb links in the shipless reader`).

### Task 12: Commands for the manager

**Files:**
- Modify: `desktop/src/commands.rs`, `desktop/src/main.rs`, `desktop/build.rs`, `desktop/capabilities/local.json`

**Interfaces:** `open_reader(url: Option<String>)` (validates with `urb::parse` when given; starts the reader origin and the engine; navigates the workspace window through `/boot` to `/read?url=` or `/`), `reader_status() -> {engine: "off"|"booting"|"ready"|"failed", our: Option<String>, error: Option<String>}`, `clear_reader_history()`.

- [ ] Step 1: Implement and register each in all three places (local.json only; none in workspace-remote).
- [ ] Step 2: `node scripts/desktop-commands.mjs && cargo test`.
- [ ] Step 3: Commit (`feat: open the shipless reader from the manager`).

### Task 13: The manager's first-run card

**Files:**
- Modify: `desktop/ui/manager.html`, `scripts/ui-manager.mjs`

- [ ] Step 1: Failing browser test in `ui-manager.mjs` (stubbed Tauri): with no ship configured the "Read without a ship" card is first and the connect form second; Open with `urb://~zod/x` invokes `open_reader` with that url; a bad address shows "That isn't an urb:// address" without invoking; while `reader_status` says `booting` the card shows "Setting up your reader. This happens once."; with a ship configured the card follows the ship section; with the `urb-engine` feature off (`reader_status` rejects) the card is hidden.
- [ ] Step 2: Implement the card: the copy from the spec, the address field, Open, "Start here" (`open_reader(null)`), the network note in a details element, and "Clear reading history" (`clear_reader_history`).
- [ ] Step 3: `CHROME="$(command -v google-chrome)" node scripts/ui-manager.mjs`.
- [ ] Step 4: Commit (`feat: offer reading without a ship on first run`).

### Task 14: urb:// links with no ship

**Files:**
- Modify: `desktop/src/urb.rs`, `desktop/src/main.rs`

- [ ] Step 1: Failing test: `route(cfg_url_empty: bool, on_shell_page: bool)` returns `Reader` when no ship is configured and `Inbox` otherwise (today's path).
- [ ] Step 2: In `arrive`, with no ship configured, call `open_reader(Some(newest))` on the main thread instead of only queueing; the inbox still keeps the link so a ship connected later can take it.
- [ ] Step 3: Manual: with an empty config dir (`XDG_CONFIG_HOME=$(mktemp -d)`) run `target/debug/lattice-desktop urb://~wep/desktop-engine-check` against a claimed fleet set (Task 5's script, with the read as a fake moon via `LATTICE_ENGINE_FAKE=~bidlys-donref-dozzod-dozwep`, a debug-build-only override like `LATTICE_PROBE_JS`) and see the page.
- [ ] Step 4: Commit (`feat: open urb links in the shipless reader when no ship is set`).

### Task 15: Packaging

**Files:**
- Modify: `.github/workflows/release.yml`, `flake.nix`, `desktop/README.md`

- [ ] Step 1: release.yml: before "build and upload", run Task 1's toolchain steps per OS (clang 18 from apt.llvm.org on ubuntu-22.04 with `CC_x86_64_unknown_linux_gnu` and `LIBCLANG_PATH`; Homebrew `llvm@20` on macOS with `CC_<target>`, `LIBCLANG_PATH` and `SDKROOT`), then `sh desktop/scripts/mesa-deps.sh`. If Task 1 left a target unable to build, pass `--no-default-features` for that matrix entry only and say so in the job's label.
- [ ] Step 2: flake.nix: add `clang` and `rustPlatform.bindgenHook` to `nativeBuildInputs`; `fetchurl` the two archives (URLs and SHA-256s from `fetch-deps.sh`), unpack them into one derivation with `urcrypt/` and `sqlite/`, and set `MESA_SYS_DEPS` to it in `buildRustPackage`'s env; add `cargoLock.outputHashes` for `urb-0.0.1`, `urb-render-0.0.1`, `urb-gateway-0.0.1` and `mesa-sys-0.0.1` (get each with a fake hash and `nix build`). Check the libmesa submodule arrived (`third_party/libmesa/src/noun.c` in the vendored source); if not, set `cargoLock.allowBuiltinFetchGit = true`.
- [ ] Step 3: Run `nix build .#lattice-desktop --print-build-logs` locally or in CI's nix job; it passes and `result/bin/lattice-desktop` exists.
- [ ] Step 4: Run a hand-dispatched release workflow on the branch (unsigned, a draft) and record each bundle's size against the 1.0.15 release's assets (`gh release view v1.0.15 --json assets`). Expected: about +1.1 MB per installer.
- [ ] Step 5: README: a "Reading without a ship" section (what it is, what is stored in `<app_data_dir>/urb/`, the network it uses, how to clear it) and the build prerequisite (clang 18 or newer, `desktop/scripts/mesa-deps.sh`).
- [ ] Step 6: Commit (`ci: build release bundles with the urb engine`), (`build: build the urb engine in the nix flake`), (`docs: explain reading without a ship`).

### Task 16: Slice 1 end-to-end check and release

**Files:**
- Modify: `scripts/desktop-matrix.sh`, `desktop/Cargo.toml`, `desktop/tauri.conf.json`

- [ ] Step 1: desktop-matrix shipless case: empty config dir, the real binary, Open a fleet page from the manager (as a fake moon via the debug override), assert the page text, the disabled strip and its three reasons, a click on an in-page urb link staying in the reader, back returning, and the history entry on the home.
- [ ] Step 2: First-run timing on a real network, by hand, on a clean data dir, reading one public page of the owner's choosing (once, from the persistent comet the app makes; not a test): record time to the comet being ready and to the first page in the PR.
- [ ] Step 3: Bump the desktop to 1.1.0 in both files. Commit (`release: lattice desktop 1.1.0, read lattice without a ship`).

---

## Slice 2: ship users' published reads, natively, with fallback

### Task 17: Ship: one arm for the reader's page view

**Files:**
- Modify: `code/nex/lattice/app.hoon` (the `%pub` branch of the `/apps/lattice?url=` handler)

- [ ] Step 1: Before changing anything, record the reader HTML for a peer gemtext page, a peer Markdown page, a peer `%html` page and a peer `%gmi` page that looks like HTML, read from ~dep of pages on ~wep (claim lattice-gate and lattice-gate-peer; publish the four on ~wep). Save to `/tmp/reader-before/`.
- [ ] Step 2: Move everything after `got` (canon, `cbox`, `fv`, `oft`, `ttl`, the mode branches, the send, the history visit) into `++  reader-pub-view  |=  [eyre-id=@ta our=@p ship=@p rel=path mode=view-mode:pg body=@t raw=@t bg=?]`; the GET calls it. No behaviour change.
- [ ] Step 3: Deploy to ~dep (`scripts/dev-deploy.py`), re-read the four pages, and `diff -r /tmp/reader-before /tmp/reader-after`: identical. History shows four visits each round.
- [ ] Step 4: Commit (`refactor: one arm renders a peer page in the reader`).

### Task 18: Ship: the reader-body route

**Files:**
- Modify: `code/nex/lattice/app.hoon`, `code/version.json`
- Test: `scripts/two-ship-reader-body.sh`

- [ ] Step 1: Write `scripts/two-ship-reader-body.sh` (A = ~dep, B = ~wep, env as `two-ship-links.sh`): for each of the four pages, `POST /apps/lattice/reader-body?url=urb://~wep/<p>` with `{"mark","body"}` from B's `/fetch` gives HTML byte-identical to `GET /apps/lattice?url=...`; a history entry is written; a key-authenticated request is 403; our own ship is 400; a folder url is 400; an oversize body is 413; a mark `%hoon` is floored to `%gmi`; no session is 403.
- [ ] Step 2: Implement `[%'POST' %reader-body]`: owner session only, `?=(~ key)`, parse the url with `de-urb:lu` to `%pub`, refuse own ship and folder, parse the JSON body, cap it, map the mark to a view-mode (floor `%gmi`), call `+reader-pub-view`.
- [ ] Step 3: Run the script: all pass. Bump `code/version.json` to the next release.
- [ ] Step 4: Commit (`feat: render a reader page from a body the desktop read`).

### Task 19: Bridge: intercept and read natively

**Files:**
- Modify: `desktop/src/proxy.rs`

**Interfaces:** `fn native_candidate(target: &str, headers: &[(String, String)], our: &str) -> Option<String>` (the url when every condition in the spec's step 1 holds); `enum Route { Relay, ReaderBody(NativePage), ShipDownPage(NativePage) }` decided by a pure `fn route_after(native: Result<NativePage, ReadError>, ship_has_route: bool) -> ...`.

- [ ] Step 1: Failing tests: `native_candidate` for own ship, another ship, a folder, `/forum/b`, `/k/x`, `/p/x`, a single-letter mount, `via=ship`, `x-lattice-bg`, a search query, a bad url; `route_after` for each row of the spec's flow; end to end with `testutil::Stub` as the ship and a fake engine: a native success makes exactly one `POST /apps/lattice/reader-body` and no GET; a 404 from it makes one GET and marks the session; `NotPublished` makes one GET and the next request for that url skips the engine; a stub that refuses connections yields the ship-down page with "Your ship isn't answering".
- [ ] Step 2: Implement in `serve`: after `read_request`, before relaying, check `native_candidate`; the engine is asked only when `Status::Ready` (start it otherwise, and relay); a 3 s budget; the 5 minute not-published memory and the per-session "no route" flag live in the `Bridge` state. Start the engine in the background when a workspace opens (`open_workspace`), so it is ready by the first click.
- [ ] Step 3: `cargo test proxy && scripts/desktop-bridge-check.sh`.
- [ ] Step 4: Commit (`feat: read other ships' pages natively through the bridge`).

### Task 20: Slice 2 two-ship check and release

**Files:**
- Create: `scripts/desktop-native-read.sh`
- Modify: `desktop/Cargo.toml`, `desktop/tauri.conf.json`

- [ ] Step 1: The script claims lattice-gate and lattice-gate-peer, deploys Task 18's lattice to ~dep, runs the debug desktop against ~dep (`LATTICE_ENGINE_FAKE` as a fake moon), and through `LATTICE_PROBE_JS` opens a browser tab on `urb://~wep/<page>`: the frame shows the page with the star and comment box; the desktop log shows `bridge: native` and one `reader-body`; a comment sent from the box arrives on ~wep (`/apps/lattice/comments` on B); a bookmark lands in A's `/bookmarks`; a page ~wep shares privately with ~dep opens through the ship (log shows the fall-through); with ~dep's serf stopped (SIGSTOP), the tab shows the ship-down page with the disabled strip; SIGCONT, release both claims.
- [ ] Step 2: Time 10 warm and 10 cold-page reads through the bridge both ways (`via=ship` and native) and add the medians to the spec's measurements section.
- [ ] Step 3: Bump the desktop to 1.2.0. Commit (`release: lattice desktop 1.2.0, faster reads of other ships`).

---

## Slice 3 (staged, planned after slices 1 and 2 ship)

### Task 21: Forum and furum boards for shipless readers

A separate plan. Outline: the engine gains read-only board calls through `ForumCall` and `FurumCall` read variants (Task 10's strip test is amended to allow exactly those, by name), `render.rs` gains a board and thread view, `/read` routes `urb://~host/forum/<board>[/<id>]` and furum addresses to it, and posting is a disabled "Connect a ship to post".
