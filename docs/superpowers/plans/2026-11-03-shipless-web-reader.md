# Shipless web reader: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone with a browser opens `https://<ship>.<domain>/<path>` and reads a lattice page, served by urb-fetch's Rust `urb-gateway` in a new public, read-only mode. Every write or identity action is shown disabled with its reason.

**Architecture:** A `-public <domain>` mode in `core/urb-gateway` (urb-fetch): a configurable host suffix, static chrome around each body, sandboxed `?frame` frames for peer HTML, hardened headers, rate limits, a blocklist, cache headers and path-free logs. A deploy recipe (TLS proxy with a wildcard certificate) is written and tested locally, never run publicly. Lattice later gains "Copy web link".

**Spec:** `docs/superpowers/specs/2026-11-03-shipless-web-reader-design.md` (wiki `specs/2026-11-03-shipless-web-reader-design`). It holds the spikes, the comparison with a PWA plus relay, and the owner decisions this plan waits on.

## Global constraints

- Work in nisfeb/urb-fetch on a branch off main (89ca9ec or later), in `core/urb-gateway` and, only where needed, `core/urb-render`. Lattice changes are Task 9 only.
- Without `-public`, the gateway is byte-identical to today: `core/ci/gateway-diff.mjs` stays 123 of 123 and `core/ci/gateway-net.mjs` offline 54 of 54. Run both before every merge.
- Reads only. GET and HEAD. The gateway's identity sends nothing but the lattice reader's reads. No pokes beyond the reader's `%grubbery-load` peek, ever.
- One persistent identity per state folder. Tests use fake moons on the fleet. Never contact `~ricsul-bilwyt`; never touch `~hus` or any fleet ship without a fleet claim (`FLEET_WHO`); no live ship in a routine run.
- Nothing is deployed publicly by this plan. Task 10 is the owner's, after the decisions in the spec.
- Commits as `nisfeb <business@nisfeb.com>`, no AI attribution, Doom commit-msg lint (valid type, no scope except `ci`, subject <=72, body wrapped <=72). No em-dashes; never hard-wrap markdown.

## Review focus

- **Origin isolation:** a page of ~zod can never run script on `nec.<domain>` or on the apex. Pinned in Tasks 2 and 3.
- **Peer HTML:** only ever in a frame whose document carries the `SANDBOX` CSP; never inline in the chrome; `js` and `css` marks never served with an active type. Pinned in Task 3.
- **Host rule:** every Host outside `<domain>` and `*.<domain>` is 421, including `<ship>.urb.localhost` in public mode. Pinned in Task 1.
- **Forwarded IP:** `X-Forwarded-For` is trusted only from a loopback peer. Pinned in Task 5.
- **Parity:** loopback mode unchanged. Pinned in every task by the differential runs.

---

### Task 1: The public host rule

**Files:** `core/urb-gateway/src/flags.rs`, `core/urb-gateway/src/routes.rs`, `core/urb-render/src/gateway.rs` (`urb_of_host` taking a suffix), tests beside them.

- [ ] Add `-public <domain>` to `flags` (Go `flag` style words, as the other flags). Validate: lower-case DNS name, at least one dot, no port.
- [ ] Thread the suffix into `urb_of_host` (default `.urb.localhost`, so the loopback vectors stay identical) and into `Gateway::handle`: in public mode the apex is the home host and `*.<domain>` (one label) are ship hosts; `urb.localhost`, `localhost` and `127.0.0.1` are 421.
- [ ] `gateway_url` builds `https://<ship>.<domain>/<path>` in public mode (no port), so `/go` and rewritten links point at public hosts.
- [ ] Tests: a planet, a moon and the longest comet host map to their urb:// urls; two labels, an upper-case label after lowering, a non-ship label, and a foreign Host are refused; every `conformance/gateway-go.json` vector still passes with no flag.
- [ ] Commit: `feat: a public host suffix for urb-gateway`.

### Task 2: Headers for a user-content domain

**Files:** `core/urb-gateway/src/routes.rs`, `core/urb-gateway/src/http.rs`.

- [ ] In public mode only, every answer carries `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `X-Robots-Tag: noindex, nofollow`, and a CSP with `frame-ancestors 'self'` added to the policy the answer already has (`OWN`, `SANDBOX` or `RAW`).
- [ ] `GET /robots.txt` on every host answers `User-agent: *` / `Disallow: /`.
- [ ] No answer ever sets a cookie: a test walks every route and asserts no `Set-Cookie`.
- [ ] Tests: each header on each route kind; loopback mode has none of them (parity).
- [ ] Commit: `feat: user-content headers for the public gateway`.

### Task 3: The chrome and the sandboxed frame

**Files:** `core/urb-gateway/src/routes.rs` (new `chrome` function), `core/urb-render/src/gateway.rs` only if a hook is needed.

- [ ] Public mode wraps every page: static HTML, no script, under `OWN` plus `frame-ancestors 'self'`. It shows the ship and path, a home link, the action strip ("Bookmark", "Comment", "Follow", each a disabled button with "Connect a ship to ..."), "Open in lattice" (the `urb://` address), "Get lattice", and the abuse contact (flag `-abuse <address>`).
- [ ] Gemtext, Markdown and text render inside the chrome as today (`render_as`, same escaping).
- [ ] HTML (by mark, or `%gmi` sniffed, exactly as `render_as`) renders as the interstitial line "This page is from ~ship, not from <domain>" and `<iframe sandbox="allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation" src="?frame">`. The `?frame` answer (a query, reserved like `?raw`, so no published path can collide) is the rewritten HTML with the `SANDBOX` CSP header, from the same ship host only, and refused (403) when `Sec-Fetch-Dest` is `document` so it is never a top-level page.
- [ ] `js`, `css` and `noun` marks render as escaped text in the chrome; `?raw` stays `text/plain` with `RAW`.
- [ ] Forum and furum addresses answer the chrome with "Reading boards on the web is coming. Open in lattice to read it now." and status 501.
- [ ] Errors use `fail_of`'s words inside the chrome; a `later` failure gets a retry link.
- [ ] Tests: the chrome has no `<script`; a hostile HTML body (script, meta refresh, `<base>`, forms) appears only in the `?frame` answer; `?frame` as a document is 403; each mark's path; the private page's words.
- [ ] Commit: `feat: the public gateway's chrome, with actions disabled`.

### Task 4: The home page

**Files:** `core/urb-gateway/src/routes.rs`.

- [ ] Public apex `/`: what this is in two sentences, an address form (GET `/go`, which also takes `~ship/page`), the start list read through the engine from `-start <urb url>` with a compiled-in copy for when it cannot be read, and "Get lattice".
- [ ] Tests: the form, `/go` with each address form, the fallback list when the start page fails.
- [ ] Commit: `feat: the public gateway's home page`.

### Task 5: Rate limits and caps

**Files:** `core/urb-gateway/src/` (new `limits.rs`), `flags.rs`.

- [ ] The client IP is the TCP peer, or the last `X-Forwarded-For` entry when the peer is loopback and `-trust-proxy` is set.
- [ ] Per IP: token bucket, `-rate 60` a minute, `-burst 20`; over it, 429 with `Retry-After`.
- [ ] Per publisher: at most `-ship-cold 4` cold reads in flight and `-ship-rate 120` a minute; over it, 503 with `Retry-After`. Cached answers do not count.
- [ ] Body cap 4 MB (`-max-body`), answered as the desktop does.
- [ ] Tests on a fake clock: bucket refill, the forwarded rule (a non-loopback peer's header ignored), per-ship caps, the cap's words.
- [ ] Commit: `feat: rate limits for the public gateway`.

### Task 6: Cache headers and the blocklist

**Files:** `core/urb-gateway/src/routes.rs`, new `blocklist.rs`.

- [ ] `Cache-Control: public, max-age=60` on pages, `max-age=300` on the home page, `no-store` on errors.
- [ ] `-blocklist <file>`: lines `~ship` or `~ship/path/prefix`, `#` comments, re-read when its mtime changes. A match answers 451 in the chrome with the abuse contact, before the engine is touched.
- [ ] Tests: prefix matching on segment boundaries, reload on change, a bad line logged and skipped.
- [ ] Commit: `feat: a blocklist for the public gateway`.

### Task 7: Logs and counters

**Files:** `core/urb-gateway/src/main.rs`, `routes.rs`.

- [ ] In public mode each request logs status, duration and ship only: no path, no query, no IP. Counters (reads, cache hits, 429, 451, 503, failures) at `GET /metrics` on a separate loopback-only listener (`-metrics 127.0.0.1:<port>`).
- [ ] Test: a run of requests leaves no path or IP in the log.
- [ ] Commit: `feat: path-free logs for the public gateway`.

### Task 8: Fleet and local end-to-end

**Files:** `core/ci/public-gateway.mjs` (new), `docs/rust-core.md` (a section on public mode).

- [ ] With a fleet claim (`FLEET_WHO`) on lattice-gate-peer, reset to `lattice`, publish a gemtext page, a Markdown page and a hostile HTML page with `POST /apps/lattice/save`. Run `urb-gateway -public test.example -fake <moon>` as a fake moon of the publisher, behind Caddy on loopback with a local CA (`tls internal`) and `/etc/hosts`-free resolution (`--resolve` in curl, `--host-resolver-rules` in headless Brave). Release the claim after.
- [ ] Check in headless Brave: each page renders; the action strip is disabled with its reasons; the HTML page's script runs only in the frame and cannot read `document.cookie` of, or script, the ship origin or the apex; `nec.test.example` cannot frame `zod.test.example`; 429 after the burst; 451 for a blocked ship; a foreign Host is 421.
- [ ] Rerun `gateway-diff.mjs` (123 of 123) and `gateway-net.mjs --offline` (54 of 54) with no flag.
- [ ] Commit: `test: the public gateway end to end on the fleet`.

### Task 9 (lattice, after the gateway is live): Copy web link

**Files:** in this repo, where `feat-copy-urb-link` puts "Copy urb link" (reader bar and editor share menu), plus a constant for the domain.

- [ ] "Copy web link" beside it, giving `https://<domain>/go?url=<encoded urb url>`, shown only for published pages and only when the constant is set.
- [ ] UI test for both places; desk version bump per release practice.
- [ ] Commit: `feat: copy a web link to a published page`.

### Task 10 (owner): Deploy

Not part of this plan's execution. Needs the spec's owner decisions: domain, DNS API token, VPS, identity, consent default, abuse contact, start list. The recipe from Task 8 (Caddy with DNS-01 wildcard for `<domain>` and `*.<domain>`, `urb-gateway -public <domain> -trust-proxy -abuse ... -start ... -blocklist ...` as a systemd unit, UDP port open in the firewall) goes in `docs/rust-core.md`. First live reads: only the owner's own published pages.

### Later, not planned here

- The lattice-side publisher flag ("Readable on the web gateway") in the pub index, and the gateway honouring it.
- Forum and furum boards on the web (after desktop slice 3's board renderer).
- The PWA plus hardened relay (spec option (a)), only if the owner asks for it.
