#!/usr/bin/env python3
"""tile-perf.py: what a map tile costs the ship, on a FAKE ship.

Measures, against a lattice whose tile route reaches a stub tile server
(a test build with +tile-base pointed at it, see TESTING.md):

  1. the ship time of one tile request: N tiles one after another, each
     a fresh z/x/y, timed end to end, less the stub's own answer time;
  2. a trivial request (/beacon-rev) the same way, for the request path
     every route pays;
  3. other requests' latency during a burst: /page-tree timed alone, then
     again while four threads stream tile requests.

The ship lets 120 tiles a minute through and answers the rest 429, as
the service worker does. A run that asks for more than that in a minute
is timing refusals: keep N small, or run the parts a minute apart.

It reads nothing from Mapbox. Usage:

  LATTICE_URL=http://localhost:8207 LATTICE_COOKIE=~/c.cookie \\
    python3 -I scripts/tile-perf.py [N]
"""
import os, sys, time, threading, statistics, urllib.request, urllib.error

URL = os.environ['LATTICE_URL'].rstrip('/') + '/apps/lattice'
COOKIE = open(os.path.expanduser(os.environ['LATTICE_COOKIE'])).read().strip()
N = int(sys.argv[1]) if len(sys.argv) > 1 else 40


def get(path, origin=False):
    req = urllib.request.Request(URL + path, headers={'Cookie': COOKIE})
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read()
            return r.status, time.perf_counter() - t, len(body), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, time.perf_counter() - t, 0, dict(e.headers)


def post(path, data):
    req = urllib.request.Request(URL + path, data=data, method='POST',
                                 headers={'Cookie': COOKIE, 'Origin': os.environ['LATTICE_URL'].rstrip('/')})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status


def ms(xs):
    return f'median {statistics.median(xs) * 1000:.0f} ms, p90 {sorted(xs)[int(len(xs) * 0.9) - 1] * 1000:.0f} ms, n={len(xs)}'


seq = [0]


def tile():
    # a fresh tile each time at zoom 12, so nothing is cached anywhere
    seq[0] += 1
    i = seq[0] + int(time.time()) % 1000 * 50
    return '/tile/streets/12/%d/%d' % (i % 4096, (i // 4096) % 4096)


post('/map-token', b'pk.perf-test-token')
st, _, _, _ = get('/tile-status')
print('tile-status', st)

# baseline for other requests
print('trivial request:', ms([get('/beacon-rev')[1] for _ in range(N)]))
base = [get('/page-tree')[1] for _ in range(10)]
print('page-tree alone:', ms(base))

# one tile after another
one = []
for _ in range(N):
    s, t, n, h = get(tile())
    if s != 200:
        print('tile answered', s)
        break
    one.append(t)
    leak = [k for k in h if k.lower().startswith('x-mapbox')]
    if leak:
        print('LEAK: Mapbox header passed through:', leak)
print('tile, one at a time (round trip, stub answers at once):', ms(one))
print('  headers:', {k: v for k, v in h.items() if k.lower() in ('content-type', 'cache-control')})

# other requests during a burst of tiles
stop = threading.Event()
codes = []


def burst():
    while not stop.is_set():
        codes.append(get(tile())[0])


ths = [threading.Thread(target=burst) for _ in range(4)]
for t in ths:
    t.start()
time.sleep(1)
during = []
for _ in range(10):
    during.append(get('/page-tree')[1])
    time.sleep(0.3)
stop.set()
for t in ths:
    t.join()
print('page-tree during a burst of 4 parallel tile streams:', ms(during))
print('  burst answers: %d x 200, %d other' % (
    codes.count(200), len([c for c in codes if c != 200])))
post('/map-token', b'')
