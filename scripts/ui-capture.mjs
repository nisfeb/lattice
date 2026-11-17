#!/usr/bin/env node
//  ui-capture.mjs: quick capture, quick open and ghost links
//  (docs/superpowers/specs/2026-11-15-quick-capture-and-ghost-links-design.md).
//
//  A: Inbox capture. A new page asks nothing. Text typed into it is saved
//     as inbox/YYYY-MM-DD-NNNN within the autosave delay, by every road
//     that leaves it (a tab switch, another +, a close, offline and a
//     reload). An empty one is never written. A folder's + keeps its
//     dialog, where an empty name or the untouched folder is a capture.
//     Move or rename names a page not saved yet. Autosave off waits for
//     Ctrl+S. A journal day from the brief button is saved once written.
//
//  B: Quick open. Ctrl/Cmd+O, or the Files toolbar's Open, opens the
//     palette's box in open mode: pages and memories only, the recent ones
//     first with nothing typed, ranked as the palette ranks with a query,
//     and a last row that creates the typed name when no page has it.
//
//  C: Palette by recent use. With nothing typed the command palette lists
//     the actions run last first, then the rest as registered, read once
//     as it opens. With a query a tie goes to the more recent. Junk in the
//     key changes nothing.
//
//  D: Ghost links. [[YYYY-MM-DD offers that journal day first, written or
//     not. A wikilink to a page not written yet is dimmed in the preview,
//     and opening it, by the preview, an Outgoing row or the address,
//     starts that page under its name with nothing written. A name the
//     ship refuses, a 403 and a link whose host is down keep the locked
//     tab. A deleted page still opens as it does today: this kernel keeps
//     serving it, and refuses to make it again.
//
//  E: When a page is written. A page hidden at once is saved without the
//     debounce. A page deleted elsewhere is not written again until a
//     save on purpose, and a same-tab reopen of a page that vanished
//     starts nothing. A page started with its name is made by autosave
//     only when the ship answers. An offline draw skips Inbox names this
//     device knows. A display name stays with the page it was given to.
//
//  F: A named page's create that lands while the browser sees a timeout.
//     The retry finds the page holding what this editor sent, takes it as
//     its own and saves the text typed since. A page there holding other
//     text is refused as before, and never written over.
//
//  ONLY=A (or B, C, D, E, F) runs just that section after the setup.
//
//  Usage: LATTICE_URL=http://localhost:<port> LATTICE_COOKIE=<cookie file> \
//           node scripts/ui-capture.mjs
//  Env:   LATTICE_URL, LATTICE_COOKIE, CHROME (as ui-offline.mjs). A
//         throwaway ship only: it writes pages, and at the end deletes the
//         Inbox pages it saw made and its own folder.
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const RUN = 'xcap-' + process.pid;
const SEEDP = RUN + '/seed', SHEET = RUN + '/sheet';
const on = (id) => !process.env.ONLY || process.env.ONLY.split(',').includes(id);
const INBOX = /^inbox\/\d{4}-\d{2}-\d{2}-\d{4}$/;

const check = makeCheck();
const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false),
});
//  a native dialog is never part of the editor; count any, and never stay
let natives = 0;
const nativeSeen = [];
page.on('dialog', (d) => { natives++; nativeSeen.push(step + ': ' + d.type()); d.accept().catch(() => {}); });
//  every time the editor's own dialog is shown, from the first paint on
await page.evaluateOnNewDocument(() => {
  window.__dlgShows = 0;
  new MutationObserver((ms) => {
    for (const m of ms) if (m.target.id === 'dlg' && !m.target.hidden) window.__dlgShows++;
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
});

//  The date in an Inbox name is the device's: a zone whose date differs
//  from UTC's at this hour, so a name dated by UTC is caught
const utcHour = new Date().getUTCHours();
await page.emulateTimezone(utcHour >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago');
const utcToday = new Date().toISOString().slice(0, 10);

//  the outage, as ui-offline.mjs makes it: the save and probe routes abort
let shipDown = false;
let holdSave = 0;          // ms each page-save is held before it goes
const fake = new Map();    // D: a page-source name -> 'abort' or {status, body}
let fakeLink = null;       // D: a tree row for another ship's page, put in every dump
let holdDump = null;       // A, D: page-dump requests held while this is an array
const hideRows = new Set(); // E: paths left out of every dump
const landCut = new Set();  // F: names whose next create lands, and the browser sees it fail
//  every page-save the editor sent: its page, type, whether it was a
//  create, its display name and when it went
const saves = [];
const reqs = [];           // every url the page asked for
//  the pages this run saw made: a create the ship took, or one the suite
//  made itself. The cleanup deletes the Inbox pages among them, no others.
const made = new Set();
page.on('response', (r) => {
  const u = r.url();
  if (!/\/page-save\?/.test(u) || r.status() !== 200) return;
  const q = new URL(u).searchParams;
  if (q.get('new') === '1') made.add(q.get('name'));
});
await page.setRequestInterception(true);
page.on('request', (r) => {
  const u = r.url();
  reqs.push(u);
  if (/\/page-save\?/.test(u)) {
    const q = new URL(u).searchParams;
    saves.push({ name: q.get('name'), type: q.get('type'), isNew: q.get('new') === '1',
      dn: q.get('dname') || '', at: Date.now() });
  }
  const fk = /\/page-source\?/.test(u) && fake.get(new URL(u).searchParams.get('name'));
  if (fk) {
    (fk === 'abort' ? r.abort('internetdisconnected') : r.respond({ status: fk.status,
      contentType: 'application/json', body: JSON.stringify(fk.body) })).catch(() => {});
    return;
  }
  if (/\/page-dump/.test(u) && holdDump) { holdDump.push(r); return; }
  if (/\/page-dump/.test(u) && (fakeLink || hideRows.size)) {
    const row = fakeLink;
    fetch(u, { headers: { Cookie: env.cookie } }).then((x) => x.json()).then((d) => {
      d.nodes = (d.nodes || []).filter((n) => !hideRows.has(n.path) && (!row || n.path !== row.path));
      if (row) d.nodes.push(row);
      return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
    }).catch(() => r.continue().catch(() => {}));
    return;
  }
  //  F: a create that reaches the ship and is cut on the way back
  const sq = /\/page-save\?/.test(u) && new URL(u).searchParams;
  if (sq && sq.get('new') === '1' && landCut.delete(sq.get('name'))) {
    fetch(u, { method: 'POST', headers: { Cookie: env.cookie }, body: r.postData() })
      .then((x) => { if (x.ok) made.add(sq.get('name')); })
      .finally(() => r.abort('timedout').catch(() => {}));
    return;
  }
  const down = shipDown && /page-save|legacy-status|page-cmd|know-save/.test(u);
  if (!down && holdSave && /\/page-save\?/.test(u)) {
    setTimeout(() => r.continue().catch(() => {}), holdSave);
    return;
  }
  (down ? r.abort() : r.continue()).catch(() => {});
});

const api = (p, init = {}) => fetch(env.base + '/apps/lattice/' + p,
  { ...init, headers: { Cookie: env.cookie, ...(init.headers || {}) } });
//  a page made by the suite itself, through the ship's API
const apiMake = async (n, body, type = 'md') => {
  const r = await api('page-save?type=' + type + '&new=1&name=' + encodeURIComponent(n), { method: 'POST', body });
  if (r.ok) made.add(n);
  return r;
};
const shipPage = async (n) => {
  const r = await api('page-source?name=' + encodeURIComponent(n));
  return r.ok ? r.json() : null;
};
const shipBody = async (n) => ((await shipPage(n)) || {}).body;
//  the pages the ship lists. page-source still answers for a page moved
//  or deleted, so the tree is what says one exists
const treePages = async (pre) => {
  const r = await api('page-tree');
  const j = r.ok ? await r.json() : {};
  return (j.nodes || []).filter((n) => n.page && n.path.startsWith(pre)).map((n) => n.path);
};
const inboxOnShip = () => treePages('inbox/');
const qCount = () => page.evaluate(() => new Promise((res) => {
  const rq = indexedDB.open('lattice-offline');
  rq.onsuccess = () => {
    try {
      const c = rq.result.transaction('saves', 'readonly').objectStore('saves').count();
      c.onsuccess = () => res(c.result); c.onerror = () => res(-1);
    } catch { res(0); }
  };
  rq.onerror = () => res(-1);
}));

const boot = async () => {
  await leaving();
  await page.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0
      && !!window.latTabs, { timeout: 90000 });
  await sleep(1000);
};
//  what the front of the editor says about itself
const front = () => page.evaluate(() => {
  const s = window.latTabs.state();
  const t = s.tabs[s.active] || {};
  const pn = document.getElementById('pname');
  return { key: t.key, id: t.id, name: pn.value, readOnly: pn.readOnly,
    kind: document.getElementById('pkind').value, url: location.search,
    focus: document.activeElement && document.activeElement.id, ntabs: s.tabs.length,
    src: document.getElementById('src').value };
});
const dlgOpen = () => page.evaluate(() => !document.getElementById('dlg').hidden);
const shows = () => page.evaluate(() => window.__dlgShows);
//  The editor's dialogs over the whole run: the counter starts again on
//  every load, so it is added up before each one. dlgMeant counts the
//  dialogs the suite opens on purpose (a folder's +, Move or rename), and
//  the end check says nothing else opened one.
let dlgBase = 0, dlgMeant = 0;
const dlgSum = async () => dlgBase + ((await shows().catch(() => 0)) || 0);
const leaving = async () => { dlgBase = await dlgSum(); };
//  a dialog left over from a step that failed must not hold up the next
const unstick = async () => {
  if (await dlgOpen()) await page.evaluate(() => document.getElementById('dlgcancel').click());
};
//  typing as a user does it, through the focused field
const typeIn = async (text) => {
  await page.evaluate(() => document.getElementById('src').focus());
  await page.keyboard.type(text);
};
const setText = (text) => page.evaluate((t) => {
  const s = document.getElementById('src');
  s.value = t; s.dispatchEvent(new Event('input'));
}, text);
const plus = () => page.evaluate(() => {
  const g = document.querySelector('.tgroup.gfocus [data-sb="new"]')
    || document.querySelector('[data-sb="new"]');
  g.click();
});
//  the front page's name once its first save landed: in the field, locked.
//  A create behind another can take a busy ship over 10 s (A9), so this
//  waits as long as the other creates do. How soon a save is SENT is
//  checked on its own (A2).
const landed = (ms = 40000) => waitFor(async () => {
  const f = await front();
  return f.readOnly && f.key && f.key === f.name ? f.key : null;
}, ms, 200);
const today = () => page.evaluate(() => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
});
const inTree = (n) => page.evaluate((x) => [...document.querySelectorAll('#treelist a.pg')]
  .some((a) => a.href.includes('name=' + encodeURIComponent(x))), n);
const tabKeys = () => page.evaluate(() => window.latTabs.state().tabs.map((t) => t.key));
//  a page with this text is on the ship under an Inbox name not seen before
const capturedAs = async (text, before) => waitFor(async () => {
  for (const n of await inboxOnShip()) {
    if (before.includes(n)) continue;
    if ((await shipBody(n)) === text) return n;
  }
  return null;
}, 12000, 500);

//  the + on the run's own folder in the tree, which opens the dialog
const addf = () => page.evaluate((r) => {
  const a = [...document.querySelectorAll('#treelist a.addf')].find((x) => x.title === 'new file in ' + r);
  if (a) a.click();
  return !!a;
}, RUN);

let step = 'setup';
const journalMade = [], memMade = [];
try {
  await page.goto(env.app + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(async () => {
    localStorage.clear();
    indexedDB.deleteDatabase('lattice-offline');
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  });
  await api('page-save?type=md&new=1&name=' + encodeURIComponent(SEEDP), { method: 'POST', body: '# seed' });
  await api('page-save?type=fods&new=1&name=' + encodeURIComponent(SHEET), { method: 'POST',
    body: '<?xml version="1.0" encoding="UTF-8"?>\n<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"'
      + ' office:mimetype="application/vnd.oasis.opendocument.spreadsheet"><office:body><office:spreadsheet/></office:body></office:document>' });
  await boot();

  if (on('A')) {
    // ── A1. the strip's + asks nothing, is markdown, and has the cursor ──
    step = 'A1 plus';
    await page.evaluate((n) => { window.latTabs.openIn('page', n); }, SHEET);
    const sheetKind = await waitFor(async () => (await front()).kind === 'fods', 20000);
    check('A: the spreadsheet is in front before the +', !!sheetKind, JSON.stringify(await front()));
    let s0 = await shows();
    let n0 = saves.length;
    await plus();
    await sleep(800);
    let f = await front();
    check('A: the strip\'s + shows no dialog', !(await dlgOpen()) && (await shows()) === s0);
    check('A: the + gives a new, unnamed tab', f.key === '' && f.name === '' && !f.readOnly, JSON.stringify(f));
    check('A: the cursor is in the body', f.focus === 'src', f.focus);
    check('A: the new page is markdown after a spreadsheet', f.kind === 'md', f.kind);
    check('A: the status line asks for nothing',
      /just write/.test(await page.evaluate(() => document.getElementById('status').textContent)));
    const ph = await page.evaluate(() => document.getElementById('src').placeholder);
    check('A: the empty editor does not ask for a name either', !/name/.test(ph), ph);

    // ── A2. text typed is saved in the Inbox within the autosave delay ──
    step = 'A2 typed';
    const T1 = 'capture one ' + RUN;
    await typeIn(T1);
    const t0 = Date.now();
    const name1 = await landed();
    check('A: typed text is saved under inbox/<date>-NNNN', !!name1 && INBOX.test(name1), String(name1));
    //  when the save went, not when the ship answered: a busy ship's round
    //  trip is not the editor's to keep short
    const sent1 = saves.slice(n0).find((x) => x.name === name1 && x.isNew);
    check('A: sent within the autosave delay (2 s after the last key)', !!sent1 && sent1.at - t0 < 4000,
      sent1 ? ((sent1.at - t0) / 1000).toFixed(1) + ' s' : 'not sent');
    const local = await today();
    check('A: the name carries the device\'s local date, not UTC\'s', !!name1 && name1.slice(6, 16) === local
      && local !== utcToday, JSON.stringify({ name1, local, utcToday }));
    check('A: the ship holds the text', !!name1 && (await shipBody(name1)) === T1);
    check('A: the save was a create, as markdown', saves.slice(n0).some((x) => x.name === name1 && x.isNew && x.type === 'md'),
      JSON.stringify(saves.slice(n0)));
    f = await front();
    check('A: the tab is named for it', f.key === name1, JSON.stringify(f));
    check('A: the address names it', f.url.includes(encodeURIComponent(name1)), f.url);
    check('A: the tree shows it', !!name1 && await waitFor(() => inTree(name1), 5000));
    check('A: no dialog on the way', (await shows()) === s0);

    // ── A3. a second capture gets a different name ──
    step = 'A3 second';
    await plus();
    await sleep(500);
    const T2 = 'capture two ' + RUN;
    await typeIn(T2);
    const name2 = await landed();
    check('A: a second capture lands under its own name', !!name2 && INBOX.test(name2) && name2 !== name1,
      JSON.stringify([name1, name2]));
    check('A: and holds its own text', !!name2 && (await shipBody(name2)) === T2);

    // ── A4. a drawn name that is taken draws again ──
    //  Math.random answers the queue __rq first. NN(k) is the draw that
    //  gives the four digits nn + k.
    step = 'A4 clash';
    const nn = 1000 + (process.pid % 8000);
    const NN = (k) => (nn + k + 0.5) / 10000;
    const dig = (k) => String(nn + k).padStart(4, '0');
    await page.evaluate((x) => {
      const orig = Math.random;
      window.__rq = [x];
      Math.random = () => (window.__rq.length ? window.__rq.shift() : orig());
    }, NN(0));
    await plus();
    await sleep(500);
    const T3 = 'clash first ' + RUN;
    await setText(T3);
    const name3 = await landed();
    check('A: a stubbed draw names the page', !!name3 && name3.endsWith('-' + dig(0)), String(name3));
    //  a name this device knows (the page just made) is drawn again before
    //  anything is sent
    step = 'A4 known';
    await page.evaluate((x, y) => { window.__rq = [x, y]; }, NN(0), NN(1));
    await plus();
    await sleep(500);
    const T4 = 'clash second ' + RUN;
    n0 = saves.length;
    await setText(T4);
    const name4 = await landed();
    check('A: a draw equal to a page this device knows is drawn again, before any request',
      !!name4 && name4.endsWith('-' + dig(1)) && !saves.slice(n0).some((x) => x.name === name3),
      JSON.stringify({ name3, name4, saves: saves.slice(n0) }));
    check('A: both pages hold their own text',
      !!name3 && !!name4 && (await shipBody(name3)) === T3 && (await shipBody(name4)) === T4);

    //  names the ship has and this device does not know yet (the tree's
    //  reads are held): the ship's 409 draws again
    step = 'A4 ship clash';
    holdDump = [];
    const pre = name3 ? name3.slice(0, -4) : 'inbox/x-';
    const THEIRS4 = 'made elsewhere ' + RUN;
    for (let k = 2; k <= 7; k++) await apiMake(pre + dig(k), THEIRS4);
    await page.evaluate((x, y) => { window.__rq = [x, y]; }, NN(2), NN(8));
    await plus();
    await sleep(500);
    const T4c = 'clash on the ship ' + RUN;
    n0 = saves.length;
    await setText(T4c);
    const name4c = await landed();
    check('A: a draw the ship already has is drawn again on its 409, and lands',
      !!name4c && name4c.endsWith('-' + dig(8)) && saves.slice(n0).some((x) => x.name === pre + dig(2) && x.isNew)
      && (await shipBody(name4c)) === T4c, JSON.stringify({ name4c, saves: saves.slice(n0) }));
    check('A: and the page that had the name keeps its text', (await shipBody(pre + dig(2))) === THEIRS4);

    //  five clashes in a row: the save fails, and the next one still draws
    //  (the name in the field is a drawn one, not typed)
    step = 'A4 five clashes';
    await page.evaluate((xs) => { window.__rq = xs; }, [3, 4, 5, 6, 7].map(NN));
    await plus();
    await sleep(500);
    n0 = saves.length;
    const T4b = 'five clashes ' + RUN;
    await setText(T4b);
    const five = await waitFor(() => page.evaluate(() => window.__rq.length === 0
      && /already exists/.test(document.getElementById('status').textContent)), 40000, 300);
    const tried = saves.slice(n0).map((x) => x.name);
    check('A: five taken draws in a row fail the save, as any save fails',
      !!five && JSON.stringify(tried) === JSON.stringify([3, 4, 5, 6, 7].map((k) => pre + dig(k))), JSON.stringify(tried));
    await setText(T4b + '!');
    const name4b = await landed();
    check('A: the next save draws again and lands', !!name4b && INBOX.test(name4b) && name4b !== pre + dig(7)
      && (await shipBody(name4b)) === T4b + '!', String(name4b));
    const heldA = holdDump;
    holdDump = null;
    for (const r of heldA) r.continue().catch(() => {});

    // ── A5. an empty page writes nothing ──
    step = 'A5 empty';
    await plus();
    n0 = saves.length;
    await sleep(3000);
    await setText('x');
    await setText('');
    await sleep(3500);
    check('A: an empty unnamed page sends no page-save', saves.length === n0, JSON.stringify(saves.slice(n0)));
    const ids0 = (await front()).id;
    s0 = await shows();
    const nat0 = natives;
    await page.evaluate((id) => { window.latTabs.closeTab(id); }, ids0);
    await sleep(1500);
    check('A: closing it asks nothing and writes nothing',
      saves.length === n0 && (await shows()) === s0 && natives === nat0);
    check('A: and its tab is gone', !(await page.evaluate((id) => window.latTabs.state().tabs.some((t) => t.id === id), ids0)));

    // ── A6. typed, then left at once: the page is still captured ──
    step = 'A6 switch';
    let before = await inboxOnShip();
    const keep = (await front()).id;
    await plus();
    await sleep(500);
    const T5 = 'left by a switch ' + RUN;
    await setText(T5);
    await page.evaluate((id) => { window.latTabs.switchTab(id); }, keep);
    const c5 = await capturedAs(T5, before);
    check('A: text typed then a tab switch at once is captured', !!c5, String(c5));
    check('A: the tab left behind is named for it', !!c5 && (await tabKeys()).includes(c5), JSON.stringify(await tabKeys()));

    step = 'A6 plus again';
    before = await inboxOnShip();
    await plus();
    await sleep(500);
    const T6 = 'left by another plus ' + RUN;
    await setText(T6);
    await plus();
    const c6 = await capturedAs(T6, before);
    check('A: text typed then + again at once is captured', !!c6, String(c6));

    step = 'A6 group switch';
    before = await inboxOnShip();
    await page.evaluate(() => { window.latSplits.split('r'); });
    await waitFor(() => page.evaluate(() => window.latTabs.groups().length >= 2), 5000);
    await page.evaluate(() => {
      const gs = document.querySelectorAll('.tgroup');
      gs[gs.length - 1].querySelector('[data-sb="new"]').click();
    });
    await sleep(800);
    const gtab = (await front()).id;
    const T6b = 'left by a group switch ' + RUN;
    await setText(T6b);
    await page.evaluate(() => { window.latTabs.focus(0); });
    const c6b = await capturedAs(T6b, before);
    check('A: text typed in a split then the other group focused at once is captured', !!c6b, String(c6b));
    check('A: and the tab in the group left is named for it', !!c6b && await page.evaluate((id, k) =>
      window.latTabs.groups().some((g) => g.tabs.some((t) => t.id === id && t.key === k)), gtab, c6b),
      JSON.stringify(await page.evaluate(() => window.latTabs.groups())));
    await page.evaluate(() => { localStorage.removeItem('appTabs'); });
    await boot();

    step = 'A6 close';
    await plus();
    await sleep(500);
    before = await inboxOnShip();
    s0 = await shows();
    const nat1 = natives;
    const T7 = 'left by a close ' + RUN;
    await setText(T7);
    await page.evaluate(() => { const s = window.latTabs.state(); window.latTabs.closeTab(s.tabs[s.active].id); });
    const c7 = await capturedAs(T7, before);
    check('A: text typed then the tab closed at once is captured', !!c7, String(c7));
    check('A: and the close asked nothing', (await shows()) === s0 && natives === nat1);

    // ── A7. offline: queued, kept over a reload, and landed later ──
    step = 'A7 offline';
    before = await inboxOnShip();
    shipDown = true;
    await plus();
    await sleep(500);
    const T8 = 'captured offline ' + RUN;
    await setText(T8);
    const q1 = await waitFor(async () => (await qCount()) === 1, 15000);
    f = await front();
    check('A: an offline capture is queued', !!q1, 'q=' + await qCount());
    check('A: and named in the Inbox', INBOX.test(f.key || '') && f.key === f.name, JSON.stringify(f));
    const name8 = f.key;
    await leaving();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => !!window.latTabs, { timeout: 90000 });
    await sleep(2000);
    check('A: the queued capture survives a reload', (await qCount()) === 1, 'q=' + await qCount());
    shipDown = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const q0 = await waitFor(async () => (await qCount()) === 0, 30000, 500);
    check('A: it lands when the routes answer again', !!q0 && (await shipBody(name8)) === T8,
      JSON.stringify({ q: await qCount(), body: await shipBody(name8) }));

    //  an offline capture whose drawn name someone else takes before the
    //  ship is back lands under another Inbox name, and theirs is left be
    step = 'A7 offline clash';
    before = await inboxOnShip();
    const cf0 = await treePages('conflicts/');
    shipDown = true;
    await plus();
    await sleep(500);
    const T8b = 'offline, name taken ' + RUN;
    await setText(T8b);
    await waitFor(async () => (await qCount()) === 1, 15000);
    const taken = (await front()).key;
    const THEIRS = 'someone else made this ' + RUN;
    await apiMake(taken, THEIRS);
    shipDown = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitFor(async () => (await qCount()) === 0, 30000, 500);
    const c8b = await capturedAs(T8b, [...before, taken]);
    check('A: a replayed capture whose name was taken lands under another Inbox name', !!c8b && c8b !== taken,
      JSON.stringify({ taken, c8b }));
    check('A: the page that took the name is untouched', (await shipBody(taken)) === THEIRS);
    check('A: the tab follows the new name', !!c8b && (await front()).key === c8b, JSON.stringify(await front()));
    const cf1 = (await treePages('conflicts/')).filter((n) => !cf0.includes(n));
    check('A: and no conflicts/ copy is made of it', !cf1.length, JSON.stringify(cf1));
    await boot();

    // ── A8. the toolbar's New page and a split group's + ──
    step = 'A8 toolbar';
    before = await inboxOnShip();
    s0 = await shows();
    await page.evaluate(() => document.getElementById('newfile').click());
    await sleep(800);
    f = await front();
    check('A: the toolbar\'s New page shows no dialog', !(await dlgOpen()) && (await shows()) === s0);
    check('A: and starts a blank markdown page with the cursor in it',
      f.key === '' && f.name === '' && f.kind === 'md' && f.focus === 'src', JSON.stringify(f));
    const T9 = 'from the toolbar ' + RUN;
    await typeIn(T9);
    const name9 = await landed();
    check('A: and it is captured', !!name9 && INBOX.test(name9) && (await shipBody(name9)) === T9, String(name9));

    step = 'A8 split';
    await page.evaluate(() => { window.latSplits.split('r'); });
    await sleep(1500);
    const g2 = await page.evaluate(() => window.latTabs.groups().length);
    s0 = await shows();
    await page.evaluate(() => {
      const gs = document.querySelectorAll('.tgroup');
      gs[gs.length - 1].querySelector('[data-sb="new"]').click();
    });
    await sleep(1000);
    f = await front();
    check('A: a split group\'s + shows no dialog', g2 >= 2 && !(await dlgOpen()) && (await shows()) === s0, 'groups=' + g2);
    check('A: and starts a blank markdown page with the cursor in it',
      f.key === '' && f.name === '' && f.kind === 'md' && f.focus === 'src', JSON.stringify(f));
    const T10 = 'from a split ' + RUN;
    await typeIn(T10);
    const name10 = await landed();
    check('A: and it is captured', !!name10 && INBOX.test(name10) && (await shipBody(name10)) === T10, String(name10));
    await page.evaluate(() => { localStorage.removeItem('appTabs'); });
    await boot();

    // ── A9. a folder's + keeps its dialog; an untouched name captures ──
    step = 'A9 folder';
    dlgMeant++;
    check('A: the folder has its +', await addf());
    const up = await waitFor(dlgOpen, 5000, 100);
    const seedv = await page.evaluate(() => document.getElementById('dlginput').value);
    check('A: a folder\'s + still shows the dialog, seeded with the folder', !!up && seedv === RUN + '/', seedv);
    before = await inboxOnShip();
    n0 = saves.length;
    await page.evaluate(() => {
      const k = document.getElementById('dlgkind');
      k.value = 'text'; k.dispatchEvent(new Event('change'));
      document.getElementById('dlginput').focus();
    });
    await page.keyboard.press('Enter');
    await sleep(800);
    f = await front();
    check('A: Enter on the untouched folder starts an unnamed page of the kind chosen',
      !(await dlgOpen()) && f.key === '' && !f.readOnly && f.kind === 'text', JSON.stringify(f));
    const T11 = 'folder seed capture ' + RUN;
    await typeIn(T11);
    const name11 = await landed();
    check('A: it is captured to the Inbox, not the folder', !!name11 && INBOX.test(name11), String(name11));
    check('A: as the kind chosen in the dialog', saves.slice(n0).some((x) => x.name === name11 && x.isNew && x.type === 'text'),
      JSON.stringify(saves.slice(n0)));

    step = 'A9 typed';
    dlgMeant++;
    await addf();
    await waitFor(dlgOpen, 5000, 100);
    await page.evaluate(() => document.getElementById('dlginput').focus());
    await page.keyboard.type('typed');
    await page.keyboard.press('Enter');
    const typed = RUN + '/typed';
    //  a create right behind another can take the ship over 10 s
    const madeTyped = await waitFor(async () => (await shipPage(typed)) !== null
      && (await front()).key === typed, 40000, 500);
    check('A: a typed name lands in the folder', !!madeTyped,
      JSON.stringify({ ...(await front()), st: await page.evaluate(() => document.getElementById('status').textContent),
        saves: saves.slice(-3) }));

    step = 'A9 escape';
    const fe = await front();
    n0 = saves.length;
    dlgMeant++;
    await addf();
    await waitFor(dlgOpen, 5000, 100);
    await page.keyboard.press('Escape');
    await sleep(1500);
    const fe2 = await front();
    check('A: Escape changes nothing', !(await dlgOpen()) && saves.length === n0
      && fe2.key === fe.key && fe2.ntabs === fe.ntabs, JSON.stringify([fe, fe2]));

    step = 'A9 tree menu';
    dlgMeant++;
    await page.evaluate((r) => window.latTreeMenu.open('f:' + r), RUN);
    await page.evaluate(() => document.querySelector('.treemenu [data-mi="new"]').click());
    const tm = await waitFor(dlgOpen, 5000, 100);
    check('A: the tree menu\'s New page here still shows the dialog', !!tm);
    await unstick();

    step = 'A9 blank sheet';
    n0 = saves.length;
    dlgMeant++;
    await addf();
    await waitFor(dlgOpen, 5000, 100);
    await page.evaluate(() => {
      const k = document.getElementById('dlgkind');
      k.value = 'fods'; k.dispatchEvent(new Event('change'));
      document.getElementById('dlginput').focus();
    });
    await page.keyboard.press('Enter');
    const sheetUp = await waitFor(async () => (await front()).kind === 'fods'
      && (await page.evaluate(() => document.getElementById('src').value.length > 0)), 20000);
    await sleep(1500);
    await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
    await sleep(3000);
    check('A: an untouched blank spreadsheet with no name writes nothing, Ctrl+S included',
      !!sheetUp && saves.length === n0, JSON.stringify(saves.slice(n0)));

    // ── A10. Move or rename ──
    step = 'A10 move captured';
    await plus();
    await sleep(500);
    const T12 = 'to be moved ' + RUN;
    await setText(T12);
    const name12 = await landed();
    dlgMeant++;
    await page.evaluate(() => document.getElementById('tpath').click());
    await waitFor(dlgOpen, 5000, 100);
    const moved = RUN + '/moved';
    await page.evaluate((n) => {
      document.getElementById('dlginput').value = n;
      document.getElementById('dlgok').click();
    }, moved);
    const mv = await waitFor(async () => (await shipBody(moved)) === T12
      && !(await inboxOnShip()).includes(name12) && (await front()).key === moved, 40000, 500);
    check('A: Move or rename moves a captured page', !!mv && !(await inboxOnShip()).includes(name12),
      JSON.stringify({ name12, moved: await shipBody(moved) }));
    check('A: and the editor follows it', (await front()).key === moved, JSON.stringify(await front()));

    step = 'A10 name unsaved';
    before = await inboxOnShip();
    await plus();
    await sleep(500);
    const T13 = 'named before its save ' + RUN;
    await setText(T13);
    dlgMeant++;
    await page.evaluate(() => document.getElementById('tpath').click());
    const nup = await waitFor(dlgOpen, 3000, 100);
    check('A: Move or rename on a page not saved yet asks its name', !!nup);
    await sleep(2500);       // past the autosave delay, the question still open
    const named = RUN + '/named';
    await page.evaluate((n) => {
      document.getElementById('dlginput').value = n;
      document.getElementById('dlgok').click();
    }, named);
    const nm = await waitFor(async () => (await shipBody(named)) === T13, 15000, 500);
    check('A: the page is created under that name', !!nm, JSON.stringify(await front()));
    const stray = [];
    for (const n of await inboxOnShip()) if (!before.includes(n) && (await shipBody(n)) === T13) stray.push(n);
    check('A: and not in the Inbox', stray.length === 0, JSON.stringify(stray));

    //  named while its capture is on the wire: one page, under the name
    step = 'A10 name in flight';
    before = await inboxOnShip();
    await plus();
    await sleep(500);
    holdSave = 4000;
    n0 = saves.length;
    const T13b = 'named while saving ' + RUN;
    await setText(T13b);
    const sent = await waitFor(() => saves.length > n0, 6000, 100);
    const flying = saves.length > n0 ? saves[saves.length - 1].name : null;
    dlgMeant++;
    await page.evaluate(() => document.getElementById('tpath').click());
    await waitFor(dlgOpen, 3000, 100);
    const named2 = RUN + '/named-in-flight';
    await page.evaluate((n) => {
      document.getElementById('dlginput').value = n;
      document.getElementById('dlgok').click();
    }, named2);
    const nm2 = await waitFor(async () => (await treePages(RUN + '/')).includes(named2)
      && (await shipBody(named2)) === T13b, 20000, 500);
    holdSave = 0;
    await sleep(2000);
    const inbox2 = (await inboxOnShip()).filter((n) => !before.includes(n));
    check('A: naming a page while its capture is on the wire leaves one page, under the name',
      !!sent && INBOX.test(flying || '') && !!nm2 && !inbox2.length && (await front()).key === named2,
      JSON.stringify({ flying, nm2, inbox2, f: await front() }));

    // ── A11. autosave off: nothing until Ctrl+S, which captures ──
    step = 'A11 autosave off';
    await page.evaluate(() => { localStorage.latAutosave = '0'; });
    await plus();
    await sleep(500);
    n0 = saves.length;
    const T14 = 'manual save ' + RUN;
    await typeIn(T14);
    await sleep(4000);
    check('A: with autosave off nothing is written', saves.length === n0, JSON.stringify(saves.slice(n0)));
    await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
    const name14 = await landed();
    check('A: Ctrl+S captures it to the Inbox', !!name14 && INBOX.test(name14) && (await shipBody(name14)) === T14,
      String(name14));
    await page.evaluate(() => { localStorage.removeItem('latAutosave'); });

    // ── A12. a page started with its name (startNamed), and the brief ──
    step = 'A12 named start';
    const day = RUN + '/journal-day';
    await plus();
    await sleep(500);
    await page.evaluate((n) => window.latStartNamed(n), day);
    n0 = saves.length;
    await sleep(3000);
    check('A: a page started with its name writes nothing until it has text', saves.length === n0
      && (await front()).name === day, JSON.stringify(saves.slice(n0)));
    const T15 = 'named day line ' + RUN;
    await typeIn(T15);
    const ds = await waitFor(async () => (await shipBody(day)) === T15
      && (await treePages(RUN + '/')).includes(day), 12000, 500);
    check('A: and is saved under that name once it has text', !!ds);

    step = 'A12 journal';
    const jn = 'journal/' + await today();
    //  page-del leaves a page the ship still answers for, and refuses to
    //  make again (409), so a day made and deleted is never free again
    if ((await treePages('journal/')).includes(jn) || await shipPage(jn)) {
      console.log('  note - today\'s journal exists, or existed, on this ship: the brief button check did not run');
    } else {
      await page.evaluate(() => document.getElementById('rb-brief').click());
      const jup = await waitFor(async () => (await front()).name === jn, 10000);
      check('A: the brief button starts today\'s journal, named', !!jup, JSON.stringify(await front()));
      const T16 = 'journal line ' + RUN;
      await typeIn(T16);
      const js = await waitFor(async () => (await shipBody(jn)) === T16, 30000, 500);
      check('A: the journal day is saved once it has text', !!js);
    }

    step = 'A end';
    check('A: no native dialog at any point', natives === 0, 'natives=' + natives);
    const allDlg = await dlgSum();
    check('A: the editor\'s dialog opened only where the suite opened it', allDlg === dlgMeant,
      JSON.stringify({ shown: allDlg, meant: dlgMeant }));
  }

  //  the palette's box and the chords, for B and C
  const chord = async (key, mods) => {
    for (const m of mods) await page.keyboard.down(m);
    await page.keyboard.press(key);
    for (const m of [...mods].reverse()) await page.keyboard.up(m);
    await sleep(250);
  };
  //  the palette's box as the user sees it
  const pal = () => page.evaluate(() => {
    const p = document.getElementById('palette'), i = document.getElementById('palin');
    return { open: !p.hidden, ph: i.placeholder, focus: document.activeElement === i,
      rows: [...document.querySelectorAll('#pallist .palrow')].map((r) => ({ kind: r.dataset.kind,
        key: r.dataset.key || '', name: r.querySelector('.palname').textContent,
        home: r.querySelector('.palhome').textContent,
        keys: (r.querySelector('.palkeys') || {}).textContent || '' })) };
  });
  const palUp = () => waitFor(async () => { const x = await pal(); return x.open && x.focus ? x : null; }, 5000, 100);
  const palEsc = async () => { if ((await pal()).open) await page.keyboard.press('Escape'); await sleep(200); };

  const palType = async (t) => { await page.keyboard.type(t); await sleep(300); return pal(); };
  //  a page opened from outside the picker, shown and settled
  const openWait = async (n) => {
    await page.evaluate((x) => window.latTabs.openIn('page', x), n);
    return waitFor(async () => { const f = await front(); return f.key === n && f.name === n && f.readOnly; }, 20000, 200);
  };

  if (on('B')) {
    const QA = RUN + '/qa', QB = RUN + '/qb', QC = RUN + '/qc', QD = RUN + '/qd';
    const QE = RUN + '/qe', QE2 = RUN + '/qe2';
    const ctrlO = async () => { await chord('KeyO', ['Control']); return palUp(); };
    step = 'B setup';
    for (const n of [QA, QB, QC, QD, QE])
      await api('page-save?type=md&new=1&name=' + encodeURIComponent(n), { method: 'POST', body: 'body of ' + n });
    await boot();

    // ── B1. Ctrl+O opens the palette's box in open mode, asking nothing ──
    step = 'B1 open mode';
    await page.evaluate(() => document.getElementById('src').focus());
    const r0 = reqs.length;
    let s = await ctrlO();
    await sleep(1000);
    const asked = reqs.slice(r0).filter((u) => /\/apps\/lattice\/(know-|page-)/.test(u));
    check('B: Ctrl+O opens the palette\'s box', !!s);
    s = await pal();
    check('B: in open mode: the placeholder says open a page', s.ph === 'open a page', s.ph);
    check('B: and it lists no actions', s.rows.every((r) => r.kind === 'page' || r.kind === 'know'),
      JSON.stringify(s.rows.slice(0, 4)));
    check('B: opening it asks the ship nothing', asked.length === 0, JSON.stringify(asked));
    await palEsc();
    check('B: Escape closes it and hands the focus back', await page.evaluate(() =>
      document.getElementById('palette').hidden && document.activeElement.id === 'src'));
    //  recents in localStorage that are junk, or not there at all
    let junkOk = true;
    for (const v of ['{junk', '[1,null,{"kind":"x","key":2},{"kind":"page"}]', '"a"']) {
      await page.evaluate((x) => { localStorage.latRecents = x; }, v);
      s = await ctrlO();
      if (!s || !s.rows.every((r) => r.kind === 'page' || r.kind === 'know')) junkOk = false;
      await palEsc();
    }
    await page.evaluate(() => localStorage.removeItem('latRecents'));
    check('B: junk in the recents is read as no recents', junkOk);
    //  nothing to list says why: no recents yet, or nothing matching
    const noneSays = () => page.evaluate(() => (document.querySelector('#pallist .palnone') || {}).textContent || '');
    s = await ctrlO();
    const noRecent = s && !s.rows.length && await noneSays();
    s = await palType('%%%');
    const noMatch = s && !s.rows.length && await noneSays();
    check('B: with no recent pages yet the picker says so, and a query matching nothing says that',
      noRecent === 'no recent pages' && noMatch === 'nothing matches', JSON.stringify({ noRecent, noMatch }));
    await palEsc();

    // ── B2. recents: newest first, front left out, deleted gone, renamed followed ──
    step = 'B2 recents';
    await openWait(QD);
    check('B: a page to rename is open', !!(await openWait(QE)));
    dlgMeant++;
    await page.evaluate(() => document.getElementById('tpath').click());
    await waitFor(dlgOpen, 5000, 100);
    await page.evaluate((n) => {
      document.getElementById('dlginput').value = n;
      document.getElementById('dlgok').click();
    }, QE2);
    const ren = await waitFor(async () => (await front()).key === QE2
      && (await treePages(RUN + '/')).includes(QE2), 40000, 500);
    check('B: it is renamed', !!ren, JSON.stringify(await front()));
    for (const n of [QA, QB, QC]) await openWait(n);
    //  deleted from elsewhere, as another device would
    await api('page-del?name=' + encodeURIComponent(QD), { method: 'POST' });
    await boot();
    await waitFor(async () => (await front()).key === QC, 20000, 200);
    s = await ctrlO();
    const keys = s ? s.rows.map((r) => r.key) : [];
    check('B: with nothing typed: the recent pages, newest first, without the one in front',
      keys[0] === QB && keys[1] === QA && !keys.includes(QC), JSON.stringify(keys));
    check('B: ten at most, and no Create row', keys.length <= 10 && s.rows.every((r) => r.kind !== 'create'));
    check('B: a page deleted since is not listed', !keys.includes(QD), JSON.stringify(keys));
    check('B: a renamed page is listed under its new name', keys.includes(QE2) && !keys.includes(QE),
      JSON.stringify(keys));
    await palEsc();

    // ── B3. typing filters; Enter opens in place, Ctrl+Enter in a new tab ──
    step = 'B3 filter';
    const f0 = await front();
    await ctrlO();
    s = await palType(QB);
    check('B: typing filters: the typed page is the top row, and no action is listed',
      !!s.rows[0] && s.rows[0].key === QB && s.rows.every((r) => r.kind !== 'action'),
      JSON.stringify(s.rows.slice(0, 3)));
    await page.keyboard.press('Enter');
    const inPlace = await waitFor(async () => {
      const f = await front();
      return f.key === QB && f.name === QB && f.readOnly ? f : null;
    }, 20000, 200);
    check('B: Enter opens it in the front tab', !!inPlace && inPlace.ntabs === f0.ntabs && !(await pal()).open,
      JSON.stringify([f0.ntabs, inPlace]));
    await ctrlO();
    await palType(QA);
    await chord('Enter', ['Control']);
    const newTab = await waitFor(async () => {
      const f = await front();
      return f.key === QA && f.name === QA && f.readOnly ? f : null;
    }, 20000, 200);
    check('B: Ctrl+Enter opens it in a new tab', !!newTab && newTab.ntabs === f0.ntabs + 1,
      JSON.stringify(newTab || await front()));

    // ── B4. the Create row ──
    step = 'B4 create row';
    await ctrlO();
    s = await palType(RUN + '/q');
    const last = s.rows[s.rows.length - 1] || {};
    check('B: a Create row is last when no page has the typed name',
      s.rows.length > 1 && last.kind === 'create' && /^Create /.test(last.name)
        && s.rows.slice(0, -1).every((r) => r.kind === 'page' || r.kind === 'know'), JSON.stringify(s.rows));
    s = await palType('a');
    check('B: and absent when a page has exactly that name',
      s.rows.length > 0 && s.rows.every((r) => r.kind !== 'create'), JSON.stringify(s.rows));
    await palEsc();

    // ── B5. Enter on no match, and Shift+Enter, create the typed page ──
    step = 'B5 create';
    const TU = 'unsaved line ' + RUN + ' ';
    await typeIn(TU);
    const inbox0 = await inboxOnShip();
    const b0 = saves.length;
    const MADE = RUN + '/made-by-enter';
    await ctrlO();
    s = await palType(MADE);
    check('B: with no match, the Create row is the only row', s.rows.length === 1 && s.rows[0].kind === 'create',
      JSON.stringify(s.rows));
    await page.keyboard.press('Enter');
    const made = await waitFor(async () => (await treePages(RUN + '/')).includes(MADE)
      && (await front()).key === MADE, 40000, 500);
    check('B: Enter on it creates the typed page, at the typed path', !!made, JSON.stringify(await front()));
    check('B: as markdown', saves.slice(b0).some((x) => x.name === MADE && x.isNew && x.type === 'md'),
      JSON.stringify(saves.slice(b0)));
    check('B: the text left unsaved in the page in front is kept', ((await shipBody(QA)) || '').includes(TU.trim()),
      String(await shipBody(QA)));
    const SHIFT = RUN + '/q';
    await ctrlO();
    s = await palType(SHIFT);
    const matches = s.rows.filter((r) => r.kind === 'page').length;
    await chord('Enter', ['Shift']);
    const sh = await waitFor(async () => (await treePages(RUN + '/')).includes(SHIFT)
      && (await front()).key === SHIFT, 40000, 500);
    check('B: Shift+Enter with matches creates the typed page', matches > 1 && !!sh
      && saves.slice(b0).some((x) => x.name === SHIFT && x.isNew && x.type === 'md'),
      JSON.stringify({ matches, f: await front() }));
    check('B: neither went to the Inbox', (await inboxOnShip()).filter((n) => !inbox0.includes(n)).length === 0);
    //  Shift+Enter on a name a page already has opens that page
    const b1 = saves.length;
    await ctrlO();
    await palType(QB);
    await chord('Enter', ['Shift']);
    const opened = await waitFor(async () => { const x = await front(); return x.key === QB && x.name === QB && x.readOnly ? x : null; }, 20000, 200);
    await sleep(1500);
    const qb = await front();
    check('B: Shift+Enter on a name a page has opens that page, writing nothing',
      !!opened && qb.src === await shipBody(QB) && !saves.slice(b1).some((x) => x.isNew)
      && !/already exists/.test(await page.evaluate(() => document.getElementById('status').textContent)),
      JSON.stringify({ qb, saves: saves.slice(b1) }));

    // ── B6. names: the picker makes what the new-page dialog makes ──
    step = 'B6 names';
    //  the page made under `pre`, its create's type, and the status line
    const outcome = async (pre, k0) => {
      const ps = await waitFor(async () => { const x = await treePages(pre); return x.length ? x : null; }, 40000, 500);
      if (ps) await waitFor(async () => (await front()).key === ps[0], 10000, 200);
      await sleep(600);
      return { pages: ps || [], types: saves.slice(k0).filter((x) => x.isNew && x.name.startsWith(pre)).map((x) => x.type),
        st: await page.evaluate(() => document.getElementById('status').textContent) };
    };
    for (const [tag, typed] of [['x', 'x/'], ['ext', 'notes/a.md'], ['shape', 'My Page']]) {
      const D = RUN + '/dlg-' + tag + '/', P = RUN + '/pick-' + tag + '/';
      let k0 = saves.length;
      dlgMeant++;
      await addf();
      await waitFor(dlgOpen, 5000, 100);
      await page.evaluate((v) => {
        const k = document.getElementById('dlgkind');
        k.value = 'md'; k.dispatchEvent(new Event('change'));
        const i = document.getElementById('dlginput');
        i.value = v; i.focus();
      }, D + typed);
      await page.keyboard.press('Enter');
      const viaD = await outcome(D, k0);
      k0 = saves.length;
      await ctrlO();
      await palType(P + typed);
      await page.keyboard.press('Enter');
      const viaP = await outcome(P, k0);
      const same = (o) => JSON.stringify(o).split(D).join(P);
      check('B: "' + typed + '" makes the page and says what the dialog does',
        viaP.pages.length === 1 && viaP.pages.every((n) => n.startsWith(P) && !n.endsWith('/') && !n.includes('//'))
          && viaP.types.length === 1 && viaP.types[0] === 'md' && same(viaD) === JSON.stringify(viaP),
        JSON.stringify({ viaD, viaP }));
    }
    //  three spaces name nothing: the picker offers no Create row and
    //  Shift+Enter writes nothing, as the dialog's empty name writes nothing
    let k1 = saves.length;
    const fs0 = await front();
    await ctrlO();
    s = await palType('   ');
    const noCreate = s.rows.every((r) => r.kind !== 'create');
    await chord('Enter', ['Shift']);
    await sleep(2500);
    const fs1 = await front();
    check('B: three spaces offer no Create row, and Shift+Enter makes nothing',
      noCreate && !saves.slice(k1).some((x) => x.isNew) && fs1.key === fs0.key,
      JSON.stringify({ rows: s.rows.length, saves: saves.slice(k1), fs0: fs0.key, fs1: fs1.key }));
    await palEsc();
    k1 = saves.length;
    dlgMeant++;
    await addf();
    await waitFor(dlgOpen, 5000, 100);
    await page.evaluate(() => {
      const i = document.getElementById('dlginput');
      i.value = '   '; i.focus();
    });
    await page.keyboard.press('Enter');
    await sleep(2500);
    check('B: and the dialog given three spaces makes no page either', !saves.slice(k1).some((x) => x.isNew),
      JSON.stringify(saves.slice(k1)));

    // ── B7. Ctrl+O from a tool tab, and with vim on in the editor ──
    step = 'B7 tool tab';
    await openWait(QB);
    await page.evaluate(() => document.getElementById('rb-settings').click());
    const SET = '#toolhost iframe[data-tool="frame:/apps/lattice/settings"]';
    const fr = await waitFor(() => page.evaluate((q) => {
      const f = document.querySelector(q);
      return f?.contentDocument?.readyState === 'complete' && !!f.contentDocument.body;
    }, SET), 30000, 300);
    await sleep(2000);
    await page.evaluate((q) => {
      const f = document.querySelector(q);
      f.focus(); f.contentWindow.focus(); f.contentDocument.body.focus();
    }, SET);
    s = await ctrlO();
    check('B: Ctrl+O works with a tool tab in front', !!fr && !!s && s.ph === 'open a page',
      JSON.stringify({ fr, s: s && s.ph }));
    await palEsc();
    await page.evaluate(async () => {
      for (const t of window.latTabs.state().tabs.filter((x) => x.kind === 'tool')) await window.latTabs.closeTab(t.id);
    });
    step = 'B7 vim';
    await openWait(QB);
    await page.evaluate(() => { localStorage.edVim = '1'; window.dispatchEvent(new StorageEvent('storage', { key: 'edVim' })); });
    await sleep(300);
    await page.focus('#src');
    s = await ctrlO();
    check('B: Ctrl+O works with vim on while the editor has focus', !!s && s.ph === 'open a page');
    await palEsc();
    await page.evaluate(() => { localStorage.removeItem('edVim'); window.dispatchEvent(new StorageEvent('storage', { key: 'edVim' })); });

    // ── B8. the Open button, and the palette's index ──
    step = 'B8 button';
    const btn = await page.evaluate(() => {
      const b = document.getElementById('qopen');
      return b && { title: b.title, aria: b.getAttribute('aria-label'), action: b.dataset.action,
        next: b.nextElementSibling && b.nextElementSibling.firstElementChild
          && b.nextElementSibling.firstElementChild.id };
    });
    check('B: the Files toolbar has an Open button beside New page, its tooltip its accessible name',
      !!btn && btn.title === btn.aria && btn.action === 'qopen' && /^Open a page/.test(btn.title)
        && btn.next === 'newfile', JSON.stringify(btn));
    await page.evaluate(() => document.getElementById('qopen').click());
    s = await palUp();
    check('B: the Open button opens the box in open mode', !!s && s.ph === 'open a page');
    await palEsc();
    await chord('KeyK', ['Control']);
    s = await palUp();
    check('B: Ctrl+K still opens the command palette, actions only with nothing typed',
      !!s && s.ph === 'run an action or open a page' && s.rows.length > 0 && s.rows.every((r) => r.kind === 'action'),
      JSON.stringify(s && s.ph));
    s = await palType('Open a page');
    const row = s.rows.find((r) => r.kind === 'action' && r.name === 'Open a page');
    check('B: the palette lists Open a page, homed in Files, with its keys',
      !!row && row.home === 'Files' && row.keys === 'Ctrl+O', JSON.stringify(row || s.rows.slice(0, 3)));
    //  run as the user would: the arrow keys down to the row, then Enter
    const at = row ? s.rows.indexOf(row) : -1;
    if (at < 0) console.log('  note - the palette did not list Open a page: running it from there was not checked');
    else {
      for (let i = 0; i < at; i++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      s = await palUp();
      check('B: running it from the palette opens open mode', !!s && s.ph === 'open a page');
    }
    await palEsc();

    step = 'B end';
    check('B: no native dialog at any point', natives === 0, 'natives=' + natives);
    const allDlg = await dlgSum();
    check('B: the editor\'s dialog opened only where the suite opened it', allDlg === dlgMeant,
      JSON.stringify({ shown: allDlg, meant: dlgMeant }));
  }
  if (on('C')) {
    const useSet = (v) => page.evaluate((x) => { localStorage.latActUse = x; }, typeof v === 'string' ? v : JSON.stringify(v));
    const names = (s) => s.rows.map((r) => r.name);
    const cmdUp = async () => { await chord('KeyK', ['Control']); return palUp(); };
    const dlgCancel = async () => { await sleep(300); if (await dlgOpen()) await page.evaluate(() => document.getElementById('dlgcancel').click()); await sleep(200); };
    //  run a row of the open palette by typing its name; the box is shut after
    const runByName = async (n) => {
      await cmdUp();
      await page.keyboard.type(n);
      await sleep(300);
      await page.keyboard.press('Enter');
      await sleep(300);
    };

    step = 'C setup';
    await page.evaluate(() => { localStorage.removeItem('latActUse'); });
    await boot();
    await openWait(SEEDP);

    // ── C1. the order follows the last run ──
    step = 'C1 order';
    let s = await cmdUp();
    const base = names(s);
    check('C: with nothing run the palette lists the actions as registered',
      base.length > 5 && base[0] !== 'Move or rename', JSON.stringify(base.slice(0, 3)));
    await palEsc();
    //  the write is localStorage.latActUse = JSON.stringify({id: ms, ...}),
    //  which no Storage method sees; count the stringify of such an object
    await page.evaluate(() => {
      window.__lw = 0;
      const o = JSON.stringify;
      JSON.stringify = function (v, ...r) {
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length
          && Object.values(v).every((x) => typeof x === 'number')) window.__lw++;
        return o.call(this, v, ...r);
      };
    });
    await runByName('Move or rename');
    dlgMeant++;
    check('C: one run from the palette writes the use once',
      (await page.evaluate(() => window.__lw)) === 1, String(await page.evaluate(() => window.__lw)));
    await dlgCancel();
    s = await cmdUp();
    check('C: after running Move or rename it is listed first', names(s)[0] === 'Move or rename', JSON.stringify(names(s).slice(0, 3)));
    check('C: the never-run actions keep their place after it',
      JSON.stringify(names(s).slice(1)) === JSON.stringify(base.filter((n) => n !== 'Move or rename')));
    await page.keyboard.press('Enter');
    await sleep(300);
    dlgMeant++;
    check('C: Enter on the first row runs it', await dlgOpen());
    await dlgCancel();

    // ── C2. a second action goes first, the first second; a home click counts ──
    step = 'C2 second';
    await runByName('Show Files');
    s = await cmdUp();
    check('C: a second run goes first and the first one second',
      names(s)[0] === 'Show Files' && names(s)[1] === 'Move or rename', JSON.stringify(names(s).slice(0, 3)));
    await palEsc();
    await page.evaluate(() => { window.__lw = 0; });
    await page.evaluate(() => document.querySelector('[data-action="ctlt"]').click());
    await sleep(200);
    check('C: a click on the home writes the use once',
      (await page.evaluate(() => window.__lw)) === 1, String(await page.evaluate(() => window.__lw)));
    s = await cmdUp();
    check('C: a run from its home goes first too', names(s)[0] === 'Toggle right pane', JSON.stringify(names(s).slice(0, 3)));
    await palEsc();
    await page.evaluate(() => document.querySelector('[data-action="ctlt"]').click());
    await sleep(200);

    // ── C3. the order holds while the box is open ──
    step = 'C3 frozen';
    await useSet({ tpath: 1 });
    s = await cmdUp();
    const frozen = names(s);
    await useSet({ ctlt: Date.now() + 10, treet: Date.now() + 9 });
    await page.keyboard.type('zz');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await sleep(300);
    check('C: rewriting the key while the box is open moves nothing', JSON.stringify(names(await pal())) === JSON.stringify(frozen),
      JSON.stringify(names(await pal()).slice(0, 3)));
    await palEsc();

    // ── C4. a query ranks by match, a tie goes to the more recent ──
    step = 'C4 query';
    const now = Date.now();
    await useSet({ treet: now - 5, ctlt: now });
    await cmdUp();
    s = await palType('toggle');
    check('C: a tie goes to the more recent run', names(s)[0] === 'Toggle right pane' && names(s)[1] === 'Toggle left pane',
      JSON.stringify(names(s).slice(0, 3)));
    await palEsc();
    await useSet({ treet: now, ctlt: now - 5 });
    await cmdUp();
    s = await palType('toggle');
    check('C: and the other way round', names(s)[0] === 'Toggle left pane' && names(s)[1] === 'Toggle right pane',
      JSON.stringify(names(s).slice(0, 3)));
    await palEsc();
    //  both match 'pane'; the left one scores better (it starts earlier)
    await useSet({ ctlt: now + 100 });
    await cmdUp();
    s = await palType('pane');
    check('C: a better match beats a more recent run',
      names(s)[0] === 'Toggle left pane' && names(s)[1] === 'Toggle right pane', JSON.stringify(names(s).slice(0, 3)));
    await palEsc();

    // ── C4b. only a control's own click is a run ──
    step = 'C4b homes';
    await useSet({});
    await page.evaluate(() => {
      const c = document.createElement('section');
      c.id = 'xcont';
      c.dataset.action = 'tpath';
      c.innerHTML = '<button type="button" id="xcb">x</button><span id="xcs">t</span>';
      document.body.append(c);
      document.getElementById('xcb').click();
      document.getElementById('xcs').click();
      c.click();
    });
    await sleep(200);
    check('C: a click inside a container home records nothing',
      (await page.evaluate(() => localStorage.latActUse)) === '{}', await page.evaluate(() => localStorage.latActUse));
    await page.evaluate(() => document.getElementById('xcont').remove());
    await page.evaluate(() => { window.__lw = 0; });
    await page.evaluate(() => document.querySelector('[data-action="ctlt"] svg, [data-action="ctlt"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await sleep(200);
    check('C: a click on a control home, even on its icon, records once',
      (await page.evaluate(() => window.__lw)) === 1 && Object.keys(JSON.parse(await page.evaluate(() => localStorage.latActUse))).join() === 'ctlt',
      String(await page.evaluate(() => window.__lw)));
    await page.evaluate(() => document.querySelector('[data-action="ctlt"]').click());
    await sleep(200);

    // ── C5. junk in the key falls back to registration order ──
    step = 'C5 junk';
    for (const junk of ['{nope', '[1,2]', '"x"', 'null', '{"tpath":"soon","treet":{}}', '{"treet":-5}', '{"treet":true}', '{"treet":-5,"ctlt":true}']) {
      await useSet(junk);
      s = await cmdUp();
      check('C: junk ' + junk + ' lists the registration order', JSON.stringify(names(s)) === JSON.stringify(base),
        JSON.stringify(names(s).slice(0, 3)));
      await palEsc();
    }

    step = 'C end';
    check('C: no native dialog at any point', natives === 0, 'natives=' + natives);
    const allDlg = await dlgSum();
    check('C: the editor\'s dialog opened only where the suite opened it', allDlg === dlgMeant,
      JSON.stringify({ shown: allDlg, meant: dlgMeant }));
  }
  if (on('D')) {
    //  Names no run has ever used on this ship. A deleted page keeps
    //  answering page-source here and cannot be made again, so a missing
    //  page is always a name never made, and nothing is deleted and made
    //  again. The journal days are in a far year of this run's own: the
    //  first year from a per-run start where none of its days answers.
    const G = RUN + '/ghosts';               // the page holding the links
    const ROW = RUN + '/not-yet';            // started from an Outgoing row, left empty
    const OFF = RUN + '/offline-start';      // started with the ship unreachable
    const FORB = RUN + '/forbidden';         // the ship answers 403
    const LNK = RUN + '/their-page';         // another ship's page, its host down
    const DEL = RUN + '/deleted';            // made, then deleted
    const BAD = 'a&b c/é';                   // a name the ship refuses (400 bad name)
    const MEMK = RUN + '-mem';               // a memory
    const MP = RUN + '/mem-link';            // a page linking only to the memory
    //  what only the ship's render draws (a footnote, a reference link, a
    //  setext heading), beside a link to a page not written
    const FN = RUN + '/rich', FNG = RUN + '/rich-missing';
    const FNBODY = 'Title\n=====\n\nA note[^1] and [a ref][r] and [[' + FNG + ']].\n\n'
      + '[r]: https://example.com/ref\n[^1]: the footnote text\n';
    const prevHtml = () => page.evaluate(() => document.getElementById('prev').srcdoc || '');
    const richOk = (h) => h.includes('<sup class="fnref"') && h.includes('<h1>Title</h1>')
      && h.includes('href="https://example.com/ref"') && !h.includes('[^1]') && !h.includes('=====');
    let Y = 3000 + (Math.floor(Date.now() / 1000) + process.pid) % 6000;
    const days = (y) => ({ JD: y + '-12-10', JX: y + '-12-11', JDOT: y + '-01-05', JOLD: y + '.1.5' });
    for (;;) {
      const d = days(Y);
      const taken = await Promise.all(['journal/' + d.JD, 'journal/' + d.JX, 'journal/' + d.JOLD,
        'journal/' + d.JDOT].map(async (n) => (await api('page-source?name=' + encodeURIComponent(n))).status !== 404));
      if (!taken.some(Boolean)) break;
      Y++;
    }
    const { JD, JX, JDOT, JOLD } = days(Y);
    const jd = 'journal/' + JD, jx = 'journal/' + JX, jold = 'journal/' + JOLD;
    console.log('  note - D uses the journal days ' + [jd, jx, jold].join(', '));
    journalMade.push(jd, jx, jold);
    memMade.push(MEMK);
    const savesOf = (n) => saves.filter((s) => s.name === n);
    let n0m = 0;
    //  the links in the preview as drawn, read off the frame's document
    const prevLinks = () => page.evaluate(() => {
      const html = document.getElementById('prev').srcdoc || '';
      const d = new DOMParser().parseFromString(html, 'text/html');
      return { css: /\.ghost\s*\{/.test(html), links: [...d.querySelectorAll('a')].map((a) => ({
        href: a.getAttribute('href'), text: a.textContent, cls: a.className, title: a.title,
        first: a.outerHTML.startsWith('<a href="') })) };
    });
    //  the ship's render writes the name unencoded, the editor's encoded
    const hrefName = (h) => {
      const m = /^\/apps\/lattice\/app\?name=(.*)$/.exec(h || '');
      try { return m ? decodeURIComponent(m[1]) : null; } catch { return null; }
    };
    const linkTo = (ls, n) => ls.links.find((l) => hrefName(l.href) === n);
    const acRows = () => page.evaluate(() => document.getElementById('ac').hidden ? []
      : [...document.querySelectorAll('#ac .row')].map((r) => ({ nm: r.querySelector('.nm').textContent,
        dir: r.querySelector('.dir').textContent, note: (r.querySelector('.new') || {}).textContent || '' })));
    const rtab = (id) => page.evaluate((i) => document.querySelector('#rtabs [data-pt=' + i + ']').click(), id);
    const tabName = () => page.evaluate(() => {
      const b = document.querySelector('#doctabs .dtab.on .dtn');
      return b ? b.textContent : null;
    });
    //  a page started under `n`: its name, editable, empty, markdown, the
    //  address naming it and the tab titled with it
    const started = (n, ms = 30000) => waitFor(async () => {
      const f = await front();
      return f.name === n && !f.readOnly && f.src === '' && f.kind === 'md'
        && f.url === '?name=' + encodeURIComponent(n) && (await tabName()) === n.split('/').pop() ? f : null;
    }, ms, 250);
    //  the tab in front is the locked blank of a failed open
    const locked = (key) => waitFor(async () => {
      const f = await front();
      return f.key === key && f.readOnly && f.src === '' ? f : null;
    }, 30000, 250);
    const bootAt = async (q) => {
      await leaving();
      await page.goto(env.app + q, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForFunction(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0
        && !!window.latTabs, { timeout: 90000 });
    };
    //  a click on the preview's link to `n`: a full navigation, as the
    //  sandboxed frame makes it
    const prevClick = async (n) => {
      const fr = await (await page.$('#prev')).contentFrame();
      let a = null;
      for (const h of await fr.$$('a'))
        if (hrefName(await h.evaluate((e) => e.getAttribute('href'))) === n) { a = h; break; }
      if (!a) return false;
      await leaving();
      await Promise.all([page.waitForNavigation({ timeout: 30000 }), a.click()]);
      await page.waitForFunction(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0
        && !!window.latTabs, { timeout: 90000 });
      return true;
    };
    //  the linking page in Read, where the preview is painted
    //  Read, painted by the editor's own renderer (whose links go to the
    //  top window), once the open's own read of the page has landed
    const readLocal = async () => {
      await sleep(1500);
      await page.evaluate(() => { window.latSetRead(false); window.latSetRead(true); });
      await waitFor(() => page.evaluate(() => (document.getElementById('prev').srcdoc || '')
        .includes('<base target="_top">')), 10000, 200);
      await sleep(300);
    };
    const readG = async () => { await openWait(G); await readLocal(); };
    const outRow = async (n) => {
      await rtab('out');
      return waitFor(() => page.evaluate((x) => {
        const a = [...document.querySelectorAll('[data-pane=out] .olrow')].find((r) => r.textContent.trim() === x);
        if (a) a.click();
        return !!a;
      }, n), 10000, 200);
    };

    step = 'D setup';
    for (const [n, b] of [[jx, 'a day written'], [jold, 'an old dotted day'], [G, 'ghosts\n'], [DEL, 'deleted body'],
      [FN, FNBODY], [MP, '[[' + MEMK + ']]\n']])
      await api('page-save?type=md&new=1&name=' + encodeURIComponent(n), { method: 'POST', body: b });
    await api('page-del?name=' + encodeURIComponent(DEL), { method: 'POST' });
    await api('know-save?key=' + encodeURIComponent(MEMK), { method: 'POST', body: 'a memory' });
    await boot();
    await openWait(G);
    await page.evaluate(() => window.latSetRead(false));

    // ── D1. [[YYYY-MM-DD offers that journal day first ──
    step = 'D1 autocomplete';
    const at = async (q) => {
      await page.evaluate(() => { const s = document.getElementById('src'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); });
      await page.keyboard.type('\n[[' + q);
      await sleep(400);
      return acRows();
    };
    let rows = await at(JD);
    check('D: [[' + JD + ' lists journal/' + JD + ' first, not written yet',
      rows.length > 0 && rows.length <= 8 && rows[0].nm === JD && rows[0].dir === 'journal' && rows[0].note === 'not written yet',
      JSON.stringify(rows.slice(0, 3)));
    await page.keyboard.press('Tab');
    await sleep(200);
    check('D: Tab inserts the full path', (await front()).src.endsWith('[[' + jd + ']]'), JSON.stringify((await front()).src.slice(-40)));
    rows = await at(Y + '-13-45');
    check('D: a date the calendar has not got offers no journal day',
      !rows.some((r) => r.dir === 'journal' || r.note), JSON.stringify(rows.slice(0, 3)));
    await page.keyboard.press('Escape');
    rows = await at(Y + '-02-30');
    check('D: nor does 30 February', !rows.some((r) => r.dir === 'journal' || r.note), JSON.stringify(rows.slice(0, 3)));
    await page.keyboard.press('Escape');
    rows = await at(JX);
    check('D: a day that exists is listed first without the note',
      rows.length > 0 && rows[0].nm === JX && rows[0].dir === 'journal' && !rows[0].note
      && rows.filter((r) => r.nm === JX).length === 1, JSON.stringify(rows.slice(0, 3)));
    await page.keyboard.press('Escape');
    rows = await at(JDOT);
    check('D: a day kept under the old dotted name offers that page',
      rows.length > 0 && rows[0].nm === JOLD && rows[0].dir === 'journal' && !rows[0].note
      && !rows.some((r) => r.nm === JDOT), JSON.stringify(rows.slice(0, 3)));
    await page.keyboard.press('Escape');

    // ── D2. dimmed in the preview, and only there ──
    step = 'D2 preview';
    const BODY = ['# ghosts', '[[' + jd + ']]', '[[' + ROW + ']]', '[[' + SEEDP + ']]', '[[' + MEMK + ']]',
      '[[/' + MEMK + ']]', '[[' + RUN + ']]', '[[' + RUN + '/]]', '[[urb://~zod/x]]', '[[/apps/lattice/forum]]',
      '[[' + BAD + ']]', '[[' + jd + '|the day]]', '[[' + OFF + ']]', ''].join('\n');
    await setText(BODY);
    const gsaved = await waitFor(async () => (await shipBody(G)) === BODY, 15000, 500);
    check('D: the page with the links is saved', !!gsaved);
    //  painted fresh from the ship, as a reload paints it
    await page.evaluate(() => window.latSetRead(true));
    await boot();
    await openWait(G);
    let ls = await waitFor(async () => { const x = await prevLinks(); return linkTo(x, jd) ? x : null; }, 15000, 250);
    const gl = ls && linkTo(ls, jd);
    check('D: the link to the missing day shows the day, dimmed, with its title',
      !!gl && gl.text === JD && gl.cls === 'ghost' && gl.title === jd + ' does not exist yet' && gl.first,
      JSON.stringify(gl));
    check('D: a labelled link to it is dimmed too', !!ls && ls.links.some((l) => l.text === 'the day' && l.cls === 'ghost'),
      JSON.stringify(ls && ls.links.filter((l) => l.text === 'the day')));
    check('D: the preview styles .ghost', !!ls && ls.css);
    await rtab('out');
    const outHas = await waitFor(() => page.evaluate((n) => [...document.querySelectorAll('[data-pane=out] .olrow')]
      .some((r) => r.textContent.trim() === n), jd), 10000, 200);
    check('D: the Outgoing links panel still lists it', !!outHas);
    //  the memory list, so the client knows MEMK is a memory
    await page.evaluate(() => document.querySelector('#ltabs [data-pt=know]').click());
    await sleep(2000);
    await page.evaluate(() => document.querySelector('#ltabs [data-pt=files]').click());
    await sleep(500);
    //  a repaint asks the ship nothing
    const r0 = reqs.length;
    await setText(BODY + ' ');
    await sleep(800);
    const asked = reqs.slice(r0).filter((u) => /page-tree|page-dump|page-source|know-list|page-exists/.test(u));
    check('D: a repaint asks the ship nothing', asked.length === 0, JSON.stringify(asked));
    ls = await prevLinks();
    check('D: and still dims the missing day', linkTo(ls, jd)?.cls === 'ghost', JSON.stringify(linkTo(ls, jd)));
    const plain = [SEEDP, MEMK, '/' + MEMK, RUN, RUN + '/', 'urb://~zod/x', '/apps/lattice/forum', BAD]
      .map((n) => [n, linkTo(ls, n)]);
    check('D: a page, a memory, a folder, an urb:// and an absolute path are not dimmed, nor a refused name',
      plain.every(([, l]) => l && !l.cls && l.first), JSON.stringify(plain.filter(([, l]) => !l || l.cls)));
    await setText(BODY);
    await waitFor(async () => (await shipBody(G)) === BODY && await page.evaluate(() =>
      !window.latTabs.groups().some((g) => g.tabs.some((t) => t.dirty))), 15000, 500);

    // ── D2b. the ship's render, with its ghost marked in it ──
    step = 'D2b ship render';
    await openWait(FN);
    await page.evaluate(() => window.latSetRead(true));
    for (const how of ['opened fresh', 'after a reload (the boot snapshot)']) {
      await boot();
      await openWait(FN);
      const h = await waitFor(async () => {
        const x = await prevHtml();
        return richOk(x) && linkTo(await prevLinks(), FNG)?.cls === 'ghost' ? x : null;
      }, 20000, 250);
      check('D: ' + how + ', a page keeps the ship\'s render (footnote, reference link, setext) with its ghost dimmed',
        !!h, JSON.stringify({ rich: richOk(await prevHtml()), link: linkTo(await prevLinks(), FNG) }));
    }

    // ── D2c. a link to a memory never starts a page ──
    step = 'D2c memory';
    await bootAt('?name=' + encodeURIComponent(MP));
    await openWait(MP);
    await readLocal();
    n0m = saves.length;
    const mclick = await prevClick(MEMK);
    await sleep(5000);
    let fm = await front();
    check('D: with the memory list not loaded, a click on a memory\'s key starts no page',
      mclick && !(fm.name === MEMK && !fm.readOnly) && !saves.slice(n0m).some((x) => x.name === MEMK),
      JSON.stringify({ mclick, fm }));
    await openWait(MP);
    await readLocal();
    const ml = await waitFor(async () => { const x = linkTo(await prevLinks(), MEMK); return x ? x : null; }, 10000, 250);
    check('D: and once the list has loaded the link is not dimmed', !!ml && !ml.cls, JSON.stringify(ml));

    // ── D3. no tree yet, nothing dimmed; the tree comes, the ghosts do ──
    step = 'D3 before the tree';
    //  a load of `n` in Read with no tree kept and the tree's reads held,
    //  its boot snapshot holding the ship's render
    const bootHeld = async (n) => {
      await openWait(n);
      await page.evaluate(() => window.latSetRead(true));
      await sleep(2000);
      await leaving();
      await page.goto(env.app + '/no-such-asset', { timeout: 30000 });
      await page.evaluate(() => new Promise((res) => {
        const rq = indexedDB.open('lattice-offline');
        rq.onsuccess = () => {
          const db = rq.result;
          try {
            const tx = db.transaction([...db.objectStoreNames], 'readwrite');
            for (const s of db.objectStoreNames) if (s !== 'saves') tx.objectStore(s).clear();
            tx.oncomplete = () => res(); tx.onerror = () => res();
          } catch { res(); }
        };
        rq.onerror = () => res();
      }));
      holdDump = [];
      await leaving();
      await page.goto(env.app + '?name=' + encodeURIComponent(n), { waitUntil: 'domcontentloaded', timeout: 90000 });
    };
    //  the held tree reads go, and the tree lands
    const unhold = async () => {
      const h = holdDump;
      holdDump = null;
      for (const r of h) r.continue().catch(() => {});
      await page.waitForFunction(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0
        && !!window.latTabs, { timeout: 90000 });
      return h.length;
    };
    //  writes to the preview frame from now on
    const frameCount = () => page.evaluate(() => {
      window.__fw = 0;
      new MutationObserver((ms) => { window.__fw += ms.length; })
        .observe(document.getElementById('prev'), { attributes: true, attributeFilter: ['srcdoc', 'src'] });
    });
    const frameWrites = () => page.evaluate(() => window.__fw);
    await bootHeld(FN);
    const early = await waitFor(async () => {
      const x = await prevLinks().catch(() => null);
      return x && linkTo(x, FNG) ? x : null;
    }, 15000, 200);
    check('D: painted before the tree, nothing is dimmed', !!early && early.links.every((l) => !l.cls),
      JSON.stringify(early && early.links.filter((l) => l.cls)));
    const held = holdDump;
    holdDump = null;
    for (const r of held) r.continue().catch(() => {});
    const late = await waitFor(async () => {
      const x = await prevLinks().catch(() => null);
      return x && linkTo(x, FNG) && linkTo(x, FNG).cls === 'ghost' && richOk(await prevHtml()) ? x : null;
    }, 30000, 250);
    check('D: and once it lands the missing page is dimmed', !!late, 'held ' + held.length);
    check('D: in the ship\'s render still, the footnote not turned back into text', richOk(await prevHtml()),
      (await prevHtml()).slice(0, 300));
    await page.waitForFunction(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0
      && !!window.latTabs, { timeout: 90000 });
    await sleep(1000);

    //  nothing to mark: the tree's landing leaves the frame alone
    step = 'D3b nothing marked';
    await bootHeld(SEEDP);
    const seedUp = await waitFor(async () => /seed/.test(await prevHtml()), 15000, 200);
    await sleep(3000);
    await frameCount();
    await unhold();
    await sleep(2500);
    let fw = await frameWrites();
    check('D: the tree landing writes the preview again only when it marks something', !!seedUp && fw === 0,
      JSON.stringify({ seedUp, fw }));
    //  the ship's render kept for marking belongs to its own tab: with the
    //  preview hidden it is not painted under another page
    step = 'D3c hidden';
    await bootHeld(FN);
    await waitFor(async () => linkTo(await prevLinks().catch(() => ({ links: [] })), FNG), 15000, 200);
    await page.evaluate(() => window.latSetRead(false));
    fake.set(SEEDP, { status: 200, body: { body: '# seed', kind: 'md', rev: 1, share: 'private' } });
    await page.evaluate((n) => window.latTabs.openIn('page', n), SEEDP);
    const seedIn = await waitFor(async () => (await front()).key === SEEDP, 15000, 200);
    await sleep(1500);
    await frameCount();
    await unhold();
    await sleep(2500);
    fw = await frameWrites();
    check('D: with the preview hidden, the tree landing paints no other page\'s render under the one in front',
      !!seedIn && fw === 0, JSON.stringify({ seedIn, fw }));
    fake.delete(SEEDP);

    // ── D4. every road to a missing page starts it, writing nothing ──
    step = 'D4 preview click';
    let n0 = saves.length;
    await readG();
    const clicked = await prevClick(jd);
    let f = clicked && await started(jd);
    check('D: a click in the preview starts the missing day, named and empty', !!f,
      JSON.stringify({ clicked, f: await front(), tab: await tabName() }));
    step = 'D4 outgoing row';
    await openWait(G);
    await outRow(jd);
    f = await started(jd);
    check('D: so does its Outgoing links row', !!f, JSON.stringify({ f: await front(), tab: await tabName() }));
    step = 'D4 address';
    await bootAt('?name=' + encodeURIComponent(jd));
    f = await started(jd);
    check('D: and so does ?name=' + jd, !!f, JSON.stringify({ f: await front(), tab: await tabName() }));
    await sleep(3000);
    check('D: none of them wrote anything', savesOf(jd).length === 0 && !(await treePages('journal/')).includes(jd),
      JSON.stringify(saves.slice(n0)));
    await leaving();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.latTabs, { timeout: 90000 });
    f = await started(jd);
    check('D: a reload lands on the same started page', !!f, JSON.stringify(await front()));

    // ── D5. a name the ship refuses keeps the locked tab, by every road ──
    step = 'D5 refused name';
    n0 = saves.length;
    await readG();
    const bclick = await prevClick(BAD);
    await sleep(4000);
    f = await front();
    check('D: a click on a refused name opens its tab and starts nothing',
      bclick && f.key === BAD && !(f.name === BAD && !f.readOnly), JSON.stringify(f));
    await openWait(G);
    await outRow(BAD);
    f = await locked(BAD);
    check('D: its Outgoing row opens the locked tab, under exactly that name', !!f, JSON.stringify(await front()));
    await bootAt('?name=' + encodeURIComponent(BAD));
    await sleep(4000);
    f = await front();
    check('D: ?name= of it starts nothing', f.key === BAD && !(f.name === BAD && !f.readOnly), JSON.stringify(f));
    check('D: and nothing was written for it', saves.slice(n0).length === 0, JSON.stringify(saves.slice(n0)));

    // ── D6. a 403, a link whose host is down, and a deleted page ──
    step = 'D6 refusals';
    await boot();
    fake.set(FORB, { status: 403, body: { error: 'forbidden' } });
    await page.evaluate((n) => window.latTabs.openIn('page', n), FORB);
    f = await locked(FORB);
    check('D: a page the ship refuses with 403 shows the locked tab', !!f, JSON.stringify(await front()));
    //  the locked tab shows a name and no page: nothing to move or rename
    const sh0 = await shows();
    await page.evaluate(() => document.getElementById('tpath').click());
    await sleep(1000);
    const mvAsked = await dlgOpen();
    await unstick();
    check('D: Move or rename is not offered on it', !mvAsked && (await shows()) === sh0
      && (await front()).key === FORB, JSON.stringify(await front()));
    fakeLink = { path: LNK, page: true, kind: 'md', rev: 0, size: 0, share: 'private', link: { host: '~sampel-palnet' } };
    fake.set(LNK, { status: 504, body: { error: '~sampel-palnet is unreachable' } });
    await boot();
    await page.evaluate((n) => window.latTabs.openIn('page', n), LNK);
    f = await locked(LNK);
    check('D: a link whose host is down shows the locked tab', !!f, JSON.stringify(await front()));
    fakeLink = null;
    fake.delete(LNK);
    fake.delete(FORB);
    await boot();
    await page.evaluate((n) => window.latTabs.openIn('page', n), DEL);
    f = await waitFor(async () => { const x = await front(); return x.key === DEL && x.src === 'deleted body' ? x : null; }, 30000, 250);
    check('D: a deleted page, which this ship still serves, opens as it does today', !!f, JSON.stringify(await front()));

    // ── D7. offline, a missing page is not started ──
    //  With the page routes cut (saves and this name's read abort) and the
    //  tree loaded, every road the suite can drive fails as it did before
    //  ghost links: nothing started, nothing queued, no save tried. Once
    //  the routes are back, the same link starts the page.
    step = 'D7 offline';
    await boot();
    const qc0 = await qCount();
    const nOff = saves.length;
    shipDown = true;
    fake.set(OFF, 'abort');
    const notStarted = (x) => x.key === OFF && !(x.name === OFF && !x.readOnly) && x.src === '';
    await readG();
    const oclick = await prevClick(OFF);
    await sleep(4000);
    let fo = await front();
    check('D: offline, a click in the preview starts no page', oclick && notStarted(fo), JSON.stringify({ oclick, fo }));
    await openWait(G);
    await outRow(OFF);
    fo = await locked(OFF);
    check('D: offline, its Outgoing row gives the locked tab of a failed open', !!fo, JSON.stringify(await front()));
    await bootAt('?name=' + encodeURIComponent(OFF));
    await sleep(4000);
    fo = await front();
    check('D: offline, ?name= of it starts no page', notStarted(fo), JSON.stringify(fo));
    check('D: offline, nothing is queued and no save is tried', (await qCount()) === qc0 && saves.length === nOff,
      JSON.stringify({ q: await qCount(), q0: qc0, saves: saves.slice(nOff) }));
    shipDown = false;
    fake.delete(OFF);
    await openWait(G);
    await outRow(OFF);
    fo = await started(OFF);
    check('D: once the routes are back, the same link starts it', !!fo, JSON.stringify(await front()));

    // ── D8. left empty, a started page leaves nothing ──
    step = 'D8 empty';
    n0 = saves.length;
    await openWait(G);
    await outRow(ROW);
    f = await started(ROW);
    check('D: an Outgoing row to a page not written starts it', !!f, JSON.stringify({ f: await front(), tab: await tabName() }));
    const nt = f && f.ntabs;
    await page.evaluate((g) => window.latTabs.openIn('page', g, { newTab: true }), G);
    await waitFor(async () => (await front()).key === G, 15000, 250);
    await page.evaluate((n) => window.latTabs.openIn('page', n), ROW);
    const again = await started(ROW);
    const named = await page.evaluate(() => [...document.querySelectorAll('#doctabs .dtab .dtn')].map((x) => x.textContent));
    check('D: opened again, it goes to the tab already started', !!again && again.ntabs === nt + 1
      && named.filter((x) => x === 'not-yet').length === 1, JSON.stringify({ again, named }));
    await page.evaluate(async () => {
      const s = window.latTabs.state();
      await window.latTabs.closeTab(s.tabs[s.active].id);
    });
    await sleep(4000);
    check('D: closed empty, it wrote nothing', savesOf(ROW).length === 0 && !(await treePages(RUN + '/')).includes(ROW),
      JSON.stringify(saves.slice(n0)));

    //  named before its first save: the strip, the address and the saved
    //  tabs follow the new name at once
    step = 'D8b rename started';
    const STR = RUN + '/started-then-named', STR2 = RUN + '/named-at-last';
    await page.evaluate((n) => window.latTabs.openIn('page', n), STR);
    f = await started(STR);
    dlgMeant++;
    await page.evaluate(() => document.getElementById('tpath').click());
    await waitFor(dlgOpen, 5000, 100);
    await page.evaluate((n) => {
      document.getElementById('dlginput').value = n;
      document.getElementById('dlgok').click();
    }, STR2);
    const fol = await waitFor(async () => {
      const x = await front();
      const kept = await page.evaluate(() => localStorage.appTabs || '');
      return x.name === STR2 && x.url === '?name=' + encodeURIComponent(STR2)
        && (await tabName()) === 'named-at-last' && kept.includes(STR2) && !kept.includes(STR) ? x : null;
    }, 5000, 200);
    check('D: a started page named before its first save takes the new name in its tab, the address and the saved tabs',
      !!f && !!fol, JSON.stringify({ f: await front(), tab: await tabName() }));
    await page.evaluate(async () => {
      const s = window.latTabs.state();
      await window.latTabs.closeTab(s.tabs[s.active].id);
    });
    await sleep(1500);

    // ── D9. typed in, it is made under that name, and stops being a ghost ──
    step = 'D9 write';
    await bootAt('?name=' + encodeURIComponent(jd));
    await started(jd);
    const TJ = 'a day written from a link ' + RUN;
    await typeIn(TJ);
    const made = await waitFor(async () => (await shipBody(jd)) === TJ && (await treePages('journal/')).includes(jd), 20000, 500);
    check('D: typing saves it under exactly that name, as a create', !!made && savesOf(jd)[0]?.isNew === true,
      JSON.stringify(savesOf(jd)));
    const own = await waitFor(async () => { const x = await front(); return x.key === jd && x.name === jd ? x : null; }, 10000, 250);
    check('D: and its tab is the page now', !!own, JSON.stringify(await front()));
    await readG();
    ls = await waitFor(async () => { const x = await prevLinks(); return linkTo(x, jd) ? x : null; }, 15000, 250);
    check('D: the link is not dimmed on the next paint', !!ls && !linkTo(ls, jd).cls, JSON.stringify(ls && linkTo(ls, jd)));
    await openWait(jd);
    await rtab('back');
    const bl = await waitFor(() => page.evaluate(() => {
      const l = [...document.querySelectorAll('#linklist a')].map((a) => a.textContent);
      return l.length ? l : null;
    }), 30000, 500);
    check('D: the new page\'s Backlinks lists the linking page', !!bl && bl.includes(G), JSON.stringify(bl));

    // ── D10. the PDF export carries no ghost styling ──
    step = 'D10 pdf';
    await openWait(G);
    await page.evaluate(() => { const x = document.querySelector('iframe[data-lat-pdf]'); if (x) x.remove(); });
    await page.click('#tmenu');
    await page.waitForSelector('.tmenu [data-mi="pdf"]', { visible: true, timeout: 5000 });
    await page.click('.tmenu [data-mi="pdf"]');
    const pdf = await waitFor(() => page.evaluate((args) => {
      const x = document.querySelector('iframe[data-lat-pdf]');
      const d = x && x.contentDocument;
      if (!d || d.readyState !== 'complete') return null;
      const [ghostHref, plainHref] = args;
      const g = d.querySelector('a[href*="' + ghostHref + '"]'), p = d.querySelector('a[href*="' + plainHref + '"]');
      if (!g || !p) return null;
      const cs = (e) => { const c = getComputedStyle(e); return [c.color, c.opacity, c.fontStyle, c.textDecorationLine].join(' '); };
      return { css: /\.ghost\s*\{/.test(x.srcdoc), ghost: cs(g), plain: cs(p), cls: g.className,
        marked: /class="ghost"|does not exist yet/.test(x.srcdoc) };
    }, [encodeURIComponent(ROW), encodeURIComponent(SEEDP)]), 60000, 500);
    check('D: the PDF export draws a missing page\'s link as any other', !!pdf && !pdf.css && pdf.ghost === pdf.plain,
      JSON.stringify(pdf));
    check('D: and carries neither the class nor the title', !!pdf && !pdf.marked, JSON.stringify(pdf));

    step = 'D end';
    check('D: no native dialog at any point', natives === 0, JSON.stringify(nativeSeen));
    const allDlg = await dlgSum();
    check('D: the editor\'s dialog opened only where the suite opened it', allDlg === dlgMeant,
      JSON.stringify({ shown: allDlg, meant: dlgMeant }));
  }
  if (on('E')) {
    //  the page hidden, as a phone locked or another app in front makes it,
    //  and shown again (which also reads the tree and the page again)
    const hide = (h) => page.evaluate((x) => {
      if (x) {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      } else { delete document.hidden; delete document.visibilityState; }
      document.dispatchEvent(new Event('visibilitychange'));
    }, h);
    const status = () => page.evaluate(() => document.getElementById('status').textContent);
    const ctrlS = async () => {
      await page.focus('#src');
      await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control');
    };
    //  whether the offline queue holds a record for `n`
    const qHas = (n) => page.evaluate((x) => new Promise((res) => {
      const rq = indexedDB.open('lattice-offline');
      rq.onsuccess = () => {
        try {
          const g = rq.result.transaction('saves', 'readonly').objectStore('saves').get(x);
          g.onsuccess = () => res(!!g.result); g.onerror = () => res(false);
        } catch { res(false); }
      };
      rq.onerror = () => res(false);
    }), n);
    const nameIt = async (n) => {
      dlgMeant++;
      await page.evaluate(() => document.getElementById('tpath').click());
      await waitFor(dlgOpen, 5000, 100);
      await page.evaluate((x) => {
        document.getElementById('dlginput').value = x;
        document.getElementById('dlgok').click();
      }, n);
    };
    let f, n0;

    // ── E1. hidden at once: the save goes without the debounce ──
    step = 'E1 hidden';
    await boot();
    await plus();
    await sleep(500);
    n0 = saves.length;
    const TH = 'hidden at once ' + RUN;
    await setText(TH);
    const tH = Date.now();
    await hide(true);
    const sentH = await waitFor(async () => saves.slice(n0).find((x) => x.isNew && INBOX.test(x.name)) || null, 5000, 50);
    await hide(false);
    check('E: text typed and the page hidden at once is saved without waiting out the debounce',
      !!sentH && sentH.at - tH < 1500, sentH ? (sentH.at - tH) + ' ms' : 'not sent');
    const nameH = await landed();
    check('E: and it lands in the Inbox', !!nameH && INBOX.test(nameH) && (await shipBody(nameH)) === TH, String(nameH));
    await page.evaluate(() => { localStorage.latAutosave = '0'; });
    await plus();
    await sleep(500);
    n0 = saves.length;
    const TO = 'hidden, autosave off ' + RUN;
    await setText(TO);
    await hide(true);
    await sleep(3000);
    await hide(false);
    check('E: with autosave off, hiding the page sends nothing', saves.length === n0, JSON.stringify(saves.slice(n0)));
    await ctrlS();
    const nameO = await landed();
    check('E: and Ctrl+S still captures it', !!nameO && (await shipBody(nameO)) === TO, String(nameO));
    await page.evaluate(() => { localStorage.removeItem('latAutosave'); });

    // ── E2. deleted elsewhere: nothing written until a save on purpose ──
    step = 'E2 deleted elsewhere';
    const GONE = RUN + '/gone-elsewhere', GONE2 = RUN + '/gone-named-anew';
    await apiMake(GONE, 'was here');
    await boot();
    await openWait(GONE);
    //  this kernel keeps answering for a deleted page, so the tree without
    //  it and the 404 the live refresh would see are the suite's
    hideRows.add(GONE);
    fake.set(GONE, { status: 404, body: { error: 'no such page' } });
    await hide(true);
    await hide(false);
    const marked = await waitFor(async () => /deleted elsewhere/.test(await status()), 20000, 200);
    check('E: the page in front answering 404 is taken as deleted elsewhere', !!marked, await status());
    n0 = saves.length;
    await typeIn(' and more');
    await sleep(4000);
    f = await front();
    check('E: typing on it sends no page-save, past the autosave delay', !!marked && saves.length === n0,
      JSON.stringify(saves.slice(n0)));
    check('E: and its text stays in the editor', f.src.includes('was here') && f.src.includes('and more'), JSON.stringify(f));
    await ctrlS();
    const re = await waitFor(async () => saves.slice(n0).find((x) => x.name === GONE) || null, 10000, 200);
    check('E: Ctrl+S then sends it, as a create', !!re && re.isNew, JSON.stringify(saves.slice(n0)));
    fake.delete(GONE);
    hideRows.delete(GONE);
    //  a new name is another page: autosave makes it
    await nameIt(GONE2);
    const re2 = await waitFor(async () => (await shipBody(GONE2)) || null, 30000, 500);
    check('E: named anew, it is saved under the new name', !!re2 && re2.includes('and more'), String(re2));

    // ── E3. a same-tab reopen of a page that vanished starts nothing ──
    step = 'E3 reopen';
    const VAN = RUN + '/vanishing';
    await apiMake(VAN, 'first');
    await api('page-save?type=md&name=' + encodeURIComponent(VAN), { method: 'POST', body: 'second' });
    await boot();
    await openWait(VAN);
    await page.evaluate(() => document.querySelector('#rtabs [data-pt=hist]').click());
    const chip = await waitFor(() => page.evaluate(() => {
      const a = document.querySelector('#histlist a');
      if (a) a.click();
      return !!a;
    }), 20000, 300);
    const inRev = await waitFor(() => page.evaluate(() => !document.getElementById('histview').hidden), 15000, 200);
    //  the tree is read again without the page, and the ship says 404
    hideRows.add(VAN);
    fake.set(VAN, { status: 404, body: { error: 'no such page' } });
    const d0 = reqs.filter((u) => /\/page-dump/.test(u)).length;
    await apiMake(RUN + '/bump', 'a change, so the tree is read again');
    const reread = await waitFor(() => reqs.filter((u) => /\/page-dump/.test(u)).length > d0, 20000, 200);
    await sleep(2500);
    n0 = saves.length;
    await page.evaluate(() => document.getElementById('hback').click());
    await sleep(4000);
    f = await front();
    check('E: History\'s back to latest on a page that vanished starts no page in its place',
      !!chip && !!inRev && !!reread && !(f.name === VAN && !f.readOnly && f.src === '') && saves.length === n0,
      JSON.stringify({ chip, inRev, reread, f, saves: saves.slice(n0) }));
    hideRows.delete(VAN);
    fake.delete(VAN);

    // ── E4. a page started with its name, offline: kept here, not queued ──
    //  startNamed is what the brief button calls for a journal day not
    //  written yet (today's real day is never touched)
    step = 'E4 named offline';
    const DAY = RUN + '/offline-day', DAY2 = RUN + '/offline-day-2';
    await boot();
    await plus();
    await sleep(500);
    await page.evaluate((n) => window.latStartNamed(n), DAY);
    const st0 = await waitFor(async () => (await front()).name === DAY, 5000, 100);
    const qc0 = await qCount();
    shipDown = true;
    n0 = saves.length;
    const TD = 'a day typed offline ' + RUN;
    await typeIn(TD);
    await sleep(9000);       // the debounce, a write that fails, and a retry
    f = await front();
    const stD = await status();
    check('E: offline, typing on a page started with its name queues no create', !!st0 && (await qCount()) === qc0,
      JSON.stringify({ q: await qCount(), qc0, saves: saves.slice(n0) }));
    check('E: its text stays in the editor, under its name, not saved', f.src === TD && f.name === DAY
      && !f.readOnly && !f.key, JSON.stringify(f));
    check('E: the status says it is not saved because the ship is unreachable', /not saved/.test(stD) && /unreachable/.test(stD), stD);
    check('E: and autosave tries again', saves.slice(n0).filter((x) => x.name === DAY).length >= 2,
      JSON.stringify(saves.slice(n0)));
    shipDown = false;
    const madeD = await waitFor(async () => (await shipBody(DAY)) === TD && (await front()).key === DAY, 30000, 500);
    const lastD = saves.filter((x) => x.name === DAY).pop();
    check('E: once the routes answer, autosave makes it, as a checked create',
      !!madeD && !!lastD && lastD.isNew && (await qCount()) === qc0, JSON.stringify({ lastD, f: await front() }));

    step = 'E4 Ctrl+S offline';
    await plus();
    await sleep(500);
    await page.evaluate((n) => window.latStartNamed(n), DAY2);
    await waitFor(async () => (await front()).name === DAY2, 5000, 100);
    shipDown = true;
    const TD2 = 'saved on purpose offline ' + RUN;
    await typeIn(TD2);
    await ctrlS();
    const q2 = await waitFor(async () => (await qCount()) === qc0 + 1, 15000, 200);
    f = await front();
    check('E: offline, Ctrl+S on such a page queues it, as it always has', !!q2 && f.key === DAY2 && f.readOnly,
      JSON.stringify({ q: await qCount(), f }));
    shipDown = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const l2 = await waitFor(async () => (await qCount()) === qc0 && (await shipBody(DAY2)) === TD2, 30000, 500);
    check('E: and it lands once the routes answer', !!l2, JSON.stringify({ q: await qCount(), body: await shipBody(DAY2) }));

    // ── E5. offline, a draw skips an Inbox name this device knows ──
    step = 'E5 offline draw';
    if (!nameH) console.log('  note - E1 made no capture: the offline draw was not checked');
    else {
      const dH = +nameH.slice(-4);
      await page.evaluate((x, y) => {
        const orig = Math.random;
        window.__rq = [x, y];
        Math.random = () => (window.__rq.length ? window.__rq.shift() : orig());
      }, (dH + 0.5) / 10000, ((dH + 5000) % 10000 + 0.5) / 10000);
      const qc1 = await qCount();
      shipDown = true;
      await plus();
      await sleep(500);
      const TX = 'drawn offline ' + RUN;
      await setText(TX);
      const qx = await waitFor(async () => (await qCount()) === qc1 + 1, 15000, 200);
      f = await front();
      const xName = f.key;
      check('E: offline, a draw equal to an Inbox page this device knows is drawn again',
        !!qx && INBOX.test(xName || '') && xName !== nameH, JSON.stringify({ nameH, f }));
      check('E: and nothing is queued under the known name, so its local copy is untouched', !(await qHas(nameH)));
      shipDown = false;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const xl = await waitFor(async () => (await qCount()) === qc1 && (await shipBody(xName)) === TX, 30000, 500);
      check('E: once back, the capture lands under its own name, and the known page keeps its text',
        !!xl && (await shipBody(nameH)) === TH, JSON.stringify({ x: await shipBody(xName), h: await shipBody(nameH) }));
    }

    // ── E6. a display name stays with the page it was given to ──
    step = 'E6 display name';
    const NL = RUN + '/named-later';
    await plus();
    await sleep(500);
    const namedTab = (await front()).id;
    await nameIt(RUN + '/Named Later');
    const nl = await waitFor(async () => (await front()).name === NL, 5000, 100);
    await plus();
    await sleep(500);
    n0 = saves.length;
    const TC = 'another capture ' + RUN;
    await setText(TC);
    const nc = await landed();
    const cs = saves.slice(n0).filter((x) => x.name === nc && x.isNew);
    check('E: a capture saved in another tab takes no display name from a page named and not written',
      !!nl && !!nc && cs.length > 0 && cs.every((x) => !x.dn), JSON.stringify(cs));
    await page.evaluate((id) => window.latTabs.switchTab(id), namedTab);
    await waitFor(async () => (await front()).name === NL, 10000, 200);
    const TN = 'the named page ' + RUN;
    await typeIn(TN);
    const nlm = await waitFor(async () => (await shipBody(NL)) === TN, 30000, 500);
    const ns = saves.find((x) => x.name === NL && x.isNew);
    check('E: and the page named keeps it for its own first save', !!nlm && !!ns && ns.dn === 'Named Later',
      JSON.stringify(ns));

    step = 'E end';
    check('E: no native dialog at any point', natives === 0, JSON.stringify(nativeSeen));
    const allDlg = await dlgSum();
    check('E: the editor\'s dialog opened only where the suite opened it', allDlg === dlgMeant,
      JSON.stringify({ shown: allDlg, meant: dlgMeant }));
  }

  const status = () => page.evaluate(() => document.getElementById('status').textContent);
  if (on('F')) {
    // ── F1. a named page's create lands, and the browser sees a timeout ──
    step = 'F1 create cut';
    const FN = RUN + '/cut-create';
    const cf0 = await treePages('conflicts/');
    await boot();
    await plus();
    await sleep(500);
    await page.evaluate((n) => window.latStartNamed(n), FN);
    const sF = await waitFor(async () => (await front()).name === FN, 5000, 100);
    landCut.add(FN);
    const T1 = 'first words ' + RUN;
    await typeIn(T1);
    const cut = await waitFor(async () => !landCut.has(FN) && (await shipBody(FN)) === T1, 20000, 200);
    const T2 = ' and more typed after';
    await typeIn(T2);
    const both = await waitFor(async () => (await shipBody(FN)) === T1 + T2
      && (await front()).key === FN, 40000, 500);
    let f = await front();
    check('F: a named page whose create landed unseen takes the text typed after it',
      !!sF && !!cut && !!both, JSON.stringify({ body: await shipBody(FN), f, st: await status() }));
    check('F: and it is the page in front, under its name', f.key === FN && f.readOnly, JSON.stringify(f));
    const cf1 = (await treePages('conflicts/')).filter((n) => !cf0.includes(n));
    check('F: and no conflicts/ copy is made of it', !cf1.length, JSON.stringify(cf1));

    // ── F2. the same, when the page there is not ours: never written over ──
    step = 'F2 create cut, page theirs';
    const FO = RUN + '/cut-theirs';
    await plus();
    await sleep(500);
    await page.evaluate((n) => window.latStartNamed(n), FO);
    await waitFor(async () => (await front()).name === FO, 5000, 100);
    const n0 = saves.length;
    shipDown = true;
    await typeIn('mine ' + RUN);
    await waitFor(() => saves.slice(n0).some((x) => x.name === FO && x.isNew) || null, 10000, 100);
    await sleep(500);
    const THEIRS = 'made elsewhere ' + RUN;
    await apiMake(FO, THEIRS);
    shipDown = false;
    const refused = await waitFor(async () => /already exists/.test(await status()) || null, 20000, 200);
    f = await front();
    check('F: a page under that name holding other text is left as it is',
      !!refused && (await shipBody(FO)) === THEIRS && !f.key && !f.readOnly,
      JSON.stringify({ body: await shipBody(FO), f, st: await status() }));
  }
} catch (e) {
  check('step "' + step + '" threw: ' + String(e.message).slice(0, 160), false);
} finally {
  try {
    shipDown = false;
    for (const n of await inboxOnShip())
      if (made.has(n)) await api('page-del?name=' + encodeURIComponent(n), { method: 'POST' });
    await api('page-del?name=' + encodeURIComponent(RUN), { method: 'POST' });
    //  D's far-future days are its own and never made again
    for (const n of journalMade) await api('page-del?name=' + encodeURIComponent(n), { method: 'POST' });
    for (const k of memMade) await api('know-delete?key=' + encodeURIComponent(k), { method: 'POST' });
    //  a journal day the brief check made is left: deleted, the ship would
    //  refuse to make it again, and ui-shell.mjs makes and opens it too
  } catch {}
  await browser.close();
}

check.done();
