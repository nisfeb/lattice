#!/usr/bin/env python3
"""Two checks, aimed at exactly what a signature change breaks:
  1. does an arm use `rail` without binding one?
  2. do calls to the arms whose arity I changed pass the right count?"""
import re, sys
#  Strip strings and comments before looking for free names. Without this
#  the word "up" inside a paragraph of HTML, and the /root segment of an
#  ames path, both read as code.
def _strip(l):
    l = re.sub(r'\\"', '', l)
    l = re.sub(r'"[^"]*"', '""', l)
    l = re.sub(r"'[^']*'", "''", l)
    i = l.find('::')
    return l[:i] if i >= 0 else l
lines = [_strip(l) for l in open(sys.argv[1]).read().split('\n')]
CHANGED = {'ensure-dir':2,'ensure-nodes':3,'cull-dirs':3,'run-probe':2,
           'run-fetch':2,'run-key-probe':1,'nexus-root':0,'grant-public':1,
           'grant-blob':2,'handle-request':2,'rf':3,'rv':2,
           'cull-slots':3,'put-slots':3}
#  the names that carry position. An arm using one it never bound is the
#  bug that cost three publish rounds: `root` silently resolved to an arm
#  of the same name in another core and nest-failed against @ud.
#  `base` is deliberately NOT here: it names a JSON field, a URL tape and a
#  revision number elsewhere in this file, so checking it produced 25 false
#  positives - and a check that cries wolf is one you stop reading.
FREE = ('rail','root','up')
#  which arms bind a rail sample
binds, cur = set(), None
for i,l in enumerate(lines):
    m = re.match(r'^\+\+  ([a-z][a-z0-9-]*)', l)
    if m:
        cur = m.group(1)
        #  an arm binds a name either as a |= SAMPLE or with =/ anywhere
        #  in its body. Only the head was checked at first, which called
        #  every `=/  root=@ud  nexus-root` arm a bug - twenty of them.
        j=i+1
        while j < len(lines) and not re.match(r'^\+\+  ', lines[j]): j+=1
        body='\n'.join(lines[i:j])
        for nm in ('rail','root','up'):
            if re.search(r'(?<![\w-])'+nm+r'=', body): binds.add((cur,nm))
#  on-file binds rail for everything lexically inside it, but those arms
#  live in a separate core; treat the on-file block explicitly
of_start = next(i for i,l in enumerate(lines) if l.strip()=='++  on-file')
of_end   = next(i for i,l in enumerate(lines) if i>of_start and l.strip()=='--')
bad=[]
#  every arm's declared arity, read from its own |= head
arity_of = {}
for i, l in enumerate(lines):
    m = re.match(r'^\+\+  ([a-z][a-z0-9-]*)', l)
    if not m: continue
    head = '\n'.join(lines[i:i+3])
    g = (re.search(r'\|=\s*\[([^\]]*)\]', head)
         or re.search(r'\|=\s*([a-z][a-z0-9-]*=[^\s)]+)', head))
    if not g: continue
    #  count only TOP-LEVEL samples: a nested type carries faces of its own,
    #  and [up=@ud dir=path xs=(list [pk=path st=..])] is three arguments,
    #  not five.
    body, depth, n = g.group(1), 0, 0
    for tok in re.finditer(r'[\[\](]|[a-z][a-z0-9-]*=', body):
        t = tok.group(0)
        if t in '[(': depth += 1
        elif t == ']': depth -= 1
        elif depth == 0: n += 1
    arity_of[m.group(1)] = max(1, n)

cur=None
for i,l in enumerate(lines):
    m = re.match(r'^\+\+  ([a-z][a-z0-9-]*)', l)
    if m: cur = m.group(1)
    #  +on-file is INDENTED, so the ^++ arm regex never matches it and
    #  nothing inside it is attributed to an arm. It binds `rail` for every
    #  case; anything else it binds PER CASE, and only from the line the
    #  binding appears on. That is where a binding got renamed to pdir-up
    #  and every `up` beneath it went unbound, unseen, to the ship.
    in_of = of_start <= i <= of_end
    case0 = (max((j for j in range(of_start, i + 1)
                  if re.match(r'^\s+\[[\[~]', lines[j])), default=of_start)
             if in_of else 0)
    for nm in FREE:
        if in_of:
            if nm == 'rail': continue
            if re.search(r'(?<![\w-])' + nm + r'=', '\n'.join(lines[case0:i + 1])): continue
        elif (cur, nm) in binds: continue
        #  not a free name when it is a FACE ACCESS (root.h) or a PATH
        #  SEGMENT (/sys/ames/.../root) - both read as the bare name.
        if re.search(r'(?<![\w/-])'+nm+r'(?![\w:=.-])', l) and '::' not in l:
            where = cur if not in_of else f'on-file case @{case0+1}'
            bad.append(f'  {i+1:5} +{where}: uses `{nm}`, binds none | {l.strip()[:50]}')
    #  arity comes from the arm's OWN signature in THIS file, not a table.
    #  A fixed table is wrong the moment two apps differ - auspex's
    #  handle-request takes one argument and lattice's takes two.
    for nm in CHANGED:
        if nm not in arity_of: continue
        want = arity_of[nm]
        for c in re.finditer(r'\((%s)((?:\s+(?:\([^()]*\)|[^\s()]+))*)\)' % re.escape(nm), l):
            got = len(re.findall(r'\([^()]*\)|[^\s()]+', c.group(2)))
            if got and got != want:
                bad.append(f'  {i+1:5} +{cur}: ({nm} ..) got {got} wants {want} | {l.strip()[:52]}')
#  [root %'x'] / [up %'x'] is a RAIL literal - [path name] - and `root`
#  and `up` are counts now. It compiles and nest-fails at run time against
#  a path, which is a slow way to learn it. Both apps hit this at
#  reg-register-at; neither checker saw it.
#  A var declared @ud but ASSIGNED a path. The root=path -> root=@ud pass
#  was a substring replace, so it also hit troot=path and src-root=path and
#  left them counting a path. Compiles; nest-fails at run time.
for i, l in enumerate(lines):
    m2 = re.search(r'=/\s+[a-z][a-z0-9-]*=@ud\s+(\(weld |/[a-z])', l)
    if m2: bad.append(f'  {i+1:5} declared @ud but assigned a PATH | {l.strip()[:52]}')
for i, l in enumerate(lines):
    for m in re.finditer(r"\[(root|up)\s+%", l):
        bad.append(f'  {i+1:5} rail literal built from a COUNT: [{m.group(1)} %..] | {l.strip()[:48]}')
#  A COUNT handed to an arm whose sample is a `path`. This is the shape
#  that survived every other check and cost three deploy cycles: it
#  compiles, and nest-fails on the manifest so the whole nexus BANGs.
_sig, _cur = {}, None
for i, l in enumerate(lines):
    m = re.match(r'^\+\+  ([a-z][a-z0-9-]*)', l)
    if not m: continue
    _cur = m.group(1)
    head = '\n'.join(lines[i:i+3])
    g = (re.search(r'\|=\s*\[([^\]]*)\]', head)
         or re.search(r'\|=\s*([a-z][a-z0-9-]*=[a-z@][\w:-]*)', head))
    if g: _sig[_cur] = re.findall(r'[a-z][a-z0-9-]*=([a-z@][\w:-]*)', g.group(1))
for i, l in enumerate(lines):
    for c in re.finditer(r'\(([a-z][a-z0-9-]{2,})((?:\s+(?:\([^()]*\)|[^\s()]+))+)\)', l):
        nm = c.group(1)
        if nm not in _sig: continue
        args = re.findall(r'\([^()]*\)|[^\s()]+', c.group(2))
        for k, a in enumerate(args):
            if k < len(_sig[nm]) and a in ('root','up') and _sig[nm][k] == 'path':
                bad.append(f'  {i+1:5} ({nm} ..): a COUNT in a `path` slot #{k+1} | {l.strip()[:46]}')
print('\n'.join(bad) if bad else '  clean')
print(len(bad),'suspect')
