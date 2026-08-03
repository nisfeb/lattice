//! A stub ship for tests: a real localhost HTTP server that records exactly
//! what arrived on the wire and answers whatever the test tells it to.
//!
//! Everything the desktop shell talks to over HTTP (the bridge's upstream, the
//! stack probe, %mcp) takes a base URL, so a stub is enough to assert what we
//! actually send and what we do with the answer. No ship, no network, no fuse.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

/// one request as it really arrived
#[derive(Clone)]
pub struct Seen {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Seen {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    pub fn body_str(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    /// every header value, for "this must never appear anywhere" assertions
    pub fn header_blob(&self) -> String {
        self.headers
            .iter()
            .map(|(k, v)| format!("{k}: {v}\n"))
            .collect()
    }
}

pub struct Stub {
    /// `http://127.0.0.1:<port>`, for anything that takes a ship base
    pub base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Stub {
    /// Answer every request with `reply(request) -> (status, body)`.
    pub fn new(reply: impl Fn(&Seen) -> (u16, String) + Send + Sync + 'static) -> Stub {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let reply = Arc::new(reply);
        // one thread per connection: the bridge pre-warms in the background,
        // so requests can overlap and must not head-of-line block each other
        std::thread::spawn(move || {
            for conn in listener.incoming().flatten() {
                let (log, reply) = (log.clone(), reply.clone());
                std::thread::spawn(move || {
                    let Ok(dup) = conn.try_clone() else { return };
                    let Some(req) = read_request(&mut BufReader::new(dup)) else { return };
                    let (status, body) = reply(&req);
                    log.lock().unwrap().push(req);
                    let mut c = conn;
                    let loc = if (300..400).contains(&status) {
                        // eyre redirects an unbound path to landscape
                        "Location: /apps/landscape/\r\n"
                    } else {
                        ""
                    };
                    let _ = write!(
                        c,
                        "HTTP/1.1 {status} {}\r\n{loc}Content-Type: text/plain\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n",
                        reason(status),
                        body.len()
                    );
                    let _ = c.write_all(body.as_bytes());
                    let _ = c.flush();
                });
            }
        });
        Stub { base, seen }
    }

    pub fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// The single request this stub was meant to get. Panics on zero, so a
    /// test whose subject silently sent nothing cannot pass by accident.
    pub fn only(&self) -> Seen {
        let r = self.requests();
        assert_eq!(r.len(), 1, "expected exactly one request, got {:?}", targets(&r));
        r.into_iter().next().unwrap()
    }

    /// The request for `target`. Panics if it never arrived.
    pub fn got(&self, target: &str) -> Seen {
        let r = self.requests();
        r.iter()
            .find(|s| s.target == target)
            .unwrap_or_else(|| panic!("never asked for {target}; asked for {:?}", targets(&r)))
            .clone()
    }

    pub fn asked_for(&self, target: &str) -> bool {
        self.requests().iter().any(|s| s.target == target)
    }
}

fn targets(r: &[Seen]) -> Vec<String> {
    r.iter().map(|s| s.target.clone()).collect()
}

fn read_request(r: &mut BufReader<std::net::TcpStream>) -> Option<Seen> {
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next()?.to_string(), parts.next()?.to_string());
    let mut headers = Vec::new();
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        r.read_line(&mut h).ok()?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        let Some((k, v)) = h.split_once(':') else { continue };
        let (k, v) = (k.trim().to_string(), v.trim().to_string());
        if k.eq_ignore_ascii_case("content-length") {
            len = v.parse().unwrap_or(0);
        }
        headers.push((k, v));
    }
    let mut body = vec![0u8; len];
    if len > 0 && r.read_exact(&mut body).is_err() {
        body.clear();
    }
    Some(Seen { method, target, headers, body })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        307 => "Temporary Redirect",
        403 => "Forbidden",
        404 => "Not Found",
        406 => "Not Acceptable",
        _ => "Status",
    }
}
