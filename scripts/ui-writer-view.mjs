#!/usr/bin/env node
//  ui-writer-view.mjs: the Writer editor view in a real browser, with no
//  ship. The built writer.js is loaded into a blank page and mounted over
//  corpus files, and the suite drives it with the mouse, the keyboard and
//  the clipboard. It checks what needs a DOM, which writer-unit.mjs
//  cannot:
//
//      a drag across table cells selects cells, and Delete or typing over
//      any selection that crosses cells leaves the table its shape
//      cut, copy and paste inside one document keep footnotes, fields and
//      tables, and a paste from elsewhere says what it could not keep
//      sync() is false until a refused document is written
//      a pasted slice context cannot set a heading level or a flag that
//      is not one
//      the print frame goes with the editor
//
//  The shell around the editor (lazy load, tabs, save) needs a ship and is
//  ui-writer.mjs.
//
//  Env:    CHROME   (as the other browser suites)
//  Usage:  node scripts/ui-writer-view.mjs
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser, makeCheck } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const js = readFileSync(join(root, 'code', 'nex', 'lattice', 'ui-app', 'writer.js'), 'utf8');
const corpus = (n) => readFileSync(join(root, 'tests', 'writer', 'corpus', n + '.fodt'), 'utf8');
const check = makeCheck();

const PAGE = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">'
  + '<div style="height:700px;width:1000px"><lat-writer id="h"></lat-writer></div></body></html>';

const browser = await launchBrowser();
const errors = [];
async function open(text) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 760 });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setContent(PAGE);
  await page.addScriptTag({ content: js });
  const r = await page.evaluate((t) => {
    window.buf = t; window.notes = [];
    window.ctl = window.LatWriter.mount(document.getElementById('h'), {
      text: t, editable: true, cur: () => window.buf, onChange() {},
      onText: (x) => { window.buf = x; }, onRefuse: (e) => window.notes.push('REFUSED ' + e), onNote: (m) => window.notes.push(m),
    });
    //  the first table's cells per row, and the document as it would save
    window.shape = () => { let t = null; window.ctl.view.state.doc.descendants((n) => { if (!t && n.type.name === 'table') t = n; return !t; }); const s = []; if (t) t.forEach((row) => s.push(row.childCount)); return s.join(','); };
    window.saved = () => { const o = window.ctl.text(); return o.error ? 'ERROR ' + o.error : o.text; };
    //  a cut or copy of the selection, then a paste at `at` (a function of
    //  the view giving a selection), as the browser sends them
    window.clip = (kind) => { const dt = new DataTransfer(); window.ctl.view.dom.dispatchEvent(new ClipboardEvent(kind, { clipboardData: dt, bubbles: true, cancelable: true })); return { html: dt.getData('text/html'), text: dt.getData('text/plain') }; };
    window.paste = (c) => { const dt = new DataTransfer(); if (c.html) dt.setData('text/html', c.html); dt.setData('text/plain', c.text || ''); window.ctl.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); };
    window.toEnd = () => { const v = window.ctl.view; v.dispatch(v.state.tr.setSelection(window.LatWriter.pm.state.Selection.atEnd(v.state.doc))); };
    window.find = (type) => { let pos = -1; window.ctl.view.state.doc.descendants((n, p) => { if (pos < 0 && n.type.name === type) pos = p; return pos < 0; }); return pos; };
    return window.ctl.error || '';
  }, text);
  if (r) throw new Error(r);
  return page;
}
const count = (t, re) => (t.match(re) || []).length;
//  the kinds of the top-level blocks a saved text opens as
const reopened = (page, t) => page.evaluate((x) => {
  const p = window.LatWriter.core.parseFodt(x);
  if (p.error) return 'ERROR ' + p.error;
  const k = []; p.doc.forEach((n) => k.push(n.type.name)); return k.filter((n) => /table|opaque/.test(n)).join(' ');
}, t);
//  a text selection from one character into cell `a` to one into cell `b`
//  (indexes in document order), which no gesture of the table plugin makes
const acrossCells = (page, a, b) => page.evaluate((i, j) => {
  const v = window.ctl.view, cells = [];
  v.state.doc.descendants((n, p) => { if (n.type.name === 'table_cell') cells.push(p); return true; });
  v.dispatch(v.state.tr.setSelection(window.LatWriter.pm.state.TextSelection.create(v.state.doc, cells[i] + 3, cells[j] + 3)));
  v.focus();
}, a, b);

console.log('==> a table keeps its shape');
{
  const t = corpus('08-tables');
  const kinds0 = await (async () => { const p = await open(t); const k = await reopened(p, t); await p.close(); return k; })();
  {
    const page = await open(t);
    const shape0 = await page.evaluate(() => window.shape());
    const box = await page.evaluate(() => {
      const tds = document.querySelectorAll('lat-writer table')[0].querySelectorAll('tr')[1].querySelectorAll('td');
      tds[0].scrollIntoView({ block: 'center' });
      const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; };
      return [r(tds[0]), r(tds[1]), tds[0].textContent, tds[2].textContent];
    });
    await page.mouse.move(box[0].x, box[0].y); await page.mouse.down();
    await page.mouse.move(box[1].x + 10, box[1].y, { steps: 8 }); await page.mouse.up();
    check.eq('a drag from one cell into the next selects the two cells', await page.evaluate(() => (window.ctl.view.state.selection.$anchorCell ? 'cells ' : 'text ') + document.querySelectorAll('lat-writer td.selectedCell').length), 'cells 2');
    await page.keyboard.press('Delete');
    check.eq('Delete over them leaves every row its cells', await page.evaluate(() => window.shape()), shape0);
    const cells = await page.evaluate(() => [...document.querySelectorAll('lat-writer table')[0].querySelectorAll('tr')[1].querySelectorAll('td')].map((e) => e.textContent));
    check('  and empties the two, not the third', cells[0] === '' && cells[1] === '' && cells[2] === box[3] && box[2] !== '', JSON.stringify(cells));
    const after = await page.evaluate(() => window.saved());
    check.eq('  and the saved table opens as a table again', await reopened(page, after), kinds0);
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    check.eq('  and undo brings the text back', await page.evaluate(() => document.querySelectorAll('lat-writer table')[0].querySelectorAll('tr')[1].querySelector('td').textContent), box[2]);
    await page.close();
  }
  {
    //  cells copied and pasted over other cells of the table, then where
    //  they do not fit
    const page = await open(t);
    const shape0 = await page.evaluate(() => window.shape());
    const r = await page.evaluate(() => {
      const v = window.ctl.view, pm = window.LatWriter.pm, cells = [];
      v.state.doc.descendants((n, p) => { if (n.type.name === 'table_cell') cells.push(p); return true; });
      const row = (i) => [...document.querySelectorAll('lat-writer table')[0].querySelectorAll('tr')[i].querySelectorAll('td')].map((e) => e.textContent);
      v.dispatch(v.state.tr.setSelection(pm.tables.CellSelection.create(v.state.doc, cells[3], cells[4])));
      v.focus();
      const c = window.clip('copy'), from = row(1);
      v.dispatch(v.state.tr.setSelection(pm.state.TextSelection.create(v.state.doc, cells[6] + 2)));
      window.paste(c);
      const to = row(2), shape1 = window.shape();
      //  at the last column the second cell has nowhere to go
      const cells2 = [];
      v.state.doc.descendants((n, p) => { if (n.type.name === 'table_cell') cells2.push(p); return true; });
      v.dispatch(v.state.tr.setSelection(pm.state.TextSelection.create(v.state.doc, cells2[11] + 2)));
      window.notes.length = 0;
      window.paste(c);
      return { from, to, shape1, shape2: window.shape(), said: window.notes.join(' ') };
    });
    check('copied cells paste over the cells at the caret', r.to[0] === r.from[0] && r.to[1] === r.from[1] && r.shape1 === shape0, JSON.stringify(r));
    check('cells that would not fit are not pasted, and the editor says so', r.shape2 === shape0 && /cells of a table/.test(r.said), JSON.stringify(r));
    const after = await page.evaluate(() => window.saved());
    check.eq('  and the table opens as a table again', await reopened(page, after), kinds0);
    await page.close();
  }
  for (const [what, a, b, key] of [['Delete over a text selection across two cells of a row', 3, 4, 'Delete'],
    ['typing over it', 3, 4, 'x'], ['Delete over one that crosses rows', 3, 6, 'Delete'], ['Backspace over one that crosses rows', 3, 7, 'Backspace']]) {
    const page = await open(t);
    const shape0 = await page.evaluate(() => window.shape());
    await acrossCells(page, a, b);
    await page.keyboard.press(key);
    check.eq(what + ' leaves the table its shape', await page.evaluate(() => window.shape()), shape0);
    const after = await page.evaluate(() => window.saved());
    check.eq('  and it opens as a table again', await reopened(page, after), kinds0);
    await page.close();
  }
  {
    //  the neighbours: what may still change a table
    const page = await open(t);
    await page.evaluate(() => { const v = window.ctl.view; v.dispatch(v.state.tr.setSelection(window.LatWriter.pm.state.NodeSelection.create(v.state.doc, window.find('table')))); v.focus(); });
    const before = count(await page.evaluate(() => window.saved()), /<table:table /g);
    await page.keyboard.press('Delete');
    check.eq('a table selected whole is still deleted whole', count(await page.evaluate(() => window.saved()), /<table:table /g), before - 1);
    await page.close();
  }
  {
    const page = await open(t);
    await page.evaluate(() => { const v = window.ctl.view; const c = window.find('table_cell'); v.dispatch(v.state.tr.setSelection(window.LatWriter.pm.state.TextSelection.create(v.state.doc, c + 2, c + 4))); v.focus(); });
    const was = await page.evaluate(() => window.ctl.view.state.doc.nodeAt(window.find('table_cell')).textContent);
    await page.keyboard.press('Delete');
    await page.keyboard.type('Z');
    check.eq('a selection inside one cell is deleted and typed over as before', await page.evaluate(() => window.ctl.view.state.doc.nodeAt(window.find('table_cell')).textContent), 'Z' + was.slice(2));
    await page.close();
  }
}

console.log('==> cut, copy and paste inside one document');
{
  let t = corpus('01-paragraphs');
  const m = /<text:p [^>]*>([^<]{10,})<\/text:p>/.exec(t);
  t = t.replace(m[0], m[0].replace(m[1], m[1] + '<text:note text:id="ftn1" text:note-class="footnote"><text:note-citation>1</text:note-citation>'
    + '<text:note-body><text:p>The footnote body.</text:p></text:note-body></text:note> page <text:page-number text:select-page="current">7</text:page-number>'
    + '<text:bookmark text:name="here"/>'));
  const selectPara = (page) => page.evaluate((prefix) => {
    const v = window.ctl.view; let pos = -1, node = null;
    v.state.doc.descendants((n, p) => { if (pos < 0 && n.isTextblock && n.textContent.startsWith(prefix)) { pos = p; node = n; } return pos < 0; });
    v.dispatch(v.state.tr.setSelection(window.LatWriter.pm.state.TextSelection.create(v.state.doc, pos + 1, pos + 1 + node.content.size)));
    v.focus();
  }, m[1].slice(0, 12));
  let cut;
  {
    const page = await open(t);
    await selectPara(page);
    cut = await page.evaluate(() => { const c = window.clip('cut'); window.toEnd(); window.paste(c); return c; });
    const after = await page.evaluate(() => window.saved());
    check.eq('a cut and pasted paragraph keeps its footnote', count(after, /<text:note /g), 1);
    check('  with the footnote body', after.includes('The footnote body.'));
    check.eq('  and its field', count(after, /<text:page-number/g), 1);
    check('  as the last paragraph', /<text:note-body>.*<text:page-number[^\n]*<\/text:p>\s*<\/office:text>/.test(after), after.slice(-400));
    check('  and it opens again', !(await reopened(page, after)).startsWith('ERROR'));
    check('the clipboard carries no XML of the document', !/note-body|footnote body|text:select-page/.test(cut.html), cut.html.slice(0, 300));
    await page.evaluate(() => { window.toEnd(); });
    await page.close();
  }
  {
    const page = await open(t);
    await selectPara(page);
    await page.evaluate(() => { const c = window.clip('copy'); window.toEnd(); window.paste(c); window.toEnd(); window.paste(c); });
    const after = await page.evaluate(() => window.saved());
    check.eq('a copy pasted twice makes three footnotes', count(after, /<text:note /g), 3);
    check.eq('  and leaves a named marker behind', count(after, /<text:bookmark /g), 1);
    check('  and it opens again', !(await reopened(page, after)).startsWith('ERROR'));
    await page.close();
  }
  {
    //  the same clipboard in another document: its key names nothing there
    const page = await open(corpus('01-paragraphs'));
    await page.evaluate((c) => { window.toEnd(); window.ctl.view.focus(); window.paste(c); }, cut);
    const after = await page.evaluate(() => window.saved());
    check.eq('a paste from another document brings no footnote', count(after, /<text:note /g), 0);
    check('  and says what was not kept', await page.evaluate(() => window.notes.some((n) => /footnote|field/i.test(n))), JSON.stringify(await page.evaluate(() => window.notes)));
    //  a key made up by a page the user copied from
    await page.evaluate(() => { window.notes.length = 0; window.toEnd(); window.paste({ html: '<p data-lw-clip="0000-1">forged <span class="fodt-opi" data-el="text:note">1</span></p>', text: 'forged' }); });
    const forged = await page.evaluate(() => window.saved());
    check('a made-up key pastes as plain text', forged.includes('forged') && count(forged, /<text:note /g) === 0);
    await page.evaluate(() => { window.notes.length = 0; window.toEnd(); window.paste({ html: '<p>plain <b>bold</b></p>', text: 'plain bold' }); });
    check('an ordinary paste says nothing', await page.evaluate(() => window.notes.length === 0 && window.saved().includes('plain ')));
    await page.close();
  }
  {
    const tt = corpus('08-tables');
    const page = await open(tt);
    const before = await page.evaluate(() => window.saved());
    await page.evaluate(() => { const v = window.ctl.view; v.dispatch(v.state.tr.setSelection(window.LatWriter.pm.state.NodeSelection.create(v.state.doc, window.find('table')))); v.focus(); const c = window.clip('cut'); window.toEnd(); window.paste(c); });
    const after = await page.evaluate(() => window.saved());
    check.eq('a cut and pasted table is still a table', count(after, /<table:table /g), count(before, /<table:table /g));
    check.eq('  with its cells', count(after, /<table:table-cell/g), count(before, /<table:table-cell/g));
    check('  and its cell styles', count(after, /table:style-name=/g) === count(before, /table:style-name=/g), `${count(after, /table:style-name=/g)} of ${count(before, /table:style-name=/g)}`);
    check.eq('  and it opens as tables again', (await reopened(page, after)).split(' ').sort().join(' '), (await reopened(page, before)).split(' ').sort().join(' '));
    await page.close();
  }
  {
    const tt = corpus('08-tables');
    const page = await open(tt);
    const before = await page.evaluate(() => window.saved());
    await page.evaluate(() => { const v = window.ctl.view; v.dispatch(v.state.tr.setSelection(window.LatWriter.pm.state.NodeSelection.create(v.state.doc, window.find('table')))); v.focus(); const c = window.clip('copy'); window.toEnd(); window.paste(c); });
    const after = await page.evaluate(() => window.saved());
    check.eq('a copied and pasted table is one more table', count(after, /<table:table /g), count(before, /<table:table /g) + 1);
    const names = (after.match(/<table:table [^>]*table:name="([^"]*)"/g) || []);
    check('  with no table name used twice', new Set(names).size === names.length, names.join(' '));
    const ids = (after.match(/xml:id="[^"]*"/g) || []);
    check('  and no xml:id used twice', new Set(ids).size === ids.length);
    check('  and it opens with every table a table', !/opaque_block/.test((await reopened(page, after)).replace(await reopened(page, before), '')), await reopened(page, after));
    await page.close();
  }
}

console.log('==> sync() and a refused document');
{
  const page = await open(corpus('01-paragraphs'));
  const r = await page.evaluate(() => {
    const ctl = window.ctl, v = ctl.view;
    v.dispatch(v.state.tr.insertText('UNSAVED-EDIT ', 3));
    const real = ctl.text; let refuse = 2;
    ctl.text = () => (refuse-- > 0 ? { error: 'simulated refusal' } : real());
    const first = ctl.sync();
    const second = ctl.sync();
    const heldBack = !window.buf.includes('UNSAVED-EDIT');
    const third = ctl.sync();
    return { first, second, heldBack, third, written: window.buf.includes('UNSAVED-EDIT'), fourth: ctl.sync(), notes: window.notes.filter((n) => /REFUSED/.test(n)).length };
  });
  check.eq('a refused sync is false', r.first, false);
  check.eq('the next one is false too, while nothing was written', r.second, false);
  check('  and nothing was', r.heldBack);
  check.eq('  and each said so', r.notes, 2);
  check('once the document serializes, sync writes it and is true', r.third === true && r.written);
  check.eq('  and a sync with nothing to write is true', r.fourth, true);
  await page.close();
}

console.log('==> a pasted slice context');
{
  const ctx = (a) => JSON.stringify(a).replace(/'/g, '&#39;');
  const cases = [
    ['a heading level that is not a number', `<span data-pm-slice='0 0 ${ctx(['heading', { level: '9"><EVIL-MARKER/>' }])}'>pasted</span>`],
    ['a heading level out of range', `<span data-pm-slice='0 0 ${ctx(['heading', { level: 4000 }])}'>pasted</span>`],
    ['flags that are not booleans', `<span data-pm-slice='0 0 ${ctx(['heading', { level: 2, pageBreak: 'x', quote: { a: 1 } }])}'>pasted</span>`],
    ['a list header that is not a boolean', `<p data-pm-slice='0 0 ${ctx(['list', {}, 'list_item', { header: 'x' }])}'>pasted</p>`],
    ['an opaque block as context', `<p data-pm-slice='0 0 ${ctx(['opaque_block', { raw: '<EVIL-MARKER/>', name: 'x', label: 'l' }])}'>pasted</p>`],
    ['a table as context', `<p data-pm-slice='0 0 ${ctx(['table', { pre: { text: '<EVIL-MARKER/>', end: 0 } }, 'table_row', {}, 'table_cell', {}])}'>pasted</p>`],
    //  text with no block of its own is placed by its context, wrappers and all
    ['a table as context of bare text', `<span data-pm-slice='0 0 ${ctx(['table', { pre: { text: '<EVIL-MARKER/>', end: 0 }, hdr: { tag: '<EVIL-MARKER/>', start: 0, end: 0, openEnd: 0 }, xattrs: [['a', '"><EVIL-MARKER/>']] },
      'table_row', { header: true, xattrs: [['a', '"><EVIL-MARKER/>']] }, 'table_cell', { xattrs: [['a', '"><EVIL-MARKER/>']] }])}'>pasted</span>`],
    ['a section as context of bare text', `<span data-pm-slice='0 0 ${ctx(['section', { xattrs: [['a', '"><EVIL-MARKER/>']] }])}'>pasted</span>`],
    ['an opaque inline as context', `<span data-pm-slice='0 0 ${ctx(['paragraph', {}, 'opaque_inline', { raw: '<EVIL-MARKER/>', name: 'x', label: 'l' }])}'>pasted</span>`],
    ['a line break as context', `<span data-pm-slice='0 0 ${ctx(['paragraph', {}, 'hard_break', {}])}'>pasted</span>`],
    ['a list whose attributes are not a list', `<p data-pm-slice='0 0 ${ctx(['list', { xattrs: 'x', kind: { a: 1 } }, 'list_item', { xattrs: 7 }])}'>pasted</p>`],
    ['a paragraph whose style is not a name', `<span data-pm-slice='0 0 ${ctx(['paragraph', { style: { a: 1 }, placeholder: 'x' }])}'>pasted</span>`],
  ];
  for (const [what, html] of cases) {
    const page = await open(corpus('08-tables'));
    const before = errors.length;
    const r = await page.evaluate((h) => {
      const v = window.ctl.view;
      v.dispatch(v.state.tr.setSelection(new window.LatWriter.pm.state.AllSelection(v.state.doc)));
      v.focus();
      window.paste({ html: h, text: 'pasted' });
      const t = window.saved();
      const bad = [];
      v.state.doc.descendants((n) => {
        if (n.type.name === 'heading' && !(Number.isInteger(n.attrs.level) && n.attrs.level >= 1 && n.attrs.level <= 10)) bad.push('level ' + JSON.stringify(n.attrs.level));
        for (const k of ['pageBreak', 'quote', 'header', 'placeholder']) if (k in n.attrs && typeof n.attrs[k] !== 'boolean') bad.push(k + ' ' + JSON.stringify(n.attrs[k]));
        return true;
      });
      const lv = (t.match(/text:outline-level="([^"]*)"/g) || []).filter((x) => !/="([1-9]|10)"/.test(x));
      return { t, bad: bad.concat(lv), dom: !!document.querySelector('lat-writer hnan, lat-writer h0') };
    }, html);
    check(what + ' is pasted as valid attributes', !r.bad.length && !r.dom, r.bad.join(' '));
    check('  with no raw XML, and no error', !r.t.startsWith('ERROR') && !r.t.includes('<EVIL-MARKER') && errors.length === before, errors.slice(before).join(' | '));
    await page.close();
  }
}

console.log('==> the print frame');
{
  const page = await open(corpus('01-paragraphs'));
  const r = await page.evaluate(async () => {
    let printed = 0;
    const real = HTMLIFrameElement.prototype.__lookupGetter__('contentWindow');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { get() { const w = real.call(this); if (w && this.hasAttribute('data-lw-print')) w.print = () => { printed++; }; return w; } });
    window.ctl.print();
    await new Promise((ok) => setTimeout(ok, 300));
    const before = document.querySelectorAll('iframe[data-lw-print]').length;
    window.ctl.destroy();
    return { printed, before, after: document.querySelectorAll('iframe[data-lw-print]').length };
  });
  check('print makes a frame and prints it', r.before === 1 && r.printed === 1, JSON.stringify(r));
  check.eq('destroy leaves no print frame', r.after, 0);
  await page.close();
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
check.done();
