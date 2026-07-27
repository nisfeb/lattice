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

const wait = (fn, ...args) => page.waitForFunction(fn, { timeout: 15000 }, ...args);
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
  await page.goto(APP, { waitUntil: 'networkidle2', timeout: 20000 });
  await wait(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0);
  ok('boot: tree renders');

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
  await page.goto(APP + '?name=' + RUN + '/hello', { waitUntil: 'networkidle2' });
  await wait(() => document.getElementById('src').value.length > 0);
  check('open: body round-trips',
    await page.evaluate(() => document.getElementById('src').value) === '# ui matrix probe');

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
  check('overlay parity: nowrap', await parity());
  await page.click('#wrapt');
  await sleep(300);
  check('overlay parity: wrap', await parity());
  await page.click('#wrapt');
  await sleep(300);

  step = 'folder create';
  // ── 3. folder create via the in-app dialog ───────────────────────────────
  await page.click('#newfolder');
  await dialog(RUN + '/sub');
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
  await page.goto(APP + '?name=' + RUN + '-moved/hello', { waitUntil: 'networkidle2' });
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
  await page.goto(APP, { waitUntil: 'networkidle2' });
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
  await page.goto(APP, { waitUntil: 'networkidle2' });
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
