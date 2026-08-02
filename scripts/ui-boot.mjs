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
    indexedDB.deleteDatabase('lattice-offline');
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
  // the primed snapshot is demoted to the LEGACY localStorage form first, so
  // this boot also proves the migration: paint from localStorage.appTree,
  // move it into IDB, remove the localStorage key
  step = 'demote snapshot to legacy form';
  const primed = await page.evaluate(() => new Promise((res) => {
    const rq = indexedDB.open('lattice-offline');
    rq.onsuccess = () => {
      const g = rq.result.transaction('kv').objectStore('kv').get('tree');
      g.onsuccess = () => { res(JSON.stringify((g.result && g.result.v) || null)); rq.result.close(); };
      g.onerror = () => { res('null'); rq.result.close(); };
    };
    rq.onerror = () => res('null');
  }));
  check('warm boot persisted the tree snapshot to IDB', primed !== 'null',
    'kv store had no tree');
  await page.evaluate((t) => new Promise((res) => {
    localStorage.appTree = t;
    // blocked while this page holds its connection — the delete completes at
    // navigation, safely before the next boot's open
    const dq = indexedDB.deleteDatabase('lattice-offline');
    dq.onsuccess = dq.onerror = dq.onblocked = res;
  }), primed);

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
  const mig = await page.evaluate(() => new Promise((res) => {
    const rq = indexedDB.open('lattice-offline');
    rq.onsuccess = () => {
      const g = rq.result.transaction('kv').objectStore('kv').get('tree');
      g.onsuccess = () => {
        res({ ls: 'appTree' in localStorage, idb: !!(g.result && g.result.v && g.result.v.length) });
        rq.result.close();
      };
      g.onerror = () => { res({ ls: 'appTree' in localStorage, idb: false }); rq.result.close(); };
    };
    rq.onerror = () => res(null);
  }));
  check('legacy localStorage tree migrated into IDB and removed',
    !!mig && mig.idb && !mig.ls, JSON.stringify(mig));
  // ── 3. a save must not discard an in-flight tree refresh ────────────────
  // A body-only save used to bump the tree generation, which exists so a
  // STRUCTURAL local patch is not overwritten by a list fetch issued before
  // it. Bumping for a body change threw away legitimate refreshes: a page
  // created while an autosave was in flight never appeared in the tree. The
  // dump is held open so the overlap is deterministic rather than luck.
  step = 'save vs in-flight tree fetch';
  const RACE = PAGE + '-race';
  await page.evaluate((n) => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes(encodeURIComponent(n))).click();
  }, PAGE);
  await wait((b) => document.getElementById('src').value === b, BODY);
  // start a tree refresh that will still be in flight when the save lands
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  // ...and a save that completes during it
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = '# edited during refresh'; s.dispatchEvent(new Event('input'));
  });
  // a page created by something else (another device, a template) meanwhile
  await page.evaluate((n) => fetch('/apps/lattice/page-save?name=' + encodeURIComponent(n) +
    '&type=md&new=1', { method: 'POST', body: '# race' }), RACE);
  await sleep(12000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sleep(8000);
  check('a page created during a save still lands in the tree',
    await page.evaluate((n) => [...document.querySelectorAll('#treelist a.pg')]
      .some((a) => a.href.includes(encodeURIComponent(n))), RACE),
    'tree is missing ' + RACE);
  // this step deliberately edited the probe page; put it back, because the
  // mobile checks below assert it resumes with its ORIGINAL body
  await page.evaluate((n, b) => fetch('/apps/lattice/page-save?name=' +
    encodeURIComponent(n) + '&type=md', { method: 'POST', body: b }), PAGE, BODY);
  await sleep(4000);

  // ── 4. mobile: land on the tree, and do not summon the keyboard ─────────
  step = 'mobile defaults';
  await page.setRequestInterception(false);
  await page.setViewport({ width: 390, height: 780, isMobile: true });
  // the tree-landing rule applies when NOTHING is remembered — with a
  // snapshot, resuming the page wins (that is the other half of the same
  // request: "default to the tree UNLESS it remembers a recent file"). Clear
  // only the page snapshot so this asserts the no-memory case.
  await page.evaluate(() => localStorage.removeItem('appPage'));
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0);
  await sleep(2500);
  const mob = await page.evaluate(() => ({
    mv: document.getElementById('ws').dataset.mv,
    focused: document.activeElement && document.activeElement.id,
  }));
  check('mobile: with nothing remembered, lands on the tree', mob.mv === 'tree', JSON.stringify(mob));
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

  // ── 5. PWA launch: a BARE url resumes the last page ─────────────────────
  // A PWA always launches at start_url, which can never carry ?name — so the
  // snapshot must resume by itself. This was the report "every time I open
  // the PWA it loads my home page instead of the last page I had open".
  step = 'bare-url resume';
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.getElementById('src').value.length > 0);
  const res = await page.evaluate(() => ({
    body: document.getElementById('src').value,
    name: document.getElementById('pname').value,
    mv: document.getElementById('ws').dataset.mv,
  }));
  check('bare launch resumes the last open page', res.body === BODY && res.name === PAGE,
    JSON.stringify(res).slice(0, 90));
  check('and lands in the editor pane on mobile', res.mv === 'code', res.mv);
} catch (e) {
  check('step "' + step + '" threw: ' + String(e.message).slice(0, 140), false);
} finally {
  try {
    await page.setRequestInterception(false);
    for (const n of [PAGE, PAGE + '-race'])
      await page.evaluate((x) =>
        fetch('/apps/lattice/page-del?name=' + encodeURIComponent(x), { method: 'POST' }), n);
  } catch {}
  await browser.close();
}

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
