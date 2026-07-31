//! The localhost bridge: the workspace webview talks ONLY to 127.0.0.1, and
//! this forwarder attaches the fuse session cookie to every request it relays
//! to the ship. Webkit cookie policy therefore never matters — builds that
//! withhold cookies on cross-site navigations, SW-mediated fetches, or
//! anything else all behave identically, because the webview needs no
//! cookies at all. One request per connection (Connection: close), bodies
//! streamed both ways, so eyre's SSE beacon works.
//!
//! ponytail: bound to 127.0.0.1 with same-user trust — any local process
//! could relay through it, but the same user can already read the cookie
//! file it injects. Add a token handshake if multi-user hosts ever matter.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use lattice_fs::default_cookie_path;

/// the ship base the bridge currently relays to, and the port it listens on
pub struct Bridge(pub Mutex<Option<(Arc<Mutex<String>>, u16)>>);

/// The webview's origin includes this port, and ALL web storage — the service
/// worker cache, localStorage — is keyed by origin. Binding port 0 gave every
/// launch a brand-new empty origin, so the desktop app re-downloaded the whole
/// UI on every start and never got the client's paint-from-snapshot: it was
/// measurably slower than the same UI in a browser, which keeps its origin.
/// A deterministic port is a stable origin, so the cache survives a restart.
const PORT_BASE: u16 = 41863;
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

/// Start (or re-point) the bridge for `ship_base`; returns the local base URL.
pub fn ensure(state: &Bridge, ship_base: &str) -> Result<String, String> {
    let base = ship_base.trim_end_matches('/').to_string();
    let mut guard = state.0.lock().unwrap();
    if let Some((cur, port)) = guard.as_ref() {
        // Re-point the SAME listener instead of binding another one: the port
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

/// pre-warm one ship connection so the first paint doesn't pay the TCP+TLS
/// handshake on top of the pier round-trip
fn prewarm(base: &str) {
    let warm = format!("{base}/apps/lattice/icon.svg");
    std::thread::spawn(move || {
        let _ = agent().get(&warm).call();
    });
}

/// one shared agent: its pool keeps ship connections (and TLS sessions)
/// alive across requests — a per-request agent paid a fresh TCP+TLS
/// handshake to the ship for every asset, which dominated remote loads.
/// Several idle connections per host, because a page load fetches in
/// parallel and the SSE beacon permanently occupies one connection.
fn agent() -> &'static ureq::Agent {
    static A: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    A.get_or_init(|| {
        ureq::AgentBuilder::new()
            .redirects(0)
            .max_idle_connections_per_host(6)
            .build()
    })
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
    // Accept-Encoding passes THROUGH: ureq (no gzip feature) hands us the
    // compressed body verbatim and Content-Encoding rides back with it, so
    // the webview decodes — stripping it made every WAN transfer identity,
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
        if matches!(
            kl.as_str(),
            "host" | "connection" | "cookie" | "content-length"
                | "upgrade" | "keep-alive" | "proxy-connection" | "transfer-encoding"
        ) {
            continue;
        }
        headers.push((k.to_string(), v.to_string()));
    }
    let mut body = vec![0u8; content_len];
    if content_len > 0 {
        reader.read_exact(&mut body)?;
    }
    crate::commands::dlog(&format!("bridge: {method} {target}"));

    let mut req = agent().request(&method, &format!("{ship}{target}"));
    for (k, v) in &headers {
        req = req.set(k, v);
    }
    if let Ok(ck) = std::fs::read_to_string(default_cookie_path()) {
        let ck = ck.trim();
        if !ck.is_empty() {
            req = req.set("cookie", ck);
        }
    }
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
        // set-cookie is dropped on purpose — the webview must stay cookieless.
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
    // stream — flushed per chunk so SSE events arrive as they happen
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
