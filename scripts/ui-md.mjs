#!/usr/bin/env node
// Unit tests for the local preview renderer (ui-src/lattice/59-md.js).
//
// This renderer exists for speed, not authority. The ship's render-md defines
// what a page IS, and its answer replaces this one a moment later. So the bar
// here is not "matches the server" but:
//
//   1. SAFE. The preview frame is sandboxed, but this render also feeds the
//      outline, the PDF export and the Skills pane, and a sandbox is a
//      second wall, not the first. Pages are not all hand-written (the
//      clipper archives arbitrary web pages). Nothing in a document may
//      become live markup or a live scheme. Most of these tests are about that.
//   2. Close enough that the correction, when it lands, is not a visible jump.
//
// Usage:  node scripts/ui-md.mjs

import { makeCheck, read, cut } from './lib/check.mjs';

// A wikilink to a page not written yet is marked only while the live
// preview sets its test (mdGhosts, made by ghostTest in 60-preview.js from
// the page tree, the memory list and the name rules). Those are lifted
// with it. Nothing is marked until a test sets a tree and the preview's
// test, which is how the PDF and the Skills pane render: unset.
const MD = `let nodes = [], grubPath = null, current = null, treeGen = 0;
let location = { origin: 'https://ship.example' };
let knowKeys = [{ key: '/a-memory' }];
const linkOf = () => null;
${cut('ui-src/lattice/10-shell.js', /const validName = [\s\S]*?\);\n/, 'validName')}
${cut('ui-src/lattice/60-preview.js', /let gtKey = [\s\S]*?\n {2}\};\n/, 'ghostTest')}
${read('ui-src/lattice/59-md.js')}`;
//  preview: true is the live preview's paint, false any other render
const SET = 'setTree: (v, preview = true) => { nodes = v; mdGhosts = preview ? ghostTest() : null; }';
const { mdToHtml, setOutside, setTree } = new Function(`${MD}
return { mdToHtml, setOutside: (v) => { mdOutside = v; }, ${SET} };`)();
// the right pane's Outgoing and Outline (76-outline.js) read a document
// through this renderer, so they are lifted to run beside it
//  (isRich is 26-writer.js's: no page here is a Writer document or a
//  spreadsheet)
const { outLinks, outline, setOutTree } = new Function('const isRich = () => false;\n' + MD + '\n'
  + cut('ui-src/lattice/76-outline.js', /function outLinks\([\s\S]*?\n {2}\}/, 'outLinks') + '\n'
  + cut('ui-src/lattice/76-outline.js', /function outline\([\s\S]*?\n {2}\}/, 'outline')
  + '\nreturn { outLinks, outline, setOutTree: ' + SET.slice(9) + ' };')();

const check = makeCheck();
const require59gmi = new Function(`${MD}\nreturn gmiToHtml;`)();
const eqj = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
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
  const bad = attrNames(got).filter((n) => !['alt', 'src', 'href', 'type', 'checked', 'disabled', 'data-line', 'data-h', 'class'].includes(n));
  check(name, !bad.length, `stray attributes ${JSON.stringify(bad)} in ${JSON.stringify(got)}`);
};
// a link's text started inside the image's alt and took its quotes, so the
// second URL sat where attribute names go
tame('a link inside an image cannot set attributes',
  "![a[b](http://y) c](http://x/src/onerror=location='javascript:alert\\x28document.domain\\x29'//)");
tame('a wikilink inside a url cannot set attributes', '[t](http://x/[[a" onmouseover="b]])');
tame('emphasis inside a url stays out of the href', '[t](http://x/_a_/b) and ![i](http://x/*b*/c)');
// an image from another host learns the reader's IP address: drawn only on
// a page whose outside content was let load (mdOutside), else a placeholder
hasnt('an outside image is not drawn by default', '![a](https://e.com/i.png)', '<img');
hasnt('nor one from a //host address', '![a](//e.com/i.png)', '<img');
has('it is a placeholder instead', '![a](https://e.com/i.png)', '[image from another site: a]');
has('an image of the ship\'s own still renders', '![a](/apps/lattice/f/x.png)', '<img alt="a" src="/apps/lattice/f/x.png">');
setOutside(true);
has('a linked image still renders, outside content let load', '[![alt](https://e.com/i.png)](https://e.com)',
  '<a href="https://e.com"><img alt="alt" src="https://e.com/i.png"></a>');
setOutside(false);
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

console.log('\na wikilink to a page not written yet (mdGhosts)');
setTree([]);
hasnt('with no tree loaded nothing is marked', '[[nope/x]]', 'ghost');
const TREE = [{ path: 'here', page: true }, { path: 'dir', page: false }, { path: 'dir/in', page: true }];
setTree(TREE, false);
for (const w of ['ghost', 'does not exist yet'])
  hasnt('outside the live preview (the PDF, Skills) no ' + w, '[[nope/x]] [[nope/y|y]]', w);
setTree(TREE);
has('a missing page is marked after its href, with a title',
  '[[nope/x]]', '<a href="/apps/lattice/app?name=nope%2Fx" class="ghost" title="nope/x does not exist yet">x</a>');
has('so is a labelled one', '[[nope/x|see]]', 'class="ghost" title="nope/x does not exist yet">see</a>');
has('a padded target is the name it opens', '[[ nope/x ]]', 'title="nope/x does not exist yet"');
for (const [n, t] of [['a page', 'here'], ['a page in a folder', 'dir/in'], ['a folder', 'dir'],
  ['a folder with its slash', 'dir/'], ['a memory', 'a-memory'], ['an urb:// address', 'urb://~zod/x'],
  ['an absolute path', '/apps/lattice/forum'], ['a name the ship refuses', 'a&b c/\u00e9'],
  ['a capital', 'Nope'], ['a trailing slash', 'nope/']])
  hasnt(n + ' is not marked', '[[' + t + ']]', 'ghost');
setOutTree(TREE);
eqj('the outgoing reader still reads a marked link', outLinks('[[nope/x]] [[here]]', 'md'), ['nope/x', 'here']);
setOutTree([]);
setTree([]);

console.log('\nthings that must not throw');
for (const [n, v] of [['empty', ''], ['null', null], ['undefined', undefined],
  ['only a fence', '```'], ['unclosed fence', '```\nx'], ['lone pipe', '|'],
  ['table marker only', '---|---'], ['deep nesting', '- a\n  - b\n    - c']]) {
  try { mdToHtml(v); check.ok('survives ' + n); } catch (e) { check.bad('survives ' + n, 'threw ' + e.message); }
}

console.log('\ncost: a hostile paragraph is linear, not quadratic or cubic');
// The scans for a closing bracket or paren are capped (as the ship's
// +scan-cap and +link-scan-cap are), so four times the text costs about
// four times the work. A ratio, not a time: quadratic gives 16 and cubic
// 64 whatever the machine. The sizes are past the caps, where the cost
// per opener has stopped growing, and small enough that the renderer as
// it was fails this in a minute instead of hanging the suite.
const cost = (s) => {
  let best = Infinity;
  for (let k = 0; k < 3 && (!k || best < 200); k++) {
    const t0 = performance.now(); mdToHtml(s); best = Math.min(best, performance.now() - t0);
  }
  return Math.max(best, 0.5);
};
const N = 2000;
for (const [n, unit, tail] of [['[a]( runs', '[a](', ''], ['[ runs', '[', ''], ['[[ runs', '[[', ''],
  ['![ runs', '![', ''], ['![a]( runs', '![a](', ''], ['[[a| runs', '[[a|', ''],
  ['spaces after a link url', ' ', ''], ['a pipe run under a table row', '|', 'x']]) {
  const make = (len) => (unit === ' ' ? '[a](b' : unit === '|' ? '|\n' : '')
    + unit.repeat(Math.ceil(len / unit.length)) + tail;
  const r = cost(make(4 * N)) / cost(make(N));
  check('4x the text is under 9x the work: ' + n, r < 9, 'ratio ' + r.toFixed(1));
}
{
  let threw = null;
  try { mdToHtml('>'.repeat(3000) + ' deep'); mdToHtml('> '.repeat(3000) + 'deep'); } catch (e) { threw = e; }
  check('3000 quote marks on a line do not overflow the stack', !threw, String(threw));
  const d = mdToHtml('>'.repeat(40) + ' deep');
  check('quotes nest 32 deep and no deeper', d.split('<blockquote>').length - 1 === 32, d.slice(0, 80));
}
has('a link with a title still links', '[a](https://e.com "the title")', '<a href="https://e.com">a</a>');
has('a 500 character url still links', '[a](https://e.com/' + 'p'.repeat(482) + ')', '<a href="https://e.com/pppp');
has('an 800 character url (signed links) still links', '[a](https://e.com/?' + 'q=1&'.repeat(200) + ')', '<a href="https://e.com/?q=1&amp;q=1');
has('so does an image with one', '![a](https://e.com/?' + 'q=1&'.repeat(200) + ')', 'image from another site: a');
has('a bracket before the closing paren stays in the address', '[a](https://e.com/x])', 'href="https://e.com/x]"');
// the paren holds at most 4,096 characters of the source, a title and its
// quotes or the & of a query string counted as written (+link-scan-cap)
{
  const at = (n, mk) => { const g = mk(n); return '[a](' + g + ')'; };
  const url = (n) => 'https://e.com/' + 'p'.repeat(n - 14);
  const ttl = (n) => 'https://e.com/' + 'p'.repeat(n - 14 - 4) + ' "t"';
  const amp = (n) => 'https://e.com/?' + 'p'.repeat(n - 15 - 4 * 100) + 'q=1&'.repeat(100);
  for (const [nm, mk] of [['plain', url], ['titled', ttl], ['with & in it', amp]]) {
    has('a ' + nm + ' paren of 4,096 characters links', at(4096, mk), '<a href="https://e.com/');
    hasnt('a ' + nm + ' paren of 4,097 characters does not', at(4097, mk), '<a ');
  }
}
hasnt('a paren 5000 characters on is no link', '[a](https://e.com/' + 'p'.repeat(5000) + ')', '<a ');
{
  const f = '```\n' + '>'.repeat(40) + '\n' + '> '.repeat(35) + 'x\n```';
  has('a fence keeps a line of 40 quote marks', f, '<code>' + '&gt;'.repeat(40) + '\n');
  has('and a spaced one with its blanks', f, '&gt; '.repeat(35) + 'x</code>');
  hasnt('and no quote is opened', f, '<blockquote>');
  const q = mdToHtml('>'.repeat(40) + ' deep');
  check('a line of 40 marks outside a fence is still held to 32', q.split('<blockquote>').length - 1 === 32, q.slice(0, 60));
}
has('2000 characters of link text still link', '[' + 't'.repeat(2000) + '](https://e.com)', '<a href="https://e.com">tttt');
hasnt('link text past the scan cap is no link', '[' + 't'.repeat(2100) + '](https://e.com)', '<a ');
has('a table still renders', '| a | b |\n|---|:-:|\n| 1 | 2 |', '<table><thead><tr><th>a</th><th>b</th>');
has('a table with no outer pipes still renders', 'a | b\n--- | ---\n1 | 2', '<td>1</td><td>2</td>');
has('a bare pipe pair is a delimiter row, as before', 'a|b\n||\n1|2', '<table>');
hasnt('a rule under a pipe line is no table', 'a|b\n---', '<table>');
hasnt('one leading pipe is no delimiter row', 'a|b\n|', '<table>');

console.log('\nan image or link whose path the browser reads as another host');
// The browser reads a backslash in a path as a slash, so /\host/p.png
// is //host/p.png: another site, which no outside-content consent covers.
for (const u of ['/\\evil.example/p.png', '\\\\evil.example/p.png', '\\/evil.example/p.png', '/\\\\evil.example/p.png', '//evil.example/p.png']) {
  hasnt('no <img> for ' + u, '![x](' + u + ')', '<img');
  hasnt('no link for ' + u.replace('//', '/\\'), '[x](' + u.replace('//', '/\\') + ')', '<a ');
  setOutside(true);
  hasnt('none with outside content allowed either: ' + u.replace('//', '/\\'), '![x](' + u.replace('//', '/\\') + ')', '<img');
  setOutside(false);
}
has('an image on this ship still draws', '![x](/apps/lattice/a/b.png?data)', '<img alt="x" src="/apps/lattice/a/b.png?data">');
has('a backslash later in a path is left alone', '[x](/a/b\\c)', '<a href="/a/b\\c">');

console.log('\ngemtext agrees with the ship (code/lib/lattice-gmi.hoon)');
const gmi = require59gmi;
const FENCED = '```hoon\n# not a heading\n```\n# Real';
check.eq('a fence with a language opens a block', gmi(FENCED), '<pre># not a heading</pre>\n<h1>Real</h1>');
check.eq('a closing fence may carry text too', gmi('```\na\n``` end\nb'), '<pre>a</pre>\n<p>b</p>');
check.eq('an unclosed fence still renders', gmi('```x\na'), '<pre>a</pre>');
check.eq('a heading needs no space', gmi('#One\n##Two\n###Three'), '<h1>One</h1>\n<h2>Two</h2>\n<h3>Three</h3>');
check.eq('extra spaces after the hashes are dropped', gmi('#   One'), '<h1>One</h1>');
check.eq('a fourth hash is heading text', gmi('#### d'), '<h3># d</h3>');
check.eq('CRLF: the CR is not content', gmi('# a\r\n```x\r\nb\r\n```\r\nc\r\n'), '<h1>a</h1>\n<pre>b</pre>\n<p>c</p>');
eqj('the outline skips a fence with a language', outline(FENCED, 'gmi'), [{ level: 1, text: 'Real', line: 4 }]);
eqj('the outline reads a heading with no space', outline('#One\n##Two', 'gmi'),
  [{ level: 1, text: 'One', line: 1 }, { level: 2, text: 'Two', line: 2 }]);
eqj('the outline reads CRLF gemtext', outline('# a\r\n```x\r\n# b\r\n```\r\n', 'gmi'), [{ level: 1, text: 'a', line: 1 }]);
eqj('gemtext links inside a fence with a language are not links', outLinks('```x\n=> https://e.com a\n```', 'gmi'), []);

check.eq('a link line needs no space after the arrow', gmi('=>http://x y'), '<p><a href="http://x" target="_blank" rel="noopener noreferrer">y</a></p>');
check.eq('a tab ends the address', gmi('=> http://x\tlab'), '<p><a href="http://x" target="_blank" rel="noopener noreferrer">lab</a></p>');
check.eq('a tab after the arrow, blanks before the label', gmi('=>\thttp://x  two words'), '<p><a href="http://x" target="_blank" rel="noopener noreferrer">two words</a></p>');
check.eq('a tab ends an urb address too', gmi('=> urb://~zod/a&b#c\tlabel'), '<p><a href="/apps/lattice?url=urb%3A%2F%2F~zod%2Fa%26b%23c">label</a></p>');
check.eq('a link with no label shows its address', gmi('=> http://x '), '<p><a href="http://x" target="_blank" rel="noopener noreferrer">http://x</a></p>');
check.eq('an arrow alone is a paragraph', gmi('=>\n=> '), '<p>=&gt;</p>\n<p>=&gt; </p>');
check.eq('a run of bullets is one list', gmi('* a\n*   b\nc\n* d'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n<p>c</p>\n<ul>\n<li>d</li>\n</ul>');
check.eq('a star with no space is a paragraph', gmi('*a'), '<p>*a</p>');
eqj('gemtext links with a tab or no space', outLinks('=>https://e.com/a one\n=> urb://~zod/x\ttwo', 'gmi'), ['https://e.com/a', 'urb://~zod/x']);

console.log('\nmarkdown agrees with the ship (code/lib/lattice-md.hoon)');
// An <img> is loaded as the page is drawn, with the reader's session. A
// source on this host with a query is a request to a route, so it is
// drawn as a link (+safe-img, +route-url). Only the bare ?data of a
// file's raw view still draws.
const CLIP = '![x](/apps/lattice/clip?url=https://evil.example/t?id=1)';
hasnt('a same-host image with a query is no image', CLIP, '<img');
has('it is a link to the same address', CLIP, '<a href="/apps/lattice/clip?url=https://evil.example/t?id=1">x</a>');
has('with no alt the link shows the address', '![](/apps/lattice?url=urb://~zod/p)', '<a href="/apps/lattice?url=urb://~zod/p">/apps/lattice?url=urb://~zod/p</a>');
for (const u of ['/a.png?data=1', '/a.png?data&url=http://e', '/a.png?', '/a.png#f?q=1', '/apps/lattice/share?text=http://e.example'])
  hasnt('no image for ' + u, '![x](' + u + ')', '<img');
has('the alt of such a link is still escaped', '![a "b <i>](/a?b=1)', '<a href="/a?b=1">a &quot;b &lt;i&gt;</a>');
has('a raw view still draws', '![x](/apps/lattice/x/~zod/p/pic.png?data)', '<img alt="x" src="/apps/lattice/x/~zod/p/pic.png?data">');
has('and so does a plain path', '![x](/pic.png)', '<img alt="x" src="/pic.png">');
setOutside(true);
hasnt('outside content allowed does not lift it', CLIP, '<img');
hasnt('an absolute same-origin image with a query is no image either',
  '![x](https://ship.example/apps/lattice/clip?url=https://evil.example/t)', '<img');
has('it becomes a link instead',
  '![x](https://ship.example/apps/lattice/clip?url=https://evil.example/t)',
  '<a href="https://ship.example/apps/lattice/clip?url=https://evil.example/t">x</a>');
hasnt('a protocol-relative same-origin image with a query is no image either',
  '![x](//ship.example/apps/lattice/clip?url=https://evil.example/t)', '<img');
has('a same-origin absolute raw ?data view still draws',
  '![x](https://ship.example/apps/lattice/f/pic.png?data)',
  '<img alt="x" src="https://ship.example/apps/lattice/f/pic.png?data">');
has('a remote image keeps its query', '![a](https://x.example/i.png?w=2)', '<img alt="a" src="https://x.example/i.png?w=2">');
has('a protocol-relative remote image keeps its query', '![a](//x.example/i.png?w=2)', '<img alt="a" src="//x.example/i.png?w=2">');
setOutside(false);
check.eq('two spaces before a line end are a break', mdToHtml('a  \nb'), '<p>a<br>\nb</p>');
check.eq('more than two as well', mdToHtml('a    \nb'), '<p>a<br>\nb</p>');
check.eq('one space is not', mdToHtml('a \nb'), '<p>a \nb</p>');
check.eq('emphasis runs across a break', mdToHtml('*a  \nb*'), '<p><em>a<br>\nb</em></p>');
check.eq('a code span keeps its spaces', mdToHtml('`a  \nb`'), '<p><code>a  \nb</code></p>');
hasnt('nothing breaks at the end of a paragraph', 'a  ', '<br>');
check.eq('a link address cannot hold "]("', mdToHtml('[a](/u](/v)'), '<p>[a](/u](/v)</p>');
check.eq('nor can an image source', mdToHtml('![a](/u](/v)'), '<p>![a](/u](/v)</p>');
check.eq('a bracket alone in an address is fine', mdToHtml('[a](/u]v)'), '<p><a href="/u]v">a</a></p>');
// A byte past ASCII is a word character on the ship, so an underscore
// beside one opens or closes nothing.
for (const t of ['é_a_é', '_a_é', 'é_a_', '—_a_—', 'a_b_c', '_a_b_', 'a__b__c', '__a__é'])
  check.eq('no emphasis in ' + t, mdToHtml(t), '<p>' + t + '</p>');
check.eq('underscores at word edges are emphasis', mdToHtml('é _a_ é (_b_)'), '<p>é <em>a</em> é (<em>b</em>)</p>');
check.eq('two underscores at word edges are bold', mdToHtml('__a__ x __b c__.'), '<p><strong>a</strong> x <strong>b c</strong>.</p>');
check.eq('and may hold one inside a word', mdToHtml('__a_b__'), '<p><strong>a_b</strong></p>');

console.log('\noutgoing links and outline (76-outline.js)');
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
// the urb:// target is encoded into the reader's query (gmiToHtml)
check('a gemtext urb:// target is encoded', require59gmi('=> urb://~zod/a?b=1&c=2 x').includes('url=urb%3A%2F%2F~zod%2Fa%3Fb%3D1%26amp;c%3D2') || require59gmi('=> urb://~zod/a?b=1&c=2 x').includes('url=urb%3A%2F%2F~zod%2Fa%3Fb%3D1%26c%3D2'));
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
    { level: 3, text: '# d', line: 3 }, { level: 2, text: 'b', line: 7 }]);
eqj('other kinds have no outline', outline('# x', 'html'), []);

console.log('task boxes: a click flips the one marker on its own source line');
// mdToHtml(text, true) marks each live box with its source line, and
// taskToggle(text, line, on) is the edit a click on it makes. Together: click
// box k, apply the edit, and exactly that one character changes.
const taskToggle = new Function(`${MD}\nreturn taskToggle;`)();
const boxes = (t) => [...mdToHtml(t, true).matchAll(/<input type="checkbox" data-line="(\d+)"(?: data-h="[0-9a-z]+")?( checked)?>/g)]
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
