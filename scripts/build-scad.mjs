#!/usr/bin/env node
//  build-scad.mjs: the OpenSCAD runtime's pin, and scad.js.
//
//  scad pages render in the browser with OpenSCAD compiled to WebAssembly.
//  That runtime is optional and is never part of the desk: the owner
//  installs it, and the ship fetches the files below once, checks
//  each against its SHA-256 and keeps them (app.hoon, +scad-install-run).
//  This file is the record of what is pinned and where it came from.
//
//  The runtime
//
//    version  OpenSCAD 2026.11.10 development snapshot, WebAssembly, web
//    upstream https://files.openscad.org/snapshots/OpenSCAD-2026.11.10-WebAssembly-web.zip
//             sha256 0ccd0154bb37ca0865e453f033b2b9415977e90a6c9d7f69a64e0c975786ca2d,
//             3,356,388 bytes, as files.openscad.org's .sha256 says. It holds
//             openscad.js (the Emscripten loader, an ES module) and
//             openscad.wasm, both unmodified here.
//    built    by the OpenSCAD project's CI from openscad/openscad master. The
//             last commit before the snapshot is bcf45a22caa954ca56ca287994cb6dbc368c67b2
//             (2026-11-07), the source a recipient is pointed to.
//    backend  Manifold, the default (strings in the wasm: "3D rendering
//             backend to use: 'CGAL' (old/slow) or 'Manifold' (new/fast)
//             [default]"). lib3mf is linked in, so 3MF export comes from
//             OpenSCAD itself.
//    licence  GPL-2.0-or-later, with OpenSCAD's exception for linking CGAL.
//             The text is OpenSCAD's COPYING at that commit, shipped as the
//             third file and served at /apps/lattice/scad/COPYING.
//    source   https://github.com/openscad/openscad
//    fonts    LiberationSans-Regular, LiberationSans-Bold and LiberationMono-Regular
//             from liberation-fonts 2.1.5 (PIN.fonts: the tarball its GitHub
//             release notes link, sha256 7191c669...25d0), under the SIL OFL
//             1.1. Without them text() draws nothing: the web build carries
//             no fonts. The worker puts them in /fonts with a fonts.conf,
//             and Liberation Sans is OpenSCAD's default font.
//
//  The release files, as the ship fetches them from +scad-url in app.hoon:
//
//    openscad.wasm.gz      the wasm, gzip level 9 by node's zlib (this script,
//                          --release). Kept and served gzipped, so it costs
//                          3.3 MB of loom and download, not 11 MB. The
//                          browser unzips it (content-encoding: gzip).
//    openscad.js           unmodified
//    openscad-COPYING.txt  OpenSCAD's COPYING, unmodified
//    LiberationSans-Regular.ttf.gz, LiberationSans-Bold.ttf.gz and
//    LiberationMono-Regular.ttf.gz
//                          the fonts text() draws with, gzipped the same way
//                          (0.6 MB), from the liberation-fonts 2.1.5 tarball
//                          (PIN.fonts), unmodified inside
//    liberation-fonts-LICENSE.txt
//                          their licence, the SIL OFL 1.1, from the tarball
//
//  scad.js
//
//  With no flag, this builds ui-src/scad/ into the served
//  code/nex/lattice/ui-app/scad.js: the viewer, the customizer, the include
//  resolver and the worker driver, as build-sheet.mjs builds sheet.js. One
//  minified IIFE, no source map, nothing global but window.LatScad. It
//  bundles no package: every line is lattice's own, and the build fails if
//  esbuild pulls in anything from node_modules, so no third-party licence
//  rides in it. CI rebuilds and diffs it. It fails over its budget: 60 KB
//  raw, 20 KB gzipped. app.js loads it only when a scad page shows with
//  the runtime installed.
//
//  Usage:
//    node scripts/build-scad.mjs [--quiet]
//        build scad.js
//    node scripts/build-scad.mjs --check-pin
//        app.hoon's +scad-files and +scad-ver match PIN below. CI runs it.
//    node scripts/build-scad.mjs --release DIR
//        download the upstream zip, check it, and write the three release
//        files to DIR, each checked against PIN. Upload those to the
//        release +scad-url names. Needs `unzip` and `tar`.
//    node scripts/build-scad.mjs --verify [URL]
//        fetch the release files from URL (default: +scad-url) and check
//        them. Skips when no URL is set.
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const APP = join(root, 'code', 'nex', 'lattice', 'app.hoon');

//  the pin itself is in lib/scad-pin.mjs, so a suite can read it without
//  running this build
import { PIN } from './lib/scad-pin.mjs';
export { PIN };

const sha = (b) => createHash('sha256').update(b).digest('hex');
const die = (m) => { console.error('build-scad: ' + m); process.exit(1); };

//  app.hoon's pin: +scad-ver, +scad-url, and each +scad-files row
export function hoonPin(src = readFileSync(APP, 'utf8')) {
  const ver = /\+\+  scad-ver  \^-\(@t '([^']*)'\)/.exec(src);
  const url = /\+\+  scad-url  \^-\(@t '([^']*)'\)/.exec(src);
  const rows = [...src.matchAll(/:\*  %'([^']+)'  %'([^']+)'\s+'([0-9a-f]{64})'\s+([0-9.]+)\s/g)]
    .map((m) => ({ name: m[1], file: m[2], sha256: m[3], size: Number(m[4].replace(/\./g, '')) }));
  return { version: ver && ver[1], url: url ? url[1] : null, files: rows };
}

async function get(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(url + ' answered ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

const arg = (k) => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1] || ''; };

if (process.argv.includes('--check-pin')) {
  const h = hoonPin();
  let bad = 0;
  const eq = (what, a, b) => { if (a !== b) { console.error(`  FAIL - ${what}: app.hoon ${JSON.stringify(a)}, build-scad ${JSON.stringify(b)}`); bad++; } else console.log(`  ok   - ${what}`); };
  eq('scad-ver', h.version, PIN.version);
  eq('scad-files has every file', h.files.length, PIN.files.length);
  for (const f of PIN.files) {
    const r = h.files.find((x) => x.name === f.name) || {};
    eq(f.name + ' file', r.file, f.file);
    eq(f.name + ' sha256', r.sha256, f.sha256);
    eq(f.name + ' size', r.size, f.size);
  }
  eq('the served js is the raw js', PIN.files[1].sha256, PIN.raw['openscad.js'].sha256);
  if (h.url === null) { console.error('  FAIL - scad-url not found'); bad++; }
  else console.log(h.url ? `  ok   - scad-url is ${h.url}` : '  note - scad-url is empty: the owner has not named the release yet');
  console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
  process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--release')) {
  const out = arg('--release');
  if (!out) die('--release DIR');
  mkdirSync(out, { recursive: true });
  const zip = await get(PIN.upstream.url);
  if (sha(zip) !== PIN.upstream.sha256 || zip.length !== PIN.upstream.size) die('the upstream zip is not the pinned one');
  const tmp = mkdtempSync(join(tmpdir(), 'scad-'));
  try {
    writeFileSync(join(tmp, 'w.zip'), zip);
    execFileSync('unzip', ['-q', '-o', join(tmp, 'w.zip'), '-d', join(tmp, 'x')]);
    const wasm = readFileSync(join(tmp, 'x', 'openscad.wasm'));
    const js = readFileSync(join(tmp, 'x', 'openscad.js'));
    for (const [n, b] of [['openscad.wasm', wasm], ['openscad.js', js]]) {
      if (sha(b) !== PIN.raw[n].sha256) die(n + ' in the zip is not the pinned file');
    }
    //  the fonts: the pinned liberation-fonts tarball, each file checked
    const tgz = await get(PIN.fonts.url);
    if (sha(tgz) !== PIN.fonts.sha256 || tgz.length !== PIN.fonts.size) die('the liberation-fonts tarball is not the pinned one');
    writeFileSync(join(tmp, 'f.tgz'), tgz);
    execFileSync('tar', ['-xzf', join(tmp, 'f.tgz'), '-C', tmp]);
    const font = (n) => {
      const b = readFileSync(join(tmp, PIN.fonts.dir, n));
      if (sha(b) !== PIN.fonts.raw[n].sha256) die(n + ' in the tarball is not the pinned file');
      return b;
    };
    const files = {
      'openscad.wasm.gz': gzipSync(wasm, { level: 9 }),
      'openscad.js': js,
      'openscad-COPYING.txt': await get(PIN.copying.url),
      'liberation-fonts-LICENSE.txt': font('LICENSE'),
    };
    for (const n of Object.keys(PIN.fonts.raw)) if (n.endsWith('.ttf')) files[n + '.gz'] = gzipSync(font(n), { level: 9 });
    for (const f of PIN.files) {
      const b = files[f.file];
      if (sha(b) !== f.sha256 || b.length !== f.size) die(`${f.file} is ${sha(b)} (${b.length} bytes), not the pin. A different zlib can gzip differently: pin the new hash in both places.`);
      writeFileSync(join(out, f.file), b);
      console.log(`wrote ${f.file}: ${b.length} bytes, sha256 ${f.sha256}`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  process.exit(0);
}

if (process.argv.includes('--verify')) {
  const base = arg('--verify') || hoonPin().url;
  if (!base) { console.log('build-scad: no release address set (app.hoon +scad-url), nothing to verify'); process.exit(0); }
  let bad = 0;
  for (const f of PIN.files) {
    const b = await get(base + f.file);
    const ok = sha(b) === f.sha256 && b.length === f.size;
    console.log((ok ? '  ok   - ' : '  FAIL - ') + base + f.file);
    if (!ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}

//  ── scad.js ──
export const BUDGET = { raw: 60 * 1024, gzip: 20 * 1024 };
const OUT = join(root, 'code', 'nex', 'lattice', 'ui-app', 'scad.js');
const r = await build({
  entryPoints: [join(root, 'ui-src', 'scad', 'index.js')],
  absWorkingDir: root,
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  //  ASCII, so the bundle reads the same whatever charset it is served or
  //  loaded with
  charset: 'ascii',
  //  ui-src/scad/blank.scad, the new-page template, inlined as a string
  loader: { '.scad': 'text' },
  metafile: true,
  write: false,
  logLevel: 'warning',
});
const pulled = Object.keys(r.metafile.inputs).filter((p) => /node_modules/.test(p));
if (pulled.length) die('scad.js must bundle no package, but pulled in ' + pulled.join(', '));
const js = '/* BUILT FILE, do not edit. Source: ui-src/scad/, build: scripts/build-scad.mjs */\n' + r.outputFiles[0].text;
writeFileSync(OUT, js);
const raw = Buffer.byteLength(js), gz = gzipSync(js, { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
if (!process.argv.includes('--quiet')) console.log(`built scad.js: ${kb(raw)} raw, ${kb(gz)} gzipped (budget ${kb(BUDGET.raw)} / ${kb(BUDGET.gzip)})`);
if (raw > BUDGET.raw || gz > BUDGET.gzip) die(`scad.js is over budget: ${kb(raw)} raw, ${kb(gz)} gzipped`);
