#!/usr/bin/env node
//  desktop-commands.mjs — a Tauri command is registered in THREE places.
//
//  Miss one and the command is denied at runtime with "not allowed. Command
//  not found", which reads like anything except what it is. This has now cost
//  three separate debugging sessions in this repo:
//
//    save_vault / pick_vault   vault export and restore could never have run
//    the seven queue_* ones    the desktop offline queue had never once worked
//    pandoc_probe/convert_tex  told people with pandoc installed they had none
//
//  Nothing caught any of them, because the browser suites stub or skip the
//  bridge and never invoke for real. So this checks the three lists agree:
//
//    1. src/main.rs      generate_handler![..]   the command exists
//    2. build.rs         AppManifest::commands   it may be permitted at all
//    3. capabilities/*   allow-<kebab-case>      someone may actually call it
//
//  Rule 2 is unforgiving in a way worth restating: opting ANY command into the
//  manifest gates them ALL, so an unlisted command is denied everywhere.
//
//  Usage: node scripts/desktop-commands.mjs
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const D = join(here, '..', 'desktop');

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ok   - ' : '  FAIL - ') + name + (ok ? '' : '\n         ' + (extra || '')));
  if (!ok) fails++;
};
const kebab = (s) => s.replace(/_/g, '-');

//  1. what the app actually exposes
const main = readFileSync(join(D, 'src', 'main.rs'), 'utf8');
const handler = main.match(/generate_handler!\s*\[([\s\S]*?)\]/);
if (!handler) {
  console.log('  FAIL - could not find generate_handler! in src/main.rs');
  process.exit(1);
}
const handled = [...handler[1].matchAll(/(?:^|\s)(?:[a-z_]+::)?([a-z][a-z0-9_]*)\s*,/g)]
  .map((m) => m[1]);

//  2. what the manifest permits to exist
const build = readFileSync(join(D, 'build.rs'), 'utf8');
const manifest = build.match(/\.commands\(&\[([\s\S]*?)\]\)/);
if (!manifest) {
  console.log('  FAIL - could not find AppManifest commands in build.rs');
  process.exit(1);
}
const declared = [...manifest[1].matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);

//  3. what any window is allowed to call
const capDir = join(D, 'capabilities');
const granted = new Set();
for (const f of readdirSync(capDir).filter((n) => n.endsWith('.json'))) {
  for (const p of JSON.parse(readFileSync(join(capDir, f), 'utf8')).permissions || []) {
    if (typeof p === 'string' && p.startsWith('allow-')) granted.add(p.slice(6));
  }
}

console.log('handler: %d   manifest: %d   granted: %d\n',
  handled.length, declared.length, granted.size);

//  every exposed command must be in the manifest, or it is denied everywhere
const missingFromManifest = handled.filter((c) => !declared.includes(c));
check('every handled command is in build.rs', missingFromManifest.length === 0,
  'denied everywhere until added to build.rs: ' + JSON.stringify(missingFromManifest));

//  ...and reachable by at least one window, or nothing can call it
const missingGrant = handled.filter((c) => !granted.has(kebab(c)));
check('every handled command is granted to some window', missingGrant.length === 0,
  'no capability grants these: ' + JSON.stringify(missingGrant));

//  the reverse direction is a typo detector: a grant or a manifest entry for a
//  command that does not exist is dead config, and hides a rename
const ghostManifest = declared.filter((c) => !handled.includes(c));
check('build.rs names no command the handler lacks', ghostManifest.length === 0,
  'in build.rs but not handled: ' + JSON.stringify(ghostManifest));

const handledKebab = new Set(handled.map(kebab));
const ghostGrants = [...granted].filter((g) => !handledKebab.has(g));
check('capabilities grant no command the handler lacks', ghostGrants.length === 0,
  'granted but not handled: ' + JSON.stringify(ghostGrants));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
