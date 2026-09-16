//  ui-view.mjs — the desktop view control: edit | split | preview.
//
//  Editor-only and preview-only are ONE three-way choice, not two toggles:
//  "neither" is not a layout. The control lives in the bar (12-bar.js), the
//  state in localStorage.appView (85-layout.js), and the desktop View menu
//  (desktop/src/main.rs) clicks these same buttons — the File-menu doctrine.
//
//  Checked here: the menu's id contract (no ship needed), then against a
//  ship: each view shows the panes it should, the choice survives a reload,
//  knowledge mode has the same three views and previews a memory as
//  markdown, and the phone tab strip ignores a desktop preference (it has
//  its own one-pane-at-a-time model).
//
//  Usage: node scripts/ui-view.mjs      (defaults to the harness ship on :8080)
import { readFileSync } from 'fs';
import { homedir } from 'os';

const ROOT = new globalThis.URL('..', import.meta.url).pathname;
const BASE = process.env.LATTICE_UI || 'http://localhost:8080';
const CKF = process.env.LATTICE_COOKIE || homedir() + '/.config/lattice-fs/cookie';
const APP = BASE + '/apps/lattice/app';

let fails = 0;
const check = (m, c, d) => {
  console.log((c ? '  ok   - ' : '  FAIL - ') + m + (c || !d ? '' : ' (' + d + ')'));
  if (!c) fails++;
};

// ── 1. the id contract, straight out of the Rust ──────────────────────────
const mainRs = readFileSync(ROOT + 'desktop/src/main.rs', 'utf8');
const appJs = readFileSync(ROOT + 'code/nex/lattice/ui-app/app.js', 'utf8');
const ids = [...mainRs.matchAll(/"view-[a-z-]+" => "([a-z]+)"/g)].map((m) => m[1]);
check('the View menu maps the three views and the two side panes', ids.length === 5,
  'found ' + ids.length + ': ' + ids.join(','));
for (const id of ids) {
  check('menu target #' + id + ' exists in the shipped UI', appJs.includes('id="' + id + '"'));
}

// ── 2. behaviour, against a ship ──────────────────────────────────────────
let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; }
catch { console.error('puppeteer-core missing: npm i --no-save puppeteer-core'); process.exit(2); }

const ck = readFileSync(CKF, 'utf8').trim();
const [cn, ...cr] = ck.split('=');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox'],
});

const boot = async (width, pre) => {
  const p = await browser.newPage();
  await p.setViewport({ width, height: 900 });
  await p.setCookie({ name: cn, value: cr.join('='), domain: new globalThis.URL(BASE).hostname, path: '/' });
  if (pre) await p.evaluateOnNewDocument((kv) => { for (const k in kv) localStorage[k] = kv[k]; }, pre);
  await p.goto(APP, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  return p;
};
// pane widths, 0 for anything not on screen
const widths = (p) => p.evaluate(() => Object.fromEntries(
  [['ed', '.edwrap'], ['pv', '.prevwrap'], ['h2', '#ph2'], ['tree', '.tree'], ['ctl', '.ctl']]
    .map(([k, s]) => [k, Math.round(document.querySelector(s).getBoundingClientRect().width)])));
const pressed = (p) => p.evaluate(() => Object.fromEntries(
  ['viewedit', 'viewsplit', 'viewprev'].map((id) =>
    [id, document.getElementById(id).getAttribute('aria-pressed')])));
const click = (p, id) => p.evaluate((i) => document.getElementById(i).click(), id);

const desk = await boot(1400);
const split = await widths(desk);
check('split (the default): editor and preview both on screen, with a handle between',
  split.ed > 0 && split.pv > 0 && split.h2 > 0, JSON.stringify(split));
check('split is the pressed button', (await pressed(desk)).viewsplit === 'true');

await click(desk, 'viewedit');
const edit = await widths(desk);
check('edit: the preview and its handle are gone', edit.pv === 0 && edit.h2 === 0, JSON.stringify(edit));
check('edit: the editor took the preview’s room', edit.ed >= split.ed + split.pv - 2,
  JSON.stringify({ split, edit }));
check('edit: the side panes are untouched', edit.tree === split.tree && edit.ctl === split.ctl);
check('edit is the pressed button', (await pressed(desk)).viewedit === 'true');

await click(desk, 'viewprev');
const prev = await widths(desk);
check('preview: the editor is gone', prev.ed === 0 && prev.h2 === 0, JSON.stringify(prev));
check('preview: the preview took the editor’s room', prev.pv >= split.ed + split.pv - 2,
  JSON.stringify({ split, prev }));

await desk.reload({ waitUntil: 'domcontentloaded' });
await desk.waitForFunction(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
  { timeout: 90000 });
const again = await widths(desk);
check('the choice survives a reload', again.ed === 0 && again.pv > 0, JSON.stringify(again));

// knowledge mode: the same view, and a memory previews as markdown
// the memory listing arrives after a fetch, so the tree still shows PAGES
// for a moment; remember them to tell a memory row from a page row
const pages = await desk.evaluate(() => [...document.querySelectorAll('#treelist a.pg')].map((a) => a.textContent));
await click(desk, 'modet');
const know = await widths(desk);
check('knowledge mode: preview-only holds', know.ed === 0 && know.pv > 0, JSON.stringify(know));
check('knowledge mode: the view control is still in the bar',
  await desk.evaluate(() => document.getElementById('viewseg').getBoundingClientRect().width > 0));
await desk.waitForFunction((pg) => document.getElementById('treesec').textContent === 'memories'
  && ([...document.querySelectorAll('#treelist a.pg')].some((a) => !pg.includes(a.textContent))
      || /no memories yet/.test(document.getElementById('treelist').textContent)),
  { timeout: 90000 }, pages);
// the tag chips fold under a heading (they used to fill the pane top)
const tagsec = await desk.evaluate(() => {
  const d = document.getElementById('tagsec');
  //  checkVisibility, not a rect: Chromium keeps a layout box for a closed
  //  details' content (content-visibility: hidden), so its rect is not 0
  return { open: d.open, shown: !d.hidden, chips: document.getElementById('chips').checkVisibility(),
    label: document.getElementById('tagsh').textContent };
});
check('knowledge mode: the tags fold is shown and folded by default',
  tagsec.shown && !tagsec.open && !tagsec.chips, JSON.stringify(tagsec));
check('knowledge mode: its heading counts the tags', /^tags \u00b7 \d+$/.test(tagsec.label), tagsec.label);
await desk.evaluate(() => document.getElementById('tagsh').click());
check('knowledge mode: one click unfolds the chips',
  await desk.evaluate(() => document.getElementById('chips').checkVisibility()));
await desk.evaluate(() => document.getElementById('tagsh').click());
const memory = await desk.evaluate((pg) => {
  const a = [...document.querySelectorAll('#treelist a.pg')].find((x) => !pg.includes(x.textContent));
  if (!a) return null;
  a.click();
  return a.textContent;
}, pages);
if (memory) {
  let painted = false;
  try {
    await desk.waitForFunction(() => /<(p|h[1-6]|ul|pre)\b/.test(document.getElementById('prev').srcdoc || ''),
      { timeout: 20000 });
    painted = true;
  } catch {}
  check('knowledge mode: opening a memory paints it into the preview', painted, memory);
} else console.log('  skip - no memory on this ship to open');
await click(desk, 'modet');
const back = await widths(desk);
check('pages mode again: preview-only resumes', back.ed === 0 && back.pv > 0, JSON.stringify(back));

await click(desk, 'viewsplit');
const restored = await widths(desk);
check('split again: both panes and the handle return',
  restored.ed > 0 && restored.pv > 0 && restored.h2 > 0, JSON.stringify(restored));
await desk.close();

// a phone has tabs, not a view; a desktop preference must not reach it
const phone = await boot(400, { appView: 'edit' });
await phone.evaluate(() => document.querySelector('.mtabs button[data-mv="prev"]').click());
const tab = await widths(phone);
check('phone: the preview tab still shows the preview with edit-only remembered',
  tab.pv > 0 && tab.ed === 0, JSON.stringify(tab));
check('phone: the view control is not in the bar',
  await phone.evaluate(() => document.getElementById('viewseg').getBoundingClientRect().width === 0));
await phone.close();

await browser.close();
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
