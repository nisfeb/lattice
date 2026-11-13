#!/usr/bin/env node
//  ui-scad.mjs: OpenSCAD pages (scad) in the editor shell, in a browser
//  against a fake ship. The 3D pane on its own is ui-scad-view.mjs, which
//  needs no ship. This is everything around it.
//
//    lazy loading: a cold boot and a markdown open never ask for scad.js
//      or the runtime, and a scad page without the runtime asks for
//      scad.js only, never the runtime
//    without the runtime the preview shows the source and a bar offers
//      the install; the bar's Install installs it (with SCAD_SRC)
//    with it, Read is the 3D view and Edit has the view beside the editor
//    a customizer change rewrites its line in the editor, undo puts it
//      back, and the change reaches the ship as an ordinary save
//    a new page created as scad starts as the box template
//    a markdown tab beside a scad tab keeps no pane, and the scad tab gets
//      it back
//    the status follows the ship: an uninstall and an install made
//      elsewhere reach an open editor when a scad page opens
//    an update that fails says so, in the editor and in Settings, and
//      the old runtime stays
//    Save view writes name-view, replaces only a view it saved, and the
//      editor shows the new one
//    a scad page opened once renders offline, from the runtime the page
//      cached, and the service worker answers no runtime request
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           SCAD_SRC=http://127.0.0.1:N/good/ node scripts/ui-scad.mjs
//  SCAD_SRC is where the ship fetches the runtime from, a server it can
//  reach (scad-runtime.sh says how). Without it the sections that need the
//  runtime are skipped. ONLY=A,B runs just those sections after the setup.
//  Never run against production. Everything it writes is under one folder
//  and deleted at the end, and the runtime is uninstalled.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const APP = env.app;
const RUN = 'uiscad-' + process.pid;
const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(join(here, '..', 'tests', 'scad', 'customizer', 'box.scad'), 'utf8');
const check = makeCheck();
const on = (id) => !process.env.ONLY || process.env.ONLY.split(',').includes(id);
const SRC = process.env.SCAD_SRC || '';
const INST = '/grubbery/ball/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app';

const P = { sign: RUN + '/sign', md: RUN + '/notes', box: RUN + '/box', view: RUN + '/box-view', lib: RUN + '/lib/plate', uses: RUN + '/uses', made: RUN + '/made' };
const api = (path, init = {}) => fetch(env.base + '/apps/lattice/' + path,
  { ...init, headers: { Cookie: env.cookie, Origin: env.base, ...(init.headers || {}) } });
const put = (name, body, type = 'scad') => api('page-save?type=' + type + '&new=1&name=' + encodeURIComponent(name), { method: 'POST', body });
const shipBody = async (name) => { const r = await api('page-source?name=' + encodeURIComponent(name)); return r.ok ? r.json() : null; };
const ball = (path, form) => fetch(env.base + INST + path, { method: 'POST', headers: { Cookie: env.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
const status = async () => (await api('scad-status')).json();
const source = (url) => ball('/scad/source.json', { action: 'write-text', content: JSON.stringify({ url }) });
//  wait for the install fiber to end
const settled = () => waitFor(async () => { const s = await status(); return s.busy ? null : s; }, 180000, 1000);

const browser = await launchBrowser({ args: ['--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await openPage(browser, env, {
  viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 120), false),
});
let reqs = [];
page.on('request', (r) => { if (r.url().includes('/apps/lattice')) reqs.push(r.url()); });
//  runtime requests the service worker answered. There must be none: the
//  desktop's webkitgtk drops the cookie from a fetch the worker makes.
const viaSw = [];
page.on('response', (r) => { if (/\/apps\/lattice\/scad\//.test(r.url()) && r.fromServiceWorker()) viaSw.push(r.url()); });
//  what this document loaded, by resource timing: a request the service
//  worker answers does not always reach the request event
const loads = (re) => page.evaluate((s) => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => new RegExp(s).test(n)), re.source);
const wait = (fn, ...a) => page.waitForFunction(fn, { timeout: 90000 }, ...a);
const srcVal = () => page.evaluate(() => document.getElementById('src').value);
async function open(name) {
  await page.evaluate((n) => window.latTabs.openIn('page', n), name);
  await wait((n) => document.getElementById('pname').value === n, name);
}
const setRead = (on) => page.evaluate((r) => window.latSetRead(r), on);
const paneDims = () => page.$eval('.scadhost .lscad-dims', (e) => e.textContent).catch(() => '');
const rendered = () => wait(() => /rendered in/.test((document.querySelector('.scadhost .lscad-st') || {}).textContent || ''));
const said = (re) => waitFor(async () => { const t = await page.$eval('#status', (e) => e.textContent); return re.test(t) ? t : null; }, 60000, 200);
//  what the status line says next, not what it said before
const hush = () => page.evaluate(() => { document.getElementById('status').textContent = ''; });
const paneButton = async (t) => { await hush(); await page.evaluate((x) => [...document.querySelectorAll('.scadhost .lscad-bar button')].find((b) => b.textContent === x).click(), t); };

let step = 'setup';
try {
  await page.goto(APP + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(async () => {
    localStorage.clear();
    indexedDB.deleteDatabase('lattice-offline');
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  });
  //  start with no runtime, and the source the suite was given
  await api('scad-uninstall', { method: 'POST' });
  if (SRC) {
    await ball('/scad', { action: 'create-file', filename: 'source.json', blot: '/json' });
    await source(SRC);
  }
  const seeds = [
    [P.md, '# notes\n\nplain markdown', 'md'],
    [P.box, TEMPLATE],
    [P.lib, 'module plate(w) { cube([w, w, 2]); }\n'],
    [P.uses, 'include <lib/plate.scad>\nplate(30);\n'],
  ];
  for (const [n, b, t] of seeds) {
    const r = await put(n, b, t);
    if (!r.ok) throw new Error('seed ' + n + ': ' + r.status + ' ' + (await r.text()).slice(0, 120));
  }
  await waitFor(async () => {
    const j = await (await api('page-dump', { cache: 'no-store' })).json();
    return seeds.every(([n]) => (j.nodes || []).some((x) => x.path === n));
  }, 30000, 1000);

  // ------------------------------------------------------------ A: lazy loading
  if (on('A')) {
    step = 'A lazy loading';
    reqs = [];
    await page.goto(APP + '?name=' + encodeURIComponent(P.md), { waitUntil: 'networkidle2', timeout: 60000 });
    await wait((n) => document.getElementById('pname').value === n && document.getElementById('src').value.includes('plain markdown'), P.md);
    await sleep(1500);
    check('A: a cold boot on a markdown page asks for no scad.js', (await loads(/\/app\/scad\.js/)).length === 0);
    check('A: and nothing of the runtime', !reqs.some((u) => /\/scad\/|scad-status/.test(u)), reqs.filter((u) => /scad/.test(u)).join(' '));
    await open(P.box);
    await wait(() => !!window.LatScad);
    await sleep(1500);
    //  by the request event and by resource timing: either can miss one
    //  the service worker answers, or one past the timing buffer
    const sj = [...new Set([...reqs.filter((u) => /\/app\/scad\.js/.test(u)), ...await loads(/\/app\/scad\.js/)])];
    check('A: a scad page asks for scad.js once, as ?h=', sj.length === 1 && /scad\.js\?h=0v/.test(sj[0]), sj.join(' '));
    check('A: and, with no runtime, never for the runtime', !reqs.some((u) => /\/scad\/openscad/.test(u)));
    await setRead(true);
    await sleep(800);
    const frame = await page.evaluate(() => { const f = document.getElementById('prev'); return f && f.srcdoc; });
    check('A: Read shows the source in the preview', /language-openscad/.test(frame || '') && /inside width, in mm/.test(frame || ''));
    if (SRC) {
      const bar = await page.waitForFunction(() => { const e = document.getElementById('scadbar'); return e && !e.hidden && e.textContent; }, { timeout: 20000 })
        .then((h) => h.jsonValue()).catch(() => '');
      check('A: a bar offers the install', /Install the OpenSCAD runtime/.test(bar), bar);
    }
    await open(P.md);
    await sleep(500);
    check('A: back on markdown the bar is gone', await page.$eval('#scadbar', (e) => e.hidden));
  }

  // ------------------------------------------------------------ F: create
  if (on('F')) {
    step = 'F create';
    await page.evaluate(() => document.getElementById('newfile').click());
    await wait(() => !!document.getElementById('dlginput'));
    check('F: the new-page dialog offers scad', await page.evaluate(() => [...document.getElementById('dlgkind').options].some((o) => o.value === 'scad')));
    await page.evaluate((n) => {
      const i = document.getElementById('dlginput');
      i.value = n; i.dispatchEvent(new Event('input'));
      const k = document.getElementById('dlgkind');
      k.value = 'scad'; k.dispatchEvent(new Event('change'));
      document.getElementById('dlgok').click();
    }, P.made);
    const made = await waitFor(async () => { const d = await shipBody(P.made); return d && d.kind === 'scad' ? d : null; }, 20000, 500);
    check('F: a page created as scad is the box template on the ship', !!made && made.body === TEMPLATE, made && JSON.stringify([made.body.length, TEMPLATE.length, made.body.slice(-40)]));
  }

  if (SRC && on('B')) {
    // ---------------------------------------------------------- B: install
    step = 'B install';
    await open(P.box);
    await wait(() => !document.getElementById('scadbar').hidden);
    await page.evaluate(() => [...document.querySelectorAll('#scadbar button')].find((b) => b.textContent === 'Install').click());
    await wait(() => !!document.querySelector('.scadhost .lscad-main canvas'));
    const s = await status();
    check('B: the bar installs the runtime on the ship', s.have === s.pin, JSON.stringify(s).slice(0, 160));
    await rendered();
    check('B: and the part renders', /^44 × 34 × 20 mm/.test(await paneDims()), await paneDims());
    const w = await loads(/\/scad\/openscad\.wasm\?h=/);
    check('B: the wasm is asked for by its hash', w.length === 1, w.join(' '));
    const hd = await page.evaluate(async (u) => { const r = await fetch(u); return [r.headers.get('content-type'), r.headers.get('cache-control')]; }, w[0]);
    check('B: answered as application/wasm, immutable', hd[0] === 'application/wasm' && /immutable/.test(hd[1] || ''), hd.join(' '));
    check('B: the bar is gone', await page.$eval('#scadbar', (e) => e.hidden));
  }

  if (SRC && on('C')) {
    // ---------------------------------------------------------- C: Read and Edit
    step = 'C read edit';
    await open(P.box);
    await setRead(true);
    await wait(() => !!document.querySelector('.scadhost canvas') && document.querySelector('.scadhost').offsetParent);
    check('C: Read shows the 3D view, not the source frame', await page.evaluate(() => getComputedStyle(document.getElementById('prev')).display === 'none'
      && getComputedStyle(document.querySelector('#docarea .edwrap')).display === 'none'));
    await setRead(false);
    await sleep(500);
    check('C: Edit shows the editor with the view beside it', await page.evaluate(() => {
      const e = document.querySelector('#docarea .edwrap').getBoundingClientRect(), v = document.querySelector('.scadhost').getBoundingClientRect();
      return e.width > 200 && v.width > 200 && v.left >= e.right - 2;
    }));

    // ---------------------------------------------------------- D: the customizer
    step = 'D customizer';
    await rendered();
    await page.evaluate(() => { const f = document.querySelector('#lscad-width'); f.value = 120; f.dispatchEvent(new Event('input')); f.dispatchEvent(new Event('change')); });
    const v = await waitFor(async () => { const t = await srcVal(); return t.includes('width = 120; // [10:200]') ? t : null; }, 5000, 50);
    check('D: a slider rewrites its line in the editor', !!v);
    check('D: and nothing else', !!v && v === TEMPLATE.replace('width = 40;', 'width = 120;'));
    await wait(() => /^124 × 34 × 20 mm/.test((document.querySelector('.scadhost .lscad-dims') || {}).textContent || ''));
    check('D: the part follows', true);
    const saved = await waitFor(async () => { const d = await shipBody(P.box); return d && d.body.includes('width = 120;') ? d : null; }, 30000, 500);
    check('D: the change reaches the ship, a scad page still', !!saved && saved.kind === 'scad', saved && saved.kind);
    await page.evaluate(() => { document.getElementById('src').focus(); document.execCommand('undo'); });
    check('D: undo in the editor puts the line back', (await srcVal()).includes('width = 40; // [10:200]'));
    await page.evaluate(() => { document.getElementById('src').focus(); document.execCommand('redo'); });

    // ---------------------------------------------------------- E: includes
    step = 'E includes';
    await open(P.uses);
    await wait(() => /^30 × 30 × 2 mm/.test((document.querySelector('.scadhost .lscad-dims') || {}).textContent || ''));
    check('E: an include reads a page in the folder', true);
    await put(RUN + '/sign', 'linear_extrude(2) text("Hi", size = 10);\n');
    await open(RUN + '/sign');
    await wait(() => /triangles/.test((document.querySelector('.scadhost .lscad-dims') || {}).textContent || ''));
    check('E: text() draws, with the fonts the install brought', true);

    // ---------------------------------------------------------- G: tabs
    step = 'G tabs';
    await open(P.md);
    await sleep(500);
    check('G: a markdown page has no 3D pane and no bar', await page.evaluate(() => !document.querySelector('#docarea .prevwrap.scadon') && document.getElementById('scadbar').hidden));
    await open(P.box);
    await wait(() => !!document.querySelector('#docarea .prevwrap.scadon .scadhost canvas'));
    check('G: back on the scad page the pane is back', true);

    // ---------------------------------------------------------- I: the status follows the ship
    step = 'I status';
    await rendered();
    //  as Settings does it, in another window
    await api('scad-uninstall', { method: 'POST' });
    await open(P.md);
    await open(P.box);
    const offer = await waitFor(() => page.evaluate(() => { const e = document.getElementById('scadbar'); return !e.hidden && /Install the OpenSCAD runtime/.test(e.textContent); }), 20000, 200);
    check('I: after an uninstall elsewhere, the next scad page offers the install', !!offer);
    check('I: and has no 3D pane', await page.evaluate(() => !document.querySelector('#docarea .prevwrap.scadon')));
    await open(P.md);
    await api('scad-install', { method: 'POST' });
    await open(P.box);
    const came = await waitFor(() => page.evaluate(() => !!document.querySelector('#docarea .prevwrap.scadon .scadhost canvas')), 120000, 500);
    check('I: an install started elsewhere ends with the pane, without a reload', !!came);
    await settled();

    // ---------------------------------------------------------- J: an update that fails
    step = 'J failed update';
    const good = await status();
    //  an older runtime, as a lattice from before this pin left it, and a
    //  source that has no files
    await ball('/scad/state.json', { action: 'write-text', content: JSON.stringify({ have: '2000.01.01', files: good.files }) });
    await source(SRC + 'none/');
    await page.goto(APP + '?name=' + encodeURIComponent(P.box), { waitUntil: 'networkidle2', timeout: 60000 });
    const upd = await waitFor(() => page.evaluate(() => { const e = document.getElementById('scadbar'); return !e.hidden && /You have 2000\.01\.01/.test(e.textContent); }), 20000, 200);
    check('J: an older runtime is offered the update', !!upd);
    if (upd) {
      await hush();
      await page.evaluate(() => [...document.querySelectorAll('#scadbar button')].find((b) => /^Update/.test(b.textContent)).click());
      const t = await said(/install/);
      check('J: an update that fails is said to have failed', /the install failed: /.test(t || ''), t);
      const bar = await waitFor(() => page.evaluate(() => { const e = document.getElementById('scadbar'); return !e.hidden && /The last update failed/.test(e.textContent) && e.textContent; }), 20000, 200);
      check('J: and the bar keeps the reason beside the offer', !!bar, bar);
      const set = await browser.newPage();
      await set.goto(env.base + '/apps/lattice/settings', { waitUntil: 'domcontentloaded', timeout: 60000 });
      const line = await waitFor(() => set.$eval('#scst', (e) => (/installed/.test(e.textContent) ? e.textContent : null)), 20000, 200);
      check('J: Settings shows the reason too', /2000\.01\.01 is installed/.test(line || '') && /The last update failed: /.test(line || ''), line);
      await set.close();
      check('J: the old runtime stays', (await status()).have === '2000.01.01');
    }
    await source(SRC);
    await api('scad-install', { method: 'POST' });
    const again = await settled();
    check('J: the pinned runtime installs over it', !!again && again.have === again.pin && !again.error, JSON.stringify(again).slice(0, 160));

    // ---------------------------------------------------------- K: Save view
    step = 'K save view';
    await open(P.md);
    await open(P.box);
    await rendered();
    const mine = '# my own page\n';
    await put(P.view, mine, 'md');
    await paneButton('Save view');
    let t = await said(/saved the view|not a saved view|could not save/);
    check('K: Save view leaves a page of that name that is not a view', /not a saved view/.test(t || '') && ((await shipBody(P.view)) || {}).body === mine, t);
    await api('page-del?name=' + encodeURIComponent(P.view), { method: 'POST' });
    await paneButton('Save view');
    t = await said(/saved the view|not a saved view|could not save/);
    const v1 = await shipBody(P.view);
    check('K: with the name free it saves the view, an html page', /saved the view/.test(t || '') && !!v1 && v1.kind === 'html' && /^<!-- a view of box\.scad/.test(v1.body) && /<img alt="box" src="data:image\/png;base64,/.test(v1.body), t);
    await open(P.view);
    await wait((b) => document.getElementById('src').value === b, v1 ? v1.body : '');
    await open(P.box);
    await rendered();
    //  a different picture: zoom out
    await page.$eval('.scadhost .lscad-main canvas', (c) => c.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, cancelable: true })));
    await sleep(300);
    await paneButton('Save view');
    t = await said(/saved the view|not a saved view|could not save/);
    const v2 = await shipBody(P.view);
    check('K: saving again replaces the view it saved', /saved the view/.test(t || '') && !!v2 && !!v1 && v2.body !== v1.body && /^<!-- a view of box\.scad/.test(v2.body), t);
    await open(P.view);
    const shown = await waitFor(async () => !!v2 && (await srcVal()) === v2.body, 10000, 200);
    check('K: and the editor shows the new view, not its old copy', !!shown);
    await open(P.box);

    // ---------------------------------------------------------- H: offline
    step = 'H offline';
    await rendered();
    await sleep(1500);
    const cached = await page.evaluate(async () => (await (await caches.open('lattice-scad')).keys()).map((r) => r.url));
    check('H: the page keeps the runtime in a cache of its own', cached.some((u) => /openscad\.wasm\?h=/.test(u)) && cached.some((u) => /openscad\.js\?h=/.test(u)), cached.join(' '));
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const offOk = await waitFor(() => page.evaluate(() => /rendered in/.test((document.querySelector('.scadhost .lscad-st') || {}).textContent || '')), 60000, 500);
    check('H: offline, a scad page renders from the cached runtime', !!offOk);
    check('H: the service worker answered no runtime request', viaSw.length === 0, viaSw.join(' '));
    await page.setOfflineMode(false);
  }
} catch (e) {
  check('suite crashed at ' + step + ': ' + e.message, false);
} finally {
  await browser.close().catch(() => {});
  for (const n of [...Object.values(P), RUN + '/lib', RUN])
    await api('page-del?name=' + encodeURIComponent(n), { method: 'POST' }).catch(() => {});
  await api('scad-uninstall', { method: 'POST' }).catch(() => {});
  if (SRC) await ball('/scad', { action: 'delete-grub', filename: 'source.json' }).catch(() => {});
}
check.done();
