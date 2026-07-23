//! GrubberyFs: the generic FUSE filesystem, driven entirely by a Projection.
//!
//! fuser is inode-based, so we keep an ino<->path table on top of a virtual
//! tree (vpath -> entry) built once per 5s from projection.list(). Writes buffer
//! in a per-fh handle and POST once on flush (one :w = one page-save). All state
//! is behind one Mutex (fuser calls methods on &self, possibly concurrently);
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

const TTL: Duration = Duration::from_secs(1); // kernel attr/entry cache
const TREE_TTL: Duration = Duration::from_secs(5); // our vtree refresh floor

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
    rel: String,
    kind: String,
    buf: Vec<u8>,
    dirty: bool,
    new: bool,
}

struct State {
    to_path: HashMap<u64, String>, // ino -> vpath ("/demo/hello.md"); 1 = "/"
    to_ino: HashMap<String, u64>,
    next_ino: u64,
    vt: HashMap<String, VEntry>, // vpath -> entry
    vt_ts: Option<Instant>,
    read_cache: HashMap<String, Vec<u8>>, // rel -> bytes
    handles: HashMap<u64, Handle>,        // fh -> handle
    next_fh: u64,
    pending_trunc: HashMap<u64, u64>, // ino -> size (handle-less truncate deferred to open)
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
            handles: HashMap::new(),
            next_fh: 1,
            pending_trunc: HashMap::new(),
        }));
        // watch thread: invalidate on external change. Best-effort (Eyre is a
        // no-op) — the 5s TTL poll is the guaranteed freshness floor.
        let wst = st.clone();
        let wproj = proj.clone();
        std::thread::spawn(move || {
            let on_change = move || {
                if let Ok(mut s) = wst.lock() {
                    s.vt_ts = None;
                    s.read_cache.clear();
                }
            };
            wproj.watch(&on_change);
        });
        GrubberyFs {
            proj,
            st,
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
        }
    }

    /// Rebuild the vtree if stale. Calls projection.list() OUTSIDE the lock, then
    /// swaps the result in — a network hiccup keeps the stale tree.
    fn ensure_fresh(&self) {
        let stale = {
            let s = self.st.lock().unwrap();
            s.vt_ts.map_or(true, |t| t.elapsed() > TREE_TTL)
        };
        if !stale {
            return;
        }
        if let Ok(nodes) = self.proj.list() {
            let vt = build_vt(&nodes, |k| self.proj.ext_for_kind(k));
            let mut s = self.st.lock().unwrap();
            s.vt = vt;
            s.vt_ts = Some(Instant::now());
        }
    }

    /// Read-through body cache. Fetches OUTSIDE the lock.
    fn body(&self, rel: &str) -> Result<Vec<u8>, PErr> {
        if let Some(b) = self.st.lock().unwrap().read_cache.get(rel) {
            return Ok(b.clone());
        }
        let data = self.proj.read(rel)?;
        self.st
            .lock()
            .unwrap()
            .read_cache
            .insert(rel.to_string(), data.clone());
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
        let (rel, kind, buf, new) = {
            let s = self.st.lock().unwrap();
            match s.handles.get(&fh) {
                Some(h) if h.dirty => (h.rel.clone(), h.kind.clone(), h.buf.clone(), h.new),
                _ => return Ok(()),
            }
        };
        self.proj.write(&rel, &kind, &buf, new)?;
        let mut s = self.st.lock().unwrap();
        if let Some(h) = s.handles.get_mut(&fh) {
            h.dirty = false;
            h.new = false;
        }
        s.vt_ts = None;
        s.read_cache.remove(&rel);
        Ok(())
    }
}

// ---------- free helpers ----------

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

fn dirty_size(s: &State, rel: &str) -> Option<u64> {
    s.handles
        .values()
        .find(|h| h.dirty && h.rel == rel)
        .map(|h| h.buf.len() as u64)
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
            dirty_size(&s, &rel)
        } else {
            None
        };
        drop(s);
        let attr = self.mk_attr(ino, &e, ov);
        reply.entry(&TTL, &attr, Generation(0));
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
        let e = match s.vt.get(&path).cloned() {
            Some(e) => e,
            None => {
                reply.error(err(libc::ENOENT));
                return;
            }
        };
        let ov = if e.kind == VKind::File {
            let (rel, _) = self.rel_kind_of(&s, &path);
            dirty_size(&s, &rel)
        } else {
            None
        };
        drop(s);
        let attr = self.mk_attr(ino.0, &e, ov);
        reply.attr(&TTL, &attr);
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
        s.handles.insert(fh, Handle { rel, kind, buf, dirty, new: false });
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
        let (rel, kind) = self.rel_kind_of(&s, &path);
        let ino = ino_for(&mut s, &path);
        let fh = s.next_fh;
        s.next_fh += 1;
        s.handles.insert(
            fh,
            Handle { rel: rel.clone(), kind: kind.clone(), buf: Vec::new(), dirty: true, new: true },
        );
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
                s.vt.insert(path, VEntry { kind: VKind::Dir, node: None });
                s.vt_ts = None;
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
            let s = self.st.lock().unwrap();
            let parent_path = match s.to_path.get(&parent.0) {
                Some(p) => p.clone(),
                None => {
                    reply.error(err(libc::ENOENT));
                    return;
                }
            };
            let path = join(&parent_path, &name);
            let (rel, _) = self.rel_kind_of(&s, &path);
            (path, rel)
        };
        match self.proj.delete(&rel) {
            Ok(()) => {
                let mut s = self.st.lock().unwrap();
                s.vt.remove(&path);
                s.vt_ts = None;
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
        let rel = path.trim_start_matches('/').to_string();
        match self.proj.delete(&rel) {
            Ok(()) => {
                let mut s = self.st.lock().unwrap();
                s.vt.remove(&path);
                s.vt_ts = None;
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
        let (src_path, src_rel, dst_rel) = {
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
            let (dst_rel, _) = self.rel_kind_of(&s, &dst_path);
            (src_path, src_rel, dst_rel)
        };
        match self.proj.mv(&src_rel, &dst_rel) {
            Ok(()) => {
                let mut s = self.st.lock().unwrap();
                s.vt.remove(&src_path);
                s.vt_ts = None;
                drop(s);
                reply.ok();
            }
            Err(e) => reply.error(err(e.errno)),
        }
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
