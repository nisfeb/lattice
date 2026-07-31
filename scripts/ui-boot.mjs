#!/usr/bin/env node
// Boot UX invariants for the editor. Both of these were real, both were the
// "nothing is visibly broken, it is just painful" kind:
//
//   1. the preview pane was an opaque white canvas until loading finished,
//      then popped to the theme background
//   2. work done DURING the load was undone when it finished — open a page
//      while the tree (painted from localStorage at 0ms) is already clickable,
//      and boot's trailing newFile('') closed it a second later
//
// The race is made deterministic by delaying /page-dump, so this fails
// reliably against the old build rather than only on a slow ship.
//
// Usage:  node scripts/ui-boot.mjs
// Env:    LATTICE_URL, LATTICE_COOKIE, CHROME   (as ui-matrix.mjs)
// Never run against production.

import { readFileSync } from 'fs';
import { homedir } from 'os';

let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; }
catch { console.error('puppeteer-core missing: npm i --no-save puppeteer-core'); process.exit(2); }

const URL = (process.env.LATTICE_URL || 'http://localhost:8080').replace(/\/$/, '');
const COOKIE_FILE = process.env.LATTICE_COOKIE || homedir() + '/.config/lattice-fs/cookie';
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const APP = URL + '/apps/lattice/app';
const PAGE = 'uiboot' + (process.pid % 100000);
const BODY = '# boot probe';

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
const wait = (fn, ...args) => page.waitForFunction(fn, { timeout: 90000 }, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let step = 'setup';
try {
  await page.setViewport({ width: 1400, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.goto(APP + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(async () => {
    localStorage.clear();
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  });

  step = 'seed';
  await page.evaluate((n, b) => fetch('/apps/lattice/page-save?name=' + encodeURIComponent(n) +
    '&type=md&new=1', { method: 'POST', body: b }), PAGE, BODY);
  await sleep(6000);

  // warm boot: the snapshot is what makes the tree clickable at 0ms
  step = 'prime snapshot';
  await page.goto(APP, { waitUntil: 'networkidle2', timeout: 60000 });
  await wait((n) => [...document.querySelectorAll('#treelist a.pg')]
    .some((a) => a.href.includes(encodeURIComponent(n))), PAGE);

  // ── now the real test: hold /page-dump open so the load window is wide ───
  step = 'delayed boot';
  await page.setRequestInterception(true);
  page.on('request', async (r) => {
    if (r.url().includes('/page-dump')) { await sleep(6000); }
    try { await r.continue(); } catch {}
  });
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 1. the preview must be themed IMMEDIATELY, not after loading finishes
  await wait(() => !!document.getElementById('prev'));
  const early = await page.evaluate(() => {
    const p = document.getElementById('prev');
    return { srcdoc: (p.getAttribute('srcdoc') || ''), cs: getComputedStyle(p).colorScheme };
  });
  check('preview: blanked with a themed document before the load finishes',
    /color-scheme/.test(early.srcdoc), JSON.stringify(early.srcdoc).slice(0, 60));
  check('preview: iframe declares light dark, so no white flash pre-srcdoc',
    /light/.test(early.cs) && /dark/.test(early.cs), early.cs);

  // 2. open a page mid-load; it must survive the load completing
  step = 'open during load';
  await wait((n) => [...document.querySelectorAll('#treelist a.pg')]
    .some((a) => a.href.includes(encodeURIComponent(n))), PAGE);
  const dumpDone = await page.evaluate(() => !!window.__dumpDone);
  await page.evaluate((n) => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes(encodeURIComponent(n))).click();
  }, PAGE);
  await wait((b) => document.getElementById('src').value === b, BODY);
  check('tree is clickable from the snapshot before the dump lands', true,
    'dumpDone=' + dumpDone);

  // let the delayed dump land and boot's trailing action run
  await sleep(9000);
  const after = await page.evaluate(() => ({
    body: document.getElementById('src').value,
    name: document.getElementById('pname').value,
  }));
  check('the page opened during load is STILL open afterwards',
    after.body === BODY, JSON.stringify(after));
  check('and the name field still names it', after.name === PAGE, after.name);
  // ── 3. mobile: land on the tree, and do not summon the keyboard ─────────
  step = 'mobile defaults';
  await page.setRequestInterception(false);
  await page.setViewport({ width: 390, height: 780, isMobile: true });
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0);
  await sleep(2500);
  const mob = await page.evaluate(() => ({
    mv: document.getElementById('ws').dataset.mv,
    focused: document.activeElement && document.activeElement.id,
  }));
  check('mobile: lands on the tree, not an empty editor', mob.mv === 'tree', JSON.stringify(mob));
  check('mobile: does not focus the name field (no keyboard)',
    mob.focused !== 'pname', 'activeElement=' + mob.focused);

  // opening a file still moves to the editor, and a remembered file resumes
  step = 'mobile open';
  await page.evaluate((n) => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes(encodeURIComponent(n))).click();
  }, PAGE);
  await wait((b) => document.getElementById('src').value === b, BODY);
  check('mobile: opening a page switches to the editor',
    await page.evaluate(() => document.getElementById('ws').dataset.mv) === 'code');
  await page.goto(APP + '?name=' + encodeURIComponent(PAGE),
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait((b) => document.getElementById('src').value === b, BODY);
  check('mobile: a remembered file resumes in the editor',
    await page.evaluate(() => document.getElementById('ws').dataset.mv) === 'code');
} catch (e) {
  check('step "' + step + '" threw: ' + String(e.message).slice(0, 140), false);
} finally {
  try {
    await page.setRequestInterception(false);
    await page.evaluate((n) =>
      fetch('/apps/lattice/page-del?name=' + encodeURIComponent(n), { method: 'POST' }), PAGE);
  } catch {}
  await browser.close();
}

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
