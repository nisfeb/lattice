#!/usr/bin/env node
//  writer-unit.mjs: the Writer core (ui-src/writer/), pure node, no ship
//  and no LibreOffice (plan, Task 8). The round trip through LibreOffice
//  is scripts/writer-roundtrip.mjs.
//
//  Needs the ProseMirror packages: npm ci --prefix scripts --ignore-scripts.
//
//  Usage: node scripts/writer-unit.mjs
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { makeCheck } from './lib/check.mjs';
import { importWriter } from './lib/writer-node.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = join(here, '..', 'tests', 'writer', 'corpus');
const check = makeCheck();
const core = await importWriter('xml.js', 'schema.js', 'styles.js', 'parse.js', 'serialize.js', 'edits.js',
  'view.js', 'paste.js');
const { Node: PMNode, Slice, Fragment } = await import('prosemirror-model');
const { EditorState } = await import('prosemirror-state');
const { parseFodt, serializeFodt, applyEdit, schema } = core;

const read = (f) => readFileSync(join(corpus, f), 'utf8');
const files = readdirSync(corpus).filter((f) => f.endsWith('.fodt')).sort();
const lines = (t) => t.split('\n');
const changedLines = (a, b) => {
  const A = lines(a); const B = lines(b);
  if (A.length !== B.length) return -1;
  return A.filter((l, i) => l !== B[i]).length;
};
const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return JSON.stringify(b.slice(i, i + 80)); };

console.log('# no-op round trip, every corpus file');
for (const f of files) {
  const t = read(f);
  const p = parseFodt(t);
  if (!check(`${f} parses`, !p.error, p.error)) continue;
  const o = serializeFodt(p, t);
  check(`${f} no-op is byte-identical`, o.text === t, o.error || firstDiff(t, o.text || ''));
  //  a document that went through JSON (no shared node objects) is still
  //  recognised as unchanged
  const j = serializeFodt({ doc: PMNode.fromJSON(schema, p.doc.toJSON()) }, t);
  check(`${f} no-op through JSON is byte-identical`, j.text === t, j.error || firstDiff(t, j.text || ''));
  //  and the writer alone, copying nothing, reproduces LibreOffice's layout
  const r = serializeFodt(p, t, { rewrite: true });
  check(`${f} rewriting every node is byte-identical`, r.text === t, r.error || firstDiff(t, r.text || ''));
  //  an EditorState serializes like the parse result
  const s = serializeFodt(EditorState.create({ doc: p.doc }), t);
  check(`${f} an EditorState serializes the same`, s.text === t, s.error);
}

console.log('# minimal diff');
{
  const t = read('01-paragraphs.fodt');
  const p = parseFodt(t);
  const b = core.findBlock(p.doc, 'A second paragraph');
  const r = core.findText(b, 'second');
  const doc = p.doc.replace(r.from, r.to, new (await import('prosemirror-model')).Slice(
    (await import('prosemirror-model')).Fragment.from(schema.text('other')), 0, 0));
  const o = serializeFodt({ ...p, doc }, t);
  check('changing one word changes exactly one line', changedLines(t, o.text) === 1, o.error);
  check('the changed line has the new word', o.text.includes('>A other paragraph follows it, also Text Body.<'));
}
{
  //  an edit in one paragraph leaves the whitespace fixture's others alone
  const t = read('12-whitespace.fodt');
  const e = applyEdit(parseFodt(t), { op: 'insertText', find: 'A trailing space.', at: 'end', text: 'Now text follows.' });
  const o = serializeFodt(e, t);
  check('12-whitespace: an edit elsewhere changes one line', changedLines(t, o.text) === 1, o.error);
  check('12-whitespace: the edited line keeps its literal space',
    o.text.includes('<text:p text:style-name="Text_20_body">A trailing space. Now text follows.</text:p>'));
  const again = parseFodt(o.text);
  check('12-whitespace: the result parses and round-trips', serializeFodt(again, o.text).text === o.text);
  //  white space typed in the editor is written as ODF needs it
  const b = core.findBlock(again.doc, 'A trailing space.');
  const end = b.pos + 1 + b.node.content.size;
  const doc2 = again.doc.replace(end, end, new (await import('prosemirror-model')).Slice(
    (await import('prosemirror-model')).Fragment.from(schema.text('  two\tand   three ')), 0, 0));
  const o2 = serializeFodt({ ...again, doc: doc2 }, o.text);
  check('runs of spaces become text:s, tabs text:tab',
    o2.text.includes('Now text follows. <text:s/>two<text:tab/>and <text:s text:c="2"/>three </text:p>'), o2.text && o2.text.match(/Now text follows\.[^\n]*/)?.[0]);
  const back = parseFodt(o2.text);
  check('and read back as the same text', core.findBlock(back.doc, 'A trailing space.').node.textContent
    === 'A trailing space. Now text follows.  two\tand   three ');
}

console.log('# automatic styles');
{
  const t = read('01-paragraphs.fodt');
  const bold = () => serializeFodt(applyEdit(parseFodt(t), { op: 'toggleMark', find: 'Lorem ipsum', word: 'dolor', mark: 'strong' }), t).text;
  const a = bold(); const b = bold();
  const name = (a.match(/<text:span text:style-name="([^"]+)">dolor<\/text:span>/) || [])[1];
  check('bolding a word makes a span with an L style', /^LT[0-9a-f]{8}$/.test(name || ''), name);
  check('the same bold in two sessions gives the same style and text', a === b);
  check('the new style is added once, before </office:automatic-styles>',
    a.split(`style:name="${name}"`).length === 2
    && new RegExp(`<style:style style:name="${name}" style:family="text">\\n   <style:text-properties fo:font-weight="bold"/>\\n  </style:style>\\n </office:automatic-styles>`).test(a));
  check('the new style lands as LibreOffice lays it out', serializeFodt(parseFodt(a), a).text === a);
}
{
  const t = read('03-inline.fodt');
  const o = serializeFodt(applyEdit(parseFodt(t), { op: 'toggleMark', find: 'Plain, ', word: 'Plain', mark: 'strong' }), t);
  check('bolding text reuses LibreOffice\'s T1 (exactly fo:font-weight="bold")',
    o.text.includes('<text:span text:style-name="T1">Plain</text:span>, <text:span text:style-name="T1">bold</text:span>'), o.error);
  check('and adds no style', !/style:name="L[TP][0-9a-f]{8}"/.test(o.text));
  //  italic on top of T1's bold finds T7 (bold italic)
  const o2 = serializeFodt(applyEdit(parseFodt(t), { op: 'toggleMark', find: 'Plain, ', word: 'bold', mark: 'em' }), t);
  check('bold plus italic reuses T7', o2.text.includes('<text:span text:style-name="T7">bold</text:span>'), o2.error);
  //  an underline keeps its double type when the paragraph is rewritten
  const o3 = serializeFodt(applyEdit(parseFodt(t), { op: 'insertText', find: 'Underlines:', at: 'end', text: ' More.' }), t);
  check('a rewritten paragraph keeps its spans\' styles',
    o3.text.includes('Underlines: <text:span text:style-name="T3">single</text:span>, <text:span text:style-name="T4">double</text:span>, <text:span text:style-name="T5">wave</text:span>. More.</text:p>'), o3.error);
  //  style names are per family: 13-large has a text T1 and a table T1
  const big = parseFodt(read('13-large.fodt'));
  check('styles are keyed by family', core.lookup(big.styles, 'text', 'T1')?.family === 'text'
    && core.lookup(big.styles, 'table', 'T1')?.family === 'table');
}
{
  //  a page break before adds a paragraph style, and reads back
  const t = read('01-paragraphs.fodt');
  const p = parseFodt(t);
  const b = core.findBlock(p.doc, 'The last paragraph.');
  const doc = p.doc.type.create(null, null) && p.doc.copy(p.doc.content.replaceChild(p.doc.content.findIndex(b.pos).index,
    b.node.type.create({ ...b.node.attrs, pageBreak: true }, b.node.content)));
  const o = serializeFodt({ ...p, doc }, t);
  const back = parseFodt(o.text);
  check('a page break before makes an LP style on Text Body',
    /<style:style style:name="LP[0-9a-f]{8}" style:family="paragraph" style:parent-style-name="Text_20_body">\n   <style:paragraph-properties fo:break-before="page"\/>/.test(o.text), o.error);
  check('and reads back as a page break', core.findBlock(back.doc, 'The last paragraph.').node.attrs.pageBreak === true);
}

{
  //  a style a new one derives from keeps its child elements: tab stops
  //  survive turning on a page break (review, Task 8)
  let t = read('12-whitespace.fodt');
  t = t.replace('</office:automatic-styles>', '<style:style style:name="P9" style:family="paragraph" style:parent-style-name="Text_20_body"><style:paragraph-properties fo:margin-left="1cm"><style:tab-stops><style:tab-stop style:position="3cm"/></style:tab-stops></style:paragraph-properties></style:style>\n </office:automatic-styles>')
    .replace('<text:p text:style-name="Text_20_body">A trailing space. </text:p>', '<text:p text:style-name="P9">Tabbed<text:tab/>here.</text:p>');
  const p = parseFodt(t);
  const b = core.findBlock(p.doc, 'Tabbed');
  const doc = p.doc.copy(p.doc.content.replaceChild(p.doc.content.findIndex(b.pos).index,
    b.node.type.create({ ...b.node.attrs, pageBreak: true }, b.node.content)));
  const o = serializeFodt({ ...p, doc }, t);
  check('a page break on a style with tab stops keeps the tab stops',
    /<style:paragraph-properties fo:break-before="page" fo:margin-left="1cm"><style:tab-stops><style:tab-stop style:position="3cm"\/><\/style:tab-stops><\/style:paragraph-properties>/.test(o.text || ''), o.error);
  check('and that style reads back as a page break', core.findBlock(parseFodt(o.text).doc, 'Tabbed').node.attrs.pageBreak === true);
}

console.log('# white space as LibreOffice reads it');
{
  //  each source paragraph, and its text as LibreOffice 26.8 reads it
  //  (its txt export). text:s, text:tab, text:line-break, a soft page
  //  break and fields end a run of spaces; markers do not
  const cases = [
    ['a<text:line-break/> b', 'a\n b'],
    ['a<text:s/> b', 'a  b'],
    ['a<text:tab/> b', 'a\t b'],
    ['a <text:bookmark text:name="bm"/> b', 'a b'],
    ['a <text:bookmark-start text:name="b2"/> b<text:bookmark-end text:name="b2"/>', 'a b'],
    ['a <text:reference-mark text:name="r"/> b', 'a b'],
    ['a <text:alphabetical-index-mark text:string-value="k"/> b', 'a b'],
    ['a <text:soft-page-break/> b', 'a  b'],
    ['a <text:page-number text:select-page="current">1</text:page-number> b', 'a 1 b'],
    ['a <text:span> b</text:span>', 'a b'],
  ];
  const base = read('12-whitespace.fodt');
  const at = base.indexOf('<text:p '); const end = base.indexOf('  </office:text>');
  const t = base.slice(0, at) + cases.map(([x]) => `<text:p text:style-name="Text_20_body">${x}</text:p>\n   `).join('') + base.slice(end);
  const p = parseFodt(t);
  const shown = (n) => { let s = ''; n.forEach((k) => { s += k.isText ? k.text : k.type === schema.nodes.hard_break ? '\n' : (k.attrs.label || ''); }); return s; };
  const got = []; p.doc.forEach((n) => { if (n.isTextblock) got.push(shown(n)); });
  cases.forEach(([x, want], i) => check(`reads ${JSON.stringify(x)} as LibreOffice does`, got[i] === want, JSON.stringify(got[i])));
  //  what LibreOffice writes for those, which a rewrite must reproduce
  const lo = [
    'a<text:line-break/> b', 'a <text:s/>b', 'a<text:tab/> b', 'a <text:bookmark text:name="bm"/>b',
    'a <text:page-number text:select-page="current">1</text:page-number><text:s/>b',
    'a <text:note text:id="n1" text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>n</text:p></text:note-body></text:note><text:s/>b',
  ];
  const t2 = base.slice(0, at) + lo.map((x) => `<text:p text:style-name="Text_20_body">${x}</text:p>\n   `).join('') + base.slice(end);
  const r = serializeFodt(parseFodt(t2), t2, { rewrite: true });
  check('rewriting LibreOffice\'s own white space layout is byte-identical', r.text === t2, r.error || firstDiff(t2, r.text || ''));
}

{
  //  a character XML cannot hold is never written, and must not count as
  //  text between two spaces: saved and reopened, the paragraph reads as
  //  typed, less that character
  const base = '<?xml version="1.0" encoding="UTF-8"?>\n<office:document xmlns:office="o" xmlns:text="t">\n <office:body>\n  <office:text>\n   <text:p>seed</text:p>\n  </office:text>\n </office:body>\n</office:document>\n';
  const S = schema.nodes;
  const strip = (x) => x.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
  const trip = (x) => {
    const o = serializeFodt({ doc: S.doc.create(null, [S.paragraph.create(null, schema.text(x))]) }, base);
    const back = o.text && parseFodt(o.text);
    return o.error || back.error || back.doc.firstChild.textContent;
  };
  for (const x of ['two \u000c words', '\u0001 indented', 'a \u0008 b', ' \u0001 x', 'x \u0001 ', 'a  \u0002\u0003  b', '\u0001', 'a\u0001 b', 'a \ufffe b', 'tab\t\u0001 x', '\u0001\u0002 \u0003 \u0004 z']) {
    check.eq(`${JSON.stringify(x)} reopens as typed, less what XML cannot hold`, trip(x), strip(x));
  }
  //  and split over text nodes with different marks, as a paste leaves it
  const bold = schema.marks.strong.create();
  const o = serializeFodt({ doc: S.doc.create(null, [S.paragraph.create(null, [schema.text('two '), schema.text('\u000c', [bold]), schema.text(' words')])]) }, base);
  check.eq('a stripped character alone in a span leaves the spaces around it', o.error || parseFodt(o.text).doc.firstChild.textContent, 'two  words');
  //  a seeded sweep over short strings of spaces, letters and such characters
  let seed = 7, bad = null;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 3000 && !bad; i++) {
    let x = '';
    for (let k = rnd(9) + 1; k > 0; k--) x += [' ', ' ', 'a', '\u0001', '\u000c', '\t', 'b'][rnd(7)];
    if (trip(x) !== strip(x)) bad = x;
  }
  check('3000 random strings with such characters reopen as typed', !bad, JSON.stringify(bad));
}

console.log('# paired markers');
{
  const t = read('10-unknown.fodt');
  const p = parseFodt(t);
  const b = core.findBlock(p.doc, 'A bookmark starts in this paragraph');
  const doc = p.doc.copy(p.doc.content.replaceChild(p.doc.content.findIndex(b.pos).index,
    b.node.type.create(b.node.attrs, schema.text('A bookmark starts in this paragraph'))));
  const o = serializeFodt({ ...p, doc }, t);
  check('deleting one half of a bookmark pair is refused', !!o.error && /bookmark "span"/.test(o.error), o.error || 'saved');
  const st = EditorState.create({ doc: p.doc });
  check('the editor guard refuses the same step',
    core.pairGuard(st.tr.delete(b.pos + 1, b.pos + 2), st) === false);
  check('and lets an ordinary edit through',
    core.pairGuard(st.tr.insertText('x', b.pos + 3), st) === true);
  //  deleting both halves is allowed
  const e = core.findBlock(p.doc, 'and ends in this one.');
  const tr = st.tr.delete(e.pos + 1, e.pos + e.node.content.size + 1).delete(b.pos + 1, b.pos + 2);
  check('deleting both halves of a pair is allowed', !serializeFodt({ ...p, doc: tr.doc }, t).error || unbalancedOther(tr.doc));
}
function unbalancedOther(doc) { return [...core.unbalanced(doc)].every((k) => !k.includes('"span"')); }

console.log('# the model');
{
  const p = parseFodt(read('08-tables.fodt'));
  const kinds = [];
  p.doc.forEach((n) => kinds.push(n.type.name));
  check('a simple table is a table', kinds.includes('table'));
  const op = []; p.doc.forEach((n) => { if (n.type.name === 'opaque_block') op.push(n.attrs.name); });
  check('a merged-cell table is one opaque_block', op.filter((n) => n === 'table:table').length === 1);
  const t1 = []; p.doc.forEach((n) => { if (n.type.name === 'table') t1.push(n); });
  check('the header row is marked', t1[0].firstChild.attrs.header === true && t1[0].child(1).attrs.header === false);
  const e = applyEdit(p, { op: 'addTableRow', table: 'Table1', cells: ['Quinces', 'Yellow', '5'] });
  const o = serializeFodt(e, read('08-tables.fodt'));
  check('a new row copies the last row\'s cell styles',
    o.text.includes('    <table:table-row>\n     <table:table-cell table:style-name="Table1.A2" office:value-type="string">\n      <text:p text:style-name="Table_20_Contents">Quinces</text:p>'), o.error);
}
{
  const p = parseFodt(read('04-lists.fodt'));
  let lists = 0; p.doc.forEach((n) => { if (n.type.name === 'list') lists++; });
  check('lists are lists', lists >= 4);
  const o = serializeFodt(applyEdit(p, { op: 'addListItem', find: 'Second, b', text: 'Second, c' }), read('04-lists.fodt'));
  check('a new list item sits in LibreOffice\'s layout',
    o.text.includes('       <text:p text:style-name="P2">Second, b</text:p>\n      </text:list-item>\n      <text:list-item>\n       <text:p text:style-name="P2">Second, c</text:p>\n      </text:list-item>\n     </text:list>'), o.error);
}
{
  const p = parseFodt(read('10-unknown.fodt'));
  check('10-unknown: tracking is on (no text:track-changes attribute)', p.tracking === true);
  check('10-unknown: macros are noticed', p.macros === true);
  check('01: tracking is off', parseFodt(read('01-paragraphs.fodt')).tracking === false);
  const names = new Set(); p.doc.descendants((n) => { if (n.type.name.startsWith('opaque')) names.add(n.attrs.name); });
  for (const n of ['text:note', 'text:bookmark-start', 'text:table-of-content', 'text:tracked-changes', 'office:annotation', 'text:date'])
    check(`10-unknown: ${n} is opaque`, names.has(n));
  let sections = 0; p.doc.descendants((n) => { if (n.type.name === 'section') sections++; });
  check('10-unknown: a plain section is editable and a linked one opaque', sections === 1 && names.has('text:section'));
  const q = parseFodt(read('06-quote-break.fodt'));
  const qb = core.findBlock(q.doc, 'A paragraph before the quotation.');
  let quote = false; let brk = false;
  q.doc.descendants((n) => { if (n.attrs.quote) quote = true; if (n.attrs.pageBreak) brk = true; });
  check('06: Quotations shows as a quote and a page break is seen', quote && brk && qb);
  const l = parseFodt(read('09-layout.fodt')).layout;
  check('09: the page width comes from the first master page', /^\d/.test(l.width || ''), JSON.stringify(l));
}

console.log('# extractors');
{
  const t = read('12-whitespace.fodt');
  const txt = core.fodtText(t);
  check('fodtText keeps spaces and tabs', txt.includes('Tab\tseparated\t\tvalues.') && txt.includes('three  spaces'), txt.slice(0, 120));
  check('fodtText has no markup', !/style-name|office:/.test(core.fodtText(read('10-unknown.fodt'))));
  const ol = core.fodtOutline(read('02-headings.fodt'));
  check('fodtOutline lists the headings with levels', ol.length >= 6 && ol.some((h) => h.level === 3 && h.text.includes('Heading level 3')), JSON.stringify(ol.slice(0, 3)));
  const ln = core.fodtLinks(read('05-links.fodt'));
  check('fodtLinks lists the targets, decoded', ln.includes('https://example.org/page?a=1&b=2'), JSON.stringify(ln));
  check('the extractors answer empty on a refused document',
    core.fodtText(read('hostile/billion-laughs.fodt')) === '' && core.fodtOutline('<x') .length === 0);
}

console.log('# hostile files');
for (const f of readdirSync(join(corpus, 'hostile')).sort()) {
  const t = read('hostile/' + f);
  let p; let threw = null;
  try { p = parseFodt(t); } catch (e) { threw = e; }
  check(`hostile/${f}: never throws`, !threw, threw && threw.message);
  if (/billion|doctype|external-entity|deep|space-bomb/.test(f)) check(`hostile/${f}: refused with { error }`, !!(p && p.error), p && p.error);
  else {
    check(`hostile/${f}: opens`, !!(p && !p.error), p && p.error);
    check(`hostile/${f}: no-op is byte-identical`, serializeFodt(p, t).text === t);
  }
}
{
  const p = parseFodt(read('hostile/script-iframe.fodt'));
  const op = []; p.doc.descendants((n) => { if (n.type.name.startsWith('opaque')) op.push(n.attrs.name); });
  check('script, iframe and svg stay opaque', ['script', 'iframe', 'html:script', 'svg:svg'].every((n) => op.includes(n)), op.join(' '));
  const s = parseFodt(read('hostile/style-injection.fodt'));
  const all = [...s.styles.styles.values()].map((e) => core.styleCss(s.styles, e.family, e.name)).join(';');
  check('style values never reach CSS unparsed', !/url\(|expression|<|>|\}/.test(all), all);
  check('the font-size with an injection is dropped', !/font-size/.test(core.styleCss(s.styles, 'paragraph', 'Evil_20_Para')));
  //  10 KB of text:s that says 40 million spaces: the editor refuses it,
  //  and search reads at most a million of them, in linear time
  const sb = read('hostile/space-bomb.fodt');
  const t0 = performance.now();
  const words = core.fodtText(sb);
  const ms = performance.now() - t0;
  check(`hostile/space-bomb.fodt: its words in linear time (${ms.toFixed(0)} ms)`, ms < 1000 && /^spaced {1000,}out$/.test(words)
    && words.length <= core.SPACES + 9, words.length);
  check('the spaces around a line break still go', core.fodtText(read('12-whitespace.fodt')).split('\n').every((l) => l === l.replace(/^ +| +$/g, '')));
  const big = 'x'.repeat(8 * 1024 * 1024 + 1);
  check('a document over 8 MB is refused', !!parseFodt(big).error);
  check('a malformed document is refused', !!parseFodt('<office:document><office:body>').error);
}

console.log('# the view (Task 9), what node can check');
{
  const blank = readFileSync(join(here, '..', 'ui-src', 'writer', 'blank.fodt'), 'utf8');
  const b = parseFodt(blank);
  check('blank.fodt opens', !b.error, b.error);
  check('blank.fodt no-op is byte-identical', !b.error && serializeFodt(b, blank).text === blank);
  check('blank.fodt is not recording changes and has no macros', !b.error && !b.tracking && !b.macros);
  const has = (n) => !!core.lookup(b.styles, 'paragraph', n);
  check('blank.fodt defines Text body, Quotations and Heading 1 to 6',
    ['Text_20_body', 'Quotations', ...[1, 2, 3, 4, 5, 6].map((i) => 'Heading_20_' + i)].every(has));
  check('blank.fodt has a bullet and a numbered list style',
    core.listStyleFor(b.styles, 'bullet') === 'List_20_1' && core.listStyleFor(b.styles, 'number') === 'Numbering_20_123');
  check('blank.fodt was saved by LibreOffice', /<meta:generator>LibreOffice\//.test(blank));

  check('cssStr escapes everything but letters, digits, - and _',
    core.cssStr('a"]{x}</style>') === '"a\\22 \\5d \\7b x\\7d \\3c \\2f style\\3e "', core.cssStr('a"]{x}</style>'));
  for (const f of ['hostile/style-injection.fodt', 'hostile/script-iframe.fodt', '07-styles.fodt', '13-large.fodt']) {
    const p = parseFodt(read(f));
    const css = core.docCss(p.styles, 'lat-writer[data-lw="1"]');
    check(`${f}: the view's style sheet has no url(, expression, < or stray }`,
      !/url\(|expression|</.test(css) && css.split('\n').every((l) => !l || /^[^{}]*\{[^{}]*\}$/.test(l)), css.slice(0, 200));
  }
  const lay = core.pageBox(parseFodt(read('09-layout.fodt')).layout);
  check('the page box comes from the first master page', lay.width > 700 && lay.left > 0, JSON.stringify(lay));
  check('a page box with nonsense margins falls back', core.pageBox({ width: '10cm', marginLeft: '9cm' }).left === 76);

  const M = schema.marks;
  const linkDom = M.link.spec.toDOM(M.link.create({ href: 'javascript:alert(1)' }));
  check('a link in the editor carries no href', !('href' in linkDom[1]) && linkDom[1]['data-href'] === 'javascript:alert(1)');
  check('safeHref takes http, https, mailto, urb, # and relative, and nothing else',
    ['https://a', 'http://a', 'mailto:a@b', 'urb://~zod/x', '#x', 'other/report.fodt'].every(core.safeHref)
    && !['javascript:alert(1)', ' JavaScript:x', 'java\tscript:x', 'data:text/html,x', 'file:///etc', 'vnd.sun.star.script:x', 'macro:x', '.uno:Open']
      .some(core.safeHref));
  const ss = M.spanStyle.spec.toDOM(M.spanStyle.create({ rest: [['fo:color', '#ff0000'], ['fo:font-size', 'url(x)'], ['fo:background-color', 'red;x:url(y)']] }));
  check('a span\'s own properties show through the whitelist only', ss[1].style === 'color:#ff0000', JSON.stringify(ss[1]));

  //  what a paste brings: the document's styles, no spans, no markers
  const p10 = parseFodt(read('10-unknown.fodt'));
  const S = schema.nodes;
  const pasted = S.doc.create(null, [
    S.list.create({ kind: 'number', src: [1, 2], xattrs: [['xml:id', 'x']] }, S.list_item.create(null, S.paragraph.create(null, schema.text('one')))),
    S.paragraph.create({ src: [3, 4], xattrs: [['xml:id', 'y']] }, [schema.text('two'),
      S.opaque_inline.create({ raw: '<text:bookmark-start text:name="b"/>', name: 'text:bookmark-start' }),
      S.opaque_inline.create({ raw: '<text:date>x</text:date>', name: 'text:date', label: 'x' })]),
  ]);
  const fixed = [];
  pasted.forEach((n) => fixed.push(core.fixPasted(n, b.styles)));
  check('a pasted ol takes the numbered list style', fixed[0].attrs.xattrs[0][1] === 'Numbering_20_123' && fixed[0].attrs.kind === null);
  check('pasted nodes keep no span and no file attributes', fixed.every((n) => n.attrs.src === null)
    && fixed[1].attrs.xattrs.length === 0);
  check('a pasted paragraph takes the body style', fixed[1].attrs.style === 'Text_20_body');
  check('a paste leaves bookmarks behind and keeps fields',
    !fixed[1].content.content.some((c) => c.attrs && c.attrs.name === 'text:bookmark-start')
    && fixed[1].content.content.some((c) => c.attrs && c.attrs.name === 'text:date'));
  //  a drag that moves a paragraph is a move: its comments go with it
  {
    const t = read('10-unknown.fodt');
    const pp = parseFodt(t);
    const plug = core.pastePlugin({}, pp.styles);
    let at = -1, node = null;
    pp.doc.descendants((n, pos) => { if (at < 0 && n.isTextblock && n.textContent.includes('point comment')) { at = pos; node = n; } return at < 0; });
    const sl = new Slice(Fragment.from(node), 0, 0);
    const n = (x) => (x.match(/<office:annotation[ >]/g) || []).length;
    const moveOut = (drag) => {
      const st0 = EditorState.create({ doc: pp.doc });
      const got = plug.props.transformPasted(sl, { dragging: drag(sl) });
      return serializeFodt(st0.apply(st0.tr.delete(at, at + node.nodeSize).insert(1, got.content)), t);
    };
    const moved = moveOut((x) => ({ slice: x, move: true }));
    check('a paragraph dragged within the document keeps its comments', !moved.error && n(moved.text) === n(t) && n(t) === 2, n(moved.text || ''));
    check('a pasted copy of it still leaves them behind', n(moveOut(() => null).text) === 0);
  }
  //  the hidden declaration blocks come back when a step drops one
  {
    const t = read('01-paragraphs.fodt');
    const st0 = EditorState.create({ doc: parseFodt(t).doc, plugins: [core.keepHidden()] });
    const first = st0.doc.firstChild;
    const r = st0.applyTransaction(st0.tr.replaceWith(0, first.nodeSize, S.paragraph.create(null, schema.text('typed'))));
    const out = serializeFodt(r.state, t);
    check('typing over the hidden sequence-decls keeps them', first.attrs.name === 'text:sequence-decls'
      && !out.error && out.text.includes('<text:sequence-decls>') && out.text.includes('typed'));
  }
  check('a list style is found by kind in a corpus file', core.listStyleFor(parseFodt(read('04-lists.fodt')).styles, 'number') === 'L2');
  check('a Basic library counts as macros, LibreOffice\'s empty libraries element does not',
    p10.macros === true && parseFodt(read('01-paragraphs.fodt')).macros === false);
}

console.log('# paste and save, from other editors');
{
  //  a pasted control character never reaches the file: XML 1.0 has no
  //  way to write one, and LibreOffice refuses a file that holds one
  const t = read('01-paragraphs.fodt');
  const p = parseFodt(t);
  const b = core.findBlock(p.doc, 'A second paragraph');
  const tr = EditorState.create({ doc: p.doc }).tr.insertText('one\u000btwo\u0001\u000c￾three', b.pos + 1);
  const o = serializeFodt({ doc: tr.doc }, t);
  const para = ((o.text || '').match(/>(one[^]*?three)/) || [])[1] || '';
  check('a pasted control character is not written', !o.error && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(o.text), JSON.stringify(para));
  check('and Word\'s vertical tab is a line break', para === 'one<text:line-break/>twothree', JSON.stringify(para));
  //  the rules ProseMirror's DOMParser reads pasted HTML with. Google Docs
  //  wraps a whole paste in <b style="font-weight:normal">, and says
  //  underline and strike in a span's style
  const rules = (m) => schema.marks[m].spec.parseDOM;
  const matches = (m, style, v) => rules(m).filter((r) => r.style === style || r.style === style + '=' + v)
    .find((r) => !r.getAttrs || r.getAttrs(v) !== false);
  const b0 = rules('strong').find((r) => r.tag === 'b');
  check('a <b> that says font-weight:normal is not bold', !!b0.getAttrs && b0.getAttrs({ style: { fontWeight: 'normal' } }) === false);
  check('a plain <b> is', !b0.getAttrs || b0.getAttrs({ style: { fontWeight: '' } }) !== false);
  check('font-weight:400 inside a bold run turns bold off', !!matches('strong', 'font-weight', '400')?.clearMark);
  check('font-weight:700 is bold', !!matches('strong', 'font-weight', '700') && !matches('strong', 'font-weight', '700').clearMark);
  check('font-style:normal turns italic off', !!matches('em', 'font-style', 'normal')?.clearMark);
  check('text-decoration:underline is underline', !!matches('underline', 'text-decoration', 'underline'));
  check('text-decoration:line-through is strike', !!matches('strike', 'text-decoration', 'line-through'));
  check('text-decoration-line:underline line-through is both', !!matches('underline', 'text-decoration-line', 'underline line-through')
    && !!matches('strike', 'text-decoration-line', 'underline line-through'));
  check('text-decoration:none is neither', !matches('underline', 'text-decoration', 'none') && !matches('strike', 'text-decoration', 'none'));
}

console.log('# copy and paste within Writer');
{
  const S = schema.nodes;
  //  what the view writes to the clipboard is read back: a link's
  //  data-href, a character style's data-cs, a list's data-ls
  const rules = (t) => (schema.marks[t] || schema.nodes[t]).spec.parseDOM;
  const el = (attrs) => ({ getAttribute: (k) => attrs[k] ?? null, hasAttribute: (k) => k in attrs });
  const lr = rules('link').find((r) => r.tag === 'a[data-href]');
  check('a copied link keeps its target', !!lr && lr.getAttrs(el({ 'data-href': 'https://example.org/' })).href === 'https://example.org/');
  check('and a copied javascript: link is still dropped', !!lr && lr.getAttrs(el({ 'data-href': 'javascript:alert(1)' })) === false);
  const cr = (rules('charStyle') || []).find((r) => r.tag === 'span[data-cs]');
  check('a copied character style is read back', !!cr && cr.getAttrs(el({ 'data-cs': 'Emphasis' })).name === 'Emphasis');
  const ul = rules('list').find((r) => r.tag === 'ul');
  const ua = ul.getAttrs(el({ 'data-ls': 'L2' }));
  check('a copied list names its list style', (ua.xattrs || []).some(([k, v]) => k === 'text:style-name' && v === 'L2'));
  //  paste.js keeps a style this document has, and drops one it has not
  const st = parseFodt(read('04-lists.fodt')).styles;
  const item = S.list_item.create(null, S.paragraph.create(null, schema.text('x')));
  const num = core.fixPasted(S.list.create({ kind: 'bullet', xattrs: [['text:style-name', 'L2']] }, item), st);
  check('a pasted numbered list keeps its numbering', num.attrs.xattrs.some(([k, v]) => k === 'text:style-name' && v === 'L2'), JSON.stringify(num.attrs.xattrs));
  const other = core.fixPasted(S.list.create({ kind: 'bullet', xattrs: [['text:style-name', 'Nope"/><x']] }, item), st);
  check('a list style this document lacks becomes its own', other.attrs.xattrs.length === 1 && other.attrs.xattrs[0][1] === core.listStyleFor(st, 'bullet'), JSON.stringify(other.attrs.xattrs));
  const st7 = parseFodt(read('07-styles.fodt')).styles;
  const cs = (n) => schema.text('w', [schema.marks.charStyle.create({ name: n })]);
  const para = (n) => core.fixPasted(S.paragraph.create(null, cs(n)), st7).firstChild.marks.length;
  const known = [...st7.styles.values()].find((e) => e.family === 'text' && !e.auto);
  check('a pasted character style this document defines stays', !!known && para(known.name) === 1);
  check('one it does not define goes', para('No_20_Such') === 0);
}

console.log('# attribute values, however the file quoted them');
{
  const wrap = (body, styles = '') => `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="o" xmlns:text="t" xmlns:style="s" xmlns:table="tb" xmlns:xlink="x" office:mimetype="application/vnd.oasis.opendocument.text">
 <office:styles>${styles}</office:styles>
 <office:body>
  <office:text>
${body}
  </office:text>
 </office:body>
</office:document>
`;
  //  the first element of that name in the saved text, as the tokenizer reads it
  const first = (text, name) => { let hit = null; const walk = (e) => { for (const k of e.kids) if (k.name) { if (!hit && k.name === name) hit = k; walk(k); } }; const x = core.parseXml(text); if (x.error) return { error: x.error }; walk(x.root); return hit; };
  const edit = (t, find = 'hello') => serializeFodt(applyEdit(parseFodt(t), { op: 'insertText', find, at: 'end', text: 'Z' }), t);
  const attrsOf = (el) => el.attrs.map(([k]) => k + '=' + core.attr(el, k)).join(' | ');
  //  values a producer may put in single quotes: a double quote, one that
  //  reads as a second attribute, an ampersand, angle brackets, both quotes
  for (const [what, tag, want] of [
    ['a double quote', `text:style-name='a"b'`, 'text:style-name=a"b'],
    ['what reads as a second attribute', `text:style-name="S" text:x='1" evil="2'`, 'text:style-name=S | text:x=1" evil="2'],
    ['ampersands and brackets', `text:x='a &amp; b &lt;c&gt; > "d" &quot;e&quot; &#34;'`, 'text:x=a & b <c> > "d" "e" "'],
    ['an apostrophe in double quotes', `text:x="it's &apos;so&apos;"`, "text:x=it's 'so'"],
    ['spaces around the equals sign', `text:x = 'q"q'`, 'text:x=q"q'],
  ]) {
    const t = wrap(`   <text:p ${tag}>hello</text:p>`);
    const o = edit(t);
    const el = o.text ? first(o.text, 'text:p') : o;
    check(`a paragraph with ${what} is rewritten well-formed`, !el.error && !!el.attrs, el.error || o.error);
    check.eq('  with the same attributes and values', el.attrs ? attrsOf(el) : '', want);
    check('  and opens again with the edit', !parseFodt(o.text || '').error && (o.text || '').includes('helloZ'));
    check('  and unedited it is byte-identical', serializeFodt(parseFodt(t), t).text === t);
  }
  for (const [what, body, name, want] of [
    ['link', `<text:p>hello <text:a xlink:href='h?a=1&amp;b="2"' office:name='a"b'>l</text:a></text:p>`, 'text:a', 'xlink:href=h?a=1&b="2" | office:name=a"b'],
    ['span', `<text:p>hello <text:span text:style-name='N"o' text:x='"'>s</text:span></text:p>`, 'text:span', 'text:style-name=N"o | text:x="'],
    ['list', `<text:list text:style-name='L"1' xml:id='i"d'><text:list-item><text:p>hello</text:p></text:list-item></text:list>`, 'text:list', 'text:style-name=L"1 | xml:id=i"d'],
    ['section', `<text:section text:name='s"1'><text:p>hello</text:p></text:section>`, 'text:section', 'text:name=s"1'],
    ['table cell', `<table:table table:name='t"1'><table:table-column/><table:table-row><table:table-cell table:style-name='c"1'><text:p>hello</text:p></table:table-cell></table:table-row></table:table>`, 'table:table-cell', 'table:style-name=c"1'],
  ]) {
    const o = edit(wrap('   ' + body));
    const el = o.text ? first(o.text, name) : o;
    check.eq(`a rewritten ${what} keeps single-quoted values`, el && el.attrs ? attrsOf(el) : (el && el.error) || o.error, want);
  }
  //  a list style whose name needs escaping, from the toolbar's command
  const { TextSelection } = await import('prosemirror-state');
  const keys = await importWriter('keys.js');
  for (const raw of ['A&amp;B&quot;x', 'A&lt;B&gt;&apos;c']) {
    const t = wrap('   <text:p>hello</text:p>', `<text:list-style style:name="${raw}"><text:list-level-style-bullet text:level="1" text:bullet-char="•"/></text:list-style>`);
    const p = parseFodt(t);
    const name = core.listStyleFor(p.styles, 'bullet');
    let st = EditorState.create({ doc: p.doc, selection: TextSelection.create(p.doc, 2) });
    keys.toList(name)(st, (tr) => { st = st.apply(tr); });
    const o = serializeFodt({ ...p, doc: st.doc }, t);
    const el = o.text ? first(o.text, 'text:list') : o;
    check.eq(`a new list in the style ${JSON.stringify(name)} names it`, el && el.attrs ? core.attr(el, 'text:style-name') : (el && el.error) || o.error, name);
    const dom = schema.nodes.list.spec.toDOM(st.doc.firstChild);
    check.eq('  and shows under its decoded name, which a copy reads back', dom[1]['data-ls'] + ' ' + core.decode(schema.nodes.list.spec.parseDOM[0].getAttrs({ hasAttribute: () => true, getAttribute: () => dom[1]['data-ls'] }).xattrs[0][1]), name + ' ' + name);
  }
  //  a paired marker with its name in single quotes is still a pair
  const pair = parseFodt(wrap(`   <text:p>hello <text:bookmark-start text:name='b"1'/>in<text:bookmark-end text:name = 'b"1'/> out</text:p>`));
  const half = pair.doc.firstChild.copy(Fragment.from(pair.doc.firstChild.content.content.filter((n) => n.attrs.name !== 'text:bookmark-end')));
  check.eq('a marker named in single quotes is paired', [...core.unbalanced(pair.doc)].join(), '');
  check.eq('  and missing its other half is seen', [...core.unbalanced(pair.doc.copy(Fragment.from(half)))].join(), 'text:bookmark "b"1"');
}

console.log('# a table keeps its shape');
{
  //  the editor's guard (view.js) over the editor's own keymap: a replace
  //  that joins cells or rows is refused, so the saved table opens as a
  //  table again
  const { Plugin, TextSelection, NodeSelection } = await import('prosemirror-state');
  const { deleteSelection } = await import('prosemirror-commands');
  const t = read('08-tables.fodt');
  const p = parseFodt(t);
  let tpos = -1, table = null;
  p.doc.descendants((n, pos) => { if (tpos < 0 && n.type.name === 'table') { tpos = pos; table = n; } return tpos < 0; });
  const cells = [];
  table.descendants((n, pos) => { if (n.type.name === 'table_cell') cells.push(tpos + 1 + pos); return n.type.name !== 'table_cell'; });
  const w = table.firstChild.childCount;
  const shape = (doc) => { let tb = null; doc.descendants((n) => { if (!tb && n.type.name === 'table') tb = n; return !tb; }); const s = []; if (tb) tb.forEach((r) => s.push(r.childCount)); return s.join(); };
  const kinds = (doc) => { const k = []; doc.forEach((n) => k.push(n.type.name)); return k.join(); };
  const guard = new Plugin({ filterTransaction: (tr) => core.tablesKept(tr) });
  const run = (sel, f) => {
    const st = EditorState.create({ doc: p.doc, plugins: [guard], selection: sel });
    let next = st;
    f(st, (tr) => { next = st.apply(tr); });
    const o = serializeFodt({ ...p, doc: next.doc }, t);
    return { doc: next.doc, changed: next.doc !== st.doc, again: o.error || kinds(parseFodt(o.text).doc) };
  };
  const text = (a, b) => TextSelection.create(p.doc, a + 3, b + 3);
  const type = (s, d) => d(s.tr.insertText('x'));
  for (const [what, sel, f] of [
    ['Delete from one cell into the next', text(cells[w], cells[w + 1]), deleteSelection],
    ['typing over that selection', text(cells[w], cells[w + 1]), type],
    ['Delete from one row into the next', text(cells[w], cells[2 * w]), deleteSelection],
    ['Delete from the paragraph above into a cell', TextSelection.create(p.doc, tpos - 2, cells[w + 1] + 3), deleteSelection],
    ['Delete from a cell to the paragraph below', TextSelection.create(p.doc, cells[w + 1] + 3, tpos + table.nodeSize + 2), deleteSelection],
  ]) {
    const r = run(sel, f);
    check(what + ' leaves the table as it was', shape(r.doc) === shape(p.doc) && !r.changed, shape(r.doc));
    check('  and it opens as a table again', r.again === kinds(p.doc), r.again);
  }
  const inCell = run(TextSelection.create(p.doc, cells[w] + 2, cells[w] + 4), deleteSelection);
  check('a selection inside one cell is still deleted', inCell.changed && shape(inCell.doc) === shape(p.doc) && inCell.again === kinds(p.doc));
  const whole = run(NodeSelection.create(p.doc, tpos), deleteSelection);
  const tables = (doc) => kinds(doc).split(',').filter((k) => k === 'table').length;
  check.eq('a table selected whole is still deleted', tables(whole.doc), tables(p.doc) - 1);
  const typed = run(TextSelection.create(p.doc, cells[0] + 2), type);
  check('typing in a cell still works', typed.changed && typed.again === kinds(p.doc));
  //  a table of one column or one row has no ragged leftover to show a
  //  deletion that begins before it
  {
    const S = schema.nodes, P = (t) => S.paragraph.create(null, schema.text(t));
    const cell = (t) => S.table_cell.create(null, P(t));
    const mk = (rows) => S.table.create(null, rows.map((r) => S.table_row.create(null, r.map(cell))));
    const shapeOf = (d) => { const o = []; d.forEach((n) => { if (n.type.name === 'table') n.forEach((r) => o.push(r.childCount)); }); return o.join(); };
    const cellAt = (doc, k) => { let at = -1, seen = 0; doc.descendants((n, pos) => { if (n.type.name === 'table_cell' && ++seen === k) at = pos; return true; }); return at; };
    for (const [what, rows] of [['one column', [['h'], ['1'], ['2'], ['3']]], ['one row', [['a', 'b', 'c']]]]) {
      const doc = S.doc.create(null, [P('before'), mk(rows), P('after')]);
      const from = TextSelection.create(doc, 3, cellAt(doc, 2) + 3);
      const st = EditorState.create({ doc, plugins: [guard], selection: from });
      let del = st, typed = st;
      deleteSelection(st, (tr) => { del = st.apply(tr); });
      typed = st.apply(st.tr.insertText('x'));
      check(what + ': a delete from the paragraph above into the second cell leaves every cell', shapeOf(del.doc) === shapeOf(doc) && del.doc === doc, shapeOf(del.doc));
      check(what + ': and so does typing over it', shapeOf(typed.doc) === shapeOf(doc) && typed.doc === doc, shapeOf(typed.doc));
      const one = EditorState.create({ doc, plugins: [guard], selection: TextSelection.create(doc, 3, cellAt(doc, 1) + 3) });
      let d1 = one;
      deleteSelection(one, (tr) => { d1 = one.apply(tr); });
      check(what + ': one that ends in the first cell keeps its shape', shapeOf(d1.doc) === shapeOf(doc), shapeOf(d1.doc));
    }
  }
  //  some columns of a table, pasted as a table of their own, are written
  //  under column declarations of their own width
  const narrow = table.copy(Fragment.from(table.content.content.map((r) => r.copy(Fragment.from([r.child(0), r.child(1)])))));
  const o = serializeFodt({ ...p, doc: p.doc.replace(0, 0, new Slice(Fragment.from(narrow.type.create({ ...narrow.attrs, src: null }, narrow.content)), 0, 0)) }, t);
  const first = o.text && o.text.slice(o.text.indexOf('<table:table '), o.text.indexOf('</table:table>'));
  const cols = (x) => [...x.matchAll(/<table:table-column\b([^>]*)>/g)].reduce((a, m) => a + Number((/number-columns-repeated="(\d+)"/.exec(m[1]) || [0, 1])[1]), 0);
  check.eq('a table narrower than its column declarations gets its own', first ? cols(first) : o.error, 2);
  check.eq('  and a table of the width it came with keeps them', cols(t.slice(t.indexOf('<table:table '), t.indexOf('</table:table>'))), w);
}

console.log('# what a paste may bring');
{
  const S = schema.nodes;
  const st = parseFodt(read('01-paragraphs.fodt')).styles;
  const P = (attrs, ...kids) => S.paragraph.create(attrs, kids);
  const note = S.opaque_inline.create({ raw: '<text:note>x</text:note>', name: 'text:note', label: '1' });
  const mark = S.opaque_inline.create({ raw: '<text:bookmark text:name="b"/>', name: 'text:bookmark' });
  const cell = (...kids) => S.table_cell.create({ xattrs: [['a', '"><x/>']] }, kids);
  const tbl = S.table.create({ pre: { text: '<x/>', end: 0, cols: 1 }, xattrs: [['a', '"><x/>']] }, S.table_row.create(null, cell(P(null, schema.text('in a cell'), note))));
  //  from clipboard HTML: no opaque node, no table, whatever the slice
  //  context claimed, and the open sides shrink with the wrappers
  const out = core.fromOutside(new Slice(Fragment.from([tbl, S.opaque_block.create({ raw: '<x/>', name: 'x' })]), 4, 0));
  const names = []; out.content.descendants((n) => { names.push(n.type.name); });
  check.eq('a slice from outside loses its table, its opaque nodes and their attributes', names.join(), 'paragraph,text');
  check.eq('  and is open as deep as what is left', out.openStart + ',' + out.openEnd, '1,0');
  //  a context naming a text block around a list item is not placed whole
  for (const wrap of [S.heading.create({ level: 3 }, S.list_item.create(null, P(null, schema.text('item')))), S.paragraph.create(null, S.list_item.create(null, P(null, schema.text('item'))))]) {
    let threw = null, got = null;
    try {
      const d = S.doc.create(null, [P(null, schema.text('abc'))]);
      const sl = core.fromOutside(new Slice(Fragment.from(wrap), 1, 1));
      const stt = EditorState.create({ doc: d });
      got = stt.apply(stt.tr.replaceSelection(sl)).doc.textContent;
    } catch (e) { threw = e; }
    check('a slice context that puts a list item in a ' + wrap.type.name + ' is pasted without throwing', !threw && /item/.test(got), String(threw || got));
  }
  const brk = S.hard_break.create({ src: [1, 2] }, schema.text('inside'));
  const leaf = core.fromOutside(new Slice(Fragment.from(P(null, brk)), 2, 2));
  check('a leaf given content is a plain leaf', leaf.content.firstChild.firstChild.content.size === 0 && leaf.openStart === 1 && leaf.openEnd === 1);
  //  attributes of the right kind
  const h = core.fixPasted(S.heading.create({ level: '9"><x/>', pageBreak: 'x', quote: { a: 1 }, style: { a: 1 } }, schema.text('h')), st);
  check('a pasted heading has a level, flags and a style of the right kind', h.attrs.level === 1 && h.attrs.pageBreak === false && h.attrs.quote === false && (h.attrs.style === null || typeof h.attrs.style === 'string'), JSON.stringify(h.attrs));
  check.eq('  a level past 10 is 1, one inside is kept', [4000, 0, -3, 2.9, '7', 10].map((level) => core.fixPasted(S.heading.create({ level }, schema.text('h')), st).attrs.level).join(), '1,1,1,2,7,10');
  const li = core.fixPasted(S.list.create({ xattrs: 'x', kind: { a: 1 } }, S.list_item.create({ header: 'x', xattrs: 7 }, P(null, schema.text('i')))), st);
  check('a pasted list whose attributes are not a list is this document\'s own', li.attrs.kind === null && Array.isArray(li.attrs.xattrs) && li.firstChild.attrs.header === false);
  //  a copy made in this document comes back as it was, less its markers
  const own = core.ownPasted(Fragment.from([tbl, P({ src: [5, 9], xattrs: [['k', 'v']] }, schema.text('t'), note, mark)]));
  const on = []; own.descendants((n) => { on.push(n.type.name === 'opaque_inline' ? n.attrs.name : n.type.name); });
  check.eq('a copy from this document keeps its table and footnotes, not a named marker', on.join(), 'table,table_row,table_cell,paragraph,text,text:note,paragraph,text,text:note');
  check('  with the attributes it had', own.firstChild.attrs.pre.text === '<x/>' && own.lastChild.attrs.src[0] === 5 && own.lastChild.attrs.xattrs[0][1] === 'v');
  check('what HTML cannot carry is told from what it can', core.beyondHtml(Fragment.from(tbl)) && core.beyondHtml(Fragment.from(P(null, note))) && !core.beyondHtml(Fragment.from(P(null, schema.text('t')))));
}

console.log('# speed');
{
  const t = read('13-large.fodt');
  parseFodt(t); // warm the JIT, as a page open after load would be
  const t0 = performance.now();
  const p = parseFodt(t);
  const o = serializeFodt(applyEdit(p, { op: 'insertParagraph', find: 'Chapter 30', text: 'New.' }), t);
  const ms = performance.now() - t0;
  check(`13-large parses, edits and serializes in under 300 ms (${ms.toFixed(0)} ms)`, ms < 300 && !o.error, o.error);
}

check.done();
