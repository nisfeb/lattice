#!/usr/bin/env node
// Unit tests for the local preview renderer (ui-src/lattice/59-md.js).
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

import { makeCheck, read, cut } from './lib/check.mjs';

const mdToHtml = new Function(`${read('ui-src/lattice/59-md.js')}\nreturn mdToHtml;`)();
// the right pane's Outgoing and Outline (76-outline.js) read a document
// through this renderer, so they are lifted to run beside it
const { outLinks, outline } = new Function(read('ui-src/lattice/59-md.js') + '\n'
  + cut('ui-src/lattice/76-outline.js', /function outLinks\([\s\S]*?\n {2}\}/, 'outLinks') + '\n'
  + cut('ui-src/lattice/76-outline.js', /function outline\([\s\S]*?\n {2}\}/, 'outline')
  + '\nreturn { outLinks, outline };')();

const check = makeCheck();
const has = (name, input, needle) => {
  const got = mdToHtml(input);
  check(name, got.includes(needle), `want containing ${JSON.stringify(needle)} got ${JSON.stringify(got)}`);
};
const hasnt = (name, input, needle) => {
  const got = mdToHtml(input);
  check(name, !got.includes(needle), `want NOT containing ${JSON.stringify(needle)} got ${JSON.stringify(got)}`);
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

// Attribute names as a browser reads them: '/' and whitespace part them, a
// value is quoted or runs to the next space. Anything but these is a live
// attribute a document put there.
const attrNames = (html) => [...html.matchAll(/<[a-z]+([^>]*)>/gi)].flatMap(([, a]) =>
  [...a.matchAll(/[\s/]*([^\s/>=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?/g)].map((m) => m[1].toLowerCase()));
const tame = (name, input) => {
  const got = mdToHtml(input);
  const bad = attrNames(got).filter((n) => !['alt', 'src', 'href', 'type', 'checked', 'disabled', 'data-line', 'class'].includes(n));
  check(name, !bad.length, `stray attributes ${JSON.stringify(bad)} in ${JSON.stringify(got)}`);
};
// a link's text started inside the image's alt and took its quotes, so the
// second URL sat where attribute names go
tame('a link inside an image cannot set attributes',
  "![a[b](http://y) c](http://x/src/onerror=location='javascript:alert\\x28document.domain\\x29'//)");
tame('a wikilink inside a url cannot set attributes', '[t](http://x/[[a" onmouseover="b]])');
tame('emphasis inside a url stays out of the href', '[t](http://x/_a_/b) and ![i](http://x/*b*/c)');
has('a linked image still renders', '[![alt](https://e.com/i.png)](https://e.com)',
  '<a href="https://e.com"><img alt="alt" src="https://e.com/i.png"></a>');
has('emphasis in link text still renders', '[a **b**](https://e.com)', '<a href="https://e.com">a <strong>b</strong></a>');

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
  try { mdToHtml(v); check.ok('survives ' + n); } catch (e) { check.bad('survives ' + n, 'threw ' + e.message); }
}

console.log('\noutgoing links and outline (76-outline.js)');
const eqj = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
eqj('an empty body has no links', outLinks('', 'md'), []);
eqj('an empty body has no outline', outline('', 'md'), []);
eqj('an empty gemtext body has neither', [outLinks('', 'gmi'), outline('', 'gmi')], [[], []]);
eqj('wikilinks and links, deduped, in order',
  outLinks('[[a/b]] then [x](https://e.com/?q=1&r=2)\n\n- [[c|see c]] and [[a/b]]', 'md'),
  ['a/b', 'https://e.com/?q=1&r=2', 'c']);
eqj('an app link names its page', outLinks('[x](/apps/lattice/app?name=n%2Fm)', 'md'), ['n/m']);
eqj('images and unsafe schemes are not links',
  outLinks('![i](https://e.com/i.png) [j](javascript:alert(1))', 'md'), []);
eqj('links inside a fence are ignored', outLinks('```\n[[nope]]\n```\n[[yes]]', 'md'), ['yes']);
eqj('gemtext links', outLinks('=> urb://~zod/x one\n=> https://e.com two\n=> bad:x three', 'gmi'),
  ['urb://~zod/x', 'https://e.com']);
eqj('markdown headings with their lines', outline('# One\n## Two\ntext\n###### Six', 'md'),
  [{ level: 1, text: 'One', line: 1 }, { level: 2, text: 'Two', line: 2 },
    { level: 6, text: 'Six', line: 4 }]);
eqj('headings inside a fence are ignored', outline('```\n# not\n```\n~~~\n# nor\n~~~\n# yes', 'md'),
  [{ level: 1, text: 'yes', line: 7 }]);
eqj('#nospace is not a heading', outline('#tag\n####### seven', 'md'), []);
eqj('gemtext headings stop at three',
  outline('# a\n### c\n#### d\n```\n# fenced\n```\n## b', 'gmi'),
  [{ level: 1, text: 'a', line: 1 }, { level: 3, text: 'c', line: 2 },
    { level: 2, text: 'b', line: 7 }]);
eqj('other kinds have no outline', outline('# x', 'html'), []);

console.log('task boxes: a click flips the one marker on its own source line');
// mdToHtml(text, true) marks each live box with its source line, and
// taskToggle(text, line, on) is the edit a click on it makes. Together: click
// box k, apply the edit, and exactly that one character changes.
const taskToggle = new Function(`${read('ui-src/lattice/59-md.js')}\nreturn taskToggle;`)();
const boxes = (t) => [...mdToHtml(t, true).matchAll(/<input type="checkbox" data-line="(\d+)"( checked)?>/g)]
  .map((m) => ({ line: +m[1], on: !!m[2] }));
const click = (t, k) => {
  const b = boxes(t)[k];
  const r = b && taskToggle(t, b.line, !b.on);
  return r ? t.slice(0, r.at) + r.ch + t.slice(r.at + 1) : null;
};
const eqs = (name, got, want) => check(name, got === want, `want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
check('no live box without tasks', !mdToHtml('- [ ] a').includes('data-line')
  && mdToHtml('- [ ] a').includes('disabled'), mdToHtml('- [ ] a'));
check('a live box is not disabled', !mdToHtml('- [ ] a', true).includes('disabled'), mdToHtml('- [ ] a', true));
eqs('dash checks', click('- [ ] a', 0), '- [x] a');
eqs('x unchecks', click('* [x] a', 0), '* [ ] a');
eqs('capital X unchecks', click('+ [X] a', 0), '+ [ ] a');
eqs('ordered list', click('1. [ ] a\n2) [ ] b', 1), '1. [ ] a\n2) [x] b');
const fenced = '```\n- [ ] in code\n```\n- [ ] real\n~~~\n* [x] also code\n~~~\n- [ ] second';
eqj('fenced boxes are not boxes', boxes(fenced).map((b) => b.line), [3, 7]);
eqs('a box after a fence flips its own line', click(fenced, 1),
  '```\n- [ ] in code\n```\n- [ ] real\n~~~\n* [x] also code\n~~~\n- [x] second');
eqs('duplicates: the second one', click('- [ ] same\n- [ ] same', 1), '- [ ] same\n- [x] same');
eqs('duplicates: the first one', click('- [ ] same\n- [ ] same', 0), '- [x] same\n- [ ] same');
const nest = '- [ ] top\n  - [ ] mid\n    1. [x] deep\n\t- [ ] tab';
eqs('nested', click(nest, 2), '- [ ] top\n  - [ ] mid\n    1. [ ] deep\n\t- [ ] tab');
eqs('tab indent', click(nest, 3), '- [ ] top\n  - [ ] mid\n    1. [x] deep\n\t- [x] tab');
const quote = 'para\n- [ ] [x] text\n\n> - [ ] quoted\n> > * [X] deeper\n\n- [ ] after';
eqj('quote lines keep their page lines', boxes(quote).map((b) => b.line), [1, 3, 4, 6]);
eqs('in a blockquote', click(quote, 1), 'para\n- [ ] [x] text\n\n> - [x] quoted\n> > * [X] deeper\n\n- [ ] after');
eqs('in a nested blockquote', click(quote, 2), 'para\n- [ ] [x] text\n\n> - [ ] quoted\n> > * [ ] deeper\n\n- [ ] after');
eqs('only the marker, not later brackets', click(quote, 0), 'para\n- [x] [x] text\n\n> - [ ] quoted\n> > * [X] deeper\n\n- [ ] after');
eqs('CRLF', click('# t\r\n- [ ] a\r\n- [x] b\r\n', 1), '# t\r\n- [ ] a\r\n- [ ] b\r\n');
eqs('CRLF, an empty item', click('- [ ] \r\n- [ ] b', 0), '- [x] \r\n- [ ] b');
eqj('a table cell is no box', boxes('| a | b |\n|---|---|\n| [ ] | x |'), []);
eqj('a paragraph line is no box', boxes('text\n[ ] not a task'), []);
eqj('html is text, its box no box', boxes('<input type="checkbox" data-line="0">'), []);
eqj('a stale click changes nothing', taskToggle('- [x] a', 0, true), null);
eqj('a line that is no longer a task', taskToggle('plain\n- [ ] a', 0, true), null);
eqj('a line past the end', taskToggle('- [ ] a', 3, true), null);

check.done();
