//  ui-mobar.mjs: the phone shell (src/97-mobar.js + the 820px block).
//
//  At phone width the side panes are drawers over the document, opened by
//  the corner toggles or an edge swipe and shut by the scrim, and a bottom
//  bar holds new page, search, today's brief and the open-tabs switcher.
//  Worth a harness because every failure mode here is silent: a control
//  that is hidden with no working replacement is just gone, and nothing
//  throws (the tree-+ bug shipped exactly that way).
//
//  Seeds three pages in two mobar-<pid> folders and removes the folders at
//  the end.
//
//  Usage:  LATTICE_URL=http://localhost:8081 \
//          LATTICE_COOKIE=~/.config/lattice-fs/cookie node scripts/ui-mobar.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, seed, sleep } from './lib/harness.mjs';

const env = shipEnv();
const RUN = 'mobar-' + process.pid;
const A = RUN + '/alpha';
const B = RUN + '/beta';
//  a folder and page with names far wider than a phone, which must
//  truncate rather than widen the drawer (the + stays in reach)
const LONGDIR = RUN + '-with-a-folder-name-far-wider-than-any-phone-screen';
const LONG = LONGDIR + '/a-page-name-that-is-also-far-wider-than-any-phone-screen';
await seed(env, [[A, '# alpha'], [B, '# beta'], [LONG, '# long']]);
const check = makeCheck();
const browser = await launchBrowser();

const boot = async (width, height) => {
  const p = await openPage(browser, env,
    { viewport: { width, height, isMobile: width < 820, hasTouch: width < 820 } });
  await p.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  return p;
};
// on screen and not covered: the point at its centre hits it (or a child)
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
const inView = (p, id) => p.evaluate((i) => {
  const r = document.getElementById(i).getBoundingClientRect();
  return r.left >= 0 && r.right <= innerWidth && r.width > 0;
}, id);
const offScreen = (p, id) => p.evaluate((i) => {
  const r = document.getElementById(i).getBoundingClientRect();
  return r.right <= 0 || r.left >= innerWidth;
}, id);
// the drawers slide; wait for the move to finish before measuring
const still = () => sleep(450);
const tapAt = async (p, x, y) => { await p.touchscreen.tap(x, y); await still(); };
// a control that is missing or covered fails its check, not the run
const tap = async (p, sel) => {
  try { await p.tap(sel); } catch (e) { console.log('  (no tap on ' + sel + ': ' + e.message + ')'); }
  await still();
};
const until = async (p, fn, arg) => {
  try { await p.waitForFunction(fn, { timeout: 15000 }, arg); return true; } catch { return false; }
};
const closeAll = async (p) => {
  await p.evaluate(() => document.getElementById('ws').classList.remove('ldraw', 'rdraw'));
  await still();
};

//  a crash still removes what was seeded
try {
  // ── phone ──────────────────────────────────────────────────────────────────
  const m = await boot(390, 844);
  await closeAll(m);

  check('old mobile chrome gone: #mtabs, #msheet, #mmore, #fullt, #mpath', await m.evaluate(() =>
    ['mtabs', 'msheet', 'mmore', 'fullt', 'mpath'].every((i) => !document.getElementById(i))));
  check('the obsolete layout keys are gone', await m.evaluate(() =>
    !('appMv' in localStorage) && !('appFull' in localStorage)));
  check('the bottom bar is on screen', await reach(m, '#mbar'));
  check('both drawers start shut', (await offScreen(m, 'lpane')) && (await offScreen(m, 'rpane')));

  // drawers open and close
  await tap(m, '#treet');
  check('#treet opens the left drawer', await inView(m, 'lpane'));
  check('and says so', await m.evaluate(() =>
    document.getElementById('treet').getAttribute('aria-pressed') === 'true'));
  check('the ribbon rides in the left drawer', await inView(m, 'ribbon'));
  check('the ribbon is not cloned', await m.evaluate(() =>
    document.querySelectorAll('[data-rb=palette]').length === 1));
  await tapAt(m, 380, 420);
  check('the scrim shuts it', await offScreen(m, 'lpane'));
  check('the ribbon goes with it', await offScreen(m, 'ribbon'));
  check('and the toggle says so', await m.evaluate(() =>
    document.getElementById('treet').getAttribute('aria-pressed') === 'false'));
  await tap(m, '#ctlt');
  check('#ctlt opens the right drawer', await inView(m, 'rpane'));
  await tapAt(m, 10, 420);
  check('the scrim shuts that too', await offScreen(m, 'rpane'));

  // edge swipe: from within 24px of the edge only
  const swipe = async (x0, x1, y = 420) => {
    await m.evaluate((a, b, yy) => {
      const t = (x) => [new Touch({ identifier: 1, target: document.body, clientX: x, clientY: yy })];
      const fire = (type, x) => document.body.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : t(x), changedTouches: t(x) }));
      fire('touchstart', a);
      for (let i = 1; i <= 5; i++) fire('touchmove', a + (b - a) * i / 5);
      fire('touchend', b);
    }, x0, x1, y);
    await still();
  };
  await swipe(5, 120);
  check('a swipe in from the left edge opens the left drawer', await inView(m, 'lpane'));
  await closeAll(m);
  await swipe(385, 270);
  check('a swipe in from the right edge opens the right drawer', await inView(m, 'rpane'));
  await closeAll(m);
  await swipe(60, 200);
  check('a swipe from mid-screen opens nothing',
    (await offScreen(m, 'lpane')) && (await offScreen(m, 'rpane')));
  await m.evaluate(() => {
    const s = document.getElementById('src');
    s.value = 'select some of this text';
    s.focus();
    s.setSelectionRange(0, 6);
  });
  await swipe(5, 120);
  check('no swipe while text in the editor is selected', await offScreen(m, 'lpane'));
  await m.evaluate(() => {
    const s = document.getElementById('src');
    s.setSelectionRange(0, 0);
    s.value = '';
    s.blur();
  });

  // the command palette by touch (Task 8 review)
  await tap(m, '#treet');
  await tap(m, '#rb-palette');
  check('left drawer > palette opens the command palette', await m.evaluate(() => {
    const p = document.getElementById('palette');
    return !!p && !p.hidden && p.getBoundingClientRect().height > 0;
  }));
  await m.keyboard.press('Escape');
  await closeAll(m);

  // every placement-map home reachable: on screen as is, or after one drawer
  const HOMES = ['#newfile', '[data-pt=know]', '[data-pt=marks]', '#tmenu', '#tread',
    '[data-pt=page]', '[data-pt=hist]', '#rb-settings', '#rb-access', '#rb-inbox'];
  for (const sel of HOMES) {
    let how = null;
    if (await reach(m, sel)) how = 'as is';
    for (const [t, side] of [['#treet', 'left'], ['#ctlt', 'right']]) {
      if (how) break;
      await tap(m, t);
      if (await reach(m, sel)) how = side + ' drawer';
      await closeAll(m);
    }
    check('reachable: ' + sel, !!how, how || 'nowhere');
  }
  await tap(m, '#mb-search');
  check('reachable: #qinput, from the bottom bar search', await reach(m, '#qinput'));
  check('and the search field has the focus', await m.evaluate(() =>
    document.activeElement && document.activeElement.id === 'qinput'));
  await m.evaluate(() => document.activeElement.blur());
  await closeAll(m);
  await m.evaluate(() => document.querySelector('#ltabs [data-pt=files]').click());

  // opening a page closes the drawer
  await tap(m, '#treet');
  const opened = await m.evaluate(() => {
    const l = document.querySelector('#treelist a.pg');
    l.click();
    return new URL(l.href, location.href).searchParams.get('name');
  });
  await until(m, (n) => document.getElementById('pname').value === n, opened);
  await still();
  check('opening a page closes the drawer', (await offScreen(m, 'lpane'))
    && await m.evaluate(() => !document.getElementById('ws').classList.contains('ldraw')));

  // the tab header and the tab strip at 390px
  check('the tab header is on screen', await reach(m, '#tpath'));
  check('the path names the open page', await m.evaluate((n) =>
    document.getElementById('tpath').textContent.includes(n), opened));
  check('the tab strip is on screen', await reach(m, '#doctabs .dtab.on'));

  // tab switcher: exactly two tabs, listed, and a tap switches
  await m.evaluate(async (a, b) => {
    const T = window.latTabs;
    await T.openIn('page', a);
    for (const t of T.list()) if (t.key !== a) await T.closeTab(t.id);
    await T.openIn('page', b, { newTab: true });
  }, A, B);
  await until(m, (b) => document.getElementById('pname').value === b, B);
  await tap(m, '#mtabsw');
  const rows = await m.evaluate(() =>
    [...document.querySelectorAll('#mtsheet .mtrow')].map((r) => r.dataset.key));
  check('tab switcher lists the two open tabs', rows.length === 2 && rows.includes(A) && rows.includes(B),
    JSON.stringify(rows));
  await tap(m, '#mtsheet .mtrow[data-key="' + A + '"] .mtname');
  await until(m, (a) => document.getElementById('pname').value === a, A);
  check('tapping the other makes it active', await m.evaluate((a) => {
    const s = window.latTabs.state();
    return s.tabs[s.active].key === a;
  }, A));
  check('and the sheet is away', await m.evaluate(() => {
    const s = document.getElementById('mtsheet');
    return !s || s.hidden;
  }));
  await tap(m, '#mtabsw');
  await tap(m, '#mtsheet .mtrow[data-key="' + B + '"] .mtx');
  await until(m, () => window.latTabs.list().length === 1);
  check('a row\'s close closes that tab', await m.evaluate((a) =>
    window.latTabs.list().map((t) => t.key).join() === a, A));
  await m.evaluate(() => { const s = document.getElementById('mtsheet'); if (s) s.hidden = true; });

  // Save on a phone: an icon button, and only while a grub tab is in front.
  // Pages and memories autosave, and a tool tab has nothing to save. The
  // grub is the code grub of page A, opened and never typed into.
  const shown = (p, sel) => p.evaluate((s) => {
    const e = document.querySelector(s);
    return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
  }, sel);
  const frontIs = (p, kind, key) => until(p, ([k, y]) => {
    const s = window.latTabs.state();
    return s.tabs[s.active].kind === k && (y === null || s.tabs[s.active].key === y);
  }, [kind, key]);
  const lbase = (await (await fetch(env.base + '/apps/lattice/streams',
    { headers: { Cookie: env.cookie } })).json()).base;
  const GRUB = lbase + '/page/' + A + '/code';
  check('phone: no Save while a page is in front', !(await shown(m, '#save')));
  await m.evaluate((g) => window.latTabs.openIn('grub', g, { newTab: true }), GRUB);
  await frontIs(m, 'grub', GRUB);
  check('phone: Save is on screen while a grub is in front', await reach(m, '#save'));
  check('and it is an icon button, Save (Ctrl+S)', await m.evaluate(() => {
    const b = document.getElementById('save');
    return b.title === 'Save (Ctrl+S)' && b.getAttribute('aria-label') === b.title
      && !!b.querySelector('svg') && !b.textContent.trim();
  }));
  await m.evaluate(() => window.latOpenSettings());
  await frontIs(m, 'tool', null);
  check('phone: no Save while a tool tab is in front', !(await shown(m, '#save')));
  await m.evaluate(async () => {
    const T = window.latTabs;
    for (const t of T.list()) if (t.kind !== 'page') await T.closeTab(t.id);
  });
  await frontIs(m, 'page', A);
  check('phone: and none back on the page', !(await shown(m, '#save')));

  // Ctrl+E switches Edit / Read on a phone too (a keyboard case, a tablet)
  await m.evaluate(() => document.activeElement && document.activeElement.blur());
  await m.keyboard.down('Control');
  await m.keyboard.press('e');
  await m.keyboard.up('Control');
  check('phone: Ctrl+E turns Read on', await m.evaluate(() =>
    document.getElementById('ws').classList.contains('vp')));
  await m.keyboard.down('Control');
  await m.keyboard.press('e');
  await m.keyboard.up('Control');
  check('and off', await m.evaluate(() => document.getElementById('ws').classList.contains('ve')));

  // a sideways drag along the tab strip scrolls it, even from the screen's edge
  const stripY = await m.evaluate(() => {
    const r = document.querySelector('#doctabs .dtlist').getBoundingClientRect();
    return r.top + r.height / 2;
  });
  await m.evaluate((y) => {
    const el = document.querySelector('#doctabs .dtlist');
    const t = (x) => [new Touch({ identifier: 1, target: el, clientX: x, clientY: y })];
    const fire = (type, x) => el.dispatchEvent(new TouchEvent(type, {
      bubbles: true, cancelable: true,
      touches: type === 'touchend' ? [] : t(x), changedTouches: t(x) }));
    fire('touchstart', 10);
    for (let i = 1; i <= 5; i++) fire('touchmove', 10 + 110 * i / 5);
    fire('touchend', 120);
  }, stripY);
  await still();
  check('a drag that starts on the tab strip opens no drawer', await offScreen(m, 'lpane'));
  await closeAll(m);

  // the bottom bar's items are titled buttons, each an action
  check('bottom bar items are actions', await m.evaluate(() =>
    ['mb-new', 'mb-search', 'mb-brief', 'mtabsw'].every((i) => {
      const b = document.getElementById(i);
      return !!b && !!b.dataset.action && b.getAttribute('aria-label') === b.title;
    })));
  await tap(m, '#mb-new');
  let newOpen = false;
  try { await m.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 5000 }); newOpen = true; } catch {}
  check('bottom bar new page opens the new-page prompt', newOpen);
  await m.evaluate(() => document.getElementById('dlgcancel').click());

  // Read paints the preview on a phone. The pane is display:none until it is
  // shown, and Chromium never paints a sandboxed frame that loaded while
  // hidden (60-preview.js, showPreview). Painted means hiding the frame's
  // text changes the pixels.
  await m.evaluate(() => {
    const s = document.getElementById('src');
    s.value = '# painted\n\nRead shows this.';
    s.dispatchEvent(new Event('input'));
  });
  await tap(m, '#tread [data-r="1"]');
  await sleep(1200);
  const pbox = await m.evaluate(() => {
    const r = document.getElementById('prev').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 160) };
  });
  let painted = false;
  if (pbox.width && pbox.height) {
    const shown = await m.screenshot({ clip: pbox });
    await (await (await m.$('#prev')).contentFrame()).evaluate(() => { document.body.style.visibility = 'hidden'; });
    const blank = await m.screenshot({ clip: pbox });
    painted = !Buffer.from(shown).equals(Buffer.from(blank));
  }
  check('phone: Read paints the page', painted, JSON.stringify(pbox));
  await tap(m, '#tread [data-r="0"]');

  // nothing may stick out past the device width (innerWidth stretches with
  // the overflow, so measure against 390)
  const over = await m.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll('#ws > *, .center *, #mbar *')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > 391 && !el.closest('.dtlist')) n++;
    }
    return { scrollW: document.documentElement.scrollWidth, past: n };
  });
  check('phone: no horizontal scroll', over.scrollW <= 390 && over.past === 0, JSON.stringify(over));
  await tap(m, '#treet');
  const longRow = await m.evaluate((dir) => {
    const f = [...document.querySelectorAll('#treelist .fld')].find((x) => x.textContent.includes(dir));
    const a = f && f.querySelector('.addf');
    const r = a && a.getBoundingClientRect();
    const d = document.getElementById('lpane').getBoundingClientRect();
    return { plus: r && r.width ? Math.round(r.right) : null, drawer: Math.round(d.right) };
  }, LONGDIR);
  check('phone: a long folder name truncates and keeps its + in the drawer',
    longRow.plus !== null && longRow.plus <= longRow.drawer, JSON.stringify(longRow));
  await m.evaluate((dir) => {
    const f = [...document.querySelectorAll('#treelist .fld')].find((x) => x.textContent.includes(dir));
    f.querySelector('.addf').click();
  }, LONGDIR);
  let plusOpen = false;
  try { await m.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 5000 }); plusOpen = true; } catch {}
  check('phone: a tree folder + opens the new-page prompt', plusOpen);
  await m.evaluate(() => document.getElementById('dlgcancel').click());
  await closeAll(m);

  // ── list indent/outdent by thumb ───────────────────────────────────────────
  // Phones have no Tab key, so the editor grows a button pair while the caret
  // sits where listTab would act. The tap must not steal focus (the keyboard
  // would drop), and the pair must vanish on prose.
  await m.evaluate(() => {
    const s = document.getElementById('src');
    s.value = '1. one\n- two\n- [ ] three\nplain prose';
    s.dispatchEvent(new Event('input'));
  });
  const caretTo = async (ln) => {
    await m.evaluate((l) => {
      const s = document.getElementById('src');
      s.focus();
      const at = s.value.split('\n').slice(0, l).join('\n').length + (l ? 1 : 0);
      s.setSelectionRange(at + 2, at + 2);
      document.dispatchEvent(new Event('selectionchange'));
    }, ln);
    await sleep(300);   // the paint is debounced
  };
  const pairOn = () => m.evaluate(() => {
    const b = document.getElementById('lbtns');
    return b.classList.contains('on') && getComputedStyle(b).display !== 'none';
  });
  const line = (n) => m.evaluate((i) => document.getElementById('src').value.split('\n')[i], n);
  const press = (id) => m.evaluate((i) => {
    document.getElementById(i).dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
  }, id);
  await caretTo(0);
  check('ordered item: the pair appears', await pairOn());
  check('and is on screen, not under the bottom bar', await reach(m, '#lind'));
  await press('lind');
  check('ordered item indents by tap', (await line(0)) === '  1. one', await line(0));
  await press('loutd');
  check('and steps back out', (await line(0)) === '1. one', await line(0));
  await caretTo(2);
  await press('lind');
  check('task item indents by tap', (await line(2)) === '  - [ ] three', await line(2));
  check('the textarea keeps focus through taps', await m.evaluate(() =>
    document.activeElement === document.getElementById('src')));
  await caretTo(3);
  check('on prose the pair is gone', !(await pairOn()));
  const gap = await m.evaluate(() => document.getElementById('statusbar').getBoundingClientRect().top
    - document.getElementById('src').getBoundingClientRect().bottom);
  check('and the text runs down to the status bar', Math.abs(gap) <= 1, String(gap));
  await m.close();

  // ── desktop web: untouched ─────────────────────────────────────────────────
  const d = await boot(1400, 900);
  check('desktop: no bottom bar', !(await reach(d, '#mbar')));
  check('desktop: the ribbon is a column again', await d.evaluate(() => {
    const r = document.getElementById('ribbon').getBoundingClientRect();
    return r.left === 0 && r.height > 400 && r.width < 60;
  }));
  check('desktop: the left pane sits beside it', await d.evaluate(() => {
    const s = getComputedStyle(document.getElementById('lpane'));
    return s.position !== 'fixed' && s.transform === 'none';
  }));
  check('desktop: #treet still toggles the column', await d.evaluate(() => {
    const ws = document.getElementById('ws');
    const was = ws.classList.contains('nt');
    document.getElementById('treet').click();
    const now = ws.classList.contains('nt');
    document.getElementById('treet').click();
    return was !== now && !ws.classList.contains('ldraw');
  }));
  await d.evaluate((g) => window.latTabs.openIn('grub', g, { newTab: true }), GRUB);
  await frontIs(d, 'grub', GRUB);
  check('desktop: no Save button even on a grub (Ctrl+S and the File menu)',
    !(await shown(d, '#save')) && await d.evaluate(() => !!document.getElementById('save')));
  await d.evaluate(async () => {
    const T = window.latTabs;
    for (const t of T.list()) if (t.kind === 'grub') await T.closeTab(t.id);
  });
  await d.close();
} catch (e) {
  check('suite crashed: ' + e.message, false);
} finally {
  await browser.close();
  for (const n of [RUN, LONGDIR])
    await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(n),
      { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
}
check.done();
