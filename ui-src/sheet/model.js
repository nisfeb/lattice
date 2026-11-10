//  model.js: a flat ODS document as an editable model, and back to text.
//
//  The rule is the Writer core's: the source text is the truth, and a
//  save copies every byte lattice did not change. So the model keeps, for
//  every row, cell and column, the span it came from. An untouched row is
//  written by copying its span. A changed row is rewritten in
//  LibreOffice's own layout, and inside it every untouched cell is still
//  copied. Open and save with no edit is byte-identical.
//
//  Rows and cells stay run-length encoded, as ODF writes them
//  (table:number-rows-repeated, table:number-columns-repeated). Nothing is
//  ever expanded to the sheet's 1,048,576 rows: a run is split only where
//  an edit lands.

import { parseXml, attr, decode, escText, escAttr } from '../writer/xml.js';

export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384;

const ROW_BOXES = new Set(['table:table-header-rows', 'table:table-row-group', 'table:table-rows']);
const COL_BOXES = new Set(['table:table-header-columns', 'table:table-column-group', 'table:table-columns']);

//  the attributes that carry a cell's value. Everything else on a cell
//  (spans, validation names, anything unknown) rides along untouched.
const VALUE_ATTRS = new Set([
  'table:style-name', 'table:number-columns-repeated', 'table:formula', 'office:value-type',
  'office:value', 'office:date-value', 'office:time-value', 'office:boolean-value',
  'office:string-value', 'office:currency', 'calcext:value-type',
]);

const int = (s, d = 1) => {
  const n = parseInt(s, 10);
  return n > 0 ? n : d;
};

//  the display text of a cell's <text:p> children: paragraphs joined by a
//  newline, text:s as spaces, text:tab as a tab, text:line-break as a
//  newline. Entities decoded.
function cellText(src, ps) {
  const out = [];
  for (const p of ps) {
    let t = '';
    const walk = (e) => {
      for (const k of e.kids) {
        if (k.text) t += k.cdata ? src.slice(k.start + 9, k.end - 3) : decode(src.slice(k.start, k.end));
        else if (!k.name) continue;
        else if (k.name === 'text:s') t += ' '.repeat(Math.min(int(attr(k, 'text:c')), 4096));
        else if (k.name === 'text:tab') t += '\t';
        else if (k.name === 'text:line-break') t += '\n';
        else if (k.name === 'office:annotation') continue;
        else walk(k);
      }
    };
    walk(p);
    out.push(t);
  }
  return out.join('\n');
}

//  ISO 8601 date or date-time to a spreadsheet serial (days since the null
//  date), and a duration (PT13H37M05S) to a fraction of a day
export function dateSerial(iso, nullDate) {
  const m = /^(-?\d{4,})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d):(\d\d(?:\.\d+)?))?/.exec(iso || '');
  if (!m) return null;
  const day = Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
  const frac = m[4] ? (+m[4] * 3600 + +m[5] * 60 + +m[6]) / 86400 : 0;
  return day - nullDate + frac;
}
export function timeSerial(dur) {
  const m = /^(-)?PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(dur || '');
  if (!m) return null;
  const s = (+(m[2] || 0) * 3600 + +(m[3] || 0) * 60 + +(m[4] || 0)) / 86400;
  return m[1] ? -s : s;
}
const p2 = (n) => String(n).padStart(2, '0');
export function serialDate(n, nullDate) {
  const whole = Math.floor(n + 1e-9);
  const d = new Date((whole + nullDate) * 86400000);
  let iso = `${String(d.getUTCFullYear()).padStart(4, '0')}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const secs = Math.round((n - whole) * 86400);
  if (secs > 0) iso += `T${p2(Math.floor(secs / 3600))}:${p2(Math.floor(secs / 60) % 60)}:${p2(secs % 60)}`;
  return iso;
}
export function serialTime(n) {
  const neg = n < 0;
  const secs = Math.round(Math.abs(n) * 86400);
  return `${neg ? '-' : ''}PT${p2(Math.floor(secs / 3600))}H${p2(Math.floor(secs / 60) % 60)}M${p2(secs % 60)}S`;
}

//  a number as LibreOffice writes office:value: the shortest text that
//  reads back as the same double
export const numAttr = (n) => {
  if (!Number.isFinite(n)) return '0';
  let s = String(n);
  if (s.includes('e')) s = s.replace('e+', 'E').replace('e', 'E');
  return s;
};

function parseCell(src, el, nullDate) {
  const c = {
    src: [el.start, el.end], rep: 1, covered: el.name === 'table:covered-table-cell', attrs: el.attrs,
    st: null, vt: null, v: null, f: null, text: '', keep: '', err: false, cs: 1, rs: 1, dirty: false, rich: false,
  };
  let cur = null;
  for (const [k, raw] of el.attrs) {
    switch (k) {
      case 'table:number-columns-repeated': c.rep = int(raw); break;
      case 'table:style-name': c.st = decode(raw); break;
      case 'table:formula': c.f = decode(raw); break;
      case 'office:value-type': c.vt = raw; break;
      case 'office:value': c.v = Number(raw); break;
      case 'office:date-value': c.v = dateSerial(raw, nullDate); break;
      case 'office:time-value': c.v = timeSerial(raw); break;
      case 'office:boolean-value': c.v = raw === 'true'; break;
      case 'office:string-value': c.sv = decode(raw); break;
      case 'office:currency': cur = raw; break;
      case 'calcext:value-type': if (raw === 'error') c.err = true; break;
      case 'table:number-columns-spanned': c.cs = int(raw); break;
      case 'table:number-rows-spanned': c.rs = int(raw); break;
      default:
    }
  }
  if (cur) c.cur = cur;
  const ps = [];
  for (const k of el.kids) {
    if (!k.name) continue;
    if (k.name === 'text:p') {
      ps.push(k);
      if (k.kids.some((x) => x.name && x.name !== 'text:s' && x.name !== 'text:tab' && x.name !== 'text:line-break')) c.rich = true;
    } else c.keep += src.slice(k.start, k.end);
  }
  c.text = cellText(src, ps);
  if (c.vt === 'string') c.v = c.sv !== undefined && !c.err ? c.sv : c.text;
  if (c.vt && c.vt !== 'string' && c.vt !== 'boolean' && (c.v === null || Number.isNaN(c.v))) c.v = 0;
  delete c.sv;
  return c;
}

function parseRow(src, el, nullDate) {
  const row = { src: [el.start, el.end], rep: 1, attrs: el.attrs, cells: [], dirty: false };
  for (const [k, raw] of el.attrs) if (k === 'table:number-rows-repeated') row.rep = int(raw);
  for (const k of el.kids) {
    if (k.name === 'table:table-cell' || k.name === 'table:covered-table-cell') row.cells.push(parseCell(src, k, nullDate));
  }
  return row;
}

function parseTable(src, el, nullDate) {
  const sheet = {
    el, name: attr(el, 'table:name') || '', style: attr(el, 'table:style-name') || null,
    rows: [], cols: [], gone: [], dirty: false, isNew: false,
  };
  const walk = (e) => {
    for (const k of e.kids) {
      if (!k.name) continue;
      if (k.name === 'table:table-row') sheet.rows.push(parseRow(src, k, nullDate));
      else if (k.name === 'table:table-column') {
        sheet.cols.push({
          src: [k.start, k.end], rep: int(attr(k, 'table:number-columns-repeated')), attrs: k.attrs,
          st: attr(k, 'table:style-name') || null, cellSt: attr(k, 'table:default-cell-style-name') || null, dirty: false,
        });
      } else if (ROW_BOXES.has(k.name) || COL_BOXES.has(k.name)) walk(k);
    }
  };
  walk(el);
  return sheet;
}

const find = (el, name) => el && el.kids.find((k) => k.name === name);

//  +parseFods: the model of a flat ODS text, or { error }
export function parseFods(text, limits) {
  const x = parseXml(text, limits);
  if (x.error) return { error: x.error };
  const docEl = find(x.root, 'office:document');
  if (!docEl) return { error: 'not a flat OpenDocument file' };
  const body = find(docEl, 'office:body');
  const ss = find(body, 'office:spreadsheet');
  if (!ss) return { error: 'not a spreadsheet' };
  const calc = find(ss, 'table:calculation-settings');
  const nd = calc && find(calc, 'table:null-date');
  const ndIso = (nd && attr(nd, 'table:date-value')) || '1899-12-30';
  const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(ndIso);
  const nullDate = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : Date.UTC(1899, 11, 30) / 86400000;
  const doc = {
    text, root: x.root, docEl, ss, nullDate,
    auto: find(docEl, 'office:automatic-styles'), styles: find(docEl, 'office:styles'),
    sheets: [], newAuto: [], tracked: !!find(ss, 'table:tracked-changes'),
  };
  for (const k of ss.kids) if (k.name === 'table:table') doc.sheets.push(parseTable(text, k, nullDate));
  if (!doc.sheets.length) return { error: 'a spreadsheet with no sheets' };
  return doc;
}

// ── addressing ───────────────────────────────────────────────────────────

//  the number of rows a sheet's runs cover, and of the cells of one row
export const rowCount = (sheet) => sheet.rows.reduce((n, r) => n + r.rep, 0);
const cellCount = (row) => row.cells.reduce((n, c) => n + c.rep, 0);

//  the run holding row r: [index, first row of the run], or null past the end
function rowRun(sheet, r) {
  let at = 0;
  for (let i = 0; i < sheet.rows.length; i++) {
    const n = sheet.rows[i].rep;
    if (r < at + n) return [i, at];
    at += n;
  }
  return null;
}
function cellRun(row, c) {
  let at = 0;
  for (let i = 0; i < row.cells.length; i++) {
    const n = row.cells[i].rep;
    if (c < at + n) return [i, at];
    at += n;
  }
  return null;
}

const EMPTY = Object.freeze({ vt: null, v: null, f: null, text: '', st: null, err: false, cs: 1, rs: 1, covered: false, rep: 1 });

//  +cellAt: the cell at (r, c), read-only. An empty cell past the stored
//  rows and columns is EMPTY.
export function cellAt(sheet, r, c) {
  const rr = rowRun(sheet, r);
  if (!rr) return EMPTY;
  const cr = cellRun(sheet.rows[rr[0]], c);
  return cr ? sheet.rows[rr[0]].cells[cr[0]] : EMPTY;
}
export const rowAt = (sheet, r) => {
  const rr = rowRun(sheet, r);
  return rr ? sheet.rows[rr[0]] : null;
};

const cloneCell = (c, rep) => ({ ...c, src: null, rep, dirty: true });
const blankCell = (rep) => ({
  src: null, rep, covered: false, attrs: [], st: null, vt: null, v: null, f: null, text: '', keep: '',
  err: false, cs: 1, rs: 1, dirty: true, rich: false,
});
const cloneRow = (row, rep) => ({
  src: null, rep, attrs: row.attrs, cells: row.cells.map((c) => ({ ...c, src: null, dirty: true })), dirty: true,
});
//  a new row takes its neighbour's row style, so heights stay even
const blankRow = (like, rep) => ({
  src: null, rep, dirty: true, cells: [],
  attrs: like ? like.attrs.filter(([k]) => k === 'table:style-name') : [],
});

//  +ownRow: row r as a run of its own (rep 1), splitting a repeated run
//  and growing the sheet when r is past its end
export function ownRow(sheet, r) {
  if (r < 0 || r >= MAX_ROWS) return null;
  let rr = rowRun(sheet, r);
  if (!rr) {
    const have = rowCount(sheet);
    const last = sheet.rows[sheet.rows.length - 1] || null;
    if (r > have) sheet.rows.push(blankRow(last, r - have));
    sheet.rows.push(blankRow(last, 1));
    sheet.ver = (sheet.ver || 0) + 1;
    return sheet.rows[sheet.rows.length - 1];
  }
  const [i, at] = rr;
  const row = sheet.rows[i];
  if (row.rep === 1) return row;
  const before = r - at, after = row.rep - before - 1;
  const parts = [];
  //  the first piece keeps the source span, so the rest follow it in place
  if (before) { row.rep = before; row.dirty = true; parts.push(row); }
  let mine;
  if (before) mine = cloneRow(row, 1); else { row.rep = 1; row.dirty = true; mine = row; }
  parts.push(mine);
  if (after) parts.push(cloneRow(row, after));
  sheet.rows.splice(i, 1, ...parts);
  sheet.ver = (sheet.ver || 0) + 1;
  return mine;
}

//  +ownCell: cell c of a row as a run of its own
export function ownCell(row, c) {
  if (c < 0 || c >= MAX_COLS) return null;
  row.dirty = true;
  let cr = cellRun(row, c);
  if (!cr) {
    const have = cellCount(row);
    if (c > have) row.cells.push(blankCell(c - have));
    row.cells.push(blankCell(1));
    return row.cells[row.cells.length - 1];
  }
  const [i, at] = cr;
  const cell = row.cells[i];
  if (cell.rep === 1) return cell;
  const before = c - at, after = cell.rep - before - 1;
  const parts = [];
  if (before) parts.push(cloneCell(cell, before));
  const mine = cloneCell(cell, 1);
  parts.push(mine);
  if (after) parts.push(cloneCell(cell, after));
  row.cells.splice(i, 1, ...parts);
  return mine;
}

//  +setCell: put a value into (r, c). `val` is { vt, v, f, text, err }:
//  the type, the value, the stored formula (or null) and the display
//  text. The cell's style and its other attributes are kept.
export function setCell(sheet, r, c, val) {
  const row = ownRow(sheet, r);
  const cell = row && ownCell(row, c);
  if (!cell) return null;
  cell.vt = val.vt ?? null;
  cell.v = val.v ?? null;
  cell.f = val.f ?? null;
  cell.text = val.text ?? '';
  cell.err = !!val.err;
  if (val.cur !== undefined) cell.cur = val.cur;
  if (cell.vt !== 'currency') delete cell.cur;
  cell.rich = false;
  cell.dirty = true;
  return cell;
}
export function setStyle(sheet, r, c, st) {
  const row = ownRow(sheet, r);
  const cell = row && ownCell(row, c);
  if (!cell) return null;
  cell.st = st;
  cell.dirty = true;
  return cell;
}

//  +extent: [rows, cols] of the part of a sheet that holds anything: a
//  value, a formula or a merge. Trailing empty runs do not count.
export function extent(sheet) {
  let rows = 0, cols = 0, at = 0;
  for (const row of sheet.rows) {
    let c = 0, last = 0;
    for (const cell of row.cells) {
      if (cell.vt || cell.f || cell.text || cell.keep || cell.cs > 1 || cell.rs > 1) last = c + cell.rep;
      c += cell.rep;
    }
    if (last) {
      //  a repeated row with content counts once past its start: the run
      //  is real data only when it is short
      rows = at + Math.min(row.rep, 4096);
      if (last > cols) cols = last;
    }
    at += row.rep;
  }
  return [rows, Math.min(cols, MAX_COLS)];
}

// ── serializing ──────────────────────────────────────────────────────────

//  the text of a cell as <text:p> elements, as LibreOffice writes it:
//  one per line, runs of spaces as text:s, tabs as text:tab
function textPs(t) {
  if (t === '') return [];
  return t.split('\n').map((line) => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '\t') { out += '<text:tab/>'; i++; continue; }
      if (ch === ' ') {
        let j = i;
        while (line[j] === ' ') j++;
        const n = j - i;
        //  a lone space between words is a plain space. One at the start,
        //  and every space after the first, is text:s
        if (i === 0) out += n === 1 ? '<text:s/>' : `<text:s text:c="${n}"/>`;
        else if (n === 1) out += ' ';
        else out += ' ' + (n === 2 ? '<text:s/>' : `<text:s text:c="${n - 1}"/>`);
        i = j;
        continue;
      }
      let j = i;
      while (j < line.length && line[j] !== ' ' && line[j] !== '\t') j++;
      out += escText(line.slice(i, j));
      i = j;
    }
    return `<text:p>${out}</text:p>`;
  });
}

function cellXml(doc, cell, ind) {
  const name = cell.covered ? 'table:covered-table-cell' : 'table:table-cell';
  let a = '';
  const put = (k, v) => { a += ` ${k}="${escAttr(String(v))}"`; };
  if (cell.st) put('table:style-name', cell.st);
  for (const [k, raw] of cell.attrs) if (k === 'table:content-validation-name') a += ` ${k}="${raw}"`;
  if (cell.rep > 1) put('table:number-columns-repeated', cell.rep);
  if (cell.f) put('table:formula', cell.f);
  if (cell.vt) {
    put('office:value-type', cell.vt);
    if (cell.vt === 'string') {
      if (cell.f) put('office:string-value', cell.err ? '' : cell.v ?? '');
    } else if (cell.vt === 'boolean') put('office:boolean-value', cell.v ? 'true' : 'false');
    else if (cell.vt === 'date') put('office:date-value', serialDate(cell.v, doc.nullDate));
    else if (cell.vt === 'time') put('office:time-value', serialTime(cell.v));
    else {
      if (cell.vt === 'currency' && cell.cur) put('office:currency', cell.cur);
      put('office:value', numAttr(cell.v));
    }
    put('calcext:value-type', cell.err ? 'error' : cell.vt);
  }
  for (const [k, raw] of cell.attrs) {
    if (!VALUE_ATTRS.has(k) && k !== 'table:content-validation-name') a += ` ${k}="${raw}"`;
  }
  const ps = textPs(cell.text);
  if (!ps.length && !cell.keep) return `<${name}${a}/>`;
  const pad = '\n' + ' '.repeat(ind + 1);
  return `<${name}${a}>${cell.keep ? pad + cell.keep : ''}${ps.map((p) => pad + p).join('')}\n${' '.repeat(ind)}</${name}>`;
}

function rowXml(doc, row, ind) {
  let a = '';
  let rep = false;
  for (const [k, raw] of row.attrs) {
    if (k === 'table:number-rows-repeated') { rep = true; if (row.rep > 1) a += ` ${k}="${row.rep}"`; } else a += ` ${k}="${raw}"`;
  }
  if (!rep && row.rep > 1) a += ` table:number-rows-repeated="${row.rep}"`;
  const pad = '\n' + ' '.repeat(ind + 1);
  //  a row holds at least one cell
  const cells = row.cells.length ? row.cells : [blankCell(1)];
  const body = cells.map((c) => pad + (c.src && !c.dirty ? doc.text.slice(c.src[0], c.src[1]) : cellXml(doc, c, ind + 1))).join('');
  return `<table:table-row${a}>${body}\n${' '.repeat(ind)}</table:table-row>`;
}

function colXml(col) {
  let a = '';
  let rep = false;
  for (const [k, raw] of col.attrs) {
    if (k === 'table:number-columns-repeated') { rep = true; if (col.rep > 1) a += ` ${k}="${col.rep}"`; }
    else if (k === 'table:style-name') { if (col.st) a += ` ${k}="${escAttr(col.st)}"`; }
    else a += ` ${k}="${raw}"`;
  }
  if (!col.attrs.some(([k]) => k === 'table:style-name') && col.st) a = ` table:style-name="${escAttr(col.st)}"` + a;
  if (!rep && col.rep > 1) a += ` table:number-columns-repeated="${col.rep}"`;
  return `<table:table-column${a}/>`;
}

//  the indent of the element starting at `at`: the spaces back to its line start
function indentAt(text, at) {
  let i = at;
  while (i > 0 && text[i - 1] === ' ') i--;
  return i > 0 && text[i - 1] !== '\n' ? -1 : at - i;
}

//  one sheet's <table:table>, as edits to its source span. Returns the
//  list of [start, end, replacement] splices, in source order.
function sheetSplices(doc, sheet) {
  const out = [];
  const text = doc.text;
  //  a removed element goes with the line break and indent before it
  const cut = ([s, e]) => {
    let b = s;
    while (b > 0 && text[b - 1] === ' ') b--;
    if (b > 0 && text[b - 1] === '\n') b--;
    out.push([b, e, '']);
  };
  sheet.gone.forEach(cut);
  const emit = (items, xml, fallbackInd) => {
    let last = null;       // the last source-backed item seen: new ones go after it
    let pend = [];         // new items before any source-backed one
    for (const it of items) {
      if (it.src) {
        const ind = Math.max(indentAt(text, it.src[0]), 0);
        if (pend.length) {
          out.push([it.src[0], it.src[0], pend.map((p) => xml(p, ind) + '\n' + ' '.repeat(ind)).join('')]);
          pend = [];
        }
        if (it.dirty) out.push([it.src[0], it.src[1], xml(it, ind)]);
        last = it;
      } else if (last) {
        const ind = Math.max(indentAt(text, last.src[0]), 0);
        out.push([last.src[1], last.src[1], '\n' + ' '.repeat(ind) + xml(it, ind)]);
      } else pend.push(it);
    }
    return pend.length ? pend.map((p) => xml(p, fallbackInd)) : null;
  };
  const el = sheet.el;
  const elInd = Math.max(indentAt(text, el.start), 0);
  const looseCols = emit(sheet.cols, (c) => colXml(c), elInd + 1);
  const looseRows = emit(sheet.rows, (r, ind) => rowXml(doc, r, ind), elInd + 1);
  //  a table that had no column or row elements at all (hand-made input):
  //  put the new ones just inside it
  const pad = '\n' + ' '.repeat(elInd + 1);
  if (looseRows) out.push([el.closeStart, el.closeStart, looseRows.map((x) => ' ' + x + '\n' + ' '.repeat(elInd)).join('')]);
  if (looseCols) out.push([el.openEnd, el.openEnd, looseCols.map((x) => pad + x).join('')]);
  if (sheet.dirty) {
    //  the table's own start tag: its name changed
    const open = text.slice(el.start, el.openEnd).replace(/table:name="[^"]*"/, `table:name="${escAttr(sheet.name)}"`);
    out.push([el.start, el.openEnd, open]);
  }
  return out;
}

function newSheetXml(doc, sheet, ind) {
  const sp = ' '.repeat(ind);
  const a = ` table:name="${escAttr(sheet.name)}"` + (sheet.style ? ` table:style-name="${escAttr(sheet.style)}"` : '');
  const cols = sheet.cols.map((c) => `\n${sp} ${colXml(c)}`).join('');
  const rows = (sheet.rows.length ? sheet.rows : [blankRow(null, 1)]).map((r) => `\n${sp} ${rowXml(doc, r, ind + 1)}`).join('');
  return `<table:table${a}>${cols}${rows}\n${sp}</table:table>`;
}

//  +serializeFods: the model back to flat ODS text
export function serializeFods(doc) {
  const text = doc.text;
  let splices = [];
  let lastEl = null;
  for (const sheet of doc.sheets) {
    if (sheet.isNew) {
      const ind = lastEl ? Math.max(indentAt(text, lastEl.start), 0) : 3;
      const at = lastEl ? lastEl.end : doc.ss.openEnd;
      splices.push([at, at, '\n' + ' '.repeat(ind) + newSheetXml(doc, sheet, ind)]);
    } else {
      splices = splices.concat(sheetSplices(doc, sheet));
      lastEl = sheet.el;
    }
  }
  if (doc.newAuto.length) {
    //  new automatic styles go at the end of office:automatic-styles
    const au = doc.auto;
    if (au && !au.empty) {
      splices.push([au.closeStart, au.closeStart, doc.newAuto.map((s) => ' ' + s + '\n ').join('')]);
    } else if (au) {
      splices.push([au.start, au.end, '<office:automatic-styles>\n' + doc.newAuto.map((s) => '  ' + s + '\n').join('') + ' </office:automatic-styles>']);
    } else {
      const at = find(doc.docEl, 'office:body').start;
      splices.push([at, at, '<office:automatic-styles>\n' + doc.newAuto.map((s) => '  ' + s + '\n').join('') + ' </office:automatic-styles>\n ']);
    }
  }
  for (const [s, e, t] of doc.attrEdits || []) splices.push([s, e, t]);
  if (!splices.length) return text;
  //  stable by position: inserts at one point keep their order
  splices = splices.map((s, i) => [...s, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[3] - b[3]);
  let out = '';
  let pos = 0;
  for (const [s, e, t] of splices) {
    if (s < pos) {
      //  an edit inside a span already replaced or removed: the outer one won
      if (e <= pos) continue;
      out += t;
      pos = e;
      continue;
    }
    out += text.slice(pos, s) + t;
    pos = e;
  }
  return out + text.slice(pos);
}
