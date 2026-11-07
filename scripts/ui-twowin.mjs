#!/usr/bin/env node
//  ui-twowin.mjs: two windows of one browser on the same pages.
//
//    1. the edit lock (36-editlock.js): the first window on a page holds
//       'lat-edit:<name>' and edits; the second opens it read-only with
//       #lockbar, and "Edit here instead" (#locktake) moves the lock over.
//       Closing the holder hands the lock to the window waiting for it.
//    2. stale saves (35-pages.js casQ/settleStale, ?cas=1): a save behind
//       a write made elsewhere merges when the edits touch different
//       stretches, and otherwise keeps the editor's text under conflicts/
//       and shows theirs, never writing over the ship's newer body.
//    3. one offline queue for both windows (08-offline.js dropQueued): a
//       save in window B does not remove a record another window queued,
//       and that record still drains to the ship afterwards.
//
//  WRITES to the ship (namespace tw/, and conflicts/), dev harness only.
//  Env: LATTICE_URL, LATTICE_COOKIE, CHROME
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const url = (n) => env.app + '?name=' + encodeURIComponent(n);
const VIEW = { viewport: { width: 1400, height: 900 } };

const browser = await launchBrowser();
const p1 = await openPage(browser, env, VIEW);
p1.on('dialog', (d) => d.accept().catch(() => {}));
let p2 = null, pB = null;

//  ship reads and writes, made from inside any open page (same cookie)
const shipSource = (page, name) => page.evaluate(async (n) => {
  const r = await fetch('/apps/lattice/page-source?name=' + encodeURIComponent(n));
  if (!r.ok) return { status: r.status, body: '' };
  return { status: 200, body: (await r.json()).body };
}, name);
const shipPut = (page, name, body, extra = '') => page.evaluate(async (n, b, x) => {
  const r = await fetch('/apps/lattice/page-save?name=' + encodeURIComponent(n) + '&type=md' + x,
    { method: 'POST', body: b });
  return r.status;
}, name, body, extra);
const treePaths = (page) => page.evaluate(async () => {
  const t = await (await fetch('/apps/lattice/page-tree')).json();
  return (t.nodes || []).filter((n) => n.page).map((n) => n.path);
});
const type = (page, text) => page.evaluate((t) => {
  const s = document.getElementById('src');
  s.value = t; s.dispatchEvent(new Event('input'));
}, text);
const save = (page) => page.evaluate(() => document.getElementById('save').click());
const srcVal = (page) => page.evaluate(() => document.getElementById('src').value);
//  the editor shows `name`, read from the ship (not the empty boot state)
const shows = (page, name) => page.waitForFunction((n) =>
  document.getElementById('pname') && document.getElementById('pname').value === n
    && document.getElementById('src').value.length > 0, { timeout: 60000 }, name);
const lockState = (page) => page.evaluate(() => {
  const b = document.getElementById('lockbar');
  return { bar: !!b && !b.hidden, ro: document.getElementById('src').readOnly };
});
const holds = (page, name) => waitFor(() => page.evaluate(async (n) =>
  (await navigator.locks.query()).held.some((l) => l.name === 'lat-edit:' + n), name), 30000);
//  the shared IndexedDB queue, read from a page of this origin
const idb = (page, op, rec) => page.evaluate((o, r) => new Promise((res) => {
  const rq = indexedDB.open('lattice-offline', 3);
  rq.onerror = () => res({ err: 'open' });
  rq.onsuccess = () => {
    try {
      const st = rq.result.transaction('saves', o === 'put' ? 'readwrite' : 'readonly')
        .objectStore('saves');
      const q = o === 'put' ? st.put(r) : o === 'get' ? st.get(r) : st.count();
      q.onsuccess = () => res({ v: q.result === undefined ? null : q.result });
      q.onerror = () => res({ err: o });
    } catch (e) { res({ err: String(e) }); }
  };
}), op, rec);

try {
  // -- setup: clean client state, fresh tw/ and conflicts/, seeded pages ----
  await p1.goto(env.app + '/no-such-asset', { timeout: 60000 });
  await p1.evaluate(async () => {
    localStorage.clear();
    indexedDB.deleteDatabase('lattice-offline');
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
    const del = (n) => fetch('/apps/lattice/page-del?name=' + encodeURIComponent(n), { method: 'POST' });
    await del('tw'); await del('conflicts');
  });
  const SEED = [['tw/a', '# a\n\nlocked page\n'],
    ['tw/b', 'line one\n\nline two\n\nline three\n'],
    ['tw/c', '# c\n\nbefore\n'], ['tw/q', '# q\n\nship copy\n']];
  for (const [n, b] of SEED) await shipPut(p1, n, b, '&new=1');
  const seeded = await waitFor(async () => {
    for (const [n, b] of SEED) if ((await shipSource(p1, n)).body !== b) return false;
    return true;
  }, 60000, 1000);
  check('(setup) the tw/ pages are seeded', !!seeded);

  // -- 1. the edit lock across two windows ---------------------------------
  await p1.goto(url('tw/a'), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await shows(p1, 'tw/a');
  check('the first window holds the lock on tw/a', !!(await holds(p1, 'tw/a')));
  check('and edits it', !(await lockState(p1)).ro && !(await lockState(p1)).bar,
    JSON.stringify(await lockState(p1)));

  p2 = await openPage(browser, env, VIEW);

  p2.on('dialog', (d) => d.accept().catch(() => {}));
  await p2.goto(url('tw/a'), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await shows(p2, 'tw/a');
  const ro2 = await waitFor(async () => { const s = await lockState(p2); return s.bar && s.ro && s; }, 30000);
  check('the second window opens tw/a read-only, with the lock bar', !!ro2,
    JSON.stringify(await lockState(p2)));

  await p2.evaluate(() => document.getElementById('locktake').click());
  const moved = await waitFor(async () => {
    const a = await lockState(p1), b = await lockState(p2);
    return a.bar && a.ro && !b.bar && !b.ro;
  }, 30000);
  check('"Edit here instead" moves the lock: the first goes read-only, the second edits',
    !!moved, JSON.stringify({ first: await lockState(p1), second: await lockState(p2) }));

  await p2.close(); p2 = null;
  const back = await waitFor(async () => { const s = await lockState(p1); return !s.bar && !s.ro; }, 30000);
  check('closing the holder hands the lock to the waiting window', !!back,
    JSON.stringify(await lockState(p1)));

  // -- 2. a stale save merges, or is kept aside, never written over --------
  //  Autosave off, so each save happens when the suite says: the editor is
  //  made dirty BEFORE the write elsewhere lands, so no refresh can quietly
  //  hand the editor theirs first.
  await p1.evaluate(() => { localStorage.latAutosave = '0'; });
  await p1.goto(url('tw/b'), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await shows(p1, 'tw/b');
  await holds(p1, 'tw/b');
  await type(p1, (await srcVal(p1)).replace('line one', 'line ONE mine'));
  await shipPut(p1, 'tw/b', 'line one\n\nline two\n\nline THREE theirs\n');
  await save(p1);
  const merged = await waitFor(async () => {
    const b = (await shipSource(p1, 'tw/b')).body;
    return b.includes('line ONE mine') && b.includes('line THREE theirs');
  }, 60000, 1000);
  check('edits to different lines merge on the ship', !!merged,
    JSON.stringify((await shipSource(p1, 'tw/b')).body));
  const mergedHere = await waitFor(async () => {
    const v = await srcVal(p1);
    return v.includes('line ONE mine') && v.includes('line THREE theirs');
  }, 30000);
  check('and the editor shows the merged text', !!mergedHere, JSON.stringify(await srcVal(p1)));
  check('and no conflicts/ page was made',
    !(await treePaths(p1)).some((p) => p.startsWith('conflicts/')));

  const mine = (await srcVal(p1)).replace('line ONE mine', 'line ONE mine again');
  await type(p1, mine);
  const theirs = (await shipSource(p1, 'tw/b')).body.replace('line ONE mine', 'line ONE theirs again');
  await shipPut(p1, 'tw/b', theirs);
  await save(p1);
  const kept = await waitFor(async () =>
    (await treePaths(p1)).find((p) => p.startsWith('conflicts/mine-tw-b-')), 60000, 1000);
  check('an edit to the same line is kept aside under conflicts/mine-tw-b-*', !!kept);
  const keptBody = kept ? (await shipSource(p1, kept)).body : '';
  check('the kept page holds the editor\'s text', keptBody.includes('line ONE mine again'),
    JSON.stringify(keptBody));
  const shipB = (await shipSource(p1, 'tw/b')).body;
  check('the ship keeps theirs, not written over',
    shipB.includes('line ONE theirs again') && !shipB.includes('line ONE mine again'), JSON.stringify(shipB));
  const showsTheirs = await waitFor(async () => (await srcVal(p1)).includes('line ONE theirs again'), 30000);
  check('and the editor now shows theirs', !!showsTheirs, JSON.stringify(await srcVal(p1)));

  // -- 3. one queue, two windows: B's save leaves A's record alone ---------
  //  Batch replays are HELD (not aborted) on both windows while the record
  //  sits there: an abort would mark the window degraded and send B's own
  //  save to the queue too. Held requests are let go before the drain.
  let holdBatch = true;
  const held = [];
  const gate = (r) => {
    if (holdBatch && /page-save-batch/.test(r.url())) { held.push(r); return; }
    r.continue().catch(() => {});
  };
  await p1.setRequestInterception(true); p1.on('request', gate);
  pB = await openPage(browser, env, VIEW);
  pB.on('dialog', (d) => d.accept().catch(() => {}));
  await pB.setRequestInterception(true); pB.on('request', gate);
  await pB.goto(url('tw/c'), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await shows(pB, 'tw/c');
  await holds(pB, 'tw/c');
  //  observation window: B's boot replay check (4 s after boot) has passed,
  //  so the record inserted below is a foreign window's, not B's backlog
  await sleep(5000);
  const rec = { name: 'tw/q', kind: 'md', body: 'queued by A', baseRev: 0, isNew: false,
    queuedAt: Date.now(), id: 'zzzz-1', win: 'zzzz', seq: 1, dname: '', dnames: '' };
  const put = await idb(p1, 'put', rec);
  check('(setup) a foreign window\'s record is queued', !put.err, JSON.stringify(put));

  await type(pB, '# c\n\nedited in B\n');
  await save(pB);
  const cLanded = await waitFor(async () =>
    (await shipSource(pB, 'tw/c')).body.includes('edited in B'), 60000, 1000);
  check('window B\'s save of tw/c lands', !!cLanded);
  const still = await idb(pB, 'get', 'tw/q');
  check('and the record queued by another window is still there',
    !!still.v && still.v.body === 'queued by A' && still.v.win === 'zzzz', JSON.stringify(still));

  holdBatch = false;
  for (const r of held.splice(0)) r.continue().catch(() => {});
  //  a reload is a replay moment: boot drains what the queue holds
  await pB.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  const drained = await waitFor(async () => (await idb(pB, 'count')).v === 0, 60000, 1000);
  check('the queued record drains once replays are let through', !!drained,
    JSON.stringify(await idb(pB, 'count')));
  const qLanded = await waitFor(async () =>
    (await shipSource(pB, 'tw/q')).body === 'queued by A', 30000, 1000);
  check('and its body reaches the ship', !!qLanded, JSON.stringify((await shipSource(pB, 'tw/q')).body));
} catch (e) {
  check('the suite threw: ' + String(e.message).slice(0, 140), false);
} finally {
  // -- cleanup (failure path too: residue would skew the next run) ---------
  try {
    await p1.evaluate(async () => {
      for (const n of ['tw', 'conflicts'])
        await fetch('/apps/lattice/page-del?name=' + n, { method: 'POST' });
    });
  } catch {}
  await browser.close();
}

console.log(check.fails === 0 ? '\nall checks passed' : '\n' + check.fails + ' FAILURES');
process.exit(check.fails === 0 ? 0 : 1);
