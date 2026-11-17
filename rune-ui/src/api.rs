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

#[derive(Clone, Debug, Default, Deserialize)]
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
#[derive(Debug, Default, Deserialize)]
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

/// What the window remembers between runs, beside the session.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct Prefs {
    /// `dark`, `light`, or anything else for the system's.
    #[serde(default)]
    pub theme: String,
    /// The page that was open, to open again.
    #[serde(default)]
    pub last: String,
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

    /// The next theme in the round: system, dark, light.
    pub fn next_theme(&self) -> &'static str {
        match self.theme.as_str() {
            "dark" => "light",
            "light" => "system",
            _ => "dark",
        }
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

    pub fn know_delete(&self, key: &str) -> Result<(), String> {
        self.call("POST", &format!("know-delete?key={}", enc(key)), Some("")).map(drop)
    }

    /// Sets who may read a page: `private`, `shared` (ships over Urbit) or
    /// `clearweb` (anyone with the link).
    pub fn share(&self, name: &str, mode: &str) -> Result<(), String> {
        let q = if mode == "private" { format!("page-share-clear?name={}", enc(name)) } else { format!("page-share?name={}&mode={}", enc(name), enc(mode)) };
        self.call("POST", &q, Some("")).map(drop)
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
        let title = name.rsplit('/').next().unwrap_or(name);
        self.call("POST", &format!("page-save?name={}&type=md&new=1&by=rune", enc(name)), Some(&format!("# {title}\n"))).map(drop)
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        self.call("POST", &format!("page-move?from={}&to={}&dname=", enc(from), enc(to)), Some("")).map(drop)
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
        let back: Prefs = serde_json::from_str(&serde_json::to_string(&Prefs { theme: "light".into(), last: "a/b".into() }).unwrap()).unwrap();
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
        assert_eq!(ship_list("nec Bad").unwrap_err(), "Bad is not a ship's name");
        assert!(ship_list("").unwrap().is_empty());
        assert!(group_name_ok("team-2") && !group_name_ok("Team") && !group_name_ok("2team") && !group_name_ok("") && !group_name_ok("a b"));
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
        // a memory is written, listed with its text, and deleted. The ship
        // may refuse a key whose deleted memory is still in the trash, so
        // each run uses its own.
        let key = format!("/rune/probe-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
        c.know_save(&key, "a fact\n").unwrap();
        let all = c.know_all().unwrap();
        let got = all.iter().find(|k| k.key == key).expect("the memory is listed");
        assert_eq!(got.body.trim(), "a fact");
        c.know_delete(&key).unwrap();
        assert!(!c.know_all().unwrap().iter().any(|k| k.key == key), "and gone after a delete");
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
        let stamp = key.rsplit('-').next().unwrap().to_owned();
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
