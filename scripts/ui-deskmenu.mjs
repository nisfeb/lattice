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
//  Usage: node scripts/ui-deskmenu.mjs      (defaults to the harness ship on :8080)
import { shipEnv, launchBrowser, openPage, makeCheck } from './lib/harness.mjs';

const env = shipEnv();
const APP = env.app;
const check = makeCheck();

// (the menu-id contract is checked ship-free in scripts/desktop-commands.mjs)

// ── 2. behaviour, against a ship ──────────────────────────────────────────
const MOVED = ['newfile', 'newfolder', 'newtmpl', 'upfiles', 'updir', 'save'];

const browser = await launchBrowser();

/** Boot the app, optionally pretending to be the desktop shell. */
const boot = async (desktop) => {
  const p = await openPage(browser, env, { viewport: { width: 1400, height: 900 } });
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
  //  confirming the dialog must WRITE the page. It used to only fill the name
  //  field, so a create that was never followed by a save left nothing behind
  //  and read as a button that did nothing.
  const made = plus + '/deskmenu-create-probe';
  const saves = [];
  const onSave = (r) => { if (/page-save/.test(r.url())) saves.push(r.status()); };
  desk.on('response', onSave);
  await desk.evaluate((n) => {
    const i = document.getElementById('dlginput');
    i.value = n; i.dispatchEvent(new Event('input'));
    document.getElementById('dlgok').click();
  }, made);
  await new Promise((r) => setTimeout(r, 6000));
  desk.off('response', onSave);
  check('desktop: confirming the dialog writes the page', saves.length > 0,
    'page-save statuses: ' + JSON.stringify(saves));
  const listed = await desk.evaluate((n) =>
    [...document.querySelectorAll('#treelist a.pg')].some((a) => a.href.includes(encodeURIComponent(n))), made);
  check('desktop: and the new page is in the tree', listed, 'looking for ' + made);
  //  leave the ship as we found it
  await desk.evaluate((n) => fetch('/apps/lattice/page-del?name=' + encodeURIComponent(n),
    { method: 'POST', credentials: 'same-origin' }).catch(() => {}), made);
  await new Promise((r) => setTimeout(r, 1500));
}
await desk.close();

await browser.close();
check.done();
