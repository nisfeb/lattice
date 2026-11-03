# Shipless web reader: design

Status: proposed, for owner review. Plan: `docs/superpowers/plans/2026-11-03-shipless-web-reader.md`. Wiki mirrors: `specs/2026-11-03-shipless-web-reader-design` and `specs/2026-11-03-shipless-web-reader-plan`.

## Goal

Someone with only a browser, no install and no extension, clicks a link and reads a lattice page. This is the next reach after the desktop's shipless reader (nisfeb/lattice PR #369, slice 1, `docs/superpowers/specs/2026-11-03-desktop-urb-engine-design.md` on `feat-desktop-urb-engine`). The point is growing lattice's readership beyond people who run Urbit. Speed for ship users is not a goal (lattice memory `/feedback/lattice/comets-for-shipless-not-speed`), and nothing here changes the ship user's path.

The same hard rule as the desktop holds: only page bodies come through the engine. Every write or identity action (bookmark, comment, follow, subscribe, forum post, vote, share) needs a real ship. In shipless mode each is shown disabled with a one-line reason, never hidden and never performed by a comet.

## What exists today

- **The engine.** urb-fetch's Rust core at 89ca9ec (`core/urb`, `core/urb-render`, `core/urb-wasm`, `core/urb-gateway`). It builds native (desktop, the `urb-gateway` binary) and as wasm32-wasip1 (`mesa.wasm` 1,025,973 bytes, 373,159 gzipped; `render.wasm` 237,400 bytes, 91,712 gzipped), with JS shims in `shim/` (`mesa.mjs`, `render.js`, `wasi.js`). The extension runs the wasm build since gate 6 (nisfeb-extension 18edfa7).
- **Transport in a browser.** Browsers have no UDP. The extension's in-browser reader and "ship in a tab" both use one transport: `relayTransport` in `mesa.mjs`, a WebSocket to `urb-fetch -relay` (`relay.go`, Go, unchanged by the Rust port). The relay keeps one UDP port per ship and forwards frames `[kind][galaxy][ip][port][datagram]`. There is no WebRTC path and no hosted relay. The relay runs on the user's own machine (`ws://localhost:8476`), accepts only `chrome-extension://*` origins by default, and carries this note: "anyone who can reach the relay may claim any ship and send datagrams anywhere. That is fine on loopback. Before hosting it for others, it needs proof that a client holds the ship's key, and rate limits." Where a relay is hosted for real use was left as the owner's call (lattice memory `/project/nisfeb-extension/urb-fetch-reader`).
- **The gateway.** `urb-gateway` (Rust, M8, byte-identical to the Go gateway on 123 of 123 fleet requests) serves `urb://~ship/path` at `http://ship.urb.localhost:8475/path`, GET and HEAD only. It is loopback only by design: any Host but `urb.localhost`, `localhost`, `127.0.0.1` or `<ship>.urb.localhost` gets 421 (`core/urb-gateway/src/routes.rs` 94 to 101, `HOST_SUFFIX` in `core/urb-render/src/gateway.rs`). Peer HTML is served under lattice's `+sandbox-csp` (`sandbox allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation`, `urb_render::gateway::SANDBOX`), and pages it renders itself under `default-src 'none'; style-src 'unsafe-inline'`. Live, 2026-10-27, the Go gateway read its first page in 6.9 s on a fresh comet, then 0.07 to 0.13 s.
- **Lattice's own clearweb.** A publisher can already choose to serve a page on the open web from their own ship (the `/c/` clearweb route). The README draws the line: pages are Urbit-native, "the exception is what you *choose* to publish clearweb, which your ship serves itself." Any public web reader for urb-published pages crosses that line, so publisher consent is part of this design, not an afterthought.

## Spikes (2026-11-03)

All on this machine. No live lattice ship was contacted, no fleet ship was touched, nothing was deployed.

1. **CORS on the engine's HTTPS calls.** The engine fetches `https://bootstrap.urbit.org/comet-stars.jam` (to mine a comet) and posts to `https://roller.urbit.org/v1/azimuth` (key lookups). With an `Origin` header, the stars file answers 200 with no `Access-Control-Allow-Origin`, the roller's preflight answers 404, and its POST answers with no ACAO either. In headless Brave from a plain `http://127.0.0.1` page, both fetches failed (`Failed to fetch`). The extension never hit this because it holds host permissions. **A plain web page cannot mine a comet or look up keys without a same-origin proxy for both.**
2. **The Rust wasm engine in a plain web page.** A static page (`~/.cache/shipweb-spike/`, scratch, not committed) loaded `shim/mesa.mjs` and `mesa.wasm` from the rust-core tree, with an IndexedDB store copied from the extension's `idbStore`, `relayTransport` to `urb-fetch -relay -relay-fake -relay-origins 127.0.0.1:8650`, and a fetch that sends the two Urbit URLs to same-origin proxies. Results in headless Brave:
   - The page mined a real comet (`~batdux-sibnem-hobfyn-ripsyn--rollec-midmul-namlet-litzod`) and opened the engine in **2.3 s**, including the stars and roller calls through the proxy.
   - A second and third visit reopened the **same comet** from IndexedDB in **47 and 59 ms**.
   - The relay accepted the web origin, gave the comet UDP port 51000, and the engine's datagrams for a read of `urb://~zod/spike` came out of it toward the fake galaxy. With `-relay-fake` nothing left the machine, so no page was read.
   - `navigator.storage.persist()` answered `false` (headless, not installed), so the comet's store is evictable.
   So yes: **a static PWA can run the engine as a comet, given a WebSocket relay and two HTTPS proxies we host.** Cold cost for a new visitor is about 465 KB gzipped of wasm plus 2.3 s of setup, then the first contact with the publisher (4 s cold in the extension, 2026-10-28).
3. **The gateway on a public name.** Not run: the code answers it. `routes::handle` refuses every Host outside `*.urb.localhost` with 421, so a public gateway needs a configurable host suffix. Ship names fit DNS labels: the longest, a comet, is 56 characters, under the 63 limit, and a wildcard certificate for `*.<domain>` covers every ship.

## Options

### (a) A static PWA plus a relay we host

The engine runs in the visitor's tab as the visitor's own comet, kept in IndexedDB. We host the static files, a WebSocket relay and the two HTTPS proxies.

- **What a new user sees.** A link `https://<domain>/#urb://~ship/page` opens a page that says "Setting up a private reader in this browser" for 5 to 8 s the first time (465 KB download, 2.3 s mint, about 4 s first contact), then the page. Later visits open in about 0.1 s plus the read. An install prompt is optional.
- **Latency.** Worst on the first visit, which is when a new reader decides whether to stay. Warm reads 0.1 to 1.4 s (extension figures).
- **Hosting.** Static files anywhere (any CDN). The relay needs a VPS with a public IPv4 and inbound UDP. It holds one UDP port per comet for as long as it runs, so ports run out at about 64,000 comets and need eviction; an evicted comet that comes back stalls about 80 s while publishers resend to its old address.
- **Abuse.** The relay is an open UDP forwarder today: it sends datagrams to any ip:port a client names. Hosted, that is a reflection and spam tool. Before it can face the internet it needs proof of key (a comet's name is derived from its key, so a signed challenge suffices), per-client and per-IP rate limits, a destination rule (galaxies, and ip:ports that have sent to that ship's port, as a NAT allows), and port eviction. None of this exists. The roller proxy needs its own rate limit.
- **Privacy.** Each browser is its own comet, so publishers see a persistent pseudonym per reader and can link one reader's reads over time; they see the relay's IP, not the reader's. The relay operator sees reader IPs, which ships they reach, and timing; public scry paths travel in the clear, so it could see URLs too.
- **Comet records.** Every visitor leaves a permanent record on every publisher they read, and a visitor who clears storage, or whose storage is evicted (Safari drops script-written storage after 7 days without use unless the app is installed), mints another. At web scale that is thousands of comets per popular publisher. The desktop design took care to make one comet per install for exactly this reason.
- **Security of peer HTML.** One origin holds the comet's key in IndexedDB. Peer HTML must go into an `<iframe sandbox>` without `allow-same-origin` (an opaque origin) fed by `srcdoc` or a blob, and the app must run under a strict CSP (`script-src 'self' 'wasm-unsafe-eval'`). A slip in the sandbox attributes exposes the key. Content is rendered client-side, so crawlers and Safe Browsing see none of it.
- **Two tabs.** Two tabs would run two engines on one comet and one store, which libmesa does not survive (memory trap 2: an identity that changes address stalls). It needs a single engine per browser: Web Locks to elect one tab, BroadcastChannel to the others.

### (b) urb-gateway as a public read-only HTTPS gateway

The Rust `urb-gateway`, in a new public mode, runs on a server as one identity and serves `https://<ship>.<domain>/<path>` to anyone, behind a TLS proxy.

- **What a new user sees.** An ordinary web page, at once. No setup, no download, works on any phone and on networks that block UDP.
- **Latency.** A page the gateway has read in the last minute: about 1 ms in the engine plus the visitor's round trip. A page not yet read: 0.1 to 1.4 s. A publisher the gateway never contacted: about 1.2 s in-process (desktop measurements), 6.9 s on the Go gateway's first-ever page live. The gateway's identity is always warm, so no visitor pays a mint.
- **Hosting.** One small VPS with a public IPv4 and inbound UDP on one kept port, a TLS proxy with a wildcard certificate (DNS-01, so the DNS provider needs an API), and wildcard DNS. Bandwidth is small: pages are text, mostly under 16 KB. Pages are cacheable for 60 s, matching the engine's revision-list cache, so a CDN can sit in front later.
- **Abuse.** Ordinary web abuse, well understood: per-IP rate limits, a body cap (4 MB, as the desktop), the existing 512-connection cap and slow-client timeouts (M8 fix round), and a per-publisher rate so a crawler cannot make the gateway hammer one ship. The gateway never sends UDP anywhere a client names. A publisher who blocks the gateway's identity blocks every web reader at once, which is a clear consent lever.
- **Privacy.** Publishers see one identity for all web readers: reading is not identifiable to them. The operator sees each visitor's IP and URL, so the logging policy is the privacy policy (proposed below: no URLs in logs).
- **Comet records.** One identity, one record per publisher, ever.
- **Security of peer HTML.** Our domain serves third parties' content, so it is built like a user-content domain:
  - A dedicated apex domain used for nothing else, never a subdomain of nisfeb.com or of anything with logins.
  - One origin per ship (`<ship>.<domain>`), so ship A's page can never script ship B's. The gateway already maps hosts to ships this way; only the suffix changes.
  - Peer HTML only inside a sandboxed frame whose document is served with the `SANDBOX` CSP header, an opaque origin with no storage. Gemtext, Markdown and text rendered by the gateway, escaped, under `default-src 'none'`; the gateway's chrome needs no script at all.
  - No cookies, sessions or logins anywhere on the domain, so there is nothing to steal.
  - Non-HTML marks that a browser could run (`js`, `css`) served only as escaped text or `text/plain` with `nosniff`, never with an active type.
  - Headers on every answer: `Strict-Transport-Security` with `includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, and `frame-ancestors 'self'` (the chrome frames its own `?frame` answer; nothing else may frame either).
  - The domain submitted to the Public Suffix List, so each ship subdomain is its own site for cookies and storage partitioning. This is defence in depth, since no answer sets a cookie.
  - The residual risk is reputation: a phishing or malware page published on Urbit becomes reachable under our domain, and Safe Browsing can flag the whole domain. Mitigations: a ship and page blocklist the operator can edit without a restart, an abuse contact on every page, and an interstitial before any HTML page ("This page is from ~ship, not from <domain>").
- **Publisher consent.** A gateway turns urb-published pages into web pages, which lattice today leaves to the publisher's clearweb choice. Proposed defaults: `X-Robots-Tag: noindex, nofollow` on every answer and a `robots.txt` that disallows all, so pages are reachable by link but not by search; a ship-level opt-out honoured through the blocklist; and, later, a lattice-side flag so a publisher can opt out (or opt into indexing) from their own ship. The owner decides the default.

### (c) Both

The gateway first, the PWA later as an opt-in "read privately in this browser" mode for readers who prefer their own comet. It costs both sets of hosting and both sets of abuse work, and the PWA's relay is the hardest piece of either. Worth doing only if a later feature needs a per-reader identity in the browser, which the hard rule rules out for now.

### Side by side

| | (a) PWA plus relay | (b) public gateway |
|---|---|---|
| First page for a new visitor | 5 to 8 s, 465 KB of wasm | 0.1 to 1.4 s, nothing to download |
| Works on UDP-blocked networks | yes, through the relay | yes |
| Works on phones | yes; Safari evicts the comet weekly unless installed | yes |
| Server pieces | static files, relay, stars and roller proxies | one gateway behind TLS |
| Hardest abuse problem | an open UDP forwarder, not yet hardened | HTTP rate limits, standard |
| Identities on publishers | one per visitor, more after evictions | one |
| Reader identifiable to publishers | as a pseudonym, linkable over time | no |
| Operator sees | reader IPs, ships reached, timing | reader IPs and URLs |
| Peer HTML | sandboxed frame on the app's one origin, next to the comet's key | sandboxed frame on a per-ship origin with no key and no cookies |
| Crawlable | no | only if we allow it |
| New code | a web app, a hardened relay, proxies, tab election | a public mode for the gateway, chrome, limits, headers |

## Recommendation: (b), the public read-only gateway

It is the only option where clicking a link simply shows the page, which is what reach needs. It leaves one identity on each publisher instead of one per visitor, hides readers from publishers, keeps untrusted HTML away from any key, and its abuse surface is ordinary HTTP. The Rust gateway already exists and matches the Go gateway byte for byte, so the work is a public mode around it, not a new reader. The PWA is shelved, not refused: spike 2 shows it works, and its list of prerequisites (relay hardening, proxies, tab election, storage persistence) is kept above for if it is ever wanted.

### Shape

- **Names.** `https://<domain>/` is the home page: what this is, the start list, an address field (`urb://~ship/page` or `~ship/page`, redirected to the ship's host), and how to get lattice. `https://<ship>.<domain>/<path>` is a page. `https://<domain>/go?url=urb://...` redirects, as `/go` does on loopback, so lattice can build web links without knowing the host rule.
- **The process.** `urb-gateway` gains `-public <domain>`: the host suffix becomes `.<domain>`, the 421 rule still refuses every other Host, the listener stays on loopback behind the TLS proxy, and the client IP is taken from `X-Forwarded-For` only when the peer is loopback. Without `-public`, nothing changes: the loopback gateway's 123-request parity must still hold.
- **The page.** In public mode every page is the gateway's chrome around the body. The chrome is static HTML, no script: the ship and path, a home link, the action strip with each action disabled and its reason ("Connect a ship to bookmark", "Connect a ship to comment", "Connect a ship to follow"), "Open in lattice" (the `urb://` address, which lattice desktop and the extension handle), "Get lattice", and the abuse contact. Gemtext, Markdown and text are rendered inline as today. HTML pages get the interstitial line and a frame whose `src` is the same page with `?frame` (reserved like `?raw`, so no published path can collide), on the same ship host, answered with the `SANDBOX` CSP.
- **Errors.** `fail_of`'s words, as on loopback: not published, the ship did not answer (with a retry link), and private pages: "This page is private. Connect the ship it was shared with."
- **Reads only.** GET and HEAD, as today. The engine makes only the reads the lattice reader makes (revision-list peeks and keens; the peek is a `%grubbery-load` poke at the protocol level, M8's finding, and the only poke the gateway's identity ever sends). Forums and furum boards are out of the first cut: the gateway answers their addresses with a page that says reading boards on the web is coming, and offers "Open in lattice".
- **Limits.** Per client IP: 60 requests a minute, a burst of 20, answered 429 with `Retry-After`. Per publisher: at most 4 cold reads at once and 120 a minute, more wait or answer 503. Body cap 4 MB. All in the gateway, configurable by flag, so they do not depend on the proxy.
- **Caching.** `Cache-Control: public, max-age=60` on pages and `max-age=300` on the home page. No CDN at first.
- **Blocklist.** A file of ships and `~ship/path` prefixes, re-read when it changes, answered 451 with the abuse contact.
- **Logs.** Status, duration and ship only, never the path or the client IP; counters for reads, cache hits, 429s and failures.
- **Identity.** One persistent identity in the gateway's state folder, mined once, never per run. A comet works today (verified live on the Go gateway). A moon of an owner ship would say who runs it and would pass hosts that refuse comets, but the real-network moon path is untested (it waits on a `|moon` key). Owner's call; never `~ricsul-bilwyt`.

### Lattice's side

- **Web links.** The lattice reader and editor gain "Copy web link" beside the existing urb:// link (`feat-copy-urb-link`), giving `https://<domain>/go?url=urb://~ship/path`. This is the growth loop: ship users share links anyone can open. It ships only once the gateway is live, behind a constant for the domain.
- **Opt-out, later.** A publisher setting, "Readable on the web gateway", on by default or off by default as the owner decides, published in the pub index so the gateway can honour it. A lattice release, after the first cut.
- **Nothing else changes** on ships or for ship users.

## What the owner must decide or provide

1. **A domain.** A dedicated apex used for nothing else, with a DNS provider that has an API for DNS-01 (wildcard certificate). Then a Public Suffix List submission from the domain's owner.
2. **Hosting and who pays.** One VPS with public IPv4 and inbound UDP on one port (about $5 to $12 a month at this traffic), its operator, and whether a CDN may sit in front (it would see traffic too).
3. **Publisher consent.** Serve every urb-published page by default with noindex and an opt-out, or serve only publishers who opt in. And whether search indexing is ever allowed.
4. **Abuse.** An abuse contact address, a takedown policy, and who acts on reports, since the domain will serve third parties' content.
5. **The gateway's identity.** A comet, or a moon of which ship (not `~ricsul-bilwyt`).
6. **The start list's address**, shared with the desktop (`urb://~nisfeb/start` is the desktop's placeholder).
7. **The log policy** as proposed (no paths, no IPs), or another.
8. **The PWA and relay.** Confirm it is shelved. If it is wanted later, someone must host and pay for a hardened relay.

## Out of scope

Deploying anything public, the PWA and relay, forum and furum boards on the web, writing as the gateway's identity, search indexing, accounts of any kind, and any change to the ship user's path.

## Risks

- **Domain reputation.** One hostile page can get the domain flagged. Mitigated by per-ship origins, the interstitial, the blocklist and a dedicated apex; not eliminated.
- **One identity.** If publishers or hosts refuse it, every web reader loses that publisher. That is also the consent lever.
- **One process.** libmesa runs on one host thread; the cache absorbs repeat reads, and a CDN or a second gateway (a second identity) is the scaling path.
- **Real network.** The gateway's live run is from 2026-10-27 (Go); the Rust gateway has only run on the fake fleet and offline. The first public test reads only the owner's own published pages.
- **Consent.** Publishers who chose not to go clearweb may object. The noindex default, the opt-out and the lattice-side flag are the answer; the owner sets the default before launch.
