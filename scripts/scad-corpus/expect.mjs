#!/usr/bin/env node
//  expect.mjs: what OpenSCAD itself reads as customizer parameters, for
//  each fixture in tests/scad/customizer. scad-unit.mjs checks lattice's JS
//  parser against these files.
//
//  It runs the pinned runtime in node, so it needs the two raw files:
//    node scripts/build-scad.mjs --release DIR    (then gunzip the wasm)
//    node scripts/scad-corpus/expect.mjs DIR
//  where DIR holds openscad.js and openscad.wasm. It writes NAME.json
//  beside each NAME.scad: OpenSCAD's --export-format param output.
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const dir = process.argv[2];
if (!dir) { console.error('usage: expect.mjs DIR'); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, '..', '..', 'tests', 'scad', 'customizer');
const OpenSCAD = (await import(join(dir, 'openscad.js'))).default;
const wasmBinary = readFileSync(join(dir, 'openscad.wasm'));
for (const f of readdirSync(fx).filter((n) => n.endsWith('.scad')).sort()) {
  const m = await OpenSCAD({ noInitialRun: true, wasmBinary, print: () => {}, printErr: () => {} });
  m.FS.writeFile('/in.scad', readFileSync(join(fx, f), 'utf8'));
  const rc = m.callMain(['/in.scad', '-o', '/out.param', '--export-format', 'param']);
  if (rc !== 0) { console.error(f + ': OpenSCAD answered ' + rc); process.exit(1); }
  const j = JSON.parse(m.FS.readFile('/out.param', { encoding: 'utf8' }));
  delete j.title;
  writeFileSync(join(fx, f.replace(/\.scad$/, '.json')), JSON.stringify(j, null, 1) + '\n');
  console.log(f + ': ' + j.parameters.length + ' parameters');
}
