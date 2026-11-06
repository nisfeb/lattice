#!/usr/bin/env node
//  ui-app-comments.mjs: the served app.js leaves out the sources' whole-line
//  comments (build-ui.mjs). This proves that is all it leaves out: app.js
//  and the same files with every comment in minify (esbuild, whitespace
//  and comments only) to the very same program. A line that looked like a
//  comment but sat in a template literal would differ here.
//
//  usage: node scripts/ui-app-comments.mjs
import { readFileSync, readdirSync } from 'fs';
import { transformSync } from 'esbuild';
import { makeCheck } from './lib/check.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const L = ROOT + 'ui-src/lattice/';
const app = readFileSync(ROOT + 'code/nex/lattice/ui-app/app.js', 'utf8');
const head = app.slice(0, app.indexOf('// ── src/'));
const full = head + readdirSync(L).filter((f) => f.endsWith('.js')).sort()
  .map((f) => readFileSync(L + f, 'utf8').trimEnd() + '\n').join('\n') + '})();\n';
const min = (s) => transformSync(s, { minifyWhitespace: true, target: 'es2022' }).code;
const check = makeCheck();
check('app.js is its sources less comments', min(app) === min(full));
check('and is smaller for it', app.length < full.length - 200000, app.length + ' vs ' + full.length);
check.done();
