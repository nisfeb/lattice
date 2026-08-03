//! The localhost bridge: the workspace webview talks ONLY to 127.0.0.1, and
//! this forwarder attaches the fuse session cookie to every request it relays
//! to the ship. Webkit cookie policy therefore never matters. Builds that
//! withhold cookies on cross-site navigations, SW-mediated fetches, or
//! anything else all behave identically, because the webview needs no
//! cookies at all. One request per connection (Connection: close), bodies
//! streamed both ways, so eyre's SSE beacon works.
//!
//! ponytail: bound to 127.0.0.1 with same-user trust. Any local process
//! could relay through it, but the same user can already read the cookie
//! file it injects. Add a token handshake if multi-user hosts ever matter.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use lattice_fs::default_cookie_path;

/// the ship base the bridge currently relays to, and the port it listens on
pub struct Bridge(pub Mutex<Option<(Arc<Mutex<String>>, u16)>>);

/// The webview's origin includes this port, and ALL web storage (the service
/// worker cache, localStorage) is keyed by origin. Binding port 0 gave every
/// launch a brand-new empty origin, so the desktop app re-downloaded the whole
/// UI on every start and never got the client's paint-from-snapshot. It was
/// measurably slower than the same UI in a browser, which keeps its origin.
/// A deterministic port is a stable origin, so the cache survives a restart.
///
/// BELOW 32768 on purpose. Linux hands out ephemeral ports from 32768 upward
/// (`net.ipv4.ip_local_port_range`), so the old 41863 sat inside that range:
/// any unrelated outgoing connection could be holding it at launch, the bind
/// would step to 41864, and the webview would come up on a DIFFERENT origin.
/// Since the offline queue, the tree snapshot and the resume snapshot are all
/// keyed by origin, that silently hid a user's queued edits. Found by mutation
/// testing, which flagged the same overlap making the port test flaky.
const PORT_BASE: u16 = 26500;
const PORT_SPAN: u16 = 16;

fn bind_stable() -> Result<(TcpListener, u16), String> {
    let mut last = String::new();
    for port in PORT_BASE..PORT_BASE + PORT_SPAN {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => return Ok((l, port)),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!(
        "bridge bind: no free port in {PORT_BASE}..{}: {last}",
        PORT_BASE + PORT_SPAN
    ))
}

/// Start (or re-point) the bridge for `ship_base`. Returns the local base URL.
pub fn ensure(state: &Bridge, ship_base: &str) -> Result<String, String> {
    let base = ship_base.trim_end_matches('/').to_string();
    let mut guard = state.0.lock().unwrap();
    if let Some((cur, port)) = guard.as_ref() {
        // Re-point the SAME listener instead of binding another one. The port
        // is part of the webview's origin, so rebinding would discard the
        // cache keyed to it. A ship change always comes from connect(), which
        // clears browsing data, so no ship is served another's cached shell.
        *cur.lock().unwrap() = base.clone();
        let port = *port;
        prewarm(&base);
        return Ok(format!("http://127.0.0.1:{port}"));
    }
    let (listener, port) = bind_stable()?;
    let shared = Arc::new(Mutex::new(base.clone()));
    let ship = shared.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let ship = ship.lock().unwrap().clone();
            std::thread::spawn(move || {
                let _ = serve(conn, &ship);
            });
        }
    });
    *guard = Some((shared, port));
    prewarm(&base);
    Ok(format!("http://127.0.0.1:{port}"))
}

/// Is the stored session actually good for `base`? Hits an owner-gated route
/// with the fuse cookie: 200 means logged in, 403 means the cookie is stale or
/// belongs to another ship. Nothing cheaper is honest. The cookie FILE
/// existing says only that we logged in once, which is exactly the state the
/// connection page used to misreport. Doubles as a connection warm-up.
pub fn probe(base: &str) -> Result<bool, String> {
    let url = format!("{}/apps/lattice/legacy-status", base.trim_end_matches('/'));
    let req = with_cookie(agent().get(&url));
    match req.call() {
        Ok(r) => Ok(r.status() == 200),
        // a 403/redirect is a live ship that does not know us: not connected,
        // but not an error either. Only a transport failure is an error.
        Err(ureq::Error::Status(_, _)) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// The fuse session cookie at `path`, if there is one. A file that is missing,
/// unreadable or blank is NOT a session: attaching an empty cookie header
/// would be a request we already know the ship will refuse.
pub fn session_cookie(path: &str) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
}

/// The one place credentials go onto an outbound request. Read fresh every
/// time: a reconnect rewrites the cookie file, and the next request must use
/// the new session rather than one cached at startup.
pub fn with_cookie(req: ureq::Request) -> ureq::Request {
    match session_cookie(&default_cookie_path()) {
        Some(c) => req.set("cookie", &c),
        None => req,
    }
}

/// pre-warm one ship connection so the first paint doesn't pay the TCP+TLS
/// handshake on top of the pier round-trip
fn prewarm(base: &str) {
    let warm = format!("{base}/apps/lattice/icon.svg");
    std::thread::spawn(move || {
        let _ = agent().get(&warm).call();
    });
}

/// one shared agent: its pool keeps ship connections (and TLS sessions)
/// alive across requests. A per-request agent paid a fresh TCP+TLS
/// handshake to the ship for every asset, which dominated remote loads.
/// Several idle connections per host, because a page load fetches in
/// parallel and the SSE beacon permanently occupies one connection.
pub fn agent() -> &'static ureq::Agent {
    static A: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    A.get_or_init(|| {
        ureq::AgentBuilder::new()
            .redirects(0)
            .max_idle_connections_per_host(6)
            // CONNECT timeout only, never read/write: the SSE beacon holds a
            // connection open for hours, and a read timeout would sever it on
            // every idle stretch. Connect is where an unreachable ship hangs
            // (SYN into the void), and 10s bounds it so the webview gets its
            // 502 while the client's own AbortController is still waiting.
            // The offline queue depends on failure being FAST.
            .timeout_connect(std::time::Duration::from_secs(10))
            .build()
    })
}

/// Headers the webview sent that must NOT be relayed on.
///
/// `cookie` is the load-bearing one. The whole point of the bridge is that the
/// webview holds no session and we attach ours Rust-side, so forwarding a page
/// cookie would put webkit's cookie behaviour back in the auth path. The rest
/// are hop-by-hop (they describe the webview↔bridge connection, not the
/// bridge↔ship one) plus `content-length`, which ureq recomputes.
///
/// NB: accept-encoding is deliberately NOT dropped. It rides through so the
/// ship can gzip and the webview decodes, which matters on every WAN load.
fn drop_request_header(lower_name: &str) -> bool {
    matches!(
        lower_name,
        "host" | "connection" | "cookie" | "content-length"
            | "upgrade" | "keep-alive" | "proxy-connection" | "transfer-encoding"
    )
}

fn serve(client: TcpStream, ship: &str) -> std::io::Result<()> {
    client.set_nodelay(true).ok();
    let mut reader = BufReader::new(client.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = match (parts.next(), parts.next()) {
        (Some(m), Some(t)) => (m.to_string(), t.to_string()),
        _ => return Ok(()),
    };
    // headers: keep what the page sent except hop-by-hop, host and cookies.
    // Accept-Encoding passes THROUGH. ureq (no gzip feature) hands us the
    // compressed body verbatim and Content-Encoding rides back with it, so
    // the webview decodes. Stripping it made every WAN transfer identity,
    // which is a real tax on app.js and page-tree vs a plain browser.
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut content_len = 0usize;
    loop {
        let mut h = String::new();
        reader.read_line(&mut h)?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        let Some((k, v)) = h.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        let kl = k.to_ascii_lowercase();
        if kl == "content-length" {
            content_len = v.parse().unwrap_or(0);
        }
        if drop_request_header(&kl) {
            continue;
        }
        headers.push((k.to_string(), v.to_string()));
    }
    // allocate as bytes actually arrive, never what the header claims: a
    // request lying "Content-Length: 10^18" was an instant OOM abort via
    // vec![0; huge] before a single body byte existed.
    let mut body = Vec::new();
    if content_len > 0 {
        (&mut reader).take(content_len as u64).read_to_end(&mut body)?;
        if body.len() < content_len {
            return Ok(()); // truncated body: drop it, same as a failed read_exact
        }
    }
    crate::commands::dlog(&format!("bridge: {method} {target}"));

    let mut req = agent().request(&method, &format!("{ship}{target}"));
    for (k, v) in &headers {
        req = req.set(k, v);
    }
    let req = with_cookie(req);
    let resp = if content_len > 0 { req.send_bytes(&body) } else { req.call() };
    let resp = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => {
            let msg = format!("bridge: ship unreachable: {e}");
            let mut c = client;
            write!(
                c,
                "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                msg.len(),
                msg
            )?;
            return Ok(());
        }
    };

    let mut c = client;
    write!(c, "HTTP/1.1 {} {}\r\n", resp.status(), resp.status_text())?;
    for name in resp.headers_names() {
        let nl = name.to_ascii_lowercase();
        // close-delimited relay: length/framing headers are ours to own.
        // set-cookie is dropped on purpose. The webview must stay cookieless.
        if matches!(
            nl.as_str(),
            "content-length" | "transfer-encoding" | "connection" | "set-cookie" | "keep-alive"
        ) {
            continue;
        }
        if let Some(v) = resp.header(&name) {
            write!(c, "{name}: {v}\r\n")?;
        }
    }
    write!(c, "Connection: close\r\n\r\n")?;
    // stream, flushed per chunk so SSE events arrive as they happen
    let mut src = resp.into_reader();
    let mut buf = [0u8; 16 * 1024];
    loop {
        match src.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if c.write_all(&buf[..n]).is_err() {
                    break;
                }
                c.flush().ok();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_webviews_cookie_is_never_relayed() {
        // the bridge exists so the webview holds NO session. Forwarding its
        // cookie would put webkit's cookie behaviour back in the auth path,
        // which is the entire class of bug this design removed.
        assert!(drop_request_header("cookie"));
        // hop-by-hop headers describe the webview<->bridge hop, not ours
        for h in ["host", "connection", "content-length", "upgrade",
                  "keep-alive", "proxy-connection", "transfer-encoding"] {
            assert!(drop_request_header(h), "{h} must not be relayed");
        }
        // accept-encoding MUST ride through. The ship gzips and the webview
        // decodes. Dropping it made every WAN transfer identity-encoded.
        assert!(!drop_request_header("accept-encoding"));
        for h in ["accept", "user-agent", "referer", "if-none-match", "range"] {
            assert!(!drop_request_header(h), "{h} should reach the ship");
        }
    }

    use crate::testutil::Stub;
    use proptest::prelude::*;

    /// Push raw bytes through a real serve() relaying to `ship` and collect
    /// whatever the client gets back. serve() runs to completion before this
    /// returns, so "the ship saw nothing" is a decision, not a race.
    fn through_bridge(req: &[u8], ship: &str) -> Vec<u8> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let ship = ship.to_string();
        let t = std::thread::spawn(move || {
            let (conn, _) = listener.accept().unwrap();
            let _ = serve(conn, &ship);
        });
        let mut c = TcpStream::connect(addr).unwrap();
        c.write_all(req).ok();
        c.shutdown(std::net::Shutdown::Write).ok();
        let mut out = Vec::new();
        let _ = c.read_to_end(&mut out);
        t.join().expect("serve must not panic");
        out
    }

    /// Feed raw bytes to a real serve() with a dead upstream and collect
    /// whatever it answers. The property is survival: reply or drop, never
    /// panic (the join would surface it) and never abort on an absurd claim.
    fn poke_bridge(req: &[u8]) -> Vec<u8> {
        through_bridge(req, "http://127.0.0.1:1") // nothing listens: refused fast
    }

    /// one plain GET straight at the bridge's own port, returning the body
    fn get_through_bridge(base: &str, path: &str) -> String {
        let addr = base.trim_start_matches("http://").to_string();
        let mut c = TcpStream::connect(addr).unwrap();
        write!(c, "GET {path} HTTP/1.1\r\nhost: bridge\r\n\r\n").unwrap();
        c.shutdown(std::net::Shutdown::Write).ok();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        out.rsplit("\r\n\r\n").next().unwrap_or_default().to_string()
    }

    #[test]
    fn a_request_body_reaches_the_ship_byte_for_byte() {
        // Nothing else in this file proves a POST body is forwarded AT ALL.
        // If it silently stopped being, every save, upload and batch write
        // would arrive at the ship empty while the webview saw a 200.
        let ship = Stub::new(|_| (200, "saved".to_string()));
        let body = r#"{"page":"note","text":"body bytes that must survive the hop"}"#;
        let req = format!(
            "POST /apps/lattice/save?id=7 HTTP/1.1\r\nhost: 127.0.0.1:{PORT_BASE}\r\n\
             cookie: webview-junk=1\r\ncontent-length: {}\r\n\
             x-lattice-probe: keep-me\r\naccept-encoding: gzip\r\n\r\n{body}",
            body.len()
        );
        let back = through_bridge(req.as_bytes(), &ship.base);

        let seen = ship.only();
        assert_eq!(seen.method, "POST", "the method is relayed as sent");
        assert_eq!(seen.target, "/apps/lattice/save?id=7", "path AND query");
        assert_eq!(seen.body_str(), body, "the body must arrive intact");
        assert_eq!(seen.header("content-length"), Some(body.len().to_string().as_str()));
        // ordinary request headers ride through...
        assert_eq!(seen.header("x-lattice-probe"), Some("keep-me"));
        // ...including accept-encoding, or every WAN transfer goes identity
        assert_eq!(seen.header("accept-encoding"), Some("gzip"));
        // ...but never the webview's own cookie: that is the whole design
        assert!(
            !seen.header_blob().contains("webview-junk"),
            "the webview's cookie was relayed: {}",
            seen.header_blob()
        );

        // and the ship's answer comes back, status line and body
        let back = String::from_utf8_lossy(&back);
        assert!(back.starts_with("HTTP/1.1 200 OK"), "{back}");
        assert!(back.ends_with("saved"), "the response body must reach the webview: {back}");
    }

    #[test]
    fn a_truncated_body_is_never_forwarded_as_a_short_one() {
        // a client that promises 64 bytes and dies after 4 must not have its
        // half-written save committed to the ship as a complete one
        let ship = Stub::new(|_| (200, "should not happen".to_string()));
        let back = through_bridge(
            b"POST /apps/lattice/save HTTP/1.1\r\ncontent-length: 64\r\n\r\nhalf",
            &ship.base,
        );
        assert!(
            ship.requests().is_empty(),
            "a truncated body reached the ship"
        );
        assert!(back.is_empty(), "the webview must get no fabricated reply");
    }

    #[test]
    fn an_unreachable_ship_is_a_502_and_not_a_hang() {
        // the client's offline queue depends on failure arriving FAST and
        // looking like a failure, not like an empty success
        let back = String::from_utf8_lossy(&poke_bridge(b"GET /apps/lattice/app HTTP/1.1\r\n\r\n"))
            .into_owned();
        assert!(back.starts_with("HTTP/1.1 502 Bad Gateway"), "{back}");
    }

    #[test]
    fn probe_reports_the_session_honestly() {
        // 200 on an owner-gated route is the ONLY thing that means logged in.
        // The connection page reads this directly, so a wrong answer either
        // strands the user on a login form or claims a ship it cannot reach.
        let live = Stub::new(|_| (200, "ok".to_string()));
        assert_eq!(probe(&live.base), Ok(true));
        assert_eq!(
            live.only().target,
            "/apps/lattice/legacy-status",
            "the probe must hit the owner-gated route, not something public"
        );
        // a live ship that does not know us: not connected, but not an error
        let stale = Stub::new(|_| (403, "no".to_string()));
        assert_eq!(probe(&stale.base), Ok(false));
        // a ship that answers something other than 200 is not a session either
        let odd = Stub::new(|_| (307, String::new()));
        assert_eq!(probe(&odd.base), Ok(false));
        // nothing listening is an error, which the page must advise on
        // differently from "reachable but logged out"
        assert!(probe("http://127.0.0.1:1").is_err());
        // a configured url with a trailing slash must not become //apps/...
        let slashed = Stub::new(|_| (200, "ok".to_string()));
        let base = format!("{}/", slashed.base);
        assert_eq!(probe(&base), Ok(true));
        assert_eq!(slashed.only().target, "/apps/lattice/legacy-status");
    }

    #[test]
    fn the_session_cookie_is_attached_only_when_there_is_one() {
        // every authenticated request the shell makes goes through here. If it
        // stopped attaching, the whole workspace would 403 with the cookie
        // file sitting right there; if it attached a blank one, likewise.
        let p = std::env::temp_dir().join(format!("lattice-ck-{}", std::process::id()));
        std::fs::remove_file(&p).ok();
        let path = p.to_string_lossy().into_owned();
        assert_eq!(session_cookie(&path), None, "no file is no session");
        std::fs::write(&p, b"  \n ").unwrap();
        assert_eq!(session_cookie(&path), None, "a blank file is no session");
        std::fs::write(&p, b"urbauth-~tyr=0v1.2ab3c\n").unwrap();
        assert_eq!(
            session_cookie(&path).as_deref(),
            Some("urbauth-~tyr=0v1.2ab3c"),
            "the cookie is passed on verbatim, minus the trailing newline"
        );
        std::fs::remove_file(&p).ok();
    }

    proptest! {
        // few cases: each one is a real TCP round-trip
        #![proptest_config(ProptestConfig { cases: 24, ..ProptestConfig::default() })]

        // a local client can write ANYTHING at the bridge socket
        #[test]
        fn serve_survives_arbitrary_request_bytes(
            req in proptest::collection::vec(any::<u8>(), 0..256),
        ) {
            poke_bridge(&req);
        }

        // a lying content-length must not allocate what the header claims:
        // "Content-Length: 10^18" with no body was an instant OOM abort
        #[test]
        fn a_lying_content_length_cannot_oom(len in any::<u64>()) {
            let req = format!("POST /x HTTP/1.1\r\ncontent-length: {len}\r\n\r\nhi");
            poke_bridge(req.as_bytes());
        }

        // header names are matched lowercased at the call site, so the drop
        // list must be total and hit regardless of the wire casing
        #[test]
        fn drop_request_header_is_total_and_case_blind(name in "[!-~]{1,24}") {
            let dropped = drop_request_header(&name.to_ascii_lowercase());
            let expected = matches!(
                name.to_ascii_lowercase().as_str(),
                "host" | "connection" | "cookie" | "content-length" | "upgrade"
                    | "keep-alive" | "proxy-connection" | "transfer-encoding"
            );
            prop_assert_eq!(dropped, expected);
        }
    }

    /// Wait for exclusive use of the bridge port range. What can hold a port in
    /// it is another test process, several of which run at once under
    /// cargo-mutants. The kernel is no longer a contender: PORT_BASE now sits
    /// below the ephemeral floor (32768), so no outgoing connection can be
    /// handed one of these ports. That overlap used to fail this test at random
    /// and score mutants "caught" by the flake.
    ///
    /// So: take a port outside the asserted range as a cross-process lock (no
    /// dependency, no cleanup), then wait for the range itself to be clear.
    /// The lock is deliberately never released. ensure() hands PORT_BASE to a
    /// thread that owns it for the life of the process, so a claim ending with
    /// the test would let the next process in while this one still held it.
    fn claim_the_port_range() {
        // generous: the claim is held for a whole process lifetime, so N
        // concurrent test binaries serialize on it
        for _ in 0..600 {
            if let Ok(lock) = TcpListener::bind(("127.0.0.1", PORT_BASE + PORT_SPAN + 1)) {
                if (0..2).all(|i| TcpListener::bind(("127.0.0.1", PORT_BASE + i)).is_ok()) {
                    std::mem::forget(lock);
                    return;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!(
            "127.0.0.1:{PORT_BASE}..{} never came free. Something holds one of \
             those ports: the desktop app itself, or an ordinary outgoing \
             connection that the kernel handed an ephemeral port in this range.",
            PORT_BASE + 2
        );
    }

    /// One test, because ensure() hands its listener to a thread that owns it
    /// for the life of the process: nothing can free PORT_BASE again, so the
    /// bind-stable assertions have to run first, in the same test.
    #[test]
    fn the_bridge_port_is_deterministic_and_relays_to_the_current_ship() {
        claim_the_port_range();
        // The port is part of the webview's ORIGIN, and web storage is keyed by
        // origin. A moving port gave every launch an empty cache, which is what
        // made the desktop app slower than the same UI in a browser. So the
        // first bind must be PORT_BASE, and a taken port must step by one
        // rather than fall back to an ephemeral one.
        let (first, p1) = bind_stable().expect("a free port in the range");
        assert_eq!(p1, PORT_BASE, "first bind must be the deterministic port");
        let (second, p2) = bind_stable().expect("the range has room");
        assert_eq!(p2, PORT_BASE + 1, "a taken port steps by one, stays stable");
        drop(first);
        drop(second);
        // and with the range free again we are back to the same origin
        let (third, p3) = bind_stable().expect("free again");
        assert_eq!(p3, PORT_BASE, "the origin is recoverable, not drifting");
        drop(third);

        // And the bridge that port belongs to must actually forward. ensure()
        // returning a plausible-looking url without a live listener behind it
        // is a blank window; forwarding to a stale ship after a re-point is
        // one ship's pages served under another ship's session and origin.
        let ship1 = Stub::new(|_| (200, "ship one".to_string()));
        let ship2 = Stub::new(|_| (200, "ship two".to_string()));
        let bridge = Bridge(Mutex::new(None));

        let local = ensure(&bridge, &format!("{}/", ship1.base)).expect("bridge starts");
        assert_eq!(local, format!("http://127.0.0.1:{PORT_BASE}"), "the webview's origin");
        assert_eq!(get_through_bridge(&local, "/apps/lattice/app"), "ship one");
        // the trailing slash was trimmed, not doubled onto the target
        assert!(ship1.asked_for("/apps/lattice/app"), "{:?}", ship1.requests().len());

        let again = ensure(&bridge, &ship2.base).expect("re-point");
        assert_eq!(again, local, "a ship change must NOT move the origin");
        assert_eq!(
            get_through_bridge(&local, "/apps/lattice/app"),
            "ship two",
            "the bridge kept relaying to the previous ship after a re-point"
        );
    }
}
