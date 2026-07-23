//! EyreTransport: the HTTP transport. Owner-gated loopback HTTP over an Eyre
//! login cookie, reusing the +code -> cookie flow (read once, keep only the
//! cookie, mode 600). Freshness uses the core's TTL poll (watch is a no-op).

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::sync::Mutex;

use crate::transport::{TErr, Transport};

pub struct EyreTransport {
    base: String, // bare Eyre base; login is at /~/login
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

    /// POST /~/login with the +code; keep only the derived urbauth cookie.
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
                    self.login(None)?; // cookie expired — re-auth once
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
