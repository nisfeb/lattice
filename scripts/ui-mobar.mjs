//  ui-mobar.mjs — the phone-width bar (src/97-mobar.js + the 820px block).
//
//  At 390px the bar used to wrap into three rows — 184px of chrome before
//  content. It is now one row (home · path label · save · ⋯), with the
//  dropped controls reachable through a ⋯ sheet that clicks the page's own
//  hidden buttons. Worth a harness because every failure mode here is
//  silent: a control that is hidden with no working replacement is just
//  gone, and nothing throws (the tree-+ bug shipped exactly that way).
//
//  Needs a ship with at least one folder ("harnessdir" is seeded on ~tyr).
//
//  Usage:  LATTICE_UI=http://localhost:8081 \
//          LATTICE_COOKIE=~/.config/lattice-fs/cookie node scripts/ui-mobar.mjs
import { readFileSync } from 'fs';
import { homedir } from 'os';

const BASE = process.env.LATTICE_UI || 'http://localhost:8080';
const CKF = (process.env.LATTICE_COOKIE || homedir() + '/.config/lattice-fs/nec-cookie')
  .replace(/^~/, homedir());
const APP = BASE + '/apps/lattice/app';

let fails = 0;
const check = (m, c, d) => {
  console.log((c ? '  ok   - ' : '  FAIL - ') + m + (c || !d ? '' : ' (' + d + ')'));
  if (!c) fails++;
};

const puppeteer = (await import('puppeteer-core')).default;
const ck = readFileSync(CKF, 'utf8').trim();
const [cn, ...cr] = ck.split('=');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium',
  headless: 'new', args: ['--no-sandbox'],
});

const boot = async (width, height) => {
  const p = await browser.newPage();
  await p.setViewport({ width, height, isMobile: width < 820, hasTouch: width < 820 });
  await p.setCookie({ name: cn, value: cr.join('='), domain: new globalThis.URL(BASE).hostname, path: '/' });
  await p.goto(APP, { waitUntil: 'domcontentloaded', timeout: 90000 });
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

for (const id of ['modet', 'pname', 'pkind', 'qt', 'cmt', 'aclt'])
  check('phone: #' + id + ' is off the bar', !(await vis(m, id)));
for (const id of ['mpath', 'mmore', 'save'])
  check('phone: #' + id + ' is on the bar', await vis(m, id));

// the ⋯ sheet: opens, carries the four rows, and its rows drive the real
// buttons — search must actually open the search pane
await m.evaluate(() => document.getElementById('mmore').click());
check('⋯ opens the sheet', await vis(m, 'msheet'));
const modeLabel = await m.evaluate(() => document.getElementById('ms-mode').textContent);
check('the mode row mirrors the live mode button', modeLabel.length > 0, JSON.stringify(modeLabel));
await m.evaluate(() => document.getElementById('ms-q').click());
let qOpened = false;
try { await m.waitForFunction(() => !document.getElementById('qwrap').hidden, { timeout: 5000 }); qOpened = true; } catch {}
check('sheet > search opens the search pane', qOpened);
check('and the sheet is away again', !(await vis(m, 'msheet')));
await m.evaluate(() => document.getElementById('qclose').click());

// label: open a page, the label says so, tapping it is rename
await m.evaluate(() => { document.querySelector('.mtabs button[data-mv="tree"]').click(); });
await m.evaluate(() => { document.querySelector('#treelist a.pg').click(); });
await m.waitForFunction(() => document.getElementById('mpath').textContent !== 'no page open',
  { timeout: 15000 });
const label = await m.evaluate(() => document.getElementById('mpath').textContent);
check('the label carries the open page', /harnessdir\//.test(label), label);
await m.evaluate(() => document.getElementById('mpath').click());
let renameOpen = false;
try { await m.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 5000 }); renameOpen = true; } catch {}
check('tapping the label opens move/rename', renameOpen);
const seeded = await m.evaluate(() => document.getElementById('dlginput').value);
check('pre-filled with the current name', seeded === label, JSON.stringify(seeded));
await m.evaluate(() => document.getElementById('dlgcancel').click());

// the bar is an item of a 1fr grid track whose floor is min-content, so a
// long status line once pushed the whole layout 12px past the viewport —
// horizontal scroll that only appeared AFTER the first pier response wrote
// a longer status. By this point in the run a page has opened and a dialog
// has cycled, so the status carries real text; nothing may stick out.
const over = await m.evaluate(() => {
  const vw = window.innerWidth;
  let n = 0;
  for (const el of document.querySelectorAll('body *'))
    if (el.getBoundingClientRect().right > vw + 1) n++;
  return { scrollW: document.documentElement.scrollWidth, vw, past: n };
});
check('phone: nothing reaches past the right edge (no horizontal scroll)',
  over.scrollW <= over.vw && over.past === 0, JSON.stringify(over));

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
check('desktop web: the name input is still there', await vis(d, 'pname'));
check('desktop web: no phone label', !(await vis(d, 'mpath')));
check('desktop web: no ⋯', !(await vis(d, 'mmore')));
await d.close();

await browser.close();
console.log(fails ? '\n' + fails + ' FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
