//! EyreTransport: the HTTP transport. Owner-gated loopback HTTP over an Eyre
//! login cookie, reusing the +code -> cookie flow (read once, keep only the
//! cookie, mode 600). Freshness uses the core's TTL poll (watch is a no-op).

use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use crate::transport::{TErr, Transport, MAX_BODY};

/// How much of an HTTP error body a TErr message may carry. The whole body is
/// what the ship wanted to say, but it can be an HTML error page, and this
/// string ends up in a shell line and in a served file. Enough for a page-save
/// 400 naming the field it rejected, short enough to stay one readable line.
const DETAIL_MAX: usize = 200;

/// The agent every ordinary request goes through: pooled connections (so a
/// mount's steady traffic isn't paying a fresh handshake per call), bounded
/// on CONNECT and on each socket read and write. Without them a dead pier, a
/// stale URL or a ship that stops mid-reply hangs a FUSE call forever: the
/// uninterruptible wedge mounts.rs's own comment warns about. The read bound
/// is per read, not per reply, so a slow-but-alive ship (a big page-dump, a
/// busy pier) still finishes. It matches lick's 120s deadline. The beacon
/// watch keeps its own agent with no read timeout, since it idles by design.
///
/// Never follows a redirect. The +code login and every cookie-bearing
/// request go through here, and a redirect could carry them to a host the
/// URL rule never checked. A 3xx comes back to do_req as an error instead.
fn req_agent() -> &'static ureq::Agent {
    static A: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    A.get_or_init(|| {
        let io = std::time::Duration::from_secs(120);
        ureq::AgentBuilder::new()
            .redirects(0)
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout_read(io)
            .timeout_write(io)
            .build()
    })
}

/// Where a ship URL points: scheme, host and port. The host is lower case,
/// with no IPv6 brackets and no trailing dot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

impl Origin {
    /// The cookie file for this origin: `cookie-<scheme>-<host>-<port>`. Any
    /// byte that is not safe in a file name becomes `_`.
    pub fn cookie_file_name(&self) -> String {
        let raw = format!("cookie-{}-{}-{}", self.scheme, self.host, self.port);
        raw.chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
            .collect()
    }
}

impl std::fmt::Display for Origin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.host.contains(':') {
            write!(f, "{}://[{}]:{}", self.scheme, self.host, self.port)
        } else {
            write!(f, "{}://{}:{}", self.scheme, self.host, self.port)
        }
    }
}

/// Split a ship URL into its origin. Only http and https are accepted.
pub fn origin_of(url: &str) -> Result<Origin, String> {
    let url = url.trim();
    // a browser or the url crate drops tab, CR and LF inside a URL, and
    // reads a backslash as a slash, so the host it connects to is not the
    // one a plain split sees: "http://8.8.8.8\x.local" went to 8.8.8.8 with
    // the +code in the clear (security audit run-1)
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("{url:?}: a ship URL may not hold spaces or control characters"));
    }
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| format!("{url:?} is not a ship URL (want https://host or http://host:port)"))?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "https" => 443,
        "http" => 80,
        _ => return Err(format!("{url:?}: the scheme must be http or https")),
    };
    let authority = rest.split(['/', '?', '#', '\\']).next().unwrap_or("");
    if authority.contains('@') {
        return Err(format!("{url:?}: a ship URL may not carry a user name or password"));
    }
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (h, after) = v6
            .split_once(']')
            .ok_or_else(|| format!("{url:?}: unclosed [ in the host"))?;
        match after {
            "" => (h, None),
            p => match p.strip_prefix(':') {
                Some(p) => (h, Some(p)),
                None => return Err(format!("{url:?}: junk after the IPv6 host")),
            },
        }
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    let port = match port {
        None | Some("") => default_port,
        Some(p) => p.parse().map_err(|_| format!("{url:?}: bad port {p:?}"))?,
    };
    let host = host.to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host).to_string();
    if host.is_empty() {
        return Err(format!("{url:?}: no host"));
    }
    Ok(Origin { scheme, host, port })
}

/// Whether plain http to this host stays on this machine or the local net:
/// loopback, a private or CGNAT (Tailscale) range, a ULA, or a `.local`,
/// `.localhost` or `.ts.net` name.
fn host_is_local(host: &str) -> bool {
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".ts.net")
    {
        return true;
    }
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        let [a, b, ..] = ip.octets();
        let cgnat = a == 100 && (b & 0xc0) == 64;
        return ip.is_loopback() || ip.is_private() || cgnat;
    }
    if let Ok(ip) = host.parse::<Ipv6Addr>() {
        let ula = (ip.segments()[0] & 0xfe00) == 0xfc00;
        return ip == Ipv6Addr::LOCALHOST || ula;
    }
    false
}

/// The ship URL rule, the same in every lattice client. https is always
/// fine. Plain http is fine only to a loopback or LAN host, because over
/// http the +code and the session cookie cross the wire in the clear.
pub fn check_ship_url(url: &str) -> Result<Origin, String> {
    let o = origin_of(url)?;
    if o.scheme == "https" || host_is_local(&o.host) {
        return Ok(o);
    }
    Err(format!(
        "refusing {url}: plain http to {} would send the +code and session cookie in the clear. \
         Use https, or a loopback/LAN address (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, \
         100.64-127.x, ::1, fc00::/7, *.local, *.ts.net)",
        o.host
    ))
}

/// The origin record that sits next to a cookie file. It names the one
/// origin the cookie belongs to.
fn record_path(cookie_path: &str) -> String {
    format!("{cookie_path}.origin")
}

/// The global cookie file name older builds used for every ship.
const LEGACY_NAME: &str = "cookie";

/// The cookie at `path`, if it may go to `o`. A record for another origin
/// always says no. With no record at all, a per-origin file is trusted,
/// since its caller chose it for this origin (the desktop shell keeps its
/// own per-origin files without records). The legacy global file is not:
/// with no record, nothing says which ship it came from.
fn read_cookie_for(path: &str, o: &Origin) -> Option<String> {
    match std::fs::read_to_string(record_path(path)) {
        Ok(rec) if rec.trim() != o.to_string() => return None,
        Ok(_) => {}
        Err(_) if Path::new(path).file_name()? == LEGACY_NAME => return None,
        Err(_) => {}
    }
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Load the cookie for origin `o`.
///
/// Migration. Older builds kept one global `cookie` file, whatever ship it
/// came from, so a changed URL sent one ship's session to another. Now each
/// origin has its own file, and store() writes an origin record next to
/// every cookie. If `path` has no usable cookie, the global `cookie` beside
/// it is read, but only when its record names this same origin. A global
/// cookie left by an older build has no record, so it is never reused. The
/// next `auth`, or a LATTICE_CODE re-login, writes a fresh one.
fn load_cookie(path: &str, o: &Origin) -> Option<String> {
    if let Some(c) = read_cookie_for(path, o) {
        return Some(c);
    }
    let legacy = Path::new(path).with_file_name(LEGACY_NAME);
    let legacy = legacy.to_str()?;
    if legacy == path {
        return None;
    }
    read_cookie_for(legacy, o)
}

/// Write `data` to `path` so that only the owner can ever read it.
///
/// The dir is made 0700 if it is new. The bytes go to a fresh temp file
/// (0600, O_NOFOLLOW, never an existing file), which is then renamed over
/// `path`. A reader sees the old file or the new one, never half of one, and
/// a symlink planted at `path` is replaced, not followed. Every error is
/// returned, so a cookie we could not lock down is never reported as stored.
fn write_private(path: &Path, data: &str) -> std::io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    let tmp = dir.join(format!(
        ".{}.{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let res = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)?;
        // the umask can only narrow the mode above, but pin it anyway, the
        // same 0600 an older build set on a file that was already there
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        f.write_all(data.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

pub struct EyreTransport {
    base: String, // bare Eyre base. Login is at /~/login
    // the URL rule's verdict on `base`. Every request checks it first, so a
    // refused URL never sees the +code or the cookie.
    origin: Result<Origin, String>,
    cookie: Mutex<Option<String>>,
    cookie_path: String,
    // Set by quiesce() so the background watch loop stops on unmount.
    stop: Arc<AtomicBool>,
    stop_wake: Arc<(Mutex<bool>, Condvar)>,
}

impl EyreTransport {
    pub fn new(base: &str, cookie_path: &str) -> Self {
        let origin = check_ship_url(base);
        let cookie = origin.as_ref().ok().and_then(|o| load_cookie(cookie_path, o));
        Self {
            base: base.trim_end_matches('/').to_string(),
            origin,
            cookie: Mutex::new(cookie),
            cookie_path: cookie_path.to_string(),
            stop: Arc::new(AtomicBool::new(false)),
            stop_wake: Arc::new((Mutex::new(false), Condvar::new())),
        }
    }

    /// Wait up to `dur` for `stop` to be set. Returns true if stopped.
    fn wait_stop(&self, dur: std::time::Duration) -> bool {
        if self.stop.load(Ordering::SeqCst) {
            return true;
        }
        let (lock, cv) = &*self.stop_wake;
        let g = lock.lock().unwrap();
        if *g || self.stop.load(Ordering::SeqCst) {
            return true;
        }
        let (g, _) = cv.wait_timeout(g, dur).unwrap();
        *g || self.stop.load(Ordering::SeqCst)
    }

    fn checked(&self) -> Result<&Origin, TErr> {
        self.origin.as_ref().map_err(|e| TErr::new(0, e.clone()))
    }

    /// POST /~/login with the +code. Keep only the derived urbauth cookie.
    ///
    /// Refused outright when the URL fails the ship URL rule. That also
    /// covers the silent re-login in do_req, so LATTICE_CODE is only ever
    /// sent to a URL that passed it. The agent follows no redirects, so the
    /// +code goes to this one URL and nowhere else.
    pub fn login(&self, code: Option<String>) -> Result<(), TErr> {
        self.checked()?;
        let code = code
            .or_else(|| std::env::var("LATTICE_CODE").ok())
            .ok_or_else(|| TErr::new(401, "no +code (set LATTICE_CODE or run `auth` on a tty)"))?;
        let body = format!("password={}", urlencode(code.trim()));
        let resp = req_agent()
            .post(&format!("{}/~/login", self.base))
            .set("Content-Type", "application/x-www-form-urlencoded")
            .send_string(&body);
        let resp = match resp {
            Ok(r) => r,
            Err(ureq::Error::Status(c, _)) => {
                return Err(TErr::new(c, "login failed — wrong +code?"))
            }
            Err(e) => return Err(TErr::new(0, format!("login error: {e}"))),
        };
        let cookies = resp.all("set-cookie");
        if cookies.is_empty() {
            return Err(TErr::new(500, "login: no Set-Cookie"));
        }
        let ck = cookies
            .into_iter()
            .filter_map(|sc| sc.split(';').next().map(str::trim))
            .find(|c| c.starts_with("urbauth-"))
            .ok_or_else(|| TErr::new(500, "login: no urbauth cookie"))?
            .to_string();
        self.store(&ck)
    }

    fn store(&self, ck: &str) -> Result<(), TErr> {
        let origin = self.checked()?.to_string();
        let werr = |e: std::io::Error| TErr::new(500, format!("cookie write: {e}"));
        // Drop the old origin record first. If we die part way, the new
        // cookie is left with no record, and so it is never sent. It is never
        // left under a record that names some other origin.
        let rec = record_path(&self.cookie_path);
        match std::fs::remove_file(&rec) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(werr(e)),
        }
        write_private(Path::new(&self.cookie_path), ck).map_err(werr)?;
        write_private(Path::new(&rec), &origin).map_err(werr)?;
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
        self.checked()?;
        let url = self.url(path, query);
        let cookie = self.cookie.lock().unwrap().clone().unwrap_or_default();
        let req = req_agent().request(method, &url).set("Cookie", &cookie);
        let resp = match body {
            Some(b) => req.set("Content-Type", "application/octet-stream").send_bytes(b),
            None => req.call(),
        };
        match resp {
            // the agent follows no redirects, so a 3xx lands here. Following
            // it by hand would send the cookie somewhere the URL rule never
            // looked, so it is an error. On Eyre's 307 login redirect, re-auth
            // once directly against /~/login when LATTICE_CODE is configured.
            Ok(r) if (300..400).contains(&r.status()) => {
                let code = r.status();
                if code == 307 && retry && has_lattice_code() {
                    self.login(None)?;
                    return self.do_req(method, path, query, body, false);
                }
                let to = r.header("location").unwrap_or("").to_string();
                Err(TErr::new(code, format!("http {code}: redirect to {to:?} not followed")))
            }
            Ok(r) => {
                // Read one byte past the cap, so an oversized reply is an error
                // and never a silently cut body.
                let mut buf = Vec::new();
                r.into_reader()
                    .take(MAX_BODY as u64 + 1)
                    .read_to_end(&mut buf)
                    .map_err(|e| TErr::new(0, format!("read: {e}")))?;
                if buf.len() > MAX_BODY {
                    return Err(TErr::new(0, format!("read: reply over {MAX_BODY} bytes")));
                }
                Ok(buf)
            }
            Err(ureq::Error::Status(code, resp)) => {
                if code == 401 && retry && has_lattice_code() {
                    self.login(None)?; // cookie expired. Re-auth once
                    return self.do_req(method, path, query, body, false);
                }
                // Carry the ship's own words. The message is printed verbatim by
                // the shell and by `errors`, and "http 400" says nothing when the
                // reply body names the field page-save rejected. lick already
                // returns the reply body as the message, so this keeps the two
                // transports saying the same kind of thing behind the trait.
                // Bounded, and on one line: an Eyre error page can be megabytes
                // of HTML, and generic.rs's dump() serves this string as the BODY
                // of the placeholder file it puts in place of an unreadable grub.
                let detail = resp.into_string().unwrap_or_default();
                let detail = detail.split_whitespace().collect::<Vec<_>>().join(" ");
                Err(TErr::new(
                    code,
                    if detail.is_empty() {
                        format!("http {code}")
                    } else if detail.chars().count() > DETAIL_MAX {
                        let head: String = detail.chars().take(DETAIL_MAX).collect();
                        format!("http {code}: {head}...")
                    } else {
                        format!("http {code}: {detail}")
                    },
                ))
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
    fn watch(&self, on_event: &(dyn Fn(crate::transport::WatchEvent) + Send + Sync)) {
        use crate::transport::WatchEvent as W;
        use std::io::BufRead;
        // a refused URL gets no stream and no cookie. The TTL poll still
        // runs, and every request it makes fails with the rule's message.
        if self.origin.is_err() {
            return;
        }
        let url = format!(
            "{}/grubbery/api/keep/apps/lattice.lattice_app/beacon/rev",
            self.base
        );
        // reconnect until stopped. The stream severs on ship restart, pier
        // hiccup, or an idle proxy; each of those is transient, and the TTL
        // poll covers the gap until we get back on. Down is what re-arms it.
        while !self.stop.load(Ordering::SeqCst) {
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
                    // ship down or stream refused. Back off, then retry.
                    on_event(W::Down);
                    if self.wait_stop(std::time::Duration::from_secs(5)) {
                        return;
                    }
                    continue;
                }
            };
            // Require a real 200 SSE stream. With redirects(0), a 307 login
            // redirect lands in Ok(r), and treating it as Up would silence the
            // TTL poll while no events ever arrive.
            let is_sse = resp.status() == 200
                && resp
                    .header("content-type")
                    .is_some_and(|ct| ct.to_ascii_lowercase().starts_with("text/event-stream"));
            if !is_sse {
                on_event(W::Down);
                if self.wait_stop(std::time::Duration::from_secs(5)) {
                    return;
                }
                continue;
            }
            if self.stop.load(Ordering::SeqCst) {
                return;
            }
            // Up only once the stream is actually open. Anything that bumped
            // during the gap before it is unseen, which is why the core
            // treats Up itself as a change.
            on_event(W::Up);
            let mut reader = std::io::BufReader::new(resp.into_reader());
            let mut line = String::new();
            let mut dirty = false;
            let mut name: Option<String> = None;
            while !self.stop.load(Ordering::SeqCst) {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,   // stream closed: reconnect
                    Ok(_) => {
                        let t = line.trim_end();
                        if t.is_empty() {
                            // blank line = end of one SSE event. Fire at most
                            // once per event, not once per field line.
                            if dirty && pages_changed(name.as_deref()) {
                                on_event(W::Changed);
                            }
                            dirty = false;
                            name = None;
                        } else if let Some(n) = t.strip_prefix("event:") {
                            name = Some(n.trim().to_string());
                            dirty = true;
                        } else if t.starts_with("data:") {
                            dirty = true;
                        }
                    }
                }
            }
            if self.stop.load(Ordering::SeqCst) {
                return;
            }
            if dirty && pages_changed(name.as_deref()) {
                on_event(W::Changed); // stream ended mid-event: keep the nudge
            }
            on_event(W::Down);
            if self.wait_stop(std::time::Duration::from_secs(2)) {
                return;
            }
        }
    }

    fn quiesce(&self, _bound: std::time::Duration) {
        self.stop.store(true, Ordering::SeqCst);
        let (lock, cv) = &*self.stop_wake;
        let mut g = lock.lock().unwrap();
        *g = true;
        cv.notify_all();
    }
}

fn has_lattice_code() -> bool {
    std::env::var("LATTICE_CODE").ok().is_some_and(|c| !c.trim().is_empty())
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

/// Whether one beacon event can mean a page changed. The keep streams the
/// whole /beacon directory, and its events are named after the grub that
/// moved ("upd /rev", "old /comments"). Comments and memories have beacons
/// of their own, and refetching every page for one of those only costs the
/// ship a full dump. Anything else, an unnamed event included, still counts.
fn pages_changed(name: Option<&str>) -> bool {
    !matches!(name, Some(n) if n.ends_with(" /comments") || n.ends_with(" /know"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn only_page_events_refresh_the_mount() {
        // memories and comments bump beacons of their own; a mount that
        // re-dumped every page for each of those paid a full dump per agent
        // memory save
        assert!(pages_changed(Some("upd /rev")));
        assert!(pages_changed(Some("old /rev")));
        assert!(!pages_changed(Some("upd /know")));
        assert!(!pages_changed(Some("old /know")));
        assert!(!pages_changed(Some("upd /comments")));
        // unknown or unnamed: assume it matters
        assert!(pages_changed(Some("upd /something-new")));
        assert!(pages_changed(None));
    }

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
        let t = EyreTransport::new("http://localhost", p.to_str().unwrap());
        assert!(t.ship().is_err(), "no cookie yet means no ship, not an empty name");

        t.store("urbauth-~tyr=0v1.abcde").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "urbauth-~tyr=0v1.abcde");
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a session cookie must not be readable by anyone else");
        let dmode = std::fs::metadata(p.parent().unwrap()).unwrap().permissions().mode() & 0o777;
        assert_eq!(dmode, 0o700, "a new cookie dir is the owner's alone");
        assert_eq!(
            std::fs::read_to_string(format!("{}.origin", p.display())).unwrap(),
            "http://localhost:80",
            "the cookie is tagged with the one origin it belongs to"
        );
        assert_eq!(t.ship().unwrap(), "~tyr");
        // and it is picked back up on the next run
        assert_eq!(
            EyreTransport::new("http://localhost", p.to_str().unwrap()).ship().unwrap(),
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

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn an_expired_cookie_re_authenticates_once_and_replays() {
        let _g = ENV_LOCK.lock().unwrap();
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
        std::env::remove_var("LATTICE_CODE");
        let seen = s.seen();
        assert_eq!(seen.len(), 3, "exactly one re-auth, then one replay");
        assert!(seen[1].starts_with("POST /~/login"), "a 401 must trigger a re-login");
        assert!(seen[2].starts_with("GET /x"), "and the original request must be replayed");
        assert_eq!(t.ship().unwrap(), "~tyr", "the fresh cookie is now in force");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn login_scans_all_set_cookie_headers_for_urbauth() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        std::thread::spawn(move || {
            if let Ok((mut sock, _)) = l.accept() {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf);
                let resp = concat!(
                    "HTTP/1.1 200 OK\r\n",
                    "Set-Cookie: cf_proxy=abc; Path=/\r\n",
                    "Set-Cookie: urbauth-~tyr=0vmulti; Path=/; HttpOnly\r\n",
                    "Content-Length: 0\r\n",
                    "Connection: close\r\n\r\n"
                );
                let _ = sock.write_all(resp.as_bytes());
            }
        });
        let dir = tmpdir("multi-cookie");
        let p = dir.join("cookie");
        let t = EyreTransport::new(&base, p.to_str().unwrap());
        t.login(Some("lidlut-tabwed".into())).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "urbauth-~tyr=0vmulti");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn do_req_preserves_403_body_and_only_reauths_401_or_307_with_lattice_code() {
        let _g = ENV_LOCK.lock().unwrap();
        let dir = tmpdir("auth-rules");

        // 403 must never trigger login or swallow its body, even when LATTICE_CODE is set.
        std::env::set_var("LATTICE_CODE", "lidlut-tabwed");
        let s403 = stub(vec![(403, "read-only link", None)]);
        let t403 = EyreTransport::new(&s403.base, dir.join("c403").to_str().unwrap());
        t403.store("urbauth-~tyr=0v1").unwrap();
        let e = t403.get_bytes("/x", &[]).unwrap_err();
        assert_eq!(e.code, 403);
        assert!(e.msg.contains("read-only link"), "{}", e.msg);
        assert_eq!(s403.seen().len(), 1, "403 must not call /~/login");

        // 307 with LATTICE_CODE set re-authenticates via /~/login and replays.
        let s307 = stub(vec![
            (307, "", Some("x=y\r\nLocation: /~/login")),
            (200, "", Some("urbauth-~tyr=0v307; Path=/")),
            (200, "after-307", None),
        ]);
        let t307 = EyreTransport::new(&s307.base, dir.join("c307").to_str().unwrap());
        t307.store("urbauth-~tyr=0vold").unwrap();
        assert_eq!(t307.get_bytes("/x", &[]).unwrap(), b"after-307");
        assert_eq!(s307.seen().len(), 3);

        // 401 without LATTICE_CODE returns the server's 401 without attempting login.
        std::env::remove_var("LATTICE_CODE");
        let s401 = stub(vec![(401, "session expired", None)]);
        let t401 = EyreTransport::new(&s401.base, dir.join("c401").to_str().unwrap());
        t401.store("urbauth-~tyr=0vold").unwrap();
        let e = t401.get_bytes("/x", &[]).unwrap_err();
        assert_eq!(e.code, 401);
        assert!(e.msg.contains("session expired"), "{}", e.msg);
        assert_eq!(s401.seen().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn watch_rejects_non_sse_responses_and_stops_on_quiesce() {
        use crate::transport::WatchEvent as W;
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let srv = std::thread::spawn(move || {
            // 1) 307 redirect to login must be treated as Down, never Up.
            if let Ok((mut sock, _)) = l.accept() {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf);
                let _ = sock.write_all(
                    b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /~/login\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });
        let dir = tmpdir("watch-307");
        let t = Arc::new(EyreTransport::new(&base, dir.join("c").to_str().unwrap()));
        t.store("urbauth-~tyr=0v1").unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let evs = events.clone();
        let t_stop = t.clone();
        let t_run = t.clone();
        let h = std::thread::spawn(move || {
            t_run.watch(&move |ev| {
                evs.lock().unwrap().push(ev);
                if ev == W::Down {
                    t_stop.quiesce(Duration::from_secs(1));
                }
            });
        });
        h.join().unwrap();
        srv.join().unwrap();
        assert_eq!(*events.lock().unwrap(), vec![W::Down], "307 must never emit Up");

        // 2) A real 200 text/event-stream emits Up, Changed, and exits on quiesce.
        let l2 = TcpListener::bind("127.0.0.1:0").unwrap();
        let base2 = format!("http://{}", l2.local_addr().unwrap());
        let srv2 = std::thread::spawn(move || {
            if let Ok((mut sock, _)) = l2.accept() {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf);
                let body = "event: upd /rev\ndata: 2\n\n";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes());
            }
        });
        let t2 = Arc::new(EyreTransport::new(&base2, dir.join("c2").to_str().unwrap()));
        t2.store("urbauth-~tyr=0v1").unwrap();
        let events2 = Arc::new(Mutex::new(Vec::new()));
        let evs2 = events2.clone();
        let t2_stop = t2.clone();
        let t2_run = t2.clone();
        let h2 = std::thread::spawn(move || {
            t2_run.watch(&move |ev| {
                evs2.lock().unwrap().push(ev);
                if ev == W::Changed {
                    t2_stop.quiesce(Duration::from_secs(1));
                }
            });
        });
        h2.join().unwrap();
        srv2.join().unwrap();
        assert_eq!(*events2.lock().unwrap(), vec![W::Up, W::Changed]);
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
        // and nothing else was asked: no login, no retry. Without this the
        // test caught a login only when it happened to fail for want of
        // LATTICE_CODE, which another test sets for the whole process
        assert_eq!(s.seen().len(), 1, "one request, no login: {:?}", s.seen());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_ship_url_rule_allows_https_and_local_http_only() {
        for ok in [
            "https://ship.example.com",
            "HTTPS://Ship.Example.com:8443/x",
            "http://localhost:8080",
            "http://LOCALHOST",
            "http://ship.localhost",
            "http://127.0.0.1:8080",
            "http://127.9.9.9",
            "http://10.1.2.3",
            "http://172.16.0.1",
            "http://172.31.255.255",
            "http://192.168.1.10:8080",
            "http://100.64.0.1",
            "http://100.127.255.255",
            "http://[::1]:8080",
            "http://[fc00::1]",
            "http://[FD12:3456::1]:80",
            "http://pier.local",
            "http://pier.local.",
            "http://ship.tail1234.ts.net",
        ] {
            assert!(check_ship_url(ok).is_ok(), "{ok} should pass: {:?}", check_ship_url(ok));
        }
        for bad in [
            "http://ship.example.com",
            "http://8.8.8.8",
            "http://172.32.0.1",
            "http://100.128.0.1",
            "http://[2001:db8::1]",
            "http://[::ffff:127.0.0.1]",
            "http://local",
            "http://evil.com/.local",
            "http://localhost.evil.com",
            "http://user@localhost",
            "ftp://localhost",
            "localhost:8080",
            "http://",
            "http://localhost:99999",
            // a backslash ends the host for a browser and the url crate
            "http://8.8.8.8\\x.local",
            "http://8.8.8.8:80\\x.local",
            "http://ship.example.com\\.local",
            "http://localhost\t.evil.com",
            "http://8.8.8.8\n.local",
            "http://8.8.8.8\r.local",
            "http://8.8.8.8 .local",
        ] {
            assert!(check_ship_url(bad).is_err(), "{bad:?} must be refused");
        }
        let e = check_ship_url("http://ship.example.com").unwrap_err();
        assert!(e.contains("Use https, or a loopback/LAN address"), "{e}");
    }

    // the host and port the rule judges must be the ones ureq connects to,
    // which come from the url crate. Every URL the rule accepts parses the
    // same way there.
    #[test]
    fn the_rule_reads_a_url_as_the_url_crate_does() {
        for u in [
            "https://ship.example.com",
            "HTTPS://Ship.Example.com:8443/x",
            "http://localhost:8080/apps",
            "http://127.0.0.1:8080?x",
            "http://[::1]:8080#f",
            "http://pier.local",
            "http://localhost\\x.example.com",
            "https://ship.example.com\\x",
        ] {
            let ours = check_ship_url(u).unwrap_or_else(|e| panic!("{u}: {e}"));
            let theirs = url::Url::parse(u).unwrap();
            let host = theirs.host_str().unwrap().trim_start_matches('[').trim_end_matches(']');
            assert_eq!(ours.host, host, "{u}");
            assert_eq!(ours.port, theirs.port_or_known_default().unwrap(), "{u}");
        }
    }

    #[test]
    fn a_refused_url_never_sees_the_code_or_the_cookie() {
        // no server behind it: the rule must refuse before any connect
        let dir = tmpdir("refused");
        let t = EyreTransport::new("http://ship.example.com", dir.join("cookie").to_str().unwrap());
        let e = t.login(Some("lidlut-tabwed".into())).unwrap_err();
        assert!(e.msg.contains("Use https"), "{}", e.msg);
        let e = t.get_bytes("/x", &[]).unwrap_err();
        assert!(e.msg.contains("Use https"), "{}", e.msg);
        assert!(t.store("urbauth-~tyr=0v1").is_err(), "and no cookie is ever stored for it");
        assert!(!dir.join("cookie").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cookie_is_only_sent_to_the_origin_that_minted_it() {
        let dir = tmpdir("origin");
        let p = dir.join("cookie-http-localhost-8080");
        let a = EyreTransport::new("http://localhost:8080", p.to_str().unwrap());
        a.store("urbauth-~tyr=0v1").unwrap();
        // the same file under another origin: its record says no
        let b = EyreTransport::new("http://127.0.0.1:8080", p.to_str().unwrap());
        assert!(b.ship().is_err(), "another origin must not pick the cookie up");

        // an old global cookie with no record is never reused
        let legacy = dir.join("cookie");
        std::fs::write(&legacy, "urbauth-~zod=0vold").unwrap();
        let c = EyreTransport::new("http://localhost:9090", dir.join("cookie-x").to_str().unwrap());
        assert!(c.ship().is_err(), "a legacy cookie with no origin record is not trusted");
        let g = EyreTransport::new("http://localhost:9090", legacy.to_str().unwrap());
        assert!(g.ship().is_err(), "not even through its own path");

        // but a global cookie whose record names this origin is reused, and
        // only by that origin
        g.store("urbauth-~zod=0vnew").unwrap();
        let d = EyreTransport::new("http://localhost:9090", dir.join("cookie-y").to_str().unwrap());
        assert_eq!(d.ship().unwrap(), "~zod", "the same origin may reuse the global cookie");
        let e = EyreTransport::new("http://localhost:9091", dir.join("cookie-z").to_str().unwrap());
        assert!(e.ship().is_err(), "a different port is a different origin");

        // a per-origin file with no record was picked for this origin by its
        // caller (the desktop shell writes these), so it is used
        let own = dir.join("cookie-http-localhost-7070");
        std::fs::write(&own, "urbauth-~nec=0v7").unwrap();
        let f = EyreTransport::new("http://localhost:7070", own.to_str().unwrap());
        assert_eq!(f.ship().unwrap(), "~nec");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_symlink_at_the_cookie_path_is_replaced_not_followed() {
        let dir = tmpdir("symlink");
        let target = dir.join("victim");
        std::fs::write(&target, "keep me").unwrap();
        let p = dir.join("cookie");
        std::os::unix::fs::symlink(&target, &p).unwrap();
        let t = EyreTransport::new("http://localhost", p.to_str().unwrap());
        t.store("urbauth-~tyr=0v1").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep me", "the link target is untouched");
        assert!(!std::fs::symlink_metadata(&p).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "urbauth-~tyr=0v1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unwritable_cookie_dir_is_an_error_not_a_silent_success() {
        let dir = tmpdir("ro");
        let sub = dir.join("locked");
        std::fs::create_dir(&sub).unwrap();
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o500)).unwrap();
        let t = EyreTransport::new("http://localhost", sub.join("cookie").to_str().unwrap());
        let r = t.store("urbauth-~tyr=0v1");
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o700)).unwrap();
        // root ignores the mode bits, so only a normal user can see the error
        if unsafe { libc::geteuid() } != 0 {
            assert!(r.is_err(), "a cookie we could not write must not count as stored");
            assert!(t.ship().is_err());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_redirect_is_never_followed_with_the_cookie() {
        // one reply only: if the agent followed the Location, it would hang
        // on a second connect that nobody answers, or reach another host
        let s = stub(vec![(302, "", Some("x=y\r\nLocation: /elsewhere"))]);
        let dir = tmpdir("redirect");
        let t = EyreTransport::new(&s.base, dir.join("cookie").to_str().unwrap());
        t.store("urbauth-~tyr=0v1").unwrap();
        let e = t.get_bytes("/x", &[]).unwrap_err();
        assert_eq!(e.code, 302, "{}", e.msg);
        assert!(e.msg.contains("not followed"), "{}", e.msg);
        assert_eq!(s.seen().len(), 1, "exactly one request: {:?}", s.seen());
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
