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
    #  +handle-remote-save writes onto ANOTHER ship's grubbery - it refuses
    #  our own ship explicitly ('own ship: use /grub-save'), so every road
    #  it builds names a place we do not own and absolute is the only thing
    #  it could be.
    if cur == 'handle-remote-save': continue
    #  +explore renders an ARBITRARY namespace location out of a
    #  /x/<ship>/<path> url - a peer's tree as often as ours. Its pax is a
    #  request path, so absolute is the only thing it could be.
    if cur == 'explore': continue
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
        #  This list cost two rounds of silent data loss, both the same way:
        #  a GENERIC variable name on it. 'dir' hid +ensure-dirs (every
        #  directory make vetoed); 'pax' hid +pub-grub-rev (every re-publish
        #  vetoed, which rolled back the share write that ran before it).
        #
        #  A name earns a place here only by saying WHOSE path it holds. If
        #  the name would be at home in any arm in the file, it does not
        #  qualify, however obvious the one case in front of you looks.
        #
        #    gdir, ug-base, public-grp   the usergroup registry, under /sys
        #    prefix                      +remote-road's /sys/ames/ships prefix
        #    app-base                    a PEER's install path
        #    p.pp, u.pp                  a path parsed out of a REQUEST url
        #    tree-path                   a /t/ tree address from a urb:// url
        FOREIGN = ('gdir','ug-base','public-grp','prefix','p.pp',
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

#  A second class, and the one that survived the whole road conversion: our
#  own install path spelled out inside a STRING. These are not roads, so
#  nothing above sees them, and they are not compile errors either - they
#  are URLs handed to a browser. Hardcoded, they worked at the app tier and
#  silently 404'd every clearweb read and public form once the app moved
#  into a desk. Learn the path from /sys/link at runtime (+self-base).
inst = re.compile(r"['\"/]((?:[a-z][a-z0-9-]*)\.[a-z][a-z0-9_-]*_app)")
lit, cur = [], None
for i, raw in enumerate(open(sys.argv[1])):
    l = re.sub(r'::.*', '', raw)
    m = re.match(r'^\+\+  ([a-z][a-z0-9-]*)', raw)
    if m: cur = m.group(1)
    #  +remote-install names a PEER's desk install - where THEY keep the app,
    #  which we reach over ames and could not learn from our own /sys/link.
    if cur == 'remote-install': continue
    #  +app-base IS the old app-tier constant, deliberately: it is where a
    #  PEER still running at the app tier keeps lattice, and +self-base's
    #  fallback for our own trusted-tier install. See +self-base.
    if cur == 'app-base': continue
    for mm in inst.finditer(l):
        lit.append((i + 1, mm.group(1), l.strip()[:62]))
for ln, nm, txt in lit:
    print(f'  {ln:5}  hardcoded install path {nm!r} | {txt}')
print(f'{len(lit)} hardcoded install path(s) in a string')
