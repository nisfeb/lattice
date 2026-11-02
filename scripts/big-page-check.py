#!/usr/bin/env python3
"""One big page must not slow the ship (perf pass 7). Against a FAKE ship.

usage: big-page-check.py <base-url> <raw-cookie-file> [--mb N] [--budget S]

Saves one md page of about N MB (default 1.5) under bigchk-<pid>/, then:

  round-trip  page-source gives the body back byte for byte, kind md. The
              body carries every escape +wrap-content writes (quotes,
              backslashes, tabs, newlines, a control byte), so the decoder
              walks all of its branches on a big body.
  budget      page-source of the big page, page-tree and the home route
              each answer within S seconds (default 3), best of two.

Before perf pass 7 every read that unwrapped the page's source stepped
through the body a byte at a time in Hoon: about 7 s for 1.5 MB, paid by
page-source, page-tree, page-dump and home alike. After it they take well
under a second. The page is deleted at the end. Never point this at a real
ship.
"""
import argparse, json, os, sys, time, urllib.error, urllib.parse, urllib.request


def body_of(mb):
    """a deterministic md body of about mb MB with every escape in it"""
    lines = ["# Big page", ""]
    n, i = 0, 0
    while n < mb * 1_000_000:
        if i % 40 == 0:
            s = f"## Section {i // 40}"
        elif i % 97 == 0:
            s = "a path C:\\docs\\it's here\tand a tab, \x01 a control byte"
        else:
            s = f"line {i}: the user's pasted document doesn't stop, it goes on and on."
        lines.append(s)
        n += len(s) + 1
        i += 1
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('url')
    ap.add_argument('cookie')
    ap.add_argument('--mb', type=float, default=1.5)
    ap.add_argument('--budget', type=float, default=3.0)
    a = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)
    root = a.url.rstrip('/')
    base = root + '/apps/lattice'
    ck = open(a.cookie).read().strip()
    fails = []
    name = f"bigchk-{os.getpid()}/big"

    def req(method, path, body=None, timeout=900):
        r = urllib.request.Request(path, data=body, method=method, headers={'Cookie': ck})
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def check(label, ok, detail=''):
        print(('PASS ' if ok else 'FAIL ') + label + (f' ({detail})' if detail else ''))
        if not ok:
            fails.append(label)

    def timed(path):
        """best of two wall times, and the last status"""
        best, st = None, 0
        for _ in range(2):
            t0 = time.monotonic()
            st, _ = req('GET', path)
            dt = time.monotonic() - t0
            best = dt if best is None else min(best, dt)
        return best, st

    body = body_of(a.mb)
    q = urllib.parse.urlencode({'name': name, 'type': 'md', 'new': '1'})
    t0 = time.monotonic()
    st, out = req('POST', f"{base}/page-save?{q}", body.encode())
    print(f"saved {len(body.encode())} bytes as {name}: {st} in {time.monotonic() - t0:.1f} s")
    if st != 200:
        print(f"FAIL save: {out[:200]!r}")
        return 1
    # the save's own follow-up work (the evaluator, the indexes) runs
    # after it answers: wait until a cheap read is quick three times running
    ok, t_end = 0, time.monotonic() + 120
    while ok < 3 and time.monotonic() < t_end:
        t1 = time.monotonic()
        req('GET', f"{base}/beacon-rev")
        ok = ok + 1 if time.monotonic() - t1 < 1 else 0
        time.sleep(1)
    try:
        src = f"{base}/page-source?{urllib.parse.urlencode({'name': name})}"
        st, out = req('GET', src)
        d = json.loads(out) if st == 200 else {}
        check('round-trip: page-source body is byte-identical',
              d.get('body') == body, f"status {st}, {len(d.get('body') or '')} chars back")
        check('round-trip: kind md', d.get('kind') == 'md', str(d.get('kind')))
        for label, path in (('page-source of the big page', src),
                            ('page-tree', f"{base}/page-tree"),
                            ('home route', base)):
            dt, st = timed(path)
            check(f"budget: {label} within {a.budget:g} s", st == 200 and dt <= a.budget,
                  f"{dt:.2f} s, status {st}")
    finally:
        st, _ = req('POST', f"{base}/page-del?{urllib.parse.urlencode({'name': name.split('/')[0]})}")
        print(f"cleanup: page-del {name.split('/')[0]}: {st}")
    print('big-page-check: ' + ('all passed' if not fails else f"{len(fails)} failed"))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
