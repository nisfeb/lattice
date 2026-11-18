// a stand-in for the openscad command, for tests: the wasm build run under node.
// Put it in a folder with the runtime the ship installs, as openscad-glue.mjs and
// openscad.wasm, and a two-line `openscad` script that runs it with node. Then
// LATTICE_OPENSCAD=<that script> points the client and its tests at it.
// The files beside the main file's root are copied in, and the output copied out.
import fs from 'fs';
import path from 'path';
import OpenSCAD from './openscad-glue.mjs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.error('OpenSCAD version 2021.01 (wasm stand-in)'); process.exit(0); }
const main = args[0];
const oi = args.indexOf('-o');
const out = args[oi + 1];
// the tree the main file sits in: its top is the folder holding "w"
const top = main.slice(0, main.indexOf('/w/'));
const here = path.dirname(new URL(import.meta.url).pathname);
const inst = await OpenSCAD({ wasmBinary: fs.readFileSync(path.join(here, 'openscad.wasm')), noInitialRun: true, print: (s) => console.log(s), printErr: (s) => console.error(s) });
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { try { inst.FS.mkdir(p); } catch {} walk(p); } else inst.FS.writeFile(p, fs.readFileSync(p)); } };
let d = '';
for (const s of top.split('/').filter(Boolean)) { d += '/' + s; try { inst.FS.mkdir(d); } catch {} }
walk(top);
let rc = 0;
try { rc = inst.callMain(args); } catch (x) { rc = typeof x === 'number' ? x : (x && typeof x.status === 'number' ? x.status : 1); }
try { fs.writeFileSync(out, inst.FS.readFile(out)); } catch {}
process.exit(rc);
