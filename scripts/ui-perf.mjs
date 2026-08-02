#!/usr/bin/env node
// Perf regression check for the lattice editor. It asserts REQUEST COUNTS, not
// wall-clock: every request to the pier costs ~0.5s and they serialize (six in
// parallel measured no faster than six in series), so the count on a path IS
// its user-visible latency. Wall-clock on a shared harness ship is noise.
//
// Usage:  node scripts/ui-perf.mjs
// Env:    LATTICE_URL     ship base (default http://localhost:8080)
//         LATTICE_COOKIE  cookie file (default ~/.config/lattice-fs/cookie)
//         CHROME          browser binary (default /usr/bin/chromium)
//
// Needs puppeteer-core:  npm i --no-save puppeteer-core
// Never run against production — it writes two probe pages and deletes them.

import { readFileSync } from 'fs';
import { homedir } from 'os';

let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; }
catch { console.error('puppeteer-core missing: npm i --no-save puppeteer-core'); process.exit(2); }

const URL = (process.env.LATTICE_URL || 'http://localhost:8080').replace(/\/$/, '');
const COOKIE_FILE = process.env.LATTICE_COOKIE || homedir() + '/.config/lattice-fs/cookie';
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const APP = URL + '/apps/lattice/app';
const RUN = 'uiperf-' + process.pid;

const cookie = readFileSync(COOKIE_FILE, 'utf8').trim();
const [ckName, ...ckRest] = cookie.split('=');
const host = new globalThis.URL(URL).hostname;

let fails = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  ok   - ' + name);
  else { console.log('  FAIL - ' + name + (detail ? ' (' + detail + ')' : '')); fails++; }
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => check('page threw: ' + e.message.slice(0, 90), false));
await page.setCookie({ name: ckName, value: ckRest.join('='), domain: host, path: '/' });

// every /apps/lattice request the page makes, in order
let reqs = [];
page.on('request', (r) => {
  const u = r.url();
  if (u.includes('/apps/lattice')) reqs.push(u.slice(u.indexOf('/apps/lattice') + 13));
});
const since = (mark, pat) => reqs.slice(mark).filter((u) => u.includes(pat)).length;
const wait = (fn, ...args) => page.waitForFunction(fn, { timeout: 90000 }, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = RUN + '/alpha', B = RUN + '/beta';
const BODY_A = '# alpha probe', BODY_B = '# beta probe';

let step = 'setup';
try {
  // a JSON 404 would trip chromium's internal viewer; use a plain-text one
  await page.goto(APP + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(async () => {
    localStorage.clear();
    indexedDB.deleteDatabase('lattice-offline');
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  });

  step = 'seed probe pages';
  await page.evaluate(async (a, b, ba, bb) => {
    const put = (n, body) => fetch('/apps/lattice/page-save?name=' + encodeURIComponent(n) +
      '&type=md&new=1', { method: 'POST', body });
    await put(a, ba);
    await put(b, bb);
  }, A, B, BODY_A, BODY_B);
  // let the writes settle before boot: the dump can trail page-source by a
  // revision (the evaluator settles after the writer), and a dump landing
  // mid-test legitimately prunes the entry it thinks is stale — a cache miss,
  // not a wrong answer, but it makes the assertions below flap.
  await sleep(6000);

  // ── 1. cold boot: how many requests before the editor is usable? ─────────
  step = 'cold boot';
  reqs = [];
  await page.goto(APP, { waitUntil: 'networkidle2', timeout: 60000 });
  await wait(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0);
  const boot = reqs.slice();
  check('boot: fetches page-dump (bodies arrive with the tree)',
    boot.filter((u) => u.includes('page-dump')).length === 1,
    'saw ' + boot.filter((u) => u.includes('page-dump')).length);
  check('boot: no page-tree (superseded by page-dump)',
    boot.filter((u) => u.includes('page-tree')).length === 0);
  // the two control-panel lists must not be queued ahead of the tree
  const iDump = boot.findIndex((u) => u.includes('page-dump'));
  const iPerm = boot.findIndex((u) => u.includes('share-groups'));
  const iShar = boot.findIndex((u) => u.includes('shared-with-me'));
  check('boot: share-groups deferred until after the tree',
    iPerm === -1 || iPerm > iDump, 'dump@' + iDump + ' groups@' + iPerm);
  check('boot: shared-with-me deferred until after the tree',
    iShar === -1 || iShar > iDump, 'dump@' + iDump + ' shared@' + iShar);
  console.log('       boot API calls: ' +
    JSON.stringify(boot.filter((u) => !/\.(js|png|svg|webmanifest)$/.test(u) && u !== '/app')));

  // ── 2. first open of a page: body must paint WITHOUT waiting on the net ──
  step = 'first open';
  await sleep(1500);                       // let deferred boot traffic settle
  let mark = reqs.length;
  await page.evaluate((n) => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes(encodeURIComponent(n))).click();
  }, A);
  // painted from the dump body synchronously, before any round-trip returns
  const paintedFast = await page.evaluate(() =>
    document.getElementById('src').value).catch(() => '');
  check('open A: editor text painted from the tree dump, no round-trip',
    paintedFast === BODY_A, JSON.stringify(paintedFast.slice(0, 40)));
  await wait(() => document.getElementById('src').value.length > 0);
  await sleep(2500);
  console.log('       first open of A cost ' + since(mark, 'page-source') +
    ' page-source request(s) (fills preview + share)');

  // ── 3. RE-open an already-opened page: must cost ZERO requests ───────────
  step = 'toggle';
  await page.evaluate((n) => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes(encodeURIComponent(n))).click();
  }, B);
  await wait((b) => document.getElementById('src').value === b, BODY_B);
  await sleep(2500);                       // let B's render land and cache
  mark = reqs.length;                      // count only the re-open of A
  await page.evaluate((n) => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes(encodeURIComponent(n))).click();
  }, A);
  await wait((b) => document.getElementById('src').value === b, BODY_A);
  const instant = since(mark, 'page-source') + since(mark, 'page-preview');
  check('re-open A: zero requests (served from the page cache)',
    instant === 0, instant + ' request(s): ' + JSON.stringify(reqs.slice(mark)));
  await sleep(1500);
  const settled = since(mark, 'page-source') + since(mark, 'page-preview');
  check('re-open A: still zero after settling', settled === 0,
    settled + ' request(s): ' + JSON.stringify(reqs.slice(mark)));

  // ── 4. a save must not leave a stale body behind ─────────────────────────
  step = 'save invalidation';
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = '# alpha edited'; s.dispatchEvent(new Event('input'));
  });
  await page.click('#save');
  // wait for the write to actually land — a fixed sleep raced the pier
  await wait(() => /saved|compiling/.test(document.getElementById('status').textContent));
  await sleep(1500);
  await page.evaluate((n) => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes(encodeURIComponent(n))).click();
  }, B);
  await wait((b) => document.getElementById('src').value === b, BODY_B);
  await page.evaluate((n) => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes(encodeURIComponent(n))).click();
  }, A);
  await sleep(1200);
  check('re-open after save: shows the SAVED body, not the pre-save dump copy',
    await page.evaluate(() => document.getElementById('src').value) === '# alpha edited',
    JSON.stringify(await page.evaluate(() => document.getElementById('src').value)));
} catch (e) {
  check('step "' + step + '" threw: ' + String(e.message).slice(0, 120), false);
} finally {
  if (fails || process.env.VERBOSE)
    console.log('\n  full request log:\n' + reqs.map((u, i) => '   ' + i + ' ' + u).join('\n'));
  try {
    await page.evaluate(async (a, b) => {
      for (const n of [a, b])
        await fetch('/apps/lattice/page-del?name=' + encodeURIComponent(n), { method: 'POST' });
    }, A, B);
  } catch {}
  await browser.close();
}

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
