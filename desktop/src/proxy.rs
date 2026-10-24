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
//!
//! Browsers are a different matter. Any page the user opens in any browser
//! can aim requests at 127.0.0.1, and the bridge would sign them with the
//! owner's cookie. So a request is refused with a 403, before the ship sees
//! it, unless it looks like it came from the webview itself:
//!
//! - Host is `127.0.0.1:<port>` or `localhost:<port>`. A DNS rebinding page
//!   reaches the socket under its own host name, so this check stops it.
//! - Origin is absent or the bridge's own origin. A cross-site fetch or
//!   form POST carries the attacker's origin.
//! - Sec-Fetch-Site is not `cross-site`. That catches the cross-site GETs
//!   (img, script, top-level navigation) that carry no Origin.
//!
//! One exception. The app renders untrusted pages in sandboxed frames, and
//! those have an opaque origin. Their requests say `cross-site`, and some
//! say `Origin: null`. A Referer on the bridge's own origin lets them
//! through, since no other site can forge one, but WITHOUT the owner's
//! session. A browser gives an opaque-origin frame no cookies, and the ship
//! relies on that: public assets load, owner routes answer 403. Signing those
//! requests would hand peer-written script in a sandboxed frame the owner's
//! session, which is exactly what the sandbox is there to withhold.
//!
//! Lines, header count and body size are capped too, so a stray client
//! cannot make a thread buffer without bound.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};


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

/// How long to keep asking for PORT_BASE before accepting a different origin.
/// Moving PORT_BASE below the ephemeral range stopped the kernel taking it,
/// but left the likeliest thief of all: our own previous instance, still
/// closing its listener while the user relaunches. That is precisely the
/// "quit, rebuild, start again" path, and stepping a port there hands the new
/// window a new origin whose IndexedDB is empty, so the queued edits from the
/// session that just ended are invisible. Reported as lost work, and it is.
///
/// Waiting a few seconds costs a slow launch in a rare case. Not waiting costs
/// somebody their unsaved writing, so the trade is not close.
const PORT_WAIT_MS: u64 = 3_000;
const PORT_POLL_MS: u64 = 100;

fn bind_stable() -> Result<(TcpListener, u16), String> {
    let mut last = String::new();
    //  the canonical origin, patiently
    for _ in 0..(PORT_WAIT_MS / PORT_POLL_MS) {
        match TcpListener::bind(("127.0.0.1", PORT_BASE)) {
            Ok(l) => return Ok((l, PORT_BASE)),
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(std::time::Duration::from_millis(PORT_POLL_MS));
    }
    //  Still held, so another instance is genuinely running rather than
    //  exiting. Stepping is right (a second window has to work) but it is a
    //  different origin, and the caller warns rather than letting the user
    //  discover it by missing edits.
    for port in PORT_BASE + 1..PORT_BASE + PORT_SPAN {
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
    if port != PORT_BASE {
        // Not a cosmetic detail. Web storage is keyed by origin, so this
        // window cannot see the offline queue, tree snapshot or resume
        // snapshot belonging to a window on the canonical port. Anyone
        // debugging "where did my queued edits go" should find this line
        // rather than guess.
        crate::commands::dlog(&format!(
            "bridge: PORT {PORT_BASE} was taken, running on {port}. This is a \
             DIFFERENT ORIGIN: offline edits queued by another instance are \
             not visible here. Close the other instance and restart to get \
             them back."
        ));
    }
    let shared = Arc::new(Mutex::new(base.clone()));
    let ship = shared.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let ship = ship.lock().unwrap().clone();
            std::thread::spawn(move || {
                let _ = serve(conn, &ship, port);
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
    // NOT the shared agent: that one deliberately has no read timeout (the
    // SSE beacon holds a connection open for hours), which for this one call
    // meant a wedged or queue-bound pier held the connection page's status
    // check open indefinitely. A status check that cannot say "slow" inside
    // ten seconds should say "unreachable"; the page offers reconnect either
    // way. Everything real still goes through the shared agent.
    let a = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(std::time::Duration::from_secs(10))
        .build();
    let req = with_cookie(a.get(&url));
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
///
/// The cookie is looked up by the request's OWN origin (session.rs), never
/// by whichever ship the config names right now. So a request can only ever
/// carry the cookie that origin issued.
pub fn with_cookie(req: ureq::Request) -> ureq::Request {
    match crate::session::cookie_for(req.url()) {
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

/// Longest request line or header line we read, in bytes.
const MAX_LINE: u64 = 8 * 1024;
/// Most header lines one request may carry.
const MAX_HEADERS: usize = 100;
/// Largest request body we relay. Bigger is a 413.
const MAX_BODY: usize = 64 * 1024 * 1024;

/// Is `authority` (host:port) this bridge? Both spellings of loopback count.
fn is_bridge(authority: &str, port: u16) -> bool {
    authority.eq_ignore_ascii_case(&format!("127.0.0.1:{port}"))
        || authority.eq_ignore_ascii_case(&format!("localhost:{port}"))
}

/// How the bridge may relay one request. See the module comment.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Trust {
    /// not the webview: refused before the ship sees it
    Refuse,
    /// a sandboxed frame, let through on our own Referer but relayed with no
    /// session, the way a browser treats an opaque origin
    Anonymous,
    /// the webview's own same-origin request, relayed with the owner's session
    Session,
}

/// Did the webview send this, and not some other page in some browser?
/// And if it did, may the request carry the owner's session?
fn from_webview(
    host: Option<&str>,
    origin: Option<&str>,
    site: Option<&str>,
    referer: Option<&str>,
    port: u16,
) -> Trust {
    if !host.is_some_and(|h| is_bridge(h, port)) {
        return Trust::Refuse;
    }
    let bridge_origin = |o: &str| o.strip_prefix("http://").is_some_and(|a| is_bridge(a, port));
    // same-origin, or a navigation the user made. same-site is NOT enough:
    // another server on 127.0.0.1 is same-site with the bridge.
    let same_origin = origin.is_none_or(bridge_origin)
        && site.is_none_or(|s| s.eq_ignore_ascii_case("same-origin") || s.eq_ignore_ascii_case("none"));
    if same_origin {
        return Trust::Session;
    }
    // a Referer on our own origin. Only a page the bridge served can send it.
    let ours = referer
        .and_then(|r| r.strip_prefix("http://"))
        .and_then(|r| r.split(['/', '?', '#']).next())
        .is_some_and(|a| is_bridge(a, port));
    if ours && origin.is_none_or(|o| o == "null" || bridge_origin(o)) {
        return Trust::Anonymous;
    }
    Trust::Refuse
}

/// One request off the wire, already filtered, ready to relay. An empty body
/// means the request had none: that is what decides send_bytes vs call.
struct Incoming {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    /// relay with the owner's session (false: a sandboxed frame's request)
    session: bool,
}

/// What to do with one request off the wire.
enum Request {
    /// relay it to the ship
    Relay(Incoming),
    /// answer with this status line and never contact the ship
    Refuse(&'static str),
    /// say nothing: no request line, or a body cut short
    Drop,
}

/// Read one line of at most MAX_LINE bytes into `out`. False means the line
/// was longer, and the rest of it is still unread.
fn read_capped(reader: &mut impl BufRead, out: &mut String) -> std::io::Result<bool> {
    out.clear();
    (&mut *reader).take(MAX_LINE + 1).read_line(out)?;
    Ok(out.len() as u64 <= MAX_LINE)
}

/// Read one request for the bridge on `port`. Drop is a request we will not
/// serve at all: no request line, or a body that stopped short of what its
/// Content-Length promised. Refuse is one we answer without the ship: a
/// browser that is not the webview, or a request over a size cap. Both are
/// decided before the body is read.
///
/// Split from serve so the interesting inputs (a lying Content-Length, a
/// truncated body, a header line with no colon) can be fed in as bytes.
fn read_request(reader: &mut impl BufRead, port: u16) -> std::io::Result<Request> {
    let mut line = String::new();
    if !read_capped(reader, &mut line)? {
        return Ok(Request::Refuse("414 URI Too Long"));
    }
    let mut parts = line.split_whitespace();
    let (method, target) = match (parts.next(), parts.next()) {
        (Some(m), Some(t)) => (m.to_string(), t.to_string()),
        _ => return Ok(Request::Drop),
    };
    // headers: keep what the page sent except hop-by-hop, host and cookies.
    // Accept-Encoding passes THROUGH. ureq (no gzip feature) hands us the
    // compressed body verbatim and Content-Encoding rides back with it, so
    // the webview decodes. Stripping it made every WAN transfer identity,
    // which is a real tax on app.js and page-tree vs a plain browser.
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut content_len = 0usize;
    // host is dropped from the relay, so keep it here for the check below
    let mut host = None;
    let mut h = String::new();
    for n in 0.. {
        if !read_capped(reader, &mut h)? {
            return Ok(Request::Refuse("431 Request Header Fields Too Large"));
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if n == MAX_HEADERS {
            return Ok(Request::Refuse("431 Request Header Fields Too Large"));
        }
        let Some((k, v)) = h.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        let kl = k.to_ascii_lowercase();
        if kl == "content-length" {
            content_len = v.parse().unwrap_or(0);
        }
        if kl == "host" {
            host = Some(v.to_string());
        }
        if drop_request_header(&kl) {
            continue;
        }
        headers.push((k.to_string(), v.to_string()));
    }
    let header = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    };
    let trust = from_webview(
        host.as_deref(),
        header("origin"),
        header("sec-fetch-site"),
        header("referer"),
        port,
    );
    if trust == Trust::Refuse {
        return Ok(Request::Refuse("403 Forbidden"));
    }
    if content_len > MAX_BODY {
        return Ok(Request::Refuse("413 Payload Too Large"));
    }
    // allocate as bytes actually arrive, never what the header claims: a
    // request lying "Content-Length: 10^18" was an instant OOM abort via
    // vec![0; huge] before a single body byte existed.
    let mut body = Vec::new();
    if content_len > 0 {
        (&mut *reader).take(content_len as u64).read_to_end(&mut body)?;
        if body.len() < content_len {
            return Ok(Request::Drop); // truncated body: same as a failed read_exact
        }
    }
    Ok(Request::Relay(Incoming { method, target, headers, body, session: trust == Trust::Session }))
}

/// Answer `status` with no ship involved, then close. The client may still
/// be sending a request we never read. Closing on unread bytes makes the
/// kernel send a reset, which can eat the reply, so half-close and drain a
/// bounded amount first.
fn refuse(mut c: TcpStream, reader: &mut impl Read, status: &str) -> std::io::Result<()> {
    write!(
        c,
        "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{status}",
        status.len()
    )?;
    c.shutdown(std::net::Shutdown::Write).ok();
    c.set_read_timeout(Some(std::time::Duration::from_secs(2))).ok();
    let _ = std::io::copy(&mut reader.take(1 << 20), &mut std::io::sink());
    Ok(())
}

/// Status line, filtered headers, then the body as it arrives.
fn relay_response(c: &mut TcpStream, resp: ureq::Response) -> std::io::Result<()> {
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
    // c is an unbuffered socket, so io::copy hands each chunk on as it
    // arrives and SSE events go out as they happen. A read or write error
    // ends the relay, which is all the old loop did with one too.
    let _ = std::io::copy(&mut resp.into_reader(), c);
    Ok(())
}

/// Relay one request from the bridge on `port` to `ship`.
fn serve(client: TcpStream, ship: &str, port: u16) -> std::io::Result<()> {
    client.set_nodelay(true).ok();
    let mut reader = BufReader::new(client.try_clone()?);
    let req = match read_request(&mut reader, port)? {
        Request::Relay(req) => req,
        Request::Refuse(status) => {
            crate::commands::dlog(&format!("bridge: refused {status}"));
            return refuse(client, &mut reader, status);
        }
        Request::Drop => return Ok(()),
    };
    crate::commands::dlog(&format!("bridge: {} {}", req.method, req.target));

    let mut out = agent().request(&req.method, &format!("{ship}{}", req.target));
    for (k, v) in &req.headers {
        out = out.set(k, v);
    }
    let out = if req.session { with_cookie(out) } else { out };
    let resp = if !req.body.is_empty() { out.send_bytes(&req.body) } else { out.call() };
    let mut c = client;
    let resp = match resp {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => {
            let msg = format!("bridge: ship unreachable: {e}");
            write!(
                c,
                "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                msg.len(),
                msg
            )?;
            return Ok(());
        }
    };

    relay_response(&mut c, resp)
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
    ///
    /// serve() is told it is the bridge on PORT_BASE, whatever port the test
    /// listener got. The Host check only reads headers, so requests here
    /// name `127.0.0.1:{PORT_BASE}` like the webview would.
    fn through_bridge(req: &[u8], ship: &str) -> Vec<u8> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let ship = ship.to_string();
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (conn, _) = listener.accept().unwrap();
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                serve(conn, &ship, PORT_BASE)
            }));
            let _ = done.send(r.is_ok());
        });
        // bounded, so a relay that stalls is a failure and not a hung suite:
        // a header relayed when it should have been dropped (a lying
        // content-length) leaves the ship waiting for a body that never comes
        let limit = std::time::Duration::from_secs(20);
        let mut c = TcpStream::connect(addr).unwrap();
        c.set_read_timeout(Some(limit)).ok();
        c.write_all(req).ok();
        c.shutdown(std::net::Shutdown::Write).ok();
        let mut out = Vec::new();
        let _ = c.read_to_end(&mut out);
        match finished.recv_timeout(limit) {
            Ok(ok) => assert!(ok, "serve must not panic"),
            Err(_) => panic!("the bridge stalled relaying this request"),
        }
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
        let mut c = TcpStream::connect(&addr).unwrap();
        write!(c, "GET {path} HTTP/1.1\r\nhost: {addr}\r\n\r\n").unwrap();
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
        // header names as WebKit sends them: capitalised. The drop list is
        // matched on the lowercased name, so this is what proves the
        // lowercasing happens; lowercase names here passed without it.
        let req = format!(
            "POST /apps/lattice/save?id=7 HTTP/1.1\r\nHost: 127.0.0.1:{PORT_BASE}\r\n\
             Cookie: webview-junk=1\r\nContent-Length: {}\r\n\
             X-Lattice-Probe: keep-me\r\nAccept-Encoding: gzip\r\n\r\n{body}",
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
            format!(
                "POST /apps/lattice/save HTTP/1.1\r\nhost: 127.0.0.1:{PORT_BASE}\r\n\
                 content-length: 64\r\n\r\nhalf"
            )
            .as_bytes(),
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
        let req = format!("GET /apps/lattice/app HTTP/1.1\r\nHost: 127.0.0.1:{PORT_BASE}\r\n\r\n");
        let back = String::from_utf8_lossy(&poke_bridge(req.as_bytes())).into_owned();
        assert!(back.starts_with("HTTP/1.1 502 Bad Gateway"), "{back}");
    }

    /// Send `req` to a live stub ship through the bridge. Returns the status
    /// line the client got and how many requests reached the ship.
    fn status_and_hits(req: &str) -> (String, usize) {
        let ship = Stub::new(|_| (200, "relayed".to_string()));
        let back = String::from_utf8_lossy(&through_bridge(req.as_bytes(), &ship.base)).into_owned();
        let status = back.lines().next().unwrap_or_default().to_string();
        (status, ship.requests().len())
    }

    #[test]
    fn a_foreign_host_is_refused_before_the_ship_sees_it() {
        // DNS rebinding: evil.example resolves to 127.0.0.1, so the page's
        // requests reach the socket under evil.example's name. Signing those
        // with the owner's cookie would hand that page the ship.
        for host in ["evil.example", "evil.example:26500", "127.0.0.1:9", "127.0.0.2:26500"] {
            let (status, hits) = status_and_hits(&format!(
                "GET /apps/lattice/app HTTP/1.1\r\nHost: {host}\r\n\r\n"
            ));
            assert_eq!(status, "HTTP/1.1 403 Forbidden", "host {host}");
            assert_eq!(hits, 0, "host {host} reached the ship");
        }
        // no Host at all is not the webview either
        let (status, hits) = status_and_hits("GET /apps/lattice/app HTTP/1.1\r\n\r\n");
        assert_eq!(status, "HTTP/1.1 403 Forbidden");
        assert_eq!(hits, 0);
    }

    #[test]
    fn a_cross_site_request_is_refused_before_the_ship_sees_it() {
        // any page in any browser can aim at 127.0.0.1 with the right Host.
        // Origin catches its fetches and form POSTs.
        let (status, hits) = status_and_hits(&format!(
            "POST /apps/lattice/save HTTP/1.1\r\nHost: 127.0.0.1:{PORT_BASE}\r\n\
             Origin: https://evil.example\r\nContent-Length: 2\r\n\r\nhi"
        ));
        assert_eq!(status, "HTTP/1.1 403 Forbidden");
        assert_eq!(hits, 0, "a cross-site POST reached the ship");
        // a same-host origin on another port is another site's origin
        let (status, hits) = status_and_hits(&format!(
            "GET /x HTTP/1.1\r\nHost: 127.0.0.1:{PORT_BASE}\r\nOrigin: http://127.0.0.1:8080\r\n\r\n"
        ));
        assert_eq!((status.as_str(), hits), ("HTTP/1.1 403 Forbidden", 0));
        // Sec-Fetch-Site catches a cross-site GET, which carries no Origin
        let (status, hits) = status_and_hits(&format!(
            "GET /apps/lattice/app HTTP/1.1\r\nHost: 127.0.0.1:{PORT_BASE}\r\n\
             Sec-Fetch-Site: cross-site\r\nReferer: https://evil.example/\r\n\r\n"
        ));
        assert_eq!((status.as_str(), hits), ("HTTP/1.1 403 Forbidden", 0));
        // Origin: null is how a sandboxed attacker frame hides its origin
        let (status, hits) = status_and_hits(&format!(
            "GET /x HTTP/1.1\r\nHost: 127.0.0.1:{PORT_BASE}\r\nOrigin: null\r\n\r\n"
        ));
        assert_eq!((status.as_str(), hits), ("HTTP/1.1 403 Forbidden", 0));
    }

    #[test]
    fn the_webviews_own_requests_are_still_relayed() {
        let good = [
            // a plain local client: curl, or the app's own probes
            format!("GET /x HTTP/1.1\r\nHost: 127.0.0.1:{PORT_BASE}\r\n\r\n"),
            format!("GET /x HTTP/1.1\r\nHost: localhost:{PORT_BASE}\r\n\r\n"),
            // the webview's same-origin fetch
            format!(
                "POST /x HTTP/1.1\r\nHost: 127.0.0.1:{PORT_BASE}\r\n\
                 Origin: http://127.0.0.1:{PORT_BASE}\r\nSec-Fetch-Site: same-origin\r\n\
                 Content-Length: 2\r\n\r\nhi"
            ),
            // the user typed the address
            format!("GET /x HTTP/1.1\r\nHost: 127.0.0.1:{PORT_BASE}\r\nSec-Fetch-Site: none\r\n\r\n"),
            // a sandboxed preview frame: opaque origin, but our own Referer
            format!(
                "GET /x HTTP/1.1\r\nHost: 127.0.0.1:{PORT_BASE}\r\nOrigin: null\r\n\
                 Sec-Fetch-Site: cross-site\r\nReferer: http://127.0.0.1:{PORT_BASE}/apps/lattice/app\r\n\r\n"
            ),
        ];
        for req in good {
            let (status, hits) = status_and_hits(&req);
            assert_eq!(status, "HTTP/1.1 200 OK", "{req}");
            assert_eq!(hits, 1, "{req}");
        }
    }

    #[test]
    fn a_sandboxed_frame_is_relayed_without_the_owners_session() {
        // The Referer exception lets an opaque-origin frame load what the ship
        // serves publicly. The owner's cookie must not ride along: a browser
        // gives that frame no cookies, and the ship's sandbox depends on it
        // (audit finding desktop-bridge-referer-exception, lattice run-1).
        let host = format!("127.0.0.1:{PORT_BASE}");
        let ours = format!("http://127.0.0.1:{PORT_BASE}/apps/lattice/app");
        let bridge = format!("http://127.0.0.1:{PORT_BASE}");
        let t = |origin: Option<&str>, site: Option<&str>, referer: Option<&str>| {
            from_webview(Some(&host), origin, site, referer, PORT_BASE)
        };
        // sandboxed frames: opaque origin, our own Referer
        assert_eq!(t(Some("null"), Some("cross-site"), Some(&ours)), Trust::Anonymous);
        assert_eq!(t(None, Some("cross-site"), Some(&ours)), Trust::Anonymous);
        // the webview itself keeps its session
        assert_eq!(t(Some(&bridge), Some("same-origin"), Some(&ours)), Trust::Session);
        assert_eq!(t(None, Some("none"), None), Trust::Session);
        assert_eq!(t(None, None, None), Trust::Session);
        // another server on 127.0.0.1 is same-site, not same-origin
        assert_eq!(t(None, Some("same-site"), Some("http://127.0.0.1:8080/")), Trust::Refuse);
        assert_eq!(t(Some("http://127.0.0.1:8080"), Some("same-site"), None), Trust::Refuse);
        // and the decision reaches the relay
        let req = format!(
            "GET /apps/lattice/x HTTP/1.1\r\nHost: {host}\r\nOrigin: null\r\n\
             Sec-Fetch-Site: cross-site\r\nReferer: {ours}\r\n\r\n"
        );
        match read_request(&mut std::io::Cursor::new(req.into_bytes()), PORT_BASE).unwrap() {
            Request::Relay(r) => assert!(!r.session, "a sandboxed frame must not carry the session"),
            _ => panic!("a sandboxed frame's request should still be relayed"),
        }
        let req = format!(
            "GET /apps/lattice/x HTTP/1.1\r\nHost: {host}\r\nOrigin: {bridge}\r\n\
             Sec-Fetch-Site: same-origin\r\n\r\n"
        );
        match read_request(&mut std::io::Cursor::new(req.into_bytes()), PORT_BASE).unwrap() {
            Request::Relay(r) => assert!(r.session, "the webview's own request keeps the session"),
            _ => panic!("the webview's own request must be relayed"),
        }
    }

    #[test]
    fn oversized_requests_are_refused_without_the_ship() {
        let host = format!("Host: 127.0.0.1:{PORT_BASE}\r\n");
        let long = "a".repeat(MAX_LINE as usize + 1);
        let (status, hits) = status_and_hits(&format!("GET /{long} HTTP/1.1\r\n{host}\r\n"));
        assert_eq!((status.as_str(), hits), ("HTTP/1.1 414 URI Too Long", 0));
        let (status, hits) = status_and_hits(&format!("GET / HTTP/1.1\r\n{host}X-Big: {long}\r\n\r\n"));
        assert_eq!((status.as_str(), hits), ("HTTP/1.1 431 Request Header Fields Too Large", 0));
        let many = "X-A: 1\r\n".repeat(MAX_HEADERS);
        let (status, hits) = status_and_hits(&format!("GET / HTTP/1.1\r\n{host}{many}\r\n"));
        assert_eq!((status.as_str(), hits), ("HTTP/1.1 431 Request Header Fields Too Large", 0));
        let (status, hits) = status_and_hits(&format!(
            "POST / HTTP/1.1\r\n{host}Content-Length: {}\r\n\r\nhi",
            MAX_BODY + 1
        ));
        assert_eq!((status.as_str(), hits), ("HTTP/1.1 413 Payload Too Large", 0));
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
            let req = format!(
                "POST /x HTTP/1.1\r\nhost: 127.0.0.1:{PORT_BASE}\r\ncontent-length: {len}\r\n\r\nhi"
            );
            poke_bridge(req.as_bytes());
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

        // The reported failure, exactly: quit the app, rebuild, launch again.
        // The previous instance is still letting go of its listener, so a bind
        // that gives up immediately lands on PORT_BASE+1. That is a DIFFERENT
        // ORIGIN, and web storage is keyed by origin, so the offline queue the
        // user just filled is not reachable from the new window. It reads as
        // lost work because it is. Waiting for the canonical port is what makes
        // a relaunch keep its data.
        let (held, hp) = bind_stable().expect("free range");
        assert_eq!(hp, PORT_BASE);
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            drop(held); // the outgoing instance finally exits
        });
        let (got, port) = bind_stable().expect("the canonical port comes free");
        assert_eq!(
            port, PORT_BASE,
            "a relaunch must wait for the SAME origin, not silently take a new \
             one and orphan the queued edits"
        );
        drop(got);
        releaser.join().unwrap();

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
