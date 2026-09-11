#!/usr/bin/env python3
"""Which nexus fibers can reach each arm, and at what DEPTH.

A nexus-relative road is [%| steps lane]: climb `steps` to the nexus root,
then descend. `steps` is the depth of the fiber that BUILDS the road, so an
arm that builds one is only correct if every fiber that can reach it sits at
the same depth. Get it wrong and the road climbs past the root and crashes
the fiber - and a crashed sig fiber respawns, so it is a crash loop at 100%
CPU rather than an error you read once.

Nothing in the language checks this. +nex-road takes the depth from a rail
the caller happens to hold; a constant takes it from whoever wrote it down.

So: read the depth of every dispatch arm out of its `?+ rail` case, walk the
call graph from each, and report any arm reachable at more than one depth.
Those are the arms that must take the depth as an ARGUMENT rather than read
it from a constant.

  depth-check.py <nexus.hoon> [--all]
"""
import re, sys
from collections import defaultdict

path = sys.argv[1]
show_all = '--all' in sys.argv
raw = open(path).read().split('\n')
#  COMMENTS AND STRINGS ARE NOT CALLS. The first version built its call
#  graph from every lowercase word it saw, so prose in a comment - and this
#  file is mostly prose - wired every arm to every other and reported 40
#  hazards where there were a handful. Strip both before reading calls.
def strip(l):
    l = re.sub(r"'[^']*'", "''", l)
    l = re.sub(r'"[^"]*"', '""', l)
    i = l.find('::')
    return l[:i] if i >= 0 else l
lines = [strip(l) for l in raw]

#  ── the dispatch arms, and the depth each one runs at ──────────────────
#  a case reads [<path pattern> <name pattern>]; the path half's segment
#  count is the fiber's distance from the nexus root.
of_a = next((i for i,l in enumerate(lines) if l.strip().startswith('++  on-file')), None)
if of_a is None: sys.exit('no +on-file')
of_b = next(i for i,l in enumerate(lines) if i>of_a and l.strip()=='--')

def depth_of(case):
    #  [~ %'main.sig']             -> /            -> 0
    #  [[%mirror ~] %'mirror.sig'] -> /mirror      -> 1
    #  [[%ui %requests ~] @]       -> /ui/requests -> 2
    #  [[%page @ *] %code]         -> /page/<name> -> 2   (* is the tail,
    #                                                      not a segment)
    #
    #  The first pass used \S+ for the name half, which is greedy and ate
    #  the closing bracket - so every [~ %'name'] case returned None and
    #  the whole depth-0 world, the writer's, was silently dropped. An
    #  under-reporting checker is the one failure this tool must not have.
    c = case.strip()
    if not c.startswith('['): return None
    head = '~' if re.match(r'^\[\s*~\s', c) else None
    if head is None:
        m = re.match(r'^\[\s*(\[[^\]]*\])', c)
        if not m: return None
        head = m.group(1)
    if head == '~': return 0
    inner = head[1:-1]
    inner = inner.split('~')[0]           # ~ ends the path pattern
    return len(re.findall(r'%[a-z0-9\'.-]+|@(?![a-z])', inner))

#  KEYED BY LINE, not by case text. The lines are stripped of string
#  literals before parsing, which turns [~ %'main.sig'] and
#  [~ %'shares.sig'] into the same text - so a text key silently merged
#  three depth-0 fibers into one and lost the writer's whole subtree.
entries = {}          # case line no -> (depth, [callees])
cur_case = None
for i in range(of_a, of_b):
    s = lines[i].strip()
    if re.match(r'^\[[\[~]', s) and not s.startswith('[%'):
        cur_case = i
        entries[i] = (depth_of(s), [])
        continue
    if cur_case is not None:
        #  `s` is stripped, so a BARE TAIL CALL is the whole line - which an
        #  indentation-anchored pattern can never match. Missing those made
        #  the mirror fiber's entire subtree read as 'unreached', and an
        #  under-reporting checker is worse than none.
        for m in re.finditer(r'\(([a-z][a-z0-9-]{2,})[\s)]|bind:m\s+([a-z][a-z0-9-]{2,})\s*$', s):
            entries[cur_case][1].append(m.group(1) or m.group(2))
        if re.fullmatch(r'[a-z][a-z0-9-]{2,}', s):
            entries[cur_case][1].append(s)
        for n in re.findall(r"(?<![\w:.-])([a-z][a-z0-9-]{2,})(?![\w:-])", s):
            entries[cur_case][1].append(n)

#  ── every arm, its body, and the arms it calls ─────────────────────────
arms, order = {}, []
cur = None
for i,l in enumerate(lines):
    m = re.match(r'^\+\+  ([a-z][a-z0-9-]*)', l)
    if m: cur = m.group(1); arms[cur] = []; order.append(cur)
    elif cur: arms[cur].append(l)
CALL = re.compile(r'\(([a-z][a-z0-9-]{2,})[\s)]|bind:m\s+([a-z][a-z0-9-]{2,})\s*$|^\s+([a-z][a-z0-9-]{2,})\s*$')
def callees(body):
    #  Calls, AND arms passed as values. +fs-op is handed to lick-serve as a
    #  callback and never 'called' anywhere - so a call-shaped scan lost the
    #  whole /fs.sig subtree. For a safety tool the error must point at more
    #  reachability, never less: an extra edge costs a false hazard, a
    #  missing one costs a crash loop nobody predicted.
    out = set()
    for l in body:
        for m in CALL.finditer(l):
            n = m.group(1) or m.group(2) or m.group(3)
            if n in arms: out.add(n)
        for n in re.findall(r"(?<![\w:.-])([a-z][a-z0-9-]{2,})(?![\w:-])", l):
            if n in arms: out.add(n)
    return out
calls = {a: callees(b) - {a} for a,b in arms.items()}

#  ── propagate depth from each entry ────────────────────────────────────
reach = defaultdict(set)
for case,(d,names) in entries.items():
    if d is None: continue
    seen, stack = set(), [n for n in names if n in arms]
    while stack:
        a = stack.pop()
        if a in seen: continue
        seen.add(a); reach[a].add(d)
        stack.extend(calls.get(a, ()))

#  ── which arms are depth-SENSITIVE? ────────────────────────────────────
#  An arm that builds a nexus-relative road is only a HAZARD if it gets the
#  depth from somewhere fixed. An arm that takes the depth as an ARGUMENT is
#  correct at every depth - that is the whole prescription - so flagging it
#  would be flagging the fix.
#
#  Checked against auspex, which was converted by threading `root=@ud`: the
#  first version of this test called five of its arms hazards. They are the
#  cure, not the disease.
#  `[%| ...]` is NOT a road pattern. It is the failure side of every each in
#  the file - [%| 400 'bad name'] - so matching it called four arms hazards
#  that build no road at all. A road is built by +rf, +rv or +nex-road, or
#  named by the old absolute constant.
BUILDS = re.compile(r'\((?:rf|rv)\s|nex-road')
FIXED  = re.compile(r'(?<![\w-])(nexus-root|app-base|req-dir|writer-rail)(?![\w-])')
TAKES  = re.compile(r'(?<![\w-])(root|up|depth)=@ud')
def hazardous(body):
    t = '\n'.join(body)
    if not (BUILDS.search(t) or FIXED.search(t)): return False
    return not TAKES.search(t)
#  +nexus-up DEFINES the depth; it is not a consumer of one.
sens = {a for a,b in arms.items() if hazardous(b)} - {'nexus-up'}
#  `arms` holds STRIPPED lines already, so a mention of app-base in a
#  comment no longer makes an arm look depth-sensitive.

print(f'{len(entries)} dispatch arms: ' + ', '.join(
      f'depth {d}' for d in sorted({d for d,_ in entries.values() if d is not None})))
bad = sorted(a for a in sens if len(reach.get(a,()))>1)
for a in bad:
    print(f'  HAZARD  +{a}: builds a nexus-relative road, reachable at depths {sorted(reach[a])}')
if show_all:
    for a in sorted(sens):
        if a not in bad: print(f'  ok      +{a}: depth {sorted(reach.get(a,[])) or "unreached"}')
print(f'{len(bad)} arm(s) must take the depth as an argument')
