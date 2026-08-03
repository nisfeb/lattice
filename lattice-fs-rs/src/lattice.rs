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
            // page-save 400s on an empty body for non-index kinds. Seed a newline
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
        // no server rename: read source + save dst + delete src. create=false:
        // page-save without new=1 creates OR overwrites, giving POSIX clobber
        // semantics (create=true would 409 when the destination exists).
        let v = self.t.get_json("/apps/lattice/page-source", &[("name", &self.full(src))])?;
        let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("hoon").to_string();
        let body = v
            .get("body")
            .and_then(|b| b.as_str())
            .unwrap_or("")
            .as_bytes()
            .to_vec();
        self.write(dst, &kind, &body, false)?;
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
    let mut out: Vec<Node> = Vec::with_capacity(arr.len());
    let mut bodies = HashMap::new();
    let mut at: HashMap<String, usize> = HashMap::new(); // rel -> its index in `out`
    for n in arr {
        let rel = n.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string();
        // One rel, one node. `bodies` is keyed by rel and keeps the last writer,
        // so the node list has to as well: two nodes sharing a rel leaves FUSE's
        // st_size describing one of them and read() returning the other's bytes,
        // and every cat of that page short-reads. A repeated (or absent, which
        // reads as "") path is malformed input, but it comes off the wire.
        bodies.remove(&rel);
        let is_page = n.get("page").and_then(|p| p.as_bool()).unwrap_or(false);
        let node = if !is_page {
            Node {
                rel: rel.clone(),
                is_dir: true,
                is_page: false,
                kind: String::new(),
                size: 0,
                mtime: now(),
                readonly: false,
            }
        } else {
            let kind = n.get("kind").and_then(|k| k.as_str()).unwrap_or("hoon").to_string();
            let mtime = da_to_unix(n.get("mtime").and_then(|m| m.as_str()).unwrap_or(""));
            let readonly = kind == "index";
            // A present `body` is inlined. Cache it, and derive size from the actual
            // bytes (the st_size guard). A missing `body` means the server omitted an
            // oversized page (dump-inline-max). Don't cache it (body() reads it on
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
            Node { rel: rel.clone(), is_dir: false, is_page: true, kind, size, mtime, readonly }
        };
        match at.get(&rel) {
            Some(&i) => out[i] = node,
            None => {
                at.insert(rel, out.len());
                out.push(node);
            }
        }
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
/// (UTC). Whole-second precision. The sub-second `..hex` fraction is dropped.
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
    // saturating: the fields come off the wire, and an absurd one (an hour
    // field near i64::MAX) must clamp, not overflow (a panic in debug builds)
    days_from_civil(y, mo, d)
        .saturating_mul(86400)
        .saturating_add(hh.saturating_mul(3600))
        .saturating_add(mm.saturating_mul(60))
        .saturating_add(ss)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// algorithm). Avoids a chrono dependency for one conversion.
fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    // widen BEFORE the March-shift: y comes off the wire, and i32::MIN - 1
    // overflows i32 (a panic in debug builds)
    let y = if m <= 2 { y as i64 - 1 } else { y as i64 };
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
        // a folder node + a page node whose reported "size" LIES (999). The parsed
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
             "size": 500000}, // no "body", omitted by dump-inline-max
        ]});
        let (nodes, bodies) = parse_dump(&v).unwrap();
        assert!(bodies.contains_key("small")); // small inlined + cached
        assert!(!bodies.contains_key("big")); // large omitted -> lazy read
        let big = nodes.iter().find(|n| n.rel == "big").unwrap();
        assert!(big.is_page);
        assert_eq!(big.size, 500000); // trusts the reported size
    }

    #[test]
    fn dump_keeps_exactly_one_node_per_path() {
        // duplicate (or absent) paths are malformed, but they arrive off the
        // wire. Two nodes sharing a rel leaves st_size describing one of them
        // while read() returns the other's bytes, and that page short-reads.
        let v = serde_json::json!({"nodes": [
            {"path": "x", "page": true, "kind": "md", "body": "aa"},
            {"path": "x", "page": true, "kind": "md", "body": "bbbb"},
            {"path": "y", "page": true, "kind": "md", "body": "cc"},
            {"path": "y", "page": false},
        ]});
        let (nodes, bodies) = parse_dump(&v).unwrap();
        assert_eq!(nodes.len(), 2, "one node per path");
        let n = |r: &str| nodes.iter().find(|n| n.rel == r).unwrap();
        assert_eq!(n("x").size, 4);
        assert_eq!(bodies["x"], b"bbbb", "the last writer owns both the node and the body");
        // a page shadowed by a later folder must not leave its body behind
        assert!(n("y").is_dir);
        assert!(!bodies.contains_key("y"));
        for (rel, b) in &bodies {
            assert_eq!(n(rel).size, b.len() as u64, "{rel}: st_size must match the bytes");
        }
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

    #[test]
    fn da_extreme_fields_do_not_overflow() {
        // each of these panicked (arithmetic overflow) before the saturating fix
        let _ = da_to_unix("~2026.7.22..9223372036854775807.0.0");
        let _ = da_to_unix("~-2147483648.1.1"); // i32::MIN year, March-shift y-1
        let _ = da_to_unix("~2147483647.12.31..23.59.9223372036854775807");
    }

    // ---------- property tests ----------

    use proptest::prelude::*;
    use crate::transport::{TErr, Transport};

    /// A transport that answers ship() and nothing else: strip/full are pure.
    struct NullT;
    impl Transport for NullT {
        fn get_bytes(&self, _: &str, _: &[(&str, &str)]) -> Result<Vec<u8>, TErr> {
            Err(TErr::new(0, "null transport"))
        }
        fn post(&self, _: &str, _: &[(&str, &str)], _: &[u8]) -> Result<Vec<u8>, TErr> {
            Err(TErr::new(0, "null transport"))
        }
        fn ship(&self) -> Result<String, TErr> {
            Ok("~test".into())
        }
    }

    /// Hinnant's civil_from_days, the inverse of days_from_civil, so the
    /// roundtrip law can be checked without trusting the code under test.
    fn civil_from_days(z: i64) -> (i32, u32, u32) {
        let z = z + 719468;
        let era = if z >= 0 { z } else { z - 146096 } / 146097;
        let doe = z - era * 146097;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
        ((if m <= 2 { y + 1 } else { y }) as i32, m, d)
    }

    /// JSON that looks like (broken) ship output: the parser's own vocabulary
    /// with wrong types, missing fields, and junk at every level.
    fn dumpish_json() -> impl Strategy<Value = Value> {
        let leaf = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::Bool),
            any::<i64>().prop_map(|n| serde_json::json!(n)),
            "[ -~]{0,12}".prop_map(Value::String),
        ];
        leaf.prop_recursive(4, 48, 4, |inner| {
            let key = proptest::sample::select(vec![
                "nodes", "path", "page", "kind", "mtime", "body", "size", "junk",
            ]);
            prop_oneof![
                proptest::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
                proptest::collection::hash_map(key, inner, 0..5)
                    .prop_map(|m| Value::Object(m.into_iter().map(|(k, v)| (k.to_string(), v)).collect())),
            ]
        })
    }

    proptest! {
        // a ship's mtime string is wire data: any string at all must parse to
        // SOME i64, never panic (overflow was a real panic in debug builds)
        #[test]
        fn da_is_total(s in ".*") {
            let _ = da_to_unix(&s);
        }

        #[test]
        fn da_is_total_on_numeric_extremes(
            y in any::<i64>(), mo in any::<i64>(), d in any::<i64>(),
            hh in any::<i64>(), mm in any::<i64>(), ss in any::<i64>(),
        ) {
            let _ = da_to_unix(&format!("~{y}.{mo}.{d}..{hh}.{mm}.{ss}"));
            let _ = da_to_unix(&format!("~{y}.{mo}.{d}"));
        }

        // the calendar roundtrip law over ±~2.7 millennia of days
        #[test]
        fn civil_days_roundtrip(days in -1_000_000i64..1_000_000) {
            let (y, m, d) = civil_from_days(days);
            prop_assert_eq!(days_from_civil(y, m, d), days);
        }

        // parse_dump consumes network JSON: total over arbitrary shapes, and
        // when it accepts, every cached body's node size equals its byte length
        #[test]
        fn parse_dump_is_total_and_sizes_match(v in dumpish_json()) {
            if let Ok((nodes, bodies)) = parse_dump(&v) {
                for (rel, body) in &bodies {
                    let n = nodes.iter().find(|n| &n.rel == rel);
                    prop_assert!(n.is_some(), "body {rel} without a node");
                    prop_assert_eq!(n.unwrap().size, body.len() as u64);
                }
            }
        }

        // sub-root mapping law: what full() prefixes, strip() removes
        #[test]
        fn strip_inverts_full(root in "[a-z0-9/]{0,12}", rel in "[a-z0-9/]{0,12}") {
            let p = LatticeProjection::new(Box::new(NullT), &root).unwrap();
            prop_assert_eq!(p.strip(&p.full(&rel)), Some(rel));
        }

        // and a path outside the sub-root never maps in
        #[test]
        fn strip_rejects_outside_paths(root in "[a-z0-9]{1,8}", path in "[a-z0-9/]{0,12}") {
            let p = LatticeProjection::new(Box::new(NullT), &root).unwrap();
            let inside = path == root || path.starts_with(&format!("{root}/"));
            prop_assert_eq!(p.strip(&path).is_some(), inside);
        }
    }

    // ---------- the nexus routes, over a scripted transport ----------

    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct RecInner {
        script: Mutex<VecDeque<Result<Vec<u8>, TErr>>>,
        log: Mutex<Vec<String>>,
    }

    #[derive(Clone, Default)]
    struct Rec(Arc<RecInner>);

    fn ok(s: &str) -> Result<Vec<u8>, TErr> {
        Ok(s.as_bytes().to_vec())
    }
    fn bad(code: u16) -> Result<Vec<u8>, TErr> {
        Err(TErr::new(code, "scripted failure"))
    }

    impl Rec {
        fn next(&self, entry: String) -> Result<Vec<u8>, TErr> {
            self.0.log.lock().unwrap().push(entry);
            self.0
                .script
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err(TErr::new(599, "script exhausted")))
        }
        fn log(&self) -> Vec<String> {
            self.0.log.lock().unwrap().clone()
        }
    }

    fn qs(query: &[(&str, &str)]) -> String {
        query.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&")
    }

    impl Transport for Rec {
        fn get_bytes(&self, path: &str, query: &[(&str, &str)]) -> Result<Vec<u8>, TErr> {
            self.next(format!("GET {path}?{}", qs(query)))
        }
        fn post(&self, path: &str, query: &[(&str, &str)], body: &[u8]) -> Result<Vec<u8>, TErr> {
            self.next(format!(
                "POST {path}?{} {:?}",
                qs(query),
                String::from_utf8_lossy(body)
            ))
        }
        fn ship(&self) -> Result<String, TErr> {
            Ok("~test".into())
        }
        fn watch(&self, on_change: &(dyn Fn() + Send + Sync)) {
            on_change();
        }
    }

    fn lp(root: &str, script: Vec<Result<Vec<u8>, TErr>>) -> (Rec, LatticeProjection) {
        let rec = Rec::default();
        *rec.0.script.lock().unwrap() = script.into();
        let p = LatticeProjection::new(Box::new(rec.clone()), root).unwrap();
        (rec, p)
    }

    #[test]
    fn write_maps_kind_to_page_type_and_seeds_only_a_new_empty_body() {
        // the `type` decides the mark the page is stored under. A wrong one
        // stores markdown as hoon (or worse, clobbers a generated %index).
        let (rec, p) = lp("", (0..5).map(|_| ok("{}")).collect());
        p.write("n", "md", b"hi", false).unwrap();
        p.write("n", "index", b"", true).unwrap();
        p.write("n", "md", b"", true).unwrap();
        p.write("n", "md", b"hi", true).unwrap();
        p.write("n", "bespoke", b"x", false).unwrap();
        assert_eq!(
            rec.log(),
            vec![
                r#"POST /apps/lattice/page-save?name=n&type=md "hi""#,
                // %index accepts an empty body; it must NOT be seeded
                r#"POST /apps/lattice/page-save?name=n&type=index&new=1 """#,
                // page-save 400s on an empty body for every other kind, so a
                // brand-new page is seeded with a newline
                r#"POST /apps/lattice/page-save?name=n&type=md&new=1 "\n""#,
                // ...but only when it IS empty. Never overwrite real content.
                r#"POST /apps/lattice/page-save?name=n&type=md&new=1 "hi""#,
                r#"POST /apps/lattice/page-save?name=n&type=hoon "x""#,
            ]
        );
    }

    #[test]
    fn mv_saves_the_destination_before_deleting_the_source() {
        // there is no server rename. Ordering IS the safety property: save
        // first, delete second. Reversed (or a skipped save) loses the page.
        let (rec, p) = lp("", vec![ok(r#"{"body":"content","kind":"gmi"}"#), ok("{}"), ok("{}")]);
        p.mv("a", "b").unwrap();
        let log = rec.log();
        assert_eq!(log.len(), 3);
        assert_eq!(log[0], "GET /apps/lattice/page-source?name=a");
        assert_eq!(log[1], r#"POST /apps/lattice/page-save?name=b&type=gmi "content""#);
        assert!(!log[1].contains("new=1"), "a move must clobber the destination, not 409");
        assert_eq!(log[2], r#"POST /apps/lattice/page-del?name=a """#);
    }

    #[test]
    fn errors_treats_a_missing_page_as_clean_but_not_a_real_failure() {
        let (_, p) = lp("", vec![ok("  boom: syntax\n")]);
        assert_eq!(p.errors("n").unwrap(), "boom: syntax");
        let (_, p) = lp("", vec![bad(404)]);
        assert_eq!(p.errors("n").unwrap(), "", "no such page = clean, not an error");
        let (_, p) = lp("", vec![bad(500)]);
        assert!(p.errors("n").is_err(), "a real failure must not be reported as clean");
    }

    #[test]
    fn dump_falls_back_to_list_and_read_only_when_the_route_is_missing() {
        let tree = r#"{"nodes":[{"path":"n","page":true,"kind":"md","size":2,"mtime":"~2026.7.20"}]}"#;
        let (rec, p) = lp("", vec![bad(404), ok(tree), ok(r#"{"body":"hi","kind":"md"}"#)]);
        let (nodes, bodies) = p.dump().unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(bodies["n"], b"hi");
        let log = rec.log();
        assert!(log[0].contains("page-dump"));
        assert!(log[1].contains("page-tree"), "an old nexus falls back to list()+read()");

        // any other failure is a failure, not a silent N+1 crawl
        let (rec, p) = lp("", vec![bad(500)]);
        assert!(p.dump().is_err());
        assert_eq!(rec.log().len(), 1);
    }

    #[test]
    fn list_filters_to_the_sub_root_and_flags_generated_pages() {
        let tree = r#"{"nodes":[
            {"path":"notes","page":false},
            {"path":"notes/a","page":true,"kind":"md","size":3,"mtime":"~2026.7.20"},
            {"path":"notes/idx","page":true,"kind":"index","size":1,"mtime":"~2026.7.20"},
            {"path":"notes/sub","page":false},
            {"path":"other","page":true,"kind":"md","size":1,"mtime":"~2026.7.20"}
        ]}"#;
        let (_, p) = lp("notes", vec![ok(tree)]);
        let ns = p.list().unwrap();
        let mut rels: Vec<&str> = ns.iter().map(|n| n.rel.as_str()).collect();
        rels.sort();
        assert_eq!(rels, vec!["a", "idx", "sub"], "the sub-root itself and outsiders are dropped");
        let f = |r: &str| ns.iter().find(|n| n.rel == r).unwrap();
        assert!(f("a").is_page && !f("a").is_dir && !f("a").readonly);
        assert!(f("idx").readonly, "a generated %index page must be read-only");
        assert!(f("sub").is_dir && !f("sub").is_page);
        assert_eq!(f("a").mtime, 1784505600, "mtime comes off the @da, not the clock");
        assert!(f("sub").mtime > 1_700_000_000, "a folder gets wall clock");
    }

    #[test]
    fn remap_dump_strips_the_sub_root_from_rels_and_body_keys() {
        // a rel that kept its prefix would be read/written at the wrong page
        let dump = r#"{"nodes":[
            {"path":"notes","page":true,"kind":"md","body":"root body","mtime":"~2026.7.20"},
            {"path":"notes/a","page":true,"kind":"md","body":"aa","mtime":"~2026.7.20"},
            {"path":"elsewhere","page":true,"kind":"md","body":"nope","mtime":"~2026.7.20"}
        ]}"#;
        let (_, p) = lp("notes", vec![ok(dump)]);
        let (nodes, bodies) = p.dump().unwrap();
        assert_eq!(nodes.iter().map(|n| n.rel.clone()).collect::<Vec<_>>(), vec!["a"]);
        assert_eq!(bodies.keys().cloned().collect::<Vec<_>>(), vec!["a".to_string()]);
        assert_eq!(bodies["a"], b"aa");

        // mounting the whole tree is a no-op remap
        let (_, p) = lp("", vec![ok(dump)]);
        let (nodes, bodies) = p.dump().unwrap();
        assert_eq!(nodes.len(), 3);
        assert_eq!(bodies.len(), 3);
    }

    #[test]
    fn dump_marks_generated_index_pages_read_only() {
        let v = serde_json::json!({"nodes": [
            {"path": "idx", "page": true, "kind": "index", "mtime": "~2026.7.20", "body": "x"},
            {"path": "note", "page": true, "kind": "md", "mtime": "~2026.7.20", "body": "y"},
            {"path": "d", "page": false},
        ]});
        let (nodes, _) = parse_dump(&v).unwrap();
        let f = |r: &str| nodes.iter().find(|n| n.rel == r).unwrap();
        assert!(f("idx").readonly, "%index is generated; an edit would be clobbered");
        assert!(!f("note").readonly);
        assert!(f("d").mtime > 1_700_000_000, "a folder's mtime is wall clock");
    }

    #[test]
    fn folder_and_page_routes_carry_the_root_prefixed_name() {
        let (rec, p) = lp("notes", vec![ok("{}")]);
        p.mkdir("d").unwrap();
        assert_eq!(rec.log(), vec![r#"POST /apps/lattice/folder-new?name=notes/d """#]);

        let (rec, p) = lp("notes", vec![ok("{}")]);
        p.delete("d").unwrap();
        assert_eq!(rec.log(), vec![r#"POST /apps/lattice/page-del?name=notes/d """#]);

        let (rec, p) = lp("notes", vec![ok(r#"{"body":"the body"}"#)]);
        assert_eq!(p.read("n").unwrap(), b"the body");
        assert_eq!(rec.log(), vec!["GET /apps/lattice/page-source?name=notes/n"]);
        assert_eq!(p.ship(), "~test");
    }

    #[test]
    fn watch_delegates_to_the_transport() {
        let (_, p) = lp("", vec![]);
        let fired = Arc::new(AtomicBool::new(false));
        let f = fired.clone();
        p.watch(&move || f.store(true, Ordering::SeqCst));
        assert!(fired.load(Ordering::SeqCst), "watch must reach the transport");
    }

    #[test]
    fn da_needs_three_date_fields_and_ignores_extra_ones() {
        // fewer than three is unparseable -> now, and must never index past the end
        for s in ["~2026", "~2026.7", "~"] {
            assert!(da_to_unix(s) > 1_700_000_000, "{s}");
        }
        // more than three still parses the first three
        assert_eq!(da_to_unix("~2026.7.20.99"), da_to_unix("~2026.7.20"));
    }
}
