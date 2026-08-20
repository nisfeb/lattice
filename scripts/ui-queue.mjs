#!/usr/bin/env node
//  ui-queue.mjs — the offline queue's LIFECYCLE, end to end in a real
//  browser. Every scenario is a bug that shipped: names the server would
//  400 were queued and then silently discarded on drain (#178); a queued
//  create lost its create flag to the first coalescing autosave (#175);
//  edit+rename manufactured a conflicts/ page on replay (#176, #177 — both
//  fixes were wrong until base 0 became a real no-CAS spelling in #178);
//  and the FIRST offline action being structural threw past every caller
//  and did nothing (#178).
//
//  WRITES to the ship (namespace qh/) — dev harness only.
//  Env: LATTICE_URL, LATTICE_COOKIE, CHROME   (as ui-matrix.mjs)
import { shipEnv, launchBrowser, openPage, makeCheck, sleep } from './lib/harness.mjs';

const env = shipEnv();
const APP = env.app;
const check = makeCheck();

const browser = await launchBrowser();
const page = await openPage(browser, env, { viewport: { width: 1400, height: 900 } });

// the switch: while down, every write and the reconnect probe abort at the
// network layer — indistinguishable from an unreachable ship
let shipDown = false;
await page.setRequestInterception(true);
page.on('request', (r) => {
  const down = shipDown &&
    /page-save|page-save-batch|page-move|page-del|folder-new|know-save|legacy-status/.test(r.url());
  (down ? r.abort() : r.continue()).catch(() => {});
});

const wait = async (fn, arg, ms = 30000) => {
  await page.waitForFunction(fn, { timeout: ms }, arg);
};
const status = () => page.evaluate(() => document.getElementById('status').textContent || '');
const qCount = () => page.evaluate(() => new Promise((res) => {
  try {
    const rq = indexedDB.open('lattice-offline', 3);
    rq.onsuccess = () => {
      try {
        const c = rq.result.transaction('saves', 'readonly').objectStore('saves').count();
        c.onsuccess = () => res(c.result); c.onerror = () => res(-1);
      } catch { res(0); }
    };
    rq.onerror = () => res(-1);
  } catch { res(-1); }
}));
const opCount = () => page.evaluate(() => new Promise((res) => {
  try {
    const rq = indexedDB.open('lattice-offline', 3);
    rq.onsuccess = () => {
      try {
        const c = rq.result.transaction('ops', 'readonly').objectStore('ops').count();
        c.onsuccess = () => res(c.result); c.onerror = () => res(-1);
      } catch { res(0); }
    };
    rq.onerror = () => res(-1);
  } catch { res(-1); }
}));
const type = (text) => page.evaluate((t) => {
  const s = document.getElementById('src');
  s.value = t; s.dispatchEvent(new Event('input'));
}, text);
const nameAndType = (name, text) => page.evaluate((n, t) => {
  const p = document.getElementById('pname');
  p.readOnly = false; p.value = n;
  const s = document.getElementById('src');
  s.value = t; s.dispatchEvent(new Event('input'));
}, name, text);
const shipSource = (name) => page.evaluate(async (n) => {
  const r = await fetch('/apps/lattice/page-source?name=' + encodeURIComponent(n));
  if (!r.ok) return { status: r.status };
  return { status: 200, body: (await r.json()).body };
}, name);
const conflictRows = () => page.evaluate(() =>
  [...document.querySelectorAll('#treelist a.pg')]
    .filter((a) => a.href.includes('conflicts')).length);
const drain = async () => {
  shipDown = false;
  // the reconnect probe runs every 20s; the drain follows it. On timeout,
  // say WHAT is stuck — a silent hang is exactly what this suite hunts.
  try {
  await wait(() => new Promise((res) => {
    const rq = indexedDB.open('lattice-offline', 3);
    rq.onsuccess = () => {
      try {
        const s = rq.result.transaction('saves', 'readonly').objectStore('saves').count();
        const o = rq.result.transaction('ops', 'readonly').objectStore('ops').count();
        let sv = -1, ov = -1;
        // resolve EVERY poll (false when nonzero) — a predicate that only
        // resolves on success leaves waitForFunction awaiting forever
        const done = () => { if (sv >= 0 && ov >= 0) res(sv === 0 && ov === 0); };
        s.onsuccess = () => { sv = s.result; done(); };
        o.onsuccess = () => { ov = o.result; done(); };
      } catch { res(false); }
    };
    rq.onerror = () => res(false);
  }), undefined, 150000);
  } catch (e) {
    console.log('  DRAIN STUCK: saves=' + await qCount() + ' ops=' + await opCount()
      + ' status="' + (await status()).slice(0, 80) + '"'
      + ' badge=' + await page.evaluate(() => {
          const b = document.getElementById('offbadge');
          return b ? JSON.stringify({ hidden: b.hidden, text: b.textContent }) : 'none';
        }));
    throw e;
  }
  await sleep(4000);   // let loadTree land after the drain
};

try {
  // ── setup: clean client state, seed pages ─────────────────────────────────
  await page.goto(APP + '/no-such-asset', { timeout: 60000 });
  await page.evaluate(async () => {
    localStorage.clear();
    indexedDB.deleteDatabase('lattice-offline');
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  });
  await page.evaluate(async () => {
    // idempotent: a crashed earlier run leaves qh/ and conflicts/ residue,
    // and new=1 seeding silently 409s against it — every assertion below
    // would then measure the residue, not this run
    const del = (n) => fetch('/apps/lattice/page-del?name=' + encodeURIComponent(n),
      { method: 'POST' });
    await del('qh'); await del('conflicts');
    const put = (n, body, extra) => fetch('/apps/lattice/page-save?name=' +
      encodeURIComponent(n) + '&type=md' + (extra || ''), { method: 'POST', body });
    await put('qh/orig', '# orig v1', '&new=1');
    await put('qh/orig', '# orig v2');           // a second rev: destinations
    await put('qh/doomed', '# doomed', '&new=1'); // with history broke #177
  });
  await sleep(5000);
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0, undefined, 90000);

  // ── 1. an invalid name is refused BEFORE it can queue ─────────────────────
  shipDown = true;
  await page.evaluate(() => document.getElementById('newf') ? document.getElementById('newf').click() : null);
  await nameAndType('qh/Bad Name', '# doc the drain would have discarded');
  await page.evaluate(() => document.getElementById('save').click());
  await sleep(2000);
  check('an invalid name is refused loudly', /bad name/.test(await status()), await status());
  check('and nothing was queued for the drain to discard', await qCount() === 0,
    'saves=' + await qCount());

  // ── 2. offline create + coalescing autosave keeps the create flag ────────
  await nameAndType('qh/created', '# created v1');
  await page.evaluate(() => document.getElementById('save').click());
  await wait(() => /waiting to sync|saved offline/.test(document.getElementById('status').textContent));
  await type('# created v2 coalesced');
  await sleep(4000);   // autosave debounce + queue write
  check('re-edits coalesce to one queued record', await qCount() === 1,
    'saves=' + await qCount());

  // ── 3. offline edit + rename of a page WITH history ──────────────────────
  await page.evaluate(() => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes('qh%2Forig')).click();
  });
  await wait(() => document.getElementById('src').value.includes('orig v2'));
  await type('# orig EDITED offline');
  await sleep(4000);
  check('the edit queued', await qCount() === 2, 'saves=' + await qCount());
  check('(setup) the edited page is the open one',
    await page.evaluate(() => document.getElementById('pname').value) === 'qh/orig');
  await page.evaluate(() => document.getElementById('mv').click());
  // offsetParent is null for fixed-position dialogs — measure the box instead
  await wait(() => {
    const d = document.getElementById('dlginput');
    return d && !d.hidden && d.getBoundingClientRect().height > 0;
  });
  await page.evaluate(() => {
    const i = document.getElementById('dlginput');
    i.value = 'qh/renamed';
    document.getElementById('dlgok').click();
  });
  await sleep(2500);
  check('the offline rename queued as an op', await opCount() >= 1,
    'ops=' + await opCount());

  // ── 4. a structural op as a NEXT action while offline (delete) ───────────
  await page.evaluate(() => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes('qh%2Fdoomed')).click();
  });
  await sleep(1500);
  await page.evaluate(() => document.getElementById('del').click());
  await sleep(800);
  await page.evaluate(() => document.getElementById('dlgok').click());
  await sleep(2500);
  check('the offline delete queued', await opCount() >= 2, 'ops=' + await opCount());

  // ── the drain: everything lands, nothing manufactured, nothing lost ──────
  await drain();
  const created = await shipSource('qh/created');
  check('the created page landed with its LAST body',
    created.status === 200 && /created v2 coalesced/.test(created.body || ''),
    JSON.stringify(created).slice(0, 80));
  const renamed = await shipSource('qh/renamed');
  check('the renamed page holds the offline edit',
    renamed.status === 200 && /orig EDITED offline/.test(renamed.body || ''),
    JSON.stringify(renamed).slice(0, 80));
  const orig = await shipSource('qh/orig');
  check('the old name is gone', orig.status !== 200, 'status=' + orig.status);
  const doomed = await shipSource('qh/doomed');
  check('the deleted page is gone', doomed.status !== 200, 'status=' + doomed.status);
  check('NO conflicts/ page was manufactured', await conflictRows() === 0,
    'rows=' + await conflictRows());
} catch (e) {
  check('the suite threw: ' + String(e.message).slice(0, 140), false);
} finally {
  // ── cleanup ──────────────────────────────────────────────────────────────
  //  Cleanup runs on the failure path too: the seeding above says what a
  //  leftover qh/ does to the next run.
  shipDown = false;      // else the interceptor aborts the delete
  try {
    await page.evaluate(async () => {
      await fetch('/apps/lattice/page-del?name=qh', { method: 'POST' });
    });
  } catch {}
  await browser.close();
}

console.log(check.fails === 0 ? '\nall checks passed' : '\n' + check.fails + ' FAILURES');
process.exit(check.fails === 0 ? 0 : 1);
