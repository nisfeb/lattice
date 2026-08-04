#!/usr/bin/env node
// Offline-editing invariants (docs/offline-edits.md). The outage is
// simulated by ABORTING the save/probe routes via request interception, so
// every scenario is deterministic rather than depending on a dead ship.
//
// Usage:  node scripts/ui-offline.mjs
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
const RUN = 'uioff' + (process.pid % 100000);
const A = RUN + '/alpha', B = RUN + '/beta';

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
const qCount = () => page.evaluate(() => new Promise((res) => {
  const rq = indexedDB.open('lattice-offline');
  rq.onsuccess = () => {
    try {
      const c = rq.result.transaction('saves', 'readonly').objectStore('saves').count();
      c.onsuccess = () => res(c.result); c.onerror = () => res(-1);
    } catch { res(0) }
  };
  rq.onerror = () => res(-1);
}));

// the switch: while down, saves and the reconnect probe abort at the network
// layer, indistinguishable from an unreachable ship as far as fetch can see
let shipDown = false;
await page.setRequestInterception(true);
page.on('request', (r) => {
  const down = shipDown && /page-save|legacy-status|page-cmd|know-save/.test(r.url());
  (down ? r.abort() : r.continue()).catch(() => {});
});

let step = 'setup';
try {
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(APP + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(async () => {
    localStorage.clear();
    indexedDB.deleteDatabase('lattice-offline');
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  });
  await page.evaluate(async (a, b) => {
    const put = (n, body) => fetch('/apps/lattice/page-save?name=' + encodeURIComponent(n) +
      '&type=md&new=1', { method: 'POST', body });
    await put(a, '# alpha v1'); await put(b, '# beta v1');
  }, A, B);
  await sleep(6000);
  await page.goto(APP + '?name=' + encodeURIComponent(A), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.getElementById('src').value.includes('alpha v1'));

  // ── 1. the ship goes away mid-session. An edit queues instead of failing ──
  step = 'edit while down';
  shipDown = true;
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = '# alpha OFFLINE EDIT'; s.dispatchEvent(new Event('input'));
  });
  await wait(() => (document.getElementById('status').textContent || '').includes('waiting to sync'));
  check('a failed save queues, and the status says so', true);
  //  The status line is overwritten by the next event, so it cannot be the
  //  only signal that you are editing offline. The badge reports the CONDITION.
  const badge = () => page.evaluate(() => {
    const b = document.getElementById('offbadge');
    return b ? { hidden: b.hidden, text: b.textContent, syncing: b.classList.contains('syncing') } : null;
  });
  const b1 = await badge();
  check('the offline badge is showing', b1 && !b1.hidden, JSON.stringify(b1));
  check('and it says offline, with the queue depth',
    b1 && /offline/.test(b1.text) && /1 queued/.test(b1.text), JSON.stringify(b1));
  check('and it is not in the syncing state yet', b1 && !b1.syncing, JSON.stringify(b1));
  check('the queue holds one record', await qCount() === 1, 'count=' + await qCount());
  check('the editor is clean, not stuck dirty',
    await page.evaluate(() => document.getElementById('status').textContent.includes('1 waiting')));

  // ── 2. the queue is the top read tier ────────────────────────────────────
  step = 'queue read tier';
  await page.evaluate((n) => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes(encodeURIComponent(n))).click();
  }, B);
  await wait(() => document.getElementById('src').value.includes('beta v1'));
  await page.evaluate((n) => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes(encodeURIComponent(n))).click();
  }, A);
  await sleep(1500);
  check('reopening a queued page shows the QUEUED body, not the server copy',
    await page.evaluate(() => document.getElementById('src').value) === '# alpha OFFLINE EDIT',
    JSON.stringify(await page.evaluate(() => document.getElementById('src').value)));

  // ── 3. non-save operations refuse honestly while offline ────────────────
  step = 'mutate guard';
  await page.evaluate(() => document.querySelector('.share button[data-m="clearweb"]').click());
  // the guard's own message is immediately followed by the caller's failure
  // line ("share failed offline"). The FINAL status is what the user reads
  await wait(() => (document.getElementById('status').textContent || '').includes('share failed offline'));
  check('a share attempt while offline is refused, named as offline', true);

  // ── 4. reconnect: the probe notices, replay drains, the ship converges ───
  step = 'replay';
  shipDown = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));   // refreshAll -> replayQueue
  await wait(() => (document.getElementById('status').textContent || '').includes('synced'), );
  check('replay reports the sync', true);
  check('the queue is empty afterwards', await qCount() === 0, 'count=' + await qCount());
  const b2 = await badge();
  check('the badge clears once the queue drains', b2 && b2.hidden, JSON.stringify(b2));
  await sleep(3000);
  const server = await page.evaluate(async (n) => {
    const r = await fetch('/apps/lattice/page-source?name=' + encodeURIComponent(n));
    return (await r.json()).body;
  }, A);
  check('the ship has the offline edit', server === '# alpha OFFLINE EDIT', JSON.stringify(server));

  // ── 5. Phase 2: a conflict is applied AND flagged, with the loser kept ───
  // While this client is offline, "another device" (node itself, whose
  // fetches bypass the page's interception, exactly like a second machine)
  // edits the same page. On replay: the offline version wins as the newest
  // revision, the status names the overwritten rev, and history still
  // holds it.
  step = 'conflict on replay';
  await page.goto(APP + '?name=' + encodeURIComponent(B), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.getElementById('src').value.includes('beta v1'));
  shipDown = true;
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = '# beta OFFLINE'; s.dispatchEvent(new Event('input'));
  });
  await wait(() => (document.getElementById('status').textContent || '').includes('waiting to sync'));
  // the concurrent edit, from outside the browser entirely
  const cr = await fetch(URL + '/apps/lattice/page-save?name=' + encodeURIComponent(B) + '&type=md',
    { method: 'POST', headers: { cookie }, body: '# beta CONCURRENT' });
  const cj = await cr.json();
  check('concurrent edit landed server-side (the rev to be overwritten)',
    cr.ok && cj.rev > 0, JSON.stringify(cj));
  await sleep(2000);
  shipDown = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await wait(() => (document.getElementById('status').textContent || '').includes('conflict'));
  const cstat = await page.evaluate(() => document.getElementById('status').textContent);
  check('replay flags the conflict and names where the loser was kept',
    cstat.includes('saved at conflicts/'), cstat.slice(0, 140));
  await sleep(3000);
  const winner = await page.evaluate(async (n) => {
    const r = await fetch('/apps/lattice/page-source?name=' + encodeURIComponent(n));
    return (await r.json()).body;
  }, B);
  check('the offline version won (newest revision)', winner === '# beta OFFLINE',
    JSON.stringify(winner));
  // NOT asserted via page-source-at: the firm keep coalesces rapid revisions
  // (three quick writes kept revs [3,1] in testing), so history is exactly
  // the wrong place to promise recovery from, which is why the server
  // preserves the loser as a real page instead.
  const keptName = 'conflicts/' + B.replace(/\//g, '-') + '-rev' + cj.rev;
  const kept = await page.evaluate(async (n) => {
    const r = await fetch('/apps/lattice/page-source?name=' + encodeURIComponent(n));
    return r.ok ? (await r.json()).body : 'HTTP ' + r.status;
  }, keptName);
  check('the overwritten concurrent edit is preserved as a conflict page',
    kept === '# beta CONCURRENT', keptName + ' -> ' + JSON.stringify(kept));

  // ── 6. know memories: queue, queue-first reopen, last-write-wins replay ──
  // know-read is deliberately NOT intercepted. The server still answers with
  // the pre-edit body, so the reopen check proves the queue OUTRANKS a
  // reachable read, not merely a dead one.
  step = 'know offline';
  const K = 'test/' + RUN;
  await page.click('#modet');
  await wait(() => document.getElementById('ws').className.includes('know'));
  await page.evaluate((k) => {
    document.getElementById('pname').value = k;
    const s = document.getElementById('src');
    s.value = 'memory v1'; s.dispatchEvent(new Event('input'));
  }, K);
  await page.click('#save');
  await wait(() => (document.getElementById('status').textContent || '').includes('memory saved'));
  shipDown = true;
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = 'memory OFFLINE'; s.dispatchEvent(new Event('input'));
  });
  await page.click('#save');
  await wait(() => (document.getElementById('status').textContent || '').includes('waiting to sync'));
  check('a know save queues while the ship is down', true);
  check('the know queue holds one record', await qCount() === 1, 'count=' + await qCount());
  await page.evaluate((n) => [...document.querySelectorAll('#treelist a.pg')]
    .find((a) => a.textContent === n).click(), RUN);
  await sleep(1500);
  check('reopening a queued memory shows the QUEUED body, beating a live know-read',
    await page.evaluate(() => document.getElementById('src').value) === 'memory OFFLINE',
    JSON.stringify(await page.evaluate(() => document.getElementById('src').value)));
  step = 'know replay';
  shipDown = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await wait(() => (document.getElementById('status').textContent || '').includes('offline edits synced'));
  check('know replay drains the queue', await qCount() === 0, 'count=' + await qCount());
  const kr = await fetch(URL + '/apps/lattice/know-read?key=' + encodeURIComponent(K),
    { headers: { cookie } });
  const kb = kr.ok ? (await kr.json()).body : 'HTTP ' + kr.status;
  check('the ship has the offline memory (last write wins, no conflict page)',
    kb === 'memory OFFLINE', JSON.stringify(kb));
} catch (e) {
  check('step "' + step + '" threw: ' + String(e.message).slice(0, 140), false);
} finally {
  try {
    shipDown = false;
    await page.evaluate(async (run) => {
      await fetch('/apps/lattice/page-del?name=' + encodeURIComponent(run), { method: 'POST' });
      await fetch('/apps/lattice/page-del?name=conflicts', { method: 'POST' });
      await fetch('/apps/lattice/know-delete?key=' + encodeURIComponent('test/' + run),
        { method: 'POST' });
      indexedDB.deleteDatabase('lattice-offline');
    }, RUN);
  } catch {}
  await browser.close();
}

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
