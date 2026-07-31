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
use std::sync::Mutex;

use lattice_fs::default_cookie_path;

/// port of the running bridge, if any
pub struct Bridge(pub Mutex<Option<(String, u16)>>);

/// Start (or reuse) the bridge for `ship_base`; returns the local base URL.
pub fn ensure(state: &Bridge, ship_base: &str) -> Result<String, String> {
    let mut guard = state.0.lock().unwrap();
    if let Some((base, port)) = guard.as_ref() {
        if base == ship_base {
            return Ok(format!("http://127.0.0.1:{port}"));
        }
        // ship changed: the old forwarder keeps serving old connections
        // harmlessly; we just start a fresh one for the new base
    }
    let listener =
        TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("bridge bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let base = ship_base.trim_end_matches('/').to_string();
    let ship = base.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let ship = ship.clone();
            std::thread::spawn(move || {
                let _ = serve(conn, &ship);
            });
        }
    });
    *guard = Some((base, port));
    Ok(format!("http://127.0.0.1:{port}"))
}

/// one shared agent: its pool keeps ship connections (and TLS sessions)
/// alive across requests — a per-request agent paid a fresh TCP+TLS
/// handshake to the ship for every asset, which dominated remote loads
fn agent() -> &'static ureq::Agent {
    static A: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    A.get_or_init(|| ureq::AgentBuilder::new().redirects(0).build())
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
    // headers: keep what the page sent except hop-by-hop, host, cookies and
    // encoding (we want an identity body we can stream through untouched)
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
            "host" | "connection" | "cookie" | "accept-encoding" | "content-length"
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
