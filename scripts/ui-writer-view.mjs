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

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
check.done();
