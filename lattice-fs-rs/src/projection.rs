//! The projection seam: a Node view of one grubbery app's tree, plus the
//! Projection trait the core drives. All app semantics live in an impl
//! (see lattice.rs); the core never names markdown, hoon, or a route.

use crate::transport::TErr;

/// A projection failure carrying a POSIX errno for the core to return to FUSE.
#[derive(Debug)]
pub struct PErr {
    pub errno: i32,
    pub msg: String,
}

impl PErr {
    pub fn new(errno: i32, msg: impl Into<String>) -> Self {
        Self { errno, msg: msg.into() }
    }
}

impl From<TErr> for PErr {
    fn from(e: TErr) -> Self {
        let errno = match e.code {
            400 => libc::EINVAL,
            401 | 403 => libc::EACCES,
            404 => libc::ENOENT,
            409 => libc::EEXIST,
            _ => libc::EIO,
        };
        PErr { errno, msg: e.msg }
    }
}

#[derive(Clone, Debug)]
pub struct Node {
    pub rel: String,     // projection key, no leading slash, no extension ("" = root)
    pub is_dir: bool,    // a plain folder (no editable source)
    pub is_page: bool,   // has editable source; MAY also parent children
    pub kind: String,    // md|gmi|html|text|js|css|hoon|index  ("" for a pure dir)
    pub size: u64,       // byte length of the editable body
    pub mtime: i64,      // unix seconds
    pub readonly: bool,  // generated %index pages
}

pub trait Projection: Send + Sync {
    fn list(&self) -> Result<Vec<Node>, PErr>;
    fn read(&self, rel: &str) -> Result<Vec<u8>, PErr>;
    fn errors(&self, rel: &str) -> Result<String, PErr>;
    fn write(&self, rel: &str, kind: &str, data: &[u8], create: bool) -> Result<(), PErr>;
    fn mkdir(&self, rel: &str) -> Result<(), PErr>;
    fn delete(&self, rel: &str) -> Result<(), PErr>;
    fn mv(&self, src: &str, dst: &str) -> Result<(), PErr>;

    /// Block, calling `on_change` when the tree changes externally. Delegates to
    /// the transport (lick pushes; Eyre is a no-op and the core's TTL poll wins).
    fn watch(&self, on_change: &(dyn Fn() + Send + Sync));

    // kind<->ext policy. Shared for lattice; another app overrides.
    fn ext_for_kind(&self, kind: &str) -> &'static str {
        match kind {
            "md" => "md",
            "gmi" => "gmi",
            "html" => "html",
            "text" => "txt",
            "js" => "js",
            "css" => "css",
            "index" => "md",
            _ => "hoon",
        }
    }
    fn kind_for_ext(&self, ext: &str) -> String {
        match ext {
            "md" => "md",
            "gmi" => "gmi",
            "html" => "html",
            "txt" => "text",
            "js" => "js",
            "css" => "css",
            _ => "hoon",
        }
        .to_string()
    }
}
