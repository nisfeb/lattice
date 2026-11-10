#!/usr/bin/env node
//  sheet-unit.mjs: the spreadsheet core, in pure node. No ship, no
//  LibreOffice at run time: the corpus and the oracle are files
//  LibreOffice wrote (scripts/sheet-corpus/), so its results are the
//  reference here.
//
//    1. No-op.    Every corpus file parses and serializes byte-identical.
//    2. Corpus.   Every corpus formula, recomputed, gives the result
//                 LibreOffice cached, and its spelling survives being
//                 shown to a person and typed back.
//    3. Oracle.   The same for the 337 formulas of tests/sheet/oracle,
//                 and lattice's translation of each typed formula is the
//                 stored spelling LibreOffice gave it.
//    4. Edits.    Typed values, minimal diffs, repeated runs, formats,
//                 rows and columns moved with their references, the
//                 refusals, undo.
//    5. Hostile.  Repeat bombs, entities, depth: refused or handled fast.
//
//  Usage: node scripts/sheet-unit.mjs
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { makeCheck } from './lib/check.mjs';
import { parseFods, serializeFods, cellAt, extent, rowCount } from '../ui-src/sheet/model.js';
import { Engine, cellValue } from '../ui-src/sheet/engine.js';
import { Err, Unsupported, general } from '../ui-src/sheet/funcs.js';
import { toUser, toOf, moveFormula, moveAddrs, offsetFormula, parseAddrs, colName, colIndex } from '../ui-src/sheet/formula.js';
import { Book, readTyped } from '../ui-src/sheet/book.js';
import { fixed } from '../ui-src/sheet/styles.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'tests', 'sheet');
const check = makeCheck();
const corpus = (n) => readFileSync(join(dir, 'corpus', n + '.fods'), 'utf8');
const names = readdirSync(join(dir, 'corpus')).filter((f) => f.endsWith('.fods')).map((f) => f.slice(0, -5)).sort();

const show = (v) => (v instanceof Err ? v.code : JSON.stringify(v));
//  lattice's result against the cell LibreOffice cached
function agrees(got, cell) {
  const want = cellValue(cell);
  if (typeof got === 'boolean' && typeof want === 'number') got = got ? 1 : 0;
  if (got === null) return want === 0 && cell.text === '';
  if (want instanceof Err) return got instanceof Err && got.code === want.code;
  if (typeof want === 'number') return typeof got === 'number' && Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want));
  if ((want === null || want === '') && got === '') return true;
  return got === want;
}
//  spellings that differ only in spaces or in how a number is written
const loose = (f) => f.replace(/ /g, '').replace(/\d[\d.]*(?:E[+-]?\d+)?/gi, (m) => String(Number(Number(m).toPrecision(15))));

function formulas(text, label, only) {
  const doc = parseFods(text);
  const eng = new Engine(doc, (s, r, c, v) => general(v));
  let n = 0, wrong = 0, unsup = 0, spelt = 0;
  const first = [];
  for (const e of eng.formulas) {
    if (only && !only(e)) continue;
    n++;
    const cell = cellAt(doc.sheets[e.s], e.r, e.c);
    let got;
    try { got = eng.evaluate(e.f, e.s, e.r, e.c); } catch (x) {
      if (!(x instanceof Unsupported)) throw x;
      unsup++;
      continue;
    }
    if (!agrees(got, cell)) { wrong++; if (first.length < 5) first.push(`${e.f} want ${show(cellValue(cell))} got ${show(got)}`); }
    let back;
    try { back = toOf(toUser(e.f)); } catch (x) { back = 'threw: ' + x.message; }
    if (loose(back) !== loose(e.f)) { spelt++; if (first.length < 5) first.push(`${e.f} typed back as ${back}`); }
  }
  check(`${label}: ${n} formulas give LibreOffice's results`, wrong === 0, first.join(' | '));
  check(`${label}: every formula survives being shown and typed back`, spelt === 0, first.join(' | '));
  return { n, unsup, doc, eng };
}

console.log('==> no-op round trip');
for (const n of names) {
  const text = corpus(n);
  const doc = parseFods(text);
  check(`${n}: parses`, !doc.error, doc.error);
  if (!doc.error) check(`${n}: serializes byte-identical`, serializeFods(doc) === text);
  if (!doc.error) check(`${n}: a Book that was not edited gives the same text`, new Book(text).text() === text);
}

console.log('==> corpus formulas against LibreOffice');
let total = 0;
for (const n of names) {
  if (!corpus(n).includes('table:formula')) continue;
  const r = formulas(corpus(n), n);
  total += r.n;
  if (n === '02-formulas') check('02-formulas: only the unknown function is left to LibreOffice', r.unsup === 1, String(r.unsup));
  else check(`${n}: nothing is left to LibreOffice`, r.unsup === 0, String(r.unsup));
}
check('the corpus holds over a thousand formulas', total > 1000, String(total));

console.log('==> the oracle');
{
  const text = readFileSync(join(dir, 'oracle', 'oracle.fods'), 'utf8');
  const typed = readFileSync(join(dir, 'oracle', 'typed.txt'), 'utf8').trim().split('\n');
  const r = formulas(text, 'oracle', (e) => e.c === 5);
  check('oracle: every typed formula is in the sheet', r.n === typed.length, `${r.n} of ${typed.length}`);
  check('oracle: nothing is left to LibreOffice', r.unsup === 0, String(r.unsup));
  let off = 0;
  const first = [];
  typed.forEach((t, i) => {
    const stored = cellAt(r.doc.sheets[0], i, 5).f;
    let mine;
    try { mine = toOf('=' + t); } catch (x) { mine = 'threw: ' + x.message; }
    if (loose(mine) !== loose(stored)) { off++; if (first.length < 5) first.push(`=${t} gave ${mine}, LibreOffice ${stored}`); }
  });
  check('oracle: lattice stores a typed formula as LibreOffice does', off === 0, first.join(' | '));
}

console.log('==> spellings and addresses');
check.eq('colName', [0, 25, 26, 701, 702, 16383].map(colName).join(), 'A,Z,AA,ZZ,AAA,XFD');
check.eq('colIndex', ['A', 'Z', 'AA', 'XFD'].map(colIndex).join(), '0,25,26,16383');
check.eq('toOf: separators, sheets, absolutes', toOf("=SUM(A1:B2, $C$3; 'My Sheet'.D4, Data!E5)"), "of:=SUM([.A1:.B2];[.$C$3];[$'My Sheet'.D4];[Data.E5])".replace("[$'My", "['My"));
check.eq('toUser', toUser("of:=IF([.A1]>=2;\"x\"\"y\";[$'It''s'.B2])"), "=IF(A1>=2,\"x\"\"y\",$'It''s'.B2)");
check.eq('toUser: whole columns and rows', toUser('of:=SUM([.A:.A])+SUM([.2:.3])'), '=SUM(A:A)+SUM(2:3)');
check.eq('toOf: whole columns', toOf('=SUM(A:A)'), 'of:=SUM([.A:.A])');
check.eq('toOf: a function name that looks like a cell', toOf('=LOG10(100)+A1'), 'of:=LOG10(100)+[.A1]');
check.eq('toOf: newer functions get their stored prefix', toOf('=IFS(A1>1,"a")'), 'of:=COM.MICROSOFT.IFS([.A1]>1;"a")');
check.eq('toUser: and lose it again', toUser('of:=COM.MICROSOFT.IFS([.A1]>1;"a")'), '=IFS(A1>1,"a")');
check.eq('toUser: a formula lattice cannot read is shown as stored', toUser('of:={1;2|3;4}'), '={1;2|3;4}');
check('toOf: refuses what it cannot read', (() => { try { toOf('=1+'); return false; } catch { return true; } })());
const op = (dim, at, n) => ({ sheet: 'S', dim, at, n });
check.eq('insert rows moves a reference below', moveFormula('of:=[.A1]+[.A5]+[.$B$7]', 'S', op('r', 3, 2)), 'of:=[.A1]+[.A7]+[.$B$9]');
check.eq('insert rows grows a range across it', moveFormula('of:=SUM([.A2:.A9])', 'S', op('r', 4, 3)), 'of:=SUM([.A2:.A12])');
check.eq('delete rows shrinks a range', moveFormula('of:=SUM([.A2:.A9])', 'S', op('r', 3, -2)), 'of:=SUM([.A2:.A7])');
check.eq('delete rows clips a range end', moveFormula('of:=SUM([.A2:.A9])', 'S', op('r', 7, -5)), 'of:=SUM([.A2:.A7])');
check.eq('delete rows kills a reference inside', moveFormula('of:=[.A4]*2', 'S', op('r', 3, -1)), 'of:=#REF!*2');
check.eq('delete rows kills a range wholly inside', moveFormula('of:=SUM([.A4:.A5])', 'S', op('r', 3, -2)), 'of:=SUM(#REF!)');
check.eq('insert columns', moveFormula('of:=[.B1]+[.A1]+SUM([.A1:.C1])', 'S', op('c', 1, 1)), 'of:=[.C1]+[.A1]+SUM([.A1:.D1])');
check.eq('another sheet is left alone', moveFormula('of:=[.A5]+[$T.A5]', 'S', op('r', 0, 1)), 'of:=[.A6]+[$T.A5]');
check.eq('a formula on another sheet follows its named sheet', moveFormula('of:=[.A5]+[$S.A5]', 'T', op('r', 0, 1)), 'of:=[.A5]+[$S.A6]');
check.eq('whole columns move with columns, not rows', moveFormula('of:=SUM([.C:.C])', 'S', op('c', 0, 2)) + moveFormula('of:=SUM([.C:.C])', 'S', op('r', 0, 2)), 'of:=SUM([.E:.E])of:=SUM([.C:.C])');
check.eq('nothing moved gives the same string', moveFormula('of:=[.A1]  +  1', 'S', op('r', 5, 1)), 'of:=[.A1]  +  1');
check.eq('only the references are respelled', moveFormula('of:=IF( [.A9]>1 ; "a;b" ; 2 )', 'S', op('r', 0, 1)), 'of:=IF( [.A10]>1 ; "a;b" ; 2 )');
check('an unreadable formula is not moved', moveFormula('of:={1;2}+[.A1]', 'S', op('r', 0, 1)) === null);
check.eq('moveAddrs', moveAddrs('$S.$B$2:.$B$5 S.A1:S.C9', op('r', 3, 1)), '$S.$B$2:.$B$6 S.A1:S.C10');
check.eq("moveAddrs: another sheet's addresses stay", moveAddrs("'My Sheet'.A1:'My Sheet'.C5", op('r', 0, 1)), "'My Sheet'.A1:'My Sheet'.C5");
check('parseAddrs refuses what is not an address', parseAddrs('hello') === null);
check.eq('offsetFormula moves relative parts only', offsetFormula('of:=[.A1]+[.$A1]+[.A$1]+[.$A$1]', 2, 3), 'of:=[.D3]+[.$A3]+[.D$1]+[.$A$1]');
check.eq('offsetFormula off the edge is #REF!', offsetFormula('of:=[.A1]', -1, 0), 'of:=#REF!');

console.log('==> numbers as text');
check.eq('general', [0, 1, -1.5, 1 / 3, 0.1 + 0.2, 1e15, 1e17, 1.23456789012345678e17, 1e-10, 123456789012].map(general).join(' '),
  '0 1 -1.5 0.333333333333333 0.3 1000000000000000 1E+017 1.23456789012346E+017 0.0000000001 123456789012');
check.eq('fixed', [fixed(1.005, 2), fixed(-0.004, 2), fixed(1234567.891, 2, 1, true), fixed(2.5, 0), fixed(0.5, 0, 0)].join(' '), '1.01 0.00 1,234,567.89 3 1');
const t = (s) => { const r = readTyped(s, 0); return r.vt + ':' + r.v; };
check.eq('readTyped', ['12', '-1,234.5', '1e3', '12.5%', '$1,234.50', 'true', "'007", 'hello', '1.2.3', '', '13:45', '.5'].map(t).join(' | '),
  'float:12 | float:-1234.5 | float:1000 | percentage:0.125 | currency:1234.5 | boolean:true | string:007 | string:hello | string:1.2.3 | null:null | time:0.5729166666666666 | float:0.5');

console.log('==> edits');
{
  const text = corpus('10-large');
  const b = new Book(text);
  const r = b.enter(0, 5, 1, '1000');
  const out = b.text();
  const a = text.split('\n'), z = out.split('\n');
  let diff = 0;
  for (let i = 0; i < Math.max(a.length, z.length); i++) if (a[i] !== z[i]) diff++;
  check('one typed number changes a handful of lines of 1,200 rows', a.length === z.length && diff > 0 && diff <= 8, `${diff} lines`);
  check('and recomputes its row total and both sums', r.changed.length === 4, JSON.stringify(r.changed));
  check.eq('the row total', b.cell(0, 5, 3).v, 1000 * b.cell(0, 5, 2).v);
  check('what lattice wrote parses again and round-trips', (() => { const d = parseFods(out); return !d.error && serializeFods(d) === out; })());
}
{
  const text = corpus('02-formulas');
  const b = new Book(text);
  b.mark();
  b.enter(0, 1, 0, '20');
  check.eq('a+b follows its input', b.cell(0, 1, 3).v, 23);
  check.eq('and so does a formula that reads that formula', b.cell(0, 29, 3).v, 23 + b.cell(0, 2, 3).v * b.cell(0, 3, 3).v);
  check('the unknown function is reported stale, its cached value kept', b.cell(0, 37, 3).text === '#NAME?');
  const e = b.enter(0, 2, 2, '=A2+');
  check('a formula that cannot be read is refused', !!e.error && b.cell(0, 2, 2).text === 'a-b', e.error);
  b.enter(0, 40, 0, '=SUM(A2:A10)&" total"');
  check.eq('a new formula is computed', b.cell(0, 40, 0).text, '100 total');
  b.enter(0, 41, 0, '=NOSUCH(1)');
  check('a formula lattice cannot evaluate is kept, with no value, and marked', b.cell(0, 41, 0).f === 'of:=NOSUCH(1)' && b.cell(0, 41, 0).vt === null && b.stale(0, 41, 0));
  b.enter(0, 42, 0, '=A43');
  b.enter(0, 42, 0, '=A43+1');
  b.enter(0, 43, 0, '=A43');
  check.eq('a formula that reads itself is a cycle error', b.cell(0, 43, 0).text, 'Err:522');
  b.enter(0, 44, 0, '=A2>1');
  check('a typed comparison is stored as a boolean', b.cell(0, 44, 0).vt === 'boolean' && b.cell(0, 44, 0).text === 'TRUE');
  check.eq('input shows a formula as typed', b.input(0, 1, 3), '=A2+B2');
  b.enter(0, 44, 1, '=DATE(2026,11,10)');
  check.eq('a typed formula that makes a date is shown as one', b.cell(0, 44, 1).vt + ' ' + b.cell(0, 44, 1).text, 'date 2026-11-10');
  b.enter(0, 44, 2, '=TIME(13,30,0)');
  check.eq('and one that makes a time, as a time', b.cell(0, 44, 2).vt + ' ' + b.cell(0, 44, 2).text, 'time 13:30:00');
  b.enter(0, 44, 3, '=YEAR(B45)+1');
  check.eq('and a formula reads the date as its day number', b.cell(0, 44, 3).v, 2027);
  b.enter(0, 45, 0, "'=not a formula");
  check.eq('an apostrophe makes text of anything', b.cell(0, 45, 0).v + '|' + b.input(0, 45, 0), "=not a formula|'=not a formula");
  b.enter(0, 46, 0, '25%');
  check('a typed percent gets a percent format', b.cell(0, 46, 0).vt === 'percentage' && b.cell(0, 46, 0).text === '25.00%' && b.text().includes('<number:percentage-style style:name="Ln'));
  b.enter(0, 46, 0, '50');
  check.eq('a plain number typed over a percent is a percent', b.cell(0, 46, 0).v + ' ' + b.cell(0, 46, 0).text, '0.5 50.00%');
  b.enter(0, 46, 1, '10%');
  check('the same formatting twice makes one style', b.text().split('<number:percentage-style style:name="Ln').length === 2);
  b.enter(0, 1, 0, '');
  check('clearing a cell empties it and keeps the row', b.cell(0, 1, 0).vt === null && b.cell(0, 1, 3).v === 3);
  const again = parseFods(b.text());
  check('the edited text parses and round-trips', !again.error && serializeFods(again) === b.text(), again.error);
  b.undo();
  check('undo goes back to the bytes it started from', b.text() === text);
  check('redo comes forward again', b.redo() && b.cell(0, 46, 1).text === '10.00%');
}
{
  const text = corpus('03-repeats');
  const b = new Book(text);
  b.enter(0, 2, 0, 'in a repeated row');
  check.eq('a repeated row splits around the edit', b.sheets[0].rows.map((r) => r.rep).join(), '1,1,1,2,1,20,1,1');
  b.enter(0, 0, 1, 'mid');
  check.eq('a repeated cell splits around the edit', [0, 1, 2].map((c) => b.cell(0, 0, c).text).join(), 'x,mid,x');
  b.enter(0, 300, 2, 'far');
  check('typing past the last row grows the sheet with one repeated gap', rowCount(b.sheets[0]) === 301 && b.sheets[0].rows.length === 10);
  const d = parseFods(b.text());
  check.eq('and reads back', [cellAt(d.sheets[0], 2, 0).text, cellAt(d.sheets[0], 3, 0).text, cellAt(d.sheets[0], 300, 2).text, cellAt(d.sheets[0], 26, 0).text].join(), 'in a repeated row,,far,far');
  check.eq('the extent ignores trailing empty runs', extent(parseFods(text).sheets[0]).join(), '28,31');
}
{
  const text = corpus('02-formulas');
  const b = new Book(text);
  check('insert rows', b.shift(0, 'r', 3, 2).ok);
  check.eq('a row below moved down with its formula respelled', b.cell(0, 5, 3).f + ' ' + b.cell(0, 5, 3).v, 'of:=[.A6]*[.B6] 42');
  check.eq('the sum range grew and its value did not change', b.cell(0, 21, 3).f + ' ' + b.cell(0, 21, 3).v, 'of:=SUM([.A2:.A20]) 106');
  check('delete those rows again', b.shift(0, 'r', 3, -2).ok);
  const strip = (s) => s.replace(/\s+/g, '');
  check('and the cells are what they were', (() => {
    const d = parseFods(text).sheets[0];
    for (let r = 0; r < 38; r++) for (let c = 0; c < 4; c++) { const x = cellAt(d, r, c), y = b.cell(0, r, c); if (x.f !== y.f || strip(x.text) !== strip(y.text)) return false; }
    return true;
  })());
  check('delete a row a sum reads', b.shift(0, 'r', 4, -1).ok);
  check.eq('the sum is computed again', b.cell(0, 18, 3).f + ' ' + b.cell(0, 18, 3).v, 'of:=SUM([.A2:.A17]) 105');
  check('delete a column formulas read', b.shift(0, 'c', 0, -1).ok);
  check.eq('they point at nothing now', b.cell(0, 1, 2).f + ' ' + b.cell(0, 1, 2).text, 'of:=#REF!+[.A2] #REF!');
}
{
  const b = new Book(corpus('07-ranges'));
  check('insert a row above a named range, a filter and a conditional format', b.shift(0, 'r', 2, 1).ok);
  const out = b.text();
  check('the named range moved', out.includes('table:cell-range-address="$Ranges.$B$2:.$B$6"'));
  check('the filter range moved', out.includes('table:target-range-address="Ranges.A1:Ranges.C6"'));
  check('the print range moved', out.includes('table:print-ranges="Ranges.A1:Ranges.C7"'));
  check('the conditional format moved', out.includes('calcext:target-range-address="Ranges.B2:Ranges.B6"'));
  check.eq('SUM over the named range still adds up', b.cell(0, 6, 1).v, 16);
  b.enter(0, 2, 1, '100');
  check.eq('and takes in the new row', b.cell(0, 6, 1).v, 116);
  check.eq('a named expression is read', b.cell(0, 1, 2).v, 1.2);
}
{
  const b = new Book(corpus('08-opaque'));
  const r = b.shift(0, 'r', 1, 1);
  check('a sheet with a pivot table refuses to move rows, and says why', /pivot table/.test(r.error || ''), r.error);
  check('and nothing changed', b.text() === corpus('08-opaque'));
  b.enter(0, 1, 1, '10');
  check('cells are still editable there', b.cell(0, 5, 1).v === 19);
  const out = b.text();
  check('the comment, the shape, the pivot table and the macro are still in the file',
    ['<office:annotation', '<draw:rect', '<table:data-pilot-table ', 'MsgBox'].every((x) => out.includes(x)));
}
{
  const b = new Book(corpus('04-merged'));
  check('an insert that would cut a merged cell is refused', /merged/.test(b.shift(0, 'r', 2, 1).error || ''));
  check('an insert below the merges is fine', b.shift(0, 'r', 5, 1).ok);
  check('a column insert through a merge is refused', /merged/.test(b.shift(0, 'c', 1, 1).error || ''));
  check('typing into a covered cell is refused', /merged/.test(b.enter(0, 0, 1, 'x').error || ''));
}
{
  const b = new Book(corpus('05-sheets'));
  b.enter(0, 1, 0, '10');
  check.eq('an edit recomputes across sheets, two deep', b.cell(1, 0, 1).v + ' ' + b.cell(1, 1, 1).v + ' ' + b.cell(2, 0, 1).v + ' ' + b.cell(2, 1, 1).v, '15 30 40 41');
  check('insert a row on the data sheet', b.shift(0, 'r', 1, 1).ok);
  check.eq("the other sheets' formulas follow", b.cell(1, 0, 1).f + ' ' + b.cell(2, 0, 1).f, "of:=SUM([$Data.A3:.A5]) of:=[$'My Sheet'.B2]+[$Data.A3]");
  const a = b.addSheet('');
  check('a new sheet gets a free name', a.sheet === 3 && b.sheets[3].name === 'Sheet4');
  check('a duplicate name is refused', /already/.test(b.addSheet('data').error || ''));
  check('a name with a bad character is refused', !!b.addSheet('a/b').error);
  b.enter(3, 0, 0, "=Data.A3+'My Sheet'.B1");
  check.eq('a formula on the new sheet reads the others', b.cell(3, 0, 0).v, 25);
  const d = parseFods(b.text());
  check('four sheets read back', !d.error && d.sheets.length === 4 && serializeFods(d) === b.text());
}
{
  const text = corpus('06-formats');
  const b = new Book(text);
  check('the looks are read', b.look(0, 0, 0).bold && b.look(0, 0, 1).italic && b.look(0, 0, 2).align === 'center' && b.look(0, 1, 1).bg === '#ffff00');
  const had = b.styleAt(0, 0, 0);
  b.format(0, 0, 0, 0, 1, { bold: true });
  check('bold over a bold cell keeps its style', b.styleAt(0, 0, 0) === had, b.styleAt(0, 0, 0));
  check('bold over an italic cell is both', b.look(0, 0, 1).bold && b.look(0, 0, 1).italic);
  b.format(0, 2, 0, 2, 0, { number: 'currency' });
  check.eq('a currency format rewrites the shown text', b.cell(0, 2, 0).text + ' ' + b.cell(0, 2, 0).vt, '$1.00 currency');
  check('and keeps the cell bold', b.look(0, 2, 0).bold);
  b.format(0, 0, 0, 0, 0, { bold: false });
  check('bold comes off', !b.look(0, 0, 0).bold);
  const d = parseFods(b.text());
  check('formatting round-trips', !d.error && serializeFods(d) === b.text());
  const b2 = new Book(b.text());
  check('and reads back the same', b2.look(0, 0, 1).bold && b2.look(0, 0, 1).italic && b2.cell(0, 2, 0).text === '$1.00' && !b2.look(0, 0, 0).bold);
}

console.log('==> hostile input');
{
  const head = '<?xml version="1.0"?>\n<office:document xmlns:office="o" xmlns:table="t" xmlns:text="x" office:mimetype="application/vnd.oasis.opendocument.spreadsheet"><office:body><office:spreadsheet>';
  const tail = '</office:spreadsheet></office:body></office:document>';
  const bomb = head + '<table:table table:name="B"><table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="16384" office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>'
    + '<table:table-row><table:table-cell table:formula="of:=SUM([.A1:.XFD1048576])" office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell><table:table-cell table:formula="of:=SUM([.A1:.B3])"/></table:table-row></table:table>' + tail;
  const t0 = Date.now();
  const b = new Book(bomb);
  check('a repeat bomb opens', !b.error, b.error);
  const r = b.enter(0, 0, 0, '5');
  check('an edit inside it is fast', Date.now() - t0 < 4000, `${Date.now() - t0} ms`);
  check('the formula over 17 billion cells keeps its cached value and is marked', b.cell(0, 1048576 - 1 + 1, 0).v === 7 || b.stale(0, 1048576, 0), JSON.stringify(r).slice(0, 80));
  check('the row count is never over the sheet', rowCount(b.sheets[0]) <= 1048577);
  check('a repeat count of nonsense is one', parseFods(head + '<table:table table:name="B"><table:table-row table:number-rows-repeated="-5"><table:table-cell table:number-columns-repeated="x"/></table:table-row></table:table>' + tail).sheets[0].rows[0].rep === 1);
  check('an entity declaration is refused', !!parseFods('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]>' + head.slice(22) + tail).error);
  check('a Writer document is not a spreadsheet', /spreadsheet/.test(parseFods('<office:document xmlns:office="o"><office:body><office:text/></office:body></office:document>').error || ''));
  check('a spreadsheet with no sheet is refused', !!parseFods(head + tail).error);
  check('text that is not XML is refused', !!parseFods('hello').error);
  const deep = head + '<table:table table:name="B"><table:table-row><table:table-cell table:formula="of:=' + '('.repeat(500) + '1' + ')'.repeat(500) + '"/></table:table-row></table:table>' + tail;
  const bd = new Book(deep);
  check('a formula nested 500 deep is left alone, not crashed on', !bd.error && bd.enter(0, 0, 1, '1').changed.length === 1);
  const names = head + '<table:table table:name="A&amp;&lt;b&gt;&quot;"><table:table-row><table:table-cell office:value-type="string"><text:p>&lt;script&gt;alert(1)&lt;/script&gt;</text:p></table:table-cell></table:table-row></table:table>' + tail;
  const bn = new Book(names);
  check.eq('markup in a name and a cell is text', bn.sheets[0].name + ' ' + bn.cell(0, 0, 0).text, 'A&<b>" <script>alert(1)</script>');
  bn.enter(0, 0, 1, '<b>&"\'');
  check('and is escaped when written', bn.text().includes('<text:p>&lt;b&gt;&amp;"\'</text:p>'));
}

check.done();
