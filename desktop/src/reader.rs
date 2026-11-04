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
//! - `/read?url=...&fresh=1` and `/?fresh=1` a reload: what the engine
//!   keeps for the page's ship goes (`Reads::expire`), then the plain
//!   address, so back and forward to it read as any visit does. A request
//!   the webview marks as a reload (`Cache-Control: max-age=0` or
//!   `no-cache`, as its own reload sends) is fresh too, read in place.
//!   Either is fresh only from the reader's own pages (`own_page`): a
//!   publisher's sandboxed frame can navigate the window on a click, and
//!   such a request is read as a plain visit;
//! - `/raw?url=&key=` a publisher's HTML for the sandboxed frame, from the
//!   read just made (`key` names it), never a second network read;
//! - `/assets/reader.js`, compiled in;
//! - `/boot?k=&to=` hands the window this launch's token as an HttpOnly
//!   cookie, as the bridge's bootstrap does, then goes to `to`;
//! - `POST /history/clear` empties the local history;
//! - `POST /comment?url=` sends the form's `body` as a comment on that
//!   page, as the reader identity (engine.rs), then goes back to the page,
//!   which says what became of it;
//! - `POST /forum?url=` starts a post (`title`, `link`, `body`) on a
//!   lattice forum board, or a reply (`body`) in one of its threads, as
//!   the reader identity, on a board whose host lists it as taking them,
//!   then goes back to the board or thread, which says what became of it.
//!
//! Loopback is not a boundary (see proxy.rs), and here the prize is the
//! comet: a caller who could drive it could make it read whatever they
//! like, or comment and post as it. The POSTs need the reader's own Origin, so
//! a publisher's sandboxed frame (Origin `null`) cannot comment either. So every route that reads, or changes anything, needs this
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


use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::engine::{CometMode, Comets, CommentError, NativePage, Opened, ReadError, Reads};
use crate::history::History;
use crate::render::{self, Mode, Note, Open, Talk};

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
/// Longest request body: a forum post, its fields percent-encoded (three
/// bytes for each byte at most), and a little more. A comment is smaller.
const MAX_BODY: usize = 3 * (crate::boards::TITLE_MAX + crate::boards::LINK_MAX + crate::boards::TEXT_MAX) + 1024;
/// How long a comment may wait for the publisher's answer.
const COMMENT_BUDGET: Duration = Duration::from_secs(20);
/// The live start list may hold the home up this long.
const START_BUDGET: Duration = Duration::from_secs(3);
/// What the live start list's read gave (the page, or that there was
/// none) is kept this long, so a publisher that is slow or has no list
/// does not hold up every visit to the home.
const START_TTL: Duration = Duration::from_secs(600);
/// A start list read that failed is kept only this long: a comet's first
/// contact with the publisher can take two minutes, and the home shows
/// the live list as soon as that is done.
const START_FAIL_TTL: Duration = Duration::from_secs(20);
/// A publisher's list of the pages that take comments is kept this long,
/// as the engine keeps its revision list; a reload drops it. When the
/// list could not be had, for a shorter time.
const OPEN_TTL: Duration = Duration::from_secs(60);
const OPEN_FAIL_TTL: Duration = Duration::from_secs(20);
/// How long the list may hold up a page (it is read after the page, on
/// the flow the read opened, so it is quick when it comes at all).
const OPEN_BUDGET: Duration = Duration::from_secs(6);
/// each forum host's boards that take comet posts (`Ctx::forum_open`)
type Forums = HashMap<String, (Instant, Option<Vec<String>>)>;
/// each publisher's list (`Ctx::open`), and when it was asked for
type Opens = HashMap<String, (Instant, Option<Opened>)>;

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
    start: Mutex<Option<(Instant, Option<NativePage>)>>,
    /// what became of the last comment, for the page it was on, shown once
    note: Mutex<Option<(String, Note)>>,
    /// each publisher's pages that take comments, when it was asked
    opens: Mutex<Opens>,
    /// each forum host's boards that take comet posts, when it was asked
    forums: Mutex<Forums>,
}

impl Ctx {
    pub fn new(reads: Box<dyn Reads>, history: History, port: u16) -> Ctx {
        Ctx {
            reads,
            history,
            port,
            raws: Mutex::new(VecDeque::new()),
            start: Mutex::new(None),
            note: Mutex::new(None),
            opens: Mutex::new(HashMap::new()),
            forums: Mutex::new(HashMap::new()),
        }
    }

    /// Does `host`'s forum board `board` take the reader's posts? From the
    /// list kept for `host`, or asked for now when that is stale or
    /// `fresh`. `None` when the host does not say.
    pub fn forum_open(&self, host: &str, board: &str, fresh: bool) -> Option<bool> {
        let kept = self.forums.lock().unwrap().get(host).cloned();
        let list = match kept {
            Some((at, l)) if !fresh && at.elapsed() < if l.is_some() { OPEN_TTL } else { OPEN_FAIL_TTL } => l,
            _ => {
                let l = self.reads.forum_open(host, OPEN_BUDGET);
                self.forums.lock().unwrap().insert(host.to_string(), (Instant::now(), l.clone()));
                l
            }
        };
        list.map(|l| l.iter().any(|n| n == board))
    }

    /// Does the page `key` of `ship` take comments, and how does it take a
    /// comet's? From the lists kept for `ship`, or asked for now when they
    /// are stale or `fresh`. A page `/pub/comets` does not name is open.
    fn open(&self, ship: &str, key: &str, fresh: bool) -> (Open, Comets) {
        let kept = self.opens.lock().unwrap().get(ship).cloned();
        let list = match kept {
            Some((at, l)) if !fresh && at.elapsed() < if l.is_some() { OPEN_TTL } else { OPEN_FAIL_TTL } => l,
            _ => {
                let l = self.reads.comments_open(ship, OPEN_BUDGET);
                self.opens.lock().unwrap().insert(ship.to_string(), (Instant::now(), l.clone()));
                l
            }
        };
        let Some(l) = list else { return (Open::Unknown, Comets::default()) };
        let open = if l.names.iter().any(|n| same_page(n, key)) { Open::Yes } else { Open::No };
        let comets = l.comets.iter().find(|(n, _)| same_page(n, key)).map_or_else(Comets::default, |(_, c)| *c);
        (open, comets)
    }

    /// The note for `url`, once.
    pub fn take_note(&self, url: &str) -> Option<Note> {
        let mut g = self.note.lock().unwrap();
        if g.as_ref().is_some_and(|(u, _)| u == url) {
            return g.take().map(|(_, n)| n);
        }
        None
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

    /// The live start list, read at most once per START_TTL. A read that
    /// found the engine still starting is not kept.
    fn start_list(&self, fresh: bool) -> Option<NativePage> {
        if fresh {
            self.reads.expire(render::START_URL);
            *self.start.lock().unwrap() = None;
        }
        if let Some((at, p)) = &*self.start.lock().unwrap() {
            if at.elapsed() < if p.is_some() { START_TTL } else { START_FAIL_TTL } {
                return p.clone();
            }
        }
        let got = self.reads.read(render::START_URL, START_BUDGET, false);
        let p = got.as_ref().ok().cloned();
        if !matches!(got, Err(ReadError::Booting)) {
            *self.start.lock().unwrap() = Some((Instant::now(), p.clone()));
        }
        p
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
    /// the webview's own reload (see the module comment)
    reload: bool,
    length: Option<usize>,
    body: Vec<u8>,
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
        413 => "Content Too Large",
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
            "cache-control" | "pragma" => {
                let v = v.to_ascii_lowercase();
                req.reload |= v.split(',').any(|d| matches!(d.trim(), "no-cache" | "max-age=0"));
            }
            "content-length" => match v.parse::<usize>() {
                Ok(n) => req.length = Some(n),
                Err(_) => return Ok(Err(400)),
            },
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
    // a body is read only for a POST, and only up to the cap
    if req.method == "POST" {
        let n = req.length.unwrap_or(0);
        if n > MAX_BODY {
            return Ok(Err(413));
        }
        req.body = vec![0; n];
        reader.read_exact(&mut req.body)?;
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
        ("/" | "/read" | "/connect", true) | ("/history/clear" | "/comment" | "/forum", false) if !trusted(req, port) => plain(403),
        ("/forum", false) if req.method == "POST" => {
            if !req.origin.as_deref().is_some_and(|o| reader_origin(o, port)) {
                return plain(403);
            }
            forum_write(ctx, req)
        }
        ("/comment", false) if req.method == "POST" => {
            if !req.origin.as_deref().is_some_and(|o| reader_origin(o, port)) {
                return plain(403);
            }
            comment(ctx, req)
        }
        ("/history/clear", false) if req.method == "POST" => {
            if !req.origin.as_deref().is_some_and(|o| reader_origin(o, port)) {
                return plain(403);
            }
            if let Err(e) = ctx.history.clear() {
                crate::commands::dlog(&format!("reader: {e}"));
            }
            redirect(303, "/")
        }
        ("/", true) if Fresh::of(req, port) == Fresh::Asked => {
            ctx.start_list(true);
            redirect(303, "/")
        }
        ("/", true) => {
            let live = ctx.start_list(Fresh::of(req, port) == Fresh::Reload);
            let html = live.as_ref().is_some_and(|p| urb_render::gateway::render_as(&p.mark, p.body.as_bytes()) == "html");
            let key = match &live {
                Some(p) if html => ctx.keep_raw(render::START_URL, p.body.as_bytes()),
                _ => String::new(),
            };
            shown(200, render::home(live.as_ref(), &key, &ctx.history.list()))
        }
        // the app's navigation policy shows the manager for this before it
        // loads (commands.rs); this is only what a stray request sees
        ("/connect", true) => redirect(302, "/"),
        ("/read", true) => read(ctx, req.arg("url").unwrap_or(""), Fresh::of(req, port)),
        (_, false) => plain(405),
        _ => plain(404),
    }
}

/// The form's `body` field, cut to lattice's cap on a character boundary.
fn form_body(raw: &[u8]) -> String {
    form_field(raw, "body", render::COMMENT_MAX)
}

/// A form field, cut to `max` bytes on a character boundary.
fn form_field(raw: &[u8], name: &str, max: usize) -> String {
    let text = String::from_utf8_lossy(raw);
    let v = text
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| unescape(k) == name)
        .map(|(_, v)| unescape(v))
        .unwrap_or_default();
    let mut end = v.len().min(max);
    while !v.is_char_boundary(end) {
        end -= 1;
    }
    v[..end].to_string()
}

/// `POST /forum`: a post on a lattice forum board, or a reply in one of
/// its threads, sent as the reader identity, then back to the board or
/// thread, which says what became of it. Only where the host lists the
/// board as taking comet posts, asked again now; a furum board takes
/// none.
fn forum_write(ctx: &Ctx, req: &Req) -> Resp {
    use crate::boards::{App, LINK_MAX, TEXT_MAX, TITLE_MAX};
    use crate::engine::ForumWrite;
    let url = address(req.arg("url").unwrap_or(""));
    let Some(p) = crate::boards::place(&url).filter(|p| p.app == App::Forum) else { return plain(400) };
    let body = form_field(&req.body, "body", TEXT_MAX);
    let w = match &p.post {
        None => {
            let title = form_field(&req.body, "title", TITLE_MAX);
            let link = form_field(&req.body, "link", LINK_MAX);
            let some = |t: String| (!t.trim().is_empty()).then_some(t);
            some(title.trim().to_string()).map(|title| ForumWrite::Post {
                board: p.board.clone(),
                title,
                url: some(link.trim().to_string()),
                body: some(body.clone()),
            })
        }
        Some(_) => match (crate::boards::post_id(&p), body.trim().is_empty()) {
            (Some(post), false) => Some(ForumWrite::Reply { board: p.board.clone(), post, parent: None, body: body.clone() }),
            (None, _) => return plain(400),
            _ => None,
        },
    };
    let note = match w {
        None => Note::Empty,
        Some(w) => match ctx.forum_open(&p.host, &p.board, true) {
            Some(true) => match ctx.reads.forum_write(&p.host, w, COMMENT_BUDGET) {
                Ok(()) => Note::Sent,
                Err(CommentError::Refused(words)) => Note::Refused { words, body },
                Err(CommentError::Unanswered(words)) => Note::Unanswered { words, body },
                Err(CommentError::Failed(words)) => Note::Failed { words, body },
            },
            _ => Note::Closed { body },
        },
    };
    let outcome = match &note {
        Note::Sent | Note::Posted | Note::Held => "sent".to_string(),
        Note::Closed { .. } | Note::CometsOff { .. } | Note::Full { .. } => "board closed to comets".to_string(),
        Note::Empty => "empty".to_string(),
        Note::Refused { words, .. } => format!("refused: {words}"),
        Note::Unanswered { words, .. } => format!("unanswered: {words}"),
        Note::Failed { words, .. } => format!("failed: {words}"),
    };
    crate::commands::dlog(&format!("reader: forum write on {url}: {outcome}"));
    // the board's own address, so the note meets the page it goes back to
    let back = match &p.post {
        None => p.board_url(),
        Some(id) => p.thread_url(id),
    };
    if note == Note::Sent {
        ctx.reads.expire(&back);
    }
    *ctx.note.lock().unwrap() = Some((back.clone(), note));
    redirect(303, &render::read_href(&back))
}

/// Do a list's name and a read's key name the same page? Each is the path
/// the publisher keeps it at, with or without its leading slash.
/// The minutes, rounded up, until a page's cap of comets' comments frees,
/// while it is at the cap now. A time that has passed is no cap: the
/// window rolled over and the page is open again.
fn full_mins(c: &Comets) -> Option<u64> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    c.full_until.filter(|&u| u > now).map(|u| (u - now).div_ceil(60).max(1))
}

fn same_page(name: &str, key: &str) -> bool {
    !key.is_empty() && name.trim_start_matches('/') == key.trim_start_matches('/')
}

/// `POST /comment`: the comment, sent as the reader identity, then back to
/// the page, which says what became of it. The page is read again first
/// (the read is warm by now) for its key, which is the path the publisher
/// keeps it at; the form's own word for the page is never trusted.
fn comment(ctx: &Ctx, req: &Req) -> Resp {
    let url = address(req.arg("url").unwrap_or(""));
    let Some(ship) = render::commentable(&url) else { return plain(400) };
    let body = form_body(&req.body);
    let note = if body.trim().is_empty() {
        Note::Empty
    } else {
        match ctx.reads.read(&url, COMMENT_BUDGET, false) {
            Err(e) => Note::Failed { words: format!("The page couldn't be read again: {}", read_words(&e)), body },
            // asked again, not kept: a comment said to be posted must be
            // one the page takes now
            Ok(p) => match ctx.open(&ship, &p.key, true) {
                (Open::No, _) => Note::Closed { body },
                (_, c) if c.mode == CometMode::Off => Note::CometsOff { body },
                (_, c) if full_mins(&c).is_some() => Note::Full { mins: full_mins(&c).unwrap_or(1), body },
                (open, c) => match ctx.reads.comment(&ship, &p.key, &body, COMMENT_BUDGET) {
                    // the publisher turns a comet over the cap away without
                    // a word, and says so in /pub/comets: ask again before
                    // calling it posted
                    Ok(()) => match full_mins(&ctx.open(&ship, &p.key, true).1) {
                        Some(mins) => Note::Full { mins, body },
                        None if c.mode == CometMode::Held => Note::Held,
                        None if open == Open::Yes => Note::Posted,
                        None => Note::Sent,
                    },
                    Err(CommentError::Refused(words)) => Note::Refused { words, body },
                    Err(CommentError::Unanswered(words)) => Note::Unanswered { words, body },
                    Err(CommentError::Failed(words)) => Note::Failed { words, body },
                },
            },
        }
    };
    // the outcome, never the text
    let outcome = match &note {
        Note::Posted => "posted".to_string(),
        Note::Sent => "sent".to_string(),
        Note::Held => "held for review".to_string(),
        Note::Closed { .. } => "comments off".to_string(),
        Note::CometsOff { .. } => "anonymous comments off".to_string(),
        Note::Full { .. } => "anonymous comments full".to_string(),
        Note::Empty => "empty".to_string(),
        Note::Refused { words, .. } => format!("refused: {words}"),
        Note::Unanswered { words, .. } => format!("unanswered: {words}"),
        Note::Failed { words, .. } => format!("failed: {words}"),
    };
    crate::commands::dlog(&format!("reader: comment on {url}: {outcome}"));
    *ctx.note.lock().unwrap() = Some((url.clone(), note));
    redirect(303, &render::read_href(&url))
}

/// A failed read, in a line.
fn read_words(e: &ReadError) -> String {
    match e {
        ReadError::NotPublished(w) | ReadError::Failed(w) | ReadError::Unreachable { words: w, .. } => w.clone(),
        ReadError::Busy => "the reader is in use by another lattice window".into(),
        ReadError::Booting => "the reader is still getting ready".into(),
    }
}

/// How fresh a `/read` is to be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fresh {
    /// what the engine keeps will do
    No,
    /// `fresh=1`: drop what is kept, then go to the plain address
    Asked,
    /// the webview's reload: drop what is kept and read in place (a
    /// redirect it followed could carry the same header again)
    Reload,
}

impl Fresh {
    /// A `trusted` request's freshness. `fresh=1` counts only from the
    /// reader's own pages, and a reload header from anything but a
    /// publisher's frame, so that a frame, which can navigate the window
    /// on a click, cannot make each click a fresh read.
    fn of(req: &Req, port: u16) -> Fresh {
        if req.arg("fresh") == Some("1") && own_page(req, port) {
            Fresh::Asked
        } else if req.reload && !from_frame(req, port) {
            Fresh::Reload
        } else {
            Fresh::No
        }
    }
}

/// Did one of the reader's own pages (reader.js) make this request? Its
/// navigations are `Sec-Fetch-Site: same-origin`; a frame's, from an
/// opaque origin, are cross-site. A webview that sends no fetch metadata
/// is judged by the Referer: a reader page, not a `/raw` frame.
fn own_page(req: &Req, port: u16) -> bool {
    match req.site.as_deref() {
        Some(s) => s == "same-origin",
        None => on_reader(req.referer.as_deref(), port) && !from_frame(req, port),
    }
}

/// Did a publisher's sandboxed frame make this request?
fn from_frame(req: &Req, port: u16) -> bool {
    let raw = req
        .referer
        .as_deref()
        .and_then(|r| r.strip_prefix("http://"))
        .and_then(|r| r.find('/').map(|i| &r[i..]))
        .is_some_and(|p| p == "/raw" || p.starts_with("/raw?"));
    raw && on_reader(req.referer.as_deref(), port)
        || req.site.as_deref().is_some_and(|s| s == "cross-site" || s == "same-site")
}

/// `/read`: the page, or why not.
fn read(ctx: &Ctx, given: &str, fresh: Fresh) -> Resp {
    let url = address(given);
    if let Err((status, words)) = urb_render::gateway::de_urb(url.as_bytes()) {
        let mut s = render::bad_address(&url);
        if status != 400 {
            s.html = s.html.replace("That isn't an urb:// address.", &render_words(&words));
        }
        return shown(400, s);
    }
    if fresh != Fresh::No {
        crate::commands::dlog(&format!("reader: fresh read of {url}"));
        ctx.reads.expire(&url);
        if let Some(ship) = render::commentable(&url) {
            ctx.opens.lock().unwrap().remove(&ship);
        }
        if fresh == Fresh::Asked {
            return redirect(303, &render::read_href(&url));
        }
    }
    if let Some(at) = crate::boards::place(&url) {
        let (status, s) = crate::boards::read(ctx, &url, &at);
        return shown(status, s);
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
    let our = ctx.reads.our();
    let note = ctx.take_note(url);
    let (open, comets) =
        render::commentable(url).map_or((Open::Unknown, Comets::default()), |ship| ctx.open(&ship, &p.key, false));
    let talk = Talk { our: our.as_deref(), note: note.as_ref(), open, comets: comets.mode, full: full_mins(&comets) };
    let s = render::page(url, p, Mode::Shipless, &key, &talk);
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
    // the reader is in use: its identity is kept
    engine.claim();
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

    type Said = Arc<Mutex<Vec<(String, String, String)>>>;

    /// a stand-in engine: the pages it has, how often it was asked, and
    /// the comments it sent
    struct Fake {
        calls: Arc<AtomicUsize>,
        expired: Said,
        answer: Answer,
        said: Said,
        refuse: Option<CommentError>,
        /// the publisher's pages that take comments; None, it doesn't say
        open: Arc<Mutex<Option<Vec<String>>>>,
        opens: Arc<AtomicUsize>,
        /// the publisher's `/pub/comets`, by page
        comets: Arc<Mutex<Vec<(String, Comets)>>>,
        /// what the first page's `/pub/comets` row becomes once a comment
        /// is sent: a publisher that turned it away at the cap
        fills: Arc<Mutex<Option<Comets>>>,
        /// the forum host's boards that take comet posts; None, it doesn't say
        forum: Arc<Mutex<Option<Vec<String>>>>,
        /// the forum posts and replies it sent
        wrote: Wrote,
    }

    type Wrote = Arc<Mutex<Vec<(String, crate::engine::ForumWrite)>>>;

    impl Reads for Fake {
        fn read(&self, url: &str, _: Duration, _: bool) -> Result<NativePage, ReadError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            (self.answer)(url)
        }
        fn expire(&self, url: &str) {
            self.expired.lock().unwrap().push((url.into(), String::new(), String::new()));
        }
        fn our(&self) -> Option<String> {
            Some("~doznec-sampel-palnet".into())
        }
        fn comment(&self, ship: &str, page: &str, body: &str, _: Duration) -> Result<(), CommentError> {
            self.said.lock().unwrap().push((ship.into(), page.into(), body.into()));
            if let Some(f) = self.fills.lock().unwrap().take() {
                self.comets.lock().unwrap()[0].1 = f;
            }
            self.refuse.clone().map_or(Ok(()), Err)
        }
        fn comments_open(&self, _: &str, _: Duration) -> Option<Opened> {
            self.opens.fetch_add(1, Ordering::SeqCst);
            let names = self.open.lock().unwrap().clone()?;
            Some(Opened { names, comets: self.comets.lock().unwrap().clone() })
        }
        fn forum_open(&self, _: &str, _: Duration) -> Option<Vec<String>> {
            self.forum.lock().unwrap().clone()
        }
        fn forum_write(&self, host: &str, w: crate::engine::ForumWrite, _: Duration) -> Result<(), CommentError> {
            self.wrote.lock().unwrap().push((host.into(), w));
            self.refuse.clone().map_or(Ok(()), Err)
        }
    }

    fn page_of(body: &str, mark: &str) -> NativePage {
        NativePage { key: "/k".into(), body: body.into(), mark: mark.into(), how: "keen".into() }
    }

    fn ctx(name: &str, answer: impl Fn(&str) -> Result<NativePage, ReadError> + Send + Sync + 'static) -> (Ctx, Arc<AtomicUsize>) {
        let (c, calls, _) = expiring(name, answer);
        (c, calls)
    }

    /// a reader whose engine also says which addresses it was asked to
    /// expire
    fn expiring(
        name: &str,
        answer: impl Fn(&str) -> Result<NativePage, ReadError> + Send + Sync + 'static,
    ) -> (Ctx, Arc<AtomicUsize>, Said) {
        let dir = std::env::temp_dir().join(format!("reader-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let calls = Arc::new(AtomicUsize::new(0));
        let expired = Said::default();
        let fake = Fake { calls: calls.clone(), expired: expired.clone(), answer: Box::new(answer), said: Said::default(), refuse: None, open: Arc::default(), opens: Arc::default(), comets: Arc::default(), fills: Arc::default(), forum: Arc::default(), wrote: Wrote::default() };
        (Ctx::new(Box::new(fake), History::open(&dir), PORT), calls, expired)
    }

    fn expired_urls(e: &Said) -> Vec<String> {
        e.lock().unwrap().iter().map(|(u, _, _)| u.clone()).collect()
    }

    #[test]
    fn a_fresh_read_expires_the_page_then_goes_to_the_plain_address() {
        let (c, calls, expired) = expiring("fresh", pages);
        let (st, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello&fresh=1", &own()));
        assert_eq!(st, 303, "{out}");
        assert!(out.contains("Location: /read?url=urb%3A%2F%2F~zod%2Fhello\r\n"), "{out}");
        assert_eq!(expired_urls(&expired), ["urb://~zod/hello"]);
        assert_eq!(calls.load(Ordering::SeqCst), 0, "the read is the redirect's");
        // a bare ~ship/path, and fresh=0 is no reload
        assert_eq!(ask(&c, &get("/read?url=~zod/hello&fresh=1", &own())).0, 303);
        assert_eq!(ask(&c, &get("/read?url=~zod/hello&fresh=0", &cookie())).0, 200);
        assert_eq!(expired_urls(&expired), ["urb://~zod/hello", "urb://~zod/hello"]);
        // a plain read, as a link or back and forward make, keeps the cache
        let (st, _) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert_eq!((st, expired.lock().unwrap().len()), (200, 2));
    }

    #[test]
    fn the_webviews_own_reload_is_fresh_in_place() {
        let (c, calls, expired) = expiring("reload", pages);
        for h in ["Cache-Control: max-age=0\r\n", "Cache-Control: no-cache\r\nPragma: no-cache\r\n", "Pragma: no-cache\r\n"] {
            let (st, out) = ask(&c, &get("/read?url=urb://~zod/hello", &format!("{}{h}", cookie())));
            assert_eq!(st, 200, "{h}: {out}");
            assert!(out.contains("<h1>Hello</h1>"));
        }
        assert_eq!(expired_urls(&expired), ["urb://~zod/hello"; 3]);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        // a long max-age is no reload
        ask(&c, &get("/read?url=urb://~zod/hello", &format!("{}Cache-Control: max-age=60\r\n", cookie())));
        assert_eq!(expired.lock().unwrap().len(), 3);
    }

    #[test]
    fn a_fresh_read_needs_the_token_and_an_address() {
        let (c, calls, expired) = expiring("freshbad", pages);
        assert_eq!(ask(&c, &get("/read?url=urb://~zod/hello&fresh=1", "")).0, 403);
        let x = get("/read?url=urb://~zod/hello&fresh=1", &format!("{}Origin: http://evil.example\r\n", cookie()));
        assert_eq!(ask(&c, &x).0, 403);
        assert_eq!(ask(&c, &get("/read?url=http%3A%2F%2Fexample.com&fresh=1", &own())).0, 400);
        assert!(expired.lock().unwrap().is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    /// A publisher's sandboxed frame can navigate the window on a click:
    /// that is a plain visit, fresh=1 or not, so a frame cannot make each
    /// click cost the publisher a list read.
    #[test]
    fn only_the_readers_own_pages_make_a_read_fresh() {
        let (c, calls, expired) = expiring("freshframe", pages);
        let raw = format!("http://127.0.0.1:{PORT}/raw?url=urb%3A%2F%2F~zod%2Fhello&key=k");
        for h in [
            "Sec-Fetch-Site: cross-site\r\n".to_string(),
            "Sec-Fetch-Site: same-site\r\n".to_string(),
            format!("Sec-Fetch-Site: cross-site\r\nReferer: {raw}\r\n"),
            format!("Referer: {raw}\r\n"),
            "Sec-Fetch-Site: none\r\n".to_string(),
            String::new(),
        ] {
            let extra = format!("{}{h}", cookie());
            let (st, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello&fresh=1", &extra));
            assert_eq!(st, 200, "{h}: {out}");
            assert!(out.contains("<h1>Hello</h1>"), "{h}");
            assert_eq!(ask(&c, &get("/?fresh=1", &extra)).0, 200, "{h}");
        }
        // and a reload header from a frame's navigation is no reload
        for h in ["Sec-Fetch-Site: cross-site\r\n".to_string(), format!("Referer: {raw}\r\n")] {
            let extra = format!("{}{h}Cache-Control: max-age=0\r\n", cookie());
            assert_eq!(ask(&c, &get("/read?url=urb://~zod/hello", &extra)).0, 200);
        }
        assert!(expired.lock().unwrap().is_empty(), "{:?}", expired_urls(&expired));
        assert_eq!(calls.load(Ordering::SeqCst), 8 + 1, "the reads, and the start list once");
        // a reader page without fetch metadata is judged by its Referer
        let extra = format!("{}Referer: http://127.0.0.1:{PORT}/read?url=urb%3A%2F%2F~zod%2Fhello\r\n", cookie());
        assert_eq!(ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello&fresh=1", &extra)).0, 303);
        assert_eq!(expired_urls(&expired), ["urb://~zod/hello"]);
    }

    #[test]
    fn a_fresh_home_reads_the_start_list_again() {
        let (c, calls, expired) = expiring("freshhome", pages);
        assert_eq!(ask(&c, &get("/", &cookie())).0, 200);
        assert_eq!(ask(&c, &get("/", &cookie())).0, 200);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "kept");
        let (st, out) = ask(&c, &get("/?fresh=1", &own()));
        assert_eq!(st, 303);
        assert!(out.contains("Location: /\r\n"), "{out}");
        assert_eq!(expired_urls(&expired), [render::START_URL]);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        // and the webview's reload of the home
        ask(&c, &get("/", &format!("{}Cache-Control: max-age=0\r\n", cookie())));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(ask(&c, &get("/?fresh=1", "")).0, 403);
        assert_eq!(expired.lock().unwrap().len(), 2);
    }

    /// A comet's first contact can take two minutes: a start list that
    /// failed is asked for again soon, and the live one shown once read.
    #[test]
    fn a_failed_start_list_is_not_kept_for_long() {
        let up = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let u = up.clone();
        let live = NativePage { key: "/start".into(), body: "# Live start\n".into(), mark: "gmi".into(), how: "keen".into() };
        let l = live.clone();
        let (c, calls) = ctx("startfail", move |_| {
            if u.load(Ordering::SeqCst) {
                Ok(l.clone())
            } else {
                Err(ReadError::Unreachable { later: true, words: "no answer within 3s".into() })
            }
        });
        let age = |by: Duration| {
            let mut g = c.start.lock().unwrap();
            let (at, _) = g.as_mut().unwrap();
            *at -= by;
        };
        let (_, out) = ask(&c, &get("/", &cookie()));
        assert!(out.contains("<h1>lattice</h1>"), "the compiled list");
        ask(&c, &get("/", &cookie()));
        assert_eq!(calls.load(Ordering::SeqCst), 1, "a failure is kept a little while");
        up.store(true, Ordering::SeqCst);
        age(START_FAIL_TTL);
        let (_, out) = ask(&c, &get("/", &cookie()));
        assert_eq!(calls.load(Ordering::SeqCst), 2, "and no longer");
        assert!(out.contains("Live start"), "{out}");
        // the live list is kept far longer
        age(START_FAIL_TTL * 2);
        let (_, out) = ask(&c, &get("/", &cookie()));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(out.contains("Live start"));
        assert!(START_FAIL_TTL <= Duration::from_secs(30) && START_TTL > START_FAIL_TTL * 2);
    }

    /// a reader whose engine says what it was asked to comment, refusing
    /// with `refuse`
    fn talking(name: &str, refuse: Option<CommentError>) -> (Ctx, Said) {
        let (c, said, _, _) = talking_open(name, refuse, None);
        (c, said)
    }

    /// as `talking`, with a publisher that says which pages take comments
    #[allow(clippy::type_complexity)]
    fn talking_open(
        name: &str,
        refuse: Option<CommentError>,
        open: Option<Vec<String>>,
    ) -> (Ctx, Said, Arc<Mutex<Option<Vec<String>>>>, Arc<AtomicUsize>) {
        let dir = std::env::temp_dir().join(format!("reader-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let said = Said::default();
        let (open, opens) = (Arc::new(Mutex::new(open)), Arc::new(AtomicUsize::new(0)));
        let fake = Fake {
            calls: Arc::default(),
            expired: Said::default(),
            answer: Box::new(pages),
            said: said.clone(),
            refuse,
            open: open.clone(),
            opens: opens.clone(),
            forum: Arc::default(),
            wrote: Wrote::default(),
            comets: Arc::default(),
            fills: Arc::default(),
        };
        (Ctx::new(Box::new(fake), History::open(&dir), PORT), said, open, opens)
    }

    #[test]
    fn a_page_that_takes_comments_offers_the_box_and_says_posted() {
        let (c, said, _, opens) = talking_open("open", None, Some(vec!["/other".into(), "/k".into()]));
        let (_, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert!(out.contains("class=\"talk-form\"") && out.contains(">Post to ~zod</button>"), "{out}");
        assert!(!out.contains("They decide whether it appears"));
        ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert_eq!(opens.load(Ordering::SeqCst), 1, "the list is kept");
        assert_eq!(ask(&c, &post_comment("urb://~zod/hello", &ours(), "body=hi")).0, 303);
        assert_eq!(opens.load(Ordering::SeqCst), 3, "a comment asks again, before the send and after it");
        assert_eq!(said.lock().unwrap().len(), 1);
        let (_, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert!(out.contains("Posted to ~zod.") && !out.contains("Sent to ~zod."), "{out}");
    }

    #[test]
    fn a_page_with_comments_off_says_so_and_sends_nothing() {
        let (c, said, open, _) = talking_open("closed", None, Some(vec!["/other".into()]));
        let (_, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert!(out.contains("Comments are off on this page") && !out.contains("talk-form"), "{out}");
        // turned off after the box was shown: the text comes back, unsent
        let (c2, said2, _, _) = talking_open("closed2", None, Some(vec!["/k".into()]));
        assert!(ask(&c2, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie())).1.contains("talk-form"));
        drop((c2, said2));
        assert_eq!(ask(&c, &post_comment("urb://~zod/hello", &ours(), "body=mine")).0, 303);
        assert!(said.lock().unwrap().is_empty());
        let (_, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert!(out.contains("turned comments off on this page, so it wasn't sent") && out.contains(">mine</textarea>"), "{out}");
        // a reload asks the publisher again
        *open.lock().unwrap() = Some(vec!["k".into()]);
        let (_, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert!(out.contains("Comments are off"), "kept");
        c.opens.lock().unwrap().clear();
        let (_, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert!(out.contains("talk-form"), "{out}");
    }

    #[test]
    fn a_pages_comet_policy_shapes_the_box_and_the_send() {
        let dir = std::env::temp_dir().join(format!("reader-comets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let said = Said::default();
        let comets = Arc::new(Mutex::new(vec![("/k".to_string(), Comets { mode: CometMode::Held, full_until: None })]));
        let fills: Arc<Mutex<Option<Comets>>> = Arc::default();
        let fake = Fake {
            calls: Arc::default(),
            expired: Said::default(),
            answer: Box::new(pages),
            said: said.clone(),
            refuse: None,
            open: Arc::new(Mutex::new(Some(vec!["/k".into()]))),
            opens: Arc::default(),
            comets: comets.clone(),
            fills: fills.clone(),
            forum: Arc::default(),
            wrote: Wrote::default(),
        };
        let c = Ctx::new(Box::new(fake), History::open(&dir), PORT);
        let read = |c: &Ctx| ask(c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie())).1;
        let out = read(&c);
        assert!(out.contains("talk-form") && out.contains("Anonymous comments are reviewed before they appear."), "{out}");
        assert_eq!(ask(&c, &post_comment("urb://~zod/hello", &ours(), "body=hi")).0, 303);
        assert_eq!(said.lock().unwrap().len(), 1);
        assert!(read(&c).contains("Sent to ~zod for review."));
        // off: no box, and nothing is sent
        comets.lock().unwrap()[0].1 = Comets { mode: CometMode::Off, full_until: None };
        assert_eq!(ask(&c, &post_comment("urb://~zod/hello", &ours(), "body=mine")).0, 303);
        assert_eq!(said.lock().unwrap().len(), 1);
        let out = read(&c);
        assert!(out.contains("Anonymous comments are off on this page.") && !out.contains("talk-form"), "{out}");
        assert!(out.contains(">mine</textarea>"), "{out}");
        // at the cap until an hour from now: no box, and nothing is sent
        let later = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 3600;
        comets.lock().unwrap()[0].1 = Comets { mode: CometMode::Open, full_until: Some(later) };
        assert_eq!(ask(&c, &post_comment("urb://~zod/hello", &ours(), "body=more")).0, 303);
        assert_eq!(said.lock().unwrap().len(), 1);
        let out = read(&c);
        assert!(out.contains("Too many anonymous comments here right now, try again in 60 min.") && !out.contains("talk-form"), "{out}");
        // a send the publisher turned away at the cap: its /pub/comets says
        // so after the send, and the reader says so instead of "Posted"
        comets.lock().unwrap()[0].1 = Comets { mode: CometMode::Open, full_until: None };
        c.opens.lock().unwrap().clear();
        *fills.lock().unwrap() = Some(Comets { mode: CometMode::Open, full_until: Some(later) });
        assert_eq!(ask(&c, &post_comment("urb://~zod/hello", &ours(), "body=over")).0, 303);
        assert_eq!(said.lock().unwrap().len(), 2);
        let out = read(&c);
        assert!(out.contains("try again in 60 min. Your comment wasn't posted.") && !out.contains("Posted to"), "{out}");
        assert!(out.contains(">over</textarea>"), "{out}");
        // a cap that is over is no cap
        comets.lock().unwrap()[0].1 = Comets { mode: CometMode::Open, full_until: Some(1) };
        c.opens.lock().unwrap().clear();
        let out = read(&c);
        assert!(out.contains(">Post to ~zod</button>") && !out.contains("Too many"), "{out}");
    }

    /// a reader whose forum host lists `boards` as taking comet posts
    fn posting(name: &str, boards: Option<Vec<String>>) -> (Ctx, Wrote, Said) {
        let dir = std::env::temp_dir().join(format!("reader-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (wrote, expired) = (Wrote::default(), Said::default());
        let fake = Fake {
            calls: Arc::default(),
            expired: expired.clone(),
            answer: Box::new(pages),
            said: Said::default(),
            refuse: None,
            open: Arc::default(),
            opens: Arc::default(),
            forum: Arc::new(Mutex::new(boards)),
            wrote: wrote.clone(),
            comets: Arc::default(),
            fills: Arc::default(),
        };
        (Ctx::new(Box::new(fake), History::open(&dir), PORT), wrote, expired)
    }

    fn post_forum(url: &str, extra: &str, body: &str) -> String {
        post_comment(url, extra, body).replacen("POST /comment?", "POST /forum?", 1)
    }

    #[test]
    fn a_forum_post_and_reply_go_as_the_reader_identity() {
        use crate::engine::ForumWrite;
        let (c, wrote, expired) = posting("forumpost", Some(vec!["general".into()]));
        let (st, out) = ask(&c, &post_forum("urb://~wep/forum/general", &ours(), "title=Hi+there&link=&body=first%21"));
        assert_eq!(st, 303, "{out}");
        assert!(out.contains("Location: /read?url=urb%3A%2F%2F~wep%2Fforum%2Fgeneral"), "{out}");
        let (st, _) = ask(&c, &post_forum("urb://~wep/forum/general/1.000", &ours(), "body=a+reply"));
        assert_eq!(st, 303);
        let got = wrote.lock().unwrap().clone();
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(
            got[0],
            ("~wep".into(), ForumWrite::Post { board: "general".into(), title: "Hi there".into(), url: None, body: Some("first!".into()) })
        );
        match &got[1] {
            (h, ForumWrite::Reply { board, post, parent: None, body }) => {
                assert_eq!((h.as_str(), board.as_str(), post.decimal().as_str(), body.as_str()), ("~wep", "general", "1000", "a reply"));
            }
            w => panic!("{w:?}"),
        }
        // the thread is read fresh, and says it was sent, once
        assert!(expired_urls(&expired).contains(&"urb://~wep/forum/general/1.000".to_string()));
        assert_eq!(c.take_note("urb://~wep/forum/general/1.000"), Some(Note::Sent));
        assert_eq!(c.take_note("urb://~wep/forum/general/1.000"), None);
    }

    #[test]
    fn a_forum_write_goes_only_where_the_host_takes_it() {
        for (name, boards) in [("forumoff", Some(vec!["other".to_string()])), ("forumold", None)] {
            let (c, wrote, _) = posting(name, boards);
            assert_eq!(ask(&c, &post_forum("urb://~wep/forum/general", &ours(), "title=t&body=mine")).0, 303);
            assert!(wrote.lock().unwrap().is_empty(), "{name}");
            assert_eq!(c.take_note("urb://~wep/forum/general"), Some(Note::Closed { body: "mine".into() }), "{name}");
        }
        let (c, wrote, _) = posting("forumbad", Some(vec!["general".into()]));
        // a furum board, a page, no title, an empty reply, a foreign caller
        assert_eq!(ask(&c, &post_forum("urb://~rup/furum/m1c", &ours(), "title=t")).0, 400);
        assert_eq!(ask(&c, &post_forum("urb://~rup/furum/m1c/3", &ours(), "body=x")).0, 400);
        assert_eq!(ask(&c, &post_forum("urb://~wep/hello", &ours(), "title=t")).0, 400);
        assert_eq!(ask(&c, &post_forum("urb://~wep/forum/general", &ours(), "title=+&body=x")).0, 303);
        assert_eq!(c.take_note("urb://~wep/forum/general"), Some(Note::Empty));
        assert_eq!(ask(&c, &post_forum("urb://~wep/forum/general/3", &ours(), "body=+")).0, 303);
        let bad = format!("{}Origin: null\r\n", cookie());
        assert_eq!(ask(&c, &post_forum("urb://~wep/forum/general", &bad, "title=t")).0, 403);
        assert!(wrote.lock().unwrap().is_empty());
    }

    fn post_comment(url: &str, extra: &str, body: &str) -> String {
        format!(
            "POST /comment?url={} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n{extra}Content-Type: application/x-www-form-urlencoded\r\n\
             Content-Length: {}\r\n\r\n{body}",
            render::enc(url),
            body.len()
        )
    }

    fn ours() -> String {
        format!("{}Origin: http://127.0.0.1:{PORT}\r\nSec-Fetch-Site: same-origin\r\n", cookie())
    }

    #[test]
    fn a_comment_is_sent_as_the_reader_identity_and_said_once() {
        let (c, said) = talking("comment", None);
        let (st, out) = ask(&c, &post_comment("urb://~zod/hello", &ours(), "body=hello+there%21&x=1"));
        assert_eq!(st, 303, "{out}");
        assert!(out.contains("Location: /read?url=urb%3A%2F%2F~zod%2Fhello\r\n"), "{out}");
        // to the publisher, at the page's key as the read gave it
        assert_eq!(*said.lock().unwrap(), [("~zod".to_string(), "/k".to_string(), "hello there!".to_string())]);
        let (_, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert!(out.contains("Sent to ~zod."), "{out}");
        assert!(out.contains("<code class=\"who\">~doznec-sampel-palnet</code>"));
        let (_, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert!(!out.contains("Sent to ~zod."), "said once");
    }

    #[test]
    fn a_refused_comment_says_so_and_keeps_the_text() {
        let (c, _) = talking("refused", Some(CommentError::Refused("weir: no".into())));
        assert_eq!(ask(&c, &post_comment("urb://~zod/hello", &ours(), "body=mine")).0, 303);
        let (_, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert!(out.contains("~zod refused this comment") && out.contains("weir: no") && out.contains(">mine</textarea>"));
        let (c, _) = talking("unanswered", Some(CommentError::Unanswered("~zod did not answer".into())));
        assert_eq!(ask(&c, &post_comment("urb://~zod/hello", &ours(), "body=mine")).0, 303);
        let (_, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert!(out.contains("~zod didn't answer"));
    }

    #[test]
    fn only_the_reader_itself_can_comment() {
        let (c, said) = talking("comment403", None);
        let ck = cookie();
        for extra in [
            String::new(),
            ck.clone(),
            format!("{ck}Origin: null\r\n"),
            format!("{ck}Origin: http://evil.example\r\n"),
            format!("{ck}Origin: http://127.0.0.1:26500\r\n"),
            format!("Origin: http://127.0.0.1:{PORT}\r\n"),
            format!("{ck}Origin: http://127.0.0.1:{PORT}\r\nSec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n"),
        ] {
            assert_eq!(ask(&c, &post_comment("urb://~zod/hello", &extra, "body=x")).0, 403, "{extra}");
        }
        // a GET is no comment
        assert_eq!(ask(&c, &get("/comment?url=urb://~zod/hello&body=x", &ck)).0, 404);
        assert!(said.lock().unwrap().is_empty());
    }

    #[test]
    fn an_empty_or_huge_or_misplaced_comment_is_not_sent() {
        let (c, said) = talking("commentbad", None);
        assert_eq!(ask(&c, &post_comment("urb://~zod/hello", &ours(), "body=+++")).0, 303);
        let (_, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert!(out.contains("Write something first."));
        let huge = format!("body={}", "a".repeat(MAX_BODY));
        assert_eq!(ask(&c, &post_comment("urb://~zod/hello", &ours(), &huge)).0, 413);
        assert_eq!(ask(&c, &post_comment("urb://~zod/k/notes", &ours(), "body=x")).0, 400);
        assert!(said.lock().unwrap().is_empty());
        // a long one is cut to lattice's cap, on a character boundary
        let long = format!("body={}", "%E2%9C%93".repeat(1400));
        assert_eq!(ask(&c, &post_comment("urb://~zod/hello", &ours(), &long)).0, 303);
        let sent = said.lock().unwrap()[0].2.clone();
        assert!(sent.len() <= render::COMMENT_MAX && sent.len() > render::COMMENT_MAX - 3 && sent.chars().all(|ch| ch == '\u{2713}'));
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

    /// the token, on a navigation one of the reader's own pages made
    fn own() -> String {
        format!("{}Sec-Fetch-Site: same-origin\r\n", cookie())
    }

    #[test]
    fn a_page_is_read_and_rendered_with_its_policy() {
        let (c, calls) = ctx("page", pages);
        let (st, out) = ask(&c, &get("/read?url=urb%3A%2F%2F~zod%2Fhello", &cookie()));
        assert_eq!(st, 200, "{out}");
        assert!(out.contains(&format!("Content-Security-Policy: {}\r\n", render::OWN)));
        assert!(out.contains("<h1>Hello</h1>") && out.contains("Connect a node to bookmark"));
        assert!(out.contains("class=\"talk-form\""), "a published page takes comments");
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
        // a different last digit (a fixed "0" was the same key one time in 16)
        let last = if src.ends_with('0') { '1' } else { '0' };
        let wrong = format!("{}{last}", &src[..src.len() - 1]);
        assert_eq!(ask(&c, &get(&wrong, &format!("Referer: http://127.0.0.1:{PORT}/\r\n"))).0, 404);
    }

    #[test]
    fn an_html_start_page_is_framed_in_the_home() {
        let (c, _) = ctx("htmlstart", |u| {
            assert_eq!(u, render::START_URL);
            Ok(page_of("<h1>Styled start</h1><a href=\"urb://~nec/y\">y</a>", "html"))
        });
        let (st, out) = ask(&c, &get("/", &cookie()));
        assert_eq!(st, 200, "{out}");
        assert!(out.contains(&format!("Content-Security-Policy: {}\r\n", render::FRAMED)));
        assert!(!out.contains("<h1>lattice</h1>") && !out.contains("Styled start"), "not the fallback, not inline");
        assert!(out.contains("Recently read"));
        let src = out.split("<iframe").nth(1).unwrap().split("src=\"").nth(1).unwrap().split('"').next().unwrap().replace("&amp;", "&");
        assert!(src.starts_with("/raw?url=urb%3A%2F%2F~nisfeb%2Fstart&key="), "{src}");
        let frame = get(
            &src,
            &format!("Origin: null\r\nReferer: http://127.0.0.1:{PORT}/\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Dest: iframe\r\n"),
        );
        let (st, out) = ask(&c, &frame);
        assert_eq!(st, 200, "{out}");
        assert!(out.contains(&format!("Content-Security-Policy: {}\r\n", render::SANDBOX)));
        assert!(out.contains("<h1>Styled start</h1><a href=\"/read?url=urb://~nec/y\">"), "{out}");
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
        assert!(out.contains("<h1>lattice</h1>"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_live_start_list_is_read_once_in_a_while() {
        let booting = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let b = booting.clone();
        let (c, calls) = ctx("startttl", move |u| {
            if b.load(Ordering::SeqCst) {
                Err(ReadError::Booting)
            } else {
                pages(u)
            }
        });
        // still starting: asked again next time
        assert_eq!(ask(&c, &get("/", &cookie())).0, 200);
        assert_eq!(ask(&c, &get("/", &cookie())).0, 200);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        // an answer (here: no such page) is kept
        booting.store(false, Ordering::SeqCst);
        for _ in 0..3 {
            let (st, out) = ask(&c, &get("/", &cookie()));
            assert_eq!(st, 200);
            assert!(out.contains("<h1>lattice</h1>"));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn form_values_are_decoded() {
        assert_eq!(unescape("urb%3A%2F%2F~zod%2Fa+b"), "urb://~zod/a b");
        assert_eq!(unescape("100%"), "100%");
        assert_eq!(unescape("%zz%4"), "%zz%4");
        assert_eq!(unescape("%e2%9c%93"), "\u{2713}");
    }

    /// On the fleet: two reader identities comment on a page that takes
    /// comments, each through the reader's own routes, and a page with
    /// comments off shows no box. Run by the e2e that publishes the pages
    /// (FLEET_OPEN, FLEET_CLOSED, on ~wep) and checks the publisher's
    /// inbox after; plain `cargo test` skips it as ignored.
    #[test]
    #[ignore = "needs a fleet ship publishing FLEET_OPEN and FLEET_CLOSED"]
    fn two_identities_comment_on_a_fleet_page() {
        if std::env::var("LATTICE_FLEET").as_deref() != Ok("1") {
            eprintln!("skipped: LATTICE_FLEET=1 is not set");
            return;
        }
        let open = std::env::var("FLEET_OPEN").expect("FLEET_OPEN");
        let closed = std::env::var("FLEET_CLOSED").expect("FLEET_CLOSED");
        let nonce = std::env::var("FLEET_NONCE").expect("FLEET_NONCE");
        for n in 1..=2 {
            let tmp = std::env::temp_dir().join(format!("reader-fleet-{n}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&tmp);
            let e = crate::engine::Engine::fake(tmp.join("engine"), "new-moon-of:~wep");
            e.read(&open, Duration::from_secs(90), true).expect("the first read");
            eprintln!("identity {n}: {:?}", e.our());
            let c = Ctx::new(Box::new(e.clone()), History::open(&tmp), PORT);
            let href = format!("/read?url={}", render::enc(&open));
            let (st, out) = ask(&c, &get(&href, &cookie()));
            assert_eq!(st, 200, "{out}");
            assert!(out.contains("class=\"talk-form\"") && out.contains(">Post to ~wep</button>"), "{out}");
            let body = format!("body=from+identity+{n}+{nonce}");
            assert_eq!(ask(&c, &post_comment(&open, &ours(), &body)).0, 303);
            let (_, out) = ask(&c, &get(&href, &cookie()));
            assert!(out.contains("Posted to ~wep."), "{out}");
            let (st, out) = ask(&c, &get(&format!("/read?url={}", render::enc(&closed)), &cookie()));
            assert_eq!(st, 200, "{out}");
            assert!(out.contains("Comments are off on this page") && !out.contains("talk-form"), "{out}");
            e.close();
            let _ = std::fs::remove_dir_all(&tmp);
        }
    }
}
