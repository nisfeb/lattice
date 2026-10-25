#!/usr/bin/env python3
"""Run a test file's test- arms through `vere eval`, with no ship.

A fast inner loop for pure libs: vere eval has hoon and zuse but no clay,
scries or agents, so this splices each /+ import in by hand. Run it from
the app repo, where hoon-test.conf lives. The verdict that counts is still
hoon-test.sh on a fake ship.

usage: offline-test.py tests/lib/foo.hoon [arm ...]

Each /+ import NAME is found, in order, in:
  1. hoon-test.conf's FILES (an entry SRC=lib/NAME.hoon) and LIBS
     (an entry ending in NAME.hoon),
  2. ./lib/NAME.hoon and ./vendor/NAME.hoon,
  3. a mounted %base: $BASE_DIR, else the dev platform ship's
     ~/fleet/piers/*/base (for test.hoon and other stock libs).
OFFLINE_LIB_NAME=path overrides one import, e.g. OFFLINE_LIB_unix=x.hoon.
"""
import glob, os, re, shlex, subprocess, sys

def find_vere():
    """$VERE, else the newest ~/software/vere-*-linux-x86_64 by version."""
    if os.environ.get('VERE'):
        return os.environ['VERE']
    pat = os.path.expanduser('~/software/vere-*-linux-x86_64')
    found = sorted(glob.glob(pat),
                   key=lambda p: [int(x) for x in re.findall(r'\d+', os.path.basename(p))])
    if not found:
        sys.exit(f'offline-test: no vere binary: set VERE=/path/to/vere, '
                 f'or put one at {pat}')
    return found[-1]


VERE = find_vere()


def conf():
    """hoon-test.conf's shell-style assignments, as a dict."""
    out = {}
    if os.path.exists('hoon-test.conf'):
        for line in open('hoon-test.conf'):
            m = re.match(r'\s*([A-Z_]+)=(.*)$', line)
            if m:
                out[m.group(1)] = ' '.join(shlex.split(m.group(2), comments=True))
    return out


def bases():
    if os.environ.get('BASE_DIR'):
        return [os.environ['BASE_DIR']]
    # the dev platform first, then any other mounted fleet pier
    found = sorted(glob.glob(os.path.expanduser('~/fleet/piers/*/base')))
    return sorted(found, key=lambda p: '/pex/' not in p)


def find(name, c):
    env = os.environ.get('OFFLINE_LIB_' + name.replace('-', '_'))
    if env:
        return env
    for entry in c.get('FILES', '').split():
        src, _, dest = entry.partition('=')
        if os.path.basename(dest or src) == name + '.hoon':
            return src
    for src in c.get('LIBS', '').split():
        if os.path.basename(src) == name + '.hoon':
            return src
    for p in (f'lib/{name}.hoon', f'vendor/{name}.hoon') + tuple(
            os.path.join(b, 'lib', name + '.hoon') for b in bases()):
        if os.path.exists(p):
            return p
    sys.exit(f'offline-test: no source for /+ {name}; set OFFLINE_LIB_{name.replace("-", "_")}=path')


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path, only = sys.argv[1], sys.argv[2:]
    c = conf()
    src = open(path).read()
    m = re.search(r'^/\+\s+(.*)$', src, re.M)
    imports = m.group(1) if m else ''
    body = re.sub(r'^/\+.*$', '', src, flags=re.M)
    arms = re.findall(r'^\+\+  (test-[\w-]+)', body, re.M)
    if only:
        arms = [a for a in arms if a in only]
    pre = []
    for item in (s.strip() for s in imports.split(',') if s.strip()):
        if item.startswith('*'):
            pre.append('=+\n' + open(find(item[1:], c)).read())
        else:
            face, _, lib = item.partition('=')
            pre.append(f'=/  {face}\n' + open(find(lib or face, c)).read())
    calls = '\n'.join(f'    [%{a} (mule |.({a}:t))]' for a in arms)
    hoon = '\n'.join(pre) + '\n=/  t\n' + body + f'''
%+  turn
  ^-  (list [term (each tang tang)])
  :~
{calls}
  ==
|=  [n=term r=(each tang tang)]
^-  [term ? wall]
?:  ?=(%| -.r)
  [n | (zing (turn (flop p.r) (cury wash [0 100])))]
[n =(~ p.r) (zing (turn p.r (cury wash [0 100])))]
'''
    if os.environ.get('DUMP'):
        open(os.environ['DUMP'], 'w').write(hoon)
    out = subprocess.run([VERE, 'eval'], input=hoon.encode(), capture_output=True)
    clean = lambda b: re.sub(r'\x1b\[[0-9;]*m', '', b.decode())
    noise = re.compile(r'^(loom:|lite:|eval \(run\):)')
    log = [l for l in clean(out.stderr).splitlines() if not noise.match(l)]
    res = clean(out.stdout)
    print('\n'.join(log))
    print('\n'.join(l for l in res.splitlines() if '%.y <<>>' not in l))
    ok, bad = res.count('%.y <<>>'), res.count('%.n <<')
    print(f'{ok} passed, {bad} failed, of {len(arms)}')
    sys.exit(0 if arms and ok == len(arms) else 1)


main()
