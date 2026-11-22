#!/usr/bin/env node
//  ui-races.mjs: saves that race something else, in the real editor.
//
//  Each case forces one order of events that a ship gives only now and
//  then, and checks that no text is lost by it:
//
//    a parked save that has nothing to send leaves the window able to save
//    text typed while a stale save is settled is merged, not saved over it
//    a refresh read answered after a later save does not paint over it
//    an edit queued offline claims the rev of the copy it was made on,
//      when the page was opened offline and when it was left and reopened
//    a queued edit with no rev to claim still gets their text kept
//    text typed before the fresh read lands is on the device when hidden
//
//  No ship: lib/stub-ship.mjs stands in for the routes the editor uses and
//  serves the built app.js, and holds answers back to force the order.
//
//  Usage:  node scripts/ui-races.mjs [case ...]
//  Setup:  npm ci --prefix scripts
import { launchBrowser, makeCheck, sleep, waitFor } from './lib/harness.mjs';
import { stubShip } from './lib/stub-ship.mjs';

const check = makeCheck();
const browser = await launchBrowser();
const only = process.argv.slice(2);

//  a ship with `seed`, and the editor open on it at `q`
async function up(seed, q = '') {
  const ship = await stubShip(seed);
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.setViewport({ width: 1300, height: 850 });
  await page.goto(ship.url + q, { waitUntil: 'domcontentloaded' });
  const name = new URLSearchParams(q.slice(1)).get('name');
  //  open, and the fresh read behind the first paint answered
  if (name) await waitFor(() => ship.S.log.some((e) => e.path === 'page-source' && e.q.render && e.res), 15000, 50);
  await sleep(300);
  return { ...ship, page, done: async () => { await ctx.close(); ship.close(); } };
}
const ed = (p) => p.evaluate(() => document.querySelector('#src').value);
const status = (p) => p.evaluate(() => document.querySelector('#status').textContent);
const typeEnd = async (p, t) => {
  await p.focus('#src');
  await p.evaluate(() => { const s = document.querySelector('#src'); s.selectionStart = s.selectionEnd = s.value.length; });
  await p.keyboard.type(t);
};
const body = (x, name) => (x.S.pages.get(name) || { body: null }).body;
//  the answered saves since log index `from`
const answered = (x, from = 0) => x.S.log.slice(from).filter((e) => /^page-save/.test(e.path) && e.res);
const cases = {};

//  Split view. n/a is held by the "changed elsewhere" bar with unsaved
//  text, and is parked when the other group takes the front. Its parked
//  save has nothing to send. The page typed into next must still save.
cases.parked = async () => {
  const x = await up({ 'n/a': 'alpha\n', 'n/b': 'beta\n' }, '?name=n/a');
  const p = x.page;
  x.S.put('n/a', 'alpha\nTHEIRS');
  await typeEnd(p, 'MINE');
  await waitFor(() => p.evaluate(() => !document.querySelector('#casbar').hidden), 10000, 100);
  check('the page changed elsewhere holds its bar', await p.evaluate(() => !document.querySelector('#casbar').hidden), await status(p));
  await typeEnd(p, ' more');
  await p.evaluate(() => window.latSplits.split('right'));
  await sleep(800);
  await p.evaluate(() => {
    const g = window.latTabs.groups();
    const i = g.findIndex((q) => !q.tabs.some((t) => t.key === 'n/a'));
    if (i >= 0 && !g[i].focus) window.latTabs.focus(i);
  });
  await sleep(500);
  await p.evaluate(() => window.latTabs.openIn('page', 'n/b', {}));
  await waitFor(async () => (await ed(p)) === 'beta\n', 8000, 100);
  await sleep(800);
  await typeEnd(p, 'TYPED-IN-B');
  await waitFor(() => (body(x, 'n/b') || '').includes('TYPED-IN-B'), 8000, 100);
  check.eq('text typed in the other pane is autosaved', body(x, 'n/b'), 'beta\nTYPED-IN-B');
  await typeEnd(p, ' again');
  await p.keyboard.down('Control'); await p.keyboard.press('s'); await p.keyboard.up('Control');
  await waitFor(() => (body(x, 'n/b') || '').includes('again'), 6000, 100);
  check.eq('and Ctrl+S saves', body(x, 'n/b'), 'beta\nTYPED-IN-B again');
  check.eq('the held page was not written over', body(x, 'n/a'), 'alpha\nTHEIRS');
  await x.done();
};

//  Another writer changes line 1. This window appends, autosaves, is
//  refused as stale, and the settle reads theirs, merges and saves. The
//  stub answers slowly, as a pier does, and more is typed meanwhile.
const LINES = 'line1\nline2\nline3\nline4\nline5\n';
const staleThenType = async (typeMore) => {
  const x = await up({ 'n/a': LINES }, '?name=n/a');
  const p = x.page;
  x.S.put('n/a', LINES.replace('line1', 'line1 THEIRS'));
  x.S.delay = 500;
  await typeEnd(p, 'MINE1');
  await waitFor(() => x.S.saves().some((e) => e.res && e.res.code === 409), 15000, 25);
  await typeMore(p);
  //  quiet: every save answered and none for two seconds
  let n = -1;
  await waitFor(async () => {
    const k = x.S.log.length;
    if (k === n && x.S.saves().every((e) => e.res)) return true;
    n = k; await sleep(2500); return false;
  }, 30000, 10);
  return x;
};
cases.settleTyping = async () => {
  const x = await staleThenType((p) => p.keyboard.type(' MINE2'));
  const head = body(x, 'n/a'), shown = await ed(x.page);
  check('their edit is still on the page', head.includes('line1 THEIRS'), JSON.stringify(head));
  check('and so is everything typed here', head.endsWith('MINE1 MINE2'), JSON.stringify(head));
  check.eq('the editor shows what the ship holds', shown, head);
  check('no conflict was made of it', ![...x.S.pages.keys()].some((k) => k.startsWith('conflicts/')), [...x.S.pages.keys()].join(' '));
  check('the caret stayed at the end of the typed text', await x.page.evaluate(() => {
    const s = document.querySelector('#src'); return s.selectionStart === s.value.length;
  }));
  await x.done();
};
//  The same, but what is typed meanwhile touches the stretch they changed,
//  so it cannot be merged: it is kept aside and held, never saved over.
cases.settleOverlap = async () => {
  const x = await staleThenType(async (p) => {
    await p.evaluate(() => { document.querySelector('#src').setSelectionRange(5, 5); });
    await p.keyboard.type('Z');
  });
  const head = body(x, 'n/a'), p = x.page;
  check('their edit is still on the page', head.includes('line1 THEIRS'), JSON.stringify(head));
  check('the text typed here is still in the editor', (await ed(p)).startsWith('line1Z'), JSON.stringify(await ed(p)));
  check('the bar says it is not saved', await p.evaluate(() => !document.querySelector('#casbar').hidden), await status(p));
  const kept = [...x.S.pages.keys()].filter((k) => k.startsWith('conflicts/mine-'));
  check('and a copy of it is kept', kept.length === 1 && x.S.pages.get(kept[0]).body.startsWith('line1Z'), kept.join(' '));
  await x.done();
};

//  A background refresh reads the open page. Before its answer lands the
//  user types and saves, and that save's answer lands first. The late
//  answer holds the text from before the edit.
cases.lateRead = async () => {
  const x = await up({ 'n/a': 'alpha\n' }, '?name=n/a');
  const p = x.page;
  let held = null, go;
  const gate = new Promise((r) => { go = r; });
  x.S.hook = async (ev, S) => {
    //  the tree read fails, so the focus refresh reads the open page
    if (ev.path === 'page-dump') return { code: 500, body: {} };
    if (ev.path !== 'page-source' || ev.q.render || held) return null;
    const was = S.pages.get('n/a');
    held = { body: was.body, kind: was.kind, rev: was.rev, share: 'private', comments: false };
    await gate;
    return { code: 200, body: held };
  };
  await p.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => held, 35000, 50);
  check('a refresh read of the page is on the wire', !!held);
  await typeEnd(p, 'TYPED-1 ');
  await p.keyboard.down('Control'); await p.keyboard.press('s'); await p.keyboard.up('Control');
  await waitFor(() => body(x, 'n/a').includes('TYPED-1'), 8000, 50);
  await sleep(300);
  go();
  await sleep(1000);
  check.eq('the late answer does not replace the saved text', await ed(p), 'alpha\nTYPED-1 ');
  await typeEnd(p, 'TYPED-2');
  await waitFor(() => body(x, 'n/a').includes('TYPED-2'), 8000, 50);
  check.eq('and the next save keeps it', body(x, 'n/a'), 'alpha\nTYPED-1 TYPED-2');
  await x.done();
};

//  the offline queue's page records, as the editor stored them
const queue = (p) => p.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('lattice-offline');
  r.onsuccess = () => {
    const g = r.result.transaction('saves').objectStore('saves').getAll();
    g.onsuccess = () => { r.result.close(); res(g.result); };
  };
}));
const queued = async (p, name) => (await queue(p)).find((q) => q.name === name) || null;
const clickRow = (p, name) => p.evaluate((n) => {
  [...document.querySelectorAll('#treelist a.pg')]
    .find((a) => a.getAttribute('href').endsWith('name=' + encodeURIComponent(n))).click();
}, name);
//  the ship is back and the window is looked at again: the queue drains
const comeBack = async (x) => {
  x.S.down = false;
  await x.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitFor(async () => !(await queue(x.page)).length, 30000, 200);
  await sleep(500);
};
const kept = (x) => [...x.S.pages].filter(([k]) => k.startsWith('conflicts/')).map(([, v]) => v.body).join('|');

//  The ship is away. A page is opened from the tree's copy and typed into,
//  and another device edits it before the ship is back. The queued edit
//  must claim the rev of the copy it was made on, so the ship keeps theirs.
cases.offlineOpen = async () => {
  const x = await up({ 'n/a': 'alpha\n', 'n/b': 'beta\n' }, '?name=n/a');
  const p = x.page;
  x.S.down = true;
  await clickRow(p, 'n/b');
  await waitFor(async () => (await ed(p)) === 'beta\n', 5000, 50);
  await typeEnd(p, 'MINE');
  const t0 = Date.now();
  const q = await waitFor(() => queued(p, 'n/b'), 22000, 200);
  check('the edit is queued', !!q && q.body === 'beta\nMINE', JSON.stringify(q));
  check('without sitting out the wait for a read that already failed', Date.now() - t0 < 9000, (Date.now() - t0) + ' ms');
  check.eq('on the rev of the copy that was painted', q && q.baseRev, 1);
  x.S.put('n/b', 'THEIRS\nbeta\n');
  await comeBack(x);
  check.eq('the offline edit landed', body(x, 'n/b'), 'beta\nMINE');
  check('and their edit is kept beside it', kept(x).includes('THEIRS'), [...x.S.pages.keys()].join(' '));
  check('which the status says', /conflict/.test(await status(p)), await status(p));
  await x.done();
};
//  A page open at rev 1 is edited offline, left, come back to and edited
//  again. The second edit replaces the first in the queue and must keep
//  the rev the first one forked from.
cases.offlineReopen = async () => {
  const x = await up({ 'n/a': 'alpha\n', 'n/b': 'beta\n' }, '?name=n/a');
  const p = x.page;
  x.S.down = true;
  await typeEnd(p, 'MINE-1 ');
  const q1 = await waitFor(() => queued(p, 'n/a'), 10000, 200);
  check.eq('the first offline edit claims the rev it was read at', q1 && q1.baseRev, 1);
  await clickRow(p, 'n/b');
  await waitFor(async () => (await ed(p)) === 'beta\n', 5000, 50);
  await clickRow(p, 'n/a');
  await waitFor(async () => (await ed(p)) === 'alpha\nMINE-1 ', 5000, 50);
  await typeEnd(p, 'MINE-2');
  const q2 = await waitFor(async () => { const q = await queued(p, 'n/a'); return q && q.body.includes('MINE-2') && q; }, 22000, 200);
  check.eq('the second keeps that rev', q2 && q2.baseRev, 1);
  x.S.put('n/a', 'THEIRS\nalpha\n');
  await comeBack(x);
  check.eq('the offline edit landed', body(x, 'n/a'), 'alpha\nMINE-1 MINE-2');
  check('and their edit is kept beside it', kept(x).includes('THEIRS'), [...x.S.pages.keys()].join(' '));
  //  the control: nobody else wrote, so nothing is flagged
  x.S.down = true;
  await typeEnd(p, ' MINE-3');
  await waitFor(async () => { const q = await queued(p, 'n/a'); return q && q.body.includes('MINE-3'); }, 10000, 200);
  const n = [...x.S.pages.keys()].length;
  await comeBack(x);
  check.eq('an edit nobody raced lands', body(x, 'n/a'), 'alpha\nMINE-1 MINE-2 MINE-3');
  check.eq('with no conflict page', [...x.S.pages.keys()].length, n);
  await x.done();
};
//  A queued edit of a copy whose rev was never known has no rev to claim.
//  The ship writes an edit with no claim over whatever it holds, so the
//  replay must get their text kept another way. A record that claims
//  nothing on purpose (queued behind a folder job) still just lands.
cases.offlineBlind = async () => {
  const x = await up({ 'n/a': 'alpha\n', 'n/b': 'beta\n' }, '?name=n/a');
  const p = x.page;
  await p.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('lattice-offline');
    r.onsuccess = () => {
      const s = r.result.transaction('saves', 'readwrite').objectStore('saves');
      const rec = (name, more) => ({ name, kind: 'md', body: 'MINE ' + name, baseRev: null, bv: 1,
        queuedAt: Date.now(), id: 'gone-' + name, win: 'gone', seq: 1, ...more });
      s.put(rec('n/a', { blind: 1 }));
      s.put(rec('n/b', {})).onsuccess = () => { r.result.close(); res(); };
    };
  }));
  x.S.put('n/a', 'THEIRS-A\n');
  x.S.put('n/b', 'THEIRS-B\n');
  await p.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => !(await queue(p)).length, 30000, 200);
  await sleep(500);
  check.eq('the edit with no rev landed', body(x, 'n/a'), 'MINE n/a');
  check('and the text it replaced is kept', kept(x).includes('THEIRS-A'), [...x.S.pages.keys()].join(' '));
  check.eq('an edit that claims nothing on purpose landed', body(x, 'n/b'), 'MINE n/b');
  check('and kept nothing', !kept(x).includes('THEIRS-B'), kept(x));
  await x.done();
};
//  A page is painted from the tree's copy and typed into while its fresh
//  read is still out, then the app is hidden (a phone's app switch). The
//  tab may never run again, so the text must be on the device by then.
cases.hidden = async () => {
  const x = await up({ 'n/a': 'alpha\n', 'n/b': 'beta\n' }, '?name=n/a');
  const p = x.page;
  let go;
  const gate = new Promise((r) => { go = r; });
  x.S.hook = async (ev) => { if (ev.path === 'page-source' && ev.q.name === 'n/b') await gate; return null; };
  await clickRow(p, 'n/b');
  await waitFor(async () => (await ed(p)) === 'beta\n', 5000, 50);
  await typeEnd(p, 'QUICK NOTE');
  const hide = (on) => p.evaluate((on) => {
    Object.defineProperty(document, 'hidden', { get: () => on, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    if (on) window.dispatchEvent(new Event('pagehide'));
  }, on);
  await hide(true);
  const q = await waitFor(() => queued(p, 'n/b'), 3000, 100);
  check('hidden with the read still out: the text is in the queue', !!q && q.body === 'beta\nQUICK NOTE', JSON.stringify(q));
  check.eq('on the rev of the copy that was painted', q && q.baseRev, 1);
  check('and nothing was sent ahead of the read', !x.S.saves().length, x.S.saves().map((e) => e.path).join(' '));
  //  the app comes back: the editor still owns the text and saves it itself
  await hide(false);
  await typeEnd(p, ' and more');
  go();
  await waitFor(() => body(x, 'n/b').includes('and more'), 10000, 100);
  await waitFor(async () => !(await queue(p)).length, 5000, 100);
  check.eq('back in front, the editor saves it', body(x, 'n/b'), 'beta\nQUICK NOTE and more');
  check('the queued copy is gone', !(await queue(p)).length, JSON.stringify(await queue(p)));
  check('and nothing was made a conflict', !kept(x), [...x.S.pages.keys()].join(' '));
  check('or written twice', x.S.saves().length === 1, x.S.saves().map((e) => e.path + ' ' + JSON.stringify(e.body)).join(' '));
  await x.done();
};

for (const [name, run] of Object.entries(cases)) {
  if (only.length && !only.includes(name)) continue;
  console.log('\n' + name);
  try { await run(); } catch (e) { check.bad(name + ' ran to its end', String(e && e.stack || e)); }
}
await browser.close();
check.done();
