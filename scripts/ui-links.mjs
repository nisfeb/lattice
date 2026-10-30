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

const entry = async (tail = '/page/x/doc/code') => {
  const l = await (await A_('shared-with-me')).json().catch(() => []);
  return l.find((e) => e.host === BSHIP && e.path.endsWith(tail)) || null;
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
  for (const t of ['/page/x/doc/code', '/page/x/ro/code']) {
    const e = await entry(t);
    if (e) await post(A_, 'shared-with-me-del?host=' + q(BSHIP) + '&path=' + q(e.path));
  }
  await post(B_, 'page-del?name=x');
  await post(B_, 'share-group-del?name=' + q(ASHIP.replace(/^~/, '')));
}
//  B makes x/doc and shares it with A, edit, and x/ro, read; A has folder notes
async function setup() {
  await cleanup();
  await post(B_, 'page-save?name=x/doc&type=md&new=1', '# from B');
  await post(B_, 'share-file?name=x/doc&ship=' + q(ASHIP) + '&mode=edit');
  await post(B_, 'page-save?name=x/ro&type=md&new=1', '# ro');
  await post(B_, 'share-file?name=x/ro&ship=' + q(ASHIP) + '&mode=read');
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
const LP = (path) => `#treelist a.pg.lnk[data-path="${path}"]`;
const SWROW = (tail) => `#treelist a.pg.swm[title^="${BSHIP}"][title$="${tail}"]`;
const save = async (p) => {
  await p.keyboard.down('Control'); await p.keyboard.press('s'); await p.keyboard.up('Control');
};
//  whether the offline queue (08-offline.js) holds an edit for `name`
const queued = (p, name) => p.evaluate((n) => new Promise((res) => {
  const rq = indexedDB.open('lattice-offline', 3);
  rq.onerror = () => res(null);
  rq.onsuccess = () => {
    try {
      const g = rq.result.transaction('saves', 'readonly').objectStore('saves').get(n);
      g.onsuccess = () => res(!!g.result);
      g.onerror = () => res(null);
    } catch { res(null); }
  };
}), name);
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
    await until(d, (s) => !!document.querySelector(s), SWROW('/x/doc/code')));
  const drag = await d.evaluate((s) => {
    const row = document.querySelector(s);
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
  }, SWROW('/x/doc/code'));
  check('the row drags and folder notes takes it', drag.draggable && drag.accepted, JSON.stringify(drag));
  check('a link row appears at notes/doc',
    await until(d, (s) => {
      const r = document.querySelector(s);
      return !!r && r.dataset.path === 'notes/doc';
    }, LP('notes/doc')));
  check('  ...with the link icon',
    await d.evaluate((s) => !!document.querySelector(s + ' svg.ic-link'), LP('notes/doc')));
  check('  ...and ~host on hover',
    await d.evaluate((s, h) => (document.querySelector(s) || {}).title?.includes(h), LP('notes/doc'), BSHIP));
  check('  ...and the shared-with-me row is gone',
    await until(d, (s) => !document.querySelector(s), SWROW('/x/doc/code')));
  check('the ship has the link', (await node('notes/doc'))?.link?.host === BSHIP);

  // open: B's text, the tab titled with the local path
  await d.click(LP('notes/doc'));
  check('opening it shows B\'s text',
    await until(d, () => document.getElementById('src').value === '# from B'),
    await d.evaluate(() => document.getElementById('src').value));
  check('the tab is titled notes/doc', await d.evaluate(() =>
    document.querySelector('.dtab.on .dtn')?.textContent) === 'notes/doc',
  await d.evaluate(() => document.querySelector('.dtab.on .dtn')?.textContent));
  check('  ...a page tab', await d.evaluate(() =>
    document.querySelector('.dtab.on')?.dataset.kind) === 'page');

  // type and Ctrl+S: the text lands on B, twice running (the second save
  // claims the rev the first one made)
  await d.focus('#src');
  await d.keyboard.press('End');
  await d.keyboard.type(' via A');
  await save(d);
  check('Ctrl+S lands the text on B',
    !!(await waitFor(async () => (await bBody()) === '# from B via A', 20)), await bBody());
  await d.keyboard.type(' twice');
  await save(d);
  check('  ...and a second save right after lands too',
    !!(await waitFor(async () => (await bBody()) === '# from B via A twice', 20)), await bBody());

  // the Page tab
  await d.evaluate(() => document.querySelector('[data-pt=page]')?.click());
  await sleep(300);
  const pt = await d.evaluate(() => ({
    from: document.getElementById('lnkfrom')?.textContent,
    mode: document.getElementById('lnkmode')?.textContent,
    shown: !!document.getElementById('lnkrow') && !document.getElementById('lnkrow').hidden,
    back: !!document.querySelector('#lnkrow button'),
  }));
  check('the Page tab shows "Linked from ~B/"',
    pt.shown && (pt.from || '').startsWith('Linked from ' + BSHIP + '/'), JSON.stringify(pt));
  check('  ...naming B\'s path', pt.from === 'Linked from ' + BSHIP + '/x/doc', JSON.stringify(pt));
  check('  ...and the mode', /edit/.test(pt.mode || ''), JSON.stringify(pt));
  check('  ...and no second home for Move back there', !pt.back, JSON.stringify(pt));

  // this ship unreachable for the save: never queued, the text stays unsaved
  await d.setRequestInterception(true);
  let icept = true;
  let cut = true;
  let saves = 0;
  d.on('request', (r) => {
    const hit = r.method() === 'POST' && r.url().includes('/page-save?name=notes%2Fdoc&');
    if (hit) saves++;
    if (!icept || r.isInterceptResolutionHandled()) return;
    if (hit && cut) r.abort(); else r.continue();
  });
  await d.keyboard.type(' net');
  await save(d);
  check('own ship unreachable: the save says the read-failure copy',
    await until(d, (c) => document.getElementById('status').textContent.includes(c), readFail, 15000),
    await status(d));
  check('  ...NOT saved, and still unsaved', await d.evaluate(() =>
    document.getElementById('cerr').textContent === 'NOT saved' && window.__latUnsaved()));
  check('  ...and nothing queued', (await queued(d, 'notes/doc')) === false);
  cut = false;
  await save(d);
  check('  ...back: Ctrl+S lands it',
    !!(await waitFor(async () => (await bBody()) === '# from B via A twice net', 20)), await bBody());
  icept = false;
  await d.setRequestInterception(false);

  // B edits meanwhile: A's next save is refused, B's text survives
  await post(B_, 'page-save?name=x/doc&type=md', '# B moved on');
  await d.focus('#src');
  await d.keyboard.press('End');
  await d.keyboard.type(' stale');
  await save(d);
  check('a stale save is refused with the conflict status',
    await until(d, () => /changed/.test(document.getElementById('status').textContent), undefined, 15000),
    await status(d));
  check('  ...the conflict bar is up', await until(d, () => !document.getElementById('lnkcf').hidden));
  await shot(d, 'links-desktop-conflict.png');
  check('  ...and B\'s newer text survives', (await bBody()) === '# B moved on', await bBody());
  check('  ...and the editor keeps what was typed', await d.evaluate(() =>
    document.getElementById('src').value.endsWith(' stale')));
  const before = saves;
  await d.keyboard.type(' more');
  await sleep(4000);
  check('  ...autosave stands down for it', saves === before, saves - before + ' saves');
  await d.click('#lnkcfkeep');
  check('Keep mine as a copy: theirs comes back',
    await until(d, () => document.getElementById('src').value === '# B moved on', undefined, 20000));
  check('  ...the bar goes', await d.evaluate(() => document.getElementById('lnkcf').hidden));
  const mine = await (await A_('page-source?name=notes/doc-mine')).json().catch(() => ({}));
  check('  ...and my text is a page beside it', (mine.body || '').endsWith(' stale more'), mine.body);
  check('  ...in the tree', await until(d, () =>
    !!document.querySelector('#treelist a.pg[href*="notes%2Fdoc-mine"]')));
  await post(B_, 'page-save?name=x/doc&type=md', '# B again');
  await d.focus('#src');
  await d.keyboard.press('End');
  await d.keyboard.type(' x');
  await save(d);
  check('another stale save: the bar again', await until(d, () => !document.getElementById('lnkcf').hidden,
    undefined, 15000));
  await d.click('#lnkcfre');
  check('Reload theirs: B\'s text, nothing unsaved',
    await until(d, () => document.getElementById('src').value === '# B again' && !window.__latUnsaved(),
      undefined, 20000));

  // B offline: a save says the read-failure copy, an open shows the last copy
  bStop();
  await d.focus('#src');
  await d.keyboard.press('End');
  await d.keyboard.type(' off');
  await save(d);
  check('a save with B offline shows the read-failure copy',
    await until(d, (c) => document.getElementById('status').textContent.includes(c), readFail, 15000),
    await status(d));
  check('  ...and is not queued as saved offline', await d.evaluate(() =>
    !/saved offline/.test(document.getElementById('cerr').textContent)) && !(await queued(d, 'notes/doc')));
  await discardTo(d, KEEP);
  await d.click(LP('notes/doc'));
  check('opening it with B offline shows the badge',
    await until(d, (s) => document.querySelector(s + ' .lbad')?.textContent, LP('notes/doc'), 15000));
  check('  ...verbatim', await d.evaluate((s) =>
    document.querySelector(s + ' .lbad')?.textContent, LP('notes/doc')) === badgeCopy);
  check('  ...then since when', /^since \S/.test(await d.evaluate((s) =>
    document.querySelector(s + ' .lbsince')?.textContent || '', LP('notes/doc'))));
  check('  ...and the open says why',
    await until(d, (c) => document.getElementById('status').textContent.includes(c), readFail, 30000),
    await status(d));
  check('  ...showing the last copy read', await d.evaluate(() =>
    document.getElementById('src').value) === '# B again');
  await d.focus('#src');
  await d.keyboard.type('zz');
  check('  ...read-only', await d.evaluate(() =>
    document.getElementById('src').readOnly && document.getElementById('src').value === '# B again'));
  await shot(d, 'links-desktop-badge.png');
  bStart();
  check('B back up', await bUp());

  // open again with B up
  await d.click(KEEP);
  await sleep(800);
  await d.click(LP('notes/doc'));
  check('it opens again with B back, editable',
    await until(d, () => document.getElementById('src').value === '# B again'
      && !document.getElementById('src').readOnly));
  check('  ...the badge goes once a read works',
    await until(d, (s) => !document.querySelector(s + ' .lbad'), LP('notes/doc')));
  await d.evaluate(() => document.querySelector('[data-pt=page]')?.click());
  await sleep(300);
  await shot(d, 'links-desktop-page-tab.png');

  // a read grant: locked, also after a tab switch away and back
  const ro = await waitFor(() => entry('/page/x/ro/code'), 40);
  check('B shares x/ro, read', !!ro);
  if (ro) await post(A_, 'link-make?host=' + q(BSHIP) + '&path=' + q(ro.path) + '&to=notes%2Fro');
  check('the read link shows', await until(d, (s) => !!document.querySelector(s), LP('notes/ro'), 40000));
  await d.click(LP('notes/ro'));
  await until(d, () => document.getElementById('src').value === '# ro');
  await d.focus('#src');
  await d.keyboard.type('zz');
  check('a read link can\'t be typed in', await d.evaluate(() =>
    document.getElementById('src').readOnly && document.getElementById('src').value === '# ro'));
  await d.keyboard.down('Control'); await d.click(KEEP); await d.keyboard.up('Control');
  await until(d, () => document.querySelector('.dtab.on')?.dataset.key === 'notes/keep');
  await d.click('.dtab[data-key="notes/ro"]');
  await until(d, () => document.getElementById('src').value === '# ro');
  await d.focus('#src');
  await d.keyboard.type('zz');
  check('  ...nor after a tab switch away and back', await d.evaluate(() =>
    document.getElementById('src').readOnly && document.getElementById('src').value === '# ro'));
  // a reload paints the front tab from its snapshot before the tree knows
  // the page is a link: the lock must land once the tree loads
  await d.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await d.waitForFunction(() => document.querySelectorAll('#treelist a.pg').length > 0, { timeout: 90000 });
  await until(d, () => document.getElementById('src').value === '# ro');
  await sleep(1500);
  await d.focus('#src');
  await d.keyboard.type('zz');
  check('  ...nor after a reload with it in front', await d.evaluate(() =>
    document.querySelector('.dtab.on')?.dataset.key === 'notes/ro'
    && document.getElementById('src').readOnly && document.getElementById('src').value === '# ro'),
  await d.evaluate(() => document.querySelector('.dtab.on')?.dataset.key + ' '
    + document.getElementById('src').readOnly + ' ' + JSON.stringify(document.getElementById('src').value)));

  // Move back, from the page menu, its one home
  await d.click(LP('notes/doc'));
  await until(d, () => document.getElementById('src').value === '# B again');
  await d.click('#tmenu');
  await sleep(200);
  const mi = await d.evaluate(() => document.querySelector('.tmenu [data-mi="linkback"]')?.textContent);
  check('the page menu offers "Move back to shared with me"',
    mi === 'Move back to shared with me', mi);
  await d.click('.tmenu [data-mi="linkback"]');
  check('  ...the shared-with-me row comes back',
    await until(d, (s) => !!document.querySelector(s), SWROW('/x/doc/code')));
  check('  ...and the link row goes', await until(d, (s) => !document.querySelector(s), LP('notes/doc')));
  check('  ...and no tab is left on it', await d.evaluate(() =>
    !document.querySelector('.dtab[data-key="notes/doc"]')));
  check('  ...on the ship too', !(await node('notes/doc')) && !!(await entry()));
  check('palette lists both moves', await d.evaluate(() => {
    const ids = window.latPalette.ids();
    return ids.includes('swm-move') && ids.includes('pm-linkback');
  }));
  await d.close();

  // ── phone, from the drawers ──────────────────────────────────────────────
  const m = await boot(390, 844);
  await closeAll(m);
  await drawer(m, 'l');
  const MV = SWROW('/x/doc/code') + ' + .swmv';
  await until(m, (s) => !!document.querySelector(s), MV);
  check('phone: the row\'s Move into my pages is in the left drawer', await reach(m, MV));
  check('  ...a titled button, in the tab order', await m.evaluate((s) => {
    const b = document.querySelector(s);
    return !!b && b.tagName === 'BUTTON' && b.tabIndex === 0 && b.dataset.action === 'swm-move'
      && b.title === 'Move into my pages' && b.getAttribute('aria-label') === b.title;
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
  check('phone: the link row appears', await until(m, (s) => !!document.querySelector(s), LP('notes/doc')));
  await closeAll(m);
  await drawer(m, 'l');
  check('phone: the link row is in the drawer', await reach(m, LP('notes/doc')));
  await tapRow(m, LP('notes/doc'));
  check('phone: it opens', await until(m, () => document.getElementById('src').value === '# B again'));
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
  await tapRow(m, LP('notes/doc'));
  await sleep(500);
  await closeAll(m);
  await drawer(m, 'l');
  check('phone: the badge shows in the drawer',
    await until(m, (s) => document.querySelector(s + ' .lbad')?.textContent, LP('notes/doc'), 15000)
    && await reach(m, LP('notes/doc') + ' .lbad'));
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
  await tapRow(m, LP('notes/doc'));
  await until(m, () => document.getElementById('src').value === '# B again');
  await closeAll(m);
  check('phone: the page menu is in reach', await reach(m, '#tmenu'));
  await m.tap('#tmenu');
  await sleep(300);
  check('phone: it offers Move back', await reach(m, '.tmenu [data-mi="linkback"]'));
  await m.tap('.tmenu [data-mi="linkback"]');
  check('phone: the shared row comes back',
    await until(m, (s) => !!document.querySelector(s), SWROW('/x/doc/code')));
  await m.close();
} catch (e) {
  check.bad('suite ran to the end', e.stack || String(e));
} finally {
  bStart();
  await browser.close();
  await cleanup();
}
check.done();
