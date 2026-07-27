//! GenericProjection: mount ANY grubbery ball tree (another nexus, an arbitrary
//! sub-path) — not just lattice's /page. Browses/reads via grubbery's generic
//! ball API (no lattice route knowledge), so grep/cat work over any nexus.
//!
//! Writes overwrite an EXISTING grub in place via grubbery's own `edit_file` MCP
//! tool: read the current text, replace it whole, blot preserved, atomic (no
//! delete-first, so a rejected conversion leaves the old grub intact). This is
//! the same "writable file" path the operator has — permission is the owner's,
//! the mechanism is grubbery's. `rm` maps to `delete_grub`. Creating a *new*
//! grub is refused (EROFS): a foreign nexus's correct blot can't be inferred
//! from bytes, and a wrong blot yields a broken grub. Grubs with no text/mime
//! conversion fail the edit cleanly (EIO), never corrupt.
//!
//! Supported reliably: read, whole-file OVERWRITE (an editor's save, `>`), and
//! `rm`. NOT reliable: append / partial writes (`>>`, `tee -a`). A grub's mark
//! may normalize its text (e.g. hoon strips a trailing newline), so the byte
//! length exposed as /txt need not equal the stored bytes — an offset-based
//! append then lands at the wrong place. Overwrite is immune because it replaces
//! the whole content, which is what editors do. Emptying a grub via the mount is
//! also a no-op by design (see write()); use `rm` to remove one.
//!
//! Wire (HTTP only — the generic API is not on lick):
//!   GET  /grubbery/api/tree/<root>            -> {neck, files:{name:mark}, dirs:{name:{...}}}
//!   GET  /grubbery/api/file/<root>/<rel>?blot=/txt   -> the grub's text form (edit-consistent)
//!   GET  /grubbery/api/file/<root>/<rel>?blot=/json  -> semantic value, when there's no text tube
//!   POST /grubbery/mcp  (edit_file / delete_grub)    -> in-place overwrite / remove
//! `/txt` is read first: it's what edit_file overwrites, and a mark with no text
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

    /// Call a grubbery MCP tool over HTTP. Returns Ok on success; maps a JSON-RPC
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
        // structure only; sizes are filled by dump() (which the core warms from).
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
                readonly: is_dir, // files editable in place; dirs aren't
            })
            .collect())
    }

    fn read(&self, rel: &str) -> Result<Vec<u8>, PErr> {
        // /txt is the grub's text form: readable AND exactly what edit_file matches,
        // so read and write stay consistent. A mark with no text tube returns a
        // clean 400 ("No tube") — fall back to /json for a semantic, read-only view
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
        // No bulk endpoint for a generic tree: walk it, then read each grub (read()
        // picks /txt, falling back to /json — small, not the raw jam). A grub that
        // won't render gets a placeholder so the tree stays browsable.
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
            // edit_file (a diff, not a set) can't rebuild a grub from empty — so
            // honoring the empty commit would wipe it and the next commit couldn't
            // recover. Skip it; the following commit carries the real content.
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
        // Folders need delete_folder — delete_grub silently no-ops on them (it
        // even claims "Deleted"). Only empty dirs get here: the core's rmdir
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

    // A generic grub has no lattice kind; present everything as .txt so grep/cat
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
    use super::split_rel;

    #[test]
    fn split_rel_roots_and_nests() {
        let root = "apps/foo.foo_app";
        assert_eq!(split_rel(root, "grub"), ("/apps/foo.foo_app".into(), "grub".into()));
        assert_eq!(
            split_rel(root, "sub/dir/grub"),
            ("/apps/foo.foo_app/sub/dir".into(), "grub".into())
        );
    }
}
