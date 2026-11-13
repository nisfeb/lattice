#!/usr/bin/env python3
"""Storage invariants, seen from outside. Against a FAKE ship.

usage: storage-check.py <base-url> <raw-cookie-file>

  titles   /pub/titles survives a reload of the nexus, and is laid again
           from the published pages when it is missing (before its loader
           row every reload dropped it)
  seen     /notify/seen survives a reload
  revs     a page unpublished and published again is published again, at a
           revision above the one it had, so under a new id
  corrupt  a corrupt /notify/seen is kept aside under /corrupt before the
           writer replaces it

Seeds pages under storchk/ and deletes them at the end. Exits non-zero on
any failure. Never point it at a real ship.
"""
import json, sys, time, urllib.error, urllib.request

INST = '/grubbery/ball/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app'
DATA = '/grubbery/api/file/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app'


def main():
    url, ck = sys.argv[1].rstrip('/'), open(sys.argv[2]).read().strip()
    sys.stdout.reconfigure(line_buffering=True)
    fails = []

    def req(method, path, body=None, timeout=300, ctype=None):
        h = {'Cookie': ck}
        if ctype:
            h['Content-Type'] = ctype
        r = urllib.request.Request(url + path, data=body, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except Exception as e:  # noqa: BLE001
            return 0, str(e).encode()

    def lat(method, path, body=None):
        return req(method, '/apps/lattice' + path, body)

    def check(name, ok, detail=''):
        print(('ok    ' if ok else 'FAIL  ') + name + ('' if ok else '  ' + str(detail)[:300]))
        if not ok:
            fails.append(name)

    def grub(rel):
        st, out = req('GET', DATA + rel, timeout=60)
        return out.decode(errors='replace') if st == 200 else None

    def until(f, secs=120):
        t = time.monotonic()
        while time.monotonic() - t < secs:
            v = f()
            if v:
                return v
            time.sleep(2)
        return None

    def reload():
        req('POST', INST, b'action=reload-nexus', ctype='application/x-www-form-urlencoded')
        # the writer starts again: wait for a route to answer
        time.sleep(5)
        until(lambda: lat('GET', '/tree-job')[0] == 200, 600)

    def revs():
        g = grub('/pub/revs')
        try:
            return json.loads(g) if g else {}
        except ValueError:
            return {}

    # --- titles and revs ---
    st, _ = lat('POST', '/page-save?name=storchk/t1&type=md', b'# Storage Title One\n\nbody')
    check('seed a page', st == 200, st)
    st, out = lat('POST', '/page-share?name=storchk/t1&mode=shared')
    check('publish it', st == 200, out)
    # a %noun grub: the file API answers its jam, so presence is checked
    got = until(lambda: grub('/pub/titles') is not None, 120)
    check('titles: laid', bool(got))
    r1 = until(lambda: revs().get('/storchk/t1'), 60)
    check('revs: listed', bool(r1), revs())

    reload()
    check('titles: kept across a reload', grub('/pub/titles') is not None)

    st, _ = req('DELETE', DATA + '/pub/titles', timeout=60)
    check('titles: dropped by hand', st == 200 and grub('/pub/titles') is None, st)
    reload()
    got = until(lambda: grub('/pub/titles') is not None, 120)
    check('titles: laid again at writer start', bool(got))

    # unpublish, then publish again: the revision climbs
    lat('POST', '/page-share?name=storchk/t1&mode=private')
    until(lambda: '/storchk/t1' not in revs(), 60)
    lat('POST', '/page-share?name=storchk/t1&mode=shared')
    r2 = until(lambda: revs().get('/storchk/t1'), 60)
    check('revs: published again', bool(r2), revs())
    check('revs: the revision climbs', bool(r1 and r2) and r2['rev'] > r1['rev'], (r1, r2))
    check('revs: under a new id', bool(r1 and r2) and r2['id'] != r1['id'], (r1, r2))

    # --- seen, and a corrupt seen kept aside ---
    st, _ = lat('POST', '/notify-read?all=1')
    check('seen: marked', st == 200 and until(lambda: grub('/notify/seen') is not None, 30), st)
    reload()
    check('seen: kept across a reload', grub('/notify/seen') is not None)
    st, out = req('POST', '/grubbery/api/over' + DATA[len('/grubbery/api/file'):] + '/notify/seen?blot=/txt',
                  b'not a read state', ctype='text/plain')
    check('corrupt: written', st in (200, 303), out)
    lat('POST', '/notify-read?all=1')

    def aside():
        try:
            f = json.loads(grub('/faults.json') or '{}').get('corrupt-notify-seen', {})
        except ValueError:
            return None
        w = f.get('what', '')
        return w.split('kept it aside at ')[-1] if 'kept it aside at ' in w else None
    at = until(aside, 60)
    check('corrupt: recorded', bool(at))
    check('corrupt: kept aside under /corrupt', bool(at) and grub(at) is not None, at)

    # --- clean up ---
    lat('POST', '/page-share?name=storchk/t1&mode=private')
    lat('POST', '/page-delete?name=storchk/t1')
    print('storage-check: ' + ('FAIL ' + ', '.join(fails) if fails else 'all passed'))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
