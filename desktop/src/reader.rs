//! The shipless reader's origin: a second loopback listener, at
//! 127.0.0.1:26520 (or the next free port up to 26535, stable for the same
//! storage reason as the bridge's), serving pages the urb engine reads.
//! The workspace window moves between the manager and this origin when no
//! ship is configured. It has no Tauri commands (capabilities/
//! workspace-remote.json grants the bridge's ports only).
//!
//! Routes, GET and HEAD only, but for one POST:
//!
//! - `/` the home: the start list and recent reads;
//! - `/read?url=urb://...` a page (a bare `~ship/path` works too);
//! - `/raw?url=&key=` a publisher's HTML for the sandboxed frame, from the
//!   read just made (`key` names it), never a second network read;
//! - `/assets/reader.js`, compiled in;
//! - `/boot?k=&to=` hands the window this launch's token as an HttpOnly
//!   cookie, as the bridge's bootstrap does, then goes to `to`;
//! - `POST /history/clear` empties the local history.
//!
//! Loopback is not a boundary (see proxy.rs), and here the prize is the
//! comet: a caller who could drive it could make it read whatever they
//! like. So every route that reads, or changes anything, needs this
//! launch's token cookie, and the request filter is the bridge's: Host
//! `127.0.0.1:<port>` or `localhost:<port>`, Origin absent or the reader's
//! own, and a request that is not same-origin only as a plain navigation
//! (no fetch, no subresource). Anything else is a 403 before the engine is
//! asked. The cookie rides top-level navigations (SameSite=Lax) so a link
//! clicked in a publisher's sandboxed frame opens in the reader; no other
//! browser has the cookie. Cookies are scoped by host and not by port, so
//! the bridge's cookie reaches this origin too: the reader's has its own
//! name and value, and the bridge never relays a cookie.
//!
//! `/raw` needs no cookie (a sandboxed frame has an opaque origin and gets
//! none), but its key is unguessable and comes only from the page the
//! reader just served, and its answer is lattice's `+sandbox-csp`.


use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::engine::{NativePage, ReadError, Reads};
use crate::history::History;
use crate::render::{self, Mode};

/// The port the reader listens on, once it does.
pub struct Reader(pub Mutex<Option<u16>>);

const PORT_BASE: u16 = 26520;
const PORT_SPAN: u16 = 16;
/// as the bridge: our own previous instance may still hold the port
const PORT_WAIT_MS: u64 = 3_000;
const PORT_POLL_MS: u64 = 100;

const TOKEN_COOKIE: &str = "lattice-reader";
/// Longest request line or header line, and most headers.
const MAX_LINE: u64 = 8 * 1024;
const MAX_HEADERS: usize = 100;
/// Longest request line: an address is short, so a long one is refused.
const MAX_TARGET: usize = 2048;
/// How many reads `/raw` can still answer for.
const RAWS: usize = 16;
/// A read that got no answer is tried this many times, a second apart,
/// within READ_TOTAL, as the extension tries.
const READ_TRIES: usize = 5;
const READ_TOTAL: Duration = Duration::from_secs(20);
/// The live start list may hold the home up this long.
const START_BUDGET: Duration = Duration::from_secs(3);

/// This launch's reader token: 32 bytes from the OS, hex, never on disk.
pub fn token() -> &'static str {
    static T: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        let mut b = [0u8; 32];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut b))
            .expect("no OS randomness for the reader token");
        b.iter().map(|x| format!("{x:02x}")).collect()
    })
}

fn same_secret(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Where the window goes first: the reader sets the token and goes to `to`,
/// a path on the reader.
pub fn boot_url(base: &str, to: &str) -> String {
    format!("{base}/boot?k={}&to={}", token(), render::enc(to))
}

/// What a page needs: the engine (or a test's stand-in), the history, and
/// the publisher HTML the last reads brought, by key.
pub struct Ctx {
    pub reads: Box<dyn Reads>,
    pub history: History,
    pub port: u16,
    raws: Mutex<VecDeque<(String, String, Vec<u8>)>>,
}

impl Ctx {
    pub fn new(reads: Box<dyn Reads>, history: History, port: u16) -> Ctx {
        Ctx { reads, history, port, raws: Mutex::new(VecDeque::new()) }
    }

    fn keep_raw(&self, url: &str, body: &[u8]) -> String {
        let mut b = [0u8; 16];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut b))
            .expect("no OS randomness");
        let key: String = b.iter().map(|x| format!("{x:02x}")).collect();
        let mut r = self.raws.lock().unwrap();
        r.push_back((key.clone(), url.to_string(), body.to_vec()));
        while r.len() > RAWS {
            r.pop_front();
        }
        key
    }

    fn raw(&self, url: &str, key: &str) -> Option<Vec<u8>> {
        let r = self.raws.lock().unwrap();
        r.iter()
            .find(|(k, u, _)| same_secret(k.as_bytes(), key.as_bytes()) && u == url)
            .map(|(_, _, b)| b.clone())
    }
}

/// One request, as far as the reader reads it.
#[derive(Debug, Default)]
struct Req {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    host: Option<String>,
    origin: Option<String>,
    site: Option<String>,
    mode: Option<String>,
    dest: Option<String>,
    referer: Option<String>,
    token: bool,
}

impl Req {
    fn arg(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// An answer.
#[derive(Debug)]
struct Resp {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        302 => "Found",
        303 => "See Other",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        414 => "URI Too Long",
        431 => "Request Header Fields Too Large",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    }
}

fn plain(status: u16) -> Resp {
    let r = reason(status);
    Resp {
        status,
        headers: vec![("Content-Type", "text/plain; charset=utf-8".into())],
        body: format!("{status} {r}").into_bytes(),
    }
}

fn shown(status: u16, s: render::Shown) -> Resp {
    Resp {
        status,
        headers: vec![
            ("Content-Type", "text/html; charset=utf-8".into()),
            ("Content-Security-Policy", s.csp.into()),
        ],
        body: s.html.into_bytes(),
    }
}

fn redirect(status: u16, to: &str) -> Resp {
    Resp { status, headers: vec![("Location", to.into())], body: Vec::new() }
}

/// `%XX` and `+` decoded, as a form sends them.
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match (b[i], b.get(i + 1).copied().and_then(hex), b.get(i + 2).copied().and_then(hex)) {
            (b'%', Some(h), Some(l)) => {
                out.push(h << 4 | l);
                i += 3;
            }
            (b'+', _, _) => {
                out.push(b' ');
                i += 1;
            }
            (c, _, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn read_capped(reader: &mut impl BufRead, out: &mut String) -> std::io::Result<bool> {
    out.clear();
    (&mut *reader).take(MAX_LINE + 1).read_line(out)?;
    Ok(out.len() as u64 <= MAX_LINE)
}

/// One request off the wire: `Err(status)` for one refused as it was read.
fn read_req(reader: &mut impl BufRead) -> std::io::Result<Result<Req, u16>> {
    let mut line = String::new();
    if !read_capped(reader, &mut line)? {
        return Ok(Err(414));
    }
    let mut parts = line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else { return Ok(Err(400)) };
    if target.len() > MAX_TARGET {
        return Ok(Err(414));
    }
    let (path, q) = target.split_once('?').unwrap_or((target, ""));
    let mut req = Req {
        method: method.to_string(),
        path: path.to_string(),
        query: q
            .split('&')
            .filter(|kv| !kv.is_empty())
            .map(|kv| {
                let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
                (unescape(k), unescape(v))
            })
            .collect(),
        ..Req::default()
    };
    let mut h = String::new();
    for n in 0.. {
        if !read_capped(reader, &mut h)? {
            return Ok(Err(431));
        }
        let l = h.trim_end();
        if l.is_empty() {
            break;
        }
        if n == MAX_HEADERS {
            return Ok(Err(431));
        }
        let Some((k, v)) = l.split_once(':') else { continue };
        let v = v.trim().to_string();
        match k.trim().to_ascii_lowercase().as_str() {
            "host" => req.host = Some(v),
            "origin" => req.origin = Some(v),
            "sec-fetch-site" => req.site = Some(v.to_ascii_lowercase()),
            "sec-fetch-mode" => req.mode = Some(v.to_ascii_lowercase()),
            "sec-fetch-dest" => req.dest = Some(v.to_ascii_lowercase()),
            "referer" => req.referer = Some(v),
            "cookie" => {
                req.token |= v.split(';').any(|kv| {
                    kv.trim()
                        .strip_prefix(TOKEN_COOKIE)
                        .and_then(|r| r.strip_prefix('='))
                        .is_some_and(|t| same_secret(t.as_bytes(), token().as_bytes()))
                })
            }
            _ => {}
        }
    }
    Ok(Ok(req))
}

fn is_reader(authority: &str, port: u16) -> bool {
    authority.eq_ignore_ascii_case(&format!("127.0.0.1:{port}"))
        || authority.eq_ignore_ascii_case(&format!("localhost:{port}"))
}

fn reader_origin(o: &str, port: u16) -> bool {
    o.strip_prefix("http://").is_some_and(|a| is_reader(a, port))
}

fn on_reader(referer: Option<&str>, port: u16) -> bool {
    referer
        .and_then(|r| r.strip_prefix("http://"))
        .and_then(|r| r.split(['/', '?', '#']).next())
        .is_some_and(|a| is_reader(a, port))
}

/// May this request drive the reader? See the module comment.
fn trusted(req: &Req, port: u16) -> bool {
    if !req.token || !req.origin.as_deref().is_none_or(|o| reader_origin(o, port)) {
        return false;
    }
    let same = req.site.as_deref().is_none_or(|s| s == "same-origin" || s == "none");
    let navigation = req.method == "GET"
        && req.mode.as_deref().is_none_or(|m| m == "navigate")
        && req.dest.as_deref().is_none_or(|d| d == "document");
    same || navigation
}

/// A plain path on the reader, for `/boot`'s `to`.
fn reader_path(to: &str) -> bool {
    to.starts_with('/') && !to.starts_with("//") && !to.bytes().any(|b| b < 0x20 || b == b'\\' || b == 0x7f)
}

/// The urb:// address a `/read` was given: as typed, or a bare
/// `~ship/path`, trimmed.
fn address(given: &str) -> String {
    let g = given.trim();
    if g.starts_with('~') {
        format!("urb://{g}")
    } else {
        g.to_string()
    }
}

fn handle(ctx: &Ctx, req: &Req) -> Resp {
    let port = ctx.port;
    if !req.host.as_deref().is_some_and(|h| is_reader(h, port)) {
        return plain(403);
    }
    let get = req.method == "GET" || req.method == "HEAD";
    match (req.path.as_str(), get) {
        ("/assets/reader.js", true) => Resp {
            status: 200,
            headers: vec![("Content-Type", "text/javascript; charset=utf-8".into())],
            body: render::JS.as_bytes().to_vec(),
        },
        ("/boot", true) => {
            let ok = req.arg("k").is_some_and(|k| same_secret(k.as_bytes(), token().as_bytes()))
                && req.arg("to").is_some_and(reader_path)
                && req.origin.is_none();
            if !ok {
                return plain(403);
            }
            let mut r = redirect(302, req.arg("to").unwrap_or("/"));
            r.headers.push((
                "Set-Cookie",
                format!("{TOKEN_COOKIE}={}; Path=/; HttpOnly; SameSite=Lax", token()),
            ));
            r
        }
        ("/raw", true) => {
            let framed = on_reader(req.referer.as_deref(), port)
                && req.origin.as_deref().is_none_or(|o| o == "null" || reader_origin(o, port));
            if !framed {
                return plain(403);
            }
            let (url, key) = (req.arg("url").unwrap_or(""), req.arg("key").unwrap_or(""));
            // the frame's source and nothing else: opened as a page of its
            // own, it goes back to the reader's page for it
            if req.dest.as_deref() == Some("document") && trusted(req, port) {
                return redirect(302, &render::read_href(url));
            }
            match ctx.raw(url, key) {
                Some(body) => Resp {
                    status: 200,
                    headers: vec![
                        ("Content-Type", "text/html; charset=utf-8".into()),
                        ("Content-Security-Policy", render::SANDBOX.into()),
                    ],
                    body: render::raw_html(&body),
                },
                None => plain(404),
            }
        }
        ("/" | "/read" | "/connect", true) | ("/history/clear", false) if !trusted(req, port) => plain(403),
        ("/history/clear", false) if req.method == "POST" => {
            if !req.origin.as_deref().is_some_and(|o| reader_origin(o, port)) {
                return plain(403);
            }
            if let Err(e) = ctx.history.clear() {
                crate::commands::dlog(&format!("reader: {e}"));
            }
            redirect(303, "/")
        }
        ("/", true) => {
            let live = ctx.reads.read(render::START_URL, START_BUDGET, false).ok();
            shown(200, render::home(live.as_ref(), &ctx.history.list()))
        }
        // the app's navigation policy shows the manager for this before it
        // loads (commands.rs); this is only what a stray request sees
        ("/connect", true) => redirect(302, "/"),
        ("/read", true) => read(ctx, req.arg("url").unwrap_or("")),
        (_, false) => plain(405),
        _ => plain(404),
    }
}

/// `/read`: the page, or why not.
fn read(ctx: &Ctx, given: &str) -> Resp {
    let url = address(given);
    if let Err((status, words)) = urb_render::gateway::de_urb(url.as_bytes()) {
        let mut s = render::bad_address(&url);
        if status != 400 {
            s.html = s.html.replace("That isn't an urb:// address.", &render_words(&words));
        }
        return shown(400, s);
    }
    let start = Instant::now();
    let mut tries = 0;
    let got = loop {
        tries += 1;
        let left = READ_TOTAL.saturating_sub(start.elapsed());
        match ctx.reads.read(&url, left.max(Duration::from_secs(1)), false) {
            Err(ReadError::Unreachable { later: true, .. })
                if tries < READ_TRIES && start.elapsed() + Duration::from_secs(1) < READ_TOTAL =>
            {
                std::thread::sleep(Duration::from_secs(1));
            }
            r => break r,
        }
    };
    match got {
        Ok(p) => page(ctx, &url, &p),
        Err(e) => {
            crate::commands::dlog(&format!("reader: {url}: {e:?}"));
            let (status, s) = render::error_page(&url, &e, Mode::Shipless, ctx.reads.step());
            shown(status, s)
        }
    }
}

fn render_words(words: &[u8]) -> String {
    String::from_utf8_lossy(&urb_render::gateway::html_escape(words)).into_owned()
}

fn page(ctx: &Ctx, url: &str, p: &NativePage) -> Resp {
    let html = urb_render::gateway::render_as(&p.mark, p.body.as_bytes()) == "html";
    let key = if html { ctx.keep_raw(url, p.body.as_bytes()) } else { String::new() };
    let s = render::page(url, p, Mode::Shipless, &key);
    if let Err(e) = ctx.history.add(url, &s.title) {
        crate::commands::dlog(&format!("reader: {e}"));
    }
    shown(200, s)
}

fn write_resp(c: &mut impl Write, r: &Resp, head: bool) -> std::io::Result<()> {
    write!(c, "HTTP/1.1 {} {}\r\n", r.status, reason(r.status))?;
    for (k, v) in &r.headers {
        write!(c, "{k}: {v}\r\n")?;
    }
    write!(
        c,
        "X-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nReferrer-Policy: same-origin\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        r.body.len()
    )?;
    if !head {
        c.write_all(&r.body)?;
    }
    c.flush()
}

/// One connection: one request, then close.
fn serve(ctx: &Ctx, c: TcpStream) -> std::io::Result<()> {
    c.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let mut reader = BufReader::new(c.try_clone()?);
    let resp = match read_req(&mut reader)? {
        Ok(req) => {
            crate::commands::dlog(&format!("reader: {} {}", req.method, req.path));
            let head = req.method == "HEAD";
            let r = handle(ctx, &req);
            let mut c = c;
            return write_resp(&mut c, &r, head);
        }
        Err(status) => plain(status),
    };
    let mut c = c;
    write_resp(&mut c, &resp, false)
}

fn bind_stable() -> Result<(TcpListener, u16), String> {
    let mut last = String::new();
    for _ in 0..(PORT_WAIT_MS / PORT_POLL_MS) {
        match TcpListener::bind(("127.0.0.1", PORT_BASE)) {
            Ok(l) => return Ok((l, PORT_BASE)),
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(Duration::from_millis(PORT_POLL_MS));
    }
    for port in PORT_BASE + 1..PORT_BASE + PORT_SPAN {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => return Ok((l, port)),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("reader bind: no free port in {PORT_BASE}..{}: {last}", PORT_BASE + PORT_SPAN))
}

/// Start the reader unless it runs. Its base url.
pub fn ensure(state: &Reader, make: impl FnOnce(u16) -> Ctx) -> Result<String, String> {
    let mut g = state.0.lock().unwrap();
    if let Some(port) = *g {
        return Ok(format!("http://127.0.0.1:{port}"));
    }
    let (listener, port) = bind_stable()?;
    crate::commands::dlog(&format!("reader: listening on 127.0.0.1:{port}"));
    let ctx = Arc::new(make(port));
    std::thread::Builder::new()
        .name("reader".into())
        .spawn(move || {
            for c in listener.incoming().flatten() {
                let ctx = ctx.clone();
                std::thread::spawn(move || {
                    let _ = serve(&ctx, c);
                });
            }
        })
        .map_err(|e| e.to_string())?;
    *g = Some(port);
    Ok(format!("http://127.0.0.1:{port}"))
}

/// Start the reader for this app, on its engine and history (both in
/// `<app_data_dir>/urb/`). Its base url.
pub fn start(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("urb");
    let engine = app.state::<crate::engine::Engine>().inner().clone();
    ensure(&app.state::<Reader>(), |port| Ctx::new(Box::new(engine), History::open(&dir), port))
}

/// The reader's port, if it listens.
pub fn port(state: &Reader) -> Option<u16> {
    *state.0.lock().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const PORT: u16 = 26599;

    type Answer = Box<dyn Fn(&str) -> Result<NativePage, ReadError> + Send + Sync>;

    /// a stand-in engine: the pages it has, and how often it was asked
    struct Fake {
        calls: Arc<AtomicUsize>,
        answer: Answer,
    }

    impl Reads for Fake {
        fn read(&self, url: &str, _: Duration, _: bool) -> Result<NativePage, ReadError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            (self.answer)(url)
        }
    }

    fn page_of(body: &str, mark: &str) -> NativePage {
        NativePage { key: "/k".into(), body: body.into(), mark: mark.into(), how: "keen".into() }
    }

    fn ctx(name: &str, answer: impl Fn(&str) -> Result<NativePage, ReadError> + Send + Sync + 'static) -> (Ctx, Arc<AtomicUsize>) {
        let dir = std::env::temp_dir().join(format!("reader-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let calls = Arc::new(AtomicUsize::new(0));
        let fake = Fake { calls: calls.clone(), answer: Box::new(answer) };
        (Ctx::new(Box::new(fake), History::open(&dir), PORT), calls)
    }

    fn pages(url: &str) -> Result<NativePage, ReadError> {
        match url {
            "urb://~zod/hello" => Ok(page_of("# Hello\n=> urb://~nec/x on", "gmi")),
            "urb://~zod/site" => Ok(page_of("<h1>site</h1><a href=\"urb://~nec/y\">y</a>", "html")),
            u => Err(ReadError::NotPublished(format!("{u} is not published"))),
        }
    }

    /// the response to raw request bytes, as the wire would carry it
    fn ask(ctx: &Ctx, raw: &str) -> (u16, String) {
        let mut reader = BufReader::new(raw.as_bytes());
        let mut out = Vec::new();
        match read_req(&mut reader).unwrap() {
            Ok(req) => write_resp(&mut out, &handle(ctx, &req), req.method == "HEAD").unwrap(),
            Err(s) => write_resp(&mut out, &plain(s), false).unwrap(),
        }
        let out = String::from_utf8_lossy(&out).into_owned();
        let status = out[9..12].parse().unwrap();
        (status, out)
    }

    fn get(path: &str, extra: &str) -> String {
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n{extra}\r\n")
    }

    fn cookie() -> String {
        format!("Cookie: other=1; {TOKEN_COOKIE}={}\r\n", token())
    }

    #[test]
    fn a_page_is_read_and_rendered_with_its_policy() {
        let (c, calls) = ctx("page", pages);
        let (st, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert_eq!(st, 200, "{out}");
        assert!(out.contains(&format!("Content-Security-Policy: {}\r\n", render::OWN)));
        assert!(out.contains("<h1>Hello</h1>") && out.contains("Connect a ship to bookmark"));
        assert!(out.contains("X-Content-Type-Options: nosniff"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(c.history.list()[0].url, "urb://~zod/hello");
        assert_eq!(c.history.list()[0].title, "Hello");
        // a bare ~ship/path is an address too
        let (st, _) = ask(&c, &get("/read?url=~zod/hello", &cookie()));
        assert_eq!(st, 200);
    }

    #[test]
    fn nothing_drives_the_engine_without_the_token() {
        let (c, calls) = ctx("token", pages);
        let other = format!("Cookie: {TOKEN_COOKIE}=nope\r\n");
        for extra in ["", other.as_str(), "Cookie: lattice-bridge=x\r\n"] {
            let (st, _) = ask(&c, &get("/read?url=urb://~zod/hello", extra));
            assert_eq!(st, 403);
            assert_eq!(ask(&c, &get("/", extra)).0, 403);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0, "the engine was asked");
    }

    #[test]
    fn foreign_callers_are_refused_before_the_engine() {
        let (c, calls) = ctx("foreign", pages);
        let ck = cookie();
        let cases = [
            // DNS rebinding: our socket under another name
            format!("GET /read?url=urb://~zod/hello HTTP/1.1\r\nHost: evil.example:{PORT}\r\n{ck}\r\n"),
            format!("GET /read?url=urb://~zod/hello HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{ck}\r\n", PORT + 1),
            get("/read?url=urb://~zod/hello", &format!("{ck}Origin: http://evil.example\r\n")),
            get("/read?url=urb://~zod/hello", &format!("{ck}Origin: http://127.0.0.1:26500\r\n")),
            // a cross-site fetch or subresource, even with the cookie
            get(
                "/read?url=urb://~zod/hello",
                &format!("{ck}Sec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: no-cors\r\nSec-Fetch-Dest: image\r\n"),
            ),
            get(
                "/read?url=urb://~zod/hello",
                &format!("{ck}Sec-Fetch-Site: same-site\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Dest: empty\r\n"),
            ),
        ];
        for raw in &cases {
            assert_eq!(ask(&c, raw).0, 403, "{raw}");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        // a link clicked in a sandboxed frame: a top-level navigation
        let nav = get(
            "/read?url=urb://~zod/hello",
            &format!("{ck}Sec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n"),
        );
        assert_eq!(ask(&c, &nav).0, 200);
    }

    #[test]
    fn the_sandboxed_frame_gets_the_read_just_made_under_the_sandbox() {
        let (c, calls) = ctx("raw", pages);
        let (_, out) = ask(&c, &get("/read?url=urb://~zod/site", &cookie()));
        assert!(out.contains(&format!("Content-Security-Policy: {}\r\n", render::FRAMED)));
        let src = out.split("<iframe").nth(1).unwrap().split("src=\"").nth(1).unwrap().split('"').next().unwrap().replace("&amp;", "&");
        assert!(src.starts_with("/raw?url=urb%3A%2F%2F~zod%2Fsite&key="), "{src}");
        // the frame: opaque origin, our Referer, no cookie
        let frame = get(
            &src,
            &format!(
                "Origin: null\r\nReferer: http://127.0.0.1:{PORT}/read?url=x\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Dest: iframe\r\n"
            ),
        );
        let (st, out) = ask(&c, &frame);
        assert_eq!(st, 200, "{out}");
        assert!(out.contains(&format!("Content-Security-Policy: {}\r\n", render::SANDBOX)));
        assert!(out.contains("<base target=\"_top\"><h1>site</h1><a href=\"/read?url=urb://~nec/y\">"));
        assert_eq!(calls.load(Ordering::SeqCst), 1, "/raw read again");
        // without our Referer, or with a key it never gave out, nothing
        assert_eq!(ask(&c, &get(&src, "")).0, 403);
        assert_eq!(ask(&c, &get(&src, "Referer: http://evil.example/\r\n")).0, 403);
        let wrong = format!("{}0", &src[..src.len() - 1]);
        assert_eq!(ask(&c, &get(&wrong, &format!("Referer: http://127.0.0.1:{PORT}/\r\n"))).0, 404);
    }

    #[test]
    fn only_get_and_head_and_the_history_clear() {
        let (c, calls) = ctx("methods", pages);
        let ck = cookie();
        let post = format!("POST /read?url=urb://~zod/hello HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n{ck}\r\n");
        assert_eq!(ask(&c, &post).0, 405);
        let head = format!("HEAD /read?url=urb://~zod/hello HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n{ck}\r\n");
        let (st, out) = ask(&c, &head);
        assert_eq!(st, 200);
        assert!(out.ends_with("\r\n\r\n"));
        c.history.add("urb://~zod/a", "A").unwrap();
        let clear = |o: &str| {
            format!("POST /history/clear HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n{ck}{o}Content-Length: 0\r\n\r\n")
        };
        assert_eq!(ask(&c, &clear("")).0, 403, "a clear with no Origin");
        assert_eq!(ask(&c, &clear("Origin: http://evil.example\r\n")).0, 403);
        assert_eq!(c.history.list().len(), 2);
        assert_eq!(ask(&c, &clear(&format!("Origin: http://127.0.0.1:{PORT}\r\n"))).0, 303);
        assert!(c.history.list().is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 1, "only the HEAD read");
    }

    #[test]
    fn a_bad_address_is_a_400_that_says_so() {
        let (c, calls) = ctx("bad", pages);
        let (st, out) = ask(&c, &get("/read?url=http%3A%2F%2Fexample.com", &cookie()));
        assert_eq!(st, 400);
        assert!(out.contains("That isn't an urb:// address"));
        let (st, out) = ask(&c, &get("/read?url=urb://~zod/forum/general", &cookie()));
        assert_eq!(st, 400);
        assert!(out.contains("lattice forum board"), "{out}");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn long_or_huge_requests_are_refused() {
        let (c, calls) = ctx("long", pages);
        let long = get(&format!("/read?url=urb://~zod/{}", "a".repeat(2100)), &cookie());
        assert_eq!(ask(&c, &long).0, 414);
        let headers: String = (0..101).map(|i| format!("X-{i}: y\r\n")).collect();
        assert_eq!(ask(&c, &get("/", &headers)).0, 431);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn no_answer_is_tried_again_then_said_plainly() {
        let (c, calls) = ctx("retry", |_| Err(ReadError::Unreachable { later: true, words: "~zod did not answer".into() }));
        let t = Instant::now();
        let (st, out) = ask(&c, &get("/read?url=urb://~zod/hello", &cookie()));
        assert_eq!(st, 504);
        assert!(out.contains("some networks block it") && out.contains("data-go=\"retry\""));
        assert_eq!(calls.load(Ordering::SeqCst), READ_TRIES);
        assert!(t.elapsed() < READ_TOTAL);
        let (c, calls) = ctx("notpub", pages);
        let (st, out) = ask(&c, &get("/read?url=urb://~zod/private", &cookie()));
        assert_eq!((st, calls.load(Ordering::SeqCst)), (404, 1));
        assert!(out.contains("connect the ship it was shared with"));
    }

    #[test]
    fn the_boot_hands_over_the_token_and_only_to_a_reader_path() {
        let (c, _) = ctx("boot", pages);
        let (st, out) = ask(&c, &get(&boot_url("", "/read?url=urb%3A%2F%2F~zod%2Fhello"), ""));
        assert_eq!(st, 302);
        assert!(out.contains("Location: /read?url=urb%3A%2F%2F~zod%2Fhello\r\n"), "{out}");
        assert!(out.contains(&format!("Set-Cookie: {TOKEN_COOKIE}={}; Path=/; HttpOnly; SameSite=Lax", token())));
        for to in ["//evil.example/", "http://evil.example/", "/a\r\nSet-Cookie: x", "\\evil"] {
            let (st, out) = ask(&c, &get(&format!("/boot?k={}&to={}", token(), render::enc(to)), ""));
            assert_eq!(st, 403, "{to}: {out}");
        }
        assert_eq!(ask(&c, &get("/boot?k=nope&to=/", "")).0, 403);
    }

    #[test]
    fn the_home_falls_back_to_the_compiled_start_list() {
        let (c, calls) = ctx("home", pages);
        let (st, out) = ask(&c, &get("/", &cookie()));
        assert_eq!(st, 200);
        assert!(out.contains("<h1>Start here</h1>"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn form_values_are_decoded() {
        assert_eq!(unescape("urb%3A%2F%2F~zod%2Fa+b"), "urb://~zod/a b");
        assert_eq!(unescape("100%"), "100%");
        assert_eq!(unescape("%zz%4"), "%zz%4");
        assert_eq!(unescape("%e2%9c%93"), "\u{2713}");
    }
}
