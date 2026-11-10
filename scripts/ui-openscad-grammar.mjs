#!/usr/bin/env node
// Unit tests for the OpenSCAD grammar appended to prism.js, as
// ui-latex-grammar.mjs tests the LaTeX one. These assert on token classes.
//
// Usage: node scripts/ui-openscad-grammar.mjs
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { makeCheck } from './lib/check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PRISM = join(here, '..', 'code', 'nex', 'lattice', 'prism.js');

globalThis.window = globalThis;
globalThis.WorkerGlobalScope = undefined;
// eslint-disable-next-line no-eval
(0, eval)(readFileSync(PRISM, 'utf8'));
const { Prism } = globalThis;

const check = makeCheck();
check('prism defines the openscad grammar', !!Prism.languages.openscad);
check('scad is an alias of openscad', Prism.languages.scad === Prism.languages.openscad);

const src = [
  '// width of the box, in mm',
  'width = 30; // [10:100]',
  'include <lib/screws.scad>',
  'label = "a // not a comment";',
  '/* [Hidden] */',
  '$fn = 64;',
  'module box(w) { cube([w, 2.5e1, .5]); }',
  'if (true) box(width);',
].join('\n');
const html = Prism.highlight(src, Prism.languages.openscad, 'openscad');
check('a line comment is a comment', /class="token comment">\/\/ width of the box/.test(html));
check('a customizer comment is a comment', /class="token comment">\/\/ \[10:100\]/.test(html));
check('a block comment is a comment', /class="token comment">\/\* \[Hidden\] \*\//.test(html));
check('// in a string is not a comment', /class="token string">"a \/\/ not a comment"/.test(html));
check('include is a keyword', /class="token keyword">include</.test(html));
check('  and its path one token', /class="token url">&lt;lib\/screws\.scad></.test(html));
check('module is a keyword', /class="token keyword">module</.test(html));
check('cube is a builtin', /class="token builtin">cube</.test(html));
check('$fn is a special variable', /class="token variable">\$fn</.test(html));
check('2.5e1 is a number', /class="token number">2\.5e1</.test(html));
check('.5 is a number', /class="token number">\.5</.test(html));
check('true is a boolean', /class="token boolean">true</.test(html));
check('box( is a function call', /class="token function">box</.test(html));

const t0 = Date.now();
Prism.highlight('"'.repeat(20000) + '/*'.repeat(20000) + '<'.repeat(20000), Prism.languages.openscad, 'openscad');
check('unterminated strings, comments and includes stay fast', Date.now() - t0 < 1500, `${Date.now() - t0} ms`);

check.done();
