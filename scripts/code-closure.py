#!/usr/bin/env python3
"""Is this code directory closed under everything a GUEST resolves?

A published app is hermetic twice over. desk.hoon: "The host layer resolves
marcs from the root code namespace; the guest resolves against /desk/code.
Guests distribute every marc they use." And +find-code-ns is hermetic for
source: "Lower namespaces must include marks/libs they need."

So unlike the host-world checks, this one resolves MARCS as well as imports.
A marc `[/dir %name]` is mar/dir/name.hoon; `[/ %name]` is mar/name.hoon.

  code-closure.py <code-dir> [--fill <grubbery-desk>]

Without --fill it reports. With it, it copies each missing marc/lib in from
a grubbery desk and repeats until closed, because a vendored marc drags in
its own imports.
"""
import os, re, shutil, sys

code = sys.argv[1].rstrip('/')
fill = None
if '--fill' in sys.argv:
    fill = sys.argv[sys.argv.index('--fill') + 1].rstrip('/')

def files_in(root):
    out = set()
    for dp, dn, fn in os.walk(root):
        for f in fn:
            out.add(os.path.relpath(os.path.join(dp, f), root))
    return out

def norm(p):
    o = []
    for s in p.split('/'):
        if s in ('', '.'): continue
        if s == '..': o and o.pop()
        else: o.append(s)
    return '/'.join(o)

ball = re.compile(r'^\s*/[<&]\s+\S+\s+(\S+)|^\s*/\*\s+\S+\s+%\S+\s+(\S+)', re.M)
#  A MARC IS THE BLOT, NOT THE RAIL. Both are written [/dir %name], and in a
#  %fall row they sit side by side - [%fall %& [/mail %idx] [[/auspex %idx] *x]]
#  - where the FIRST is where the grub lives and only the second names a mark.
#  Matching both made every grub path look like a missing marc.
#
#  A blot appears either inside a pair, [[/dir %name] value], or as a unit,
#  `[/dir %name]. Those two forms are what this matches.
marc = re.compile(r'(?:\[\[|`\[)\s*/((?:[a-z0-9-]+/?)*)\s+%\'?([a-z][a-z0-9-]*)\'?\s*\]')

recv = re.compile(r'[=?]\(\s*\[/((?:[a-z0-9-]+/?)*)\s+%\'?([a-z][a-z0-9-]*)\'?\s*\]')

def wants(rel, have):
    """every path this file needs, as code-dir-relative paths"""
    src = open(os.path.join(code, rel), encoding='utf-8', errors='replace').read()
    out = set()
    for a, b in ball.findall(src):
        pm = a or b
        q = norm(pm.lstrip('/')) if pm.startswith('/') else norm(os.path.dirname(rel) + '/' + pm)
        if pm.endswith('/'):
            if not any(f.startswith(q + '/') for f in have): out.add(q + '/')
            continue
        out.add(q if q in have else q + '.hoon')
    #  A mark we only ever RECEIVE appears as a comparison against an
    #  incoming blot - =([/ %timer-wake] p.sage.u.in) - never as a literal we
    #  construct. Whether a guest must carry those is not answerable by
    #  reading; wallet-nexus ships marks it only receives, so we do too. The
    #  ship is the authority: install and read the BANGs.
    for d, n in recv.findall(src):
        d = '/'.join(s2 for s2 in d.split('/') if s2)
        out.add(f'mar/{d}/{n}.hoon' if d else f'mar/{n}.hoon')
    for d, n in marc.findall(src):
        d = '/'.join(s for s in d.split('/') if s)
        out.add(f'mar/{d}/{n}.hoon' if d else f'mar/{n}.hoon')
    return out

#  a grubbery desk keeps the same tree under gub/, so a code-dir-relative
#  path is found by trying gub/<rel> then <rel>
def source_of(rel):
    for c in (os.path.join(fill, 'gub', rel), os.path.join(fill, rel)):
        if os.path.isfile(c): return c

added, rounds = [], 0
while True:
    rounds += 1
    have = files_in(code)
    missing = set()
    for rel in sorted(f for f in have if f.endswith('.hoon')):
        for w in wants(rel, have):
            if w.endswith('/') or w in have: continue
            missing.add(w)
    if not missing: break
    if not fill:
        print(f'{len(have)} files, {len(missing)} unresolved:')
        for m in sorted(missing): print('   ' + m)
        sys.exit(1)
    got = False
    for m in sorted(missing):
        s = source_of(m)
        if not s:
            print(f'   !! no source for {m}'); continue
        os.makedirs(os.path.join(code, os.path.dirname(m)), exist_ok=True)
        shutil.copyfile(s, os.path.join(code, m))
        added.append(m); got = True
    if not got:
        print('   stuck — missing files have no source'); sys.exit(1)
    if rounds > 20: print('   too many rounds'); sys.exit(1)

n = len(files_in(code))
print(f'{code}: {n} files, closed under source+marcs' + (f' (+{len(added)} vendored)' if added else ''))
for a in added: print('   + ' + a)
