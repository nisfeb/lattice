"""GrubberyFS: the generic FUSE Operations, driven entirely by a Projection.

Model: build a virtual-path tree once from projection.list() (5s TTL); resolve
and readdir from that dict — no per-op HTTP for structure. Writes buffer in a
handle and POST once on flush, so one :w = one page-save = one eval.
"""
import errno
import os
import stat
import threading
import time

from fuse import FuseOSError, Operations

from .projection import ProjectionError


class WriteHandle:
    __slots__ = ("rel", "kind", "buf", "dirty", "new")

    def __init__(self, rel, kind, buf, new):
        self.rel, self.kind = rel, kind
        self.buf = bytearray(buf)
        self.dirty, self.new = False, new


class GrubberyFS(Operations):
    TREE_TTL = 5.0

    def __init__(self, proj):
        self.p = proj
        self.uid = os.getuid()          # so files appear owned by the mounting user
        self.gid = os.getgid()          # (else rm/chmod prompt on root-owned entries)
        self.lock = threading.RLock()
        self.vt = {}                 # vpath -> ("dir"|"file", Node); "/" always present
        self.vt_ts = 0.0
        self.handles = {}            # fh -> WriteHandle
        self.read_cache = {}         # rel -> bytes
        self._fh = 3
        self._build()
        threading.Thread(target=self.p.watch, args=(self._invalidate,),
                         daemon=True).start()

    # ---------- virtual tree ----------
    def _build(self):
        with self.lock:
            nodes = self.p.list()
            parents = {n.rel.rsplit("/", 1)[0] for n in nodes if "/" in n.rel}
            vt = {"/": ("dir", None)}
            for n in nodes:
                segs = n.rel.split("/")
                for i in range(1, len(segs)):          # synthesize ancestor dirs
                    vt.setdefault("/" + "/".join(segs[:i]), ("dir", None))
                if n.is_dir:
                    vt["/" + n.rel] = ("dir", n)
                elif n.rel in parents:
                    # page-with-children: a dir whose own body is <dir>/<leaf>.<ext>
                    # (not index.md — that would collide with real %index pages)
                    vt["/" + n.rel] = ("dir", n)
                    leaf = n.rel.rsplit("/", 1)[-1]
                    vt[f"/{n.rel}/{leaf}.{self.p.ext_for_kind(n.kind)}"] = ("file", n)
                else:
                    leaf = n.rel.rsplit("/", 1)[-1]
                    vt[f"/{n.rel}.{self.p.ext_for_kind(n.kind)}"] = ("file", n)
            self.vt, self.vt_ts = vt, time.time()

    def _tree(self):
        with self.lock:
            if time.time() - self.vt_ts > self.TREE_TTL:
                self._build()
            return self.vt

    def _invalidate(self, rel):
        with self.lock:
            self.vt_ts = 0.0
            if rel is None:
                self.read_cache.clear()
            else:
                self.read_cache.pop(rel, None)

    def _resolve(self, path):
        return self._tree().get(path.rstrip("/") or "/")

    def _body(self, rel):
        if rel in self.read_cache:
            return self.read_cache[rel]
        data, _mt = self.p.read(rel)
        self.read_cache[rel] = data
        return data

    def _alloc(self):
        with self.lock:
            self._fh += 1
            return self._fh

    def _open_handle_for(self, path):
        """A dirty/new handle covering `path`, if any — lets getattr report a
        just-created or in-progress file the vtree doesn't have yet."""
        try:
            rel, _ = self._rel_kind_of(path)
        except Exception:
            return None
        for h in self.handles.values():
            if h.rel == rel:
                return h
        return None

    # ---------- getattr ----------
    def getattr(self, path, fh=None):
        now = int(time.time())
        own = dict(st_uid=self.uid, st_gid=self.gid)
        ent = self._resolve(path)
        if ent is None:
            h = self._open_handle_for(path)
            if h is not None:                          # created, not yet flushed
                return dict(st_mode=stat.S_IFREG | 0o644, st_nlink=1,
                            st_size=len(h.buf), st_mtime=now, st_ctime=now,
                            st_atime=now, **own)
            raise FuseOSError(errno.ENOENT)
        kind, node = ent
        if kind == "dir":
            return dict(st_mode=stat.S_IFDIR | 0o755, st_nlink=2,
                        st_mtime=int(node.mtime) if node else now, **own)
        # FILE. size from the tree node (no body fetch); an open dirty handle wins.
        h = self._open_handle_for(path)
        size = len(h.buf) if (h is not None and h.dirty) else node.size
        mode = 0o444 if node.readonly else 0o644
        return dict(st_mode=stat.S_IFREG | mode, st_nlink=1, st_size=size,
                    st_mtime=int(node.mtime) or now, st_ctime=int(node.mtime) or now,
                    st_atime=now, **own)

    # ---------- readdir ----------
    def readdir(self, path, fh):
        yield "."
        yield ".."
        base = path.rstrip("/") or "/"
        seen = set()
        for vp in self._tree():
            if vp == "/":
                continue
            parent, _, leaf = vp.rpartition("/")
            parent = parent or "/"
            if parent == base and leaf not in seen:
                seen.add(leaf)
                yield leaf

    # ---------- open / read ----------
    def open(self, path, flags):
        ent = self._resolve(path)
        if ent is None or ent[0] != "file":
            raise FuseOSError(errno.ENOENT)
        node = ent[1]
        if node.readonly and (flags & (os.O_WRONLY | os.O_RDWR | os.O_TRUNC)):
            raise FuseOSError(errno.EACCES)            # generated %index page
        fh = self._alloc()
        base = b"" if (flags & os.O_TRUNC) else self._body(node.rel)
        self.handles[fh] = WriteHandle(node.rel, node.kind, base, new=False)
        if flags & os.O_TRUNC:
            self.handles[fh].dirty = True
        return fh

    def read(self, path, size, offset, fh):
        h = self.handles.get(fh)
        buf = h.buf if h else bytearray(self._body(self._resolve(path)[1].rel))
        return bytes(buf[offset:offset + size])

    # ---------- write: buffer; POST once on flush ----------
    def write(self, path, data, offset, fh):
        h = self.handles[fh]
        if offset > len(h.buf):
            h.buf.extend(b"\0" * (offset - len(h.buf)))
        h.buf[offset:offset + len(data)] = data
        h.dirty = True
        return len(data)

    def truncate(self, path, length, fh=None):
        if fh is not None and fh in self.handles:
            h = self.handles[fh]
            del h.buf[length:]
            if len(h.buf) < length:
                h.buf.extend(b"\0" * (length - len(h.buf)))
            h.dirty = True
            return
        # handle-less truncate (rare: `: > f`, truncate(1)): read-modify-write now.
        ent = self._resolve(path)
        if ent is None or ent[0] != "file":
            raise FuseOSError(errno.ENOENT)
        node = ent[1]
        if node.readonly:
            raise FuseOSError(errno.EACCES)
        body = bytearray(self._body(node.rel))
        del body[length:]
        if len(body) < length:
            body.extend(b"\0" * (length - len(body)))
        if not body:
            body = bytearray(b"\n")            # page-save rejects an empty body
        try:
            self.p.write(node.rel, node.kind, bytes(body), create=False)
        except ProjectionError as e:
            raise FuseOSError(e.errno)
        self._invalidate(node.rel)

    def create(self, path, mode, fi=None):
        rel, kind = self._rel_kind_of(path)
        fh = self._alloc()
        h = WriteHandle(rel, kind, b"", new=True)
        h.dirty = True
        self.handles[fh] = h
        return fh

    def flush(self, path, fh):
        self._commit(fh)
        return 0

    def release(self, path, fh):
        self._commit(fh)
        self.handles.pop(fh, None)
        return 0

    def _commit(self, fh):
        h = self.handles.get(fh)
        if h is None or not h.dirty:
            return
        try:
            self.p.write(h.rel, h.kind, bytes(h.buf), create=h.new)
        except ProjectionError as e:
            raise FuseOSError(e.errno)
        h.dirty = False
        h.new = False
        self._invalidate(h.rel)

    # ---------- namespace ----------
    def mkdir(self, path, mode):
        try:
            self.p.mkdir(path.strip("/"))
        except ProjectionError as e:
            raise FuseOSError(e.errno)
        self._invalidate(None)

    def unlink(self, path):
        ent = self._resolve(path)
        if ent is None:
            raise FuseOSError(errno.ENOENT)
        try:
            self.p.delete(ent[1].rel)
        except ProjectionError as e:
            raise FuseOSError(e.errno)
        self._invalidate(None)

    def rmdir(self, path):
        try:
            self.p.delete(path.strip("/"))
        except ProjectionError as e:
            raise FuseOSError(e.errno)
        self._invalidate(None)

    def rename(self, old, new):
        oent = self._resolve(old)
        if oent is None:
            raise FuseOSError(errno.ENOENT)
        nrel, _ = self._rel_kind_of(new)
        try:
            self.p.move(oent[1].rel, nrel)
        except ProjectionError as e:
            raise FuseOSError(e.errno)
        self._invalidate(None)

    # ---------- helpers ----------
    def _rel_kind_of(self, path):
        """FS path -> (projection rel, kind). Strips the extension; maps a
        page-with-children body file (<dir>/<leaf>.<ext>) back to the parent rel."""
        p = path.strip("/")
        parent, _, leaf = p.rpartition("/")
        stem, dot, ext = leaf.rpartition(".")
        if not dot:
            stem, ext = leaf, ""
        kind = self.p.kind_for_ext(ext) if ext else "hoon"
        if parent and stem == parent.rsplit("/", 1)[-1]:
            ent = self._tree().get("/" + parent)
            if ent and ent[0] == "dir" and ent[1] and ent[1].is_page:
                return parent, kind
        rel = f"{parent}/{stem}" if parent else stem
        return rel, kind
