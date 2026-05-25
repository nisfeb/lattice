# %lattice — design

**Status:** draft, v1 scope
**Date:** 2026-05-05

## Goal

A cross-ship hypertext content network for Urbit. Authors publish gemtext
(`.gmi`) files from a Clay desk; readers fetch them over Ames remote scry
(`%fine`); a native Compose Multiplatform app renders the result with
working cross-ship links.

The wire protocol is *not* Gemini-over-TLS. We borrow the gemtext content
format and the spirit (small, hypertext, cross-linkable) and use Urbit's
native primitives in place of TCP/TLS/DNS. URLs are
`urb://~ship/path` — ship name is the address, no DNS.

## Architecture

### Two artifacts

1. **`%lattice` desk** — Urbit desk containing the `%lattice` agent, a
   `%gmi` mark, generated docket, and the author's `lib/` directory of
   gemtext files. Lives in `desk/` in this repo.
2. **`lattice` app** — Compose Multiplatform Kotlin app for Android +
   Linux/macOS/Windows desktop. Templated on talon (lift its
   `+code`/channel auth code). Lives in `app/` in this repo.

### Wire model

```
Author ship ~author                          Reader ship ~reader + app
  desk/lib/notes/intro.gmi                      lattice app
        ↓ |commit                                  ↓ HTTP (Eyre, +code session)
   %lattice agent                              %lattice agent on ~reader
   reads Clay,                                     ↓ remote scry over Ames
   binds /x/lib/notes/intro/gmi                ~author serves cached value
        ↓ Ames %fine ←──────────────────────────  ↓
                                              app renders gemtext
```

The reader's app does not speak Ames — it speaks Eyre HTTP to the *user's
own* `%lattice` agent, which performs the remote scry. This keeps the
app in the role of "client to my ship", same as Talon.

## URL scheme

```
urb://~ship-name/path/to/doc
```

- Scheme: `urb`. Distinct, can register as an OS protocol handler later.
- Authority: an Urbit ship name (`@p`), with the leading `~`.
- Path: forward-slash-delimited segments. Trailing `.gmi` is *omitted*
  from the URL but implied on disk.
- Fragments: not supported in v1.
- Query: not supported in v1.

### URL ↔ Clay ↔ scry mapping

For `urb://~author/notes/2026/intro`:

| Layer | Form |
|---|---|
| URL | `urb://~author/notes/2026/intro` |
| Clay path on author's desk | `/lib/notes/2026/intro/gmi` |
| Scry path bound by agent | agent namespace path corresponding to `/lib/notes/2026/intro/gmi` (exact encoding deferred — see Open questions) |

`urb://~author/` (empty path) is the ship's home page:
- if `lib/index.gmi` exists on the desk, serve it;
- else the agent auto-generates a listing of files under `lib/`.

### Relative links

Gemtext link lines (`=> URL [description]`) inside a doc may use:

- absolute `urb://~ship/path` — fetched verbatim
- absolute path `/foo/bar` — resolves against the current URL's ship
- relative `foo/bar` — standard URI relative resolution against the
  current URL

Other schemes (`https://`, `gemini://`, `mailto:`) are not opened in v1
but are displayed as inert text with the URL visible (so the user can
copy them out).

## Urbit side: `%lattice` agent

### Responsibilities

1. **Watch Clay.** Subscribe to commits on its own desk. On each commit,
   diff against last known state of `lib/`, identify added / changed /
   removed `.gmi` files, and update bindings accordingly.

2. **Bind for remote scry.** For each present file, register a binding
   such that an Ames `%fine` request from a peer for the corresponding
   path returns the file's contents with the `%gmi` mark.

3. **Serve Eyre to the local app.** One endpoint for v1:

   | Endpoint | Purpose |
   |---|---|
   | `GET /apps/lattice/fetch?url=<urb-url>` | Resolves `<urb-url>` via remote scry (or short-circuits to local Clay read when the target ship is self). Returns body bytes + mark in JSON envelope. |

4. **Auto-generate index.** When asked for `urb://~self/`, if
   `lib/index.gmi` is absent, generate a minimal gemtext listing of
   `lib/` on the fly. (For peers fetching `urb://~author/`, the same
   logic applies on the author's ship at bind time.)

### Auth (Eyre side)

Standard Eyre channel + session cookie. The app authenticates with
`+code`, gets a session, and uses it on all subsequent requests. This
mirrors Talon exactly — code is lifted from there.

### Mark

Define `%gmi` mark in `desk/mar/gmi.hoon` for `text/gemini`. Used as
the mark of bound values so peers fetching see the right MIME type.

## App side: `lattice`

### Stack

- Compose Multiplatform (KMP)
- Targets: Android (8+, API 26), Linux, macOS, Windows desktop
- Source layout mirrors talon:
  - `composeApp/src/commonMain` — UI, gemtext renderer, navigation, repos
  - `composeApp/src/androidMain` — Android-only impls
  - `composeApp/src/desktopMain` — desktop-only impls

### v1 features

- **Auth.** Add ship: hostname, `+code`, mint session cookie. Single
  active ship per session for v1 (no multi-ship switcher yet).
- **Gemtext renderer.** Native Compose UI rendering of:
  - text lines
  - heading lines (`#`, `##`, `###`)
  - link lines (`=> URL [description]`) — clickable when `urb://`,
    selectable text otherwise
  - bullet list lines (`*`)
  - quote lines (`>`)
  - preformatted blocks (` ``` `)
- **Address bar.** User can type a `urb://~ship/path` and load it.
- **Back / forward.** Per-tab navigation history.
- **Bookmarks.** Local to the app, persisted (Room on Android, SQLite
  on desktop — match talon's storage layer where reasonable).
- **Home page.** Default page is `urb://~yourship/`.
- **Cross-ship links.** Clicking a `urb://` link in rendered content
  navigates the address bar.

### Out of v1

- Images and any non-text MIME types
- Write / edit from the app (authors use their own tools + `|commit`)
- History search
- Themes / customization beyond light/dark
- Comments, replies, reactions
- Discovery — no global index, no subscriptions, no notifications
- Permissioned content (everything is public for v1)
- Multi-ship session switching
- TOFU / certificate-style verification of unrelated ships
- Tabs (single-tab navigation in v1; tabs can be added later)

## Publishing flow (author POV)

1. Author has the `%lattice` desk installed on their ship.
2. They write `desk/lib/notes/2026/intro.gmi` in their editor.
3. They `|commit %lattice` (or whatever the desk is mounted as).
4. The agent picks up the new file on the next commit notification,
   binds it, and the file is now fetchable at
   `urb://~author/notes/2026/intro` from anywhere.

No web form, no upload, no separate publish step. Filesystem +
`|commit` *is* the publishing UX.

## Reading flow (reader POV)

1. Reader opens the `lattice` app, signs in to their ship with `+code`.
2. App loads `urb://~reader/` (own home page) by default.
3. Reader types `urb://~author/notes/2026/intro` in the address bar.
4. App calls `GET /apps/lattice/fetch?url=urb://~author/notes/2026/intro`
   on its own ship.
5. The reader's `%lattice` agent issues an Ames remote scry to `~author`
   for the corresponding scry path.
6. `~author` (or any peer caching the value) responds with the gemtext
   bytes.
7. Agent returns body to the app, which parses and renders.
8. Clicking a link in the rendered doc loads the next URL the same way.

## Repo layout

```
gemini-urbit/
  desk/                          # Urbit desk
    sys.kelvin
    desk.bill
    desk.docket-0
    app/lattice.hoon
    mar/gmi.hoon
    sur/lattice.hoon
    lib/                         # author's gemtext lives here; whether
                                 #   the actual .gmi files are committed
                                 #   to this repo is up to the author
  app/                           # KMP project
    composeApp/
      src/commonMain/...
      src/androidMain/...
      src/desktopMain/...
    build.gradle.kts
    settings.gradle.kts
    gradle/
  docs/
    superpowers/specs/           # this spec lives here
```

The repo is a polyglot monorepo: one git repository, two distinct
toolchain trees. Each side has its own build system; nothing in the
KMP build references the desk.

## Open questions / deferred decisions

These do not block the design but must be resolved during implementation:

1. **Exact scry path encoding.** Need to verify against current Urbit
   kernel: how does an agent register a `%bind` (or kernel equivalent)
   such that `%fine` requests from peers resolve to the bound value?
   What is the canonical path shape — `/x/lib/notes/2026/intro/gmi`,
   `/g/x/0/lattice/lib/...`, or something else? Verify on `~zod` first.
2. **Kernel + runtime version on `~zod`.** Confirm remote scry is
   actually available and stable on the dev ship's vere/kernel before
   building against it.
3. **Single agent vs split.** Start as one agent. If Eyre serving and
   Clay watching both grow significant state, consider splitting into
   `%lattice` (publish) + `%lattice-bridge` (Eyre/fetch).
4. **Mark choice for serving.** `%gmi` for typed delivery, or `%mime`
   with `text/gemini`? Probably both — `%gmi` internally, `%mime` at
   the Eyre boundary so the app gets a uniform envelope.
5. **`+code` lifting.** Decide whether to copy talon's auth modules
   into `app/composeApp/src/commonMain/...` directly or extract a
   shared module. Copy first; extract if a second client appears.

## Implementation phasing (suggested)

These will become separate plans under `docs/superpowers/plans/`.

1. **Phase 1 — Urbit side spike.** Stand up `%lattice` agent on `~zod`,
   verify Clay watch + bind + remote scry round-trip from another
   fakezod. Prove the Ames path works before building the app.
2. **Phase 2 — Eyre endpoints.** Add `/apps/lattice/fetch` and
   `/apps/lattice/local` to the agent. Verify with `curl` against
   `~zod`.
3. **Phase 3 — KMP app skeleton.** Fork talon's auth/channel code into
   `app/`. Strip chat-specific code. Get a window that signs in to a
   ship.
4. **Phase 4 — Renderer + navigation.** Implement gemtext parser,
   Compose renderer, address bar, back/forward, bookmarks. Test
   against the Phase 1 fakezod.
5. **Phase 5 — Polish + package.** Build artifacts (APK + AppImage +
   .deb + .dmg + .msi), README, install docs.
