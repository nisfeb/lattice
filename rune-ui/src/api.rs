//! The ship's HTTP API, as the web client calls it. Every call blocks, so
//! each runs on a `rune::Latest` worker and never on the UI thread.

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Where the ship is and the session cookie that opens it.
#[derive(Clone, Default)]
pub struct Conn {
    pub url: String,
    pub cookie: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Node {
    pub path: String,
    #[serde(default)]
    pub page: bool,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub rev: u64,
    /// Who may read it: `shared` (over Urbit) or `clearweb`. Empty for a
    /// private page: the dump names only the shared ones.
    #[serde(default)]
    pub share: String,
    /// The name to show in place of the path's last part, when the page
    /// or folder was named with capitals, spaces or punctuation.
    #[serde(default)]
    pub dname: String,
    /// A folder's own share setting, which its pages take: `shared` or
    /// `clearweb`, empty for none.
    #[serde(default)]
    pub dshare: String,
    /// The page's text, when the dump carried it: every page on a first
    /// dump, then only those written since.
    #[serde(default)]
    pub body: Option<String>,
    /// The page is a link to one another ship shared, moved into this tree.
    /// It is read and saved through this ship like any page, and never
    /// carried in a dump.
    #[serde(default)]
    pub link: Option<LinkTo>,
}

/// What a link in the tree points at: the page on its host, and whether it may be changed.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct LinkTo {
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub path: String,
    /// `read` or `edit`, as the host granted it when the link was made.
    #[serde(default)]
    pub mode: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Page {
    #[serde(skip)]
    pub name: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub rev: u64,
}

/// A bookmark the reader keeps on the ship: an address on the network
/// or the web, the title it was kept under, and the folder it is in,
/// empty for none (`bookmarks-json`).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Bookmark {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub folder: String,
}

/// The whole tree with page bodies, in one request (`page-dump`).
#[derive(Debug, Default, Deserialize, Serialize)]
pub struct Dump {
    pub nodes: Vec<Node>,
    /// Handed back on the next dump, which then carries only what changed.
    #[serde(default)]
    pub since: String,
}

/// One memory: a fact kept under a path-like key.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Know {
    /// Starts with a slash: `/project/lattice/status`.
    pub key: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub updated: String,
}

#[derive(Deserialize)]
struct Knows {
    items: Vec<Know>,
}

/// A group of ships and what it may read (`peek`) and write (`make`), as
/// the ship's access list gives it. The paths are whole paths on the ship.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Group {
    pub name: String,
    #[serde(default)]
    pub ships: Vec<String>,
    #[serde(default)]
    pub peek: Vec<String>,
    #[serde(default)]
    pub make: Vec<String>,
}

/// What a group may do with one page.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Level {
    None,
    Read,
    Edit,
}

impl Group {
    /// The whole path of a page's text under the lattice at `base`.
    fn road(base: &str, name: &str) -> String {
        format!("{base}/page/{name}/code")
    }

    /// What this group may do with the page `name` by the page's own grant.
    pub fn level(&self, base: &str, name: &str) -> Level {
        let road = Group::road(base, name);
        if self.make.contains(&road) {
            Level::Edit
        } else if self.peek.contains(&road) {
            Level::Read
        } else {
            Level::None
        }
    }

    /// This group with the ships typed in place of its own. Its paths stay.
    pub fn with_ships(&self, typed: &str) -> Result<Group, String> {
        let mut ships = ship_list(typed)?;
        ships.sort();
        ships.dedup();
        Ok(Group { ships, ..self.clone() })
    }

    /// This group with its grant on the page `name` set to `level`. Every
    /// other path it holds is kept as it is.
    pub fn with_level(&self, base: &str, name: &str, level: Level) -> Group {
        let road = Group::road(base, name);
        let mut g = self.clone();
        g.peek.retain(|p| *p != road);
        g.make.retain(|p| *p != road);
        if level != Level::None {
            g.peek.push(road.clone());
        }
        if level == Level::Edit {
            g.make.push(road);
        }
        g
    }
}

/// The ships in a list as typed, between spaces or commas, each with its
/// sig. `Err` names the first that is not a ship's name.
pub fn ship_list(typed: &str) -> Result<Vec<String>, String> {
    typed.split(|c: char| c.is_whitespace() || c == ',').filter(|t| !t.is_empty()).map(|t| ship_name(t).ok_or_else(|| format!("{t} is not a ship's name"))).collect()
}

/// What to ban, as typed: a ship's name with its sig, or `comets` for every
/// comet at once. `None` for anything else.
pub fn ban_target(typed: &str) -> Option<String> {
    let t = typed.trim();
    if t == "comets" { Some(t.to_owned()) } else { ship_name(t) }
}

/// A group's name as the ship takes it: lowercase letters, digits and
/// hyphens, starting with a letter.
pub fn group_name_ok(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_lowercase()) && name.len() <= 40 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[derive(Deserialize)]
struct Streams {
    base: String,
}

/// One ship's access to a page: `edit` or `read`, and the folder it comes
/// through when the grant is a folder's and not the page's own.
#[derive(Clone, Debug, PartialEq)]
pub struct Reader {
    pub ship: String,
    pub edit: bool,
    pub via: Option<String>,
}

/// The ships that may read the page `name`, from the access list: each
/// with the widest access any of its groups gives, sorted by ship.
pub fn readers(groups: &[Group], name: &str) -> Vec<Reader> {
    // what a path grants on this page: its own text, or a folder above it
    let on = |path: &str| -> Option<Option<String>> {
        let rel = path.split_once("/page/")?.1.trim_end_matches('/');
        if rel.strip_suffix("/code") == Some(name) {
            return Some(None);
        }
        let dir = rel.strip_suffix("/code").unwrap_or(rel);
        (!rel.ends_with("/code") && name.strip_prefix(dir).is_some_and(|r| r.starts_with('/'))).then(|| Some(dir.to_owned()))
    };
    let mut out: Vec<Reader> = Vec::new();
    for g in groups {
        let read = g.peek.iter().find_map(|p| on(p));
        let edit = g.make.iter().find_map(|p| on(p));
        let Some(via) = edit.clone().or(read) else { continue };
        for ship in &g.ships {
            match out.iter_mut().find(|r| r.ship == *ship) {
                Some(r) => {
                    r.edit |= edit.is_some();
                    // the page's own grant is the one to show
                    if via.is_none() {
                        r.via = None;
                    }
                }
                None => out.push(Reader { ship: ship.clone(), edit: edit.is_some(), via: via.clone() }),
            }
        }
    }
    out.sort_by(|a, b| a.ship.cmp(&b.ship));
    out
}

/// A ship's name as typed, with its sig: `nec` and `~nec` are both `~nec`.
/// `None` for text that cannot be a ship's name.
pub fn ship_name(typed: &str) -> Option<String> {
    let t = typed.trim().trim_start_matches('~');
    let ok = !t.is_empty() && t.len() <= 60 && t.chars().all(|c| c.is_ascii_lowercase() || c == '-');
    ok.then(|| format!("~{t}"))
}

#[derive(Deserialize)]
struct Granted {
    #[serde(default)]
    notified: bool,
}

/// A page another ship shared with this one: a notice it sent, not proof.
/// Opening it is what shows the grant still holds.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Shared {
    pub host: String,
    /// The page's whole path on the host.
    pub path: String,
    /// `read` or `edit`.
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub when: String,
}

impl Shared {
    /// The page's name on its host: the path after `/page/`, without the
    /// `/code` a page's text sits under. The whole path when it has no such part.
    pub fn name(&self) -> &str {
        let rel = self.path.split_once("/page/").map_or(self.path.as_str(), |(_, r)| r);
        rel.strip_suffix("/code").unwrap_or(rel)
    }

    pub fn editable(&self) -> bool {
        self.mode == "edit"
    }
}

#[derive(Deserialize)]
struct Browsed {
    #[serde(default)]
    body: String,
    #[serde(default)]
    builder: Option<String>,
    #[serde(default)]
    rev: u64,
}

#[derive(Deserialize)]
struct RemoteSaved {
    #[serde(default)]
    outcome: String,
    #[serde(default)]
    rev: u64,
}

#[derive(Deserialize)]
struct Flag {
    #[serde(default)]
    on: bool,
    #[serde(default)]
    shared: bool,
}

/// One comment on a page.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Comment {
    pub page: String,
    pub id: String,
    #[serde(default)]
    pub author: String,
    #[serde(default, deserialize_with = "when_text")]
    pub when: String,
    #[serde(default)]
    pub body: String,
}

/// A date the ship gives as its own text or, for held comments, as
/// milliseconds since 1970. Both come out as the ship's text.
fn when_text<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => s,
        serde_json::Value::Number(n) => da_of_ms(n.as_f64().unwrap_or(0.0) as i64),
        _ => String::new(),
    })
}

/// Milliseconds since 1970 as the ship writes a date: `~2026.11.17..20.36.35`.
pub fn da_of_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // days to a civil date (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("~{y}.{m}.{d}..{}.{}.{}", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// One activity notice: a comment from another ship, a reply on a
/// forum, a share or its end, an ask to edit, a followed folder's news.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Notice {
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default, deserialize_with = "when_text")]
    pub when: String,
    #[serde(default)]
    pub who: String,
    #[serde(default)]
    pub host: String,
    #[serde(default, rename = "where")]
    pub place: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub read: bool,
}

/// What pressing Open on a notice shows here.
#[derive(Debug, PartialEq)]
pub enum Opens {
    /// A page of this ship.
    Page(String),
    /// A page another ship shared: its host and whole path.
    Shared(Shared),
    /// The Access screen, where an ask is answered.
    Access,
    /// Somewhere this client has no screen for yet (a forum, a folder).
    Nothing,
}

impl Notice {
    /// The line that says what it is about, in the web client's words.
    pub fn label(&self) -> String {
        let title = if self.title.is_empty() { String::new() } else { format!(": {}", self.title) };
        let shared = || Shared { host: self.host.clone(), path: self.place.clone(), ..Shared::default() }.name().to_owned();
        match self.kind.as_str() {
            "comment" => format!("comment on {}", self.place),
            "ask" => format!("asks to edit {}", self.title),
            "share" => format!("shared {}", shared()),
            "reshare" => format!("changed the share of {}", shared()),
            "unshare" => format!("stopped sharing {}", shared()),
            "asked" => format!("answered your ask on {}", shared()),
            "remote" => format!("reply on {}/{}{title}", self.host, self.place),
            "reply" => format!("reply on {}{title}", self.place),
            "folder" if !self.title.is_empty() => self.title.clone(),
            _ => self.place.clone(),
        }
    }

    pub fn opens(&self) -> Opens {
        match self.kind.as_str() {
            "comment" => Opens::Page(self.place.clone()),
            "ask" => Opens::Access,
            "share" | "reshare" | "asked" if !self.place.ends_with('/') => Opens::Shared(Shared { host: self.host.clone(), path: self.place.clone(), mode: "read".into(), when: String::new() }),
            _ => Opens::Nothing,
        }
    }
}

#[derive(Deserialize)]
struct Notices {
    #[serde(default)]
    items: Vec<Notice>,
}

/// The inbox's counts: held comet comments and unread notices.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
pub struct Waiting {
    #[serde(default)]
    pub held: u32,
    #[serde(default)]
    pub unread: u32,
}

/// An ask for edit on a page or folder: one waiting on this ship
/// (`ship` asked), or one this ship sent (`host` was asked).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Ask {
    #[serde(default, alias = "host")]
    pub ship: String,
    pub path: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub note: String,
    #[serde(default, deserialize_with = "when_text")]
    pub when: String,
}

#[derive(Debug, Default, Deserialize, PartialEq)]
pub struct Asks {
    #[serde(default)]
    pub pending: Vec<Ask>,
    #[serde(default)]
    pub sent: Vec<Ask>,
}

/// The most an image may weigh, fetched.
const IMAGE_MAX: u64 = 8 * 1024 * 1024;

/// The bytes at a URL, for an image: `http` and `https` only, 8 MB at
/// most, twenty seconds at most. The cookie goes only where it is given.
pub fn fetch_bytes(url: &str, cookie: Option<&str>) -> Result<Vec<u8>, String> {
    #[cfg(target_arch = "wasm32")]
    {
        // ponytail: no bytes over a waited-for request. The browser fetches images itself
        let _ = (url, cookie);
        Err("not fetched in the browser build".into())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("not a web address".into());
        }
        let mut req = ureq::get(url).timeout(Duration::from_secs(20));
        if let Some(c) = cookie {
            req = req.set("cookie", c);
        }
        let res = req.call().map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("{code}"),
            e => e.to_string(),
        })?;
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut std::io::Read::take(res.into_reader(), IMAGE_MAX + 1), &mut out).map_err(|e| e.to_string())?;
        if out.len() as u64 > IMAGE_MAX {
            return Err("larger than 8 MB".into());
        }
        Ok(out)
    }
}

/// A captured page's name: `inbox/YYYY-MM-DD-NNNN`, the date and four
/// digits drawn from `seed`, drawn again while `taken` says the name is used.
pub fn capture_name(date: &str, mut seed: u64, taken: &dyn Fn(&str) -> bool) -> String {
    loop {
        let name = format!("inbox/{date}-{:04}", seed % 10_000);
        if !taken(&name) {
            return name;
        }
        // any step that walks all ten thousand
        seed = seed.wrapping_add(7919);
    }
}

/// The names a day's journal page may have: the dashed one the ship's
/// journal pass writes, then two dotted ones older pages were started at.
pub fn journal_forms(date: &str) -> Vec<String> {
    let p: Vec<&str> = date.split('-').collect();
    let [y, m, d] = p.as_slice() else { return vec![format!("journal/{date}")] };
    let bare = |n: &str| n.trim_start_matches('0').to_owned();
    vec![format!("journal/{date}"), format!("journal/{y}.{}.{}", bare(m), bare(d)), format!("journal/{y}.{m}.{d}")]
}

/// The local date, `YYYY-MM-DD`.
// ponytail: asks the system's `date`, since std has no time zones. UTC when that fails.
pub fn today() -> String {
    let local = std::process::Command::new("date").arg("+%Y-%m-%d").output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).map(|s| s.trim().to_owned());
    local.filter(|d| d.len() == 10).unwrap_or_else(|| {
        let ms = crate::api::since_epoch().map_or(0, |d| d.as_millis() as i64);
        let da = da_of_ms(ms);
        let ymd: Vec<&str> = da.trim_start_matches('~').split("..").next().unwrap_or("").split('.').collect();
        format!("{}-{:0>2}-{:0>2}", ymd[0], ymd.get(1).unwrap_or(&"1"), ymd.get(2).unwrap_or(&"1"))
    })
}

/// A note cut to whole characters within the 280 bytes a host keeps.
pub fn clip_note(s: &str) -> &str {
    let mut end = s.len().min(280);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// What the ship says of map tiles: whether a Mapbox token is set (the
/// token itself is never told), and the deepest zoom it gives.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct TileStatus {
    #[serde(default)]
    pub token: bool,
    /// The token in use is the one set in orrery, none being set here.
    #[serde(default)]
    pub orrery: bool,
    #[serde(default)]
    pub max: u32,
    #[serde(default)]
    pub styles: Vec<String>,
}

#[derive(Deserialize)]
struct Templates {
    #[serde(default)]
    templates: Vec<String>,
}

#[derive(Deserialize)]
struct Backlinks {
    #[serde(default)]
    links: Vec<String>,
}

#[derive(Deserialize)]
struct Comets {
    #[serde(default)]
    mode: String,
}

#[derive(Deserialize)]
struct Inbox {
    #[serde(default)]
    items: Vec<Comment>,
}

#[derive(Deserialize)]
struct Rendered {
    #[serde(default)]
    comments: bool,
    /// The page as the ship renders it, for a kind it renders.
    #[serde(default)]
    html: String,
    /// Said only of `orrery/map`: whether orrery keeps it.
    #[serde(default)]
    kept: Option<bool>,
}

/// One stored revision of a page.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Rev {
    pub rev: u64,
    /// When it was written, as the ship writes a date (`~2026.11.17..17.25.11..b165`).
    #[serde(default)]
    pub updated: String,
}

impl Rev {
    /// The date as people write it: `2026-11-17 17:25`. The ship's own
    /// text when it is not a date this reads.
    pub fn when(&self) -> String {
        let parts: Vec<&str> = self.updated.trim_start_matches('~').split("..").collect();
        let date: Vec<&str> = parts.first().map_or(Vec::new(), |d| d.split('.').collect());
        let time: Vec<&str> = parts.get(1).map_or(Vec::new(), |t| t.split('.').collect());
        match (date.as_slice(), time.as_slice()) {
            ([y, m, d], [h, min, ..]) => format!("{y}-{m:0>2}-{d:0>2} {h:0>2}:{min:0>2}"),
            ([y, m, d], _) => format!("{y}-{m:0>2}-{d:0>2}"),
            _ => self.updated.clone(),
        }
    }
}

#[derive(Deserialize)]
struct History {
    revisions: Vec<Rev>,
}

#[derive(Deserialize)]
struct Saved {
    #[serde(default)]
    rev: u64,
    /// The page had changed since the revision the save named: it was applied all the same, and what it replaced is kept at `kept`.
    #[serde(default)]
    conflicted: bool,
    #[serde(default)]
    kept: String,
}

/// Where a signed-in session is kept between runs: the app's own file,
/// readable by its owner alone.
fn session_path() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))?;
    Some(base.join("lattice-rune").join("session.json"))
}

/// Where a ship's tree and pages are kept between runs, to read when it
/// does not answer: beside the session, one file for each ship's address.
fn kept_path(url: &str) -> Option<std::path::PathBuf> {
    let name: String = url.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    Some(session_path()?.with_file_name(format!("kept-{name}.json")))
}

fn keep_at(p: &std::path::Path, nodes: Vec<Node>) -> Result<(), String> {
    write_private(p, &serde_json::to_vec(&Dump { nodes, since: String::new() }).map_err(|e| e.to_string())?)
}

/// Waits. A browser page cannot: there the wait is skipped.
pub fn pause(d: Duration) {
    #[cfg(target_arch = "wasm32")]
    let _ = d;
    #[cfg(not(target_arch = "wasm32"))]
    std::thread::sleep(d);
}

/// The time since 1970. The browser has no system clock to ask but its own.
pub fn since_epoch() -> Result<Duration, std::time::SystemTimeError> {
    #[cfg(target_arch = "wasm32")]
    return Ok(Duration::from_millis(js_sys::Date::now() as u64));
    #[cfg(not(target_arch = "wasm32"))]
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
}

/// The browser's requests to the ship that served the page. The browser sends its own session with each.
#[cfg(target_arch = "wasm32")]
pub mod web {
    pub const FORM: &str = "application/x-www-form-urlencoded";
    /// The name the preferences are kept under in the browser's storage.
    pub const PREFS: &str = "lattice-rune.prefs";

    /// The browser's storage for this address, when it lets the page have one.
    pub fn storage() -> Option<web_sys::Storage> {
        web_sys::window()?.local_storage().ok().flatten()
    }

    /// One request, waited for: the answer's status and text.
    // ponytail: a waited-for request stops the page until the ship answers. Each is short. An async fetch with its answer taken in `poll` is the step up when the pauses show
    pub fn request(method: &str, url: &str, content_type: Option<&str>, accept: Option<&str>, body: Option<&str>) -> Result<(u16, String), String> {
        let js = |e: wasm_bindgen::JsValue| e.as_string().unwrap_or_else(|| "the ship could not be reached".into());
        let x = web_sys::XmlHttpRequest::new().map_err(js)?;
        x.open_with_async(method, url, false).map_err(js)?;
        for (name, value) in [("content-type", content_type), ("accept", accept)] {
            if let Some(v) = value {
                x.set_request_header(name, v).map_err(js)?;
            }
        }
        x.send_with_opt_str(body).map_err(|_| "the ship could not be reached".to_owned())?;
        Ok((x.status().map_err(js)?, x.response_text().map_err(js)?.unwrap_or_default()))
    }

    /// The session of a page the ship served: the ship is the page's own
    /// address and the browser sends its login with every request, so there
    /// is no code to ask for and nothing to keep. A browser that is not
    /// signed in is sent to the ship's own login page, to come back here.
    pub fn session() -> Option<super::Conn> {
        let loc = web_sys::window()?.location();
        let url = loc.origin().ok()?;
        // an owner's route: the ship answers it only to its owner's browser
        let (code, text) = request("GET", &format!("{url}/apps/lattice/streams"), None, None, None).ok()?;
        if code != 200 || !text.trim_start().starts_with('{') {
            let back = loc.pathname().unwrap_or_default();
            let _ = loc.set_href(&format!("{url}/~/login?redirect={}", super::enc(&back)));
            return None;
        }
        // the cookie is the browser's and is never seen here. Only its name's part is made up, for `ship` to read
        let name = request("GET", &format!("{url}/~/name"), None, None, None).ok().map(|(_, t)| t.trim().to_owned()).filter(|t| super::ship_name(t).is_some()).unwrap_or_else(|| "ship".into());
        Some(super::Conn { url, cookie: format!("urbauth-{name}=the-browsers") })
    }

    /// The text of an answer the ship did not refuse, or its refusal as the native client words one.
    pub fn text(r: Result<(u16, String), String>) -> Result<String, String> {
        match r? {
            (0, _) => Err("the ship could not be reached".into()),
            (code, text) if code >= 400 => Err(format!("{code}: {text}")),
            (_, text) => Ok(text),
        }
    }
}

/// Writes a file only its owner reads, whole or not at all: beside it first, then moved into place.
pub fn write_private(p: &std::path::Path, body: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(p.parent().ok_or("no parent")?).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("part");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).and_then(|mut f| f.write_all(body).and_then(|()| f.sync_all())).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}

fn kept_at(p: &std::path::Path) -> Option<(Dump, u64)> {
    let d: Dump = serde_json::from_slice(&std::fs::read(p).ok()?).ok()?;
    let age = std::fs::metadata(p).ok()?.modified().ok()?.elapsed().map_or(0, |d| d.as_secs());
    Some((d, age))
}

/// Whether sharing in `mode` over `was` is going public, which asks
/// first: from private, or from a folder whose pages differ, to either
/// public mode. Moving between the two public modes does not ask.
pub fn goes_public(was: &str, mode: &str) -> bool {
    let public = |m: &str| m == "shared" || m == "clearweb";
    public(mode) && !public(was)
}

/// One event of the ship's change stream (`ui-src/lattice/90-sync.js`).
/// The ship stamps a file under `/beacon` on every change and the
/// stream carries each stamp: first as it stood when the stream was
/// registered (`old`), then as it moves.
#[derive(Clone, Debug, PartialEq)]
pub enum Beacon {
    /// Pages changed. `old` is the stamp as it stood at registration: from then on the stream is the ship's word.
    Rev { old: bool, stamp: String },
    /// Memories changed.
    Know { old: bool, stamp: String },
    /// What is shared with this ship changed.
    Shares { old: bool, stamp: String },
    /// The inbox moved: a held comment, or something to read.
    Notify { old: bool, stamp: String },
    /// A comment landed.
    Comments,
    /// The stream ended, as it does every minute or so, or broke.
    Down,
}

/// The whole events in what has come of a stream so far, each its name
/// and its data. What follows the last blank line stays, to be added to.
pub fn sse_events(buf: &mut String) -> Vec<(String, String)> {
    let mut out = Vec::new();
    while let Some(end) = buf.find("\n\n") {
        let (mut name, mut data) = (String::new(), String::new());
        for ln in buf[..end].split('\n') {
            if let Some(n) = ln.strip_prefix("event: ") {
                name = n.trim().to_owned();
            } else if let Some(d) = ln.strip_prefix("data: ") {
                data = d.trim().to_owned();
            }
        }
        buf.drain(..end + 2);
        if !name.is_empty() {
            out.push((name, data));
        }
    }
    out
}

/// The event a stream's name and data are: `old /rev`, `upd /know` and
/// the like. `None` for one this client does nothing with.
pub fn beacon_of(name: &str, data: &str) -> Option<Beacon> {
    let old = name.starts_with("old");
    let stamp = data.to_owned();
    match name.rsplit(' ').next()? {
        "/rev" => Some(Beacon::Rev { old, stamp }),
        "/know" => Some(Beacon::Know { old, stamp }),
        "/shares" => Some(Beacon::Shares { old, stamp }),
        "/notify" => Some(Beacon::Notify { old, stamp }),
        "/comments" if !old => Some(Beacon::Comments),
        _ => None,
    }
}

/// The last stamp seen of each thing the stream tells of, and whether a
/// stream is registered. It turns events into what to read again.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BeaconState {
    pub live: bool,
    rev: String,
    know: String,
    shares: String,
    notify: String,
}

/// What an event asks to be read again.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Wants {
    pub tree: bool,
    pub know: bool,
    pub shared: bool,
    pub inbox: bool,
}

impl BeaconState {
    /// Takes one event. A stamp as it stood at registration is news only
    /// when it differs from the last one seen: something changed while
    /// nobody was listening. A stamp that moves on a live stream is news.
    pub fn take(&mut self, ev: Beacon) -> Wants {
        let mut w = Wants::default();
        // a stamp at registration is a missed change when one was seen before and it is not this one
        let moved = |last: &mut String, old: bool, stamp: String| {
            let news = if old { !last.is_empty() && !stamp.is_empty() && *last != stamp } else { true };
            if !stamp.is_empty() {
                *last = stamp;
            }
            news
        };
        match ev {
            Beacon::Rev { old, stamp } => {
                self.live |= old;
                w.tree = moved(&mut self.rev, old, stamp);
            }
            Beacon::Know { old, stamp } => w.know = moved(&mut self.know, old, stamp),
            // these two say the same stamp again when nothing moved
            Beacon::Shares { old, stamp } => w.shared = stamp != self.shares && moved(&mut self.shares, old, stamp),
            Beacon::Notify { old, stamp } => w.inbox = stamp != self.notify && moved(&mut self.notify, old, stamp),
            Beacon::Comments => w.inbox = true,
            Beacon::Down => self.live = false,
        }
        w
    }
}

/// How long to wait before listening again, in milliseconds, after `fail`
/// tries in a row that did not hold: three seconds, doubling to thirty,
/// and from half to one and a half of that by `jitter` (0 to 1), so that
/// windows dropped together do not all come back on the same tick.
pub fn beacon_wait(fail: u32, jitter: f64) -> u64 {
    let base = (3000u64 << fail.saturating_sub(1).min(4)).min(30_000);
    ((base as f64 * (0.5 + jitter.clamp(0.0, 1.0))).round() as u64).min(30_000)
}

/// The count of failed tries after one more: none when the stream was
/// registered and then lived a minute or carried a change, which is the
/// stream ending on schedule. Five at most.
pub fn beacon_fail(fail: u32, registered: bool, lived_ms: u128, bumped: bool) -> u32 {
    if registered && (lived_ms >= 60_000 || bumped) {
        0
    } else {
        (fail + 1).min(5)
    }
}

/// What of lattice's software a ship has (`desktop/src/stack.rs`): %mcp,
/// the bootstrap that installs the rest, with the name its server gives.
/// %grubbery, the framework lattice runs inside. And lattice itself.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stack {
    pub mcp: Option<String>,
    pub grubbery: bool,
    pub lattice: bool,
}

/// Whether a route's answer shows something bound there. The ship
/// redirects (307) a path nothing has bound, and a 404 is the same.
/// Anything else, a refusal included, is something listening.
pub fn bound(status: u16) -> bool {
    status != 307 && status != 404
}

impl Stack {
    /// The list as the desktop app shows it: for each, whether it is there, its name, and a word on it.
    pub fn lines(&self) -> [(bool, &'static str, String); 3] {
        let word = |on: bool, note: &str| if on { note.to_owned() } else { "not installed".to_owned() };
        [
            (self.mcp.is_some(), "%mcp", word(self.mcp.is_some(), self.mcp.as_deref().unwrap_or("the bootstrap, which installs everything else"))),
            (self.grubbery, "%grubbery", word(self.grubbery, "the framework lattice runs inside")),
            (self.lattice, "lattice", word(self.lattice, "the app itself")),
        ]
    }

    /// Whether the list is worth showing: lattice is not there to use. A ship that runs lattice lacks nothing that matters here, whether or not it still has the %mcp that installed it.
    pub fn missing(&self) -> bool {
        !self.grubbery || !self.lattice
    }
}

/// How the connection to the ship stands, as the desktop app's settings say it.
#[derive(Clone, Debug, PartialEq)]
pub enum Link {
    Connected,
    /// The ship does not answer.
    Unreachable,
    /// The ship answers, and no longer takes this session.
    SignedOut,
}

/// The state of the connection from what was last seen of it: reads
/// that got no answer, or a read the ship refused as not signed in.
pub fn link(offline: bool, lapsed: bool) -> Link {
    if offline {
        Link::Unreachable
    } else if lapsed {
        Link::SignedOut
    } else {
        Link::Connected
    }
}

/// Whether an error is the ship saying this session is not signed in.
pub fn lapsed(error: &str) -> bool {
    error.starts_with("401") || error.starts_with("403")
}

/// What stands at a `urb://` address, as the ship reads it (`GET /urb-read`).
#[derive(Clone, Debug, PartialEq)]
pub enum Urb {
    /// A page: its ship, its path there, its kind and its text, and how many comments its public thread has.
    Page { ship: String, path: String, kind: String, body: String, comments: usize },
    /// A folder: its path, and what is in it, each with its address and whether it is a folder too.
    Folder { path: String, entries: Vec<(String, String, bool)> },
    /// A forum board or one of its threads: read as the forum reads it.
    Forum,
    /// A file that is no page: what it is, and its size in bytes.
    Binary { kind: String, size: u64 },
}

/// An address as typed, made whole: `urb://` is put before `~ship/path`
/// when it was left off. `None` for what names no ship.
pub fn urb_address(typed: &str) -> Option<String> {
    let t = typed.trim();
    let rest = t.strip_prefix("urb://").unwrap_or(t);
    let ship = rest.split('/').next().unwrap_or_default();
    (ship.starts_with('~') && ship_name(ship).is_some()).then(|| format!("urb://{rest}"))
}

/// Whether an address is a forum's: `urb://~ship/forum` and under it.
pub fn urb_is_forum(url: &str) -> bool {
    url.trim_start_matches("urb://").split('/').nth(1) == Some("forum")
}

/// Reads the ship's answer for an address.
pub fn urb_parse(json: &str) -> Result<Urb, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let text = |k: &str| v[k].as_str().unwrap_or_default().to_owned();
    match v["kind"].as_str() {
        Some("page") => {
            // this ship's own page comes with its name, another's with its path there
            let path = if v["name"].is_string() { text("name") } else { text("path").trim_start_matches('/').to_owned() };
            Ok(Urb::Page { ship: text("ship"), path, kind: text("mode"), body: text("body"), comments: v["comments"].as_array().map_or(0, Vec::len) })
        }
        Some("folder") => {
            let entries = v["entries"].as_array().map_or_else(Vec::new, |a| a.iter().filter_map(|e| Some((e["name"].as_str()?.to_owned(), e["url"].as_str()?.to_owned(), e["folder"].as_bool().unwrap_or(false)))).collect());
            Ok(Urb::Folder { path: text("path"), entries })
        }
        Some("board" | "thread") => Ok(Urb::Forum),
        Some("binary") => Ok(Urb::Binary { kind: text("type"), size: v["size"].as_u64().unwrap_or(0) }),
        _ => Err("the ship gave nothing this reads at that address".into()),
    }
}

/// What the ship says of the map token, as its settings page words it.
pub fn tiles_say(t: &TileStatus) -> &'static str {
    match (t.token, t.orrery) {
        (true, true) => "Using the Mapbox token set in orrery. A token saved here is used instead.",
        (true, false) => "A token is set. It is never shown again.",
        _ => "No token is set.",
    }
}

/// The OpenSCAD runtime the ship keeps for browsers (`GET /scad-status`):
/// the version it offers and its size, the one installed, and whether an
/// install is running or failed.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct ScadStatus {
    #[serde(default)]
    pub pin: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub have: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub busy: bool,
    /// Whether this build of lattice names an address to install from.
    #[serde(default)]
    pub source: bool,
}

impl ScadStatus {
    /// The runtime's state in the ship's settings page's words, the label
    /// of the button that installs or updates it when one is offered, and
    /// whether it can be uninstalled.
    pub fn says(&self) -> (String, Option<String>, bool) {
        let have = self.have.as_deref().filter(|h| !h.is_empty());
        let mb = format!("{} MB", (self.size as f64 / 1e5).round() / 10.0);
        let err = self.error.as_deref().filter(|e| !e.is_empty());
        let text = match (self.busy, have) {
            (true, _) => "installing, this takes a little while...".to_owned(),
            (false, Some(h)) => format!("OpenSCAD {h} is installed.{}{}", if h == self.pin { String::new() } else { format!(" This lattice offers {}.", self.pin) }, err.map_or_else(String::new, |e| format!(" The last update failed: {e}"))),
            (false, None) if !self.source => "This build of lattice names no address to install from.".to_owned(),
            (false, None) => err.map_or_else(|| "Not installed.".to_owned(), |e| format!("Not installed: {e}")),
        };
        let install = match have {
            _ if self.busy => None,
            Some(h) if h == self.pin => None,
            Some(_) => Some(format!("Update to {} ({mb})", self.pin)),
            None if !self.source => None,
            None => Some(format!("Install ({mb})")),
        };
        (text, install, have.is_some() && !self.busy)
    }
}

/// The Commons mirror (`GET /obelisk-status`): whether %obelisk, the
/// database it copies into, is installed, and whether the mirror is on.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
pub struct Obelisk {
    #[serde(default)]
    pub installed: bool,
    #[serde(default)]
    pub enabled: bool,
}

/// An agent key as the ship lists it, in the words the ship's own
/// settings page says it in: whose it is, and what it may touch.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentKey {
    pub id: String,
    pub title: String,
    pub detail: String,
}

/// The keys of the ship's answer (`GET /keys`), newest first as it gives them.
pub fn agent_keys(json: &str) -> Result<Vec<AgentKey>, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let day = |da: &serde_json::Value| da.as_str().map(|d| format!("{} UTC", Rev { rev: 0, updated: d.to_owned() }.when()));
    let list = |v: &serde_json::Value| v.as_array().map_or_else(String::new, |a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" "));
    let rows = v.as_array().ok_or("the ship did not give a list of keys")?;
    Ok(rows
        .iter()
        .map(|k| {
            let sc = &k["scope"];
            let pages = match (&sc["pages"]["all"], &sc["pages"]["some"]) {
                (serde_json::Value::String(all), _) => all.clone(),
                (_, some) if some.is_object() => format!("scoped (read {}; write {})", list(&some["read"]), list(&some["write"])),
                _ => "none".into(),
            };
            let web = if sc["web"].get("all").is_some() {
                "all ships (read)".into()
            } else if let Some(some) = sc["web"]["some"].as_object() {
                some.iter().map(|(ship, e)| format!("{ship} (read {}; write {})", list(&e["read"]), list(&e["write"]))).collect::<Vec<_>>().join(", ")
            } else {
                "none".into()
            };
            let mut detail = format!("memory {}, pages {pages}, other ships {web}, skills {}", sc["memory"].as_str().unwrap_or("none"), sc["skills"].as_str().unwrap_or("none"));
            if sc["sensitive"].as_bool() == Some(true) {
                detail.push_str(", reads sensitive memories");
            }
            detail.push_str(&format!(". Made {}", day(&k["made"]).unwrap_or_default()));
            detail.push_str(&day(&k["used"]).map_or_else(|| ", never used".into(), |d| format!(", last used {d}")));
            if let Some(until) = day(&k["tainted_until"]) {
                detail.push_str(&format!(". Read sensitive content, so until {until} it writes only sensitive"));
            }
            AgentKey { id: k["id"].as_str().unwrap_or_default().to_owned(), title: format!("{} (writes as {})", k["name"].as_str().unwrap_or_default(), k["by"].as_str().unwrap_or_default()), detail }
        })
        .collect())
}

/// What is asked for when a key is made, as the ship's settings form holds it.
#[derive(Clone, Debug, Default)]
pub struct KeyAsk {
    pub name: String,
    /// The name its saves are signed with.
    pub by: String,
    /// `write`, `read` or `none`.
    pub memory: String,
    /// `read`, `write`, `none`, or `some` for the paths given.
    pub pages: String,
    pub pages_read: String,
    pub pages_write: String,
    /// `off`, `all`, or `some` for one ship and its paths.
    pub web: String,
    pub web_ship: String,
    pub web_read: String,
    pub web_write: String,
    /// `none`, `read` or `write`.
    pub skills: String,
    pub sensitive: bool,
}

/// What is sent to make a key (`POST /key-mint`), or why it is not sent:
/// the checks the ship's form makes before it posts. Paths are parted by
/// commas and each starts with a slash, put there when it was left off.
pub fn key_request(a: &KeyAsk) -> Result<serde_json::Value, String> {
    let paths = |v: &str| v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(|s| if s.starts_with('/') { s.to_owned() } else { format!("/{s}") }).collect::<Vec<_>>();
    let (name, by, ship) = (a.name.trim(), a.by.trim(), a.web_ship.trim());
    if name.is_empty() || name.chars().count() > 200 {
        return Err("a key needs a name, 200 characters at most".into());
    }
    if by.is_empty() || by.len() > 64 || !by.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err("the name it writes as is letters, digits, dots, dashes and underscores, 64 at most".into());
    }
    if a.web == "some" && ship.is_empty() {
        return Err("pick a ship for scoped access to other ships, or set Other ships to none".into());
    }
    let pages = if a.pages == "some" { serde_json::json!({ "some": { "read": paths(&a.pages_read), "write": paths(&a.pages_write) } }) } else { serde_json::json!({ "all": a.pages }) };
    let web = match a.web.as_str() {
        "all" => serde_json::json!({ "all": null }),
        "some" => serde_json::json!({ "some": { ship: { "read": paths(&a.web_read), "write": paths(&a.web_write) } } }),
        _ => serde_json::json!({ "off": null }),
    };
    Ok(serde_json::json!({ "name": name, "by": by, "scope": { "memory": a.memory, "pages": pages, "web": web, "sensitive": a.sensitive, "skills": a.skills } }))
}

/// A page's save that could not reach the ship, waiting to be sent: the
/// text, and the revision it was written over, by which the ship can
/// tell whether the page changed meanwhile.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct Queued {
    pub kind: String,
    pub body: String,
    pub base: u64,
    /// The page was made here and the ship has not seen it: sent as a new page, which a page of that name made elsewhere meanwhile refuses.
    #[serde(default)]
    pub is_new: bool,
    /// When it was put by, in seconds.
    #[serde(default)]
    pub at: u64,
}

/// The saves that wait, one for each page by its name (`docs/offline-edits.md`).
pub type Queue = std::collections::BTreeMap<String, Queued>;

/// Puts a save by. A page saved again while one waits takes its place,
/// and keeps what the first one knew: the revision the ship last gave,
/// and that the page is new. Once new, new until it is sent.
pub fn enqueue(q: &mut Queue, p: &Page, base: u64, is_new: bool, at: u64) {
    let prev = q.get(&p.name);
    let (base, is_new) = (prev.map_or(base, |o| o.base), is_new || prev.is_some_and(|o| o.is_new));
    q.insert(p.name.clone(), Queued { kind: p.kind.clone(), body: p.body.clone(), base, is_new, at });
}

/// How sending one waiting save came out.
#[derive(Clone, Debug, PartialEq)]
pub enum Sent {
    /// The ship has it, at this revision. When the ship's page had changed since the save was written, the text it replaced is kept under the name given.
    Done { rev: u64, kept: Option<String> },
    /// The ship refused it in a way sending again would not mend, and the text is kept as a page of its own under this name. Why it was refused.
    Aside(String, String),
    /// Not sent, or refused with nowhere to keep the text: it stays waiting. Why.
    Stop(String),
}

/// Whether the ship refused a waiting save in a way sending it again
/// cannot mend: a bad request, a missing target, a conflict, a text too
/// large. Anything else (no answer, a 5xx, a session that lapsed, a rate
/// limit) leaves it waiting. The web client's `REPLAY_DROP`.
pub fn replay_drop(error: &str) -> bool {
    error.split_once(':').and_then(|(code, _)| code.parse::<u16>().ok()).is_some_and(|c| [400, 404, 409, 410, 413, 422].contains(&c))
}

/// The name a refused save's text is kept under: `conflicts/offline-`,
/// what it was (`create` or `edit`), the page's name made one segment
/// as the ship makes it for its own kept copies (`/` to `-`, with `-`
/// and `~` marked so no two names share one), and when.
pub fn aside_name(tag: &str, name: &str, stamp: &str) -> String {
    let flat = name.replace('~', "~~").replace('-', "~d").replace('/', "-");
    format!("conflicts/offline-{tag}-{flat}-{stamp}")
}

/// The name a memory waits under: its key after `know:`, so a memory
/// and a page of the same name never share a place in the list.
pub fn know_queue_name(name: &str) -> String {
    format!("know:{}", name.trim_start_matches('/'))
}

/// The memory a waiting save is of, by its key without the slash. `None` for a page's.
pub fn queued_know(name: &str) -> Option<&str> {
    name.strip_prefix("know:")
}

/// The memories as read, with those that wait put over them: a waiting
/// text is the memory's text, and a memory written away that the ship
/// has not seen is listed.
pub fn knows_with(mut knows: Vec<Know>, q: &Queue) -> Vec<Know> {
    for (name, w) in q {
        let Some(key) = queued_know(name).map(|k| format!("/{k}")) else { continue };
        match knows.iter_mut().find(|k| k.key == key) {
            Some(k) => k.body = w.body.clone(),
            None => knows.push(Know { key, body: w.body.clone(), ..Know::default() }),
        }
    }
    knows
}

/// A delete or a move made with the ship away, waiting to be sent in
/// the order it was made: "rename A to B" then "delete B" is not its
/// reverse. Pages and folders only.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub enum QueuedOp {
    Del(String),
    /// From a path to a path, with the names to show for it (`RealName`).
    Move { from: String, to: String, dname: String, dnames: String },
}

/// A path at `at` or under it, as it is called once `at` is `to`. `None` for a path elsewhere.
fn moved(path: &str, at: &str, to: &str) -> Option<String> {
    let rest = path.strip_prefix(at).filter(|r| r.is_empty() || r.starts_with('/'))?;
    Some(format!("{to}{rest}"))
}

/// Puts a delete or a move by, and settles now what it means for the
/// saves that wait, so that when the ship answers every one of these can
/// go before every save and still be right. A delete drops the saves
/// under its path. A move carries them to their new names, and they then
/// name no revision: the page they go over is the moved one, whatever
/// the ship numbers it. Memories are not under any page's path.
pub fn enqueue_op(ops: &mut Vec<QueuedOp>, saves: &mut Queue, op: QueuedOp) {
    match &op {
        // a page made away and deleted away was never the ship's: its save goes, and there is nothing to send
        QueuedOp::Del(name) if saves.get(name).is_some_and(|q| q.is_new) => {
            saves.remove(name);
            return;
        }
        QueuedOp::Del(name) => saves.retain(|k, _| queued_know(k).is_some() || moved(k, name, "").is_none()),
        QueuedOp::Move { from, to, .. } => {
            let carried: Vec<(String, String)> = saves.keys().filter(|k| queued_know(k).is_none()).filter_map(|k| Some((k.clone(), moved(k, from, to)?))).collect();
            for (old, new) in carried {
                if let Some(mut q) = saves.remove(&old) {
                    q.base = 0;
                    saves.insert(new, q);
                }
            }
        }
    }
    ops.push(op);
}

/// The tree as read, as it is once the deletes and moves that wait are
/// done to it: what shows while they wait.
pub fn ops_over(mut nodes: Vec<Node>, ops: &[QueuedOp]) -> Vec<Node> {
    for op in ops {
        match op {
            QueuedOp::Del(name) => nodes.retain(|n| moved(&n.path, name, "").is_none()),
            QueuedOp::Move { from, to, dname, .. } => {
                for n in &mut nodes {
                    if let Some(new) = moved(&n.path, from, to) {
                        // the moved thing itself is shown under the name typed for it, or its plain path
                        if n.path == *from {
                            n.dname = dname.clone();
                        }
                        n.path = new;
                    }
                }
            }
        }
    }
    nodes
}

fn ops_path(url: &str) -> Option<std::path::PathBuf> {
    let q = queue_path(url)?;
    Some(q.with_file_name(format!("ops-{}", q.file_name()?.to_str()?.trim_start_matches("waiting-"))))
}

fn queue_path(url: &str) -> Option<std::path::PathBuf> {
    Some(kept_path(url)?.with_file_name(format!("waiting-{}", kept_path(url)?.file_name()?.to_str()?.trim_start_matches("kept-"))))
}

fn queue_at(p: &std::path::Path) -> Queue {
    std::fs::read(p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Whether a call failed because the ship did not answer, as against the
/// ship answering no: no status at all, or the 502 or 504 of something
/// in between that could not reach it. Only then is what was kept read.
pub fn gone(error: &str) -> bool {
    match error.split_once(':').and_then(|(code, _)| code.parse::<u16>().ok()) {
        Some(code) => code == 502 || code == 504,
        None => true,
    }
}

/// How long ago, in words: the age of what was kept.
pub fn ago(secs: u64) -> String {
    let (n, unit) = match secs {
        0..60 => return "just now".into(),
        60..3600 => (secs / 60, "minute"),
        3600..86_400 => (secs / 3600, "hour"),
        _ => (secs / 86_400, "day"),
    };
    format!("{n} {unit}{} ago", if n == 1 { "" } else { "s" })
}

/// What the window remembers between runs, beside the session.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct Prefs {
    /// `dark`, `light`, or anything else for the system's.
    #[serde(default)]
    pub theme: String,
    /// The page that was open, to open again.
    #[serde(default)]
    pub last: String,
    /// The pages opened last on this device, newest first, ten at most.
    #[serde(default)]
    pub recent: Vec<String>,
    /// The palette's commands run on this device, the last one first.
    #[serde(default)]
    pub used: Vec<String>,
    /// The page in each tab (empty for a tab with none) and the tab in
    /// front, to open again.
    #[serde(default)]
    pub tabs: Vec<String>,
    #[serde(default)]
    pub tab: usize,
    /// The page held beside in the split, or empty.
    #[serde(default)]
    pub split: String,
    /// The pages whose images from other sites may load, newest first.
    #[serde(default)]
    pub outside: Vec<String>,
    /// The core rules written by agent keys that the notice was dismissed for: it shows again when there is one not here.
    #[serde(default)]
    pub core_seen: Vec<String>,
    /// Autosave is on unless this says otherwise.
    #[serde(default)]
    pub no_autosave: bool,
    /// The source editor's font: `mono`, `serif` or `coding`, and anything else for the app's own.
    #[serde(default)]
    pub font: String,
    /// Vim keys in the source editor.
    #[serde(default)]
    pub vim: bool,
    /// Making a page public does not ask first: "do not ask again" was ticked on a publish that went ahead.
    #[serde(default)]
    pub pub_ok: bool,
    /// The tree is sorted by name from the end: the web client's `name-desc`.
    #[serde(default)]
    pub sort_desc: bool,
    /// The page held beside is held below, not to the right.
    #[serde(default)]
    pub split_down: bool,
    /// The bookmark folders folded away in the left pane.
    #[serde(default)]
    pub marks_folded: Vec<String>,
    /// What the ship last said of themes, so the first frame is drawn in them.
    #[serde(default)]
    pub worn: crate::theme::Worn,
    /// The pin chosen here for a feature of a map that is not written to, as orrery's: by the body it names.
    #[serde(default)]
    pub pins: std::collections::BTreeMap<String, String>,
}

impl Prefs {
    fn path() -> Option<std::path::PathBuf> {
        Some(session_path()?.with_file_name("prefs.json"))
    }

    /// The kept preferences, or the defaults when there are none or they do not read.
    pub fn load() -> Prefs {
        #[cfg(target_arch = "wasm32")]
        let kept = web::storage().and_then(|st| st.get_item(web::PREFS).ok().flatten());
        #[cfg(not(target_arch = "wasm32"))]
        let kept = Prefs::path().and_then(|p| std::fs::read_to_string(p).ok());
        kept.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    /// Keeps them. A failure is not worth a message: they are a convenience.
    pub fn save(&self) {
        // in a browser they are kept in its storage for this ship's address, under one name
        #[cfg(target_arch = "wasm32")]
        if let (Some(st), Ok(t)) = (web::storage(), serde_json::to_string(self)) {
            let _ = st.set_item(web::PREFS, &t);
        }
        #[cfg(not(target_arch = "wasm32"))]
        if let (Some(p), Ok(t)) = (Prefs::path(), serde_json::to_string(self)) {
            let _ = p.parent().map(std::fs::create_dir_all);
            let _ = std::fs::write(p, t);
        }
    }

    /// Whether to draw dark, given what the system says.
    pub fn dark(&self, system: bool) -> bool {
        match self.theme.as_str() {
            "dark" => true,
            "light" => false,
            _ => system,
        }
    }

    /// Lets a page load what it has from other sites, from now on.
    pub fn allow_outside(&mut self, name: &str) {
        self.outside.retain(|n| n != name);
        self.outside.insert(0, name.to_owned());
        self.outside.truncate(500);
    }

    /// Notes a page as the one opened last.
    pub fn opened(&mut self, name: &str) {
        self.recent.retain(|n| n != name);
        self.recent.insert(0, name.to_owned());
        self.recent.truncate(10);
    }

    /// The next theme in the round: system, dark, light.
    pub fn next_theme(&self) -> &'static str {
        match self.theme.as_str() {
            "dark" => "light",
            "light" => "system",
            _ => "dark",
        }
    }
}

/// Whether `name` is a path the ship takes as it is: parts of lowercase
/// letters, digits and `. _ ~ -`, none empty, `.` or `..`.
pub fn valid_name(name: &str) -> bool {
    name.split('/').all(|s| !s.is_empty() && s != "." && s != ".." && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._~-".contains(&b)))
}

/// What a typed name becomes: the path, and the names to show for the
/// parts of it that could not be kept as typed.
#[derive(Clone, Debug, PartialEq)]
pub struct RealName {
    pub name: String,
    /// The last part as typed, empty when the path keeps it.
    pub dname: String,
    /// Every part as typed, `/`-joined, with an empty entry for a part the
    /// path keeps. Empty when no part needs one.
    pub dnames: String,
}

/// The web client's rule (`realName`): a valid path is used as it is and
/// gets no display name. Anything else is made lowercase, with each run of
/// other characters a hyphen, and the typed text is kept to show.
pub fn real_name(typed: &str) -> Option<RealName> {
    let t = typed.trim().trim_matches('/');
    if t.is_empty() {
        return None;
    }
    if valid_name(t) {
        return Some(RealName { name: t.to_owned(), dname: String::new(), dnames: String::new() });
    }
    // as the web client's slugSeg: each run of other characters is one hyphen
    // (a hyphen typed beside it stays), and hyphens and dots go from the ends
    let slug = |s: &str| {
        let (mut out, mut other) = (String::new(), false);
        for ch in s.to_lowercase().chars() {
            if ch.is_ascii_lowercase() || ch.is_ascii_digit() || "._~-".contains(ch) {
                out.push(ch);
                other = false;
            } else if !other {
                out.push('-');
                other = true;
            }
        }
        out.trim_matches(|c| c == '-' || c == '.').to_owned()
    };
    let segs: Vec<&str> = t.split('/').map(str::trim).collect();
    let slugs: Vec<String> = segs.iter().map(|s| slug(s)).collect();
    let name = slugs.join("/");
    if !valid_name(&name) {
        return None;
    }
    let per: Vec<&str> = segs.iter().zip(&slugs).map(|(s, g)| if *s == g { "" } else { *s }).collect();
    let dnames = if per.iter().any(|p| !p.is_empty()) { per.join("/") } else { String::new() };
    Some(RealName { name, dname: per.last().copied().unwrap_or("").to_owned(), dnames })
}

impl RealName {
    /// The query for the display names, as the web client sends them.
    fn query(&self) -> String {
        let mut q = String::new();
        if !self.dname.is_empty() {
            q.push_str(&format!("&dname={}", enc(&self.dname)));
        }
        if !self.dnames.is_empty() {
            q.push_str(&format!("&dnames={}", enc(&self.dnames)));
        }
        q
    }

    /// The names to show, by path: one for each part that needs one.
    pub fn shown(&self) -> Vec<(String, String)> {
        let parts: Vec<&str> = self.name.split('/').collect();
        self.dnames
            .split('/')
            .enumerate()
            .filter(|(i, d)| !d.is_empty() && *i < parts.len())
            .map(|(i, d)| (parts[..=i].join("/"), d.to_owned()))
            .collect()
    }
}

/// A ship address as typed, made into a base URL: a scheme added when
/// missing (http for localhost, https otherwise) and trailing slashes cut.
pub fn base_url(typed: &str) -> String {
    let t = typed.trim().trim_end_matches('/');
    if t.contains("://") {
        return t.to_owned();
    }
    let local = t.starts_with("localhost") || t.starts_with("127.");
    format!("{}://{t}", if local { "http" } else { "https" })
}

/// A thread on a forum board, as the ship lists it. Its text comes only with the thread itself.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct ForumPost {
    pub id: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub up: u64,
    #[serde(default)]
    pub down: u64,
    #[serde(default)]
    pub comments: u64,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    /// When it was last posted to or commented on.
    #[serde(default)]
    pub active: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct ForumComment {
    pub id: u64,
    #[serde(default)]
    pub parent: Option<u64>,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub body: String,
}

/// A board: what it is called, and its threads, newest first, a hundred at most.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Board {
    pub board: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub public: bool,
    #[serde(default)]
    pub count: u64,
    #[serde(default)]
    pub posts: Vec<ForumPost>,
    /// The text the board keeps beside its threads. Not in what the ship gives of a board: `forum_board` reads it from the moderation page.
    #[serde(skip)]
    pub sidebar: String,
}

/// One thread with its text and its comments, oldest first.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Thread {
    pub board: String,
    #[serde(default)]
    pub title: String,
    pub post: ForumPost,
    #[serde(default)]
    pub comments: Vec<ForumComment>,
}

/// The names of the boards the forum's own index page links to, in its
/// order. The ship has no list of boards but that page: each is a link
/// to `/apps/lattice/forum/<name>`, and a name is a term.
pub fn board_names(index_html: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in index_html.split("href=\"/apps/lattice/forum/").skip(1) {
        let name = &part[..part.find('"').unwrap_or(0)];
        let term = name.starts_with(|c: char| c.is_ascii_lowercase()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if term && !out.iter().any(|n| n == name) {
            out.push(name.to_owned());
        }
    }
    out
}

/// A thread's comments in the order they are read, each with how deep
/// it sits: a reply under what it answers, oldest first at every level.
/// One whose parent is not there, or that would nest without end, is
/// read at the top.
pub fn comment_order(comments: &[ForumComment]) -> Vec<(usize, &ForumComment)> {
    let has = |id: u64| comments.iter().any(|c| c.id == id);
    let mut out = Vec::with_capacity(comments.len());
    let mut stack: Vec<(usize, &ForumComment)> = comments.iter().filter(|c| c.parent.is_none_or(|p| !has(p) || p == c.id)).rev().map(|c| (0, c)).collect();
    while let Some((depth, c)) = stack.pop() {
        out.push((depth, c));
        if out.len() > comments.len() {
            break;
        }
        stack.extend(comments.iter().filter(|k| k.parent == Some(c.id) && k.id != c.id).rev().map(|k| (depth + 1, k)));
    }
    // what a loop of parents left out is still read
    let seen: std::collections::HashSet<u64> = out.iter().map(|(_, c)| c.id).collect();
    out.extend(comments.iter().filter(|c| !seen.contains(&c.id)).map(|c| (0, c)));
    out
}

/// The refusals on the ship's page of them: for each, why a post was
/// refused, and the board and how long ago, as the page words them.
/// The ship gives these only as that page, each a row holding a `ti`
/// span and a `me` span (`render-notes` in `lattice-forum-render.hoon`).
pub fn refusal_notes(page: &str) -> Vec<(String, String)> {
    // the text of the first span of a class in a row, with its marks let go and its characters read
    let span = |row: &str, class: &str| {
        let open = format!("<span class=\"{class}\">");
        let from = row.find(&open)? + open.len();
        let inner = &row[from..from + row[from..].find("</span>")?];
        let mut text = String::new();
        let mut rest = inner;
        while let Some(lt) = rest.find('<') {
            text.push_str(&rest[..lt]);
            rest = rest[lt..].find('>').map_or("", |gt| &rest[lt + gt + 1..]);
        }
        text.push_str(rest);
        Some(crate::html::decode(&text))
    };
    page.split("<div class=\"rw\">").skip(1).filter_map(|row| Some((span(row, "ti")?, span(row, "me")?))).collect()
}

/// What the ship's moderation page says of a board. The ship gives
/// these nowhere else: the roles ships hold, the board's sidebar text,
/// its pruning and whether comets may post are read from the forms of
/// `render-mod` in `lattice-forum-render.hoon`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BoardMod {
    /// What a ship with no role of its own may do, as the page words it: `reader`, `poster` or `moderator`.
    pub default_role: String,
    pub public: bool,
    /// Whether comets may post. `None` on a private board, where they never may.
    pub comets: Option<bool>,
    pub sidebar: String,
    /// Whether old threads with a low score are deleted, and the score and the days the form holds.
    pub prune: bool,
    pub min_score: u64,
    pub after_days: u64,
    /// Each ship with a role of its own, and the role as the page words it.
    pub roles: Vec<(String, String)>,
}

/// Reads the moderation page. `None` for a page that is not one.
pub fn board_mod(page: &str) -> Option<BoardMod> {
    fn between<'a>(s: &'a str, a: &str, b: &str) -> Option<&'a str> {
        let from = s.find(a)? + a.len();
        Some(&s[from..from + s[from..].find(b)?])
    }
    let text = |s: &str| crate::html::decode(s);
    let default_role = text(between(page, "Default role: ", "<")?);
    let num = |name: &str| between(page, &format!("name=\"{name}\" value=\""), "\"").and_then(|n| n.parse().ok());
    let roles = between(page, "<table class=\"mod\">", "</table>").map_or_else(Vec::new, |t| t.split("<tr><td>").skip(1).filter_map(|row| Some((text(&row[..row.find("</td>")?]), text(between(row, "</td><td>", "</td>")?)))).collect());
    Some(BoardMod {
        default_role,
        public: page.contains("This board is currently public."),
        comets: if page.contains("Comets may post on this board.") { Some(true) } else if page.contains("Comets may not post on this board.") { Some(false) } else { None },
        sidebar: between(page, "<textarea name=\"sidebar\"", "</textarea>").and_then(|t| t.split_once('>')).map(|(_, t)| text(t)).unwrap_or_default(),
        prune: between(page, "name=\"prune-enabled\"", ">").is_some_and(|t| t.contains("checked")),
        min_score: num("min-score").unwrap_or(2),
        after_days: num("after-days").unwrap_or(7),
        roles,
    })
}

/// The pruning typed, as the ship takes it: a least score, and a count of days that is one or more.
pub fn prune_rule(score: &str, days: &str) -> Result<(u64, u64), String> {
    let score = score.trim().parse::<u64>().map_err(|_| "the least score is a whole number, 0 or more".to_owned())?;
    match days.trim().parse::<u64>() {
        Ok(d) if d >= 1 => Ok((score, d)),
        _ => Err("the days are a whole number, 1 or more".into()),
    }
}

/// A board as typed by its address, and the thread when the address
/// names one: `urb://~ship/forum/board`, with or without `urb://` and
/// `forum/`, and a thread's number after. A board on another ship is
/// kept as `~ship/board`, and one on `own` as its bare name, which is
/// how every forum call here tells whose board it is.
pub fn board_key(typed: &str, own: &str) -> Result<(String, Option<u64>), String> {
    let why = || "a board's address is urb://~ship/forum/board".to_owned();
    let t = typed.trim().trim_start_matches("urb://").trim_end_matches('/');
    let mut parts: Vec<&str> = t.split('/').collect();
    if parts.len() >= 2 && parts[1] == "forum" {
        parts.remove(1);
    }
    let (ship, name, post) = match parts[..] {
        [ship, name] => (ship, name, None),
        [ship, name, post] => (ship, name, Some(post.parse::<u64>().map_err(|_| why())?)),
        _ => return Err(why()),
    };
    let ship = ship_name(ship).filter(|_| ship.starts_with('~')).ok_or_else(why)?;
    let term = name.starts_with(|c: char| c.is_ascii_lowercase()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !term {
        return Err(why());
    }
    Ok((if ship == own { name.to_owned() } else { format!("{ship}/{name}") }, post))
}

/// The tags typed for a thread, as the ship takes them: five at most,
/// each lowercase letters, digits and dashes, starting with a letter,
/// twenty-four characters at most. Commas or spaces part them, and a
/// leading `#` is let go. What is not a tag is said, as the web
/// client's form says it before posting.
pub fn forum_tags(typed: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for t in typed.split(|c: char| c == ',' || c.is_whitespace()).map(|t| t.trim_start_matches('#')).filter(|t| !t.is_empty()) {
        let ok = t.len() <= 24 && t.starts_with(|c: char| c.is_ascii_lowercase()) && t.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !ok {
            return Err(format!("{t} is not a tag: lowercase letters, digits and dashes, starting with a letter, 24 characters at most"));
        }
        if !out.iter().any(|x| x == t) {
            out.push(t.to_owned());
        }
    }
    if out.len() > 5 {
        return Err("a thread carries five tags at most".into());
    }
    Ok(out)
}

impl Conn {
    /// The ship's name, from its session cookie (`urbauth-~zod=..`).
    pub fn ship(&self) -> &str {
        self.cookie.split('=').next().and_then(|n| n.strip_prefix("urbauth-")).unwrap_or("ship")
    }

    /// The session to open with: the environment's, else the one saved by
    /// the last login.
    pub fn load() -> Option<Conn> {
        #[cfg(target_arch = "wasm32")]
        return web::session();
        #[cfg(not(target_arch = "wasm32"))]
        Conn::load_kept()
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn load_kept() -> Option<Conn> {
        if let Some(c) = Conn::from_env() {
            return Some(c);
        }
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(session_path()?).ok()?).ok()?;
        Some(Conn { url: v["url"].as_str()?.to_owned(), cookie: v["cookie"].as_str()?.to_owned() })
    }

    /// Keeps the tree with every page's text, to read when the ship does not answer. In a file only its owner reads, written whole or not at all.
    pub fn keep_tree(&self, nodes: Vec<Node>) -> Result<(), String> {
        keep_at(&kept_path(&self.url).ok_or("no home directory")?, nodes)
    }

    /// Sends one save that waited (`docs/offline-edits.md`). A page made here
    /// goes as a new page, which the ship refuses when the name was taken
    /// meanwhile: taken by this same text, it is done. An edit goes with the
    /// revision it was written over and is applied either way, the ship
    /// keeping what it replaced when that had changed. A text refused for
    /// good is kept as a page of its own before it leaves the queue.
    pub fn send_queued(&self, name: &str, q: &Queued) -> Sent {
        let body = if q.body.is_empty() { "\n" } else { q.body.as_str() };
        let know = queued_know(name);
        let kind = if know.is_some() { "md" } else { q.kind.as_str() };
        let save = |name: &str, how: &str| self.call("POST", &format!("page-save?name={}&type={}&by=rune{how}", enc(name), enc(kind)), Some(body));
        // a memory is written as any save of one is: the last write wins, and there is nothing to flag
        let tried = match know {
            Some(key) => self.know_save(&format!("/{key}"), body).map(|()| "{}".to_owned()),
            None if q.is_new => save(name, "&new=1"),
            None => save(name, &format!("&base={}", q.base)),
        };
        let why = match tried {
            Ok(text) => {
                return match serde_json::from_str::<Saved>(&text) {
                    Ok(a) => Sent::Done { rev: a.rev, kept: (a.conflicted && !a.kept.is_empty()).then_some(a.kept) },
                    Err(e) => Sent::Stop(format!("the ship's answer was not read: {e}")),
                }
            }
            Err(e) if !replay_drop(&e) => return Sent::Stop(e),
            Err(e) => e,
        };
        // the name taken by this very text is an earlier try of this save that landed after all
        if q.is_new && why.starts_with("409") {
            match self.page(name) {
                Ok(there) if there.body == body => return Sent::Done { rev: there.rev, kept: None },
                Err(e) if gone(&e) => return Sent::Stop(e),
                _ => {}
            }
        }
        let stamp = std::process::Command::new("date").arg("+%Y%m%d-%H%M%S").output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).map(|s| s.trim().to_owned()).filter(|s| s.len() == 15);
        let stamp = stamp.unwrap_or_else(|| crate::api::since_epoch().map_or(0, |d| d.as_secs()).to_string());
        let base = aside_name(if know.is_some() { "memory" } else if q.is_new { "create" } else { "edit" }, know.unwrap_or(name), &stamp);
        // never over a kept copy: the first of the name, -2, -3 that is free
        for i in 1..30 {
            let alt = if i > 1 { format!("{base}-{i}") } else { base.clone() };
            match save(&alt, "&new=1") {
                Ok(_) => return Sent::Aside(alt, why),
                Err(e) if e.starts_with("409") => {}
                Err(e) => return Sent::Stop(format!("{why}, and its text could not be kept aside: {e}")),
            }
        }
        Sent::Stop(why)
    }

    /// The deletes and moves that wait for this ship, in the order they were made.
    pub fn ops(&self) -> Vec<QueuedOp> {
        ops_path(&self.url).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn store_ops(&self, ops: &[QueuedOp]) -> Result<(), String> {
        write_private(&ops_path(&self.url).ok_or("no home directory")?, &serde_json::to_vec(ops).map_err(|e| e.to_string())?)
    }

    /// Sends one delete or move that waited, as it would have gone at the time.
    pub fn send_op(&self, op: &QueuedOp) -> Result<(), String> {
        match op {
            QueuedOp::Del(name) => self.delete(name),
            QueuedOp::Move { from, to, dname, dnames } => self.rename_as(from, &RealName { name: to.clone(), dname: dname.clone(), dnames: dnames.clone() }),
        }
    }

    /// The OpenSCAD runtime the ship keeps for browsers.
    pub fn scad_status(&self) -> Result<ScadStatus, String> {
        serde_json::from_str(&self.call("GET", "scad-status", None)?).map_err(|e| e.to_string())
    }

    /// Starts the ship fetching the runtime (`install`), or drops it. The install runs on: its state is read with `scad_status`.
    pub fn scad_runtime(&self, install: bool) -> Result<(), String> {
        self.call("POST", if install { "scad-install" } else { "scad-uninstall" }, Some("")).map(drop)
    }

    /// Whether %obelisk is installed and the Commons mirror on.
    pub fn obelisk(&self) -> Result<Obelisk, String> {
        serde_json::from_str(&self.call("GET", "obelisk-status", None)?).map_err(|e| e.to_string())
    }

    /// Turns the Commons mirror on or off. Off deletes the copy it made.
    pub fn mirror(&self, on: bool) -> Result<(), String> {
        self.call("POST", &format!("mirror-config?enabled={on}"), Some("")).map(drop)
    }

    /// Asks the ship to install %obelisk from the ship that publishes it. It answers at once: `obelisk` says when it is there.
    pub fn obelisk_install(&self) -> Result<(), String> {
        self.call("POST", "obelisk-install", Some("")).map(drop)
    }

    /// Rebuilds the search index from the pages and memories as they are. The ship answers when it is done.
    pub fn reindex(&self) -> Result<(), String> {
        self.call_in(120, "POST", "search-reindex", Some("")).map(drop)
    }

    /// One request to the ship's %mcp, answering its result. It answers as a stream of one event even for one reply, and refuses a request that does not say it accepts one.
    fn mcp_rpc(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let body = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
        #[cfg(not(target_arch = "wasm32"))]
        let text = {
            let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(120)).build();
            match agent.post(&format!("{}/mcp", self.url)).set("cookie", &self.cookie).set("content-type", "application/json").set("accept", "application/json, text/event-stream").send_string(&body) {
                Ok(r) if r.status() == 200 => r.into_string().map_err(|e| e.to_string())?,
                Ok(r) => return Err(format!("{}: this ship has no %mcp", r.status())),
                Err(ureq::Error::Status(code, _)) => return Err(format!("{code}: %mcp did not take that")),
                Err(e) => return Err(e.to_string()),
            }
        };
        #[cfg(target_arch = "wasm32")]
        let text = match web::request("POST", &format!("{}/mcp", self.url), Some("application/json"), Some("application/json, text/event-stream"), Some(&body))? {
            (200, t) => t,
            (code, _) => return Err(format!("{code}: this ship has no %mcp")),
        };
        let frame = text.lines().find_map(|l| l.strip_prefix("data: ")).unwrap_or(text.trim());
        let v: serde_json::Value = serde_json::from_str(frame).map_err(|e| format!("bad reply from %mcp: {e}"))?;
        match v.get("error") {
            Some(e) => Err(format!("%mcp: {e}")),
            None => Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null)),
        }
    }

    /// What of lattice's software the ship has. An error when the ship could not be asked at all, which is not the same as having nothing.
    pub fn stack(&self) -> Result<Stack, String> {
        #[cfg(not(target_arch = "wasm32"))]
        let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(20)).build();
        #[cfg(not(target_arch = "wasm32"))]
        let status = |path: &str| match agent.get(&format!("{}{path}", self.url)).set("cookie", &self.cookie).call() {
            Ok(r) => Ok(r.status()),
            Err(ureq::Error::Status(code, _)) => Ok(code),
            Err(e) => Err(e.to_string()),
        };
        #[cfg(target_arch = "wasm32")]
        let status = |path: &str| web::request("GET", &format!("{}{path}", self.url), None, None, None).map(|(code, _)| code);
        let grubbery = bound(status("/grubbery/api/tree")?);
        let lattice = status("/apps/lattice").is_ok_and(bound);
        // a real handshake, not only an answer: a refusal would otherwise read as %mcp being there
        let hello = serde_json::json!({ "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "lattice-rune", "version": env!("CARGO_PKG_VERSION") } });
        let mcp = self.mcp_rpc("initialize", hello).ok().and_then(|r| r["serverInfo"]["name"].as_str().map(str::to_owned));
        Ok(Stack { mcp, grubbery, lattice })
    }

    /// Asks the ship, through its %mcp, to install %grubbery from the ship that publishes it. The ship answers when it has taken the ask: the desk arrives over minutes.
    pub fn install_grubbery(&self, from: &str) -> Result<(), String> {
        let r = self.mcp_rpc("tools/call", serde_json::json!({ "name": "mcp/install-app", "arguments": { "ship": from, "desk": "grubbery" } }))?;
        if r["isError"].as_bool() == Some(true) {
            return Err(format!("%mcp could not install it: {}", r["content"]));
        }
        Ok(())
    }

    /// Where this ship's lattice lives in its tree, which the change stream's address is under.
    pub fn lat_base(&self) -> Result<String, String> {
        let v: serde_json::Value = serde_json::from_str(&self.call("GET", "streams", None)?).map_err(|e| e.to_string())?;
        v["base"].as_str().filter(|b| !b.is_empty()).map(str::to_owned).ok_or_else(|| "the ship named no base".into())
    }

    /// Listens to the ship's change stream until it ends, giving each event to `on`. Answers whether the stream was registered, and whether a change came after that. `on` answering false stops the listening.
    pub fn beacon_stream(&self, base: &str, mut on: impl FnMut(Beacon) -> bool) -> Result<(bool, bool), String> {
        #[cfg(target_arch = "wasm32")]
        {
            // ponytail: a stream cannot be waited for on the page's one thread. The tree is read again on a timer, as it is without a stream
            let _ = (base, &mut on);
            Err("no stream in the browser build".into())
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            use std::io::Read;
            // no limit on the whole request: the stream is held open. A read that hears nothing for two minutes is a dead one, since the ship ends each stream itself after about eighty seconds
            let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(120)).build();
            let resp = match agent.get(&format!("{}/grubbery/api/keep{base}/beacon/rev", self.url)).set("cookie", &self.cookie).set("accept", "text/event-stream").call() {
                Ok(r) => r,
                Err(ureq::Error::Status(code, _)) => return Err(format!("{code}: no stream")),
                Err(e) => return Err(e.to_string()),
            };
            let (mut rd, mut buf, mut chunk) = (resp.into_reader(), String::new(), [0u8; 4096]);
            let (mut registered, mut bumped) = (false, false);
            loop {
                let n = match rd.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                buf.push_str(&String::from_utf8_lossy(&chunk[..n]));
                for (name, data) in sse_events(&mut buf) {
                    let Some(ev) = beacon_of(&name, &data) else { continue };
                    match &ev {
                        Beacon::Rev { old: true, .. } => registered = true,
                        Beacon::Rev { old: false, .. } => bumped = true,
                        _ => {}
                    }
                    if !on(ev) {
                        return Ok((registered, bumped));
                    }
                }
            }
            Ok((registered, bumped))
        }
    }

    /// What stands at a `urb://` address: a page, a folder, a board, a file. The ship waits on another ship for one of its.
    pub fn urb_read(&self, url: &str) -> Result<Urb, String> {
        urb_parse(&self.call_in(90, "GET", &format!("urb-read?url={}", enc(url)), None)?)
    }

    /// The agent keys, newest first.
    pub fn keys(&self) -> Result<Vec<AgentKey>, String> {
        agent_keys(&self.call("GET", "keys", None)?)
    }

    /// Makes a key from what `key_request` built, and answers its secret: the ship gives it this once and keeps only a hash.
    pub fn key_mint(&self, ask: &serde_json::Value) -> Result<String, String> {
        #[cfg(target_arch = "wasm32")]
        {
            let text = web::text(web::request("POST", &format!("{}/apps/lattice/key-mint", self.url), Some("application/json"), None, Some(&ask.to_string())))?;
            let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            v["token"].as_str().map(str::to_owned).ok_or_else(|| "the ship made no key".into())
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let req = ureq::post(&format!("{}/apps/lattice/key-mint", self.url)).timeout(Duration::from_secs(30)).set("cookie", &self.cookie).set("origin", &self.url).set("content-type", "application/json");
            let text = match req.send_string(&ask.to_string()) {
                Ok(r) => r.into_string().map_err(|e| e.to_string())?,
                Err(ureq::Error::Status(code, r)) => return Err(format!("{code}: {}", r.into_string().unwrap_or_default())),
                Err(e) => return Err(e.to_string()),
            };
            let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            v["token"].as_str().map(str::to_owned).ok_or_else(|| "the ship made no key".into())
        }
    }

    /// Revokes a key by its id: it stops working at once.
    pub fn key_revoke(&self, id: &str) -> Result<(), String> {
        self.call("POST", &format!("key-revoke?id={}", enc(id)), Some("")).map(drop)
    }

    /// The saves that wait for this ship, from the file they are kept in.
    pub fn queue(&self) -> Queue {
        queue_path(&self.url).map(|p| queue_at(&p)).unwrap_or_default()
    }

    /// Keeps the saves that wait. They are nowhere else, so a failure here is one to say.
    pub fn store_queue(&self, q: &Queue) -> Result<(), String> {
        write_private(&queue_path(&self.url).ok_or("no home directory")?, &serde_json::to_vec(q).map_err(|e| e.to_string())?)
    }

    /// The tree as it was last kept for this ship, and how many seconds ago. Its `since` is empty, so the next read of the ship is a whole one.
    pub fn kept_tree(&self) -> Option<(Dump, u64)> {
        kept_at(&kept_path(&self.url)?)
    }

    /// Keeps this session for the next run, in a file only its owner reads.
    pub fn remember(&self) -> Result<(), String> {
        let p = session_path().ok_or("no home directory")?;
        std::fs::create_dir_all(p.parent().ok_or("no parent")?).map_err(|e| e.to_string())?;
        let body = serde_json::json!({ "url": self.url, "cookie": self.cookie }).to_string();
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&p).map_err(|e| e.to_string())?;
            f.write_all(body.as_bytes()).map_err(|e| e.to_string())
        }
        #[cfg(not(unix))]
        std::fs::write(&p, body).map_err(|e| e.to_string())
    }

    /// Forgets the saved session.
    pub fn forget() {
        if let Some(p) = session_path() {
            let _ = std::fs::remove_file(p);
        }
    }

    /// Signs in with the ship's access code and returns the session.
    pub fn login(typed_url: &str, code: &str) -> Result<Conn, String> {
        #[cfg(target_arch = "wasm32")]
        {
            // the page is served by the ship, which signed the browser in before it served it
            let _ = (typed_url, code);
            Err("sign in on the ship's own page".into())
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let url = base_url(typed_url);
            // the cookie comes on the redirect itself, so it is not followed
            let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(20)).build();
            let res = agent
                .post(&format!("{url}/~/login"))
                .set("content-type", "application/x-www-form-urlencoded")
                .send_string(&format!("password={}", enc(code.trim())));
            let res = match res {
                Ok(r) => r,
                Err(ureq::Error::Status(_, _)) => return Err("that access code was refused".into()),
                Err(e) => return Err(format!("could not reach {url}: {e}")),
            };
            let cookie = res.header("set-cookie").and_then(|c| c.split(';').next()).unwrap_or("").trim().to_owned();
            if !cookie.starts_with("urbauth-~") {
                return Err("the ship gave no session".into());
            }
            Ok(Conn { url, cookie })
        }
    }

    /// From `LATTICE_URL` and `LATTICE_COOKIE` (a file holding the cookie
    /// header's value), `None` when either is unset or unreadable.
    pub fn from_env() -> Option<Conn> {
        let url = std::env::var("LATTICE_URL").ok()?.trim_end_matches('/').to_owned();
        let cookie = std::fs::read_to_string(std::env::var("LATTICE_COOKIE").ok()?).ok()?.trim().to_owned();
        Some(Conn { url, cookie })
    }

    fn call(&self, method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
        self.call_in(30, method, path, body)
    }

    /// `call` with its own time limit, for the few routes the ship is slow to answer.
    fn call_in(&self, secs: u64, method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
        self.call_url(secs, method, &format!("{}/apps/lattice/{path}", self.url), body)
    }

    /// One request of the ship, at any of its addresses, as the owner.
    fn call_url(&self, secs: u64, method: &str, url: &str, body: Option<&str>) -> Result<String, String> {
        #[cfg(target_arch = "wasm32")]
        {
            let _ = secs;
            web::text(web::request(method, url, None, None, body))
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let req = ureq::request(method, url)
                .timeout(Duration::from_secs(secs))
                .set("cookie", &self.cookie)
                // the ship refuses a cross-site write, and reads the origin to tell
                .set("origin", &self.url);
            let res = match body {
                Some(b) => req.send_string(b),
                None => req.call(),
            };
            match res {
                Ok(r) => r.into_string().map_err(|e| e.to_string()),
                Err(ureq::Error::Status(code, r)) => Err(format!("{code}: {}", r.into_string().unwrap_or_default())),
                Err(e) => Err(e.to_string()),
            }
        }
    }

    /// One scry through eyre, as the web client's theme script asks: nothing when the ship has nothing there.
    fn scry(&self, path: &str) -> Result<Option<serde_json::Value>, String> {
        match self.call_url(30, "GET", &format!("{}/~/scry/{path}.json", self.url), None) {
            Ok(t) => serde_json::from_str(&t).map(Some).map_err(|e| e.to_string()),
            Err(e) if e.starts_with("404") => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// What the ship says of themes now, over what it said before: lattice's
    /// own from its %settings bucket, Talon's when it is followed, and the
    /// profile's colour when an accent asks for it. Talon's bucket or the
    /// profile not answering leaves what was had.
    pub fn worn(&self, mut w: crate::theme::Worn) -> Result<crate::theme::Worn, String> {
        w.lattice(self.scry("settings/bucket/lattice/ui-prefs")?.as_ref());
        if w.reads_talon() {
            if let Ok(b) = self.scry("settings/bucket/talon/ui-prefs") {
                w.talon(b.as_ref());
            }
        }
        if w.wants_profile() {
            if let Ok(c) = self.scry("contacts/v1/self") {
                w.contacts(c.as_ref());
            }
        }
        Ok(w)
    }

    /// Every node, with the bodies written since `since` (all of them when
    /// it is empty). One deep read on the ship, as the web client makes.
    pub fn dump(&self, since: &str) -> Result<Dump, String> {
        let q = if since.is_empty() { "page-dump".to_owned() } else { format!("page-dump?since={}", enc(since)) };
        serde_json::from_str(&self.call("GET", &q, None)?).map_err(|e| e.to_string())
    }

    /// The whole store as one vault archive, and what it holds and lacks.
    /// Read as the web client reads it: the dump, then the memories and the
    /// share modes, with a page the dump gave no body for read on its own.
    pub fn vault(&self, now: u64) -> Result<crate::vault::Built, String> {
        let json = |path: &str| self.call_in(120, "GET", path, None).ok().and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
        let dump = json("page-dump").ok_or("export failed: could not read the page tree")?;
        let source = |name: &str| self.page(name).ok().map(|p| p.body);
        Ok(crate::vault::build(&dump, json("know-all").as_ref(), json("page-scopes").as_ref(), &source, now))
    }

    /// Puts an archive back, as the web client does: the folders, the pages
    /// fifty at a time (one by one when the ship refuses a batch, so only
    /// the page at fault is lost), then the sensitive marks, share modes and
    /// display names of what was saved, then the memories. Answers what to
    /// say and whether all of it went well.
    pub fn vault_restore(&self, a: &crate::vault::Archive) -> (String, bool) {
        let post = |q: String, body: &str| self.call_in(120, "POST", &q, Some(body));
        let (mut said, mut well) = (a.warnings.clone(), true);
        let mut saved = std::collections::BTreeSet::new();
        if a.page_files > 0 {
            for d in crate::vault::folders(&a.pages) {
                let _ = post(format!("folder-new?name={}", enc(&d)), "");
            }
            let mut failed = Vec::new();
            for part in a.pages.chunks(50) {
                // the ship refuses an empty body
                let body = |p: &crate::vault::PageIn| if p.body.is_empty() { "\n".to_owned() } else { p.body.clone() };
                let items: Vec<(String, &str, String)> = part.iter().map(|p| (p.name.clone(), p.kind, body(p))).collect();
                if self.save_batch(&items).is_ok() {
                    saved.extend(part.iter().map(|p| p.name.clone()));
                    continue;
                }
                for p in part {
                    match post(format!("page-save?name={}&type={}", enc(&p.name), p.kind), &body(p)) {
                        Ok(_) => drop(saved.insert(p.name.clone())),
                        Err(_) => failed.push(p.name.clone()),
                    }
                }
            }
            let mut bits = vec![format!("pages: {} restored", saved.len())];
            if a.skip_ext > 0 {
                bits.push(format!("{} skipped (unknown extension)", a.skip_ext));
            }
            if a.skip_name > 0 {
                bits.push(format!("{} skipped (bad name)", a.skip_name));
            }
            if !failed.is_empty() {
                well = false;
                let more = if failed.len() > 5 { format!(" and {} more", failed.len() - 5) } else { String::new() };
                bits.push(format!("{} failed: {}{more}", failed.len(), failed.iter().take(5).cloned().collect::<Vec<_>>().join(", ")));
            }
            let plan = crate::vault::plan(a, &saved);
            if plan.dropped > 0 {
                bits.push(format!("{} share mode or name entries ignored (no restored page)", plan.dropped));
            }
            said.push(bits.join(", "));
            // the ship answers a batch before every page of it is there to
            // be marked, so what it says is not there is asked for again
            let post = |q: String, body: &str| {
                let mut tries = 0;
                loop {
                    match post(q.clone(), body) {
                        Err(e) if e.starts_with("404") && tries < 5 => {
                            tries += 1;
                            pause(Duration::from_secs(1));
                        }
                        r => return r,
                    }
                }
            };
            // the marks first: a page must not be shared a moment before it is marked
            let mut tally = |what: &str, bad: usize| {
                if bad > 0 {
                    well = false;
                    said.push(format!("{what}: {bad} failed"));
                }
            };
            tally("sensitive marks", plan.sensitive.iter().filter(|p| post(format!("page-sensitive?name={}&on=1", enc(p)), "").is_err()).count());
            tally("share modes", plan.share.iter().filter(|(n, m)| post(format!("page-share?name={}&mode={}", enc(n), enc(m)), "").is_err()).count());
            // a move to the same path is how the ship sets a display name
            tally("display names", plan.names.iter().filter(|(p, d)| post(format!("page-move?from={}&to={}&dname={}", enc(p), enc(p), enc(d)), "").is_err()).count());
        }
        if let Some(know) = &a.know {
            match post("know-import".into(), know) {
                Ok(_) => said.push("memories restored".into()),
                Err(e) => {
                    well = false;
                    said.push(format!("the memories were not restored: {e}"));
                }
            }
        }
        (said.join(". "), well)
    }

    pub fn tree(&self) -> Result<Vec<Node>, String> {
        Ok(self.dump("")?.nodes)
    }

    pub fn page(&self, name: &str) -> Result<Page, String> {
        let raw = self.call("GET", &format!("page-source?name={}", enc(name)), None)?;
        let mut p: Page = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        p.name = name.to_owned();
        Ok(p)
    }

    /// Saves over `base`, the rev the text was read at. The ship answers 409
    /// when the page has moved past it.
    pub fn save(&self, p: &Page, base: u64) -> Result<u64, String> {
        let q = format!("page-save?name={}&type={}&by=rune&base={base}&cas=1", enc(&p.name), enc(&p.kind));
        let s: Saved = serde_json::from_str(&self.call("POST", &q, Some(&p.body))?).map_err(|e| e.to_string())?;
        Ok(s.rev)
    }

    /// Every stored revision of a page, newest first.
    pub fn history(&self, name: &str) -> Result<Vec<Rev>, String> {
        let h: History = serde_json::from_str(&self.call("GET", &format!("page-history?name={}", enc(name)), None)?).map_err(|e| e.to_string())?;
        Ok(h.revisions)
    }

    /// The page as it was at `rev`.
    pub fn page_at(&self, name: &str, rev: u64) -> Result<Page, String> {
        let raw = self.call("GET", &format!("page-source-at?name={}&rev={rev}", enc(name)), None)?;
        let mut p: Page = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        p.name = name.to_owned();
        p.rev = rev;
        Ok(p)
    }

    /// Every memory with its text, in one request.
    pub fn know_all(&self) -> Result<Vec<Know>, String> {
        let k: Knows = serde_json::from_str(&self.call("GET", "know-all", None)?).map_err(|e| e.to_string())?;
        Ok(k.items)
    }

    /// The bookmarks the reader keeps, newest first.
    pub fn bookmarks(&self) -> Result<Vec<Bookmark>, String> {
        serde_json::from_str(&self.call("GET", "bookmarks-json", None)?).map_err(|e| e.to_string())
    }

    /// Keeps a bookmark, in a folder or, with none named, in no folder.
    pub fn bookmark(&self, url: &str, title: &str, folder: &str) -> Result<(), String> {
        self.call("POST", &format!("bookmark?url={}&title={}&folder={}", enc(url), enc(title), enc(folder)), Some("")).map(drop)
    }

    /// Moves a bookmark to a folder, or out of one with none named. Its place in the list stays.
    pub fn bookmark_move(&self, url: &str, folder: &str) -> Result<(), String> {
        self.call("POST", &format!("bookmark-move?url={}&folder={}", enc(url), enc(folder)), Some("")).map(drop)
    }

    /// Drops a bookmark.
    pub fn unbookmark(&self, url: &str) -> Result<(), String> {
        self.call("POST", &format!("unbookmark?url={}", enc(url)), Some("")).map(drop)
    }

    /// Writes a memory, new or not. `key` starts with a slash.
    pub fn know_save(&self, key: &str, body: &str) -> Result<(), String> {
        // the ship refuses an empty body
        self.call("POST", &format!("know-save?key={}", enc(key)), Some(if body.is_empty() { "\n" } else { body })).map(drop)
    }

    /// Renames or moves a memory. Both keys start with a slash. The ship
    /// refuses a key that is not there (404) and one already taken (409).
    /// Only the text goes with it: the new key's history starts again.
    pub fn know_move(&self, from: &str, to: &str) -> Result<(), String> {
        self.call("POST", &format!("know-move?from={}&to={}", enc(from), enc(to)), Some("")).map(drop)
    }

    /// Sends one of the forum's own forms, as the ship's forum pages do: `path` under `/forum/`, and the
    /// fields. The ship answers by sending the browser on to a page, which is not followed, and it
    /// answers the same when its rules refuse what was sent: the board is read again to see.
    fn forum_form(&self, path: &str, fields: &[(&str, &str)]) -> Result<(), String> {
        #[cfg(target_arch = "wasm32")]
        {
            let body = fields.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect::<Vec<_>>().join("&");
            let root = if path.starts_with('~') { "forum-remote" } else { "forum" };
            // the browser follows the ship's redirect itself, and the page it lands on is not used
            web::text(web::request("POST", &format!("{}/apps/lattice/{root}/{path}", self.url), Some(web::FORM), None, Some(&body))).map(drop)
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let body = fields.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect::<Vec<_>>().join("&");
            // the ship waits on another ship before it answers for a board there: about 30 s when that ship is not reachable
            let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(90)).build();
            // a board on another ship (`~ship/board`) has the same forms under its own route, which the ship sends on to that ship
            let root = if path.starts_with('~') { "forum-remote" } else { "forum" };
            let res = agent.post(&format!("{}/apps/lattice/{root}/{path}", self.url)).set("cookie", &self.cookie).set("origin", &self.url).set("content-type", "application/x-www-form-urlencoded").send_string(&body);
            match res {
                Ok(_) => Ok(()),
                Err(ureq::Error::Status(code, _)) if (300..400).contains(&code) => Ok(()),
                Err(ureq::Error::Status(code, r)) => Err(format!("{code}: {}", r.into_string().unwrap_or_default())),
                Err(e) => Err(e.to_string()),
            }
        }
    }

    /// Starts a thread on one of this ship's boards: a title, and a link, a text or both. Tags as `forum_tags` gives them.
    pub fn forum_submit(&self, board: &str, title: &str, link: &str, body: &str, tags: &[String]) -> Result<(), String> {
        let mut fields = vec![("title", title)];
        if !link.is_empty() {
            fields.push(("url", link));
        }
        if !body.is_empty() {
            fields.push(("body", body));
        }
        let names = ["t1", "t2", "t3", "t4", "t5"];
        fields.extend(names.iter().zip(tags).map(|(n, t)| (*n, t.as_str())));
        self.forum_form(&format!("{board}/submit"), &fields)
    }

    /// Comments on a thread, or with `parent` answers a comment of it.
    pub fn forum_comment(&self, board: &str, post: u64, parent: Option<u64>, body: &str) -> Result<(), String> {
        let parent = parent.map(|p| p.to_string());
        let mut fields = vec![("body", body)];
        if let Some(p) = &parent {
            fields.push(("parent", p));
        }
        self.forum_form(&format!("{board}/{post}/comment"), &fields)
    }

    /// The posts other ships refused, newest as the ship lists them: why, and where and when.
    pub fn forum_notes(&self) -> Result<Vec<(String, String)>, String> {
        let page = self.call("GET", "forum-notes", None)?;
        // a page that is not the refusals page is not read as an empty list
        if !page.contains("Refused posts") {
            return Err("the ship did not give its page of refusals".into());
        }
        Ok(refusal_notes(&page))
    }

    /// Clears every refusal note.
    pub fn forum_notes_clear(&self) -> Result<(), String> {
        #[cfg(target_arch = "wasm32")]
        {
            web::text(web::request("POST", &format!("{}/apps/lattice/forum-notes/clear", self.url), None, None, Some(""))).map(drop)
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(30)).build();
            match agent.post(&format!("{}/apps/lattice/forum-notes/clear", self.url)).set("cookie", &self.cookie).set("origin", &self.url).send_string("") {
                Ok(_) => Ok(()),
                Err(ureq::Error::Status(code, _)) if (300..400).contains(&code) => Ok(()),
                Err(ureq::Error::Status(code, r)) => Err(format!("{code}: {}", r.into_string().unwrap_or_default())),
                Err(e) => Err(e.to_string()),
            }
        }
    }

    /// Makes a board: a name (a term), a title, a description, and what those with no role of their own may do: `poster`, `reader` or `mod`.
    pub fn forum_new(&self, name: &str, title: &str, description: &str, role: &str) -> Result<(), String> {
        self.forum_form("_new", &[("name", name), ("title", title), ("description", description), ("role", role)])
    }

    /// Sets a board's title and description.
    pub fn forum_edit(&self, board: &str, title: &str, description: &str) -> Result<(), String> {
        self.forum_form(&format!("{board}/mod/edit-info"), &[("title", title), ("description", description)])
    }

    /// Flips a board between public and private. The form has no other way: it says neither which.
    pub fn forum_flip_public(&self, board: &str) -> Result<(), String> {
        self.forum_form(&format!("{board}/mod/public"), &[("x", "1")])
    }

    /// Deletes a board with every thread on it.
    pub fn forum_board_delete(&self, board: &str) -> Result<(), String> {
        self.forum_form(&format!("{board}/mod/delete"), &[("x", "1")])
    }

    /// What the moderation page says of a board: roles, sidebar, pruning, comets.
    pub fn forum_mod(&self, board: &str) -> Result<BoardMod, String> {
        board_mod(&self.call("GET", &format!("forum/{board}/mod"), None)?).ok_or_else(|| "the ship did not give the board's moderation page".into())
    }

    /// Gives a ship a role on a board (`reader`, `poster` or `mod`), or with none sets it to the board's default, which the ship still lists by name.
    pub fn forum_role(&self, board: &str, who: &str, role: Option<&str>) -> Result<(), String> {
        match role {
            Some(r) => self.forum_form(&format!("{board}/mod/role"), &[("who", who), ("role", r)]),
            None => self.forum_form(&format!("{board}/mod/remove-role"), &[("who", who)]),
        }
    }

    /// Sets the text beside a board's threads. Empty hides it.
    pub fn forum_sidebar(&self, board: &str, text: &str) -> Result<(), String> {
        self.forum_form(&format!("{board}/sidebar"), &[("sidebar", text)])
    }

    /// Sets a board's pruning: threads scoring under the least score are deleted once so many days old. `None` turns it off.
    pub fn forum_prune(&self, board: &str, rule: Option<(u64, u64)>) -> Result<(), String> {
        match rule {
            Some((score, days)) => self.forum_form(&format!("{board}/mod/prune"), &[("prune-enabled", "on"), ("min-score", &score.to_string()), ("after-days", &days.to_string())]),
            None => self.forum_form(&format!("{board}/mod/prune"), &[("x", "1")]),
        }
    }

    /// Flips whether comets may post on a board. As with public, the form says neither which.
    pub fn forum_comets(&self, board: &str) -> Result<(), String> {
        self.forum_form(&format!("{board}/mod/comets"), &[("x", "1")])
    }

    /// Invites a ship to a private board, or takes the invitation back. Answers whether the ship was told of an invitation: it holds either way.
    pub fn forum_invite(&self, board: &str, ship: &str, add: bool) -> Result<bool, String> {
        let q = format!("forum-{}?board={}&ship={}", if add { "invite" } else { "revoke" }, enc(board), enc(ship));
        // the ship waits a few seconds on the other ship before it answers
        let g: Granted = serde_json::from_str(&self.call_in(120, "POST", &q, Some(""))?).map_err(|e| e.to_string())?;
        Ok(g.notified)
    }

    /// Gives a thread this ship's point. Once given it stays: the forms have no way to take it back.
    pub fn forum_vote(&self, board: &str, post: u64) -> Result<(), String> {
        self.forum_form(&format!("{board}/vote"), &[("target", &format!("post-{post}"))])
    }

    /// Pins a thread to the top of its board, or lets it go.
    pub fn forum_pin(&self, board: &str, post: u64, on: bool) -> Result<(), String> {
        self.forum_form(&format!("{board}/{post}/pin"), &[("pinned", if on { "true" } else { "false" })])
    }

    /// Deletes a thread, or with `comment` one comment of it. Its author or a mod of the board may.
    pub fn forum_delete(&self, board: &str, post: u64, comment: Option<u64>) -> Result<(), String> {
        match comment {
            Some(id) => self.forum_form(&format!("{board}/{post}/delete-comment"), &[("comment-id", &id.to_string())]),
            None => self.forum_form(&format!("{board}/{post}/delete"), &[("x", "1")]),
        }
    }

    /// Sets a thread's tags to these, five at most. None clears them.
    pub fn forum_set_tags(&self, board: &str, post: u64, tags: &[String]) -> Result<(), String> {
        let names = ["t1", "t2", "t3", "t4", "t5"];
        let mut fields: Vec<(&str, &str)> = names.iter().zip(tags).map(|(n, t)| (*n, t.as_str())).collect();
        // a form with no field at all is not one the ship reads
        fields.push(("x", "1"));
        self.forum_form(&format!("{board}/{post}/tags"), &fields)
    }

    /// The boards on this ship, each with its threads. The names come from the forum's index page, fifty at most.
    pub fn forum_boards(&self) -> Result<Vec<Board>, String> {
        let names = board_names(&self.call("GET", "forum", None)?);
        names.iter().take(50).map(|n| self.board_bare(n)).collect()
    }

    /// One of this ship's boards, with its threads and the text beside them.
    pub fn forum_board(&self, board: &str) -> Result<Board, String> {
        let mut b = self.board_bare(board)?;
        // the moderation page is the only place the ship gives that text, and only of its own boards. A board read without it is still read
        if !board.contains('/') {
            b.sidebar = self.forum_mod(board).map(|m| m.sidebar).unwrap_or_default();
        }
        Ok(b)
    }

    /// The address of a board: this ship's by its name, another ship's as `~ship/board`.
    fn board_url(&self, board: &str) -> String {
        match board.split_once('/') {
            Some((ship, name)) => format!("urb://{ship}/forum/{name}"),
            None => format!("urb://{}/forum/{board}", self.ship()),
        }
    }

    fn board_bare(&self, board: &str) -> Result<Board, String> {
        let mut b: Board = serde_json::from_str(&self.call_in(60, "GET", &format!("urb-read?url={}", enc(&self.board_url(board))), None)?).map_err(|e| e.to_string())?;
        // what is done to it next goes by the same name it was read by
        b.board = board.to_owned();
        Ok(b)
    }

    /// A thread of one of this ship's boards, with its text and comments.
    pub fn forum_thread(&self, board: &str, post: u64) -> Result<Thread, String> {
        let url = format!("{}/{post}", self.board_url(board));
        let mut th: Thread = serde_json::from_str(&self.call_in(60, "GET", &format!("urb-read?url={}", enc(&url)), None)?).map_err(|e| e.to_string())?;
        th.board = board.to_owned();
        Ok(th)
    }

    /// The core memories an agent key wrote, which every session loads as rules until the owner keeps or untags each. Keys with their slashes, in order.
    pub fn know_core_agents(&self) -> Result<Vec<String>, String> {
        serde_json::from_str(&self.call("GET", "know-core-agents", None)?).map_err(|e| e.to_string())
    }

    /// The owner vouches for a core memory an agent key wrote: it is the owner's from now on.
    pub fn know_core_keep(&self, key: &str) -> Result<(), String> {
        self.call("POST", &format!("know-core-keep?key={}", enc(key)), Some("")).map(drop)
    }

    /// A memory's revisions, oldest first. The key starts with a slash.
    pub fn know_history(&self, key: &str) -> Result<Vec<Rev>, String> {
        let h: History = serde_json::from_str(&self.call("GET", &format!("know-history?key={}", enc(key)), None)?).map_err(|e| e.to_string())?;
        Ok(h.revisions)
    }

    /// A memory's text as it was at `rev`.
    pub fn know_at(&self, key: &str, rev: u64) -> Result<String, String> {
        let k: Know = serde_json::from_str(&self.call("GET", &format!("know-read-at?key={}&rev={rev}", enc(key)), None)?).map_err(|e| e.to_string())?;
        Ok(k.body)
    }

    /// Makes an old revision of a memory its newest. What it replaces stays in the history.
    pub fn know_restore_rev(&self, key: &str, rev: u64) -> Result<(), String> {
        self.call("POST", &format!("know-restore-rev?key={}&rev={rev}", enc(key)), Some("")).map(drop)
    }

    /// The keys of the deleted memories still in the trash, each with its slash, in order.
    pub fn know_trash(&self) -> Result<Vec<String>, String> {
        let v: serde_json::Value = serde_json::from_str(&self.call("GET", "know-trash", None)?).map_err(|e| e.to_string())?;
        let mut keys: Vec<String> = v["keys"].as_array().map_or(Vec::new(), |a| a.iter().filter_map(|k| k["key"].as_str().map(str::to_owned)).collect());
        keys.sort();
        Ok(keys)
    }

    /// Brings a deleted memory back from the trash. The key starts with a slash.
    pub fn know_restore(&self, key: &str) -> Result<(), String> {
        self.call("POST", &format!("know-restore?key={}", enc(key)), Some("")).map(drop)
    }

    /// Puts a tag on a memory, or takes one off. The key starts with a slash. The ship folds a tag to lower case.
    pub fn know_tag(&self, key: &str, tag: &str, on: bool) -> Result<(), String> {
        self.call("POST", &format!("know-{}?key={}&tag={}", if on { "tag" } else { "untag" }, enc(key), enc(tag)), Some("")).map(drop)
    }

    pub fn know_delete(&self, key: &str) -> Result<(), String> {
        self.call("POST", &format!("know-delete?key={}", enc(key)), Some("")).map(drop)
    }

    /// Sets who may read a page: `private`, `shared` (ships over Urbit) or
    /// `clearweb` (anyone with the link).
    pub fn share(&self, name: &str, mode: &str) -> Result<(), String> {
        let q = if mode == "private" { format!("page-share-clear?name={}", enc(name)) } else { format!("page-share?name={}&mode={}", enc(name), enc(mode)) };
        self.call("POST", &q, Some("")).map(drop)
    }

    /// Sets a folder's share setting. Every page in it with none of its own
    /// takes it, and so do pages made or moved in later. `private` clears it.
    pub fn share_dir(&self, name: &str, mode: &str) -> Result<(), String> {
        self.call_in(120, "POST", &format!("page-share-dir?name={}&mode={}", enc(name), enc(mode)), Some("")).map(drop)
    }

    /// Where a folder shared in `mode` is read from, `None` for a private one.
    pub fn dir_address(&self, name: &str, mode: &str) -> Option<String> {
        self.address(name, mode).map(|a| if mode == "clearweb" { format!("{a}/") } else { a })
    }

    /// Where a page shared in `mode` is read from, `None` for a private one.
    pub fn address(&self, name: &str, mode: &str) -> Option<String> {
        match mode {
            "clearweb" => Some(format!("{}/apps/lattice/c/{name}", self.url)),
            "shared" => Some(format!("urb://{}/{name}", self.ship())),
            _ => None,
        }
    }

    /// The ship's access list: every group with its ships and paths.
    pub fn groups(&self) -> Result<Vec<Group>, String> {
        serde_json::from_str(&self.call("GET", "share-groups", None)?).map_err(|e| e.to_string())
    }

    /// Where this lattice lives on the ship: the start of every grant path.
    pub fn base(&self) -> Result<String, String> {
        let s: Streams = serde_json::from_str(&self.call("GET", "streams", None)?).map_err(|e| e.to_string())?;
        Ok(s.base)
    }

    /// Writes a group: its ships and the paths it may read and write
    /// replace what it had. The ship keeps anything else the group holds.
    pub fn group_save(&self, g: &Group) -> Result<(), String> {
        let body = serde_json::json!({ "ships": g.ships, "peek": g.peek, "make": g.make }).to_string();
        self.call_in(120, "POST", &format!("share-group-save?name={}", enc(&g.name)), Some(&body)).map(drop)
    }

    pub fn group_delete(&self, name: &str) -> Result<(), String> {
        self.call_in(120, "POST", &format!("share-group-del?name={}", enc(name)), Some("")).map(drop)
    }

    /// The pages other ships said they shared with this one.
    pub fn shared(&self) -> Result<Vec<Shared>, String> {
        serde_json::from_str(&self.call("GET", "shared-with-me", None)?).map_err(|e| e.to_string())
    }

    /// Moves a page shared with this ship into its own tree, as a link at
    /// `to`. The entry leaves shared with me, and the host's grant is not
    /// touched. The host is asked for the page's kind, so it is refused while the host is away.
    pub fn link_make(&self, sh: &Shared, to: &str) -> Result<(), String> {
        self.call_in(60, "POST", &format!("link-make?host={}&path={}&to={}", enc(&sh.host), enc(&sh.path), enc(to)), Some("")).map(drop)
    }

    /// Moves a link back to shared with me, and drops it from the tree.
    pub fn link_unmake(&self, name: &str) -> Result<(), String> {
        self.call("POST", &format!("link-unmake?name={}", enc(name)), Some("")).map(drop)
    }

    /// Drops a notice from the list. It changes nothing on the host.
    pub fn shared_forget(&self, sh: &Shared) -> Result<(), String> {
        self.call("POST", &format!("shared-with-me-del?host={}&path={}", enc(&sh.host), enc(&sh.path)), Some("")).map(drop)
    }

    /// Reads a shared page from its host, through this ship. The page's
    /// name is `~host/name`, and its kind is the host's, or text when the
    /// host's file is not a lattice page.
    pub fn browse(&self, sh: &Shared) -> Result<Page, String> {
        // the ship waits on the host, and asks it once more where its lattice lives when the first try fails
        let raw = self.call_in(90, "GET", &format!("browse-file?ship={}&path={}", enc(&sh.host), enc(&sh.path)), None)?;
        let b: Browsed = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        Ok(Page { name: format!("{}/{}", sh.host, sh.name()), body: b.body, kind: b.builder.unwrap_or_else(|| "text".into()), rev: b.rev })
    }

    /// Writes a shared page back to its host over `base`. Answers the new
    /// rev, or `None` when the host took the write but did not confirm it.
    pub fn remote_save(&self, sh: &Shared, body: &str, base: u64) -> Result<Option<u64>, String> {
        let q = format!("remote-save?ship={}&path={}&base={base}", enc(&sh.host), enc(&sh.path));
        let r: RemoteSaved = serde_json::from_str(&self.call_in(120, "POST", &q, Some(body))?).map_err(|e| e.to_string())?;
        Ok((r.outcome == "landed").then_some(r.rev))
    }

    /// Whether a page or folder is marked sensitive itself. A page under a
    /// sensitive folder is sensitive too, and this does not say so.
    pub fn sensitive(&self, name: &str) -> Result<bool, String> {
        let f: Flag = serde_json::from_str(&self.call("GET", &format!("page-sensitive?name={}", enc(name)), None)?).map_err(|e| e.to_string())?;
        Ok(f.on)
    }

    /// Marks a page or folder sensitive, or clears the mark. Marking takes
    /// back what folders and groups granted. Answers whether the page is
    /// still shared by its own setting, which the mark leaves alone.
    pub fn set_sensitive(&self, name: &str, on: bool) -> Result<bool, String> {
        let q = format!("page-sensitive?name={}&on={}", enc(name), if on { 1 } else { 0 });
        let f: Flag = serde_json::from_str(&self.call_in(120, "POST", &q, Some(""))?).map_err(|e| e.to_string())?;
        Ok(f.shared)
    }

    /// The address an image on this ship is fetched at: a path from the
    /// ship's root as it is, and any other path from the app's own
    /// folder, which is where the web client's page resolves it.
    pub fn image_url(&self, src: &str) -> String {
        if src.starts_with('/') {
            format!("{}{src}", self.url)
        } else {
            format!("{}/apps/lattice/{src}", self.url)
        }
    }

    pub fn cookie(&self) -> &str {
        &self.cookie
    }

    /// The newest comments across every page (the ship gives 200 at most).
    pub fn comments(&self) -> Result<Vec<Comment>, String> {
        let i: Inbox = serde_json::from_str(&self.call_in(60, "GET", "comments-inbox", None)?).map_err(|e| e.to_string())?;
        Ok(i.items)
    }

    /// Whether comments are on for a page, by the nearest setting at or above it.
    pub fn comments_on(&self, name: &str) -> Result<bool, String> {
        let r: Rendered = serde_json::from_str(&self.call("GET", &format!("page-source?name={}&render=1", enc(name)), None)?).map_err(|e| e.to_string())?;
        Ok(r.comments)
    }

    /// Whether orrery keeps a page, so that the ship refuses its saves.
    /// `None` where the ship does not say, which is every page but `orrery/map`.
    pub fn kept(&self, name: &str) -> Result<Option<bool>, String> {
        let r: Rendered = serde_json::from_str(&self.call("GET", &format!("page-source?name={}&render=1", enc(name)), None)?).map_err(|e| e.to_string())?;
        Ok(r.kept)
    }

    /// The page as the ship renders it to HTML: what its preview shows.
    /// Empty for a kind the ship does not render.
    pub fn rendered(&self, name: &str) -> Result<String, String> {
        let r: Rendered = serde_json::from_str(&self.call_in(60, "GET", &format!("page-source?name={}&render=1", enc(name)), None)?).map_err(|e| e.to_string())?;
        Ok(r.html)
    }

    /// Turns comments on or off at a page or folder.
    pub fn set_comments(&self, name: &str, on: bool) -> Result<(), String> {
        self.call("POST", &format!("page-comments?name={}&on={}", enc(name), if on { 1 } else { 0 }), Some("")).map(drop)
    }

    /// Posts the owner's comment on a page. The ship answers a form post
    /// with a redirect to the reader, which is not followed: that it
    /// answered so is the success.
    pub fn comment(&self, page: &str, body: &str) -> Result<(), String> {
        #[cfg(target_arch = "wasm32")]
        {
            web::text(web::request("POST", &format!("{}/apps/lattice/comment?page={}", self.url, enc(page)), Some(web::FORM), None, Some(&format!("body={}", enc(body))))).map(drop)
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(30)).build();
            let res = agent
                .post(&format!("{}/apps/lattice/comment?page={}", self.url, enc(page)))
                .set("cookie", &self.cookie)
                .set("origin", &self.url)
                .set("content-type", "application/x-www-form-urlencoded")
                .send_string(&format!("body={}", enc(body)));
            match res {
                Ok(_) => Ok(()),
                Err(ureq::Error::Status(code, r)) => Err(format!("{code}: {}", r.into_string().unwrap_or_default())),
                Err(e) => Err(e.to_string()),
            }
        }
    }

    /// Comet comments held for the owner's yes, across every page, newest first.
    pub fn held(&self) -> Result<Vec<Comment>, String> {
        let i: Inbox = serde_json::from_str(&self.call_in(60, "GET", "held-comments", None)?).map_err(|e| e.to_string())?;
        Ok(i.items)
    }

    /// Approves or rejects one held comment.
    pub fn held_answer(&self, page: &str, id: &str, approve: bool) -> Result<(), String> {
        self.call("POST", &format!("comet-pending?page={}&id={}&do={}", enc(page), enc(id), if approve { "approve" } else { "reject" }), Some("")).map(drop)
    }

    /// What a page does with comets' comments: `open`, `held` or `off`.
    pub fn comets(&self, name: &str) -> Result<String, String> {
        let c: Comets = serde_json::from_str(&self.call("GET", &format!("page-comets?name={}", enc(name)), None)?).map_err(|e| e.to_string())?;
        Ok(if c.mode.is_empty() { "open".into() } else { c.mode })
    }

    pub fn set_comets(&self, name: &str, mode: &str) -> Result<(), String> {
        self.call("POST", &format!("page-comets?name={}&mode={}", enc(name), enc(mode)), Some("")).map(drop)
    }

    /// The activity notices, newest first, each with whether it is read.
    pub fn notices(&self) -> Result<Vec<Notice>, String> {
        let n: Notices = serde_json::from_str(&self.call_in(60, "GET", "notify", None)?).map_err(|e| e.to_string())?;
        Ok(n.items)
    }

    /// Marks one notice read, or all of them with no id.
    pub fn notice_read(&self, id: Option<&str>) -> Result<(), String> {
        let q = id.map_or("all=1".to_owned(), |i| format!("id={}", enc(i)));
        self.call("POST", &format!("notify-read?{q}"), Some("")).map(drop)
    }

    /// How much waits in the inbox. Two directory reads on the ship, no bodies.
    pub fn waiting(&self) -> Result<Waiting, String> {
        serde_json::from_str(&self.call("GET", "notify-count", None)?).map_err(|e| e.to_string())
    }

    /// The asks for edit waiting here, and the ones this ship sent.
    pub fn asks(&self) -> Result<Asks, String> {
        serde_json::from_str(&self.call("GET", "access-requests", None)?).map_err(|e| e.to_string())
    }

    /// Approves an ask (that ship may then edit) or denies it.
    pub fn ask_answer(&self, ship: &str, path: &str, approve: bool) -> Result<(), String> {
        self.call("POST", &format!("access-answer?ship={}&path={}&do={}", enc(ship), enc(path), if approve { "approve" } else { "deny" }), Some("")).map(drop)
    }

    /// Asks a host for edit on what it shares read-only, with a note.
    pub fn ask_edit(&self, host: &str, path: &str, note: &str) -> Result<(), String> {
        self.call("POST", &format!("access-request?host={}&path={}", enc(host), enc(path)), Some(clip_note(note.trim()))).map(drop).map_err(|e| {
            if e.contains("too-old") {
                "this host's lattice is too old to take requests".into()
            } else if e.starts_with("504") {
                format!("{host} did not answer, so nothing was asked")
            } else {
                e
            }
        })
    }

    /// The pages that link to a page, as the ship's index has them.
    pub fn backlinks(&self, name: &str) -> Result<Vec<String>, String> {
        let b: Backlinks = serde_json::from_str(&self.call_in(60, "GET", &format!("page-backlinks?name={}", enc(name)), None)?).map_err(|e| e.to_string())?;
        Ok(b.links.into_iter().filter(|l| l != name).collect())
    }

    /// Saves many pages in one request: name, kind and text for each. All
    /// of them or none, 200 at most. A page that exists is written over.
    pub fn save_batch(&self, items: &[(String, &str, String)]) -> Result<(), String> {
        let body: Vec<serde_json::Value> = items.iter().map(|(name, kind, body)| serde_json::json!({ "name": name, "type": kind, "body": body })).collect();
        self.call_in(120, "POST", "page-save-batch", Some(&serde_json::Value::Array(body).to_string())).map(drop)
    }

    /// Whether the ship can give map tiles, and how deep.
    pub fn tile_status(&self) -> Result<TileStatus, String> {
        serde_json::from_str(&self.call("GET", "tile-status", None)?).map_err(|e| e.to_string())
    }

    /// Sets the ship's Mapbox token, or clears it with an empty one. The
    /// ship never gives it back: it only says whether one is set.
    pub fn map_token(&self, token: &str) -> Result<(), String> {
        self.call("POST", "map-token", Some(token.trim())).map(drop).map_err(|e| if e.starts_with("400") { "that does not look like a Mapbox token".into() } else { e })
    }

    /// The address of a map tile on the ship, which fetches it from
    /// Mapbox with the owner's token and keeps nothing.
    pub fn tile_url(&self, style: &str, z: u32, x: u32, y: u32) -> String {
        format!("{}/apps/lattice/tile/{}/{z}/{x}/{y}", self.url, enc(style))
    }

    /// The templates the ship has, by name.
    pub fn templates(&self) -> Result<Vec<String>, String> {
        let t: Templates = serde_json::from_str(&self.call("GET", "template-list", None)?).map_err(|e| e.to_string())?;
        Ok(t.templates)
    }

    /// Makes a page, or a folder of pages, from a template. One save per
    /// page on the ship, so it is given time.
    pub fn template_new(&self, template: &str, rn: &RealName) -> Result<(), String> {
        self.call_in(120, "POST", &format!("template-new?template={}&name={}{}", enc(template), enc(&rn.name), rn.query()), Some("")).map(drop).map_err(|e| if e.starts_with("409") { "a page by that name exists".into() } else { e })
    }

    /// Removes one comment.
    pub fn comment_delete(&self, page: &str, id: &str) -> Result<(), String> {
        self.call("POST", &format!("comment-del?page={}&id={}", enc(page), enc(id)), Some("")).map(drop)
    }

    /// The ships that are banned, in the ship's order.
    pub fn bans(&self) -> Result<Vec<String>, String> {
        serde_json::from_str(&self.call("GET", "banlist", None)?).map_err(|e| e.to_string())
    }

    /// Bans a ship (or `comets`): it is taken out of every group it is in
    /// and cannot be granted anything until it is unbanned.
    pub fn ban(&self, who: &str) -> Result<(), String> {
        self.call_in(120, "POST", &format!("ban?ship={}", enc(who)), Some("")).map(drop)
    }

    /// Lifts a ban. It gives back nothing the ban took.
    pub fn unban(&self, who: &str) -> Result<(), String> {
        self.call_in(120, "POST", &format!("unban?ship={}", enc(who)), Some("")).map(drop)
    }

    /// Lets `ship` read (`edit` false) or edit a page or folder. Answers
    /// whether the ship was told: the grant holds either way.
    pub fn grant(&self, name: &str, ship: &str, edit: bool) -> Result<bool, String> {
        let q = format!("share-file?name={}&ship={}&mode={}", enc(name), enc(ship), if edit { "edit" } else { "read" });
        // the ship tries to tell the other ship before it answers: about 30 s when that ship is not reachable
        let g: Granted = serde_json::from_str(&self.call_in(120, "POST", &q, Some(""))?).map_err(|e| e.to_string())?;
        Ok(g.notified)
    }

    /// Takes back what `grant` gave.
    pub fn ungrant(&self, name: &str, ship: &str) -> Result<(), String> {
        self.call_in(120, "POST", &format!("unshare-file?name={}&ship={}", enc(name), enc(ship)), Some("")).map(drop)
    }

    /// Makes a new Markdown page. The ship answers 409 when the name is taken.
    pub fn create(&self, name: &str) -> Result<(), String> {
        self.create_as(&RealName { name: name.to_owned(), dname: String::new(), dnames: String::new() })
    }

    /// Makes a new Markdown page at `rn.name`, shown under the names typed.
    pub fn create_as(&self, rn: &RealName) -> Result<(), String> {
        let title = if rn.dname.is_empty() { rn.name.rsplit('/').next().unwrap_or(&rn.name) } else { &rn.dname };
        self.call("POST", &format!("page-save?name={}&type=md&new=1&by=rune{}", enc(&rn.name), rn.query()), Some(&format!("# {title}\n"))).map(drop)
    }

    /// Makes an empty folder, shown under the names typed. Nested is fine, and one that is there already is no error.
    pub fn folder_new(&self, rn: &RealName) -> Result<(), String> {
        self.call("POST", &format!("folder-new?name={}{}", enc(&rn.name), rn.query()), Some("")).map(drop)
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        self.rename_as(from, &RealName { name: to.to_owned(), dname: String::new(), dnames: String::new() })
    }

    /// Moves a page or folder to `rn.name`, shown under the names typed. A
    /// plain path clears the name the old one was shown under.
    pub fn rename_as(&self, from: &str, rn: &RealName) -> Result<(), String> {
        let q = if rn.dname.is_empty() { format!("&dname={}", rn.query()) } else { rn.query() };
        self.call("POST", &format!("page-move?from={}&to={}{q}", enc(from), enc(&rn.name)), Some("")).map(drop)
    }

    pub fn delete(&self, name: &str) -> Result<(), String> {
        self.call("POST", &format!("page-del?name={}", enc(name)), Some("")).map(drop)
    }
}

/// Percent-encodes a query value: everything but unreserved characters.
pub fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enc_keeps_unreserved_and_escapes_the_rest() {
        assert_eq!(enc("notes/a b&c.md"), "notes%2Fa%20b%26c.md");
        assert_eq!(enc("é"), "%C3%A9");
    }

    #[test]
    fn a_typed_address_becomes_a_base_url() {
        assert_eq!(base_url(" ship.example.com/ "), "https://ship.example.com");
        assert_eq!(base_url("localhost:8080"), "http://localhost:8080");
        assert_eq!(base_url("http://10.0.0.2:8080/"), "http://10.0.0.2:8080");
        assert_eq!(Conn { url: String::new(), cookie: "urbauth-~zod=0v1.abc".into() }.ship(), "~zod");
    }

    #[test]
    fn preferences_pick_the_theme_and_survive_text_that_is_not_theirs() {
        let p = Prefs::default();
        assert!(p.dark(true) && !p.dark(false), "no choice follows the system");
        let dark = Prefs { theme: "dark".into(), ..p.clone() };
        assert!(dark.dark(false));
        assert_eq!((p.next_theme(), dark.next_theme(), Prefs { theme: "light".into(), ..p.clone() }.next_theme()), ("dark", "light", "system"));
        let back: Prefs = serde_json::from_str(&serde_json::to_string(&Prefs { theme: "light".into(), last: "a/b".into(), no_autosave: true, recent: vec!["a/b".into()], used: vec!["edit".into()], tabs: vec!["a/b".into(), String::new()], tab: 1, split: "c".into(), outside: vec!["a/b".into()], core_seen: vec!["a".into()], pub_ok: true, font: "serif".into(), vim: true, sort_desc: true, marks_folded: vec!["web".into()], split_down: true, worn: crate::theme::Worn { own: true, ..Default::default() }, pins: [("place/home".to_owned(), "home".to_owned())].into() }).unwrap()).unwrap();
        assert_eq!((back.theme.as_str(), back.last.as_str()), ("light", "a/b"));
        assert!(back.sort_desc);
        assert_eq!(serde_json::from_str::<Prefs>(r#"{"other":1}"#).unwrap(), Prefs::default(), "unknown fields and missing ones are fine");
    }

    #[test]
    fn the_access_list_says_who_reads_a_page_and_how() {
        let base = "/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app/page/";
        let g = |name: &str, ships: &[&str], peek: &[&str], make: &[&str]| Group {
            name: name.into(),
            ships: ships.iter().map(|s| (*s).to_owned()).collect(),
            peek: peek.iter().map(|p| format!("{base}{p}")).collect(),
            make: make.iter().map(|p| format!("{base}{p}")).collect(),
        };
        let groups = [
            g("nec", &["~nec"], &["notes/today/code"], &[]),
            g("bud", &["~bud"], &["notes/today/code"], &["notes/today/code"]),
            g("team", &["~nec", "~wes"], &["notes"], &[]),
            g("other", &["~zod"], &["notes/todayish/code", "note"], &[]),
            g("public", &[], &[], &[]),
        ];
        assert_eq!(
            readers(&groups, "notes/today"),
            vec![
                Reader { ship: "~bud".into(), edit: true, via: None },
                Reader { ship: "~nec".into(), edit: false, via: None },
                Reader { ship: "~wes".into(), edit: false, via: Some("notes".into()) },
            ],
            "the page's own grant wins over a folder's, and a name that only starts the same grants nothing"
        );
        assert!(readers(&groups, "elsewhere").is_empty());
        assert_eq!((ship_name(" nec "), ship_name("~sampel-palnet"), ship_name("Not A Ship"), ship_name("~")), (Some("~nec".into()), Some("~sampel-palnet".into()), None, None));
        let parsed: Vec<Group> = serde_json::from_str(r#"[{"name":"nec","ships":["~nec"],"peek":["/x/page/a/code"],"poke":[],"opaque":0,"make":[]}]"#).unwrap();
        assert_eq!(readers(&parsed, "a"), vec![Reader { ship: "~nec".into(), edit: false, via: None }]);
    }

    #[test]
    fn a_groups_grant_on_a_page_is_set_without_touching_its_others() {
        let base = "/apps/x/lattice";
        let g = Group { name: "team".into(), ships: vec!["~nec".into()], peek: vec![format!("{base}/page/other/code"), format!("{base}/page/dir")], make: vec![] };
        assert_eq!(g.level(base, "a/b"), Level::None);
        let read = g.with_level(base, "a/b", Level::Read);
        assert_eq!((read.level(base, "a/b"), read.peek.len(), read.make.len()), (Level::Read, 3, 0));
        let edit = read.with_level(base, "a/b", Level::Edit);
        assert_eq!((edit.level(base, "a/b"), edit.peek.len(), edit.make.len()), (Level::Edit, 3, 1), "an edit grant reads too, and is not listed twice");
        assert_eq!(edit.with_level(base, "a/b", Level::None), g, "taking it back leaves the group as it was");
        assert_eq!(ship_list(" nec, ~bud\n~wes ").unwrap(), ["~nec", "~bud", "~wes"]);
        let swapped = edit.with_ships("wes ~nec wes").unwrap();
        assert_eq!((swapped.ships.clone(), swapped.peek.len(), swapped.make.len()), (vec!["~nec".to_owned(), "~wes".to_owned()], 3, 1), "new ships, once each, and the same paths");
        assert!(edit.with_ships("").unwrap().ships.is_empty() && edit.with_ships("Nope").is_err());
        assert_eq!(ship_list("nec Bad").unwrap_err(), "Bad is not a ship's name");
        assert!(ship_list("").unwrap().is_empty());
        assert_eq!((ban_target(" comets "), ban_target("wes"), ban_target("Comets"), ban_target("")), (Some("comets".into()), Some("~wes".into()), None, None));
        assert!(group_name_ok("team-2") && !group_name_ok("Team") && !group_name_ok("2team") && !group_name_ok("") && !group_name_ok("a b"));
    }

    #[test]
    fn a_shared_notice_names_its_page_and_the_answers_parse() {
        let list: Vec<Shared> = serde_json::from_str(r#"[{"host":"~nec","path":"/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app/page/notes/plan/code","mode":"edit","when":"~2026.11.17..9.0.0"},{"host":"~bud","path":"/apps/other/thing","mode":"read","when":""}]"#).unwrap();
        assert_eq!((list[0].name(), list[0].editable()), ("notes/plan", true));
        assert_eq!((list[1].name(), list[1].editable()), ("/apps/other/thing", false), "a path that is not a lattice page is shown whole");
        let b: Browsed = serde_json::from_str(r#"{"body":"hi","mark":"page","builder":"md","editable":true,"rev":7}"#).unwrap();
        assert_eq!((b.body.as_str(), b.builder.as_deref(), b.rev), ("hi", Some("md"), 7));
        let plain: Browsed = serde_json::from_str(r#"{"body":"x","mark":"txt","builder":null,"editable":true,"rev":1}"#).unwrap();
        assert_eq!(plain.builder, None);
        let ok: RemoteSaved = serde_json::from_str(r#"{"ok":true,"outcome":"landed","rev":8,"prev-rev":7}"#).unwrap();
        assert_eq!((ok.outcome.as_str(), ok.rev), ("landed", 8));
        let unsure: RemoteSaved = serde_json::from_str(r#"{"ok":true,"outcome":"unverified","error":"~nec did not acknowledge"}"#).unwrap();
        assert_eq!((unsure.outcome.as_str(), unsure.rev), ("unverified", 0));
    }

    #[test]
    fn a_typed_name_becomes_a_path_and_the_names_to_show() {
        let rn = |t: &str| real_name(t).map(|r| (r.name, r.dname, r.dnames));
        let own = |a: &str, b: &str, c: &str| Some((a.to_owned(), b.to_owned(), c.to_owned()));
        assert_eq!(rn("notes/today"), own("notes/today", "", ""), "a valid path is used as it is, with no name to show");
        assert_eq!(rn(" /notes/My Page/ "), own("notes/my-page", "My Page", "/My Page"));
        assert_eq!(rn("Trips/2026/Barcelona & Back!"), own("trips/2026/barcelona-back", "Barcelona & Back!", "Trips//Barcelona & Back!"));
        assert_eq!(rn("Crème brûlée"), own("cr-me-br-l-e", "Crème brûlée", "Crème brûlée"));
        assert_eq!(rn("Folder/plain"), own("folder/plain", "", "Folder/"));
        assert_eq!(rn("A - B"), own("a---b", "A - B", "A - B"), "as the web client slugs it, hyphen for hyphen");
        assert_eq!(rn("..Hidden.."), own("hidden", "..Hidden..", "..Hidden.."));
        assert_eq!((rn(""), rn("///"), rn("!!!"), rn("a//b"), rn("a/../b")), (None, None, None, None, None), "nothing a path can keep");
        assert!(valid_name("a.b_c~d-1/x") && !valid_name("A") && !valid_name("a/") && !valid_name("a b") && !valid_name("."));
        let r = real_name("Trips/2026/Barcelona & Back!").unwrap();
        assert_eq!(r.shown(), vec![("trips".to_owned(), "Trips".to_owned()), ("trips/2026/barcelona-back".to_owned(), "Barcelona & Back!".to_owned())]);
        assert_eq!(r.query(), "&dname=Barcelona%20%26%20Back%21&dnames=Trips%2F%2FBarcelona%20%26%20Back%21");
    }

    #[test]
    fn a_ship_date_reads_as_a_date() {
        let r = |u: &str| Rev { rev: 1, updated: u.into() }.when();
        assert_eq!(r("~2026.11.7..9.5.11..b165"), "2026-11-07 09:05");
        assert_eq!(r("~2026.11.17"), "2026-11-17");
        assert_eq!(r("soon"), "soon");
    }

    #[test]
    fn a_tree_and_a_page_parse_as_the_ship_writes_them() {
        let t: Dump = serde_json::from_str(r#"{"nodes":[{"path":"a/b","page":true,"kind":"md","rev":3,"size":9,"body":"hi"},{"path":"a","page":false}],"since":"x"}"#).unwrap();
        assert_eq!((t.nodes.len(), t.nodes[0].rev, t.nodes[1].page, t.since.as_str()), (2, 3, false, "x"));
        assert_eq!((t.nodes[0].body.as_deref(), t.nodes[1].body.as_deref()), (Some("hi"), None));
        let p: Page = serde_json::from_str(r#"{"body":"hi","kind":"md","rev":2,"mtime":"~2026"}"#).unwrap();
        assert_eq!((p.body.as_str(), p.rev), ("hi", 2));
    }

    #[test]
    fn a_held_comments_date_in_milliseconds_reads_as_the_ships_text() {
        assert_eq!(da_of_ms(0), "~1970.1.1..0.0.0");
        assert_eq!(da_of_ms(1_794_947_795_000), "~2026.11.17..20.36.35");
        assert_eq!(da_of_ms(951_782_400_000), "~2000.2.29..0.0.0");
        let held: Inbox = serde_json::from_str(r#"{"items":[{"page":"a/b","id":"0v1","author":"~zod","when":1794947795000,"body":"hi"}]}"#).unwrap();
        assert_eq!(Rev { rev: 0, updated: held.items[0].when.clone() }.when(), "2026-11-17 20:36");
        let inbox: Inbox = serde_json::from_str(r#"{"items":[{"page":"a","id":"0v1","when":"~2026.11.17..20.36.35..0722"}]}"#).unwrap();
        assert_eq!(inbox.items[0].when, "~2026.11.17..20.36.35..0722");
    }

    #[test]
    fn a_notice_says_what_it_is_about_and_where_it_opens() {
        let n: Notices = serde_json::from_str(
            r#"{"unread":2,"items":[
            {"id":"0v1","kind":"comment","when":1794947795000,"who":"~bus","host":"~zod","where":"notes/today","post":0,"title":"","body":"nice","read":false},
            {"id":"0v2","kind":"share","when":1,"who":"~bus","host":"~bus","where":"/apps/x/data/lattice.lattice_app/page/plans/trip/code","post":0,"title":"","body":"","read":true},
            {"id":"0v3","kind":"ask","when":1,"who":"~bus","host":"~zod","where":"/x/page/plans","post":0,"title":"plans","body":"please","read":false},
            {"id":"0v4","kind":"remote","when":1,"who":"~bus","host":"~bus","where":"tech","post":7,"title":"Rune","body":"","read":false},
            {"id":"0v5","kind":"unshare","when":1,"who":"~bus","host":"~bus","where":"/x/page/plans/trip/code","post":0,"title":"","body":"","read":false},
            {"id":"0v6","kind":"folder","when":1,"who":"~bus","host":"~bus","where":"/notes","post":0,"title":"2 new pages in notes from ~bus","body":"","read":false},
            {"id":"0v7","kind":"new-kind","where":"somewhere"}]}"#,
        )
        .unwrap();
        let labels: Vec<String> = n.items.iter().map(Notice::label).collect();
        assert_eq!(labels, ["comment on notes/today", "shared plans/trip", "asks to edit plans", "reply on ~bus/tech: Rune", "stopped sharing plans/trip", "2 new pages in notes from ~bus", "somewhere"]);
        assert_eq!(n.items[0].opens(), Opens::Page("notes/today".into()));
        assert!(matches!(n.items[1].opens(), Opens::Shared(s) if s.host == "~bus" && s.name() == "plans/trip"));
        assert_eq!(n.items[2].opens(), Opens::Access);
        assert!(n.items[3..].iter().all(|i| i.opens() == Opens::Nothing));
        assert_eq!(Rev { rev: 0, updated: n.items[0].when.clone() }.when(), "2026-11-17 20:36");
        let w: Waiting = serde_json::from_str(r#"{"held":1,"unread":2}"#).unwrap();
        assert_eq!((w.held, w.unread), (1, 2));
    }

    #[test]
    fn asks_read_from_both_sides_and_a_note_is_cut_on_a_character() {
        let a: Asks = serde_json::from_str(
            r#"{"pending":[{"ship":"~bus","path":"/a/page/plans/code","name":"plans","note":"may I?","when":1794947795000}],
                "sent":[{"host":"~nec","path":"/b/page/notes/dir-index","name":"notes","note":"","when":1}]}"#,
        )
        .unwrap();
        assert_eq!((a.pending[0].ship.as_str(), a.pending[0].name.as_str(), a.sent[0].ship.as_str()), ("~bus", "plans", "~nec"));
        assert_eq!(clip_note("short"), "short");
        let long = "é".repeat(200);
        assert_eq!(clip_note(&long).len(), 280);
        let odd = format!("a{long}");
        assert_eq!(clip_note(&odd).len(), 279, "never half a character");
    }

    #[test]
    fn a_days_journal_page_is_looked_for_under_three_names() {
        assert_eq!(journal_forms("2026-03-07"), ["journal/2026-03-07", "journal/2026.3.7", "journal/2026.03.07"]);
        assert_eq!(journal_forms("2026-11-17")[1], "journal/2026.11.17");
        assert_eq!(journal_forms("odd"), ["journal/odd"]);
    }

    #[test]
    fn a_captured_page_is_named_by_the_date_and_four_digits_not_in_use() {
        assert_eq!(capture_name("2026-11-17", 42, &|_| false), "inbox/2026-11-17-0042");
        assert_eq!(capture_name("2026-11-17", 123_456, &|_| false), "inbox/2026-11-17-3456");
        // a name in use is passed over
        assert_eq!(capture_name("2026-11-17", 42, &|n| n.ends_with("-0042")), "inbox/2026-11-17-7961");
        let d = today();
        assert!(d.len() == 10 && d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-' && d.starts_with("20"), "{d}");
    }

    #[test]
    fn an_image_on_the_ship_is_asked_for_at_the_ship() {
        let c = Conn { url: "http://ship.example".into(), cookie: "k=v".into() };
        assert_eq!(c.image_url("/apps/lattice/icon.svg"), "http://ship.example/apps/lattice/icon.svg");
        assert_eq!(c.image_url("icon.svg"), "http://ship.example/apps/lattice/icon.svg");
        assert_eq!(c.image_url("pics/a.png"), "http://ship.example/apps/lattice/pics/a.png");
    }

    /// The forum against a ship, read: it needs a board named `general` with a pinned thread 1 that has
    /// tags, a link thread 2, and three comments on thread 1, one a reply. `scripts/forum-seed.sh` makes them.
    #[test]
    #[ignore]
    fn live_forum_read() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let boards = c.forum_boards().unwrap();
        let names: Vec<&str> = boards.iter().map(|b| b.board.as_str()).collect();
        assert!(names.contains(&"general") && names.contains(&"quiet"), "{names:?}");
        let b = c.forum_board("general").unwrap();
        assert_eq!((b.title.as_str(), b.description.as_str(), b.public), ("General talk", "Anything goes", true));
        // newest first, and a listed thread comes without its text. The posting test may have added threads above these
        assert!(b.count >= 2 && b.posts.windows(2).all(|w| w[0].id > w[1].id), "{:?}", b.posts.iter().map(|p| p.id).collect::<Vec<_>>());
        let (link, first) = (b.posts.iter().find(|p| p.id == 2).unwrap(), b.posts.iter().find(|p| p.id == 1).unwrap());
        assert_eq!((link.title.as_str(), link.link.as_deref(), link.body.as_deref()), ("A link", Some("https://urbit.org"), None));
        assert_eq!((first.pinned, first.up, first.comments, first.tags.clone(), first.body.as_deref()), (true, 1, 3, vec!["intro".to_owned(), "meta".to_owned()], None));
        let t = c.forum_thread("general", 1).unwrap();
        assert!(t.post.body.as_deref().is_some_and(|b| b.starts_with("The **body**")), "{:?}", t.post);
        let order: Vec<(usize, &str)> = comment_order(&t.comments).into_iter().map(|(d, c)| (d, c.body.as_str())).collect();
        assert_eq!(order, [(0, "A first comment."), (1, "A reply to it."), (0, "Another top comment.")]);
        assert!(c.forum_board("no-such-board").unwrap_err().contains("404"));
        assert!(c.forum_thread("general", 99).unwrap_err().contains("404"));
    }

    #[test]
    fn refusals_are_read_from_the_ships_page_of_them() {
        // rows as +render-notes writes them, in the page's shell
        let page = r#"<html><body><form class="bar"></form><div class="ct"><h3>Refused posts</h3><form method="post" action="/apps/lattice/forum-notes/clear"><button type="submit">Clear</button></form><div class="rw"><div><span class="ti">your role on this board cannot post</span><span class="me">~nec/general, 2 minutes ago</span></div></div><div class="rw"><div><span class="ti">a post needs a title (300 bytes at most), a url of 2,048 &amp; a body of 40,000 &lt;b&gt;</span><span class="me">~sampel-palnet/a-b, 3 days ago</span></div></div></div></body></html>"#;
        assert_eq!(
            refusal_notes(page),
            [("your role on this board cannot post".to_owned(), "~nec/general, 2 minutes ago".to_owned()), ("a post needs a title (300 bytes at most), a url of 2,048 & a body of 40,000 <b>".to_owned(), "~sampel-palnet/a-b, 3 days ago".to_owned())]
        );
        // none, as the page says it, and a row cut short is left out
        assert!(refusal_notes(r#"<h3>Refused posts</h3><span></span><p class="me">No refusals.</p>"#).is_empty());
        assert!(refusal_notes(r#"<div class="rw"><div><span class="ti">cut"#).is_empty());
        assert!(refusal_notes("").is_empty());
    }

    #[test]
    fn tags_are_taken_as_the_ship_takes_them_or_said_not_to_be() {
        assert_eq!(forum_tags(" bug, #idea  c2-d bug ").unwrap(), ["bug", "idea", "c2-d"]);
        assert!(forum_tags("").unwrap().is_empty());
        for bad in ["Bug", "c++", "2fast", "-x", "a_b", &"a".repeat(25)] {
            assert!(forum_tags(bad).unwrap_err().contains("is not a tag"), "{bad}");
        }
        assert!(forum_tags(&"a".repeat(24)).is_ok());
        assert_eq!(forum_tags("a b c d e f").unwrap_err(), "a thread carries five tags at most");
        assert!(forum_tags("a b c d e a").is_ok(), "one typed twice is one");
    }

    #[test]
    fn boards_are_named_by_the_index_page_and_comments_nest_under_what_they_answer() {
        let page = r#"<a href="/apps/lattice/forum">forum</a><a href="/apps/lattice/forum/_new">create a board</a><span class="ti"><a href="/apps/lattice/forum/general">General talk</a></span><a href="/apps/lattice/forum/quiet-room2">Q</a><a href="/apps/lattice/forum/general">again</a><a href="/apps/lattice/forum/general/3">a thread</a><a href="/apps/lattice/forum/Bad">B</a><a href="/apps/lattice/forum/"#;
        assert_eq!(board_names(page), ["general", "quiet-room2"]);
        assert!(board_names("").is_empty());
        let c = |id: u64, parent: Option<u64>| ForumComment { id, parent, ..ForumComment::default() };
        let all = [c(0, None), c(1, Some(0)), c(2, None), c(3, Some(1)), c(4, Some(0)), c(5, Some(99)), c(6, Some(6))];
        let got: Vec<(usize, u64)> = comment_order(&all).into_iter().map(|(d, c)| (d, c.id)).collect();
        assert_eq!(got, [(0, 0), (1, 1), (2, 3), (1, 4), (0, 2), (0, 5), (0, 6)]);
        // two that answer each other are both read, once each
        let ring = [c(1, Some(2)), c(2, Some(1))];
        let mut ids: Vec<u64> = comment_order(&ring).into_iter().map(|(_, c)| c.id).collect();
        ids.sort_unstable();
        assert_eq!(ids, [1, 2]);
        // the ship's own shapes read, with what may be absent left out
        let b: Board = serde_json::from_str(r#"{"posts":[{"tags":[],"comments":0,"link":"https://urbit.org","author":"~zod","body":null,"title":"A link","id":2,"pinned":false,"up":0,"down":0}],"public":true,"title":"General talk","count":1,"board":"general","description":"d","kind":"board"}"#).unwrap();
        assert_eq!((b.posts[0].link.as_deref(), b.posts[0].body.as_deref(), b.count), (Some("https://urbit.org"), None, 1));
    }

    /// Posting to the forum against a ship: it needs the board `general` that `scripts/forum-seed.sh` makes, and can run again.
    #[test]
    #[ignore]
    fn live_forum_post() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let before = c.forum_board("general").unwrap();
        let stamp = crate::api::since_epoch().unwrap().as_secs();
        let title = format!("Posted natively {stamp}");
        c.forum_submit("general", &title, "", "Text with *marks*, an & and a = sign.\n\nSecond paragraph: é.", &forum_tags("native second").unwrap()).unwrap();
        let after = c.forum_board("general").unwrap();
        assert_eq!(after.count, before.count + 1);
        let made = after.posts.iter().find(|p| p.title == title).expect("the thread is listed");
        assert_eq!(made.tags, ["native", "second"]);
        let read = |c: &Conn| c.forum_thread("general", made.id).unwrap();
        assert_eq!(read(&c).post.body.as_deref(), Some("Text with *marks*, an & and a = sign.\n\nSecond paragraph: é."));
        // a comment, and an answer to it, sit where they were put
        c.forum_comment("general", made.id, None, "A comment, with a + and a % in it.").unwrap();
        let first = read(&c).comments[0].clone();
        assert_eq!((first.body.as_str(), first.parent), ("A comment, with a + and a % in it.", None));
        c.forum_comment("general", made.id, Some(first.id), "An answer.").unwrap();
        let t = read(&c);
        assert_eq!(comment_order(&t.comments).into_iter().map(|(d, c)| (d, c.body.as_str())).collect::<Vec<_>>(), [(0, "A comment, with a + and a % in it."), (1, "An answer.")]);
        // a link thread with no text
        c.forum_submit("general", &format!("A link {stamp}"), "https://example.org/a?b=c&d=e", "", &[]).unwrap();
        let linked = c.forum_board("general").unwrap();
        assert_eq!(linked.posts.iter().find(|p| p.title == format!("A link {stamp}")).and_then(|p| p.link.clone()).as_deref(), Some("https://example.org/a?b=c&d=e"));
        // a point is given once, a pin goes on and comes off, tags are set and cleared
        c.forum_vote("general", made.id).unwrap();
        c.forum_vote("general", made.id).unwrap();
        c.forum_pin("general", made.id, true).unwrap();
        c.forum_set_tags("general", made.id, &forum_tags("changed").unwrap()).unwrap();
        let p = read(&c).post;
        assert_eq!((p.up, p.pinned, p.tags.clone()), (1, true, vec!["changed".to_owned()]));
        c.forum_pin("general", made.id, false).unwrap();
        c.forum_set_tags("general", made.id, &[]).unwrap();
        let p = read(&c).post;
        assert!(!p.pinned && p.tags.is_empty(), "{p:?}");
        // the answer is deleted and the comment stays, then the link thread goes whole
        let answer = read(&c).comments.iter().find(|k| k.parent.is_some()).unwrap().id;
        c.forum_delete("general", made.id, Some(answer)).unwrap();
        assert_eq!(read(&c).comments.iter().map(|k| k.body.as_str()).collect::<Vec<_>>(), ["A comment, with a + and a % in it."]);
        let gone = linked.posts.iter().find(|p| p.title == format!("A link {stamp}")).unwrap().id;
        c.forum_delete("general", gone, None).unwrap();
        assert!(!c.forum_board("general").unwrap().posts.iter().any(|p| p.id == gone));
        assert!(c.forum_thread("general", gone).unwrap_err().starts_with("404"));
        // this ship was refused nothing, the page of refusals says so, and clearing none is taken
        assert!(c.forum_notes().unwrap().is_empty());
        c.forum_notes_clear().unwrap();
        assert!(c.forum_notes().unwrap().is_empty());
        // a thread with no title is refused by the form, and a board that is not there says so
        assert!(c.forum_submit("general", "", "", "no title", &[]).unwrap_err().starts_with("400"));
        assert!(c.forum_submit("no-such-board", "x", "", "", &[]).unwrap_err().starts_with("404"));
    }

    /// Boards against a ship: made, changed, flipped and deleted. It needs nothing first and can run again.
    #[test]
    #[ignore]
    fn live_forum_boards() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let name = format!("made-{}", crate::api::since_epoch().unwrap().as_secs());
        c.forum_new(&name, "Made & named", "A board, with a \"description\".", "reader").unwrap();
        assert!(c.forum_boards().unwrap().iter().any(|b| b.board == name), "the board is on the index");
        let b = c.forum_board(&name).unwrap();
        assert_eq!((b.title.as_str(), b.description.as_str(), b.public, b.count), ("Made & named", "A board, with a \"description\".", true, 0));
        c.forum_edit(&name, "Renamed", "").unwrap();
        c.forum_flip_public(&name).unwrap();
        let b = c.forum_board(&name).unwrap();
        assert_eq!((b.title.as_str(), b.description.as_str(), b.public), ("Renamed", "", false));
        c.forum_flip_public(&name).unwrap();
        assert!(c.forum_board(&name).unwrap().public);
        // a board made again under a name taken does not take the first one's place
        c.forum_submit(&name, "Kept", "", "text", &[]).unwrap();
        c.forum_new(&name, "Second", "", "poster").unwrap();
        let b = c.forum_board(&name).unwrap();
        eprintln!("made again under the same name, the board is titled {:?} with {} thread(s)", b.title, b.count);
        assert!(c.forum_new("Bad Name", "x", "", "poster").unwrap_err().starts_with("400"));
        assert!(c.forum_new(&format!("{name}-x"), "", "", "poster").unwrap_err().starts_with("400"));
        assert!(c.forum_new(&format!("{name}-y"), "t", "", "king").unwrap_err().starts_with("400"));
        c.forum_board_delete(&name).unwrap();
        assert!(!c.forum_boards().unwrap().iter().any(|b| b.board == name));
        assert!(c.forum_board(&name).unwrap_err().starts_with("404"));
    }

    #[test]
    fn a_moderation_page_reads_as_the_ship_writes_it() {
        let m = board_mod(include_str!("forum_mod_public.html")).unwrap();
        assert_eq!(m.default_role, "poster");
        assert!(m.public && m.prune);
        assert_eq!(m.comets, Some(false));
        assert_eq!(m.sidebar, "Rules & <b>such</b>\nsee https://example.com \"q\"");
        assert_eq!((m.min_score, m.after_days), (3, 9));
        assert_eq!(m.roles, [("~bud".to_owned(), "reader".to_owned()), ("~nec".to_owned(), "moderator".to_owned())]);
        let m = board_mod(include_str!("forum_mod_private.html")).unwrap();
        assert!(!m.public);
        assert_eq!(m.comets, None, "a private board takes no comets either way");
        // a page with no roles, no sidebar and pruning off, as a new board's is
        let bare = "<p class=\"me\">Default role: reader</p><textarea name=\"sidebar\" rows=\"6\" cols=\"60\"></textarea><input type=\"checkbox\" name=\"prune-enabled\" value=\"on\" /><input type=\"number\" name=\"min-score\" value=\"2\" min=\"0\" /><input type=\"number\" name=\"after-days\" value=\"7\" min=\"1\" /><p class=\"me\">No explicit roles set. Everyone gets the default role.</p>";
        assert_eq!(board_mod(bare).unwrap(), BoardMod { default_role: "reader".into(), min_score: 2, after_days: 7, ..BoardMod::default() });
        assert_eq!(board_mod("<html>some other page</html>"), None);
    }

    #[test]
    fn a_boards_address_reads_as_whose_board_it_is() {
        let key = |t: &str| board_key(t, "~zod");
        assert_eq!(key("urb://~nec/forum/chat"), Ok(("~nec/chat".into(), None)));
        assert_eq!(key(" ~sampel-palnet/forum/b2/14/ "), Ok(("~sampel-palnet/b2".into(), Some(14))));
        assert_eq!(key("~nec/chat/3"), Ok(("~nec/chat".into(), Some(3))));
        // this ship's own board is read the plain way
        assert_eq!(key("urb://~zod/forum/chat"), Ok(("chat".into(), None)));
        for bad in ["", "chat", "~nec", "nec/chat", "~nec/Chat", "~nec/forum", "~nec/chat/x", "~nec/a/1/2", "urb://~nec/pages/chat/1/2"] {
            assert!(key(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_ship_that_did_not_answer_is_told_from_one_that_said_no() {
        for e in ["http://localhost:1/apps/lattice/page-dump: Connection Failed: Connect error: Connection refused (os error 111)", "timed out reading response", "502: bad gateway", "504: "] {
            assert!(gone(e), "{e}");
        }
        for e in ["403: sign in", "404: {\"error\":\"no such page\"}", "500: crashed", "409: taken"] {
            assert!(!gone(e), "{e}");
        }
        assert_eq!([ago(5), ago(60), ago(150), ago(3600), ago(90_000), ago(200_000)], ["just now", "1 minute ago", "2 minutes ago", "1 hour ago", "1 day ago", "2 days ago"]);
    }

    #[test]
    fn a_tree_kept_is_read_back_with_every_text_for_its_own_ship() {
        let dir = std::env::temp_dir().join(format!("lr-kept-{}", std::process::id()));
        let file = dir.join("deep").join("kept.json");
        assert!(kept_at(&file).is_none(), "nothing is kept before anything is read");
        let nodes = vec![Node { path: "notes".into(), dname: "Notes".into(), ..Node::default() }, Node { path: "notes/a".into(), page: true, kind: "md".into(), rev: 7, body: Some("# A\n\ntext \u{e9}\n".into()), ..Node::default() }];
        keep_at(&file, nodes).unwrap();
        let (d, age) = kept_at(&file).unwrap();
        assert!(age < 60 && d.since.is_empty());
        assert_eq!((d.nodes.len(), d.nodes[0].dname.as_str(), d.nodes[1].rev, d.nodes[1].body.as_deref()), (2, "Notes", 7, Some("# A\n\ntext \u{e9}\n")));
        // each ship's address has its own file
        assert_ne!(kept_path("http://ship.example:8080"), kept_path("http://other.example"));
        assert!(kept_path("http://ship.example:8080").unwrap().ends_with("lattice-rune/kept-http---ship-example-8080.json"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_save_that_waits_is_one_for_each_page_and_keeps_what_the_first_knew() {
        let page = |name: &str, body: &str| Page { name: name.into(), body: body.into(), kind: "md".into(), rev: 0 };
        let mut q = Queue::new();
        enqueue(&mut q, &page("a", "one"), 4, false, 10);
        enqueue(&mut q, &page("made", "new"), 0, true, 11);
        // saved again: the newer text, over the revision the ship last gave, not one this device made up
        enqueue(&mut q, &page("a", "two"), 9, false, 12);
        enqueue(&mut q, &page("made", "newer"), 0, false, 13);
        assert_eq!(q.len(), 2);
        assert_eq!(q["a"], Queued { kind: "md".into(), body: "two".into(), base: 4, is_new: false, at: 12 });
        assert_eq!((q["made"].body.as_str(), q["made"].is_new), ("newer", true));
        // kept in a file and read back the same. A file that is not there, or not a queue, is an empty one
        let file = std::env::temp_dir().join(format!("lr-queue-{}", std::process::id())).join("waiting.json");
        assert!(queue_at(&file).is_empty());
        write_private(&file, &serde_json::to_vec(&q).unwrap()).unwrap();
        assert_eq!(queue_at(&file), q);
        std::fs::write(&file, "not json").unwrap();
        assert!(queue_at(&file).is_empty());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
        assert!(queue_path("http://ship.example:8080").unwrap().ends_with("lattice-rune/waiting-http---ship-example-8080.json"));
    }

    #[test]
    fn a_waiting_save_leaves_only_when_sending_again_would_not_mend_it() {
        for e in ["400: bad", "404: no such folder", "409: page exists", "410: gone", "413: too large", "422: x"] {
            assert!(replay_drop(e), "{e}");
        }
        for e in ["http://ship/apps/lattice/page-save: Connection refused", "500: crash", "502: bad gateway", "401: sign in", "403: no", "408: slow", "429: wait"] {
            assert!(!replay_drop(e), "{e}");
        }
        // as the ship flattens a name for its own kept copies: a/b and a-b do not share one
        assert_eq!(aside_name("edit", "notes/a-b", "20261118-012233"), "conflicts/offline-edit-notes-a~db-20261118-012233");
        assert_ne!(aside_name("create", "a/b", "s"), aside_name("create", "a-b", "s"));
        assert_eq!(aside_name("create", "~x", "s"), "conflicts/offline-create-~~x-s");
    }

    /// Saves that waited, sent to a ship: an edit over the revision it knew, one over a page since changed, a page made here, and one whose name was taken meanwhile.
    #[test]
    #[ignore]
    fn live_send_queued() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let name = format!("waited/a-{}", crate::api::since_epoch().unwrap().as_secs());
        let q = |body: &str, base: u64, is_new: bool| Queued { kind: "md".into(), body: body.into(), base, is_new, at: 0 };
        // made here: it goes as a new page
        let Sent::Done { rev: r1, kept: None } = c.send_queued(&name, &q("first\n", 0, true)) else { panic!("a new page is taken") };
        assert_eq!(c.page(&name).unwrap().body, "first\n");
        // sent again, as after a try that landed unseen: the same text there is not a collision
        assert_eq!(c.send_queued(&name, &q("first\n", 0, true)), Sent::Done { rev: r1, kept: None });
        // a page starts at revision 0, and a save that names 0 names no revision: it is applied and nothing is checked
        let Sent::Done { rev: r2, kept: None } = c.send_queued(&name, &q("second\n", r1, false)) else { panic!("an edit over a new page is plain") };
        assert!((r1, r2) == (0, 1), "{r1} {r2}");
        // an edit over the revision the ship has: applied, nothing kept
        let Sent::Done { rev: r2b, kept: None } = c.send_queued(&name, &q("second, again\n", r2, false)) else { panic!("an edit over the ship's own revision is plain") };
        // an edit written over a revision the ship has moved past: applied all the same, and what it replaced is kept
        let Sent::Done { rev: r3, kept: Some(kept) } = c.send_queued(&name, &q("third, written away\n", r2, false)) else { panic!("a conflict is flagged") };
        assert!(r3 > r2b && kept.starts_with("conflicts/"), "{kept}");
        assert_eq!(c.page(&name).unwrap().body, "third, written away\n");
        assert_eq!(c.page(&kept).unwrap().body, "second, again\n", "the text replaced is kept");
        // a page made here under a name taken meanwhile by another text: kept aside, the ship's page untouched
        let Sent::Aside(alt, why) = c.send_queued(&name, &q("made away under the same name\n", 0, true)) else { panic!("a taken name keeps the text aside") };
        assert!(why.starts_with("409") && alt.starts_with("conflicts/offline-create-waited-a~d"), "{alt} {why}");
        assert_eq!(c.page(&alt).unwrap().body, "made away under the same name\n");
        assert_eq!(c.page(&name).unwrap().body, "third, written away\n");
        // a memory that waited: written, and written again over itself, the last one winning
        let key = format!("rune/waited-{}", name.rsplit('-').next().unwrap());
        assert_eq!(c.send_queued(&know_queue_name(&key), &q("a fact kept away\n", 0, false)), Sent::Done { rev: 0, kept: None });
        assert_eq!(c.send_queued(&know_queue_name(&key), &q("the fact, changed\n", 0, false)), Sent::Done { rev: 0, kept: None });
        assert_eq!(c.know_all().unwrap().iter().find(|k| k.key == format!("/{key}")).map(|k| k.body.trim().to_owned()), Some("the fact, changed".into()));
        c.know_delete(&format!("/{key}")).unwrap();
        // a ship that is not there: it stays waiting
        let away = Conn { url: "http://127.0.0.1:9".into(), cookie: String::new() };
        assert!(matches!(away.send_queued(&name, &q("x", 1, false)), Sent::Stop(_)));
        for n in [name, kept, alt] {
            c.delete(&n).unwrap();
        }
    }

    #[test]
    fn a_memory_that_waits_is_put_over_what_was_read() {
        let mut q = Queue::new();
        let page = |name: &str, body: &str| Page { name: name.into(), body: body.into(), kind: "md".into(), rev: 0 };
        enqueue(&mut q, &Page { name: know_queue_name("/project/a"), ..page("", "changed away") }, 0, false, 1);
        enqueue(&mut q, &Page { name: know_queue_name("made/away"), ..page("", "new") }, 0, false, 2);
        // a page of the same name waits beside it, and is no memory
        enqueue(&mut q, &page("project/a", "a page"), 3, false, 3);
        assert_eq!(q.len(), 3);
        assert_eq!((queued_know("know:project/a"), queued_know("project/a")), (Some("project/a"), None));
        let read = vec![Know { key: "/project/a".into(), body: "as read".into(), tags: vec!["core".into()], updated: "~2026.1.1".into() }, Know { key: "/other".into(), body: "untouched".into(), ..Know::default() }];
        let got = knows_with(read, &q);
        assert_eq!(got.iter().map(|k| (k.key.as_str(), k.body.as_str())).collect::<Vec<_>>(), [("/project/a", "changed away"), ("/other", "untouched"), ("/made/away", "new")]);
        assert_eq!(got[0].tags, ["core"], "what else the ship said of it stays");
    }

    #[test]
    fn a_delete_or_a_move_that_waits_settles_the_saves_that_wait() {
        let page = |name: &str, body: &str| Page { name: name.into(), body: body.into(), kind: "md".into(), rev: 0 };
        let mv = |from: &str, to: &str| QueuedOp::Move { from: from.into(), to: to.into(), dname: String::new(), dnames: String::new() };
        let (mut ops, mut q) = (Vec::new(), Queue::new());
        enqueue(&mut q, &page("notes/a", "A"), 4, false, 1);
        enqueue(&mut q, &page("notes/sub/b", "B"), 0, true, 2);
        enqueue(&mut q, &page("notes-other", "O"), 2, false, 3);
        enqueue(&mut q, &Page { name: know_queue_name("notes/a"), ..page("", "a memory") }, 0, false, 4);
        // a folder moved: the saves under it go with it, and name no revision. One beside it, and a memory of the same name, stay
        enqueue_op(&mut ops, &mut q, mv("notes", "kept"));
        assert_eq!(q.keys().map(String::as_str).collect::<Vec<_>>(), ["kept/a", "kept/sub/b", "know:notes/a", "notes-other"]);
        assert_eq!((q["kept/a"].base, q["kept/sub/b"].is_new, q["notes-other"].base), (0, true, 2));
        // a page deleted under its new name: its save is dropped, the others wait
        enqueue_op(&mut ops, &mut q, QueuedOp::Del("kept/a".into()));
        assert_eq!(q.keys().map(String::as_str).collect::<Vec<_>>(), ["kept/sub/b", "know:notes/a", "notes-other"]);
        assert_eq!(ops, [mv("notes", "kept"), QueuedOp::Del("kept/a".into())], "in the order made");
        // a page made away and deleted away leaves nothing to send
        let (mut ops2, mut q2) = (Vec::new(), Queue::new());
        enqueue(&mut q2, &page("scratch", "s"), 0, true, 1);
        enqueue_op(&mut ops2, &mut q2, QueuedOp::Del("scratch".into()));
        assert!(ops2.is_empty() && q2.is_empty());
        // the tree as read shows as it is once they are done
        let node = |path: &str, page: bool| Node { path: path.into(), page, ..Node::default() };
        let shown = ops_over(vec![node("notes", false), node("notes/a", true), node("notes/sub/b", true), node("notes-other", true), node("x", true)], &ops);
        assert_eq!(shown.iter().map(|n| n.path.as_str()).collect::<Vec<_>>(), ["kept", "kept/sub/b", "notes-other", "x"]);
        // a move with a name to show
        let shown = ops_over(vec![node("x", true)], &[QueuedOp::Move { from: "x".into(), to: "my-page".into(), dname: "My Page".into(), dnames: String::new() }]);
        assert_eq!((shown[0].path.as_str(), shown[0].dname.as_str()), ("my-page", "My Page"));
        assert!(ops_path("http://ship.example:8080").unwrap().ends_with("lattice-rune/ops-http---ship-example-8080.json"));
    }

    /// Deletes and moves that waited, sent to a ship in order, and a save carried by a move.
    #[test]
    #[ignore]
    fn live_send_ops() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let t = crate::api::since_epoch().unwrap().as_secs();
        let (a, b, to) = (format!("ops{t}/a"), format!("ops{t}/b"), format!("ops{t}/moved"));
        let q = |body: &str, base: u64, is_new: bool| Queued { kind: "md".into(), body: body.into(), base, is_new, at: 0 };
        for n in [&a, &b] {
            assert!(matches!(c.send_queued(n, &q("as made\n", 0, true)), Sent::Done { .. }));
        }
        // made away: a moved to a new name with an edit waiting on it, then b deleted
        let (mut ops, mut saves) = (Vec::new(), Queue::new());
        enqueue(&mut saves, &Page { name: a.clone(), body: "edited before the move\n".into(), kind: "md".into(), rev: 0 }, 0, false, 1);
        enqueue_op(&mut ops, &mut saves, QueuedOp::Move { from: a.clone(), to: to.clone(), dname: String::new(), dnames: String::new() });
        enqueue_op(&mut ops, &mut saves, QueuedOp::Del(b.clone()));
        for op in &ops {
            c.send_op(op).unwrap();
        }
        for (name, w) in &saves {
            assert!(matches!(c.send_queued(name, w), Sent::Done { kept: None, .. }), "{name}");
        }
        assert_eq!(c.page(&to).unwrap().body, "edited before the move\n");
        // the tree is what says a page is gone: the ship still answers a read of a moved or deleted page by name
        let names: Vec<String> = c.dump("").unwrap().nodes.into_iter().filter(|n| n.page).map(|n| n.path).collect();
        assert!(names.contains(&to) && !names.contains(&a) && !names.contains(&b), "{names:?}");
        // a delete of nothing is answered as done, and a move of nothing is refused for good, which is what lets it be dropped
        c.send_op(&QueuedOp::Del(b.clone())).unwrap();
        let gone_from = c.send_op(&QueuedOp::Move { from: a.clone(), to: format!("ops{t}/x"), dname: String::new(), dnames: String::new() }).unwrap_err();
        assert!(gone_from.starts_with("404") && replay_drop(&gone_from), "{gone_from}");
        c.delete(&to).unwrap();
    }

    #[test]
    fn an_agent_key_is_asked_for_and_read_as_the_ships_page_does() {
        let ask = KeyAsk { name: " laptop Claude ".into(), by: "claude-laptop".into(), memory: "write".into(), pages: "read".into(), web: "off".into(), skills: "none".into(), ..KeyAsk::default() };
        assert_eq!(key_request(&ask).unwrap(), serde_json::json!({"name": "laptop Claude", "by": "claude-laptop", "scope": {"memory": "write", "pages": {"all": "read"}, "web": {"off": null}, "sensitive": false, "skills": "none"}}));
        let scoped = KeyAsk { pages: "some".into(), pages_read: "/notes, projects ,".into(), pages_write: "notes/agent".into(), web: "some".into(), web_ship: " ~nec ".into(), web_read: "/x".into(), sensitive: true, ..ask.clone() };
        let v = key_request(&scoped).unwrap();
        assert_eq!(v["scope"]["pages"], serde_json::json!({"some": {"read": ["/notes", "/projects"], "write": ["/notes/agent"]}}));
        assert_eq!(v["scope"]["web"], serde_json::json!({"some": {"~nec": {"read": ["/x"], "write": []}}}));
        assert_eq!(v["scope"]["sensitive"], true);
        assert_eq!(key_request(&KeyAsk { web: "all".into(), ..ask.clone() }).unwrap()["scope"]["web"], serde_json::json!({"all": null}));
        for bad in [KeyAsk { name: " ".into(), ..ask.clone() }, KeyAsk { by: "has space".into(), ..ask.clone() }, KeyAsk { by: String::new(), ..ask.clone() }, KeyAsk { by: "x".repeat(65), ..ask.clone() }, KeyAsk { web: "some".into(), ..ask.clone() }] {
            assert!(key_request(&bad).is_err(), "{bad:?}");
        }
        let listed = r#"[{"id":"k1","name":"laptop","by":"claude","scope":{"memory":"write","pages":{"some":{"read":["/notes"],"write":["/notes/agent"]}},"web":{"some":{"~nec":{"read":["/x"],"write":[]}}},"sensitive":true,"skills":"read"},"made":"~2026.11.17..17.25.11..b165","used":"~2026.11.18..6.5.0..0000","tainted_until":"~2026.11.18..18.5.0..0000"},{"id":"k2","name":"old","by":"hermes","scope":{"memory":"read","pages":{"all":"none"},"web":{"off":null},"sensitive":false},"made":"~2026.1.2..3.4.5..0000","used":null}]"#;
        let keys = agent_keys(listed).unwrap();
        assert_eq!(keys[0], AgentKey { id: "k1".into(), title: "laptop (writes as claude)".into(), detail: "memory write, pages scoped (read /notes; write /notes/agent), other ships ~nec (read /x; write ), skills read, reads sensitive memories. Made 2026-11-17 17:25 UTC, last used 2026-11-18 06:05 UTC. Read sensitive content, so until 2026-11-18 18:05 UTC it writes only sensitive".into() });
        assert_eq!(keys[1].detail, "memory read, pages none, other ships none, skills none. Made 2026-01-02 03:04 UTC, never used");
        assert!(agent_keys("{}").is_err());
    }

    /// Agent keys against a ship: made, listed, used, refused, revoked.
    #[test]
    #[ignore]
    fn live_agent_keys() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let by = format!("rune-{}", crate::api::since_epoch().unwrap().as_secs());
        let ask = KeyAsk { name: "Rune's test key".into(), by: by.clone(), memory: "read".into(), pages: "some".into(), pages_read: "notes".into(), web: "off".into(), skills: "none".into(), ..KeyAsk::default() };
        let token = c.key_mint(&key_request(&ask).unwrap()).unwrap();
        assert!(token.len() > 20, "a secret is given once");
        let keys = c.keys().unwrap();
        let k = keys.iter().find(|k| k.title == format!("Rune's test key (writes as {by})")).expect("the key is listed");
        assert!(k.detail.starts_with("memory read, pages scoped (read /notes; write ), other ships none, skills none. Made 20") && k.detail.ends_with("never used"), "{}", k.detail);
        // the same name to write as is refused, with the ship's reason
        let again = c.key_mint(&key_request(&ask).unwrap()).unwrap_err();
        eprintln!("a second key writing as the same name: {again}");
        assert!(again.starts_with("409") || again.starts_with("400"), "{again}");
        c.key_revoke(&k.id).unwrap();
        assert!(!c.keys().unwrap().iter().any(|x| x.id == k.id));
    }

    #[test]
    fn the_runtime_and_the_token_are_said_as_the_ships_page_says_them() {
        let st = |have: Option<&str>, busy, source, error: Option<&str>| ScadStatus { pin: "2026.05".into(), size: 4_260_000, have: have.map(str::to_owned), error: error.map(str::to_owned), busy, source };
        assert_eq!(st(None, false, true, None).says(), ("Not installed.".into(), Some("Install (4.3 MB)".into()), false));
        assert_eq!(st(None, false, true, Some("fetch failed")).says().0, "Not installed: fetch failed");
        assert_eq!(st(None, false, false, None).says(), ("This build of lattice names no address to install from.".into(), None, false));
        assert_eq!(st(Some("2026.05"), false, true, None).says(), ("OpenSCAD 2026.05 is installed.".into(), None, true));
        assert_eq!(st(Some("2025.01"), false, true, Some("x")).says(), ("OpenSCAD 2025.01 is installed. This lattice offers 2026.05. The last update failed: x".into(), Some("Update to 2026.05 (4.3 MB)".into()), true));
        assert_eq!(st(Some("2025.01"), true, true, None).says(), ("installing, this takes a little while...".into(), None, false));
        // as the ship writes it, with nothing installed
        let read: ScadStatus = serde_json::from_str(r#"{"pin":"2026.05","size":4260000,"have":null,"error":null,"busy":false,"source":true}"#).unwrap();
        assert_eq!(read, st(None, false, true, None));
        let t = |token, orrery| TileStatus { token, orrery, ..TileStatus::default() };
        assert_eq!([tiles_say(&t(false, false)), tiles_say(&t(true, false)), tiles_say(&t(true, true))], ["No token is set.", "A token is set. It is never shown again.", "Using the Mapbox token set in orrery. A token saved here is used instead."]);
    }

    /// The ship's OpenSCAD runtime: its state read, installed from the address the ship names, and dropped. The install fetches about 4 MB.
    #[test]
    #[ignore]
    fn live_scad_runtime() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let st = c.scad_status().unwrap();
        eprintln!("before: {st:?}");
        assert!(!st.pin.is_empty() && st.size > 1_000_000);
        if !st.source {
            eprintln!("this build names no address to install from: the install is not tried");
            return;
        }
        c.scad_runtime(true).unwrap();
        let mut now = c.scad_status().unwrap();
        for _ in 0..150 {
            if !now.busy {
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
            now = c.scad_status().unwrap();
        }
        eprintln!("after the install: {now:?}");
        assert!(!now.busy, "the install ends");
        assert!(now.have.as_deref() == Some(now.pin.as_str()) || now.error.is_some(), "it is installed, or the ship says why not");
        c.scad_runtime(false).unwrap();
        assert_eq!(c.scad_status().unwrap().have, None);
    }

    /// The Commons mirror against a ship: its state read, turned on and off. A fake ship cannot reach the ship that publishes %obelisk, so it is not installed here.
    #[test]
    #[ignore]
    fn live_mirror() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let was = c.obelisk().unwrap();
        eprintln!("before: {was:?}");
        c.mirror(true).unwrap();
        let on = c.obelisk().unwrap();
        c.mirror(false).unwrap();
        let off = c.obelisk().unwrap();
        eprintln!("turned on: {on:?}, turned off: {off:?}");
        assert!(!off.enabled);
        // with %obelisk there the switch is what the ship then says. Without it, the ship's answer is printed, not assumed
        if was.installed {
            assert!(on.enabled);
        }
        c.obelisk_install().unwrap();
    }

    #[test]
    fn going_public_is_what_asks_first() {
        for (was, mode, asks) in [("private", "shared", true), ("", "clearweb", true), ("mixed", "shared", true), ("shared", "clearweb", false), ("clearweb", "shared", false), ("shared", "private", false), ("private", "private", false)] {
            assert_eq!(goes_public(was, mode), asks, "{was} to {mode}");
        }
    }

    /// The search index rebuilt on a ship, and a page then found by a word in it.
    #[test]
    #[ignore]
    fn live_reindex() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        c.reindex().unwrap();
    }

    #[test]
    fn an_address_is_made_whole_and_what_stands_there_is_read() {
        assert_eq!(urb_address(" ~nec/notes/a "), Some("urb://~nec/notes/a".into()));
        assert_eq!(urb_address("urb://~sampel-palnet"), Some("urb://~sampel-palnet".into()));
        for bad in ["", "notes/a", "nec/a", "https://example.com", "urb://Notes"] {
            assert_eq!(urb_address(bad), None, "{bad}");
        }
        assert!(urb_is_forum("urb://~nec/forum/chat/3") && urb_is_forum("urb://~nec/forum") && !urb_is_forum("urb://~nec/notes/forum"));
        let page = r##"{"url":"urb://~nec/notes/a","ship":"~nec","own":false,"kind":"page","shared":false,"path":"/notes/a","mode":"md","body":"# A\n","size":4,"comments":[{"author":"~bud","when":"~2026.1.1","body":"hi"}]}"##;
        assert_eq!(urb_parse(page), Ok(Urb::Page { ship: "~nec".into(), path: "notes/a".into(), kind: "md".into(), body: "# A\n".into(), comments: 1 }));
        let own = r##"{"url":"urb://~zod/a","ship":"~zod","own":true,"kind":"page","mode":"gmi","name":"a","body":"x","rev":2,"comments":[]}"##;
        assert_eq!(urb_parse(own), Ok(Urb::Page { ship: "~zod".into(), path: "a".into(), kind: "gmi".into(), body: "x".into(), comments: 0 }));
        let folder = r#"{"url":"urb://~nec/notes/","ship":"~nec","own":false,"kind":"folder","path":"/notes","entries":[{"name":"sub","url":"urb://~nec/notes/sub/","folder":true},{"name":"a","url":"urb://~nec/notes/a","folder":false}]}"#;
        assert_eq!(urb_parse(folder), Ok(Urb::Folder { path: "/notes".into(), entries: vec![("sub".into(), "urb://~nec/notes/sub/".into(), true), ("a".into(), "urb://~nec/notes/a".into(), false)] }));
        assert_eq!(urb_parse(r#"{"kind":"binary","mark":"mime","type":"image/png","size":1234}"#), Ok(Urb::Binary { kind: "image/png".into(), size: 1234 }));
        assert_eq!(urb_parse(r#"{"kind":"thread"}"#), Ok(Urb::Forum));
        assert!(urb_parse("{}").is_err() && urb_parse("not json").is_err());
    }

    /// An address read through a ship: its own published page, its own folder, and a ship that is not there.
    #[test]
    #[ignore]
    fn live_urb_read() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let dir = format!("urbt{}", crate::api::since_epoch().unwrap().as_secs());
        let name = format!("{dir}/page");
        let q = Queued { kind: "md".into(), body: "# Read by address\n".into(), base: 0, is_new: true, at: 0 };
        assert!(matches!(c.send_queued(&name, &q), Sent::Done { .. }));
        c.share(&name, "shared").unwrap();
        let got = c.urb_read(&format!("urb://{}/{name}", c.ship())).unwrap();
        assert_eq!(got, Urb::Page { ship: c.ship().to_owned(), path: name.clone(), kind: "md".into(), body: "# Read by address\n".into(), comments: 0 });
        let folder = c.urb_read(&format!("urb://{}/{dir}/", c.ship()));
        eprintln!("the folder's address: {folder:?}");
        let away = c.urb_read("urb://~nec/notes/a").unwrap_err();
        eprintln!("a ship that is not there: {away}");
        assert!(away.starts_with("504") || away.starts_with("404"), "{away}");
        c.delete(&name).unwrap();
    }

    #[test]
    fn the_change_stream_is_read_and_says_what_to_read_again() {
        // events come in pieces: only whole ones are taken, and the rest waits
        let mut buf = String::from("event: old /rev\ndata: 41\n\nevent: old /know\ndata: 7\n\nevent: upd /re");
        assert_eq!(sse_events(&mut buf), [("old /rev".to_owned(), "41".to_owned()), ("old /know".to_owned(), "7".to_owned())]);
        assert_eq!(buf, "event: upd /re");
        buf.push_str("v\ndata: 42\n\n: a comment line\n\n");
        assert_eq!(sse_events(&mut buf), [("upd /rev".to_owned(), "42".to_owned())]);
        assert_eq!(beacon_of("upd /rev", "42"), Some(Beacon::Rev { old: false, stamp: "42".into() }));
        assert_eq!(beacon_of("old /comments", "x"), None, "a comment stamp as it stood is not news");
        assert_eq!((beacon_of("upd /comments", "x"), beacon_of("upd /folds", "x")), (Some(Beacon::Comments), None));
        let rev = |old, n: &str| Beacon::Rev { old, stamp: n.into() };
        let mut st = BeaconState::default();
        // the first registration is no news: nothing was seen before it
        assert_eq!(st.take(rev(true, "41")), Wants::default());
        assert!(st.live);
        // a change on the live stream is
        assert!(st.take(rev(false, "42")).tree);
        // the stream ends and comes back at the same stamp: nothing was missed
        st.take(Beacon::Down);
        assert!(!st.live);
        assert_eq!(st.take(rev(true, "42")), Wants::default());
        // it comes back at another: something changed while nobody listened
        st.take(Beacon::Down);
        assert!(st.take(rev(true, "45")).tree && st.live);
        // memories have their own stamp
        assert_eq!(st.take(Beacon::Know { old: true, stamp: "7".into() }), Wants::default());
        assert!(st.take(Beacon::Know { old: false, stamp: "8".into() }).know);
        // shares and the inbox say the same stamp again when nothing moved
        assert_eq!(st.take(Beacon::Shares { old: true, stamp: "a".into() }), Wants::default());
        assert_eq!(st.take(Beacon::Shares { old: false, stamp: "a".into() }), Wants::default());
        assert!(st.take(Beacon::Shares { old: false, stamp: "b".into() }).shared);
        assert!(st.take(Beacon::Shares { old: true, stamp: "c".into() }).shared, "moved while the stream was down");
        assert_eq!(st.take(Beacon::Notify { old: true, stamp: "n1".into() }), Wants::default());
        assert!(st.take(Beacon::Notify { old: false, stamp: "n2".into() }).inbox && st.take(Beacon::Comments).inbox);
        // listening again: at once in effect after a stream that lived, slower after each that did not, thirty seconds at most
        assert_eq!((beacon_fail(3, true, 80_000, false), beacon_fail(3, true, 2_000, true), beacon_fail(0, true, 2_000, false), beacon_fail(5, false, 0, false)), (0, 0, 1, 5));
        assert_eq!([beacon_wait(0, 0.5), beacon_wait(1, 0.5), beacon_wait(2, 0.5), beacon_wait(3, 0.0), beacon_wait(5, 1.0), beacon_wait(9, 0.5)], [3000, 3000, 6000, 6000, 30_000, 30_000]);
    }

    /// The change stream of a ship: registered, and a page saved while it is listened to comes down it.
    #[test]
    #[ignore]
    fn live_beacon() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let base = c.lat_base().unwrap();
        eprintln!("the base: {base}");
        let name = format!("beacon/p{}", crate::api::since_epoch().unwrap().as_secs());
        let (c2, name2) = (c.clone(), name.clone());
        let mut seen = Vec::new();
        let mut saver = None;
        let (registered, bumped) = c
            .beacon_stream(&base, |ev| {
                eprintln!("{ev:?}");
                // once it is registered, a page is saved from elsewhere
                if matches!(ev, Beacon::Rev { old: true, .. }) && saver.is_none() {
                    let (c3, n3) = (c2.clone(), name2.clone());
                    saver = Some(std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(1));
                        c3.send_queued(&n3, &Queued { kind: "md".into(), body: "seen\n".into(), base: 0, is_new: true, at: 0 })
                    }));
                }
                let done = matches!(ev, Beacon::Rev { old: false, .. });
                seen.push(ev);
                !done
            })
            .unwrap();
        assert!(registered && bumped, "{seen:?}");
        assert!(matches!(saver.unwrap().join().unwrap(), Sent::Done { .. }));
        c.delete(&name).unwrap();
    }

    #[test]
    fn the_connection_is_said_as_it_stands() {
        assert_eq!([link(false, false), link(true, false), link(false, true), link(true, true)], [Link::Connected, Link::Unreachable, Link::SignedOut, Link::Unreachable]);
        assert!(lapsed("403: sign in") && lapsed("401: ") && !lapsed("404: no such page") && !lapsed("http://ship: Connection refused"));
    }

    #[test]
    fn the_ships_software_is_listed_as_the_desktop_lists_it() {
        assert!(bound(200) && bound(403) && bound(406) && !bound(307) && !bound(404));
        let all = Stack { mcp: Some("~zod urbit mcp server".into()), grubbery: true, lattice: true };
        assert!(!all.missing());
        assert_eq!(all.lines()[0], (true, "%mcp", "~zod urbit mcp server".to_owned()));
        let none = Stack::default();
        assert!(none.missing());
        assert_eq!(none.lines().map(|(on, name, word)| (on, name, word)), [(false, "%mcp", "not installed".to_owned()), (false, "%grubbery", "not installed".to_owned()), (false, "lattice", "not installed".to_owned())]);
        assert!(Stack { mcp: Some("x".into()), grubbery: true, lattice: false }.missing());
        assert!(!Stack { mcp: None, grubbery: true, lattice: true }.missing(), "lattice runs: the bootstrap is not asked after");
    }

    /// What a ship has of lattice's software, asked of a fake ship that has lattice.
    #[test]
    #[ignore]
    fn live_stack() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let st = c.stack().unwrap();
        eprintln!("{st:?}");
        assert!(st.grubbery && st.lattice, "the ship this is run against has both");
        assert!(Conn { url: "http://127.0.0.1:9".into(), cookie: String::new() }.stack().is_err(), "a ship that cannot be asked is an error, not an empty list");
    }

    #[test]
    fn pruning_is_checked_before_it_is_sent() {
        assert_eq!(prune_rule(" 0 ", "1"), Ok((0, 1)));
        assert!(prune_rule("-1", "3").is_err() && prune_rule("2", "0").is_err() && prune_rule("2", "").is_err() && prune_rule("x", "3").is_err());
    }

    /// A board's moderation against a ship: roles, sidebar, pruning, comets and invitations.
    #[test]
    #[ignore]
    fn live_forum_mod() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let name = format!("mod-{}", crate::api::since_epoch().unwrap().as_secs());
        c.forum_new(&name, "Moderated", "", "reader").unwrap();
        let m = c.forum_mod(&name).unwrap();
        assert_eq!((m.default_role.as_str(), m.public, m.prune, m.sidebar.as_str(), m.roles.len()), ("reader", true, false, "", 0));
        let comets = m.comets.expect("a public board says whether comets post");
        c.forum_role(&name, "~nec", Some("mod")).unwrap();
        c.forum_role(&name, "~bud", Some("poster")).unwrap();
        c.forum_sidebar(&name, "Be kind & <brief>\nhttps://example.com").unwrap();
        c.forum_prune(&name, Some((4, 12))).unwrap();
        c.forum_comets(&name).unwrap();
        let m = c.forum_mod(&name).unwrap();
        assert_eq!(m.roles, [("~bud".to_owned(), "poster".to_owned()), ("~nec".to_owned(), "moderator".to_owned())]);
        assert_eq!((m.sidebar.as_str(), m.prune, m.min_score, m.after_days, m.comets), ("Be kind & <brief>\nhttps://example.com", true, 4, 12, Some(!comets)));
        c.forum_role(&name, "~nec", None).unwrap();
        c.forum_sidebar(&name, "").unwrap();
        c.forum_prune(&name, None).unwrap();
        let m = c.forum_mod(&name).unwrap();
        // a role taken away is the board's default given by name: the ship still lists the ship
        assert_eq!(m.roles, [("~bud".to_owned(), "poster".to_owned()), ("~nec".to_owned(), "reader".to_owned())]);
        assert_eq!((m.sidebar.as_str(), m.prune), ("", false));
        // a bad ship or role is refused outright
        assert!(c.forum_role(&name, "nec", Some("mod")).unwrap_err().starts_with("400"));
        assert!(c.forum_role(&name, "~nec", Some("king")).unwrap_err().starts_with("400"));
        // only a private board has members: an invitation holds though the other ship is not there to be told
        assert!(c.forum_invite(&name, "~nec", true).unwrap_err().starts_with("400"));
        c.forum_flip_public(&name).unwrap();
        assert_eq!(c.forum_mod(&name).unwrap().comets, None);
        assert_eq!(c.forum_invite(&name, "~nec", true), Ok(false));
        c.forum_invite(&name, "~nec", false).unwrap();
        assert!(c.forum_invite(&name, c.ship(), true).unwrap_err().starts_with("400"), "the owner is not invited to their own board");
        c.forum_board_delete(&name).unwrap();
    }

    /// A board by its address against one ship: its own is read the plain way, and one on a ship that is not there is said so, not hung on.
    #[test]
    #[ignore]
    fn live_forum_away() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let name = format!("away-{}", crate::api::since_epoch().unwrap().as_secs());
        c.forum_new(&name, "Here", "", "poster").unwrap();
        let (key, post) = board_key(&format!("urb://{}/forum/{name}", c.ship()), c.ship()).unwrap();
        assert_eq!((key.as_str(), post), (name.as_str(), None));
        assert_eq!(c.forum_board(&key).unwrap().title, "Here");
        let (key, _) = board_key("urb://~nec/forum/chat", c.ship()).unwrap();
        let why = c.forum_board(&key).unwrap_err();
        assert!(why.starts_with("504") && why.contains("does not answer"), "{why}");
        assert!(c.forum_thread(&key, 1).unwrap_err().starts_with("504"));
        // a thread sent there is handed to this ship, which answers as it does for any form
        c.forum_submit(&key, "Hello", "", "text", &[]).unwrap();
        c.forum_board_delete(&name).unwrap();
    }

    /// Memories against a ship, by themselves: this needs no page and can run again on the same pier.
    #[test]
    #[ignore]
    fn live_memories() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        // a memory is written, listed with its text, and deleted. The ship
        // may refuse a key whose deleted memory is still in the trash, so
        // each run uses its own.
        let key = format!("/rune/probe-{}", crate::api::since_epoch().unwrap().as_secs());
        c.know_save(&key, "a fact\n").unwrap();
        let all = c.know_all().unwrap();
        let got = all.iter().find(|k| k.key == key).expect("the memory is listed");
        assert_eq!(got.body.trim(), "a fact");
        // moved, it is read under the new key and gone from the old. A key taken or missing is refused
        let moved = format!("{key}-moved");
        c.know_move(&key, &moved).unwrap();
        let all = c.know_all().unwrap();
        assert!(all.iter().any(|k| k.key == moved && k.body.starts_with("a fact")) && !all.iter().any(|k| k.key == key), "the memory moved with its text");
        c.know_save(&key, "another\n").unwrap();
        assert!(c.know_move(&key, &moved).unwrap_err().contains("409"), "a key already taken is refused");
        assert!(c.know_move(&format!("{key}-never"), &format!("{key}-x")).unwrap_err().contains("404"), "a key that is not there is refused");
        // a core memory whose text says an agent wrote it waits in the notice's list until it is kept or untagged
        let (rule, other) = (format!("{key}-rule"), format!("{key}-rule2"));
        for k in [&rule, &other] {
            c.know_save(k, "---\nsource: agent\n---\nAlways answer briefly.\n").unwrap();
            c.know_tag(k, "core", true).unwrap();
        }
        let waiting = c.know_core_agents().unwrap();
        assert!(waiting.contains(&rule) && waiting.contains(&other), "{waiting:?}");
        c.know_core_keep(&rule).unwrap();
        c.know_tag(&other, "core", false).unwrap();
        let waiting = c.know_core_agents().unwrap();
        assert!(!waiting.contains(&rule) && !waiting.contains(&other), "{waiting:?}");
        // kept, it is still core and says the owner vouched for it. Untagged, it is no rule any more
        let all = c.know_all().unwrap();
        let kept = all.iter().find(|k| k.key == rule).unwrap();
        assert!(kept.tags.contains(&"core".to_owned()) && kept.body.contains("source: user") && kept.body.contains("Always answer briefly."), "{kept:?}");
        assert!(!all.iter().find(|k| k.key == other).unwrap().tags.contains(&"core".to_owned()));
        assert!(c.know_core_keep(&format!("{key}-never")).unwrap_err().contains("404"));
        c.know_delete(&rule).unwrap();
        c.know_delete(&other).unwrap();
        // each save is a revision: the old text is read at its number, and restored it is the newest again
        c.know_save(&moved, "a fact, rewritten\n").unwrap();
        let revs = c.know_history(&moved).unwrap();
        assert!(revs.len() >= 2 && revs.windows(2).all(|w| w[0].rev < w[1].rev), "{revs:?}");
        let (first, last) = (revs[0].rev, revs[revs.len() - 1].rev);
        assert!(c.know_at(&moved, first).unwrap().starts_with("a fact\n") || c.know_at(&moved, first).unwrap().trim() == "a fact");
        assert_eq!(c.know_at(&moved, last).unwrap().trim(), "a fact, rewritten");
        assert!(c.know_at(&moved, last + 50).unwrap_err().contains("404"));
        c.know_restore_rev(&moved, first).unwrap();
        let now = c.know_all().unwrap().into_iter().find(|k| k.key == moved).unwrap();
        assert_eq!(now.body.trim(), "a fact");
        let after = c.know_history(&moved).unwrap();
        // the restore is a revision of its own. The ship may let an older one go as it writes it, so only that is held
        assert!(after.last().is_some_and(|r| r.rev > last), "{after:?}");
        assert!(c.know_restore_rev(&moved, last + 50).unwrap_err().contains("404"));
        // a tag goes on, is listed folded to lower case, and comes off
        c.know_tag(&moved, "Rune-Tag", true).unwrap();
        c.know_tag(&moved, "second", true).unwrap();
        let tags = |c: &Conn| c.know_all().unwrap().into_iter().find(|k| k.key == moved).map(|k| k.tags).unwrap_or_default();
        let mut got = tags(&c);
        got.sort();
        assert_eq!(got, ["rune-tag", "second"]);
        c.know_tag(&moved, "rune-tag", false).unwrap();
        assert_eq!(tags(&c), ["second"]);
        // one that was never on comes off without complaint, and a key that is not a key is refused
        c.know_tag(&moved, "never", false).unwrap();
        assert!(c.know_tag("", "x", true).is_err());
        // deleted, a memory is in the trash and not in the list. Restored, it is back with its text and its tags
        c.know_delete(&moved).unwrap();
        assert!(c.know_trash().unwrap().contains(&moved) && !c.know_all().unwrap().iter().any(|k| k.key == moved));
        // the ship takes a restore. Whether the memory is then back is not held here: on a fake pier
        // the ship answers ok and leaves it in the trash, asked by hand as well, so that is said and not failed
        c.know_restore(&moved).unwrap();
        let back = c.know_all().unwrap().into_iter().any(|k| k.key == moved);
        eprintln!("after a restore the memory is {}", if back { "back in the list" } else { "still in the trash: this pier's ship does not bring it back" });
        if back {
            c.know_delete(&moved).unwrap();
        }
        assert!(c.know_restore("").is_err(), "a key that is not a key is refused");
        c.know_delete(&key).unwrap();
        assert!(!c.know_all().unwrap().iter().any(|k| k.key == key), "and gone after a delete");
    }

    /// An empty folder made on a ship is in the tree it then gives, with the names typed.
    #[test]
    #[ignore = "needs a ship: LATTICE_URL and LATTICE_COOKIE"]
    fn live_folder_new_is_listed_empty() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let stamp = crate::api::since_epoch().unwrap().as_secs();
        let rn = real_name(&format!("Rune Dir {stamp}/Sub Folder")).unwrap();
        assert_eq!(rn.name, format!("rune-dir-{stamp}/sub-folder"));
        c.folder_new(&rn).unwrap();
        let tree = c.tree().unwrap();
        let node = |path: &str| tree.iter().find(|n| n.path == path).unwrap_or_else(|| panic!("{path} is not in the tree"));
        let (outer, inner) = (node(&format!("rune-dir-{stamp}")), node(&rn.name));
        assert!(!outer.page && !inner.page, "both are folders");
        assert_eq!((outer.dname.as_str(), inner.dname.as_str()), (format!("Rune Dir {stamp}").as_str(), "Sub Folder"), "shown as typed");
        assert!(!tree.iter().any(|n| n.page && n.path.starts_with(&format!("rune-dir-{stamp}/"))), "and nothing is in them");
        // made again, it is no error and nothing doubles
        c.folder_new(&rn).unwrap();
        assert_eq!(c.tree().unwrap().iter().filter(|n| n.path == rn.name).count(), 1);
        // a name the ship does not take is refused
        let bad = RealName { name: "Bad Name".into(), dname: String::new(), dnames: String::new() };
        assert!(c.folder_new(&bad).is_err());
        println!("folder: {}", rn.name);
    }

    /// The themes in the ship's %settings, read as the window reads them:
    /// Talon's while it is followed, lattice's own once the switch is off.
    #[test]
    #[ignore = "needs a ship: LATTICE_URL and LATTICE_COOKIE"]
    fn live_themes_are_read_from_settings() {
        use serde_json::json;
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        // a ship that was never themed answers, with nothing
        let bare = c.worn(crate::theme::Worn::default()).expect("the ship answers with no bucket");
        println!("before: {}", bare.said());
        let ship = c.call_url(30, "GET", &format!("{}/~/host", c.url), None).unwrap().trim().trim_start_matches('~').to_owned();
        let stamp = crate::api::since_epoch().unwrap().as_millis();
        // as the web client's theme script writes an entry: a poke on a channel of its own
        let put = |desk: &str, entry: &str, value: serde_json::Value| {
            let url = format!("{}/~/channel/rune-theme-{stamp}-{desk}-{entry}", c.url);
            let poke = json!([{ "id": 1, "action": "poke", "ship": ship, "app": "settings", "mark": "settings-event", "json": { "put-entry": { "desk": desk, "bucket-key": "ui-prefs", "entry-key": entry, "value": value.to_string() } } }]);
            c.call_url(30, "PUT", &url, Some(&poke.to_string())).unwrap();
        };
        let theme = |id: &str, name: &str, surface: &str| json!({ "id": id, "name": name, "dark": true, "primary": "#8AB4F8", "secondary": "#C58AF9", "tertiary": "#78D9EC", "background": "#101418", "surface": surface, "text": "", "muted": "", "raised": "", "error": "", "selection": "", "link": "" });
        let until = |what: &str, ok: &dyn Fn(&crate::theme::Worn) -> bool| {
            for _ in 0..40 {
                let w = c.worn(crate::theme::Worn::default()).unwrap();
                if ok(&w) {
                    return w;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            panic!("{what} was not read back");
        };
        let name = format!("Night {stamp}");
        put("talon", "themes", json!({ "themes": [theme("a", &name, "#1B2026")], "activeId": "a" }));
        put("talon", "accent", json!({ "enabled": true, "mode": "Custom", "customHex": "FFCC00" }));
        let w = until("Talon's theme and accent", &|w| w.name() == Some(name.as_str()) && w.look().accent.is_some_and(|a| a.hex().starts_with("#ffcc00")));
        assert!(w.follows());
        assert_eq!(w.look().bg.map(|c| c.hex()), Some("#1b2026ff".to_owned()));
        // lattice's own, worn once Talon is not followed
        let mine = format!("Mine {stamp}");
        put("lattice", "themes", json!({ "themes": [theme("m", &mine, "#202020")], "activeId": "m" }));
        put("lattice", "use-talon-theme", json!({ "enabled": false }));
        let w = until("lattice's own theme", &|w| !w.follows() && w.name() == Some(mine.as_str()));
        assert_eq!(w.look().bg.map(|c| c.hex()), Some("#202020ff".to_owned()));
        // and back to following Talon
        put("lattice", "use-talon-theme", json!({ "enabled": true }));
        until("Talon followed again", &|w| w.follows() && w.name() == Some(name.as_str()));
    }

    /// The reader's bookmarks, kept on a ship and read back as the left pane reads them.
    #[test]
    #[ignore = "needs a ship: LATTICE_URL and LATTICE_COOKIE"]
    fn live_bookmarks_are_kept_and_read_newest_first() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let stamp = crate::api::since_epoch().unwrap().as_secs();
        let (one, two) = (format!("urb://~zod/rune-mark-{stamp}"), format!("https://example.com/rune mark?n={stamp}&x=1"));
        c.bookmark(&one, "Rune & one", "rune marks").unwrap();
        c.bookmark(&two, "", "").unwrap();
        let all = c.bookmarks().unwrap();
        let at = |url: &str| all.iter().position(|b| b.url == url).unwrap_or_else(|| panic!("{url} is not among {all:?}"));
        assert_eq!(all[at(&one)], Bookmark { url: one.clone(), title: "Rune & one".into(), folder: "rune marks".into() }, "title and folder come back as sent");
        // a title sent empty is kept empty, so the pane shows the address for it
        assert_eq!((all[at(&two)].title.as_str(), all[at(&two)].folder.as_str()), ("", ""));
        assert_eq!(crate::marks::label(&all[at(&two)]), two);
        assert!(at(&two) < at(&one), "the one kept last is read first");
        // a bookmark of a page that is shared opens by the read the pane uses for it.
        // The page is left there, named for the run, for `scripts/marks-ship.json` to press
        let name = format!("marks{stamp}/page");
        let q = Queued { kind: "md".into(), body: "# Kept by a bookmark\n".into(), base: 0, is_new: true, at: 0 };
        assert!(matches!(c.send_queued(&name, &q), Sent::Done { .. }));
        c.share(&name, "shared").unwrap();
        let there = format!("urb://{}/{name}", c.ship());
        c.bookmark(&there, "Kept page", "rune marks").unwrap();
        assert!(matches!(c.urb_read(&there).unwrap(), Urb::Page { body, .. } if body == "# Kept by a bookmark\n"));
        println!("bookmarked: {there}");
        // moved in place, then out of its folder, then dropped, each as the ship has it
        let list = |c: &Conn| c.bookmarks().unwrap();
        let before = list(&c);
        c.bookmark_move(&two, "later reading").unwrap();
        let moved = list(&c);
        assert_eq!(moved, crate::marks::after(&before, &crate::marks::Change::Move(two.clone(), "later reading".into())), "a move changes the folder and keeps the order");
        assert!(moved.iter().any(|b| b.url == two && b.folder == "later reading"));
        c.bookmark_move(&two, "").unwrap();
        assert_eq!(list(&c), before, "and back out of it");
        c.unbookmark(&two).unwrap();
        assert_eq!(list(&c), crate::marks::after(&before, &crate::marks::Change::Drop(two.clone())));
        // one kept again goes to the front and does not double
        c.bookmark(&one, "Rune & one, again", "").unwrap();
        let again = list(&c);
        assert_eq!(again, crate::marks::after(&crate::marks::after(&before, &crate::marks::Change::Drop(two.clone())), &crate::marks::Change::Keep(one.clone(), "Rune & one, again".into(), String::new())));
        assert_eq!(again.iter().filter(|b| b.url == one).count(), 1);
        let all = { let mut a = again; a.retain(|b| b.url != one); a.push(Bookmark { url: one.clone(), title: "Rune & one".into(), folder: "rune marks".into() }); a };
        let at = |url: &str| all.iter().position(|b| b.url == url).unwrap();
        // and the rows the pane makes of them
        let rows = crate::marks::rows(&all, &format!("rune-mark-{stamp}"), &[]);
        assert_eq!(rows, [crate::marks::Row::Folder { name: "rune marks".into(), folded: false }, crate::marks::Row::Mark { at: at(&one), under: true }]);
    }

    /// Against a real ship: `LATTICE_URL=.. LATTICE_COOKIE=.. cargo test -- --ignored`.
    /// It needs a page named `rune-probe` to exist.
    #[test]
    #[ignore]
    fn live_read_save_and_conflict() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        assert!(c.tree().unwrap().iter().any(|n| n.page && n.path == "rune-probe"), "the tree lists the page");
        let mut p = c.page("rune-probe").unwrap();
        // a base of 0 is no check at all on the ship, as in the web client:
        // move a fresh page past it first
        if p.rev == 0 {
            p.body.push_str("\nfirst\n");
            p.rev = c.save(&p, 0).unwrap();
        }
        let base = p.rev;
        p.body = format!("# probe\n\nsaved at rev {base}\n");
        let rev = c.save(&p, base).unwrap();
        assert!(rev > base, "a save moves the rev: {base} -> {rev}");
        assert_eq!(c.page("rune-probe").unwrap().body, p.body, "and reads back");
        // the same text again is no conflict: the ship takes it as already landed
        p.body.push_str("another edit\n");
        assert!(c.save(&p, base).unwrap_err().starts_with("409"), "a stale base is refused");
        // history lists what was saved, and an old revision reads as it was
        let revs = c.history("rune-probe").unwrap();
        assert!(revs.len() >= 2 && revs[0].rev > revs[1].rev, "newest first: {revs:?}");
        assert!(revs[0].when().starts_with("20"), "a date: {}", revs[0].when());
        // not every number is a stored revision: read one the list names
        let old = c.page_at("rune-probe", revs[1].rev).unwrap();
        assert!(old.body != p.body && old.rev == revs[1].rev, "the old text, not the new");
        assert!(c.page_at("rune-probe", 999_999).is_err(), "a revision that is not there is an error, not a page");
        // sharing moves a page between private, Urbit and the web, and the dump says which
        // a node the dump gives no share is private
        let mode = |c: &Conn| Some(c.dump("").unwrap().nodes.into_iter().find(|n| n.path == "rune-probe").unwrap().share).filter(|m| !m.is_empty()).unwrap_or("private".into());
        c.share("rune-probe", "private").unwrap();
        assert_eq!(mode(&c), "private");
        c.share("rune-probe", "clearweb").unwrap();
        assert_eq!(mode(&c), "clearweb");
        let open = ureq::get(&c.address("rune-probe", "clearweb").unwrap()).call().map(|r| r.status());
        assert_eq!(open.ok(), Some(200), "the web address answers with no session");
        c.share("rune-probe", "shared").unwrap();
        assert_eq!(mode(&c), "shared");
        c.share("rune-probe", "private").unwrap();
        assert_eq!(mode(&c), "private");
        assert!(c.address("a/b", "shared").unwrap().starts_with("urb://~") && c.address("a", "private").is_none());
        // a group is saved, changed and deleted, each call accepted. On the
        // fake ships' kernel only the first group write of a pier's life shows
        // in the access list (PARITY.md), so the list is checked when the
        // group is there and the rest is the calls answering.
        let base = c.base().unwrap();
        assert!(base.starts_with("/apps/") && base.ends_with("lattice_app"), "the lattice's place on the ship: {base}");
        let gname = format!("rune{}", crate::api::since_epoch().unwrap().as_secs());
        let g = Group { name: gname.clone(), ships: vec!["~nec".into(), "~bud".into()], ..Group::default() }.with_level(&base, "rune-probe", Level::Read);
        c.group_save(&g).unwrap();
        match c.groups().unwrap().into_iter().find(|x| x.name == gname) {
            Some(got) => {
                // the ship lists ships in its own order
                let mut ships = got.ships.clone();
                ships.sort();
                assert_eq!((ships, got.level(&base, "rune-probe")), (vec!["~bud".to_owned(), "~nec".to_owned()], Level::Read));
                assert!(readers(&c.groups().unwrap(), "rune-probe").iter().any(|r| r.ship == "~bud" && !r.edit), "its ships read the page");
                eprintln!("the group landed and read back");
            }
            None => eprintln!("the group did not show in the access list: not this pier's first group write"),
        }
        c.group_save(&g.with_level(&base, "rune-probe", Level::Edit)).unwrap();
        c.group_delete(&gname).unwrap();
        assert!(c.group_save(&Group { name: "Bad Name".into(), ..Group::default() }).unwrap_err().starts_with("400"));
        // a comment is posted on a page, listed, and removed. Off by default, and refused empty
        assert!(!c.comments_on("rune-probe").unwrap());
        c.set_comments("rune-probe", true).unwrap();
        assert!(c.comments_on("rune-probe").unwrap());
        let said = format!("a comment at {base}");
        c.comment("rune-probe", &said).unwrap();
        let mine = |c: &Conn| c.comments().unwrap().into_iter().find(|m| m.page == "rune-probe" && m.body == said);
        // the write is its own step behind the answer
        let mut got = None;
        for _ in 0..20 {
            got = mine(&c);
            if got.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        let got = got.expect("the comment is in the inbox");
        assert!(got.author.starts_with('~') && !got.id.is_empty());
        assert!(c.comment("rune-probe", "").unwrap_err().starts_with("400"), "an empty comment is refused");
        c.comment_delete("rune-probe", &got.id).unwrap();
        assert!(mine(&c).is_none(), "a removed comment is gone");
        let run = crate::api::since_epoch().unwrap().as_secs();
        // a batch makes every page in it, with the folders they need, and an empty one is refused
        c.save_batch(&[(format!("rune-batch-{run}/a"), "md", "# a\n".into()), (format!("rune-batch-{run}/deep/b"), "text", "b\n".into())]).unwrap();
        // the ship answers before it has written them all, so the last one is waited for
        for _ in 0..40 {
            if c.page(&format!("rune-batch-{run}/deep/b")).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        assert_eq!(c.page(&format!("rune-batch-{run}/deep/b")).unwrap().body, "b\n");
        assert_eq!(c.page(&format!("rune-batch-{run}/a")).unwrap().kind, "md");
        assert!(c.save_batch(&[]).is_err());
        // templates: each one listed makes a page or a folder of pages, and a name in use is refused
        let tmpls = c.templates().unwrap();
        assert!(!tmpls.is_empty(), "the ship has templates");
        for t in &tmpls {
            let name = format!("rune-tmpl-{t}-{run}");
            c.template_new(t, &RealName { name: name.clone(), dname: String::new(), dnames: String::new() }).unwrap();
            let tree = c.tree().unwrap();
            assert!(tree.iter().any(|n| n.path == name || n.path.starts_with(&format!("{name}/"))), "{t} made nothing at {name}");
        }
        let taken = RealName { name: "rune-probe".into(), dname: String::new(), dnames: String::new() };
        assert_eq!(c.template_new(&tmpls[0], &taken).unwrap_err(), "a page by that name exists");
        // a template that is not there: the ship answers ok and makes nothing, so only listed ones are offered
        let none = format!("rune-none-{run}");
        let _ = c.template_new("no-such-template", &RealName { name: none.clone(), dname: String::new(), dnames: String::new() });
        assert!(!c.tree().unwrap().iter().any(|n| n.path.starts_with(&none)));
        // the ship renders a Markdown page to HTML, which is what a PDF export prints
        let html = c.rendered("rune-probe").unwrap();
        assert!(html.contains("<h1") && html.contains("probe"), "{html}");
        // map tiles: a fake ship has no Mapbox token, says so, and gives no tile
        let ts = c.tile_status().unwrap();
        assert!(!ts.token && ts.max == 17 && ts.styles.contains(&"streets".to_owned()), "{ts:?}");
        assert_eq!(fetch_bytes(&c.tile_url("streets", 1, 0, 0), Some(c.cookie())).unwrap_err(), "503");
        assert_eq!(fetch_bytes(&c.tile_url("nonsense", 1, 0, 0), Some(c.cookie())).unwrap_err(), "404");
        // a token is refused by its shape, set, told of only as set, and cleared
        assert_eq!(c.map_token("not a token!").unwrap_err(), "that does not look like a Mapbox token");
        c.map_token("pk.rune-test-token_0").unwrap();
        assert!(c.tile_status().unwrap().token);
        c.map_token("").unwrap();
        assert!(!c.tile_status().unwrap().token);
        // the ship's own images come back as images, with the session
        let svg = fetch_bytes(&c.image_url("icon.svg"), Some(c.cookie())).unwrap();
        assert!(String::from_utf8_lossy(&svg).contains("<svg"), "the icon is an svg");
        let png = fetch_bytes(&c.image_url("/apps/lattice/apple-touch-icon.png"), Some(c.cookie())).unwrap();
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']), "the touch icon is a png");
        assert!(fetch_bytes(&c.image_url("no-such-image.png"), Some(c.cookie())).is_err());
        // only orrery's map is said to be kept or not, and with no orrery here it is not
        assert_eq!(c.kept("rune-probe").unwrap(), None);
        if !c.tree().unwrap().iter().any(|n| n.path == "orrery/map") {
            c.save(&Page { name: "orrery/map".into(), body: r#"{"type":"FeatureCollection","features":[]}"#.into(), kind: "geojson".into(), rev: 0 }, 0).unwrap();
        }
        assert_eq!(c.kept("orrery/map").unwrap(), Some(false));
        // a captured page is made by its first save, with no create before it
        let cap = capture_name(&today(), u64::from(std::process::id()), &|_| false);
        let made = Page { name: cap.clone(), body: "a thought\n".into(), kind: "md".into(), rev: 0 };
        c.save(&made, 0).unwrap();
        assert_eq!(c.page(&cap).unwrap().body, "a thought\n");
        assert!(c.tree().unwrap().iter().any(|n| n.page && n.path == cap));
        // a page that links to the probe is among its backlinks, once the ship has read it
        let from = format!("rune-linker-{run}");
        c.create(&from).unwrap();
        let mut linker = c.page(&from).unwrap();
        linker.body = "see [[rune-probe]]\n".into();
        c.save(&linker, linker.rev).unwrap();
        let mut back = Vec::new();
        for _ in 0..20 {
            back = c.backlinks("rune-probe").unwrap();
            if back.contains(&from) {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        assert!(back.contains(&from), "{back:?}");
        assert!(!back.contains(&"rune-probe".to_owned()));
        // asks: none wait on a lone ship, an answer to no ask is refused, and so is asking oneself
        assert_eq!(c.asks().unwrap(), Asks::default());
        assert!(c.ask_answer("~bus", "/a/page/rune-probe/code", true).unwrap_err().starts_with("404"));
        assert!(c.ask_edit(c.ship(), "/a/page/rune-probe/code", "please").unwrap_err().starts_with("400"));
        // the inbox's notices and counts answer, and marking all read leaves none unread
        let before = c.notices().unwrap();
        c.notice_read(None).unwrap();
        assert!(c.notice_read(Some("not an id")).is_err());
        assert_eq!(c.waiting().unwrap().unread, 0);
        assert!(c.notices().unwrap().iter().all(|n| n.read), "{before:?}");
        // comets' comments: open until set, held when set, and nothing held with no comet about
        assert_eq!(c.comets("rune-probe").unwrap(), "open");
        c.set_comets("rune-probe", "held").unwrap();
        assert_eq!(c.comets("rune-probe").unwrap(), "held");
        assert!(c.set_comets("rune-probe", "sometimes").is_err());
        assert!(c.held().unwrap().is_empty());
        // answering a comment that is not there comes back, whatever it says
        let _ = c.held_answer("rune-probe", "0v1.nosuch", true);
        assert!(c.held_answer("rune-probe", "0v1.nosuch", true).is_ok() == c.held_answer("rune-probe", "0v1.nosuch", false).is_ok());
        c.set_comets("rune-probe", "open").unwrap();
        c.set_comments("rune-probe", false).unwrap();
        assert!(!c.comments_on("rune-probe").unwrap());
        // the sensitive mark is set, read back and cleared, and says when the page is still shared
        assert!(!c.sensitive("rune-probe").unwrap());
        assert!(!c.set_sensitive("rune-probe", true).unwrap(), "a private page is not still shared");
        assert!(c.sensitive("rune-probe").unwrap());
        c.share("rune-probe", "clearweb").unwrap();
        assert!(c.set_sensitive("rune-probe", true).unwrap(), "its own share stands, and the answer says so");
        c.share("rune-probe", "private").unwrap();
        assert!(!c.set_sensitive("rune-probe", false).unwrap());
        assert!(!c.sensitive("rune-probe").unwrap());
        assert!(c.sensitive("no/such/page-here").is_ok_and(|on| !on) && c.set_sensitive("no/such/page-here", true).unwrap_err().starts_with("404"));
        // a name typed with capitals and spaces is kept to show, for the page and its folder
        let stamp = crate::api::since_epoch().unwrap().as_secs();
        let typed = format!("Rune Names {stamp}/My Page");
        let rn = real_name(&typed).unwrap();
        c.create_as(&rn).unwrap();
        let shown = |c: &Conn, path: &str| c.dump("").unwrap().nodes.into_iter().find(|n| n.path == path).map(|n| n.dname);
        assert_eq!(shown(&c, &rn.name), Some("My Page".into()));
        assert_eq!(shown(&c, rn.name.split('/').next().unwrap()), Some(format!("Rune Names {stamp}")), "the folder too");
        // a rename under a new typed name shows that one, and a plain path shows none
        let to = real_name(&format!("Rune Names {stamp}/Our Page")).unwrap();
        c.rename_as(&rn.name, &to).unwrap();
        assert_eq!(shown(&c, &to.name), Some("Our Page".into()));
        let plain = format!("{}/plain", to.name.split('/').next().unwrap());
        c.rename(&to.name, &plain).unwrap();
        // the name to show goes in a step of its own behind the move, on a busy ship a moment later
        for _ in 0..20 {
            if shown(&c, &plain) == Some(String::new()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        assert_eq!(shown(&c, &plain), Some(String::new()));
        // a folder's share setting is taken by the pages in it, and cleared again
        let fdir = format!("rune-shared-{}", crate::api::since_epoch().unwrap().as_secs());
        c.create(&format!("{fdir}/inside")).unwrap();
        let node = |c: &Conn, path: &str| c.dump("").unwrap().nodes.into_iter().find(|n| n.path == path).unwrap();
        c.share_dir(&fdir, "clearweb").unwrap();
        assert_eq!(node(&c, &fdir).dshare, "clearweb", "the folder says its setting");
        assert_eq!(node(&c, &format!("{fdir}/inside")).share, "clearweb", "and a page in it takes it");
        let open = ureq::get(&format!("{}inside", c.dir_address(&fdir, "clearweb").unwrap())).call().map(|r| r.status());
        assert_eq!(open.ok(), Some(200), "the page answers on the web with no session");
        c.share_dir(&fdir, "private").unwrap();
        assert_eq!((node(&c, &fdir).dshare, node(&c, &format!("{fdir}/inside")).share), (String::new(), String::new()), "private clears both");
        assert!(c.share_dir("no-such-folder-here", "shared").unwrap_err().starts_with("404"));
        // nothing is shared with a ship alone, and a ship that is not there is not read
        assert!(c.shared().unwrap().is_empty());
        let far = Shared { host: "~nec".into(), path: format!("{}/page/x/code", c.base().unwrap()), mode: "edit".into(), when: String::new() };
        assert!(c.browse(&far).unwrap_err().starts_with("504"), "an unreachable host is a 504, not a page");
        assert!(c.remote_save(&far, "text", 0).is_err(), "and a save to it is an error, not a success");
        // a banned ship is listed, cannot be granted anything, and is let back by an unban
        let _ = c.unban("~wes");
        c.ban("~wes").unwrap();
        assert!(c.bans().unwrap().contains(&"~wes".to_owned()), "a banned ship is in the list");
        assert!(c.grant("rune-probe", "~wes", false).unwrap_err().starts_with("403"), "and is refused a grant");
        assert!(c.ban("~zod").unwrap_err().starts_with("400"), "one cannot ban oneself");
        c.unban("~wes").unwrap();
        assert!(!c.bans().unwrap().contains(&"~wes".to_owned()), "an unban takes it off the list");
        // a grant to a ship is accepted, and a grant to oneself is refused. Whether
        // the access list then names the ship is not asserted: on a fake ship
        // only the first grant ever showed there (see PARITY.md), so it is printed.
        assert!(c.grant("rune-probe", "~zod", false).unwrap_err().starts_with("400"), "a grant to oneself is refused");
        if std::env::var("LATTICE_GRANT").is_ok() {
            let notified = c.grant("rune-probe", "~nec", false).unwrap();
            assert!(!notified, "a ship that is not there is not told");
            eprintln!("readers after a grant to ~nec: {:?}", readers(&c.groups().unwrap(), "rune-probe"));
        }
        assert!(c.groups().unwrap().iter().any(|g| g.name == "public"), "the access list reads");
        // create, rename, delete
        // a second dump carries only what was written since the first
        let first = c.dump("").unwrap();
        assert!(first.nodes.iter().filter(|n| n.page).all(|n| n.body.is_some()) && !first.since.is_empty(), "a first dump has every body");
        p.body.push_str("once more\n");
        c.save(&p, rev).unwrap();
        let next = c.dump(&first.since).unwrap();
        let bodies: Vec<&str> = next.nodes.iter().filter(|n| n.body.is_some()).map(|n| n.path.as_str()).collect();
        assert_eq!(bodies, ["rune-probe"], "only the page written since comes with its body");
        let has = |c: &Conn, n: &str| c.tree().unwrap().iter().any(|x| x.page && x.path == n);
        // names of their own each run: on an old kernel a deleted page's name cannot be used again
        let stamp = crate::api::since_epoch().unwrap().as_secs().to_string();
        let (made, moved) = (format!("rune-made-{stamp}"), format!("rune-moved-{stamp}/here"));
        c.create(&made).unwrap();
        assert!(has(&c, &made), "a created page is in the tree");
        assert!(c.create(&made).unwrap_err().starts_with("409"), "a taken name is refused");
        c.rename(&made, &moved).unwrap();
        assert!(has(&c, &moved) && !has(&c, &made), "a rename moves it");
        c.delete(&moved).unwrap();
        assert!(!has(&c, &moved), "a delete removes it");
        // a folder moves and goes with every page in it, by the same two calls
        let (dir, to) = (format!("rune-dir-{stamp}"), format!("rune-kept-{stamp}/dir"));
        c.create(&format!("{dir}/one")).unwrap();
        c.create(&format!("{dir}/deep/two")).unwrap();
        c.rename(&dir, &to).unwrap();
        assert!(has(&c, &format!("{to}/one")) && has(&c, &format!("{to}/deep/two")) && !has(&c, &format!("{dir}/one")), "a folder rename moves its pages");
        c.delete(&to).unwrap();
        assert!(!has(&c, &format!("{to}/one")) && !has(&c, &format!("{to}/deep/two")), "a folder delete removes them");
    }

    /// `LATTICE_URL=.. LATTICE_CODE=.. cargo test -- --ignored login`
    #[test]
    #[ignore]
    fn live_login() {
        let url = std::env::var("LATTICE_URL").unwrap();
        let c = Conn::login(&url, &std::env::var("LATTICE_CODE").unwrap()).unwrap();
        assert!(c.ship().starts_with('~') && c.tree().is_ok(), "the session opens the ship");
        assert!(Conn::login(&url, "ridlur-figbud-capmut-bidrup").is_err(), "a wrong code is refused");
    }
}
