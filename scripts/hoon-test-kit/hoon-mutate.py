#!/usr/bin/env python3
"""Mutation check for the Hoon libs: break one thing, run the suites, and
report every break that no test noticed. See README.md and PLAYBOOK.md.

    hoon-mutate.py <pier> [--ops OP,...] [--only ARM,...] [--since REV] [--list]

Each mutant is written into the test desk's mount, never into the repo, and
the clean lib is synced back when the run ends, however it ends. A mutant
that loops forever stops the run, since only ^C typed in the ship's dojo
ends a spinning event; with DOJO_PANE=<tmux pane> the runner types it.
"""
import argparse, os, re, shlex, signal, subprocess, sys, tempfile, time

KIT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, KIT)
import grubbery_clay  # noqa: E402


def find_conf():
    """hoon-test.conf, as hoon-test.sh finds it: $HOON_TEST_CONF, or the
    nearest one at or above the current directory."""
    if os.environ.get('HOON_TEST_CONF'):
        return os.path.abspath(os.environ['HOON_TEST_CONF'])
    d = os.getcwd()
    while True:
        if os.path.isfile(f'{d}/hoon-test.conf'):
            return f'{d}/hoon-test.conf'
        if d == '/':
            sys.exit('no hoon-test.conf here or above')
        d = os.path.dirname(d)


def read_conf(path):
    """The KEY=value lines of a conf file bash also sources."""
    conf = {}
    for tok in shlex.split(open(path).read(), comments=True):
        if '=' in tok:
            k, v = tok.split('=', 1)
            conf[k] = v
    return conf


CONF = find_conf()
ROOT = os.path.dirname(CONF)
_c = read_conf(CONF)
DESK = _c['DESK']
DIALECT = _c.get('DIALECT', 'clay')
CODE = f"{ROOT}/{_c.get('CODE', '')}"
PRELUDE = _c.get('PRELUDE', '').split()


def lib_dest(entry):
    """Where a LIBS entry lands on the desk, as hoon-test.sh puts it."""
    if '=' in entry:
        return entry.split('=', 1)[1]
    if DIALECT == 'grubbery':
        return os.path.relpath(f'{ROOT}/{entry}', CODE)
    return 'lib/' + os.path.basename(entry)


# (source path, desk-relative dest, name shown in results)
LIBS = [(f"{ROOT}/{e.split('=', 1)[0]}", lib_dest(e), lib_dest(e)[len('lib/'):-len('.hoon')])
        for e in _c['LIBS'].split()]


def put_lib(pier, src, dest, text=None):
    """A lib onto the desk's mount: the source, or a mutant's text of it.
    A grubbery lib is translated on the way, exactly as a sync does."""
    path = f'{pier}/{DESK}/{dest}'
    if DIALECT == 'grubbery':
        grubbery_clay.install(CODE, src, path, f'{pier}/{DESK}', PRELUDE, text)
        return
    with open(path, 'w') as f:
        f.write(open(src).read() if text is None else text)
SWAP = {'lte': 'lth', 'lth': 'lte', 'gte': 'gth', 'gth': 'gte'}


def code_part(line):
    i = line.find('::')
    return line if i < 0 else line[:i]


def arm_at(lines, n):
    for i in range(n, -1, -1):
        m = re.match(r'\s*\+[+$*]  (\S+)', lines[i])  # an arm, a mold or an alias
        if m:
            return m.group(1)
    return '?'


def boundary(lines):
    """(lte a b) <-> (lth a b), (gte a b) <-> (gth a b): the edge case."""
    for n, line in enumerate(lines):
        for m in re.finditer(r'\((lte|lth|gte|gth) ', code_part(line)):
            op = m.group(1)
            new = line[:m.start() + 1] + SWAP[op] + line[m.end() - 1:]
            yield n, f'{op}->{SWAP[op]}', {n: new}


def tall_conjunct(lines):
    """One child of a tall ?& (or ?|) replaced by its identity, & (or |):
    the guard as if that condition were never written."""
    for n, line in enumerate(lines):
        m = re.match(r'(\s*)(\?&|\?\|)  (?=\S)', code_part(line))
        if not m:
            continue
        rune, col = m.group(2), m.end()
        unit = '&' if rune == '?&' else '|'
        end = n + 1  # the closing == at the rune's own column
        while end < len(lines) and not lines[end].startswith(m.group(1) + '=='):
            end += 1
        starts = [n] + [i for i in range(n + 1, end)
                        if len(lines[i]) - len(lines[i].lstrip()) == col and lines[i].strip()
                        and not lines[i].lstrip().startswith('::')]
        for k, s in enumerate(starts):
            stop = starts[k + 1] if k + 1 < len(starts) else end
            edit = {i: None for i in range(s, stop)}  # None: drop the line
            head = lines[s][:col] if s == n else ' ' * col
            edit[s] = head + unit + '\n'
            child = (lines[s][col:] if s == n else lines[s].strip()).strip()
            yield s, f'{rune} drop {child[:40]}', edit


def wide_children(code, start):
    """The top-level children of the wide form whose ( is at code[start],
    and the index of its ). Children are split at single spaces outside
    any bracket or quote. None when the form doesn't close on this line."""
    depth, quote, kids, cur = 0, None, [], start + 1
    i = start + 1
    while i < len(code):
        c = code[i]
        if quote:
            if c == '\\':
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in '\'"':
            quote = c
        elif c in '([{':
            depth += 1
        elif c in ')]}':
            if depth == 0:
                if c != ')':
                    return None
                kids.append((cur, i))
                return kids, i
            depth -= 1
        elif c == ' ' and depth == 0:
            kids.append((cur, i))
            cur = i + 1
        i += 1
    return None


def wide_conjunct(lines):
    """One child of a wide &(...), |(...), ?&(...) or ?|(...) replaced by
    its identity, as conjunct does for the tall forms: orrery and auspex
    write most one-line guards this way."""
    for n, line in enumerate(lines):
        code = code_part(line)
        for m in re.finditer(r'(?<![a-z0-9$%^*~=?!-])(\?)?([&|])\(', code):
            got = wide_children(code, m.end() - 1)
            if not got:
                continue
            kids, close = got
            if len(kids) < 2:
                continue
            rune = (m.group(1) or '') + m.group(2) + '('
            for a, b in kids:
                new = line[:a] + m.group(2) + line[b:]
                yield n, f'{rune} drop {code[a:b][:40]}', {n: new}


def conjunct(lines):
    """Every condition of every conjunction, tall or wide."""
    yield from tall_conjunct(lines)
    yield from wide_conjunct(lines)


def swapper(pattern, table, label):
    """Every match of `pattern` in code (not comments) replaced by its
    table entry, one site per mutant."""
    def op(lines):
        for n, line in enumerate(lines):
            code = code_part(line)
            for m in re.finditer(pattern, code):
                old = m.group(0)
                new = line[:m.start()] + table[old] + line[m.end():]
                yield n, f'{label} {old.strip()}->{table[old].strip()}', {n: new}
    op.__name__ = label
    return op


# ?: and ?. swapped: the branch taken when the condition does not hold.
branch = swapper(r'\?[:.](?=  |\()', {'?:': '?.', '?.': '?:'}, 'branch')
# =( and !=( swapped, and only as a comparison: after a space or a bracket,
# never ?=( (a type test) and never the =( inside a rune like |=( or ^=(.
equal = swapper(r'(?:(?<=[\s(\[])|^)!?=\(', {'=(': '!=(', '!=(': '=('}, 'equal')
# a literal flag flipped: a default or an early answer nobody relies on.
flag = swapper(r'%\.[yn]\b', {'%.y': '%.n', '%.n': '%.y'}, 'flag')

MENU = {op.__name__: op for op in [boundary, conjunct, branch, equal, flag]}
MENU["wide"] = wide_conjunct  # conjunct's wide half alone, for a rerun after it was added


def touched_arms(rev):
    """The arms a git diff against rev touches, per lib: where a big lib's
    change is, so the expensive ops run there and not over every arm."""
    arms = set()
    for path, lib in LIBS:
        diff = subprocess.run(['git', '-C', ROOT, 'diff', '-U0', rev, '--', path],
                              capture_output=True, text=True, check=True).stdout
        lines = open(path).readlines()
        for m in re.finditer(r'^@@ -\S+ \+(\d+)(?:,(\d+))? @@', diff, re.M):
            start, count = int(m.group(1)), int(m.group(2) or 1)
            for n in range(max(start - 1, 0), min(start - 1 + max(count, 1), len(lines))):
                arms.add((lib, arm_at(lines, n)))
    return arms


def mutants(menu):
    for path, _, lib in LIBS:
        lines = open(path).readlines()
        for op in menu:
            for n, what, edit in op(lines):
                out = [edit.get(i, l) for i, l in enumerate(lines)]
                yield lib, n + 1, arm_at(lines, n), what, ''.join(l for l in out if l is not None)


def run(pier, env=None, timeout=None):
    return subprocess.run([f'{KIT}/hoon-test.sh', pier],
                          env={**os.environ, 'HOON_TEST_CONF': CONF, **(env or {})},
                          capture_output=True, text=True, timeout=timeout,
                          # its own session, so a ^C for the runner is not
                          # also delivered to the suite mid-run
                          start_new_session=True)


def live(a, todo):
    """Mutate code that only a running app exercises (a nexus's fibers).
    Each mutant is deployed to a dev instance with the config's
    LIVE_DEPLOY, and judged by its LIVE_CHECK, commands run from the repo
    root. LIVE_DEPLOY gets LIVE_FILE (the file to deploy: the raw source,
    since the instance builds it itself) and LIVE_SRC (its repo path), and
    exits 0 when the instance built it, 3 when it did not build, anything
    else when the ship is in trouble. LIVE_CHECK exits 0 when every check
    passes, 1 when one fails, anything else when it could not finish.
    The clean files go back at the end, however it ends."""
    deploy, check = _c.get('LIVE_DEPLOY'), _c.get('LIVE_CHECK')
    if not (deploy and check):
        sys.exit('--live needs LIVE_DEPLOY and LIVE_CHECK in hoon-test.conf')
    def sh(cmd, env, timeout):
        return subprocess.run(cmd, shell=True, cwd=ROOT, env={**os.environ, **env},
                              capture_output=True, text=True, timeout=timeout,
                              start_new_session=True)
    srcs = {lib: src for src, dest, lib in LIBS}
    def put(lib, text=None):
        path = srcs[lib]
        if text is not None:
            fd, path = tempfile.mkstemp(suffix='.hoon')
            with os.fdopen(fd, 'w') as f:
                f.write(text)
        try:
            return sh(deploy, {'LIVE_FILE': path, 'LIVE_SRC': os.path.relpath(srcs[lib], ROOT)}, 900).returncode
        finally:
            if text is not None:
                os.unlink(path)
    libs = sorted({m[0] for m in todo})
    for lib in libs:
        if put(lib) != 0:
            sys.exit(f'{lib}: the clean code did not deploy; fix that first')
    if sh(check, {}, 1800).returncode != 0:
        sys.exit('the live check fails on the clean code; fix that first')
    stop = []
    def ask_stop(sig, frame):
        if stop:
            raise KeyboardInterrupt
        stop.append(1)
        print('stopping after this mutant; ^C again to stop now', flush=True)
    signal.signal(signal.SIGINT, ask_stop)
    tally, survivors = {}, []
    try:
        for i, (lib, line, arm, what, text) in enumerate(todo, 1):
            if stop:
                print(f'[{i}/{len(todo)}] stopped by request; the rest did not run', flush=True)
                break
            t0 = time.time()
            d = put(lib, text)
            if d == 3:
                verdict = 'no-build'
            elif d != 0:
                print(f'[{i}/{len(todo)}] deploying {lib}:{line} +{arm} {what} failed ({d}): '
                      'is the ship answering? results from here are void', flush=True)
                break
            else:
                try:
                    c = sh(check, {}, 1800).returncode
                except subprocess.TimeoutExpired:
                    c = None
                if c not in (0, 1):
                    print(f'[{i}/{len(todo)}] the check on {lib}:{line} +{arm} {what} did not finish '
                          f'({c}): the ship may be down or spinning; results from here are void', flush=True)
                    break
                verdict = 'SURVIVED' if c == 0 else 'killed'
            tally[verdict] = tally.get(verdict, 0) + 1
            if verdict == 'SURVIVED':
                survivors.append((lib, line, arm, what))
            print(f'[{i}/{len(todo)}] {verdict:8} {lib}:{line} +{arm} {what} ({time.time() - t0:.0f}s)', flush=True)
    finally:
        for lib in libs:
            if put(lib) != 0:
                print(f'could not put the clean {lib} back on the instance: deploy it by hand')
    print('\n' + '  '.join(f'{k}: {v}' for k, v in sorted(tally.items())))
    for lib, line, arm, what in survivors:
        print(f'SURVIVED  {lib}:{line}  +{arm}  {what}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pier')
    ap.add_argument('--only', help='comma-separated arm names')
    ap.add_argument('--since', metavar='REV',
                    help='only the arms a git diff against REV touches (a branch, a tag, HEAD)')
    ap.add_argument('--list', action='store_true', help='print the mutants and stop')
    ap.add_argument('--live', action='store_true',
                    help="mutate on a running dev instance, judged by the conf's LIVE_CHECK")
    ap.add_argument('--ops', default='boundary,conjunct',
                    help=f'comma-separated, from: {",".join(MENU)} (default: %(default)s)')
    a = ap.parse_args()
    only = set(a.only.split(',')) if a.only else None
    touched = touched_arms(a.since) if a.since else None
    todo = [m for m in mutants([MENU[o] for o in a.ops.split(',')])
            if (not only or m[2] in only) and (touched is None or (m[0], m[2]) in touched)]
    if a.list:
        for lib, line, arm, what, _ in todo:
            print(f'{lib}:{line}  +{arm}  {what}')
        print(f'{len(todo)} mutants')
        return
    if a.live:
        return live(a, todo)
    if run(a.pier).returncode != 0:
        sys.exit('the suites fail on the clean libs; fix that first')
    tally, survivors = {}, []
    last = None
    # ^C (or kill -INT) asks to stop BETWEEN mutants: the one running
    # finishes, then the clean libs go back. Interrupted mid-mutant, the
    # runner never reached its restore and left a mutant on the desk.
    # A second ^C stops at once, as before.
    stop = []
    def ask_stop(sig, frame):
        if stop:
            raise KeyboardInterrupt
        stop.append(1)
        print('stopping after this mutant; ^C again to stop now', flush=True)
    signal.signal(signal.SIGINT, ask_stop)
    try:
        for i, (lib, line, arm, what, text) in enumerate(todo, 1):
            if stop:
                print(f'[{i}/{len(todo)}] stopped by request; the rest did not run', flush=True)
                break
            src, dest = next((p, d) for p, d, n in LIBS if n == lib)
            # one mutant at a time: the lib the last mutant broke goes back
            # to clean first, or every later mutant runs against two breaks
            if last and last != (src, dest):
                put_lib(a.pier, *last)
            put_lib(a.pier, src, dest, text)
            last = (src, dest)
            t0 = time.time()
            # MUTANT_T: seconds before a mutant counts as spinning. A spin can
            # kill the ship before 120 s, so set it near a few honest runs
            r = run(a.pier, {'NOSYNC': '1', 'TEST_T': os.environ.get('MUTANT_T', '120')})
            if r.returncode == 4:  # no answer: the ship is down, stop here
                print(f'[{i}/{len(todo)}] the ship stopped answering during {lib}:{line} +{arm} {what}; '
                      'results from here are void', flush=True)
                break
            verdict = {0: 'SURVIVED', 1: 'killed', 3: 'no-build'}.get(r.returncode, 'timeout')
            if verdict == 'timeout':
                # A spinning event is ended by ^C typed in the ship's dojo,
                # and by nothing else: a signal to the worker (or the king)
                # does not interrupt it. With DOJO_PANE set to the dojo's
                # tmux pane, send that ^C and go on; without it, stop here.
                pane = os.environ.get('DOJO_PANE')
                if not pane:
                    print(f'[{i}/{len(todo)}] timeout  {lib}:{line} +{arm} {what}: the ship may be '
                          'spinning on this mutant. Press ^C in its dojo (or rerun with '
                          'DOJO_PANE=<tmux pane>); results from here are void', flush=True)
                    break
                subprocess.run(['tmux', 'send-keys', '-t', pane, 'C-c'], check=False)
                time.sleep(5)
            tally[verdict] = tally.get(verdict, 0) + 1
            if verdict == 'SURVIVED':
                survivors.append((lib, line, arm, what))
            print(f'[{i}/{len(todo)}] {verdict:8} {lib}:{line} +{arm} {what} ({time.time() - t0:.0f}s)', flush=True)
    finally:
        # Write the clean libs AND force the commit. A sync alone is not
        # enough: if the mount already matches the repo, rsync reports no
        # change and the desk keeps the last mutant it committed.
        for src, dest, _ in LIBS:
            put_lib(a.pier, src, dest)
        if run(a.pier, {'NOSYNC': '1'}).returncode != 0:
            print('could not restore the clean libs on the ship; once it is up, run '
                  'NOSYNC=1 hoon-test.sh <pier>')
    print('\n' + '  '.join(f'{k}: {v}' for k, v in sorted(tally.items())))
    for lib, line, arm, what in survivors:
        print(f'SURVIVED  {lib}:{line}  +{arm}  {what}')


if __name__ == '__main__':
    main()
