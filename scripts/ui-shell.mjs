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
//    the left pane: Knowledge lists memories with no mode switch, a memory
//      opens as a know tab beside a still-rendered Files tree, Ctrl+K
//      focuses the Search tab, sort flips the root order, the trash
//      restores a deleted memory, and Bookmarks lists /bookmarks-json
//    the ribbon, top to bottom, and its tool tabs: Access & groups and the
//      inbox render in a tab (the inbox carries the unread badge), Settings
//      frames the settings page without its reader bar, the brief opens
//      today's journal page, and Browser asks before leaving unsaved work
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-shell.mjs
import { shipEnv, launchBrowser, openPage, seed, makeCheck, sleep } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
//  fixed keys, not per run: know-delete is a soft delete with no purge
//  route, so each run restores and reuses these instead of leaving a new
//  memory in the trash every time
const MEM = 'test/shell-suite';
const FRESH = 'test/shell-suite-new';
const MARK = 'https://example.com/shell-' + process.pid;
//  the right pane's pages: headings, a link, and the page it links to
const RP = 'rpane-' + process.pid;
const LINKER = 'rplink-' + process.pid;
const LINKED = 'x-' + process.pid + '/a';
const UNSEEDED = 'x-' + process.pid + '/never';
const post = (path, body) => fetch(env.base + '/apps/lattice/' + path,
  { method: 'POST', headers: { Cookie: env.cookie }, body });
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
  await post('know-restore?key=' + encodeURIComponent(MEM)).catch(() => {});
  await post('know-save?key=' + encodeURIComponent(MEM), 'shell suite memory');
  await post('know-restore?key=' + encodeURIComponent(FRESH)).catch(() => {});
  await post('know-delete?key=' + encodeURIComponent(FRESH)).catch(() => {});
  await post('bookmark?url=' + encodeURIComponent(MARK) + '&title=shell%20mark&folder=shellf');
  await page.goto(env.app + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(() => {
    for (const k of ['appNT', 'appNC', 'appLTab', 'appRTab', 'appPanes', 'appTabs']) localStorage.removeItem(k);
  });
  await boot();

  // ── New memory never writes over an existing key ───────────────────────
  //  Files is in front and no memory tab is open, so the memory list has
  //  not been fetched: the client cannot know MEM exists
  const knew = async (key) => {
    await page.evaluate(() => document.getElementById('knew').click());
    await page.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 5000 });
    await page.evaluate((k) => {
      document.getElementById('dlginput').value = k;
      document.getElementById('dlgok').click();
    }, key);
  };
  const readMem = async (k) => {
    const r = await fetch(env.base + '/apps/lattice/know-read?key=' + encodeURIComponent(k),
      { headers: { Cookie: env.cookie } });
    return r.ok ? (await r.json()).body : null;
  };
  const unloaded = await page.evaluate(() => !document.querySelector('#knowlist a.pg'));
  await knew(MEM);
  const opened = await page.waitForFunction((k) => {
    const s = window.latTabs.state();
    return s.tabs[s.active].kind === 'know' && s.tabs[s.active].key === k && s.shows;
  }, { timeout: 30000 }, MEM).then(() => true, () => false);
  await sleep(1500);
  const kept = await readMem(MEM);
  check('new memory on an existing key opens it and leaves its body intact',
    unloaded && opened && kept === 'shell suite memory', JSON.stringify({ unloaded, opened, kept }));
  await knew(FRESH);
  const made = await page.waitForFunction((k) => {
    const s = window.latTabs.state();
    return s.tabs[s.active].kind === 'know' && s.tabs[s.active].key === k;
  }, { timeout: 30000 }, FRESH).then(() => true, () => false);
  check('new memory on a free key creates it', made && (await readMem(FRESH)) !== null,
    JSON.stringify({ made }));
  await page.evaluate(() => localStorage.removeItem('appTabs'));

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
    [...document.querySelectorAll('#ribbon button, #ltabs button, #rtabs button, #treet, #ctlt, #lpane .ptool button')]
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
    keptHidden: ['pname', 'pkind', 'wrapt', 'save']
      .filter((id) => { const e = document.getElementById(id); return !e || e.getBoundingClientRect().width > 0; }),
  }));
  check('tree and status moved',
    moved.tree && moved.ctl && moved.status && moved.spin && moved.off && moved.editor,
    JSON.stringify(moved));
  check('the old bar controls exist but are off screen', moved.keptHidden.length === 0,
    JSON.stringify(moved.keptHidden));

  // ── left pane tabs ─────────────────────────────────────────────────────
  const until = (fn, arg, ms = 30000) => page.waitForFunction(fn, { timeout: ms }, arg)
    .then(() => true, () => false);
  await page.evaluate(() => document.querySelector('#ltabs [data-pt=know]')?.click());
  const listed = await until((k) => [...document.querySelectorAll('[data-pane=know] #knowlist a.pg')]
    .some((a) => a.textContent === k.split('/').pop()), MEM);
  const noMode = await page.evaluate(() => !document.getElementById('modet'));
  check('knowledge tab lists memories without a mode switch', listed && noMode,
    JSON.stringify({ listed, noMode }));

  await page.evaluate((k) => [...document.querySelectorAll('#knowlist a.pg')]
    .find((a) => a.textContent === k.split('/').pop())?.click(), MEM);
  const knowTab = await until((k) => {
    const s = window.latTabs?.state();
    if (!s) return false;
    const t = s.tabs[s.active];
    return t && t.kind === 'know' && t.key === k && s.shows;
  }, MEM);
  await sleep(500);
  const files = await page.evaluate(() => ({
    pages: document.querySelectorAll('[data-pane=files] #treelist a.pg[href*="name="]').length,
    mem: document.querySelectorAll('#treelist a.pg:not([href*="name="])').length,
  }));
  check('opening a memory makes a know tab', knowTab && files.pages > 0 && files.mem === 0,
    JSON.stringify({ knowTab, files }));

  await page.evaluate(() => { localStorage.appNT = '1'; window.latShell.paneOpen('l', false); });
  await page.focus('#src');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(300);
  const ck = await page.evaluate(() => ({
    focus: document.activeElement && document.activeElement.id,
    tab: !document.querySelector('section[data-pane=search]').hidden,
  }));
  const lpaneUp = await shown('#lpane');
  check('ctrl+k focuses search pane', ck.focus === 'qinput' && ck.tab && lpaneUp,
    JSON.stringify({ ...ck, lpaneUp }));

  await page.evaluate(() => document.querySelector('#ltabs [data-pt=files]').click());
  const roots = () => page.evaluate(() => [...document.querySelectorAll('#treelist > *')]
    .filter((r) => (parseInt(r.style.marginLeft, 10) || 0) === 0 && r.style.display !== 'none'
      && (r.matches('a.pg[href*="name="]') || r.matches('.fld')))
    .slice(0, 400).map((r) => (r.matches('.fld') ? 'd:' : 'p:') + r.textContent));
  const r0 = await roots();
  await page.evaluate(() => document.getElementById('tsort')?.click());
  await sleep(200);
  const r1 = await roots();
  const fo = (l) => l.filter((x) => x.startsWith('d:'));
  const pg = (l) => l.filter((x) => x.startsWith('p:'));
  const flipped = r0.length > 1
    && JSON.stringify(fo(r1)) === JSON.stringify(fo(r0).reverse())
    && JSON.stringify(pg(r1)) === JSON.stringify(pg(r0).reverse())
    && (!fo(r1).length || r1[0].startsWith('d:'));
  check('sort toggles', flipped, JSON.stringify({ r0: r0.slice(0, 4), r1: r1.slice(0, 4) }));
  if (flipped) await page.evaluate(() => document.getElementById('tsort')?.click());

  await post('know-delete?key=' + encodeURIComponent(MEM));
  await page.evaluate(() => document.querySelector('#ltabs [data-pt=know]')?.click());
  await page.evaluate(() => document.getElementById('ktrash')?.click());
  const inTrash = await until((k) => [...document.querySelectorAll('#ktrashlist [data-key]')]
    .some((r) => r.dataset.key.replace(/^\//, '') === k), MEM);
  await page.evaluate((k) => [...document.querySelectorAll('#ktrashlist [data-key]')]
    .find((r) => r.dataset.key.replace(/^\//, '') === k)?.querySelector('button')?.click(), MEM);
  let back = 0;
  for (let i = 0; i < 20 && back !== 200; i++) {
    await sleep(500);
    back = (await fetch(env.base + '/apps/lattice/know-read?key=' + encodeURIComponent(MEM),
      { headers: { Cookie: env.cookie } })).status;
  }
  check('trash restore', inTrash && back === 200, JSON.stringify({ inTrash, back }));

  const bj = await page.evaluate(async () => {
    const r = await fetch('/apps/lattice/bookmarks-json');
    let d = null;
    try { d = await r.json(); } catch {}
    return { status: r.status, arr: Array.isArray(d), n: Array.isArray(d) ? d.length : -1,
      has: Array.isArray(d) && d.some((b) => b.folder === 'shellf' && b.title === 'shell mark') };
  });
  await page.evaluate(() => document.querySelector('#ltabs [data-pt=marks]').click());
  const rows = await until((n) => document.querySelectorAll('[data-pane=marks] a.pg').length === n
    && n > 0, bj.n);
  const nrows = await page.evaluate(() => document.querySelectorAll('[data-pane=marks] a.pg').length);
  check('bookmarks json', bj.status === 200 && bj.arr && bj.has && rows,
    JSON.stringify({ ...bj, nrows }));
  await page.evaluate(() => document.querySelector('#ltabs [data-pt=files]').click());

  // ── right pane tabs follow the document ────────────────────────────────
  await seed(env, [[RP, '# One\n## Two\ntext\n'], [LINKER, 'see [[' + LINKED + ']] and [[' + UNSEEDED + ']]\n'],
    [LINKED, 'linked page\n']]);
  const openDoc = async (kind, key) => {
    await page.evaluate((k, n) => window.latTabs.openIn(k, n), kind, key);
    return until(([k, n]) => {
      const s = window.latTabs.state();
      const t = s.tabs[s.active];
      return t && t.kind === k && t.key === n && s.shows;
    }, [kind, key]);
  };
  const rtab = (id) => page.evaluate((i) => document.querySelector('#rtabs [data-pt=' + i + ']').click(), id);
  const paneText = (id) => page.evaluate((i) =>
    document.querySelector('#rbody > [data-pane=' + i + ']').innerText.trim(), id);

  const rpOpen = await openDoc('page', RP);
  await rtab('outline');
  const olRows = await until(() => document.querySelectorAll('[data-pane=outline] .olrow').length === 2);
  await page.evaluate(() => [...document.querySelectorAll('[data-pane=outline] .olrow')]
    .find((a) => a.textContent.trim() === 'Two')?.click());
  await sleep(200);
  const caret = await page.evaluate(() => document.getElementById('src').selectionStart);
  check('outline lists headings', rpOpen && olRows && caret === '# One\n'.length,
    JSON.stringify({ rpOpen, olRows, caret, text: await paneText('outline') }));

  //  the pane follows the tab in front, in both directions, with no click
  await openDoc('page', LINKER);
  const gone1 = await until(() => !document.querySelector('[data-pane=outline] .olrow'));
  await openDoc('page', RP);
  const back1 = await until(() => document.querySelectorAll('[data-pane=outline] .olrow').length === 2);
  check('the outline follows a tab switch', gone1 && back1, JSON.stringify({ gone1, back1 }));
  //  and the text as it is typed
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value += '### Three\n';
    s.dispatchEvent(new Event('input'));
  });
  const typed = await until(() => [...document.querySelectorAll('[data-pane=outline] .olrow')]
    .some((a) => a.textContent === 'Three'));
  check('the outline follows typing', typed);

  //  history applies to a memory, backlinks do not
  await openDoc('know', MEM);
  await rtab('hist');
  const memHist = await until(() => !document.getElementById('histsec').hidden);
  await rtab('back');
  await sleep(300);
  const memBack = await paneText('back');
  check('a memory has history and no backlinks',
    memHist && memBack === 'Nothing here for this tab.', JSON.stringify({ memHist, memBack }));

  await openDoc('page', LINKER);
  await rtab('out');
  const outRow = await until((n) => [...document.querySelectorAll('[data-pane=out] .olrow')]
    .some((a) => a.textContent.trim() === n), LINKED);
  await page.evaluate((n) => [...document.querySelectorAll('[data-pane=out] .olrow')]
    .find((a) => a.textContent.trim() === n)?.click(), LINKED);
  const followed = await until((n) => {
    const s = window.latTabs.state();
    return s.tabs[s.active].key === n;
  }, LINKED);
  check('outgoing lists links', outRow && followed,
    JSON.stringify({ outRow, followed, text: await paneText('out') }));
  await openDoc('page', LINKER);
  const muted = await until(([a, b]) => {
    const rows = [...document.querySelectorAll('[data-pane=out] .olrow')];
    const row = (n) => rows.find((r) => r.textContent.trim() === n);
    return row(a) && row(b) && !row(a).classList.contains('muted') && row(b).classList.contains('muted');
  }, [LINKED, UNSEEDED]);
  check('an outgoing link to no page is muted', muted, await paneText('out'));

  const cmtSrc = async () => {
    const res = await fetch(env.base + '/apps/lattice/page-source?name=' + encodeURIComponent(RP),
      { headers: { Cookie: env.cookie } });
    return res.ok ? (await res.json()).comments : 'http ' + res.status;
  };
  await openDoc('page', RP);
  await rtab('page');
  const cmtShown = await until(() => {
    const c = document.getElementById('cmton');
    return !!c && c.getBoundingClientRect().width > 0 && !c.disabled;
  });
  const flipCmt = async (want) => {
    await page.evaluate(() => document.getElementById('cmton').click());
    let got;
    for (let i = 0; i < 30 && (got = await cmtSrc()) !== want; i++) await sleep(500);
    return got;
  };
  const cmOn = await flipCmt(true);
  const cmOff = await flipCmt(false);
  check('comments toggle round-trips', cmtShown && cmOn === true && cmOff === false,
    JSON.stringify({ cmtShown, cmOn, cmOff }));

  const sbase = (await (await fetch(env.base + '/apps/lattice/streams',
    { headers: { Cookie: env.cookie } })).json()).base;
  //  the post box follows the flag with the Comments tab in front: it is
  //  off now, and switching it on (from the hidden Page tab) opens the box
  await rtab('comments');
  const boxOff = await until(() => document.getElementById('rpcmpost').disabled
    && /off for this page/.test(document.getElementById('rpcmnote').textContent));
  await page.evaluate(() => document.getElementById('cmton').click());
  const boxOn = await until(() => !document.getElementById('rpcmpost').disabled
    && !document.getElementById('rpcmbody').disabled);
  const stayed = await page.evaluate(() =>
    !document.querySelector('#rbody > [data-pane=comments]').hidden);
  check('the comment box opens when comments turn on', boxOff && boxOn && stayed,
    JSON.stringify({ boxOff, boxOn, stayed, on: await cmtSrc() }));
  await page.evaluate(() => document.getElementById('cmton').click());
  for (let i = 0; i < 30 && (await cmtSrc()) !== false; i++) await sleep(500);

  const grubOpen = await openDoc('grub', sbase + '/page/' + RP + '/code');
  await rtab('comments');
  await sleep(300);
  const none = await paneText('comments');
  check('inapplicable tab says so', grubOpen && none === 'Nothing here for this tab.',
    JSON.stringify({ grubOpen, none }));
  await rtab('page');

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

  // ── the ribbon and tool tabs ───────────────────────────────────────────
  const names = await page.evaluate(() => [...document.querySelectorAll('#ribbon button')]
    .map((b) => (b.title === b.getAttribute('aria-label') ? b.title : '!' + b.title)));
  check('ribbon order and tooltips', JSON.stringify(names) === JSON.stringify([
    "Today's brief", 'Browser', 'Forum', 'Comments inbox', 'Access & groups', 'Explorer',
    'Sync conflicts', 'Command palette (Ctrl+P)', 'Settings']), JSON.stringify(names));

  const front = () => page.evaluate(() => {
    const s = window.latTabs.state();
    const t = s.tabs[s.active];
    return t ? { kind: t.kind, key: t.key, shows: s.shows, n: s.tabs.length } : null;
  });
  const isFront = (kind, key) => until(([k, n]) => {
    const s = window.latTabs.state();
    const t = s.tabs[s.active];
    return t && t.kind === k && t.key === n && s.shows;
  }, [kind, key]);
  await openDoc('page', RP);
  const n0 = (await front()).n;
  await page.evaluate(() => document.getElementById('rb-access').click());
  const accTab = await isFront('tool', 'access');
  const acc = await page.evaluate(() => {
    const w = document.getElementById('aclwrap');
    const r = w.getBoundingClientRect();
    const host = document.getElementById('toolhost');
    return {
      inHost: !!host && host.contains(document.getElementById('aclgrid')),
      shown: r.width > 0 && r.height > 0,
      fixed: getComputedStyle(w).position === 'fixed',
      doc: document.getElementById('docarea').getBoundingClientRect().height,
      head: document.getElementById('tpath').textContent,
      tread: document.getElementById('tread').getBoundingClientRect().width,
    };
  });
  const n1 = (await front()).n;
  check('access opens as a tab',
    accTab && acc.inHost && acc.shown && !acc.fixed && acc.doc === 0 && n1 === n0 + 1
      && acc.head === 'Access & groups' && acc.tread === 0,
    JSON.stringify({ accTab, acc, n0, n1 }));
  await rtab('page');
  await sleep(300);
  const pgNone = await paneText('page');
  check('a tool tab leaves the Page tab empty', pgNone === 'Nothing here for this tab.', pgNone);
  await page.focus('#aclnew');
  await page.keyboard.press('Escape');
  await sleep(300);
  const esc = await front();
  check('escape in a tool tab keeps the tab',
    esc.kind === 'tool' && esc.key === 'access' && esc.n === n1, JSON.stringify(esc));
  await openDoc('page', RP);
  await sleep(300);
  const back2 = await page.evaluate(() => ({
    doc: document.getElementById('docarea').getBoundingClientRect().height,
    host: document.getElementById('toolhost').getBoundingClientRect().height,
  }));
  await page.evaluate(() => document.getElementById('aclopen').click());
  const refocus = await isFront('tool', 'access');
  const n2 = (await front()).n;
  check('#aclopen focuses the same access tab',
    back2.doc > 0 && back2.host === 0 && refocus && n2 === n1, JSON.stringify({ back2, refocus, n1, n2 }));

  await page.evaluate(() => document.getElementById('rb-settings').click());
  const setTab = await isFront('tool', 'frame:/apps/lattice/settings');
  const framed = await until(() => {
    const f = document.querySelector('#toolhost iframe:not([hidden])');
    const d = f && f.contentDocument;
    const bar = d && d.querySelector('form.bar');
    return !!(d && d.getElementById('themeui') && bar && getComputedStyle(bar).display === 'none');
  });
  check('settings frame hides reader bar', setTab && framed, JSON.stringify({ setTab, framed }));
  //  a link to the editor inside the frame opens in the shell, not the frame
  await page.evaluate((n) => {
    const d = document.querySelector('#toolhost iframe:not([hidden])').contentDocument;
    const a = d.createElement('a');
    a.href = '/apps/lattice/app?name=' + encodeURIComponent(n);
    a.textContent = 'to the editor';
    d.body.append(a);
    a.click();
  }, RP);
  const shelled = await isFront('page', RP);
  await sleep(500);
  const frameAt = await page.evaluate(() => {
    const f = document.querySelector('#toolhost iframe');
    return f ? f.contentWindow.location.pathname : null;
  });
  check('an editor link in the frame opens in the shell',
    shelled && frameAt === '/apps/lattice/settings', JSON.stringify({ shelled, frameAt }));

  //  today's brief: the unpadded day, when that page exists
  const today = await page.evaluate(() => {
    const d = new Date();
    return 'journal/' + d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate();
  });
  const had = (await fetch(env.base + '/apps/lattice/page-source?name=' + encodeURIComponent(today),
    { headers: { Cookie: env.cookie } })).ok;
  if (!had) await seed(env, [[today, '# brief\n']]);
  //  a comment on RP, unseen, for the inbox badge after the reload
  await post('page-comments?name=' + encodeURIComponent(RP) + '&on=1');
  await sleep(2000);
  await post('comment?page=' + encodeURIComponent(RP), 'body=shell+inbox+probe');
  await sleep(2000);
  await page.evaluate(() => localStorage.removeItem('cmtSeen'));
  await boot();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const unread = await until(() => document.getElementById('rb-inbox').classList.contains('has-unread'), null, 45000);
  check('inbox badge moved', unread);
  await page.evaluate(() => document.getElementById('rb-inbox').click());
  const inTab = await isFront('tool', 'inbox');
  const read = await until(() => !document.getElementById('rb-inbox').classList.contains('has-unread')
    && document.getElementById('toolhost').contains(document.getElementById('cmlist'))
    && !!document.querySelector('#cmlist .aclcard'));
  check('the inbox opens as a tab and clears the badge', inTab && read, JSON.stringify({ inTab, read }));

  await page.evaluate(() => document.getElementById('rb-brief').click());
  const brief = await isFront('page', today);
  check('brief opens journal', brief, JSON.stringify({ today, front: await front() }));
  if (!had) await post('page-del?name=' + encodeURIComponent(today)).catch(() => {});

  //  the ribbon's ways off the editor ask about unsaved work first. A grub
  //  never autosaves, so its edit is still unsaved when Browser is clicked.
  await openDoc('grub', sbase + '/page/' + RP + '/code');
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value += '\n';
    s.dispatchEvent(new Event('input'));
  });
  await page.evaluate(() => document.getElementById('rb-browser').click());
  const asked = await until(() => !document.getElementById('dlg').hidden, null, 5000);
  await page.evaluate(() => document.getElementById('dlgcancel').click());
  await sleep(500);
  const stayed2 = await page.evaluate(() => location.pathname);
  let unloadAsk = false;
  page.on('dialog', (d) => { if (d.type() === 'beforeunload') unloadAsk = true; d.accept(); });
  await page.evaluate(() => document.getElementById('rb-browser').click());
  await until(() => !document.getElementById('dlg').hidden, null, 5000);
  await Promise.all([
    page.waitForNavigation({ timeout: 30000 }).catch(() => null),
    page.evaluate(() => document.getElementById('dlgok').click()),
  ]);
  const left = await page.evaluate(() => location.pathname).catch(() => null);
  check('browser asks before leaving unsaved work',
    asked && stayed2 === '/apps/lattice/app' && left === '/apps/lattice' && !unloadAsk,
    JSON.stringify({ asked, stayed2, left, unloadAsk }));
} catch (e) {
  check('threw: ' + String(e.message).slice(0, 140), false);
} finally {
  await page.evaluate(() => {
    for (const k of ['appNT', 'appNC', 'appLTab', 'appRTab', 'appTabs', 'appSort']) localStorage.removeItem(k);
  }).catch(() => {});
  await browser.close();
  await post('know-delete?key=' + encodeURIComponent(MEM)).catch(() => {});
  await post('know-delete?key=' + encodeURIComponent(FRESH)).catch(() => {});
  await post('unbookmark?url=' + encodeURIComponent(MARK)).catch(() => {});
  for (const n of [RP, LINKER, 'x-' + process.pid])
    await post('page-del?name=' + encodeURIComponent(n)).catch(() => {});
}
check.done();
