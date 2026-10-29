//  ui-mobar.mjs — the phone-width bar (src/97-mobar.js + the 820px block).
//
//  At 390px the bar used to wrap into three rows — 184px of chrome before
//  content. It is now one row (home · path label · save · ⋯), with the
//  dropped controls reachable through a ⋯ sheet that clicks the page's own
//  hidden buttons. Worth a harness because every failure mode here is
//  silent: a control that is hidden with no working replacement is just
//  gone, and nothing throws (the tree-+ bug shipped exactly that way).
//
//  Seeds harnessdir/one, so the ship has at least one folder.
//
//  Usage:  LATTICE_URL=http://localhost:8081 \
//          LATTICE_COOKIE=~/.config/lattice-fs/cookie node scripts/ui-mobar.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, seed } from './lib/harness.mjs';

const env = shipEnv();
//  and a folder and page with names far wider than a phone, which must
//  truncate rather than widen the page (the + stays in reach)
const LONGDIR = 'harnessdir-with-a-folder-name-far-wider-than-any-phone-screen';
await seed(env, [['harnessdir/one', '# one'],
  [LONGDIR + '/a-page-name-that-is-also-far-wider-than-any-phone-screen', '# long']]);
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
const vis = (p, id) => p.evaluate((i) => {
  const el = document.getElementById(i);
  return !!el && !el.hidden && el.offsetParent !== null;
}, id);

// ── phone ──────────────────────────────────────────────────────────────────
const m = await boot(390, 844);

const chrome = await m.evaluate(() => ({
  bar: Math.round(document.querySelector('.bar').getBoundingClientRect().height),
  tabs: Math.round(document.querySelector('.mtabs').getBoundingClientRect().height),
}));
check('one bar row: bar is under 60px (was 138)', chrome.bar < 60, chrome.bar + 'px');
check('total chrome under 110px (was 184)', chrome.bar + chrome.tabs < 110,
  (chrome.bar + chrome.tabs) + 'px');

for (const id of ['pname', 'pkind'])
  check('phone: #' + id + ' is off the bar', !(await vis(m, id)));
for (const id of ['mpath', 'mmore', 'save'])
  check('phone: #' + id + ' is on the bar', await vis(m, id));

// the ⋯ sheet: opens, carries the four rows, and its rows drive the real
// buttons — search must actually open the search pane
await m.evaluate(() => document.getElementById('mmore').click());
check('⋯ opens the sheet', await vis(m, 'msheet'));
check('no mode row: memories are the Knowledge tab',
  await m.evaluate(() => !document.getElementById('ms-mode')));
await m.evaluate(() => document.getElementById('ms-q').click());
let qOpened = false;
try {
  await m.waitForFunction(() => document.getElementById('ws').dataset.mv === 'tree'
    && !document.querySelector('section[data-pane=search]').hidden
    && document.activeElement && document.activeElement.id === 'qinput', { timeout: 5000 });
  qOpened = true;
} catch {}
check('sheet > search opens the search tab', qOpened && (await vis(m, 'qinput')));
check('and the sheet is away again', !(await vis(m, 'msheet')));
await m.evaluate(() => document.querySelector('#ltabs [data-pt=files]').click());

// the access row opens the Access & groups tool tab, on screen
await m.evaluate(() => document.getElementById('mmore').click());
await m.evaluate(() => document.getElementById('ms-acl').click());
let aclShown = false;
try {
  await m.waitForFunction(() => {
    const w = document.getElementById('aclwrap');
    return document.getElementById('toolhost').contains(w)
      && w.getBoundingClientRect().height > 0;
  }, { timeout: 15000 });
  aclShown = true;
} catch {}
check('sheet > access opens the access tab', aclShown);
// again from the tree view, with that tab already in front: the tap
// still brings the access tab on screen rather than doing nothing
await m.evaluate(() => document.querySelector('.mtabs button[data-mv="tree"]').click());
await m.evaluate(() => document.getElementById('mmore').click());
await m.evaluate(() => document.getElementById('ms-acl').click());
let aclAgain = false;
try {
  await m.waitForFunction(() => document.getElementById('ws').dataset.mv === 'code'
    && document.getElementById('aclwrap').getBoundingClientRect().height > 0, { timeout: 15000 });
  aclAgain = true;
} catch {}
check('a second access tap from the tree view shows it again', aclAgain);
await m.evaluate(() => {
  const s = window.latTabs.state();
  return window.latTabs.closeTab(s.tabs[s.active].id);
});

// label: open a page, the label says so, tapping it is rename
await m.evaluate(() => { document.querySelector('.mtabs button[data-mv="tree"]').click(); });
const opened = await m.evaluate(() => {
  const a = document.querySelector('#treelist a.pg');
  a.click();
  return new URL(a.href, location.href).searchParams.get('name');
});
await m.waitForFunction(() => document.getElementById('mpath').textContent !== 'no page open',
  { timeout: 15000 });
const label = await m.evaluate(() => document.getElementById('mpath').textContent);
check('the label carries the open page', !!opened && label.includes(opened), label + ' (opened ' + opened + ')');
await m.evaluate(() => document.getElementById('mpath').click());
let renameOpen = false;
try { await m.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 5000 }); renameOpen = true; } catch {}
check('tapping the label opens move/rename', renameOpen);
const seeded = await m.evaluate(() => document.getElementById('dlginput').value);
check('pre-filled with the current name', seeded === label, JSON.stringify(seeded));
await m.evaluate(() => document.getElementById('dlgcancel').click());

// the preview tab paints. Its pane is display:none from boot, and Chromium
// never paints a sandboxed frame that loaded while hidden, so the tab
// flashed and stayed blank (60-preview.js, showPreview). Painted means the
// frame's text is on screen: hiding that text must change the pixels.
await m.evaluate(() => {
  const s = document.getElementById('src');
  s.value = '# painted\n\nThe preview tab shows this.';
  s.dispatchEvent(new Event('input'));
  document.querySelector('.mtabs button[data-mv="prev"]').click();
});
await new Promise((r) => setTimeout(r, 1500));
const pbox = await m.evaluate(() => {
  const r = document.getElementById('prev').getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 160) };
});
const shown = await m.screenshot({ clip: pbox });
await (await (await m.$('#prev')).contentFrame()).evaluate(() => { document.body.style.visibility = 'hidden'; });
const blank = await m.screenshot({ clip: pbox });
check('phone: the preview tab paints the page', !Buffer.from(shown).equals(Buffer.from(blank)));
await m.evaluate(() => document.querySelector('.mtabs button[data-mv="code"]').click());

// the bar is an item of a 1fr grid track whose floor is min-content, so a
// long status line once pushed the whole layout 12px past the viewport —
// horizontal scroll that only appeared AFTER the first pier response wrote
// a longer status. By this point in the run a page has opened and a dialog
// has cycled, so the status carries real text; nothing may stick out.
const over = await m.evaluate(() => {
  const vw = 390;   // the device width: innerWidth stretches to fit overflow
  let n = 0;
  for (const el of document.querySelectorAll('body *'))
    if (el.getBoundingClientRect().right > vw + 1) n++;
  return { scrollW: document.documentElement.scrollWidth, vw, past: n };
});
check('phone: nothing reaches past the right edge (no horizontal scroll)',
  over.scrollW <= over.vw && over.past === 0, JSON.stringify(over));
await m.evaluate(() => document.querySelector('.mtabs button[data-mv="tree"]').click());
const longRow = await m.evaluate((dir) => {
  const f = [...document.querySelectorAll('#treelist .fld')].find((x) => x.textContent.includes(dir));
  const a = f && f.querySelector('.addf');
  const r = a && a.getBoundingClientRect();
  return { plus: r && r.width ? Math.round(r.right) : null, scrollW: document.documentElement.scrollWidth };
}, LONGDIR);
//  against the device width, not innerWidth: a phone's layout viewport
//  stretches to fit content that overflows, so innerWidth grows with the bug
longRow.vw = 390;
check('phone: a long folder name truncates and keeps its + on screen',
  longRow.plus !== null && longRow.plus <= longRow.vw && longRow.scrollW <= longRow.vw, JSON.stringify(longRow));
await m.evaluate(() => document.querySelector('.mtabs button[data-mv="code"]').click());

// ── list indent/outdent by thumb ───────────────────────────────────────────
// Phones have no Tab key, so the editor grows a fixed button pair while the
// caret sits where listTab would act — ordered, unordered, and task items
// alike. The tap must not steal focus (the keyboard would drop), and the
// pair must vanish on prose.
await m.evaluate(() => {
  const s = document.getElementById('src');
  s.value = '1. one\n- two\n- [ ] three\nplain prose';
  s.dispatchEvent(new Event('input'));
});
const caretTo = async (line) => {
  await m.evaluate((ln) => {
    const s = document.getElementById('src');
    s.focus();
    const at = s.value.split('\n').slice(0, ln).join('\n').length + (ln ? 1 : 0);
    s.setSelectionRange(at + 2, at + 2);
    document.dispatchEvent(new Event('selectionchange'));
  }, line);
  await new Promise((r) => setTimeout(r, 300));   // the paint is debounced
};
const pairState = () => m.evaluate(() => ({
  on: document.getElementById('lbtns').classList.contains('on'),
  display: getComputedStyle(document.getElementById('lbtns')).display,
  active: document.activeElement && document.activeElement.id,
  mv: document.getElementById('ws').dataset.mv,
}));
const pairOn = async () => { const st = await pairState(); return st.on && st.display !== 'none'; };
const line = (n) => m.evaluate((i) => document.getElementById('src').value.split('\n')[i], n);
const tap = (id) => m.evaluate((i) => {
  const ev = new Event('pointerdown', { bubbles: true, cancelable: true });
  document.getElementById(i).dispatchEvent(ev);
}, id);

await caretTo(0);
check('ordered item: the pair appears', await pairOn(), JSON.stringify(await pairState()));
await tap('lind');
check('ordered item indents by tap', (await line(0)) === '  1. one', await line(0));
await tap('loutd');
check('and steps back out', (await line(0)) === '1. one', await line(0));

await caretTo(1);
await tap('lind');
check('unordered item indents by tap', (await line(1)) === '  - two', await line(1));
await caretTo(2);
await tap('lind');
check('task item indents by tap', (await line(2)) === '  - [ ] three', await line(2));
check('the textarea keeps focus through taps', await m.evaluate(() =>
  document.activeElement === document.getElementById('src')));

await caretTo(3);
check('on prose the pair is gone', !(await pairOn()));

// a tree folder's + prompts for a name on phone too (the name field is
// hidden here just as it is on the desktop shell)
await m.evaluate(() => { document.querySelector('.mtabs button[data-mv="tree"]').click(); });
await m.evaluate(() => { document.querySelector('#treelist a.addf').click(); });
let plusOpen = false;
try { await m.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 5000 }); plusOpen = true; } catch {}
check('phone: a tree folder + opens the new-page prompt', plusOpen);
await m.evaluate(() => document.getElementById('dlgcancel').click());
await m.close();

// ── desktop web: untouched ─────────────────────────────────────────────────
const d = await boot(1400, 900);
//  the shell frame took the old bar off the desktop screen; the field stays
//  in the DOM as the store everything reads
check('desktop web: the name input is still there',
  await d.evaluate(() => !!document.getElementById('pname')));
check('desktop web: no phone label', !(await vis(d, 'mpath')));
check('desktop web: no ⋯', !(await vis(d, 'mmore')));
await d.close();

await browser.close();
check.done();
