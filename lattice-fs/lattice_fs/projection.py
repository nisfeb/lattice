"""LatticeProjection: maps the lattice nexus HTTP surface onto the Projection
seam. This is the only file that knows lattice's routes and grub layout.
"""
import calendar
import errno
import time

from grubbery_fs.auth import NexusClient, NotFound
from grubbery_fs.projection import Node, Projection, ProjectionError

APP = "lattice.lattice_app"          # the grub-path app name (nexus reload log)


def da_str_to_unix(da):
    """'~2026.7.22..18.30.00..cafe' -> unix seconds (UTC). Whole-second is enough
    for mtime; the sub-second `..hex` fraction is dropped. Date-only -> midnight."""
    if not da or not da.startswith("~"):
        return time.time()
    date, _, tod = da[1:].partition("..")
    try:
        y, mo, d = (int(x) for x in date.split("."))
    except ValueError:
        return time.time()
    tod = tod.split("..", 1)[0]                       # drop sub-second fraction
    parts = tod.split(".") if tod else []
    hh, mm, ss = (int(parts[i]) if i < len(parts) else 0 for i in range(3))
    return float(calendar.timegm((y, mo, d, hh, mm, ss, 0, 0, 0)))


class LatticeProjection(Projection):
    def __init__(self, client, our_ship):
        self.c = client
        self.our = our_ship                          # "~sampel-palnet"

    def connect(self):
        self.c.connect()

    def close(self):
        pass

    # ---------- reads ----------
    def list(self):
        out = []
        for n in self.c.get_json("/apps/lattice/page-tree")["nodes"]:
            rel = n["path"]
            if not n["page"]:
                out.append(Node(rel, is_dir=True, is_page=False, kind="",
                                size=0, mtime=time.time(), readonly=False))
                continue
            kind = n["kind"]
            out.append(Node(rel, is_dir=False, is_page=True, kind=kind,
                            size=n.get("size", 0),
                            mtime=da_str_to_unix(n.get("mtime", "")),
                            readonly=(kind == "index"),
                            broken=n.get("broken", False)))
        return out

    def read(self, rel):
        try:
            d = self.c.get_json("/apps/lattice/page-source", {"name": rel})
        except NotFound:
            raise ProjectionError(errno.ENOENT, rel)
        return d["body"].encode("utf-8"), da_str_to_unix(d.get("mtime", ""))

    def errors(self, rel):
        # read the err grub directly via the generic /x/ proxy (?data), exactly
        # as the web editor does. '' = clean. No dedicated route.
        path = f"/apps/lattice/x/{self.our}/apps/{APP}/page/{rel}/err"
        try:
            return self.c.get_raw(path, {"data": ""}).decode("utf-8", "replace").strip()
        except NotFound:
            return ""

    # ---------- writes (through the app's action) ----------
    def write(self, rel, kind, data, *, create):
        params = {"name": rel}
        if kind == "index":
            params["type"] = "index"                 # body generated server-side
        elif kind in Projection.KIND_OF_EXT.values():
            params["type"] = kind                    # md/gmi/html/text/js/css
        else:
            params["type"] = "hoon"
        if create:
            params["new"] = "1"
            # page-save 400s on an empty body for non-index kinds; seed a newline
            # (the editor overwrites it on the real flush).
            if kind != "index" and not data:
                data = b"\n"
        self.c.post("/apps/lattice/page-save", params, body=data)

    def mkdir(self, rel):
        self.c.post("/apps/lattice/folder-new", {"name": rel}, b"")

    def delete(self, rel):
        self.c.post("/apps/lattice/page-del", {"name": rel}, b"")

    def move(self, src, dst):
        # no server rename: read source + create dst + delete src. Re-evals dst.
        d = self.c.get_json("/apps/lattice/page-source", {"name": src})
        self.write(dst, d["kind"], d["body"].encode("utf-8"), create=True)
        self.delete(src)

    # ---------- freshness ----------
    def watch(self, on_change):
        # best-effort: grubbery's native keep-SSE on the /page directory grub
        # (the same endpoint the web editor live-reloads from). Any change frame
        # -> full invalidate. This is a LATENCY accelerator only; the core's 5s
        # TTL poll is the guaranteed correctness floor, so if the frame format
        # differs or the stream never fires, freshness still holds within 5s.
        route = f"/grubbery/api/keep/apps/{APP}/page"
        try:
            for event, _name in self.c.sse(route):
                if event.startswith("old"):
                    continue                         # initial snapshot, not a change
                on_change(None)
        except Exception:
            return
