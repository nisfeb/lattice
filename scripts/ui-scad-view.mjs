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
const hits = [];
const server = createServer((q, r) => {
  const p = q.url.split('?')[0];
  hits.push(p);
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

async function open(text, { editable = true, pages = {}, timeout, fonts = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 760 });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base + '/');
  await page.evaluate((t, ed, pg, to, fonts) => {
    window.buf = t;
    window.edits = [];
    window.jumps = [];
    window.downloads = [];
    HTMLAnchorElement.prototype.click = function () { window.downloads.push({ name: this.download, href: this.href }); };
    window.pages = pg;
    window.fails = 0;
    //  kept, so a section can mount the pane again as the shell does
    window.opts = {
      text: t, name: 'parts/box', editable: ed, timeout: to,
      runtime: { wasm: '/rt/openscad.wasm', js: '/rt/openscad.js', fonts },
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
  }, text, editable, pages, timeout, fonts ? FONTS.map((n) => [n, '/rt/' + n]) : []);
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
check('runaway recursion ends with a message', /error|no part/i.test(s) || /recursion/i.test(await con(page)), s);
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
