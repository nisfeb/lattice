#!/usr/bin/env node
//  ui-view.mjs: the tab header (23-tabhead.js): Edit / Read, the path, the
//  page menu.
//
//  Edit and Read are ONE choice per tab, with no split: Edit hides the
//  preview, Read hides the editor. Checked here against a ship: the control
//  and Ctrl+E flip it, the choice survives a reload (it rides in appTabs),
//  the path opens the move dialog, the page menu changes the kind and the
//  page saves as that kind, Back and Forward are disabled with nothing to
//  step to, and a phone shows the same header (its drawers and bottom bar
//  are scripts/ui-mobar.mjs).
//
//  The desktop View menu's contract is checked ship-free in
//  scripts/desktop-commands.mjs.
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-view.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, seed, sleep } from './lib/harness.mjs';

const env = shipEnv();
const APP = env.app;
const RUN = 'vw-' + process.pid;
const P = RUN + '/p';
const check = makeCheck();

const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const shipGet = async (path) => {
  const r = await fetch(env.base + '/apps/lattice/' + path, { headers: { Cookie: env.cookie } });
  return r.ok ? r.json() : null;
};

const boot = async (width, url = APP) => {
  const p = await openPage(browser, env, {
    viewport: { width, height: 900 },
    onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false),
  });
  p.on('dialog', (d) => d.accept().catch(() => {}));
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  await sleep(800);
  return p;
};
//  pane widths, 0 for anything not on screen
const widths = (p) => p.evaluate(() => Object.fromEntries(
  [['ed', '.edwrap'], ['pv', '.prevwrap']]
    .map(([k, s]) => [k, Math.round(document.querySelector(s).getBoundingClientRect().width)])));
const readOn = (p) => p.evaluate(() =>
  document.querySelector('#tread button[data-r="1"]').getAttribute('aria-pressed') === 'true');

try {
  await seed(env, [[P, '# view\n\nbody\n']]);
  const url = APP + '?name=' + encodeURIComponent(P);
  const desk = await boot(1400, url);
  await desk.waitForFunction((n) => document.getElementById('pname').value === n, { timeout: 30000 }, P);

  // ── Edit and Read ───────────────────────────────────────────────────────
  const w0 = await widths(desk);
  check('edit is the default: no preview, no split',
    w0.ed > 0 && w0.pv === 0 && !(await readOn(desk)), JSON.stringify(w0));
  const ctl = await desk.evaluate(() => {
    const r = document.getElementById('tread');
    const b = (n) => r.querySelector('button[data-r="' + n + '"]');
    return { n: r.querySelectorAll('button').length, t: b(1).title, x: b(1).textContent };
  });
  check('the control is two buttons, Edit and Read, tipped Edit / Read (Ctrl+E)',
    ctl.n === 2 && ctl.t === 'Edit / Read (Ctrl+E)' && ctl.x === 'Read', JSON.stringify(ctl));

  await desk.click('#tread button[data-r="1"]');
  const w1 = await widths(desk);
  check('read: the editor is gone and the preview has the room',
    w1.ed === 0 && w1.pv > 0, JSON.stringify(w1));
  check('read is the pressed button', await readOn(desk));
  await desk.click('#tread button[data-r="0"]');
  const w2 = await widths(desk);
  check('edit again: the preview is gone', w2.ed > 0 && w2.pv === 0, JSON.stringify(w2));

  // ctrl+e toggles, from the editor itself
  await desk.focus('#src');
  await desk.keyboard.down('Control');
  await desk.keyboard.press('e');
  await desk.keyboard.up('Control');
  const w3 = await widths(desk);
  check('ctrl+e switches to read', w3.ed === 0 && w3.pv > 0 && (await readOn(desk)), JSON.stringify(w3));
  const painted = await desk.evaluate(() => /<(p|h[1-6])\b/.test(document.getElementById('prev').srcdoc || ''));
  check('entering read paints the preview', painted);
  await desk.keyboard.down('Control');
  await desk.keyboard.press('e');
  await desk.keyboard.up('Control');
  const w4 = await widths(desk);
  check('ctrl+e switches back to edit', w4.ed > 0 && w4.pv === 0, JSON.stringify(w4));

  // the choice rides with the tab through a reload
  await desk.click('#tread button[data-r="1"]');
  await sleep(300);
  await desk.reload({ waitUntil: 'domcontentloaded' });
  await desk.waitForFunction(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  await sleep(1000);
  const again = await widths(desk);
  check('the choice survives a reload', again.ed === 0 && again.pv > 0, JSON.stringify(again));
  await desk.click('#tread button[data-r="0"]');

  // ── the path opens the move dialog ──────────────────────────────────────
  const shown = await desk.evaluate(() => document.getElementById('tpath').textContent);
  check('the path names the open page', shown.includes(P), shown);
  await desk.click('#tpath');
  await desk.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 10000 })
    .catch(() => {});
  const dlg = await desk.evaluate(() => ({
    open: !document.getElementById('dlg').hidden, v: document.getElementById('dlginput').value }));
  check('path click opens move, prefilled with the name', dlg.open && dlg.v === P, JSON.stringify(dlg));
  await desk.keyboard.press('Escape');
  await desk.waitForFunction(() => document.getElementById('dlg').hidden, { timeout: 5000 }).catch(() => {});

  // ── back / forward ──────────────────────────────────────────────────────
  const nav = await desk.evaluate(() => ['tback', 'tfwd'].map((id) => {
    const b = document.getElementById(id);
    return [b.disabled, b.getAttribute('aria-disabled')];
  }));
  check('back and forward are disabled with nothing to step to',
    nav.every(([d, a]) => d && a === 'true'), JSON.stringify(nav));

  // ── the page menu ───────────────────────────────────────────────────────
  await desk.click('#tmenu');
  const items = await desk.evaluate(() =>
    [...document.querySelectorAll('.tmenu [data-mi]')].map((b) => b.dataset.mi));
  check('the menu lists its items',
    ['kind', 'wrap', 'dup', 'download', 'raw', 'del'].every((i) => items.includes(i)), JSON.stringify(items));
  const labels = await desk.evaluate(() =>
    [...document.querySelectorAll('.tmenu [data-mi]')].map((b) => b.textContent));
  check('the menu has Download and no Export vault',
    labels.includes('Download') && !labels.some((l) => /export/i.test(l)), JSON.stringify(labels));
  check('convert to html is not offered off the desktop app and off tex', !items.includes('tex'),
    JSON.stringify(items));
  await desk.click('.tmenu [data-mi="kind"]');
  await desk.click('.tmenu [data-kind="gmi"]');
  const kv = await desk.evaluate(() => document.getElementById('pkind').value);
  check('page menu kind change sets #pkind', kv === 'gmi', kv);
  let kind = null;
  for (let i = 0; i < 20 && kind !== 'gmi'; i++) {
    await sleep(1000);
    kind = ((await shipGet('page-source?name=' + encodeURIComponent(P))) || {}).kind;
  }
  check('and the page saves as gmi', kind === 'gmi', String(kind));
  await desk.keyboard.press('Escape');
  const closed = await desk.evaluate(() => !document.querySelector('.tmenu'));
  check('escape closes the menu', closed);
  await desk.close();

  // ── a phone has the same header ─────────────────────────────────────────
  const phone = await boot(400, url);
  check('phone: the tab header is on screen, Edit / Read with it',
    await phone.evaluate(() => {
      const r = document.getElementById('tread').getBoundingClientRect();
      return r.width > 0 && r.right <= 400;
    }));
  await phone.close();
} catch (e) {
  check('suite crashed: ' + e.message, false);
} finally {
  await browser.close();
  for (const n of [P, RUN])
    await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(n),
      { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
}
check.done();
