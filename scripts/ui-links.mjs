#!/usr/bin/env node
//  ui-links.mjs: shared page links in the editor (docs/superpowers/specs/
//  2026-10-29-shared-page-links-design.md, "In the editor").
//
//  Ship B shares x/doc with ship A. In A's editor the shared-with-me row
//  is dragged onto folder `notes` and becomes a link row at notes/doc. The
//  link opens as a page tab titled with its local path, saves land on B
//  (and a stale save is refused, not written), the Page tab names where it
//  comes from, B offline gives the badge, and "Move back to shared with me"
//  undoes it. Then the same at 390px, from the drawers.
//
//  Fake fleet ships only. B goes offline by SIGSTOP of its vere serf, as
//  scripts/two-ship-links.sh does, and is always continued again.
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//         B_URL=http://localhost:8135 B_COOKIE=/tmp/mun-cookie.txt \
//         [B_PIER=~/fleet/piers/mun] [SHOTS=dir] node scripts/ui-links.mjs
import { execSync } from 'child_process';
import { homedir } from 'os';
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, shipName } from './lib/harness.mjs';

const env = shipEnv();
const benv = shipEnv({ urlVar: 'B_URL', cookieVar: 'B_COOKIE', cookieDefault: '/tmp/mun-cookie.txt' });
const B_PIER = (process.env.B_PIER || homedir() + '/fleet/piers/mun').replace(/^~/, homedir());
const SHOTS = process.env.SHOTS || '';
const check = makeCheck();

const A_ = (path, init = {}) => fetch(env.base + '/apps/lattice/' + path,
  { ...init, headers: { Cookie: env.cookie } });
const B_ = (path, init = {}) => fetch(benv.base + '/apps/lattice/' + path,
  { ...init, headers: { Cookie: benv.cookie } });
const post = (f, path, body) => f(path, { method: 'POST', body });
const q = encodeURIComponent;
const ASHIP = await shipName(env);
const BSHIP = await shipName(benv);

//  B's serf, frozen: B answers nothing, which is all offline means to A
const bpid = () => execSync(`pgrep -f -- '--snap-dir ${B_PIER}( |$)' | head -1`).toString().trim();
const bStop = () => execSync('kill -STOP ' + bpid());
const bStart = () => { try { execSync('kill -CONT ' + bpid()); } catch {} };
const bUp = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await B_('shared-with-me')).ok) return true; } catch {}
    await sleep(2000);
  }
  return false;
};

const entry = async () => {
  const l = await (await A_('shared-with-me')).json().catch(() => []);
  return l.find((e) => e.host === BSHIP && e.path.endsWith('/page/x/doc/code')) || null;
};
const bBody = async () => (await (await B_('page-source?name=x/doc')).json()).body;
const node = async (path) => {
  const d = await (await A_('page-tree')).json();
  return d.nodes.find((n) => n.path === path) || null;
};
const waitFor = async (fn, secs = 30) => {
  for (let i = 0; i < secs; i++) { const v = await fn(); if (v) return v; await sleep(1000); }
  return null;
};

async function cleanup() {
  bStart();
  await post(A_, 'page-del?name=notes');
  const e = await entry();
  if (e) await post(A_, 'shared-with-me-del?host=' + q(BSHIP) + '&path=' + q(e.path));
  await post(B_, 'page-del?name=x');
  await post(B_, 'share-group-del?name=' + q(ASHIP.replace(/^~/, '')));
}
//  B makes x/doc and shares it with A, edit; A has folder notes
async function setup() {
  await cleanup();
  await post(B_, 'page-save?name=x/doc&type=md&new=1', '# from B');
  await post(B_, 'share-file?name=x/doc&ship=' + q(ASHIP) + '&mode=edit');
  await post(A_, 'page-save?name=notes/keep&type=md&new=1', '# keep');
  return waitFor(entry, 40);
}

const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const boot = async (width, height) => {
  const p = await openPage(browser, env,
    { viewport: { width, height, isMobile: width < 820, hasTouch: width < 820 } });
  await p.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  await sleep(1500);
  return p;
};
const until = async (p, fn, arg, ms = 20000) => {
  try { await p.waitForFunction(fn, { timeout: ms }, arg); return true; } catch { return false; }
};
const LROW = (host) => `#treelist a.pg.lnk[data-host="${host}"]`;
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + name }); };
const still = () => sleep(450);
const closeAll = async (p) => {
  await p.evaluate(() => document.getElementById('ws').classList.remove('ldraw', 'rdraw'));
  await still();
};
//  the row is on screen and nothing covers its centre
const reach = (p, sel) => p.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
  const hit = document.elementFromPoint(x, y);
  return !!hit && (hit === el || el.contains(hit));
}, sel);
const KEEP = '#treelist a.pg[href*="notes%2Fkeep"]';
//  click away from a dirty document and take the discard question
const discardTo = async (p, sel) => {
  await p.click(sel);
  const asked = await until(p, () => {
    const g = document.getElementById('dlg');
    return !!g && !g.hidden && /discard/.test(document.getElementById('dlgmsg').textContent);
  }, undefined, 30000);
  if (asked) await p.click('#dlgok');
  await sleep(800);
  return asked;
};
//  the left or right drawer open, by its toggle, unless it already is
const drawer = async (p, side) => {
  const cls = side === 'l' ? 'ldraw' : 'rdraw';
  if (!(await p.evaluate((c) => document.getElementById('ws').classList.contains(c), cls)))
    await p.tap(side === 'l' ? '#treet' : '#ctlt');
  await still();
};
//  a tap on a row of the drawer's tree, scrolled into view first
const tapRow = async (p, sel) => {
  await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
  await sleep(200);
  await p.tap(sel);
};
const status = (p) => p.evaluate(() => document.getElementById('status').textContent);
const badgeCopy = BSHIP + ' unreachable or no longer sharing';
const readFail = BSHIP + ' is unreachable or no longer shares this page';

try {
  check('B shares x/doc with A', !!(await setup()));

  // ── desktop ──────────────────────────────────────────────────────────────
  const d = await boot(1280, 900);
  check('the shared-with-me row is there',
    await until(d, (h) => !!document.querySelector('#treelist a.pg.swm[title^="' + h + '"]'), BSHIP));
  const drag = await d.evaluate((h) => {
    const row = document.querySelector('#treelist a.pg.swm[title^="' + h + '"]');
    const fold = [...document.querySelectorAll('#treelist .fld')]
      .find((f) => f.dataset.tk === 'f:notes');
    if (!row || !fold) return { row: !!row, fold: !!fold };
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    fold.dispatchEvent(over);
    fold.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return { draggable: row.draggable, accepted: over.defaultPrevented };
  }, BSHIP);
  check('the row drags and folder notes takes it', drag.draggable && drag.accepted, JSON.stringify(drag));
  check('a link row appears at notes/doc',
    await until(d, (s) => {
      const r = document.querySelector(s);
      return !!r && r.dataset.path === 'notes/doc';
    }, LROW(BSHIP)));
  check('  ...with the link icon',
    await d.evaluate((s) => !!document.querySelector(s + ' svg.ic-link'), LROW(BSHIP)));
  check('  ...and ~host on hover',
    await d.evaluate((s, h) => (document.querySelector(s) || {}).title?.includes(h), LROW(BSHIP), BSHIP));
  check('  ...and the shared-with-me row is gone',
    await until(d, (h) => !document.querySelector('#treelist a.pg.swm[title^="' + h + '"]'), BSHIP));
  check('the ship has the link', (await node('notes/doc'))?.link?.host === BSHIP);

  // open: B's text, the tab titled with the local path
  await d.click(LROW(BSHIP));
  check('opening it shows B\'s text',
    await until(d, () => document.getElementById('src').value === '# from B'),
    await d.evaluate(() => document.getElementById('src').value));
  check('the tab is titled notes/doc', await d.evaluate(() =>
    document.querySelector('.dtab.on .dtn')?.textContent) === 'notes/doc',
  await d.evaluate(() => document.querySelector('.dtab.on .dtn')?.textContent));
  check('  ...a page tab', await d.evaluate(() =>
    document.querySelector('.dtab.on')?.dataset.kind) === 'page');

  // type and Ctrl+S: the text lands on B
  await d.focus('#src');
  await d.keyboard.press('End');
  await d.keyboard.type(' via A');
  await d.keyboard.down('Control'); await d.keyboard.press('s'); await d.keyboard.up('Control');
  check('Ctrl+S lands the text on B',
    !!(await waitFor(async () => (await bBody()) === '# from B via A', 20)), await bBody());

  // the Page tab
  await d.evaluate(() => document.querySelector('[data-pt=page]')?.click());
  await sleep(300);
  const pt = await d.evaluate(() => ({
    from: document.getElementById('lnkfrom')?.textContent,
    mode: document.getElementById('lnkmode')?.textContent,
    shown: !!document.getElementById('lnkrow') && !document.getElementById('lnkrow').hidden,
  }));
  check('the Page tab shows "Linked from ~B/"',
    pt.shown && (pt.from || '').startsWith('Linked from ' + BSHIP + '/'), JSON.stringify(pt));
  check('  ...naming B\'s path', pt.from === 'Linked from ' + BSHIP + '/x/doc', JSON.stringify(pt));
  check('  ...and the mode', /edit/.test(pt.mode || ''), JSON.stringify(pt));

  // B edits meanwhile: A's next save is refused, B's text survives
  await post(B_, 'page-save?name=x/doc&type=md', '# B moved on');
  await d.focus('#src');
  await d.keyboard.press('End');
  await d.keyboard.type(' stale');
  await d.keyboard.down('Control'); await d.keyboard.press('s'); await d.keyboard.up('Control');
  await sleep(4000);
  check('a stale save is refused with the conflict status',
    /changed/.test(await status(d)), await status(d));
  check('  ...and B\'s newer text survives', (await bBody()) === '# B moved on', await bBody());
  check('  ...and the editor keeps what was typed', await d.evaluate(() =>
    document.getElementById('src').value.endsWith(' stale')));
  //  drop the edit, the way a user does: leave, and discard when asked
  check('leaving asks to discard what did not save', await discardTo(d, KEEP));

  // B offline: a save says the read-failure copy, an open gives the badge
  await d.click(LROW(BSHIP));
  await until(d, () => document.getElementById('src').value === '# B moved on');
  bStop();
  await d.focus('#src');
  await d.keyboard.press('End');
  await d.keyboard.type(' off');
  await d.keyboard.down('Control'); await d.keyboard.press('s'); await d.keyboard.up('Control');
  check('a save with B offline shows the read-failure copy',
    await until(d, (c) => document.getElementById('status').textContent.includes(c), readFail, 15000),
    await status(d));
  check('  ...and is not queued as saved offline', await d.evaluate(() =>
    !/saved offline/.test(document.getElementById('cerr').textContent)));
  await discardTo(d, KEEP);
  await d.click(LROW(BSHIP));
  check('opening it with B offline shows the badge',
    await until(d, (s) => document.querySelector(s + ' .lbad')?.textContent, LROW(BSHIP), 15000));
  check('  ...verbatim', await d.evaluate((s) =>
    document.querySelector(s + ' .lbad')?.textContent, LROW(BSHIP)) === badgeCopy);
  check('  ...and the open says why',
    await until(d, (c) => document.getElementById('status').textContent.includes(c), readFail, 30000),
    await status(d));
  await shot(d, 'links-desktop-badge.png');
  bStart();
  check('B back up', await bUp());

  // open again with B up: the Page tab, then Move back from the page menu
  await d.click(KEEP);
  await sleep(800);
  await d.click(LROW(BSHIP));
  check('it opens again with B back',
    await until(d, () => document.getElementById('src').value === '# B moved on'));
  check('  ...the badge goes once a read works',
    await until(d, (s) => !document.querySelector(s + ' .lbad'), LROW(BSHIP)));
  await d.evaluate(() => document.querySelector('[data-pt=page]')?.click());
  await sleep(300);
  await shot(d, 'links-desktop-page-tab.png');
  await d.click('#tmenu');
  await sleep(200);
  const mi = await d.evaluate(() => document.querySelector('.tmenu [data-mi="linkback"]')?.textContent);
  check('the page menu offers "Move back to shared with me"',
    mi === 'Move back to shared with me', mi);
  await d.click('.tmenu [data-mi="linkback"]');
  check('  ...the shared-with-me row comes back',
    await until(d, (h) => !!document.querySelector('#treelist a.pg.swm[title^="' + h + '"]'), BSHIP));
  check('  ...and the link row goes', await until(d, (s) => !document.querySelector(s), LROW(BSHIP)));
  check('  ...on the ship too', !(await node('notes/doc')) && !!(await entry()));
  check('palette lists both moves', await d.evaluate(() => {
    const ids = window.latPalette.ids();
    return ids.includes('swm-move') && ids.includes('linkback');
  }));
  await d.close();

  // ── phone, from the drawers ──────────────────────────────────────────────
  const m = await boot(390, 844);
  await closeAll(m);
  await drawer(m, 'l');
  const MV = `#treelist a.pg.swm[title^="${BSHIP}"] .swmv`;
  await until(m, (s) => !!document.querySelector(s), MV);
  check('phone: the row\'s Move into my pages is in the left drawer', await reach(m, MV));
  check('  ...titled', await m.evaluate((s) => {
    const b = document.querySelector(s);
    return !!b && b.title === 'Move into my pages' && b.getAttribute('aria-label') === b.title;
  }, MV));
  await tapRow(m, MV);
  await sleep(500);
  const seedv = await m.evaluate(() => document.getElementById('dlginput')?.value);
  check('  ...it opens the move dialog', seedv === 'doc', seedv);
  await m.evaluate(() => {
    const i = document.getElementById('dlginput');
    i.value = 'notes/doc'; i.dispatchEvent(new Event('input'));
    document.getElementById('dlgok').click();
  });
  check('phone: the link row appears', await until(m, (s) => !!document.querySelector(s), LROW(BSHIP)));
  await closeAll(m);
  await drawer(m, 'l');
  check('phone: the link row is in the drawer', await reach(m, LROW(BSHIP)));
  await tapRow(m, LROW(BSHIP));
  check('phone: it opens', await until(m, () => document.getElementById('src').value === '# B moved on'));
  await closeAll(m);
  await drawer(m, 'r');
  await m.evaluate(() => document.querySelector('[data-pt=page]')?.click());
  await still();
  check('phone: the Page tab in the right drawer says where from',
    await reach(m, '#lnkfrom') && (await m.evaluate(() =>
      document.getElementById('lnkfrom').textContent)) === 'Linked from ' + BSHIP + '/x/doc');
  await closeAll(m);
  // offline: the badge in the drawer
  bStop();
  await drawer(m, 'l');
  await tapRow(m, KEEP);
  //  the open's fetch lands after its paint and shuts the drawer again
  await sleep(3000);
  await drawer(m, 'l');
  await tapRow(m, LROW(BSHIP));
  await sleep(500);
  await closeAll(m);
  await drawer(m, 'l');
  check('phone: the badge shows in the drawer',
    await until(m, (s) => document.querySelector(s + ' .lbad')?.textContent, LROW(BSHIP), 15000)
    && await reach(m, LROW(BSHIP) + ' .lbad'));
  await shot(m, 'links-phone-badge.png');
  await closeAll(m);
  await drawer(m, 'r');
  await m.evaluate(() => document.querySelector('[data-pt=page]')?.click());
  await still();
  check('phone: the Page tab carries the badge too',
    await until(m, (c) => document.getElementById('lnkbad')?.textContent === c, badgeCopy, 5000));
  await shot(m, 'links-phone-page-tab.png');
  await closeAll(m);
  bStart();
  check('B back up', await bUp());
  // move back from the page menu
  await drawer(m, 'l');
  await tapRow(m, LROW(BSHIP));
  await until(m, () => document.getElementById('src').value === '# B moved on');
  await closeAll(m);
  check('phone: the page menu is in reach', await reach(m, '#tmenu'));
  await m.tap('#tmenu');
  await sleep(300);
  check('phone: it offers Move back', await reach(m, '.tmenu [data-mi="linkback"]'));
  await m.tap('.tmenu [data-mi="linkback"]');
  check('phone: the shared row comes back',
    await until(m, (h) => !!document.querySelector('#treelist a.pg.swm[title^="' + h + '"]'), BSHIP));
  await m.close();
} catch (e) {
  check.bad('suite ran to the end', e.stack || String(e));
} finally {
  bStart();
  await browser.close();
  await cleanup();
}
check.done();
