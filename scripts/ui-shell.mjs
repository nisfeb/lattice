#!/usr/bin/env node
//  ui-shell.mjs: the editor shell frame: ribbon, tabbed side panes, status
//  bar and the two corner toggles.
//
//    the frame's parts are all on screen at desktop width
//    a pane tab switch shows one section, and survives a reload
//    the corner toggles close and reopen their panes, and say so
//    every chrome button carries a tooltip equal to its accessible name
//    the tree and the status line moved into the frame with their ids
//    the status bar raises a chip for a compile error, which opens Page
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-shell.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, sleep } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false),
});

const boot = async () => {
  await page.goto(env.app, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  await sleep(800);
};
const shown = (sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return false;
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
}, sel);
const width = (sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  return e ? e.getBoundingClientRect().width : -1;
}, sel);
const pressed = (sel) => page.evaluate((s) => document.querySelector(s)?.getAttribute('aria-pressed'), sel);

try {
  await page.goto(env.app + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(() => {
    for (const k of ['appNT', 'appNC', 'appLTab', 'appRTab', 'appPanes']) localStorage.removeItem(k);
  });
  await boot();

  // ── the frame is on screen ─────────────────────────────────────────────
  const parts = {};
  for (const s of ['#ribbon', '#lpane', '#rpane', '#statusbar', '#center']) parts[s] = await shown(s);
  check('ribbon, panes and status bar exist', Object.values(parts).every(Boolean), JSON.stringify(parts));

  // ── left pane tabs switch and persist ──────────────────────────────────
  await page.evaluate(() => document.querySelector('#ltabs [data-pt=know]')?.click());
  await sleep(200);
  const lt = async () => page.evaluate(() => ({
    know: (() => { const s = document.querySelector('section[data-pane=know]'); return !!s && !s.hidden; })(),
    files: (() => { const s = document.querySelector('section[data-pane=files]'); return !!s && !s.hidden; })(),
    on: document.querySelector('#ltabs [data-pt=know]')?.getAttribute('aria-selected'),
    ls: localStorage.appLTab,
  }));
  const a = await lt();
  check('left pane tabs switch', a.know && !a.files && a.on === 'true' && a.ls === 'know', JSON.stringify(a));
  await boot();
  const b = await lt();
  check('the left tab survives a reload', b.know && !b.files, JSON.stringify(b));
  await page.evaluate(() => document.querySelector('#ltabs [data-pt=files]')?.click());
  await sleep(200);

  // ── right pane tabs: one section at a time ─────────────────────────────
  await page.evaluate(() => document.querySelector('#rtabs [data-pt=hist]')?.click());
  await sleep(200);
  const r = await page.evaluate(() => ({
    open: [...document.querySelectorAll('#rbody > section')].filter((s) => !s.hidden).map((s) => s.dataset.pane),
    histsec: !!document.querySelector('section[data-pane=hist] #histsec'),
    linksec: !!document.querySelector('section[data-pane=back] #linksec'),
    ls: localStorage.appRTab,
  }));
  check('right pane tabs switch', r.open.join() === 'hist' && r.ls === 'hist', JSON.stringify(r));
  check('history and backlinks live in their tabs', r.histsec && r.linksec, JSON.stringify(r));
  await page.evaluate(() => document.querySelector('#rtabs [data-pt=page]')?.click());
  await sleep(200);

  // ── corner toggles ─────────────────────────────────────────────────────
  for (const [btn, pane] of [['#treet', '#lpane'], ['#ctlt', '#rpane']]) {
    const before = { w: await width(pane), p: await pressed(btn) };
    await page.click(btn);
    await sleep(250);
    const shut = { w: await width(pane), p: await pressed(btn), btn: await shown(btn) };
    await page.click(btn);
    await sleep(250);
    const back = { w: await width(pane), p: await pressed(btn) };
    check(btn + ' hides ' + pane,
      before.w > 0 && before.p === 'true' && shut.w === 0 && shut.p === 'false' && shut.btn,
      JSON.stringify({ before, shut }));
    check(btn + ' restores ' + pane, back.w > 0 && back.p === 'true', JSON.stringify(back));
  }

  // ── ribbonAdd and the tooltip rule ─────────────────────────────────────
  const added = await page.evaluate(() => {
    const b = window.latShell?.ribbonAdd({ id: 'shtest', icon: 'cal', name: 'Shell test', keys: 'Ctrl+Y', run: () => { window.__shRan = 1; } });
    if (!b) return null;
    b.click();
    return { inRibbon: !!document.querySelector('#ribbon #rb-shtest'), title: b.title, ran: window.__shRan === 1 };
  });
  check('ribbonAdd adds a working button',
    !!added && added.inRibbon && added.ran && added.title === 'Shell test (Ctrl+Y)', JSON.stringify(added));
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll('#ribbon button, #ltabs button, #rtabs button, #treet, #ctlt')]
      .filter((b) => !b.title || b.title !== b.getAttribute('aria-label'))
      .map((b) => b.id || b.dataset.pt || b.outerHTML.slice(0, 60)));
  const count = await page.evaluate(() =>
    document.querySelectorAll('#ribbon button, #ltabs button, #rtabs button, #treet, #ctlt').length);
  check('every chrome button has a tooltip', count >= 12 && bad.length === 0, JSON.stringify({ count, bad }));
  await page.evaluate(() => document.getElementById('rb-shtest')?.remove());

  // ── what moved, moved with its ids ─────────────────────────────────────
  const moved = await page.evaluate(() => ({
    tree: !!document.querySelector('#lpane section[data-pane=files] #treelist'),
    ctl: !!document.querySelector('#rpane section[data-pane=page] #cerr'),
    status: !!document.querySelector('#statusbar #status'),
    spin: !!document.querySelector('#statusbar #spin'),
    off: !!document.querySelector('#statusbar #offbadge'),
    editor: !!document.querySelector('#center #src') && !!document.querySelector('#center #prev'),
    keptHidden: ['pname', 'pkind', 'modet', 'viewseg', 'qt', 'cmt', 'aclt', 'wrapt', 'save']
      .filter((id) => { const e = document.getElementById(id); return !e || e.getBoundingClientRect().width > 0; }),
  }));
  check('tree and status moved',
    moved.tree && moved.ctl && moved.status && moved.spin && moved.off && moved.editor,
    JSON.stringify(moved));
  check('the old bar controls exist but are off screen', moved.keptHidden.length === 0,
    JSON.stringify(moved.keptHidden));

  // ── compile error chip ─────────────────────────────────────────────────
  await page.evaluate(() => {
    localStorage.appNC = '1';
    document.getElementById('ctlt').click();   // open: the click flips it
    document.getElementById('ctlt').click();   // closed again
    document.querySelector('#rtabs [data-pt=hist]').click();
    const c = document.getElementById('cerr');
    c.textContent = 'syntax error at line 3'; c.className = 'err';
  });
  await sleep(200);
  const chip = { shown: await shown('#errchip'), text: await page.evaluate(() => document.getElementById('errchip')?.textContent) };
  await page.evaluate(() => document.getElementById('errchip')?.click());
  await sleep(250);
  const after = await page.evaluate(() => ({
    nc: document.getElementById('ws').classList.contains('nc'),
    page: !document.querySelector('section[data-pane=page]')?.hidden,
  }));
  await page.evaluate(() => { const c = document.getElementById('cerr'); c.textContent = ' '; c.className = 'ok'; });
  await sleep(200);
  const gone = !(await shown('#errchip'));
  check('a compile error raises the status chip', chip.shown && /syntax error/.test(chip.text || ''), JSON.stringify(chip));
  check('the chip opens the Page tab', !after.nc && after.page, JSON.stringify(after));
  check('the chip leaves with the error', gone);
} catch (e) {
  check('threw: ' + String(e.message).slice(0, 140), false);
} finally {
  await page.evaluate(() => {
    for (const k of ['appNT', 'appNC', 'appLTab', 'appRTab']) localStorage.removeItem(k);
  }).catch(() => {});
  await browser.close();
}
check.done();
