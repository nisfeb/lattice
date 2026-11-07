#!/usr/bin/env python3
"""Folder sharing across two ships. Against two FAKE ships.

usage: A_URL=... A_COOKIE=<raw cookie file> B_URL=... B_COOKIE=... two-ship-dirshare.py

Then A shares another folder with B alone, unpublished: B reads its index,
with titles, and its pages; a page A adds later B reads too, until A moves
it out, and one A moves in B reads; and B gets the private page's refusal for a
folder not shared with it. Then A unshares the folder: B is told live,
reads neither the pages nor the index, and a page A adds after is not
B's; and a shared folder deleted and made again is not shared.

Ship A shares a folder of three pages, one of them in a subfolder. Ship B
reads the folder's index at urb://~a/<folder>/ and each page over urb://,
in its own reader. Then A moves a page out of the folder, and B no longer
reads it at its old address; A clears the folder's setting, and B reads
neither the index nor the pages left in it.

gate.mjs runs it with --two-ship. Exits non-zero on any failure.
"""
import json
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

    def index(where=None):
        st, txt = read((where or s) + '/')
        m = re.search(r'<ul class="dindex">(.*?)</ul>', txt, re.S)
        if not m:
            return None
        return [n + ('/' if sl else '') for n, sl in re.findall(r'href="[^"]*%2F([A-Za-z0-9-]+)(%2F)?">', m.group(1))]

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

    # ── a folder shared with B alone, not published ──
    ship_b = b('GET', '/~/host')[1].strip()
    g, h = f'{ROOT}/granted', f'{ROOT}/hidden'
    post(f'page-save?type=md&new=1&name={g}/memo', '# Memo for B\n')
    post(f'page-save?type=md&new=1&name={g}/sub/note', '# Note for B\n')
    post(f'page-save?type=md&new=1&name={h}/secret', '# Not for B\n')
    post(f'share-file?name={g}&ship={ship_b}&mode=read')
    until('B reads the index of a folder shared with it', lambda: True if index(g) == ['sub/', 'memo'] else index(g))
    st, txt = read(g + '/')
    check('B sees the page titles there', '>Memo for B</a>' in txt, txt[-300:])
    until('B reads a page in it', lambda: reads(g + '/memo', 'Memo for B'))
    until('B reads its subfolder', lambda: True if index(g + '/sub') == ['note'] else index(g + '/sub'))
    # a page added later is B's too, and moved out it is not
    post(f'page-save?type=md&new=1&name={g}/later', '# Later for B\n')
    until('B reads a page added to the folder later', lambda: reads(g + '/later', 'Later for B'))
    until('B finds it in the folder index', lambda: True if 'later' in (index(g) or []) else index(g))

    def swm(rel):
        st, txt = b('GET', '/apps/lattice/shared-with-me')
        try:
            return any(e['host'] == ship_a and e['path'].endswith(f'/page/{rel}/code') for e in json.loads(txt))
        except ValueError:
            return False
    def swm_dir(rel):
        st, txt = b('GET', '/apps/lattice/shared-with-me')
        try:
            return any(e['host'] == ship_a and e['path'].endswith(f'/page/{rel}/dir-index') for e in json.loads(txt))
        except ValueError:
            return False
    # the folder is one entry in B's shared with me, and a page made in it
    # later adds none: the folder's entry covers it
    until('B lists the folder as one entry', lambda: swm_dir(g) or 'no folder entry in shared-with-me')
    check('B has no entry of its own for the page added later', not swm(g + '/later'))
    check('nor for a page that was in it', not swm(g + '/memo'))
    post(f'page-move?from={g}/later&to={ROOT}/out')
    until('B loses the page moved out', lambda: reads(g + '/later', 'Later for B') is not True)
    until('B cannot read it where it went', lambda: reads(ROOT + '/out', 'Later for B') is not True)
    until('B no longer finds it in the index', lambda: True if 'later' not in (index(g) or ['later']) else index(g))
    until('B is told it was taken back', lambda: (not swm(g + '/later')) or 'still in shared-with-me')
    post(f'page-move?from={ROOT}/out&to={g}/back')
    until('B reads a page moved into the folder', lambda: reads(g + '/back', 'Later for B'))
    st, txt = read(h + '/')
    check('B gets the private refusal for a folder not shared with it',
          index(h) is None and 'not published here' in txt, txt[-200:])

    # ── A unshares the folder: its rule and every grant it made go ──
    gname = ship_b.lstrip('~')

    def group():
        st, txt = a('GET', '/apps/lattice/share-groups')
        try:
            return next((x for x in json.loads(txt) if x['name'] == gname), None)
        except ValueError:
            return None

    def under(rel):
        gr = group() or {}
        return [p for p in gr.get('peek', []) + gr.get('make', []) if f'/page/{rel}/' in p + '/']
    check('the group holds the folder before the unshare', bool(under(g)), str(group())[:300])
    opaque = (group() or {}).get('opaque', 0)
    post(f'unshare-file?name={g}&ship={ship_b}')
    check('the group holds nothing under the folder', under(g) == [], str(under(g)))
    check('nor its index roads', (group() or {}).get('opaque', 0) < opaque, str(group())[:300])
    until('B is told live it was unshared', lambda: (not swm_dir(g)) or 'still in shared-with-me')
    until('B cannot read a page of it', lambda: reads(g + '/memo', 'Memo for B') is not True)
    until('B cannot read its index', lambda: index(g) is None or index(g))
    post(f'page-save?type=md&new=1&name={g}/after', '# After for B\n')
    time.sleep(5)
    check('a page added after the unshare is not granted', under(g) == [], str(under(g)))
    check('B cannot read it', reads(g + '/after', 'After for B') is not True)
    check('B is not told of it', not swm(g + '/after'))

    # ── deleting a shared folder leaves nothing behind ──
    d = f'{ROOT}/gone'
    post(f'page-save?type=md&new=1&name={d}/p', '# Gone for B\n')
    post(f'share-file?name={d}&ship={ship_b}&mode=read')
    until('B reads a page of the folder to delete', lambda: reads(d + '/p', 'Gone for B'))
    post(f'page-del?name={d}')
    until('the group holds nothing under the deleted folder', lambda: under(d) == [] or under(d))
    post(f'page-save?type=md&new=1&name={d}/p', '# Again not for B\n')
    time.sleep(5)
    check('a folder made again at its name is not shared', under(d) == [], str(under(d)))
    check('B cannot read its page', reads(d + '/p', 'Again not for B') is not True)

    a('POST', '/apps/lattice/page-del?name=' + ROOT)
    print(f'{len(fails)} failed' if fails else 'all passed')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
