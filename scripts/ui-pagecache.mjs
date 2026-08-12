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
const PROFILE = mkdtempSync(join(tmpdir(), 'lat-pc-'));

const puppeteer = (await import('puppeteer-core')).default;
const ck = readFileSync(CKF, 'utf8').trim();
const [cn, ...cr] = ck.split('=');
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

// ── cold, then the background self-refetch populates the cache ──────────
let t = await nav(PAGE);
console.log('  (cold: ' + t + 'ms)');
await sleep(12000);   // idle gate (2s idle / 6s cap) + self-fetch + margin

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
await p2.close();

// ── the cache and worker survive a browser restart ──────────────────────
await browser.close();
browser = await launch();
p = await browser.newPage();
await p.setCookie({ name: cn, value: cr.join('='), domain: HOST, path: '/' });
track(p);
t = await nav(PAGE);
check('instant across browser restart', t < 400, t + 'ms');
check('restart content is fresh', (await p.content()).includes(stamp2));

// ── home is a cached surface too ────────────────────────────────────────
await nav(HOME); await sleep(12000);
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
await nav(PAGE); await sleep(12000);
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

// ── a manual reload must reach the network ──────────────────────────────
await sleep(12000);
t = await nav(PAGE);
check('(setup) view cached once more', t < 400, t + 'ms');
const t0r = Date.now();
await p.reload({ waitUntil: 'domcontentloaded' });
check('F5 goes to the network', Date.now() - t0r > 400, (Date.now() - t0r) + 'ms');

await browser.close();
rmSync(PROFILE, { recursive: true, force: true });
console.log(fails === 0 ? '\nall checks passed' : '\n' + fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
