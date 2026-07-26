//! GenericProjection: mount ANY grubbery ball tree (another nexus, an arbitrary
//! sub-path) — not just lattice's /page. Read-only for now: it browses/reads via
//! grubbery's generic ball API (no lattice route knowledge), so grep/cat work
//! over any nexus. Writes are refused (EROFS); weir-governed writes are a
//! deliberate follow-up (encoding edited bytes back into a grub's mark without
//! corrupting it needs per-mark care).
//!
//! Wire (HTTP only — the generic API is not on lick):
//!   GET /grubbery/api/tree/<root>            -> {neck, files:{name:mark}, dirs:{name:{...}}}
//!   GET /grubbery/api/file/<root>/<rel>?blot=/json  -> the grub's semantic value
//! `?blot=/json` gives the small, useful form (an @t grub's source, a struct's
//! json) rather than the multi-MB raw jam (which carries the compiled core).

use std::collections::HashMap;

use serde_json::Value;

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
                readonly: true,
            })
            .collect())
    }

    fn read(&self, rel: &str) -> Result<Vec<u8>, PErr> {
        let raw = self.t.get_bytes(&self.file_path(rel), &[("blot", "/json")])?;
        // The value is JSON. A JSON string (an @t grub: source/text) -> its raw
        // text; anything structured -> the JSON as text (still grep/cat-friendly).
        match serde_json::from_slice::<Value>(&raw) {
            Ok(Value::String(s)) => Ok(s.into_bytes()),
            Ok(v) => Ok(v.to_string().into_bytes()),
            Err(_) => Ok(raw), // not JSON — serve the bytes as-is
        }
    }

    fn dump(&self) -> Result<(Vec<Node>, HashMap<String, Vec<u8>>), PErr> {
        // No bulk endpoint for a generic tree: walk it, then read each grub via
        // ?blot=/json (small — the semantic value, not the raw jam). A grub that
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
                readonly: true,
            });
        }
        Ok((nodes, bodies))
    }

    fn errors(&self, _rel: &str) -> Result<String, PErr> {
        Ok(String::new()) // no per-page evaluator errors in a generic tree
    }

    fn write(&self, _rel: &str, _kind: &str, _data: &[u8], _create: bool) -> Result<(), PErr> {
        Err(PErr::new(libc::EROFS, "generic ball mount is read-only"))
    }

    fn mkdir(&self, _rel: &str) -> Result<(), PErr> {
        Err(PErr::new(libc::EROFS, "generic ball mount is read-only"))
    }

    fn delete(&self, _rel: &str) -> Result<(), PErr> {
        Err(PErr::new(libc::EROFS, "generic ball mount is read-only"))
    }

    fn mv(&self, _src: &str, _dst: &str) -> Result<(), PErr> {
        Err(PErr::new(libc::EROFS, "generic ball mount is read-only"))
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
