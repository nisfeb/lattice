#!/usr/bin/env node
//  app-js-size.mjs: a ratchet on the editor bundle's size.
//
//  app.js is the one script every cold boot of the editor loads, so it
//  should only grow on purpose. scripts/app-js-size.json holds the size it
//  was last agreed at ("bytes"), the slack any change may spend without
//  saying so ("grow"), and why the size is what it is ("why"). This fails
//  once app.js passes bytes + grow. To go past it, move the code into a
//  lazily loaded file (writer.js and settings.js are the pattern), or raise
//  "bytes" in the same change and say why in "why". A release that shrinks
//  app.js may lower "bytes" too, which tightens the ratchet.
//
//  It replaced the Writer phase's own constant in ui-writer.mjs (release
//  107 plus 8 KB), which was only ever meant to keep the Writer editor out
//  of the main bundle and which main had outgrown by release 109.
//
//  usage: node scripts/app-js-size.mjs [path/to/app.js]
import { readFileSync, statSync } from 'fs';

const ROOT = new URL('..', import.meta.url).pathname;
export const LIMIT = JSON.parse(readFileSync(ROOT + 'scripts/app-js-size.json', 'utf8'));
export const MAX = LIMIT.bytes + LIMIT.grow;

if (import.meta.url === 'file://' + process.argv[1]) {
  const f = process.argv[2] || ROOT + 'code/nex/lattice/ui-app/app.js';
  const n = statSync(f).size;
  const left = MAX - n;
  if (left < 0) {
    console.error(`app.js is ${n} bytes, ${-left} over its ratchet (${LIMIT.bytes} + ${LIMIT.grow}).`
      + '\nMove the new code into a lazily loaded file, or raise "bytes" in'
      + ' scripts/app-js-size.json and say why in "why".');
    process.exit(1);
  }
  console.log(`app.js is ${n} bytes, ${left} under its ratchet (${LIMIT.bytes} + ${LIMIT.grow})`);
}
