#!/usr/bin/env python3
"""Two checks, aimed at exactly what a signature change breaks:
  1. does an arm use `rail` without binding one?
  2. do calls to the arms whose arity I changed pass the right count?"""
import re, sys
lines = open(sys.argv[1]).read().split('\n')
CHANGED = {'ensure-dir':2,'ensure-nodes':3,'cull-dirs':3,'run-probe':2,
           'run-fetch':2,'run-key-probe':1,'nexus-root':0,'grant-public':1,
           'grant-blob':2,'handle-request':1,'rf':3,'rv':2,
           'cull-slots':3,'put-slots':3}
#  the names that carry position. An arm using one it never bound is the
#  bug that cost three publish rounds: `root` silently resolved to an arm
#  of the same name in another core and nest-failed against @ud.
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
cur=None
for i,l in enumerate(lines):
    m = re.match(r'^\+\+  ([a-z][a-z0-9-]*)', l)
    if m: cur = m.group(1)
    if of_start <= i <= of_end: continue          # rail is in scope here
    for nm in FREE:
        if re.search(r'(?<![\w-])'+nm+r'(?![\w:=-])', l) and (cur,nm) not in binds and '::' not in l:
            bad.append(f'  {i+1:5} +{cur}: uses `{nm}`, binds none | {l.strip()[:56]}')
    for nm,want in CHANGED.items():
        for c in re.finditer(r'\((%s)((?:\s+(?:\([^()]*\)|[^\s()]+))*)\)' % re.escape(nm), l):
            got = len(re.findall(r'\([^()]*\)|[^\s()]+', c.group(2)))
            if got != want:
                bad.append(f'  {i+1:5} +{cur}: ({nm} ..) got {got} wants {want} | {l.strip()[:56]}')
print('\n'.join(bad) if bad else '  clean')
print(len(bad),'suspect')
