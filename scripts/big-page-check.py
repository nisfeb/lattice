#!/usr/bin/env python3
"""One big page must not slow the ship (perf passes 7 and 8). Against a FAKE ship.

usage: big-page-check.py <base-url> <raw-cookie-file> [--mb N] [--budget S]
                         [--save-budget S] [--render-budget S]

Saves one md page of about N MB (default 1.5) under bigchk-<pid>/, then:

  round-trip  page-source gives the body back byte for byte, kind md. The
              body carries every escape +wrap-content writes (quotes,
              backslashes, tabs, newlines, a control byte), so the encoder
              and the decoder walk all of their branches on a big body.
  budget      page-source of the big page, page-tree and the home route
              each answer within S seconds (default 5), best of two.
  save        a save of the big page with one line added answers within
              --save-budget seconds (default 10), and page-source then
              gives the edited body back byte for byte.
  render      the editor's open (page-source render=1) and the live
              preview (POST page-preview) of the big page each answer
              within --render-budget seconds (default 25), best of two.

Before perf pass 7 every read that unwrapped the page's source stepped
through the body a byte at a time in Hoon: about 7 s for 1.5 MB, paid by
page-source, page-tree, page-dump and home alike. After it they take
about 1.2 s on an idle host and up to 4 s on a saturated one, which is why
the budget is 5 s: well clear of a loaded host, well under the old 7 s.

Perf pass 8 did the same for the save (+wrap-content encoded a byte at a
time) and the markdown render (+ib-in and +wikilinkify copied plain text
a character at a time). On an idle host the save took 3 to 7 s and the
render 30 to 40 s; they now take about 2 s and 5 to 7 s. The render
budget leaves room for a saturated host and still fails the old code.
The save budget only leaves room: the old save of this body took 4 to
5 s, so it would pass too. The page is deleted at the end. Never point
this at a real ship.
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
    ap.add_argument('--budget', type=float, default=5.0)
    ap.add_argument('--save-budget', type=float, default=10.0)
    ap.add_argument('--render-budget', type=float, default=25.0)
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

    def timed(path, method='GET', data=None):
        """best of two wall times, and the last status and answer"""
        best, st, out = None, 0, b''
        for _ in range(2):
            t0 = time.monotonic()
            st, out = req(method, path, data)
            dt = time.monotonic() - t0
            best = dt if best is None else min(best, dt)
        return best, st, out

    def settle():
        """the save's own follow-up work (the evaluator, the indexes) runs
        after it answers: wait until a cheap read is quick three times running"""
        ok, t_end = 0, time.monotonic() + 120
        while ok < 3 and time.monotonic() < t_end:
            t1 = time.monotonic()
            req('GET', f"{base}/beacon-rev")
            ok = ok + 1 if time.monotonic() - t1 < 1 else 0
            time.sleep(1)

    def source_body():
        st, out = req('GET', src)
        d = json.loads(out) if st == 200 else {}
        return st, d

    body = body_of(a.mb)
    q = urllib.parse.urlencode({'name': name, 'type': 'md', 'new': '1'})
    t0 = time.monotonic()
    st, out = req('POST', f"{base}/page-save?{q}", body.encode())
    print(f"saved {len(body.encode())} bytes as {name}: {st} in {time.monotonic() - t0:.1f} s")
    if st != 200:
        print(f"FAIL save: {out[:200]!r}")
        return 1
    src = f"{base}/page-source?{urllib.parse.urlencode({'name': name})}"
    settle()
    try:
        st, d = source_body()
        check('round-trip: page-source body is byte-identical',
              d.get('body') == body, f"status {st}, {len(d.get('body') or '')} chars back")
        check('round-trip: kind md', d.get('kind') == 'md', str(d.get('kind')))
        for label, path in (('page-source of the big page', src),
                            ('page-tree', f"{base}/page-tree"),
                            ('home route', base)):
            dt, st, _ = timed(path)
            check(f"budget: {label} within {a.budget:g} s", st == 200 and dt <= a.budget,
                  f"{dt:.2f} s, status {st}")
        # save: the editor's autosave of the open page, one line added
        edited = body + "one more line, with a quote ' and a backslash \\\n"
        q = urllib.parse.urlencode({'name': name, 'type': 'md'})
        settle()
        t0 = time.monotonic()
        st, out = req('POST', f"{base}/page-save?{q}", edited.encode())
        dt = time.monotonic() - t0
        check(f"save: the big page within {a.save_budget:g} s",
              st == 200 and dt <= a.save_budget, f"{dt:.2f} s, status {st}")
        settle()
        st, d = source_body()
        check('save: page-source gives the edited body back byte for byte',
              d.get('body') == edited, f"status {st}, {len(d.get('body') or '')} chars back")
        # render: the editor's open and the live preview
        dt, st, out = timed(src + '&render=1')
        d = json.loads(out) if st == 200 else {}
        check(f"render: editor open (render=1) within {a.render_budget:g} s",
              st == 200 and dt <= a.render_budget and '<h1>Big page</h1>' in (d.get('html') or ''),
              f"{dt:.2f} s, status {st}")
        dt, st, out = timed(f"{base}/page-preview?type=md", 'POST', edited.encode())
        check(f"render: page-preview within {a.render_budget:g} s",
              st == 200 and dt <= a.render_budget and b'<h1>Big page</h1>' in out,
              f"{dt:.2f} s, status {st}")
    finally:
        st, _ = req('POST', f"{base}/page-del?{urllib.parse.urlencode({'name': name.split('/')[0]})}")
        print(f"cleanup: page-del {name.split('/')[0]}: {st}")
    print('big-page-check: ' + ('all passed' if not fails else f"{len(fails)} failed"))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
