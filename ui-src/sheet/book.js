//  book.js: one open spreadsheet and every edit lattice makes to it.
//
//  No DOM here. The grid (view.js) and the test suites drive a Book: type
//  into a cell, format a range, insert or delete rows and columns, add a
//  sheet, undo. The Book keeps the model, its styles and its formula
//  engine in step, and gives back the flat ODS text.

import {
  parseFods, serializeFods, cellAt, setCell, setStyle, ownRow, extent, rowCount, MAX_ROWS, MAX_COLS, dateSerial,
} from './model.js';
import { Engine } from './engine.js';
import { Styles, fixed } from './styles.js';
import { toOf, toUser, FormulaError, moveFormula, moveAddrs, offsetFormula, hasBadRef, bodyOf, quoteSheet, renameInFormula } from './formula.js';
import { general } from './funcs.js';
import { attr, escAttr } from '../writer/xml.js';

const HISTORY_CHARS = 24 * 1024 * 1024;

//  what a typed text is: { vt, v, kind } where kind names the number
//  format it wants ('percent', 'currency', 'date', 'time') or is null
const NUM = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
export function readTyped(text, nullDate) {
  const t = text.trim();
  if (t === '') return { vt: null, v: null, kind: null };
  if (text[0] === "'") return { vt: 'string', v: text.slice(1), kind: null };
  if (/\d/.test(t) && NUM.test(t)) return { vt: 'float', v: Number(t.replace(/,/g, '')), kind: null };
  let m = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*%$/.exec(t);
  if (m) return { vt: 'percentage', v: Number(m[1]) / 100, kind: 'percent' };
  m = /^(-)?\$\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)$/.exec(t);
  if (m) return { vt: 'currency', v: Number(m[2].replace(/,/g, '')) * (m[1] ? -1 : 1), kind: 'currency', cur: 'USD' };
  if (/^true$/i.test(t)) return { vt: 'boolean', v: true, kind: null };
  if (/^false$/i.test(t)) return { vt: 'boolean', v: false, kind: null };
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
    return { vt: 'date', v: dateSerial(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, nullDate), kind: 'date' };
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m && +m[2] < 60 && +(m[3] || 0) < 60) return { vt: 'time', v: (+m[1] * 3600 + +m[2] * 60 + +(m[3] || 0)) / 86400, kind: 'time' };
  return { vt: 'string', v: text, kind: null };
}

const KIND_VT = { percent: 'percentage', currency: 'currency', date: 'date', time: 'time' };

// ── what a structural edit must rewrite, and what stops it ───────────────

//  the attributes that hold cell addresses lattice rewrites when rows or
//  columns move: element -> [[attribute, 'addr' | 'expr']]
const MOVES = {
  'table:named-range': [['table:cell-range-address', 'addr'], ['table:base-cell-address', 'addr']],
  'table:named-expression': [['table:base-cell-address', 'addr'], ['table:expression', 'expr']],
  'table:database-range': [['table:target-range-address', 'addr']],
  'table:table': [['table:print-ranges', 'addr']],
  'calcext:conditional-format': [['calcext:target-range-address', 'addr']],
  'calcext:condition': [['calcext:base-cell-address', 'addr'], ['calcext:value', 'expr']],
  'calcext:color-scale-entry': [['calcext:value', 'expr']],
  'table:content-validation': [['table:base-cell-address', 'addr'], ['table:condition', 'expr']],
};
//  elements that hold ranges lattice does not rewrite: with one of these
//  in the document, rows and columns cannot move
const BLOCKS = {
  'table:data-pilot-table': 'a pivot table', 'draw:object': 'a chart or an embedded object', 'table:scenario': 'a scenario',
  'table:tracked-changes': 'recorded changes', 'table:detective': 'a detective trace', 'table:consolidation': 'a consolidation',
  'table:cell-range-source': 'a linked range', 'table:table-source': 'a linked sheet', 'chart:chart': 'a chart',
};
const RANGEISH = /(?:^|:)(?:[a-z-]*cell-range-address[a-z-]*|[a-z-]*range-address|[a-z-]*cell-address|print-ranges|notify-on-update-of-ranges|cell-ranges|buttons)$/;

export class Book {
  constructor(text) {
    this.history = [];
    this.future = [];
    this.error = null;
    this.load(text);
  }

  load(text) {
    const doc = parseFods(text);
    if (doc.error) { this.error = doc.error; return false; }
    this.error = null;
    this.doc = doc;
    this.styles = new Styles(doc);
    this.engine = new Engine(doc, (s, r, c, v, vt) => this.styles.text(this.styleAt(s, r, c), v, vt));
    this.base = text;
    this.touched = false;
    return true;
  }

  get sheets() { return this.doc.sheets; }
  styleAt(s, r, c) {
    const sheet = this.doc.sheets[s];
    return this.styles.nameAt(sheet, cellAt(sheet, r, c), c);
  }

  //  the text now. The same string as loaded when nothing was edited.
  text() { return this.touched ? serializeFods(this.doc) : this.base; }

  // ── undo ───────────────────────────────────────────────────────────────

  //  call before an edit: the text as it is goes on the undo stack
  mark() {
    const t = this.text();
    if (this.history[this.history.length - 1] !== t) this.history.push(t);
    let total = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      total += this.history[i].length;
      if (total > HISTORY_CHARS) { this.history.splice(0, i + 1); break; }
    }
    this.future = [];
  }
  undo() {
    if (!this.history.length) return false;
    this.future.push(this.text());
    this.load(this.history.pop());
    return true;
  }
  redo() {
    if (!this.future.length) return false;
    this.history.push(this.text());
    this.load(this.future.pop());
    return true;
  }
  //  reparse from the model's own text: after an edit that moved spans
  reload() {
    const t = serializeFods(this.doc);
    const ok = this.load(t);
    return ok;
  }

  // ── reading ────────────────────────────────────────────────────────────

  cell(s, r, c) { return cellAt(this.doc.sheets[s], r, c); }
  //  what the formula bar shows for a cell, and what typing it back keeps
  input(s, r, c) {
    const cell = this.cell(s, r, c);
    if (cell.f) return toUser(cell.f);
    if (!cell.vt) return '';
    if (cell.vt === 'string') {
      const t = cell.v ?? cell.text;
      const as = readTyped(t, this.doc.nullDate);
      return as.vt !== 'string' || t[0] === '=' || t[0] === "'" ? "'" + t : t;
    }
    if (cell.vt === 'boolean') return cell.v ? 'TRUE' : 'FALSE';
    if (cell.vt === 'percentage') return general(Number((cell.v * 100).toPrecision(15))) + '%';
    if (cell.vt === 'date') return this.styles.text(null, cell.v, 'date') + (cell.v % 1 ? ' ' + this.styles.text(null, cell.v % 1, 'time') : '');
    if (cell.vt === 'time') return this.styles.text(null, cell.v, 'time');
    return general(cell.v);
  }
  look(s, r, c) { return this.styles.lookOf(this.styleAt(s, r, c)); }
  stale(s, r, c) { return this.engine.isStale(s, r, c); }
  extent(s) { return extent(this.doc.sheets[s]); }

  // ── writing cells ──────────────────────────────────────────────────────

  //  +enter: what was typed into a cell. Returns { changed: [[s, r, c]] }
  //  or { error }. Call mark() first when it should be one undo step.
  enter(s, r, c, typed) {
    const sheet = this.doc.sheets[s];
    if (!sheet || r < 0 || c < 0 || r >= MAX_ROWS || c >= MAX_COLS) return { error: 'outside the sheet' };
    const was = cellAt(sheet, r, c);
    if (was.covered) return { error: 'that cell is part of a merged cell' };
    this.touched = true;
    if (typed.length > 1 && typed[0] === '=') {
      let f;
      try { f = toOf(typed); } catch (e) {
        if (e instanceof FormulaError) return { error: 'that formula cannot be read: ' + e.message };
        throw e;
      }
      return this.putFormula(s, r, c, f);
    }
    const val = readTyped(typed, this.doc.nullDate);
    let st = this.styleAt(s, r, c);
    const has = this.styles.dataKind(this.styles.lookOf(st).data);
    if (val.vt === 'float' && has) {
      //  a plain number typed into a formatted cell takes the format's type
      val.vt = KIND_VT[has];
      if (has === 'percent') val.v /= 100;
      if (has === 'currency') val.cur = was.cur || 'USD';
    } else if (val.kind && val.kind !== has) {
      st = this.styles.restyle(st, { data: this.styles.dataStyle(val.kind) });
      setStyle(sheet, r, c, st);
    }
    val.f = null;
    val.text = val.vt === 'string' ? val.v : this.styles.text(st, val.v, val.vt);
    setCell(sheet, r, c, val);
    this.engine.setFormula(s, r, c, null);
    const changed = this.engine.recalc([[s, r, c]]);
    return { changed: [[s, r, c], ...changed] };
  }

  //  a stored formula into a cell, and its value computed
  putFormula(s, r, c, f) {
    const sheet = this.doc.sheets[s];
    this.touched = true;
    const was = cellAt(sheet, r, c);
    //  until it is computed the cell holds no value: if lattice cannot
    //  evaluate it, LibreOffice will when it opens the file
    setCell(sheet, r, c, { vt: null, v: null, f, text: '', cur: was.cur });
    const e = this.engine.setFormula(s, r, c, f);
    const changed = this.engine.recalc([[s, r, c]], [e]);
    return { changed: [[s, r, c], ...changed] };
  }

  //  +copyCell: one cell's content (not its style) from another place, a
  //  formula's relative references moved with it
  copyCell(from, s, r, c) {
    if (from.f) {
      const f = offsetFormula(from.f, r - from.r, c - from.c);
      if (f) return this.putFormula(s, r, c, f);
    }
    const sheet = this.doc.sheets[s];
    this.touched = true;
    setCell(sheet, r, c, { vt: from.vt, v: from.v, f: null, text: from.text, err: false, cur: from.cur });
    this.engine.setFormula(s, r, c, null);
    return { changed: [[s, r, c], ...this.engine.recalc([[s, r, c]])] };
  }

  //  +format: a formatting change over a rectangle. change is { bold,
  //  italic, underline, align } or { number: 'general' | 'number' |
  //  'percent' | 'currency' | 'date' | 'time' }.
  format(s, r1, c1, r2, c2, change) {
    const sheet = this.doc.sheets[s];
    this.touched = true;
    const ch = { ...change };
    if ('number' in ch) { ch.data = this.styles.dataStyle(ch.number); delete ch.number; }
    const out = [];
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const cell = cellAt(sheet, r, c);
        if (cell.covered) continue;
        const st = this.styles.restyle(this.styleAt(s, r, c), ch);
        const own = setStyle(sheet, r, c, st);
        if ('data' in ch && own.vt && own.vt !== 'string' && own.vt !== 'boolean' && typeof own.v === 'number') {
          const kind = change.number;
          own.vt = KIND_VT[kind] || 'float';
          if (own.vt === 'currency') own.cur = own.cur || 'USD'; else delete own.cur;
          own.text = this.styles.text(st, own.v, own.vt);
        }
        out.push([s, r, c]);
      }
    }
    return { changed: out };
  }

  // ── sheets ─────────────────────────────────────────────────────────────

  addSheet(name) {
    const have = new Set(this.doc.sheets.map((x) => x.name.toLowerCase()));
    let nm = (name || '').trim();
    if (!nm) { let i = this.doc.sheets.length + 1; do nm = 'Sheet' + i++; while (have.has(nm.toLowerCase())); }
    const why = this.badSheetName(nm, -1);
    if (why) return { error: why };
    const first = this.doc.sheets[0];
    this.doc.sheets.push({ el: null, name: nm, style: first ? first.style : null, rows: [], cols: [], gone: [], dirty: false, isNew: true });
    this.touched = true;
    this.reload();
    return { sheet: this.doc.sheets.length - 1 };
  }
  badSheetName(nm, self) {
    if (!nm) return 'a sheet needs a name';
    if (nm.length > 100 || /[[\]*?:/\\]/.test(nm) || nm[0] === "'" || nm[nm.length - 1] === "'") return 'a sheet name cannot hold [ ] * ? : / \\ or start or end with an apostrophe';
    if (this.doc.sheets.some((x, i) => i !== self && x.name.toLowerCase() === nm.toLowerCase())) return 'there is already a sheet with that name';
    return null;
  }

  // ── rows and columns ───────────────────────────────────────────────────

  //  +blocked: why rows (dim 'r') or columns (dim 'c') cannot be inserted
  //  (n > 0) or deleted (n < 0) at `at` on sheet s, or null when they can
  blocked(s, dim, at, n) {
    const { doc } = this;
    const sheet = doc.sheets[s];
    const cnt = Math.abs(n);
    if (!sheet || cnt < 1 || at < 0) return 'nothing to do';
    const max = dim === 'r' ? MAX_ROWS : MAX_COLS;
    if (at + cnt > max) return 'that is past the edge of the sheet';
    //  anything that holds ranges lattice does not rewrite
    let why = null;
    const body = doc.docEl.kids.find((k) => k.name === 'office:body');
    const walk = (el) => {
      if (why) return;
      for (const k of el.kids) {
        if (!k.name || why) continue;
        if (BLOCKS[k.name]) { why = `this spreadsheet has ${BLOCKS[k.name]}, which lattice cannot keep in step`; return; }
        const known = MOVES[k.name] || [];
        for (const [a] of k.attrs) {
          if (RANGEISH.test(a) && !known.some(([x]) => x === a) && a !== 'table:end-cell-address') {
            why = `this spreadsheet has a ${k.name.replace(/^[a-z]+:/, '').replace(/-/g, ' ')} lattice cannot keep in step`;
            return;
          }
        }
        if (k.name !== 'table:table-row') walk(k);
        else {
          //  inside rows only shapes carry addresses
          for (const cell of k.kids) if (cell.name) for (const x of cell.kids) if (x.name && x.name.startsWith('draw:')) walk({ kids: [x] });
        }
      }
    };
    walk(body);
    if (why) return why;
    //  a merged cell the edit would cut through
    let r = 0;
    for (const row of sheet.rows) {
      let c = 0;
      for (const cell of row.cells) {
        if (cell.cs > 1 || cell.rs > 1) {
          for (let i = 0; i < Math.min(row.rep, 1024); i++) {
            const lo = dim === 'r' ? r + i : c, span = dim === 'r' ? cell.rs : cell.cs, hi = lo + span - 1;
            const cut = n > 0 ? lo < at && hi >= at : (lo < at && hi >= at) || (lo >= at && lo < at + cnt && hi >= at + cnt);
            if (cut) return 'that would cut through a merged cell';
          }
        }
        c += cell.rep;
      }
      r += row.rep;
    }
    //  every formula must be one lattice can move
    for (const sh of doc.sheets) {
      for (const row of sh.rows) for (const cell of row.cells) if (cell.f && bodyOf(cell.f) !== null && moveFormula(cell.f, sh.name, { sheet: sheet.name, dim, at, n }) === null) return 'a formula here is one lattice cannot read, so it cannot be moved safely';
    }
    return null;
  }

  //  +shift: insert (n > 0) or delete (n < 0) rows or columns. Returns
  //  { error } or { ok: true }. One undo step: call mark() first.
  shift(s, dim, at, n) {
    const why = this.blocked(s, dim, at, n);
    if (why) return { error: why };
    const { doc } = this;
    const sheet = doc.sheets[s];
    const op = { sheet: sheet.name, dim, at, n };
    const cnt = Math.abs(n);
    this.touched = true;

    // 1. the references, everywhere
    for (const sh of doc.sheets) {
      for (const row of sh.rows) {
        for (const cell of row.cells) {
          if (!cell.f) continue;
          const f = moveFormula(cell.f, sh.name, op);
          if (f !== null && f !== cell.f) { cell.f = f; cell.dirty = true; row.dirty = true; }
        }
      }
    }
    const edits = [];
    const text = doc.text;
    const fix = (el) => {
      for (const k of el.kids) {
        if (!k.name) continue;
        const known = MOVES[k.name];
        const list = known ? [...known] : [];
        if (k.attrs.some(([a]) => a === 'table:end-cell-address')) list.push(['table:end-cell-address', 'addr']);
        for (const [a, kind] of list) {
          const raw = k.attrs.find(([x]) => x === a);
          if (!raw) continue;
          const val = attr(k, a);
          let next;
          if (kind === 'addr') next = moveAddrs(val, op);
          else if (!val.includes('[')) next = val;
          else {
            const head = bodyOf(val) === null ? 'of:=' : '';
            const moved = moveFormula(head + val, sheet.name, op);
            next = moved === null ? null : moved.slice(head.length);
          }
          if (next === null || next === val) continue;
          const open = text.slice(k.start, k.openEnd);
          const at0 = open.indexOf(` ${a}="${raw[1]}"`);
          if (at0 < 0) continue;
          const vs = k.start + at0 + a.length + 3;
          edits.push([vs, vs + raw[1].length, escAttr(next)]);
        }
        if (k.name !== 'table:table-row') fix(k);
      }
    };
    fix(doc.docEl.kids.find((k) => k.name === 'office:body'));
    doc.attrEdits = (doc.attrEdits || []).concat(edits);

    // 2. the rows or columns themselves
    if (dim === 'r') this.shiftRows(sheet, at, n, cnt);
    else this.shiftCols(sheet, at, n, cnt);

    // 3. spans moved: start again from the new text, then recompute what
    //    now points at nothing
    if (!this.reload()) return { error: this.error };
    this.touched = true;
    //  a delete takes values out of ranges, so every formula is computed
    //  again. An insert only adds empty cells: just what now points at
    //  nothing.
    const again = n < 0 ? this.engine.formulas : this.engine.formulas.filter((e) => hasBadRef(e.f));
    if (again.length) this.engine.recalc(again.map((e) => [e.s, e.r, e.c]), again);
    return { ok: true };
  }

  //  a run boundary at row index `at`: the index of the run that starts there
  splitRows(sheet, at) {
    let r = 0;
    for (let i = 0; i < sheet.rows.length; i++) {
      const row = sheet.rows[i];
      if (r === at) return i;
      if (at < r + row.rep) {
        const tail = { src: null, rep: row.rep - (at - r), attrs: row.attrs, cells: row.cells.map((c) => ({ ...c, src: null, dirty: true })), dirty: true };
        row.rep = at - r;
        row.dirty = true;
        sheet.rows.splice(i + 1, 0, tail);
        return i + 1;
      }
      r += row.rep;
    }
    return -1;      // past the stored rows
  }
  shiftRows(sheet, at, n, cnt) {
    const i = this.splitRows(sheet, at);
    if (n > 0) {
      if (i < 0) return;                       // below everything stored
      const like = sheet.rows[i - 1] || sheet.rows[i];
      sheet.rows.splice(i, 0, { src: null, rep: cnt, dirty: true, cells: [], attrs: like ? like.attrs.filter(([k]) => k === 'table:style-name') : [] });
      this.trim(sheet);
      return;
    }
    if (i < 0) return;
    let j = this.splitRows(sheet, at + cnt);
    if (j < 0) j = sheet.rows.length;
    for (const row of sheet.rows.splice(i, j - i)) if (row.src) sheet.gone.push(row.src);
    if (!sheet.rows.length) ownRow(sheet, 0);
  }
  //  rows pushed past the last one fall off, as in LibreOffice
  trim(sheet) {
    let over = rowCount(sheet) - MAX_ROWS;
    while (over > 0 && sheet.rows.length) {
      const last = sheet.rows[sheet.rows.length - 1];
      if (last.rep > over) { last.rep -= over; last.dirty = true; over = 0; } else { over -= last.rep; if (last.src) sheet.gone.push(last.src); sheet.rows.pop(); }
    }
  }
  shiftCols(sheet, at, n, cnt) {
    const splitAt = (list, idx, clone) => {
      let c = 0;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (c === idx) return i;
        if (idx < c + it.rep) {
          const tail = clone(it, it.rep - (idx - c));
          it.rep = idx - c;
          it.dirty = true;
          list.splice(i + 1, 0, tail);
          return i + 1;
        }
        c += it.rep;
      }
      return -1;
    };
    const cloneCell = (c, rep) => ({ ...c, src: null, rep, dirty: true });
    const blank = (rep, st) => ({ src: null, rep, covered: false, attrs: [], st: st || null, vt: null, v: null, f: null, text: '', keep: '', err: false, cs: 1, rs: 1, dirty: true, rich: false });
    for (const row of sheet.rows) {
      const i = splitAt(row.cells, at, cloneCell);
      if (i < 0) continue;
      row.dirty = true;
      for (const c of row.cells) c.dirty = true;
      if (n > 0) {
        //  the new cells take the look of the column to their left
        const left = row.cells[i - 1];
        row.cells.splice(i, 0, blank(cnt, left && !left.covered ? left.st : null));
      } else {
        let j = splitAt(row.cells, at + cnt, cloneCell);
        if (j < 0) j = row.cells.length;
        row.cells.splice(i, j - i);
        if (!row.cells.length) row.cells.push(blank(1));
      }
    }
    const cloneCol = (c, rep) => ({ ...c, src: null, rep, dirty: true });
    const i = splitAt(sheet.cols, at, cloneCol);
    if (i < 0) return;
    if (n > 0) {
      const like = sheet.cols[i - 1] || sheet.cols[i];
      sheet.cols.splice(i, 0, { ...like, src: null, rep: cnt, dirty: true });
      //  columns pushed past the last one fall off
      let over = sheet.cols.reduce((a, c) => a + c.rep, 0) - MAX_COLS;
      while (over > 0 && sheet.cols.length) {
        const last = sheet.cols[sheet.cols.length - 1];
        if (last.rep > over) { last.rep -= over; last.dirty = true; over = 0; } else { over -= last.rep; if (last.src) sheet.gone.push(last.src); sheet.cols.pop(); }
      }
    } else {
      let j = splitAt(sheet.cols, at + cnt, cloneCol);
      if (j < 0) j = sheet.cols.length;
      for (const col of sheet.cols.splice(i, j - i)) if (col.src) sheet.gone.push(col.src);
    }
  }

  //  +resize: a column's width or a row's height, in CSS pixels
  resize(s, dim, at, pxSize) {
    const sheet = this.doc.sheets[s];
    const cm = (Math.max(pxSize, 4) / 37.795).toFixed(3) + 'cm';
    this.touched = true;
    if (dim === 'c') {
      const xml = (name) => `<style:style style:name="${name}" style:family="table-column"><style:table-column-properties fo:break-before="auto" style:column-width="${cm}"/></style:style>`;
      const name = 'Lco' + cm.replace(/[^0-9]/g, '');
      if (!this.styles.col.has(name) && !this.doc.newAuto.some((x) => x.includes(`"${name}"`))) this.doc.newAuto.push(xml(name));
      let c = 0;
      for (let i = 0; i < sheet.cols.length; i++) {
        const col = sheet.cols[i];
        if (at < c + col.rep) {
          const parts = [];
          const before = at - c, after = col.rep - before - 1;
          if (before) parts.push({ ...col, rep: before, dirty: true });
          parts.push({ ...col, src: before ? null : col.src, rep: 1, st: name, dirty: true });
          if (after) parts.push({ ...col, src: null, rep: after, dirty: true });
          if (before) parts[0].src = col.src;
          sheet.cols.splice(i, 1, ...parts);
          break;
        }
        c += col.rep;
      }
    } else {
      const name = 'Lro' + cm.replace(/[^0-9]/g, '');
      const xml = `<style:style style:name="${name}" style:family="table-row"><style:table-row-properties style:row-height="${cm}" fo:break-before="auto" style:use-optimal-row-height="false"/></style:style>`;
      if (!this.styles.row.has(name) && !this.doc.newAuto.some((x) => x.includes(`"${name}"`))) this.doc.newAuto.push(xml);
      const row = ownRow(sheet, at);
      row.attrs = [['table:style-name', name], ...row.attrs.filter(([k]) => k !== 'table:style-name')];
      row.dirty = true;
    }
    return this.reload();
  }
}

export { fixed, quoteSheet, renameInFormula };
