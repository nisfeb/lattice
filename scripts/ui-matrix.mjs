#!/usr/bin/env node
// UI integration matrix for the lattice web app, driven through a real
// headless Chromium. Exercises the editor, folder operations, sharing, the
// knowledge mode, mobile pane behavior, and theming against a running ship
// (the tyr harness by default). Never run against production.
//
// Usage:  node scripts/ui-matrix.mjs
// Env:    LATTICE_URL     ship base (default http://localhost:8080)
//         LATTICE_COOKIE  cookie file (default ~/.config/lattice-fs/cookie)
//         CHROME          browser binary (default /usr/bin/chromium)
//
// Needs puppeteer-core:  npm i --no-save puppeteer-core

import { readFileSync } from 'fs';
import { homedir } from 'os';

let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; }
catch { console.error('puppeteer-core missing: npm i --no-save puppeteer-core'); process.exit(2); }

const URL = (process.env.LATTICE_URL || 'http://localhost:8080').replace(/\/$/, '');
const COOKIE_FILE = process.env.LATTICE_COOKIE || homedir() + '/.config/lattice-fs/cookie';
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const APP = URL + '/apps/lattice/app';
const RUN = 'uimx-' + process.pid;          // per-run namespace, cleaned at the end

const cookie = readFileSync(COOKIE_FILE, 'utf8').trim();
const [ckName, ...ckRest] = cookie.split('=');
const host = new globalThis.URL(URL).hostname;

let fails = 0;
const ok = (name) => console.log('  ok   - ' + name);
const bad = (name, detail) => { console.log('  FAIL - ' + name + (detail ? ' (' + detail + ')' : '')); fails++; };
const check = (name, cond, detail) => (cond ? ok(name) : bad(name, detail));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => bad('page threw: ' + e.message.slice(0, 80)));
await page.setCookie({ name: ckName, value: ckRest.join('='), domain: host, path: '/' });

// The no-native-popups rule is absolute: any prompt/confirm/alert fails the run.
await page.evaluateOnNewDocument(() => {
  for (const f of ['prompt', 'confirm', 'alert'])
    window[f] = () => { throw new Error('native ' + f + '() used'); };
});

// the harness pier is slow (a page save is 2-4s, a folder move is one save
// per page), so integration waits get a generous budget
const wait = (fn, ...args) => page.waitForFunction(fn, { timeout: 90000 }, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The in-app dialog: fill (optional) and submit / cancel.
const dialog = async (value, submit = true) => {
  await wait(() => !document.getElementById('dlg').hidden);
  if (value !== null) await page.evaluate((v) => { document.getElementById('dlginput').value = v; }, value);
  await page.click(submit ? '#dlgok' : '#dlgcancel');
};

let step = 'boot';
try {
  // ── 1. boot: tree renders ─────────────────────────────────────────────────
  await page.setViewport({ width: 1400, height: 900 });
  // per-run isolation: the browser profile can persist across runs, and the
  // editor's localStorage boot snapshot would paint a PREVIOUS run's tree
  // (stale RUN ids) — a real user's snapshot is their own last session, but
  // each matrix run is a fresh namespace.
  // plain-text 404 on the app origin: navigating to a JSON file trips
  // chromium's internal viewer (a getEventId pageerror)
  await page.goto(APP + '/no-such-asset', { timeout: 20000 });
  await page.evaluate(async () => {
    localStorage.clear();
    // the profile can persist: drop any service worker + caches from a
    // previous run/deploy so every run boots as a fresh visitor
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  });
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0);
  ok('boot: tree renders');

  // every <lat-*> tag must have upgraded to its class — a connectedCallback
  // that throws leaves a dead pane that fails nothing else at boot
  check('boot: custom elements upgraded', await page.evaluate(() =>
    [...document.querySelectorAll('*')].filter((e) => e.tagName.includes('-'))
      .every((e) => e.constructor !== HTMLElement)));

  step = 'new page';
  // ── 2. new page: type, save, appears in tree, round-trips ────────────────
  await page.click('#newfile');
  await page.evaluate((n) => {
    document.getElementById('pname').value = n;
    const k = document.getElementById('pkind'); k.value = 'md';
    const s = document.getElementById('src');
    s.value = '# ui matrix probe'; s.dispatchEvent(new Event('input'));
  }, RUN + '/hello');
  await page.click('#save');
  await wait((n) => [...document.querySelectorAll('#treelist a.pg')]
    .some((a) => a.textContent === 'hello.md' && a.href.includes(n)), RUN);
  ok('save: new md page appears in tree');
  check('highlight: Prism overlay rendered',
    await page.evaluate(() => document.querySelectorAll('#hl .token').length > 0));
  await page.goto(APP + '?name=' + RUN + '/hello', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.getElementById('src').value.length > 0);
  check('open: body round-trips',
    await page.evaluate(() => document.getElementById('src').value) === '# ui matrix probe');

  // live refresh: an edit made elsewhere (here: straight through the API,
  // as if from another device) must land in the open editor without a
  // reload — the beacon drives it; local edits would have blocked it.
  await page.evaluate(async (n) => {
    await fetch('/apps/lattice/page-save?name=' + encodeURIComponent(n) + '&type=md',
      { method: 'POST', body: '# updated elsewhere' });
  }, RUN + '/hello');
  await wait(() => document.getElementById('src').value === '# updated elsewhere');
  ok('live: open page updates when edited elsewhere');

  // version history: the earlier remote edit left ≥2 revisions; the panel
  // lists them, viewing one is read-only, restoring re-saves it as newest.
  await page.goto(APP + '?name=' + RUN + '/hello', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => !document.getElementById('histsec').hidden);
  // history is lazy now: revisions fetch on first header expand
  await page.click('#histh');
  await wait(() => document.querySelectorAll('#histlist a').length >= 2);
  ok('history: panel lists revisions after expanding');
  await page.evaluate(() => {                      // open the OLDEST revision
    const chips = document.querySelectorAll('#histlist a');
    chips[chips.length - 1].click();
  });
  await wait(() => document.getElementById('src').readOnly);
  const histBody = await page.evaluate(() => document.getElementById('src').value);
  check('history: viewing a revision is read-only and shows old content',
    histBody === '# ui matrix probe', JSON.stringify(histBody).slice(0, 40));
  await page.click('#hrestore');
  await wait(() => !document.getElementById('src').readOnly);
  await page.waitForFunction(async (n) => {
    const r = await fetch('/apps/lattice/page-source?name=' + encodeURIComponent(n));
    return (await r.json()).body === '# ui matrix probe';
  }, { timeout: 30000 }, RUN + '/hello');
  ok('history: restore re-saves the old revision as newest');

  // REGRESSION GUARDS for the adversarial review's findings.
  // F2 (data loss): text typed DURING a save must survive — the save must not
  // mark the editor clean, or the refresh echo swaps the stale server body in.
  await page.evaluate((n) => {
    const s = document.getElementById('src');
    s.value = 'BASE BODY'; s.dispatchEvent(new Event('input'));
  }, RUN);
  await page.evaluate(() => document.getElementById('save').click());
  await page.evaluate(() => {                       // type while the save is in flight
    const s = document.getElementById('src');
    s.value = 'BASE BODY + TYPED DURING SAVE';
    s.dispatchEvent(new Event('input'));
  });
  await sleep(6000);                                // save lands, beacon + refresh fire
  check('F2: text typed during a save is not clobbered',
    (await page.evaluate(() => document.getElementById('src').value)) === 'BASE BODY + TYPED DURING SAVE',
    await page.evaluate(() => document.getElementById('src').value));

  // F4/F13: while viewing a revision, save is refused and Tab cannot edit
  await page.goto(APP + '?name=' + RUN + '/hello', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => !document.getElementById('histsec').hidden);
  await page.click('#histh');
  await wait(() => document.querySelectorAll('#histlist a').length >= 2);
  await page.evaluate(() => document.querySelectorAll('#histlist a')[document.querySelectorAll('#histlist a').length - 1].click());
  await wait(() => document.getElementById('src').readOnly);
  const revBody = await page.evaluate(() => document.getElementById('src').value);
  await page.evaluate(() => document.getElementById('save').click());
  await sleep(1200);
  check('F4: save while viewing a revision is refused',
    (await page.evaluate(() => document.getElementById('status').textContent)).includes('restore'));
  await page.focus('#src');
  await page.keyboard.press('Tab');
  check('F13: Tab cannot edit the read-only historical view',
    (await page.evaluate(() => document.getElementById('src').value)) === revBody);

  // F12: leaving to knowledge mode must not leak readOnly into the memory editor
  await page.click('#modet');
  await wait(() => document.getElementById('ws').className.includes('know'));
  check('F12: knowledge editor is not left read-only after a revision view',
    !(await page.evaluate(() => document.getElementById('src').readOnly)));
  check('F12: stale history panel hidden after mode switch',
    await page.evaluate(() => document.getElementById('histsec').hidden));
  await page.click('#modet');
  await wait(() => !document.getElementById('ws').className.includes('know'));
  // setMode clears the open page, so reopen it for the autosave check below
  await page.goto(APP + '?name=' + RUN + '/hello', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.getElementById('src').value.length > 0);

  // autosave: a 2s typing pause persists the draft, with no UI churn —
  // the server copy converges on what was typed.
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = '# autosaved content';
    s.setSelectionRange(5, 5);
    s.dispatchEvent(new Event('input'));
  });
  await page.waitForFunction(async (n) => {
    const r = await fetch('/apps/lattice/page-source?name=' + encodeURIComponent(n));
    return (await r.json()).body === '# autosaved content';
  }, { timeout: 30000 }, RUN + '/hello');
  ok('autosave: 2s pause persists the draft');
  check('autosave: text and caret untouched',
    await page.evaluate(() => {
      const s = document.getElementById('src');
      return s.value === '# autosaved content' && s.selectionStart === 5;
    }));

  // wikilinks render in the preview; backlinks list the linking page
  await page.evaluate(async (n) => {
    await fetch('/apps/lattice/page-save?name=' + encodeURIComponent(n + '/linker') + '&type=md&new=1',
      { method: 'POST', body: 'see [[' + n + '/hello]]' });
  }, RUN);
  await page.goto(APP + '?name=' + RUN + '/linker', { waitUntil: 'domcontentloaded' });
  await wait(() => (document.getElementById('prev').srcdoc || '').includes('/apps/lattice/app?name='));
  ok('wikilinks: preview renders [[x]] as an editor link');
  await page.goto(APP + '?name=' + RUN + '/hello', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => !document.getElementById('linksec').hidden);
  await page.click('#linkh');                       // backlinks fetch lazily on expand
  await wait(() => !!document.querySelector('#linklist a'));
  check('backlinks: panel lists the linking page',
    (await page.evaluate(() => document.querySelector('#linklist a').textContent)) === RUN + '/linker');
  await page.evaluate(async (n) => {   // done with the linker — keep later folder ops light
    await fetch('/apps/lattice/page-del?name=' + encodeURIComponent(n + '/linker'), { method: 'POST' });
  }, RUN);

  // ...but never over local unsaved edits: type locally, change remotely,
  // and the local text must survive.
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = '# my unsaved local edit';
    s.dispatchEvent(new Event('input'));          // marks dirty
  });
  await page.evaluate(async (n) => {
    await fetch('/apps/lattice/page-save?name=' + encodeURIComponent(n) + '&type=md',
      { method: 'POST', body: '# remote change that must NOT clobber' });
  }, RUN + '/hello');
  await sleep(3000);                              // beacon + debounce window
  check('live: unsaved local edits are never clobbered',
    await page.evaluate(() => document.getElementById('src').value) === '# my unsaved local edit');
  await page.goto(APP + '?name=' + RUN + '/hello', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.getElementById('src').value.length > 0);

  // overlay geometry parity: the highlight layer must occupy exactly the
  // textarea's box in both wrap modes, or the caret drifts off its line on
  // long pages (bites wherever scrollbars consume layout, e.g. Firefox).
  const parity = () => page.evaluate(() => {
    const s = document.getElementById('src'), h = document.getElementById('hl');
    return s.clientWidth === h.clientWidth && s.clientHeight === h.clientHeight
      && Math.abs(s.scrollHeight - h.scrollHeight) <= 1;
  });
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = Array.from({ length: 300 }, (_, i) =>
      i % 7 ? `line ${i}` : `line ${i} long enough to wrap `.repeat(6)).join('\n');
    s.dispatchEvent(new Event('input'));
  });
  check('wrap: soft-wrap is the default',
    await page.evaluate(() => document.getElementById('ws').className.includes('wrap')));
  check('overlay parity: wrap (default)', await parity());
  await page.click('#wrapt');
  await sleep(300);
  check('overlay parity: nowrap', await parity());
  await page.click('#wrapt');
  await sleep(300);

  // empty file: saving with no content must succeed (the UI stands in a
  // newline for the body the backend refuses to take empty).
  await page.click('#newfile');
  await page.evaluate((n) => {
    document.getElementById('pname').value = n;
    document.getElementById('pkind').value = 'md';
  }, RUN + '/empty');
  await page.click('#save');
  await wait((n) => [...document.querySelectorAll('#treelist a.pg')]
    .some((a) => a.textContent === 'empty.md' && a.href.includes(n)), RUN);
  ok('save: empty file saves without manual content');

  // new-from-template: a core creation path (it was lost in the UI migration
  // and restored). Exercises the choice dialog, instantiation, and the open.
  // wikilink autocomplete: opens on [[, ranks siblings first, Tab completes.
  step = 'autocomplete';
  await page.evaluate((n) => {
    const s = document.getElementById('src');
    s.value = 'see '; s.setSelectionRange(4, 4); s.dispatchEvent(new Event('input'));
  }, RUN);
  await page.focus('#src');
  await page.keyboard.type('[[');
  await wait(() => !document.getElementById('ac').hidden);
  ok('autocomplete: opens on [[');
  const sibling = RUN + '/hello';
  await page.keyboard.type('hell');
  await wait(() => [...document.querySelectorAll('#ac .row')].length > 0);
  const acFirst = await page.evaluate(() => {
    const r = document.querySelector('#ac .row');
    return (r.querySelector('.dir').textContent + '/' + r.querySelector('.nm').textContent)
      .replace(/^\/+/, '');
  });
  check('autocomplete: ranks the matching page first', acFirst === sibling, acFirst + ' != ' + sibling);
  await page.keyboard.press('Tab');
  await wait((s) => document.getElementById('src').value === 'see [[' + s + ']]', sibling);
  ok('autocomplete: Tab completes the full path');
  check('autocomplete: closes after completing',
    await page.evaluate(() => document.getElementById('ac').hidden));
  // a scripted edit must behave exactly like typing: preview refreshes and
  // the buffer is dirty so autosave persists it
  await wait((s) => (document.getElementById('prev').srcdoc || '').includes(s), sibling);
  ok('autocomplete: completion refreshes the preview');
  // Tab-indent is the other scripted edit — it used to show in the editor and
  // never reach the ship. Autosave firing is the observable proof it is now
  // treated as a real edit (asserting ship state here races the slow pier).
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = 'Z'; s.setSelectionRange(0, 0); s.dispatchEvent(new Event('input'));
  });
  await wait(() => document.getElementById('status').textContent === 'autosaved');
  await page.evaluate(() => { document.getElementById('status').textContent = 'idle'; });
  await page.focus('#src');
  await page.keyboard.press('Tab');
  await wait(() => document.getElementById('status').textContent === 'autosaved');
  check('Tab indent counts as an edit (autosaves)',
    (await page.evaluate(() => document.getElementById('src').value)) === '  Z');
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = ''; s.dispatchEvent(new Event('input'));
  });

  step = 'template';
  await page.click('#newtmpl');
  await wait(() => !document.getElementById('dlg').hidden && !document.getElementById('dlgopts').hidden);
  check('template: picker lists the shipped templates',
    (await page.evaluate(() => [...document.querySelectorAll('#dlgopt, .dlgopt')].map((o) => o.dataset.val)))
      .includes('guestbook'));
  await page.evaluate(() => [...document.querySelectorAll('.dlgopt')]
    .find((b) => b.dataset.val === 'guestbook').click());
  await wait(() => !document.getElementById('dlginput').hidden);
  await page.evaluate((v) => { document.getElementById('dlginput').value = v; }, RUN + '/gb');
  await page.click('#dlgok');
  await wait((n) => (document.getElementById('status').textContent || '').includes('created ' + n),
    RUN + '/gb');
  check('template: instantiates and opens the new page',
    (await page.evaluate(() => document.getElementById('pname').value)) === RUN + '/gb');
  check('template: self-reference rewritten to the new path',
    (await page.evaluate(() => document.getElementById('src').value)).includes('/' + RUN + '/gb'));
  await page.evaluate(async (n) => {
    await fetch('/apps/lattice/page-del?name=' + encodeURIComponent(n), { method: 'POST' });
  }, RUN + '/gb');

  step = 'folder create';
  // ── 3. folder create via the in-app dialog ───────────────────────────────
  await page.click('#newfolder');
  await dialog(RUN + '/sub/');   // trailing slash: the UI must normalize it
  await wait((n) => [...document.querySelectorAll('#treelist .fld')]
    .some((f) => f.textContent.includes('sub') && !f.textContent.includes('.')), RUN);
  ok('folder: created through the in-app dialog');

  step = 'folder select';
  // ── 4. folder select targets the right pane ──────────────────────────────
  const row = await page.evaluateHandle((n) =>
    [...document.querySelectorAll('#treelist .fld')].find((f) => f.textContent.includes(n.split('/')[0])), RUN);
  await row.asElement().click();
  await wait(() => document.getElementById('del').textContent === 'delete folder');
  check('folder select: pane shows folder controls',
    await page.evaluate(() => document.getElementById('pname').value).then?.() ??
    (await page.evaluate(() => document.getElementById('pname').value)) === RUN);

  step = 'share tree';
  // ── 5. share tree clearweb: public read + indicator; then private ────────
  await page.evaluate(() => [...document.querySelectorAll('.share button')]
    .find((b) => b.dataset.m === 'clearweb').click());
  await wait(() => document.getElementById('cwurl').textContent.includes('public'));
  await sleep(1500);
  const pub = await page.evaluate(async (u) =>
    (await fetch(u, { credentials: 'omit' })).status, URL + '/apps/lattice/c/' + RUN + '/hello');
  check('share-tree clearweb: page publicly readable', pub === 200, 'status ' + pub);
  await wait((n) => [...document.querySelectorAll('#treelist .fld')]
    .some((f) => f.textContent.includes(n.split('/')[0]) && f.querySelector('.cw')), RUN);
  ok('share-tree clearweb: folder shows the globe indicator');
  await page.evaluate(() => [...document.querySelectorAll('.share button')]
    .find((b) => b.dataset.m === 'private').click());
  await sleep(1500);
  const priv = await page.evaluate(async (u) =>
    (await fetch(u, { credentials: 'omit' })).status, URL + '/apps/lattice/c/' + RUN + '/hello');
  check('share-tree private: public read revoked', priv !== 200, 'status ' + priv);

  step = 'folder rename';
  // ── 6. folder rename via dialog ──────────────────────────────────────────
  await page.click('#mv');
  await dialog(RUN + '-moved');
  await wait((n) => [...document.querySelectorAll('#treelist .fld')]
    .some((f) => f.textContent.includes(n)), RUN + '-moved');
  ok('folder rename: dialog-driven move lands');

  step = 'mode toggle';
  // ── 7. mode toggle: label shows current view, chips clean up ─────────────
  const label0 = await page.evaluate(() => document.getElementById('modet').textContent.trim());
  check('mode label: pages view says pages', label0.includes('pages'), label0);
  await page.click('#modet');
  await wait(() => document.getElementById('ws').className.includes('know'));
  const label1 = await page.evaluate(() => document.getElementById('modet').textContent.trim());
  check('mode label: knowledge view says knowledge', label1.includes('knowledge'), label1);

  step = 'knowledge';
  // ── 8. knowledge: save, read back, delete via dialog ─────────────────────
  await page.evaluate((n) => {
    document.getElementById('pname').value = 'test/' + n;
    const s = document.getElementById('src');
    s.value = 'ui matrix memory'; s.dispatchEvent(new Event('input'));
  }, RUN);
  await page.click('#save');
  await wait((n) => [...document.querySelectorAll('#treelist a.pg')]
    .some((a) => a.textContent === n), RUN);
  ok('know: memory saved and listed');
  await page.evaluate((n) => [...document.querySelectorAll('#treelist a.pg')]
    .find((a) => a.textContent === n).click(), RUN);
  await wait(() => document.getElementById('src').value.length > 0);
  check('know: body round-trips',
    (await page.evaluate(() => document.getElementById('src').value)) === 'ui matrix memory');
  await page.click('#del');
  await dialog(null);   // confirm dialog, no input
  await wait((n) => ![...document.querySelectorAll('#treelist a.pg')]
    .some((a) => a.textContent === n), RUN);
  ok('know: delete via in-app confirm');

  // back to pages: chips gone
  await page.click('#modet');
  await wait(() => !document.getElementById('ws').className.includes('know'));
  check('mode round-trip: tag chips hidden again',
    await page.evaluate(() => getComputedStyle(document.getElementById('chips')).display) === 'none');

  step = 'cleanup deletes';
  // ── 9. delete the test page + folder via dialogs ─────────────────────────
  await page.goto(APP + '?name=' + RUN + '-moved/hello', { waitUntil: 'domcontentloaded' });
  await wait(() => document.getElementById('src').value.length > 0);
  await page.click('#del');
  await dialog(null);
  await wait((n) => ![...document.querySelectorAll('#treelist a.pg')]
    .some((a) => a.href.includes(n + '%2Fhello')), RUN + '-moved');
  ok('page delete: dialog-driven');
  const frow = await page.evaluateHandle((n) =>
    [...document.querySelectorAll('#treelist .fld')].find((f) => f.textContent.includes(n)), RUN + '-moved');
  if (frow.asElement()) {
    await frow.asElement().click();
    await wait(() => document.getElementById('del').textContent === 'delete folder');
    await page.click('#del');
    await dialog(null);
  }
  await wait((n) => ![...document.querySelectorAll('#treelist .fld, #treelist a.pg')]
    .some((x) => x.textContent.includes(n)), RUN);
  ok('folder delete: whole subtree gone');

  step = 'mobile';
  // ── 10. mobile: toggle reveals the tree, opening jumps to the editor ─────
  await page.setViewport({ width: 390, height: 780, isMobile: true });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.click('#modet');
  await wait(() => document.getElementById('ws').dataset.mv === 'tree');
  check('mobile: mode toggle jumps to the tree pane',
    await page.evaluate(() => getComputedStyle(document.getElementById('tree')).display) !== 'none');
  await page.click('#modet');   // back to pages, still on tree pane
  await wait(() => document.querySelector('#treelist a.pg'));
  await page.evaluate(() => document.querySelector('#treelist a.pg').click());
  await wait(() => document.getElementById('ws').dataset.mv === 'code');
  ok('mobile: opening a page jumps to the editor pane');

  step = 'dark theme';
  // ── 11. dark theme: blank preview shows the theme background ─────────────
  await page.setViewport({ width: 1200, height: 800 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await sleep(600);
  const shot = await page.screenshot({ encoding: 'base64' });
  const px = await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res) => { img.onload = res; img.src = 'data:image/png;base64,' + b64; });
    const r = document.getElementById('prev').getBoundingClientRect();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const sc = img.width / innerWidth;
    return [...cx.getImageData((r.left + r.width / 2) * sc, (r.top + r.height / 2) * sc, 1, 1).data.slice(0, 3)];
  }, shot);
  check('dark theme: blank preview is the theme background',
    px[0] < 60 && px[1] < 60 && px[2] < 60, 'pixel ' + px.join(','));
} catch (e) {
  bad('matrix aborted at [' + step + ']: ' + e.message.slice(0, 120));
}

await browser.close();
console.log(fails ? `\nui-matrix FAILED (${fails})` : '\nui-matrix PASSED');
process.exit(fails ? 1 : 0);
