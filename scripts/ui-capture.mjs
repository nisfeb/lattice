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
//  ONLY=A runs just that section after the setup.
//
//  Usage: LATTICE_URL=http://localhost:<port> LATTICE_COOKIE=<cookie file> \
//           node scripts/ui-capture.mjs
//  Env:   LATTICE_URL, LATTICE_COOKIE, CHROME (as ui-offline.mjs). A
//         throwaway ship only: it writes and deletes inbox/ pages.
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
page.on('dialog', (d) => { natives++; d.accept().catch(() => {}); });
//  every time the editor's own dialog is shown, from the first paint on
await page.evaluateOnNewDocument(() => {
  window.__dlgShows = 0;
  new MutationObserver((ms) => {
    for (const m of ms) if (m.target.id === 'dlg' && !m.target.hidden) window.__dlgShows++;
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
});

//  the outage, as ui-offline.mjs makes it: the save and probe routes abort
let shipDown = false;
const saves = [];          // every page-save the editor sent: {name, type, isNew}
await page.setRequestInterception(true);
page.on('request', (r) => {
  const u = r.url();
  if (/\/page-save\?/.test(u)) {
    const q = new URL(u).searchParams;
    saves.push({ name: q.get('name'), type: q.get('type'), isNew: q.get('new') === '1' });
  }
  const down = shipDown && /page-save|legacy-status|page-cmd|know-save/.test(u);
  (down ? r.abort() : r.continue()).catch(() => {});
});

const api = (p, init = {}) => fetch(env.base + '/apps/lattice/' + p,
  { ...init, headers: { Cookie: env.cookie, ...(init.headers || {}) } });
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
//  the front page's name once its first save landed: in the field, locked
const landed = (ms = 9000) => waitFor(async () => {
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

let step = 'setup';
let baseline = [];
let journal = null;
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
  baseline = await inboxOnShip();
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

    // ── A2. text typed is saved in the Inbox within the autosave delay ──
    step = 'A2 typed';
    const T1 = 'capture one ' + RUN;
    const t0 = Date.now();
    await typeIn(T1);
    const name1 = await landed();
    const secs = (Date.now() - t0) / 1000;
    check('A: typed text is saved under inbox/<date>-NNNN', !!name1 && INBOX.test(name1), String(name1));
    check('A: within the autosave delay (2 s and the round trip)', !!name1 && secs < 8, secs.toFixed(1) + ' s');
    check('A: the name carries today\'s local date', !!name1 && name1.slice(6, 16) === await today(), name1);
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
    step = 'A4 clash';
    const nn = 1000 + (process.pid % 8000);
    const a = (nn + 0.5) / 10000, b = (nn + 1 + 0.5) / 10000;
    await page.evaluate((x) => {
      const orig = Math.random;
      window.__rq = [x];
      Math.random = () => (window.__rq.length ? window.__rq.shift() : orig());
    }, a);
    await plus();
    await sleep(500);
    const T3 = 'clash first ' + RUN;
    await setText(T3);
    const name3 = await landed();
    check('A: a stubbed draw names the page', !!name3 && name3.endsWith('-' + nn), String(name3));
    await page.evaluate((x, y) => { window.__rq = [x, y]; }, a, b);
    await plus();
    await sleep(500);
    const T4 = 'clash second ' + RUN;
    n0 = saves.length;
    await setText(T4);
    const name4 = await landed(15000);
    check('A: the same draw again still lands, under a new name',
      !!name4 && name4 !== name3 && name4.endsWith('-' + (nn + 1)), JSON.stringify([name3, name4]));
    check('A: the taken name was tried first', saves.slice(n0).some((x) => x.name === name3 && x.isNew));
    check('A: both pages hold their own text',
      !!name3 && !!name4 && (await shipBody(name3)) === T3 && (await shipBody(name4)) === T4);

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

    step = 'A6 close';
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
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => !!window.latTabs, { timeout: 90000 });
    await sleep(2000);
    check('A: the queued capture survives a reload', (await qCount()) === 1, 'q=' + await qCount());
    shipDown = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const q0 = await waitFor(async () => (await qCount()) === 0, 30000, 500);
    check('A: it lands when the routes answer again', !!q0 && (await shipBody(name8)) === T8,
      JSON.stringify({ q: await qCount(), body: await shipBody(name8) }));
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
    const addf = () => page.evaluate((r) => {
      const a = [...document.querySelectorAll('#treelist a.addf')].find((x) => x.title === 'new file in ' + r);
      if (a) a.click();
      return !!a;
    }, RUN);
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
    await addf();
    await waitFor(dlgOpen, 5000, 100);
    await page.keyboard.press('Escape');
    await sleep(1500);
    const fe2 = await front();
    check('A: Escape changes nothing', !(await dlgOpen()) && saves.length === n0
      && fe2.key === fe.key && fe2.ntabs === fe.ntabs, JSON.stringify([fe, fe2]));

    step = 'A9 tree menu';
    await page.evaluate((r) => window.latTreeMenu.open('f:' + r), RUN);
    await page.evaluate(() => document.querySelector('.treemenu [data-mi="new"]').click());
    const tm = await waitFor(dlgOpen, 5000, 100);
    check('A: the tree menu\'s New page here still shows the dialog', !!tm);
    await unstick();

    // ── A10. Move or rename ──
    step = 'A10 move captured';
    await plus();
    await sleep(500);
    const T12 = 'to be moved ' + RUN;
    await setText(T12);
    const name12 = await landed();
    await page.evaluate(() => document.getElementById('tpath').click());
    await waitFor(dlgOpen, 5000, 100);
    const moved = RUN + '/moved';
    await page.evaluate((n) => {
      document.getElementById('dlginput').value = n;
      document.getElementById('dlgok').click();
    }, moved);
    const mv = await waitFor(async () => (await shipBody(moved)) === T12, 15000, 500);
    check('A: Move or rename moves a captured page', !!mv && !(await inboxOnShip()).includes(name12),
      JSON.stringify({ name12, moved: await shipBody(moved) }));
    check('A: and the editor follows it', (await front()).key === moved, JSON.stringify(await front()));

    step = 'A10 name unsaved';
    before = await inboxOnShip();
    await plus();
    await sleep(500);
    const T13 = 'named before its save ' + RUN;
    await setText(T13);
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

    // ── A12. a journal day from the brief button ──
    step = 'A12 journal';
    const jn = 'journal/' + await today();
    if ((await treePages('journal/')).includes(jn)) {
      check('A: (skipped) today\'s journal already exists on this ship', true);
    } else {
      await page.evaluate(() => document.getElementById('rb-brief').click());
      const jup = await waitFor(async () => (await front()).name === jn, 10000);
      check('A: the brief button starts today\'s journal, named', !!jup, JSON.stringify(await front()));
      const T15 = 'journal line ' + RUN;
      await typeIn(T15);
      journal = jn;
      const js = await waitFor(async () => (await shipBody(jn)) === T15, 12000, 500);
      check('A: the journal day is saved once it has text', !!js);
    }

    step = 'A end';
    check('A: no native dialog at any point', natives === 0, 'natives=' + natives);
  }
} catch (e) {
  check('step "' + step + '" threw: ' + String(e.message).slice(0, 160), false);
} finally {
  try {
    shipDown = false;
    for (const n of await inboxOnShip())
      if (!baseline.includes(n)) await api('page-del?name=' + encodeURIComponent(n), { method: 'POST' });
    await api('page-del?name=' + encodeURIComponent(RUN), { method: 'POST' });
    if (journal) await api('page-del?name=' + encodeURIComponent(journal), { method: 'POST' });
  } catch {}
  await browser.close();
}

check.done();
