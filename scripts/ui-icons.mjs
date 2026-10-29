#!/usr/bin/env node
// Unit tests for the icon set in ui-src/lattice/10-shell.js: every name the
// client draws exists, stroke icons render unfilled, and the chrome carries
// no emoji. 10-shell.js is lifted into a vm with a stub document.
//
// Usage:  node scripts/ui-icons.mjs
import vm from 'vm';
import { readdirSync } from 'fs';
import { makeCheck, read, cut } from './lib/check.mjs';

const L = 'ui-src/lattice/';
const check = makeCheck();
const src = cut(L + '10-shell.js', /const ICON = \{[\s\S]*?\n {2}const ico = [\s\S]*?\n {2}\};/, 'ICON/ico');
const { ICON, ico } = vm.runInNewContext(src + '\n({ ICON, ico })');

const files = readdirSync('ui-src/lattice').filter((f) => f.endsWith('.js')).sort();
const used = new Set();
for (const f of files)
  for (const m of read(L + f).matchAll(/ico\('([a-z]+)'\)/g)) used.add(m[1]);
const missing = [...used].filter((n) => !ICON[n]);
check('every ico() name used in ui-src exists in ICON', !missing.length, missing.join(' '));

const svg = ico('gear');
check('stroke icons render fill none', svg.includes('fill="none"') && svg.includes('stroke="currentColor"'), svg);
check('stroke icons use width 1.5', svg.includes('stroke-width="1.5"'));
check('fill icons are unchanged', ico('folder').includes('fill="currentColor"') && !ico('folder').includes('stroke'));

const want = 'pl pr cal globe forum inbox key tree conflict term gear pen fplus tpl upload sort fold out back list hist eye x left right dots menu plus pin mark know save'.split(' ');
const lack = want.filter((n) => !ICON[n] || ICON[n][2] !== 'stroke');
check('every shell icon is a stroke icon', !lack.length, lack.join(' '));

// scope: the chrome files this plan owns; legacy files may carry emoji
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const bad = files.filter((f) => /^1\d-/.test(f) && /\p{Extended_Pictographic}/u.test(noComments(read(L + f))));
check('no emoji in chrome', !bad.length, bad.join(' '));

check.done();
