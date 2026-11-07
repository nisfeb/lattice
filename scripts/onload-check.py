#!/usr/bin/env python3
"""onload-check.py: every grub app.hoon writes has a covering on-load row.

grubbery's loader (lib/loader.hoon) builds the new tree from the rows of
+on-load alone and drops every grub no row covers. A write to a path with
no row works until the next reload, then is silently gone (/pub/titles and
/notify/seen were, for every release before their rows).

So this reads the rows of +on-load (a file row covers its one grub, a
directory row everything under it) and every write in app.hoon (put-file,
over:fio, over-gained:fio, make:fio, over:io, over-as-soft:io,
make-soft:io, over-fold:io), resolves each write's road to a path, and
fails when one is not covered. A road it cannot resolve fails too, unless
EXEMPT names it with the reason, so a new write gets looked at.

  scripts/onload-check.py [code/nex/lattice/app.hoon]
"""
import re
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else 'code/nex/lattice/app.hoon'

# a road expression that names no path in this nexus's tree, or one that is
# deliberately not kept, and why. Keyed by the road text as written.
EXEMPT = {
    # the crash record: a reload resets its counts (+rise-later)
    'rise-road': 'ephemeral by design',
    # +carry-old-data: writes the carried tree into whatever rows declare
    'rod': 'carry: writes only under declared rows',
    'rod.u.ro': 'carry: writes only under declared rows',
    '(rf up / nam.i.fis)': 'carry: root files the old instance had, declared ones only',
    # remote and other-desk roads: not this nexus's tree
    'road.u.hr': 'a remote save, on another ship',
    'dst': 'see the caller: a remote or template destination',
}

# a gate's own path or road argument, by arm:name, and where every caller's
# lies (the check cannot follow a call). Each is checked for a row as well.
PARAMS = {
    'fodt-store:pdir': '/page/*',
    'clearweb-body:pdir': '/page/*',
    'apply-forum-puts:bdir': '/forum/boards/*',
    'pub-regrow-loop:pax.u.or': '/pub/vault/*',
    # the page evaluator's fiber: its rail is the page's, under /page
    'on-file:path.rail': '/page/*',
    'forum-put:bdir': '/forum/boards/*',
    'write-eval-seen:pdir': '/page/*',
    'pub-save-page:pax.u.or': '/pub/vault/*',
    'eval-run:pdir': '/page/*',
    # a page copy: under /page, or /template for a template's
    'copy-tree:ddir': ['/page/*', '/template/*'],
    'copy-filed:base': ['/comments/*', '/comments-held/*'],
    # a change beacon: each sub its callers name (+beacon-subs)
    'beacon-put:sub': 'beacons',
}
# the writes that ARE the write primitives, whose road is their caller's
WRAPPERS = {'put-file', 'ensure-dirs'}

# the arms a write takes its road from, and where those roads live
HELPERS = {
    'link-road': '/links/*',
    'lock-road': '/lock/*',
    'entry-road': None,  # its base argument says
    'skill-road': None,
    'ban-road': '/banned',
    'pub-pending-road': '/pub-pending',
    'pub-trying-road': '/pub-trying',
    'legacy-mark-road': '/legacy/state',
}

WRITES = re.compile(
    r'(?<![\w-])(put-file|over:fio|over-gained:fio|make:fio|over:io|'
    r'over-as-soft:io|make-soft:io|over-fold:io)\s+')


def rows(src):
    """The covering rows of +on-load: (files, dirs)."""
    a = src.index('++  on-load')
    b = src.index('++  on-file', a)
    body = src[a:b]
    body = '\n'.join(l for l in body.split('\n') if not l.strip().startswith('::'))
    files, dirs = set(), set()
    for m in re.finditer(r"\[%(?:fall|stay|over|load) %& \[(/[\w/.-]*) %'?([\w.-]+)'?\]", body):
        d = m.group(1).rstrip('/')
        files.add(f'{d}/{m.group(2)}')
    for m in re.finditer(r"\[%(?:fall|stay|over|load) %\| (/[\w/.-]+)", body):
        dirs.add(m.group(1).rstrip('/'))
    files.add('/manifest.json')  # manifest:loader
    return files, dirs


def lit_name(t):
    m = re.fullmatch(r"%'?([\w.-]+)'?", t)
    return m.group(1) if m else None


def split_args(t):
    """Top-level whitespace-separated hoon terms of t."""
    out, depth, cur = [], 0, ''
    i = 0
    while i < len(t):
        c = t[i]
        if c in '([':
            depth += 1
        elif c in ')]':
            depth -= 1
        if c in ' \t\n' and depth == 0:
            if cur:
                out.append(cur)
            cur = ''
            # a run of blanks
        else:
            cur += c
        i += 1
    if cur:
        out.append(cur)
    return out


def first_term(t):
    t = t.lstrip()
    if not t:
        return ''
    if t[0] in '([':
        depth = 0
        for i, c in enumerate(t):
            if c in '([':
                depth += 1
            elif c in ')]':
                depth -= 1
                if depth == 0:
                    return t[:i + 1]
        return t
    if t.startswith(':(') or t.startswith(':['):
        return ':' + first_term(t[1:])
    m = re.match(r'[^\s()\[\]]+', t)
    return m.group(0) if m else ''


class Resolver:
    def __init__(self, lines):
        self.lines = lines
        self.text = '\n'.join(lines)

    def arm(self, at):
        for i in range(at, -1, -1):
            m = re.match(r'\+\+  ([\w-]+)', self.lines[i])
            if m:
                return m.group(1)
            if re.match(r'    \+\+  on-file', self.lines[i]):
                return 'on-file'
        return ''

    def binding(self, name, at):
        """The expression bound to `name` before line `at`: the nearest
        =/ in this arm, else a ++ arm of that name. ('param', key) when it
        is the arm's own argument."""
        pat = re.compile(r'=/\s+' + re.escape(name) + r'(?:=[\w:$-]+(?:\([^)]*\))?)?\s+(.*)$')
        par = re.compile(r'\|=\s+.*(?<![\w.-])' + re.escape(name) + r'=')
        for i in range(at, max(0, at - 400), -1):
            l = self.lines[i]
            if l.startswith('++  ') and i != at:
                break
            if par.search(l):
                return ('param', f'{self.arm(at)}:{name}')
            m = pat.search(l)
            if m:
                e = m.group(1).strip()
                if not e:
                    e = self.lines[i + 1].strip()
                return first_term(e)
        m = re.search(r'^\+\+  ' + re.escape(name) + r'\s+(.*)$', self.text, re.M)
        if m:
            e = m.group(1).strip()
            if e.startswith('|=') or not e:
                # the body's first (rf ...)
                start = m.end()
                body = self.text[start:start + 600]
                r = re.search(r'\(rf \w+ [^\n]*', body)
                return first_term(r.group(0)) if r else None
            return first_term(e)
        return None

    def dir(self, t, at, depth=0):
        """A path term as a pattern ('/a/b' or '/a/*'), None if unknown."""
        t = t.strip()
        if re.fullmatch(r'/[\w/.-]*', t):
            return t.rstrip('/') or ''
        if t == '/':
            return ''
        if t == 'path.rail':
            return PARAMS.get(f'{self.arm(at)}:path.rail')
        m = re.fullmatch(r':?\((weld|welp|snoc)\s+(.*)\)', t, re.S)
        if m:
            args = split_args(m.group(2))
            if args:
                head = self.dir(args[0], at, depth + 1)
                if head is None:
                    return None
                if isinstance(head, list):
                    return [h.rstrip('*').rstrip('/') + '/*' for h in head]
                return head.rstrip('*').rstrip('/') + '/*'
        if re.fullmatch(r'[\w-]+(\.[\w.-]+)?', t) and depth < 6:
            k = f'{self.arm(at)}:{t}'
            if k in PARAMS:
                return PARAMS[k]
            b = self.binding(t, at)
            if isinstance(b, tuple):
                return PARAMS.get(b[1])
            if b and b != t:
                return self.dir(b, at, depth + 1)
        return None

    def road(self, t, at, depth=0):
        """A road term as a path pattern, or None."""
        t = t.strip()
        m = re.fullmatch(r'\(rf\s+(.*)\)', t, re.S)
        if m:
            args = split_args(m.group(1))
            if len(args) == 3:
                d = self.dir(args[1], at)
                if d is None or isinstance(d, list) or d == 'beacons':
                    return d
                n = lit_name(args[2])
                claim = PARAMS.get(f'{self.arm(at)}:{args[2]}')
                if n is None and claim is not None:
                    return claim
                base = d.rstrip('*').rstrip('/')
                if d.endswith('*'):
                    return base + '/*'
                return f'{base}/{n}' if n else base + '/*'
        m = re.fullmatch(r'\(rv\s+(.*)\)', t, re.S)
        if m:
            args = split_args(m.group(1))
            if len(args) == 2:
                d = self.dir(args[1], at)
                return None if d is None else d.rstrip('*').rstrip('/') + '/*'
        m = re.fullmatch(r'\(([\w-]+)\s+(.*)\)', t, re.S)
        if m and m.group(1) in HELPERS:
            h = HELPERS[m.group(1)]
            if h:
                return h
            args = split_args(m.group(2))
            if len(args) >= 2:
                d = self.dir(args[1], at)
                return None if d is None else d.rstrip('*').rstrip('/') + '/*'
        if re.fullmatch(r'[\w-]+(\.[\w.-]+)?', t) and depth < 6:
            if t in HELPERS and HELPERS[t]:
                return HELPERS[t]
            b = self.binding(t, at)
            if isinstance(b, tuple):
                if b[1].split(':')[0] in WRAPPERS:
                    return 'wrapper'
                return PARAMS.get(b[1])
            if b and b != t:
                return self.road(b, at, depth + 1)
        return None


def beacon_subs(src):
    """Every beacon a call names: (bump-beacon %x ..) and (beacon-put r %x ..)."""
    subs = set(re.findall(r'\(bump-beacon %([\w-]+)', src))
    subs |= set(re.findall(r'\(beacon-put \w+ %([\w-]+)', src))
    return [f'/beacon/{x}' for x in sorted(subs)]


def covered(p, files, dirs):
    if isinstance(p, list):
        return all(covered(q, files, dirs) for q in p)
    if p.endswith('/*'):
        base = p[:-2]
        return any(base == d or base.startswith(d + '/') for d in dirs)
    if p in files:
        return True
    return any(p.startswith(d + '/') for d in dirs)


def main():
    src = open(SRC).read()
    lines = src.split('\n')
    files, dirs = rows(src)
    res = Resolver(lines)
    bad = []
    seen = 0
    for i, l in enumerate(lines):
        if l.strip().startswith('::') or l.startswith('++  '):
            continue
        if res.arm(i) in WRAPPERS:
            continue
        for m in WRITES.finditer(l):
            rest = l[m.end():]
            if not rest.strip():
                rest = lines[i + 1]
            t = first_term(rest)
            if not t:
                continue
            seen += 1
            if t in EXEMPT:
                continue
            p = res.road(t, i)
            if p == 'wrapper':
                continue
            if p == 'beacons':
                p = beacon_subs(src)
            if p is None:
                bad.append(f'{SRC}:{i + 1}: cannot tell where {t} is (add it to EXEMPT with a reason, or name its road plainly)')
            elif not covered(p, files, dirs):
                bad.append(f'{SRC}:{i + 1}: {p} has no covering on-load row, so a reload drops it ({t})')
    for b in bad:
        print(b)
    print(f'onload-check: {seen} writes, {len(files)} file rows, {len(dirs)} dir rows, {len(bad)} uncovered')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
