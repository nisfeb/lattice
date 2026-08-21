#!/usr/bin/env node
// Unit tests for the LaTeX grammar appended to prism.js.
//
// The grammar is hand-written (like hoon and gemtext beside it), so it needs
// its own check. Order matters in a Prism grammar, earliest match wins, and
// the failure mode is silent: a wrong rule does not throw, it just paints the
// document the wrong colour. These assert on token classes in the output.
//
// Usage: node scripts/ui-latex-grammar.mjs
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const PRISM = join(here, '..', 'grubbery-overlay', 'nex', 'lattice', 'prism.js');

globalThis.window = globalThis;
globalThis.WorkerGlobalScope = undefined;
// eslint-disable-next-line no-eval
(0, eval)(readFileSync(PRISM, 'utf8'));
const { Prism } = globalThis;

let fails = 0;
const check = (name, cond, extra) => {
  console.log((cond ? '  ok   - ' : '  FAIL - ') + name + (cond ? '' : '  ' + (extra || '')));
  if (!cond) fails++;
};

check('prism defines the latex grammar', !!Prism.languages.latex);
check('tex is an alias of latex', Prism.languages.tex === Prism.languages.latex);

const src = [
  '% a comment',
  '\\documentclass{article}',
  '\\usepackage{amsmath}',
  '\\section{Heading}',
  'Text with 100\\% escaped and $e^{i\\pi}+1=0$ inline.',
  '\\begin{equation}',
  'a = b',
  '\\end{equation}',
  '\\href{https://example.com}{link}',
].join('\n');
const html = Prism.highlight(src, Prism.languages.latex, 'latex');

check('a comment is a comment', /class="token comment">% a comment/.test(html));
//  the one that a naive /%.*/ gets wrong, and the one that matters: a percent
//  sign is a real character in a document about percentages
check('an escaped percent is NOT a comment',
  !/class="token comment">%\s*escaped/.test(html) && html.includes('escaped'));
check('the document class is a keyword', /class="token keyword">article</.test(html));
check('the package name is a keyword', /class="token keyword">amsmath</.test(html));
check('a section title is a headline', /class="token headline[^"]*">Heading</.test(html));
check('inline math is one token', /class="token equation[^"]*">\$e\^/.test(html));
check('a display environment is math', /class="token equation[^"]*">[\s\S]*?a = b/.test(html));
check('a url is a url', /class="token url">https:\/\/example\.com</.test(html));

//  a document of plain prose must survive untouched, no stray tokens
const prose = Prism.highlight('Just words, no commands.', Prism.languages.latex, 'latex');
check('plain prose is left alone', !/class="token/.test(prose), prose);

console.log(fails ? '\n' + fails + ' FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
