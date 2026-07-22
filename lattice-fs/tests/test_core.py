#!/usr/bin/env python3
"""T4/T5 — GrubberyFS ops against an in-memory FakeProjection (no libfuse).
Exercises every code path the real mount hits except libfuse's syscall marshal.
Run: python3 tests/test_core.py
"""
import errno
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fuse import FuseOSError                          # noqa: E402
from grubbery_fs.core import GrubberyFS               # noqa: E402
from grubbery_fs.projection import Node, Projection, ProjectionError  # noqa: E402

T = 1_000_000.0


class FakeProjection(Projection):
    """Records read/write calls so tests can assert buffering + no-fetch-getattr."""
    def __init__(self):
        # rel -> (kind, body, readonly)
        self.pages = {
            "notes/todo": ("md", b"# todo\n- a\n", False),
            "blog": ("md", b"# blog root\n", False),          # page-with-children
            "blog/first": ("gmi", b"# first post\n", False),
            "readme": ("index", b"|=(deps ...)\n", True),     # generated, readonly
        }
        self.folders = {"notes"}
        self.read_count = 0
        self.writes = []          # (rel, kind, data, create)
        self.deletes = []
        self.mkdirs = []
        self.moves = []

    def connect(self): pass
    def close(self): pass
    def watch(self, on_change): return           # no-op; TTL poll drives freshness

    def list(self):
        out = []
        for rel in self.folders:
            out.append(Node(rel, True, False, "", 0, T, False))
        for rel, (kind, body, ro) in self.pages.items():
            out.append(Node(rel, False, True, kind, len(body), T, ro))
        return out

    def read(self, rel):
        self.read_count += 1
        if rel not in self.pages:
            raise ProjectionError(errno.ENOENT, rel)
        return self.pages[rel][1], T

    def errors(self, rel): return ""

    def write(self, rel, kind, data, *, create):
        self.writes.append((rel, kind, data, create))
        ro = self.pages.get(rel, (None, None, False))[2]
        self.pages[rel] = (kind, data, ro)

    def mkdir(self, rel): self.mkdirs.append(rel); self.folders.add(rel)
    def delete(self, rel):
        self.deletes.append(rel); self.pages.pop(rel, None); self.folders.discard(rel)
    def move(self, src, dst):
        self.moves.append((src, dst))
        self.pages[dst] = self.pages.pop(src)


def fs():
    return GrubberyFS(FakeProjection())


def check(name, cond):
    if not cond:
        raise AssertionError(name)
    print(f"  ok  {name}")


def test_getattr():
    f = fs()
    import stat
    a = f.getattr("/")
    check("root is dir", a["st_mode"] & stat.S_IFDIR)
    a = f.getattr("/notes/todo.md")
    check("leaf page is regular file", a["st_mode"] & stat.S_IFREG)
    check("size from tree node (== body len)", a["st_size"] == len(b"# todo\n- a\n"))
    check("getattr did NOT fetch body", f.p.read_count == 0)      # Judge #2 fix G
    a = f.getattr("/readme.md")
    check("index page is 0444", (a["st_mode"] & 0o777) == 0o444)
    try:
        f.getattr("/nope.md"); check("missing -> ENOENT", False)
    except FuseOSError as e:
        check("missing -> ENOENT", e.errno == errno.ENOENT)


def test_readdir():
    f = fs()
    root = set(f.readdir("/", None))
    check("root lists notes dir", "notes" in root)
    check("root lists blog dir (page-with-children)", "blog" in root)
    check("root lists readme.md", "readme.md" in root)
    check("root lists todo NOT at top level", "todo.md" not in root)
    blog = set(f.readdir("/blog", None))
    check("blog/ lists its own body file blog.md", "blog.md" in blog)
    check("blog/ lists child first.gmi", "first.gmi" in blog)


def test_write_buffering():
    f = fs()
    fh = f.open("/notes/todo.md", os.O_WRONLY | os.O_TRUNC)
    f.write("/notes/todo.md", b"hello ", 0, fh)
    f.write("/notes/todo.md", b"there ", 6, fh)
    f.write("/notes/todo.md", b"world", 12, fh)
    check("no POST before flush", len(f.p.writes) == 0)
    f.flush("/notes/todo.md", fh)
    check("exactly one POST on flush", len(f.p.writes) == 1)
    rel, kind, data, create = f.p.writes[0]
    check("assembled body", data == b"hello there world")
    check("kind preserved (md)", kind == "md")
    check("not a create (existing page)", create is False)
    f.release("/notes/todo.md", fh)
    check("release does not re-POST (not dirty)", len(f.p.writes) == 1)


def test_create():
    f = fs()
    fh = f.create("/notes/new.md", 0o644)
    f.write("/notes/new.md", b"fresh", 0, fh)
    # getattr before flush must see the in-progress file (create-then-stat)
    a = f.getattr("/notes/new.md")
    check("create-then-getattr sees buffer size", a["st_size"] == 5)
    f.release("/notes/new.md", fh)
    check("create POSTs once", len(f.p.writes) == 1)
    rel, kind, data, create = f.p.writes[0]
    check("create rel strips ext", rel == "notes/new")
    check("create kind from ext", kind == "md")
    check("create flag set", create is True)


def test_index_readonly():
    f = fs()
    try:
        f.open("/readme.md", os.O_WRONLY); check("index write -> EACCES", False)
    except FuseOSError as e:
        check("index write -> EACCES", e.errno == errno.EACCES)
    # reading it is fine (cat/rg work)
    fh = f.open("/readme.md", os.O_RDONLY)
    check("index readable", f.read("/readme.md", 999, 0, fh).startswith(b"|="))


def test_invalidate_and_cache():
    f = fs()
    fh = f.open("/notes/todo.md", os.O_RDONLY)
    b1 = f.read("/notes/todo.md", 999, 0, fh)
    check("read returns body (read_cache init OK)", b1 == b"# todo\n- a\n")
    n0 = f.p.read_count
    fh2 = f.open("/notes/todo.md", os.O_RDONLY)
    f.read("/notes/todo.md", 999, 0, fh2)
    check("second read served from cache (no extra fetch)", f.p.read_count == n0)
    f._invalidate(None)
    fh3 = f.open("/notes/todo.md", os.O_RDONLY)
    f.read("/notes/todo.md", 999, 0, fh3)
    check("invalidate forces a re-fetch", f.p.read_count == n0 + 1)


def test_rename_move():
    f = fs()
    f.rename("/notes/todo.md", "/notes/done.md")
    check("rename uses projection.move (read+create+delete)",
          f.p.moves == [("notes/todo", "notes/done")])


def test_delete():
    f = fs()
    f.unlink("/notes/todo.md")
    check("unlink deletes page rel", f.p.deletes == ["notes/todo"])


def main():
    tests = [test_getattr, test_readdir, test_write_buffering, test_create,
             test_index_readonly, test_invalidate_and_cache,
             test_rename_move, test_delete]
    for t in tests:
        print(t.__name__)
        t()
    print(f"\nALL {len(tests)} core test groups passed.")


if __name__ == "__main__":
    main()
