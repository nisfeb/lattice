#!/usr/bin/env python3
"""Whole-tree jobs, seen from outside (release 77). Against a FAKE ship.

usage: job-check.py <base-url> <raw-cookie-file> [--pages N]

  tree-job   GET /tree-job names a folder share while it runs, and is null
             once it is done (the editor asks it when a save times out)
  delete     the legacy POST /delete of a folder is a job too: /tree-job
             names it while it runs, and when it answers every page of the
             folder is unpublished
  regrow     POST /pub-regrow answers grown = the pages it grew (at least
             the folder's), and running = false
  box        an own page shared for EDIT shows no comment box in the reader
             (it is framed sandbox="", where the form is dead), while the
             same page shared for reading keeps it

Seeds N md pages (default 20) under jobchk/f and deletes them at the end.
Exits non-zero on any failure. Never point it at a real ship.
"""
import argparse, json, sys, threading, time, urllib.error, urllib.parse, urllib.request


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('url')
    ap.add_argument('cookie')
    ap.add_argument('--pages', type=int, default=20)
    a = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)
    base = a.url.rstrip('/') + '/apps/lattice'
    ck = open(a.cookie).read().strip()
    fails = []

    def req(method, path, body=None, timeout=900, root=False):
        r = urllib.request.Request((a.url.rstrip('/') if root else base) + path,
                                   data=body, method=method, headers={'Cookie': ck})
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except Exception as e:  # noqa: BLE001
            return 0, str(e).encode()

    def check(name, ok, detail=''):
        print(('ok    ' if ok else 'FAIL  ') + name + ('' if ok else '  ' + str(detail)[:300]))
        if not ok:
            fails.append(name)

    def job():
        st, out = req('GET', '/tree-job', timeout=60)
        if st != 200:
            return ('status', st)
        try:
            return json.loads(out).get('job')
        except ValueError:
            return ('bad', out[:80])

    def published():
        st, out = req('GET', '/list', timeout=120)
        return set(json.loads(out).get('files', [])) if st == 200 else None

    def during(method, path):
        """run a request, polling /tree-job meanwhile: (status, body, jobs seen)"""
        seen, stop = set(), threading.Event()

        def poll():
            while not stop.is_set():
                j = job()
                if isinstance(j, str):
                    seen.add(j)
                time.sleep(1)

        th = threading.Thread(target=poll)
        th.start()
        st, out = req(method, path)
        stop.set()
        th.join()
        return st, out, seen

    names = [f'jobchk/f/p{i:02}' for i in range(a.pages)]
    items = [{'name': n, 'type': 'md', 'body': f'# {n}\n\n' + 'x' * 800 + '\n'} for n in names]
    st, out = req('POST', '/page-save-batch', json.dumps(items).encode())
    if st != 200:
        sys.exit(f'seed failed: {st} {out[:200]!r}')
    print(f'seeded {a.pages} pages under jobchk/f')

    j0 = job()
    check('tree-job: null with no job running', j0 is None, j0)
    st, out, seen = during('POST', '/page-share-tree?name=jobchk/f&mode=shared')
    check('tree-job: names the folder share while it runs', st == 200 and 'share-tree' in seen,
          (st, seen))
    check('tree-job: null once the share is done', job() is None, job())

    pub = published() or set()
    mine = {p for p in pub if p.startswith('jobchk/f/')}
    check('the share published every page', len(mine) == a.pages, len(mine))
    st, out = req('POST', '/pub-regrow')
    r = json.loads(out) if st == 200 else {}
    # every page of the folder grows; an index row whose vault copy does
    # not read as text is skipped, so grown can be under the index's size
    g = r.get('grown', -1)
    check('regrow: grown is the pages it grew', st == 200 and a.pages <= g <= len(pub),
          (st, r, len(pub)))
    check('regrow: not still running when it answers', r.get('running') is False, r)

    st, out, seen = during('POST', '/delete?path=jobchk/f')
    left = {p for p in (published() or {'?'}) if p.startswith('jobchk/f/')}
    check('delete: the legacy folder unpublish is a tree job', st == 200 and 'unpub' in seen,
          (st, seen))
    check('delete: every page is unpublished when it answers', not left, sorted(left)[:5])
    check('delete: no job left behind', job() is None, job())

    # the comment box, read-shared and then edit-shared
    pg = names[0]
    req('POST', '/page-comments?name=' + urllib.parse.quote(pg) + '&on=1')
    host = urllib.request.urlopen(a.url.rstrip('/') + '/~/host', timeout=30).read().decode().strip()
    sb = json.loads(req('GET', '/streams')[1]).get('base')
    view = f'/x/{host}{sb}/page/{pg}/'
    st, out = req('GET', view)
    check('box: an own page in the reader has its comment box', st == 200 and b'Comment as' in out,
          st)
    grp = 'jobchk' + str(int(time.time()) % 100000)
    st, _ = req('POST', '/share-group-save?name=' + grp, json.dumps(
        {'ships': ['~zod'], 'peek': [], 'make': [f'{sb}/page/{pg}']}).encode())
    st2, out = req('GET', view + '?u=' + grp)
    check('box: shared for edit, the sandboxed page has no comment box',
          st == 200 and st2 == 200 and b'Comment as' not in out, (st, st2))
    req('POST', '/share-group-del?name=' + grp)

    st, _ = req('POST', '/page-del?name=jobchk')
    print(f'cleanup: {st}')
    print('job-check: ' + ('all passed' if not fails else f'{len(fails)} failed'))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
