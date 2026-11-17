//! The ship's HTTP API, as the web client calls it. Every call blocks, so
//! each runs on a `rune::Latest` worker and never on the UI thread.

use serde::Deserialize;
use std::time::Duration;

/// Where the ship is and the session cookie that opens it.
#[derive(Clone, Default)]
pub struct Conn {
    pub url: String,
    pub cookie: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Node {
    pub path: String,
    #[serde(default)]
    pub page: bool,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub rev: u64,
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

#[derive(Deserialize)]
struct Tree {
    nodes: Vec<Node>,
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
        let req = ureq::request(method, &format!("{}/apps/lattice/{path}", self.url))
            .timeout(Duration::from_secs(30))
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

    pub fn tree(&self) -> Result<Vec<Node>, String> {
        let t: Tree = serde_json::from_str(&self.call("GET", "page-tree", None)?).map_err(|e| e.to_string())?;
        Ok(t.nodes)
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
    fn a_tree_and_a_page_parse_as_the_ship_writes_them() {
        let t: Tree = serde_json::from_str(r#"{"nodes":[{"path":"a/b","page":true,"kind":"md","rev":3,"size":9},{"path":"a","page":false}],"since":"x"}"#).unwrap();
        assert_eq!((t.nodes.len(), t.nodes[0].rev, t.nodes[1].page), (2, 3, false));
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
        // create, rename, delete
        let has = |c: &Conn, n: &str| c.tree().unwrap().iter().any(|x| x.page && x.path == n);
        let _ = c.delete("rune-made");
        let _ = c.delete("rune-moved/here");
        c.create("rune-made").unwrap();
        assert!(has(&c, "rune-made"), "a created page is in the tree");
        assert!(c.create("rune-made").unwrap_err().starts_with("409"), "a taken name is refused");
        c.rename("rune-made", "rune-moved/here").unwrap();
        assert!(has(&c, "rune-moved/here") && !has(&c, "rune-made"), "a rename moves it");
        c.delete("rune-moved/here").unwrap();
        assert!(!has(&c, "rune-moved/here"), "a delete removes it");
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
