#!/usr/bin/env python3
"""Deploy this checkout's code/ to lattice on a FAKE grubbery ship.

usage: dev-deploy.py <base-url> <cookie-jar> [--add] [--approve] [--code DIR]
                     [--manifest FILE] [--dry-run]

Mirrors code/ into the ball at /lattice-dev/code through the explorer
(create-folder, create-file, write-text), then stamps that tree's
version.json with a dev version, which makes the desk pull. With --add it
first makes the desk: POST /apps/grubbery/desks/add {name: lattice, code:
/lattice-dev/code}, so lattice lands at the same path as on ricsul,
<shell>/desks/lattice.desk. A lattice desk that follows another source
(a current kernel boots one following ~ricsul-bilwyt, which a fake ship
cannot reach) is removed first with /desks/delete, which also keeps boot
from making it again. Removing the desk destroys the instance inside it,
so --add does it only when all of these hold: the desk follows exactly
that stock source, it holds no instance (?info=1 answers 404), and the
ship is a galaxy, as fleet and CI ships are. --replace-desk drops the
first two for a throwaway ship, never the third. Every run reads the
desk's source first and stops if it is not /lattice-dev/code: the desk
would never pull what this writes. Files are written only when they
differ, so a redeploy sends only what changed. --approve then grants the
instance its own weir.json (approve-weir with it as `granted`; without
`granted` the grant is empty and lattice stops serving) and the
usergroups its groups.json names, and reloads its permits, which a
release that adds a road needs.

The shell is at /apps/shell on a current kernel and at /apps/shell.shell
on an older one. The first request asks /apps which it is, and waits
until the shell answers at all: a ship that has just booted redirects
/grubbery/ball to landscape for a while.

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
# the source a current kernel's shell gives the stock lattice desk on any
# ship but the distributor (+desk-source in grubbery's gub/nex/shell.hoon)
STOCK = {'code': '~ricsul-bilwyt/apps/shell/desks/lattice.desk/desk/code'}


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
        except (OSError, urllib.error.URLError) as e:  # refused or timed out: no answer
            return 0, str(e).encode()

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

    def shell(self):
        """the shell's path: /apps/shell, or /apps/shell.shell on an old kernel"""
        if not hasattr(self, '_shell'):
            for _ in range(150):
                st, body = self.req(self.ball('/apps') + '?list=1')
                if st == 200:
                    break
                time.sleep(2)
            else:
                sys.exit(f'dev-deploy: the shell does not answer: list /apps: {st} {body[:200]!r}')
            try:
                names = {c['name'] for c in json.loads(body)['children']}
            except (ValueError, TypeError, KeyError):
                names = set()
            if 'shell' in names:
                self._shell = '/apps/shell'
            elif 'shell.shell' in names:
                self._shell = '/apps/shell.shell'
            else:
                sys.exit(f'dev-deploy: no shell under /apps: list /apps answered {st} {body[:300]!r}')
        return self._shell

    def read(self, f):
        """status and body of a file; an old kernel reads at /api/file, a current one at /api/peek"""
        api = '/grubbery/api/file' if self.shell().endswith('.shell') else '/grubbery/api/peek'
        return self.req(api + f)

    def text(self, f):
        st, body = self.read(f)
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


def check_desk(ship, desk, app, a):
    """Before anything is written: None when the desk already follows ROOT,
    False when there is none and --add makes it, True when --add replaces
    it. Anything else stops: every read that fails stops too."""
    st, body = ship.read(desk + '/source.json')
    if st == 404:
        st, _ = ship.req(ship.ball(desk) + '?list=1')
        if st != 404:
            sys.exit(f'dev-deploy: {desk} answers {st} but its source.json does not: left alone')
        if not a.add:
            sys.exit(f'dev-deploy: there is no {desk}; run with --add to make it')
        return False
    if st != 200:
        sys.exit(f'dev-deploy: cannot read {desk}/source.json ({st} {body[:200]!r}): left alone')
    try:
        src = json.loads(body)
    except ValueError:
        sys.exit(f'dev-deploy: {desk}/source.json is not JSON ({body[:200]!r}): left alone')
    if src == {'code': ROOT}:
        if a.add:
            print(f'dev-deploy: {desk} already follows {ROOT}')
        return None
    if not a.add:
        sys.exit(f'dev-deploy: the desk follows {json.dumps(src)}, not {ROOT}: it would never pull '
                 'this deploy. On a fresh fake ship run with --add, which replaces a stock, empty desk')
    host = ship.req('/~/host')
    ship_name = host[1].decode(errors='replace').strip() if host[0] == 200 else f'(/~/host answered {host[0]})'
    held = (f'dev-deploy: {ship_name}: {desk} follows {json.dumps(src)} and may hold the instance\'s '
            'data (pages, boards, vault, shares, grants); it was left alone')
    if not a.replace_desk:
        if src != STOCK:  # (a) only the stock source the kernel boots with
            sys.exit(f'{held}. Only a desk following {json.dumps(STOCK)} is replaced; --replace-desk '
                     'overrides on a throwaway ship')
        st, _ = ship.req(ship.ball(app) + '?info=1')
        if st != 404:  # (b) no instance, and the 404 itself says so
            sys.exit(f'{held}. {app}?info=1 answered {st}, not 404: an instance is there or it cannot '
                     'be told; --replace-desk overrides on a throwaway ship')
    if host[0] != 200 or not re.fullmatch(r'~[a-z]{3}', ship_name):  # (c) a galaxy, always
        sys.exit(f'{held}. Only a galaxy (a fleet or CI ship) has its desk replaced')
    print(f'dev-deploy: replacing {desk}, which follows {json.dumps(src)}'
          + (' (--replace-desk)' if a.replace_desk else ', stock and empty'))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('base'); ap.add_argument('jar')
    ap.add_argument('--add', action='store_true', help='also make the desk (first deploy); replaces only a '
                    "stock, empty lattice desk on a galaxy")
    ap.add_argument('--replace-desk', action='store_true',
                    help='with --add, replace a lattice desk that follows any other source even if it holds '
                    'an instance: DESTROYS the instance and all its data. Throwaway galaxies only')
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
    desk = ship.shell() + '/desks/lattice.desk'
    app = desk + '/desk/data/lattice.lattice_app'
    replace = check_desk(ship, desk, app, a)

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

    if replace is not None:
        if replace:
            st, body = ship.req('/apps/grubbery/desks/delete',
                                json.dumps({'app': 'lattice.desk'}), 'application/json')
            print(f'dev-deploy: desks/delete: {st} {body.decode(errors="replace")}')
            if st != 200:
                sys.exit(1)
        st, body = ship.req('/apps/grubbery/desks/add',
                            json.dumps({'name': 'lattice', 'code': ROOT}), 'application/json')
        print(f'dev-deploy: desks/add: {st} {body.decode(errors="replace")}')
        if st != 200:
            sys.exit(1)

    if a.approve:
        for _ in range(180):  # a first install makes the instance once the desk builds
            weir = ship.text(app + '/weir.json')
            if weir and weir.strip():
                break
            time.sleep(5)
        else:
            sys.exit(f'dev-deploy: no {app}/weir.json yet; run --approve again later')
        granted = json.loads(weir)
        try:  # the usergroups lattice reads within (/public), which other ships read through
            groups = json.loads(ship.text(app + '/groups.json') or 'null')
        except ValueError:
            groups = None
        if isinstance(groups, dict):
            granted['groups'] = sorted(groups)
        grant = {'action': 'approve-weir', 'app': app, 'picks': {}, 'granted': granted}
        for path, body in (('/apps/grubbery/permits', grant), ('/apps/grubbery/permits/reload', {'app': app})):
            st, out = ship.req(path, json.dumps(body), 'application/json')
            print(f'dev-deploy: {path}: {st}')
            if st not in (200, 303):
                sys.exit(out[:400].decode(errors='replace'))


if __name__ == '__main__':
    main()
