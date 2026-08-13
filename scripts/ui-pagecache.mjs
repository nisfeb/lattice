#!/usr/bin/env node
//  ui-pagecache.mjs — the reader's LRU page cache (#173), end to end.
//
//  The regime under test: sw-js answers reader navigations from the
//  'lattice-pages' cache (a miss redirects to ?u=sw<ts>, which the worker
//  ignores — it must NEVER fetch); page-cache-script refetches each painted
//  document from page context and stores it under its canonical URL; the
//  beacon scripts converge a stale paint QUIETLY and swap a live bump
//  through the cache; the editor busts what it saves. Every failure mode
//  here is silent staleness or a silently slow page, so each scenario
//  asserts both content and timing, and counts post-paint navigations —
//  the check whose absence let the #172 reload loop ship.
//
//  WRITES to the ship (page-save on harnessdir/one) — dev harness only,
//  never production.
//
//  Env:    LATTICE_URL, LATTICE_COOKIE, CHROME   (as ui-matrix.mjs)
//  Usage:  LATTICE_URL=http://localhost:8081 \
//          LATTICE_COOKIE=~/.config/lattice-fs/cookie node scripts/ui-pagecache.mjs
import { readFileSync, rmSync, mkdtempSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

const BASE = (process.env.LATTICE_URL || 'http://localhost:8080').replace(/\/$/, '');
const CKF = (process.env.LATTICE_COOKIE || homedir() + '/.config/lattice-fs/cookie')
  .replace(/^~/, homedir());
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const PROFILE = mkdtempSync(join(process.env.LATTICE_PROFILE_DIR || tmpdir(), 'lat-pc-'));

const puppeteer = (await import('puppeteer-core')).default;
const ck = readFileSync(CKF, 'utf8').trim();
const [cn, ...cr] = ck.split('=');

// Settle gate: right after a deploy the pier serves everything at 5-10s while
// the nexus rebuilds, and a fresh profile's SW install (sw.js + activation)
// queues behind that — the suite would measure deploy churn, not the regime.
// Same contract as the matrix settle scripts: three consecutive sub-4s docs.
{
  let okRuns = 0;
  for (let i = 0; i < 40 && okRuns < 3; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(BASE + '/apps/lattice', { headers: { Cookie: ck } });
      okRuns = (r.ok && Date.now() - t0 < 4000) ? okRuns + 1 : 0;
    } catch { okRuns = 0; }
    if (okRuns < 3) await new Promise((r) => setTimeout(r, 5000));
  }
  if (okRuns < 3) { console.log('ship never settled'); process.exit(1); }
}
const HOST = new globalThis.URL(BASE).hostname;
const PAGE = BASE + '/apps/lattice?url=urb%3A%2F%2F~tyr%2Fharnessdir%2Fone';
const HOME = BASE + '/apps/lattice';
let fails = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   - ' : '  FAIL - ') + name + (detail ? ' (' + detail + ')' : ''));
  if (!ok) fails++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const launch = () => puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  userDataDir: PROFILE, args: ['--no-sandbox'],
});
let browser = await launch();
let p = await browser.newPage();
await p.setCookie({ name: cn, value: cr.join('='), domain: HOST, path: '/' });
let navs = 0;
const track = (pg) => pg.on('framenavigated', f => { if (f === pg.mainFrame()) navs++; });
track(p);
const nav = async (url) => {
  const t0 = Date.now();
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return Date.now() - t0;
};
// The write path is BACKGROUND machinery: the idle self-refetch queues on a
// pier that serializes requests, behind a one-time ~7-asset SW install on a
// fresh profile (~17s of pier time after a deploy). The contract is "the
// next view after the machinery settles is instant", not "instant N seconds
// after cold" — so readiness is polled, with a hard cap that still fails
// the run if the machinery is genuinely broken.
const waitCached = async (url, maxMs = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const ready = await p.evaluate(async (u) => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg || !reg.active) return false;
      const c = await caches.open('lattice-pages');
      return !!(await c.match(u));
    }, url).catch(() => false);
    if (ready) return true;
    await sleep(1000);
  }
  return false;
};

// ── cold, then the background self-refetch populates the cache ──────────
let t = await nav(PAGE);
console.log('  (cold: ' + t + 'ms)');
check('(setup) cold view cached in the background', await waitCached(PAGE));

// ── repeat: served by the SW from the pages cache, canonical URL ────────
t = await nav(PAGE);
check('repeat view is instant', t < 400, t + 'ms');
check('repeat URL stays canonical', !p.url().includes('u=sw'));
navs = 0;
await sleep(10000);
check('no spurious reloads on a cached paint', navs === 0, navs + ' navs');

// ── stale-at-open converges QUIETLY; the NEXT view is fresh ─────────────
const stamp1 = 'quiet-' + Math.floor(Math.random() * 1e6);
await nav(HOME);
await p.evaluate(async (b) => {
  await fetch('/apps/lattice/page-save?name=harnessdir%2Fone&type=md',
    { method: 'POST', body: b });
}, '# one\n' + stamp1);
await sleep(3000);
t = await nav(PAGE);
check('stale-at-open paints instantly', t < 400, t + 'ms');
navs = 0;
await sleep(10000);
check('convergence is quiet — no reload', navs === 0, navs + ' navs');
t = await nav(PAGE);
check('next view is fresh', (await p.content()).includes(stamp1));
check('next view still instant', t < 400, t + 'ms');

// ── a live bump while viewing: exactly one swap, corrected in place ─────
const stamp2 = 'live-' + Math.floor(Math.random() * 1e6);
navs = 0;
const p2 = await browser.newPage();
await p2.setCookie({ name: cn, value: cr.join('='), domain: HOST, path: '/' });
await p2.goto(HOME, { waitUntil: 'domcontentloaded' });
// opening p2 made the viewing tab HIDDEN, and hidden tabs now hold no
// stream and defer updates by design — bring it back before the bump so
// this scenario tests the VISIBLE live path
await p.bringToFront();
await sleep(1500);   // let the stream reconnect
navs = 0;
await p2.evaluate(async (b) => {
  await fetch('/apps/lattice/page-save?name=harnessdir%2Fone&type=md',
    { method: 'POST', body: b });
}, '# one\n' + stamp2);
let seen = false;
for (let i = 0; i < 25 && !seen; i++) {
  await sleep(1000);
  try { seen = (await p.content()).includes(stamp2); } catch {}
}
check('live bump corrects the open view', seen);
check('live bump is exactly one navigation', navs === 1, navs + ' navs');

// ── hidden tab: no churn while away, ONE catch-up swap on return ────────
const stamp2b = 'hidden-' + Math.floor(Math.random() * 1e6);
await p2.bringToFront();             // p is hidden again: stream parked
// p2's own return-to-front catch-up may swap ITS document (home changed
// under it) — let that settle, and retry the save if the swap raced it
await sleep(6000);
navs = 0;
const saveB = (b) => p2.evaluate(async (body) => {
  await fetch('/apps/lattice/page-save?name=harnessdir%2Fone&type=md',
    { method: 'POST', body });
}, b);
try { await saveB('# one\n' + stamp2b); }
catch { await sleep(3000); await saveB('# one\n' + stamp2b); }
await sleep(8000);
check('hidden tab does not navigate on a bump', navs === 0, navs + ' navs');
await p.bringToFront();              // return: one coalesced catch-up swap
let caught = false;
for (let i = 0; i < 20 && !caught; i++) {
  await sleep(1000);
  try { caught = (await p.content()).includes(stamp2b); } catch {}
}
check('return to the tab catches up', caught, navs + ' navs');
check('catch-up is exactly one navigation', navs === 1, navs + ' navs');
await p2.close();

// ── the cache and worker survive a browser restart ──────────────────────
await browser.close();
browser = await launch();
p = await browser.newPage();
await p.setCookie({ name: cn, value: cr.join('='), domain: HOST, path: '/' });
track(p);
await p.bringToFront();
t = await nav(PAGE);
check('instant across browser restart', t < 400, t + 'ms');
check('restart content is fresh', (await p.content()).includes(stamp2b));

// ── home is a cached surface too ────────────────────────────────────────
await nav(HOME);
check('(setup) home cached in the background', await waitCached(HOME));
t = await nav(HOME);
check('home repeat is instant', t < 400, t + 'ms');

// ── eviction: budget=1 empties the cache; next view takes the slow path ─
await p.evaluate(() => { localStorage.latCacheBudget = '1'; });
await nav(PAGE);
await sleep(12000);
const left = await p.evaluate(async () => {
  const c = await caches.open('lattice-pages');
  return (await c.keys()).length;
});
check('eviction empties the cache at budget=1', left === 0, left + ' entries');
t = await nav(PAGE);
check('post-eviction view takes the slow path',
  p.url().includes('u=sw') || t > 400, t + 'ms');
await p.evaluate(() => { localStorage.removeItem('latCacheBudget'); });

// ── an EDITOR save busts the cached view of the page it changed ─────────
await nav(PAGE);
check('(setup) page recached', await waitCached(PAGE));
t = await nav(PAGE);
check('(setup) page cached again', t < 400, t + 'ms');
const stamp3 = 'editor-' + Math.floor(Math.random() * 1e6);
await p.goto(BASE + '/apps/lattice/app?name=harnessdir%2Fone',
  { waitUntil: 'domcontentloaded' });
let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  await sleep(1000);
  ready = await p.evaluate(() => {
    const ta = document.querySelector('textarea');
    return !!ta && ta.value.includes('one');
  }).catch(() => false);
}
check('(setup) editor loaded the page', ready);
await p.evaluate((s) => {
  const ta = document.querySelector('textarea');
  if (!ta) return;
  ta.value = '# one\n' + s;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}, stamp3);
let landed = false;
for (let i = 0; i < 25 && !landed; i++) {
  await sleep(1000);
  landed = await p.evaluate(async (s) => {
    const r = await fetch('/apps/lattice?url=urb%3A%2F%2F~tyr%2Fharnessdir%2Fone&u=pc' + Date.now(),
      { cache: 'no-store' });
    return (await r.text()).includes(s);
  }, stamp3).catch(() => false);
}
check('(setup) editor save landed on ship', landed);
await sleep(2000);
const busted = await p.evaluate(async (page) => {
  const c = await caches.open('lattice-pages');
  return !(await c.match(page));
}, PAGE);
check('editor save busts the cached view', busted);
t = await nav(PAGE);
check('view after own edit is fresh', (await p.content()).includes(stamp3), t + 'ms');

// ── an UNRELATED write must not swap the open view ──────────────────────
// (the beacon is vault-global; the swap must be page-scoped). The editor
// save above busted the entry — wait for the recache so this scenario runs
// on a cache-served view with a real displayed-baseline.
check('(setup) entry back after the editor bust', await waitCached(PAGE));
t = await nav(PAGE);
navs = 0;
const p3 = await browser.newPage();
await p3.setCookie({ name: cn, value: cr.join('='), domain: HOST, path: '/' });
await p3.goto(HOME, { waitUntil: 'domcontentloaded' });
await p3.evaluate(async () => {
  await fetch('/apps/lattice/page-save?name=harnessdir%2Fother&type=md',
    { method: 'POST', body: '# other\nunrelated-' + Math.random() });
});
await sleep(15000);
check('unrelated write does not swap the open view', navs === 0, navs + ' navs');
await p3.close();

// ── a DELETED page must fall out of the cache ───────────────────────────
await p.evaluate(async () => {
  await fetch('/apps/lattice/page-save?name=harnessdir%2Ftmpdel&type=md',
    { method: 'POST', body: '# doomed\ntmpdel-body' });
});
await sleep(2000);
const DOOMED = BASE + '/apps/lattice?url=urb%3A%2F%2F~tyr%2Fharnessdir%2Ftmpdel';
await nav(DOOMED);
check('(setup) doomed page in cache', await waitCached(DOOMED));
t = await nav(DOOMED);
check('(setup) doomed page cached', t < 400, t + 'ms');
await p.evaluate(async () => {
  await fetch('/apps/lattice/page-del?name=harnessdir%2Ftmpdel', { method: 'POST' });
});
// this tab did the delete via raw fetch (no bustPages) — convergence must
// come from the page script. The ?url= reader serves a 200 "not published"
// page for a missing pub, so the cached entry CONVERGES to that body (the
// 404-drop path applies to /x/ routes, where the server actually 404s).
await nav(DOOMED);
let ghost = true;
for (let i = 0; i < 30 && ghost; i++) {
  await sleep(1000);
  ghost = await p.evaluate(async (u) => {
    const c = await caches.open('lattice-pages');
    const hit = await c.match(u);
    if (!hit) return false;              // dropped: converged
    return (await hit.text()).includes('tmpdel-body');  // still the old body?
  }, DOOMED).catch(() => true);
}
check('deleted page converges out of the cached view', !ghost);
t = await nav(DOOMED);
check('view after delete is not the old page',
  !(await p.content()).includes('tmpdel-body'), t + 'ms');

// ── /clip is a side-effecting GET: never cached, never self-refetched ───
const CLIP = BASE + '/apps/lattice/clip?url=' +
  encodeURIComponent('urb://~tyr/harnessdir/one');
await nav(CLIP); await sleep(12000);
const clipCached = await p.evaluate(async () => {
  const c = await caches.open('lattice-pages');
  for (const k of await c.keys())
    if (k.url.includes('/apps/lattice/clip')) return true;
  return false;
});
check('clip confirmation never enters the cache', !clipCached);
t = await nav(CLIP);
check('repeat clip reaches the server', t > 400, t + 'ms');

// ── a manual reload must reach the network ──────────────────────────────
check('(setup) view recached', await waitCached(PAGE));
t = await nav(PAGE);
check('(setup) view cached once more', t < 400, t + 'ms');
const t0r = Date.now();
await p.reload({ waitUntil: 'domcontentloaded' });
check('F5 goes to the network', Date.now() - t0r > 400, (Date.now() - t0r) + 'ms');

await browser.close();
rmSync(PROFILE, { recursive: true, force: true });
console.log(fails === 0 ? '\nall checks passed' : '\n' + fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
