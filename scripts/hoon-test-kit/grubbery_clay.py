#!/usr/bin/env python3
"""Grubbery libs, rewritten for a clay test desk.

A grubbery desk's code is built by grubbery, not by clay's ford, and the two
disagree on imports and on what a lib's subject already holds:

  /<  face  /lib/a/b.hoon     ->  /+  face=a-b          (ford finds lib/a/b.hoon)
  /<  *  /lib/a.hoon          ->  /+  *a
  /&  face  /lib/dir/         ->  one /* per file as %mime, and face bound to
                                  the (axal (map @ta mime)) grubbery hands over
  /&  face  /lib/x/f.txt      ->  /*  face  %mime  /lib/x/f/txt

and the faces grubbery puts in every subject (tarball, nexus, ...) are
PRELUDE: each becomes a /+ at the top. A relative /< resolves against the
importing file's own directory: a .hoon as above, any other file (a web
client's index.html, say) as /*  face  %mime  <its path>, copied along.
Other runes (/$, /%) and relative /& are refused by name rather than
guessed at.

    grubbery_clay.py <code-root> <src.hoon> <dest.hoon> <desk-root> [prelude ...]

writes dest only when its text changes, copies every file a /& names to the
same path under desk-root, and prints each path it wrote: output means a
change, as rsync -i's does for the plain libs.
"""
import os, re, shutil, sys

IMPORT = re.compile(r'^/<\s+(\*|[a-z][a-z0-9-]*)\s+(\S+)\s*$')
MIME = re.compile(r'^/&\s+([a-z][a-z0-9-]*)\s+(\S+)\s*$')
KNOT = re.compile(r'^[a-z0-9~_.-]+$')


class Refused(Exception):
    pass


def lib_face(path):
    """/lib/a/b.hoon -> a-b, which ford resolves to lib/a/b.hoon."""
    if not (path.startswith('/lib/') and path.endswith('.hoon')):
        raise Refused(f'{path}: only absolute /lib/... .hoon imports are translated')
    return path[len('/lib/'):-len('.hoon')].replace('/', '-')


def seg_path(rel):
    """lib/pytz/foo.txt -> /lib/pytz/foo/txt, the clay path of a file."""
    head, ext = os.path.splitext(rel)
    segs = head.strip('/').split('/') + [ext[1:]]
    for s in segs:
        if not KNOT.match(s):
            raise Refused(f'{rel}: {s!r} is not a knot, so clay cannot hold it')
    return '/' + '/'.join(segs)


def translate(text, code_root, prelude=(), here=''):
    """(clay text, [(src file, desk-relative dest)] of the files a /& or a
    relative /< names). `here` is the importing file's directory under
    code_root, which a relative /< resolves against, as grubbery's does."""
    lines = text.split('\n')
    out, files, body = [f'/+  {p}' for p in prelude], [], []
    n = 0
    for n, line in enumerate(lines):
        s = line.strip()
        if not s or s.startswith('::'):
            out.append(line)
            continue
        m = IMPORT.match(s)
        if m and not m.group(2).startswith('/'):
            # RELATIVE: resolved against the importing file's own directory
            # (./ and ../ as grubbery reads them). A .hoon lands where an
            # absolute import would; any other file is what grubbery makes
            # of it, a %mime built through its extension's mark.
            face, path = m.groups()
            rel = os.path.normpath(os.path.join(here or '.', path))
            if rel == '..' or rel.startswith('../'):
                raise Refused(f'{m.group(2)}: climbs out of the code tree')
            path = '/' + rel
            if not path.endswith('.hoon'):
                if face == '*':
                    raise Refused(f'{m.group(2)}: a file import needs a face')
                rel = path.strip('/')
                out.append(f'/*  {face}  %mime  {seg_path(rel)}')
                files.append((os.path.join(code_root, rel), rel))
                continue
            out.append(f'/+  *{lib_face(path)}' if face == '*' else f'/+  {face}={lib_face(path)}')
            continue
        if m:
            face, path = m.groups()
            out.append(f'/+  *{lib_face(path)}' if face == '*' else f'/+  {face}={lib_face(path)}')
            continue
        m = MIME.match(s)
        if m:
            face, path = m.groups()
            if not path.startswith('/'):
                raise Refused(f'{path}: relative /& paths are not translated')
            src = os.path.join(code_root, path.strip('/'))
            if path.endswith('/'):
                names = sorted(f for f in os.listdir(src) if os.path.isfile(os.path.join(src, f)))
                pairs = []
                for i, name in enumerate(names):
                    rel = path.strip('/') + '/' + name
                    out.append(f'/*  {face}-{i}  %mime  {seg_path(rel)}')
                    files.append((os.path.join(src, name), rel))
                    pairs.append(f"['{name}' {face}-{i}]")
                body.append(f'=/  {face}  ^-  (axal (map @ta mime))')
                body.append(f"  [`(malt `(list [@ta mime])`~[{' '.join(pairs)}]) ~]")
            else:
                rel = path.strip('/')
                out.append(f'/*  {face}  %mime  {seg_path(rel)}')
                files.append((src, rel))
            continue
        if s.startswith('/') and len(s) > 1 and s[1] in '$%*=~-+?':
            if s.startswith('/?'):
                out.append(line)
                continue
            raise Refused(f'line {n + 1}: {s.split()[0]} is not translated')
        break
    else:
        n = len(lines)
    return '\n'.join(out + body + lines[n:]), files


def write_if_changed(path, data, mode='w'):
    if os.path.exists(path):
        with open(path, 'rb' if 'b' in mode else 'r') as f:
            if f.read() == data:
                return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, mode) as f:
        f.write(data)
    return True


def install(code_root, src, dest, desk_root, prelude=(), text=None):
    """Translate src (or text, a mutant of it) into dest on the desk, and
    copy the files it names. Answers the desk paths written."""
    here = os.path.relpath(os.path.dirname(os.path.abspath(src)), os.path.abspath(code_root))
    clay, files = translate(open(src).read() if text is None else text, code_root, prelude,
                            '' if here == '.' else here)
    wrote = [dest] if write_if_changed(dest, clay) else []
    for f, rel in files:
        d = os.path.join(desk_root, rel)
        if write_if_changed(d, open(f, 'rb').read(), 'wb'):
            wrote.append(d)
    return wrote


if __name__ == '__main__':
    code_root, src, dest = sys.argv[1:4]
    desk_root = sys.argv[4]
    try:
        for p in install(code_root, src, dest, desk_root, sys.argv[5:]):
            print(p)
    except Refused as e:
        sys.exit(f'{src}: {e}')
