#!/usr/bin/env python3
"""Measure how long whole-tree publish work stalls a FAKE ship.

usage: stall-check.py <base-url> <raw-cookie-file> [--keep] [--trace] [--resume]
                      [--max-stall S]

Seeds 300 md pages (~2 KB each) under stall/s0..s5, publishes four of the
50-page folders (200 pages), then times, while a poller asks for a cheap
route (GET /apps/lattice/shared-with-me) every 250 ms, one request at a
time:

  share     POST /page-share-tree, 50 pages, private -> shared
  regrow    POST /pub-regrow over every published page
  delete    POST /page-del of a 50-published-page folder

A poll that takes N s means the ship answered nothing else for about N s
(the method of the release-74 investigation). Release 75 froze the ship
for 77 s (share), 48 s (regrow) and 63 s (delete); release 76 yields
between pages and inside a page's publish. Each step starts once the
ship is quiet (a fresh seed keeps every evaluator busy for minutes).
--resume also reloads lattice part way through a share and checks the
writer finishes it. Exits non-zero when any poll during a measured step
is slower than --max-stall (default 3.5 s; release 76 measured 2.4 to
3.2 s worst, the ship's ~0.35 s floor included), or a resume did not
finish. A re-run reuses the
pages there; they are deleted at the end unless --keep.

Never point it at a real ship.
"""
import argparse, json, statistics, sys, threading, time, urllib.error, urllib.request

FOLDERS = 6
PER = 50


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('url')
    ap.add_argument('cookie')
    ap.add_argument('--keep', action='store_true')
    ap.add_argument('--trace', action='store_true', help='list every poll over 2 s')
    ap.add_argument('--resume', action='store_true',
                    help='also reload lattice part way through a share of stall/s4 '
                         'and check the writer finishes it')
    ap.add_argument('--max-stall', type=float, default=3.5)
    a = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)
    base = a.url.rstrip('/') + '/apps/lattice'
    ck = open(a.cookie).read().strip()

    def req(method, path, body=None, timeout=900):
        r = urllib.request.Request(base + path, data=body, method=method,
                                   headers={'Cookie': ck})
        t = time.monotonic()
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                out = resp.status, resp.read()
        except urllib.error.HTTPError as e:
            out = e.code, e.read()
        except Exception as e:  # noqa: BLE001  a timeout is a measurement
            out = 0, str(e).encode()
        return out + (time.monotonic() - t,)

    def measured(label, method, path):
        settle()
        lat, stop = [], threading.Event()

        at = []

        def poll():
            while not stop.is_set():
                t0 = time.monotonic()
                st, _, dt = req('GET', '/shared-with-me', timeout=600)
                lat.append(dt)
                at.append((t0 - start, dt))
                time.sleep(max(0, 0.25 - (time.monotonic() - t0)))

        start = time.monotonic() + 1
        th = threading.Thread(target=poll)
        th.start()
        time.sleep(1)
        st, body, dt = req(method, path)
        time.sleep(1)
        stop.set()
        th.join()
        worst = max(lat) if lat else 0
        p50 = statistics.median(lat) if lat else 0
        print(f'{label:8} {st} op {dt:6.1f}s  polls {len(lat):4}  p50 {p50:5.2f}s'
              f'  max {worst:6.2f}s  >2s {sum(x > 2 for x in lat)}  {body[:60]!r}')
        if a.trace:
            print('         slow polls (start s, took s): ' + ' '.join(
                f'{t:.0f}:{d:.1f}' for t, d in at if d > 2))
        return st, worst

    def settle():
        # a fresh seed leaves every page's evaluator compiling for minutes;
        # measure the job, not that backlog: wait for four quick polls
        quick, t = 0, time.monotonic()
        while quick < 4 and time.monotonic() - t < 1800:
            quick = quick + 1 if req('GET', '/shared-with-me', timeout=600)[2] < 1 else 0
            time.sleep(0.5)

    st, out, _ = req('GET', '/page-tree')
    have = {}
    for n in (json.loads(out).get('nodes', []) if st == 200 else []):
        if n.get('page') and n['path'].startswith('stall/s'):
            have.setdefault(n['path'].split('/')[1], []).append(n.get('share', 'private'))
    body = 'x' * 1900
    print(f'seeding {FOLDERS * PER} pages under stall/ (a re-run keeps what is there)')
    for f in range(FOLDERS):
        if len(have.get(f's{f}', [])) == PER:
            continue
        items = [{'name': f'stall/s{f}/p{f * PER + i:03}', 'type': 'md',
                  'body': f'# page {f * PER + i}\n\n{body}\n'} for i in range(PER)]
        st, out, dt = req('POST', '/page-save-batch', json.dumps(items).encode())
        print(f'  stall/s{f}: {st} in {dt:.1f}s')
        if st != 200:
            sys.exit(f'seed failed: {out[:200]!r}')
    for f in (1, 2, 3):
        if have.get(f's{f}') and all(x != 'private' for x in have[f's{f}']):
            continue
        st, _, dt = req('POST', f'/page-share-tree?name=stall/s{f}&mode=shared')
        print(f'  publish stall/s{f}: {st} in {dt:.1f}s')

    worst = []
    if have.get('s0') and all(x != 'private' for x in have['s0']):
        req('POST', '/page-share-tree?name=stall/s0&mode=private')
    st, w = measured('share', 'POST', '/page-share-tree?name=stall/s0&mode=shared')
    worst.append(('share', st, w))
    st, w = measured('regrow', 'POST', '/pub-regrow')
    worst.append(('regrow', st, w))
    st, w = measured('delete', 'POST', '/page-del?name=stall/s0')
    worst.append(('delete', st, w))

    if a.resume:
        inst = (a.url.rstrip('/') + '/grubbery/ball/apps/shell.shell/desks/'
                'lattice.desk/desk/data/lattice.lattice_app')

        def shares():
            st, out, _ = req('GET', '/page-tree')
            if st != 200:
                return None
            return [n.get('share', 'private') for n in json.loads(out).get('nodes', [])
                    if n.get('page') and n['path'].startswith('stall/s4/')]

        def job():
            r = urllib.request.Request(inst + '/tree-job?info=1', headers={'Cookie': ck})
            try:
                with urllib.request.urlopen(r, timeout=120) as resp:
                    return json.loads(resp.read()).get('text')
            except Exception:  # noqa: BLE001
                return None

        settle()
        th = threading.Thread(target=lambda: req(
            'POST', '/page-share-tree?name=stall/s4&mode=shared', timeout=60))
        th.start()
        time.sleep(15)
        mid = shares() or []
        r = urllib.request.Request(inst, data=b'action=reload-nexus', method='POST',
                                   headers={'Cookie': ck})
        try:
            urllib.request.urlopen(r, timeout=300).read()
        except Exception:  # noqa: BLE001  303 or a dropped connection
            pass
        th.join()
        t = time.monotonic()
        done = False
        while time.monotonic() - t < 1200:
            sh = shares()
            if sh and len(sh) == PER and all(x != 'private' for x in sh) and job() == '0':
                done = True
                break
            time.sleep(10)
        n_mid = sum(x != 'private' for x in mid)
        print(f'resume   {n_mid}/{PER} shared when lattice reloaded; '
              f'{"all shared and the job cleared" if done else "NOT finished"}'
              f' {time.monotonic() - t:.0f}s later')
        worst.append(('resume', 200 if done and n_mid < PER else 0, 0))
        req('POST', '/page-share-tree?name=stall/s4&mode=private')

    if not a.keep:
        st, _, dt = req('POST', '/page-del?name=stall')
        print(f'cleanup: {st} in {dt:.1f}s')
    bad = [(n, s, w) for n, s, w in worst if s != 200 or w > a.max_stall]
    for n, s, w in bad:
        print(f'FAIL  {n}: status {s}, worst poll {w:.2f}s (max {a.max_stall}s)')
    print('stall-check: ' + ('all passed' if not bad else f'{len(bad)} failed'))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
