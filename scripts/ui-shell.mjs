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
//      opens as a know tab beside a still-rendered Files tree, Ctrl+Shift+F
//      focuses the Search tab, sort flips the root order, the trash
//      restores a deleted memory, and Bookmarks lists /bookmarks-json
//    the ribbon, top to bottom, and its tool tabs: Access & groups and the
//      inbox render in a tab (the inbox carries the unread badge), Settings
//      frames the settings page without its reader bar, the brief opens
//      today's journal page, and leaving for the desktop's manager page
//      asks about unsaved work first
//    the command palette: Ctrl+P and the ribbon open it, actions match
//      first with their home, pages after them open with Enter (Ctrl+Enter
//      in a new tab), and every action it lists has a home in the DOM
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
const FRAMEP = 'x-' + process.pid + '/framed';
const PALP = 'x-' + process.pid + '/access-palette';
const PALQ = 'x-' + process.pid + '/palette-newtab';
const AUTOP = 'x-' + process.pid + '/autosave-off';
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
    keptHidden: ['pname', 'pkind', 'texconv', 'save']
      .filter((id) => { const e = document.getElementById(id); return !e || e.getBoundingClientRect().width > 0; }),
    holder: ['pname', 'pkind', 'texconv']
      .every((id) => !!document.querySelector('#tabhead #tholder[hidden] #' + id)),
    barGone: !document.querySelector('lat-bar, .bar, #wrapt'),
  }));
  check('tree and status moved',
    moved.tree && moved.ctl && moved.status && moved.spin && moved.off && moved.editor,
    JSON.stringify(moved));
  check('the old bar controls exist but are off screen', moved.keptHidden.length === 0,
    JSON.stringify(moved.keptHidden));
  check('the old bar is gone; its stores sit in the tab header\'s hidden holder',
    moved.holder && moved.barGone, JSON.stringify(moved));

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
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyF');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await sleep(300);
  const ck = await page.evaluate(() => ({
    focus: document.activeElement && document.activeElement.id,
    tab: !document.querySelector('section[data-pane=search]').hidden,
  }));
  const lpaneUp = await shown('#lpane');
  check('ctrl+shift+f focuses search pane', ck.focus === 'qinput' && ck.tab && lpaneUp,
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
    .map((b) => (b.title === b.getAttribute('aria-label') ? b.title : '!' + b.title)
      .replace(/^(Comments inbox), \S+ unread$/, '$1')));
  check('ribbon order and tooltips', JSON.stringify(names) === JSON.stringify([
    "Today's brief", 'Browser', 'Forum', 'Comments inbox', 'Access & groups',
    'Sync conflicts', 'Command palette (Ctrl+K)', 'Settings']), JSON.stringify(names));

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

  // ── the command palette ────────────────────────────────────────────────
  await seed(env, [[PALP, '# palette target\n'], [PALQ, '# palette new tab\n']]);
  //  no access tab open, so running the action makes one
  await page.evaluate(async () => {
    for (const t of window.latTabs.state().tabs.filter((x) => x.kind === 'tool'))
      await window.latTabs.closeTab(t.id);
  });
  await boot();
  await openDoc('page', RP);
  const palRows = () => page.evaluate(() => [...document.querySelectorAll('#pallist .palrow')]
    .map((r) => ({ kind: r.dataset.kind, name: r.querySelector('.palname')?.textContent,
      home: r.querySelector('.palhome')?.textContent || '', key: r.dataset.key || '' })));
  const palType = async (q) => {
    await page.evaluate(() => { const i = document.getElementById('palin'); if (i) i.value = ''; });
    await page.keyboard.type(q);
    await sleep(250);
  };
  const ctrl = async (code) => {
    await page.keyboard.down('Control');
    await page.keyboard.press(code);
    await page.keyboard.up('Control');
  };
  //  the print dialog is the browser default for Ctrl+P: watched as
  //  defaultPrevented on the way out of the page
  await page.evaluate(() => {
    window.__pPrevented = null;
    addEventListener('keydown', (e) => { if (e.key === 'p') window.__pPrevented = e.defaultPrevented; });
  });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await ctrl('KeyP');
  const palUp = await until(() => {
    const p = document.getElementById('palette');
    return !!p && !p.hidden && document.activeElement === document.getElementById('palin');
  }, null, 5000);
  await palType('acc');
  const accRows = await palRows();
  const n3 = (await front()).n;
  await page.keyboard.press('Enter');
  const palAcc = await isFront('tool', 'access');
  const palGone = await page.evaluate(() => document.getElementById('palette')?.hidden === true);
  check('ctrl+p opens palette',
    palUp && accRows[0]?.name === 'Access & groups' && accRows[0]?.home === 'Ribbon'
      && palAcc && palGone && (await front()).n === n3 + 1
      && (await page.evaluate(() => window.__pPrevented)) === true,
    JSON.stringify({ palUp, first: accRows[0], palAcc, palGone }));

  //  the ribbon button opens the same palette, and Esc closes it
  await page.evaluate(() => document.getElementById('rb-palette').click());
  const viaRib = await until(() => document.getElementById('palette')?.hidden === false, null, 5000);
  await page.keyboard.press('Escape');
  const escShut = await until(() => document.getElementById('palette')?.hidden === true, null, 5000);
  check('the ribbon opens the palette and esc closes it', viaRib && escShut,
    JSON.stringify({ viaRib, escShut }));

  //  typed text is text: nothing it holds becomes markup
  await openDoc('page', RP);
  await ctrl('KeyP');
  await palType('<img src=x onerror="window.__palx=1">');
  const inert = await page.evaluate(() => !document.querySelector('#pallist img') && !window.__palx);
  check('palette input never becomes markup', inert);

  await palType('access');
  const mixed = await palRows();
  const lastAct = mixed.map((r) => r.kind).lastIndexOf('action');
  const firstDoc = mixed.findIndex((r) => r.kind !== 'action');
  const pRow = mixed.findIndex((r) => r.kind === 'page' && r.key === PALP);
  await palType(PALP);
  const only = await palRows();
  const n4 = (await front()).n;
  await page.keyboard.press('Enter');
  const palPage = await isFront('page', PALP);
  const n5 = (await front()).n;
  check('pages listed after actions',
    lastAct >= 0 && pRow > lastAct && firstDoc > lastAct && only[0]?.key === PALP && palPage && n5 === n4,
    JSON.stringify({ lastAct, firstDoc, pRow, first: only[0], palPage, n4, n5 }));
  await ctrl('KeyP');
  await palType(PALQ);
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  const palNew = await isFront('page', PALQ);
  const n6 = (await front()).n;
  check('ctrl+enter opens a page in a new tab', palNew && n6 === n5 + 1, JSON.stringify({ palNew, n5, n6 }));

  //  the page menu builds its items when it opens, so it is opened first
  await page.evaluate(() => document.getElementById('tmenu').click());
  await sleep(200);
  const homeless = await page.evaluate(() => {
    const P = window.latPalette;
    if (!P) return null;
    return { n: P.ids().length, only: P.only,
      //  shtest is the ribbonAdd probe above, whose button the suite removed
      //  a home rendered on demand (the page menu's items, a shared row's
      //  control) is there exactly while its when() holds, so one whose
      //  when() is false counts as homed. Never a hidden stand-in.
      missing: P.ids().filter((id) => id !== 'shtest' && !P.only.includes(id) && P.applies(id)
        && !document.querySelector('[data-action="' + CSS.escape(id) + '"]')) };
  });
  await page.evaluate(() => document.getElementById('tmenu').click());
  check('every action has a home in the DOM',
    !!homeless && homeless.n >= 30 && JSON.stringify(homeless.only) === '["explorer"]'
      && homeless.missing.length === 0,
    JSON.stringify(homeless));

  await page.evaluate(() => document.getElementById('rb-settings').click());
  const setTab = await isFront('tool', 'frame:/apps/lattice/settings');
  const framed = await until(() => {
    const f = document.querySelector('#toolhost iframe:not([hidden])');
    const d = f && f.contentDocument;
    const bar = d && d.querySelector('form.bar');
    return !!(d && d.getElementById('themeui') && bar && getComputedStyle(bar).display === 'none');
  });
  check('settings frame hides reader bar', setTab && framed, JSON.stringify({ setTab, framed }));
  //  a link to the editor inside the frame opens in a new shell tab, not
  //  in the frame and not over the Settings tab
  await seed(env, [[FRAMEP, '# from the frame\n']]);
  const nf = (await front()).n;
  await page.evaluate((n) => {
    const d = document.querySelector('#toolhost iframe:not([hidden])').contentDocument;
    const a = d.createElement('a');
    a.href = '/apps/lattice/app?name=' + encodeURIComponent(n);
    a.textContent = 'to the editor';
    d.body.append(a);
    a.click();
  }, FRAMEP);
  const shelled = await isFront('page', FRAMEP);
  await sleep(500);
  const frameAt = await page.evaluate(() => {
    const f = document.querySelector('#toolhost iframe');
    return f ? f.contentWindow.location.pathname : null;
  });
  const afterF = await page.evaluate(() => window.latTabs.state().tabs.map((t) => t.key));
  check('an editor link in the frame opens in a new shell tab',
    shelled && frameAt === '/apps/lattice/settings' && afterF.length === nf + 1
      && afterF.includes('frame:/apps/lattice/settings'),
    JSON.stringify({ shelled, frameAt, nf, afterF }));

  // ── settings: editor, publishing, legacy, connection ───────────────────
  //  latOpenSettings opens the Settings tab (or focuses the open one) and
  //  brings the named section to the top of the frame
  await openDoc('page', RP);
  await page.evaluate(() => window.latOpenSettings && window.latOpenSettings('legacy'));
  const atLegacy = await until(() => {
    const f = document.querySelector('#toolhost iframe[data-tool="frame:/apps/lattice/settings"]');
    const d = f && f.contentDocument;
    const e = d && d.getElementById('legacy');
    if (!e) return false;
    const top = e.getBoundingClientRect().top;
    return f.contentWindow.scrollY > 0 && top >= 0 && top < f.contentWindow.innerHeight - 40;
  });
  const anchors = await page.evaluate(() => {
    const d = document.querySelector('#toolhost iframe[data-tool="frame:/apps/lattice/settings"]')?.contentDocument;
    if (!d) return null;
    return { vim: !!d.querySelector('#editor #vimsel'), wrap: !!d.querySelector('#editor #wrapdef'),
      auto: !!d.querySelector('#editor #autosave'), pub: !!d.getElementById('publishing'),
      legacy: !!d.getElementById('legacy'), backup: !!d.querySelector('#backup ~ #vaultui'),
      conn: d.getElementById('connection') ? d.getElementById('connection').hidden : 'absent',
      sched: !d.getElementById('bksched') || d.getElementById('bksched').hidden,
      schedNote: /desktop app/.test(d.getElementById('vaultui').textContent) };
  });
  check('settings has editor, publishing, legacy anchors',
    !!anchors && anchors.vim && anchors.wrap && anchors.auto && anchors.pub && anchors.legacy
      && anchors.backup && anchors.conn === true && anchors.sched && anchors.schedNote,
    JSON.stringify(anchors));
  //  already open: no second tab, and the frame scrolls to the new section
  const nSet = (await front()).n;
  await page.evaluate(() => window.latOpenSettings && window.latOpenSettings('backup'));
  const atBackup = await until(() => {
    const d = document.querySelector('#toolhost iframe[data-tool="frame:/apps/lattice/settings"]')?.contentDocument;
    const e = d && d.getElementById('backup');
    return !!e && Math.abs(e.getBoundingClientRect().top) < 40;
  });
  check('latOpenSettings scrolls to its section, also when Settings is open',
    atLegacy && atBackup && (await front()).n === nSet, JSON.stringify({ atLegacy, atBackup }));

  //  the reset shows only while the key is set, and follows a change made
  //  in the shell through the storage event
  const pubGone = await page.evaluate(() => { localStorage.removeItem('latPubOk'); return true; });
  const pubHidden = await until(() => document.querySelector('#toolhost iframe[data-tool="frame:/apps/lattice/settings"]')
    ?.contentDocument.getElementById('pubreset')?.hidden === true, null, 5000);
  await page.evaluate(() => { localStorage.latPubOk = '1'; });
  const pubShown = await until(() => document.querySelector('#toolhost iframe[data-tool="frame:/apps/lattice/settings"]')
    ?.contentDocument.getElementById('pubreset')?.hidden === false, null, 5000);
  await page.evaluate(() => document.querySelector('#toolhost iframe[data-tool="frame:/apps/lattice/settings"]')
    .contentDocument.getElementById('pubreset').click());
  const pubReset = await page.evaluate(() => !('latPubOk' in localStorage));
  check('pubOk reset', pubGone && pubHidden && pubShown && pubReset,
    JSON.stringify({ pubHidden, pubShown, pubReset }));

  //  wrap default: the frame writes appWrap and the shell repaints from it
  const wrap0 = await page.evaluate(() => localStorage.appWrap);
  await page.evaluate(() => document.querySelector('#toolhost iframe[data-tool="frame:/apps/lattice/settings"]')
    .contentDocument.getElementById('wrapdef').click());
  const wrapped = await until((w) => localStorage.appWrap !== w
    && document.getElementById('ws').classList.contains('wrap') === (localStorage.appWrap === '1'), wrap0, 5000);
  await page.evaluate(() => document.querySelector('#toolhost iframe[data-tool="frame:/apps/lattice/settings"]')
    .contentDocument.getElementById('wrapdef').click());
  const wrapBack = await until((w) => localStorage.appWrap === w
    && document.getElementById('ws').classList.contains('wrap') === (w === '1'), wrap0, 5000);
  check('wrap default in settings reaches the open editor', wrapped && wrapBack,
    JSON.stringify({ wrap0, wrapped, wrapBack }));

  //  autosave off: typing waits for Ctrl+S, and the tab says it is unsaved
  await seed(env, [[AUTOP, 'autosave base\n']]);
  const autoOn = await page.evaluate(() => document.querySelector('#toolhost iframe[data-tool="frame:/apps/lattice/settings"]')
    .contentDocument.getElementById('autosave').checked);
  await page.evaluate(() => document.querySelector('#toolhost iframe[data-tool="frame:/apps/lattice/settings"]')
    .contentDocument.getElementById('autosave').click());
  const autoOff = await page.evaluate(() => localStorage.latAutosave === '0');
  await openDoc('page', AUTOP);
  await until(() => document.getElementById('src').value.startsWith('autosave base'));
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.focus();
    s.value += 'typed with autosave off\n';
    s.dispatchEvent(new Event('input'));
  });
  await sleep(4000);
  const shipBody = async () => {
    const r = await fetch(env.base + '/apps/lattice/page-source?name=' + encodeURIComponent(AUTOP),
      { headers: { Cookie: env.cookie } });
    return r.ok ? r.text() : null;
  };
  const held = await shipBody();
  const stillD = await page.evaluate(() => !!document.querySelector('.dtab.on.dirty'));
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Control');
  let landed = null;
  for (let i = 0; i < 20 && !(landed || '').includes('typed with autosave off'); i++) {
    await sleep(500);
    landed = await shipBody();
  }
  const cleanAfter = await until(() => !document.querySelector('.dtab.on.dirty'), null, 10000);
  check('autosave off', autoOn && autoOff && held !== null && !held.includes('typed with autosave off')
    && stillD && (landed || '').includes('typed with autosave off') && cleanAfter,
    JSON.stringify({ autoOn, autoOff, held: held && held.slice(0, 60), stillD, cleanAfter }));
  await page.evaluate(() => localStorage.removeItem('latAutosave'));

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
  const named = await page.evaluate(() => {
    const b = document.getElementById('rb-inbox');
    return { t: b.title, l: b.getAttribute('aria-label') };
  });
  check('inbox badge moved', unread && named.t === named.l && /^Comments inbox, \S+ unread$/.test(named.l),
    JSON.stringify({ unread, named }));
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
  //  the grub's body lands after its tab shows, and repaints a clean
  //  editor, so the edit waits for it and then must read as unsaved
  await openDoc('grub', sbase + '/page/' + RP + '/code');
  await until(() => document.getElementById('src').value.length > 0);
  await sleep(2000);
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value += 'unsaved probe\n';
    s.dispatchEvent(new Event('input'));
  });
  await until(() => document.querySelector('.dtab.on.dirty') !== null, null, 5000);
  //  Save does nothing while a tool tab is in front: the dirty grub parked
  //  under it is not written from a screen that does not show it. Watched
  //  as the request itself, since the ship may refuse or delay the body.
  let grubSaves = 0;
  const onReq = (r) => { if (/\/(grub|remote)-save\b/.test(r.url())) grubSaves++; };
  page.on('request', onReq);

  const grubTab = await page.evaluate(() => { const s = window.latTabs.state(); return s.tabs[s.active].id; });
  await page.evaluate(() => document.getElementById('rb-access').click());
  const underTool = await isFront('tool', 'access');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Control');
  await page.evaluate(() => document.getElementById('save').click());
  await sleep(3000);
  page.off('request', onReq);
  await page.evaluate((id) => window.latTabs.switchTab(id), grubTab);
  const stillDirty = await until(() => {
    const s = window.latTabs.state();
    return s.tabs[s.active].kind === 'grub' && document.querySelector('.dtab.on.dirty') !== null;
  }, null, 5000);
  check('save under a tool tab leaves the hidden grub alone',
    underTool && grubSaves === 0 && stillDirty, JSON.stringify({ underTool, grubSaves, stillDirty }));
  //  the one way off the editor left (Browser and Forum are tabs now): the
  //  desktop's manager page, here with a stand-in for the desktop's bridge
  await page.evaluate(() => {
    window.__mgr = null;
    window.__TAURI__ = { core: { invoke: async (cmd) => { window.__mgr = cmd; } } };
  });
  await page.evaluate(() => { window.latOpenManager(); });
  const asked = await until(() => !document.getElementById('dlg').hidden, null, 5000);
  await page.evaluate(() => document.getElementById('dlgcancel').click());
  await sleep(500);
  const stayed2 = await page.evaluate(() => window.__mgr);
  await page.evaluate(() => { window.latOpenManager(); });
  await until(() => !document.getElementById('dlg').hidden, null, 5000);
  await page.evaluate(() => document.getElementById('dlgok').click());
  const left = await until(() => window.__mgr === 'open_manager', null, 10000);
  await page.evaluate(() => { delete window.__TAURI__; });
  check('leaving for the manager page asks about unsaved work first',
    asked && stayed2 === null && left, JSON.stringify({ asked, stayed2, left }));
} catch (e) {
  check('threw: ' + String(e.message).slice(0, 140), false);
} finally {
  await page.evaluate(() => {
    for (const k of ['appNT', 'appNC', 'appLTab', 'appRTab', 'appTabs', 'appSort', 'latAutosave', 'latPubOk'])
      localStorage.removeItem(k);
  }).catch(() => {});
  await browser.close();
  await post('know-delete?key=' + encodeURIComponent(MEM)).catch(() => {});
  await post('know-delete?key=' + encodeURIComponent(FRESH)).catch(() => {});
  await post('unbookmark?url=' + encodeURIComponent(MARK)).catch(() => {});
  for (const n of [RP, LINKER, 'x-' + process.pid])
    await post('page-del?name=' + encodeURIComponent(n)).catch(() => {});
}
check.done();
