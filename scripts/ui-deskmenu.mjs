//  ui-deskmenu.mjs — the desktop File menu and the buttons it replaced.
//
//  On desktop these commands moved into the native menubar (desktop/src/main.rs).
//  The menu does not reimplement them: it CLICKS the page's own buttons, which
//  are hidden rather than removed. Two things can quietly break that:
//
//    1. a button is renamed or removed, and the menu item becomes a silent
//       no-op — nothing throws, the menu just stops doing anything;
//    2. the hiding leaks to web or mobile, where there is no menubar to reach
//       the command from and it becomes unreachable entirely.
//
//  Both are checked here. The id contract is checked without a ship; the
//  behaviour needs one.
//
//  Usage: node scripts/ui-deskmenu.mjs      (defaults to ~nec on :8080)
import { readFileSync } from 'fs';
import { homedir } from 'os';

const ROOT = new globalThis.URL('..', import.meta.url).pathname;
const BASE = process.env.LATTICE_UI || 'http://localhost:8080';
const CKF = process.env.LATTICE_COOKIE || homedir() + '/.config/lattice-fs/nec-cookie';
const APP = BASE + '/apps/lattice/app';

let fails = 0;
const check = (m, c, d) => {
  console.log((c ? '  ok   - ' : '  FAIL - ') + m + (c || !d ? '' : ' (' + d + ')'));
  if (!c) fails++;
};

// ── 1. the id contract, straight out of the Rust ──────────────────────────
// main.rs maps a menu id to an element id. Parsing it here means the test
// cannot drift from the menu: add an item, and its button is checked too.
const mainRs = readFileSync(ROOT + 'desktop/src/main.rs', 'utf8');
const appJs = readFileSync(ROOT + 'grubbery-overlay/nex/lattice/ui-app/app.js', 'utf8');
const ids = [...mainRs.matchAll(/"file-[a-z-]+" => "([a-z]+)"/g)].map((m) => m[1]);
check('the File menu maps at least the five commands that moved', ids.length >= 5,
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
const MOVED = ['newfile', 'newfolder', 'newtmpl', 'upfiles', 'updir', 'save'];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox'],
});

/** Boot the app, optionally pretending to be the desktop shell. */
const boot = async (desktop) => {
  const p = await browser.newPage();
  await p.setViewport({ width: 1400, height: 900 });
  await p.setCookie({ name: cn, value: cr.join('='), domain: new globalThis.URL(BASE).hostname, path: '/' });
  if (desktop) {
    // invoke is stubbed because 10-shell.js and 70-upload.js route through it
    // on desktop. __LATTICE_FILE_MENU__ is what commands.rs injects, and is
    // set separately so the older-build case can be exercised.
    await p.evaluateOnNewDocument((menu) => {
      window.__TAURI__ = { core: { invoke: async () => null } };
      if (menu) window.__LATTICE_FILE_MENU__ = true;
    }, desktop === 'menu');
  }
  await p.goto(APP, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  return p;
};

const shown = (p) => p.evaluate((list) => Object.fromEntries(list.map((id) => {
  const el = document.getElementById(id);
  //  offsetParent is null for anything actually invisible, which catches a
  //  hidden ancestor as well as the attribute
  return [id, !!el && !el.hidden && el.offsetParent !== null];
})), MOVED);

// web: every one of them must still be reachable, because there is no menubar
const web = await boot(false);
const onWeb = await shown(web);
check('web: every moved command is still a visible button',
  MOVED.every((id) => onWeb[id]), JSON.stringify(onWeb));
await web.close();

// an OLDER desktop build: __TAURI__ is there, the File menu is not. The UI
// ships from the ship and the menu ships in the binary, so this pairing is
// reachable in the field. Hiding here would strand every one of these
// commands with nothing to reach them by.
const old = await boot(true);
const onOld = await shown(old);
check('a desktop build with no File menu keeps its buttons',
  MOVED.every((id) => onOld[id]), JSON.stringify(onOld));
await old.close();

// desktop: hidden, but still present and still clickable
const desk = await boot('menu');
const onDesk = await shown(desk);
check('desktop: all six are hidden from the page',
  MOVED.every((id) => !onDesk[id]), JSON.stringify(onDesk));
check('desktop: but they still EXIST — the menu clicks these very elements',
  await desk.evaluate((list) => list.every((id) => !!document.getElementById(id)), MOVED));
check('desktop: the emptied button rows are hidden too, not left as a blank band',
  await desk.evaluate(() => [...document.querySelectorAll('#tree .newbtns')]
    .every((r) => r.hidden)));

// the menu's actual mechanism: click a HIDDEN button and see the app respond
await desk.evaluate(() => { document.getElementById('newfolder').click(); });
let opened = false;
try {
  await desk.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 5000 });
  opened = true;
} catch {}
check('desktop: clicking a hidden button still runs its handler', opened);
await desk.evaluate(() => { const c = document.getElementById('dlgcancel'); if (c) c.click(); });

// The green + on a tree folder. It calls newFile(path) directly rather than
// going through #newfile, so the desktop override has to sit on newFile
// itself — hooking the button left this one setting a name into a hidden
// field and focusing something display:none, i.e. doing nothing at all.
const plus = await desk.evaluate(() => {
  const a = document.querySelector('#treelist a.addf');
  if (!a) return null;
  a.click();
  return (a.title.match(/^new file in (.*)$/) || [])[1] || '';
});
if (plus === null) {
  check('desktop: a tree folder + was available to test', false,
    'no a.addf in the tree — needs a ship with at least one folder');
} else {
  let asked = false;
  try {
    await desk.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 5000 });
    asked = true;
  } catch {}
  check('desktop: a tree folder + opens the new-page dialog', asked);
  const seeded = await desk.evaluate(() => document.getElementById('dlginput').value);
  check('desktop: and pre-fills that folder', seeded === plus + '/',
    'folder ' + JSON.stringify(plus) + ' -> dialog ' + JSON.stringify(seeded));
  await desk.evaluate(() => { const c = document.getElementById('dlgcancel'); if (c) c.click(); });
}
await desk.close();

await browser.close();
console.log(fails ? '\n' + fails + ' FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
