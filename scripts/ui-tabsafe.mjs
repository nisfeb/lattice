#!/usr/bin/env node
//  ui-tabsafe.mjs: saves that land after the editor has moved on, and the
//  ways into the editor that used to skip a tab or a question.
//
//    a memory created and then left at once (a page opened while its write
//      is in flight) never takes over the page's tab, and the page's typing
//      is saved to the page, not to a page named after the memory
//    a create that fails does not strand the create queued behind it: the
//      second page still lands, and the failed one leaves no tree row
//    clicking a folder with unsaved text in front asks (a grub) or saves
//      (a page) before the folder paints over it
//    a folder can be deleted from the page menu
//    New page with a tool tab in front opens the page in a document tab
//    a memory moved while another tab comes forward renames only its own
//      tab, and the document in front keeps its name
//
//  The slow and failing writes are made by holding or answering the
//  request in the browser (request interception), so every race here is
//  deterministic. Everything seeded is under one run folder and deleted.
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-tabsafe.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, seed, sleep } from './lib/harness.mjs';

const env = shipEnv();
const RUN = 'ts-' + process.pid;
const P = RUN + '/p', Q = RUN + '/q', G = RUN + '/g', D = RUN + '/doomed/x';
const K1 = RUN + '-k1';            // New memory in C1
const K6 = RUN + '-k6', K6B = RUN + '-k6b';
const A1 = RUN + '/fail-a', B1 = RUN + '/then-b', N4 = RUN + '/from-tool';

const check = makeCheck();
//  ONLY=C1,I3 runs just those sections (each stands alone)
const on = (id) => !process.env.ONLY || process.env.ONLY.split(',').includes(id);
const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false),
});
page.on('dialog', (d) => d.accept().catch(() => {}));

//  rule(req): a number holds the request that many ms, 'fail' answers 500
//  after `failAfter` ms, anything else lets it through. seen collects urls.
let rule = null;
let failAfter = 0;
const seen = [];
await page.setRequestInterception(true);
page.on('request', (r) => {
  const act = rule ? rule(r) : null;
  if (act) seen.push(r.url());
  if (act === 'fail') {
    setTimeout(() => r.respond({ status: 500, contentType: 'text/plain', body: 'test failure' })
      .catch(() => {}), failAfter);
  } else if (typeof act === 'number') setTimeout(() => r.continue().catch(() => {}), act);
  else r.continue().catch(() => {});
});

const shipGet = async (path) => {
  const r = await fetch(env.base + '/apps/lattice/' + path, { headers: { Cookie: env.cookie } });
  return r.ok ? r.json() : null;
};
const pageBody = async (name) => {
  const j = await shipGet('page-source?name=' + encodeURIComponent(name));
  return j ? (j.body || '') : null;
};
const boot = async (url = env.app) => {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  await sleep(800);
};
const state = () => page.evaluate(() => window.latTabs.state());
const front = async () => { const s = await state(); return s.tabs[s.active]; };
const waitOn = async (kind, key) => {
  try {
    await page.waitForFunction((k, y) => {
      const s = window.latTabs && window.latTabs.state();
      return !!s && s.active >= 0 && s.tabs[s.active].kind === k && s.tabs[s.active].key === y && s.shows
        && !document.getElementById('src').readOnly;
    }, { timeout: 30000 }, kind, key);
    return true;
  } catch { return false; }
};
const until = async (fn, arg, ms = 30000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    if (await page.evaluate(fn, arg)) return true;
    await sleep(250);
  }
  return false;
};
const dlgUp = () => until(() => !document.getElementById('dlg').hidden, null, 8000);
const dlgAnswer = (value, kind) => page.evaluate((v, k) => {
  const i = document.getElementById('dlginput');
  if (v !== null) { i.value = v; i.dispatchEvent(new Event('input')); }
  if (k) document.getElementById('dlgkind').value = k;
  document.getElementById('dlgok').click();
}, value, kind);
const row = (name) => '#treelist a.pg[href$="name=' + encodeURIComponent(name) + '"]';
const tabSel = (kind, key) => `#doctabs .dtab[data-kind="${kind}"][data-key="${key}"]`;
const typeEnd = async (text) => {
  await page.focus('#src');
  await page.evaluate(() => { const s = document.getElementById('src'); s.setSelectionRange(s.value.length, s.value.length); });
  await page.keyboard.type(text);
};
//  a folder row's pick: the row itself (the arrow only folds)
const pickFolder = (path) => page.evaluate((p) => {
  const leaf = p.split('/').pop();
  const r = [...document.querySelectorAll('#treelist .fld')]
    .find((f) => f.querySelector('.fln').textContent === leaf);
  if (r) r.click();
  return !!r;
}, path);
const newPage = async (name) => {
  await page.evaluate(() => document.getElementById('newfile').click());
  if (!(await dlgUp())) return false;
  await dlgAnswer(name, 'md');
  return until(() => document.getElementById('dlg').hidden, null, 8000);
};

let grub = null;
const cleanup = [];
try {
  await seed(env, [[P, 'page p\n'], [Q, 'page q\n'], [G, 'grub g\n'], [D, 'doomed\n']]);
  await fetch(env.base + '/apps/lattice/know-save?key=' + encodeURIComponent(K6),
    { method: 'POST', headers: { Cookie: env.cookie }, body: 'memory six\n' });
  const base = (await (await fetch(env.base + '/apps/lattice/streams',
    { headers: { Cookie: env.cookie } })).json()).base;
  grub = base + '/page/' + G + '/code';

  await page.goto(env.app + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(() => { localStorage.removeItem('appTabs'); localStorage.removeItem('appPage'); });
  await boot();
  await sleep(8000);   // the service worker's one reload on a fresh profile
  await page.waitForFunction(() => document.querySelectorAll('#treelist a.pg').length > 0, { timeout: 90000 });
  await page.waitForSelector(row(P), { timeout: 30000 });

  if (on('C1')) {
    // ── C1: New memory, then a page opened while its write is in flight ──
    rule = (r) => (/\/know-save\?/.test(r.url()) ? 4000 : null);
    seen.length = 0;
    await page.evaluate(() => document.getElementById('knew').click());
    await dlgUp();
    await dlgAnswer(K1, null);
    for (let i = 0; i < 80 && !seen.length; i++) await sleep(100);
    await page.click(row(P));
    await waitOn('page', P);
    await typeEnd('C1TYPED');
    await sleep(9000);     // the memory lands at 4s, the page's autosave after
    rule = null;
    const c1 = {
      tab: await front(),
      pname: await page.evaluate(() => document.getElementById('pname').value),
      p: await pageBody(P),
      stray: await pageBody(K1),
      mem: !!(await shipGet('know-read?key=' + encodeURIComponent(K1))),
    };
    check('C1: a memory landing late leaves the page tab and its name alone',
      c1.tab.kind === 'page' && c1.tab.key === P && c1.pname === P, JSON.stringify(c1));
    check('C1: the page typing is saved to the page, and no page takes the memory\'s name',
      (c1.p || '').includes('C1TYPED') && c1.stray === null && c1.mem, JSON.stringify(c1));
  }

  if (on('I1')) {
    // ── I1: the first create fails, the second queued behind it lands ────
    failAfter = 3000;
    rule = (r) => (/\/page-save\?/.test(r.url()) && r.url().includes(encodeURIComponent(A1)) ? 'fail' : null);
    await newPage(A1);
    await newPage(B1);
    let b1 = null;
    for (let i = 0; i < 40 && b1 === null; i++) { await sleep(500); b1 = await pageBody(B1); }
    await sleep(1000);
    rule = null;
    const i1 = {
      b1, a1: await pageBody(A1), tab: await front(),
      rows: await page.evaluate((a, b) => ({
        a: !!document.querySelector('#treelist a.pg[href$="name=' + encodeURIComponent(a) + '"]'),
        b: document.querySelector('#treelist a.pg[href$="name=' + encodeURIComponent(b) + '"]')?.className ?? null,
      }), A1, B1),
    };
    check('I1: a failed create does not lose the create queued behind it',
      i1.b1 !== null && i1.a1 === null && i1.tab.key === B1, JSON.stringify(i1));
    check('I1: the tree keeps the second page, settled, and drops the failed one',
      !i1.rows.a && i1.rows.b !== null && !/pend/.test(i1.rows.b), JSON.stringify(i1.rows));
  }

  if (on('I1')) {
    // ── I1: three News while the first create is held: all three land ──
    const T = [RUN + '/three-a', RUN + '/three-b', RUN + '/three-c'];
    rule = (r) => (/\/page-save\?/.test(r.url()) && r.url().includes(encodeURIComponent(T[0])) ? 3000 : null);
    for (const t of T) await newPage(t);
    let got = [];
    for (let i = 0; i < 60; i++) {
      got = await Promise.all(T.map(pageBody));
      if (got.every((b) => b !== null)) break;
      await sleep(500);
    }
    rule = null;
    const fr = await front();
    check('I1: creates queued behind a slow one all land, and the editor names the last',
      got.every((b) => b !== null) && fr.key === T[2], JSON.stringify({ got, fr }));
    cleanup.push(...T);
  }

  if (on('I2')) {
    // ── I2: a folder click with unsaved text in front ─────────────────────
    await page.click(row(P));
    await waitOn('page', P);
    await typeEnd('I2PAGE');
    await pickFolder(RUN);
    await until(() => document.getElementById('pname').readOnly
      && !document.querySelector('#treelist a.pg.cur'), null, 30000);
    await sleep(500);
    const i2p = await pageBody(P);
    check('I2: a folder click saves the page typed into first', (i2p || '').includes('I2PAGE'),
      JSON.stringify({ i2p }));
    await page.evaluate((p) => { window.latTabs.openIn('grub', p, { newTab: true }); }, grub);
    await waitOn('grub', grub);
    await typeEnd('I2GRUB');
    await pickFolder(RUN);
    const asked = await dlgUp();
    await page.evaluate(() => document.getElementById('dlgcancel').click());
    await sleep(500);
    const i2g = await page.evaluate(() => ({ text: document.getElementById('src').value,
      grub: !!window.latTabs.state().shows }));
    check('I2: a folder click over a dirty grub asks, and cancel keeps the text',
      asked && i2g.text.includes('I2GRUB'), JSON.stringify({ asked, i2g }));
    //  leave the grub unsaved and closed
    await page.evaluate(async (p) => {
      const t = window.latTabs.list().find((x) => x.kind === 'grub' && x.key === p);
      if (t) window.latTabs.closeTab(t.id);
    }, grub);
    if (await dlgUp()) await page.evaluate(() => document.getElementById('dlgok').click());
    await sleep(800);
  }

  if (on('I3')) {
    // ── I3: delete a folder from the page menu ────────────────────────────
    await boot();
    await pickFolder(RUN + '/doomed');
    await until(() => document.getElementById('pname').readOnly, null, 10000);
    await page.click('#tmenu');
    await sleep(200);
    const hasDel = await page.evaluate(() => !!document.querySelector('.tmenu [data-mi="del"]'));
    if (hasDel) {
      await page.evaluate(() => document.querySelector('.tmenu [data-mi="del"]').click());
      const conf = await dlgUp();
      const what = await page.evaluate(() => document.getElementById('dlg').textContent);
      await page.evaluate(() => document.getElementById('dlgok').click());
      let gone = false;
      for (let i = 0; i < 40 && !gone; i++) { await sleep(500); gone = (await pageBody(D)) === null; }
      check('I3: the page menu deletes a folder, through its confirm',
        conf && /delete folder/.test(what) && gone, JSON.stringify({ conf, what: what.slice(0, 80), gone }));
    } else check('I3: a folder view offers Delete in the page menu', false);
  }

  if (on('I4')) {
    // ── I4: New page with a tool tab in front ─────────────────────────────
    await page.evaluate(() => document.getElementById('rb-settings').click());
    await until(() => { const s = window.latTabs.state(); return s.tabs[s.active].kind === 'tool'; });
    const before = (await state()).tabs.length;
    await newPage(N4);
    let n4 = null;
    for (let i = 0; i < 40 && n4 === null; i++) { await sleep(500); n4 = await pageBody(N4); }
    await waitOn('page', N4);
    const s4 = await state();
    const t4 = s4.tabs[s4.active];
    check('I4: New page with a tool in front opens a page tab, in front',
      n4 !== null && t4.kind === 'page' && t4.key === N4 && s4.tabs.length === before + 1
      && s4.tabs.some((t) => t.kind === 'tool'), JSON.stringify({ n4, s4 }));
    //  and a folder clicked from under a tool lands in a page tab too
    await page.click(tabSel('tool', 'frame:/apps/lattice/settings')).catch(() => {});
    await until(() => { const s = window.latTabs.state(); return s.tabs[s.active].kind === 'tool'; });
    const n5 = (await state()).tabs.length;
    await pickFolder(RUN);
    await until(() => { const s = window.latTabs.state(); return s.tabs[s.active].kind === 'page'; });
    const s5 = await state();
    check('I4: a folder clicked under a tool shows in a page tab',
      s5.tabs[s5.active].kind === 'page' && s5.tabs.length === n5 + 1
      && await page.evaluate(() => document.getElementById('pname').readOnly), JSON.stringify(s5));
  }

  if (on('I6')) {
    // ── I6: a memory moved while another tab comes forward ────────────────
    await page.evaluate((k) => { window.latTabs.openIn('know', k, { newTab: true }); }, K6);
    await waitOn('know', K6);
    await page.evaluate((q) => { window.latTabs.openIn('page', q, { newTab: true }); }, Q);
    await waitOn('page', Q);
    await page.click(tabSel('know', K6));
    await waitOn('know', K6);
    rule = (r) => (/\/know-move\?/.test(r.url()) ? 3000 : null);
    seen.length = 0;
    await page.evaluate(() => document.getElementById('mv').click());
    await dlgUp();
    await dlgAnswer(K6B, null);
    for (let i = 0; i < 40 && !seen.length; i++) await sleep(100);
    await page.click(tabSel('page', Q));
    await waitOn('page', Q);
    await sleep(5000);
    rule = null;
    await typeEnd('I6TYPED');
    await sleep(4000);
    const s6 = await state();
    const i6 = {
      tab: s6.tabs[s6.active], pname: await page.evaluate(() => document.getElementById('pname').value),
      know: s6.tabs.filter((t) => t.kind === 'know').map((t) => t.key),
      q: await pageBody(Q), stray: await pageBody(K6B),
    };
    check('I6: the page in front keeps its tab and name after a memory move lands',
      i6.tab.kind === 'page' && i6.tab.key === Q && i6.pname === Q, JSON.stringify(i6));
    check('I6: the moved memory\'s own tab is renamed, and the page\'s typing stays the page\'s',
      i6.know.includes(K6B) && !i6.know.includes(K6) && (i6.q || '').includes('I6TYPED')
      && i6.stray === null, JSON.stringify(i6));
  }
} catch (e) {
  check('suite crashed: ' + e.message, false);
} finally {
  await browser.close();
  for (const n of [P, Q, G, D, A1, B1, N4, K1, K6B, ...cleanup, RUN])
    await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(n),
      { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
  for (const k of [K1, K6, K6B])
    await fetch(env.base + '/apps/lattice/know-delete?key=' + encodeURIComponent(k),
      { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
}
check.done();
