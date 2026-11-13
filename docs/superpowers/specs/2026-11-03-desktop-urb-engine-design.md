# Lattice desktop on the urb-fetch engine: design

Status: approved for build (owner, 2026-11-03: "lattice desktop doesn't use it? what's the point of all this if we don't use it? let's work."). Plan: `docs/superpowers/plans/2026-11-03-desktop-urb-engine.md`. Wiki mirrors: `specs/2026-11-03-desktop-urb-engine-design` and `specs/2026-11-03-desktop-urb-engine-plan`.

## Goal

The core value is reach. Someone who downloads lattice desktop and has never run Urbit can install it, skip "connect a ship", and read lattice content through a comet the app makes for them. That extends lattice beyond existing Urbit users. Ship users reading other ships' published pages faster was a second benefit; that work (slice 2) is deferred, see below.

The engine is urb-fetch's Rust core at 89ca9ec (`urb` with the `native` feature, `urb-render`, and the state helpers in `urb-gateway`), linked into the desktop binary and run on a thread of its own, as `docs/rust-core.md` "Later consumers" says. No sidecar process, no wasm.

## Hard rule: the engine reads page content, and its one write is an anonymous comment

The native engine fetches page bodies. Its one write is a comment on a published page, sent as the comet itself, not as anyone's ship (changed 2026-11-03, below). Every other action that writes, or that belongs to the user's identity, goes over the user's ship exactly as it does today. No action is ever performed by the comet on behalf of the user's ship, and no ship-side state is faked locally.

### Change, 2026-11-03: using the app anonymously, comments included

Owner, 2026-11-03: "users should have the option at the login page to use the app anonymously. it should say they can browse and comment but not host without a node. when they select this option they should enter the app and go to the start page". This replaces the earlier rule that comments are disabled in shipless mode.

- **The login page.** The manager's connect section is headed "connect your node", and right after its form comes the one other choice, "or use lattice anonymously": "No node? You can use lattice anonymously. You can browse pages and comment on them, but you can't host pages without a node." Its one button, "use anonymously", calls `open_reader` with no address, which enters the app on the reader's start page (`/`, the start list and recent reads). The old first-run card (an address field, Open and "start here", placed above the connect form) is gone, so there is one path, not two. With a node configured the option stays, after the ship section. Connecting a node later works as before, from the manager or the reader's "Connect a node".
- **How a comment travels.** On a ship, `POST /apps/lattice/comment-remote` pokes the peer through gall: `%grubbery-load` to `[peer %grubbery]` with `[[/comment-notice %& <base> %'comments.sig'] [%poke [/lattice %comment-action] [page body]]]`, where `<base>` is where lattice runs on the peer (the desk install `/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app`, or the older `/apps/lattice.lattice_app`). The peer's `/comments.sig` fiber takes the author from the transport (`+get-poke-src`), and `+apply-comment-notice` and `+apply-comment` store it under `/comments/<page>/<id>`. The urb engine already sends exactly that poke (`Request::Poke`, the core's `grub_poke_with`), so nothing was added upstream in urb-fetch and the pin stays at 89ca9ec. The desktop's `Engine::comment` submits `Request::Poke { folder: <base>, name: "comments.sig", mark: ("/lattice", "comment-action"), value: [page body] }`, the desk base first and the older one only if the first is refused. `page` is the key the read gave (the path the publisher keeps the page at, `index` resolved), never the form's word for it.
- **Does a publisher accept a comet?** Yes, by lattice's own rules, with two limits; lattice's server-side policy is unchanged by this work. Grubbery's `/public` usergroup weir applies to every foreign ship, comets included, and lattice grants it the `comments.sig` poke road (`+send-public-how`). `+apply-comment-notice` then refuses silently if the sender is banned, the page has comments off (the default: a page or folder takes comments only when its owner turns them on), the page does not exist, or the page holds 200 comments. The limits: lattice's `+family` counts every comet as one author, so all comets together get `per-author` (20) comments per page, and an owner can ban every comet at once. Silent refusals cannot be told from success on the wire (the grub's `%pack` comes when the inbox takes the poke in), so the reader says "Sent to ~ship. ~ship decides whether it appears: it won't if they haven't turned on comments for this page." A poke the publisher's ship refuses (its weir, or no lattice there) is said plainly with its words, and so is no answer ("~ship didn't answer, so your comment may not have been sent"); the text is kept in the box either way.
- **The reader.** A published page (`Mount::N`; not a `/k/` know entry or a `/t/` tree file) gets a comment box under the page (outside any sandboxed frame): "Send to ~ship", and "Sent anonymously from this computer as `~comet`, the name ~ship sees as the author." `POST /comment?url=` needs the token cookie and the reader's own Origin, so a publisher's sandboxed frame (Origin `null`), a web page or another local process cannot make the comet comment. The body is capped at lattice's `max-body` (4096 bytes) on a character boundary, and the request at 13 KB. The outcome is shown once on the page the POST returns to (a 303), and logged without the text.
- **Authors.** Lattice shows a comment's author as its `@p` (`comments-inbox`, `+render-comments`), so a comet's comments show its full name there; nothing changes on the ship.
- **Still off.** Bookmarks ("Connect a node to bookmark"), follows ("Connect a node to follow") and hosting ("Hosting pages needs a node") are shown disabled with their reasons.

What the reader offers today, found in `code/nex/lattice/app.hoon` (the `/apps/lattice?url=` reader, `+render-page-titled`, `+render-browser-page`, `+remote-comment-box`, `+bm-script`) and `ui-src/lattice`:

| Action or state | Route it calls today | Slice 2 (ship user, native body) | Slice 1 (shipless) |
|---|---|---|---|
| Bookmark star, and whether the page is starred | `POST /apps/lattice/bookmark?url=&title=`, `GET /apps/lattice/bookmarks` (`+bm-script`) | Unchanged: the ship renders the reader page, star and script included | Shown disabled: "Connect a node to bookmark" |
| Bookmark list, refile, remove | `GET /apps/lattice/marks`, `POST /unbookmark`, `POST /bookmark-move` | Unchanged (ship page) | Not shown (needs a ship) |
| Comment on a peer's page | form `POST /apps/lattice/comment-remote?ship=&page=` (target `_top`), the ship pokes the peer's `comments.sig` | Unchanged: the ship renders `+remote-comment-box` into the page | Offered, as the comet: the reader's `POST /comment` pokes the publisher's `comments.sig` through the engine (2026-11-03 change, above) |
| Reading history (the visit) | written by the reader route itself (`poke-history [%visit url title]`) after it answers; `POST /history-forget`, `/history-clear` | The new route writes the visit exactly as the GET does | Kept locally in the app's data dir (below), never sent anywhere |
| Subscribe to one page (the per-file keep) | `POST /apps/lattice/sub`, `/unsub` with `url=urb://...` | Unchanged, over the ship. No button for it exists in the reader HTML or `ui-src` today; only the route. | Not offered |
| Follow a ship | `POST /apps/lattice/follow`, `/unfollow` | Unchanged | Shown disabled: "Connect a node to follow" |
| Lattice forum: read, post, comment, vote, refusal notes | `urb://~host/forum/...` redirects to `/apps/lattice/forum-remote/...`; `POST /forum-post-remote`; notes on `/forum.sig` | Not intercepted at all: forum addresses stay on the ship | Reading comes in slice 3; writing shown disabled: "Connect a ship to post" |
| Private page a peer shared with you | `+read-shared-page`, needs your ship on the peer's ACL | Always the ship; the native read is skipped or falls through | Not readable: "This page is private. Connect the ship it was shared with." |
| Shared with me list, comments inbox | `69-shared.js`, `73-comments.js` (workspace tools, ship routes) | Untouched: not reader pages | Not shown |
| Edit button, send to orrery, live refresh (SSE keep) | own pages only (`eb`, `+orrery-slot`, `+sse-script`) | Own pages are never read natively | N/A |
| Editing a peer's page shared for edit | `POST /apps/lattice/remote-save` (editor, `40-grub.js`) | Untouched | Not offered |
| Clip and archive | `/clip`, `/clip-html`, `/clip-paste` (http and https pages only) | Untouched: not urb:// | Not offered |
| Sharing, links, publishing | `page-share`, `share-file`, `link-make`, `save` (own pages) | Untouched | Not offered; "Host" shown disabled: "Hosting pages needs a node" |
| Likes and reactions | none on published pages; forum votes only (row above) | N/A | N/A |
| Notifications and badges a read triggers | none from a read, beyond the history visit; comment notices are the peer's | N/A | N/A |

So a natively fetched page still shows the user's ship-side state and offers every action, because in slice 2 the ship still renders the page: the engine only supplies the body. In shipless mode each action but commenting is visible and disabled with a one-line reason, never hidden and never faked with the comet.

What a comet could do as itself, and whether to offer it: reading pages (yes, slice 1), commenting on a published page (yes, since the 2026-11-03 change), reading lattice forums and furum boards (yes, slice 3), posting to a furum or lattice forum as the comet (not yet: hosts commonly refuse comets, and it would publish under an identity the user loses when they attach a ship; revisit on owner request), and keeping a page live through the comet's own keep (no: the core has no live following yet, a non-goal of the port). Nothing else.

## Measurements (2026-11-03)

Fleet sets lattice-gate (~dep, "your ship") and lattice-gate-peer (~wep, the publisher), both reset to their `lattice` snapshots (lattice 109), claimed as `desktop-urbengine` and released after. ~wep published 14 gemtext pages of about 3.9 KB (`bench-1` to `bench-14`) through `POST /apps/lattice/save`. Each ship was left about 110 s after reset before timing, per urb-fetch's settle finding. All on loopback, so these are protocol and processing costs, not real network latency.

| Path | First contact (cold) | Cold page (peer known, page never read) | Warm (same page again) |
|---|---|---|---|
| (a) your ship, `GET /apps/lattice/fetch?url=urb://~wep/bench-N` on ~dep | 5.58, 5.76, 5.78 s: median 5.76 s (3 runs, both ships reset each time) | median 0.78 s (10 pages; later runs 0.93 s) | median 0.72 s (10 repeats, 0.69 to 0.85 s) |
| (b) native engine in-process, one host, `Request::Read` | median 1.22 s (10 new identities, 1.17 to 1.66 s) | median 12.6 ms (10 pages) | median 0.8 ms (10 repeats); 124 to 131 ms once the 60 s revision-list cache has expired |
| (c) native as a moon | the identities in (b) are fake moons of ~dep; on the fake network a comet cannot exist, so (b) is the moon case | | |

The ship re-reads the peer on every request (`+read-page-body` is deliberately not scry-first), which is why its warm number stays at 0.7 s. The engine keeps the revision list for 60 s and libmesa keeps fetched pages, so a repeat costs under a millisecond, and a refresh of the list about 130 ms.

The comet's first boot, on the live network (roller and bootstrap HTTPS only, no lattice ship contacted): minting and opening took 424, 356 and 410 ms (0.86 to 0.93 s for the whole process). The first page a fresh comet reads from a live ship was not re-measured, so as not to leave comets on live ships; the earlier live figures are 4 s cold in the extension (2026-10-28) and 6.9 s in the Go gateway (2026-10-27), then 0.07 to 0.13 s warm.

Verdict: native is clearly faster, well past the 30% or 200 ms bar. Warm it is 0.8 ms to 130 ms against 0.72 s, and first contact is 1.2 s against 5.8 s. The speed case for routing ship users' published reads natively (slice 2) is strong. It does not gate the work: shipless reading (slice 1) is the point either way.

## Feasibility spike (2026-11-03)

The desktop crate at origin/main (1.0.15), with `urb`, `urb-render` and `urb-gateway` as git dependencies pinned to 89ca9ec, builds a release binary on this machine (clang 23.1, rustc 1.98.1) and the spike reads and renders a page. What it took:

- The desktop already has `mod urb` (the 1.0.15 link handler), which shadows the `urb` crate. The dependency is renamed: `urb-engine = { package = "urb", ... }`.
- `cargo update -p cc` (mesa-sys asks for cc 1.10; the lock had an older one).
- `cargo update -p prettyplease --precise 0.2.37`. bindgen 0.73.2 accepts syn 2 or 3 and prettyplease 0.2 or 0.3, and the desktop's lock resolved bindgen to syn 2 and prettyplease 0.3 (syn 3), which does not compile. prettyplease 0.2 keeps both on syn 2.
- `MESA_SYS_DEPS` set to a folder holding urcrypt and the SQLite amalgamation, fetched by `core/mesa-sys/fetch-deps.sh` with its SHA-256 checks. mesa-sys never downloads anything itself.
- Nothing else: libmesa's SQLite is the only SQLite in the desktop's tree (no `libsqlite3-sys`), so "SQLite twice" does not arise. If the desktop ever gains a SQLite, mesa-sys must link against that copy instead.

Size, linux x86_64 release: unstripped 25.16 MB to 27.88 MB; stripped 17.10 MB to 19.45 MB (+2.35 MB, +13.8%); gzip -9 of the stripped binary 6.31 MB to 7.44 MB (+1.13 MB). The deb, AppImage and dmg are compressed, so the installer grows by about 1.1 MB per platform. A clean release build of the desktop took 7 minutes; adding the engine added about 4.5 minutes of C and bindgen on 16 cores.

## Architecture

### The engine (`desktop/src/engine.rs`)

One engine per app. With a ship configured it starts lazily the first time something asks for a read (the shipless reader, or a slice 2 interception), never at launch, so a ship user who never reads natively pays nothing. With no ship configured it starts at launch (`Engine::prewarm`) and reads the start list and the first page it links to, so the comet is mined and the first contact made while the first-run page is up. A comet made that way carries an `unclaimed` file until the reader is used (`claim`, when the reader starts). An unclaimed comet is kept across launches and reused, so launches that never read mint no new comet and leave no new record on the start ship; it does not count as the reader having been used (the manager's close still refuses). Connecting a ship, or launching with one configured, deletes it with its store, and a start still in progress deletes it itself before reaching the network.

- State lives in `<app_data_dir>/urb/` (Linux `~/.local/share/org.lattice.desktop/urb/`, macOS `~/Library/Application Support/org.lattice.desktop/urb/`), mode 0700: `comet.key` (0600), `<comet>.db` (libmesa's SQLite store, with `-wal`, `-shm` and `.lock`), and `<comet>.db.port` (the UDP port the identity keeps; a new port stalls publishers for about 80 s). It is opened with `urb_gateway::state::find(dir, "", false, "")`, which mines a comet the first time (fetching the comet-stars list over HTTPS, as the Go binding does) and reuses it after. One persistent comet per install: every new comet leaves a permanent record on each ship it reads.
- The host runs on its own thread, as `urb-gateway`'s main does: `GatewayUdp` with the kept port, `NetIo`, `Host::new(io, random)`, `host.open(false)`, then a loop that takes jobs from a channel, submits `Request::Read(url)`, hands each result back on the job's channel, and calls `host.turn()`. A caller wakes it with `Event::Wake` through `NetIo::waker()`.
- API: `Engine::comment(ship, page, body, budget) -> Result<(), CommentError>` (`Refused`, `Unanswered`, `Failed`), the engine's one write (2026-11-03 change, above), and `Engine::read(url, budget) -> Result<NativePage, ReadError>` where `NativePage { key, body, mark, how }` and `ReadError` is `NotPublished`, `Unreachable { later }`, `Busy` (the store is locked by another lattice instance), `Booting` (when the caller will not wait for the boot), or `Failed(message)`; `Engine::status() -> Off | Booting | Ready { our } | Failed(message)`.
- Failures map from `urb::Failure` through `urb_gateway::routes::fail_of` (status and words), so the desktop says what the gateway says.
- Bodies over 4 MB are refused as `Failed`, so a hostile publisher cannot balloon the app.
- Two lattice instances on one data dir: the second gets `Busy` (libmesa's `.lock`) and says "The reader is in use by another lattice window."
- A failed start is not tried again for 5 s (`RETRY_AFTER`), so the setup page's reload shows the failure in plain words instead of starting again forever. A damaged keyfile or store is moved into `damaged-<ms>/` and a new comet is made; a damaged `.port` file costs only the port. A store held by another instance is never treated as damage. (Review, 2026-11-03.)

### Shipless reading (`desktop/src/reader.rs`, slice 1)

A desktop-owned reader, served from a second loopback listener, the reader origin, at `127.0.0.1:26520` (or the next free port up to 26535, stable for the same storage reason as the bridge). It is a separate origin from the bridge (26500 to 26515), so it shares no storage or service worker with any ship UI. Cookies are scoped by host and not by port, so the two origins do see each other's cookies: the reader's token cookie has its own name (`lattice-reader`) and value, the reader ignores the bridge's, and the bridge never relays a cookie.

- Routes, GET and HEAD only (plus `POST /history/clear`, which empties the local history, and `POST /comment?url=`, which sends a comment as the comet; both need the reader's own Origin): `/` (home), `/read?url=urb://...` (a page), `/raw?url=...&key=...` (a publisher's HTML for the sandboxed frame, from the read just made, never a second network read), `/assets/reader.css` and `/assets/reader.js` (compiled in), and `/boot?k=&to=` (hands the window this launch's token as an HttpOnly cookie, as the bridge's bootstrap does). The stylesheet is inline in each page instead of `/assets/reader.css`, since the policy's `style-src 'unsafe-inline'` would block a linked one.
- The same request filter as the bridge: Host must be `127.0.0.1:<port>` or `localhost:<port>`, Origin absent or the reader's own, Sec-Fetch-Site not `cross-site`, the token cookie required for `/read`, and the size caps. The token cookie is `SameSite=Lax` and a request that is not same-origin is let through only as a plain top-level GET navigation (Sec-Fetch-Mode `navigate`, Dest `document`), so a link clicked in a publisher's sandboxed frame opens in the reader while fetches and subresources from anywhere else are refused. A sandboxed frame's `/raw` request is allowed by a same-origin Referer, as in the bridge. Any other caller gets 403 before the engine is touched, so another local process or a web page cannot drive the comet.
- Rendering uses `urb-render`'s gateway renderers with the gateway's CSPs: gemtext, Markdown and text are rendered by the desktop, escaped, under `default-src 'none'; style-src 'unsafe-inline'` plus `script-src 'self'` for `reader.js` only; a publisher's HTML goes in an iframe with `sandbox="allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation"` whose `src` is `/raw`, served with `urb_render::gateway::SANDBOX` as its CSP header (an opaque origin, so it reaches neither the reader's storage nor the app). Only `render_as` decides which, by the published mark, with `%gmi` sniffed for HTML, exactly as the gateway.
- Links: urb-render's `page_link` resolves and filters links (the hostile-input rules: schemes, length, controls, `//`), then the desktop maps every urb:// target to `/read?url=<encoded>`, so links stay in the app. http and https links leave for the system browser through the existing `nav_decision`. As built, this needs nothing upstream: gemtext and Markdown go through urb-render's public `render_gemtext` and `render_markdown` with a link function that wraps `page_link` (a dummy port) and maps each gateway URL back through `urb_of_host`; a publisher's HTML goes through `rewrite_html` with a random port no publisher can guess, and only the links it rewrote are then pointed at `/read`. The frame's HTML also gets `<base target="_top">` (after a leading doctype), so a clicked urb:// link opens in the reader and not inside the frame. An upstream `render_with` and `rewrite_html_with` (byte-identical to `render`, proved on every vector) is committed on urb-fetch branch `render-with` but not pushed; the desktop can move to it later.
- Chrome, owned by the desktop and the same on every page: an address field (a form GET to `/read`, which also takes a bare `~ship/path`), back and forward (`history.back()`), a home link, the disabled action strip ("Bookmark", "Follow", "Host", with "Connect a node to bookmark", "Connect a node to follow" and "Hosting pages needs a node"), the comment box on a published page, and a "Connect a node" link to the manager. The page title is the page's first `#` heading or its address, as lattice's reader titles it.
- Errors in plain words, from `fail_of`: not published, the ship did not answer (with a retry button; `later` failures retry up to 5 times, as the extension does), private ("This page is private. Connect the ship it was shared with."), and the engine's own state (booting, busy, failed).

### The workspace window and its capabilities

The app stays single-window. In shipless mode the workspace window moves between the manager (the app's local origin) and the reader origin.

- `nav_decision` allows the reader origin, and rewrites an urb:// top-level navigation to `/read?url=` when no bridge is up (today it is blocked with no bridge).
- `capabilities/workspace-remote.json` today grants its commands to `http://127.0.0.1:*`, which would include the reader origin. It is narrowed to the sixteen bridge ports (`http://127.0.0.1:26500` to `:26515`), so a reader page gets no commands at all. The reader needs none: its links to the manager are plain navigations to the local origin, which `nav_decision` allows.
- A test proves that an `invoke` from a reader page, and from a sandboxed frame inside one, is refused.

### Onboarding (the manager's first run)

As changed on 2026-11-03 (above): the manager opens on "connect your node", the connect form, and right after it "or use lattice anonymously" with its one button, which enters the app on the reader's start page. (As first built, a separate "read without a ship" card with an address field came first; it was replaced so there is one path.)

The engine is already starting when the option shows. Measured live from a fresh HOME, mining takes 1 to 3 s and the first contact with a publisher 6 to 12 s, which the warm-up's start-list read and the first page share. While the engine starts, the card and the reader say "Getting ready to read" with how long the first time takes (about 10 seconds) and the step it is on ("Setting up this computer", "Joining the Urbit network"). After that, opens cost the read alone.

Network use, said in the card's detail: HTTPS to roller.urbit.org and bootstrap.urbit.org (the comet-stars list and key lookups), and UDP to Urbit galaxies and the ships read. A network that blocks UDP cannot read; the reader says so after its retries ("Couldn't reach the Urbit network. Some networks block it."). A hosted relay is out of scope.

How a new user finds content:

- Pasting an address into the reader's address field.
- The 1.0.15 urb:// handler: a link clicked in a browser, Talon or a terminal starts or focuses lattice. With no ship configured it opens in the shipless reader at once, instead of waiting in the inbox for a ship that may never come. With a ship configured, behaviour is unchanged (a workspace tab on the ship's reader; slice 2 accelerates it).
- "Start here": a starting list read through the engine from a published page the owner keeps (gemtext links, for example `urb://~nisfeb/start`; the address is the owner's call, and is a constant in `reader.rs`), with a copy of it compiled into the app for the first run and for when it cannot be read. No such list exists today, so the plan's task writes the first one as a page for the owner to publish.
- Local history: the reader's home lists recent pages.

### What shipless mode keeps on this computer

Everything is in `<app_data_dir>/urb/`, and nothing leaves it:

- `comet.key`, the comet's private key; the engine's `<comet>.db` (flows, keys, cached pages) and `.port`.
- `history.json`: up to 500 recent reads, `{url, title, at}`, written on each successful read, shown on the reader home, clearable there ("Clear history") and from the manager.

No bookmarks, follows or comments are kept locally. A comment goes to the publisher and no copy stays here.

### Upgrade path: attaching a ship later

- Connecting a ship works as today, from the manager. Using the app anonymously stays available on the manager.
- The comet and its engine state carry over and become the engine slice 2 uses for native reads, so no second comet is ever made.
- Local history stays local, still listed on the reader home. Importing it into the ship's history is not offered in this work: the ship has no route that takes visits, and adding one is a ship change for later if asked.
- Nothing else exists to carry: a shipless user has no bookmarks or follows, and their comments stay on the publishers' ships under the comet's name.
- A moon of the user's ship as the engine's identity (instead of the comet) is staged for later. It would not open private pages either, since ACLs name the ship, so it buys little today.

### Slice 2 (deferred): ship users' published reads, natively, with the ship as the shell

Deferred (owner, 2026-11-03): "start to focus on getting users without ships able to use comets. I don't see evidence that comets are a compelling way to speed up normal operation." Nothing of slice 2 is built: no `reader-body` route, no interception in the bridge, and the ship-user path is exactly as it was. The design below is kept for if it is ever picked up again.

Two shapes were compared:

1. **The ship's reader page stays the shell; the desktop swaps in a natively fetched body.** The bridge reads the peer's page natively and hands the body to a new ship route, which renders the reader page exactly as if the ship had read it: the same Hoon renderer, bar, star, comment box, title and history visit.
2. **A desktop-owned reader for ship users that calls ship routes for the actions.** The desktop renders the body and rebuilds the chrome, the star (with its localStorage cache), the comment box, history writes and the rest, against ship routes, some of which do not exist (no route records a visit).

Shape 1 is chosen. Every action and every piece of ship-side state stays exactly where it is, there is one reader to maintain rather than two drifting copies, the page looks the same either way, and the hard rule holds by construction. Its cost is a ship release (a new route), and that a reader page still needs the ship to answer. When the ship does not answer, the desktop falls back to the shipless reader page with actions disabled and "Your ship isn't answering" as the reason, so reading still works while the ship is down.

The flow, in the bridge (`proxy.rs`):

1. A `GET /apps/lattice?url=<u>` from the workspace, with the session, where `<u>` passes `urb::parse`, names a ship other than the connected one, is a page address (not a folder ending in `/`, not `/forum/...`, not a tree address `/k/`, `/t/`, `/p/` or another single-letter mount), and the request has no `via=ship` and no `x-lattice-bg` header.
2. If the engine is `Ready`, read natively with a 3 s budget. If it is `Off` or `Booting`, start it if needed and relay to the ship this time (never make a reader wait on a comet boot).
3. Native success: `POST /apps/lattice/reader-body?url=<u>` to the ship with the session and the JSON `{"mark": ..., "body": ...}`; relay its answer. A 404 or 405 (a ship older than the route) marks the session as "no route" and the original GET is relayed, now and for the rest of the session.
4. Native `NotPublished` (it may be a private page shared with this ship): relay the original GET, so the ship's `+read-shared-page` answers it, and remember the address for 5 minutes to go straight to the ship next time.
5. Native `Unreachable`, `Busy` or `Failed`: relay the original GET (the ship may reach a peer the comet cannot).
6. The ship unreachable at step 3 or 5 (connection refused, or no answer in 10 s): serve the shipless reader's page for the native body, with "Your ship isn't answering" in the action strip.

`via=ship` lets a "read through my ship" link force the old path; the ship ignores the unknown argument.

The ship route, in `app.hoon`:

- `POST /apps/lattice/reader-body?url=urb://~peer/page`, owner session only: refused for a key (`?=(^ key)`), for our own ship, for a folder or empty path, for a body over the reader's cap, and for a mark that is not a lattice view-mode (it is floored to `%gmi`, as a legacy peer's is).
- The `%pub` branch of the `/apps/lattice?url=` handler is refactored so that everything after it has `got=[rel mode body]` (title, comment box, the `%gmi`, `%html` and other branches, the response, and the history visit) is one arm, `+reader-pub-view`, called by the GET with what it read and by the new route with what it was handed. The supplied body is treated exactly as a peer's body is today (peer markup always sandboxed, Markdown and text escaped).
- Trust: the body comes from the owner's own desktop over the owner's session, so it can do nothing a peer's page could not. The worst a compromised desktop could do is record a visit with a wrong title in the owner's own history.

Reads of the owner's own pages, forum addresses, tree addresses and shared private pages are never intercepted.

### Slice 3, staged: forums and furum boards for shipless readers

The engine reads lattice forums (trace 8) and furum boards, but `urb-render` has no board renderer. Slice 3 adds a desktop board and thread view on the forum and furum readers, read only, with posting disabled ("Connect a ship to post"). It is planned after slices 1 and 2 ship.

## Packaging

- Dependencies in `desktop/Cargo.toml`, pinned to one urb-fetch commit (89ca9ec now, then the commit with `render_with`): `urb-engine = { package = "urb", git = "https://github.com/nisfeb/urb-fetch.git", rev = ..., features = ["native"] }`, `urb-render`, `urb-gateway`. Behind a default cargo feature `urb-engine`, so any target that cannot build libmesa can ship without shipless reading while that is fixed (the manager then hides the card).
- `desktop/scripts/mesa-deps.sh` finds the pinned mesa-sys checkout with `cargo metadata` and runs its `fetch-deps.sh` into `desktop/target/mesa-deps` (falling back to `shasum -a 256` where `sha256sum` is missing); `desktop/.cargo/config.toml` sets `MESA_SYS_DEPS` to that folder (relative). Every build path runs the script first: CI, release, nix and `cargo tauri dev`.
- `deny.toml`: `allow-git = ["https://github.com/nisfeb/urb-fetch"]` (unknown git is denied today). The libmesa submodule comes with Cargo's git checkout.
- Linux release (ubuntu-22.04, kept for its old glibc): its clang 14 cannot build `-std=gnu23`. Install clang 18 from apt.llvm.org and set `CC_x86_64_unknown_linux_gnu=clang-18` and `LIBCLANG_PATH`. CI's test jobs on ubuntu-24.04 already have clang 18, which urb-fetch's own CI uses.
- macOS (macos-14, aarch64 native and x86_64 cross from arm64): Xcode 15's Apple clang predates `-std=gnu23`, and libmesa has never been built for macOS by mesa-sys. Use Homebrew LLVM (`brew install llvm@20`), with `CC_aarch64_apple_darwin` and `CC_x86_64_apple_darwin` pointing at its clang and `SDKROOT=$(xcrun --show-sdk-path)`. mesa-sys already sets `-DU3_OS_osx=1` and builds blake3's NEON file on aarch64 and its x86-64 assembly on x86_64. This is the largest risk, so the plan's first task is a CI job that builds mesa-sys for all three targets before anything else lands.
- nix (`flake.nix`, linux only): add `clang` and `rustPlatform.bindgenHook` to `nativeBuildInputs`, `cargoLock.outputHashes` for the urb-fetch git sources, and the two archives as `fetchurl` inputs with the same SHA-256s, joined into a folder that `MESA_SYS_DEPS` names. Whether nixpkgs' `importCargoLock` brings the libmesa submodule for a git dependency is checked in the plan; if not, `allowBuiltinFetchGit = true` does.
- Installer size grows by about 1.1 MB per platform (above).

## Testing

- Unit tests in `desktop` (no network): the link mapping (every urb-render link vector, plus urb:// to `/read`), the reader's request filter (Host, Origin, Sec-Fetch-Site, token, Referer for `/raw`), the CSP per mark, the history file (cap, order, clear), the bridge's interception predicate (own ship, folder, forum, tree, `via=ship`, `x-lattice-bg`), the fallback table with a fake engine and a fake ship (each row above), the `nav_decision` rows for the reader origin, and the narrowed capability file.
- `scripts/desktop-commands.mjs` passes with the new commands registered in all three places (`main.rs`, `build.rs`, the capability files).
- A real read on the fleet, natively: an `#[ignore]` test in `engine.rs` driven by `scripts/desktop-engine-fleet.sh`, which claims the lattice-gate-peer set (`FLEET_WHO`), resets it to `lattice`, publishes a page with `POST /apps/lattice/save`, and runs the test, which reads it through `Engine` as a fake moon of the publisher (the fake network has no comets), and checks the body and the rendered HTML; the script releases the claim. The test runs with `LATTICE_FLEET=1 cargo test -- --ignored`; without the fleet (CI) it skips with a message. Never ~ricsul-bilwyt or ~hus without a claim; never a live ship in a routine run.
- Slice 2 on two fleet ships (lattice-gate and lattice-gate-peer, both claimed): the reader page for a peer page comes back from `reader-body` with the star, the comment box and a history entry, and is byte-identical to the plain GET's page (diffed); a shared private page falls through to the ship; a frozen ship (SIGSTOP on its serf) gives the fallback page.
- `desktop-shipless.sh` (the real binary with `LATTICE_PROBE_JS`, under Xvfb, fresh HOME): choose "use anonymously", land on the start page, open a fleet-published page, check the disabled strip and its reasons, post a comment, and check on the publisher's `comments-inbox` that it arrived on that page with the engine's identity as its author.
- ui-manager (browser test of `manager.html` with a stubbed Tauri) covers the anonymous option: beside the connect form, its copy, no competing card, and that it opens the start page.

## Out of scope

Writing as the comet beyond page comments, live following, a hosted relay, Windows, importing local history into a ship, a moon as the engine identity, and the Go gateway. The forum and furum reader is slice 3.

## Risks

- **macOS build of libmesa.** Unproven. Mitigated by the CI spike first and the `urb-engine` feature.
- **Old CI clangs.** ubuntu-22.04 and Xcode 15 both lack `-std=gnu23`; both get a newer clang (above).
- **Lockfile pins.** The prettyplease pin must stay until bindgen and prettyplease agree on syn; cargo-deny's duplicate check may warn.
- **UDP-blocked networks.** Shipless reading needs UDP. No relay is hosted.
- **Comet records on publishers.** One persistent comet per install, never a new one per run; tests use fake moons on the fleet.
- **Engine and ship drift.** The engine reads what lattice 81 and later publish (the spike read lattice 109 pages). A future lattice change to the publishing layout must reach urb-fetch first, then the desktop's pin.
