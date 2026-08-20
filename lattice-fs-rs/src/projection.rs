//! The projection seam: a Node view of one grubbery app's tree, plus the
//! Projection trait the core drives. All app semantics live in an impl
//! (see lattice.rs); the core never names markdown, hoon, or a route.

use std::collections::HashMap;

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

/// One bulk warm: the whole node tree plus every page body, keyed by rel.
/// Named because the tuple is spelled out at every dump() impl and parse site.
pub type Dump = (Vec<Node>, HashMap<String, Vec<u8>>);

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
    /// Our ship @p (e.g. "~tyr"), for the mount banner.
    fn ship(&self) -> String;

    fn list(&self) -> Result<Vec<Node>, PErr>;
    fn read(&self, rel: &str) -> Result<Vec<u8>, PErr>;

    /// Bulk warm: the whole tree AND every page body in one round-trip. The core
    /// calls this to fill the read cache so grep/cat run from RAM. lattice serves
    /// it from a single page-dump peek, falling back to list()+read() on an old
    /// nexus that lacks the route.
    fn dump(&self) -> Result<Dump, PErr>;

    fn errors(&self, rel: &str) -> Result<String, PErr>;
    fn write(&self, rel: &str, kind: &str, data: &[u8], create: bool) -> Result<(), PErr>;
    fn mkdir(&self, rel: &str) -> Result<(), PErr>;
    fn delete(&self, rel: &str) -> Result<(), PErr>;
    fn mv(&self, src: &str, dst: &str) -> Result<(), PErr>;

    /// Block, calling `on_event` for external changes and for the health of
    /// the watch stream itself. Delegates to the transport. The core trusts
    /// a live stream over its TTL clock, so `Up`/`Down` matter as much as
    /// `Changed` — see WatchEvent in transport.rs.
    fn watch(&self, on_event: &(dyn Fn(crate::transport::WatchEvent) + Send + Sync));

    // kind<->ext policy. Shared for lattice; another app overrides.
    // The browser holds the same table as KIND_EXT/EXT_KIND in
    // ui-app/src/30-tree.js (and a twin in ui-app/vault.js). No build step
    // joins the two languages, so a new kind has to be added on both sides.
    // One difference is deliberate: kind_for_ext answers hoon for anything
    // it does not know, because every file on a mounted disk must get some
    // kind, while the browser's extKind answers null and skips the file.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::TErr;

    /// Nothing but the trait's provided methods, which is what's under test.
    struct Bare;
    impl Projection for Bare {
        fn ship(&self) -> String {
            "~test".into()
        }
        fn list(&self) -> Result<Vec<Node>, PErr> {
            Ok(vec![])
        }
        fn read(&self, _rel: &str) -> Result<Vec<u8>, PErr> {
            Ok(vec![])
        }
        fn dump(&self) -> Result<Dump, PErr> {
            Ok((vec![], HashMap::new()))
        }
        fn errors(&self, _rel: &str) -> Result<String, PErr> {
            Ok(String::new())
        }
        fn write(&self, _: &str, _: &str, _: &[u8], _: bool) -> Result<(), PErr> {
            Ok(())
        }
        fn mkdir(&self, _rel: &str) -> Result<(), PErr> {
            Ok(())
        }
        fn delete(&self, _rel: &str) -> Result<(), PErr> {
            Ok(())
        }
        fn mv(&self, _s: &str, _d: &str) -> Result<(), PErr> {
            Ok(())
        }
        fn watch(&self, _on_event: &(dyn Fn(crate::transport::WatchEvent) + Send + Sync)) {}
    }

    #[test]
    fn kind_and_ext_round_trip_for_every_page_type() {
        // the ext decides the FILENAME the tree exposes and the kind decides the
        // mark a save is stored under, so the two must stay inverses. A broken
        // pair either hides a page or stores it as the wrong type.
        let p = Bare;
        for (kind, ext) in
            [("md", "md"), ("gmi", "gmi"), ("html", "html"), ("text", "txt"), ("js", "js"), ("css", "css")]
        {
            assert_eq!(p.ext_for_kind(kind), ext, "kind {kind}");
            assert_eq!(p.kind_for_ext(ext), kind, "ext {ext}");
        }
        // a generated %index page is served as .md (it renders markdown) but is
        // deliberately NOT invertible: .md always means an editable md page
        assert_eq!(p.ext_for_kind("index"), "md");
        // everything else is a bare hoon page, in both directions
        assert_eq!(p.ext_for_kind("hoon"), "hoon");
        assert_eq!(p.ext_for_kind("something-new"), "hoon");
        assert_eq!(p.kind_for_ext("hoon"), "hoon");
        assert_eq!(p.kind_for_ext("something-new"), "hoon");
    }

    #[test]
    fn a_transport_status_maps_to_the_errno_the_shell_acts_on() {
        // these drive real behaviour: ENOENT is "no such file", EEXIST makes an
        // atomic save fall back to overwrite, EACCES tells the caller to
        // re-auth instead of retrying forever.
        for (code, errno) in [
            (400, libc::EINVAL),
            (401, libc::EACCES),
            (403, libc::EACCES),
            (404, libc::ENOENT),
            (409, libc::EEXIST),
            (500, libc::EIO),
            (418, libc::EIO),
            (0, libc::EIO),
        ] {
            let p: PErr = TErr::new(code, "server said no").into();
            assert_eq!(p.errno, errno, "http {code}");
            assert_eq!(p.msg, "server said no", "the server's message must survive");
        }
    }
}
