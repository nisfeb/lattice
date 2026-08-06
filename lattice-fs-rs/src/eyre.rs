//! EyreTransport: the HTTP transport. Owner-gated loopback HTTP over an Eyre
//! login cookie, reusing the +code -> cookie flow (read once, keep only the
//! cookie, mode 600). Freshness uses the core's TTL poll (watch is a no-op).

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::sync::Mutex;

use crate::transport::{TErr, Transport};

pub struct EyreTransport {
    base: String, // bare Eyre base. Login is at /~/login
    cookie: Mutex<Option<String>>,
    cookie_path: String,
}

impl EyreTransport {
    pub fn new(base: &str, cookie_path: &str) -> Self {
        let cookie = std::fs::read_to_string(cookie_path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Self {
            base: base.trim_end_matches('/').to_string(),
            cookie: Mutex::new(cookie),
            cookie_path: cookie_path.to_string(),
        }
    }

    /// POST /~/login with the +code. Keep only the derived urbauth cookie.
    pub fn login(&self, code: Option<String>) -> Result<(), TErr> {
        let code = code
            .or_else(|| std::env::var("LATTICE_CODE").ok())
            .ok_or_else(|| TErr::new(401, "no +code (set LATTICE_CODE or run `auth` on a tty)"))?;
        let body = format!("password={}", urlencode(code.trim()));
        let resp = ureq::post(&format!("{}/~/login", self.base))
            .set("Content-Type", "application/x-www-form-urlencoded")
            .send_string(&body);
        let resp = match resp {
            Ok(r) => r,
            Err(ureq::Error::Status(c, _)) => {
                return Err(TErr::new(c, "login failed — wrong +code?"))
            }
            Err(e) => return Err(TErr::new(0, format!("login error: {e}"))),
        };
        let sc = resp
            .header("set-cookie")
            .ok_or_else(|| TErr::new(500, "login: no Set-Cookie"))?;
        let ck = sc.split(';').next().unwrap_or("").to_string();
        if !ck.starts_with("urbauth-") {
            return Err(TErr::new(500, "login: no urbauth cookie"));
        }
        self.store(&ck)
    }

    fn store(&self, ck: &str) -> Result<(), TErr> {
        if let Some(dir) = std::path::Path::new(&self.cookie_path).parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&self.cookie_path, ck)
            .map_err(|e| TErr::new(500, format!("cookie write: {e}")))?;
        let _ = std::fs::set_permissions(&self.cookie_path, std::fs::Permissions::from_mode(0o600));
        *self.cookie.lock().unwrap() = Some(ck.to_string());
        Ok(())
    }

    fn url(&self, path: &str, query: &[(&str, &str)]) -> String {
        let mut u = format!("{}{}", self.base, path);
        if !query.is_empty() {
            u.push('?');
            let qs: Vec<String> = query
                .iter()
                .map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v)))
                .collect();
            u.push_str(&qs.join("&"));
        }
        u
    }

    fn do_req(
        &self,
        method: &str,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&[u8]>,
        retry: bool,
    ) -> Result<Vec<u8>, TErr> {
        let url = self.url(path, query);
        let cookie = self.cookie.lock().unwrap().clone().unwrap_or_default();
        let req = ureq::request(method, &url).set("Cookie", &cookie);
        let resp = match body {
            Some(b) => req.set("Content-Type", "application/octet-stream").send_bytes(b),
            None => req.call(),
        };
        match resp {
            Ok(r) => {
                let mut buf = Vec::new();
                r.into_reader()
                    .read_to_end(&mut buf)
                    .map_err(|e| TErr::new(0, format!("read: {e}")))?;
                Ok(buf)
            }
            Err(ureq::Error::Status(code, _)) => {
                if (code == 401 || code == 403) && retry {
                    self.login(None)?; // cookie expired. Re-auth once
                    return self.do_req(method, path, query, body, false);
                }
                Err(TErr::new(code, format!("http {code}")))
            }
            Err(e) => Err(TErr::new(0, format!("transport: {e}"))),
        }
    }
}

impl Transport for EyreTransport {
    fn get_bytes(&self, path: &str, query: &[(&str, &str)]) -> Result<Vec<u8>, TErr> {
        self.do_req("GET", path, query, None, true)
    }

    fn post(&self, path: &str, query: &[(&str, &str)], body: &[u8]) -> Result<Vec<u8>, TErr> {
        self.do_req("POST", path, query, Some(body), true)
    }

    fn ship(&self) -> Result<String, TErr> {
        let ck = self
            .cookie
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| TErr::new(401, "no cookie — run `auth`"))?;
        // urbauth-~tyr=0v... -> ~tyr
        let name = ck.split('=').next().unwrap_or("");
        Ok(name.trim_start_matches("urbauth-").to_string())
    }

    /// Push invalidation over the same beacon SSE the editor listens to.
    ///
    /// The writer bumps /beacon/rev on EVERY mutation — including a page-save
    /// that arrived over this very mount, and crucially including one that
    /// arrived over HTTP from the open editor. Without this the mount only
    /// ever learned about edits at the 5s TTL poll, so a save in the editor
    /// took up to five seconds to be visible in vim, and a grep right after a
    /// save read the pre-edit body. Subscribing here makes the mount react to
    /// the editor in milliseconds, the same nudge the editor already gets.
    ///
    /// Blocking, best-effort, and silently absent if the stream can't be held:
    /// the 5s TTL poll is still the guaranteed floor, so a dropped stream is a
    /// slowdown, never a staleness. The TTL poll being behind it is exactly
    /// why an SSE gap cannot wedge the filesystem.
    fn watch(&self, on_change: &(dyn Fn() + Send + Sync)) {
        use std::io::BufRead;
        let url = format!(
            "{}/grubbery/api/keep/apps/lattice.lattice_app/beacon/rev",
            self.base
        );
        // reconnect forever. The stream severs on ship restart, pier hiccup,
        // or an idle proxy; each of those is transient, and the TTL poll
        // covers the gap until we get back on.
        loop {
            let cookie = self.cookie.lock().unwrap().clone().unwrap_or_default();
            // a dedicated agent, CONNECT timeout only, never a read timeout:
            // the beacon holds an idle connection open for hours between
            // bumps, and a read timeout would sever it on every quiet stretch
            // (the exact failure proxy.rs's agent is built to avoid). Connect
            // is where a dead ship hangs, so that one stays bounded.
            let agent = ureq::AgentBuilder::new()
                .redirects(0)
                .timeout_connect(std::time::Duration::from_secs(10))
                .build();
            let req = agent
                .get(&url)
                .set("Cookie", &cookie)
                .set("Accept", "text/event-stream");
            let resp = match req.call() {
                Ok(r) => r,
                Err(_) => {
                    // ship down or stream refused. Back off, then retry — the
                    // TTL poll is the floor meanwhile.
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    continue;
                }
            };
            let mut reader = std::io::BufReader::new(resp.into_reader());
            let mut line = String::new();
            let mut dirty = false;
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,   // stream closed: reconnect
                    Ok(_) => {
                        let t = line.trim_end();
                        if t.is_empty() {
                            // blank line = end of one SSE event. Fire at most
                            // once per event, not once per field line.
                            if dirty {
                                on_change();
                                dirty = false;
                            }
                        } else if t.starts_with("data:") || t.starts_with("event:") {
                            dirty = true;
                        }
                    }
                }
            }
            if dirty {
                on_change();   // stream ended mid-event: don't drop the last nudge
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    }
}

/// Percent-encode everything but the RFC 3986 unreserved set (matches the
/// Python client's urllib.urlencode, which encodes `/` in query values too).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::io::Write as _;
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir()
            .join(format!("lattice-fs-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A throwaway HTTP server that answers `replies` in order, then stops.
    /// Each reply is (status, body, optional Set-Cookie).
    struct Stub {
        base: String,
        seen: Arc<Mutex<Vec<String>>>,
    }

    impl Stub {
        fn seen(&self) -> Vec<String> {
            self.seen.lock().unwrap().clone()
        }
    }

    fn stub(replies: Vec<(u16, &'static str, Option<&'static str>)>) -> Stub {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        std::thread::spawn(move || {
            for (code, body, cookie) in replies {
                let Ok((mut sock, _)) = l.accept() else { return };
                sock.set_read_timeout(Some(Duration::from_secs(5))).ok();
                // read the head, plus whatever body arrived with it
                let mut raw = Vec::new();
                let mut chunk = [0u8; 4096];
                while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => raw.extend_from_slice(&chunk[..n]),
                    }
                }
                // drain the declared body too, so an assertion can see it
                let text = String::from_utf8_lossy(&raw).to_string();
                let want: usize = text
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:")?.trim().parse().ok())
                    .unwrap_or(0);
                let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4).unwrap_or(raw.len());
                while raw.len() < head_end + want {
                    match sock.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => raw.extend_from_slice(&chunk[..n]),
                    }
                }
                let line = text.lines().next().unwrap_or("").to_string();
                let req_body = String::from_utf8_lossy(&raw[head_end.min(raw.len())..]).to_string();
                sink.lock().unwrap().push(format!("{line} {req_body}"));
                let ck = cookie.map(|c| format!("Set-Cookie: {c}\r\n")).unwrap_or_default();
                let resp = format!(
                    "HTTP/1.1 {code} S\r\nContent-Length: {}\r\n{ck}Connection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes());
                let _ = sock.flush();
                let _ = sock.shutdown(std::net::Shutdown::Both);
            }
        });
        Stub { base, seen }
    }

    #[test]
    fn url_appends_a_query_only_when_there_is_one() {
        let t = EyreTransport::new("http://host:8080/", "/nonexistent/cookie");
        assert_eq!(t.url("/x", &[]), "http://host:8080/x", "no query means no '?'");
        assert_eq!(
            t.url("/apps/lattice/page-source", &[("name", "a/b c"), ("type", "md")]),
            "http://host:8080/apps/lattice/page-source?name=a%2Fb%20c&type=md",
            "a page name must be encoded, '/' included"
        );
    }

    #[test]
    fn urlencode_passes_the_unreserved_set_through_untouched() {
        assert_eq!(urlencode("aZ0-_.~"), "aZ0-_.~");
        assert_eq!(urlencode("a/b c&d=e"), "a%2Fb%20c%26d%3De");
    }

    #[test]
    fn a_stored_cookie_is_owner_only_and_names_the_ship() {
        // the cookie IS the ship's session. World-readable would hand any local
        // process full owner authority.
        let dir = tmpdir("store");
        let p = dir.join("nested").join("cookie");
        let t = EyreTransport::new("http://host", p.to_str().unwrap());
        assert!(t.ship().is_err(), "no cookie yet means no ship, not an empty name");

        t.store("urbauth-~tyr=0v1.abcde").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "urbauth-~tyr=0v1.abcde");
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a session cookie must not be readable by anyone else");
        assert_eq!(t.ship().unwrap(), "~tyr");
        // and it is picked back up on the next run
        assert_eq!(
            EyreTransport::new("http://host", p.to_str().unwrap()).ship().unwrap(),
            "~tyr"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn login_keeps_only_the_urbauth_cookie_and_refuses_anything_else() {
        let s = stub(vec![
            (200, "", Some("urbauth-~tyr=0v1.abcde; Path=/; HttpOnly")),
            (200, "", Some("sessionid=not-urbauth; Path=/")),
            (403, "", None),
        ]);
        let dir = tmpdir("login");
        let p = dir.join("cookie");
        let t = EyreTransport::new(&s.base, p.to_str().unwrap());
        t.login(Some("lidlut-tabwed".into())).unwrap();
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            "urbauth-~tyr=0v1.abcde",
            "only the cookie itself, never its attributes"
        );
        assert!(s.seen()[0].starts_with("POST /~/login"));

        // a Set-Cookie that isn't an urbauth is not a session: refuse it rather
        // than store a useless cookie and fail every later request as a 401
        let t2 = EyreTransport::new(&s.base, dir.join("c2").to_str().unwrap());
        assert!(t2.login(Some("x".into())).is_err());
        assert!(!dir.join("c2").exists(), "a refused login must not write a cookie");

        // and a rejected +code surfaces the server's status
        let t3 = EyreTransport::new(&s.base, dir.join("c3").to_str().unwrap());
        assert_eq!(t3.login(Some("x".into())).unwrap_err().code, 403);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_expired_cookie_re_authenticates_once_and_replays() {
        let s = stub(vec![
            (401, "", None),                                  // the cookie went stale
            (200, "", Some("urbauth-~tyr=0vfresh; Path=/")),   // the silent re-login
            (200, "payload", None),                            // the replayed request
        ]);
        let dir = tmpdir("retry");
        let t = EyreTransport::new(&s.base, dir.join("cookie").to_str().unwrap());
        t.store("urbauth-~tyr=0vstale").unwrap();
        std::env::set_var("LATTICE_CODE", "lidlut-tabwed-pillex-ridrup");

        assert_eq!(t.get_bytes("/x", &[]).unwrap(), b"payload");
        let seen = s.seen();
        assert_eq!(seen.len(), 3, "exactly one re-auth, then one replay");
        assert!(seen[1].starts_with("POST /~/login"), "a 401 must trigger a re-login");
        assert!(seen[2].starts_with("GET /x"), "and the original request must be replayed");
        assert_eq!(t.ship().unwrap(), "~tyr", "the fresh cookie is now in force");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn post_puts_the_page_body_on_the_wire_and_returns_the_reply() {
        // a save whose body never reaches the ship is a silent data loss
        let s = stub(vec![(200, "saved", None)]);
        let dir = tmpdir("post");
        let t = EyreTransport::new(&s.base, dir.join("cookie").to_str().unwrap());
        t.store("urbauth-~tyr=0v1").unwrap();
        let got = t.post("/apps/lattice/page-save", &[("name", "n")], b"# the body").unwrap();
        assert_eq!(got, b"saved");
        assert_eq!(s.seen(), vec!["POST /apps/lattice/page-save?name=n HTTP/1.1 # the body"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_non_auth_status_reaches_the_caller_without_a_login_attempt() {
        // dump() depends on seeing a real 404 to fall back to list()+read(), and
        // hammering /~/login on every 404 would be both wrong and hostile.
        let s = stub(vec![(404, "", None)]);
        let dir = tmpdir("noretry");
        let t = EyreTransport::new(&s.base, dir.join("cookie").to_str().unwrap());
        t.store("urbauth-~tyr=0v1").unwrap();
        let e = t.get_bytes("/apps/lattice/page-dump", &[]).unwrap_err();
        assert_eq!(e.code, 404, "a 404 must reach the projection unchanged");
        let _ = std::fs::remove_dir_all(&dir);
    }

    proptest! {
        // every page name (any UTF-8 at all) must encode losslessly into the
        // unreserved set + %XX escapes, and decode back to the same bytes.
        // Anything else would corrupt a query value on the wire.
        #[test]
        fn urlencode_is_lossless_and_url_safe(s in ".*") {
            let e = urlencode(&s);
            let bytes = e.as_bytes();
            let mut decoded = Vec::new();
            let mut i = 0;
            while i < bytes.len() {
                match bytes[i] {
                    b'%' => {
                        prop_assert!(i + 2 < bytes.len(), "dangling %% in {}", e);
                        let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap();
                        decoded.push(u8::from_str_radix(hex, 16).expect("non-hex escape"));
                        i += 3;
                    }
                    b @ (b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~') => {
                        decoded.push(b);
                        i += 1;
                    }
                    other => prop_assert!(false, "reserved byte {other:#x} leaked into {}", e),
                }
            }
            prop_assert_eq!(decoded, s.as_bytes());
        }
    }
}
