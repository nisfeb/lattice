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
//    a delete queued offline goes with what the user agreed to, and a move
//      rewrites a queued edit as the ship does
//    text typed before the fresh read lands is on the device when hidden
//    a queued or live save claims the rev of the text it was made on, however
//      the page was reached (reload, reopen, a drain on the wire, an old
//      record, a stash replayed by another window)
//    vim mode never splits a two-unit character (not a race: see the case)
//    a map whose field in use cannot be written: what is written still
//      goes out, and the page stays unsaved
//    a rich tab closed with text in a field puts it on its own page
//
//  No ship: lib/stub-ship.mjs stands in for the routes the editor uses and
//  serves the built app.js, and holds answers back to force the order.
//
//  Usage:  node scripts/ui-races.mjs [case ...]
//  Setup:  npm ci --prefix scripts
import { readFileSync } from 'fs';
import { launchBrowser, makeCheck, sleep, waitFor } from './lib/harness.mjs';
import { stubShip } from './lib/stub-ship.mjs';

const check = makeCheck();
const browser = await launchBrowser();
const only = process.argv.slice(2);

//  a ship with `seed`, and the editor open on it at `q`
async function up(seed, q = '', again = null) {
  const ship = again ? again.ship : await stubShip(seed);
  const ctx = again ? again.ctx : await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.setViewport({ width: 1300, height: 850 });
  await page.goto(ship.url + q, { waitUntil: 'domcontentloaded' });
  const name = new URLSearchParams(q.slice(1)).get('name');
  //  open, and the fresh read behind the first paint answered
  if (name) await waitFor(() => ship.S.log.some((e) => e.path === 'page-source' && e.q.render && e.res), 15000, 50);
  await sleep(300);
  return { ...ship, ship, ctx, page, done: async () => { await ctx.close(); ship.close(); } };
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

//  A map's detail field writes when it is left. The shell asks the map
//  to write the field in use before every save (sync), and the map says
//  no when it cannot: here a time that is no date. A save sent after
//  that no would put the page on the ship without the edit and say
//  "saved". Ctrl+S and a tab switch send nothing then. The autosave and
//  a hidden page still put what is written already on the ship or in the
//  queue, and the page stays unsaved. Each says so, and the edit stays in
//  its field.
cases.syncRefused = async () => {
  const MAP = '{"type":"FeatureCollection","lattice":{},"features":[\n'
    + '{"type":"Feature","geometry":{"type":"Point","coordinates":[-71,42]},"properties":{"name":"a"}}\n]}\n';
  const x = await up({ 'm/map': [MAP, 'geojson'], 'n/b': 'beta\n' }, '?name=m/map');
  const p = x.page;
  const M = 'lat-map:not([hidden]) ', F = (k) => M + '.lm-detail [data-k="' + k + '"]';
  await waitFor(() => p.$(M + '.lm-list [role=listitem]'), 20000, 100);
  await p.click(M + '.lm-list [role=listitem]');
  await waitFor(() => p.$(F('name')), 5000, 100);
  const ctrlS = async () => { await p.keyboard.down('Control'); await p.keyboard.press('s'); await p.keyboard.up('Control'); };
  const sent = () => x.S.saves().length;
  const field = (k) => p.$eval(F(k), (e) => e.value);
  const dlg = () => p.evaluate(() => { const d = document.getElementById('dlg'); return d && !d.hidden ? document.getElementById('dlgmsg').textContent : ''; });
  //  the neighbour: a field in use that can be written goes out with the save
  await p.focus(F('name'));
  await p.keyboard.type(' one');
  await ctrlS();
  await waitFor(() => (body(x, 'm/map') || '').includes('"a one"'), 8000, 100);
  check('Ctrl+S saves the field in use when the map can write it', (body(x, 'm/map') || '').includes('"a one"'), body(x, 'm/map'));
  //  Ctrl+S with a field the map cannot write
  await waitFor(() => p.$(F('time')), 5000, 100);
  await p.focus(F('time'));
  await p.keyboard.type('not a date');
  let n = sent();
  await ctrlS();
  await sleep(1500);
  check.eq('Ctrl+S sends nothing when the map could not write the field', sent() - n, 0);
  check('and says it is not saved', /not saved/.test(await status(p)), await status(p));
  check.eq('the field keeps what was typed', await field('time'), 'not a date');
  //  the autosave: a written edit is already in the buffer, and a field
  //  that cannot be written is in use when it fires. What is written goes
  //  out without the field, and the page stays unsaved with the reason
  await p.$eval(F('time'), (e) => { e.value = ''; });
  await p.focus(F('name'));
  await p.keyboard.type(' two');
  await p.keyboard.press('Tab');
  await waitFor(() => p.$(F('time')), 5000, 100);
  await p.focus(F('time'));
  await p.keyboard.type('not a date');
  n = sent();
  await waitFor(() => (body(x, 'm/map') || '').includes('"a one two"'), 8000, 100);
  check('the autosave sends what is written already', (body(x, 'm/map') || '').includes('"a one two"'), body(x, 'm/map'));
  check('without the field that could not be written', !(body(x, 'm/map') || '').includes('not a date'), body(x, 'm/map'));
  await sleep(500);
  check('and says it is not saved', /not saved/.test(await status(p)), await status(p));
  check.eq('the field keeps what was typed', await field('time'), 'not a date');
  //  the page is hidden with the ship away: the written text is queued
  x.S.down = true;
  await p.focus(F('name'));
  await p.keyboard.type(' three');
  await p.keyboard.press('Tab');
  await waitFor(() => p.$(F('time')), 5000, 100);
  await p.focus(F('time'));
  await p.evaluate(() => {
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
  });
  const q = await waitFor(async () => { const r = await queued(p, 'm/map'); return r && r.body.includes('"a one two three"') ? r : null; }, 8000, 100);
  check('hiding the page queues the written text', !!q, JSON.stringify(await queued(p, 'm/map')));
  check('without the field that could not be written', !!q && !q.body.includes('not a date'), q && q.body.slice(-90));
  await p.evaluate(() => {
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await comeBack(x);
  n = sent();
  //  another page is opened over it: the question comes first, and
  //  staying keeps the map in front with the field as typed. In place it
  //  is the question for any unsaved text. For a new tab the buffer would
  //  be parked as it is, without the edit, so that road asks too.
  const onTop = () => p.$eval('#dlgcancel', (e) => {
    const r = e.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === e;
  });
  for (const [road, o, q] of [['in place', {}, /discard/], ['in a new tab', { newTab: true }, /could not be written/]]) {
    await p.focus(F('time'));
    p.evaluate((o) => window.latTabs.openIn('page', 'n/b', o), o).catch(() => {});
    await waitFor(async () => !!(await dlg()), 8000, 100);
    check('another page opened ' + road + ' asks before the edit is dropped', q.test(await dlg()), await dlg());
    check('the question is over the map, not under it', await onTop());
    check.eq('and nothing was sent', sent() - n, 0);
    await p.click('#dlgcancel');
    await sleep(800);
    check('staying keeps the map in front', !!(await p.$(F('time'))) && (await ed(p)).includes('"a one two three"'), await status(p));
    check.eq('with the field as typed', await p.$(F('time')) && await field('time'), 'not a date');
    check.eq('one tab, as before', await p.evaluate(() => window.latTabs.groups().reduce((k, g) => k + g.tabs.length, 0)), 1);
  }
  check.eq('and still nothing sent', sent() - n, 0);
  //  put right, it saves whole
  await p.$eval(F('time'), (e) => { e.value = ''; });
  await p.focus(F('time'));
  await p.keyboard.type('2026-01-02T03:04:05Z');
  await ctrlS();
  await waitFor(() => (body(x, 'm/map') || '').includes('2026-01-02T03:04:05Z'), 8000, 100);
  const b = body(x, 'm/map') || '';
  check('once the field can be written the save carries every edit', b.includes('"a one two three"') && b.includes('2026-01-02T03:04:05Z'), b);
  await x.done();
};

//  The ship takes the requests of a settle and does not answer them. The
//  settle holds the writer's turn, so without a bound nothing typed after
//  it is saved, queued or stashed, Ctrl+S and hiding included. It ends in
//  time, and the text goes to the queue as it does for a gone ship.
cases.settleHang = async () => {
  const x = await up({ 'n/a': LINES }, '?name=n/a');
  const p = x.page;
  x.S.put('n/a', LINES.replace('line1', 'line1 THEIRS'));
  let hung = false;
  const never = new Promise(() => {});
  x.S.hook = async (ev) => { if (hung && !/dump|tree-job/.test(ev.path)) await never; return null; };
  await typeEnd(p, 'MINE1');
  await waitFor(() => x.S.saves().some((e) => e.res && e.res.code === 409), 15000, 5);
  hung = true;
  await sleep(300);
  await p.keyboard.type(' MINE2');
  const q = await waitFor(async () => (await queue(p)).find((r) => r.name === 'n/a' && r.body.includes('MINE2')), 90000, 500);
  check('the text typed after the refusal is in the queue', !!q, JSON.stringify(await queue(p)));
  check('on the rev the refused save claimed', !!q && q.baseRev === 1, q && q.baseRev);
  check('and the editor still holds it', (await ed(p)).endsWith('MINE1 MINE2'), await ed(p));
  await x.done();
};

//  Typing goes on while a stale settle's merged save is out, on a rich
//  page. The editor is rebuilt over the merged text, and the keystrokes
//  the view had not written yet must be written first, then kept.
cases.settleRich = async () => {
  const FODT = readFileSync(new URL('../tests/writer/corpus/01-paragraphs.fodt', import.meta.url), 'utf8');
  let x = await up({ 'w/doc': [FODT, 'fodt'], 'n/b': 'beta\n' }, '?name=w/doc');
  let p = x.page;
  const PM = 'lat-writer:not([hidden]) .ProseMirror';
  await waitFor(() => p.$(PM), 20000, 100);
  await sleep(500);
  const toEnd = async (txt) => {
    const h = await p.evaluateHandle((PM, txt) => [...document.querySelector(PM).querySelectorAll('p')].find((e) => e.textContent.includes(txt)), PM, txt);
    await h.click(); await p.keyboard.press('End');
  };
  await toEnd('The first paragraph'); await p.keyboard.type(' MINE1');
  await waitFor(() => (body(x, 'w/doc') || '').includes('MINE1'), 15000, 100);
  x.S.put('w/doc', body(x, 'w/doc').replace('The last paragraph.', 'The last paragraph THEIRS.'));
  const theirsRev = String(x.S.pages.get('w/doc').rev);
  let release;
  const gate = new Promise((r) => { release = r; });
  x.S.hook = async (ev) => { if (ev.path === 'page-save' && ev.q.name === 'w/doc' && ev.q.base === theirsRev) await gate; return null; };
  x.S.delay = 200;
  await toEnd('The first paragraph'); await p.keyboard.type(' MINE2');
  await waitFor(() => x.S.saves().some((e) => e.res && e.res.code === 409), 15000, 50);
  await waitFor(() => x.S.saves().some((e) => e.q.base === theirsRev), 15000, 20);
  await p.keyboard.type(' MINE3');
  await sleep(900);
  await p.keyboard.type(' MINE4');
  release();
  await sleep(1500);
  const pm = await p.$eval(PM, (e) => e.textContent);
  check('the writer still shows the text typed during the settle', pm.includes('MINE4') && pm.includes('MINE3'), pm.slice(0, 120));
  check('with their change merged in', pm.includes('THEIRS'), pm.slice(-80));
  await waitFor(() => (body(x, 'w/doc') || '').includes('MINE4'), 15000, 200);
  const b = body(x, 'w/doc') || '';
  check('and all of it reaches the page without another keystroke', ['MINE1', 'MINE2', 'MINE3', 'MINE4', 'THEIRS'].every((m) => b.includes(m)), b.slice(-200));
  await x.done();
  //  a sheet: a cell committed and another being typed while the save is out
  const FODS = readFileSync(new URL('../tests/sheet/corpus/01-values.fods', import.meta.url), 'utf8');
  x = await up({ 's/s': [FODS, 'fods'], 'n/b': 'beta\n' }, '?name=s/s');
  p = x.page;
  const C = (r, c) => `lat-sheet:not([hidden]) .ls-c[data-r="${r}"][data-c="${c}"]`;
  await waitFor(() => p.$(C(1, 2)), 20000, 100);
  await sleep(500);
  await p.click(C(1, 2)); await p.keyboard.type('MINE1'); await p.keyboard.press('Enter');
  await waitFor(() => (body(x, 's/s') || '').includes('MINE1'), 15000, 100);
  x.S.put('s/s', body(x, 's/s').replace('<text:p>false</text:p>', '<text:p>falseTHEIRS</text:p>'), 'fods');
  const sRev = String(x.S.pages.get('s/s').rev);
  let rel2;
  const gate2 = new Promise((r) => { rel2 = r; });
  x.S.hook = async (ev) => { if (ev.path === 'page-save' && ev.q.name === 's/s' && ev.q.base === sRev) await gate2; return null; };
  x.S.delay = 200;
  await p.click(C(2, 2)); await p.keyboard.type('MINE2'); await p.keyboard.press('Enter');
  await waitFor(() => x.S.saves().some((e) => e.res && e.res.code === 409), 15000, 50);
  await waitFor(() => x.S.saves().some((e) => e.q.base === sRev), 15000, 20);
  await p.click(C(3, 2)); await p.keyboard.type('AAA'); await p.keyboard.press('Enter'); await sleep(800);
  await p.click(C(4, 2)); await p.keyboard.type('777');
  rel2();
  await sleep(2000);
  await p.keyboard.press('Enter');
  await waitFor(() => (body(x, 's/s') || '').includes('777'), 15000, 200);
  const sb = body(x, 's/s') || '';
  check('a sheet keeps the cell committed and the cell being typed', ['MINE2', 'AAA', '777', 'THEIRS'].every((m) => sb.includes(m)), sb.length);
  await x.done();
};

//  A settle that finds a real conflict keeps a copy of the text. What was
//  typed while it ran is in that copy, and "Show theirs" asks before it
//  drops text no copy holds.
cases.settleCopy = async () => {
  const x = await up({ 'n/a': LINES, 'n/b': 'beta\n' }, '?name=n/a');
  const p = x.page;
  x.S.put('n/a', LINES + 'THEIRS');
  x.S.delay = 1500;
  await typeEnd(p, 'MINE1');
  await waitFor(() => x.S.saves().some((e) => e.res && e.res.code === 409), 15000, 10);
  await typeEnd(p, ' MINE2');
  await waitFor(async () => await p.evaluate(() => !document.querySelector('#casbar').hidden), 20000, 100);
  const copies = () => [...x.S.pages].filter(([k]) => k.startsWith('conflicts/')).map(([, v]) => v.body);
  check('the copy holds the text typed while the settle ran', copies().some((b) => b.endsWith('MINE1 MINE2')), JSON.stringify(copies()));
  //  typed after the copy: Show theirs must ask
  x.S.delay = 20;
  await typeEnd(p, ' MINE3');
  await p.click('#castheirs');
  await waitFor(async () => !!(await appDlg(p)), 5000, 100);
  check('Show theirs asks when the editor holds text no copy has', /no copy/.test(await appDlg(p)), await appDlg(p));
  await p.click('#dlgcancel');
  await sleep(500);
  check('and a cancel keeps it', (await ed(p)).endsWith('MINE1 MINE2 MINE3'), await ed(p));
  check('with the bar up', await p.evaluate(() => !document.querySelector('#casbar').hidden));
  await x.done();
  //  the page moves again while the settle runs: it settles once more
  const y = await up({ 'n/a': LINES, 'n/b': 'beta\n' }, '?name=n/a');
  const q = y.page;
  y.S.put('n/a', LINES.replace('line1', 'line1 THEIRS'));
  y.S.delay = 600;
  await typeEnd(q, 'MINE1');
  await waitFor(() => y.S.saves().some((e) => e.res && e.res.code === 409), 15000, 10);
  await q.keyboard.type(' MINE2');
  await sleep(900);
  y.S.put('n/a', body(y, 'n/a').replace('line2', 'line2 THEIRS-B'));
  await q.keyboard.type(' MINE3');
  await sleep(2500);
  y.S.put('n/a', body(y, 'n/a').replace('line3', 'line3 THEIRS-C'));
  await q.keyboard.type(' MINE4');
  let n = -1;
  await waitFor(async () => {
    const k = y.S.log.length;
    if (k === n && y.S.saves().every((e) => e.res)) return true;
    n = k; await sleep(2500); return false;
  }, 40000, 10);
  const head = body(y, 'n/a');
  check('three changes elsewhere, each apart from ours: all merged', ['THEIRS', 'THEIRS-B', 'THEIRS-C', 'MINE1 MINE2 MINE3 MINE4'].every((m) => head.includes(m)), JSON.stringify(head));
  check('no bar and no copy was made', !(await p2bar(q)) && ![...y.S.pages.keys()].some((k) => k.startsWith('conflicts/')), [...y.S.pages.keys()].join(' '));
  await y.done();
};
const p2bar = (p) => p.evaluate(() => !document.querySelector('#casbar').hidden);

//  The queue's claims, by the ways a page reaches an offline edit.
//  A page saved three times, left, and the tab reloaded with the ship
//  away: the tree's copy must carry the rev of its own text.
cases.treeRev = async () => {
  const x = await up({ 'n/a': 'alpha\n', 'n/b': 'beta\n' }, '?name=n/a');
  const p = x.page;
  for (const t of ['one ', 'two ', 'three ']) {
    await typeEnd(p, t);
    await waitFor(() => (body(x, 'n/a') || '').endsWith(t), 8000, 100);
  }
  await clickRow(p, 'n/b');
  await waitFor(async () => (await ed(p)) === 'beta\n', 5000, 50);
  await sleep(1500);
  x.S.down = true;
  await p.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await clickRow(p, 'n/a');
  await waitFor(async () => (await ed(p)).startsWith('alpha'), 5000, 50);
  await typeEnd(p, 'OFFLINE');
  const q = await waitFor(() => queued(p, 'n/a'), 25000, 200);
  check.eq('the queued edit claims the rev of the text it was made on', q && q.baseRev, x.S.pages.get('n/a').rev);
  await comeBack(x);
  check.eq('and lands', body(x, 'n/a'), 'alpha\none two three OFFLINE');
  check('with no conflict made of our own last save', !kept(x), kept(x));
  await x.done();
};
//  A page edited offline, reopened, and typed into when the ship is back
//  before the queue drains: the save claims what the queued edit claims,
//  so their text from meanwhile is kept. Likewise a page opened offline
//  from the tree that changed elsewhere.
cases.reopenLive = async () => {
  let x = await up({ 'n/a': 'alpha\n', 'n/b': 'beta\n' }, '?name=n/a');
  let p = x.page;
  x.S.down = true;
  await typeEnd(p, 'MINE1 ');
  await waitFor(() => queued(p, 'n/a'), 10000, 100);
  x.S.put('n/a', 'THEIRS\nalpha\n');
  await clickRow(p, 'n/b'); await waitFor(async () => (await ed(p)) === 'beta\n', 5000, 50);
  await clickRow(p, 'n/a'); await waitFor(async () => (await ed(p)).startsWith('alpha'), 5000, 50);
  await sleep(1500);
  x.S.down = false;
  await typeEnd(p, 'MINE2');
  await waitFor(() => (body(x, 'n/a') || '').includes('MINE2'), 30000, 100);
  await sleep(2000);
  check('a live save after a reopen keeps their text', kept(x).includes('THEIRS'), kept(x) + ' | head ' + JSON.stringify(body(x, 'n/a')));
  await x.done();
  x = await up({ 'n/a': 'alpha\n', 'n/b': 'beta\n' }, '?name=n/a');
  p = x.page;
  x.S.down = true;
  await clickRow(p, 'n/b'); await waitFor(async () => (await ed(p)) === 'beta\n', 5000, 50);
  x.S.put('n/b', 'THEIRS\nbeta\n');
  await sleep(1000);
  x.S.down = false;
  await typeEnd(p, 'MINE');
  await waitFor(() => (body(x, 'n/b') || '').includes('MINE'), 30000, 100);
  await sleep(1500);
  check('a page opened while the ship was away: their edit is kept', kept(x).includes('THEIRS'), kept(x) + ' | head ' + JSON.stringify(body(x, 'n/b')));
  await x.done();
};
//  An edit queued while a drain of the queue is on the wire, for a page
//  with no record of its own, claims the rev its editor read.
cases.replayClaim = async () => {
  const x = await up({ 'n/a': 'alpha\n', 'n/b': 'beta\n' }, '?name=n/a');
  const p = x.page;
  let go;
  const gate = new Promise((r) => { go = r; });
  let mode = 'down';
  x.S.hook = async (ev) => {
    if (mode === 'up') return null;
    if (ev.path === 'page-save-batch' && mode === 'slow') { await gate; return { code: 502, body: { error: 'bridge' } }; }
    if (/page-save|page-source/.test(ev.path)) return { code: 502, body: { error: 'bridge' } };
    return null;
  };
  await clickRow(p, 'n/b'); await waitFor(async () => (await ed(p)) === 'beta\n', 5000, 50);
  await typeEnd(p, 'B1'); await waitFor(() => queued(p, 'n/b'), 25000, 100);
  await clickRow(p, 'n/a'); await waitFor(async () => (await ed(p)) === 'alpha\n', 5000, 50);
  mode = 'slow';
  await p.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => x.S.log.some((e) => e.path === 'page-save-batch' && !e.res), 40000, 100);
  await typeEnd(p, 'MINE');
  const q = await waitFor(() => queued(p, 'n/a'), 25000, 100);
  check.eq('the edit queued behind a drain claims its editor\'s rev', q && q.baseRev, 1);
  x.S.put('n/a', 'THEIRS\nalpha\n');
  go(); mode = 'up';
  await sleep(500);
  await comeBack(x);
  check('their edit meanwhile is kept', kept(x).includes('THEIRS'), kept(x));
  await x.done();
};
//  Another window replays this window's stash. This window's later save,
//  made on the rev from before, is its own text on top of it: no conflict.
cases.stashReplayed = async () => {
  const x = await up({ 'n/a': 'alpha\n', 'n/b': 'beta\n' }, '?name=n/a');
  const p = x.page;
  let go, held = null;
  const gate = new Promise((r) => { go = r; });
  x.S.hook = async (ev, S) => {
    if (ev.path === 'page-source' && ev.q.name === 'n/b' && !held) {
      const was = S.pages.get('n/b');
      held = { body: was.body, kind: was.kind, rev: was.rev, share: 'private', comments: false };
      await gate; return { code: 200, body: held };
    }
    return null;
  };
  await clickRow(p, 'n/b'); await waitFor(async () => (await ed(p)) === 'beta\n', 5000, 50);
  await typeEnd(p, 'NOTE');
  const hide = (on) => p.evaluate((on) => {
    Object.defineProperty(document, 'hidden', { get: () => on, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    if (on) window.dispatchEvent(new Event('pagehide'));
  }, on);
  await hide(true);
  await waitFor(() => queued(p, 'n/b'), 3000, 100);
  const B = await up(null, '?name=n/a', x);
  await B.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitFor(async () => !(await queue(B.page)).length, 30000, 200);
  check.eq('the other window replayed the stash', body(x, 'n/b'), 'beta\nNOTE');
  await p.bringToFront(); await hide(false);
  await typeEnd(p, ' more'); go();
  await waitFor(() => (body(x, 'n/b') || '').includes('more'), 20000, 100);
  await sleep(1500);
  check.eq('the later text lands on top', body(x, 'n/b'), 'beta\nNOTE more');
  check('with no copy and no bar', !kept(x) && await p.evaluate(() => document.querySelector('#casbar').hidden), kept(x));
  await B.page.close();
  await x.done();
};
//  A record the previous build queued, with no claim: edited again
//  offline after the upgrade, it stays a record with no claim.
cases.oldRecord = async () => {
  const x = await up({ 'n/a': 'alpha\n', 'n/b': 'beta\n' }, '?name=n/b');
  const p = x.page;
  await p.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('lattice-offline');
    r.onsuccess = () => {
      const s = r.result.transaction('saves', 'readwrite').objectStore('saves');
      s.put({ name: 'n/a', kind: 'md', body: 'alpha\nOLD\n', baseRev: null, bv: 1, isNew: false, queuedAt: Date.now() - 5000,
        id: 'zzold-1', win: 'zzold', seq: 1, drawn: false, dname: '', dnames: '' }).onsuccess = () => { r.result.close(); res(); };
    };
  }));
  x.S.down = true;
  await p.goto(x.url + '?name=n/a', { waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await ed(p)).includes('OLD'), 15000, 100);
  await sleep(500);
  await typeEnd(p, 'MINE\n');
  const q = await waitFor(async () => (await queue(p)).find((r) => r.body.includes('MINE')), 15000, 200);
  check('the edit on top of it is not marked blind', !!q && !q.blind, JSON.stringify(q && { base: q.baseRev, blind: q.blind }));
  await comeBack(x);
  check.eq('it lands', body(x, 'n/a'), 'alpha\nOLD\nMINE\n');
  check('with no copy made of the page nobody else wrote', !kept(x), kept(x));
  await x.done();
};

//  A page with a page under it, deleted offline after the user agreed to
//  lose both, goes with the pages under it on the replay too, and the
//  edits queued for them are dropped with it.
const opsOf = (p) => p.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('lattice-offline');
  r.onsuccess = () => {
    const g = r.result.transaction('ops').objectStore('ops').getAll();
    g.onsuccess = () => { r.result.close(); res(g.result); };
  };
}));
cases.offlineDelete = async () => {
  const x = await up({ 'p/a': 'parent\n', 'p/a/c': 'child\n', 'p/b': 'sibling\n' }, '?name=p/a/c');
  const p = x.page;
  x.S.down = true;
  await typeEnd(p, 'CHILD EDIT');
  await waitFor(() => queued(p, 'p/a/c'), 25000, 100);
  await clickRow(p, 'p/a');
  await waitFor(async () => (await ed(p)) === 'parent\n', 5000, 50);
  await p.evaluate(() => document.getElementById('del').click());
  await waitFor(() => p.evaluate(() => !document.getElementById('dlg').hidden), 5000, 50);
  await p.click('#dlgok');
  const op = await waitFor(async () => (await opsOf(p)).find((o) => o.op === 'del'), 15000, 100);
  check('the delete is queued', !!op, JSON.stringify(await opsOf(p)));
  check('as a delete of the pages under it too', !!op && op.tree === true, JSON.stringify(op));
  check('the edit queued for a page under it is dropped', !(await queued(p, 'p/a/c')), JSON.stringify(await queued(p, 'p/a/c')));
  await comeBack(x);
  const del = x.S.log.find((e) => e.path === 'page-del' && e.q.name === 'p/a');
  check('the replay sends tree=1', !!del && del.q.tree === '1', JSON.stringify(del && del.q));
  await x.done();
};
//  A queued edit rides a queued move. The ship moves a page of prose as it
//  is and follows only its wikilinks; path text in it is the writer's.
cases.offlineMove = async () => {
  const x = await up({ 'old/x': 'x\n', 'n/a': 'a\n' }, '?name=old/x');
  const p = x.page;
  x.S.down = true;
  await typeEnd(p, 'see /old/x and [[old/x]] and [[old/x|label]]\n');
  await waitFor(() => queued(p, 'old/x'), 25000, 100);
  await p.evaluate(() => document.getElementById('mv').click());
  await waitFor(() => p.evaluate(() => !document.getElementById('dlg').hidden), 5000, 50);
  await p.$eval('#dlginput', (e) => { e.value = 'new/x'; });
  await p.click('#dlgok');
  const q = await waitFor(() => queued(p, 'new/x'), 15000, 100);
  check('the edit follows the move', !!q, JSON.stringify(await queue(p)));
  check('a path in prose stays as written', !!q && q.body.includes('see /old/x and'), q && q.body);
  check('a wikilink follows', !!q && q.body.includes('[[new/x]] and [[new/x|label]]'), q && q.body);
  await x.done();
};

//  A rich view holds what is being typed (a map's detail field, a cell)
//  outside the buffer until it is left. Closing its tab is leaving it, and
//  the tab shown next owns the buffer by then: the typed text must reach
//  its own page, and no page may be written with another page's view.
const MAP1 = '{"type":"FeatureCollection","lattice":{},"features":[\n'
  + '{"type":"Feature","geometry":{"type":"Point","coordinates":[-71,42]},"properties":{"name":"a"}}\n]}\n';
const MAPQ = 'lat-map:not([hidden]) ';
const mapF = (k) => MAPQ + '.lm-detail [data-k="' + k + '"]';
const pickFeature = async (p) => {
  await waitFor(() => p.$(MAPQ + '.lm-list [role=listitem]'), 20000, 100);
  await p.click(MAPQ + '.lm-list [role=listitem]');
  await waitFor(() => p.$(mapF('name')), 5000, 100);
};
const ctrlKey = async (p, k) => { await p.keyboard.down('Control'); await p.keyboard.press(k); await p.keyboard.up('Control'); };
const appDlg = (p) => p.evaluate(() => { const d = document.getElementById('dlg'); return d && !d.hidden ? document.getElementById('dlgmsg').textContent : ''; });
const pagesOf = (x) => [...x.S.pages.keys()];
cases.closeMap = async () => {
  for (const how of ['ctrl+w', 'middle click']) {
    const x = await up({ 'm/map': [MAP1, 'geojson'], 'n/b': 'beta\nmy notes\n' }, '?name=n/b');
    const p = x.page;
    await p.evaluate(() => window.latTabs.openIn('page', 'm/map', { newTab: true }));
    await pickFeature(p);
    await p.focus(mapF('name'));
    await p.keyboard.type(' TYPED');
    await sleep(300);
    if (how === 'ctrl+w') await ctrlKey(p, 'w');
    else {
      const tab = await p.evaluateHandle(() => [...document.querySelectorAll('.dtx')].pop().parentElement);
      const bb = await tab.boundingBox();
      await p.mouse.click(bb.x + 10, bb.y + bb.height / 2, { button: 'middle' });
    }
    await waitFor(async () => (await p.evaluate(() => window.latTabs.list().length)) === 1, 5000, 100);
    await sleep(3500);
    check.eq(how + ': the page in the next tab is not written over', body(x, 'n/b'), 'beta\nmy notes\n');
    check(how + ': the map keeps what was typed in the field', (body(x, 'm/map') || '').includes('"a TYPED"'), (body(x, 'm/map') || '').slice(-80));
    check(how + ': and what is shown is the next page', (await ed(p)) === 'beta\nmy notes\n', await ed(p));
    await x.done();
  }
  //  the map is the only tab: a blank page takes its place, and the map's
  //  text must not be filed there as a capture
  const x = await up({ 'm/map': [MAP1, 'geojson'] }, '?name=m/map');
  const p = x.page;
  await pickFeature(p);
  await p.focus(mapF('name'));
  await p.keyboard.type(' LAST');
  await sleep(300);
  await ctrlKey(p, 'w');
  await sleep(4500);
  check('the last tab closed: no page was made of the map', !pagesOf(x).some((k) => k.startsWith('inbox/')), pagesOf(x).join(' '));
  check('and the map has the typed text', (body(x, 'm/map') || '').includes('"a LAST"'), (body(x, 'm/map') || '').slice(-60));
  check.eq('the blank page is empty', await ed(p), '');
  await x.done();
};
//  A cell being typed is in no buffer either, and closing the tab asked
//  nothing and lost it. And a map field the map cannot write asks.
cases.closeUnwritten = async () => {
  const FODS = readFileSync(new URL('../tests/sheet/corpus/01-values.fods', import.meta.url), 'utf8');
  let x = await up({ 's/s': [FODS, 'fods'], 'n/b': 'beta\n' }, '?name=n/b');
  let p = x.page;
  await p.evaluate(() => window.latTabs.openIn('page', 's/s', { newTab: true }));
  const C = 'lat-sheet:not([hidden]) .ls-c[data-r="6"][data-c="1"]';
  await waitFor(() => p.$(C), 20000, 100);
  await p.click(C); await sleep(200);
  await p.keyboard.type('4242.5');
  await sleep(300);
  await ctrlKey(p, 'w');
  await sleep(3500);
  check('a cell being typed is saved when its tab is closed', (body(x, 's/s') || '').includes('4242.5'), 'saves ' + x.S.saves().length);
  check.eq('and the next page is as it was', body(x, 'n/b'), 'beta\n');
  await x.done();
  x = await up({ 'm/map': [MAP1, 'geojson'], 'n/b': 'beta\n' }, '?name=n/b');
  p = x.page;
  await p.evaluate(() => window.latTabs.openIn('page', 'm/map', { newTab: true }));
  await pickFeature(p);
  await waitFor(() => p.$(mapF('time')), 5000, 100);
  await p.focus(mapF('time'));
  await p.keyboard.type('not a date');
  await sleep(300);
  p.evaluate(() => { const l = window.latTabs.list(); return window.latTabs.closeTab(l.find((t) => t.key === 'm/map').id); }).catch(() => {});
  await waitFor(async () => !!(await appDlg(p)), 5000, 100);
  check('a field the map cannot write asks before its tab closes', /could not be written/.test(await appDlg(p)), await appDlg(p));
  await p.click('#dlgcancel');
  await sleep(500);
  check.eq('and a cancel keeps the tab', await p.evaluate(() => window.latTabs.list().length), 2);
  check.eq('with the field as typed', await p.$eval(mapF('time'), (e) => e.value), 'not a date');
  await x.done();
};

//  Hiding or closing the page decides on dirty too: a cell or a map field
//  typed and not yet written must be synced first, or nothing is saved and
//  the close asks nothing.
cases.hideUnwritten = async () => {
  const FODS = readFileSync(new URL('../tests/sheet/corpus/01-values.fods', import.meta.url), 'utf8');
  const hideIt = (p) => p.evaluate(() => {
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
  });
  let x = await up({ 's/s': [FODS, 'fods'], 'n/b': 'beta\n' }, '?name=s/s');
  let p = x.page;
  const C = 'lat-sheet:not([hidden]) .ls-c[data-r="6"][data-c="1"]';
  await waitFor(() => p.$(C), 20000, 100);
  await p.click(C); await sleep(200);
  await p.keyboard.type('4242.5');
  await sleep(300);
  check('a cell being typed asks before the page is closed', await p.evaluate(() => window.__latUnsaved()), 'no');
  await hideIt(p);
  await sleep(3000);
  const inQ = (await queue(p)).some((q) => q.body.includes('4242.5'));
  check('a cell being typed is saved when the page is hidden', (body(x, 's/s') || '').includes('4242.5') || inQ, 'saves ' + x.S.saves().length);
  await x.done();
  x = await up({ 'm/map': [MAP1, 'geojson'], 'n/b': 'beta\n' }, '?name=m/map');
  p = x.page;
  await pickFeature(p);
  await p.focus(mapF('name'));
  await p.keyboard.type(' HID');
  await sleep(300);
  check('a map field being typed asks before the page is closed', await p.evaluate(() => window.__latUnsaved()), 'no');
  await hideIt(p);
  await sleep(3000);
  const mq = (await queue(p)).some((q) => q.body.includes('a HID'));
  check('a map field being typed is saved when the page is hidden', (body(x, 'm/map') || '').includes('a HID') || mq, 'saves ' + x.S.saves().length);
  await x.done();
};

//  A page at a shared folder's own path: the ship lists the folder as two
//  lines (`<folder>` and `<folder>/dir-index`) and unshares it when its line
//  is gone and its index line is still there. The share pane grants and
//  revokes that page by `<path>/code` alone, and sends every line back.
cases.shareFolderPage = async () => {
  const BASE = '/apps/lattice.lattice_app';
  const x = await up({ 'a': 'the page a\n', 'a/b': 'inside\n', 'solo': 'alone\n' });
  x.S.base = BASE;
  x.S.groups = [{ name: 'crew', ships: [], peek: [BASE + '/page/a', BASE + '/page/a/dir-index'], make: [BASE + '/page/a'], poke: [], opaque: 0 }];
  const p = x.page;
  await p.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(() => p.evaluate(() => !!document.querySelector('#treelist a.pg')), 15000, 100);
  const open = (n) => p.evaluate((n) => window.latTabs.openIn('page', n, {}), n);
  const rowBtn = (t) => p.evaluate((t) => { const b = [...document.querySelectorAll('#grouplist .grow-row button')].find((e) => e.textContent === t); return b ? b.className : null; }, t);
  const click = (t) => p.evaluate((t) => [...document.querySelectorAll('#grouplist .grow-row button')].find((e) => e.textContent === t).click(), t);
  const lastSave = () => { const l = x.S.log.filter((e) => e.path === 'share-group-save'); return l.length ? JSON.parse(l[l.length - 1].body) : null; };
  await open('a');
  await waitFor(async () => (await rowBtn('read')) !== null, 15000, 100);
  check.eq('the folder line is not this page: read is off', await rowBtn('read'), '');
  check.eq('and neither is edit', await rowBtn('edit'), '');
  await click('read');
  await waitFor(() => lastSave(), 5000, 100);
  check.eq('read on the page adds its code path and keeps the folder lines', JSON.stringify(lastSave().peek), JSON.stringify([BASE + '/page/a', BASE + '/page/a/dir-index', BASE + '/page/a/code']));
  check.eq('and leaves the folder edit line alone', JSON.stringify(lastSave().make), JSON.stringify([BASE + '/page/a']));
  await waitFor(async () => (await rowBtn('read')) === 'on', 5000, 100);
  await click('read');
  await waitFor(() => x.S.log.filter((e) => e.path === 'share-group-save').length >= 2, 5000, 100);
  check.eq('read off removes the code path only: the folder stays shared', JSON.stringify(lastSave().peek) + JSON.stringify(lastSave().make), JSON.stringify([BASE + '/page/a', BASE + '/page/a/dir-index']) + JSON.stringify([BASE + '/page/a']));
  //  a page with no folder is granted by its plain path, as before
  await open('solo');
  await waitFor(async () => (await rowBtn('read')) === '', 5000, 100);
  await click('read');
  await waitFor(() => x.S.log.filter((e) => e.path === 'share-group-save').length >= 3, 5000, 100);
  check('a page with no folder is granted by its own path', lastSave().peek.includes(BASE + '/page/solo') && !lastSave().peek.some((l) => /solo\/code/.test(l)), JSON.stringify(lastSave().peek));
  //  a folder share toggle only matches its own path, never a page-only /code
  //  grant at the same path
  x.S.v2 = true;
  x.S.groups = [{ name: 'crew', ships: [], peek: [BASE + '/page/a/code'], make: [BASE + '/page/a/code'], poke: [], opaque: 0 }];
  await p.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(() => p.evaluate(() => !!document.querySelector('#treelist [data-tk="f:a"] .fln') && document.getElementById('pname') && document.getElementById('pname').value === 'solo'), 15000, 100);
  await p.evaluate(() => { window.latShell.paneOpen('r', true); window.latShell.paneTab('r', 'page'); });
  await p.click('#treelist [data-tk="f:a"] .fln');
  await waitFor(() => p.evaluate(() => !!document.querySelector('#treelist [data-tk="f:a"].cur') && /the folder/i.test((document.getElementById('sharewhat') || {}).textContent || '') && !![...document.querySelectorAll('#grouplist .grow-row button')].find((e) => e.textContent === 'read')), 15000, 100);
  check.eq('a page /code grant does not mark the folder read', await rowBtn('read'), '');
  check.eq('nor folder edit', await rowBtn('edit'), '');
  let savesBefore = x.S.log.filter((e) => e.path === 'share-group-save').length;
  await click('read');
  await waitFor(() => x.S.log.filter((e) => e.path === 'share-group-save').length > savesBefore, 5000, 100);
  check.eq('folder read on adds the folder path and keeps the page /code grant', JSON.stringify(lastSave().peek), JSON.stringify([BASE + '/page/a/code', BASE + '/page/a']));
  await waitFor(async () => (await rowBtn('read')) === 'on', 5000, 100);
  savesBefore = x.S.log.filter((e) => e.path === 'share-group-save').length;
  await click('read');
  await waitFor(() => x.S.log.filter((e) => e.path === 'share-group-save').length > savesBefore, 5000, 100);
  check.eq('folder read off removes only the folder path and keeps the page /code grant', JSON.stringify(lastSave().peek) + JSON.stringify(lastSave().make), JSON.stringify([BASE + '/page/a/code']) + JSON.stringify([BASE + '/page/a/code']));
  //  the access pane does not list the index line, and sends it back
  await p.evaluate(() => window.latTabs.openIn('acl', '', {})).catch(() => {});
  await p.evaluate(() => document.getElementById('aclopen') && document.getElementById('aclopen').click());
  await sleep(800);
  const shown = await p.evaluate(() => (document.getElementById('aclgrid') || { textContent: '' }).textContent);
  check('the access pane does not show the index line', !/dir-index/.test(shown), shown.slice(0, 200));
  await x.done();
};

//  A ship that lists its groups as version 2 takes a save's lists as the
//  whole truth: a line not sent back is removed, folder lines and their
//  index lines together, and an empty list removes every grant.
cases.shareV2 = async () => {
  const BASE = '/apps/lattice.lattice_app', P = BASE + '/page/';
  const seed = () => [{ name: 'crew', ships: [], peek: [P + 'a', P + 'a/dir-index', P + 'b', P + 'b/dir-index', P + 'solo'], make: [P + 'b'], poke: [], opaque: 0 }];
  const start = async (v2) => {
    const x = await up({ 'a': 'a\n', 'a/x': 'x\n', 'b': 'b\n', 'b/y': 'y\n', 'solo': 's\n' });
    x.S.base = BASE; x.S.v2 = v2; x.S.groups = seed();
    await x.page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(() => x.page.evaluate(() => !!document.querySelector('#treelist a.pg')), 15000, 100);
    await x.page.evaluate(() => document.getElementById('aclopen').click());
    await waitFor(() => x.page.evaluate(() => !!document.querySelector('#aclgrid .chips a')), 15000, 100);
    return x;
  };
  const saves = (x) => x.S.log.filter((e) => e.path === 'share-group-save');
  const lastBody = (x) => JSON.parse(saves(x)[saves(x).length - 1].body);
  const chip = (p, t) => p.evaluate((t) => { const a = [...document.querySelectorAll('#aclgrid .chips a')].find((e) => e.title === 'remove ' + t); if (a) a.click(); return !!a; }, t);
  //  remove one folder
  let x = await start(true);
  check('the access pane did not offer the index line', !(await x.page.evaluate(() => [...document.querySelectorAll('#aclgrid .chips a')].some((e) => /dir-index/.test(e.title)))), '');
  await chip(x.page, P + 'a');
  await waitFor(() => saves(x).length === 1, 5000, 100);
  check.eq('removing a folder sends v 2 without either of its lines', JSON.stringify(lastBody(x)), JSON.stringify({ v: 2, ships: [], peek: [P + 'b', P + 'b/dir-index', P + 'solo'], make: [P + 'b'] }));
  await waitFor(() => !x.S.groups[0].peek.includes(P + 'a'), 3000, 50);
  check.eq('and the ship holds that', JSON.stringify(x.S.groups[0].peek), JSON.stringify([P + 'b', P + 'b/dir-index', P + 'solo']));
  //  remove everything
  for (let i = 0; i < 12 && await x.page.evaluate(() => !!document.querySelector('#aclgrid .chips a')); i++) {
    const n = saves(x).length;
    await x.page.evaluate(() => document.querySelector('#aclgrid .chips a').click());
    await waitFor(() => saves(x).length > n, 5000, 100);
    await sleep(300);
  }
  check.eq('removing every line saves empty lists, and the ship holds none', JSON.stringify([lastBody(x).v, lastBody(x).peek, lastBody(x).make, x.S.groups[0].peek, x.S.groups[0].make]), JSON.stringify([2, [], [], [], []]));
  await x.done();
  //  keep everything: a page turned on and off again leaves every line
  x = await start(true);
  await x.page.evaluate(() => window.latTabs.openIn('page', 'a', {}));
  await waitFor(() => x.page.evaluate(() => !![...document.querySelectorAll('#grouplist .grow-row button')].length), 15000, 100);
  const tog = (n) => x.page.evaluate(() => [...document.querySelectorAll('#grouplist .grow-row button')].find((e) => e.textContent === 'read').click()).then(() => waitFor(() => saves(x).length >= n, 5000, 100)).then(() => sleep(400));
  await tog(1); await tog(2);
  check.eq('a page toggled on and off sends every line back with v 2', JSON.stringify(lastBody(x)), JSON.stringify({ v: 2, ships: [], peek: seed()[0].peek, make: seed()[0].make }));
  await x.done();
  //  a ship that does not say v 2 gets no v
  x = await start(false);
  await chip(x.page, P + 'a');
  await waitFor(() => saves(x).length === 1, 5000, 100);
  check('a save to a ship without version 2 carries no v', !('v' in lastBody(x)), JSON.stringify(lastBody(x)));
  await x.done();
};

//  Not a race, but it needs the real editor and real keys, and no ship:
//  vim mode on characters outside the BMP (an emoji is two UTF-16 units).
//  No command may leave half of one in the text or rest the caret inside it.
cases.vimAstral = async () => {
  const x = await up({ 'n/a': 'x\n' }, '?name=n/a');
  const p = x.page;
  await p.evaluate(() => { localStorage.setItem('edVim', '1'); localStorage.setItem('latAutosave', '0'); });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await ed(p)) === 'x\n', 8000, 100);
  await sleep(500);
  const E = '\u{1F600}';
  const show = (t) => JSON.stringify(t).replace(/[\ud800-\udfff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
  //  `keys`: one per key. A key of more than one character that is not a
  //  key name (the emoji) is sent as a keydown of its own, as an IME does.
  const run = async (text, at, keys, want, caret) => {
    await p.focus('#src');
    await p.evaluate((t) => {
      const s = document.querySelector('#src');
      s.value = t; s.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await p.keyboard.press('Escape');
    await p.evaluate((at) => { document.querySelector('#src').setSelectionRange(at, at); }, at);
    for (const k of keys) {
      if (k === E) await p.evaluate((k) => document.querySelector('#src').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })), k);
      else if (k.length > 1) await p.keyboard.press(k);
      else await p.keyboard.type(k);
    }
    const r = await p.evaluate(() => { const s = document.querySelector('#src'); return { v: s.value, a: s.selectionStart }; });
    const inside = (r.v.charCodeAt(r.a) & 0xfc00) === 0xdc00;
    const name = show(text) + ' @' + at + ' ' + keys.join(' ').replace(E, 'emoji');
    check(name, r.v === want && !inside && (caret === undefined || r.a === caret),
      'want ' + show(want) + (caret === undefined ? '' : ' caret ' + caret) + ' got ' + show(r.v) + ' caret ' + r.a);
  };
  await run('abc', 0, ['l', 'x', 'p'], 'acb', 2);
  await run('a' + E + 'b', 0, ['l', 'x', 'p'], 'ab' + E, 2);
  await run('a' + E + 'b', 0, ['l', 'x', 'P'], 'a' + E + 'b', 1);
  await run(E + 'b', 0, ['y', 'l', 'p'], E + E + 'b', 2);
  await run('a' + E + 'b', 1, ['d', 'l', 'p'], 'ab' + E, 2);
  await run('a' + E + 'b', 3, ['d', 'h', 'P'], 'a' + E + 'b', 1);
  await run(E + ' b', 0, ['v', 'y', '$', 'p'], E + ' b' + E, 4);
  await run(E + E, 0, ['v', 'l', 'y', 'P'], E + E + E + E, 2);
  await run(E + E + 'a', 2, ['v', 'h', 'd'], 'a', 0);
  await run('ab' + E, 0, ['$'], 'ab' + E, 2);
  await run('ab' + E, 0, ['$', 'r', 'z'], 'abz', 2);
  await run('ab' + E, 0, ['A', 'Escape'], 'ab' + E, 2);
  await run('abc', 0, ['r', E], E + 'bc', 0);
  await run(E + E + 'c', 0, ['2', 'r', 'z'], 'zzc', 1);
  await run(E + E, 0, ['l'], E + E, 2);
  await run(E + E, 0, ['l', 'l', 'h'], E + E, 0);
  await run('a' + E + 'b', 1, ['s', 'Z', 'Escape'], 'aZb', 1);
  await run('a' + E + 'b', 1, ['a', 'Z', 'Escape'], 'a' + E + 'Zb', 3);
  await run('a' + E + 'b', 3, ['X'], 'ab', 1);
  await run('ab ' + E + E + ' cd', 0, ['w', 'e'], 'ab ' + E + E + ' cd', 5);
  await run('ab ' + E + E + ' cd', 3, ['d', 'e'], 'ab  cd', 3);
  await run('ab ' + E + E + ' cd', 3, ['c', 'w', 'Z', 'Escape'], 'ab Z cd', 3);
  await run('x' + E + 'y', 0, ['f', E], 'x' + E + 'y', 1);
  await run('x' + E + 'y', 0, ['f', 'y', 'F', E], 'x' + E + 'y', 1);
  await run('xx' + E + 'y', 0, ['t', E], 'xx' + E + 'y', 1);
  await run('x' + E + E + 'y', 0, ['f', 'y', 'T', 'x'], 'x' + E + E + 'y', 1);
  await run('x' + E + 'y', 3, ['T', E], 'x' + E + 'y', 3);
  await run(E + E + E + '\nabcd', 10, ['k'], E + E + E + '\nabcd', 2);
  await run(E + E + E + '\nabcd', 10, ['v', 'k', 'd'], E, 0);
  //  and plain text moves as it did
  await run('abc def', 0, ['w'], 'abc def', 4);
  await run('abc def', 0, ['d', 'e'], ' def', 0);
  await run('abc', 0, ['$'], 'abc', 2);
  await run('abc', 0, ['2', 'x'], 'c', 0);
  await run('abc', 2, ['X'], 'ac', 1);
  await run('abc', 0, ['3', 'r', 'z'], 'zzz', 2);
  await run('ab', 0, ['3', 'r', 'z'], 'ab', 0);
  await run('a\nb', 0, ['l'], 'a\nb', 0);
  await run('abcabc', 0, ['2', 'f', 'c'], 'abcabc', 5);
  await run('abc', 0, ['t', 'c'], 'abc', 1);
  await run('abc', 0, ['v', 'l', 'd'], 'c', 0);
  await run('abc', 1, ['a', 'Z', 'Escape'], 'abZc', 2);
  //  e at the end of a run that ends in an emoji moves on, and d e takes the run
  await run(' ' + E + 'ba' + E + E, 1, ['e'], ' ' + E + 'ba' + E + E, 4);
  await run(E + 'b c', 0, ['d', 'e'], ' c', 0);
  await run('ab ' + E + ' cd', 0, ['e', 'e'], 'ab ' + E + ' cd', 3);
  //  l from a caret already past the last character comes back onto it
  await run('_x', 2, ['l'], '_x', 1);
  //  { from a text that starts with an empty line ends
  await run('\nab', 1, ['{'], '\nab', 0);
  await run('a\n\nab', 3, ['{'], 'a\n\nab', 2);
  await x.done();
};

//  Outside-content permission on one page never leaks globally, same-origin
//  absolute and protocol-relative image queries are blocked as routes, and
//  PDF export strips active elements, CSS urls, and unauthorized fetches.
cases.outsideAndPdf = async () => {
  const x = await up({ 'n/a': 'placeholder\n', 'n/b': '![ext](https://other.example/b.png)\n' }, '?name=n/a');
  const origin = new URL(x.url).origin;
  const host = new URL(x.url).host;
  const mdA = `![ext](https://other.example/a.png)\n![abs](${origin}/apps/lattice/clip?url=https://evil.example/1)\n![rel](//${host}/apps/lattice/clip?url=https://evil.example/2)\n`;
  const htmlDoc = '<!doctype html><html><head><style>@import url(https://evil.example/i.css); h1 { color: #246; background: url(/apps/lattice/clip?url=4); }</style></head>'
    + '<body><h1>Title</h1><p style="background:url(https://evil.example/bg);color:#123">Hello PDF</p>'
    + '<img src="/apps/lattice/clip?url=https://evil.example/csrf" alt="csrf">'
    + '<img src="/apps/lattice/f/ok.svg?data" alt="okdata">'
    + '<img src="https://evil.example/track.png" alt="track">'
    + '<link rel="stylesheet" href="https://evil.example/ext.css">'
    + '<link rel="stylesheet" href="/apps/lattice/clip?url=https://evil.example/css">'
    + '<iframe src="/apps/lattice/clip?url=3"></iframe><object data="x"></object><embed src="x"><svg><script>1</script></svg>'
    + '</body></html>';
  x.S.put('n/a', mdA, 'md');
  x.S.put('n/h', htmlDoc, 'html');
  x.S.hook = async (ev) => {
    if (ev.path === 'f/ok.svg') return { code: 200, body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>' };
    return null;
  };
  const p = x.page;
  await p.evaluate(() => { localStorage.latOutside = JSON.stringify(['n/a']); });
  await p.goto(x.url + '?name=n/a', { waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await ed(p)).includes('other.example/a.png'), 10000, 100);
  await ctrlKey(p, 'e');
  await waitFor(() => p.evaluate(() => {
    const f = document.getElementById('prev');
    return f && f.getAttribute('srcdoc') && f.getAttribute('srcdoc').includes('other.example/a.png');
  }), 10000, 100);
  const prevDoc = await p.evaluate(() => document.getElementById('prev').getAttribute('srcdoc') || '');
  check('same-origin absolute clip image becomes a link, not an img', !/<img[^>]*clip\?url/.test(prevDoc) && prevDoc.includes(`href="${origin}/apps/lattice/clip?url=https://evil.example/1"`), prevDoc.slice(-300));
  check('same-origin protocol-relative clip image becomes a link, not an img', prevDoc.includes(`href="//${host}/apps/lattice/clip?url=https://evil.example/2"`), prevDoc.slice(-300));
  check('no clip request fired from the preview', !x.S.log.some((e) => e.path === 'clip'), x.S.log.map((e) => e.path).join(' '));
  //  export n/b (outside not allowed): mdOutside from n/a must not have leaked
  await p.evaluate(() => window.latTabs.openIn('page', 'n/b', {}));
  await waitFor(async () => (await ed(p)).includes('other.example/b.png'), 10000, 100);
  await p.evaluate(() => { const f = document.querySelector('iframe[data-lat-pdf]'); if (f) f.remove(); });
  await p.click('#tmenu');
  await p.waitForSelector('.tmenu [data-mi="pdf"]', { visible: true, timeout: 5000 });
  await p.click('.tmenu [data-mi="pdf"]');
  await waitFor(() => p.evaluate(() => {
    const f = document.querySelector('iframe[data-lat-pdf]');
    return f && f.getAttribute('srcdoc') && /PDF ready to print/.test(document.getElementById('status').textContent);
  }), 15000, 100);
  const bPdf = await p.evaluate(() => document.querySelector('iframe[data-lat-pdf]').getAttribute('srcdoc') || '');
  check('mdOutside did not leak from n/a into n/b PDF export', !bPdf.includes('<img') && bPdf.includes('image from another site: ext'), bPdf.slice(-260));
  //  export hostile html page n/h (in Edit mode so the preview frame does not load it)
  await p.evaluate(() => {
    const f = document.querySelector('iframe[data-lat-pdf]');
    if (f) f.remove();
    const b = document.querySelector('[data-go="edit"]');
    if (b) b.click();
  });
  await waitFor(() => p.evaluate(() => document.getElementById('ws').classList.contains('ve')), 5000, 50);
  await p.evaluate(() => window.latTabs.openIn('page', 'n/h', {}));
  await waitFor(async () => (await ed(p)).includes('Hello PDF'), 10000, 100);
  await sleep(300);
  const pdfLogAt = x.S.log.length;
  await p.click('#tmenu');
  await p.waitForSelector('.tmenu [data-mi="pdf"]', { visible: true, timeout: 5000 });
  await p.click('.tmenu [data-mi="pdf"]');
  await waitFor(() => p.evaluate(() => {
    const f = document.querySelector('iframe[data-lat-pdf]');
    return f && f.getAttribute('srcdoc') && /PDF ready to print/.test(document.getElementById('status').textContent);
  }), 15000, 100);
  const hPdf = await p.evaluate(() => document.querySelector('iframe[data-lat-pdf]').getAttribute('srcdoc') || '');
  check('pdf export never fetched same-origin query route /clip', !x.S.log.slice(pdfLogAt).some((e) => e.path === 'clip'), x.S.log.slice(pdfLogAt).map((e) => e.path).join(' '));
  check('pdf export injects the restrictive CSP meta tag', hPdf.includes("default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:;"), hPdf.slice(0, 300));
  check('pdf export strips iframe, object, embed, svg, and link', !/<(?:iframe|object|embed|svg|link)\b/i.test(hPdf), hPdf.slice(0, 400));
  check('pdf export strips cross-origin urls, @import, and CSS url()', !/evil\.example|@import|url\(/i.test(hPdf), hPdf);
  check('pdf export still inlines bare ?data same-origin images', /<img[^>]+src="data:/i.test(hPdf), hPdf);
  check('pdf export keeps safe print styling and text', hPdf.includes('Hello PDF') && hPdf.includes('#246') && hPdf.includes('#123'), hPdf);
  const styles = await p.evaluate(() => {
    const f = document.querySelector('iframe[data-lat-pdf]');
    const d = f && f.contentDocument;
    if (!d) return null;
    return {
      h1: getComputedStyle(d.querySelector('h1')).color,
      p: getComputedStyle(d.querySelector('p')).color,
    };
  });
  check('print frame applies inline styles cleanly under the restrictive CSP',
    !!styles && styles.h1 === 'rgb(34, 68, 102)' && styles.p === 'rgb(17, 34, 51)', JSON.stringify(styles));
  await x.done();
};

//  Boot-time bodyRead (reconcileFresh) must not overwrite an IndexedDB queued
//  edit during the 4s window before queue replay runs.
cases.bootReconcileQueue = async () => {
  const x = await up({ 'n/a': 'SERVER-OLD\n' }, '?name=n/a');
  const p = x.page;
  await p.evaluate(() => new Promise((res) => {
    localStorage.appPage = JSON.stringify({ name: 'n/a', body: 'QUEUED-EDIT\n', kind: 'md', rev: 1 });
    const r = indexedDB.open('lattice-offline');
    r.onsuccess = () => {
      const s = r.result.transaction('saves', 'readwrite').objectStore('saves');
      s.put({ name: 'n/a', kind: 'md', body: 'QUEUED-EDIT\n', baseRev: 1, bv: 1, isNew: false,
        queuedAt: Date.now(), id: 'boot-q-1', win: 'other', seq: 1 }).onsuccess = () => { r.result.close(); res(); };
    };
  }));
  const logAt = x.S.log.length;
  await p.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(() => x.S.log.slice(logAt).some((e) => e.path === 'page-source' && !e.q.render && e.res), 10000, 50);
  await sleep(800);
  check.eq('boot reconcileFresh does not overwrite the queued edit', await ed(p), 'QUEUED-EDIT\n');
  await waitFor(async () => !(await queue(p)).length, 20000, 200);
  check.eq('queue replay lands the queued edit on the ship', body(x, 'n/a'), 'QUEUED-EDIT\n');
  await x.done();
};

//  Switching tabs away from a spreadsheet with an uncommitted cell edit syncs
//  and saves it through flushNoAsk in parkDoc.
cases.parkUnwritten = async () => {
  const FODS = readFileSync(new URL('../tests/sheet/corpus/01-values.fods', import.meta.url), 'utf8');
  const x = await up({ 's/s': [FODS, 'fods'], 'n/b': 'beta\n' }, '?name=s/s');
  const p = x.page;
  await p.evaluate(() => window.latTabs.openIn('page', 'n/b', { newTab: true }));
  await waitFor(async () => (await ed(p)) === 'beta\n', 8000, 100);
  await p.evaluate(() => {
    const s = window.latTabs.list().find((t) => t.key === 's/s');
    return window.latTabs.switchTab(s.id);
  });
  const C = 'lat-sheet:not([hidden]) .ls-c[data-r="6"][data-c="1"]';
  await waitFor(() => p.$(C), 20000, 100);
  await sleep(300);
  await p.click(C);
  await sleep(200);
  await p.keyboard.type('PARKED99');
  await sleep(200);
  await p.evaluate(() => {
    const b = window.latTabs.list().find((t) => t.key === 'n/b');
    return window.latTabs.switchTab(b.id);
  });
  await waitFor(() => (body(x, 's/s') || '').includes('PARKED99'), 10000, 100);
  check('switching tabs syncs and saves the uncommitted cell edit', (body(x, 's/s') || '').includes('PARKED99'), 'saves ' + x.S.saves().length);
  check.eq('the target tab stays intact', body(x, 'n/b'), 'beta\n');
  await x.done();
};

//  A stale revision read landing after the user opened another page must not
//  overwrite the newly opened page.
cases.staleRev = async () => {
  const x = await up({ 'n/a': 'REV1-BODY\n', 'n/b': 'PAGE-B\n' }, '?name=n/a');
  x.S.put('n/a', 'REV2-BODY\n');
  let go, held = false;
  const gate = new Promise((r) => { go = r; });
  x.S.hook = async (ev, S) => {
    if (ev.path === 'page-history' && ev.q.name === 'n/a') {
      return { code: 200, body: { revisions: [{ rev: 2, updated: '' }, { rev: 1, updated: '' }] } };
    }
    if (ev.path === 'page-source-at' && ev.q.name === 'n/a' && ev.q.rev === '1') {
      held = true;
      await gate;
      const at = (S.hist.get('n/a') || []).find((r) => r.rev === 1);
      return { code: 200, body: { body: at.body, kind: 'md', rev: 1 } };
    }
    return null;
  };
  const p = x.page;
  await p.evaluate(() => { window.latShell.paneOpen('r', true); window.latShell.paneTab('r', 'hist'); });
  await waitFor(() => p.evaluate(() => !!document.querySelector('#histlist a[data-rev="1"]')), 10000, 100);
  await p.click('#histlist a[data-rev="1"]');
  await waitFor(() => held, 10000, 50);
  await p.evaluate(() => window.latTabs.openIn('page', 'n/b', {}));
  await waitFor(async () => (await ed(p)) === 'PAGE-B\n', 8000, 100);
  go();
  await sleep(600);
  check.eq('stale revision response does not overwrite the new page', await ed(p), 'PAGE-B\n');
  check('editor is not left read-only or in revision mode', await p.evaluate(() => !document.getElementById('src').readOnly && document.getElementById('histview').hidden));
  await x.done();
};

//  Losing the edit lock switches rich views to read-only, and a holder with
//  unsaved edits that cannot flush refuses lock handover.
cases.lockRichAndUnsaved = async () => {
  const FODS = readFileSync(new URL('../tests/sheet/corpus/01-values.fods', import.meta.url), 'utf8');
  let x = await up({ 's/s': [FODS, 'fods'] }, '?name=s/s');
  await waitFor(() => x.page.$('lat-sheet:not([hidden]) .ls-fx input'), 20000, 100);
  const w2 = await up(null, '?name=s/s', x);
  await waitFor(() => w2.page.$('lat-sheet:not([hidden]) .ls-fx input'), 20000, 100);
  await waitFor(() => w2.page.evaluate(() => !document.getElementById('lockbar').hidden), 10000, 100);
  await sleep(200);
  const ro = await w2.page.evaluate(() => {
    const fx = document.querySelector('lat-sheet:not([hidden]) .ls-fx input');
    const bold = document.querySelector('lat-sheet:not([hidden]) .ls-bar button[data-look="bold"]');
    return !!fx && fx.readOnly && !!bold && bold.disabled;
  });
  check('losing the edit lock switches the sheet view to read-only', ro);
  await w2.page.close();
  await x.done();

  //  autosave off with unsaved edits: holder refuses handover
  x = await up({ 'n/a': 'alpha\n' }, '?name=n/a');
  await x.page.evaluate(() => { localStorage.latAutosave = '0'; });
  await typeEnd(x.page, 'UNSAVED-KEEP');
  const b2 = await up(null, '?name=n/a', x);
  await waitFor(() => b2.page.evaluate(() => !document.getElementById('lockbar').hidden), 10000, 100);
  await b2.page.click('#locktake');
  await sleep(1200);
  check('holder keeps its lock and unsaved text when flushNoAsk returns false',
    await x.page.evaluate(() => document.getElementById('lockbar').hidden && !document.getElementById('src').readOnly)
    && (await ed(x.page)).includes('UNSAVED-KEEP'));
  check('requester stays read-only when handover is refused',
    await b2.page.evaluate(() => !document.getElementById('lockbar').hidden && document.getElementById('src').readOnly));
  await b2.page.close();
  await x.done();
};

//  A background refresh must not tear down and remount Sheet mid-keystroke
//  while a cell editor is open.
cases.sheetLiveEditRefresh = async () => {
  const FODS = readFileSync(new URL('../tests/sheet/corpus/01-values.fods', import.meta.url), 'utf8');
  const x = await up({ 's/s': [FODS, 'fods'] }, '?name=s/s');
  const p = x.page;
  const C = 'lat-sheet:not([hidden]) .ls-c[data-r="6"][data-c="1"]';
  await waitFor(() => p.$(C), 20000, 100);
  await sleep(300);
  await p.click(C);
  await sleep(200);
  await p.keyboard.type('TYPING77');
  await sleep(200);
  x.S.put('s/s', body(x, 's/s').replace('<text:p>false</text:p>', '<text:p>falseREMOTE</text:p>'), 'fods');
  const before = x.S.log.length;
  await p.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sleep(1200);
  const alive = await p.evaluate(() => {
    const e = document.querySelector('lat-sheet:not([hidden]) .ls-ed');
    return !!e && !e.classList.contains('ls-idle') && e.value === 'TYPING77';
  });
  check('background refresh leaves the live sheet cell editor intact', alive, 'reqs ' + (x.S.log.length - before));
  await p.keyboard.press('Enter');
  await waitFor(() => (body(x, 's/s') || '').includes('TYPING77'), 10000, 100);
  check('pressing Enter commits and saves the cell edit', (body(x, 's/s') || '').includes('TYPING77'));
  await x.done();
};

//  Map search works before map.js loads, Read-mode outline scrolls the
//  sandboxed preview frame, and Map outline selects the right named feature.
cases.outlineAndMapSearch = async () => {
  const MAP = '{"type":"FeatureCollection","lattice":{},"features":[\n'
    + '{"type":"Feature","geometry":{"type":"Point","coordinates":[-71.1,42.1]},"properties":{}},\n'
    + '{"type":"Feature","geometry":{"type":"Point","coordinates":[-71.2,42.2]},"properties":{"name":"Alpha"}},\n'
    + '{"type":"Feature","geometry":{"type":"Point","coordinates":[-71.3,42.3]},"properties":{"name":"BeaconHill","note":"signal tower"}}\n]}\n';
  const LONG = '# Top\n\n' + Array.from({ length: 80 }, (_, i) => 'Paragraph line ' + i + ' filler text.').join('\n\n') + '\n\n# Bottom\n\nEnd text.\n';
  const x = await up({ 'n/a': 'alpha\n', 'm/map': [MAP, 'geojson'], 'n/long': LONG }, '?name=n/a');
  const p = x.page;
  //  search finds map features before map.js loads
  check('map.js is not loaded on a markdown page', await p.evaluate(() => !window.LatMap));
  await p.evaluate(() => { window.latShell.paneOpen('l', true); window.latShell.paneTab('l', 'search'); });
  await p.focus('#qinput');
  await p.keyboard.type('BeaconHill');
  await waitFor(() => p.evaluate(() => (document.getElementById('qlist').textContent || '').includes('m/map')), 8000, 100);
  check('search finds map pages before map.js loads', await p.evaluate(() => (document.getElementById('qlist').textContent || '').includes('m/map')));
  //  Read-mode outline scrolls the preview pane
  await p.evaluate(() => window.latTabs.openIn('page', 'n/long', {}));
  await waitFor(async () => (await ed(p)).includes('# Bottom'), 8000, 100);
  await ctrlKey(p, 'e');
  await waitFor(() => p.evaluate(() => document.getElementById('ws').classList.contains('vp') && (document.querySelector('#docarea .prevwrap').scrollHeight > 900)), 10000, 100);
  await p.evaluate(() => { window.latShell.paneOpen('r', true); window.latShell.paneTab('r', 'outline'); });
  await waitFor(() => p.evaluate(() => [...document.querySelectorAll('#ollist a')].some((a) => a.textContent === 'Bottom')), 8000, 100);
  await p.evaluate(() => [...document.querySelectorAll('#ollist a')].find((a) => a.textContent === 'Bottom').click());
  await waitFor(() => p.evaluate(() => document.querySelector('#docarea .prevwrap').scrollTop > 100), 5000, 50);
  check('Read-mode outline click scrolls the preview wrap', await p.evaluate(() => document.querySelector('#docarea .prevwrap').scrollTop > 100));
  //  Map outline selects the right named feature (skipping unnamed feature 0)
  await ctrlKey(p, 'e');
  await p.evaluate(() => window.latTabs.openIn('page', 'm/map', {}));
  await waitFor(() => p.$('lat-map:not([hidden]) .lm-list [role=listitem]'), 20000, 100);
  await p.evaluate(() => { window.latShell.paneOpen('r', true); window.latShell.paneTab('r', 'outline'); });
  await waitFor(() => p.evaluate(() => [...document.querySelectorAll('#ollist a')].some((a) => a.textContent === 'BeaconHill')), 8000, 100);
  await p.evaluate(() => [...document.querySelectorAll('#ollist a')].find((a) => a.textContent === 'BeaconHill').click());
  await waitFor(() => p.evaluate(() => {
    const i = document.querySelector('lat-map:not([hidden]) .lm-detail [data-k="name"]');
    return i && i.value === 'BeaconHill';
  }), 5000, 50);
  check('map outline selects the matching named feature without throwing', await p.evaluate(() => {
    const i = document.querySelector('lat-map:not([hidden]) .lm-detail [data-k="name"]');
    return !!i && i.value === 'BeaconHill';
  }));
  await x.done();
};

//  cleanTexHtml strips ping, CSS url() styles, and relative query URLs, and
//  uploadItems skips empty batches and reports accurate failure counts.
cases.texCleanAndUpload = async () => {
  const x = await up({ 't/doc': ['\\documentclass{article}\n\\begin{document}x\\end{document}\n', 'tex'] }, '?name=t/doc');
  const p = x.page;
  await p.evaluate(() => {
    window.__TAURI__ = {
      core: {
        invoke: async (cmd) => {
          if (cmd === 'pandoc_probe') return { available: true, version: 'pandoc stub' };
          if (cmd === 'convert_tex') return '<p style="text-align:center">ok</p>'
            + '<p style="background:url(/apps/lattice/clip?url=1)">badstyle</p>'
            + '<a href="https://ok.example" ping="https://evil.example/p">link</a>'
            + '<img src="/apps/lattice/clip?url=2" alt="bad">'
            + '<img src="/apps/lattice/f/pic.png?data" alt="raw">'
            + '<img src="fig.png" alt="rel">';
          return null;
        },
      },
    };
  });
  await ctrlKey(p, 'e');
  await waitFor(() => p.evaluate(() => (document.getElementById('prev').getAttribute('srcdoc') || '').includes('badstyle')), 10000, 100);
  const doc = await p.evaluate(() => document.getElementById('prev').getAttribute('srcdoc') || '');
  check('cleanTexHtml strips ping attribute', !doc.includes('ping='), doc);
  check('cleanTexHtml strips url() inline style', !doc.includes('url(/apps/lattice/clip'), doc);
  check('cleanTexHtml keeps safe inline style', doc.includes('text-align:center'), doc);
  check('cleanTexHtml blocks relative query URLs on img src', !doc.includes('/apps/lattice/clip?url=2'), doc);
  check('cleanTexHtml keeps bare ?data and plain relative img src', doc.includes('/apps/lattice/f/pic.png?data') && doc.includes('src="fig.png"'), doc);

  //  uploadItems: all files fail conversion -> zero /page-save-batch POSTs
  const feedFiles = (files) => p.evaluate((fs) => {
    const dt = new DataTransfer();
    for (const [name, content] of fs) dt.items.add(new File([content], name));
    const inp = document.getElementById('fpick');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change'));
  }, files);
  const batchBefore = x.S.log.filter((e) => e.path === 'page-save-batch').length;
  await feedFiles([['broken.ods', 'not a zip file']]);
  await waitFor(() => p.evaluate(() => /done with 1 failures/.test(document.getElementById('upmsg').textContent)), 15000, 100);
  check.eq('all-failed upload chunk sends no empty batch POST', x.S.log.filter((e) => e.path === 'page-save-batch').length - batchBefore, 0);

  //  uploadItems: 1 broken .ods + 1 valid .md, batch POST fails -> 2 failures (not 3)
  x.S.hook = async (ev) => (ev.path === 'page-save-batch' ? { code: 500, body: { error: 'boom' } } : null);
  await feedFiles([['broken2.ods', 'not a zip'], ['good.md', '# hi\n']]);
  await waitFor(() => p.evaluate(() => /done with \d+ failures/.test(document.getElementById('upmsg').textContent)), 15000, 100);
  check.eq('failed batch after a conversion error counts payload.length, not part.length',
    await p.evaluate(() => document.getElementById('upmsg').textContent), 'done with 2 failures');
  await x.done();
};

for (const [name, run] of Object.entries(cases)) {
  if (only.length && !only.includes(name)) continue;
  console.log('\n' + name);
  try { await run(); } catch (e) { check.bad(name + ' ran to its end', String(e && e.stack || e)); }
}
await browser.close();
check.done();
