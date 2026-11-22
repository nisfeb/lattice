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
import { parseFods, serializeFods, cellAt, extent, rowCount, serialDate } from '../ui-src/sheet/model.js';
import { Engine, cellValue } from '../ui-src/sheet/engine.js';
import { Err, Unsupported, general } from '../ui-src/sheet/funcs.js';
import { toUser, toOf, moveFormula, moveRefs, moveAddrs, offsetFormula, cutFormula, parseAddrs, colName, colIndex } from '../ui-src/sheet/formula.js';
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
{
  //  a move: block C3:D4 on S, two rows down and one column right
  const blk = { r1: 2, c1: 2, r2: 3, c2: 3 };
  const cut = (f, to = 'S', dr = 2, dc = 1) => cutFormula(f, blk, dr, dc, 'S', to);
  check.eq('cutFormula leaves references outside the block as written', cut('of:=[.A1]+[.$A2]+[.A$3]+[.$A$4]+SUM([.A1:.B9])'), 'of:=[.A1]+[.$A2]+[.A$3]+[.$A$4]+SUM([.A1:.B9])');
  check.eq('cutFormula moves references into the block, absolute ones too', cut('of:=[.C3]+[.$D$4]+SUM([.C3:.D4])'), 'of:=[.D5]+[.$E$6]+SUM([.D5:.E6])');
  check.eq('a range that straddles the edge of the block stays', cut('of:=SUM([.B3:.D4])+SUM([.C3:.C9])'), 'of:=SUM([.B3:.D4])+SUM([.C3:.C9])');
  check.eq('another sheet is left alone, and a whole column', cut('of:=[$T.C3]+SUM([.C:.C])'), 'of:=[$T.C3]+SUM([.C:.C])');
  check.eq('moved to another sheet, outside references name the old sheet', cut('of:=[.A1]+SUM([.A1:.B2])+SUM([.A:.A])+[$S.A1]+[$T.A1]+[.C3]+[$S.D4]', 'T'), 'of:=[$S.A1]+SUM([$S.A1:.B2])+SUM([$S.A:.A])+[$S.A1]+[$T.A1]+[.D5]+[$T.E6]');
  check.eq('moved off the edge, an inside reference is #REF!', cut('of:=[.C3]+[.A1]', 'S', -3, 0), 'of:=#REF!+[.A1]');
  check('an unreadable formula is not guessed at', cut('of:={1;2}+[.C3]') === null);
}
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
  check('a formula that cannot be read is kept as the text typed, and says why', !e.error && /cannot be read/.test(e.note || '') && b.cell(0, 2, 2).v === '=A2+' && b.cell(0, 2, 2).f === null, JSON.stringify(e));
  check.eq('the bar shows it as typed, with no apostrophe put before it', b.input(0, 2, 2), '=A2+');
  check('it is saved as a text cell', b.text().includes('office:value-type="string" calcext:value-type="string">\n      <text:p>=A2+</text:p>'));
  check.eq('and reads back as that text', new Book(b.text()).cell(0, 2, 2).v, '=A2+');
  b.enter(0, 2, 2, '=A2+1');
  check('typed again with the fault put right, it is a formula', b.cell(0, 2, 2).f === 'of:=[.A2]+1' && b.cell(0, 2, 2).v === 21 && !b.cell(0, 2, 2).bad);
  b.enter(0, 2, 2, 'a-b');
  const deep = b.enter(0, 60, 0, '=' + '-'.repeat(200000) + '1');
  check('a formula too long to read is kept as text too, not thrown', !deep.error && b.cell(0, 60, 0).v.length === 200002 && /too long/.test(deep.note || ''), JSON.stringify(deep).slice(0, 90));
  b.enter(0, 60, 0, '');
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

console.log('==> the review of release 130');
{
  //  1. the walk budget is per formula, not per session
  const blank = readFileSync(join(here, '..', 'ui-src', 'sheet', 'blank.fods'), 'utf8');
  const b = new Book(blank);
  for (let r = 0; r < 1000; r++) b.enter(0, r, 0, String(r));
  b.enter(0, 0, 1, '=SUM(A1:A1000)');
  for (let i = 0; i < 5600; i++) b.enter(0, 0, 0, String(i % 7));
  b.enter(0, 0, 0, '1000');
  check.eq('a sum still follows its range after 5,600 edits in one session', b.cell(0, 0, 1).v, 499500 + 1000);
  check('and is not marked stale', !b.stale(0, 0, 1));
}
{
  //  2. a second formatting change builds on the first
  const b = new Book(corpus('02-formulas'));
  b.format(0, 1, 0, 1, 0, { bold: true });
  b.format(0, 1, 0, 1, 0, { italic: true });
  b.format(0, 1, 0, 1, 0, { align: 'center' });
  b.enter(0, 2, 0, '50%');
  b.format(0, 2, 0, 2, 0, { bold: true });
  const again = new Book(b.text());
  const l = again.look(0, 1, 0);
  check('bold, then italic, then centred, is all three after a save', l.bold && l.italic && l.align === 'center', JSON.stringify(l));
  check.eq('a percent made bold is still a percent after a save', again.cell(0, 2, 0).text + ' ' + !!again.look(0, 2, 0).bold + ' ' + again.styles.dataKind(again.look(0, 2, 0).data), '50.00% true percent');
  b.format(0, 1, 0, 1, 0, { bold: false });
  const off = new Book(b.text()).look(0, 1, 0);
  check('taking bold off keeps the italic and the centring', !off.bold && off.italic && off.align === 'center', JSON.stringify(off));
}
{
  //  3. a range across two sheets, in a file and typed
  //  (a function, since "$'" in a replacement string means something to replace)
  const text = corpus('05-sheets').replace('of:=SUM([$Data.A2:.A4])', () => "of:=SUM([$Data.A2:$&apos;My Sheet&apos;.A4])");
  let b = null, threw = '';
  try { b = new Book(text); } catch (e) { threw = e.message; }
  check('a file with a range across sheets opens', !!b && !b.error, threw || (b && b.error));
  b.enter(0, 1, 0, '10');
  check('its formula keeps the value LibreOffice cached, marked', b.cell(1, 0, 1).v === 6 && b.stale(1, 0, 1), JSON.stringify(b.cell(1, 0, 1).v));
  let r = null;
  try { r = b.enter(0, 5, 0, "=SUM(Data.A2:'My Sheet'.A4)"); } catch (e) { threw = e.message; }
  check('typing one does not throw', !!r && !threw, threw);
  check('and is kept for LibreOffice to compute', b.cell(0, 5, 0).f === "of:=SUM([Data.A2:'My Sheet'.A4])" && b.stale(0, 5, 0), b.cell(0, 5, 0).f);
}
{
  //  4. a reference lattice does not read is not a dead reference
  const ext = "of:=['file:///other.ods'#$Sheet1.A1]+[.A2]";
  const text = corpus('02-formulas').replace('table:formula="of:=[.A2]+[.B2]"', () => `table:formula="${ext.replace(/'/g, '&apos;')}"`);
  const b = new Book(text);
  check.eq('another file\'s cell is read as written', b.cell(0, 1, 3).f, ext);
  b.enter(0, 1, 0, '20');
  check.eq('editing what it reads keeps the cached value, not #REF!', b.cell(0, 1, 3).text + ' ' + b.cell(0, 1, 3).err + ' ' + b.stale(0, 1, 3), '5 false true');
  check('the saved formula is untouched', b.text().includes(ext.replace(/'/g, '&apos;')));
  check.eq('the bar shows it as stored', b.input(0, 1, 3), "=['file:///other.ods'#$Sheet1.A1]+A2");
  check('rows cannot be moved under it, and it says why', /cannot read/.test(b.shift(0, 'r', 5, 1).error || ''));
  check('nor is it turned to #REF! by the refusal', !b.text().includes('#REF!'));
  const c = new Book(corpus('05-sheets'));
  c.enter(1, 3, 0, '=SUM(Data.A:A)');
  check.eq('a whole column on another sheet is stored, computed and shown', c.cell(1, 3, 0).f + ' ' + c.cell(1, 3, 0).v + ' ' + c.input(1, 3, 0), 'of:=SUM([Data.A:.A]) 6 =SUM(Data.A:A)');
  check.eq('and the stored spelling with $ reads back', toOf(toUser('of:=SUM([$Data.A:.A])')), 'of:=SUM([$Data.A:.A])');
  c.shift(0, 'c', 0, 1);
  check.eq('and moves with its columns', c.cell(1, 3, 0).f, 'of:=SUM([Data.B:.B])');
}
{
  //  5. no calcext namespace, no calcext attribute
  const bare = corpus('01-values').replace(/ xmlns:calcext="[^"]*"/, '').replace(/ calcext:[a-z-]+="[^"]*"/g, '');
  const b = new Book(bare);
  check('a file with no calcext namespace opens', !b.error && !bare.includes('calcext'), b.error);
  b.enter(0, 1, 1, 'changed');
  b.enter(0, 2, 1, '=1/0');
  check('an edit writes no calcext attribute into it', !b.text().includes('calcext'));
  check.eq('and the cells are written without it', new Book(b.text()).cell(0, 1, 1).text + ' ' + new Book(b.text()).cell(0, 2, 1).text, 'changed #DIV/0!');
}
//  6. whole rows can be typed
check.eq('toOf: whole rows', toOf('=SUM(2:5)+SUM($3:$3)'), 'of:=SUM([.2:.5])+SUM([.$3:.$3])');
check.eq('toOf: a number before a comparison is still a number', toOf('=2<5'), 'of:=2<5');
check.eq('toOf: and what toUser shows types back', toOf(toUser('of:=SUM([.2:.5])')), 'of:=SUM([.2:.5])');
{
  //  7. a rule on another sheet is not moved by this sheet's rows
  const cf = '<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="&apos;My Sheet&apos;.B1:&apos;My Sheet&apos;.B2">'
    + '<calcext:condition calcext:apply-style-name="Default" calcext:value="formula-is([.A5]&gt;1)" calcext:base-cell-address="&apos;My Sheet&apos;.B1"/></calcext:conditional-format></calcext:conditional-formats>';
  const named = '<table:named-expressions><table:named-expression table:name="Twice" table:base-cell-address="$&apos;My Sheet&apos;.$A$1" table:expression="[.A5]*2"/>'
    + '<table:named-range table:name="Col" table:base-cell-address="$Data.$A$1" table:cell-range-address="$Data.$A$2:.$A$4"/></table:named-expressions>';
  const src = corpus('05-sheets');
  const i = src.indexOf('</table:table>', src.indexOf('table:name="My Sheet"'));
  const text = (src.slice(0, i) + cf + src.slice(i)).replace('<table:named-expressions/>', () => named);
  check('the fixture carries the rule and the names', text.includes('formula-is([.A5]') && text.includes('table:name="Twice"'));
  const a = new Book(text);
  check('insert a row on the first sheet', a.shift(0, 'r', 1, 1).ok);
  check('the other sheet\'s rule still tests its own A5', a.text().includes('calcext:value="formula-is([.A5]&gt;1)"'));
  check('and the name based on the other sheet still reads its A5', a.text().includes('table:expression="[.A5]*2"'));
  check('while the range on the first sheet moved', a.text().includes('table:cell-range-address="$Data.$A$3:.$A$5"'));
  const z = new Book(text);
  check('insert a row on the second sheet', z.shift(1, 'r', 1, 1).ok);
  check('its own rule and its name move', z.text().includes('calcext:value="formula-is([.A6]&gt;1)"') && z.text().includes('table:expression="[.A6]*2"'));
  check('and the first sheet\'s range does not', z.text().includes('table:cell-range-address="$Data.$A$2:.$A$4"'));
}
{
  //  8. MIN and MAX over a long run
  const head = '<?xml version="1.0"?>\n<office:document xmlns:office="o" xmlns:table="t" xmlns:text="x" office:mimetype="application/vnd.oasis.opendocument.spreadsheet"><office:body><office:spreadsheet><table:table table:name="B">';
  const tail = '</table:table></office:spreadsheet></office:body></office:document>';
  const b = new Book(head + '<table:table-row table:number-rows-repeated="200000"><table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell></table:table-row>' + tail);
  let r = null, threw = '';
  try { r = b.enter(0, 0, 1, '=MAX(A1:A200000)+MIN(A1:A200000)'); } catch (e) { threw = e.message; }
  check.eq('MAX and MIN over 200,000 cells', threw || b.cell(0, 0, 1).v, 6);
  void r;
}
//  10. a time just short of midnight
check.eq('serialDate carries into the next day', [serialDate(46023.999999, 25569 - 25569), serialDate(1.5, 0), serialDate(2, 0), serialDate(0.9999999, 0)].join(' '), [serialDate(46024, 0), '1970-01-02T12:00:00', '1970-01-03', '1970-01-02'].join(' '));
check('and never writes hour 24', !/T24/.test(serialDate(46023.999999, 0)));

console.log('==> the review of release 145');
const HEAD = '<?xml version="1.0"?>\n<office:document xmlns:office="o" xmlns:table="t" xmlns:text="x" xmlns:xlink="l" xmlns:calcext="c" office:mimetype="application/vnd.oasis.opendocument.spreadsheet"><office:body><office:spreadsheet>';
const TAIL = '</office:spreadsheet></office:body></office:document>';
const blankText = readFileSync(join(here, '..', 'ui-src', 'sheet', 'blank.fods'), 'utf8');
{
  //  a cell whose content was not edited keeps its paragraphs: links,
  //  spans and paragraph attributes
  const A = '<table:table-cell office:value-type="string"><text:p>see <text:a xlink:href="https://example.org/doc" xlink:type="simple">the doc</text:a></text:p></table:table-cell>';
  const C = '<table:table-cell office:value-type="string"><text:p text:style-name="P1">a <text:span text:style-name="T1">bold</text:span> word</text:p><text:p>second</text:p></table:table-cell>';
  const row = (n) => `<table:table-row${n}>${A}<table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell>${C}</table:table-row>`;
  const src = HEAD + `<table:table table:name="S">${row('')}${row(' table:number-rows-repeated="3"')}</table:table>` + TAIL;
  const LINK = '<text:p>see <text:a xlink:href="https://example.org/doc" xlink:type="simple">the doc</text:a></text:p>';
  const SPAN = '<text:p text:style-name="P1">a <text:span text:style-name="T1">bold</text:span> word</text:p>';
  //  how many of the sheet's rows still hold the link and the span, each row counted as often as it repeats
  const kept = (b) => {
    const d = parseFods(b.text());
    let links = 0, spans = 0;
    for (const r of d.sheets[0].rows) {
      const t = d.text.slice(r.src[0], r.src[1]);
      if (t.includes(LINK)) links += r.rep;
      if (t.includes(SPAN) && t.includes('<text:p>second</text:p>')) spans += r.rep;
    }
    return links + ',' + spans;
  };
  const after = (fn) => { const b = new Book(src); fn(b); return b; };
  check.eq('the fixture: four rows with a link and a span each', kept(new Book(src)), '4,4');
  check.eq('a column insert keeps every link and span', kept(after((b) => b.shift(0, 'c', 1, 1))), '4,4');
  check.eq('a column insert before them too', kept(after((b) => b.shift(0, 'c', 0, 2))), '4,4');
  check.eq('a column delete keeps them', kept(after((b) => b.shift(0, 'c', 1, -1))), '4,4');
  check('and copies the untouched cells byte for byte', (() => { const t = after((b) => b.shift(0, 'c', 1, 1)).text(); return t.split(A).length === 3 && t.split(C).length === 3; })());
  check.eq('typing into a row of a repeated run keeps them', kept(after((b) => b.enter(0, 2, 1, '5'))), '4,4');
  check.eq('a row insert inside a repeated run keeps them', kept(after((b) => b.shift(0, 'r', 2, 1))), '4,4');
  check.eq('a row delete inside a repeated run keeps the rest', kept(after((b) => b.shift(0, 'r', 2, -1))), '3,3');
  check.eq('bold on a linked cell keeps its link', kept(after((b) => b.format(0, 0, 0, 0, 2, { bold: true }))), '4,4');
  check.eq('a number format over text cells keeps them', kept(after((b) => b.format(0, 0, 0, 3, 2, { number: 'percent' }))), '4,4');
  check.eq('a row height keeps them', kept(after((b) => b.resize(0, 'r', 0, 40))), '4,4');
  const typed = after((b) => b.enter(0, 0, 0, 'new text'));
  check.eq('typing over a linked cell replaces it, and only it', kept(typed) + ' ' + typed.cell(0, 0, 0).text, '3,4 new text');
  const twice = after((b) => { b.shift(0, 'c', 1, 1); b.format(0, 1, 0, 1, 0, { italic: true }); b.shift(0, 'r', 0, 1); b.shift(0, 'c', 0, -1); });
  check.eq('several edits in a row, each from the text of the last', (() => { const d = parseFods(twice.text()); let n = 0; for (const r of d.sheets[0].rows) if (d.text.slice(r.src[0], r.src[1]).includes(SPAN)) n += r.rep; return n; })(), 4);
  const num = after((b) => b.format(0, 0, 1, 0, 1, { number: 'percent' }));
  check.eq('a number format still rewrites the shown text of a number', num.cell(0, 0, 1).text, '100.00%');
  check('and the saved cell holds the new text', num.text().includes('<text:p>100.00%</text:p>'));
}

{
  //  how the work grows. Counted, not timed: every read of a row run goes
  //  through a counting proxy.
  const num = (v) => `<table:table-cell office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`;
  const fx = (f) => `<table:table-cell table:formula="${f}" office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell>`;
  const sheetOf = (N, f) => {
    let rows = '';
    for (let i = 1; i <= N; i++) rows += `<table:table-row>${num(i)}${num(i * 2)}${fx(f(i, N))}</table:table-row>`;
    return new Book(HEAD + `<table:table table:name="S">${rows}</table:table>` + TAIL);
  };
  const reads = (N, f) => {
    const b = sheetOf(N, f);
    const sh = b.sheets[0];
    let n = 0;
    sh.rows = new Proxy(sh.rows, { get(t, k, r) { if (typeof k === 'string' && k.charCodeAt(0) < 58) n++; return Reflect.get(t, k, r); } });
    b.enter(0, 0, 0, '7');
    return [n, b];
  };
  const grows = (label, f, right) => {
    const [a] = reads(150, f), [z, b] = reads(300, f);
    //  twice the rows is four times the cells read. Eight times is a
    //  scan of the rows for every cell.
    check(`${label}: twice the rows is about four times the work, not eight`, z / a < 5.5, `${a} then ${z}, ${(z / a).toFixed(1)} times`);
    check.eq(`${label}: and the results are right`, [0, 6, 299].map((r) => b.cell(0, r, 2).v + (b.stale(0, r, 2) ? ' stale' : '')).join(), right);
  };
  grows('COUNTIF down a column', (i, N) => `of:=COUNTIF([.$A$1:.$A$${N}];[.A${i}])`, '2,2,1');
  grows('VLOOKUP down a column', (i, N) => `of:=VLOOKUP([.A${i}];[.$A$1:.$B$${N}];2;0)`, '2,2,600');
  grows('SUMIFS down a column', (i, N) => `of:=SUMIFS([.$B$1:.$B$${N}];[.$A$1:.$A$${N}];[.A${i}])`, '16,16,600');
  grows('SUMPRODUCT down a column', (i, N) => `of:=SUMPRODUCT([.$A$1:.$A$${N}];[.$B$1:.$B$${N}])-[.A${i}]`, '18090105,18090105,18089812');
  grows('MATCH down a column', (i, N) => `of:=MATCH([.A${i}];[.$A$1:.$A$${N}];0)`, '1,1,300');
  grows('SUM down a column', (i, N) => `of:=SUM([.$A$1:.$A$${N}])+[.A${i}]`, '45163,45163,45456');
}
{
  //  a chain of formulas, each reading the one above
  const chain = (N) => {
    let rows = '<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>';
    for (let i = 2; i <= N; i++) rows += `<table:table-row><table:table-cell table:formula="of:=[.A${i - 1}]+1" office:value-type="float" office:value="${i}"><text:p>${i}</text:p></table:table-cell></table:table-row>`;
    return new Book(HEAD + `<table:table table:name="S">${rows}</table:table>` + TAIL);
  };
  const b2 = chain(2000), b4 = chain(4000);
  b2.enter(0, 0, 0, '101');
  b4.enter(0, 0, 0, '101');
  check('finding what an edit reaches: twice the chain is about twice the checks', b4.engine.checks / b2.engine.checks < 2.5, `${b2.engine.checks} then ${b4.engine.checks}`);
  check.eq('a chain of 4,000 follows its first cell', b4.cell(0, 3999, 0).v, 4100);
  const big = chain(12000);
  const r = big.enter(0, 0, 0, '101');
  check.eq('a chain of 12,000 is followed to its end', big.cell(0, 11999, 0).v + ' ' + big.cell(0, 10001, 0).v + ' ' + big.stale(0, 11999, 0), '12100 10102 false');
  check.eq('and every link changed', r.changed.length, 12000);
  //  past the bound on that search, what was not reached is marked, never left looking right
  const cut = chain(3000);
  cut.engine.maxChecks = 500;
  cut.enter(0, 0, 0, '101');
  let wrong = 0, stale = 0, right = 0;
  for (let i = 1; i < 3000; i++) { const ok = cut.cell(0, i, 0).v === i + 101; if (cut.stale(0, i, 0)) stale++; else if (ok) right++; else wrong++; }
  check('past the bound on that search, a cell is right or is marked stale', wrong === 0 && stale > 0 && right > 0, `${right} right, ${stale} stale, ${wrong} wrong and unmarked`);
  cut.engine.maxChecks = 20000000;
  cut.enter(0, 0, 0, '201');
  check('and a later edit within the bound clears the marks', !cut.stale(0, 2999, 0) && cut.cell(0, 2999, 0).v === 3200);
  //  a formula typed over and over leaves nothing behind for the search to wade through
  const again = chain(50);
  for (let i = 0; i < 400; i++) again.enter(0, 1, 0, i % 2 ? '=A1+1' : '=A1+2');
  again.enter(0, 0, 0, '101');
  check('a formula retyped 400 times is found once', again.engine.checks < 200 && again.cell(0, 49, 0).v === 150, `${again.engine.checks} checks, ${again.cell(0, 49, 0).v}`);
  //  a chain read the other way round is computed deepest first. Where
  //  that runs out of stack, what read the cell that failed is marked too.
  const N = 30000;
  let rows = '';
  for (let i = 1; i < N; i++) rows += `<table:table-row><table:table-cell table:formula="of:=[.A${i + 1}]+1" office:value-type="float" office:value="${2 * N - i}"><text:p>x</text:p></table:table-cell></table:table-row>`;
  rows += `<table:table-row><table:table-cell table:formula="of:=ROW()" office:value-type="float" office:value="${N}"><text:p>${N}</text:p></table:table-cell></table:table-row>`;
  const up = new Book(HEAD + `<table:table table:name="S">${rows}</table:table>` + TAIL);
  check('insert a row above a chain of 30,000 read from the bottom', up.shift(0, 'r', 0, 1).ok);
  wrong = 0; stale = 0; right = 0;
  for (let i = 1; i <= N; i++) { const ok = up.cell(0, i, 0).v === 2 * N - i + 1; if (up.stale(0, i, 0)) stale++; else if (ok) right++; else wrong++; }
  check('every link is computed, taken from the far end', wrong === 0 && stale === 0 && right === N, `${right} right, ${stale} stale, ${wrong} wrong and unmarked`);
  //  a chain that wanders up and down the column: link k is in row
  //  (k * 7919) mod N, so no order of the rows is the order of the chain
  const at = (k) => (k * 7919) % N;
  const cells = new Array(N);
  for (let k = 0; k < N - 1; k++) cells[at(k)] = `<table:table-cell table:formula="of:=[.A${at(k + 1) + 1}]+1" office:value-type="float" office:value="0"><text:p>0</text:p></table:table-cell>`;
  cells[at(N - 1)] = '<table:table-cell table:formula="of:=ROW()*0+[.C1]" office:value-type="float" office:value="0"><text:p>0</text:p></table:table-cell>';
  const wander = new Book(HEAD + `<table:table table:name="S">${cells.map((c, i) => `<table:table-row>${c}${i ? '' : '<table:table-cell/><table:table-cell office:value-type="float" office:value="5"><text:p>5</text:p></table:table-cell>'}</table:table-row>`).join('')}</table:table>` + TAIL);
  check('insert a column beside a chain of 30,000 that wanders', wander.shift(0, 'c', 1, 1).ok);
  wrong = 0; stale = 0; right = 0;
  for (let k = 0; k < N; k++) { const ok = wander.cell(0, at(k), 0).v === 5 + (N - 1 - k); if (wander.stale(0, at(k), 0)) stale++; else if (ok) right++; else wrong++; }
  check('each link is right or is marked stale, none wrong and unmarked', wrong === 0 && right + stale === N && right > 0, `${right} right, ${stale} stale, ${wrong} wrong and unmarked`);
}
{
  //  one typed formula must not hang the tab
  const b = new Book(blankText);
  b.enter(0, 0, 0, '=FACT(1E15)');
  check.eq('FACT of a huge number is an error at once, as in Calc', b.cell(0, 0, 0).text, '#VALUE!');
  b.enter(0, 0, 1, '1E300');
  b.enter(0, 0, 2, '=FACT(B1)');
  const vals = ['=FACT(170)/1E306', '=FACT(171)', '=FACT(170.9)/1E306', '=FACT(0)', '=FACT(5)', '=FACT(-1)'].map((f) => { b.enter(0, 1, 0, f); return b.cell(0, 1, 0).text; });
  check.eq('FACT at its edges', b.cell(0, 0, 2).text + ' ' + vals.join(' '), '#VALUE! 7.25741561530799 #VALUE! 7.25741561530799 1 120 Err:502');
}
{
  //  a few hundred bytes of file, and formulas over all of it: each stops
  //  at the walk budget, keeps its cached value and is marked
  const bomb = (f) => new Book(HEAD + '<table:table table:name="B"><table:table-row table:number-rows-repeated="1000"><table:table-cell table:number-columns-repeated="16384" office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>'
    + `<table:table-row><table:table-cell table:formula="${f}" office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell></table:table-row></table:table>` + TAIL);
  for (const f of ['of:=COUNTIF([.A1:.XFD1000];1)', 'of:=SUMPRODUCT([.A1:.XFD1000];[.A1:.XFD1000])', 'of:=COUNTIFS([.A1:.XFD1000];1)', 'of:=COM.MICROSOFT.TEXTJOIN(&quot;&quot;;1;[.A1:.XFD1000])', 'of:=SUMIF([.A1:.XFD1000];1)', 'of:=VLOOKUP(2;[.A1:.XFD1000];1;0)+SUM([.A1:.XFD1000])']) {
    const b = bomb(f);
    b.enter(0, 0, 0, '5');
    check(`${f.slice(4, 14)} over 16 million cells stops at the budget, marked, its value kept`, b.cell(0, 1000, 0).v === 7 && b.stale(0, 1000, 0) && b.engine.steps <= 5000001, `${b.cell(0, 1000, 0).v} ${b.stale(0, 1000, 0)} ${b.engine.steps}`);
  }
  //  many such formulas: the whole recalculation has a budget too
  let cells = '';
  for (let i = 0; i < 200; i++) cells += '<table:table-cell table:formula="of:=COUNTIF([.A1:.CV1000];1)" office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell>';
  const many = new Book(HEAD + '<table:table table:name="B"><table:table-row table:number-rows-repeated="1000"><table:table-cell table:number-columns-repeated="100" office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>'
    + `<table:table-row>${cells}</table:table-row></table:table>` + TAIL);
  many.engine.maxTotal = 2000000;
  many.enter(0, 0, 0, '5');
  let done = 0, marked = 0, off = 0;
  for (let c = 0; c < 200; c++) { if (many.stale(0, 1000, c)) { marked++; if (many.cell(0, 1000, c).v !== 7) off++; } else if (many.cell(0, 1000, c).v === 99999) done++; else off++; }
  check('past the budget of one recalculation the rest are marked, none left wrong', off === 0 && done > 0 && marked > 0 && done + marked === 200 && many.engine.total <= 2200000, `${done} done, ${marked} marked, ${off} wrong, ${many.engine.total} steps`);
}
{
  //  the empty cells of a range past the used rows count as empty cells
  const b = new Book(blankText);
  b.enter(0, 0, 0, 'x'); b.enter(0, 1, 0, 'y');
  b.enter(0, 0, 2, '10'); b.enter(0, 1, 2, '20'); b.enter(0, 2, 2, '30');
  const at = (f) => { b.enter(0, 0, 5, f); const c = b.cell(0, 0, 5); return c.text + (b.stale(0, 0, 5) ? ' stale' : ''); };
  const T = [['=COUNTIF(A1:A10,"")', '8'], ['=COUNTIF(A1:A10,"<>x")', '9'], ['=COUNTIF(A1:A10,"=")', '8'], ['=COUNTIF(A1:A10,"<>")', '2'], ['=COUNTIF(A1:A10,"x")', '1'],
    ['=COUNTBLANK(A1:A10)', '8'], ['=SUMIF(A1:A10,"",C1:C10)', '30'], ['=SUMIF(A1:A10,"<>x",C1:C10)', '50'], ['=AVERAGEIF(A1:A10,"<>x",C1:C10)', '25'],
    ['=COUNTIFS(A1:A10,"",B1:B10,"")', '8'], ['=COUNTIFS(A1:A10,"<>x")', '9'], ['=SUMIFS(C1:C10,A1:A10,"<>x")', '50'], ['=COUNTIF(A1:A1048576,"")', '1048574'], ['=COUNTIF(A:A,"<>x")', '1048575'],
    ['=COUNTIF(A5:B9,"")', '10'], ['=COUNTIF(A5:B9,"<>q")', '10'], ['=COUNTIF(A5:B9,"q")', '0'], ['=SUMIF(A5:A9,"",C1:C5)', '60']];
  const got = T.map(([f]) => at(f)).join(' ');
  check.eq('criteria over empty cells past the used rows, as Calc counts them', got, T.map((x) => x[1]).join(' '));
  b.enter(0, 9, 4, 'far');
  check.eq('and the same once the sheet is used further down', T.map(([f]) => at(f)).join(' '), got);
}
{
  //  a formula whose value depends on where things are is computed again after an insert
  const b = new Book(corpus('05-sheets'));
  const s3 = b.addSheet('P').sheet;
  for (let r = 0; r < 6; r++) b.enter(s3, r, 0, String((r + 1) * 10));
  const F = [[4, 2, '=ROW()'], [5, 2, '=INDEX(A1:A6,3)'], [6, 2, '=COLUMN()'], [7, 2, '=ROWS(A1:A6)'], [8, 2, '=VLOOKUP(30,A1:B6,1,0)'], [9, 2, '=MATCH(30,A1:A6,0)'],
    [10, 2, '=INDEX(A:A,3)'], [11, 2, '=COLUMNS(A1:B1)'], [12, 2, '=ROW(A3)'], [13, 2, '=SUM(A1:A6)'], [0, 4, '=INDEX($A$1:$A$6,2)'], [0, 5, '=ROW()+COLUMN()']];
  for (const [r, c, f] of F) b.enter(s3, r, c, f);
  b.enter(0, 9, 3, '=ROWS(P.A1:A6)+INDEX(P.A1:A6,2)');
  const vals = (cells) => cells.map(([r, c, s = s3]) => b.cell(s, r, c).v + (b.stale(s, r, c) ? ' stale' : '')).join();
  check.eq('before the insert', vals(F.map(([r, c]) => [r, c])) + ' | ' + vals([[9, 3, 0]]), '5,30,3,6,30,3,30,2,3,210,20,7 | 26');
  check('insert a row before row 2', b.shift(s3, 'r', 1, 1).ok);
  //  the formulas at and below row 2 moved down one. E1 and F1 did not.
  const moved = F.map(([r, c]) => [r >= 1 ? r + 1 : r, c]);
  check.eq('ROW, INDEX, ROWS, MATCH and a whole-column INDEX give the values of the new layout', vals(moved), '6,20,3,7,30,4,20,2,4,210,0,7');
  check.eq('and so does a formula on another sheet that reads this one', b.cell(0, 9, 3).f + ' ' + vals([[9, 3, 0]]), 'of:=ROWS([P.A1:.A7])+INDEX([P.A1:.A7];2) 7');
  check('insert a column before A', b.shift(s3, 'c', 0, 1).ok);
  check.eq('COLUMN and COLUMNS follow', vals(moved.map(([r, c]) => [r, c + 1])), '6,20,4,7,30,4,20,2,4,210,0,8');
  const saved = new Book(b.text());
  check.eq('and those are the values saved', [5, 6, 7, 8, 10].map((r) => saved.cell(s3, r, 3).v).join(), '6,20,4,7,4');
  check('an insert on another sheet leaves these as they are', b.shift(0, 'r', 0, 1).ok && vals(moved.map(([r, c]) => [r, c + 1])) === '6,20,4,7,30,4,20,2,4,210,0,8');
}
{
  //  a rule's references move with the rows, as its base address does
  const cv = (rules) => '<table:content-validations>' + rules.map(([n, cond, base]) => `<table:content-validation table:name="${n}" table:condition="${cond}" table:allow-empty-cell="true" table:base-cell-address="${base}"/>`).join('') + '</table:content-validations>';
  const withRules = (name, rules, cf = '') => {
    const src = corpus(name);
    const i = src.indexOf('<table:table ');
    let t = src.slice(0, i) + cv(rules) + src.slice(i);
    if (cf) { const j = t.indexOf('</table:table>'); t = t.slice(0, j) + cf + t.slice(j); }
    return t;
  };
  const cond = (b, n) => { const m = new RegExp(`table:name="${n}" table:condition="([^"]*)"[^>]*table:base-cell-address="([^"]*)"`).exec(b.text()); return m ? m[1] + ' @ ' + m[2] : 'gone'; };
  const rules = [
    ['list', 'of:cell-content-is-in-list([$Ranges.$E$2:.$E$4])', 'Ranges.A2'],
    ['between', 'of:cell-content-is-between([.B2];[.B3])', 'Ranges.A2'],
    ['mixed', 'of:cell-content-is-in-list([.$E2:.E$4])', 'Ranges.A2'],
    ['text', 'of:cell-content-is-in-list(&quot;[.A5]&quot;;&quot;b &quot;&quot;[.A6]&quot;&quot;&quot;)', 'Ranges.A2'],
    ['and', 'of:cell-content-is-decimal-number() and cell-content-is-between([.B2];[$Ranges.B9])', 'Ranges.A2'],
    ['whole', 'of:cell-content-is-in-list([$Ranges.$E:.$E])', 'Ranges.A2'],
  ];
  const cf = '<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="Ranges.C2:Ranges.C5">'
    + '<calcext:condition calcext:apply-style-name="Default" calcext:value="between([.A2],[.B2])" calcext:base-cell-address="Ranges.C2"/></calcext:conditional-format></calcext:conditional-formats>';
  const text = withRules('07-ranges', rules, cf);
  const top = new Book(text);
  check('a sheet with validation rules opens, and its rows can move', !top.error && top.blocked(0, 'r', 0, 1) === null, top.error || top.blocked(0, 'r', 0, 1));
  check('insert a row at the top', top.shift(0, 'r', 0, 1).ok);
  check.eq('a list from a cell range moves with its cells', cond(top, 'list'), 'of:cell-content-is-in-list([$Ranges.$E$3:.$E$5]) @ Ranges.A3');
  check.eq('the limits of a between rule move', cond(top, 'between'), 'of:cell-content-is-between([.B3];[.B4]) @ Ranges.A3');
  check.eq('mixed references move', cond(top, 'mixed'), 'of:cell-content-is-in-list([.$E3:.E$5]) @ Ranges.A3');
  check.eq('text that looks like a reference is left alone', cond(top, 'text'), 'of:cell-content-is-in-list(&quot;[.A5]&quot;;&quot;b &quot;&quot;[.A6]&quot;&quot;&quot;) @ Ranges.A3');
  check.eq('a rule of two parts moves in both', cond(top, 'and'), 'of:cell-content-is-decimal-number() and cell-content-is-between([.B3];[$Ranges.B10]) @ Ranges.A3');
  check.eq('a whole column does not move with rows', cond(top, 'whole'), 'of:cell-content-is-in-list([$Ranges.$E:.$E]) @ Ranges.A3');
  check('a conditional format written with a comma moves', top.text().includes('calcext:value="between([.A3],[.B3])" calcext:base-cell-address="Ranges.C3"'));
  const mid = new Book(text);
  check('insert a row inside the list', mid.shift(0, 'r', 2, 1).ok);
  check.eq('a list that straddles the insert grows', cond(mid, 'list'), 'of:cell-content-is-in-list([$Ranges.$E$2:.$E$5]) @ Ranges.A2');
  check.eq('and a limit below it moves while the one above stays', cond(mid, 'between'), 'of:cell-content-is-between([.B2];[.B4]) @ Ranges.A2');
  const col = new Book(text);
  check('insert a column before E', col.shift(0, 'c', 4, 1).ok);
  check.eq('the list moves a column right', cond(col, 'list') + ' | ' + cond(col, 'whole'), 'of:cell-content-is-in-list([$Ranges.$F$2:.$F$4]) @ Ranges.A2 | of:cell-content-is-in-list([$Ranges.$F:.$F]) @ Ranges.A2');
  const del = new Book(text);
  check('delete the rows of the list', del.shift(0, 'r', 1, -3).ok);
  check('a list whose cells are all gone says so', cond(del, 'list').startsWith('of:cell-content-is-in-list(#REF!)'), cond(del, 'list'));
  const cut = new Book(text);
  check('delete one row of the list', cut.shift(0, 'r', 2, -1).ok);
  check.eq('a list cut by a delete shrinks', cond(cut, 'list'), 'of:cell-content-is-in-list([$Ranges.$E$2:.$E$3]) @ Ranges.A2');
  //  rules that read another sheet
  const two = withRules('05-sheets', [['here', 'of:cell-content-is-in-list([$Data.$A$2:.$A$4])', 'Data.B2'], ['there', "of:cell-content-is-in-list([$&apos;My Sheet&apos;.$A$2:.$A$4])", 'Data.B2'], ['rel', 'of:cell-content-is-between([.A2];[.A3])', "&apos;My Sheet&apos;.B2"]]);
  const a = new Book(two);
  check('insert a row on the first sheet of two', a.shift(0, 'r', 0, 1).ok);
  check.eq('a list on this sheet moves', cond(a, 'here'), 'of:cell-content-is-in-list([$Data.$A$3:.$A$5]) @ Data.B3');
  check.eq('a list on the other sheet stays, its base cell moves', cond(a, 'there'), "of:cell-content-is-in-list([$&apos;My Sheet&apos;.$A$2:.$A$4]) @ Data.B3");
  check.eq('a rule based on the other sheet stays whole', cond(a, 'rel'), "of:cell-content-is-between([.A2];[.A3]) @ &apos;My Sheet&apos;.B2");
  const z = new Book(two);
  check('insert a row on the second sheet', z.shift(1, 'r', 0, 1).ok);
  check.eq('then the other sheet\'s list moves, and this one stays', cond(z, 'there') + ' | ' + cond(z, 'here'), "of:cell-content-is-in-list([$&apos;My Sheet&apos;.$A$3:.$A$5]) @ Data.B2 | of:cell-content-is-in-list([$Data.$A$2:.$A$4]) @ Data.B2");
  check.eq('and the rule based there moves', cond(z, 'rel'), "of:cell-content-is-between([.A3];[.A4]) @ &apos;My Sheet&apos;.B3");
  //  a reference lattice cannot read stops the move, as in a formula
  const ext = new Book(withRules('07-ranges', [['far', 'of:cell-content-is-in-list([&apos;file:///other.ods&apos;#$Sheet1.A1:.A5])', 'Ranges.A2']]));
  const why = ext.shift(0, 'r', 0, 1);
  check('a rule that reads another file refuses the move, and says why', /cannot read/.test(why.error || ''), JSON.stringify(why));
  check('and nothing changed', ext.text() === withRules('07-ranges', [['far', 'of:cell-content-is-in-list([&apos;file:///other.ods&apos;#$Sheet1.A1:.A5])', 'Ranges.A2']]));
  check.eq('moveRefs: only the bracketed references are respelled', moveRefs('x is-between([.A5] , "[.A5]") and [.$B$7]', 'S', { sheet: 'S', dim: 'r', at: 0, n: 2 }), 'x is-between([.A7] , "[.A5]") and [.$B$9]');
  check('moveRefs: nothing moved gives the same string, an open bracket gives null', moveRefs('a([.A1])', 'S', { sheet: 'S', dim: 'r', at: 5, n: 1 }) === 'a([.A1])' && moveRefs('a([.A1)', 'S', { sheet: 'S', dim: 'r', at: 0, n: 1 }) === null);
}
{
  //  what is typed is the date typed, or it is text
  const b = new Book(blankText);
  const typed = (t, r = 0) => { b.enter(0, r, 0, t); const c = b.cell(0, r, 0); return c.vt + ':' + c.text; };
  check.eq('a date that does not exist is kept as the text typed', ['2024-02-31', '2023-02-29', '2024-04-31', '0000-01-01', '2024-13-01', '2024-00-10'].map((t) => typed(t)).join(' '),
    'string:2024-02-31 string:2023-02-29 string:2024-04-31 string:0000-01-01 string:2024-13-01 string:2024-00-10');
  check.eq('a date that does exist is a date', ['2024-02-29', '2023-02-28', '2024-4-30', '1999-12-31', '2024-1-5'].map((t) => typed(t)).join(' '),
    'date:2024-02-29 date:2023-02-28 date:2024-04-30 date:1999-12-31 date:2024-01-05');
  check('and nothing of a refused date is written as a date', (() => { b.enter(0, 1, 0, '2024-02-31'); return !b.text().includes('office:date-value="2024-03-02"') && b.text().includes('<text:p>2024-02-31</text:p>'); })());
  check.eq('the bar shows the text as typed', b.input(0, 1, 0), '2024-02-31');
  //  a number no double holds is the text typed, not 0
  check.eq('a number too large is kept as text', ['1e999', '5E1000', '-1e400'].map((t) => typed(t, 2)).join(' ') + ' ' + ['1e308', '1E-400'].map((t) => typed(t, 2)).join(' '), 'string:1e999 string:5E1000 string:-1e400 float:1E+308 float:0');
  check('and saved as text', (() => { b.enter(0, 2, 0, '5E1000'); const t = b.text(); return t.includes('<text:p>5E1000</text:p>') && !/office:value="0"[^>]*>\s*<text:p>#NUM!/.test(t); })());
  //  a date with a time of day: the bar's own spelling reads back
  b.enter(0, 3, 0, '2024-01-15 10:30:00');
  const dt = b.cell(0, 3, 0);
  check.eq('a date and time typed is a date with a time', dt.vt + ' ' + b.input(0, 3, 0) + ' ' + serialDate(dt.v, b.doc.nullDate), 'date 2024-01-15 10:30:00 2024-01-15T10:30:00');
  const was = dt.v;
  b.enter(0, 3, 0, b.input(0, 3, 0) + ' ');
  check('what the bar shows, typed back, is the same date and time', b.cell(0, 3, 0).vt === 'date' && b.cell(0, 3, 0).v === was);
  check.eq('with a T, without seconds, and one that is not a time', ['2024-01-15T10:30:00', '2024-01-15 7:05', '2024-01-15 25:00', '2024-02-30 10:00', '2024-01-15 10:61'].map((t) => typed(t, 4) + '|' + b.input(0, 4, 0)).join(' '),
    'date:2024-01-15|2024-01-15 10:30:00 date:2024-01-15|2024-01-15 07:05:00 string:2024-01-15 25:00|2024-01-15 25:00 string:2024-02-30 10:00|2024-02-30 10:00 string:2024-01-15 10:61|2024-01-15 10:61');
  //  a cell a file gives a date and time format keeps both through an edit in the bar
  const style = '<number:date-style style:name="NDT"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/><number:text> </number:text>'
    + '<number:hours number:style="long"/><number:text>:</number:text><number:minutes number:style="long"/><number:text>:</number:text><number:seconds number:style="long"/></number:date-style>'
    + '<style:style style:name="ceDT" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="NDT"/>';
  const cellDT = '<table:table-row><table:table-cell table:style-name="ceDT" office:value-type="date" office:date-value="2024-01-15T10:30:00" calcext:value-type="date"><text:p>2024-01-15 10:30:00</text:p></table:table-cell></table:table-row>';
  const src = corpus('01-values');
  const lo = new Book(src.replace('</office:automatic-styles>', style + '</office:automatic-styles>').replace('</table:table>', cellDT + '</table:table>'));
  const at = lo.error ? -1 : lo.extent(0)[0] - 1;
  check.eq('the fixture holds a date and time cell, shown in the bar', lo.error || lo.cell(0, at, 0).vt + ' ' + lo.input(0, at, 0), 'date 2024-01-15 10:30:00');
  if (!lo.error) {
    lo.enter(0, at, 0, '2024-01-15 10:45:00');
    const after = lo.cell(0, at, 0);
    check.eq('a minute changed in the bar: still a date and time, in the cell\'s own format', after.vt + ' ' + after.text + ' ' + serialDate(after.v, lo.doc.nullDate), 'date 2024-01-15 10:45:00 2024-01-15T10:45:00');
    check('and saved as one', lo.text().includes('office:date-value="2024-01-15T10:45:00"'));
  }
}
{
  //  results Calc gives, each run in LibreOffice
  const b = new Book(blankText);
  const at = (f) => { b.enter(0, 0, 0, f); return b.cell(0, 0, 0).text; };
  const T = [['=MROUND(-7.5,5)', '-10'], ['=MROUND(-2.5,1)', '-3'], ['=MROUND(7.5,5)', '10'], ['=MROUND(2.5,-1)', '3'], ['=MROUND(-7,5)', '-5'], ['=MROUND(7.5,-5)', '10'], ['=MROUND(0,5)', '0'], ['=MROUND(5,0)', '0'],
    ['=MROUND(1.25,0.5)', '1.5'], ['=MROUND(-1.25,0.5)', '-1.5'], ['=MROUND(7,5)', '5'], ['=MROUND(8,5)', '10'],
    ['=ROUND(1.4999999999,0)', '1'], ['=TRUNC(0.9999999995)', '0'], ['=ROUNDDOWN(1.9999999999,0)', '1'], ['=ROUNDUP(1.0000000001,0)', '2'],
    ['=ROUND(-1.4999999999,0)', '-1'], ['=ROUNDUP(-1.0000000001,0)', '-2'], ['=ROUNDDOWN(-1.9999999999,0)', '-1'], ['=TRUNC(-0.29*100)', '-29'],
    ['=ROUND(2.675,2)', '2.68'], ['=ROUND(1.005,2)', '1.01'], ['=ROUND(0.5,0)', '1'], ['=ROUND(-0.5,0)', '-1'], ['=ROUND(-2.5,0)', '-3'], ['=ROUND(123456789.125,2)', '123456789.13'],
    ['=ROUNDUP(2.0000000000000004,0)', '2'], ['=ROUNDDOWN(0.3*10,0)', '3'], ['=ROUNDUP(0.1*3*10,0)', '3'], ['=TRUNC(0.29*100)', '29'],
    ['=ROUND(0.285,2)', '0.29'], ['=ROUND(1.15,1)', '1.2'], ['=ROUND(8.345,2)', '8.35'], ['=ROUNDUP(1.1,1)', '1.1'], ['=ROUNDUP(0.3,1)', '0.3'], ['=ROUNDDOWN(0.7,1)', '0.7'],
    ['=ROUNDUP(3.3*3,1)', '9.9'], ['=ROUNDDOWN(4.35*100,0)', '435'], ['=TRUNC(1.005*1000)', '1005'], ['=ROUND(5.015,2)', '5.02'], ['=ROUND(1.0049999999999999,2)', '1.01'],
    ['=ROUND(1234.5678,-2)', '1200'], ['=ROUNDUP(1234.5678,-2)', '1300'], ['=ROUNDDOWN(-1234.5678,-2)', '-1200'],
    ['=ROUND(2.5,400)', '2.5'], ['=ROUND(-2.5,400)', '-2.5'], ['=ROUNDUP(2.5,400)', '2.5'], ['=ROUNDDOWN(2.5,400)', '2.5'], ['=TRUNC(2.5,400)', '2.5'], ['=ROUND(123.456,300)', '123.456'],
    ['=ROUND(2.5,-400)', '0'], ['=ROUND(-2.5,-400)', '0'], ['=ROUNDUP(2.5,-400)', '0'], ['=ROUNDDOWN(2.5,-400)', '0'], ['=TRUNC(2.5,-400)', '0'], ['=ROUND(1E300,-300)', '1E+300'], ['=ROUND(1E300,2)', '1E+300'],
    ['=SUBSTITUTE("hello","l","X",0)', 'Err:502'], ['=SUBSTITUTE("hello","l","X",-1)', 'Err:502'], ['=SUBSTITUTE("hello","l","X",0.5)', 'Err:502'], ['=SUBSTITUTE("hello","","X",0)', 'Err:502'],
    ['=SUBSTITUTE("hello","l","X",1)', 'heXlo'], ['=SUBSTITUTE("hello","l","X",2.9)', 'helXo'], ['=SUBSTITUTE("hello","l","X",3)', 'hello'], ['=SUBSTITUTE("hello","l","X")', 'heXXo'],
    ['=REPLACE("abc",0,1,"x")', 'Err:502'], ['=REPLACE("abc",-1,1,"x")', 'Err:502'], ['=REPLACE("abc",1,-1,"x")', 'Err:502'], ['=REPLACE("abc",0.5,1,"x")', 'Err:502'],
    ['=REPLACE("abc",1,0,"x")', 'xabc'], ['=REPLACE("abc",5,1,"x")', 'abcx'], ['=REPLACE("abc",1.9,1,"x")', 'xbc'], ['=REPLACE("abc",1.9,1.9,"x")', 'xbc'], ['=REPLACE("abc",2,100,"x")', 'ax']];
  const off = T.filter(([f, want]) => at(f) !== want).map(([f, want]) => `${f} gave ${at(f)}, Calc ${want}`);
  check(`${T.length} rounding and text results are Calc's`, off.length === 0, off.join(' | '));
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
  const long = head + '<table:table table:name="B"><table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell><table:table-cell table:formula="of:=[.A1]' + '+1'.repeat(20000) + '" office:value-type="float" office:value="20001"><text:p>20001</text:p></table:table-cell></table:table-row></table:table>' + tail;
  const bl = new Book(long);
  check('a file with a formula of 20,000 terms opens', !bl.error, bl.error);
  if (!bl.error) {
    bl.enter(0, 0, 0, '5');
    check('its formula is left to LibreOffice: the cached value kept, and marked', bl.cell(0, 0, 1).v === 20001 && bl.stale(0, 0, 1) && bl.text().includes('+1+1+1'));
    check('and the cell beside it took the edit', bl.cell(0, 0, 0).v === 5);
  }
  const names = head + '<table:table table:name="A&amp;&lt;b&gt;&quot;"><table:table-row><table:table-cell office:value-type="string"><text:p>&lt;script&gt;alert(1)&lt;/script&gt;</text:p></table:table-cell></table:table-row></table:table>' + tail;
  const bn = new Book(names);
  check.eq('markup in a name and a cell is text', bn.sheets[0].name + ' ' + bn.cell(0, 0, 0).text, 'A&<b>" <script>alert(1)</script>');
  bn.enter(0, 0, 1, '<b>&"\'');
  check('and is escaped when written', bn.text().includes('<text:p>&lt;b&gt;&amp;"\'</text:p>'));
}

check.done();
