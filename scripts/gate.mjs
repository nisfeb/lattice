#!/usr/bin/env node
//  gate.mjs: the release gate, in parallel.
//
//  One base ship of our own (fleet set lattice-gate, ~dep) gets this
//  checkout through dev-deploy.py. Once its instance reads bang null it is
//  snapshotted with `fleet --fast snap ~dep gate` and cloned into LANES
//  throwaway copies (`fleet clone dep N gate`), each in its own network
//  namespace on its own port. The ship-bound suites (browser ui-*.mjs,
//  job-check.py, fs-old-beacon-check.sh, which mounts this checkout's
//  lattice-fs, and the Hoon suites) are handed to the lanes longest
//  first, by the times in scripts/gate-times.json. The ship-free work (the
//  pure ui suites, ui-manager, offline-tests.sh and the static checks) runs
//  locally at the same time. One table at the end; exit 1 on any failure.
//  The clones are dropped on the way out, Ctrl+C included.
//
//  usage: node scripts/gate.mjs [--lanes N] [--two-ship SET] [--stall]
//                               [--only a,b] [--record] [--keep] [--no-deploy]
//
//    --lanes N        clones to run the ship suites on (default: 4, or fewer
//                     when fewer suites run or memory is short)
//    --two-ship SET   also run ui-links, ui-shares-live, ui-follow-live, two-ship-links.sh
//                     and two-ship-save.sh (with --only naming any of
//                     them, just those) with A = the base ship and B = the
//                     ship of fleet set SET (lattice installed, not ~mec,
//                     ~mun, ~hus or ricsul). Clones cannot reach each other,
//                     so these need named ships and are off by default.
//    --stall          also run stall-check.py --resume on a clone of its own
//                     (about an hour, so never part of the default gate)
//    --only a,b       only these suites, ship or local (names as in the table);
//                     the local checks run too only with --local
//    --warm           deploy and snapshot, run no suite: refreshes the gate
//                     snapshot (run it on main after a merge, so a branch's
//                     run deploys only its own diff)
//    --cold           always boot, deploy and snapshot the base ship
//    --hot            hot patch a client-only diff into the lanes (the
//                     default with --only; see UI_APP)
//    --record         write the measured times back to gate-times.json
//    --no-retry       no second run, alone, for a ship suite that failed
//    --strict         a flaky suite (failed, then passed alone) fails the gate
//    --keep           leave the clones up (fleet drop dep removes them)
//    --no-deploy      snapshot the base ship as it is
//
//  Env: FLEET (the fleet script), FLEET_WHO (default fast-gate), GATE_SET
//  (default lattice-gate), VERE, CHROME, LATTICE_SCRATCH (default
//  ~/.cache/lattice-gate), GATE_KEEP_RUNS (logs of the last 10 runs kept).
//
//  Fast path: when the gate snapshot already holds this checkout's code/
//  (the pier's .lattice-deploy.json manifest matches), the base ship is
//  not booted, deployed or snapshotted: the lanes are cloned straight from
//  the snapshot. Otherwise dev-deploy sends only the files the manifest
//  says differ, with no GET per file.
//
//  Hygiene (lib/hygiene.mjs): core dumps off for every child, scratch and
//  TMPDIR under LATTICE_SCRATCH, every child marked and killed with its
//  whole tree when it ends, and no start with under 10 GB free on / or
//  2 GB on /tmp.
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'fs';
import { cpus, freemem, homedir, loadavg } from 'os';
import { join } from 'path';
import { SCRATCH, diskShort, killTagged, marked, noCores, procTag, unmarked } from './lib/hygiene.mjs';

const HOME = homedir();
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const S = ROOT + '/scripts';
const F = process.env.FLEET || HOME + '/software/personal/hoon-development/fleet/fleet';
const FLEET_DIR = F.replace(/\/[^/]+$/, '');
const WHO = process.env.FLEET_WHO || 'fast-gate';
const SET = process.env.GATE_SET || 'lattice-gate';
const VERE = process.env.VERE || HOME + '/software/vere-v4.6-linux-x86_64';
const SNAP = 'gate';
//  Each lane's serf gets a core of its own: a single-threaded serf that the
//  scheduler puts on an efficiency core (8 to 15 on this i7-1260P) runs at
//  about half speed, which is what the timing checks felt under load. The
//  serfs take CPUs 0, 2, 4 and 6 (one thread of each performance core) and
//  everything the gate starts runs on the others. GATE_PIN=0 turns it off.
const PIN = process.env.GATE_PIN !== '0' && cpus().length >= 16;
const SERF_CPU = (i) => String((2 * i) % 8);
const REST_CPUS = '1,3,5,7,8-' + (cpus().length - 1);
const NEVER = ['mec', 'mun', 'hus', 'ricsul-bilwyt-dozzod-nisfeb'];

//  --- flags ---
const argv = process.argv.slice(2);
function die(m) { console.error('gate: ' + m); process.exit(2); }
//  --help prints the comment above and starts nothing. An unknown flag is
//  refused before anything starts, so a typo never runs the full gate.
if (argv.includes('--help') || argv.includes('-h')) {
  const head = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
  console.log(head.slice(0, head.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ {0,2}/, '')).join('\n'));
  process.exit(0);
}
const TAKES = { '--lanes': 1, '--two-ship': 1, '--only': 1 };
const FLAGS = ['--stall', '--local', '--warm', '--cold', '--hot', '--record', '--no-retry', '--strict', '--keep', '--no-deploy'];
for (let i = 0; i < argv.length; i++) {
  if (TAKES[argv[i]]) i++;
  else if (!FLAGS.includes(argv[i])) die(`unknown flag ${argv[i]} (--help lists them)`);
}
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
const LANES_ASKED = opt('--lanes', '');
const TWO = opt('--two-ship', '');
const ONLY = opt('--only', '') ? opt('--only', '').split(',') : null;
if (flag('--two-ship') && !TWO) die('--two-ship needs a fleet set for ship B');
if (LANES_ASKED && !(Number.isInteger(Number(LANES_ASKED)) && Number(LANES_ASKED) > 0)) die('--lanes needs a whole number of clones');
const say = (m) => console.error(`gate: [${((Date.now() - T0) / 1000).toFixed(0)}s] ${m}`);
const T0 = Date.now();
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOGS = join(SCRATCH, RUN);
const TMP = join(LOGS, 'tmp');
{
  const short = diskShort();
  if (short.length) die('refusing to start: ' + short.join('; ') + ' (a full disk crashes the browsers and kills ships)');
}
noCores();
mkdirSync(TMP, { recursive: true });
//  keep the last GATE_KEEP_RUNS runs' logs
{
  const keep = Number(process.env.GATE_KEEP_RUNS || 10);
  const runs = readdirSync(SCRATCH).filter((d) => /^\d{4}-\d\d-\d\dT/.test(d)).sort();
  for (const d of runs.slice(0, Math.max(0, runs.length - keep))) rmSync(join(SCRATCH, d), { recursive: true, force: true });
}
const OWNER = procTag();
let tags = 0;
//  phase -> seconds, printed at the end
const phases = [];
const phase = async (name, p) => { const t = Date.now(); try { return await p; } finally { phases.push([name, (Date.now() - t) / 1000]); } };

//  --- processes: every child in its own group, so Ctrl+C reaches all of it ---
const kids = new Set();
//  Every child but fleet's carries LATTICE_TEST_OWNER (this gate) and a
//  LATTICE_TEST_TAG of its own, which its browsers and Xvfb inherit even
//  when they start a process group of their own (puppeteer does): when it
//  ends, whatever still carries its tag is killed. Fleet's ships and tmux
//  sessions outlive the run on purpose, so they are never marked.
function run(cmd, args, { env = {}, log, timeout = 0, cwd = ROOT, pin = false } = {}) {
  return new Promise((done) => {
    const t = Date.now();
    const isFleet = cmd === F;
    const tag = `${OWNER}/${++tags}`;
    if (pin && PIN) { args = ['-c', REST_CPUS, cmd, ...args]; cmd = 'taskset'; }
    const base = { ...process.env, FLEET_WHO: WHO, TMPDIR: TMP, LATTICE_SCRATCH: SCRATCH, ...env };
    const p = spawn(cmd, args, { cwd, env: isFleet ? unmarked(base) : { ...base, LATTICE_TEST_OWNER: OWNER, LATTICE_TEST_TAG: tag },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    p.tag = isFleet ? null : tag;
    kids.add(p);
    let out = '';
    const take = (b) => { out += b; };
    p.stdout.on('data', take); p.stderr.on('data', take);
    const timer = timeout && setTimeout(() => { out += `\ngate: timed out after ${timeout} s\n`; kill(p); }, timeout * 1000);
    p.on('close', (code, sig) => {
      kids.delete(p); if (timer) clearTimeout(timer);
      if (p.tag) { const left = killTagged(p.tag); if (left.length) out += `\ngate: killed ${left.length} leftover processes (${left.join(' ')})\n`; }
      if (log) writeFileSync(log, out);
      done({ code: code ?? (sig ? 128 : 1), out, secs: (Date.now() - t) / 1000 });
    });
    p.on('error', (e) => { out += String(e); });
  });
}
function kill(p) {
  try { process.kill(-p.pid, 'SIGTERM'); } catch {}
  if (p.tag) for (const q of marked('LATTICE_TEST_TAG', p.tag)) { try { process.kill(q, 'SIGTERM'); } catch {} }
}
const sh = (line, o) => run('bash', ['-c', line], o);
const fleet = (...a) => run(F, a, { timeout: 900 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

//  --- the ships ---
function setLine(name) {
  const l = readFileSync(FLEET_DIR + '/sets.conf', 'utf8').split('\n')
    .map((x) => x.replace(/#.*/, '').trim()).find((x) => x.split(/\s+/)[0] === name);
  if (!l) die(`no set ${name} in ${FLEET_DIR}/sets.conf`);
  const [, , port, ship, ...rest] = l.split(/\s+/);
  if (NEVER.includes(ship)) die(`set ${name} is ~${ship}, which the gate never touches`);
  const p = rest.map((x) => x.match(new RegExp('^path=' + ship + ':(.*)'))).find(Boolean);
  return { set: name, ship, port: Number(port), url: 'http://localhost:' + port,
    pier: p ? p[1].replace(/^~/, HOME) : HOME + '/fleet/piers/' + ship };
}
const INST = '/grubbery/ball/apps/shell.shell/desks/lattice.desk/desk/data/lattice.lattice_app';
async function get(url, cookie, ms = 30000) {
  try {
    const r = await fetch(url, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(ms) });
    return { status: r.status, text: await r.text() };
  } catch (e) { return { status: 0, text: String(e) }; }
}
async function until(what, secs, fn, every = 1000) {
  const end = Date.now() + secs * 1000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`gave up after ${secs} s waiting for ${what}`);
    await sleep(every);
  }
}
async function cookieFor(pier, url, name) {
  const jar = `${LOGS}/${name}.jar`, raw = `${LOGS}/${name}.cookie`;
  const r = await run(S + '/hoon-test-kit/ship-cookie.sh', [pier, url, jar], { env: { VERE } });
  if (r.code) throw new Error(`no cookie for ${url}: ${r.out.trim()}`);
  const line = readFileSync(jar, 'utf8').split('\n').map((l) => l.replace(/^#HttpOnly_/, '').split('\t'))
    .find((f) => f.length === 7 && f[5].startsWith('urbauth-'));
  writeFileSync(raw, `${line[5]}=${line[6]}\n`, { mode: 0o600 });
  return { jar, raw, header: `${line[5]}=${line[6]}` };
}
//  Live means: the desk holds this deploy's version stamp, the instance
//  compiled (bang null), and the route answers fast three times running.
async function live(url, cookie, stamp, secs = 900) {
  if (stamp) await until('the desk to pull ' + stamp, secs, async () => {
    const r = await get(url + '/grubbery/ball/apps/shell.shell/desks/lattice.desk/version.json?raw=1', cookie);
    return r.text.includes(stamp);
  }, 2000);
  await until('bang null', secs, async () => {
    const r = await get(url + INST + '?info=1', cookie);
    if (r.status !== 200) return false;
    let j; try { j = JSON.parse(r.text); } catch { return false; }
    if (j.bang) say('bang: ' + JSON.stringify(j.bang).slice(0, 200));
    return j.bang === null;
  }, 2000);
  //  the client is compiled into the nexus, so serving this checkout's
  //  app.js means the new build is the one answering
  const js = readFileSync(ROOT + '/code/nex/lattice/ui-app/app.js', 'utf8');
  await until('the new build to serve app.js', secs, async () =>
    (await get(url + '/apps/lattice/app/app.js', cookie, 30000)).text === js, 2000);
  let ok = 0;
  await until('the route to answer fast', secs, async () => {
    const t = Date.now(); const r = await get(url + '/apps/lattice', cookie, 15000);
    ok = r.status === 200 && Date.now() - t < 4000 ? ok + 1 : 0;
    return ok >= 3;
  }, 1000);
}

//  --- the suites ---
const browser = (f) => /puppeteer|lib\/harness\.mjs/.test(readFileSync(S + '/' + f, 'utf8'));
const uis = readdirSync(S).filter((f) => /^ui-.*\.mjs$/.test(f)).sort();
const SHIPFREE_BROWSER = ['ui-manager.mjs', 'ui-reader-loading.mjs'];
const TWO_SHIP = ['ui-links.mjs', 'ui-shares-live.mjs', 'ui-follow-live.mjs'];
const allShip = [
  ...uis.filter((f) => browser(f) && !SHIPFREE_BROWSER.includes(f) && !TWO_SHIP.includes(f)),
  'job-check.py', 'big-page-check.py', 'dirshare-check.py', 'fs-old-beacon-check.sh', 'hoon-suites',
];
const shipSuites = allShip.filter((n) => !ONLY || ONLY.includes(n));
const TWOS = [['two-ship-links.sh', 'bash'], ['two-ship-save.sh', 'bash'], ['two-ship-comments.sh', 'bash'],
  ['two-ship-notify.sh', 'bash'], ['ui-links.mjs', 'node'], ['ui-shares-live.mjs', 'node'], ['ui-follow-live.mjs', 'node'],
  ['two-ship-dirshare.py', 'python3'], ['two-ship-urb-read.sh', 'bash']];
//  A lane is a ~1.2 GB pier copy and a serf with a 2 GB loom that runs
//  near 3 GB: no more lanes than suites, pinned performance cores (4), or
//  about a third of the free memory in GB.
const LANES = LANES_ASKED ? Number(LANES_ASKED)
  : Math.max(1, Math.min(4, shipSuites.length || 1, Math.floor(availGB() / 3)));
function availGB() {
  const m = readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/);
  return m ? Number(m[1]) / 2 ** 20 : freemem() / 2 ** 30;
}
function shipCmd(name, lane) {
  const env = { LATTICE_URL: lane.url, LATTICE_COOKIE: lane.cookie };
  if (name === 'hoon-suites') return ['bash', [S + '/hoon-test-kit/hoon-test.sh', lane.pier], { env: { VERE } }];
  //  the lattice-fs this checkout builds, mounted over HTTP on the lane
  if (name === 'fs-old-beacon-check.sh') return ['bash', ['-c',
    'cargo build --release -q --manifest-path lattice-fs-rs/Cargo.toml && exec scripts/fs-old-beacon-check.sh "$0"',
    lane.url], { env }];
  if (name.endsWith('.py')) return ['python3', ['-u', S + '/' + name, lane.url, lane.cookie, ...(name === 'stall-check.py' ? ['--resume'] : [])], { env }];
  return ['node', [S + '/' + name], { env }];
}
function fiberio() {
  const g = HOME + '/software/personal/grubbery';
  return `{ git -C ${g} show origin/dist/single-release:desk/lib/fiberio.hoon 2>/dev/null ||
    curl -fsSL https://raw.githubusercontent.com/nisfeb/grubbery/dist/single-release/desk/lib/fiberio.hoon; } > ${LOGS}/fiberio.hoon`;
}
const allLocal = [
  ...uis.filter((f) => !browser(f)).map((f) => [f, 'node', [S + '/' + f]]),
  ['ui-manager.mjs', 'node', [S + '/ui-manager.mjs']],
  ['ui-reader-loading.mjs', 'node', [S + '/ui-reader-loading.mjs']],
  ['offline-tests', 'bash', [S + '/offline-tests.sh']],
  ['code-closure', 'python3', [S + '/code-closure.py', 'code']],
  ['bill-check', 'python3', [S + '/bill-check.py', 'code']],
  ['depth-check', 'python3', [S + '/depth-check.py', 'code/nex/lattice/app.hoon']],
  ['quiet-check', 'python3', [S + '/quiet-check.py', 'code']],
  ['weir-check', 'bash', ['-c', `${fiberio()} && python3 ${S}/weir-check.py code/nex/lattice/app.hoon --io ${LOGS}/fiberio.hoon`]],
  ['desktop-commands', 'node', [S + '/desktop-commands.mjs']],
  ['kind-parity', 'node', [S + '/kind-parity.mjs']],
  ['hermes-plugin', 'python3', [S + '/hermes-plugin-check.py']],
  ['scripts-parse', 'bash', ['-c', 'set -e; for f in scripts/*.mjs scripts/lib/*.mjs; do node --check "$f"; done; for f in scripts/*.sh scripts/lib/*.sh; do bash -n "$f"; done']],
  ['ui-built', 'bash', ['-c', 'node scripts/build-ui.mjs && git diff --exit-code code/nex/lattice/ui-app/app.js && node --check code/nex/lattice/ui-app/app.js']],
  ['writer-built', 'bash', ['-c', 'node scripts/build-writer.mjs && git diff --exit-code code/nex/lattice/ui-app/writer.js ui-src/writer/vendor/LICENSES && node --check code/nex/lattice/ui-app/writer.js']],
  ['writer-licences', 'node', [S + '/writer-licences.mjs']],
  ['writer-roundtrip', 'node', [S + '/writer-roundtrip.mjs']],
];
//  a misspelt --only name would otherwise run nothing and pass
for (const n of ONLY || []) {
  if (![...allShip, ...allLocal.map(([x]) => x), ...TWOS.map(([x]) => x)].includes(n)) die(`--only: no suite ${n}`);
}
const localJobs = flag('--warm') ? [] : !ONLY || flag('--local') ? allLocal : allLocal.filter(([n]) => ONLY.includes(n));

const results = [];
const record = (suite, lane, r) => {
  results.push({ suite, lane, secs: r.secs, ok: r.code === 0 });
  say(`${r.code === 0 ? 'pass' : 'FAIL'} ${suite} on ${lane} in ${r.secs.toFixed(0)} s`);
};
async function pool(items, width, fn) {
  const q = [...items]; const workers = [];
  for (let i = 0; i < width; i++) workers.push((async () => { for (let x; (x = q.shift()) !== undefined;) await fn(x, i); })());
  await Promise.all(workers);
}

async function runLocal() {
  await pool(localJobs, 4, async ([name, cmd, args]) =>
    record(name, 'local', await run(cmd, args, { log: `${LOGS}/${name}.log`, timeout: 600, pin: true })));
}

//  --- setup and teardown ---
let clones = [];
let claimed = false;
let tearing = null;
async function teardown() {
  if (tearing) return tearing;
  tearing = (async () => {
    for (const p of kids) kill(p);
    await sleep(kids.size ? 3000 : 0);
    //  anything this run started that is still about, browsers included
    for (const q of marked('LATTICE_TEST_OWNER', OWNER)) { try { process.kill(q, 'SIGKILL'); } catch {} }
    rmSync(TMP, { recursive: true, force: true });
    if (clones.length && !flag('--keep')) {
      say('dropping ' + clones.map((c) => c.id).join(' '));
      await run(F, ['drop', ...clones.map((c) => c.id)], { timeout: 300 });
    }
    if (claimed) {
      await run(F, ['down', SET], { timeout: 300 });
      await run(F, ['release', SET], { timeout: 60 });
    }
  })();
  return tearing;
}
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(s, async () => { say(s + ': stopping'); await teardown(); process.exit(130); });
}

//  What the gate snapshot holds: its pier carries the deploy manifest and
//  the session cookie minted before it was taken, which every clone takes.
const MANIFEST = '.lattice-deploy.json', COOKIE = '.lattice-gate-cookie';
//  The client files the instance lays as grubs at <instance>/app/<name>.
//  The nexus embeds them at build time, so a change to one costs a full
//  rebuild (about three minutes) through the desk. With --only (or --hot)
//  a diff of only these is written straight into each lane's grubs
//  instead, in about a second: the lane then runs the snapshot's nexus
//  with this checkout's client. The full gate always deploys.
const UI_APP = /^nex\/lattice\/ui-app\/[^/]+$/;
const HOT = (ONLY || flag('--hot')) && !flag('--cold');
async function hotPatch(lane, files, cookie) {
  for (const f of files) {
    const body = readFileSync(ROOT + '/code/' + f, 'utf8');
    const ext = f.split('.').pop();
    const mite = { js: 'application/javascript', html: 'text/html' }[ext] || 'text/plain';
    const r = await fetch(lane.url + INST + '/app/' + encodeURIComponent(f.split('/').pop()), {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'write-text', content: body, mite }), redirect: 'manual',
      signal: AbortSignal.timeout(120000) }).catch((e) => ({ status: 0, statusText: String(e) }));
    if (r.status !== 200 && r.status !== 303) throw new Error(`hot patch of ${f} on ${lane.id}: ${r.status} ${r.statusText}`);
    const served = await get(lane.url + '/apps/lattice/app/' + f.split('/').pop(), cookie, 60000);
    if (served.text !== body) throw new Error(`hot patch of ${f} on ${lane.id} is not what it serves; run with --cold`);
  }
}
function snapPier(b) { return `${HOME}/fleet/snaps/${SET}/${SNAP}.d/${b.ship}`; }
async function warmSnapshot(b) {
  if (flag('--cold') || flag('--no-deploy') || flag('--warm') || TWO) return false;
  const pier = snapPier(b);
  if (!existsSync(pier + '/' + MANIFEST) || !existsSync(pier + '/' + COOKIE)) return false;
  //  eyre's session lasts 30 days; a week leaves a margin
  if (Date.now() - statSync(pier + '/' + COOKIE).mtimeMs > 7 * 86400e3) { say('the gate snapshot is over a week old'); return false; }
  const r = await run('python3', [S + '/dev-deploy.py', b.url, '/dev/null', '--dry-run', '--manifest', pier + '/' + MANIFEST]);
  const diff = r.out.split('\n').map((l) => l.match(/^  (\S+)$/)).filter(Boolean).map((m) => m[1]);
  if (r.code && !(HOT && diff.length && diff.every((f) => UI_APP.test(f)))) {
    say('the snapshot is behind this checkout: ' + r.out.trim().split('\n').pop()); return false;
  }
  if (r.code) b.hot = diff;
  const header = readFileSync(pier + '/' + COOKIE, 'utf8').trim();
  writeFileSync(`${LOGS}/base.cookie`, header + '\n', { mode: 0o600 });
  b.cookie = { raw: `${LOGS}/base.cookie`, header, jar: null };
  return true;
}

async function baseShip() {
  const b = setLine(SET);
  const claim = existsSync(HOME + '/fleet/claims/' + SET) ? readFileSync(HOME + '/fleet/claims/' + SET, 'utf8').trim() : '';
  if (claim && claim !== WHO) die(`set ${SET} is claimed by ${claim}`);
  await fleet('claim', SET, WHO); claimed = true;
  if (await warmSnapshot(b)) {
    say(b.hot ? `the gate snapshot differs only in the client (${b.hot.join(' ')}): hot patching the lanes, no deploy`
      : 'the gate snapshot already holds this code/: no deploy');
    b.warm = true; return b;
  }
  let r = await phase('base up', fleet('up', SET));
  if (r.code) throw new Error('fleet up ' + SET + ': ' + r.out.trim());
  b.cookie = await phase('cookie', cookieFor(b.pier, b.url, 'base'));
  let stamp = '';
  if (!flag('--no-deploy')) {
    const fresh = (await get(b.url + INST + '?info=1', b.cookie.header)).status !== 200;
    r = await phase('deploy', run('python3', [S + '/dev-deploy.py', b.url, b.cookie.jar, ...(fresh ? ['--add'] : []), '--approve',
      '--manifest', b.pier + '/' + MANIFEST], { log: `${LOGS}/deploy.log`, timeout: 1800 }));
    if (r.code) throw new Error('dev-deploy failed, see ' + LOGS + '/deploy.log');
    stamp = (r.out.match(/version\.json = (\S+)/) || [])[1];
    say(`deployed ${stamp} (${(r.out.match(/(\d+) files written/) || [])[1]} files) in ${r.secs.toFixed(0)} s`);
  }
  await phase('build until live', live(b.url, b.cookie.header, stamp));
  writeFileSync(b.pier + '/' + COOKIE, b.cookie.header + '\n', { mode: 0o600 });
  say('base ship is live');
  return b;
}
async function snapBase(b) {
  if (b.warm) return;
  const r = await phase('snapshot', run(F, ['--fast', 'snap', '~' + b.ship, SNAP], { timeout: 900 }));
  if (r.code) throw new Error('fleet snap: ' + r.out.trim());
  say('snapshotted ~' + b.ship + ' as ' + SNAP);
  if (!TWO) await phase('base down', run(F, ['down', SET], { timeout: 300 }));  // its CPU goes to the lanes
}
async function makeLanes(b, n) {
  await snapBase(b);
  return phase('clone and boot', cloneLanes(b, n));
}
async function cloneLanes(b, n) {
  const r = await run(F, ['clone', b.ship, String(n), SNAP], { timeout: 900 });
  const got = r.out.split('\n').map((l) => l.match(/^(\S+-\d+) (\d+)$/)).filter(Boolean)
    .map(([, id, port]) => ({ id, port: Number(port), url: 'http://localhost:' + port,
      pier: `${HOME}/fleet/clones/${id}/${b.ship}`, cookie: b.cookie.raw }));
  clones.push(...got);
  if (r.code || got.length !== n) throw new Error('fleet clone: ' + r.out.trim());
  //  the session cookie was minted before the snapshot, so every clone
  //  takes it; a clone that answers 200 without a login is a live lattice
  await Promise.all(got.map((c) => until(c.id + ' to serve lattice', 300, async () =>
    (await get(c.url + '/apps/lattice', b.cookie.header, 15000)).status === 200)));
  if (b.hot) await phase('hot patch', Promise.all(got.map((c) => hotPatch(c, b.hot, b.cookie.header))));
  if (PIN) {
    for (const [i, c] of got.entries()) {
      const r = await sh(`for p in $(pgrep -f -- '--snap-dir ${c.pier}( |$)'); do taskset -cp ${SERF_CPU(i)} $p; done`);
      if (r.code) say(`could not pin ${c.id}'s serf: ${r.out.trim()}`);
    }
  }
  say('lanes up: ' + got.map((c, i) => `${c.id}:${c.port}${PIN ? '@cpu' + SERF_CPU(i) : ''}`).join(' '));
  return got;
}

async function runShip(b) {
  if (flag('--warm')) { await snapBase(b); say('the gate snapshot is warm'); return; }
  if (!shipSuites.length) { if (TWO) await phase('suites', runTwo(b)); return; }
  const times = JSON.parse(readFileSync(S + '/gate-times.json', 'utf8'));
  const order = [...shipSuites].sort((x, y) => (times[y] ?? 60) - (times[x] ?? 60));
  const lanes = await makeLanes(b, LANES + (flag('--stall') ? 1 : 0));
  const work = [pool(order, LANES, async (name, i) => {
    const [cmd, args, o] = shipCmd(name, lanes[i]);
    record(name, lanes[i].id, await run(cmd, args, { ...o, log: `${LOGS}/${name}.log`, timeout: 1500, pin: true }));
  }).then(() => retry(b, lanes.slice(0, LANES))).then(async () => {
    //  done with the suite lanes: their CPU goes to whatever still runs
    const idle = clones.filter((c) => c !== lanes[LANES]);
    if (idle.length && (TWO || flag('--stall')) && !flag('--keep')) {
      await run(F, ['drop', ...idle.map((c) => c.id)], { timeout: 300 });
      clones = clones.filter((c) => !idle.includes(c));
    }
  })];
  if (flag('--stall')) {
    const l = lanes[LANES]; const [cmd, args, o] = shipCmd('stall-check.py', l);
    work.push(run(cmd, args, { ...o, log: `${LOGS}/stall-check.log`, timeout: 7200 }).then((r) => record('stall-check.py', l.id, r)));
  }
  if (TWO) work.push(runTwo(b));
  await phase('suites', Promise.all(work));
}

//  A ship suite that failed under the parallel load gets one more run, on
//  a fresh clone of its own with the other lanes gone. Passing there makes
//  it "flaky": named in the summary, and a failure only with --strict.
async function retry(b, used) {
  const failed = results.filter((r) => !r.ok && r.lane !== 'local').map((r) => r.suite);
  if (!failed.length || flag('--no-retry')) return;
  say('retrying alone: ' + failed.join(' '));
  await run(F, ['drop', ...used.map((c) => c.id)], { timeout: 300 });
  clones = clones.filter((c) => !used.includes(c));
  const again = await cloneLanes(b, Math.min(failed.length, 2));
  await pool(failed, again.length, async (name, i) => {
    const [cmd, args, o] = shipCmd(name, again[i]);
    const r = await run(cmd, args, { ...o, log: `${LOGS}/${name}.retry.log`, timeout: 1500, pin: true });
    results.push({ suite: name, lane: again[i].id + ' retry', secs: r.secs, ok: r.code === 0, retry: true });
    if (r.code === 0) results.find((x) => x.suite === name && !x.retry).flaky = true;
    say(`${r.code === 0 ? 'pass' : 'FAIL'} ${name} again, alone on ${again[i].id}, in ${r.secs.toFixed(0)} s`);
  });
}

async function runTwo(a) {
  const b = setLine(TWO);
  if (b.set === SET) die('--two-ship needs another set than ' + SET);
  const claim = existsSync(HOME + '/fleet/claims/' + TWO) ? readFileSync(HOME + '/fleet/claims/' + TWO, 'utf8').trim() : '';
  if (claim && claim !== WHO) die(`set ${TWO} is claimed by ${claim}`);
  await fleet('claim', TWO, WHO);
  try {
    await fleet('up', TWO);
    b.cookie = await cookieFor(b.pier, b.url, 'peer');
    const r = await run('python3', [S + '/dev-deploy.py', b.url, b.cookie.jar, '--approve'], { log: `${LOGS}/deploy-peer.log`, timeout: 1800 });
    if (r.code) throw new Error('dev-deploy to ' + TWO + ' failed');
    await live(b.url, b.cookie.header, (r.out.match(/version\.json = (\S+)/) || [])[1]);
    //  fleet links the ships of a set, not of two sets: a |hi each way
    const hi = (x, y) => run('bash', ['-c', `source ${F} && khan ${VERE} ${x.pier} "$0"`,
      `=/  m  (strand ,vase)  ;<  =bowl  bind:m  get-bowl  ;<  ~  bind:m  (poke [our.bowl %hood] %helm-send-hi !>([~${y.ship} ~]))  (pure:m !>(%sent))`],
    { timeout: 300 });
    await hi(a, b); await hi(b, a);
    const env = { LATTICE_URL: a.url, LATTICE_COOKIE: a.cookie.raw, A_URL: a.url, A_COOKIE: a.cookie.raw,
      B_URL: b.url, B_COOKIE: b.cookie.raw, B_PIER: b.pier, VERE, A_SOCK: a.pier + '/.urb/dev/grubbery/lattice/fs' };
    //  --only naming a two-ship suite runs just the ones it names
    const named = ONLY && TWOS.some(([n]) => ONLY.includes(n));
    for (const [name, cmd] of TWOS.filter(([n]) => !named || ONLY.includes(n))) {
      record(name, '~' + a.ship + '+~' + b.ship, await run(cmd, [S + '/' + name], { env, log: `${LOGS}/${name}.log`, timeout: 1500 }));
    }
  } finally {
    await run(F, ['down', TWO], { timeout: 300 });
    await run(F, ['release', TWO], { timeout: 60 });
  }
}

//  --- main ---
const loads = [];
const sampler = setInterval(() => loads.push(loadavg()[0]), 15000);
let fatal = '';
try {
  const local = runLocal();
  //  local suites alone need no ship: no claim, no boot, no deploy
  const needShip = shipSuites.length || TWO || flag('--warm');
  const ship = needShip ? (async () => runShip(await baseShip()))().catch((e) => { fatal = e.message; }) : null;
  await Promise.all([local, ship]);
} catch (e) { fatal = e.message; }
await phase('teardown', teardown());
clearInterval(sampler);

const wall = (Date.now() - T0) / 1000;
const w = Math.max(...results.map((r) => r.suite.length), 5);
console.log(`\n${'suite'.padEnd(w)}  ${'lane'.padEnd(12)} ${'s'.padStart(6)}  result`);
for (const r of [...results].sort((x, y) => x.lane.localeCompare(y.lane) || y.secs - x.secs)) {
  console.log(`${r.suite.padEnd(w)}  ${r.lane.padEnd(12)} ${r.secs.toFixed(0).padStart(6)}  ${r.ok ? 'pass' : r.flaky ? 'flaky' : 'FAIL'}`);
}
//  a suite is failed if its last run failed; flaky if it failed and then passed alone
const last = (n) => results.filter((r) => r.suite === n).pop();
const names = [...new Set(results.map((r) => r.suite))];
const failed = names.map(last).filter((r) => !r.ok);
const flaky = results.filter((r) => r.flaky);
const missing = shipSuites.filter((n) => !results.some((r) => r.suite === n));
console.log(`\n${names.length - failed.length - flaky.length} passed, ${flaky.length} flaky, ${failed.length} failed, wall ${(wall / 60).toFixed(1)} min (${wall.toFixed(0)} s), logs ${LOGS}`);
if (loads.length) console.log(`host load (1 min): mean ${(loads.reduce((a, b) => a + b, 0) / loads.length).toFixed(1)}, peak ${Math.max(...loads).toFixed(1)}, on ${cpus().length} threads`);
if (!TWO) console.log(`not run: the two-ship suites (${TWOS.map(([n]) => n).join(', ')}); pass --two-ship SET`);
if (!flag('--stall')) console.log('not run: stall-check.py; pass --stall');
if (missing.length && fatal) console.log('never started: ' + missing.join(' '));
if (fatal) console.log('gate error: ' + fatal);
console.log('phases: ' + phases.map(([n, t]) => `${n} ${t.toFixed(0)} s`).join(', '));
for (const r of flaky) console.log(`flaky: ${r.suite} failed under the parallel load and passed alone (${LOGS}/${r.suite}.log)`);
for (const r of failed) console.log(`  ${r.suite}: ${LOGS}/${r.suite}${r.retry ? '.retry' : ''}.log`);
if (flag('--record') && !fatal) {
  const times = JSON.parse(readFileSync(S + '/gate-times.json', 'utf8'));
  for (const r of results) if (r.lane !== 'local' && r.ok && !r.retry) times[r.suite] = Math.round(r.secs);
  writeFileSync(S + '/gate-times.json', JSON.stringify(Object.fromEntries(Object.entries(times).sort((a, b) => b[1] - a[1])), null, 2) + '\n');
}
process.exit(failed.length || fatal || (flag('--strict') && flaky.length) ? 1 : 0);
