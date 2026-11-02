#!/usr/bin/env node
//  writer-licences.mjs: the licence gate for writer.js, lattice's one
//  client asset with third-party runtime code (ProseMirror).
//
//  Lattice is PolyForm Noncommercial. MIT, ISC and BSD code may be bundled
//  with its notices kept. LGPL cannot meet its relinking terms inside a
//  minified bundle, and GPL and AGPL are out (spec, Editor choice). So:
//
//    every package writer.js bundles, and every package those pull in,
//    declares a licence in ALLOWED in its package.json
//    each one is pinned exact in scripts/package.json and the lockfile
//    ui-src/writer/vendor/LICENSES names exactly those packages at the
//    installed versions (build-writer.mjs writes it; a stale one fails)
//    app.js never mentions prosemirror: ProseMirror lives in writer.js only
//
//  Pure, no ship. Needs npm ci --prefix scripts --ignore-scripts first.
//  Usage: node scripts/writer-licences.mjs
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { makeCheck } from './lib/check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const nm = join(here, 'node_modules');
const check = makeCheck();

const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause']);
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));

const pkg = json(join(here, 'package.json'));
const lock = json(join(here, 'package-lock.json'));
const dev = pkg.devDependencies || {};
//  the bundled packages: ProseMirror, and tiny-inflate (odt.js's inflate
//  for a browser with no DecompressionStream)
const RUNTIME = ['tiny-inflate'];
const roots = Object.keys(dev).filter((n) => n.startsWith('prosemirror-') || RUNTIME.includes(n));
check('scripts/package.json names the ProseMirror packages', roots.length >= 13, roots.join(' '));

//  the closure of runtime dependencies from the ProseMirror roots
const seen = new Map();
const queue = [...roots];
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  const pj = join(nm, name, 'package.json');
  if (!existsSync(pj)) { check.bad(`${name} is installed`, 'run npm ci --prefix scripts --ignore-scripts'); continue; }
  const p = json(pj);
  seen.set(name, p);
  queue.push(...Object.keys(p.dependencies || {}), ...Object.keys(p.peerDependencies || {}));
}

for (const [name, p] of [...seen].sort()) {
  const lic = typeof p.license === 'string' ? p.license : JSON.stringify(p.license || p.licenses);
  check(`${name}@${p.version} licence ${lic} is allowed`, ALLOWED.has(lic), 'allowed: ' + [...ALLOWED].join(' '));
  const locked = lock.packages?.['node_modules/' + name]?.version;
  check.eq(`${name} lockfile version matches the installed one`, locked, p.version);
  if (dev[name] !== undefined) check(`${name} is pinned exact`, dev[name] === p.version, `package.json says ${dev[name]}`);
}
check('esbuild is pinned exact', /^\d+\.\d+\.\d+$/.test(dev.esbuild || ''), `package.json says ${dev.esbuild}`);

//  vendor/LICENSES is the notice file the build writes from what it bundled
const lf = join(root, 'ui-src', 'writer', 'vendor', 'LICENSES');
const listed = existsSync(lf)
  ? [...readFileSync(lf, 'utf8').matchAll(/^((?:@[^@\s/]+\/)?[^@\s]+)@(\S+) \(([^)]+)\)$/gm)]
  : [];
check('vendor/LICENSES exists and lists packages', listed.length > 0);
for (const [, name, version, lic] of listed) {
  const p = seen.get(name);
  check(`vendor/LICENSES ${name}@${version} is a ProseMirror dependency at that version`,
    p && p.version === version, p ? `installed ${p.version}` : 'not in the closure');
  check(`vendor/LICENSES ${name} licence ${lic} is allowed`, ALLOWED.has(lic));
}
const names = new Set(listed.map((m) => m[1]));
for (const name of seen.keys()) check(`vendor/LICENSES carries ${name}'s notice`, names.has(name));

//  ProseMirror never reaches app.js
const app = readFileSync(join(root, 'code', 'nex', 'lattice', 'ui-app', 'app.js'), 'utf8');
check('app.js does not contain prosemirror', !/prosemirror/i.test(app));

check.done();
