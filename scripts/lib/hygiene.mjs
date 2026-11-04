//  hygiene.mjs: leave the machine as a test run found it.
//
//  One shared 16-thread box runs every session's tests, and a run that
//  dies leaves its headless browsers, Xvfb displays and drivers running
//  for days, writes core dumps to / when they crash, and fills /tmp. So
//  every test process here:
//
//    - turns core dumps off for itself and everything it starts
//      (systemd-coredump honours a crashing process's RLIMIT_CORE);
//    - marks what it starts: LATTICE_TEST_OWNER (pid:starttime of the
//      gate, or of a suite run by hand) and LATTICE_TEST_TAG (one suite
//      run) ride in the environment of every child, browsers and Xvfb
//      included, so it can be found later without guessing by name;
//    - kills what carries its tag when it is done (killTagged), and
//      scripts/sweep.sh kills what an owner that is gone left behind;
//    - keeps scratch under ~/.cache/lattice-gate, not /tmp (TMPDIR too,
//      so puppeteer's profiles follow).
//
//  Only processes carrying our markers are ever signalled: other
//  sessions' browsers, relays and ships have none.
import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, statfsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const SCRATCH = process.env.LATTICE_SCRATCH || join(homedir(), '.cache', 'lattice-gate');

export function noCores() {
  try { execFileSync('prlimit', ['--pid', String(process.pid), '--core=0'], { stdio: 'ignore' }); }
  catch { /* no prlimit: the shell wrappers still say ulimit -c 0 */ }
}

//  pid:starttime, which a reused pid cannot forge
export function procTag(pid = process.pid) {
  const st = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return `${pid}:${st.slice(st.lastIndexOf(')') + 2).split(' ')[19]}`;
}
export function alive(tag) {
  const pid = tag.split(':')[0];
  try { return procTag(pid) === tag; } catch { return false; }
}

//  Mark this process's children. A suite started by the gate keeps the
//  gate's owner and tag; one started by hand becomes its own owner.
export function markChildren() {
  const me = procTag();
  if (!process.env.LATTICE_TEST_OWNER) process.env.LATTICE_TEST_OWNER = me;
  if (!process.env.LATTICE_TEST_TAG) process.env.LATTICE_TEST_TAG = me;
}

//  An env with no markers, for what must outlive the run (fleet's ships
//  and tmux sessions).
export function unmarked(env) {
  const e = { ...env };
  delete e.LATTICE_TEST_OWNER; delete e.LATTICE_TEST_TAG;
  return e;
}

function environ(pid) {
  try { return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'); } catch { return null; }
}
//  pids (not ours) whose environment has key=value
export function marked(key, value) {
  const want = `${key}=${value}`;
  const out = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    const e = environ(d);
    if (e && e.includes(want)) out.push(Number(d));
  }
  return out;
}
//  SIGKILL, sync: for exit handlers, and for what a SIGTERM did not stop
export function killTagged(tag, sig = 'SIGKILL') {
  const pids = marked('LATTICE_TEST_TAG', tag);
  for (const p of pids) { try { process.kill(p, sig); } catch {} }
  return pids;
}

//  Free GB on the filesystem holding `path`
export function freeGB(path) {
  const s = statfsSync(path);
  return (s.bavail * s.bsize) / 2 ** 30;
}
//  A heavy run needs room: a browser that fills /tmp crashes, and its
//  core then fills /. ~/.cache is on /, so the / check covers the scratch. Returns the complaints, empty when there is room.
export function diskShort({ root = 10, tmp = 2 } = {}) {
  const bad = [];
  const r = freeGB('/'), t = freeGB('/tmp');
  if (r < root) bad.push(`/ has ${r.toFixed(1)} GB free, need ${root}`);
  if (t < tmp) bad.push(`/tmp has ${t.toFixed(1)} GB free, need ${tmp}`);
  return bad;
}
