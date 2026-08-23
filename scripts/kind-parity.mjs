#!/usr/bin/env node
//  kind-parity.mjs: the page-kind <-> extension table exists in three
//  places that cannot see each other, and it has already drifted apart
//  three separate times, each one a shipped data-loss bug:
//
//    KMAP (vault.js) missing tex        every .tex page vanished, silently,
//                                        on an export/restore round trip
//    projection.rs missing tex          a .tex page mounted as .hoon, and a
//                                        save fed LaTeX to the hoon compiler
//    core.rs's is_scratch missing tex   a real .tex node opened against an
//                                        empty scratch map; a save through
//                                        the mount was accepted and never
//                                        reached the ship
//
//  The third one is why is_scratch no longer hand-copies its own extension
//  list: it now asks projection.rs's kind_for_ext directly. That still
//  leaves three independent COPIES of the table itself: EXT_KIND in
//  30-tree.js, KMAP in vault.js (served alone to Settings, no bundle
//  around it, so it cannot read the bundle's copy), and kind_for_ext's
//  match arms in projection.rs, in a different language across the process
//  line. This checks the three agree, so the next kind added anywhere has
//  to land in all three or fail here first.
//
//  EXT_KIND is the reference. projection.rs backs a mounted filesystem, not
//  a browser file picker, so it is not required to be a perfect mirror.
//  See ACCEPTED_EXCEPTIONS below for the named, deliberate divergences.
//
//  Usage: node scripts/kind-parity.mjs
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ok   - ' : '  FAIL - ') + name + (ok ? '' : '\n         ' + (extra || '')));
  if (!ok) fails++;
};

//  pull a `const NAME = { ext: 'kind', ... };` object literal's entries out
//  of a JS source file, by name
function jsExtKindTable(src, constName) {
  const m = src.match(new RegExp(`const ${constName} = \\{([\\s\\S]*?)\\};`));
  if (!m) return null;
  const out = {};
  for (const [, ext, kind] of m[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) out[ext] = kind;
  return out;
}

const treePath = join(root, 'grubbery-overlay/nex/lattice/ui-app/src/30-tree.js');
const vaultPath = join(root, 'grubbery-overlay/nex/lattice/ui-app/vault.js');
const projPath = join(root, 'lattice-fs-rs/src/projection.rs');

const extKind = jsExtKindTable(readFileSync(treePath, 'utf8'), 'EXT_KIND');
if (!extKind) {
  console.log('  FAIL - could not find EXT_KIND in 30-tree.js');
  process.exit(1);
}

const kmap = jsExtKindTable(readFileSync(vaultPath, 'utf8'), 'KMAP');
if (!kmap) {
  console.log('  FAIL - could not find KMAP in vault.js');
  process.exit(1);
}

//  kind_for_ext's explicit match arms, between "match ext {" and the
//  ".to_string()" chained onto its closing brace. The wildcard arm
//  (`_ => "hoon"`) is deliberately not captured here: see hoon in
//  ACCEPTED_EXCEPTIONS below.
const rs = readFileSync(projPath, 'utf8');
const fn = rs.match(
  /fn kind_for_ext\(&self, ext: &str\) -> String \{\s*match ext \{([\s\S]*?)\}\s*\.to_string\(\)/
);
if (!fn) {
  console.log('  FAIL - could not find kind_for_ext in projection.rs');
  process.exit(1);
}
const kindForExt = {};
for (const [, ext, kind] of fn[1].matchAll(/"(\w+)"\s*=>\s*"(\w+)"/g)) kindForExt[ext] = kind;

console.log(
  'EXT_KIND: %d   KMAP: %d   kind_for_ext: %d\n',
  Object.keys(extKind).length,
  Object.keys(kmap).length,
  Object.keys(kindForExt).length
);

//  KMAP and EXT_KIND are twins in the same language, duplicated only
//  because vault.js is served alone to Settings with no bundle around it.
//  Nothing excuses a difference between these two.
const kmapKeys = new Set([...Object.keys(extKind), ...Object.keys(kmap)]);
const kmapDrift = [...kmapKeys].filter((e) => kmap[e] !== extKind[e]);
check(
  'KMAP (vault.js) matches EXT_KIND (30-tree.js)',
  kmapDrift.length === 0,
  'drifted: ' + JSON.stringify(kmapDrift.map((e) => `${e}: EXT_KIND=${extKind[e]} KMAP=${kmap[e]}`))
);

//  projection.rs backs a mounted filesystem, not a browser file picker, so
//  it does not have to carry every browser-only inbound alias. Each entry
//  here is a real, named, deliberate divergence: an unexplained one is
//  exactly how the is_scratch bug started.
const ACCEPTED_EXCEPTIONS = {
  htm: 'browser-only inbound alias for html; the mount never writes a .htm file',
  text: "legacy inbound-only alias predating the .txt convention, read by vault.js's own restore, never written by the mount",
  hoon: 'kind_for_ext has no literal "hoon" arm because hoon IS the match\'s own wildcard fallback (every unclaimed extension already becomes hoon). Correct, just invisible to a regex over literal arms',
};

const projDrift = Object.keys(extKind)
  .filter((e) => !(e in ACCEPTED_EXCEPTIONS))
  .filter((e) => kindForExt[e] !== extKind[e]);
check(
  'projection.rs kind_for_ext matches EXT_KIND (accepted exceptions aside)',
  projDrift.length === 0,
  'drifted: ' +
    JSON.stringify(projDrift.map((e) => `${e}: EXT_KIND=${extKind[e]} kind_for_ext=${kindForExt[e]}`))
);

//  the reverse direction is a typo detector: an extension projection.rs
//  answers for that the browser has never heard of is also a drift, just
//  the other way round, and an accepted exception can't excuse it. An
//  exception says projection may KNOW LESS than EXT_KIND, never more.
const projOrphans = Object.keys(kindForExt).filter((e) => !(e in extKind));
check(
  'projection.rs kind_for_ext names no extension EXT_KIND lacks',
  projOrphans.length === 0,
  'in kind_for_ext but not EXT_KIND: ' + JSON.stringify(projOrphans)
);

console.log(fails ? '\n' + fails + ' FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
