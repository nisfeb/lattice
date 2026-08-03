//! GenericProjection: mount ANY grubbery ball tree (another nexus, an arbitrary
//! sub-path), not just lattice's /page. Browses/reads via grubbery's generic
//! ball API (no lattice route knowledge), so grep/cat work over any nexus.
//!
//! Writes overwrite an EXISTING grub in place via grubbery's own `edit_file` MCP
//! tool: read the current text, replace it whole, blot preserved, atomic (no
//! delete-first, so a rejected conversion leaves the old grub intact). This is
//! the same "writable file" path the operator has. Permission is the owner's,
//! the mechanism is grubbery's. `rm` maps to `delete_grub`. Creating a *new*
//! grub is refused (EROFS). A foreign nexus's correct blot can't be inferred
//! from bytes, and a wrong blot yields a broken grub. Grubs with no text/mime
//! conversion fail the edit cleanly (EIO), never corrupt.
//!
//! Supported reliably: read, whole-file OVERWRITE (an editor's save, `>`), and
//! `rm`. NOT reliable: append / partial writes (`>>`, `tee -a`). A grub's mark
//! may normalize its text (e.g. hoon strips a trailing newline), so the byte
//! length exposed as /txt need not equal the stored bytes. An offset-based
//! append then lands at the wrong place. Overwrite is immune because it replaces
//! the whole content, which is what editors do. Emptying a grub via the mount is
//! also a no-op by design (see write()). Use `rm` to remove one.
//!
//! Wire (HTTP only, since the generic API is not on lick):
//!   GET  /grubbery/api/tree/<root>            -> {neck, files:{name:mark}, dirs:{name:{...}}}
//!   GET  /grubbery/api/file/<root>/<rel>?blot=/txt   -> the grub's text form (edit-consistent)
//!   GET  /grubbery/api/file/<root>/<rel>?blot=/json  -> semantic value, when there's no text tube
//!   POST /grubbery/mcp  (edit_file / delete_grub)    -> in-place overwrite / remove
//! `/txt` is read first. It's what edit_file overwrites, and a mark with no text
//! tube 400s cleanly (whereas /json falls back to the multi-MB raw jam).

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::projection::{Node, PErr, Projection};
use crate::transport::Transport;

pub struct GenericProjection {
    t: Box<dyn Transport>,
    ship: String,
    root: String, // ball path, no leading/trailing slash, e.g. "apps/obelisk.obelisk_app"
}

impl GenericProjection {
    pub fn new(t: Box<dyn Transport>, root: &str) -> Result<Self, PErr> {
        let ship = t.ship()?;
        Ok(Self { t, ship, root: root.trim_matches('/').to_string() })
    }

    fn file_path(&self, rel: &str) -> String {
        if rel.is_empty() {
            format!("/grubbery/api/file/{}", self.root)
        } else {
            format!("/grubbery/api/file/{}/{}", self.root, rel)
        }
    }

    /// Split a projection rel into the absolute ball directory and the grub name
    /// the MCP tools expect (path = "/apps/foo.foo_app/sub", name = "grub").
    fn dir_and_name(&self, rel: &str) -> (String, String) {
        split_rel(&self.root, rel)
    }

    /// Call a grubbery MCP tool over HTTP. Returns Ok on success. Maps a JSON-RPC
    /// error to EIO carrying the server's message.
    fn mcp(&self, tool: &str, args: Value) -> Result<(), PErr> {
        let body = json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": tool, "arguments": args},
        });
        let raw = self.t.post("/grubbery/mcp", &[], body.to_string().as_bytes())?;
        let v: Value = serde_json::from_slice(&raw)
            .map_err(|e| PErr::new(libc::EIO, format!("mcp bad json: {e}")))?;
        if let Some(err) = v.get("error") {
            let msg = err.get("message").and_then(Value::as_str).unwrap_or("mcp error");
            return Err(PErr::new(libc::EIO, msg.to_string()));
        }
        // MCP also signals tool failure as result.isError with the message in
        // content. Treat that as an error too, not a silent success.
        let res = v.get("result");
        if res.and_then(|r| r.get("isError")).and_then(Value::as_bool) == Some(true) {
            let msg = res
                .and_then(|r| r.get("content"))
                .and_then(Value::as_array)
                .and_then(|c| c.first())
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("mcp tool error");
            return Err(PErr::new(libc::EIO, msg.to_string()));
        }
        Ok(())
    }

    /// Walk the recursive tree JSON into (rel, is_dir) pairs. Files carry a mark
    /// value we don't need beyond knowing it's a file.
    fn walk(prefix: &str, node: &Value, out: &mut Vec<(String, bool)>) {
        if let Some(files) = node.get("files").and_then(Value::as_object) {
            for name in files.keys() {
                let rel =
                    if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
                out.push((rel, false));
            }
        }
        if let Some(dirs) = node.get("dirs").and_then(Value::as_object) {
            for (name, sub) in dirs {
                let rel =
                    if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
                out.push((rel.clone(), true));
                Self::walk(&rel, sub, out);
            }
        }
    }

    fn nodes(&self) -> Result<Vec<(String, bool)>, PErr> {
        let v = self.t.get_json(&format!("/grubbery/api/tree/{}", self.root), &[])?;
        let mut out = Vec::new();
        Self::walk("", &v, &mut out);
        Ok(out)
    }
}

impl Projection for GenericProjection {
    fn ship(&self) -> String {
        self.ship.clone()
    }

    fn list(&self) -> Result<Vec<Node>, PErr> {
        // structure only. Sizes are filled by dump() (which the core warms from).
        Ok(self
            .nodes()?
            .into_iter()
            .map(|(rel, is_dir)| Node {
                rel,
                is_dir,
                is_page: !is_dir,
                kind: String::new(),
                size: 0,
                mtime: now(),
                readonly: is_dir, // files editable in place. Dirs aren't
            })
            .collect())
    }

    fn read(&self, rel: &str) -> Result<Vec<u8>, PErr> {
        // /txt is the grub's text form: readable AND exactly what edit_file matches,
        // so read and write stay consistent. A mark with no text tube returns a
        // clean 400 ("No tube"). Fall back to /json for a semantic, read-only view
        // (an @t grub's source, a struct's json). /json is NOT used first because a
        // mark with no json tube falls back to the multi-MB raw jam instead of erroring.
        match self.t.get_bytes(&self.file_path(rel), &[("blot", "/txt")]) {
            Ok(raw) => Ok(raw),
            Err(e) if e.code == 400 => {
                let raw = self.t.get_bytes(&self.file_path(rel), &[("blot", "/json")])?;
                match serde_json::from_slice::<Value>(&raw) {
                    Ok(Value::String(s)) => Ok(s.into_bytes()),
                    Ok(v) => Ok(v.to_string().into_bytes()),
                    Err(_) => Ok(raw),
                }
            }
            Err(e) => Err(e.into()),
        }
    }

    fn dump(&self) -> Result<(Vec<Node>, HashMap<String, Vec<u8>>), PErr> {
        // No bulk endpoint for a generic tree. Walk it, then read each grub.
        // read() picks /txt, falling back to /json (small, not the raw jam).
        // A grub that won't render gets a placeholder so the tree stays browsable.
        let mut nodes = Vec::new();
        let mut bodies = HashMap::new();
        for (rel, is_dir) in self.nodes()? {
            if is_dir {
                nodes.push(Node {
                    rel,
                    is_dir: true,
                    is_page: false,
                    kind: String::new(),
                    size: 0,
                    mtime: now(),
                    readonly: true,
                });
                continue;
            }
            let body = self.read(&rel).unwrap_or_else(|e| {
                format!("[unreadable grub: {}]\n", e.msg).into_bytes()
            });
            let size = body.len() as u64;
            bodies.insert(rel.clone(), body);
            nodes.push(Node {
                rel,
                is_dir: false,
                is_page: true,
                kind: String::new(),
                size,
                mtime: now(),
                readonly: false, // editable in place via edit_file
            });
        }
        Ok((nodes, bodies))
    }

    fn errors(&self, _rel: &str) -> Result<String, PErr> {
        Ok(String::new()) // no per-page evaluator errors in a generic tree
    }

    fn write(&self, rel: &str, _kind: &str, data: &[u8], create: bool) -> Result<(), PErr> {
        if create {
            return Err(PErr::new(
                libc::EROFS,
                "generic mount: can't create new grubs (target blot unknown); edit existing ones",
            ));
        }
        // Overwrite in place via edit_file: old_string = the grub's current text
        // (fetched fresh so it's accurate), new_string = the written bytes. For a
        // grub whose text form differs from what we serve (a bespoke mark), the
        // match fails and edit_file errors → EIO, leaving the grub untouched.
        let current = self.read(rel)?;
        let old = String::from_utf8_lossy(&current).into_owned();
        let new = String::from_utf8_lossy(data).into_owned();
        if new.is_empty() {
            // Never set a generic grub empty via the mount. An editor's O_TRUNC
            // arrives as a truncate-to-0 commit *before* the real bytes land, and
            // edit_file (a diff, not a set) can't rebuild a grub from empty. So
            // honoring the empty commit would wipe it and the next commit couldn't
            // recover. Skip it. The following commit carries the real content.
            // `rm` (delete_grub) is how you actually remove a grub.
            return Ok(());
        }
        if old == new {
            return Ok(()); // no-op save
        }
        if old.is_empty() {
            return Err(PErr::new(libc::EIO, "generic mount: can't edit a currently-empty grub in place"));
        }
        let (path, name) = self.dir_and_name(rel);
        self.mcp("edit_file", json!({"path": path, "name": name, "old_string": old, "new_string": new}))
    }

    fn mkdir(&self, _rel: &str) -> Result<(), PErr> {
        Err(PErr::new(libc::EROFS, "generic mount: directory creation not supported"))
    }

    fn delete(&self, rel: &str) -> Result<(), PErr> {
        // Folders need delete_folder. delete_grub silently no-ops on them (it
        // even claims "Deleted"). Only empty dirs get here. The core's rmdir
        // returns ENOTEMPTY for populated ones.
        if self.nodes()?.iter().any(|(r, is_dir)| *is_dir && r == rel) {
            return self.mcp("delete_folder", json!({"path": format!("/{}/{}", self.root, rel)}));
        }
        let (path, name) = self.dir_and_name(rel);
        self.mcp("delete_grub", json!({"path": path, "name": name}))
    }

    fn mv(&self, _src: &str, _dst: &str) -> Result<(), PErr> {
        Err(PErr::new(libc::EROFS, "generic mount: rename not supported"))
    }

    // A generic grub has no lattice kind. Present everything as .txt so grep/cat
    // and editors treat it as text (the ?blot=/json read yields text/json text).
    fn ext_for_kind(&self, _kind: &str) -> &'static str {
        "txt"
    }
    fn kind_for_ext(&self, _ext: &str) -> String {
        String::new()
    }

    fn watch(&self, _on_change: &(dyn Fn() + Send + Sync)) {
        // no-op: the core's 5s TTL poll is the freshness floor for generic mounts.
    }
}

fn now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Absolute ball dir + grub name for a rel under `root`, as the MCP tools expect.
fn split_rel(root: &str, rel: &str) -> (String, String) {
    let (dir, name) = match rel.rfind('/') {
        Some(i) => (&rel[..i], &rel[i + 1..]),
        None => ("", rel),
    };
    let path = if dir.is_empty() { format!("/{root}") } else { format!("/{root}/{dir}") };
    (path, name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::TErr;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    #[test]
    fn split_rel_roots_and_nests() {
        let root = "apps/foo.foo_app";
        assert_eq!(split_rel(root, "grub"), ("/apps/foo.foo_app".into(), "grub".into()));
        assert_eq!(
            split_rel(root, "sub/dir/grub"),
            ("/apps/foo.foo_app/sub/dir".into(), "grub".into())
        );
    }

    // ---------- a scripted transport ----------

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
    /// A successful MCP tool call.
    const MCP_OK: &str = r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"text":"Edited"}]}}"#;

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

    impl Transport for Rec {
        fn get_bytes(&self, path: &str, query: &[(&str, &str)]) -> Result<Vec<u8>, TErr> {
            let q: Vec<String> = query.iter().map(|(k, v)| format!("{k}={v}")).collect();
            self.next(format!("GET {path}?{}", q.join("&")))
        }
        fn post(&self, path: &str, _q: &[(&str, &str)], body: &[u8]) -> Result<Vec<u8>, TErr> {
            self.next(format!("POST {path} {}", String::from_utf8_lossy(body)))
        }
        fn ship(&self) -> Result<String, TErr> {
            Ok("~test".into())
        }
    }

    const ROOT: &str = "apps/foo.foo_app";

    fn gp(script: Vec<Result<Vec<u8>, TErr>>) -> (Rec, GenericProjection) {
        let rec = Rec::default();
        *rec.0.script.lock().unwrap() = script.into();
        let p = GenericProjection::new(Box::new(rec.clone()), ROOT).unwrap();
        (rec, p)
    }

    const TREE: &str = r#"{"files":{"a":"%txt","b":"%txt"},"dirs":{"sub":{"files":{"g":"%txt"}}}}"#;

    // ---------- the write guards: every one of these is a data-loss stop ----------

    #[test]
    fn generic_write_refuses_to_create() {
        // a new grub's correct blot can't be inferred from bytes; a wrong one
        // yields a broken grub. Refuse BEFORE any I/O.
        let (rec, p) = gp(vec![]);
        let e = p.write("g", "", b"hello", true).unwrap_err();
        assert_eq!(e.errno, libc::EROFS);
        assert!(rec.log().is_empty(), "a refused create must not touch the wire");
    }

    #[test]
    fn generic_write_never_empties_a_grub() {
        // an editor's O_TRUNC arrives as a commit of zero bytes BEFORE the real
        // content. Honoring it would wipe the grub, and edit_file (a diff) could
        // not rebuild it from empty. The following commit carries the content.
        let (rec, p) = gp(vec![ok("real content")]);
        p.write("g", "", b"", false).unwrap();
        assert!(
            !rec.log().iter().any(|l| l.starts_with("POST")),
            "a truncate-to-zero must never reach edit_file"
        );
    }

    #[test]
    fn generic_write_overwrites_in_place_and_no_ops_only_on_identical_bytes() {
        // an identical save is a no-op...
        let (rec, p) = gp(vec![ok("same text")]);
        p.write("g", "", b"same text", false).unwrap();
        assert!(!rec.log().iter().any(|l| l.starts_with("POST")), "identical save is a no-op");

        // ...but a REAL change must POST. If this inverted, every save would be
        // silently dropped and the user's edits would vanish.
        let (rec, p) = gp(vec![ok("old text"), ok(MCP_OK)]);
        p.write("sub/g", "", b"new text", false).unwrap();
        let log = rec.log();
        let post = log.iter().find(|l| l.starts_with("POST")).expect("a changed save must POST");
        assert!(post.starts_with("POST /grubbery/mcp "));
        let v: Value = serde_json::from_str(post.splitn(3, ' ').nth(2).unwrap()).unwrap();
        assert_eq!(v["params"]["name"], "edit_file");
        let args = &v["params"]["arguments"];
        assert_eq!(args["old_string"], "old text");
        assert_eq!(args["new_string"], "new text");
        assert_eq!(args["path"], "/apps/foo.foo_app/sub", "the grub's own directory");
        assert_eq!(args["name"], "g");
    }

    #[test]
    fn generic_write_refuses_to_edit_an_empty_grub() {
        // edit_file matches old_string; there is nothing to match. Fail cleanly
        // rather than send an edit that would silently do nothing.
        let (rec, p) = gp(vec![ok("")]);
        let e = p.write("g", "", b"content", false).unwrap_err();
        assert_eq!(e.errno, libc::EIO);
        assert!(!rec.log().iter().any(|l| l.starts_with("POST")));
    }

    #[test]
    fn generic_mcp_never_reports_a_failed_edit_as_a_save() {
        // a save the ship rejected MUST surface as an error. Reporting it as
        // success makes the editor believe the file is written; the content is
        // then lost when the buffer closes.
        let cases: Vec<(&str, &str)> = vec![
            (r#"{"jsonrpc":"2.0","id":1,"error":{"message":"no such grub"}}"#, "no such grub"),
            (
                r#"{"result":{"isError":true,"content":[{"text":"no /txt tube"}]}}"#,
                "no /txt tube",
            ),
            ("this is not json at all", "mcp bad json"),
        ];
        for (resp, want) in cases {
            let (_, p) = gp(vec![ok("old text"), ok(resp)]);
            let e = p.write("g", "", b"new text", false).unwrap_err();
            assert_eq!(e.errno, libc::EIO, "{resp}");
            assert!(e.msg.contains(want), "{} should mention {want}", e.msg);
        }
        // and a genuine success is NOT reported as an error
        let (_, p) = gp(vec![ok("old text"), ok(MCP_OK)]);
        assert!(p.write("g", "", b"new text", false).is_ok());
    }

    // ---------- read: the right bytes, from the right blot ----------

    #[test]
    fn generic_read_falls_back_to_json_only_on_a_400() {
        // /txt first: it is exactly what edit_file matches, so read and write
        // stay consistent.
        let (rec, p) = gp(vec![ok("plain text")]);
        assert_eq!(p.read("g").unwrap(), b"plain text");
        assert_eq!(rec.log(), vec!["GET /grubbery/api/file/apps/foo.foo_app/g?blot=/txt"]);

        // a mark with no text tube 400s -> /json, whose string form is unwrapped
        let (rec, p) = gp(vec![bad(400), ok("\"a cord\"")]);
        assert_eq!(p.read("g").unwrap(), b"a cord");
        assert!(rec.log()[1].ends_with("blot=/json"));

        // a structured value is rendered as JSON text, and unparseable bytes
        // are served raw rather than replaced
        let (_, p) = gp(vec![bad(400), ok(r#"{"k":1}"#)]);
        assert_eq!(p.read("g").unwrap(), br#"{"k":1}"#);
        let (_, p) = gp(vec![bad(400), ok("raw bytes")]);
        assert_eq!(p.read("g").unwrap(), b"raw bytes");

        // any OTHER failure is an error, never an empty file
        let (rec, p) = gp(vec![bad(500)]);
        assert_eq!(p.read("g").unwrap_err().errno, libc::EIO);
        assert_eq!(rec.log().len(), 1, "a non-400 must not retry on /json");

        // the root grub has no trailing slash in its path
        let (rec, p) = gp(vec![ok("x")]);
        p.read("").unwrap();
        assert_eq!(rec.log(), vec!["GET /grubbery/api/file/apps/foo.foo_app?blot=/txt"]);
    }

    // ---------- the tree ----------

    #[test]
    fn generic_list_walks_the_whole_tree_and_marks_dirs() {
        let (_, p) = gp(vec![ok(TREE)]);
        let nodes = p.list().unwrap();
        let mut seen: Vec<(String, bool)> = nodes.iter().map(|n| (n.rel.clone(), n.is_dir)).collect();
        seen.sort();
        assert_eq!(
            seen,
            vec![
                ("a".to_string(), false),
                ("b".to_string(), false),
                ("sub".to_string(), true),
                ("sub/g".to_string(), false),
            ],
            "nested files must be reachable, not orphaned at the top"
        );
        for n in &nodes {
            assert_eq!(n.is_page, !n.is_dir);
            assert_eq!(n.readonly, n.is_dir, "files are editable in place, dirs are not");
            assert!(n.mtime > 1_700_000_000, "mtime must be wall clock");
        }
    }

    #[test]
    fn generic_dump_sizes_from_the_bytes_and_keeps_an_unreadable_grub_browsable() {
        // a/txt ok, b/txt 400 then /json 500 -> placeholder, sub is a dir, sub/g ok
        let (_, p) = gp(vec![
            ok(TREE),
            ok("aaaa"),
            bad(400),
            bad(500),
            ok("gg"),
        ]);
        let (nodes, bodies) = p.dump().unwrap();
        assert_eq!(bodies["a"], b"aaaa");
        assert_eq!(bodies["sub/g"], b"gg");
        assert!(
            String::from_utf8_lossy(&bodies["b"]).starts_with("[unreadable grub:"),
            "an unrenderable grub gets a placeholder so the tree stays browsable"
        );
        for n in &nodes {
            if n.is_dir {
                assert!(!n.is_page && n.size == 0);
                continue;
            }
            // st_size must equal what read() returns, or every cat short-reads
            assert_eq!(n.size, bodies[&n.rel].len() as u64, "{} size mismatch", n.rel);
        }
        assert_eq!(nodes.iter().filter(|n| n.is_dir).count(), 1);
    }

    #[test]
    fn generic_delete_routes_a_folder_and_a_grub_to_different_tools() {
        // delete_grub silently no-ops on a folder (it even claims "Deleted"),
        // so a misroute leaves the folder in place while reporting success.
        let (rec, p) = gp(vec![ok(TREE), ok(MCP_OK)]);
        p.delete("sub").unwrap();
        let post = rec.log().into_iter().find(|l| l.starts_with("POST")).unwrap();
        let v: Value = serde_json::from_str(post.splitn(3, ' ').nth(2).unwrap()).unwrap();
        assert_eq!(v["params"]["name"], "delete_folder");
        assert_eq!(v["params"]["arguments"]["path"], "/apps/foo.foo_app/sub");

        let (rec, p) = gp(vec![ok(TREE), ok(MCP_OK)]);
        p.delete("sub/g").unwrap();
        let post = rec.log().into_iter().find(|l| l.starts_with("POST")).unwrap();
        let v: Value = serde_json::from_str(post.splitn(3, ' ').nth(2).unwrap()).unwrap();
        assert_eq!(v["params"]["name"], "delete_grub");
        assert_eq!(v["params"]["arguments"]["path"], "/apps/foo.foo_app/sub");
        assert_eq!(v["params"]["arguments"]["name"], "g");
    }

    #[test]
    fn generic_unsupported_ops_fail_loudly() {
        // a silent Ok here makes the core insert a vtree entry for something
        // that does not exist on the ship
        let (_, p) = gp(vec![]);
        assert_eq!(p.mkdir("x").unwrap_err().errno, libc::EROFS);
        assert_eq!(p.mv("a", "b").unwrap_err().errno, libc::EROFS);
        assert_eq!(p.ship(), "~test");
        assert_eq!(p.errors("x").unwrap(), "", "a generic tree has no evaluator errors");
        // everything is presented as .txt so editors and grep treat it as text
        assert_eq!(p.ext_for_kind("anything"), "txt");
        assert_eq!(p.kind_for_ext("txt"), "");
    }
}
