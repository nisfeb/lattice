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

impl Conn {
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
        let base = p.rev;
        p.body = format!("# probe\n\nsaved at rev {base}\n");
        let rev = c.save(&p, base).unwrap();
        assert!(rev > base, "a save moves the rev: {base} -> {rev}");
        assert_eq!(c.page("rune-probe").unwrap().body, p.body, "and reads back");
        // the same text again is no conflict: the ship takes it as already landed
        p.body.push_str("another edit\n");
        assert!(c.save(&p, base).unwrap_err().starts_with("409"), "a stale base is refused");
    }
}
