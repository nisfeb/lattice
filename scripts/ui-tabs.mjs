#!/usr/bin/env node
//  ui-tabs.mjs: document tabs, and the save safety each one carries.
//
//    Ctrl+click opens a second tab, and a plain click on a document that is
//      already open focuses its tab instead of opening it twice
//    switching tabs inside the autosave window keeps what was typed in both
//    a dirty grub (no autosave) survives being switched away from and back,
//      shows its dot, counts as unsaved from the background, and closing it
//      asks first; cancel keeps it
//    the tab list comes back after a reload, and a corrupt one falls back to
//      a single tab with the tree still drawn
//    each tab's Back steps through what that tab has shown
//
//  The grub is the code grub of a page this suite seeds, so it is a real
//  grub under the lattice desk that nothing else uses, and page-del removes
//  it. No app file is ever opened.
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-tabs.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, seed, sleep } from './lib/harness.mjs';

const env = shipEnv();
const RUN = 'x-' + process.pid;
const A = RUN + '/a', B = RUN + '/b', G = RUN + '/g';

const check = makeCheck();
const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false),
});
//  a dirty buffer makes a reload ask; the suite never wants to stay
page.on('dialog', (d) => d.accept().catch(() => {}));

const shipGet = async (path) => {
  const r = await fetch(env.base + '/apps/lattice/' + path, { headers: { Cookie: env.cookie } });
  return r.ok ? r.json() : null;
};
const body = async (name) => ((await shipGet('page-source?name=' + encodeURIComponent(name))) || {}).body || '';

const boot = async (url = env.app) => {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  await sleep(800);
};
const state = () => page.evaluate(() => window.latTabs ? window.latTabs.state() : null);
//  the active tab is the one named and the editor shows its document
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
const row = (name) => '#treelist a.pg[href$="name=' + encodeURIComponent(name) + '"]';
const tabSel = (kind, key) => `#doctabs .dtab[data-kind="${kind}"][data-key="${key}"]`;
const typeEnd = async (text) => {
  await page.focus('#src');
  await page.evaluate(() => { const s = document.getElementById('src'); s.setSelectionRange(s.value.length, s.value.length); });
  await page.keyboard.type(text);
};

let grub = null;
try {
  await seed(env, [[A, 'page a\n'], [B, 'page b\n'], [G, 'scratch grub\n']]);
  const base = (await (await fetch(env.base + '/apps/lattice/streams',
    { headers: { Cookie: env.cookie } })).json()).base;
  grub = base + '/page/' + G + '/code';

  await page.goto(env.app + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(() => { localStorage.removeItem('appTabs'); localStorage.removeItem('appPage'); });
  await boot();
  //  a fresh load is taken over by the service worker, which reloads once
  await sleep(8000);
  await page.waitForFunction(() => document.querySelectorAll('#treelist a.pg').length > 0, { timeout: 90000 });

  // ── Ctrl+click opens a second tab ──────────────────────────────────────
  await page.click(row(A));
  await waitOn('page', A);
  await page.keyboard.down('Control');
  await page.click(row(B));
  await page.keyboard.up('Control');
  const two = await waitOn('page', B);
  let s = await state();
  check('ctrl-click opens a second tab', two && (await page.$$('#doctabs .dtab')).length === 2,
    JSON.stringify(s));

  // ── a plain click on an open document focuses its tab ─────────────────
  await page.click(row(A));
  const back = await waitOn('page', A);
  s = await state();
  check('plain click focuses the tab already showing it', back && s.tabs.length === 2,
    JSON.stringify(s));

  // ── switching inside the autosave window keeps both ───────────────────
  await typeEnd('AAA');
  await sleep(150);
  await page.click(tabSel('page', B));
  await waitOn('page', B);
  await typeEnd('BBB');
  await sleep(4000);
  const [ba, bb] = [await body(A), await body(B)];
  check('switch inside the autosave window keeps both', ba.includes('AAA') && bb.includes('BBB'),
    JSON.stringify({ ba, bb }));

  // ── a dirty grub survives switching ───────────────────────────────────
  await page.evaluate((p) => window.latTabs.openIn('grub', p, { newTab: true }), grub);
  check('a grub opens in its own tab', await waitOn('grub', grub), JSON.stringify(await state()));
  await typeEnd('GGG');
  await sleep(300);
  await page.click(tabSel('page', A));
  await waitOn('page', A);
  await page.click(tabSel('grub', grub));
  await waitOn('grub', grub);
  const g = await page.evaluate(() => ({
    text: document.getElementById('src').value,
    dot: !!document.querySelector('#doctabs .dtab.dirty'),
    ro: document.getElementById('src').readOnly,
  }));
  check('a dirty grub keeps its text across a switch', g.text.includes('GGG') && !g.ro, JSON.stringify(g));
  await sleep(700);
  check('and its tab shows the dirty dot',
    await page.evaluate(() => !!document.querySelector('#doctabs .dtab.dirty')));

  // ── a background dirty tab is unsaved work ────────────────────────────
  await page.click(tabSel('page', A));
  await waitOn('page', A);
  check('__latUnsaved sees background tabs', await page.evaluate(() => window.__latUnsaved() === true));
  await sleep(700);
  check('the background grub tab keeps its dot',
    await page.evaluate((k) => !!document.querySelector(
      `#doctabs .dtab.dirty[data-key="${k}"]`), grub));

  // ── closing it asks, and cancel keeps it ───────────────────────────────
  await page.evaluate((p) => {
    const t = window.latTabs.list().find((x) => x.kind === 'grub' && x.key === p);
    window.__closed = 'pending';
    window.latTabs.closeTab(t.id).then((v) => { window.__closed = v; });
  }, grub);
  let asked = false;
  for (let i = 0; i < 60 && !asked; i++) {
    asked = await page.evaluate(() => !document.getElementById('dlg').hidden);
    if (!asked) await sleep(250);
  }
  check('closing a dirty grub tab asks first', asked);
  await page.click('#dlgcancel');
  await sleep(500);
  s = await state();
  check('cancel keeps it', await page.evaluate(() => window.__closed === false)
    && s.tabs.some((t) => t.kind === 'grub'), JSON.stringify(s));
  //  and discarding is the other answer: the grub tab goes, unsaved
  await page.evaluate((p) => {
    const t = window.latTabs.list().find((x) => x.kind === 'grub' && x.key === p);
    window.latTabs.closeTab(t.id).then((v) => { window.__closed = v; });
  }, grub);
  await page.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 30000 });
  await page.click('#dlgok');
  await sleep(800);
  s = await state();
  const gtext = ((await shipGet('grub-source?path=' + encodeURIComponent(grub))) || {}).text || '';
  check('discard closes it and writes nothing',
    !s.tabs.some((t) => t.kind === 'grub') && !gtext.includes('GGG'), JSON.stringify(s));

  // ── the tab list survives a reload ─────────────────────────────────────
  await waitOn(s.tabs[s.active].kind, s.tabs[s.active].key);
  await sleep(2500);   // the last autosave lands, so the reload is not asked about
  const before = await state();
  await boot(page.url());
  const sa = s.tabs[s.active];
  await waitOn(sa.kind, sa.key);
  const after = await state();
  const keys = (x) => x.tabs.map((t) => t.kind + ':' + t.key).join(',');
  check('tabs restore after reload', keys(after) === keys(before) && after.active === before.active,
    keys(before) + ' @' + before.active + ' -> ' + keys(after) + ' @' + after.active);

  // ── a corrupt list falls back to one tab ───────────────────────────────
  await page.evaluate(() => { localStorage.appTabs = '{'; });
  await boot(env.app);
  s = await state();
  const rows = await page.evaluate(() => document.querySelectorAll('#treelist a.pg').length);
  check('corrupt appTabs falls back', s && s.tabs.length === 1 && rows > 0, JSON.stringify(s));

  // ── each tab steps back through what it showed ────────────────────────
  await page.click(row(A));
  await waitOn('page', A);
  await page.click(row(B));
  await waitOn('page', B);
  await page.click('#tabback');
  const stepped = await waitOn('page', A);
  s = await state();
  check('per-tab back', stepped && s.tabs.length === 1, JSON.stringify(s));
  await page.click('#tabfwd');
  check('and forward', await waitOn('page', B), JSON.stringify(await state()));

  // ── the strip's own controls ───────────────────────────────────────────
  await page.click('#tabnew');
  const made = await waitOn('page', '');
  s = await state();
  check('+ opens a new page tab', made && s.tabs.length === 2, JSON.stringify(s));
  await page.keyboard.down('Control');
  await page.keyboard.press('w');
  await page.keyboard.up('Control');
  await sleep(800);
  s = await state();
  check('Ctrl+W closes the front tab', s.tabs.length === 1 && s.tabs[0].key === B, JSON.stringify(s));
  await page.keyboard.down('Control');
  await page.click(row(A));
  await page.keyboard.up('Control');
  await waitOn('page', A);
  await page.click(tabSel('page', A), { button: 'middle' });
  await sleep(800);
  s = await state();
  check('a middle click closes a tab', s.tabs.length === 1 && s.tabs[0].key === B, JSON.stringify(s));
} catch (e) {
  check('suite crashed: ' + e.message, false);
} finally {
  //  the browser first, so no autosave of its own can land after the delete
  //  and put a page back
  await browser.close();
  for (const n of [A, B, G, RUN])
    await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(n),
      { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
}
check.done();
