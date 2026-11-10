#!/usr/bin/env node
//  sheet-roundtrip.mjs: the spreadsheet round trip through LibreOffice.
//  Pure node plus soffice, no ship.
//
//  For each case below, lattice's core opens a corpus file and edits it.
//  Then:
//
//    1. LibreOffice reads it.  soffice --headless opens lattice's output
//       and saves it again as flat ODS. A file LibreOffice cannot open
//       fails here.
//    2. Every cell agrees.     LibreOffice recalculates on load, so its
//       save holds its own results. Each cell's value, formula and shown
//       text in that save must equal lattice's.
//    3. Nothing was lost.      Everything opaque in the corpus file (a
//       comment, a shape, a pivot table, a macro, named ranges, filters,
//       conditional formats) is still in LibreOffice's save.
//    4. Lattice reads LibreOffice's save, and round-trips it
//       byte-identical.
//
//  The untouched corpus files go through the same steps with no edit, so
//  a difference that is LibreOffice's own (it shows =50% as 50.00% and
//  re-saves it the same way) is told apart from one lattice made.
//
//  Without soffice the suite skips, unless SHEET_REQUIRE_SOFFICE=1 (CI
//  sets it), which fails.
//
//  Usage: node scripts/sheet-roundtrip.mjs [--only b-insert-rows,j-large]
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { makeCheck } from './lib/check.mjs';
import { parseFods, serializeFods, cellAt, extent } from '../ui-src/sheet/model.js';
import { Book } from '../ui-src/sheet/book.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'tests', 'sheet', 'corpus');
const check = makeCheck();
const corpus = (n) => readFileSync(join(dir, n + '.fods'), 'utf8');

const must = (r) => { if (r.error) throw new Error(r.error); return r; };
//  name -> [corpus file, edit, what must still be in LibreOffice's save]
const CASES = {
  'a-typed': ['02-formulas', (b) => {
    b.enter(0, 1, 0, '20'); b.enter(0, 2, 1, '=A2*2'); b.enter(0, 40, 0, 'new text'); b.enter(0, 41, 0, '12.5%');
    b.enter(0, 42, 0, '2026-01-31'); b.enter(0, 43, 0, 'true'); b.enter(0, 44, 0, '$1,234.50'); b.enter(0, 45, 0, '13:45');
    b.enter(0, 46, 0, '=SUM(A2:A10)&" total"'); b.enter(0, 47, 0, "'007"); b.enter(0, 48, 2, '  two  spaces ');
    b.enter(0, 49, 0, '=IF(AND(A2>1,B2<10),"yes","no")'); b.enter(0, 50, 0, '=A2>B2'); b.enter(0, 51, 0, 'line one\nline two');
    b.enter(0, 52, 0, '=VLOOKUP(10,A2:B18,2,0)&"|"&ROUND(AVERAGE(B2:B18),3)'); b.enter(0, 53, 0, '<b>&amp;"quoted"</b>');
    b.enter(0, 54, 0, '=DATE(2026,11,10)'); b.enter(0, 55, 0, '=TIME(13,30,0)'); b.enter(0, 56, 0, '=EOMONTH(A55,1)');
  }],
  'b-insert-rows': ['02-formulas', (b) => { must(b.shift(0, 'r', 3, 2)); b.enter(0, 3, 0, '1000'); b.enter(0, 4, 1, '=A4/8'); }],
  'c-delete-row': ['02-formulas', (b) => { must(b.shift(0, 'r', 4, -1)); }],
  'd-insert-column': ['02-formulas', (b) => { must(b.shift(0, 'c', 1, 1)); b.enter(0, 1, 1, '5'); }],
  'e-delete-column': ['10-large', (b) => { must(b.shift(0, 'c', 2, -1)); }],
  'f-ranges': ['07-ranges', (b) => { must(b.shift(0, 'r', 2, 1)); b.enter(0, 2, 1, '100'); b.enter(0, 2, 2, '=B3*(1+Rate)'); },
    ['table:named-range', 'table:named-expression', 'table:database-range', 'calcext:conditional-format', 'table:print-ranges']],
  'g-sheets': ['05-sheets', (b) => {
    b.enter(0, 1, 0, '10'); must(b.shift(0, 'r', 1, 1)); b.enter(0, 1, 0, '5');
    const a = must(b.addSheet('New One')); b.enter(a.sheet, 0, 0, "=Data.A2+'My Sheet'.B1"); b.enter(a.sheet, 1, 0, "='It''s'.B2*2");
  }],
  'h-format': ['06-formats', (b) => {
    b.format(0, 0, 0, 2, 2, { bold: true }); b.format(0, 2, 0, 2, 1, { number: 'currency' }); b.enter(0, 2, 0, '7.5');
    b.format(0, 1, 0, 1, 2, { italic: true, align: 'center' }); b.format(0, 2, 2, 2, 2, { number: 'percent' }); b.resize(0, 'c', 1, 200); b.resize(0, 'r', 1, 40);
  }],
  'i-repeats': ['03-repeats', (b) => {
    b.enter(0, 2, 0, 'in a repeated row'); b.enter(0, 0, 1, 'split'); b.enter(0, 5, 3, '9'); b.enter(0, 200, 5, 'far away'); must(b.shift(0, 'r', 1, -2));
  }],
  'j-large': ['10-large', (b) => { b.enter(0, 5, 1, '1000'); b.enter(0, 600, 2, '0.5'); b.enter(0, 1300, 0, '=SUM(D2:D1201)/COUNT(D2:D1201)'); }],
  'k-opaque': ['08-opaque', (b) => { b.enter(0, 1, 1, '10'); b.enter(0, 0, 2, 'edited beside a comment'); b.enter(0, 8, 0, '=B6*2'); },
    ['office:annotation', 'draw:rect', 'table:data-pilot-table', 'ooo:source-code']],
  'l-merged': ['04-merged', (b) => { b.enter(0, 1, 1, '100'); b.enter(0, 0, 0, 'new title'); must(b.shift(0, 'r', 5, 2)); b.enter(0, 5, 0, 'between'); }],
  'm-i18n': ['09-i18n', (b) => { b.enter(0, 0, 1, 'naïve café ☃ 日本語 🎉'); b.enter(0, 8, 0, '=LEN(B1)&" "&UPPER(A1)'); b.enter(0, 2, 1, 'x < y && "z"'); }],
  //  formatting on top of formatting made in the same session, and a
  //  number format kept under it
  'o-stacked': ['02-formulas', (b) => {
    b.format(0, 1, 0, 1, 1, { bold: true }); b.format(0, 1, 0, 1, 1, { italic: true }); b.format(0, 1, 0, 1, 0, { align: 'center' });
    //  (in cells no formula reads: Calc shows a formula over a percent as
    //  a percent, which lattice does not do, and that is not this case)
    b.enter(0, 40, 0, '50%'); b.format(0, 40, 0, 40, 0, { bold: true }); b.enter(0, 41, 0, '$12.50'); b.format(0, 41, 0, 41, 0, { underline: true });
  }, ['fo:font-style="italic"', 'fo:font-weight="bold"']],
  //  a file from a producer that does not use LibreOffice's calcext
  //  namespace: lattice must not write the prefix into it
  'p-no-calcext': ['01-values', (b) => { b.enter(0, 1, 1, 'changed'); b.enter(0, 2, 1, '43'); b.enter(0, 17, 1, '=B3*2'); b.enter(0, 18, 1, '=1/0'); }, null,
    (t) => t.replace(/ xmlns:calcext="[^"]*"/, '').replace(/ calcext:[a-z-]+="[^"]*"/g, '')],
  'q-whole-rows': ['02-formulas', (b) => { b.enter(0, 40, 0, '=SUM(2:5)'); b.enter(0, 41, 0, '=COUNT(A:A)+MAX(B:B)'); }],
  'n-values': ['01-values', (b) => { b.enter(0, 9, 1, '40'); b.enter(0, 10, 1, '99.5'); b.enter(0, 11, 1, '2027-02-28'); b.enter(0, 12, 1, '07:05:09'); b.enter(0, 7, 1, '0.005'); b.enter(0, 13, 1, 'false'); }],
};
for (const n of readdirSync(dir).filter((f) => f.endsWith('.fods')).sort()) CASES['z-untouched-' + n.slice(0, -5)] = [n.slice(0, -5), null];

const soffice = ['soffice', 'libreoffice'].find((c) => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0);
if (!soffice) {
  if (process.env.SHEET_REQUIRE_SOFFICE === '1') { check.bad('LibreOffice (soffice) is on PATH'); check.done(); }
  console.log('sheet-roundtrip: soffice is not on PATH, skipped');
  process.exit(0);
}

const only = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const tmp = mkdtempSync(join(tmpdir(), 'latsheet-'));
const built = {};
for (const [name, [src, edit, , prep]] of Object.entries(CASES)) {
  if (only && !only.has(name)) continue;
  const b = new Book(prep ? prep(corpus(src)) : corpus(src));
  try { if (edit) edit(b); } catch (e) { check.bad(`${name}: the edit applies`, e.message); continue; }
  const text = b.text();
  if (!edit) check(`${name}: untouched is byte-identical`, text === corpus(src));
  writeFileSync(join(tmp, name + '.fods'), text);
  built[name] = b;
}
const names = Object.keys(built);
const out = join(tmp, 'lo');
try {
  execFileSync(soffice, [`-env:UserInstallation=file://${tmp}/profile`, '--headless', '--norestore', '--convert-to', 'fods', '--outdir', out,
    ...names.map((n) => join(tmp, n + '.fods'))], { stdio: 'ignore', timeout: 900000 });
} catch (e) { check.bad('LibreOffice converts lattice\'s files', e.message); }

const near = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));
for (const name of names) {
  const b = built[name];
  const [, edit, keep] = CASES[name];
  const f = join(out, name + '.fods');
  if (!check(`${name}: LibreOffice opens it and saves it`, existsSync(f))) continue;
  const lo = readFileSync(f, 'utf8');
  const doc = parseFods(lo);
  if (!check(`${name}: lattice reads LibreOffice's save`, !doc.error, doc.error)) continue;
  check(`${name}: and round-trips it byte-identical`, serializeFods(doc) === lo);
  check(`${name}: the same sheets`, doc.sheets.map((s) => s.name).join('|') === b.sheets.map((s) => s.name).join('|'));
  let cells = 0, off = 0;
  const first = [];
  b.sheets.forEach((sheet, s) => {
    const theirs = doc.sheets[s];
    if (!theirs) return;
    const [r1, c1] = b.extent(s), [r2, c2] = extent(theirs);
    for (let r = 0; r < Math.max(r1, r2); r++) {
      for (let c = 0; c < Math.max(c1, c2); c++) {
        const x = b.cell(s, r, c), y = cellAt(theirs, r, c);
        if (!x.vt && !y.vt && !x.f && !y.f) continue;
        cells++;
        //  a formula lattice left to LibreOffice has no value of lattice's to compare
        if (b.stale(s, r, c)) { if (x.f !== y.f) { off++; first.push(`${sheet.name} R${r + 1}C${c + 1} formula ${x.f} / ${y.f}`); } continue; }
        const same = x.f === y.f && !!x.err === !!y.err && (x.vt || '') === (y.vt || '') && near(x.v, y.v) && x.text === y.text;
        if (!same) { off++; if (first.length < 6) first.push(`${sheet.name} R${r + 1}C${c + 1}: lattice ${x.f || ''} ${x.vt} ${JSON.stringify(x.v)} "${x.text}", LibreOffice ${y.f || ''} ${y.vt} ${JSON.stringify(y.v)} "${y.text}"`); }
      }
    }
  });
  check(`${name}: all ${cells} cells agree with LibreOffice`, off === 0, `${off} differ: ${first.join(' | ')}`);
  for (const k of keep || []) {
    //  what this LibreOffice drops from the untouched corpus file is its
    //  own loss, not lattice's (24.2 drops a 26.8 cell comment)
    const plain = join(out, 'z-untouched-' + CASES[name][0] + '.fods');
    if (!lo.includes(k) && existsSync(plain) && !readFileSync(plain, 'utf8').includes(k)) {
      console.log(`  skip - ${name}: ${k}: this LibreOffice drops it from the untouched file too`);
      continue;
    }
    check(`${name}: ${k} is still in the file`, lo.includes(k));
  }
  if (!edit) continue;
}

if (!process.env.SHEET_KEEP) rmSync(tmp, { recursive: true, force: true }); else console.log('kept ' + tmp);
check.done();
