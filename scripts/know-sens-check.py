#!/usr/bin/env python3
"""A memory's sensitive record stays in step with its writes. Against a FAKE ship.

usage: know-sens-check.py <base-url> <raw-cookie-file>

Every sensitive memory has a `sensitive` file beside its `entry` at
/know/vault/<key>/. Saves, owner raises and lowers, moves, deletes,
restores and batches must each leave the record where the entry says.

Seeds memories under memchk-<pid>/ and deletes them at the end. Exits
non-zero on any failure. Never point it at a real ship.
"""
import json, os, sys, time, urllib.error, urllib.request

# the instance, under the shell at /apps/shell (grubbery 6ec16c6a), and
# the namespace API's darts (grubbery 46fa2bc4): GET /peek reads a grub,
# DELETE /cull drops it, PUT /make?force=1 overwrites it
APP = '/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app'
INST = '/grubbery/ball' + APP
DATA = '/grubbery/api/peek' + APP
CULL = '/grubbery/api/cull' + APP
MAKE = '/grubbery/api/make' + APP


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

    ns = f'memchk-{os.getpid()}/'
    SEN = '---\nsensitive: yes\n---\nsecret'

    def reload():
        req('POST', INST, b'action=reload-nexus', ctype='application/x-www-form-urlencoded')
        # the writer starts again: wait for a route to answer
        time.sleep(5)
        until(lambda: lat('GET', '/tree-job')[0] == 200, 600)

    def rec(k):
        # a dir peek lists its files: the record's mark has no rendering,
        # so a peek of the file itself answers 500 whether or not it is there
        st, out = req('GET', DATA + '/know/vault/' + k + '/', timeout=60)
        try:
            return st == 200 and 'sensitive' in json.loads(out).get('files', [])
        except ValueError:
            return False

    def save(k, text, sensitive=None):
        q = '/know-save?key=' + ns + k + ('' if sensitive is None else '&sensitive=' + sensitive)
        return lat('POST', q, text.encode())

    def move(a, b):
        return lat('POST', '/know-move?from=' + ns + a + '&to=' + ns + b)

    def delete(k):
        return lat('POST', '/know-delete?key=' + ns + k)

    def restore(k):
        return lat('POST', '/know-restore?key=' + ns + k)

    def batch(items):
        body = json.dumps({'items': [{'key': ns + k, 'body': b} for k, b in items]})
        return lat('POST', '/know-save-batch', body.encode())

    save('s', SEN)
    check('save sensitive: record', until(lambda: rec(ns + 's')))
    save('p', 'plain')
    check('save plain: no record', not rec(ns + 'p'))
    save('p', 'plain', sensitive='1')
    check('owner raises: record', until(lambda: rec(ns + 'p')))
    save('p', 'plain', sensitive='0')
    check('owner lowers: record gone', until(lambda: not rec(ns + 'p')))
    move('s', 's2')
    check('move: record follows', until(lambda: rec(ns + 's2') and not rec(ns + 's')))
    delete('s2')
    check('delete: record gone', until(lambda: not rec(ns + 's2')))
    restore('s2')
    check('restore: record back', until(lambda: rec(ns + 's2')))
    batch([('b1', SEN), ('b2', 'plain')])
    check('batch: records', until(lambda: rec(ns + 'b1')) and not rec(ns + 'b2'))
    batch([('b3', SEN)])
    check('batch: b3 record', until(lambda: rec(ns + 'b3')))
    save('b3', 'unmarked')
    check('owner plain save drops the mark: record gone', until(lambda: not rec(ns + 'b3')))

    # --- the one-time migration ---
    save('m', SEN)
    until(lambda: rec(ns + 'm'))
    st1, o1 = req('DELETE', CULL + '/know/vault/' + ns + 'm/sensitive')  # a memory that lost its record
    st2, o2 = req('PUT', MAKE + '/know/vault/' + ns + 'b2/sensitive?blot=/txt', b'x', ctype='text/plain')  # a stale record on a plain memory
    check('migration: record culled', until(lambda: not rec(ns + 'm')), (st1, o1))
    check('migration: stale record laid', until(lambda: rec(ns + 'b2')), (st2, o2))
    req('DELETE', CULL + '/know/sens-migrated')
    reload()  # the on-load row lays the stamp at 0
    check('migration: missing record written', until(lambda: rec(ns + 'm')))
    check('migration: stale record dropped', until(lambda: not rec(ns + 'b2')))
    check('migration: other records kept', rec(ns + 's2') and rec(ns + 'b1'))
    req('DELETE', CULL + '/know/vault/' + ns + 'm/sensitive')
    reload()  # the stamp is now set
    check('migration: runs once', not rec(ns + 'm'))

    # --- clean up ---
    for k in ('s', 's2', 'p', 'b1', 'b2', 'b3', 'm'):
        delete(k)
    print('know-sens-check: ' + ('FAIL ' + ', '.join(fails) if fails else 'all passed'))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
