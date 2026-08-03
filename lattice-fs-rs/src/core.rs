//! GrubberyFs: the generic FUSE filesystem, driven entirely by a Projection.
//!
//! fuser is inode-based, so we keep an ino<->path table on top of a virtual
//! tree (vpath -> entry) built once per 5s from projection.list(). Writes buffer
//! in a per-fh handle and POST once on flush (one :w = one page-save). All state
//! is behind one Mutex (fuser calls methods on &self, possibly concurrently).
//! HTTP calls happen OUTSIDE the lock so a slow save never blocks the mutex.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fuser::{
    BsdFileFlags, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation,
    INodeNo, LockOwner, OpenFlags, RenameFlags, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory,
    ReplyEmpty, ReplyEntry, ReplyOpen, ReplyWrite, Request, TimeOrNow, WriteFlags,
};

use crate::projection::{Node, PErr, Projection};

const TTL: Duration = Duration::from_secs(1); // kernel entry/dir-attr cache
// Files get a zero attr cache so the kernel re-stats before it computes an
// O_APPEND offset from the size. Otherwise an append within TTL of a prior write
// seeks to a stale EOF and corrupts the file. Cheap: getattr is served from RAM
// and the read hot-path uses the body cache, not stat.
const FILE_TTL: Duration = Duration::from_secs(0);
const TREE_TTL: Duration = Duration::from_secs(5);
const RECENT_TTL: Duration = Duration::from_secs(10); // grace window for the recent-mutation ledger // our vtree refresh floor (watch() is a no-op, so this is the only floor)
const READ_CACHE_MAX: usize = 256 * 1024 * 1024; // body-cache ceiling. Past it, degrade to lazy read

#[derive(Clone, Copy, PartialEq)]
enum VKind {
    Dir,
    File,
}

#[derive(Clone)]
struct VEntry {
    kind: VKind,
    node: Option<Node>, // None for synthesized dirs / root
}

struct Handle {
    rel: String, // page rel, OR the vpath for a scratch handle
    kind: String,
    buf: Vec<u8>,
    dirty: bool,
    new: bool,
    scratch: bool, // an editor temp file: commit to the scratch map, never the ship
}

struct State {
    to_path: HashMap<u64, String>, // ino -> vpath ("/demo/hello.md"); 1 = "/"
    to_ino: HashMap<String, u64>,
    next_ino: u64,
    vt: HashMap<String, VEntry>, // vpath -> entry
    vt_ts: Option<Instant>,
    read_cache: HashMap<String, Vec<u8>>, // rel -> bytes
    read_cache_bytes: usize,              // running total, for the READ_CACHE_MAX ceiling
    warm: bool,                           // a dump has landed at least once
    refresh_pending: bool,                // a background refresh is already in flight
    write_gen: u64,                       // bumped on every mutation. Guards stale dump swaps
    handles: HashMap<u64, Handle>,        // fh -> handle
    next_fh: u64,
    pending_trunc: HashMap<u64, u64>, // ino -> size (handle-less truncate deferred to open)
    scratch: HashMap<String, Vec<u8>>, // vpath -> bytes for ephemeral editor temp files
    // vpath -> (when, alive). The ship acks a save before a BRAND-NEW page is
    // visible to page-dump, so a snapshot taken in that window lacks it (and,
    // symmetrically, may still carry a just-deleted one). Swaps consult this
    // ledger. Within RECENT_TTL a snapshot can't evict a created entry or
    // resurrect a deleted one. Entries age out. Steady state is empty.
    recent: HashMap<String, (Instant, bool)>,
}

pub struct GrubberyFs {
    proj: Arc<dyn Projection>,
    st: Arc<Mutex<State>>,
    uid: u32,
    gid: u32,
}

impl GrubberyFs {
    pub fn new(proj: Arc<dyn Projection>) -> Self {
        let mut to_path = HashMap::new();
        let mut to_ino = HashMap::new();
        to_path.insert(1u64, "/".to_string());
        to_ino.insert("/".to_string(), 1u64);
        let st = Arc::new(Mutex::new(State {
            to_path,
            to_ino,
            next_ino: 2,
            vt: HashMap::new(),
            vt_ts: None,
            read_cache: HashMap::new(),
            read_cache_bytes: 0,
            warm: false,
            refresh_pending: false,
            write_gen: 0,
            handles: HashMap::new(),
            next_fh: 1,
            pending_trunc: HashMap::new(),
            scratch: HashMap::new(),
            recent: HashMap::new(),
        }));
        // watch thread: invalidate on external change. Best-effort (Eyre is a
        // no-op). The 5s TTL poll is the guaranteed freshness floor.
        let wst = st.clone();
        let wproj = proj.clone();
        std::thread::spawn(move || {
            let on_change = move || {
                if let Ok(mut s) = wst.lock() {
                    s.vt_ts = None;
                    s.read_cache.clear();
                    s.read_cache_bytes = 0; // else the stale total blocks re-caching
                }
            };
            wproj.watch(&on_change);
        });
        // warm thread: one page-dump seeds the whole vtree + every body up front,
        // so grep/cat run from RAM. Async. new() returns immediately. If a FUSE op
        // beats it, ensure_fresh() cold-blocks on the same one dump (not N reads).
        // Generation-guarded: if that cold path won AND a write already landed, this
        // (older) snapshot must not swap in and resurrect the pre-write body.
        let west = st.clone();
        let wproj2 = proj.clone();
        std::thread::spawn(move || {
            let start_gen = west.lock().unwrap().write_gen;
            if let Ok((nodes, bodies)) = wproj2.dump() {
                let vt = build_vt(&nodes, |k| wproj2.ext_for_kind(k));
                let (cache, bytes) = cap_bodies(bodies, READ_CACHE_MAX);
                let mut s = west.lock().unwrap();
                if s.write_gen == start_gen {
                    apply_swap(&mut s, vt, cache, bytes);
                }
            }
        });
        GrubberyFs {
            proj,
            st,
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
        }
    }

    /// Freshness on the FUSE path WITHOUT blocking it. Cold start (nothing warm
    /// yet) blocks once on a single dump so the first op isn't empty. Steady state
    /// serves the current (possibly stale) vtree and kicks a background dump when
    /// past TREE_TTL, coalesced by refresh_pending. The background swap is
    /// discarded if a write moved write_gen while the dump was in flight. Else a
    /// stale snapshot would resurrect an edited body or a just-deleted entry.
    fn ensure_fresh(&self) {
        if !self.st.lock().unwrap().warm {
            return self.refresh_blocking();
        }
        let go = {
            let mut s = self.st.lock().unwrap();
            let stale = s.vt_ts.map_or(true, |t| t.elapsed() > TREE_TTL);
            if stale && !s.refresh_pending {
                s.refresh_pending = true;
                true
            } else {
                false
            }
        };
        if !go {
            return; // serve the current vtree, zero network on the FUSE path
        }
        let st = self.st.clone();
        let proj = self.proj.clone();
        std::thread::spawn(move || {
            let start_gen = st.lock().unwrap().write_gen;
            let built = proj.dump().map(|(nodes, bodies)| {
                let vt = build_vt(&nodes, |k| proj.ext_for_kind(k));
                let (cache, bytes) = cap_bodies(bodies, READ_CACHE_MAX);
                (vt, cache, bytes)
            });
            let mut s = st.lock().unwrap();
            s.refresh_pending = false;
            if let Ok((vt, cache, bytes)) = built {
                if s.write_gen == start_gen {
                    apply_swap(&mut s, vt, cache, bytes);
                }
            }
        });
    }

    /// Cold path only: block until the first dump lands (mount just came up). No-op
    /// if the warm thread already won the race.
    fn refresh_blocking(&self) {
        if self.st.lock().unwrap().warm {
            return;
        }
        if let Ok((nodes, bodies)) = self.proj.dump() {
            let vt = build_vt(&nodes, |k| self.proj.ext_for_kind(k));
            let (cache, bytes) = cap_bodies(bodies, READ_CACHE_MAX);
            let mut s = self.st.lock().unwrap();
            apply_swap(&mut s, vt, cache, bytes);
        }
    }

    /// Read-through body cache. Fetches OUTSIDE the lock. After a warm dump every
    /// rel is already present, so this fetch only fires for a page created since
    /// the last dump. Skip-past-cap: always serve the bytes, but stop caching once
    /// past READ_CACHE_MAX so an oversized tree degrades to lazy read, never OOMs.
    fn body(&self, rel: &str) -> Result<Vec<u8>, PErr> {
        if let Some(b) = self.st.lock().unwrap().read_cache.get(rel) {
            return Ok(b.clone());
        }
        let data = self.proj.read(rel)?;
        let mut s = self.st.lock().unwrap();
        // re-check under the lock. A concurrent body() for the same rel may have
        // fetched and inserted while we were on the wire. Inserting again would
        // double-count the bytes and slowly rot the cap accounting.
        if !s.read_cache.contains_key(rel) {
            let add = rel.len() + data.len();
            if s.read_cache_bytes + add <= READ_CACHE_MAX {
                s.read_cache_bytes += add;
                s.read_cache.insert(rel.to_string(), data.clone());
            }
        }
        Ok(data)
    }

    /// FS vpath -> (projection rel, kind). Strips the extension; maps a
    /// page-with-children body file (<dir>/<leaf>.<ext>) back to the parent rel.
    fn rel_kind_of(&self, s: &State, path: &str) -> (String, String) {
        let p = path.trim_start_matches('/');
        let (parent, leaf) = match p.rfind('/') {
            Some(i) => (&p[..i], &p[i + 1..]),
            None => ("", p),
        };
        let (stem, ext) = match leaf.rfind('.') {
            Some(i) => (&leaf[..i], &leaf[i + 1..]),
            None => (leaf, ""),
        };
        let kind = if ext.is_empty() {
            "hoon".to_string()
        } else {
            self.proj.kind_for_ext(ext)
        };
        if !parent.is_empty() {
            let parent_leaf = parent.rsplit('/').next().unwrap();
            if stem == parent_leaf {
                if let Some(VEntry { kind: VKind::Dir, node: Some(n) }) =
                    s.vt.get(&format!("/{}", parent))
                {
                    if n.is_page {
                        return (parent.to_string(), kind);
                    }
                }
            }
        }
        let rel = if parent.is_empty() {
            stem.to_string()
        } else {
            format!("{}/{}", parent, stem)
        };
        (rel, kind)
    }

    fn mk_attr(&self, ino: u64, e: &VEntry, size_override: Option<u64>) -> FileAttr {
        let now = SystemTime::now();
        match e.kind {
            VKind::Dir => {
                let mtime = e.node.as_ref().map(|n| to_systime(n.mtime)).unwrap_or(now);
                dir_attr(ino, mtime, self.uid, self.gid)
            }
            VKind::File => {
                let n = e.node.as_ref().unwrap();
                let size = size_override.unwrap_or(n.size);
                file_attr(ino, size, to_systime(n.mtime), n.readonly, self.uid, self.gid)
            }
        }
    }

    /// Commit an fh's buffer through the projection (one POST), then invalidate.
    fn commit(&self, fh: u64) -> Result<(), PErr> {
        let (rel, kind, buf, new, scratch) = {
            let s = self.st.lock().unwrap();
            match s.handles.get(&fh) {
                Some(h) if h.dirty => (h.rel.clone(), h.kind.clone(), h.buf.clone(), h.new, h.scratch),
                _ => return Ok(()),
            }
        };
        // scratch handle: persist to the in-memory map, never the ship. rel is
        // the vpath for a scratch handle.
        if scratch {
            let mut s = self.st.lock().unwrap();
            s.scratch.insert(rel, buf);
            if let Some(h) = s.handles.get_mut(&fh) {
                h.dirty = false;
                h.new = false;
            }
            return Ok(());
        }
        self.proj.write(&rel, &kind, &buf, new)?;
        let mut s = self.st.lock().unwrap();
        if let Some(h) = s.handles.get_mut(&fh) {
            h.dirty = false;
            h.new = false;
        }
        publish(&mut s, &rel, &buf);
        Ok(())
    }
}

/// The bytes just accepted by the ship ARE the page's content now. Republish
/// them locally instead of waiting for the async re-dump:
///
///  - the vt node's size, because stat would otherwise report the pre-write
///    size (create() seeds 0) and the kernel computes an O_APPEND offset from
///    it. An append right after a write would land at the wrong offset and
///    overwrite instead of append;
///  - write_gen, so an in-flight dump swap can't undo this write;
///  - the body cache, installed rather than evicted, so a read inside the
///    ship's brief post-save window never sees stale bytes (and a post-write
///    read skips the round trip entirely).
///
/// Every path that persists bytes has to do this. Doing it on the ordinary
/// flush but not on an editor's atomic-save rename left that save one refresh
/// behind: the file read back as its PREVIOUS content.
fn publish(s: &mut State, rel: &str, buf: &[u8]) {
    let n = buf.len() as u64;
    let mt = now_secs();
    for e in s.vt.values_mut() {
        if e.kind == VKind::File {
            if let Some(node) = e.node.as_mut() {
                if node.rel == rel {
                    node.size = n;
                    node.mtime = mt;
                }
            }
        }
    }
    s.vt_ts = None;
    s.write_gen += 1;
    match s.read_cache.insert(rel.to_string(), buf.to_vec()) {
        Some(old) => {
            s.read_cache_bytes = s.read_cache_bytes.saturating_sub(old.len()) + buf.len();
        }
        None => s.read_cache_bytes += rel.len() + buf.len(),
    }
}

// ---------- free helpers ----------

/// Editor scratch/temp files that must NEVER map onto a page. A backup like
/// `foo.md~` otherwise resolves (last-dot strip) to page `foo`, so removing the
/// backup deletes the page, the sidecar data-loss bug. Rule: a known page
/// extension, or no extension (a bare hoon page), is a real file. Anything
/// else (an unknown extension, or a trailing `~`) is an editor temp, handled
/// ephemerally in the FUSE layer and never sent to the ship. Covers vim/emacs
/// backups (`foo.md~`), swap files (`.foo.md.swp`), and atomic-save temps.
fn is_scratch(name: &str) -> bool {
    if name.ends_with('~') {
        return true;
    }
    match name.rsplit_once('.') {
        Some((_, ext)) => !matches!(ext, "md" | "gmi" | "html" | "txt" | "js" | "css" | "hoon"),
        None => false,
    }
}

/// The leaf (filename) of a vpath.
fn leaf_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn err(e: i32) -> Errno {
    Errno::from_i32(e)
}

fn join(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{}", name)
    } else {
        format!("{}/{}", parent, name)
    }
}

fn ino_for(s: &mut State, path: &str) -> u64 {
    if let Some(&i) = s.to_ino.get(path) {
        return i;
    }
    let i = s.next_ino;
    s.next_ino += 1;
    s.to_ino.insert(path.to_string(), i);
    s.to_path.insert(i, path.to_string());
    i
}

fn to_systime(secs: i64) -> SystemTime {
    if secs <= 0 {
        SystemTime::now()
    } else {
        UNIX_EPOCH + Duration::from_secs(secs as u64)
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// An open handle's buffer is the authoritative current content (loaded fresh via
// body() at open, or truncated/written since). Report its length regardless of
// the dirty flag. The vtree node's size can lag a write (the re-dump is async), so
// an append that opened right after a write would otherwise seek to a stale offset
// and corrupt the file.
fn open_size(s: &State, rel: &str) -> Option<u64> {
    s.handles.values().find(|h| h.rel == rel).map(|h| h.buf.len() as u64)
}

fn dir_attr(ino: u64, mtime: SystemTime, uid: u32, gid: u32) -> FileAttr {
    let now = SystemTime::now();
    FileAttr {
        ino: INodeNo(ino),
        size: 0,
        blocks: 0,
        atime: now,
        mtime,
        ctime: mtime,
        crtime: mtime,
        kind: FileType::Directory,
        perm: 0o755,
        nlink: 2,
        uid,
        gid,
        rdev: 0,
        blksize: 4096,
        flags: 0,
    }
}

fn file_attr(ino: u64, size: u64, mtime: SystemTime, readonly: bool, uid: u32, gid: u32) -> FileAttr {
    let now = SystemTime::now();
    FileAttr {
        ino: INodeNo(ino),
        size,
        blocks: size.div_ceil(512),
        atime: now,
        mtime,
        ctime: mtime,
        crtime: mtime,
        kind: FileType::RegularFile,
        perm: if readonly { 0o444 } else { 0o644 },
        nlink: 1,
        uid,
        gid,
        rdev: 0,
        blksize: 4096,
        flags: 0,
    }
}

/// Build the virtual tree from a node list (port of the Python _build).
/// Cap a warm dump's bodies at `limit` bytes so a large tree can't OOM the
/// client. Keep bodies until the running total would exceed the cap, drop the
/// rest (body() lazily fetches those on demand). Deterministic across runs by
/// caching smallest-first, so the cache holds as many whole files as fit.
fn cap_bodies(bodies: HashMap<String, Vec<u8>>, limit: usize) -> (HashMap<String, Vec<u8>>, usize) {
    let mut entries: Vec<(String, Vec<u8>)> = bodies.into_iter().collect();
    entries.sort_by_key(|(k, b)| (k.len() + b.len(), k.clone()));
    let mut out = HashMap::new();
    let mut bytes = 0usize;
    for (k, b) in entries {
        let add = k.len() + b.len();
        if bytes + add > limit {
            continue;
        }
        bytes += add;
        out.insert(k, b);
    }
    (out, bytes)
}

/// Install a freshly-dumped snapshot, as a MERGE, not a blind replace. The
/// recent-mutation ledger overrides the snapshot both ways. A just-created
/// entry the (lagging) snapshot lacks is carried forward from the old vt,
/// with its cached body. A just-deleted one it still carries is stripped.
fn apply_swap(
    s: &mut State,
    mut vt: HashMap<String, VEntry>,
    mut cache: HashMap<String, Vec<u8>>,
    mut bytes: usize,
) {
    s.recent.retain(|_, (t, _)| t.elapsed() < RECENT_TTL);
    for (path, (_, alive)) in &s.recent {
        if *alive {
            if !vt.contains_key(path) {
                if let Some(e) = s.vt.get(path) {
                    vt.insert(path.clone(), e.clone());
                }
            }
            // carry the cached body when the snapshot has none for this rel.
            // The old cache holds the exact bytes of the recent write.
            if let Some(rel) = vt.get(path).and_then(|e| e.node.as_ref()).map(|n| n.rel.clone()) {
                if !cache.contains_key(&rel) {
                    if let Some(b) = s.read_cache.get(&rel) {
                        bytes += rel.len() + b.len();
                        cache.insert(rel, b.clone());
                    }
                }
            }
        } else if let Some(gone) = vt.remove(path) {
            if let Some(n) = gone.node {
                if let Some(b) = cache.remove(&n.rel) {
                    bytes = bytes.saturating_sub(n.rel.len() + b.len());
                }
            }
        }
    }
    s.vt = vt;
    s.vt_ts = Some(Instant::now());
    s.read_cache = cache;
    s.read_cache_bytes = bytes;
    s.warm = true;
}

fn build_vt(nodes: &[Node], ext_for: impl Fn(&str) -> &'static str) -> HashMap<String, VEntry> {
    let parents: HashSet<&str> = nodes
        .iter()
        .filter_map(|n| n.rel.rfind('/').map(|i| &n.rel[..i]))
        .collect();
    let mut vt: HashMap<String, VEntry> = HashMap::new();
    vt.insert("/".to_string(), VEntry { kind: VKind::Dir, node: None });
    for n in nodes {
        if n.rel.is_empty() {
            continue;
        }
        let segs: Vec<&str> = n.rel.split('/').collect();
        for i in 1..segs.len() {
            let d = format!("/{}", segs[..i].join("/"));
            vt.entry(d).or_insert(VEntry { kind: VKind::Dir, node: None });
        }
        if n.is_dir {
            vt.insert(format!("/{}", n.rel), VEntry { kind: VKind::Dir, node: Some(n.clone()) });
        } else if parents.contains(n.rel.as_str()) {
            // page-with-children: a dir whose own body is <dir>/<leaf>.<ext>
            vt.insert(format!("/{}", n.rel), VEntry { kind: VKind::Dir, node: Some(n.clone()) });
            let leaf = n.rel.rsplit('/').next().unwrap();
            vt.insert(
                format!("/{}/{}.{}", n.rel, leaf, ext_for(&n.kind)),
                VEntry { kind: VKind::File, node: Some(n.clone()) },
            );
        } else {
            vt.insert(
                format!("/{}.{}", n.rel, ext_for(&n.kind)),
                VEntry { kind: VKind::File, node: Some(n.clone()) },
            );
        }
    }
    vt
}

// ---------- the FUSE surface ----------

impl Filesystem for GrubberyFs {
    fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        self.ensure_fresh();
        let name = name.to_string_lossy().to_string();
        let mut s = self.st.lock().unwrap();
        let parent_path = match s.to_path.get(&parent.0) {
            Some(p) => p.clone(),
            None => {
                reply.error(err(libc::ENOENT));
                return;
            }
        };
        let child = join(&parent_path, &name);
        // scratch file: it lives in the map, not the vtree.
        if is_scratch(&name) {
            match s.scratch.get(&child) {
                Some(bytes) => {
                    let sz = bytes.len() as u64;
                    let ino = ino_for(&mut s, &child);
                    drop(s);
                    let attr = file_attr(ino, sz, SystemTime::now(), false, self.uid, self.gid);
                    reply.entry(&TTL, &attr, Generation(0));
                }
                None => reply.error(err(libc::ENOENT)),
            }
            return;
        }
        let e = match s.vt.get(&child).cloned() {
            Some(e) => e,
            None => {
                reply.error(err(libc::ENOENT));
                return;
            }
        };
        let ino = ino_for(&mut s, &child);
        let ov = if e.kind == VKind::File {
            let (rel, _) = self.rel_kind_of(&s, &child);
            open_size(&s, &rel)
        } else {
            None
        };
        let ttl = if e.kind == VKind::File { &FILE_TTL } else { &TTL };
        drop(s);
        let attr = self.mk_attr(ino, &e, ov);
        reply.entry(ttl, &attr, Generation(0));
    }

    fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        self.ensure_fresh();
        let s = self.st.lock().unwrap();
        let path = match s.to_path.get(&ino.0) {
            Some(p) => p.clone(),
            None => {
                reply.error(err(libc::ENOENT));
                return;
            }
        };
        if is_scratch(leaf_of(&path)) {
            match s.scratch.get(&path) {
                Some(bytes) => {
                    let sz = bytes.len() as u64;
                    drop(s);
                    let attr = file_attr(ino.0, sz, SystemTime::now(), false, self.uid, self.gid);
                    reply.attr(&TTL, &attr);
                }
                None => reply.error(err(libc::ENOENT)),
            }
            return;
        }
        let e = match s.vt.get(&path).cloned() {
            Some(e) => e,
            None => {
                reply.error(err(libc::ENOENT));
                return;
            }
        };
        let ov = if e.kind == VKind::File {
            let (rel, _) = self.rel_kind_of(&s, &path);
            open_size(&s, &rel)
        } else {
            None
        };
        let ttl = if e.kind == VKind::File { &FILE_TTL } else { &TTL };
        drop(s);
        let attr = self.mk_attr(ino.0, &e, ov);
        reply.attr(ttl, &attr);
    }

    #[allow(clippy::too_many_arguments)]
    fn setattr(
        &self,
        _req: &Request,
        ino: INodeNo,
        _mode: Option<u32>,
        _uid: Option<u32>,
        _gid: Option<u32>,
        size: Option<u64>,
        _atime: Option<TimeOrNow>,
        _mtime: Option<TimeOrNow>,
        _ctime: Option<SystemTime>,
        fh: Option<FileHandle>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        self.ensure_fresh();
        let mut s = self.st.lock().unwrap();
        let path = match s.to_path.get(&ino.0) {
            Some(p) => p.clone(),
            None => {
                reply.error(err(libc::ENOENT));
                return;
            }
        };
        if let Some(sz) = size {
            // 1) explicit fh -> truncate that buffer
            let mut done = false;
            if let Some(fhv) = fh {
                if let Some(h) = s.handles.get_mut(&fhv.0) {
                    resize(&mut h.buf, sz);
                    h.dirty = true;
                    done = true;
                }
            }
            // 2) an open handle for this file's rel (editor truncated without the fh)
            if !done {
                let (rel, _) = self.rel_kind_of(&s, &path);
                if let Some((&hfh, _)) = s.handles.iter().find(|(_, h)| h.rel == rel) {
                    let h = s.handles.get_mut(&hfh).unwrap();
                    resize(&mut h.buf, sz);
                    h.dirty = true;
                    done = true;
                }
            }
            // 3) handle-less -> defer to the next open() (the `>`/O_TRUNC path)
            if !done {
                s.pending_trunc.insert(ino.0, sz);
            }
        }
        let e = match s.vt.get(&path).cloned() {
            Some(e) => e,
            None => {
                reply.error(err(libc::ENOENT));
                return;
            }
        };
        drop(s);
        let attr = self.mk_attr(ino.0, &e, size);
        reply.attr(&TTL, &attr);
    }

    fn readdir(
        &self,
        _req: &Request,
        ino: INodeNo,
        _fh: FileHandle,
        offset: u64,
        mut reply: ReplyDirectory,
    ) {
        self.ensure_fresh();
        let mut s = self.st.lock().unwrap();
        let base = match s.to_path.get(&ino.0) {
            Some(p) => p.clone(),
            None => {
                reply.error(err(libc::ENOENT));
                return;
            }
        };
        let parent_ino = if base == "/" {
            1
        } else {
            let pp = match base.rfind('/') {
                Some(0) => "/",
                Some(i) => &base[..i],
                None => "/",
            };
            *s.to_ino.get(pp).unwrap_or(&1)
        };
        let mut kids: Vec<(String, FileType)> = s
            .vt
            .iter()
            .filter_map(|(vp, e)| {
                if vp == "/" {
                    return None;
                }
                let par = match vp.rfind('/') {
                    Some(0) => "/".to_string(),
                    Some(i) => vp[..i].to_string(),
                    None => "/".to_string(),
                };
                if par == base {
                    let ft = match e.kind {
                        VKind::Dir => FileType::Directory,
                        VKind::File => FileType::RegularFile,
                    };
                    Some((vp.clone(), ft))
                } else {
                    None
                }
            })
            .collect();
        // editor temp files live in the scratch map, not the vtree. List them too
        // so an editor sees its own backup/swap while it's working.
        for vp in s.scratch.keys() {
            let par = match vp.rfind('/') {
                Some(0) => "/".to_string(),
                Some(i) => vp[..i].to_string(),
                None => "/".to_string(),
            };
            if par == base {
                kids.push((vp.clone(), FileType::RegularFile));
            }
        }
        kids.sort_by(|a, b| a.0.cmp(&b.0));
        let mut list: Vec<(u64, FileType, String)> = vec![
            (ino.0, FileType::Directory, ".".to_string()),
            (parent_ino, FileType::Directory, "..".to_string()),
        ];
        for (vp, ft) in kids {
            let cino = ino_for(&mut s, &vp);
            let leaf = vp.rsplit('/').next().unwrap().to_string();
            list.push((cino, ft, leaf));
        }
        drop(s);
        for (i, (cino, ft, name)) in list.into_iter().enumerate().skip(offset as usize) {
            if reply.add(INodeNo(cino), (i + 1) as u64, ft, &name) {
                break;
            }
        }
        reply.ok();
    }

    fn open(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        self.ensure_fresh();
        // scratch file: serve its bytes from the in-memory map, never the ship.
        {
            let mut s = self.st.lock().unwrap();
            let path = match s.to_path.get(&ino.0) {
                Some(p) => p.clone(),
                None => {
                    reply.error(err(libc::ENOENT));
                    return;
                }
            };
            if is_scratch(leaf_of(&path)) {
                let buf = s.scratch.get(&path).cloned().unwrap_or_default();
                let fh = s.next_fh;
                s.next_fh += 1;
                s.handles.insert(
                    fh,
                    Handle { rel: path, kind: String::new(), buf, dirty: false, new: false, scratch: true },
                );
                drop(s);
                reply.opened(FileHandle(fh), FopenFlags::empty());
                return;
            }
        }
        let (rel, kind, pending) = {
            let s = self.st.lock().unwrap();
            let path = match s.to_path.get(&ino.0) {
                Some(p) => p.clone(),
                None => {
                    reply.error(err(libc::ENOENT));
                    return;
                }
            };
            match s.vt.get(&path) {
                Some(VEntry { kind: VKind::File, .. }) => {}
                Some(_) => {
                    reply.error(err(libc::EISDIR));
                    return;
                }
                None => {
                    reply.error(err(libc::ENOENT));
                    return;
                }
            }
            let (rel, kind) = self.rel_kind_of(&s, &path);
            let pending = s.pending_trunc.get(&ino.0).copied();
            (rel, kind, pending)
        };
        let mut buf = if pending == Some(0) {
            Vec::new()
        } else {
            match self.body(&rel) {
                Ok(b) => b,
                Err(e) => {
                    reply.error(err(e.errno));
                    return;
                }
            }
        };
        let mut dirty = false;
        if let Some(sz) = pending {
            resize(&mut buf, sz);
            dirty = true;
        }
        let mut s = self.st.lock().unwrap();
        s.pending_trunc.remove(&ino.0);
        let fh = s.next_fh;
        s.next_fh += 1;
        s.handles.insert(fh, Handle { rel, kind, buf, dirty, new: false, scratch: false });
        drop(s);
        reply.opened(FileHandle(fh), FopenFlags::empty());
    }

    fn read(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        size: u32,
        _flags: OpenFlags,
        _lock: Option<LockOwner>,
        reply: ReplyData,
    ) {
        let s = self.st.lock().unwrap();
        match s.handles.get(&fh.0) {
            Some(h) => {
                let start = (offset as usize).min(h.buf.len());
                let end = (start + size as usize).min(h.buf.len());
                reply.data(&h.buf[start..end]);
            }
            None => reply.error(err(libc::EBADF)),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn write(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        data: &[u8],
        _write_flags: WriteFlags,
        _flags: OpenFlags,
        _lock: Option<LockOwner>,
        reply: ReplyWrite,
    ) {
        let mut s = self.st.lock().unwrap();
        match s.handles.get_mut(&fh.0) {
            Some(h) => {
                let off = offset as usize;
                if off > h.buf.len() {
                    h.buf.resize(off, 0);
                }
                let end = off + data.len();
                if end > h.buf.len() {
                    h.buf.resize(end, 0);
                }
                h.buf[off..end].copy_from_slice(data);
                h.dirty = true;
                reply.written(data.len() as u32);
            }
            None => reply.error(err(libc::EBADF)),
        }
    }

    fn flush(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _lock: LockOwner,
        reply: ReplyEmpty,
    ) {
        match self.commit(fh.0) {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(err(e.errno)),
        }
    }

    fn release(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        _lock: Option<LockOwner>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        let r = self.commit(fh.0);
        self.st.lock().unwrap().handles.remove(&fh.0);
        match r {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(err(e.errno)),
        }
    }

    fn create(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        _mode: u32,
        _umask: u32,
        _flags: i32,
        reply: ReplyCreate,
    ) {
        self.ensure_fresh();
        let name = name.to_string_lossy().to_string();
        let mut s = self.st.lock().unwrap();
        let parent_path = match s.to_path.get(&parent.0) {
            Some(p) => p.clone(),
            None => {
                reply.error(err(libc::ENOENT));
                return;
            }
        };
        let path = join(&parent_path, &name);
        // editor temp file: keep it entirely in the FUSE layer (never a page).
        if is_scratch(&name) {
            let ino = ino_for(&mut s, &path);
            s.scratch.entry(path.clone()).or_default();
            let fh = s.next_fh;
            s.next_fh += 1;
            s.handles.insert(
                fh,
                Handle {
                    rel: path,
                    kind: String::new(),
                    buf: Vec::new(),
                    dirty: true,
                    new: true,
                    scratch: true,
                },
            );
            drop(s);
            let attr = file_attr(ino, 0, SystemTime::now(), false, self.uid, self.gid);
            reply.created(&TTL, &attr, Generation(0), FileHandle(fh), FopenFlags::empty());
            return;
        }
        let (rel, kind) = self.rel_kind_of(&s, &path);
        let ino = ino_for(&mut s, &path);
        let fh = s.next_fh;
        s.next_fh += 1;
        s.handles.insert(
            fh,
            Handle {
                rel: rel.clone(),
                kind: kind.clone(),
                buf: Vec::new(),
                dirty: true,
                new: true,
                scratch: false,
            },
        );
        s.recent.insert(path.clone(), (Instant::now(), true));
        // optimistic vt entry so getattr/lookup work before the flush
        let node = Node {
            rel,
            is_dir: false,
            is_page: true,
            kind,
            size: 0,
            mtime: now_secs(),
            readonly: false,
        };
        s.vt.insert(path, VEntry { kind: VKind::File, node: Some(node) });
        drop(s);
        let attr = file_attr(ino, 0, SystemTime::now(), false, self.uid, self.gid);
        reply.created(&TTL, &attr, Generation(0), FileHandle(fh), FopenFlags::empty());
    }

    fn mkdir(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        _mode: u32,
        _umask: u32,
        reply: ReplyEntry,
    ) {
        let name = name.to_string_lossy().to_string();
        let parent_path = match self.st.lock().unwrap().to_path.get(&parent.0) {
            Some(p) => p.clone(),
            None => {
                reply.error(err(libc::ENOENT));
                return;
            }
        };
        let path = join(&parent_path, &name);
        let rel = path.trim_start_matches('/').to_string();
        match self.proj.mkdir(&rel) {
            Ok(()) => {
                let mut s = self.st.lock().unwrap();
                let ino = ino_for(&mut s, &path);
                s.recent.insert(path.clone(), (Instant::now(), true));
                s.vt.insert(path, VEntry { kind: VKind::Dir, node: None });
                s.vt_ts = None;
                s.write_gen += 1;
                drop(s);
                let attr = dir_attr(ino, SystemTime::now(), self.uid, self.gid);
                reply.entry(&TTL, &attr, Generation(0));
            }
            Err(e) => reply.error(err(e.errno)),
        }
    }

    fn unlink(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let name = name.to_string_lossy().to_string();
        let (path, rel) = {
            let mut s = self.st.lock().unwrap();
            let parent_path = match s.to_path.get(&parent.0) {
                Some(p) => p.clone(),
                None => {
                    reply.error(err(libc::ENOENT));
                    return;
                }
            };
            let path = join(&parent_path, &name);
            // scratch file: drop it from the FUSE layer only. NEVER proj.delete,
            // which (via the last-dot strip) would delete the page it shadows.
            if is_scratch(&name) {
                s.scratch.remove(&path);
                s.vt.remove(&path);
                drop(s);
                reply.ok();
                return;
            }
            let (rel, _) = self.rel_kind_of(&s, &path);
            (path, rel)
        };
        match self.proj.delete(&rel) {
            Ok(()) => {
                let mut s = self.st.lock().unwrap();
                s.recent.insert(path.clone(), (Instant::now(), false));
                s.vt.remove(&path);
                s.vt_ts = None;
                s.write_gen += 1;
                drop(s);
                reply.ok();
            }
            Err(e) => reply.error(err(e.errno)),
        }
    }

    fn rmdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let name = name.to_string_lossy().to_string();
        let path = {
            let s = self.st.lock().unwrap();
            let parent_path = match s.to_path.get(&parent.0) {
                Some(p) => p.clone(),
                None => {
                    reply.error(err(libc::ENOENT));
                    return;
                }
            };
            join(&parent_path, &name)
        };
        // POSIX: a non-empty directory is ENOTEMPTY. Without this, rmdir of a
        // populated lattice folder would pass straight to page-del and take the
        // whole subtree with it (rm -r still works because it empties, then rmdirs).
        {
            let s = self.st.lock().unwrap();
            let prefix = format!("{path}/");
            if s.vt.keys().any(|k| k.starts_with(&prefix)) {
                drop(s);
                reply.error(err(libc::ENOTEMPTY));
                return;
            }
        }
        let rel = path.trim_start_matches('/').to_string();
        match self.proj.delete(&rel) {
            Ok(()) => {
                let mut s = self.st.lock().unwrap();
                s.recent.insert(path.clone(), (Instant::now(), false));
                s.vt.remove(&path);
                s.vt_ts = None;
                s.write_gen += 1;
                drop(s);
                reply.ok();
            }
            Err(e) => reply.error(err(e.errno)),
        }
    }

    fn rename(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        newparent: INodeNo,
        newname: &OsStr,
        _flags: RenameFlags,
        reply: ReplyEmpty,
    ) {
        let name = name.to_string_lossy().to_string();
        let newname = newname.to_string_lossy().to_string();
        let src_scratch = is_scratch(&name);
        let dst_scratch = is_scratch(&newname);
        let (src_path, dst_path, src_rel, dst_rel, dst_kind, dst_exists) = {
            let s = self.st.lock().unwrap();
            let pp = match s.to_path.get(&parent.0) {
                Some(p) => p.clone(),
                None => {
                    reply.error(err(libc::ENOENT));
                    return;
                }
            };
            let npp = match s.to_path.get(&newparent.0) {
                Some(p) => p.clone(),
                None => {
                    reply.error(err(libc::ENOENT));
                    return;
                }
            };
            let src_path = join(&pp, &name);
            let dst_path = join(&npp, &newname);
            let (src_rel, _) = self.rel_kind_of(&s, &src_path);
            let (dst_rel, dst_kind) = self.rel_kind_of(&s, &dst_path);
            let dst_exists = s.vt.contains_key(&dst_path);
            (src_path, dst_path, src_rel, dst_rel, dst_kind, dst_exists)
        };
        // Any rename touching a scratch name must never delete/clobber the page it
        // shadows. Handle the editor patterns explicitly:
        if src_scratch || dst_scratch {
            // the bytes an atomic save promoted onto a real page, if any
            let mut promoted: Option<Vec<u8>> = None;
            let res: Result<(), PErr> = if src_scratch && dst_scratch {
                // temp -> temp: move within the scratch map
                let v = self.st.lock().unwrap().scratch.remove(&src_path).unwrap_or_default();
                self.st.lock().unwrap().scratch.insert(dst_path.clone(), v);
                Ok(())
            } else if src_scratch {
                // atomic save: temp -> real page. Promote the scratch bytes.
                // create only when the destination doesn't exist. An atomic save
                // ONTO an existing page is an overwrite (create=true would 409 on
                // lattice / EROFS on generic, failing every VS Code-style save).
                let v = self.st.lock().unwrap().scratch.remove(&src_path).unwrap_or_default();
                let r = self.proj.write(&dst_rel, &dst_kind, &v, !dst_exists);
                promoted = Some(v);
                r
            } else {
                // backup-by-rename: page -> temp name. Snapshot the page's current
                // body into the scratch map and KEEP the page (the editor rewrites
                // it next). Never delete it, so there is no data-loss window.
                let v = self.body(&src_rel).unwrap_or_default();
                self.st.lock().unwrap().scratch.insert(dst_path.clone(), v);
                Ok(())
            };
            match res {
                Ok(()) => {
                    let mut s = self.st.lock().unwrap();
                    // src no longer exists under its old name only when it moved
                    // OUT of the page/scratch namespace (not the page->backup case).
                    if src_scratch {
                        s.scratch.remove(&src_path);
                        s.vt.remove(&src_path);
                    }
                    if !src_scratch {
                        // page -> temp: the page stays. Refresh so the new content lands
                        s.vt_ts = None;
                    }
                    if src_scratch && !dst_scratch {
                        s.recent.insert(dst_path.clone(), (Instant::now(), true));
                        // an atomic save may CREATE the page. Seed an optimistic
                        // entry, as create() does, so the file the editor just
                        // wrote is stat-able before the re-dump lands.
                        let buf = promoted.unwrap_or_default();
                        s.vt.entry(dst_path.clone()).or_insert_with(|| VEntry {
                            kind: VKind::File,
                            node: Some(Node {
                                rel: dst_rel.clone(),
                                is_dir: false,
                                is_page: true,
                                kind: dst_kind.clone(),
                                size: 0,
                                mtime: now_secs(),
                                readonly: false,
                            }),
                        });
                        // and the promoted bytes ARE that page now
                        publish(&mut s, &dst_rel, &buf);
                    }
                    remap_ino(&mut s, &src_path, &dst_path);
                    drop(s);
                    reply.ok();
                }
                Err(e) => reply.error(err(e.errno)),
            }
            return;
        }
        match self.proj.mv(&src_rel, &dst_rel) {
            Ok(()) => {
                let mut s = self.st.lock().unwrap();
                // The entry moves in the vtree too. The ship holds it under the
                // new name now, and leaving the destination to the async
                // re-dump makes `mv a b && cat b` fail with ENOENT for up to a
                // whole refresh interval. Carry the cached body across with it
                // so the read after the rename also skips the round trip.
                let moved = s.vt.remove(&src_path);
                let body = s.read_cache.remove(&src_rel);
                if let Some(b) = &body {
                    s.read_cache_bytes =
                        s.read_cache_bytes.saturating_sub(src_rel.len() + b.len());
                }
                if let Some(mut e) = moved {
                    if let Some(n) = e.node.as_mut() {
                        n.rel = dst_rel.clone();
                    }
                    s.vt.insert(dst_path.clone(), e);
                }
                if let Some(b) = body {
                    let add = dst_rel.len() + b.len();
                    match s.read_cache.insert(dst_rel.clone(), b) {
                        // the destination may already have been cached
                        Some(old) => {
                            s.read_cache_bytes = s
                                .read_cache_bytes
                                .saturating_sub(dst_rel.len() + old.len())
                                + add;
                        }
                        None => s.read_cache_bytes += add,
                    }
                }
                s.recent.insert(src_path.clone(), (Instant::now(), false));
                s.recent.insert(dst_path.clone(), (Instant::now(), true));
                s.vt_ts = None;
                s.write_gen += 1;
                remap_ino(&mut s, &src_path, &dst_path);
                drop(s);
                reply.ok();
            }
            Err(e) => reply.error(err(e.errno)),
        }
    }
}

/// After a rename the kernel keeps the SOURCE inode under the destination
/// name, so the ino<->path tables have to move with it. Without this the next
/// stat of the destination resolves through the source inode to the old vpath
/// (which the rename just removed) and returns ENOENT. An editor that saves
/// by writing a temp and renaming it into place (VS Code, `:w` with
/// `backupcopy=no`) then sees the file it just wrote disappear.
fn remap_ino(s: &mut State, src: &str, dst: &str) {
    if let Some(ino) = s.to_ino.remove(src) {
        s.to_ino.insert(dst.to_string(), ino);
        s.to_path.insert(ino, dst.to_string());
    }
}

/// Truncate/extend a buffer to exactly `sz` bytes (zero-fill on grow).
fn resize(buf: &mut Vec<u8>, sz: u64) {
    let sz = sz as usize;
    if buf.len() > sz {
        buf.truncate(sz);
    } else if buf.len() < sz {
        buf.resize(sz, 0);
    }
}

#[cfg(test)]
mod tests {
    use super::{cap_bodies, is_scratch};
    use std::collections::HashMap;

    #[test]
    fn scratch_classifies_editor_temp_files() {
        // real pages: must NOT be scratch (they map to a page and persist)
        for real in ["foo.md", "foo.gmi", "foo.html", "foo.txt", "foo.js", "foo.css", "foo.hoon", "notes"] {
            assert!(!is_scratch(real), "{real} should be a real page file");
        }
        // editor temp files: MUST be scratch (never map onto a page)
        for tmp in [
            "foo.md~",       // vim/emacs backup, the reported data-loss case
            "foo.gmi~",
            ".foo.md.swp",   // vim swap
            ".foo.md.swo",
            "foo.swp",
            "foo.tmp",
            "foo.bak",
            "4913.tmp",
        ] {
            assert!(is_scratch(tmp), "{tmp} should be an ephemeral scratch file");
        }
    }

    #[test]
    fn cap_bodies_bounds_the_cache() {
        // three 100-byte bodies (key ~1 byte each), cap at 250 bytes -> only two
        // whole files fit. The cache never exceeds the cap, and it degrades by
        // dropping files (not truncating one), so overflow reads lazily later.
        let mut b = HashMap::new();
        b.insert("a".to_string(), vec![0u8; 100]);
        b.insert("b".to_string(), vec![0u8; 100]);
        b.insert("c".to_string(), vec![0u8; 100]);
        let (cache, bytes) = cap_bodies(b, 250);
        assert_eq!(cache.len(), 2);
        assert!(bytes <= 250);
        // every cached entry is a whole body, never a partial
        for v in cache.values() {
            assert_eq!(v.len(), 100);
        }
    }

    #[test]
    fn cap_bodies_keeps_all_when_under_cap() {
        let mut b = HashMap::new();
        b.insert("x".to_string(), vec![0u8; 10]);
        b.insert("y".to_string(), vec![0u8; 10]);
        let (cache, _) = cap_bodies(b, 1_000_000);
        assert_eq!(cache.len(), 2);
    }

    // ---------- property tests ----------

    use super::{build_vt, join, leaf_of, resize};
    use crate::projection::Node;
    use proptest::prelude::*;

    proptest! {
        // total over any name (unicode, dots anywhere, empty), and the two
        // hard rules: a trailing '~' is ALWAYS scratch (the vim-backup
        // data-loss case), a known page extension NEVER is
        #[test]
        fn is_scratch_is_total(name in ".*") {
            let s = is_scratch(&name);
            if name.ends_with('~') {
                prop_assert!(s, "{} must be scratch (backup suffix)", name);
            }
        }

        #[test]
        fn known_extensions_are_never_scratch(
            stem in "[a-zA-Z0-9 ._-]*",
            ext in proptest::sample::select(vec!["md", "gmi", "html", "txt", "js", "css", "hoon"]),
        ) {
            let name = format!("{stem}.{ext}");
            prop_assert!(!is_scratch(&name), "{} is a real page file", name);
        }

        // the cache never exceeds its cap, holds only whole bodies, accounts
        // its bytes exactly, and is deterministic across runs
        #[test]
        fn cap_bodies_respects_the_cap(
            bodies in proptest::collection::hash_map(
                "[a-z/]{0,8}",
                proptest::collection::vec(any::<u8>(), 0..64),
                0..16,
            ),
            limit in 0usize..600,
        ) {
            let input = bodies.clone();
            let (cache, bytes) = cap_bodies(bodies, limit);
            prop_assert!(bytes <= limit);
            let sum: usize = cache.iter().map(|(k, v)| k.len() + v.len()).sum();
            prop_assert_eq!(bytes, sum, "accounting must match contents");
            for (k, v) in &cache {
                prop_assert_eq!(&input[k], v, "a cached body is never truncated");
            }
            let (cache2, bytes2) = cap_bodies(input, limit);
            prop_assert_eq!(cache, cache2, "deterministic across runs");
            prop_assert_eq!(bytes, bytes2);
        }

        // every entry build_vt makes must have its parent directory present,
        // whatever the projection's rels look like (empty segments, dots,
        // unicode, dirs shadowing files). An orphan would be unreachable
        // via readdir yet still occupy an inode
        #[test]
        fn build_vt_never_orphans_an_entry(
            rels in proptest::collection::vec(("[a-zA-Z0-9/._~ ]{0,16}", any::<bool>()), 0..12),
        ) {
            let nodes: Vec<Node> = rels
                .into_iter()
                .map(|(rel, is_dir)| Node {
                    rel,
                    is_dir,
                    is_page: !is_dir,
                    kind: "md".into(),
                    size: 0,
                    mtime: 0,
                    readonly: false,
                })
                .collect();
            let vt = build_vt(&nodes, |_| "md");
            prop_assert!(vt.contains_key("/"));
            for k in vt.keys() {
                if k == "/" {
                    continue;
                }
                prop_assert!(k.starts_with('/'), "vpath {} must be absolute", k);
                let parent = match k.rfind('/') {
                    Some(0) => "/".to_string(),
                    Some(i) => k[..i].to_string(),
                    None => "/".to_string(),
                };
                prop_assert!(vt.contains_key(&parent), "{} orphaned: no {}", k, parent);
            }
        }

        // resize is exact, prefix-preserving, and zero-fills growth (a
        // truncate/extend must never expose stale bytes)
        #[test]
        fn resize_is_exact(orig in proptest::collection::vec(any::<u8>(), 0..64), sz in 0u64..256) {
            let mut b = orig.clone();
            resize(&mut b, sz);
            prop_assert_eq!(b.len(), sz as usize);
            let keep = orig.len().min(sz as usize);
            prop_assert_eq!(&b[..keep], &orig[..keep]);
            prop_assert!(b[keep..].iter().all(|&x| x == 0));
        }

        // join/leaf_of roundtrip: the leaf of a joined path is the name
        #[test]
        fn join_leaf_roundtrip(
            parent in proptest::sample::select(vec!["/", "/a", "/a/b", "/deep/er/tree"]),
            name in "[a-zA-Z0-9. _~-]{1,12}",
        ) {
            let joined = join(parent, &name);
            prop_assert_eq!(leaf_of(&joined), name.as_str());
            prop_assert!(joined.starts_with(parent));
        }
    }

    // ---------- the core, driven by a fake projection ----------
    //
    // The FUSE trait methods themselves can't be called in-process (fuser's
    // Reply types have no public constructor), but everything they decide with
    // lives in these methods and helpers, which the test module can reach.

    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

    #[derive(Default)]
    struct Fake {
        nodes: Mutex<Vec<Node>>,
        bodies: Mutex<HashMap<String, Vec<u8>>>,
        log: Mutex<Vec<String>>,
        dumps: AtomicUsize,
        reads: AtomicUsize,
        entered: AtomicBool, // dump() has been entered (start_gen is already read)
        hold: AtomicBool,    // stall dump() mid-flight
        delay_ms: AtomicU64, // make dump() slow, so "blocking" is observable
        no_inline: AtomicBool, // dump carries nodes but no bodies (oversized pages)
    }

    impl Fake {
        fn new(nodes: Vec<Node>, bodies: &[(&str, &str)]) -> Arc<Self> {
            Arc::new(Fake {
                nodes: Mutex::new(nodes),
                bodies: Mutex::new(
                    bodies.iter().map(|(k, v)| (k.to_string(), v.as_bytes().to_vec())).collect(),
                ),
                ..Default::default()
            })
        }
        fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }
    }

    impl Projection for Fake {
        fn ship(&self) -> String {
            "~test".into()
        }
        fn list(&self) -> Result<Vec<Node>, PErr> {
            Ok(self.nodes.lock().unwrap().clone())
        }
        fn read(&self, rel: &str) -> Result<Vec<u8>, PErr> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.bodies
                .lock()
                .unwrap()
                .get(rel)
                .cloned()
                .ok_or_else(|| PErr::new(libc::ENOENT, "fake: no such rel"))
        }
        fn dump(&self) -> Result<(Vec<Node>, HashMap<String, Vec<u8>>), PErr> {
            self.entered.store(true, Ordering::SeqCst);
            while self.hold.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(1));
            }
            let d = self.delay_ms.load(Ordering::SeqCst);
            if d > 0 {
                std::thread::sleep(Duration::from_millis(d));
            }
            self.dumps.fetch_add(1, Ordering::SeqCst);
            let bodies = if self.no_inline.load(Ordering::SeqCst) {
                HashMap::new()
            } else {
                self.bodies.lock().unwrap().clone()
            };
            Ok((self.nodes.lock().unwrap().clone(), bodies))
        }
        fn errors(&self, _rel: &str) -> Result<String, PErr> {
            Ok(String::new())
        }
        fn write(&self, rel: &str, kind: &str, data: &[u8], create: bool) -> Result<(), PErr> {
            self.log.lock().unwrap().push(format!(
                "write {rel} {kind} {} new={create}",
                String::from_utf8_lossy(data)
            ));
            Ok(())
        }
        fn mkdir(&self, rel: &str) -> Result<(), PErr> {
            self.log.lock().unwrap().push(format!("mkdir {rel}"));
            Ok(())
        }
        fn delete(&self, rel: &str) -> Result<(), PErr> {
            self.log.lock().unwrap().push(format!("delete {rel}"));
            Ok(())
        }
        fn mv(&self, s: &str, d: &str) -> Result<(), PErr> {
            self.log.lock().unwrap().push(format!("mv {s} {d}"));
            Ok(())
        }
        fn watch(&self, _on_change: &(dyn Fn() + Send + Sync)) {}
    }

    fn page(rel: &str, kind: &str, size: u64) -> Node {
        Node {
            rel: rel.into(),
            is_dir: false,
            is_page: true,
            kind: kind.into(),
            size,
            mtime: 100,
            readonly: false,
        }
    }

    fn vdir(rel: &str) -> Node {
        Node {
            rel: rel.into(),
            is_dir: true,
            is_page: false,
            kind: String::new(),
            size: 0,
            mtime: 100,
            readonly: false,
        }
    }

    fn bare_state() -> State {
        State {
            to_path: HashMap::new(),
            to_ino: HashMap::new(),
            next_ino: 2,
            vt: HashMap::new(),
            vt_ts: None,
            read_cache: HashMap::new(),
            read_cache_bytes: 0,
            warm: false,
            refresh_pending: false,
            write_gen: 0,
            handles: HashMap::new(),
            next_fh: 1,
            pending_trunc: HashMap::new(),
            scratch: HashMap::new(),
            recent: HashMap::new(),
        }
    }

    fn handle(rel: &str, kind: &str, buf: &[u8], dirty: bool, scratch: bool) -> Handle {
        Handle {
            rel: rel.into(),
            kind: kind.into(),
            buf: buf.to_vec(),
            dirty,
            new: false,
            scratch,
        }
    }

    /// Spin (bounded) until `f` holds. Panics rather than hanging, so a mutant
    /// that stops a background refresh from ever completing fails the test.
    fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
        for _ in 0..3000 {
            if f() {
                return;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        panic!("timed out waiting for {what}");
    }

    fn warm_fs(f: Arc<Fake>) -> GrubberyFs {
        let fs = GrubberyFs::new(f as Arc<dyn Projection>);
        wait_until("the warm dump", || fs.st.lock().unwrap().warm);
        fs
    }

    #[test]
    fn body_fetches_once_and_accounts_its_bytes_exactly() {
        // a page the warm dump omitted (oversized): body() must fetch it, serve
        // it, cache it once, and account it exactly. Double-counting slowly rots
        // the cap accounting until the cache stops admitting anything.
        let big = "x".repeat(3000);
        let f = Fake::new(vec![page("note", "md", 3000)], &[("note", &big)]);
        f.no_inline.store(true, Ordering::SeqCst);
        let fs = warm_fs(f.clone());
        assert_eq!(fs.st.lock().unwrap().read_cache_bytes, 0);
        // prime the cache so the ceiling check has a real running total to add
        // to: 100_004 + 3004 fits under READ_CACHE_MAX, 100_004 * 3004 does not
        {
            let mut s = fs.st.lock().unwrap();
            s.read_cache.insert("seed".into(), vec![0u8; 100_000]);
            s.read_cache_bytes = "seed".len() + 100_000;
        }

        assert_eq!(fs.body("note").unwrap(), big.as_bytes());
        assert_eq!(fs.body("note").unwrap(), big.as_bytes());
        assert_eq!(f.reads.load(Ordering::SeqCst), 1, "the second read must come from cache");

        let s = fs.st.lock().unwrap();
        assert_eq!(s.read_cache["note"], big.as_bytes());
        assert_eq!(s.read_cache_bytes, "seed".len() + 100_000 + "note".len() + 3000);
        assert_eq!(
            s.read_cache_bytes,
            s.read_cache.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>()
        );
        // a rel with no page at all is an error, never silently empty bytes
        drop(s);
        assert!(fs.body("nope").is_err());
    }

    #[test]
    fn commit_writes_once_and_republishes_the_new_size_and_body() {
        let f = Fake::new(
            vec![vdir("d"), page("note", "md", 3), page("other", "md", 5)],
            &[("note", "old"), ("other", "hello")],
        );
        let fs = warm_fs(f.clone());
        let base = fs.st.lock().unwrap().read_cache_bytes;
        assert_eq!(base, "note".len() + 3 + "other".len() + 5);

        // a clean handle must not POST: one :w = one page-save, no more
        fs.st.lock().unwrap().handles.insert(7, handle("note", "md", b"ignored", false, false));
        fs.commit(7).unwrap();
        assert!(f.log().is_empty(), "a clean handle must not reach the ship");

        {
            let mut s = fs.st.lock().unwrap();
            let h = s.handles.get_mut(&7).unwrap();
            h.dirty = true;
            h.buf = b"brand new body".to_vec();
        }
        fs.commit(7).unwrap();
        assert_eq!(f.log(), vec!["write note md brand new body new=false"]);

        {
            let s = fs.st.lock().unwrap();
            assert!(!s.handles[&7].dirty, "a committed handle must go clean");
            let sz = |vp: &str| s.vt[vp].node.as_ref().unwrap().size;
            // the vtree size must be republished NOW: the kernel derives an
            // O_APPEND offset from it, and the re-dump is async. A stale size
            // makes the next append land at the wrong offset and overwrite.
            assert_eq!(sz("/note.md"), 14);
            assert_eq!(sz("/other.md"), 5, "an unrelated page must not be resized");
            assert!(s.vt["/note.md"].node.as_ref().unwrap().mtime > 1_700_000_000);
            // the buffer IS the page now: installed, not evicted
            assert_eq!(s.read_cache["note"], b"brand new body");
            assert_eq!(s.read_cache_bytes, base - 3 + 14);
            assert_eq!(s.write_gen, 1, "a write must supersede an in-flight dump swap");
            assert!(s.vt_ts.is_none(), "a write must invalidate the vtree");
        }

        // a page with nothing cached yet takes the other accounting branch
        fs.st.lock().unwrap().handles.insert(8, handle("fresh", "md", b"xy", true, false));
        fs.commit(8).unwrap();
        let s = fs.st.lock().unwrap();
        assert_eq!(s.read_cache_bytes, base - 3 + 14 + "fresh".len() + 2);
        assert_eq!(
            s.read_cache_bytes,
            s.read_cache.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>(),
            "accounting must match contents"
        );
        assert_eq!(s.write_gen, 2);
    }

    #[test]
    fn commit_of_a_scratch_handle_never_reaches_the_ship() {
        // the sidecar data-loss guard: an editor backup commits to the in-memory
        // scratch map. If it ever POSTed, it would overwrite the page it shadows.
        let f = Fake::new(vec![page("note", "md", 3)], &[("note", "old")]);
        let fs = warm_fs(f.clone());
        fs.st
            .lock()
            .unwrap()
            .handles
            .insert(3, handle("/note.md~", "", b"backup bytes", true, true));
        fs.commit(3).unwrap();

        assert!(f.log().is_empty(), "a scratch handle must never POST to the ship");
        let s = fs.st.lock().unwrap();
        assert_eq!(s.scratch["/note.md~"], b"backup bytes");
        assert!(!s.handles[&3].dirty);
        assert_eq!(s.write_gen, 0, "a scratch commit is not a ship mutation");
        assert_eq!(s.read_cache["note"], b"old", "the shadowed page is untouched");
    }

    #[test]
    fn rel_kind_of_maps_a_vpath_to_the_page_it_actually_writes() {
        // getting this wrong writes the user's bytes into a DIFFERENT page.
        // "demo" is a page WITH children, so its own body file is /demo/demo.md.
        let f = Fake::new(
            vec![
                page("demo", "md", 1),
                page("demo/hello", "gmi", 1),
                page("demo/other", "md", 1),
                page("top", "md", 1),
            ],
            &[],
        );
        let fs = warm_fs(f.clone());
        let s = fs.st.lock().unwrap();
        let rk = |p: &str| fs.rel_kind_of(&s, p);
        assert_eq!(rk("/demo/demo.md"), ("demo".into(), "md".into()), "the parent's own body");
        assert_eq!(rk("/demo/hello.gmi"), ("demo/hello".into(), "gmi".into()));
        assert_eq!(rk("/demo/other.md"), ("demo/other".into(), "md".into()));
        assert_eq!(rk("/top.md"), ("top".into(), "md".into()));
        assert_eq!(rk("/bare"), ("bare".into(), "hoon".into()), "no extension = a hoon page");
    }

    #[test]
    fn apply_swap_lets_the_recent_ledger_override_a_lagging_snapshot() {
        // The ship acks a save before a brand-new page is visible to page-dump.
        // A snapshot taken in that window must not evict the new page nor
        // resurrect a just-deleted one.
        let mut s = bare_state();
        s.vt.insert(
            "/fresh.md".into(),
            VEntry { kind: VKind::File, node: Some(page("fresh", "md", 2)) },
        );
        s.read_cache.insert("fresh".into(), b"hi".to_vec());
        s.read_cache_bytes = "fresh".len() + 2;
        s.recent.insert("/fresh.md".into(), (Instant::now(), true));
        s.recent.insert("/gone.md".into(), (Instant::now(), false));
        s.recent.insert("/stale.md".into(), (Instant::now() - RECENT_TTL * 2, true));

        let mut vt = HashMap::new();
        vt.insert("/".to_string(), VEntry { kind: VKind::Dir, node: None });
        vt.insert(
            "/gone.md".to_string(),
            VEntry { kind: VKind::File, node: Some(page("gone", "md", 4)) },
        );
        vt.insert(
            "/keep.md".to_string(),
            VEntry { kind: VKind::File, node: Some(page("keep", "md", 4)) },
        );
        let mut cache = HashMap::new();
        cache.insert("gone".to_string(), b"dead".to_vec());
        cache.insert("keep".to_string(), b"live".to_vec());
        let bytes = "gone".len() + 4 + "keep".len() + 4;

        apply_swap(&mut s, vt, cache, bytes);

        assert!(s.vt.contains_key("/fresh.md"), "a just-created page must survive the snapshot");
        assert_eq!(s.read_cache["fresh"], b"hi", "and keep its cached body");
        assert!(!s.vt.contains_key("/gone.md"), "a just-deleted page must not be resurrected");
        assert!(!s.read_cache.contains_key("gone"), "nor its body");
        assert!(s.vt.contains_key("/keep.md"), "the rest of the snapshot lands");
        assert_eq!(s.read_cache_bytes, "keep".len() + 4 + "fresh".len() + 2);
        assert_eq!(
            s.read_cache_bytes,
            s.read_cache.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>()
        );
        assert!(!s.recent.contains_key("/stale.md"), "the ledger must age out");
        assert!(s.warm && s.vt_ts.is_some());
    }

    #[test]
    fn ensure_fresh_blocks_when_cold_and_polls_only_past_the_ttl() {
        let f = Fake::new(vec![page("note", "md", 3)], &[("note", "old")]);
        let fs = warm_fs(f.clone());
        let dumps = || f.dumps.load(Ordering::SeqCst);
        let after_warm = dumps();

        // steady state: a fresh vtree serves with ZERO network on the FUSE path
        for _ in 0..5 {
            fs.ensure_fresh();
        }
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(dumps(), after_warm, "a fresh vtree must not hit the wire");

        // past the TTL: one background refresh, and it must actually complete
        fs.st.lock().unwrap().vt_ts = Some(Instant::now() - TREE_TTL * 2);
        fs.ensure_fresh();
        wait_until("the background refresh", || !fs.st.lock().unwrap().refresh_pending);
        assert!(dumps() > after_warm, "a stale vtree must refresh");

        // cold: ensure_fresh must BLOCK on the first dump, never return an empty
        // tree (the first ls after mount would show nothing).
        f.delay_ms.store(40, Ordering::SeqCst);
        {
            let mut s = fs.st.lock().unwrap();
            s.warm = false;
            s.vt.clear();
            s.vt_ts = None;
        }
        fs.ensure_fresh();
        let s = fs.st.lock().unwrap();
        assert!(s.warm, "a cold ensure_fresh must block until the first dump lands");
        assert!(s.vt.contains_key("/note.md"), "and return with the tree populated");
    }

    #[test]
    fn a_dump_in_flight_never_overwrites_a_newer_write() {
        // the stale-swap guard. A refresh that started before a save must not
        // land after it and resurrect the pre-write body.
        let f = Fake::new(vec![page("note", "md", 3)], &[("note", "old")]);
        let fs = warm_fs(f.clone());
        f.entered.store(false, Ordering::SeqCst);
        f.hold.store(true, Ordering::SeqCst);
        fs.st.lock().unwrap().vt_ts = Some(Instant::now() - TREE_TTL * 2);
        fs.ensure_fresh();
        wait_until("the refresh to start", || f.entered.load(Ordering::SeqCst));

        // the user saves while that dump is stalled on the wire
        fs.st.lock().unwrap().handles.insert(1, handle("note", "md", b"NEWER!", true, false));
        fs.commit(1).unwrap();

        f.hold.store(false, Ordering::SeqCst);
        wait_until("the stale refresh", || !fs.st.lock().unwrap().refresh_pending);

        let s = fs.st.lock().unwrap();
        assert_eq!(s.read_cache["note"], b"NEWER!", "a stale snapshot must not undo a write");
        assert_eq!(s.vt["/note.md"].node.as_ref().unwrap().size, 6);
    }

    #[test]
    fn open_size_reports_the_live_buffer_for_the_right_rel() {
        // an open handle's buffer is the authoritative size. Reporting another
        // file's (or none) makes an append seek to a stale offset.
        let mut s = bare_state();
        s.handles.insert(1, handle("a", "md", &[0; 7], false, false));
        s.handles.insert(2, handle("b", "md", &[0; 3], true, false));
        assert_eq!(open_size(&s, "a"), Some(7));
        assert_eq!(open_size(&s, "b"), Some(3));
        assert_eq!(open_size(&s, "c"), None, "no open handle: fall back to the vtree size");
    }

    #[test]
    fn ino_is_stable_per_path_and_never_reused() {
        let mut s = bare_state();
        let a = ino_for(&mut s, "/a.md");
        let b = ino_for(&mut s, "/b.md");
        let c = ino_for(&mut s, "/c.md");
        assert_eq!(ino_for(&mut s, "/a.md"), a, "an inode must not move under a path");
        assert!(a != b && b != c && a != c, "two paths must never share an inode");
        assert!(a >= 2 && b >= 2 && c >= 2, "1 is reserved for the root");
        assert_eq!(s.to_path[&a], "/a.md");
        assert_eq!(s.to_ino["/c.md"], c);
    }

    #[test]
    fn timestamps_are_real_wall_clock() {
        assert_eq!(to_systime(1_000_000), UNIX_EPOCH + Duration::from_secs(1_000_000));
        // a node with no usable mtime gets "now", never the epoch: an epoch
        // mtime makes make/rsync/editors treat every file as decades stale
        let secs = |t: SystemTime| t.duration_since(UNIX_EPOCH).unwrap().as_secs();
        assert!(secs(to_systime(0)) > 1_700_000_000);
        assert!(secs(to_systime(-5)) > 1_700_000_000);
        assert!(now_secs() > 1_700_000_000);
    }

    #[test]
    fn cap_bodies_keeps_the_most_files_and_admits_an_exact_fit() {
        // smallest-first: under a 25-byte cap "bbbb" (4+5) is kept and "a"
        // (1+20) dropped, so the cache holds as many whole files as fit
        let mut b = HashMap::new();
        b.insert("a".to_string(), vec![0u8; 20]);
        b.insert("bbbb".to_string(), vec![0u8; 5]);
        let (cache, bytes) = cap_bodies(b, 25);
        assert_eq!(cache.keys().cloned().collect::<Vec<_>>(), vec!["bbbb".to_string()]);
        assert_eq!(bytes, 9);
        // an entry that fills the cap EXACTLY is kept, not dropped
        let mut b = HashMap::new();
        b.insert("ab".to_string(), vec![0u8; 8]);
        let (cache, bytes) = cap_bodies(b, 10);
        assert_eq!(cache.len(), 1);
        assert_eq!(bytes, 10);
        // and the ceiling itself stays a real bound: small enough that a huge
        // tree can't OOM the client, large enough that the cache still works
        // (a byte-scale ceiling silently turns every read into a round trip)
        assert!(
            (64 << 20..=1 << 30).contains(&READ_CACHE_MAX),
            "READ_CACHE_MAX = {READ_CACHE_MAX} is not a sane memory ceiling"
        );
    }
}
