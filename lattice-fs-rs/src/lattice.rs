//! LatticeProjection: the one lattice-specific file. Maps the projection seam
//! onto the nexus routes (page-tree/page-source/page-save/folder-new/page-del,
//! err via /x/…/err?data), the kind<->ext table, and the empty-body seed.

use crate::projection::{Node, PErr, Projection};
use crate::transport::Transport;

pub const APP: &str = "lattice.lattice_app";

pub struct LatticeProjection {
    t: Box<dyn Transport>,
    ship: String,
}

impl LatticeProjection {
    pub fn new(t: Box<dyn Transport>) -> Result<Self, PErr> {
        let ship = t.ship()?;
        Ok(Self { t, ship })
    }

    pub fn ship(&self) -> &str {
        &self.ship
    }
}

impl Projection for LatticeProjection {
    fn list(&self) -> Result<Vec<Node>, PErr> {
        let v = self.t.get_json("/apps/lattice/page-tree", &[])?;
        let nodes = v
            .get("nodes")
            .and_then(|n| n.as_array())
            .ok_or_else(|| PErr::new(libc::EIO, "page-tree: no nodes"))?;
        let mut out = Vec::with_capacity(nodes.len());
        for n in nodes {
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
            let size = n.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
            let mtime = da_to_unix(n.get("mtime").and_then(|m| m.as_str()).unwrap_or(""));
            let readonly = kind == "index";
            out.push(Node { rel, is_dir: false, is_page: true, kind, size, mtime, readonly });
        }
        Ok(out)
    }

    fn read(&self, rel: &str) -> Result<Vec<u8>, PErr> {
        let v = self.t.get_json("/apps/lattice/page-source", &[("name", rel)])?;
        let body = v
            .get("body")
            .and_then(|b| b.as_str())
            .ok_or_else(|| PErr::new(libc::EIO, "page-source: no body"))?;
        Ok(body.as_bytes().to_vec())
    }

    fn errors(&self, rel: &str) -> Result<String, PErr> {
        // read the err grub via the generic /x/ proxy (?data), as the web editor
        // does. '' = clean; a missing err grub (page never ran) reads as clean.
        let path = format!("/apps/lattice/x/{}/apps/{}/page/{}/err", self.ship, APP, rel);
        match self.t.get_bytes(&path, &[("data", "")]) {
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
        let mut q: Vec<(&str, &str)> = vec![("name", rel), ("type", ptype)];
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
        self.t.post("/apps/lattice/folder-new", &[("name", rel)], b"")?;
        Ok(())
    }

    fn delete(&self, rel: &str) -> Result<(), PErr> {
        self.t.post("/apps/lattice/page-del", &[("name", rel)], b"")?;
        Ok(())
    }

    fn mv(&self, src: &str, dst: &str) -> Result<(), PErr> {
        // no server rename: read source + create dst + delete src.
        let v = self.t.get_json("/apps/lattice/page-source", &[("name", src)])?;
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
