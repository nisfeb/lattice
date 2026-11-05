#!/usr/bin/env python3
"""Folder sharing, seen from outside. Against a FAKE ship.

usage: dirshare-check.py <base-url> <raw-cookie-file>

  inherit    a folder shared with /page-share-dir shares every page under
             it, a subfolder's too, each with `via` naming the folder, and
             a page made in it later takes it
  index      urb://<ship>/<folder>/ and the address without the slash list
             the folder's published pages (by title) and subfolders, by name or
             (?sort=date) oldest first, and its pages open as normal
  override   a page's own setting wins (explicit private included), and
             /page-share-clear gives it the folder's again
  sensitive  a page marked sensitive drops what it took, and gets it back
             when unmarked
  nested     a subfolder with its own setting wins for its pages
  link       a folder set clearweb has one public /c/<folder>/ link that
             lists its pages, each readable at its own /c/ address
  move       a page moved out stops sharing at once, and one moved in
             starts
  unshare    clearing the folder unpublishes every page that only took
             its setting, and leaves pages with their own alone

Seeds about a dozen md pages under dirchk/ and deletes them at the end.
Exits non-zero on any failure. Never point it at a real ship.
"""
import argparse, json, re, sys, time, urllib.error, urllib.parse, urllib.request

ROOT = 'dirchk'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('url')
    ap.add_argument('cookie')
    a = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)
    base = a.url.rstrip('/') + '/apps/lattice'
    ck = open(a.cookie).read().strip()
    fails = []

    def req(meth, path, body=None, anon=False, timeout=120):
        r = urllib.request.Request(path if path.startswith('http') else base + '/' + path,
                                   data=body.encode() if body is not None else None, method=meth,
                                   headers={} if anon else {'Cookie': ck})
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                return resp.status, resp.read().decode('utf8', 'replace')
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode('utf8', 'replace')

    def post(path, body=''):
        st, b = req('POST', path, body)
        if st != 200:
            fails.append(f'POST {path}: {st} {b[:200]}')
        return st

    def check(name, ok, why=''):
        print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else ': ' + why))
        if not ok:
            fails.append(name)

    def nodes():
        st, b = req('GET', 'page-dump')
        return {n['path']: n for n in json.loads(b)['nodes']} if st == 200 else {}

    def until(name, fn, secs=60):
        t = time.time()
        last = None
        while time.time() - t < secs:
            last = fn()
            if last is True:
                check(name, True)
                return True
            time.sleep(1)
        check(name, False, f'not within {secs} s: {last}')
        return False

    def share_of(path):
        n = nodes().get(path) or {}
        return (n.get('share') or 'private', n.get('via'))

    def want(paths):
        def f():
            got = {p: share_of(p) for p in paths}
            return True if got == paths else got
        return f

    st, ship = req('GET', a.url.rstrip('/') + '/~/host')
    ship = ship.strip()

    def index(rel, sort=''):
        u = 'urb://' + ship + '/' + rel
        st, b = req('GET', '?url=' + urllib.parse.quote(u) + ('&sort=date' if sort else ''))
        m = re.search(r'<ul class="dindex">(.*?)</ul>', b, re.S)
        # the names from the links: a page row shows its title instead
        if not m:
            return None
        return [n + ('/' if sl else '') for n, sl in re.findall(r'href="[^"]*%2F([A-Za-z0-9-]+)(%2F)?">', m.group(1))]

    def reads(rel, text):
        st, b = req('GET', '?url=' + urllib.parse.quote('urb://' + ship + '/' + rel))
        return st == 200 and text in b

    s = f'{ROOT}/site'
    req('POST', 'page-del?name=' + ROOT)
    pages = [('alpha', 'Alpha page'), ('zeta', 'Zeta page'), ('docs/one', 'Doc one'), ('docs/deep/two', 'Doc two')]
    for name, body in pages:
        post(f'page-save?type=md&new=1&name={s}/{name}', '# ' + body + '\n')
    post(f'page-save?type=md&new=1&name={ROOT}/outside', '# Outside page\n')

    # ── inherit ──
    post(f'page-share-dir?name={s}&mode=shared')
    until('inherit: every page under the folder takes it, via the folder',
          want({f'{s}/alpha': ('shared', s), f'{s}/zeta': ('shared', s),
                f'{s}/docs/one': ('shared', s), f'{s}/docs/deep/two': ('shared', s),
                f'{ROOT}/outside': ('private', None)}))
    check('inherit: the folder node carries its setting', (nodes().get(s) or {}).get('dshare') == 'shared')
    post(f'page-save?type=md&new=1&name={s}/beta', '# Beta page\n')
    until('inherit: a page made later takes it', want({f'{s}/beta': ('shared', s)}))

    # ── index ──
    until('index: the folder lists its subfolders then pages, by name',
          lambda: True if index(s + '/') == ['docs/', 'alpha', 'beta', 'zeta'] else index(s + '/'))
    check('index: the address without the slash is the same', index(s) == ['docs/', 'alpha', 'beta', 'zeta'], str(index(s)))
    srt = index(s + '/', 'date')
    check('index: ?sort=date lists oldest first', srt is not None and srt.index('alpha') < srt.index('beta'), str(srt))
    check('index: a subfolder lists its own', index(s + '/docs/') == ['deep/', 'one'], str(index(s + '/docs/')))
    until('index: a page inside opens as normal', lambda: reads(s + '/alpha', 'Alpha page'))
    st, b = req('GET', '?url=' + urllib.parse.quote('urb://' + ship + '/' + s + '/'))
    check('index: a page row shows its title', '>Alpha page</a>' in b and '>Zeta page</a>' in b, b[-400:])

    # ── override ──
    post(f'page-share?name={s}/zeta&mode=private')
    until('override: an explicit private wins over the folder', want({f'{s}/zeta': ('private', None)}))
    until('override: and leaves the index', lambda: True if 'zeta' not in (index(s + '/') or []) else index(s + '/'))
    post(f'page-share-clear?name={s}/zeta')
    until('override: use folder setting takes it again', want({f'{s}/zeta': ('shared', s)}))

    # ── sensitive ──
    post(f'page-sensitive?name={s}/beta&on=1')
    until('sensitive: a sensitive page takes no folder setting', want({f'{s}/beta': ('private', None)}))
    post(f'page-sensitive?name={s}/beta&on=0')
    until('sensitive: unmarked, it takes it again', want({f'{s}/beta': ('shared', s)}))

    # ── nested ──
    post(f'page-share-dir?name={s}/docs&mode=clearweb')
    until('nested: the nearest folder wins',
          want({f'{s}/docs/one': ('clearweb', f'{s}/docs'), f'{s}/docs/deep/two': ('clearweb', f'{s}/docs'),
                f'{s}/alpha': ('shared', s)}))

    # ── link ──
    st, b = req('GET', f'{base}/c/{s}/docs/', anon=True)
    check('link: the clearweb folder has one public link', st == 200 and f'/apps/lattice/c/{s}/docs/one' in b
          and f'/apps/lattice/c/{s}/docs/deep/' in b, f'{st} {b[:200]}')
    st, b = req('GET', f'{base}/c/{s}/docs/one', anon=True)
    check('link: a page under it reads at its own /c/ address', st == 200 and 'Doc one' in b, str(st))
    st, b = req('GET', f'{base}/c/{s}/', anon=True)
    check('link: a folder shared over Urbit only has no public link', st == 404, str(st))

    # ── move ──
    post(f'page-move?from={s}/alpha&to={ROOT}/moved')
    until('move: a page moved out stops sharing', want({f'{ROOT}/moved': ('private', None)}))
    until('move: and leaves the index', lambda: True if 'alpha' not in (index(s + '/') or []) else index(s + '/'))
    post(f'page-move?from={ROOT}/outside&to={s}/inside')
    until('move: a page moved in takes the folder', want({f'{s}/inside': ('shared', s)}))

    # ── unshare ──
    post(f'page-share?name={s}/beta&mode=shared')
    post(f'page-share-dir?name={s}&mode=private')
    until('unshare: every page that only took it is private again, own ones stay',
          want({f'{s}/zeta': ('private', None), f'{s}/inside': ('private', None),
                f'{s}/beta': ('shared', None), f'{s}/docs/one': ('clearweb', f'{s}/docs')}))
    until('unshare: the pages leave the index',
          lambda: True if index(s + '/') == ['docs/', 'beta'] else index(s + '/'))
    until('unshare: an unshared page no longer reads', lambda: not reads(s + '/zeta', 'Zeta page'))

    req('POST', 'page-del?name=' + ROOT)
    print(f'{len(fails)} failed' if fails else 'all passed')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
