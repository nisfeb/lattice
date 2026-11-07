//  ui-invclient.mjs: invariants the web client relied on and did not
//  enforce (wiki reports/2026-11-07-lattice-unenforced-invariants).
//
//  1. A task box ticked from a stale paint: the line must still hold what
//     was drawn (content hash), or nothing is ticked.
//  2. The editor preview loads no image from another host until "Load
//     outside content for this page" is pressed for that page.
//  3. The offline replay keeps every refused body: a 413 goes to this
//     device's recovery store, a 400 becomes a conflicts/ page, and two
//     refusals of one page get two copies, the first never written over.
//  4. A record the ship keeps failing on (5xx) is stuck after three tries
//     and no longer holds up the rest; the bar offers to clear it.
//  5. A queued edit rebased onto an offline rename gets the rename's link
//     rewrite, so the replay does not put the old links back.
//
//  WRITES to the ship (namespace qi/ and conflicts/): dev harness only.
//  Env: LATTICE_URL, LATTICE_COOKIE, CHROME
import { shipEnv, launchBrowser, openPage, makeCheck, seed, sleep } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const shipFetch = (path, opts = {}) => fetch(env.base + '/apps/lattice/' + path,
  { ...opts, headers: { Cookie: env.cookie } });
const shipBody = async (n) => {
  const r = await shipFetch('page-source?name=' + encodeURIComponent(n));
  return r.ok ? (await r.json()).body : null;
};
const treeNames = async () => {
  const r = await shipFetch('page-tree');
  if (!r.ok) return [];
  const j = await r.json();
  const list = Array.isArray(j) ? j : j.pages || j.tree || j.nodes || [];
  return list.map((n) => (typeof n === 'string' ? n : n.path || n.name)).filter(Boolean);
};
await shipFetch('page-del?name=qi', { method: 'POST' });
await shipFetch('page-del?name=conflicts', { method: 'POST' });
const TASKS = '# T\n\n- [ ] one\n- [ ] two\n';
await seed(env, [['qi/tasks', TASKS], ['qi/img', '# I\n\n![pic](https://outside.invalid/p.png)\n'],
  ['qi/src', '# src\n\nsee [[qi/src]]\n'], ['qi/b-good', 'good v0']]);

const b = await launchBrowser();
const p = await openPage(b, env, { viewport: { width: 1400, height: 900 } });
//  a navigation over unsaved text asks first (beforeunload)
p.on('dialog', (d) => d.accept().catch(() => {}));
//  the replay's answers, by rule: [test, response] pairs
let rules = [];
let shipDown = false;
let outside = 0;
await p.setRequestInterception(true);
p.on('request', (r) => {
  const u = r.url();
  if (/outside\.invalid/.test(u)) { outside++; return r.abort().catch(() => {}); }
  if (shipDown && /page-save|page-move|page-del|legacy-status/.test(u)) return r.abort().catch(() => {});
  for (const [t, status] of rules) {
    if (t(u, r.postData() || '')) return r.respond({ status, contentType: 'application/json', body: '{"error":"test"}' }).catch(() => {});
  }
  r.continue().catch(() => {});
});
const srcVal = () => p.evaluate(() => document.getElementById('src').value);
const status = () => p.evaluate(() => document.getElementById('status').textContent || '');
const frame = async () => (await p.$('#prev')).contentFrame();
const open = async (name, want) => {
  await p.goto(env.app + '?name=' + encodeURIComponent(name), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction((t) => document.getElementById('src').value.includes(t), { timeout: 60000 }, want);
};
//  a record straight into the queue, as a window that has since closed
//  left it (the replay at the next boot sends it)
const queue = (rec) => p.evaluate((rec) => new Promise((res) => {
  const rq = indexedDB.open('lattice-offline', 3);
  rq.onsuccess = () => {
    const tx = rq.result.transaction('saves', 'readwrite');
    tx.objectStore('saves').put({ kind: 'md', baseRev: 0, isNew: false, queuedAt: Date.now(),
      dname: '', dnames: '', ...rec });
    tx.oncomplete = () => res(true);
    tx.onerror = () => res(false);
  };
}), rec);
const idb = (store) => p.evaluate((store) => new Promise((res) => {
  const rq = indexedDB.open('lattice-offline', 3);
  rq.onsuccess = () => {
    const g = rq.result.transaction(store, 'readonly').objectStore(store).getAll();
    g.onsuccess = () => res(g.result);
  };
}), store);
const waitQueue = async (pred, ms = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred(await idb('saves'))) return true;
    await sleep(1000);
  }
  return false;
};

try {
  // ── 1. a stale task box ticks nothing ─────────────────────────────────────
  await open('qi/tasks', '- [ ] two');
  await p.evaluate(() => window.latSetRead(true));
  await p.waitForFunction(() => (document.getElementById('prev').getAttribute('srcdoc') || '').includes('data-h='),
    { timeout: 20000 });
  await (await frame()).evaluate(() => parent.postMessage({ latTask: 2, on: true, h: 'stale' }, '*'));
  await sleep(800);
  check('a box whose line changed since the paint ticks nothing', await srcVal() === TASKS);
  check('and says so', /nothing was ticked/.test(await status()), await status());
  await (await frame()).click('input[data-line="3"]');
  await p.waitForFunction(() => document.getElementById('src').value.includes('- [x] two'), { timeout: 10000 })
    .catch(() => {});
  check('a box whose line is as drawn still ticks', (await srcVal()).includes('- [x] two'));
  for (let i = 0; i < 30 && !((await shipBody('qi/tasks')) || '').includes('- [x] two'); i++) await sleep(1000);

  // ── 2. remote images wait for "Load outside content" ──────────────────────
  await open('qi/img', 'outside.invalid');
  await p.evaluate(() => window.latSetRead(true));
  //  the ship's render may be what is painted; an input repaints locally
  await p.waitForFunction(() => /Content-Security-Policy/.test(document.getElementById('prev').getAttribute('srcdoc') || ''),
    { timeout: 30000 });
  await p.evaluate(() => document.getElementById('src').dispatchEvent(new Event('input')));
  await p.waitForFunction(() => (document.getElementById('prev').getAttribute('srcdoc') || '').includes('ximg'),
    { timeout: 20000 });
  const sd = await p.evaluate(() => document.getElementById('prev').getAttribute('srcdoc'));
  check('the local paint draws no outside image', !/<img[^>]*outside\.invalid/.test(sd));
  check('and the preview carries the policy that refuses one', /Content-Security-Policy/.test(sd));
  await sleep(3000);       // the ship's render lands too
  check('no request went to the outside host', outside === 0, 'requests=' + outside);
  check('the bar offers to load it', await p.evaluate(() => !document.getElementById('outbar').hidden));
  await p.click('#outload');
  await p.waitForFunction(() => /<img[^>]*outside\.invalid/.test(document.getElementById('prev').getAttribute('srcdoc') || ''),
    { timeout: 20000 }).catch(() => {});
  check('pressed, the image is drawn', /<img[^>]*outside\.invalid/.test(
    await p.evaluate(() => document.getElementById('prev').getAttribute('srcdoc'))));
  check('and the choice is kept for that page',
    await p.evaluate(() => JSON.parse(localStorage.latOutside || '[]').includes('qi/img')));

  // ── 3. refused replays keep their bodies ──────────────────────────────────
  rules = [
    [(u) => /page-save\?name=qi%2Fbig/.test(u), 413],
    [(u, d) => /page-save-batch/.test(u) && d.includes('"qi/big"'), 413],
    [(u) => /page-save\?name=qi%2Fbad&/.test(u), 400],
    [(u, d) => /page-save-batch/.test(u) && d.includes('"qi/bad"'), 400],
  ];
  await queue({ name: 'qi/big', body: 'the big body', id: 'gone1-1', win: 'gone1', seq: 1 });
  await queue({ name: 'qi/bad', body: 'bad body one', id: 'gone1-2', win: 'gone1', seq: 2 });
  await p.reload({ waitUntil: 'domcontentloaded' });
  check('the refused records leave the queue', await waitQueue((s) => !s.some((q) => /qi\/b(ig|ad)/.test(q.name))));
  const kv = await idb('kv');
  check('a 413 is kept in this device\'s recovery store',
    kv.some((r) => r.k.startsWith('recover:') && r.v.name === 'qi/big' && r.v.body === 'the big body'),
    JSON.stringify(kv.map((r) => r.k)));
  await p.waitForFunction(() => /qi\/big/.test((document.getElementById('qstuck') || {}).textContent || ''),
    { timeout: 10000 }).catch(() => {});
  check('and the bar shows it', await p.evaluate(() => {
    const q = document.getElementById('qstuck');
    return !!q && !q.hidden && /kept on this device/.test(q.textContent);
  }));
  let kept = (await treeNames()).filter((n) => n.startsWith('conflicts/offline-edit-qi-bad-'));
  check('a 400 is kept as a conflicts/ page', kept.length === 1, JSON.stringify(kept));
  await queue({ name: 'qi/bad', body: 'bad body two', id: 'gone1-3', win: 'gone1', seq: 3 });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await waitQueue((s) => !s.some((q) => q.name === 'qi/bad'));
  await sleep(2000);
  kept = (await treeNames()).filter((n) => n.startsWith('conflicts/offline-edit-qi-bad-'));
  const bodies = await Promise.all(kept.map(shipBody));
  check('a second refusal gets a copy of its own', kept.length === 2, JSON.stringify(kept));
  check('and the first copy is not written over',
    bodies.some((x) => /bad body one/.test(x || '')) && bodies.some((x) => /bad body two/.test(x || '')),
    JSON.stringify(bodies));

  // ── 4. a stuck record no longer holds up the rest ─────────────────────────
  rules = [
    [(u) => /page-save\?name=qi%2Fa-stuck/.test(u), 500],
    [(u, d) => /page-save-batch/.test(u) && d.includes('"qi/a-stuck"'), 500],
  ];
  await queue({ name: 'qi/a-stuck', body: 'stuck body', id: 'gone2-1', win: 'gone2', seq: 1 });
  await queue({ name: 'qi/b-good', body: 'good v1 queued', id: 'gone2-2', win: 'gone2', seq: 2 });
  await p.reload({ waitUntil: 'domcontentloaded' });
  //  a try at boot, then the reconnect probe's, 20 s apart
  check('the record behind the stuck one lands',
    await waitQueue((s) => !s.some((q) => q.name === 'qi/b-good'), 150000));
  check('with its body', await shipBody('qi/b-good') === 'good v1 queued');
  check('the stuck one stays queued', (await idb('saves')).some((q) => q.name === 'qi/a-stuck'));
  await p.waitForFunction(() => /stuck in the queue/.test((document.getElementById('qstuck') || {}).textContent || ''),
    { timeout: 10000 }).catch(() => {});
  const cleared = await p.evaluate(() => {
    const row = [...document.querySelectorAll('#qstuck div')].find((d) => /stuck in the queue/.test(d.textContent));
    const btn = row && [...row.querySelectorAll('button')].find((x) => x.textContent === 'Clear');
    if (btn) btn.click();
    return !!btn;
  });
  check('the bar lists it with a way to clear it', cleared);
  await waitQueue((s) => !s.some((q) => q.name === 'qi/a-stuck'), 15000);
  const kv2 = await idb('kv');
  check('clearing keeps its text on this device first',
    kv2.some((r) => r.k.startsWith('recover:') && r.v.name === 'qi/a-stuck' && r.v.body === 'stuck body'));
  rules = [];

  // ── 5. a queued edit rebased by an offline rename gets its link rewrite ───
  await open('qi/src', 'see [[qi/src]]');
  shipDown = true;
  await p.evaluate(() => {
    const s = document.getElementById('src');
    s.value = '# src edited\n\nsee [[qi/src]] and [[qi/src|me]]\n';
    s.dispatchEvent(new Event('input'));
  });
  await waitQueue((s) => s.some((q) => q.name === 'qi/src'), 20000);
  await p.evaluate(() => document.getElementById('mv').click());
  await p.waitForFunction(() => {
    const d = document.getElementById('dlginput');
    return d && !d.hidden && d.getBoundingClientRect().height > 0;
  }, { timeout: 10000 });
  await p.evaluate(() => {
    document.getElementById('dlginput').value = 'qi/dst';
    document.getElementById('dlgok').click();
  });
  check('the queued edit moved with the rename and took its rewrite',
    await waitQueue((s) => s.some((q) => q.name === 'qi/dst' && /\[\[qi\/dst\]\]/.test(q.body)), 20000),
    JSON.stringify((await idb('saves')).map((q) => [q.name, q.body])));
  shipDown = false;
  await waitQueue((s) => !s.some((q) => q.name === 'qi/dst'), 150000);
  await sleep(2000);
  const dst = await shipBody('qi/dst');
  check('the replay lands with the new links', /src edited/.test(dst || '')
    && /\[\[qi\/dst\]\] and \[\[qi\/dst\|me\]\]/.test(dst || '') && !/\[\[qi\/src/.test(dst || ''), dst);

  // ── 6. a paint from an old cached rev, then an edit at once ──────────────
  //  The boot snapshot holds the page's text at rev 1; the ship has the
  //  same text at rev 3. A save claiming rev 1 was refused as stale and
  //  kept aside (ui-matrix's false stales). The rev to claim comes only
  //  from a fresh answer, so the edit lands with no 409 and no copy.
  rules = [];
  const STALE = 'qi/stale';
  await shipFetch('page-save?type=md&new=1&name=' + encodeURIComponent(STALE), { method: 'POST', body: 'same text' });
  await shipFetch('page-save?type=md&name=' + encodeURIComponent(STALE), { method: 'POST', body: 'other text' });
  await shipFetch('page-save?type=md&name=' + encodeURIComponent(STALE), { method: 'POST', body: 'same text' });
  let refused = 0;
  p.on('response', (r) => { if (/page-save\?name=qi%2Fstale/.test(r.url()) && r.status() === 409) refused++; });
  await p.evaluate((n) => {
    localStorage.appPage = JSON.stringify({ name: n, body: 'same text', kind: 'md', share: 'private', rev: 1 });
  }, STALE);
  await p.goto(env.app + '?name=' + encodeURIComponent(STALE), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => document.getElementById('src').value === 'same text', { timeout: 60000 });
  await p.evaluate(() => {
    const s = document.getElementById('src');
    s.value = 'same text, edited at once'; s.dispatchEvent(new Event('input'));
  });
  let landed = false;
  for (let i = 0; i < 40 && !landed; i++) { await sleep(1000); landed = await shipBody(STALE) === 'same text, edited at once'; }
  check('an edit made on a paint from an old cached rev lands', landed, await shipBody(STALE));
  check('with no stale refusal', refused === 0, 'refused=' + refused);
  check('and no conflicts/ copy', !(await treeNames()).some((n) => n.startsWith('conflicts/mine-qi-stale')));
} catch (e) {
  check('the suite threw: ' + String(e.message).slice(0, 160), false);
} finally {
  rules = []; shipDown = false;
  try {
    await shipFetch('page-del?name=qi', { method: 'POST' });
    await shipFetch('page-del?name=conflicts', { method: 'POST' });
  } catch {}
  await b.close();
}
console.log(check.fails === 0 ? '\nall checks passed' : '\n' + check.fails + ' FAILURES');
process.exit(check.fails === 0 ? 0 : 1);
