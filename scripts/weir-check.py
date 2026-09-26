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

THE CATEGORY MATTERS TOO. A weir grants a road per category - poke, peek
(any read: peek, keep, drop, seek, peep, code, font, born) and make (any
tree change) - so a road declared as a poke does not cover a keep on it.
lattice declared /sys/lick/ as a poke; lick-serve:io keeps and peeks the
socket's /in grub, and the fs port crashed on some reloads while this
tool said ok. Each use of a road is now weighed by its load: the %load
written after it in a send-dart, or else what the arm it is handed to
sends on a road it was handed.

  weir-check.py <nexus.hoon> [--io lib/fiberio.hoon]

Exit 1 if a reached road is undeclared in the category it is reached in.
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
    #  a road with a face in its path: [%& %& (weld /sys/lick name) %in].
    #  lick-serve:io builds its socket's road this way, so without this the
    #  tool never saw it keep and peek /sys/lick/<name>/in.
    re.compile(r"\[%&\s+%&\s+\(weld\s+((?:/[a-z0-9._-]+)+)\s+([a-z][a-z0-9-]*)\)\s+%'?([a-z0-9._-]+)'?\]"),
)

#  grubbery's own table (+dart-to-dest in app/grubbery.hoon): which weir
#  category a %node dart's load is judged in
CAT = {**{l: 'peek' for l in 'peek keep drop seek peep code font born'.split()},
       'poke': 'poke',
       **{l: 'make' for l in 'make cull sand load lose gain firm tag'.split()}}

def road_of(g):
    if len(g) == 3:  return g[0].rstrip('/') + '/<' + g[1] + '>/' + g[2]
    if len(g) == 1 or not g[1]:  return g[0]
    return g[0].rstrip('/') + '/' + g[1]

def cats_at(txt, m, pc):
    """the categories this use of a road is judged in; empty if unknown"""
    eol = txt.find('\n', m.end()); eol = len(txt) if eol < 0 else eol
    after = txt[m.end():eol]
    load = re.match(r"\s+%([a-z]+)\b", after)
    if load and load.group(1) in CAT:  return {CAT[load.group(1)]}
    bol = txt.rfind('\n', 0, m.start()) + 1
    before = txt[bol:m.start()]
    #  a road bound to a face is weighed where the face is used:
    #    =/  gdir=road:tarball  [%& %| public-grp]
    #    ;<  ok=?  bind:m  (exists-soft gdir)
    bound = re.search(r"=/\s+([a-z][a-z0-9-]*)(?:=\S+)?\s+(?:`[^`]*`)?$", before)
    if bound:
        cats = set()
        for u in re.finditer(r"\(([a-z][a-z0-9-]*(?::io)?)\s+" + bound.group(1) + r"\b",
                             txt[m.end():m.end() + 2000]):
            cats |= set(pc(u.group(1)))
        if cats:  return cats
    #  a road that opens its line is an argument of a call on the line
    #  above: (poke:io\n  [%& %& /sys/gall %'main.sig']\n  ...)
    if not before.strip():
        bol = txt.rfind('\n', 0, max(bol - 1, 0)) + 1
        before = txt[bol:m.start()]
    calls_ = re.findall(r"\(([a-z][a-z0-9-]*(?::io)?)\s", before)
    return set(pc(calls_[-1])) if calls_ else set()

def roads_in(txt, pc):
    """{(road, category)}; category '?' when it can't be told"""
    out = set()
    for rx in ROADS:
        for m in rx.finditer(txt):
            road = road_of(m.groups())
            if road.startswith('/sys/') or road == '/sys':
                for c in (cats_at(txt, m, pc) or {'?'}):  out.add((road, c))
    return out

#  ── io: arm -> system roads, resolved through arm-to-arm calls ────────
io = arms(open(io_path).read())
bodies = {n: re.sub(r'::.*', '', b) for n, b in io.items()}

def calls_of(txt, known):
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
    return {c for c in cand if c in known}

calls = {n: calls_of(t, io) - {n} for n, t in bodies.items()}

def closure(seed):
    out = {n: set(v) for n, v in seed.items()}
    for _ in range(len(out)):
        grew = False
        for n in out:
            before = len(out[n])
            for c in calls[n]: out[n] |= out[c]
            if len(out[n]) != before: grew = True
        if not grew: break
    return out

#  what an arm sends on a road it was HANDED: the loads of its send-darts
#  whose road is a face, not a literal, and those of the arms it calls
PARAM = re.compile(r"send-dart(?::io)?\s+%node\s+\S+\s+([a-z][a-z0-9-]*)\s+%([a-z]+)")
param = closure({n: {CAT[l] for _, l in PARAM.findall(t) if l in CAT}
                 for n, t in bodies.items()})
def io_pc(name):  return param.get(name.removesuffix(':io'), ())

direct = {n: roads_in(t, io_pc) for n, t in bodies.items()}
#  a road CONSTANT (++reg-road) has no category of its own: it takes the
#  category of each call it is handed to, (poke reg-road ...) in reg-poke
for n, t in bodies.items():
    for m in re.finditer(r"\(([a-z][a-z0-9-]*)\s+([a-z][a-z0-9-]*-road)\b", t):
        const = direct.get(m.group(2), set())
        for road, _ in const:
            for c in io_pc(m.group(1)):  direct[n].add((road, c))
reach = closure(direct)

#  ── the app: which io arms does it call, and what does it name inline ─
app = open(app_path).read()
app_txt = re.sub(r'::.*', '', app)

app_arms = arms(app)
app_bodies = {n: re.sub(r'::.*', '', b) for n, b in app_arms.items()}
#  the app's own arms that hand a road on (+soft-poke, +bowl-now): what
#  they send on it, directly or through io
app_param = {n: {CAT[l] for _, l in PARAM.findall(t) if l in CAT}
             for n, t in app_bodies.items()}
for n, t in app_bodies.items():
    for m in re.finditer(r'\(([a-z][a-z0-9-]*):io\s+[a-z]', t):
        app_param[n] |= set(io_pc(m.group(1)))
def app_pc(name):
    return io_pc(name) if name.endswith(':io') else app_param.get(name, ())

used = {}                                   # (road, cat) -> {how it's reached}
for m in re.finditer(r'([a-z][a-z0-9-]*):io\b', app_txt):
    a = m.group(1)
    for r in reach.get(a, ()): used.setdefault(r, set()).add(a + ':io')
for r in roads_in(app_txt, app_pc):         # roads written out in the app
    used.setdefault(r, set()).add('(inline)')
#  A road built from a PATH CONSTANT: lattice says [%& %| public-grp] and
#  ++public-grp ^-(path /sys/ames/usergroups/'public.grp'). Without this the
#  road reads as declared-but-unreached, which is the false negative that
#  matters most here - it invites deleting a grant the app needs.
consts = {}
for nm, body in app_arms.items():
    #  ^-(path /sys/...), or a gate whose product is a path spelled out
    #  with a face in it (+obelisk-sub-base): the literal part is the road
    m = re.search(r"\^-\(?\s*path\s+((?:/(?:'[^']+'|[a-z0-9._-]+))+)", body)
    if m and m.group(1).startswith('/sys/'): consts[nm] = m.group(1)
for nm, road in consts.items():
    for m in re.finditer(r"\[%&\s+%[&|]\s+\(?" + re.escape(nm) + r"[\s\]]", app_txt):
        for c in (cats_at(app_txt, m, app_pc) or {'?'}):
            used.setdefault((road, c), set()).add(f'(via +{nm})')

#  a use this could not weigh adds nothing when another use of the same
#  road was weighed: the constant's own '?' line, say
for road, c in [k for k in used if k[1] == '?']:
    if any(r == road and cc != '?' for r, cc in used):
        del used[(road, c)]

#  ── what +weir-json declares ─────────────────────────────────────────
wj = arms(app).get('weir-json', '')
declared = []                               # [(road, category)]
section = None
for l in re.sub(r'::.*', '', wj).split('\n'):
    m = re.search(r":-\s+'(poke|peek|make)'", l)
    if m: section = m.group(1)
    for r in re.findall(r"line\s+'(/[^']+)'", l):
        declared.append((r, section))
if not declared and 'weir-json' not in arms(app):
    print(f'weir-check: {os.path.basename(app_path)} has no +weir-json '
          '(nothing to check; a nexus with no weir asks for nothing)')
    sys.exit(0)

def covers(d, road):
    """a declared road covers `road` if it is equal, or a prefix subtree.
    /sys/ames/registry is a FILE under the /sys/ames dir; a declared bare
    dir covers its children only with a slash, which is the distinction
    the shell enforces too."""
    if d.endswith('/'):  return road == d.rstrip('/') or road.startswith(d)
    return road == d

def covered(road, cat):
    for d, sec in declared:
        if covers(d, road) and (cat == '?' or sec == cat):  return (d, sec)
    return None

missing, ok = [], []
for road, cat in sorted(used):
    d = covered(road, cat)
    (ok if d else missing).append((road, cat, sorted(used[(road, cat)]), d))

w = max([len(r) for r, _, _, _ in ok + missing] + [4])
for road, cat, via, d in ok:
    print(f'  ok       {cat:<4}  {road:<{w}}  <- {", ".join(via)}')
for road, cat, via, _ in missing:
    elsewhere = sorted({sec for d, sec in declared if covers(d, road)})
    why = f'  (declared only as {"/".join(elsewhere)})' if elsewhere else ''
    print(f'  MISSING  {cat:<4}  {road:<{w}}  <- {", ".join(via)}{why}')

unused = [(d, sec) for d, sec in declared
          if not any(dd == (d, sec) for _, _, _, dd in ok)]
for d, sec in unused:
    print(f'  unused   {sec:<4}  {d:<{w}}  declared, nothing reaches it')

unknown = sum(1 for _, c, _, _ in ok if c == '?')
print(f'{len(missing)} reached-but-undeclared, {len(unused)} declared-but-unreached'
      + (f', {unknown} reached in a category this could not tell (?)' if unknown else ''))
sys.exit(1 if missing else 0)
