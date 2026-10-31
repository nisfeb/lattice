#!/usr/bin/env node
// Perf regression check for the lattice editor. It asserts REQUEST COUNTS,
// not wall-clock. Every request to the pier costs ~0.5s and they serialize
// (six in parallel measured no faster than six in series), so the count on a
// path IS its user-visible latency. Wall-clock on a shared harness ship is
// noise.
//
// Usage:  node scripts/ui-perf.mjs
// Env:    LATTICE_URL     ship base (default http://localhost:8080)
//         LATTICE_COOKIE  cookie file (default ~/.config/lattice-fs/cookie)
//         CHROME          browser binary (default /usr/bin/chromium)
//
// Needs puppeteer-core:  npm i --no-save puppeteer-core
// Never run against production. It writes two probe pages and deletes them.

import { shipEnv, launchBrowser, openPage, makeCheck, sleep, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const APP = env.app;
const RUN = 'uiperf-' + process.pid;

const check = makeCheck();
const browser = await launchBrowser();
const page = await openPage(browser, env, {
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false),
});

// every /apps/lattice request the page makes, in order
let reqs = [];
page.on('request', (r) => {
  const u = r.url();
  if (u.includes('/apps/lattice')) reqs.push(u.slice(u.indexOf('/apps/lattice') + 13));
});
//  and every one that has finished, so a wait can be on the answer itself
let done = [];
page.on('requestfinished', (r) => done.push(r.url()));
const rendered = (n) => waitFor(() => done.some((u) => u.includes('/page-source?')
  && u.includes('render=1') && u.includes('name=' + encodeURIComponent(n))), 20000, 100);
const since = (mark, pat) => reqs.slice(mark).filter((u) => u.includes(pat)).length;
const wait = (fn, ...args) => page.waitForFunction(fn, { timeout: 90000 }, ...args);

const A = RUN + '/alpha', B = RUN + '/beta';
const BODY_A = '# alpha probe', BODY_B = '# beta probe';

let step = 'setup';
try {
  // a JSON 404 would trip chromium's internal viewer. Use a plain-text one
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
  // let the writes settle before boot. The dump can trail page-source by a
  // revision (the evaluator settles after the writer), and a dump landing
  // mid-test legitimately prunes the entry it thinks is stale. That is a
  // cache miss, not a wrong answer, but it makes the assertions below flap.
  await waitFor(() => page.evaluate(async (a, b, ba, bb) => {
    const j = await (await fetch('/apps/lattice/page-dump', { cache: 'no-store' })).json();
    const body = (n) => ((j.nodes || []).find((x) => x.path && x.path.endsWith(n)) || {}).body;
    return body(a) === ba && body(b) === bb;
  }, A, B, BODY_A, BODY_B), 30000, 1000);

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
  //  A's render answered (it fills the preview and the page cache)
  await rendered(A); await sleep(500);
  console.log('       first open of A cost ' + since(mark, 'page-source') +
    ' page-source request(s) (fills preview + share)');

  // ── 3. RE-open an already-opened page: must cost ZERO requests ───────────
  step = 'toggle';
  await page.evaluate((n) => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes(encodeURIComponent(n))).click();
  }, B);
  await wait((b) => document.getElementById('src').value === b, BODY_B);
  await rendered(B); await sleep(500);     // let B's render land and cache
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
  //  Save is hidden on a desktop (Ctrl+S, the File menu), so as an element
  await page.evaluate(() => document.getElementById('save').click());
  // wait for the write to actually land. A fixed sleep raced the pier
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
  if (check.fails || process.env.VERBOSE)
    console.log('\n  full request log:\n' + reqs.map((u, i) => '   ' + i + ' ' + u).join('\n'));
  try {
    //  the run's folder takes both pages with it
    await page.evaluate(async (r) => {
      await fetch('/apps/lattice/page-del?name=' + encodeURIComponent(r), { method: 'POST' });
    }, RUN);
  } catch {}
  await browser.close();
}

check.done();
