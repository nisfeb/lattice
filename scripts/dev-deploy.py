#!/usr/bin/env python3
"""Deploy this checkout's code/ to lattice on a FAKE grubbery ship.

usage: dev-deploy.py <base-url> <cookie-jar> [--add] [--approve] [--code DIR]
                     [--manifest FILE] [--dry-run]

Mirrors code/ into the ball at /lattice-dev/code through the explorer
(create-folder, create-file, write-text), then stamps that tree's
version.json with a dev version, which makes the desk pull. With --add it
first makes the desk: POST /apps/grubbery/desks/add {name: lattice, code:
/lattice-dev/code}, so lattice lands at the same path as on ricsul,
/apps/shell.shell/desks/lattice.desk. Files are written only when they
differ, so a redeploy sends only what changed. --approve then grants the
instance its own weir.json (approve-weir with it as `granted`; without
`granted` the grant is empty and lattice stops serving) and reloads its
permits, which a release that adds a road needs.

Telling what differs costs a GET per file (about 0.5 s each, a minute for
code/). --manifest FILE skips that: it holds the sha256 of every file as
last written to this ship and the version stamp written with them, and is
trusted only while the ship's version.json still reads that stamp, so a
deploy from elsewhere sends everything that differs the slow way again.
gate.mjs keeps it in the pier (<pier>/.lattice-deploy.json), so it travels
with fleet snapshots and clones. --dry-run lists what would be sent (by the
manifest alone) and exits 0 when nothing would.

Never point this at a real ship: it is for fleet ships (TESTING.md). Get
a cookie jar with scripts/hoon-test-kit/ship-cookie.sh.
"""
import argparse, hashlib, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

ROOT = '/lattice-dev/code'


class Keep3xx(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a):
        return None  # the explorer answers a form POST with 303: that is success


NOREDIRECT = urllib.request.build_opener(Keep3xx)
MITES = {'js': 'application/javascript', 'html': 'text/html', 'css': 'text/css',
         'svg': 'image/svg', 'txt': 'text/plain', 'md': 'text/markdown'}


def cookie(jar):
    """the urbauth cookie from a curl jar (#HttpOnly_ lines included)"""
    for line in open(jar):
        f = line.removeprefix('#HttpOnly_').rstrip('\n').split('\t')
        if len(f) == 7 and f[5].startswith('urbauth-'):
            return f'{f[5]}={f[6]}'
    sys.exit(f'dev-deploy: no urbauth cookie in {jar}')


class Ship:
    def __init__(self, base, jar):
        self.base, self.cookie = base.rstrip('/'), cookie(jar)

    def req(self, path, data=None, ctype='application/x-www-form-urlencoded'):
        url = self.base + urllib.parse.quote(path, safe='/?=&.~-_')
        body = None
        if data is not None:
            body = (urllib.parse.urlencode(data) if isinstance(data, dict) and ctype.endswith('urlencoded')
                    else data).encode()
        h = {'Cookie': self.cookie}
        if body:
            h['Content-Type'] = ctype
        r = urllib.request.Request(url, data=body, headers=h)
        try:
            with NOREDIRECT.open(r, timeout=600) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def ball(self, path):
        return '/grubbery/ball' + path

    def children(self, d):
        """name -> entry for a ball dir, or None if it does not exist."""
        st, body = self.req(self.ball(d) + '?list=1')
        if st == 404:
            return None
        if st != 200:
            sys.exit(f'dev-deploy: list {d}: {st} {body[:200]!r}')
        return {c['name']: c for c in json.loads(body)['children']}

    def post(self, path, data, ok=(200, 303)):
        st, body = self.req(self.ball(path), data)
        if st not in ok:
            sys.exit(f'dev-deploy: {data.get("action")} {path}: {st} {body[:400].decode(errors="replace")}')

    def text(self, f):
        st, body = self.req('/grubbery/api/file' + f)
        return body.decode(errors='replace') if st == 200 else None


def ensure_dir(ship, d):
    parent, name = d.rsplit('/', 1)
    parent = parent or '/'
    kids = ship.children(parent if parent != '/' else '')
    if kids is None:
        ensure_dir(ship, parent)
        kids = {}
    if name not in kids:
        ship.post(parent if parent != '/' else '', {'action': 'create-folder', 'foldername': name})


def blot_for(name):
    ext = name.rsplit('.', 1)[-1]
    return {'hoon': '/hoon', 'json': '/json'}.get(ext, '/mime')


def hashes(code):
    """relative path -> sha256 for every file of code/ but version.json"""
    out = {}
    for dirpath, dirs, files in os.walk(code):
        rel = os.path.relpath(dirpath, code)
        for f in files:
            key = (rel.replace(os.sep, '/') + '/' if rel != '.' else '') + f
            if key != 'version.json':
                out[key] = hashlib.sha256(open(os.path.join(dirpath, f), 'rb').read()).hexdigest()
    return out


def shipped_stamp(ship):
    try:
        return json.loads(ship.text(ROOT + '/version.json') or 'null')['version']
    except (ValueError, TypeError, KeyError):
        return None


def load_manifest(path):
    try:
        return json.load(open(path)) if path else {}
    except (OSError, ValueError):
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('base'); ap.add_argument('jar')
    ap.add_argument('--add', action='store_true', help='also make the desk (first deploy)')
    ap.add_argument('--approve', action='store_true', help="grant the instance its own weir.json")
    ap.add_argument('--code', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'code'))
    ap.add_argument('--manifest', help='sha256s of what this ship holds; skips a GET per file')
    ap.add_argument('--dry-run', action='store_true', help='list what the manifest says differs, send nothing')
    a = ap.parse_args()
    code = os.path.normpath(a.code)
    if a.dry_run:
        old = load_manifest(a.manifest).get('files', {})
        new = hashes(code)
        diff = sorted(f for f in new if old.get(f) != new[f])
        for f in diff:
            print(f'  {f}')
        print(f'dev-deploy: {len(diff)} files differ from {a.manifest}')
        sys.exit(1 if diff else 0)
    ship = Ship(a.base, a.jar)
    if not re.match(r'https?://(localhost|127\.0\.0\.1)(:\d+)?$', ship.base):
        sys.exit('dev-deploy: refusing a non-local ship; this is for fake fleet ships only')

    man = load_manifest(a.manifest)
    if man and shipped_stamp(ship) != man.get('stamp'):
        print('dev-deploy: the ship moved on since the manifest; comparing on the ship')
        man = {}
    known = man.get('files', {})
    new = hashes(code)
    sent = 0
    for dirpath, dirs, files in os.walk(code):
        dirs.sort()
        rel = os.path.relpath(dirpath, code)
        d = ROOT if rel == '.' else ROOT + '/' + rel.replace(os.sep, '/')
        pre = '' if rel == '.' else rel.replace(os.sep, '/') + '/'
        if known and all(known.get(pre + f) == new[pre + f] for f in files if pre + f in new):
            continue  # the manifest vouches for every file here: no requests at all
        ensure_dir(ship, d)
        kids = ship.children(d) or {}
        for f in sorted(files):
            if rel == '.' and f == 'version.json':
                continue  # stamped last: changing it is what makes the desk pull
            key = (rel.replace(os.sep, '/') + '/' if rel != '.' else '') + f
            if f in kids and known.get(key) == new[key]:
                continue
            src = open(os.path.join(dirpath, f), encoding='utf-8').read()
            blot = blot_for(f)
            if f not in kids:
                ship.post(d, {'action': 'create-file', 'filename': f, 'blot': blot})
            elif blot != '/json' and ship.text(d + '/' + f) == src:
                continue
            args = {'action': 'write-text', 'content': src}
            mite = MITES.get(f.rsplit('.', 1)[-1])
            if blot == '/mime' and mite:
                args['mite'] = mite
            ship.post(d + '/' + f, args, ok=(200,))
            sent += 1
            print(f'  {d}/{f}', flush=True)

    ver = json.load(open(os.path.join(code, 'version.json')))['version']
    stamp = f'{ver}-dev-{int(time.time())}'
    if 'version.json' not in (ship.children(ROOT) or {}):
        ship.post(ROOT, {'action': 'create-file', 'filename': 'version.json', 'blot': '/json'})
    ship.post(ROOT + '/version.json', {'action': 'write-text', 'content': json.dumps({'version': stamp})}, ok=(200,))
    print(f'dev-deploy: {sent} files written, version.json = {stamp}')
    if a.manifest:
        tmp = a.manifest + '.part'
        with open(tmp, 'w') as fh:
            json.dump({'stamp': stamp, 'files': new}, fh)
        os.replace(tmp, a.manifest)

    if a.add:
        st, body = ship.req('/apps/grubbery/desks/add',
                            json.dumps({'name': 'lattice', 'code': ROOT}), 'application/json')
        print(f'dev-deploy: desks/add: {st} {body.decode(errors="replace")}')
        if st not in (200, 409):
            sys.exit(1)

    if a.approve:
        app = '/apps/shell.shell/desks/lattice.desk/desk/data/lattice.lattice_app'
        for _ in range(180):  # a first install makes the instance once the desk builds
            st, weir = ship.req('/grubbery/api/file' + app + '/weir.json')
            if st == 200 and weir.strip():
                break
            time.sleep(5)
        else:
            sys.exit(f'dev-deploy: no {app}/weir.json yet; run --approve again later')
        grant = {'action': 'approve-weir', 'app': app, 'picks': {}, 'granted': json.loads(weir)}
        for path, body in (('/apps/grubbery/permits', grant), ('/apps/grubbery/permits/reload', {'app': app})):
            st, out = ship.req(path, json.dumps(body), 'application/json')
            print(f'dev-deploy: {path}: {st}')
            if st not in (200, 303):
                sys.exit(out[:400].decode(errors='replace'))


if __name__ == '__main__':
    main()
