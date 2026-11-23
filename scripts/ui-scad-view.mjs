#!/usr/bin/env node
//  ui-scad-view.mjs: the scad page's 3D pane in a real browser, with no
//  ship. The built scad.js is loaded into a page served from localhost,
//  with the pinned OpenSCAD runtime beside it, and mounted as the shell
//  mounts it. The suite checks:
//
//      the template renders in a worker, and the part's size is shown
//      the runtime is fetched once, whatever the number of renders, and
//      nothing else is fetched (the worker reaches nothing)
//      a slider draws with -D while it moves and writes its line on release
//      a read-only pane draws the change and writes nothing
//      an include resolves against a page, and a hostile one is refused
//      an OpenSCAD error lands in the console with a link to its line
//      a model that runs forever is stopped at the time limit
//      a part past the triangle cap is refused before it reaches WebGL
//      STL, 3MF and PNG export
//      a part of absurd or infinite size leaves the page live
//      another page in the same pane starts clean: no part, view or -D of
//      the last one
//      text put back while a render runs stops that render
//      a change to an included page is drawn and exported
//      the shell reads an include once a session until it changes
//      a WebGL context that is lost and restored draws again
//      a pane mounted again fetches nothing, a new runtime address does
//      the time a few reference models take (printed, not checked)
//
//  Env:    CHROME (as the other browser suites)
//          SCAD_RUNTIME, a directory holding openscad.js and openscad.wasm,
//          the raw files. Unset, the suite downloads the pinned upstream zip
//          (build-scad.mjs PIN), checks it, and unpacks it (needs unzip).
//          SCAD_FONTS, a directory holding the three Liberation .ttf files.
//          Unset, the suite downloads the pinned liberation-fonts tarball.
//  Usage:  node scripts/ui-scad-view.mjs
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { createServer } from 'http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser, makeCheck, sleep, waitFor } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const check = makeCheck({ detailOnPass: true });

//  the runtime: given, or the pinned upstream build
let rt = process.env.SCAD_RUNTIME, tmp = null;
if (!rt) {
  const { PIN } = await import('./lib/scad-pin.mjs');
  tmp = mkdtempSync(join(tmpdir(), 'scad-rt-'));
  const zip = Buffer.from(await (await fetch(PIN.upstream.url)).arrayBuffer());
  if (createHash('sha256').update(zip).digest('hex') !== PIN.upstream.sha256) { console.error('the upstream zip is not the pinned one'); process.exit(2); }
  writeFileSync(join(tmp, 'w.zip'), zip);
  execFileSync('unzip', ['-q', join(tmp, 'w.zip'), '-d', tmp]);
  rt = tmp;
}
const FONTS = ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationMono-Regular.ttf'];
let fd = process.env.SCAD_FONTS;
if (!fd) {
  const { PIN } = await import('./lib/scad-pin.mjs');
  if (!tmp) tmp = mkdtempSync(join(tmpdir(), 'scad-rt-'));
  const tgz = Buffer.from(await (await fetch(PIN.fonts.url)).arrayBuffer());
  if (createHash('sha256').update(tgz).digest('hex') !== PIN.fonts.sha256) { console.error('the fonts tarball is not the pinned one'); process.exit(2); }
  writeFileSync(join(tmp, 'f.tgz'), tgz);
  execFileSync('tar', ['-xzf', join(tmp, 'f.tgz'), '-C', tmp]);
  fd = join(tmp, PIN.fonts.dir);
}
const ALLOWED = ['/', '/favicon.ico', '/scad.js', '/rt/openscad.js', '/rt/openscad.wasm', ...FONTS.map((n) => '/rt/' + n)];
const files = {
  ...Object.fromEntries(FONTS.map((n) => ['/rt/' + n, [readFileSync(join(fd, n)), 'font/ttf']])),
  '/scad.js': [readFileSync(join(root, 'code', 'nex', 'lattice', 'ui-app', 'scad.js')), 'application/javascript'],
  '/rt/openscad.js': [readFileSync(join(rt, 'openscad.js')), 'application/javascript'],
  '/rt/openscad.wasm': [readFileSync(join(rt, 'openscad.wasm')), 'application/wasm'],
  '/': [Buffer.from('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>:root{--bg:#fafafa;--text:#1a1a1a;--border:#8886;--border-soft:#8883;--muted:#8a8a8a;--green:#4a7c59}'
    + 'html,body{margin:0;height:100%;font:15px system-ui;background:var(--bg)}#h{position:absolute;inset:0}</style></head>'
    + '<body><div id="h"></div><script src="/scad.js"></script></body></html>'), 'text/html'],
};
//  stand-ins for the runtime's loader, for failures the real one will not
//  make on request: one whose OpenSCAD traps, one that does not start,
//  and one whose wasm cannot be instantiated (it is given no imports)
files['/fake/noinst.js'] = [Buffer.from('export default function (o) { return new Promise((ok) => o.instantiateWasm({}, ok)); }\n'), 'application/javascript'];
files['/fake/trap.js'] = [Buffer.from('export default async function () { '
  + 'return { FS: { mkdir() {}, writeFile() {}, readFile() { throw new Error("ENOENT"); } }, '
  + 'callMain() { throw new WebAssembly.RuntimeError("memory access out of bounds"); } }; }\n'), 'application/javascript'];
files['/fake/dead.js'] = [Buffer.from('export default async function () { throw new Error("Aborted(OOM)"); }\n'), 'application/javascript'];
const hits = [];
//  the pages /api/page-source answers, for the shell's own reader, and
//  the names it was asked for
const ship = {}, asks = [];
const server = createServer((q, r) => {
  const p = q.url.split('?')[0];
  hits.push(p);
  if (p === '/api/page-source') {
    const n = new URL(q.url, base).searchParams.get('name');
    asks.push(n);
    if (!(n in ship)) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(JSON.stringify({ body: ship[n], kind: 'scad', rev: 1 }));
    return;
  }
  const f = files[p];
  if (!f) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'content-type': f[1] });
  r.end(f[0]);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = 'http://127.0.0.1:' + server.address().port;

const TEMPLATE = readFileSync(join(root, 'tests', 'scad', 'customizer', 'box.scad'), 'utf8');
const browser = await launchBrowser({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];

//  runtime: other addresses for the wasm and the loader. name: the page.
//  askFirst: the question a phone is asked before the first download.
async function open(text, { editable = true, pages = {}, timeout, fonts = true, runtime = null, name = 'parts/box', askFirst = '' } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 760 });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base + '/');
  await page.evaluate((t, ed, pg, to, fonts, rt, name, askFirst) => {
    //  the workers made and not yet ended
    window.workers = { made: 0, live: 0 };
    const RealWorker = window.Worker;
    window.Worker = class extends RealWorker {
      constructor(...a) { super(...a); window.workers.made++; window.workers.live++; }
      terminate() { if (!this.gone) { this.gone = true; window.workers.live--; } super.terminate(); }
    };
    window.buf = t;
    window.edits = [];
    window.jumps = [];
    window.downloads = [];
    HTMLAnchorElement.prototype.click = function () { window.downloads.push({ name: this.download, href: this.href }); };
    window.pages = pg;
    window.fails = 0;
    //  kept, so a section can mount the pane again as the shell does
    window.opts = {
      text: t, name, editable: ed, timeout: to, askFirst,
      runtime: { wasm: '/rt/openscad.wasm', js: '/rt/openscad.js', fonts, ...(rt || {}) },
      readPage: async (n) => (n in window.pages ? window.pages[n] : null),
      onFail: () => { window.fails++; },
      onEdit: (line, nt, old) => {
        const L = window.buf.split('\n');
        if (L[line] !== old) return false;
        L[line] = nt; window.buf = L.join('\n'); window.edits.push([line, nt]);
        setTimeout(() => window.ctl.update(window.buf), 0);
        return true;
      },
      onJump: (l) => window.jumps.push(l),
      onSnapshot: (png) => { window.snap = png; },
    };
    window.ctl = window.LatScad.mount(document.getElementById('h'), window.opts);
  }, text, editable, pages, timeout, fonts ? FONTS.map((n) => [n, '/rt/' + n]) : [], runtime, name, askFirst);
  return page;
}
//  wait for a render to settle: the status says rendered (or an error)
async function settled(page, secs = 90) {
  for (let i = 0; i < secs * 10; i++) {
    const s = await page.evaluate(() => ({ st: document.querySelector('.lscad-st').textContent, busy: document.querySelector('.lscad-busy').textContent }));
    if (s.st && !s.busy && !/making/.test(s.st)) return s.st;
    await sleep(100);
  }
  return 'timeout';
}
const dims = (page) => page.$eval('.lscad-dims', (e) => e.textContent);
const con = (page) => page.$eval('.lscad-con pre', (e) => e.textContent);
//  the colour in the middle of the view, from the PNG Save view takes. The
//  part is yellow and the plate behind it grey.
const middle = (page) => page.evaluate(async () => {
  document.querySelectorAll('.lscad-bar button')[5].click();
  const im = new Image();
  im.src = window.snap;
  await im.decode();
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  const x = c.getContext('2d');
  x.drawImage(im, 0, 0);
  return [...x.getImageData(im.width >> 1, im.height >> 1, 1, 1).data].slice(0, 3);
});
const isPart = (c) => c[0] - c[2] > 60;
//  a page whose main thread is stuck answers nothing: give up on it
const quick = (p, ms) => Promise.race([p, sleep(ms).then(() => 'hung')]);
//  a model that takes a few seconds (4 here), then draws a 14 mm rod
const SLOW = 'for (i = [0:40]) translate([i * 0.3, 0, 0]) sphere(1, $fn = 48);\n';

console.log('the template');
let page = await open(TEMPLATE);
let s = await settled(page);
check('the template renders', /rendered in/.test(s), s);
check('  and its size is shown', /^44 × 34 × 20 mm/.test(await dims(page)), await dims(page));
check('the customizer shows its three variables', (await page.$$eval('.lscad-p', (e) => e.length)) === 3);
check('  in their group', (await page.$eval('.lscad-pg h4', (e) => e.textContent)) === 'Size');
const wasmHits = () => hits.filter((h) => h === '/rt/openscad.wasm').length;

console.log('\na slider: -D while it moves, the line on release');
await page.evaluate(() => { const f = document.querySelector('#lscad-width'); f.value = 100; f.dispatchEvent(new Event('input')); });
await sleep(200);
s = await settled(page);
check('moving draws the new width', /^104 × 34 × 20 mm/.test(await dims(page)), await dims(page));
check('  and writes nothing yet', (await page.evaluate(() => window.edits.length)) === 0);
await page.evaluate(() => { const f = document.querySelector('#lscad-width'); f.dispatchEvent(new Event('change')); });
await sleep(300);
const ed = await page.evaluate(() => window.edits);
check('release writes the line, only its value', ed.length === 1 && ed[0][0] === 3 && ed[0][1] === 'width = 100; // [10:200]', JSON.stringify(ed));
s = await settled(page);
check('  and the part keeps the new width', /^104 × 34 × 20 mm/.test(await dims(page)), await dims(page));
await page.evaluate(() => { const f = document.querySelector('#lscad-wall'); f.value = 3.4; f.dispatchEvent(new Event('input')); f.dispatchEvent(new Event('change')); });
await sleep(300);
check('a decimal step writes a clean value', (await page.evaluate(() => window.edits[1] && window.edits[1][1])) === 'wall = 3.4; // [0.8:0.2:6]');
await settled(page);
check('the runtime was fetched once for all of it', wasmHits() === 1, `${wasmHits()} fetches`);
check('nothing but the page, scad.js and the runtime was fetched', hits.every((h) => ALLOWED.includes(h)), hits.join(' '));

console.log('\nexport');
await page.evaluate(() => document.querySelectorAll('.lscad-bar button')[2].click());
await sleep(300);
let dl = await page.evaluate(() => window.downloads);
check('STL downloads the drawn part, named for the page', dl.length === 1 && dl[0].name === 'box.stl', JSON.stringify(dl.map((d) => d.name)));
await page.evaluate(() => document.querySelectorAll('.lscad-bar button')[3].click());
await settled(page);
for (let i = 0; i < 100 && (await page.evaluate(() => window.downloads.length)) < 2; i++) await sleep(100);
dl = await page.evaluate(() => window.downloads);
check('3MF comes from OpenSCAD itself', dl.length === 2 && dl[1].name === 'box.3mf', JSON.stringify(dl.map((d) => d.name)));
const zipHead = dl[1] && await page.evaluate(async (h) => [...new Uint8Array(await (await fetch(h)).arrayBuffer()).slice(0, 2)].join(), dl[1].href);
check('  and is a zip (an OPC package)', zipHead === '80,75', zipHead);
await page.evaluate(() => document.querySelectorAll('.lscad-bar button')[4].click());
dl = await page.evaluate(() => window.downloads);
check('PNG downloads the view', dl.length === 3 && dl[2].name === 'box.png' && /^data:image\/png;base64,/.test(dl[2].href));
await page.evaluate(() => document.querySelectorAll('.lscad-bar button')[5].click());
check('Save view hands the shell a PNG', /^data:image\/png;base64,/.test(await page.evaluate(() => window.snap || '')));
const px = await page.evaluate(() => { const c = document.querySelector('.lscad-main canvas'); return [c.width, c.height]; });
check('the view drew at the pane size', px[0] > 300 && px[1] > 200, px.join('x'));
await page.close();

console.log('\nread-only');
page = await open(TEMPLATE, { editable: false });
await settled(page);
await page.evaluate(() => { const f = document.querySelector('#lscad-depth'); f.value = 50; f.dispatchEvent(new Event('input')); f.dispatchEvent(new Event('change')); });
await sleep(200);
await settled(page);
check('a read-only pane draws the change', /^44 × 54 × 20 mm/.test(await dims(page)), await dims(page));
check('  and writes nothing', (await page.evaluate(() => window.edits.length)) === 0);
await page.close();

console.log('\ncustomizer fields');
{
  page = await open('wall = 2.5;\nv = [1, 2, 3];\nlabel = "line one\\nline two";\nw = 0.25; // [0.25:0.5:10]\ncube([wall, v[0], w]);\n');
  await settled(page);
  //  what a person does to a field: its text, then a change
  const set = (n, v) => page.evaluate((n1, v1) => { const f = document.querySelector('#lscad-' + n1); f.value = v1; f.dispatchEvent(new Event('change')); }, n, v);
  const shown = (n) => page.$eval('#lscad-' + n, (f) => f.value);
  const edits = () => page.evaluate(() => window.edits.map((e) => e[1]));
  check.eq('a number is a number field', await page.$eval('#lscad-wall', (f) => f.type), 'number');
  await set('wall', '');
  await set('v', '1,,3');
  await set('v', ' , , ');
  await set('v', '');
  await sleep(300);
  check.eq('an emptied number or vector field writes nothing', JSON.stringify(await edits()), '[]');
  check.eq('  and shows its value again', (await shown('wall')) + ' ' + (await shown('v')), '2.5 [1, 2, 3]');
  await set('wall', '0');
  await sleep(300);
  check.eq('a typed 0 is still written', JSON.stringify(await edits()), '["wall = 0;"]');
  check.eq('a string with a line break shows it as an escape', await shown('label'), 'line one\\nline two');
  await set('label', 'line one\\nline two!');
  await sleep(300);
  check.eq('  and an edit keeps the break in the source', (await edits())[1], 'label = "line one\\nline two!";');
  await set('label', 'a "bare" quote');
  await sleep(300);
  check.eq('  and text that is not a string in that form writes nothing', (await edits()).length + ' ' + await shown('label'), '2 line one\\nline two!');
  //  one stop up the slider, as the arrow key does: 0.75 is off the grid
  //  of the step's one decimal
  await page.evaluate(() => { const f = document.querySelector('#lscad-w'); f.stepUp(); f.dispatchEvent(new Event('input')); f.dispatchEvent(new Event('change')); });
  await sleep(300);
  check.eq('a slider stop is written as the slider shows it', (await edits())[2] + ' | ' + (await shown('w')), 'w = 0.75; // [0.25:0.5:10] | 0.75');
  await page.close();

  page = await open('/* [Global] */\ng = 1;\n/* [A] */\na = 2;\n/* [B] */\nb = 3;\ncube([g, a, b]);\n', { editable: false });
  await settled(page);
  const ids = await page.$$eval('.lscad-p input', (e) => e.map((f) => f.id));
  check('a Global parameter shown in two groups has two ids', new Set(ids).size === ids.length && ids.length === 4, ids.join(' '));
  check('  and each label is for its own field', await page.$$eval('.lscad-p', (rows) => rows.every((r) => r.querySelector('label').htmlFor === r.querySelector('input').id)));
  await page.evaluate(() => { const f = document.querySelector('[data-p="g"]'); f.value = '5'; f.dispatchEvent(new Event('change')); });
  await sleep(300);
  await settled(page);
  check.eq('on a read-only page a change to one shows in the other', (await page.$$eval('[data-p="g"]', (e) => e.map((f) => f.value))).join(), '5,5');
  check('  and is drawn', /^5 × 2 × 3 mm/.test(await dims(page)), await dims(page));
  await page.close();
}

console.log('\na render that fails outside OpenSCAD');
{
  const state = (pg) => pg.evaluate(() => ({ st: document.querySelector('.lscad-st').textContent, bad: document.querySelector('.lscad-st').classList.contains('err'),
    sum: document.querySelector('.lscad-con summary').textContent, open: document.querySelector('.lscad-con').open, con: document.querySelector('.lscad-con pre').textContent, fails: window.fails }));
  page = await open('cube(7);\n', { runtime: { wasm: '/rt/none.wasm', js: '/rt/none.js' } });
  await settled(page);
  let f = await state(page);
  check('a runtime that does not load is said to be that', /could not be loaded/.test(f.st) && f.bad && !/no part/.test(f.st), f.st);
  check('  with the reason counted and open in the console', /1 error/.test(f.sum) && f.open && /could not load the OpenSCAD runtime/.test(f.con), JSON.stringify(f));
  check.eq('  and the shell is told', f.fails, 1);
  await page.close();
  page = await open('cube(7);\n', { runtime: { js: '/fake/trap.js' } });
  await settled(page);
  f = await state(page);
  check('a trap inside OpenSCAD is a render that stopped, not an empty model', /stopped before it finished/.test(f.st) && f.bad, f.st);
  check('  with the trap counted and open in the console', /1 error/.test(f.sum) && f.open && /memory access out of bounds/.test(f.con), JSON.stringify(f));
  await page.close();
  page = await open('cube(7);\n', { runtime: { js: '/fake/dead.js' } });
  await settled(page);
  f = await state(page);
  check('a runtime that does not start is a render that stopped', /stopped before it finished/.test(f.st) && /1 error/.test(f.sum) && f.open && /runtime failed/.test(f.con), JSON.stringify(f));
  await page.close();
  page = await open('cube(7);\n', { runtime: { js: '/fake/noinst.js' }, timeout: 20000 });
  await settled(page, 40);
  f = await state(page);
  check('a wasm that cannot be instantiated is said at once, not at the time limit', /stopped before it finished/.test(f.st) && /runtime failed/.test(f.con) && !/stopped after/.test(f.con), JSON.stringify(f));
  await page.close();
  //  the neighbours: OpenSCAD's own answers read as before
  page = await open('x = 1;\n');
  await settled(page);
  f = await state(page);
  check('a model that draws nothing is still an empty model', /no part/.test(f.st) && !/error/.test(f.sum), JSON.stringify(f));
  await page.close();
}

console.log('\nan error, then the text taken back');
{
  page = await open('cube(7);\n');
  await settled(page);
  await page.evaluate(() => window.ctl.update('cube(7);\nsphere(;\n'));
  for (let i = 0; i < 300 && !/error/.test(s = await settled(page)); i++) await sleep(100);
  check('the error is shown', /error/.test(s) && /1 error/.test(await page.$eval('.lscad-con summary', (e) => e.textContent)), s);
  await page.evaluate(() => window.ctl.update('cube(7);\n'));
  await sleep(1500);
  const u = await page.evaluate(() => ({ st: document.querySelector('.lscad-st').textContent, bad: document.querySelector('.lscad-st').classList.contains('err'),
    sum: document.querySelector('.lscad-con summary').textContent, con: document.querySelector('.lscad-con pre').textContent, made: window.workers.made }));
  check('with the good text back, the status is the good render\'s', /rendered in/.test(u.st) && !u.bad, u.st);
  check('  and so is the console', !/error/.test(u.sum) && !/ERROR/.test(u.con), u.sum + ' ' + u.con.slice(0, 120));
  check.eq('  and nothing was rendered again for it', u.made, 2);
  check('  and the part is the good one', /^7 × 7 × 7 mm/.test(await dims(page)), await dims(page));
  await page.close();
}

console.log('\nan export that outlives its page');
{
  const click = (pg, t) => pg.evaluate((x) => [...document.querySelectorAll('.lscad-bar button')].find((b) => b.textContent === x).click(), t);
  const names = (pg) => pg.evaluate(() => window.downloads.map((d) => d.name));
  const live = (pg) => pg.evaluate(() => window.workers.live);
  //  until an export's worker is running
  const exporting = async (pg) => { for (let i = 0; i < 100 && (await live(pg)) < 1; i++) await sleep(50); return live(pg); };
  page = await open(SLOW, { name: 'parts/alpha', timeout: 120000 });
  await settled(page, 120);
  await click(page, '3MF');
  check.eq('an export runs in a worker', await exporting(page), 1);
  check.eq('another page in the pane ends it at once', await page.evaluate(() => { window.ctl.update('cube(3);\n', { name: 'parts/beta' }); return window.workers.live; }), 0);
  await sleep(500);
  s = await settled(page);
  check('  and the new page says nothing of it', /rendered in/.test(s), s);
  check.eq('  and nothing was downloaded under either name', (await names(page)).join(), '');
  await click(page, '3MF');
  for (let i = 0; i < 300 && !(await names(page)).length; i++) await sleep(100);
  check.eq('the new page exports under its own name', (await names(page)).join(), 'beta.3mf');
  await page.close();

  page = await open(SLOW, { name: 'parts/alpha', timeout: 120000 });
  await settled(page, 120);
  await click(page, '3MF');
  await exporting(page);
  await page.evaluate(() => window.ctl.destroy());
  check.eq('a pane that is closed ends its export', await live(page), 0);
  await sleep(1500);
  check.eq('  and downloads nothing afterwards', (await names(page)).join(), '');
  await page.close();

  //  the STL of the part on screen needs no worker: a 3MF under way goes on
  page = await open(SLOW, { name: 'parts/alpha', timeout: 120000 });
  await settled(page, 120);
  await click(page, '3MF');
  await exporting(page);
  await click(page, 'STL');
  for (let i = 0; i < 400 && (await names(page)).length < 2; i++) await sleep(100);
  check.eq('an STL asked for during a 3MF is made and the 3MF still arrives', (await names(page)).slice().sort().join(), 'alpha.3mf,alpha.stl');
  check('  and the status says the 3MF came', /3MF downloaded/.test(await page.$eval('.lscad-st', (e) => e.textContent)), await page.$eval('.lscad-st', (e) => e.textContent));
  await page.close();

  //  a phone is asked before the runtime is fetched: an export waits for
  //  the answer as a render does
  const before = hits.length;
  page = await open('cube(4);\n', { askFirst: 'This draws with OpenSCAD, about 4 MB. Download it?' });
  await sleep(300);
  await click(page, 'STL');
  await click(page, '3MF');
  await sleep(700);
  const asked = await page.evaluate(() => ({ made: window.workers.made, q: !document.querySelector('.lscad-msg').hidden && !!document.querySelector('.lscad-msg button'), dl: window.downloads.length }));
  check('an export before the answer fetches no runtime', !hits.slice(before).some((h) => /openscad/.test(h)) && asked.made === 0 && asked.dl === 0, hits.slice(before).join(' '));
  check('  and the question is still there', asked.q);
  await page.evaluate(() => document.querySelector('.lscad-msg button').click());
  await settled(page);
  await click(page, 'STL');
  await sleep(300);
  check.eq('after the answer the export works', (await names(page)).join(), 'box.stl');
  await page.close();
}

console.log('\na page and its child page, both included without .scad');
{
  page = await open('include <a>\ninclude <a/b>\ncube([x, 2, 1]);\n', { pages: { 'parts/a': 'x = 3;', 'parts/a/b': 'y = 4;' } });
  s = await settled(page);
  check('the render still runs', /rendered in/.test(s) && /^3 × 2 × 1 mm/.test(await dims(page)), s + ' ' + await dims(page));
  check('  and the include left out is said', /a\/b: not read/.test(await con(page)), (await con(page)).slice(0, 200));
  await page.close();
}

console.log('\na page and its child page, the model needs the one left out');
{
  page = await open('include <a>\ninclude <a/b>\ncube([x, y, 1]);\n', { pages: { 'parts/a': 'x = 3;', 'parts/a/b': 'y = 4;' } });
  s = await settled(page);
  const stc = await page.$eval('.lscad-st', (e) => e.className);
  check('the status does not pass for a plain render', /left out|not all/.test(s) && /err/.test(stc), s + ' ' + stc);
  check('  and the console is open on the include left out', await page.$eval('.lscad-con', (e) => e.open) && /a\/b: not read/.test(await con(page)), (await con(page)).slice(0, 200));
  //  an export of it says the same, for the 3MF and for the STL
  await page.evaluate(() => { document.querySelector('.lscad-con').open = false; });
  await page.evaluate(() => document.querySelectorAll('.lscad-bar button')[3].click());
  for (let i = 0; i < 100 && !/3MF downloaded/.test(await page.$eval('.lscad-st', (e) => e.textContent)); i++) await sleep(100);
  const x3 = await page.$eval('.lscad-st', (e) => [e.textContent, e.className]);
  check('a 3MF made without an include is not a plain download', /3MF downloaded.*not all it includes/.test(x3[0]) && /err/.test(x3[1]), x3.join(' '));
  check('  and the console is open on it', await page.$eval('.lscad-con', (e) => e.open) && /a\/b: not read/.test(await con(page)), (await con(page)).slice(0, 200));
  await page.evaluate(() => { document.querySelector('.lscad-con').open = false; });
  await page.evaluate(() => document.querySelectorAll('.lscad-bar button')[2].click());
  await sleep(500);
  const xs = await page.$eval('.lscad-st', (e) => [e.textContent, e.className]);
  check('and so is an STL of the part on screen', /STL downloaded.*not all it includes/.test(xs[0]) && /err/.test(xs[1]) && await page.$eval('.lscad-con', (e) => e.open), xs.join(' '));
  await page.close();
}

console.log('\nincludes, errors and hostile models');
page = await open('include <lib/plate.scad>\nplate(30);\n', { pages: { 'parts/lib/plate': 'module plate(w) { cube([w, w, 2]); }\n' } });
s = await settled(page);
check('an include resolves against a page in the folder', /^30 × 30 × 2 mm/.test(await dims(page)), s + ' ' + await dims(page));
await page.evaluate(() => window.ctl.update('include <../../../etc/passwd>\ncube(1);\n'));
await sleep(500);
s = await settled(page);
check('an include above the root is refused, and said', /reaches above the top/.test(await con(page)), await con(page));
await page.evaluate(() => window.ctl.update('cube(5);\nsphere(;\n'));
await sleep(500);
s = await settled(page);
check('a syntax error is an error', /error/.test(s), s);
check('  the last good part stays on screen', /^1 × 1 × 1 mm/.test(await dims(page)), await dims(page));
const link = await page.$('.lscad-con a');
check('  and the console links its line', !!link);
if (link) { await link.click(); check('  which jumps to it', (await page.evaluate(() => window.jumps[0])) === 1, JSON.stringify(await page.evaluate(() => window.jumps))); }
await page.close();

page = await open('function f(n) = f(n + 1) + 1;\necho(f(0));\ncube(1);\n');
s = await settled(page);
//  the wasm traps on it: a render that stopped, with the trap in the console
check('runaway recursion ends with a message', /error|stopped before it finished/i.test(s) || /recursion/i.test(await con(page)), s + ' ' + (await con(page)).slice(0, 120));
await page.close();

//  a one second limit: on a quick machine OpenSCAD gives this model up
//  itself after about three, and the limit has to be the first to end it
page = await open('function f(n, a = 0) = n == 0 ? a : f(n - 1, a + 1);\necho(f(50000000));\ncube(1);\n', { timeout: 1000 });
const t0 = Date.now();
s = await settled(page, 30);
check('a model that runs past the time limit is stopped', /stopped/.test(s) && Date.now() - t0 < 15000, `${s} after ${Date.now() - t0} ms`);
await page.close();

page = await open('sphere(10, $fn = 1500);\n', { timeout: 120000 });
s = await settled(page, 150);
check('a part past the triangle cap is refused before WebGL', /more than the viewer draws/.test(s), s);
await page.close();

console.log('\na part of absurd size');
for (const [what, text] of [['a part a billion km wide', 'cube(1e12);\n'], ['a part at the edge of a float', 'cube(3e38);\n'], ['a part past what a float holds', 'cube(1e39);\n']]) {
  page = await open(text);
  s = await quick(settled(page, 30).catch(() => 'crashed'), 40000);
  const alive = await quick(page.evaluate(() => 1).catch(() => 0), 5000);
  check(`${what} answers, and the page stays live`, /rendered in|error|no part|no size/.test(s) && alive === 1, s);
  page.close().catch(() => {});
}

console.log('\nanother page in the same pane');
page = await open(TEMPLATE);
await settled(page);
await page.evaluate(() => { const f = document.querySelector('#lscad-width'); f.value = 100; f.dispatchEvent(new Event('input')); });
await sleep(200);
await settled(page);
await page.evaluate(() => window.ctl.update('width = 20; // [10:200]\ntranslate([1000, 0, 0]) cube([width, 5, 5]);\n', { name: 'parts/other' }));
await sleep(500);
s = await settled(page);
check('a slider value does not follow to another page', /^20 × 5 × 5 mm/.test(await dims(page)), s + ' ' + await dims(page));
check('  and the view is fitted to the new part', isPart(await middle(page)), (await middle(page)).join());
await page.evaluate(() => window.ctl.update('sphere(;\n', { name: 'parts/broken' }));
await sleep(500);
s = await settled(page);
check('a page that fails keeps no part of the last one', /error/.test(s) && (await dims(page)) === ''
  && (await page.evaluate(() => window.ctl.mesh())) === null && !isPart(await middle(page)), s + ' ' + await dims(page));
await page.close();

console.log('\ntext put back while a render runs');
page = await open('cube(1);\n');
await settled(page);
await page.evaluate((t) => window.ctl.update(t), SLOW);
await sleep(900);
check('the slow render is under way', (await page.$eval('.lscad-busy', (e) => e.textContent)) !== '');
await page.evaluate(() => window.ctl.update('cube(1);\n'));
await sleep(700);
check('putting the text back stops it', (await page.$eval('.lscad-busy', (e) => e.textContent)) === '');
await waitFor(async () => /^14 × 2 × 2 mm/.test(await dims(page)), 12000, 200);
check('  and its part never replaces the one the text says', /^1 × 1 × 1 mm/.test(await dims(page)), await dims(page));
await page.close();

console.log('\nan included page changes');
const USES = 'include <lib/plate.scad>\nplate(30);\n';
page = await open(USES, { pages: { 'parts/lib/plate': 'module plate(w) { cube([w, w, 2]); }\n' } });
await settled(page);
await page.evaluate((t) => { window.pages['parts/lib/plate'] = 'module plate(w) { cube([w + 10, w + 10, 2]); }\n'; window.ctl.update(t); }, USES);
await waitFor(async () => /^40 × 40 × 2 mm/.test(await dims(page)), 15000, 200);
check('a change to an included page is drawn, the main text the same', /^40 × 40 × 2 mm/.test(await dims(page)), await dims(page));
await settled(page);
await page.evaluate(() => {
  window.pages['parts/lib/plate'] = 'module plate(w) { cube([w, w, 2]); translate([0, 0, 5]) cube(1); }\n';
  document.querySelectorAll('.lscad-bar button')[2].click();
});
await waitFor(() => page.evaluate(() => window.downloads.length === 1), 15000, 200);
const tris = await page.evaluate(async () => (window.downloads[0]
  ? new DataView(await (await fetch(window.downloads[0].href)).arrayBuffer()).getUint32(80, true) : -1));
check('  and an STL export is of the page as it is now', tris === 24, `${tris} triangles`);
await page.close();

console.log('\nan include costs one read a session while it does not change');
//  The shell's own reader (shell.js), over /api/page-source here. revOf
//  stands in for the tree's revs (26-scad.js), which the beacon keeps
//  fresh. What calls forget() on a save here (35-pages.js patchLocal)
//  needs the editor and a ship, and is not run.
Object.assign(ship, {
  'parts/lib/a': 'module a() { cube([10, 10, 2]); }\n',
  'parts/lib/b': 'module b() { translate([0, 0, 2]) cube([10, 10, 3]); }\n',
});
const INC = 'include <lib/a.scad>\ninclude <lib/b.scad>\ninclude <lib/none.scad>\na(); b();\n';
page = await open('cube(1);\n');
await settled(page);
await page.evaluate(() => {
  const da = document.createElement('div');
  da.id = 'docarea';
  document.body.append(da);
  window.revs = { 'parts/lib/a': 1, 'parts/lib/b': 1 };
  window.g = window.LatScad.shell({
    api: '/api', $: (id) => document.getElementById(id), pageCache: new Map(),
    revOf: (n) => (n in window.revs ? window.revs[n] : null),
  });
  window.ctl.destroy();
  window.ctl = window.LatScad.mount(document.getElementById('h'), { ...window.opts, readPage: window.g.readPage });
  //  every render ends by writing the status line, so a count of those
  //  writes says when the render of an update is done
  window.stN = 0;
  new MutationObserver(() => { window.stN++; }).observe(document.querySelector('.lscad-st'), { childList: true });
});
//  the new view's first render is over before anything is changed, or
//  its end would be taken for the end of the next one
await waitFor(() => page.evaluate(() => window.stN > 0), 90000, 50);
await settled(page);
const askd = (n) => asks.filter((x) => x === n).length;
//  update the page and wait for the render of that text. A fixed wait
//  read the part of the render before on a busy machine: the reads of the
//  includes come first, and the view says it is busy only 150 ms into the
//  render itself.
const drawn = async (act, arg) => {
  const n = await page.evaluate(() => window.stN);
  await page.evaluate(act, arg);
  await waitFor(() => page.evaluate((n) => window.stN > n, n), 90000, 50);
  return settled(page);
};
const N = 4;
for (let i = 0; i < N; i++) {
  s = await drawn((t) => window.ctl.update(t), INC + '// ' + i + '\n');
}
check(`${N} renders of a page with two includes read each once`, askd('parts/lib/a') === 1 && askd('parts/lib/b') === 1 && /^10 × 10 × 5 mm/.test(await dims(page)), `${asks.join(' ')} | ${await dims(page)}`);
check('  and a missing include is not asked for again', askd('parts/lib/none') === 1, asks.join(' '));
//  a page edited elsewhere: the tree's rev moves
ship['parts/lib/a'] = 'module a() { cube([20, 20, 2]); }\n';
s = await drawn((t) => { window.revs['parts/lib/a'] = 2; window.ctl.update(t); }, INC + '// a\n');
check('a page whose rev moved is read again, and drawn as it is now', askd('parts/lib/a') === 2 && askd('parts/lib/b') === 1 && /^20 × 20 × 5 mm/.test(await dims(page)), `${asks.join(' ')} | ${await dims(page)}`);
//  a page saved here: forget()
ship['parts/lib/b'] = 'module b() { translate([0, 0, 2]) cube([10, 10, 8]); }\n';
s = await drawn((t) => { window.g.forget('parts/lib/b'); window.ctl.update(t); }, INC + '// b\n');
check('a page forgotten is read again, and drawn as it is now', askd('parts/lib/b') === 2 && askd('parts/lib/a') === 2 && /^20 × 20 × 10 mm/.test(await dims(page)), `${asks.join(' ')} | ${await dims(page)}`);
//  the missing page is made: it comes into the tree
ship['parts/lib/none'] = 'translate([0, 0, 10]) cube([1, 1, 5]);\n';
s = await drawn((t) => { window.revs['parts/lib/none'] = 1; window.ctl.update(t); }, INC + '// none\n');
check('a page made after a miss is found', askd('parts/lib/none') === 2 && /^20 × 20 × 15 mm/.test(await dims(page)), `${asks.join(' ')} | ${await dims(page)}`);
await page.close();

console.log('\nthe WebGL context is lost and comes back');
page = await open('cube(10);\n');
await settled(page);
check('the part is in the middle of the view', isPart(await middle(page)), (await middle(page)).join());
const back = await quick(page.evaluate(async () => {
  const c = document.querySelector('.lscad-main canvas');
  const x = c.getContext('webgl').getExtension('WEBGL_lose_context');
  const on = (n) => new Promise((ok) => c.addEventListener(n, ok, { once: true }));
  let p = on('webglcontextlost');
  x.loseContext();
  await p;
  //  a restore is allowed only once the lost event is over
  await new Promise((ok) => setTimeout(ok, 100));
  p = on('webglcontextrestored');
  x.restoreContext();
  await p;
  await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  return 'back';
}), 10000);
check('a restored context draws the part again', back === 'back' && isPart(await middle(page)), back + ' ' + (await middle(page)).join());

console.log('\nthe pane mounted again');
const remount = (rt) => page.evaluate((r) => {
  window.ctl.destroy();
  window.ctl = window.LatScad.mount(document.getElementById('h'), { ...window.opts, runtime: { ...window.opts.runtime, ...r } });
}, rt);
let from = hits.length;
await remount({});
s = await settled(page);
check('a pane mounted again renders', /rendered in/.test(s), s);
check('  and fetches nothing: the runtime is kept for the session', hits.length === from, hits.slice(from).join(' '));
await remount({ wasm: '/rt/openscad.wasm?h=next' });
s = await settled(page);
check('a runtime at a new address is fetched, not the kept one', /rendered in/.test(s) && hits.slice(from).filter((h) => h === '/rt/openscad.wasm').length === 1, hits.slice(from).join(' '));
check('no runtime has failed to load so far', (await page.evaluate(() => window.fails)) === 0);
await remount({ wasm: '/rt/gone.wasm' });
s = await settled(page);
check('a runtime that does not load is told to the shell', (await page.evaluate(() => window.fails)) === 1, s);
await page.close();

console.log('\nthe hostile corpus (tests/scad/hostile): every model answers');
{
  const { readdirSync } = await import('fs');
  const dir = join(root, 'tests', 'scad', 'hostile');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.scad')).sort()) {
    const text = readFileSync(join(dir, f), 'utf8');
    const limit = /triangles/.test(f) ? 120000 : 10000;
    const before = hits.length;
    page = await open(text, { timeout: limit, pages: { 'parts/05-include-self': text } });
    const t = Date.now();
    s = await settled(page, limit / 1000 + 30);
    const said = /rendered in|error|stopped|more than the viewer draws|no part/.test(s);
    check(`${f}: answers (${s.slice(0, 60)}) in ${((Date.now() - t) / 1000).toFixed(1)} s`, said && Date.now() - t < limit + 20000);
    const extra = hits.slice(before).filter((h) => !ALLOWED.includes(h));
    check(`${f}: fetches nothing but the runtime`, !extra.length, extra.join(' '));
    const shown = await page.evaluate(() => document.querySelector('.lscad').innerHTML);
    check(`${f}: no markup of the model's own reaches the pane`, !/<script|<img|<b>/.test(shown));
    await page.close();
  }
}

console.log('\ntext(), with the Liberation fonts');
const fontsFrom = hits.length;
page = await open('linear_extrude(2) text("Hi", size = 10);\n');
s = await settled(page);
check('text("Hi") draws a part', /rendered in/.test(s) && /triangles/.test(await dims(page)), s + ' ' + await dims(page));
check('  in the default font, Liberation Sans', !/Can't get font/.test(await con(page)), await con(page));
await page.evaluate(() => window.ctl.update('linear_extrude(2) text("Mono", font = "Liberation Mono:style=Regular");\ntranslate([0, 15]) linear_extrude(2) text("Bold", font = "Liberation Sans:style=Bold");\n'));
await sleep(500);
s = await settled(page);
check('Liberation Mono and Sans Bold draw too', /rendered in/.test(s) && !/Can't get font|not found/i.test(await con(page)), s);
check('  and each font was fetched once for both renders', FONTS.every((n) => hits.slice(fontsFrom).filter((h) => h === '/rt/' + n).length === 1), JSON.stringify(FONTS.map((n) => hits.slice(fontsFrom).filter((h) => h === '/rt/' + n).length)));
await page.close();
page = await open('linear_extrude(2) text("Hi", size = 10);\n', { fonts: false });
s = await settled(page);
check('without the fonts (an older install) text() says so, and the pane answers', /no part|error/.test(s) && /font/i.test(await con(page)), s);
await page.close();

console.log('\nreference models (render time, first render after load)');
const REF = {
  bracket: 'difference() {\n union() { cube([60, 10, 4]); cube([4, 10, 40]); translate([4, 0, 4]) rotate([-90, 0, 0]) linear_extrude(10) polygon([[0, 0], [16, 0], [0, 16]]); }\n for (x = [15, 45]) translate([x, 5, -1]) cylinder(d = 5, h = 6, $fn = 48);\n for (z = [15, 32]) translate([-1, 5, z]) rotate([0, 90, 0]) cylinder(d = 5, h = 6, $fn = 48);\n}\n',
  gear: 'teeth = 40; m = 2; r = teeth * m / 2;\nlinear_extrude(8) difference() {\n union() { circle(r - m, $fn = 200); for (i = [0:teeth - 1]) rotate(i * 360 / teeth) translate([r - m, 0]) polygon([[0, -m * 0.9], [2.2 * m, -m * 0.45], [2.2 * m, m * 0.45], [0, m * 0.9]]); }\n circle(5, $fn = 64);\n}\n',
  assembly: '$fn = 32;\nfor (i = [0:49]) translate([(i % 10) * 14, floor(i / 10) * 14, 0]) difference() { union() { cylinder(d = 10, h = 6); translate([0, 0, 6]) sphere(d = 8); } translate([0, 0, -1]) cylinder(d = 3, h = 20); }\n',
};
for (const [name, text] of Object.entries(REF)) {
  page = await open(text);
  s = await settled(page, 120);
  check(`${name}: ${s}, ${await dims(page)}`, /rendered in/.test(s));
  await page.close();
}

check('no page error', !errors.length, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
if (tmp) rmSync(tmp, { recursive: true, force: true });
check.done();
