#!/usr/bin/env node
// Unit tests for the local preview renderer (ui-app/src/59-md.js).
//
// This renderer exists for speed, not authority. The ship's render-md defines
// what a page IS, and its answer replaces this one a moment later. So the bar
// here is not "matches the server" but:
//
//   1. SAFE. The preview iframe is not sandboxed, so its srcdoc runs on the
//      app's own origin, and pages are not all hand-written (the clipper
//      archives arbitrary web pages). Nothing in a document may become live
//      markup or a live scheme. Most of these tests are about that.
//   2. Close enough that the correction, when it lands, is not a visible jump.
//
// Usage:  node scripts/ui-md.mjs

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, '../grubbery-overlay/nex/lattice/ui-app/src/59-md.js'), 'utf8');
const mdToHtml = new Function(`${src}\nreturn mdToHtml;`)();

let fails = 0;
const ok = (n) => console.log('  ok   - ' + n);
const bad = (n, got, want) => {
  console.log(`  FAIL - ${n}\n         want ${JSON.stringify(want)}\n         got  ${JSON.stringify(got)}`);
  fails++;
};
const has = (name, input, needle) => {
  const got = mdToHtml(input);
  got.includes(needle) ? ok(name) : bad(name, got, 'containing ' + needle);
};
const hasnt = (name, input, needle) => {
  const got = mdToHtml(input);
  !got.includes(needle) ? ok(name) : bad(name, got, 'NOT containing ' + needle);
};

console.log('safety: a document is text, never markup');
// The clipper stores arbitrary web pages as pages. One of them containing a
// script tag must render as the TEXT of a script tag, on an origin that can
// read this session.
hasnt('a script tag does not survive as markup', '<script>alert(1)</script>', '<script>');
has('it renders as text instead', '<script>alert(1)</script>', '&lt;script&gt;');
// what matters is that it is not an ELEMENT. The characters "onerror=" may
// appear inside escaped text; inert text cannot fire a handler.
hasnt('an img onerror does not become an element', '<img src=x onerror=alert(1)>', '<img');
has('it is escaped text instead', '<img src=x onerror=alert(1)>', '&lt;img');
hasnt('a javascript: link is not linked', '[click](javascript:alert(1))', 'href="javascript:');
hasnt('a data: link is not linked', '[x](data:text/html,<script>alert(1)</script>)', 'href="data:');
has('but an http link is', '[x](https://example.com)', 'href="https://example.com"');
has('and an in-page anchor is', '[x](#foot)', 'href="#foot"');
hasnt('a javascript: image is not sourced', '![a](javascript:alert(1))', 'src="javascript:');
hasnt('quotes in a url cannot break out of the attribute',
  '[x](https://e.com/"onmouseover="alert(1))', 'onmouseover="alert');

console.log('\nblocks');
has('a heading', '# Title', '<h1>Title</h1>');
has('a deeper heading', '### Three', '<h3>Three</h3>');
has('a paragraph', 'just words', '<p>just words</p>');
has('a rule', '---', '<hr>');
has('a fence keeps its contents literal', '```\n<b>x</b>\n```', '<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
has('a quote', '> quoted', '<blockquote>');
has('a bullet list', '- one\n- two', '<ul>');
has('an ordered list', '1. one\n2. two', '<ol>');
has('a task list renders a checkbox', '- [ ] todo', 'type="checkbox"');
has('a ticked task is checked', '- [x] done', 'checked');
has('a table', 'a | b\n--- | ---\n1 | 2', '<table>');

console.log('\ninline');
has('bold', 'a **b** c', '<strong>b</strong>');
has('italic with stars', 'a *b* c', '<em>b</em>');
has('strikethrough', 'a ~~b~~ c', '<del>b</del>');
has('code', 'a `b` c', '<code>b</code>');
// the target is URI-encoded on purpose, so a name carrying & or = cannot
// smuggle extra query params. URLSearchParams decodes %2F straight back.
has('a wikilink points into the app', '[[notes/todo]]', 'name=notes%2Ftodo');
// escaping runs over the whole line before URLs are captured out of it, so
// these two guard against the entities being applied a second time
has('a link keeps a single-escaped query', '[x](https://e.com/?a=1&b=2)',
  'href="https://e.com/?a=1&amp;b=2"');
hasnt('and is not double-escaped', '[x](https://e.com/?a=1&b=2)', '&amp;amp;');
has('a wikilink target with & encodes the raw character', '[[a&b]]', 'name=a%26b');
// the placeholder for code spans used to be spaces, so a document containing
// " 1 " came back out as a code span
has('a bare number is not mistaken for a code span', 'chapter 1 begins', 'chapter 1 begins');
hasnt('and really is not', 'chapter 1 begins', '<code>');
has('emphasis inside a heading', '## a **b**', '<strong>b</strong>');

console.log('\nthings that must not throw');
for (const [n, v] of [['empty', ''], ['null', null], ['undefined', undefined],
  ['only a fence', '```'], ['unclosed fence', '```\nx'], ['lone pipe', '|'],
  ['table marker only', '---|---'], ['deep nesting', '- a\n  - b\n    - c']]) {
  try { mdToHtml(v); ok('survives ' + n); } catch (e) { bad('survives ' + n, e.message, 'no throw'); }
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
