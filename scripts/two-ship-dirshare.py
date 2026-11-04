#!/usr/bin/env python3
"""Folder sharing across two ships. Against two FAKE ships.

usage: A_URL=... A_COOKIE=<raw cookie file> B_URL=... B_COOKIE=... two-ship-dirshare.py

Ship A shares a folder of three pages, one of them in a subfolder. Ship B
reads the folder's index at urb://~a/<folder>/ and each page over urb://,
in its own reader. Then A moves a page out of the folder, and B no longer
reads it at its old address; A clears the folder's setting, and B reads
neither the index nor the pages left in it.

gate.mjs runs it with --two-ship. Exits non-zero on any failure.
"""
import os, re, sys, time, urllib.error, urllib.parse, urllib.request

ROOT = 'dirtwo'


def ship(url, cookie_file):
    ck = open(cookie_file).read().strip()
    base = url.rstrip('/')

    def req(meth, path, body=None, timeout=120):
        r = urllib.request.Request(base + path, data=body.encode() if body is not None else None,
                                   method=meth, headers={'Cookie': ck})
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                return resp.status, resp.read().decode('utf8', 'replace')
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode('utf8', 'replace')
        except Exception as e:  # a reader timeout is a miss, not a crash
            return 0, str(e)
    return req


def main():
    sys.stdout.reconfigure(line_buffering=True)
    a = ship(os.environ['A_URL'], os.environ['A_COOKIE'])
    b = ship(os.environ['B_URL'], os.environ['B_COOKIE'])
    fails = []

    def check(name, ok, why=''):
        print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else ': ' + why))
        if not ok:
            fails.append(name)

    def until(name, fn, secs=180):
        t, last = time.time(), None
        while time.time() - t < secs:
            last = fn()
            if last is True:
                return check(name, True)
            time.sleep(2)
        check(name, False, f'not within {secs} s: {str(last)[:300]}')

    def post(path, body=''):
        st, txt = a('POST', '/apps/lattice/' + path, body)
        if st != 200:
            fails.append(f'POST {path}: {st} {txt[:200]}')

    ship_a = a('GET', '/~/host')[1].strip()
    s = f'{ROOT}/site'

    def read(rel):
        return b('GET', '/apps/lattice?url=' + urllib.parse.quote(f'urb://{ship_a}/{rel}'), timeout=90)

    def index():
        st, txt = read(s + '/')
        m = re.search(r'<ul class="dindex">(.*?)</ul>', txt, re.S)
        return re.findall(r'>([A-Za-z0-9-]+/?)</a>', m.group(1)) if m else None

    def reads(rel, text):
        st, txt = read(rel)
        return True if st == 200 and text in txt else f'{st} {re.sub(r"<[^>]+>", " ", txt)[-160:]}'

    a('POST', '/apps/lattice/page-del?name=' + ROOT)
    for name, body in [('alpha', 'Alpha over urb'), ('zeta', 'Zeta over urb'), ('docs/one', 'Doc one over urb')]:
        post(f'page-save?type=md&new=1&name={s}/{name}', '# ' + body + '\n')
    post(f'page-share-dir?name={s}&mode=shared')

    until('B reads the folder index', lambda: True if index() == ['docs/', 'alpha', 'zeta'] else index())
    until('B reads a page in the folder', lambda: reads(s + '/alpha', 'Alpha over urb'))
    until('B reads a page in the subfolder', lambda: reads(s + '/docs/one', 'Doc one over urb'))

    post(f'page-move?from={s}/alpha&to={ROOT}/moved')
    until('B loses the page moved out', lambda: reads(s + '/alpha', 'Alpha over urb') is not True)
    until('B does not find it where it went', lambda: reads(ROOT + '/moved', 'Alpha over urb') is not True)

    post(f'page-share-dir?name={s}&mode=private')
    until('B loses the pages when the folder is unshared',
          lambda: reads(s + '/zeta', 'Zeta over urb') is not True and reads(s + '/docs/one', 'Doc one over urb') is not True)
    until('B loses the folder index', lambda: index() is None or index())

    a('POST', '/apps/lattice/page-del?name=' + ROOT)
    print(f'{len(fails)} failed' if fails else 'all passed')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
