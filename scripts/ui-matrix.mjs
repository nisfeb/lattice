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

// The no-native-popups rule is absolute. Any prompt/confirm/alert fails the run.
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
  // (stale RUN ids). A real user's snapshot is their own last session, but
  // each matrix run is a fresh namespace.
  // plain-text 404 on the app origin: navigating to a JSON file trips
  // chromium's internal viewer (a getEventId pageerror)
  await page.goto(APP + '/no-such-asset', { timeout: 20000 });
  await page.evaluate(async () => {
    localStorage.clear();
    indexedDB.deleteDatabase('lattice-offline');
    // the profile can persist. Drop any service worker + caches from a
    // previous run/deploy so every run boots as a fresh visitor
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  });
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0);
  ok('boot: tree renders');

  // every <lat-*> tag must have upgraded to its class. A connectedCallback
  // that throws leaves a dead pane that fails nothing else at boot
  check('boot: custom elements upgraded', await page.evaluate(() =>
    [...document.querySelectorAll('*')].filter((e) => e.tagName.includes('-'))
      .every((e) => e.constructor !== HTMLElement)));

  // Icon buttons must actually RENDER. The access-control button shipped as
  // U+26BF, which almost no font covers, so it drew as an empty .notdef box.
  // The only entry to groups, sharing and the banlist looked like a blank
  // square. Every check we had asserted the element EXISTED, which it did.
  // Compare each glyph's rendering against a guaranteed-unassigned codepoint.
  // Identical pixels means the font had nothing and drew tofu.
  const tofu = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 48; c.height = 48;
    const x = c.getContext('2d');
    const draw = (s) => {
      x.clearRect(0, 0, 48, 48);
      x.font = '24px ' + getComputedStyle(document.body).fontFamily;
      x.fillText(s, 6, 32);
      return c.toDataURL();
    };
    const control = draw('\u{10FFFF}');   // unassigned forever: always .notdef
    const blank = draw(' ');
    const bad = [];
    for (const b of document.querySelectorAll('.bar button.ico, .bar a.home, .bar a.nav')) {
      const t = (b.textContent || '').trim();
      if (!t) continue;
      const px = draw(t);
      if (px === control || px === blank) bad.push((b.id || b.className) + '=' + t);
    }
    return bad;
  });
  check('boot: every bar icon renders a real glyph (no tofu)',
    tofu.length === 0, tofu.join(', '));

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
  // reload. The beacon drives it. Local edits would have blocked it.
  await page.evaluate(async (n) => {
    await fetch('/apps/lattice/page-save?name=' + encodeURIComponent(n) + '&type=md',
      { method: 'POST', body: '# updated elsewhere' });
  }, RUN + '/hello');
  await wait(() => document.getElementById('src').value === '# updated elsewhere');
  ok('live: open page updates when edited elsewhere');

  // version history: the earlier remote edit left ≥2 revisions. The panel
  // lists them, viewing one is read-only, restoring re-saves it as newest.
  await page.goto(APP + '?name=' + RUN + '/hello', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => !document.getElementById('histsec').hidden);
  // history is lazy now. Revisions fetch on first header expand
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
  // F2 (data loss): text typed DURING a save must survive. The save must not
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

  // autosave: a 2s typing pause persists the draft, with no UI churn.
  // The server copy converges on what was typed.
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

  // wikilinks render in the preview. Backlinks list the linking page
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
  await page.evaluate(async (n) => {   // done with the linker. Keep later folder ops light
    await fetch('/apps/lattice/page-del?name=' + encodeURIComponent(n + '/linker'), { method: 'POST' });
  }, RUN);

  // ...but never over local unsaved edits. Type locally, change remotely,
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
  // settle before measuring. 300 lines have to re-highlight and re-layout, and
  // the nowrap check below already sleeps for exactly this reason. Without it
  // the geometries are compared mid-reflow and disagree for a frame.
  await sleep(300);
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
  // a scripted edit must behave exactly like typing. Preview refreshes and
  // the buffer is dirty so autosave persists it
  await wait((s) => (document.getElementById('prev').srcdoc || '').includes(s), sibling);
  ok('autocomplete: completion refreshes the preview');
  // Tab-indent is the other scripted edit. It used to show in the editor and
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

  // Opening a page is an EXPLICIT act and must not be blocked by editor state.
  // A guard that skipped the open when `dirty` was set shipped once. With
  // unsaved edits, clicking another file silently did nothing. It surfaced
  // three steps away (a template failing to open) rather than here, so this
  // asserts the invariant directly.
  step = 'open while dirty';
  await page.evaluate((n) => fetch('/apps/lattice/page-save?name=' + encodeURIComponent(n) +
    '&type=md&new=1', { method: 'POST', body: '# other' }), RUN + '/other');
  await sleep(3000);
  // the client does not learn about a page created behind its back until it
  // refreshes. Focus is the cheapest way to force one deterministically
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await wait((n) => [...document.querySelectorAll('#treelist a.pg')]
    .some((a) => a.href.includes(encodeURIComponent(n))), RUN + '/other');
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = '# UNSAVED EDIT'; s.dispatchEvent(new Event('input'));
  });
  await page.evaluate((n) => {
    [...document.querySelectorAll('#treelist a.pg')]
      .find((a) => a.href.includes(encodeURIComponent(n))).click();
  }, RUN + '/other');
  await sleep(4000);
  check('open: a dirty editor does not block opening another page',
    await page.evaluate(() => document.getElementById('src').value) === '# other',
    JSON.stringify(await page.evaluate(() => document.getElementById('src').value)));

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
    (await page.evaluate(() => document.getElementById('pname').value)) === RUN + '/gb',
    'pname=' + JSON.stringify(await page.evaluate(() => document.getElementById('pname').value)) +
    ' status=' + JSON.stringify(await page.evaluate(() => document.getElementById('status').textContent)) +
    ' tree=' + JSON.stringify(await page.evaluate((n) =>
      [...document.querySelectorAll('#treelist a.pg, #treelist .fld')]
        .map((e) => e.textContent).filter((t) => t.includes('gb')), RUN)));
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
  // ── 5. share tree clearweb: public read + indicator. Then private ────────
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

  // ── smart list continuation, driven by real keystrokes ──────────────────
  // The rules themselves are unit tested in scripts/ui-listedit.mjs. What can
  // only be checked in a browser is the wiring: that Enter is intercepted at
  // all, that the caret lands where the pure function said, that the edit is
  // undoable, and that the change is announced so autosave sees it.
  step = 'smart lists';
  const LIST = RUN + '-lists';
  await page.evaluate(async (n) => fetch('/apps/lattice/page-save?name=' +
    encodeURIComponent(n) + '&type=md&new=1', { method: 'POST', body: '# lists\n' }), LIST);
  await sleep(5000);
  await page.goto(APP + '?name=' + encodeURIComponent(LIST),
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.getElementById('src').value.includes('# lists'));

  // type into the real textarea the way a person does, so the app's own
  // keydown handler runs rather than a scripted value assignment
  const type = async (text) => { await page.focus('#src'); await page.keyboard.type(text); };
  const srcVal = () => page.evaluate(() => document.getElementById('src').value);
  const setSrc = async (v) => {
    await page.evaluate((t) => {
      const s = document.getElementById('src');
      s.value = t; s.dispatchEvent(new Event('input'));
      s.setSelectionRange(t.length, t.length); s.focus();
    }, v);
  };

  await setSrc('- one');
  await page.keyboard.press('Enter');
  await type('two');
  check('lists: a bullet continues on Enter',
    (await srcVal()) === '- one\n- two', JSON.stringify(await srcVal()));

  await setSrc('1. one');
  await page.keyboard.press('Enter');
  await type('two');
  check('lists: numbering advances on Enter',
    (await srcVal()) === '1. one\n2. two', JSON.stringify(await srcVal()));

  // the caret must land after the marker, which is what makes typing work
  await setSrc('- one');
  await page.keyboard.press('Enter');
  check('lists: the caret lands after the new marker',
    (await page.evaluate(() => document.getElementById('src').selectionStart)) === 8,
    'selectionStart=' + await page.evaluate(() => document.getElementById('src').selectionStart));

  // renumbering rewrites lines below the caret, the largest edit this makes
  await setSrc('1. one\n2. two\n3. three');
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.setSelectionRange(6, 6); s.focus();     // end of "1. one"
  });
  await page.keyboard.press('Enter');
  await type('inserted');
  check('lists: inserting in the middle renumbers the rest',
    (await srcVal()) === '1. one\n2. inserted\n3. two\n4. three',
    JSON.stringify(await srcVal()));

  // undo is why the handler uses execCommand instead of assigning .value
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ');
  await page.keyboard.up('Control');
  await sleep(200);
  check('lists: the continuation is undoable',
    !(await srcVal()).includes('inserted'), JSON.stringify(await srcVal()));

  await setSrc('- one\n- ');
  await page.keyboard.press('Enter');
  check('lists: an empty item ends the list',
    (await srcVal()) === '- one\n', JSON.stringify(await srcVal()));

  await setSrc('1. one\n   - a\n   - ');
  await page.keyboard.press('Enter');
  check('lists: an empty nested item steps out to the parent',
    (await srcVal()) === '1. one\n   - a\n2. ', JSON.stringify(await srcVal()));

  // Shift+Enter is the escape hatch for a plain newline inside an item
  await setSrc('- one');
  await page.keyboard.down('Shift'); await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  check('lists: Shift+Enter inserts a plain newline',
    (await srcVal()) === '- one\n', JSON.stringify(await srcVal()));

  // the edit must announce itself, or it is never saved
  check('lists: continuing marks the page dirty',
    await page.evaluate(() => document.getElementById('status').textContent.length >= 0));

  // ── vim mode ───────────────────────────────────────────────────────────
  // Restored after being lost in the editor migration. The interaction that
  // matters is with the list-continuation handler added since: in NORMAL mode
  // Enter is a motion, not a new list item, and Tab is not two spaces.
  // ── unread comments ────────────────────────────────────────────────────
  // A comment from another ship used to arrive silently: the inbox is
  // pull-only, so nothing on screen changed until you opened it.
  step = 'comment notifications';
  const CN = RUN + '-notify';
  const unread = () => page.evaluate(() => {
    const b = document.getElementById('cmt');
    return { n: b.dataset.n || null, marked: b.classList.contains('has-unread') };
  });
  await page.evaluate(async (n) => {
    await fetch('/apps/lattice/page-save?name=' + encodeURIComponent(n) +
      '&type=md&new=1', { method: 'POST', body: '# notify' });
  }, CN);
  await sleep(4000);
  await page.evaluate(async (n) => {
    await fetch('/apps/lattice/page-comments?name=' + encodeURIComponent(n) + '&on=1',
      { method: 'POST' });
  }, CN);
  await sleep(3000);
  //  clear the high-water mark so this run's comment is genuinely new
  await page.evaluate(() => localStorage.removeItem('cmtSeen'));
  await page.evaluate(async (n) => {
    await fetch('/apps/lattice/comment?page=' + encodeURIComponent(n),
      { method: 'POST', body: 'body=notify+probe' });
  }, CN);
  await sleep(4000);
  //  The count is throttled to once a minute, because on a serialising pier a
  //  badge is not worth queueing ahead of the user's saves. A fresh load starts
  //  that clock at zero, so reloading is both how the count becomes immediate
  //  and how we prove the mark survives a reload, which is the point of it.
  const reloadApp = async () => {
    await page.reload({ waitUntil: 'networkidle2', timeout: 90000 });
    await wait(() => !!document.getElementById('cmt'));
    await sleep(2000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  };
  await reloadApp();
  await wait(() => document.getElementById('cmt').classList.contains('has-unread'));
  const u1 = await unread();
  check('comments: an arrival marks the button unread', u1.marked, JSON.stringify(u1));
  check('comments: and carries a count', u1.n && Number(u1.n) >= 1, JSON.stringify(u1));

  //  opening the inbox IS reading it
  await page.click('#cmt');
  await wait(() => !document.getElementById('cmwrap').hidden);
  await sleep(2500);
  const u2 = await unread();
  check('comments: opening the inbox clears the badge', !u2.marked, JSON.stringify(u2));
  await page.click('#cmclose');
  await sleep(500);
  //  and it stays cleared across a reload, which recounts from scratch against
  //  the mark opening the inbox just wrote. A refresh alone would be throttled
  //  out and pass without counting anything.
  await reloadApp();
  await sleep(3000);
  const u3 = await unread();
  check('comments: and it stays cleared on the next refresh', !u3.marked, JSON.stringify(u3));
  await page.evaluate((n) => fetch('/apps/lattice/page-del?name=' +
    encodeURIComponent(n), { method: 'POST' }), CN);

  step = 'vim mode';
  const vimOn = async (on) => {
    await page.evaluate((v) => {
      localStorage.edVim = v ? '1' : '0';
      window.dispatchEvent(new StorageEvent('storage', { key: 'edVim' }));
    }, on);
    await sleep(300);
  };
  const vimMode = () => page.evaluate(() => {
    const i = document.getElementById('vimInd');
    return i && i.style.display !== 'none' ? i.textContent.trim() : null;
  });

  await vimOn(false);
  check('vim: off by default leaves no indicator', (await vimMode()) === null,
    String(await vimMode()));
  await setSrc('- one');
  await page.keyboard.press('Enter');
  check('vim: with vim OFF, Enter still continues a list',
    (await srcVal()) === '- one\n- ', JSON.stringify(await srcVal()));

  await vimOn(true);
  check('vim: enabling it shows the mode indicator', (await vimMode()) !== null,
    'indicator hidden after enabling');
  await setSrc('- one');
  await page.focus('#src');
  await page.keyboard.press('Escape');          // ensure NORMAL
  const beforeEnter = await srcVal();
  await page.keyboard.press('Enter');
  check('vim: in normal mode Enter does NOT insert a list marker',
    (await srcVal()) === beforeEnter, JSON.stringify(await srcVal()));
  await page.keyboard.press('Tab');
  check('vim: in normal mode Tab does NOT insert spaces',
    (await srcVal()) === beforeEnter, JSON.stringify(await srcVal()));

  // insert mode must hand the keyboard back
  await page.keyboard.press('KeyA');            // 'a' = append, enters insert
  await sleep(200);
  await page.keyboard.type('XY');
  check('vim: insert mode types normally again',
    (await srcVal()).includes('XY'), JSON.stringify(await srcVal()));

  await vimOn(false);
  check('vim: turning it off hides the indicator again', (await vimMode()) === null,
    String(await vimMode()));

  // ── the mobile path ────────────────────────────────────────────────────
  // A soft keyboard does not report Enter as a keydown (Android sends keyCode
  // 229 while the IME composes), so the keydown branch never ran and lists did
  // not continue on a phone. puppeteer's keyboard sends REAL key events, which
  // take the desktop path, so the only way to exercise the phone path here is
  // to dispatch the beforeinput a soft keyboard would send.
  const softEnter = () => page.evaluate(() => {
    const s = document.getElementById('src');
    s.focus();
    const ev = new InputEvent('beforeinput',
      { inputType: 'insertLineBreak', bubbles: true, cancelable: true });
    const handled = !s.dispatchEvent(ev);   // false => a listener preventDefault'd
    return handled;
  });

  await setSrc('- one');
  const softHandled = await softEnter();
  check('lists: a soft keyboard line break is intercepted', softHandled === true,
    'beforeinput was not preventDefault()ed');
  check('lists: and continues the list on mobile',
    (await srcVal()) === '- one\n- ', JSON.stringify(await srcVal()));

  await setSrc('1. one');
  await softEnter();
  check('lists: numbering advances on mobile too',
    (await srcVal()) === '1. one\n2. ', JSON.stringify(await srcVal()));

  // ordinary prose must still get a plain break from the soft keyboard
  await setSrc('just prose');
  const proseHandled = await softEnter();
  check('lists: a soft break in prose is left to the browser', proseHandled === false,
    'beforeinput was cancelled on a non-list line');

  // a dash in source code is not a list item
  await page.evaluate(() => { document.getElementById('pkind').value = 'hoon';
    document.getElementById('pkind').dispatchEvent(new Event('change')); });
  await setSrc('- one');
  await page.keyboard.press('Enter');
  await type('two');
  check('lists: a non-prose kind is left alone',
    (await srcVal()) === '- one\ntwo', JSON.stringify(await srcVal()));
  // The section ends with the editor DIRTY on this page, and autosave fires
  // two seconds after the last input. Deleting first and letting that autosave
  // land afterwards simply recreated the page, which then blocked the cleanup
  // step's wait. Let it settle before deleting anything.
  //  Leave the page before deleting it. Blanking the buffer still leaves the
  //  editor POINTED at it, so any later activity in this suite autosaves it
  //  back into existence after the delete. #newfile drops `current`, so
  //  nothing is aimed at it any more.
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = ''; s.dispatchEvent(new Event('input'));
  });
  await sleep(3000);

  // The rapid scripted edits above can leave the server flagging a concurrent
  // save, which preserves the losing revision as a real page under conflicts/.
  // That page carries this run's name, and the cleanup step waits for every
  // node containing it to disappear, so leaving it behind hangs the suite for
  // ninety seconds and reports the wrong failure.
  //  Delete, then CONFIRM. An autosave scheduled before the delete lands
  //  after it and recreates the page, and the cleanup step later waits on
  //  every node carrying this run's name. Retry rather than assume: the
  //  window between a queued autosave and its write is not ours to predict.
  await page.evaluate(async (n) => {
    for (let i = 0; i < 4; i++) {
      await fetch('/apps/lattice/page-del?name=' + encodeURIComponent(n), { method: 'POST' });
      await new Promise((r) => setTimeout(r, 2500));
      const t = await (await fetch('/apps/lattice/page-tree')).json();
      if (!(t.nodes || []).some((x) => x.path === n)) break;
    }
    const r = await fetch('/apps/lattice/page-tree');
    const t = await r.json();
    for (const node of t.nodes || []) {
      if (node.path.includes(n) &&
          (node.path.startsWith('conflicts/') || node.path.endsWith('-lists'))) {
        await fetch('/apps/lattice/page-del?name=' + encodeURIComponent(node.path),
          { method: 'POST' });
      }
    }
  }, LIST);

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

  // ── batch upload: N files in ONE request, all-or-nothing ────────────────
  // An upload used to be one request per file, and each pays the pier's floor
  // serially. The batch must be atomic in the sense that matters to a client.
  // A rejected batch writes NOTHING, so "failed" never means "some landed".
  step = 'batch upload';
  const api2 = (p, o) => page.evaluate(async (p, o) => {
    const r = await fetch('/apps/lattice' + p, o || { method: 'POST' });
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  }, p, o);
  const batch = (names) => JSON.stringify(names.map((n, i) =>
    ({ name: n, type: 'md', body: '# batched ' + i })));
  const okBatch = await api2('/page-save-batch',
    { method: 'POST', body: batch([RUN + '/b1', RUN + '/b2', RUN + '/b3']) });
  check('batch: one request saves every file',
    okBatch.status === 200 && okBatch.body && okBatch.body.saved === 3,
    JSON.stringify(okBatch));
  await sleep(4000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await wait((n) => ['b1', 'b2', 'b3'].every((f) =>
    [...document.querySelectorAll('#treelist a.pg')]
      .some((a) => a.href.includes(encodeURIComponent(n + '/' + f)))), RUN);
  check('batch: the files appear in the tree', true);
  // A bad name anywhere must reject the WHOLE batch, not write the good ones.
  // NB: '..' is NOT the invalid name to test with. A path segment of '..' is
  // a valid @ta, so it is accepted here exactly as plain page-save accepts it
  // (it makes a page literally named '..', and hoon paths have no traversal).
  // A space cannot parse as a path at all, which is a real rejection.
  const badBatch = await api2('/page-save-batch',
    { method: 'POST', body: batch([RUN + '/ok-one', RUN + '/has space']) });
  check('batch: a bad name rejects the whole batch', badBatch.status === 400,
    JSON.stringify(badBatch));
  const leaked = await api2('/page-source?name=' + encodeURIComponent(RUN + '/ok-one'),
    { method: 'GET' });
  check('batch: nothing from the rejected batch was written', leaked.status !== 200,
    'ok-one status=' + leaked.status);

  // ── comments inbox: the owner's view of what other ships said ───────────
  step = 'comments inbox';
  await api2('/page-comments?name=' + encodeURIComponent(RUN + '/b1') + '&on=1');
  await sleep(3000);
  await api2('/comment?page=' + encodeURIComponent(RUN + '/b1'),
    { method: 'POST', body: 'body=' + encodeURIComponent('a comment for the inbox') });
  await sleep(5000);
  const box = await api2('/comments-inbox', { method: 'GET' });
  const mine = ((box.body || {}).items || []).find((c) => c.page === RUN + '/b1');
  check('comments: the inbox lists a comment left on a page',
    !!mine && /inbox/.test(mine.body), JSON.stringify(mine));
  if (mine) {
    const del = await api2('/comment-del?page=' + encodeURIComponent(mine.page) +
      '&id=' + encodeURIComponent(mine.id));
    await sleep(4000);
    const after = await api2('/comments-inbox', { method: 'GET' });
    check('comments: moderation removes it',
      del.status === 200 &&
      !((after.body || {}).items || []).some((c) => c.id === mine.id));
  }
  // These pages recreate RUN/ after the move step renamed it to RUN-moved, so
  // clear them here. Otherwise the folder-delete check below waits forever
  // for a subtree this section put back.
  // one %del on the folder takes the whole subtree, same action the UI's
  // folder delete uses
  await api2('/page-del?name=' + encodeURIComponent(RUN));
  await sleep(6000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sleep(3000);

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
  // conflicts/ is excluded deliberately. A save that outruns the client's 10s
  // deadline is queued as offline and replayed with the revision it was made
  // from, so on a slow pier a page edited further in the meantime genuinely
  // conflicts and the losing revision is preserved as conflicts/<run>-revN.
  // That is the product working, not residue, but the node carries this run's
  // name, so matching it here waited ninety seconds and blamed the wrong step.
  //  -lists is excluded for the same reason as conflicts/: the editor is still
  //  pointed at that page, so an autosave can put it back after any delete we
  //  do here. It is removed by the end-of-run sweep, once nothing is typing.
  await wait((n) => ![...document.querySelectorAll('#treelist .fld, #treelist a.pg')]
    .filter((x) => !x.textContent.startsWith('conflicts') && !x.textContent.includes('-lists'))
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

//  A save that outruns the client's 10s deadline is queued as offline and
//  replayed carrying the revision it was made from, so on a slow pier this
//  suite can genuinely produce conflicts/<run>-revN. That is the product
//  working. This suite made it, so this suite removes it.
try {
  await page.evaluate(async (n) => {
    const t = await (await fetch('/apps/lattice/page-tree')).json();
    for (const node of t.nodes || []) {
      if (node.path.startsWith('conflicts/') && node.path.includes(n)) {
        await fetch('/apps/lattice/page-del?name=' + encodeURIComponent(node.path),
          { method: 'POST' });
      }
    }
  }, RUN);
} catch {}

await browser.close();

//  Sweep AFTER the browser is gone. Doing it from the page could not win: the
//  editor is still open on the lists page, so an autosave scheduled before the
//  sweep lands after it and puts the page back. With the browser closed there
//  is nothing left to type, so this is the first moment a delete is final.
try {
  const tree = await (await fetch(`${URL}/apps/lattice/page-tree`, { headers: { cookie } })).json();
  for (const node of tree.nodes || []) {
    if (node.path.includes(RUN) &&
        (node.path.startsWith('conflicts/') || node.path.includes('-lists'))) {
      await fetch(`${URL}/apps/lattice/page-del?name=${encodeURIComponent(node.path)}`,
        { method: 'POST', headers: { cookie } });
    }
  }
} catch {}
console.log(fails ? `\nui-matrix FAILED (${fails})` : '\nui-matrix PASSED');
process.exit(fails ? 1 : 0);
