#!/usr/bin/env python3
"""Wait for a dev-deployed lattice desk to build, and judge it.

usage: hoon-build-wait.py <base-url> <cookie-jar> <stamp> <code-dir> [--wait S]

hoon-build.sh's check runs it after dev-deploy.py. It waits for the desk
to hold the deploy's version stamp, then asks ?info=1 of every .hoon file
of <code-dir> in the desk until each reports a build status. Any status
but vase fails, as does a non-null bang on the lattice instance once
everything built. Each failure is printed with grubbery's error detail.
Exits 0 on a clean build, 1 on a failed one, 2 on a timeout.
"""
import argparse, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

DESK = '/grubbery/ball/apps/shell/desks/lattice.desk'
INST = DESK + '/desk/data/lattice.lattice_app'


def cookie(jar):
    for line in open(jar):
        f = line.removeprefix('#HttpOnly_').rstrip('\n').split('\t')
        if len(f) == 7 and f[5].startswith('urbauth-'):
            return f'{f[5]}={f[6]}'
    sys.exit(f'hoon-build-wait: no urbauth cookie in {jar}')


def get(base, ck, path, timeout=120):
    r = urllib.request.Request(base + urllib.parse.quote(path, safe='/?=&.~-_'), headers={'Cookie': ck})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode(errors='replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors='replace')
    except Exception as e:  # a busy ship times out; ask again
        return 0, str(e)


def info(base, ck, path):
    st, body = get(base, ck, path + '?info=1')
    if st != 200:
        return None
    try:
        return json.loads(body)
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('base'); ap.add_argument('jar'); ap.add_argument('stamp'); ap.add_argument('code')
    ap.add_argument('--wait', type=int, default=900)
    a = ap.parse_args()
    base, ck, end = a.base.rstrip('/'), cookie(a.jar), time.time() + a.wait
    t0 = time.time()

    def out_of_time(what):
        print(f'hoon-build: gave up after {a.wait} s waiting for {what}', flush=True)
        sys.exit(2)

    while a.stamp not in get(base, ck, DESK + '/version.json?raw=1')[1]:
        if time.time() > end:
            out_of_time(f'the desk to pull {a.stamp}')
        time.sleep(2)
    print(f'hoon-build: desk holds {a.stamp} after {time.time() - t0:.0f} s', flush=True)

    code = os.path.normpath(a.code)
    files = sorted(os.path.relpath(os.path.join(d, f), code)
                   for d, _, fs in os.walk(code) for f in fs if f.endswith('.hoon'))
    status = {}
    while True:
        for rel in files:
            if rel in status:
                continue
            j = info(base, ck, DESK + '/desk/code/' + rel)
            b = (j or {}).get('build') or {}
            if b.get('status'):
                status[rel] = (b['status'], b.get('detail') or '')
        left = [f for f in files if f not in status]
        if not left:
            break
        if time.time() > end:
            out_of_time('a build status from ' + ', '.join(left))
        time.sleep(3)
    bad = {f: s for f, s in status.items() if s[0] != 'vase'}
    print(f'hoon-build: {len(files)} files reported after {time.time() - t0:.0f} s, {len(bad)} not a vase', flush=True)

    bang = None
    if not bad:
        while True:
            j = info(base, ck, INST)
            if j is not None:
                bang = j.get('bang')
                if bang is None:
                    break
            if time.time() > end:
                if j is None:
                    out_of_time('the lattice instance to appear')
                break
            time.sleep(3)

    for f, (s, detail) in sorted(bad.items()):
        lines = detail.strip().splitlines()
        at = next((l.strip() for l in lines if '.hoon::[' in l), '')
        m = re.match(r'/?(.*\.hoon)::\[(\d+) (\d+)\]', at)
        loc = f'file=code/{m[1]},line={m[2]},col={m[3]}' if m else f'file=code/{f}'
        print(f'\n::error {loc}::code/{f} built to {s or "nothing"}, not a vase: '
              f'{lines[0] if lines else "no detail"} at {at or "?"}')
        print(f'--- code/{f}: {s} ---\n{detail.rstrip()}')
    if bang:
        print(f'\n::error file=code/nex/lattice/app.hoon::the lattice instance has a bang')
        print(f'--- bang on {INST} ---\n{bang.rstrip()}')
    if bad or bang:
        sys.exit(1)
    print(f'hoon-build: every .hoon file under code/ built, bang null ({time.time() - t0:.0f} s)')


if __name__ == '__main__':
    main()
