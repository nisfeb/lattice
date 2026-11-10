#!/usr/bin/env node
//  ui-sheet-grid.mjs: the spreadsheet grid in a real browser, with no
//  ship. The built sheet.js is loaded into a blank page and mounted over
//  corpus files, and the suite drives it as a person would: the mouse,
//  the keyboard, the formula bar, the clipboard, the toolbar.
//
//      a click selects, typing opens the editor, Enter commits and moves
//      a typed value recalculates what reads it, and reaches the buffer
//      the formula bar shows and edits a formula
//      arrows, Tab, Shift for a range, Delete clears it
//      copy and paste carry a formula with its references moved
//      pasted text that starts with = is data, not a formula
//      bold, a number format, rows and columns from the toolbar
//      a refusal (a pivot table, a merged cell) is said, and changes nothing
//      sheet tabs switch and add
//      undo and redo
//      read-only mounts, and a file over the size cap, take no edits
//      render() gives a document with no markup of the file's own
//      a phone-sized viewport: a tap selects without opening the editor
//
//  The shell around the grid (lazy load, tabs, save, offline) needs a
//  ship and is ui-sheet.mjs.
//
//  Env:    CHROME   (as the other browser suites)
//  Usage:  node scripts/ui-sheet-grid.mjs
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser, makeCheck, sleep } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const js = readFileSync(join(root, 'code', 'nex', 'lattice', 'ui-app', 'sheet.js'), 'utf8');
const corpus = (n) => readFileSync(join(root, 'tests', 'sheet', 'corpus', n + '.fods'), 'utf8');
const check = makeCheck();

const PAGE = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--bg:#fafafa;--text:#1a1a1a;--border:#8886;--border-soft:#8883;--surface:#8881;--accent:#4a7c59;--muted:#8a8a8a}'
  + 'html,body{margin:0;height:100%;font:15px system-ui}#h{position:absolute;inset:0}</style></head><body><lat-sheet id="h"></lat-sheet></body></html>';

const browser = await launchBrowser();
const errors = [];
async function open(text, { editable = true, viewport = { width: 1100, height: 700 }, touch = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, hasTouch: touch, isMobile: touch });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setContent(PAGE);
  await page.addScriptTag({ content: js });
  const r = await page.evaluate((t, ed) => {
    window.buf = t;
    window.changes = 0;
    window.ctl = window.LatSheet.mount(document.getElementById('h'), {
      text: t, editable: ed, name: 'folder/sheet', cur: () => window.buf,
      onText: (x) => { window.buf = x; }, onChange: () => { window.changes++; },
    });
    return window.ctl.error || '';
  }, text, editable);
  if (r) throw new Error(r);
  const at = async (r1, c1) => {
    const h = await page.$(`.ls-c[data-r="${r1}"][data-c="${c1}"]`);
    const b = await h.boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  const api = {
    page,
    click: async (r1, c1, o) => { const [x, y] = await at(r1, c1); await page.mouse.click(x, y, o); },
    shown: (r1, c1) => page.$eval(`.ls-c[data-r="${r1}"][data-c="${c1}"]`, (e) => e.textContent).catch(() => null),
    cell: (s, r1, c1) => page.evaluate((a, b, c) => { const k = window.ctl.book.cell(a, b, c); return { v: k.v, f: k.f, vt: k.vt, text: k.text }; }, s, r1, c1),
    addr: () => page.$eval('.ls-at', (e) => e.textContent),
    bar: () => page.$eval('.ls-fx input', (e) => e.value),
    note: () => page.$eval('.ls-note:not(.ls-ro) span', (e) => e.textContent).catch(() => ''),
    //  a click into the formula bar, its text selected to type over
    barSelect: async () => { await page.click('.ls-fx input'); await page.$eval('.ls-fx input', (e) => e.select()); },
    press: async (...keys) => { for (const k of keys) await page.keyboard.press(k); },
    chord: async (mod, k) => { await page.keyboard.down(mod); await page.keyboard.press(k); await page.keyboard.up(mod); },
    tool: (title) => page.evaluate((t) => { const b = [...document.querySelectorAll('.ls-bar button')].find((x) => x.title === t); b.click(); }, title),
    synced: async () => { await sleep(450); return page.evaluate(() => window.buf); },
    //  a clipboard event with this text, as the browser sends on paste
    paste: (text) => page.evaluate((t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text),
    copy: () => page.evaluate(() => {
      const dt = new DataTransfer();
      document.activeElement.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
      return dt.getData('text/plain');
    }),
  };
  return api;
}

console.log('==> typing and recalculation');
{
  const g = await open(corpus('02-formulas'));
  check.eq('the grid shows the cached values', await g.shown(1, 3), '5');
  await g.click(1, 0);
  check.eq('a click selects the cell', await g.addr(), 'A2');
  check.eq('the formula bar shows its content', await g.bar(), '2');
  await g.page.keyboard.type('20');
  check('typing opens the editor over the cell', await g.page.$eval('.ls-ed', (e) => !e.classList.contains('ls-idle') && e.value === '20'));
  await g.press('Enter');
  check.eq('Enter commits and moves down', await g.addr(), 'A3');
  check.eq('the formula that reads it is recomputed on screen', await g.shown(1, 3), '23');
  check.eq('and one further down that reads that formula', (await g.cell(0, 29, 3)).v, 275);
  const buf = await g.synced();
  check('the edit reaches the page buffer', buf.includes('office:value="20"') && buf !== corpus('02-formulas'));
  check('and the shell was told the page is dirty', await g.page.evaluate(() => window.changes > 0));
  await g.click(1, 3);
  check.eq('the bar shows a formula as it is typed', await g.bar(), '=A2+B2');
  await g.barSelect();
  await g.page.keyboard.type('=A2*B2+1');
  await g.press('Enter');
  check.eq('a formula edited in the bar is stored and computed', JSON.stringify(await g.cell(0, 1, 3)), JSON.stringify({ v: 61, f: 'of:=[.A2]*[.B2]+1', vt: 'float', text: '61' }));
  await g.click(2, 4);
  await g.page.keyboard.type('=SUM(A2:A5');
  await g.press('Enter');
  check('a formula that cannot be read is refused with a note', /cannot be read/.test(await g.note()) && (await g.cell(0, 2, 4)).f === null);
  await g.click(3, 4);
  await g.page.keyboard.type('=IF(AND(A2>1,B2<10),"yes","no")');
  await g.press('Tab');
  check.eq('logic functions work, and Tab moves right', (await g.shown(3, 4)) + ' ' + (await g.addr()), 'yes F4');
  await g.click(4, 4);
  await g.page.keyboard.type('abc');
  await g.press('Escape');
  check('Escape abandons the edit', (await g.cell(0, 4, 4)).vt === null);
  await g.click(1, 2);
  await g.click(1, 2);
  check('a double click opens the editor with the content', await g.page.$eval('.ls-ed', (e) => e.value === 'a+b' && !e.classList.contains('ls-idle')));
  await g.press('Escape');
  await g.page.close();
}

console.log('==> keyboard, ranges, clipboard');
{
  const g = await open(corpus('02-formulas'));
  await g.click(1, 0);
  await g.press('ArrowDown', 'ArrowRight');
  check.eq('arrows move', await g.addr(), 'B3');
  await g.page.keyboard.down('Shift');
  await g.press('ArrowDown', 'ArrowDown', 'ArrowLeft');
  await g.page.keyboard.up('Shift');
  check.eq('Shift and arrows select a range', await g.addr(), 'B3:A5');
  check('the range is drawn', await g.page.$eval('.ls-sel', (e) => e.style.display !== 'none' && parseFloat(e.style.height) > 60));
  await g.press('Delete');
  check('Delete clears the range, in one step', (await g.cell(0, 2, 0)).vt === null && (await g.cell(0, 4, 1)).vt === null && (await g.cell(0, 1, 0)).v === 2);
  check.eq('and what read those cells is recomputed', (await g.cell(0, 2, 3)).v, 0);
  await g.chord('Control', 'z');
  check.eq('one undo brings the range back', (await g.cell(0, 2, 0)).v + ' ' + (await g.cell(0, 4, 1)).v + ' ' + (await g.cell(0, 2, 3)).v, '10 8 6');
  await g.chord('Control', 'y');
  check('redo clears it again', (await g.cell(0, 2, 0)).vt === null);
  await g.chord('Control', 'z');
  await g.click(1, 3);
  const tsv = await g.copy();
  check.eq('copy puts the shown text on the clipboard', tsv, '5');
  await g.click(1, 5);
  await g.paste(tsv);
  check.eq("a paste of lattice's own copy carries the formula, its references moved", (await g.cell(0, 1, 5)).f, 'of:=[.C2]+[.D2]');
  await g.page.evaluate(() => window.ctl.select(0, 40, 0));
  await g.paste('1\t2\t=A1\n3\t4\thello');
  check.eq('a pasted table fills cells', [(await g.cell(0, 40, 0)).v, (await g.cell(0, 40, 1)).v, (await g.cell(0, 41, 0)).v, (await g.cell(0, 41, 2)).v].join(), '1,2,3,hello');
  check('pasted text that starts with = is kept as text, not run', (await g.cell(0, 40, 2)).f === null && (await g.cell(0, 40, 2)).v === '=A1');
  await g.page.evaluate(() => window.ctl.select(0, 0, 0));
  await g.chord('Control', 'End');
  check.eq('Ctrl+End goes to the last used cell', await g.addr(), 'F42');
  await g.chord('Control', 'Home');
  check.eq('Ctrl+Home goes home', await g.addr(), 'A1');
  await g.page.close();
}

console.log('==> the toolbar');
{
  const g = await open(corpus('06-formats'));
  check('a bold cell is drawn bold', await g.page.$eval('.ls-c[data-r="0"][data-c="0"]', (e) => e.style.fontWeight === '700'));
  await g.click(1, 0);
  await g.tool('Bold');
  check('Bold makes the cell bold and lights its button', await g.page.evaluate(() => window.ctl.book.look(0, 1, 0).bold && [...document.querySelectorAll('.ls-bar button')].find((b) => b.title === 'Bold').classList.contains('on')));
  await g.click(2, 0);
  await g.page.select('.ls-bar select', 'currency');
  check.eq('a number format rewrites the shown text', await g.shown(2, 0), '$1.00');
  await g.tool('Align centre');
  check('alignment is applied', await g.page.$eval('.ls-c[data-r="2"][data-c="0"]', (e) => e.classList.contains('ls-mid')));
  const buf = await g.synced();
  check('formatting reaches the buffer as styles', /<style:style style:name="Lce[0-9a-f]{8}"/.test(buf) && /<number:currency-style style:name="Ln[0-9a-f]{8}"/.test(buf));
  await g.page.close();
}
{
  const g = await open(corpus('02-formulas'));
  await g.click(3, 0);
  await g.tool('Insert a row below');
  check.eq('a row inserted below pushes the formulas down, respelled', (await g.cell(0, 5, 3)).f, 'of:=[.A6]/[.B6]');
  check.eq('and the sum over them grew', (await g.cell(0, 20, 3)).f, 'of:=SUM([.A2:.A19])');
  await g.click(4, 0);
  await g.tool('Delete the selected rows');
  check.eq('deleting it puts them back', (await g.cell(0, 4, 3)).f + ' ' + (await g.cell(0, 19, 3)).f, 'of:=[.A5]/[.B5] of:=SUM([.A2:.A18])');
  await g.click(0, 1);
  await g.tool('Insert a column to the right');
  check.eq('a column inserted moves references across', (await g.cell(0, 1, 4)).f, 'of:=[.A2]+[.B2]');
  const hdr = await g.page.$('.ls-h[data-row="2"]');
  await hdr.click({ button: 'right' });
  check('a right click on a row header opens the row menu', await g.page.$$eval('.ls-menu button', (b) => b.map((x) => x.textContent).join('|')) === 'Insert row above|Insert row below|Delete row');
  await g.page.evaluate(() => [...document.querySelectorAll('.ls-menu button')].find((b) => b.textContent === 'Insert row above').click());
  check('and its item inserts', (await g.cell(0, 2, 0)).vt === null && (await g.cell(0, 3, 0)).v === 10);
  await g.page.close();
}

console.log('==> refusals');
{
  const g = await open(corpus('08-opaque'));
  const before = await g.page.evaluate(() => window.ctl.text());
  await g.click(1, 0);
  await g.tool('Insert a row below');
  check('a sheet with a pivot table refuses a new row, and says why', /pivot table/.test(await g.note()));
  check('and nothing changed', before === await g.page.evaluate(() => window.ctl.text()));
  await g.page.close();
  const m = await open(corpus('04-merged'));
  //  B1 is under the merged A1:C1: a click where it would be
  const mb = await (await m.page.$('.ls-c[data-r="0"][data-c="0"]')).boundingBox();
  await m.page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
  check.eq('a click on a covered cell selects the merged cell', await m.addr(), 'A1');
  check('a merged cell is drawn across its span', await m.page.$eval('.ls-c[data-r="0"][data-c="0"]', (e) => parseFloat(e.style.width) > 200));
  await m.page.close();
}

console.log('==> sheets');
{
  const g = await open(corpus('05-sheets'));
  check.eq('one tab per sheet, and one to add', await g.page.$$eval('.ls-tabs button', (b) => b.map((x) => x.textContent).join('|')), "Data|My Sheet|It's|+");
  await g.page.evaluate(() => document.querySelectorAll('.ls-tabs button')[1].click());
  check.eq('a tab shows its sheet', await g.shown(0, 1), '6');
  await g.page.evaluate(() => document.querySelectorAll('.ls-tabs button')[0].click());
  await g.click(1, 0);
  await g.page.keyboard.type('10');
  await g.press('Enter');
  await g.page.evaluate(() => document.querySelectorAll('.ls-tabs button')[2].click());
  check.eq('an edit on one sheet recomputes another', await g.shown(0, 1), '40');
  await g.page.evaluate(() => [...document.querySelectorAll('.ls-tabs button')].pop().click());
  check.eq('+ adds a sheet and shows it', await g.page.$$eval('.ls-tabs button', (b) => b.map((x) => x.textContent + (x.classList.contains('on') ? '*' : '')).join('|')), "Data|My Sheet|It's|Sheet4*|+");
  await g.click(0, 0);
  await g.page.keyboard.type('=Data.A2*2');
  await g.press('Enter');
  check.eq('a formula on it reads the first sheet', await g.shown(0, 0), '20');
  check('the outline lists the sheets', await g.page.evaluate(() => window.LatSheet.extract.outline(window.ctl.text()).map((o) => o.text).join('|')) === "Data|My Sheet|It's|Sheet4");
  await g.page.close();
}

console.log('==> read-only');
{
  const g = await open(corpus('02-formulas'), { editable: false });
  await g.click(1, 0);
  await g.page.keyboard.type('99');
  await g.press('Enter');
  check('a read-only mount takes no typing', (await g.cell(0, 1, 0)).v === 2);
  check('and its toolbar is off', await g.page.$$eval('.ls-bar button', (b) => b.filter((x) => !x.dataset.always).every((x) => x.disabled)));
  check('the downloads stay on', await g.page.$$eval('.ls-bar button', (b) => b.filter((x) => x.dataset.always).length === 2 && b.filter((x) => x.dataset.always).every((x) => !x.disabled)));
  await g.page.evaluate(() => window.ctl.setEditable(true));
  await sleep(500);        // not a double click on the cell just clicked
  await g.click(1, 0);
  await g.page.keyboard.type('99');
  await g.press('Enter');
  check('setEditable turns editing on', (await g.cell(0, 1, 0)).v === 99);
  await g.page.close();
  //  a real file over the cap: the large corpus sheet, three times over
  const big = corpus('10-large');
  const rows = big.slice(big.indexOf('<table:table-row'), big.lastIndexOf('</table:table>'));
  const huge = big.replace('</table:table>', rows + rows + '</table:table>');
  const h = await open(huge);
  check('a file over 2 MB opens', huge.length > 2 * 1024 * 1024 && await h.shown(1, 0) === '1');
  check('with a note that it is not editable here', /large/.test(await h.page.$eval('.ls-note.ls-ro span', (e) => e.textContent)));
  await h.click(1, 1);
  await h.page.keyboard.type('5');
  await h.press('Enter');
  check('and takes no edit', (await h.cell(0, 1, 1)).v !== 5);
  await h.page.close();
}

console.log('==> render and export');
{
  const g = await open(corpus('09-i18n'));
  const html = await g.page.evaluate(() => window.LatSheet.render(window.ctl.text()));
  check('render gives a document with a table', /<body class="fods"><h3>Texte<\/h3><table>/.test(html));
  check('cell markup is escaped', html.includes('&lt;b&gt;') && !/<b>|<script/i.test(html.replace(/<br>/g, '')));
  const hostile = corpus('09-i18n').replace('table:name="Texte"', 'table:name="&lt;img src=x onerror=alert(1)&gt;"').replace('<text:p>emoji</text:p>', '<text:p>&lt;script&gt;alert(2)&lt;/script&gt;</text:p>');
  const bad = await g.page.evaluate((t) => window.LatSheet.render(t), hostile);
  check('a hostile sheet name and cell come out as text', bad.includes('&lt;img src=x onerror=alert(1)&gt;') && bad.includes('&lt;script&gt;alert(2)') && !/<img|<script/i.test(bad));
  check('show() of something that is not a spreadsheet says so', await g.page.evaluate(() => window.LatSheet.show('<office:document/>')) === 'This spreadsheet cannot be shown here.');
  const csv = await g.page.evaluate(() => window.LatSheet.exportCsv(window.ctl.text(), 0).text);
  check('CSV export quotes what needs it', csv.includes('"a < b && c > ""d"" \'e\'"') && csv.includes('français,naïve café,日本語のセル'));
  const guarded = await g.page.evaluate(() => {
    const b = new window.LatSheet.core.Book(window.LatSheet.blank);
    b.enter(0, 0, 0, "'=cmd|x");
    b.enter(0, 0, 1, '=1+1');
    b.enter(0, 0, 2, "'-5 apples");
    return window.LatSheet.exportCsv(b.text(), 0).text;
  });
  check.eq('CSV export disarms text that starts like a formula', guarded.trim(), "'=cmd|x,2,'-5 apples");
  const back = await g.page.evaluate(() => {
    const r = window.LatSheet.importCsv('name,qty\n"Smith, J",3\n=SUM(B2:B2),"line\nbreak"\n');
    const b = new window.LatSheet.core.Book(r.text);
    return [b.cell(0, 1, 0).v, b.cell(0, 1, 1).v, b.cell(0, 2, 0).f, b.cell(0, 2, 0).v, b.cell(0, 2, 1).v].join('|');
  });
  check.eq('CSV import reads quotes, and keeps a formula as text', back, 'Smith, J|3||=SUM(B2:B2)|line\nbreak');
  const ods = await g.page.evaluate(async () => {
    const e = window.LatSheet.exportOds(window.ctl.text());
    if (e.error) return e.error;
    const r = await window.LatSheet.importOds(await e.blob.arrayBuffer());
    if (r.error) return r.error;
    const b = new window.LatSheet.core.Book(r.text);
    return b.error || [b.sheets[0].name, b.cell(0, 0, 2).text, b.cell(0, 6, 1).f].join('|');
  });
  check.eq('.ods out and back in keeps the sheet', ods, 'Texte|日本語のセル|of:="<b>"&[.B3]&"</b>"');
  const real = readFileSync(join(root, 'tests', 'sheet', 'corpus', '02-formulas.ods')).toString('base64');
  const lo = await g.page.evaluate(async (b64) => {
    const u8 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const r = await window.LatSheet.importOds(u8.buffer);
    if (r.error) return r.error;
    const b = new window.LatSheet.core.Book(r.text);
    return b.error || [b.sheets[0].name, b.cell(0, 1, 3).f, b.cell(0, 1, 3).v, b.cell(0, 19, 3).v].join('|');
  }, real);
  check.eq("an .ods LibreOffice saved imports with its formulas and values", lo, 'Calc|of:=[.A2]+[.B2]|5|106');
  await g.page.close();
}

console.log('==> a phone');
{
  const g = await open(corpus('02-formulas'), { viewport: { width: 390, height: 700 }, touch: true });
  const h = await g.page.$('.ls-c[data-r="2"][data-c="1"]');
  const b = await h.boundingBox();
  await g.page.touchscreen.tap(b.x + 10, b.y + 10);
  check.eq('a tap selects', await g.addr(), 'B3');
  check('without opening the cell editor', await g.page.$eval('.ls-ed', (e) => e.classList.contains('ls-idle') && document.activeElement !== e));
  check('the toolbar wraps inside the screen', await g.page.$eval('.ls-bar', (e) => e.scrollWidth <= 392));
  await g.barSelect();
  await g.page.keyboard.type('7');
  await g.press('Enter');
  check.eq('the formula bar edits the tapped cell', (await g.cell(0, 2, 1)).v, 7);
  await g.page.close();
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
check.done();
