//! LatticeProjection: the one lattice-specific file. Maps the projection seam
//! onto the nexus routes (page-tree/page-source/page-save/folder-new/page-del,
//! err via /x/…/err?data), the kind<->ext table, and the empty-body seed.

use std::collections::HashMap;

use serde_json::Value;

use crate::projection::{Node, PErr, Projection};
use crate::transport::Transport;

pub struct LatticeProjection {
    t: Box<dyn Transport>,
    ship: String,
    root: String, // sub-root under /page ("" = whole tree, "notes" = mount /page/notes)
}

impl LatticeProjection {
    pub fn new(t: Box<dyn Transport>, root: &str) -> Result<Self, PErr> {
        let ship = t.ship()?;
        Ok(Self { t, ship, root: root.trim_matches('/').to_string() })
    }

    /// A client-visible rel -> the server-side page name (root-prefixed).
    fn full(&self, rel: &str) -> String {
        if self.root.is_empty() {
            rel.to_string()
        } else if rel.is_empty() {
            self.root.clone()
        } else {
            format!("{}/{}", self.root, rel)
        }
    }

    /// A server-side page path -> the client-visible rel, or None if it's outside
    /// the mounted sub-root. The sub-root dir itself maps to "" (the mount root).
    fn strip(&self, path: &str) -> Option<String> {
        if self.root.is_empty() {
            return Some(path.to_string());
        }
        if path == self.root {
            return Some(String::new());
        }
        path.strip_prefix(&format!("{}/", self.root)).map(str::to_string)
    }

    /// Filter a full-tree dump down to the mounted sub-root, stripping the prefix
    /// from both node rels and body keys. No-op when the whole tree is mounted.
    fn remap_dump(
        &self,
        nodes: Vec<Node>,
        bodies: HashMap<String, Vec<u8>>,
    ) -> (Vec<Node>, HashMap<String, Vec<u8>>) {
        if self.root.is_empty() {
            return (nodes, bodies);
        }
        let mut on = Vec::new();
        let mut ob = HashMap::new();
        for n in nodes {
            match self.strip(&n.rel) {
                Some(rel) if !rel.is_empty() => {
                    if let Some(b) = bodies.get(&n.rel) {
                        ob.insert(rel.clone(), b.clone());
                    }
                    on.push(Node { rel, ..n });
                }
                _ => {}
            }
        }
        (on, ob)
    }
}

impl Projection for LatticeProjection {
    fn ship(&self) -> String {
        self.ship.clone()
    }

    fn list(&self) -> Result<Vec<Node>, PErr> {
        let v = self.t.get_json("/apps/lattice/page-tree", &[])?;
        let nodes = v
            .get("nodes")
            .and_then(|n| n.as_array())
            .ok_or_else(|| PErr::new(libc::EIO, "page-tree: no nodes"))?;
        let mut out = Vec::with_capacity(nodes.len());
        for n in nodes {
            let path = n.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string();
            // keep only nodes under the mounted sub-root, with the prefix stripped
            let rel = match self.strip(&path) {
                Some(r) if !r.is_empty() => r,
                _ => continue,
            };
            let is_page = n.get("page").and_then(|p| p.as_bool()).unwrap_or(false);
            if !is_page {
                out.push(Node {
                    rel,
                    is_dir: true,
                    is_page: false,
                    kind: String::new(),
                    size: 0,
                    mtime: now(),
                    readonly: false,
                });
                continue;
            }
            let kind = n.get("kind").and_then(|k| k.as_str()).unwrap_or("hoon").to_string();
            let size = n.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
            let mtime = da_to_unix(n.get("mtime").and_then(|m| m.as_str()).unwrap_or(""));
            let readonly = kind == "index";
            out.push(Node { rel, is_dir: false, is_page: true, kind, size, mtime, readonly });
        }
        Ok(out)
    }

    fn read(&self, rel: &str) -> Result<Vec<u8>, PErr> {
        let name = self.full(rel);
        let v = self.t.get_json("/apps/lattice/page-source", &[("name", &name)])?;
        let body = v
            .get("body")
            .and_then(|b| b.as_str())
            .ok_or_else(|| PErr::new(libc::EIO, "page-source: no body"))?;
        Ok(body.as_bytes().to_vec())
    }

    fn dump(&self) -> Result<(Vec<Node>, HashMap<String, Vec<u8>>), PErr> {
        let v = match self.t.get_json("/apps/lattice/page-dump", &[]) {
            Ok(v) => v,
            // old nexus without the route -> fall back to list()+read() (N+1).
            Err(e) if e.code == 404 => {
                let nodes = self.list()?;
                let mut bodies = HashMap::new();
                for n in &nodes {
                    if n.is_page {
                        if let Ok(b) = self.read(&n.rel) {
                            bodies.insert(n.rel.clone(), b);
                        }
                    }
                }
                return Ok((nodes, bodies));
            }
            Err(e) => return Err(e.into()),
        };
        let (nodes, bodies) = parse_dump(&v)?;
        Ok(self.remap_dump(nodes, bodies))
    }

    fn errors(&self, rel: &str) -> Result<String, PErr> {
        // page-errors returns the err grub text (plain text), '' = clean or no
        // such page. Symmetric across transports (Eyre and lick both hit it).
        let name = self.full(rel);
        match self.t.get_bytes("/apps/lattice/page-errors", &[("name", &name)]) {
            Ok(b) => Ok(String::from_utf8_lossy(&b).trim().to_string()),
            Err(e) if e.code == 404 => Ok(String::new()),
            Err(e) => Err(e.into()),
        }
    }

    fn write(&self, rel: &str, kind: &str, data: &[u8], create: bool) -> Result<(), PErr> {
        let ptype = match kind {
            "index" => "index",
            "md" | "gmi" | "html" | "text" | "js" | "css" => kind,
            _ => "hoon",
        };
        let name = self.full(rel);
        let mut q: Vec<(&str, &str)> = vec![("name", &name), ("type", ptype)];
        let mut body = data.to_vec();
        if create {
            q.push(("new", "1"));
            // page-save 400s on an empty body for non-index kinds; seed a newline
            // (the editor overwrites it on the real flush).
            if kind != "index" && body.is_empty() {
                body = b"\n".to_vec();
            }
        }
        self.t.post("/apps/lattice/page-save", &q, &body)?;
        Ok(())
    }

    fn mkdir(&self, rel: &str) -> Result<(), PErr> {
        self.t.post("/apps/lattice/folder-new", &[("name", &self.full(rel))], b"")?;
        Ok(())
    }

    fn delete(&self, rel: &str) -> Result<(), PErr> {
        self.t.post("/apps/lattice/page-del", &[("name", &self.full(rel))], b"")?;
        Ok(())
    }

    fn mv(&self, src: &str, dst: &str) -> Result<(), PErr> {
        // no server rename: read source + create dst + delete src.
        let v = self.t.get_json("/apps/lattice/page-source", &[("name", &self.full(src))])?;
        let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("hoon").to_string();
        let body = v
            .get("body")
            .and_then(|b| b.as_str())
            .unwrap_or("")
            .as_bytes()
            .to_vec();
        self.write(dst, &kind, &body, true)?;
        self.delete(src)?;
        Ok(())
    }

    fn watch(&self, on_change: &(dyn Fn() + Send + Sync)) {
        self.t.watch(on_change);
    }
}

/// Parse a page-dump response into (nodes, bodies). `size` is derived from the
/// actual body bytes, never the reported `size` field, so FUSE st_size can never
/// disagree with what read() returns (a wrong server size would short/over-read).
fn parse_dump(v: &Value) -> Result<(Vec<Node>, HashMap<String, Vec<u8>>), PErr> {
    let arr = v
        .get("nodes")
        .and_then(|n| n.as_array())
        .ok_or_else(|| PErr::new(libc::EIO, "page-dump: no nodes"))?;
    let mut out = Vec::with_capacity(arr.len());
    let mut bodies = HashMap::new();
    for n in arr {
        let rel = n.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string();
        let is_page = n.get("page").and_then(|p| p.as_bool()).unwrap_or(false);
        if !is_page {
            out.push(Node {
                rel,
                is_dir: true,
                is_page: false,
                kind: String::new(),
                size: 0,
                mtime: now(),
                readonly: false,
            });
            continue;
        }
        let kind = n.get("kind").and_then(|k| k.as_str()).unwrap_or("hoon").to_string();
        let mtime = da_to_unix(n.get("mtime").and_then(|m| m.as_str()).unwrap_or(""));
        let readonly = kind == "index";
        // A present `body` is inlined: cache it, and derive size from the actual
        // bytes (the st_size guard). A missing `body` means the server omitted an
        // oversized page (dump-inline-max) — don't cache it (body() reads it on
        // demand), and trust the reported `size`, like list() already does.
        let size = match n.get("body").and_then(|b| b.as_str()) {
            Some(s) => {
                let body = s.as_bytes().to_vec();
                let sz = body.len() as u64;
                bodies.insert(rel.clone(), body);
                sz
            }
            None => n.get("size").and_then(|s| s.as_u64()).unwrap_or(0),
        };
        out.push(Node { rel, is_dir: false, is_page: true, kind, size, mtime, readonly });
    }
    Ok((out, bodies))
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Parse an Urbit `@da` string '~2026.7.22..18.30.00..cafe' -> unix seconds
/// (UTC). Whole-second precision; the sub-second `..hex` fraction is dropped.
/// Date-only '~2026.7.20' -> midnight UTC. Anything unparseable -> now.
fn da_to_unix(da: &str) -> i64 {
    let s = match da.strip_prefix('~') {
        Some(s) => s,
        None => return now(),
    };
    let (date, rest) = match s.split_once("..") {
        Some((d, r)) => (d, r),
        None => (s, ""),
    };
    let dp: Vec<&str> = date.split('.').collect();
    if dp.len() < 3 {
        return now();
    }
    let y: i32 = match dp[0].parse() {
        Ok(v) => v,
        Err(_) => return now(),
    };
    let mo: u32 = dp[1].parse().unwrap_or(1);
    let d: u32 = dp[2].parse().unwrap_or(1);
    let tod = rest.split("..").next().unwrap_or("");
    let tp: Vec<&str> = if tod.is_empty() { vec![] } else { tod.split('.').collect() };
    let hh: i64 = tp.first().and_then(|x| x.parse().ok()).unwrap_or(0);
    let mm: i64 = tp.get(1).and_then(|x| x.parse().ok()).unwrap_or(0);
    let ss: i64 = tp.get(2).and_then(|x| x.parse().ok()).unwrap_or(0);
    days_from_civil(y, mo, d) * 86400 + hh * 3600 + mm * 60 + ss
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// algorithm) — avoids a chrono dependency for one conversion.
fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400; // [0, 399]
    let m = m as i64;
    let d = d as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dump_size_from_bytes() {
        // a folder node + a page node whose reported "size" LIES (999); the parsed
        // size must equal the real body byte length, and the body must round-trip.
        let v = serde_json::json!({"nodes": [
            {"path": "a/b", "page": false},
            {"path": "note", "page": true, "kind": "md", "mtime": "~2026.7.20",
             "body": "# hi\nhello", "size": 999},
        ]});
        let (nodes, bodies) = parse_dump(&v).unwrap();
        assert_eq!(nodes.len(), 2);
        let dir = nodes.iter().find(|n| n.rel == "a/b").unwrap();
        assert!(dir.is_dir && !dir.is_page);
        let page = nodes.iter().find(|n| n.rel == "note").unwrap();
        assert!(page.is_page && !page.is_dir);
        assert_eq!(bodies["note"], b"# hi\nhello");
        assert_eq!(page.size, bodies["note"].len() as u64); // NOT 999
    }

    #[test]
    fn dump_omitted_body_not_cached() {
        // an oversized page the server omitted: no "body" field, only "size".
        // it must NOT be cached (body() reads it on demand), and its Node.size
        // must come from the reported field (there are no bytes to measure).
        let v = serde_json::json!({"nodes": [
            {"path": "small", "page": true, "kind": "md", "mtime": "~2026.7.20",
             "body": "hi", "size": 2},
            {"path": "big", "page": true, "kind": "md", "mtime": "~2026.7.20",
             "size": 500000}, // no "body" — omitted by dump-inline-max
        ]});
        let (nodes, bodies) = parse_dump(&v).unwrap();
        assert!(bodies.contains_key("small")); // small inlined + cached
        assert!(!bodies.contains_key("big")); // large omitted -> lazy read
        let big = nodes.iter().find(|n| n.rel == "big").unwrap();
        assert!(big.is_page);
        assert_eq!(big.size, 500000); // trusts the reported size
    }

    #[test]
    fn da_full_form() {
        // ~2026.7.22..19.14.23 -> 1784747663 (verified against the live nexus)
        assert_eq!(da_to_unix("~2026.7.22..19.14.23"), 1784747663);
    }

    #[test]
    fn da_date_only_is_midnight() {
        assert_eq!(da_to_unix("~2026.7.20"), 1784505600);
    }

    #[test]
    fn da_fraction_ignored() {
        assert_eq!(
            da_to_unix("~2026.7.22..19.14.23..7942"),
            da_to_unix("~2026.7.22..19.14.23")
        );
    }

    #[test]
    fn civil_epoch() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 1, 1), 10957);
    }
}
