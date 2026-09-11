#!/usr/bin/env python3
"""Does this nexus DECLARE every system road it actually reaches?

A grubbery app asks for roads in its +weir-json, and the shell grants
exactly those. At the trusted tier there is no weir, so reaching a road you
never declared costs nothing and is invisible. On a sandboxed install it is
a veto - and a veto arrives as a crashed event, which rolls back whatever
the fiber had already written. The symptom therefore shows up somewhere
else entirely:

  auspex declared four pokes and one usergroup peek. +grant-public POKES
  /sys/ames/registry, through reg-register-at:io, which auspex's source
  never names. The key probe proved the scry road, poked %set-caps,
  +do-set-caps wrote /caps and then ran rise work that poked the registry.
  Veto, rollback, and auspex reported "has not been granted the key road"
  on a ship where that road WAS granted.

  lattice declared six pokes and no peek section at all. Its writer peeked
  /sys/ames/usergroups/public.grp on rise, died, respawned, died - a crash
  loop - while page-save answered {"ok":true} and wrote nothing.

Both were hours of runtime hunting for something a grep could have said.

THE HARD PART is that the road is usually not in the app at all: it lives
inside the io arm. `(reg-register-at:io writer-rail)` contains no path. So
this reads lib/fiberio.hoon, maps each io arm to the system roads it
reaches (transitively, since reg-poke reaches it via reg-road), and then
asks which of those arms the app calls.

  weir-check.py <nexus.hoon> [--io lib/fiberio.hoon]

Exit 1 if a reached road is undeclared.
"""
import re, sys, os

args = [a for a in sys.argv[1:] if not a.startswith('--')]
if not args:
    print(__doc__); sys.exit(2)
app_path = args[0]

io_path = None
if '--io' in sys.argv:
    io_path = sys.argv[sys.argv.index('--io') + 1]
else:
    for c in ('/home/sneagan/software/wex/grubbery/lib/fiberio.hoon',
              os.path.join(os.path.dirname(app_path), '../../../lib/fiberio.hoon')):
        if os.path.exists(c): io_path = c; break
if not io_path or not os.path.exists(io_path):
    print('weir-check: cannot find lib/fiberio.hoon (pass --io)'); sys.exit(2)

def arms(src):
    """arm name -> its body text"""
    out, cur, buf = {}, None, []
    for l in src.split('\n'):
        m = re.match(r'^\+\+  ([a-z][a-z0-9-]*)', l)
        if m:
            if cur: out[cur] = '\n'.join(buf)
            cur, buf = m.group(1), [l]
        elif cur is not None:
            buf.append(l)
    if cur: out[cur] = '\n'.join(buf)
    return out

#  A ROAD, not a wire. This distinction is the whole accuracy of the tool:
#  (send-dart %node wire &+&+[/sys %'bowl.sig'] %poke ...) carries a wire
#  named /sys/now AND a road to /sys/bowl.sig, and only the second is
#  weir-gated. Matching bare /sys/... paths counted the wires too and made
#  every arm look like it reached /sys/now.
#
#  The three road shapes, all of which pair a dir path with an optional
#  file name:
#    &+&+[/sys/scry %'main.sig']      sugar for [%& %& ...]
#    [%& %& /sys/ames %'registry']    an absolute FILE road
#    [%& %| /sys/behn]                an absolute DIR road
ROADS = (
    re.compile(r"&\+&\+\[((?:/(?:'[^']+'|[a-z0-9._-]+))+)\s+%'?([a-z0-9._-]+)'?\]"),
    re.compile(r"\[%&\s+%&\s+((?:/(?:'[^']+'|[a-z0-9._-]+))+)\s+%'?([a-z0-9._-]+)'?\]"),
    re.compile(r"\[%&\s+%\|\s+((?:/(?:'[^']+'|[a-z0-9._-]+))+)\]"),
)

def roads_in(txt):
    out = set()
    for rx in ROADS:
        for m in rx.finditer(txt):
            g = m.groups()
            road = g[0] if len(g) == 1 or not g[1] else g[0].rstrip('/') + '/' + g[1]
            if road.startswith('/sys/') or road == '/sys':
                out.add(road)
    return out

#  ── io: arm -> system roads, resolved through arm-to-arm calls ────────
io = arms(open(io_path).read())
direct, calls = {}, {}
for name, body in io.items():
    txt = re.sub(r'::.*', '', body)
    direct[name] = roads_in(txt)
    #  a CALL, not any word that happens to be an arm name. `%poke` is a
    #  dart tag and `poke` is an arm; only the second is a call.
    cand = set(re.findall(r'\(([a-z][a-z0-9-]*)[\s)]', txt))
    cand |= set(re.findall(r'bind:m\s+([a-z][a-z0-9-]*)\s*$', txt, re.M))
    #  a road CONSTANT is referenced bare, never called: reg-poke says
    #  (poke reg-road [...]), and reg-road is where /sys/ames/registry
    #  lives. Missing these made the registry look unreached - the exact
    #  road whose absence this tool exists to have caught.
    cand |= {w for w in re.findall(r'[a-z][a-z0-9-]*', txt)
             if w.endswith('-road') or w.endswith('-rail')}
    calls[name] = {c for c in cand if c in io and c != name}
#  transitive closure
reach = {n: set(direct[n]) for n in io}
for _ in range(len(io)):
    grew = False
    for n in io:
        before = len(reach[n])
        for c in calls[n]: reach[n] |= reach[c]
        if len(reach[n]) != before: grew = True
    if not grew: break

#  ── the app: which io arms does it call, and what does it name inline ─
app = open(app_path).read()
app_txt = re.sub(r'::.*', '', app)

used = {}                                   # road -> {io arms that reach it}
for m in re.finditer(r'([a-z][a-z0-9-]*):io\b', app_txt):
    a = m.group(1)
    for r in reach.get(a, ()): used.setdefault(r, set()).add(a + ':io')
for r in roads_in(app_txt):                 # roads written out in the app
    used.setdefault(r, set()).add('(inline)')
#  A road built from a PATH CONSTANT: lattice says [%& %| public-grp] and
#  ++public-grp ^-(path /sys/ames/usergroups/'public.grp'). Without this the
#  road reads as declared-but-unreached, which is the false negative that
#  matters most here - it invites deleting a grant the app needs.
app_arms = arms(app)
consts = {}
for nm, body in app_arms.items():
    m = re.search(r"\^-\(path\s+((?:/(?:'[^']+'|[a-z0-9._-]+))+)\)", body)
    if m and m.group(1).startswith('/sys/'): consts[nm] = m.group(1)
for nm, road in consts.items():
    if re.search(r"\[%&\s+%[&|]\s+" + re.escape(nm) + r"[\s\]]", app_txt):
        used.setdefault(road, set()).add(f'(via +{nm})')

#  ── what +weir-json declares ─────────────────────────────────────────
wj = arms(app).get('weir-json', '')
declared = [m.group(1) for m in re.finditer(r"line\s+'(/[^']+)'", wj)]
if not declared and 'weir-json' not in arms(app):
    print(f'weir-check: {os.path.basename(app_path)} has no +weir-json '
          '(nothing to check; a nexus with no weir asks for nothing)')
    sys.exit(0)

def covered(road):
    """a declared road covers `road` if it is equal, or a prefix subtree"""
    for d in declared:
        if d.endswith('/'):
            if road == d.rstrip('/') or road.startswith(d): return d
        else:
            if road == d: return d
            #  /sys/ames/registry is a FILE under the /sys/ames dir; a
            #  declared bare dir covers its children only with a slash,
            #  which is the distinction the shell enforces too.
    return None

#  /sys/bowl.sig and friends are named without a trailing slash; normalise
#  the ones fiberio writes as a bare dir when the app declares the file.
missing, ok = [], []
for road in sorted(used):
    d = covered(road)
    (ok if d else missing).append((road, sorted(used[road]), d))

w = max([len(r) for r, _, _ in ok + missing] + [4])
for road, via, d in ok:
    print(f'  ok       {road:<{w}}  <- {", ".join(via)}')
for road, via, _ in missing:
    print(f'  MISSING  {road:<{w}}  <- {", ".join(via)}')

unused = [d for d in declared
          if not any(covered(r) == d for r, _, dd in ok if dd)]
for d in unused:
    print(f'  unused   {d:<{w}}  declared, nothing reaches it')

print(f'{len(missing)} reached-but-undeclared, {len(unused)} declared-but-unreached')
sys.exit(1 if missing else 0)
