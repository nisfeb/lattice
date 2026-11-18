//! The vault archive: every page and memory as one tar of plain files, the
//! same archive the web client writes (`code/nex/lattice/ui-app/vault.js`).

use serde_json::Value;

const README: &str = include_str!("vault_readme.txt");

/// One file of the archive.
pub struct File {
    pub name: String,
    pub body: Vec<u8>,
    pub mtime: u64,
}

/// A path as a ustar prefix and name, or none when it fits neither.
fn split_name(p: &str) -> Option<(&str, &str)> {
    if p.len() <= 100 {
        return Some(("", p));
    }
    (p.len().saturating_sub(101)..p.len()).find(|&i| p.as_bytes()[i] == b'/' && p.len() - i - 1 <= 100 && i <= 155).map(|i| (&p[..i], &p[i + 1..]))
}

fn header(name: &str, size: usize, mtime: u64, kind: u8) -> [u8; 512] {
    let mut h = [0u8; 512];
    let mut put = |s: &[u8], at: usize, len: usize| h[at..at + s.len().min(len)].copy_from_slice(&s[..s.len().min(len)]);
    let (prefix, short) = split_name(name).unwrap_or(("", name));
    put(short.as_bytes(), 0, 100);
    put(b"0000644\0", 100, 8);
    put(b"0000000\0", 108, 8);
    put(b"0000000\0", 116, 8);
    put(format!("{size:011o}\0").as_bytes(), 124, 12);
    put(format!("{mtime:011o}\0").as_bytes(), 136, 12);
    put(b"        ", 148, 8);
    put(&[kind], 156, 1);
    put(b"ustar\0", 257, 6);
    put(b"00", 263, 2);
    put(prefix.as_bytes(), 345, 155);
    let sum: u32 = h.iter().map(|&b| u32::from(b)).sum();
    h[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    h
}

fn pad(out: &mut Vec<u8>) {
    out.resize(out.len().div_ceil(512) * 512, 0);
}

/// The files as one tar. A name too long for a header goes in a GNU
/// long-name record before it.
pub fn tar(files: &[File]) -> Vec<u8> {
    let mut out = Vec::new();
    for f in files {
        if split_name(&f.name).is_none() {
            let nb = format!("{}\0", f.name);
            out.extend_from_slice(&header("././@LongLink", nb.len(), f.mtime, b'L'));
            out.extend_from_slice(nb.as_bytes());
            pad(&mut out);
        }
        out.extend_from_slice(&header(&f.name, f.body.len(), f.mtime, b'0'));
        out.extend_from_slice(&f.body);
        pad(&mut out);
    }
    out.resize(out.len() + 1024, 0);
    out
}

/// The files of a tar, each with its text. A header whose checksum is off
/// and an entry cut short are refused.
pub fn untar(u: &[u8]) -> Result<Vec<(String, String)>, String> {
    let text = |b: &[u8]| String::from_utf8_lossy(&b[..b.iter().position(|&c| c == 0).unwrap_or(b.len())]).into_owned();
    let octal = |b: &[u8]| u64::from_str_radix(&text(b).chars().filter(|c| ('0'..='7').contains(c)).collect::<String>(), 8).ok();
    let (mut out, mut off, mut long) = (Vec::new(), 0, None::<String>);
    while off + 512 <= u.len() {
        let h = &u[off..off + 512];
        if h.iter().all(|&b| b == 0) {
            break;
        }
        let sum: u64 = h.iter().enumerate().map(|(i, &b)| if (148..156).contains(&i) { 32 } else { u64::from(b) }).sum();
        if octal(&h[148..156]) != Some(sum) {
            return Err(format!("checksum mismatch at byte {off}"));
        }
        let size = octal(&h[124..136]).unwrap_or(0) as usize;
        let (kind, name, prefix) = (h[156], text(&h[..100]), text(&h[345..500]));
        off += 512;
        if off + size > u.len() {
            return Err(format!("truncated entry \"{name}\" at byte {off}"));
        }
        let data = &u[off..off + size];
        off += size.div_ceil(512) * 512;
        match kind {
            b'L' => long = Some(String::from_utf8_lossy(data).trim_end_matches('\0').to_owned()),
            b'0' | 0 => out.push((long.take().unwrap_or(if prefix.is_empty() { name } else { format!("{prefix}/{name}") }), String::from_utf8_lossy(data).into_owned())),
            _ => long = None,
        }
    }
    Ok(out)
}

/// The extension a page of this kind is written with.
pub fn kind_ext(kind: &str) -> &str {
    match kind {
        "text" => "txt",
        "index" | "" => "md",
        k => k,
    }
}

/// A ship's date (`~2026.11.17..20.36.35`) as seconds since 1970, or `now`
/// when it is not one.
pub fn da_to_unix(da: &str, now: u64) -> u64 {
    let parse = || {
        let mut halves = da.strip_prefix('~')?.split("..");
        let mut n = halves.next()?.split('.').chain(halves.next()?.split('.')).map(|p| p.parse::<i64>().ok());
        let (y, m, d, h, mi, s) = (n.next()??, n.next()??, n.next()??, n.next()??, n.next()??, n.next()??);
        u64::try_from(crate::sheet::days_from_civil(y, m, d) * 86400 + h * 3600 + mi * 60 + s).ok()
    };
    parse().unwrap_or(now)
}

/// Seconds since 1970 as `2026-11-17-20-36-35`, in UTC.
pub fn stamp(secs: u64) -> String {
    let (y, m, d) = crate::sheet::civil_from_days((secs / 86400) as i64);
    let r = secs % 86400;
    format!("{y:04}-{m:02}-{d:02}-{:02}-{:02}-{:02}", r / 3600, r % 3600 / 60, r % 60)
}

pub fn file_name(now: u64) -> String {
    format!("lattice-vault-{}.tar", stamp(now))
}

/// JSON as the web client writes it into the archive: one space a level.
fn pretty(v: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(b" "));
    serde::Serialize::serialize(v, &mut ser).expect("a JSON value is written to memory");
    out
}

/// An archive, and what it holds and lacks.
pub struct Built {
    pub bytes: Vec<u8>,
    pub pages: usize,
    pub memories: usize,
    /// What could not be read. An archive with any is incomplete.
    pub missing: Vec<String>,
    /// Folder indexes left out on purpose: the ship makes them again.
    pub excluded: usize,
}

impl Built {
    /// What to say of it once it is written to `at`.
    pub fn says(&self, at: &str) -> String {
        if !self.missing.is_empty() {
            let more = if self.missing.len() > 5 { format!(" and {} more", self.missing.len() - 5) } else { String::new() };
            return format!("exported {} page(s) to {at}, but could NOT read: {}{more}", self.pages, self.missing.iter().take(5).cloned().collect::<Vec<_>>().join(", "));
        }
        let skipped = match self.excluded {
            0 => String::new(),
            n => format!(" ({n} generated folder index{} not included, they rebuild themselves)", if n == 1 { "" } else { "es" }),
        };
        format!("exported {} page(s) and {} memories to {at}{skipped}", self.pages, self.memories)
    }
}

/// The archive of a store: `dump` is what `page-dump` answered, `know` what
/// `know-all` did and `scopes` what `page-scopes` did, each none when it
/// could not be read. `source` reads the body of a page the dump left out.
pub fn build(dump: &Value, know: Option<&Value>, scopes: Option<&Value>, source: &dyn Fn(&str) -> Option<String>, now: u64) -> Built {
    let empty = Vec::new();
    let nodes = dump["nodes"].as_array().unwrap_or(&empty);
    let s = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    let file = |name: String, body: Vec<u8>, mtime: u64| File { name, body, mtime };
    let (mut files, mut missing, mut excluded, mut pages) = (Vec::new(), Vec::new(), 0, 0);
    for n in nodes.iter().filter(|n| n["page"] == true) {
        let path = s(&n["path"]);
        if n["kind"] == "index" {
            excluded += 1;
            continue;
        }
        pages += 1;
        match n["body"].as_str().map(str::to_owned).or_else(|| source(&path)) {
            Some(body) => files.push(file(format!("pages/{path}.{}", kind_ext(n["kind"].as_str().unwrap_or_default())), body.into_bytes(), da_to_unix(n["mtime"].as_str().unwrap_or_default(), now))),
            None => missing.push(path),
        }
    }
    let mut memories = 0;
    match know {
        Some(k) => {
            for it in k["items"].as_array().unwrap_or(&empty) {
                memories += 1;
                files.push(file(format!("know/{}.md", s(&it["key"]).trim_start_matches('/')), s(&it["body"]).into_bytes(), da_to_unix(it["updated"].as_str().unwrap_or_default(), now)));
            }
            files.push(file("know.json".into(), pretty(k), now));
        }
        None => missing.push("the memories".into()),
    }
    match scopes.and_then(|v| v["items"].as_array()) {
        Some(items) => {
            let share: serde_json::Map<String, Value> = items.iter().filter(|it| !matches!(it["scope"].as_str(), None | Some("" | "private"))).map(|it| (s(&it["path"]), it["scope"].clone())).collect();
            files.push(file("share.json".into(), pretty(&Value::Object(share)), now));
        }
        None => missing.push("the share modes".into()),
    }
    let sensitive: Vec<Value> = nodes.iter().filter(|n| n["sensitive"] == true).map(|n| n["path"].clone()).collect();
    files.push(file("sensitive.json".into(), pretty(&Value::Array(sensitive)), now));
    let names: serde_json::Map<String, Value> = nodes.iter().filter(|n| !s(&n["dname"]).is_empty()).map(|n| (s(&n["path"]), n["dname"].clone())).collect();
    if !names.is_empty() {
        files.push(file("names.json".into(), pretty(&Value::Object(names)), now));
    }
    let manifest = serde_json::json!({ "pages": pages, "memories": know.map(|_| memories), "missing": missing });
    files.push(file("manifest.json".into(), pretty(&manifest), now));
    files.push(file("README.txt".into(), README.as_bytes().to_vec(), now));
    Built { bytes: tar(&files), pages, memories, missing, excluded }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_tar_reads_back_with_long_names_and_refuses_damage() {
        let long = format!("pages/{}/{}.md", "d".repeat(120), "n".repeat(120));
        let mid = format!("pages/{}/note.md", "d".repeat(110));
        let files = [File { name: "pages/a.md".into(), body: b"# a\n".to_vec(), mtime: 5 }, File { name: mid.clone(), body: vec![b'x'; 600], mtime: 5 }, File { name: long.clone(), body: "caf\u{e9}".into(), mtime: 5 }];
        let t = tar(&files);
        assert_eq!(t.len() % 512, 0);
        // a header as tar(1) reads it: magic, octal size, a checksum that adds up
        assert_eq!(&t[257..263], b"ustar\0");
        assert_eq!(&t[124..136], b"00000000004\0");
        let back = untar(&t).unwrap();
        assert_eq!(back.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["pages/a.md", mid.as_str(), long.as_str()]);
        assert_eq!(back[2].1, "caf\u{e9}");
        assert_eq!(back[1].1.len(), 600);
        let mut bent = t.clone();
        bent[3] ^= 1;
        assert!(untar(&bent).unwrap_err().contains("checksum"));
        assert!(untar(&t[..514]).unwrap_err().contains("truncated"));
    }

    #[test]
    fn dates_and_names() {
        assert_eq!(da_to_unix("~2026.11.17..20.36.35", 9), 1_794_947_795);
        assert_eq!(da_to_unix("~2026.11.17..20.36.35..a1b2", 9), 1_794_947_795);
        assert_eq!(da_to_unix("soon", 9), 9);
        assert_eq!(file_name(1_794_947_795), "lattice-vault-2026-11-17-20-36-35.tar");
        assert_eq!((kind_ext("text"), kind_ext("index"), kind_ext("tex"), kind_ext("")), ("txt", "md", "tex", "md"));
    }

    #[test]
    fn a_store_becomes_the_archive_the_web_client_writes() {
        let dump = json!({"nodes": [
            {"path": "notes", "page": false, "dname": "Notes", "sensitive": true},
            {"path": "notes", "page": true, "kind": "index", "body": "hoon"},
            {"path": "notes/a", "page": true, "kind": "md", "body": "# a\n", "mtime": "~2026.11.17..20.36.35"},
            {"path": "notes/t", "page": true, "kind": "text"},
            {"path": "gone", "page": true, "kind": "md"},
        ]});
        let know = json!({"items": [{"key": "/project/x", "body": "fact", "tags": ["t"], "updated": "~2026.11.17..20.36.35"}]});
        let scopes = json!({"items": [{"path": "notes/a", "scope": "clearweb"}, {"path": "notes/t", "scope": "private"}]});
        let source = |p: &str| (p == "notes/t").then(|| "plain".to_owned());
        let b = build(&dump, Some(&know), Some(&scopes), &source, 100);
        assert_eq!((b.pages, b.memories, b.excluded), (3, 1, 1));
        assert_eq!(b.missing, ["gone"]);
        assert!(b.says("/tmp/v.tar").contains("could NOT read: gone"));
        let files = untar(&b.bytes).unwrap();
        let get = |n: &str| files.iter().find(|(name, _)| name == n).map(|(_, t)| t.as_str());
        assert_eq!(files.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["pages/notes/a.md", "pages/notes/t.txt", "know/project/x.md", "know.json", "share.json", "sensitive.json", "names.json", "manifest.json", "README.txt"]);
        assert_eq!(get("pages/notes/t.txt"), Some("plain"));
        assert_eq!(get("share.json"), Some("{\n \"notes/a\": \"clearweb\"\n}"));
        assert_eq!(get("sensitive.json"), Some("[\n \"notes\"\n]"));
        assert_eq!(get("names.json"), Some("{\n \"notes\": \"Notes\"\n}"));
        let know_back: Value = serde_json::from_str(get("know.json").unwrap()).unwrap();
        assert_eq!(know_back, know);
        let man: Value = serde_json::from_str(get("manifest.json").unwrap()).unwrap();
        assert_eq!(man, json!({"pages": 3, "memories": 1, "missing": ["gone"]}));
        // the page's date is the file's
        assert_eq!(&b.bytes[136..148], format!("{:011o}\0", 1_794_947_795u64).as_bytes());

        // nothing read of the memories or the share modes is said, not hidden
        let b = build(&json!({"nodes": [{"path": "a", "page": true, "kind": "md", "body": "x"}]}), None, None, &|_| None, 100);
        assert_eq!(b.missing, ["the memories", "the share modes"]);
        let man: Value = serde_json::from_str(&untar(&b.bytes).unwrap().into_iter().find(|(n, _)| n == "manifest.json").unwrap().1).unwrap();
        assert_eq!(man["memories"], Value::Null);
        let clean = build(&dump, Some(&know), Some(&scopes), &|_| Some("b".into()), 100);
        assert_eq!(clean.says("/tmp/v.tar"), "exported 3 page(s) and 1 memories to /tmp/v.tar (1 generated folder index not included, they rebuild themselves)");
    }

    /// Against a ship seeded with `notes/a` (named Alpha Page), `notes/plain`
    /// (text, sensitive), `top` (shared) and the memory `/project/x`.
    #[test]
    #[ignore]
    fn live_vault() {
        let c = crate::api::Conn::from_env().expect("LATTICE_URL and LATTICE_COOKIE");
        let b = c.vault(100).unwrap();
        assert!(b.missing.is_empty(), "{:?}", b.missing);
        let files = untar(&b.bytes).unwrap();
        let get = |n: &str| files.iter().find(|(name, _)| name == n).map(|(_, t)| t.clone()).unwrap_or_else(|| panic!("no {n}"));
        assert_eq!(get("pages/notes/plain.txt"), "plain text");
        assert_eq!(get("know/project/x.md"), "a fact");
        let json = |n: &str| serde_json::from_str::<Value>(&get(n)).unwrap();
        // the ship's word for a page shared over Urbit
        assert_eq!(json("share.json")["top"], "urbit");
        assert_eq!(json("names.json")["notes/a"], "Alpha Page");
        assert!(json("sensitive.json").as_array().unwrap().contains(&json!("notes/plain")));
        assert_eq!(json("manifest.json"), json!({"pages": b.pages, "memories": b.memories, "missing": []}));
    }
}
