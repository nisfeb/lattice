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
