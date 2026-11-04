#!/usr/bin/env python3
"""Compile the whole lattice desk (code/) the way grubbery does, with no ship.

Release 111 passed every CI check while code/nex/lattice/app.hoon did not
build: a nest-fail at line 14724 that only a stalled local gate caught. The
other checks read the Hoon as text, and offline-tests.sh compiles the libs
its suites import, never app.hoon. This compiles every .hoon file in code/,
app.hoon and its marks included, and fails on the first that does not build.

How: one Hoon expression for `vere eval`. It builds grubbery's compile
subject (+sut in app/grubbery.hoon: its libs as faces over zuse), then
compiles each code/ file with grubbery's own +build-hoon, in dependency
order, against that subject plus the file's /< imports as faces, as
+build-inc in lib/build.hoon does. Marks also go through +build-marc. A
non-hoon import (icon.svg, ui-app/app.js) is a mime there, and an empty
mime here: only its type reaches the compiler.

usage: hoon-build-check.py --grubbery DESK [--code code] [--dump FILE]

DESK is a grubbery desk/ checkout (CI pins it). The vere binary is
$VERE, else the newest ~/software/vere-*-linux-x86_64, and it must be
built with an ivory pill from the ship's arvo (scripts/ivory-pill.py):
stock vere's eval kernel is hoon 137, too old for grubbery.
"""
import argparse, glob, os, re, subprocess, sys, time

# grubbery's +sut, in order: face, lib name
SUT = [('tarball', 'tarball'), ('nexus', 'nexus'), ('marks', 'marks'),
       ('build', 'build'), ('loader', 'loader'), ('server', 'server'),
       ('multipart', 'multipart'), ('http-utils', 'http-utils'),
       ('html-utils', 'html-utils'), ('json-utils', 'json-utils'),
       ('pretty-file', 'pretty-file'), ('bytestream', 'bytestream'),
       ('zlib', 'zlib'), ('io', 'fiberio'), ('cram', 'cram')]
#  +sut's last face, wasm=wasm-lia, is ~ here: the wasm libs alone take over
#  ten minutes in vere eval, and the desk does not use them. Code that did
#  would fail this check on a -find, never pass it wrongly.


def find_vere():
    if os.environ.get('VERE'):
        return os.environ['VERE']
    found = sorted(glob.glob(os.path.expanduser('~/software/vere-*-linux-x86_64')),
                   key=lambda p: [int(x) for x in re.findall(r'\d+', os.path.basename(p))])
    if not found:
        sys.exit('hoon-build-check: no vere binary: set VERE=/path/to/vere')
    return found[-1]


def cord(data):
    """bytes as a Hoon cord literal"""
    out = bytearray(b"'")
    for b in data:
        if b == 0x5c:
            out += b'\\\\'
        elif b == 0x27:
            out += b"\\'"
        elif b < 32 or b == 127:
            out += b'\\%02x' % b
        else:
            out.append(b)
    return bytes(out + b"'")


def ident(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')


# --- grubbery's own libs: clay-style /- and /+ imports -----------------

def clay_header(src):
    """(imports, body) of a clay-dialect file: /- and /+ lines at the top,
    a trailing comma continuing onto the next line"""
    lines, imports, i, cont = src.split('\n'), [], 0, None
    while i < len(lines):
        s = lines[i].strip()
        if cont:
            imports += [(cont, x.strip()) for x in s.split(',') if x.strip()]
            cont = cont if s.endswith(',') else None
        elif s == '' or s.startswith('::') or s.startswith('/?'):
            pass
        elif m := re.match(r'^/([-+])\s+(.*)$', s):
            kind = 'sur' if m.group(1) == '-' else 'lib'
            imports += [(kind, x.strip()) for x in m.group(2).split(',') if x.strip()]
            cont = kind if s.endswith(',') else None
        elif s.startswith('/'):
            sys.exit(f'hoon-build-check: unsupported ford rune in grubbery: {s}')
        else:
            break
        i += 1
    return imports, '\n'.join(lines[i:])


def clay_path(desk, kind, name):
    """clay's lookup: sur/foo-bar.hoon, else sur/foo/bar.hoon, ..."""
    parts = name.split('-')
    for k in range(1, len(parts) + 1):
        p = os.path.join(desk, kind, *parts[:k - 1], '-'.join(parts[k - 1:]) + '.hoon')
        if os.path.exists(p):
            return p
    sys.exit(f'hoon-build-check: grubbery has no /{kind}/{name}')


def grubbery_libs(desk):
    """Hoon defining each grubbery lib once, as g-<kind>-<name>, leaves first"""
    done, out = set(), []

    def visit(kind, name, stack=()):
        key = (kind, name)
        if key in done:
            return
        if key in stack:
            sys.exit(f'hoon-build-check: import cycle at {kind}/{name}')
        imports, body = clay_header(open(clay_path(desk, kind, name)).read())
        faces = []
        for k, item in imports:
            bare = item.startswith('*')
            face, _, dep = item.lstrip('*').partition('=')
            dep = dep or face
            visit(k, dep, stack + (key,))
            faces.append(f'g-{k}-{dep}' if bare else f'{face}=g-{k}-{dep}')
        done.add(key)
        sub = '[' + ' '.join(faces + ['..zuse']) + ']' if faces else '..zuse'
        #  clay reads a file as a series of hoons, each the subject of the
        #  next: =~. The leading . is because a one-item =~ does not parse.
        out.append(f'=/  g-{kind}-{name}\n  =>  {sub}\n=~  .\n{body}\n==\n')

    for _, name in SUT:
        visit('lib', name)
    return ''.join(out)


# --- the lattice desk: grubbery-dialect /< and /& imports --------------

IMPORT = re.compile(r'^/([<&])\s+(\*|[a-z][a-z0-9-]*)\s+(\S+)\s*$')


def grub_header(src):
    """grubbery's +parse-imports: (imports, body, import line count)"""
    lines, imports, i = src.split('\n'), [], 0
    while i < len(lines):
        s = lines[i]
        if s.replace(' ', '') == '' or s.startswith('::'):
            i += 1
            continue
        m = IMPORT.match(s)
        if not m:
            break
        imports.append(m.groups())
        i += 1
    return imports, '\n'.join(lines[i:]), i


def resolve(here_dir, road):
    """a road, as +lane-from-road reads it, to a desk-relative path"""
    if road.startswith('/'):
        return road.strip('/')
    parts, base = road.split('/'), here_dir.split('/') if here_dir else []
    while parts and parts[0] in ('.', '..'):
        if parts.pop(0) == '..':
            if not base:
                return None
            base.pop()
    return '/'.join(base + parts)


def generate(desk, code):
    files = sorted(os.path.relpath(p, code) for p in
                   glob.glob(os.path.join(code, '**', '*.hoon'), recursive=True))
    info, errors = {}, []
    for f in files:
        imports, body, off = grub_header(open(os.path.join(code, f), encoding='utf-8').read())
        deps = []
        for rune, face, road in imports:
            if rune == '&' and road.endswith('/'):
                errors.append(f'{f}: /& directory imports are not modelled here')
                continue
            dep = resolve(os.path.dirname(f), road)
            if dep is None or not os.path.isfile(os.path.join(code, dep)):
                errors.append(f'{f}: missing import {road}')
                continue
            deps.append((face, dep, dep.endswith('.hoon') and rune == '<'))
        info[f] = (deps, body, off)
    if errors:
        sys.exit('hoon-build-check:\n  ' + '\n  '.join(errors))

    order, state = [], {}

    def visit(f):
        if state.get(f) == 2:
            return
        if state.get(f) == 1:
            sys.exit(f'hoon-build-check: circular import at {f}')
        state[f] = 1
        for _, dep, hoon in info[f][0]:
            if hoon:
                visit(dep)
        state[f] = 2
        order.append(f)

    for f in files:
        visit(f)

    #  The eval kernel is ..zuse of the ivory pill vere was built with:
    #  ivory-pill.py makes one from the ship's sys/, since the stock
    #  pill is hoon 137 (no checksum, no cric:crypto).
    out = []
    out.append(grubbery_libs(desk).encode())
    sut = '  '.join([f'{face}=g-lib-{lib}' for face, lib in SUT] + ['wasm=~'])
    out.append(f'''=/  sut=vase
  %+  slop
    !>  :*  {sut}
        ==
  !>(..zuse)
=/  blank=vase  !>(`mime`[/text/plain 0 ''])
=/  need
  |=  [pax=@t r=(each vase tang)]
  ^-  vase
  ?:  ?=(%& -.r)  p.r
  ~>  %slog.[3 leaf+"hoon-build-check: FAILED {{(trip pax)}}"]
  %-  (slog p.r)
  !!
'''.encode())
    for f in order:
        deps, body, off = info[f]
        aug = 'sut'
        for face, dep, hoon in deps:
            v = f'c-{ident(dep)}' if hoon else 'blank'
            if face == '*':
                aug = f'(slop {v} {aug})'
            else:
                aug = f'(slop [[%face %{face} p.{v}] q.{v}] {aug})'
        d, n = os.path.split(f)
        pax = '~[' + ' '.join(f"'{x}'" for x in d.split('/') + [n]) + ']'
        out.append(f'''=/  c-{ident(f)}=vase
  ~>  %slog.[0 leaf+"built /{f}"]
  %+  need  '/{f}'
  %:  build-hoon:g-lib-build
    {aug}
    {pax}
    '''.encode() + cord(body.encode()) + f'''
    {off}
  ==
'''.encode())
        if f.startswith('mar/'):
            out.append(f'''=/  m-{ident(f)}
  =/  r  (mule |.((build-marc:g-lib-marks c-{ident(f)})))
  ?:  ?=(%& -.r)  ~
  ~>  %slog.[3 leaf+"hoon-build-check: FAILED marc /{f}"]
  %-  (slog p.r)
  !!
'''.encode())
    out.append(f"'hoon-build-check: built {len(order)} files'\n".encode())
    return b''.join(out), len(order)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--grubbery', required=True, help="a grubbery desk/ directory")
    ap.add_argument('--code', default='code')
    ap.add_argument('--dump', help='write the generated Hoon here')
    a = ap.parse_args()
    hoon, n = generate(a.grubbery, a.code)
    if a.dump:
        open(a.dump, 'wb').write(hoon)
    start = time.time()
    r = subprocess.run([find_vere(), 'eval'], input=hoon, capture_output=True)
    clean = lambda b: re.sub(r'\x1b\[[0-9;]*m', '', b.decode(errors='replace'))
    err, res = clean(r.stderr), clean(r.stdout)
    noise = re.compile(r'^(loom:|lite:|eval \(run\):|built /)')
    print('\n'.join(l for l in err.splitlines() if not noise.match(l)))
    print(res.strip())
    ok = f'built {n} files' in res
    print(f'hoon-build-check: {"ok" if ok else "FAILED"}, {n} files, '
          f'{time.time() - start:.0f}s in vere eval')
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
