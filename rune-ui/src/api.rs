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
        let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
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

/// Writes a file only its owner reads, whole or not at all: beside it first, then moved into place.
fn write_private(p: &std::path::Path, body: &[u8]) -> Result<(), String> {
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
}

impl Prefs {
    fn path() -> Option<std::path::PathBuf> {
        Some(session_path()?.with_file_name("prefs.json"))
    }

    /// The kept preferences, or the defaults when there are none or they do not read.
    pub fn load() -> Prefs {
        Prefs::path().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    /// Keeps them. A failure is not worth a message: they are a convenience.
    pub fn save(&self) {
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
        let req = ureq::request(method, &format!("{}/apps/lattice/{path}", self.url))
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

    /// Every node, with the bodies written since `since` (all of them when
    /// it is empty). One deep read on the ship, as the web client makes.
    pub fn dump(&self, since: &str) -> Result<Dump, String> {
        let q = if since.is_empty() { "page-dump".to_owned() } else { format!("page-dump?since={}", enc(since)) };
        serde_json::from_str(&self.call("GET", &q, None)?).map_err(|e| e.to_string())
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
        let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(30)).build();
        match agent.post(&format!("{}/apps/lattice/forum-notes/clear", self.url)).set("cookie", &self.cookie).set("origin", &self.url).send_string("") {
            Ok(_) => Ok(()),
            Err(ureq::Error::Status(code, _)) if (300..400).contains(&code) => Ok(()),
            Err(ureq::Error::Status(code, r)) => Err(format!("{code}: {}", r.into_string().unwrap_or_default())),
            Err(e) => Err(e.to_string()),
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
        let back: Prefs = serde_json::from_str(&serde_json::to_string(&Prefs { theme: "light".into(), last: "a/b".into(), no_autosave: true, recent: vec!["a/b".into()], used: vec!["edit".into()], tabs: vec!["a/b".into(), String::new()], tab: 1, split: "c".into(), outside: vec!["a/b".into()], core_seen: vec!["a".into()] }).unwrap()).unwrap();
        assert_eq!((back.theme.as_str(), back.last.as_str()), ("light", "a/b"));
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
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
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
        let name = format!("made-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
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
    fn pruning_is_checked_before_it_is_sent() {
        assert_eq!(prune_rule(" 0 ", "1"), Ok((0, 1)));
        assert!(prune_rule("-1", "3").is_err() && prune_rule("2", "0").is_err() && prune_rule("2", "").is_err() && prune_rule("x", "3").is_err());
    }

    /// A board's moderation against a ship: roles, sidebar, pruning, comets and invitations.
    #[test]
    #[ignore]
    fn live_forum_mod() {
        let c = Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let name = format!("mod-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
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
        let name = format!("away-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
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
        let key = format!("/rune/probe-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
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
        let gname = format!("rune{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
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
        let run = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
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
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
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
        let fdir = format!("rune-shared-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
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
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs().to_string();
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
