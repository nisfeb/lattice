#!/usr/bin/env python3
"""Absolute roads that name a path inside our OWN tree.

[%& lane] is absolute. That is right for three things and wrong for
everything else:

  /sys/...          a runtime service, granted by weir
  a caller's path   a /t/ tree address out of a urb:// url, naming a
                    place on somebody else's ship
  a peer's install  the constant this migration is trying to retire

Anything else - /page, /pub, /know, /comments - is OUR tree, and after the
conversion it must be a relative road or it addresses the old location.

The depth and scope checkers cannot see these: an arm that builds a road
the OLD way never mentions `up`, so it looks clean. This is the check for
what was missed rather than what was mistyped.

  abs-road-audit.py <nexus.hoon>
"""
import re, sys
OURS = ('/page','/pub','/know','/comments','/sub','/template','/legacy',
        '/beacon','/mirror','/share','/app','/ui','/proc','/data','/vault')
bad = []
cur = None
for i, raw in enumerate(open(sys.argv[1])):
    l = re.sub(r'::.*', '', raw)
    m = re.match(r'^\+\+  ([a-z][a-z0-9-]*)', raw)
    if m: cur = m.group(1)
    #  ?=([%& %| *] r) is a PATTERN MATCH on a road somebody handed us, not
    #  a road we build. Nothing to convert.
    if re.search(r'\?=\(\[%&', l): continue
    #  +grub-road takes a path parsed out of a request, so its road names
    #  whatever the caller asked for and absolute is right.
    if cur == 'grub-road': continue
    for road in re.finditer(r'\[%& %[&|] ([^\]]+)\]', l):
        body = road.group(1)
        if '/sys/' in body: continue                 # a runtime service
        #  a road handed to remote-road or peek-remote names a place on
        #  SOMEBODY ELSE'S ship, so absolute is correct there and the peer
        #  base belongs in it.
        if re.search(r'remote-road|peek-remote', l): continue
        #  A road built from a VARIABLE was skipped as 'needs eyes', which
        #  meant thirty-five of them were never looked at. Name the variables
        #  that legitimately hold somebody else's path instead, and flag the
        #  rest - a shorter list to keep honest than a silent one.
        FOREIGN = ('gdir','ug-base','public-grp','prefix','p.pp','pax','dir',
                   'app-base','u.pp','tree-path')
        lit = re.search(r'/[a-z][a-z0-9/-]*', body)
        if lit:
            if not lit.group(0).startswith(OURS): continue
        else:
            if any(re.search(r'(?<![\w.-])'+re.escape(f)+r'(?![\w-])', body) for f in FOREIGN):
                continue
        bad.append((i+1, cur, l.strip()[:66]))
for ln, arm, txt in bad:
    print(f'  {ln:5}  +{arm}: absolute road into our own tree | {txt}')
print(f'{len(bad)} absolute road(s) naming our own tree')
