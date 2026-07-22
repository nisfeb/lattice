#!/usr/bin/env python3
"""T2/T3 — LatticeProjection against the LIVE nexus (no FUSE).

Needs a session cookie. Provide one of:
  LATTICE_COOKIE_JAR=<netscape jar>   (extracts the urbauth cookie)
  or an existing ~/.config/lattice-fs/cookie
  or LATTICE_CODE + a login
Base: LATTICE_URL (default http://localhost:8080).
Run: LATTICE_COOKIE_JAR=/path/to/jar python3 tests/test_live.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from grubbery_fs.auth import NexusClient             # noqa: E402
from grubbery_fs.projection import ProjectionError, Node  # noqa: E402
from lattice_fs.projection import LatticeProjection, da_str_to_unix  # noqa: E402


def _cookie_from_jar(jar_path, cookie_out):
    with open(jar_path) as f:
        for line in f:
            if "urbauth-" in line:
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 7:
                    with open(cookie_out, "w") as o:
                        o.write(f"{parts[5]}={parts[6]}")
                    return True
    return False


def check(name, cond):
    if not cond:
        raise AssertionError(name)
    print(f"  ok  {name}")


def main():
    base = os.environ.get("LATTICE_URL", "http://localhost:8080")
    ckpath = os.path.join(os.path.dirname(__file__), ".live-cookie")
    jar = os.environ.get("LATTICE_COOKIE_JAR")
    if jar and _cookie_from_jar(jar, ckpath):
        print(f"cookie extracted from jar -> {ckpath}")
    elif os.path.exists(os.path.expanduser("~/.config/lattice-fs/cookie")):
        ckpath = os.path.expanduser("~/.config/lattice-fs/cookie")

    c = NexusClient(base, ckpath)
    c.connect()
    proj = LatticeProjection(c, c.ship())
    print(f"connected as {proj.our} @ {base}")

    # ---- list() ----
    nodes = proj.list()
    check("list returns Nodes", nodes and all(isinstance(n, Node) for n in nodes))
    folders = [n for n in nodes if n.is_dir]
    pages = [n for n in nodes if n.is_page]
    check("has at least one page", len(pages) > 0)
    kinds = {n.kind for n in pages}
    check("kinds valid", kinds <= {"md", "gmi", "html", "text", "js", "css",
                                   "hoon", "index"})
    # page-with-children: a page rel that is a prefix of another node
    rels = {n.rel for n in nodes}
    pwc = [p for p in pages if any(r.startswith(p.rel + "/") for r in rels)]
    print(f"  info {len(folders)} folders, {len(pages)} pages, kinds={sorted(kinds)}, "
          f"page-with-children={[p.rel for p in pwc][:3]}")

    # ---- read() a known md page ----
    md = next((p for p in pages if p.kind == "md"), None)
    if md:
        body, mt = proj.read(md.rel)
        check("read md returns bytes", isinstance(body, bytes) and len(body) > 0)
        check("read md is unwrapped (no content-env-pre wrapper)",
              b"content-env" not in body[:40] and not body.lstrip().startswith(b"|="))
        check("read mtime plausible (>2020)", mt > 1_577_836_800.0)

    # ---- errors(): clean page '' ; a broken page non-empty (if any) ----
    if md:
        check("clean page errors() == ''", proj.errors(md.rel) == "")
    broken = next((p for p in pages if p.broken), None)
    if broken:
        check("broken page errors() non-empty", proj.errors(broken.rel) != "")
    else:
        print("  info no page flagged broken in tree; skipping broken-errors check")

    # ---- write/read/delete lifecycle on a throwaway page ----
    probe = "fs-test/probe"
    try:
        proj.delete(probe)          # clean slate from a prior run
    except ProjectionError:
        pass
    time.sleep(0.3)
    proj.write(probe, "md", b"# probe\nhello from lattice-fs\n", create=True)
    time.sleep(0.3)
    body, mt0 = proj.read(probe)
    check("created page round-trips", body == b"# probe\nhello from lattice-fs\n")
    # 409 on re-create
    try:
        proj.write(probe, "md", b"x", create=True)
        check("re-create -> EEXIST", False)
    except ProjectionError as e:
        import errno as _e
        check("re-create -> EEXIST", e.errno == _e.EEXIST)
    # empty-body create seed (no 400)
    probe2 = "fs-test/empty"
    try:
        proj.delete(probe2)
    except ProjectionError:
        pass
    time.sleep(0.3)
    proj.write(probe2, "md", b"", create=True)   # would 400 without the seed
    check("empty-body create seeded (no 400)", True)

    # ---- update (edit) bumps mtime monotonically (T3) ----
    time.sleep(1.1)
    proj.write(probe, "md", b"# probe v2\nedited\n", create=False)
    time.sleep(0.3)
    body2, mt1 = proj.read(probe)
    check("edit persists", body2 == b"# probe v2\nedited\n")
    check("mtime monotonic after edit", mt1 >= mt0)

    # ---- move() ----
    dst = "fs-test/moved"
    try:
        proj.delete(dst)
    except ProjectionError:
        pass
    time.sleep(0.3)
    proj.move(probe, dst)
    time.sleep(0.3)
    mbody, _ = proj.read(dst)
    check("moved page present with body", mbody == b"# probe v2\nedited\n")
    try:
        proj.read(probe)
        check("source gone after move", False)
    except ProjectionError as e:
        import errno as _e
        check("source gone after move", e.errno == _e.ENOENT)

    # ---- cleanup ----
    for p in (dst, probe2):
        try:
            proj.delete(p)
        except ProjectionError:
            pass

    # ---- da_str_to_unix table (T3) ----
    check("da full form", abs(da_str_to_unix("~2026.7.22..19.14.23") - 1784747663.0) < 1)
    check("da date-only -> midnight", da_str_to_unix("~2026.7.20") == 1784505600.0)
    check("da with fraction ignores sub-second",
          da_str_to_unix("~2026.7.22..19.14.23..7942") == da_str_to_unix("~2026.7.22..19.14.23"))

    print("\nLIVE projection tests passed.")


if __name__ == "__main__":
    main()
