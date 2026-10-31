#!/usr/bin/env node
//  gate.mjs: the release gate, in parallel.
//
//  One base ship of our own (fleet set lattice-gate, ~dep) gets this
//  checkout through dev-deploy.py. Once its instance reads bang null it is
//  snapshotted with `fleet --fast snap ~dep gate` and cloned into LANES
//  throwaway copies (`fleet clone dep N gate`), each in its own network
//  namespace on its own port. The ship-bound suites (browser ui-*.mjs,
//  job-check.py and the Hoon suites) are handed to the lanes longest
//  first, by the times in scripts/gate-times.json. The ship-free work (the
//  pure ui suites, ui-manager, offline-tests.sh and the static checks) runs
//  locally at the same time. One table at the end; exit 1 on any failure.
//  The clones are dropped on the way out, Ctrl+C included.
//
//  usage: node scripts/gate.mjs [--lanes N] [--two-ship SET] [--stall]
//                               [--only a,b] [--record] [--keep] [--no-deploy]
//
//    --lanes N        clones to run the ship suites on (default 4)
//    --two-ship SET   also run ui-links, two-ship-links.sh and
//                     two-ship-save.sh with A = the base ship and B = the
//                     ship of fleet set SET (lattice installed, not ~mec,
//                     ~mun, ~hus or ricsul). Clones cannot reach each other,
//                     so these need named ships and are off by default.
//    --stall          also run stall-check.py --resume on a clone of its own
//                     (about an hour, so never part of the default gate)
//    --only a,b       only these ship suites (names as in the table)
//    --record         write the measured times back to gate-times.json
//    --no-retry       no second run, alone, for a ship suite that failed
//    --strict         a flaky suite (failed, then passed alone) fails the gate
//    --keep           leave the clones up (fleet drop dep removes them)
//    --no-deploy      snapshot the base ship as it is
//
//  Env: FLEET (the fleet script), FLEET_WHO (default fast-gate), GATE_SET
//  (default lattice-gate), VERE, CHROME. Logs go to /tmp/lattice-gate/<run>.
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { cpus, homedir, loadavg } from 'os';
import { join } from 'path';

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
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
const LANES = Number(opt('--lanes', 4));
const TWO = opt('--two-ship', '');
const ONLY = opt('--only', '') ? opt('--only', '').split(',') : null;
if (flag('--two-ship') && !TWO) die('--two-ship needs a fleet set for ship B');

function die(m) { console.error('gate: ' + m); process.exit(2); }
const say = (m) => console.error(`gate: [${((Date.now() - T0) / 1000).toFixed(0)}s] ${m}`);
const T0 = Date.now();
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOGS = '/tmp/lattice-gate/' + RUN;
mkdirSync(LOGS, { recursive: true });

//  --- processes: every child in its own group, so Ctrl+C reaches all of it ---
const kids = new Set();
function run(cmd, args, { env = {}, log, timeout = 0, cwd = ROOT, pin = false } = {}) {
  return new Promise((done) => {
    const t = Date.now();
    if (pin && PIN) { args = ['-c', REST_CPUS, cmd, ...args]; cmd = 'taskset'; }
    const p = spawn(cmd, args, { cwd, env: { ...process.env, FLEET_WHO: WHO, ...env }, detached: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    kids.add(p);
    let out = '';
    const take = (b) => { out += b; };
    p.stdout.on('data', take); p.stderr.on('data', take);
    const timer = timeout && setTimeout(() => { out += `\ngate: timed out after ${timeout} s\n`; kill(p); }, timeout * 1000);
    p.on('close', (code, sig) => {
      kids.delete(p); if (timer) clearTimeout(timer);
      if (log) writeFileSync(log, out);
      done({ code: code ?? (sig ? 128 : 1), out, secs: (Date.now() - t) / 1000 });
    });
    p.on('error', (e) => { out += String(e); });
  });
}
function kill(p) { try { process.kill(-p.pid, 'SIGTERM'); } catch {} }
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
const SHIPFREE_BROWSER = ['ui-manager.mjs'];
const TWO_SHIP = ['ui-links.mjs'];
const shipSuites = [
  ...uis.filter((f) => browser(f) && !SHIPFREE_BROWSER.includes(f) && !TWO_SHIP.includes(f)),
  'job-check.py', 'hoon-suites',
].filter((n) => !ONLY || ONLY.includes(n));
function shipCmd(name, lane) {
  const env = { LATTICE_URL: lane.url, LATTICE_COOKIE: lane.cookie };
  if (name === 'hoon-suites') return ['bash', [S + '/hoon-test-kit/hoon-test.sh', lane.pier], { env: { VERE } }];
  if (name.endsWith('.py')) return ['python3', ['-u', S + '/' + name, lane.url, lane.cookie, ...(name === 'stall-check.py' ? ['--resume'] : [])], { env }];
  return ['node', [S + '/' + name], { env }];
}
function fiberio() {
  const g = HOME + '/software/personal/grubbery';
  return `{ git -C ${g} show origin/dist/single-release:desk/lib/fiberio.hoon 2>/dev/null ||
    curl -fsSL https://raw.githubusercontent.com/nisfeb/grubbery/dist/single-release/desk/lib/fiberio.hoon; } > ${LOGS}/fiberio.hoon`;
}
const localJobs = [
  ...uis.filter((f) => !browser(f)).map((f) => [f, 'node', [S + '/' + f]]),
  ['ui-manager.mjs', 'node', [S + '/ui-manager.mjs']],
  ['offline-tests', 'bash', [S + '/offline-tests.sh']],
  ['code-closure', 'python3', [S + '/code-closure.py', 'code']],
  ['bill-check', 'python3', [S + '/bill-check.py', 'code']],
  ['depth-check', 'python3', [S + '/depth-check.py', 'code/nex/lattice/app.hoon']],
  ['quiet-check', 'python3', [S + '/quiet-check.py', 'code']],
  ['weir-check', 'bash', ['-c', `${fiberio()} && python3 ${S}/weir-check.py code/nex/lattice/app.hoon --io ${LOGS}/fiberio.hoon`]],
  ['desktop-commands', 'node', [S + '/desktop-commands.mjs']],
  ['kind-parity', 'node', [S + '/kind-parity.mjs']],
  ['scripts-parse', 'bash', ['-c', 'set -e; for f in scripts/*.mjs scripts/lib/*.mjs; do node --check "$f"; done; for f in scripts/*.sh scripts/lib/*.sh; do bash -n "$f"; done']],
  ['ui-built', 'bash', ['-c', 'node scripts/build-ui.mjs && git diff --exit-code code/nex/lattice/ui-app/app.js && node --check code/nex/lattice/ui-app/app.js']],
];

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

async function baseShip() {
  const b = setLine(SET);
  const claim = existsSync(HOME + '/fleet/claims/' + SET) ? readFileSync(HOME + '/fleet/claims/' + SET, 'utf8').trim() : '';
  if (claim && claim !== WHO) die(`set ${SET} is claimed by ${claim}`);
  await fleet('claim', SET, WHO); claimed = true;
  let r = await fleet('up', SET);
  if (r.code) throw new Error('fleet up ' + SET + ': ' + r.out.trim());
  b.cookie = await cookieFor(b.pier, b.url, 'base');
  let stamp = '';
  if (!flag('--no-deploy')) {
    const fresh = (await get(b.url + INST + '?info=1', b.cookie.header)).status !== 200;
    r = await run('python3', [S + '/dev-deploy.py', b.url, b.cookie.jar, ...(fresh ? ['--add'] : []), '--approve'],
      { log: `${LOGS}/deploy.log`, timeout: 1800 });
    if (r.code) throw new Error('dev-deploy failed, see ' + LOGS + '/deploy.log');
    stamp = (r.out.match(/version\.json = (\S+)/) || [])[1];
    say(`deployed ${stamp} (${(r.out.match(/(\d+) files written/) || [])[1]} files) in ${r.secs.toFixed(0)} s`);
  }
  await live(b.url, b.cookie.header, stamp);
  say('base ship is live');
  return b;
}
async function makeLanes(b, n) {
  const r = await run(F, ['--fast', 'snap', '~' + b.ship, SNAP], { timeout: 900 });
  if (r.code) throw new Error('fleet snap: ' + r.out.trim());
  say('snapshotted ~' + b.ship + ' as ' + SNAP);
  if (!TWO) await run(F, ['down', SET], { timeout: 300 });  // its CPU goes to the lanes
  return cloneLanes(b, n);
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
  await Promise.all(work);
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
      B_URL: b.url, B_COOKIE: b.cookie.raw, B_PIER: b.pier, A_SOCK: a.pier + '/.urb/dev/grubbery/lattice/fs' };
    for (const [name, cmd, args] of [['two-ship-links.sh', 'bash', [S + '/two-ship-links.sh']],
      ['two-ship-save.sh', 'bash', [S + '/two-ship-save.sh']], ['ui-links.mjs', 'node', [S + '/ui-links.mjs']]]) {
      record(name, '~' + a.ship + '+~' + b.ship, await run(cmd, args, { env, log: `${LOGS}/${name}.log`, timeout: 1500 }));
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
  const ship = (async () => runShip(await baseShip()))().catch((e) => { fatal = e.message; });
  await Promise.all([local, ship]);
} catch (e) { fatal = e.message; }
await teardown();
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
if (!TWO) console.log('not run: the two-ship suites (ui-links.mjs, two-ship-links.sh, two-ship-save.sh); pass --two-ship SET');
if (!flag('--stall')) console.log('not run: stall-check.py; pass --stall');
if (missing.length && fatal) console.log('never started: ' + missing.join(' '));
if (fatal) console.log('gate error: ' + fatal);
for (const r of flaky) console.log(`flaky: ${r.suite} failed under the parallel load and passed alone (${LOGS}/${r.suite}.log)`);
for (const r of failed) console.log(`  ${r.suite}: ${LOGS}/${r.suite}${r.retry ? '.retry' : ''}.log`);
if (flag('--record') && !fatal) {
  const times = JSON.parse(readFileSync(S + '/gate-times.json', 'utf8'));
  for (const r of results) if (r.lane !== 'local' && r.ok && !r.retry) times[r.suite] = Math.round(r.secs);
  writeFileSync(S + '/gate-times.json', JSON.stringify(Object.fromEntries(Object.entries(times).sort((a, b) => b[1] - a[1])), null, 2) + '\n');
}
process.exit(failed.length || fatal || (flag('--strict') && flaky.length) ? 1 : 0);
