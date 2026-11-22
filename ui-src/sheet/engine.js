//  engine.js: evaluates formulas over the model, and recalculates what an
//  edit makes stale.
//
//  Recalculation is narrow on purpose. Opening a sheet computes nothing,
//  so a file that was only looked at saves byte-identical. An edit
//  recomputes the cells that depend on it, directly or through other
//  formulas, and nothing else. A formula lattice cannot evaluate (a
//  function it does not know, an array, a syntax it cannot read) keeps the
//  result LibreOffice last cached and is reported stale, never guessed.

import { cellAt, extent, setCell, setUnsure, rowCount, MAX_COLS } from './model.js';
import { parse, bodyOf, parseAddrs } from './formula.js';
import { FUNCS, LAZY, Range, Err, E, Unsupported, toNum, toStr, compareOp, power } from './funcs.js';
import { attr } from '../writer/xml.js';

const key = (s, r, c) => s * 17179869184 + r * 16384 + c;
const rowKey = (s, r) => s * 1048576 + r;
//  the bounds on the work of one edit. Past one, a formula keeps its
//  cached value and is marked stale: never a wrong value shown as right.
const MAX_STEPS = 5000000;      // cells one outermost formula may read
const MAX_TOTAL = 50000000;     // cells one recalculation may read
const MAX_CHECKS = 20000000;    // tests made to find what an edit reaches
const SPAN = 32;                // rows or columns a rectangle is indexed under, at most
//  a walk stopped at a bound, as opposed to a formula lattice cannot read
class Cut extends Unsupported {}
const isErr = (v) => v instanceof Err;
const ERR_BY_TEXT = new Map(Object.values(E).map((e) => [e.code, e]));

//  a model cell's value, as formulas see it
export function cellValue(cell) {
  if (cell.err) return ERR_BY_TEXT.get(cell.text) || new Err(cell.text || '#VALUE!');
  //  a formula with no cached type gave an empty text
  if (!cell.vt) return cell.f ? '' : null;
  if (cell.vt === 'string') return cell.v ?? '';
  if (cell.vt === 'boolean') return !!cell.v;
  return typeof cell.v === 'number' ? cell.v : 0;
}

export class Engine {
  //  format(sheetIndex, r, c, value, vt) -> display text, from the cell's style
  constructor(doc, format) {
    this.doc = doc;
    this.format = format;
    this.asts = new Map();
    this.pending = new Map();     // key -> entry, to compute
    this.busy = new Set();        // keys being computed: a cycle if met again
    this.stale = new Set();       // keys lattice could not recompute
    //  keys that stopped at a bound, or read one that did. What reads one
    //  of these is not computed from it either.
    this.cut = new Set();
    this.missed = new Set();      // entries a search cut short did not reach
    this.deep = [];               // keys that ran out of stack, in the order met
    this.left = false;            // a formula inside another was left to be computed on its own
    this.retry = [];              // formulas that stopped because of one left over
    this.tainted = false;
    this.changed = [];
    this.steps = 0;
    this.total = 0;
    this.checks = 0;
    this.maxTotal = MAX_TOTAL;
    this.maxChecks = MAX_CHECKS;
    this.reindex();
  }

  sheetIndex(name) {
    const n = name.toLowerCase();
    return this.doc.sheets.findIndex((s) => s.name.toLowerCase() === n);
  }

  //  rebuild what depends on the shape of the document: the formula list,
  //  the named ranges, the used extents. After any structural edit.
  reindex() {
    this.usedCache = new Map();
    this.names = new Map();
    this.readNames();
    this.formulas = [];
    this.readers = { rows: new Map(), cols: new Map(), wide: [], wild: [] };
    this.dead = 0;
    this.doc.sheets.forEach((sheet, s) => {
      let r = 0;
      for (const row of sheet.rows) {
        if (row.cells.some((c) => c.f)) {
          const reps = Math.min(row.rep, 2048);
          for (let i = 0; i < reps; i++) {
            let c = 0;
            for (const cell of row.cells) {
              if (cell.f) {
                for (let j = 0; j < Math.min(cell.rep, 256); j++) {
                  const e = this.index(this.entry(s, r + i, c + j, cell.f));
                  this.formulas.push(e);
                  //  a formula with no value was not computed (it stopped
                  //  at a bound, or was never computed): it is marked, and
                  //  what reads it is not computed from nothing
                  if (!cell.vt) { this.stale.add(e.k); this.cut.add(e.k); }
                }
              }
              c += cell.rep;
            }
          }
        }
        r += row.rep;
      }
    });
  }

  entry(s, r, c, f) {
    const e = { s, r, c, f, k: key(s, r, c), deps: null, bad: false, dead: false };
    const ast = this.ast(f);
    if (!ast) { e.bad = true; e.deps = []; return e; }
    //  a formula too long to walk is left alone, as one too deep to parse is
    try { e.deps = this.depsOf(ast, s); } catch (x) {
      if (!(x instanceof RangeError)) throw x;
      e.bad = true;
      e.deps = [];
      e.deps.wild = true;
    }
    return e;
  }

  //  file a formula under what it reads, so the formulas that read a
  //  cell are looked up and not searched for: a short rectangle under
  //  each of its rows, a tall narrow one under each of its columns, and
  //  one that is both tall and wide on a list tried for every cell.
  index(e) {
    const { rows, cols, wide, wild } = this.readers;
    if (e.deps.wild) wild.push(e);
    const file = (map, k, v) => { const list = map.get(k); if (list) list.push(v); else map.set(k, [v]); };
    for (const [s, r1, c1, r2, c2] of e.deps) {
      if (r2 - r1 < SPAN) for (let r = r1; r <= r2; r++) file(rows, rowKey(s, r), [e, c1, c2]);
      else if (c2 - c1 < SPAN) for (let c = c1; c <= c2; c++) file(cols, rowKey(s, c), [e, s, r1, c1, r2, c2]);
      else wide.push([e, s, r1, c1, r2, c2]);
    }
    return e;
  }

  ast(f) {
    if (this.asts.has(f)) return this.asts.get(f);
    let ast = null;
    const body = bodyOf(f);
    if (body !== null) { try { ast = parse(body, 'of'); } catch { ast = null; } }
    this.asts.set(f, ast);
    return ast;
  }

  readNames() {
    const { doc } = this;
    const read = (box, s) => {
      if (!box) return;
      for (const k of box.kids) {
        if (k.name === 'table:named-range') {
          const refs = parseAddrs(attr(k, 'table:cell-range-address') || '');
          const nm = attr(k, 'table:name');
          if (nm && refs && refs.length === 1) this.names.set(nm.toLowerCase(), { ref: refs[0], home: s });
        } else if (k.name === 'table:named-expression') {
          const nm = attr(k, 'table:name');
          const ex = attr(k, 'table:expression') || '';
          let ast = null;
          try { ast = parse(bodyOf(ex) ?? ex, 'of'); } catch { ast = null; }
          if (nm) this.names.set(nm.toLowerCase(), { ast, home: s });
        }
      }
    };
    const find = (el) => el.kids.find((k) => k.name === 'table:named-expressions');
    doc.sheets.forEach((sh, s) => { if (sh.el) read(find(sh.el), s); });
    read(find(doc.ss), 0);
  }

  //  the rectangles a formula reads: [s, r1, c1, r2, c2]
  depsOf(ast, home, seen = new Set()) {
    const out = [];
    //  a reference this engine does not read (across sheets, another
    //  file) gives no rectangle. The formula is never recomputed anyway:
    //  evaluating it says Unsupported and it keeps its cached value.
    //  `wild` then says it may read anything, so any edit has it looked
    //  at again and marked as not recomputed.
    const rect = (ref, h) => { try { return this.range(ref, h); } catch (x) { if (x instanceof Unsupported) { out.wild = true; return null; } throw x; } };
    const walk = (n) => {
      if (!n) return;
      switch (n.t) {
        case 'ref': { const rg = rect(n.ref, home); if (rg instanceof Range) out.push([rg.s, rg.r1, rg.c1, rg.r2, rg.c2]); break; }
        case 'name': {
          const nm = this.names.get(n.name.toLowerCase());
          if (!nm || seen.has(n.name.toLowerCase())) break;
          seen.add(n.name.toLowerCase());
          if (nm.ref) { const rg = rect(nm.ref, nm.home); if (rg instanceof Range) out.push([rg.s, rg.r1, rg.c1, rg.r2, rg.c2]); }
          else if (nm.ast) { const sub = this.depsOf(nm.ast, nm.home, seen); if (sub.wild) out.wild = true; out.push(...sub); }
          break;
        }
        case 'paren': case 'un': case 'pct': walk(n.x); break;
        case 'bin': walk(n.l); walk(n.r); break;
        case 'call': n.args.forEach(walk); break;
        default:
      }
    };
    walk(ast);
    return out;
  }

  range(ref, home) {
    if (ref.unknown) throw new Unsupported('a reference lattice cannot read');
    if (ref.bad) return E.ref;
    const s1 = ref.a.sheet === null ? home : this.sheetIndex(ref.a.sheet);
    if (s1 < 0) return E.ref;
    const b = ref.b || ref.a;
    const s2 = ref.b && ref.b.sheet !== null ? this.sheetIndex(ref.b.sheet) : s1;
    if (s2 !== s1) throw new Unsupported('a reference across sheets');
    return new Range(this, s1, ref.a.r, ref.a.c, b.r, b.c);
  }

  used(s) {
    let u = this.usedCache.get(s);
    if (!u) { u = extent(this.doc.sheets[s]); this.usedCache.set(s, u); }
    return u;
  }

  //  the value at a cell, computing it first when it is waiting to be
  value(s, r, c) {
    //  every cell a formula reads counts against its budget, however the
    //  function reading it walks its range
    if (++this.steps > MAX_STEPS) throw new Cut('too many cells');
    const k = key(s, r, c);
    const e = this.pending.get(k);
    const sheet = this.doc.sheets[s];
    const v = e ? this.compute(e) : sheet ? cellValue(cellAt(sheet, r, c)) : E.ref;
    if (this.cut.size && this.cut.has(k)) this.tainted = true;
    else if (this.stale.size && this.stale.has(k) && !e && sheet && !cellAt(sheet, r, c).vt) this.tainted = true;
    return v;
  }

  //  fn(value, r, c) for every cell of the rectangle that holds something
  each(s, r1, c1, r2, c2, fn) {
    const sheet = this.doc.sheets[s];
    if (!sheet) return;
    let r = 0;
    for (const row of sheet.rows) {
      const top = r, bot = r + row.rep - 1;
      r += row.rep;
      if (bot < r1) continue;
      if (top > r2) break;
      if (!row.cells.some((c) => c.vt || c.f)) continue;
      const lo = Math.max(top, r1), hi = Math.min(bot, r2);
      for (let rr = lo; rr <= hi; rr++) {
        let c = 0;
        for (const cell of row.cells) {
          const left = c, right = c + cell.rep - 1;
          c += cell.rep;
          if (right < c1) continue;
          if (left > c2) break;
          //  a formula with no value is read too: it may be waiting, or
          //  stopped at a bound, and what reads it is then not right
          if (!cell.vt && !cell.f) continue;
          for (let cc = Math.max(left, c1); cc <= Math.min(right, c2); cc++) {
            //  a hostile run (a million rows of sixteen thousand cells) is
            //  not walked: the formula keeps its cached result
            let v;
            if (this.pending.size || !cell.vt) {
              v = this.value(s, rr, cc);
              if (!cell.vt && !cellAt(sheet, rr, cc).vt) continue;
            }
            else if (++this.steps > MAX_STEPS) throw new Cut('too many cells');
            else v = cellValue(cell);
            if (v !== null) fn(v, rr, cc);
          }
        }
      }
    }
  }

  // ── evaluation ─────────────────────────────────────────────────────────

  //  one value from what an expression gave: a one-cell range is its
  //  cell, a column or row is the cell on the formula's own row or column
  one(v, ctx) {
    if (!(v instanceof Range)) return v;
    if (v.single) return v.at(0, 0);
    if (v.cols === 1 && ctx.s === v.s && ctx.r >= v.r1 && ctx.r <= v.r2) return this.value(v.s, ctx.r, v.c1);
    if (v.rows === 1 && ctx.s === v.s && ctx.c >= v.c1 && ctx.c <= v.c2) return this.value(v.s, v.r1, ctx.c);
    return E.value;
  }

  ev(n, ctx) {
    switch (n.t) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'err': return ERR_BY_TEXT.get(n.v) || new Err(n.v);
      case 'missing': return undefined;
      case 'ref': return this.range(n.ref, ctx.s);
      case 'paren': return this.ev(n.x, ctx);
      case 'name': {
        const nm = this.names.get(n.name.toLowerCase());
        if (!nm) return E.name;
        if (nm.ref) return this.range(nm.ref, nm.home);
        if (!nm.ast) throw new Unsupported('a named expression');
        if (ctx.depth > 32) return E.cycle;
        return this.ev(nm.ast, { ...ctx, s: nm.home, depth: (ctx.depth || 0) + 1 });
      }
      case 'un': {
        const v = toNum(this.one(this.ev(n.x, ctx), ctx));
        return isErr(v) ? v : n.op === '-' ? -v : v;
      }
      case 'pct': {
        const v = toNum(this.one(this.ev(n.x, ctx), ctx));
        return isErr(v) ? v : v / 100;
      }
      case 'bin': return this.bin(n, ctx);
      case 'call': {
        const lazy = LAZY[n.name];
        if (lazy) return lazy(n.args, (x) => this.ev(x, ctx));
        const fn = FUNCS[n.name];
        if (!fn) throw new Unsupported(n.name);
        const args = n.args.map((a) => this.ev(a, ctx));
        //  a trailing missing argument is no argument
        while (args.length && args[args.length - 1] === undefined && n.args[args.length - 1].t === 'missing') args.pop();
        const v = fn(args, this, ctx);
        if (typeof v === 'number' && !Number.isFinite(v)) return E.num;
        return v;
      }
      default: throw new Unsupported(n.t);
    }
  }

  bin(n, ctx) {
    const l = this.one(this.ev(n.l, ctx), ctx);
    const r = this.one(this.ev(n.r, ctx), ctx);
    const { op } = n;
    if (op === '&') {
      if (isErr(l)) return l;
      if (isErr(r)) return r;
      return toStr(l) + toStr(r);
    }
    if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      if (isErr(l)) return l;
      if (isErr(r)) return r;
      const k = compareOp(l, r);
      return op === '=' ? k === 0 : op === '<>' ? k !== 0 : op === '<' ? k < 0 : op === '>' ? k > 0 : op === '<=' ? k <= 0 : k >= 0;
    }
    const a = toNum(l);
    if (isErr(a)) return a;
    const b = toNum(r);
    if (isErr(b)) return b;
    let v;
    if (op === '+') v = a + b;
    else if (op === '-') v = a - b;
    else if (op === '*') v = a * b;
    else if (op === '/') { if (b === 0) return E.div0; v = a / b; }
    else if (op === '^') return power(a, b);
    else throw new Unsupported(op);
    return Number.isFinite(v) ? v : E.num;
  }

  //  +evaluate: a stored formula's value for the cell at (s, r, c). Throws
  //  Unsupported when lattice cannot evaluate it.
  evaluate(f, s, r, c) {
    if (!this.busy.size) this.steps = 0;
    const ast = this.ast(f);
    if (!ast) throw new Unsupported('unreadable');
    let v = this.one(this.ev(ast, { s, r, c, depth: 0 }), { s, r, c });
    //  a reference to an empty cell shows 0. A function that hands back
    //  an empty cell (VLOOKUP, INDEX, IF) is null here: Calc stores it as
    //  the number 0 that shows as nothing.
    if (v === null || v === undefined) {
      let top = ast;
      while (top.t === 'paren') top = top.x;
      v = top.t === 'call' ? null : 0;
    }
    return v;
  }

  compute(e) {
    const k = key(e.s, e.r, e.c);
    if (this.busy.has(k)) return E.cycle;
    //  the walk budget is one outermost formula's, with whatever it pulls
    //  in. It starts again here: +evaluate cannot do it, since by then
    //  this cell is already in `busy`.
    const top = !this.busy.size;
    if (top) this.steps = 0;
    this.busy.add(k);
    let v;
    let ok = true;
    //  stopped at a bound: this formula, and what reads it, is not right
    let cut = top && this.total > this.maxTotal;
    const was = this.tainted;
    this.tainted = false;
    if (cut) { ok = false; this.missed.add(e); }
    else {
      try { v = this.evaluate(e.f, e.s, e.r, e.c); } catch (x) {
        //  out of stack, in a chain of formulas each reading the next.
        //  There is no room to tidy up at this depth, so it unwinds to
        //  the outermost formula. Every formula it was part way through
        //  is left unanswered there, and kept for another go (+recalc).
        if (x instanceof RangeError) {
          if (!top) throw x;
          for (const b of this.busy) {
            if (b !== k) { this.stale.add(b); this.cut.add(b); this.pending.delete(b); }
            this.deep.push(b);
          }
          this.busy.clear();
        } else if (!(x instanceof Unsupported)) { this.busy.delete(k); this.tainted = was; throw x; }
        //  the budget ran out inside a formula another one pulled in. That
        //  one is not at fault: it stays waiting, to be computed with a
        //  budget of its own, and the outermost one is tried again after.
        else if (x instanceof Cut && !top) { this.busy.delete(k); this.tainted = was; this.left = true; throw x; }
        ok = false;
        cut = x instanceof Cut || x instanceof RangeError;
        if (top && this.left && x instanceof Cut) this.retry.push(e);
      }
      //  it read a cell that stopped at a bound, so its own result would
      //  be made from a value that is not right
      if (this.tainted) { ok = false; cut = true }
    }
    this.tainted = was;
    if (top) { this.total += this.steps; this.left = false; }
    this.busy.delete(k);
    this.pending.delete(k);
    const sheet = this.doc.sheets[e.s];
    if (!ok) {
      this.stale.add(k);
      if (cut) this.cut.add(k); else this.cut.delete(k);
      return cellValue(cellAt(sheet, e.r, e.c));
    }
    this.stale.delete(k);
    this.cut.delete(k);
    this.store(e.s, e.r, e.c, e.f, v);
    return v;
  }

  //  write a result into a cell: the type, the value and the display text.
  //  A numeric result keeps the cell's numeric type (percent, currency,
  //  date, time), since that is its format's.
  store(s, r, c, f, v) {
    const sheet = this.doc.sheets[s];
    const was = cellAt(sheet, r, c);
    let val;
    const blank = v === null;
    if (blank) v = 0;
    if (isErr(v)) val = { vt: 'string', v: v.code, f, text: v.code, err: true };
    else if (typeof v === 'string') val = { vt: 'string', v, f, text: v };
    else if (typeof v === 'boolean' && !(was.vt && was.vt !== 'boolean' && was.vt !== 'string')) val = { vt: 'boolean', v, f, text: v ? 'TRUE' : 'FALSE' };
    else {
      //  a logical result in a cell Calc keeps as a plain number stays one
      if (typeof v === 'boolean') v = v ? 1 : 0;
      const keep = was.vt === 'percentage' || was.vt === 'currency' || was.vt === 'date' || was.vt === 'time';
      const vt = keep ? was.vt : 'float';
      val = { vt, v, f, text: '', cur: was.cur };
    }
    const same = was.vt === val.vt && !!was.err === !!val.err && was.f === f
      && (typeof v === 'number' ? was.v === v : isErr(v) ? was.text === val.text : was.v === val.v);
    if (same && !blank) return;
    if (val.text === '' && typeof v === 'number' && !blank) val.text = this.format(s, r, c, v, val.vt);
    if (blank && same && was.text === '') return;
    setCell(sheet, r, c, val);
    this.usedCache.delete(s);
    this.changed.push([s, r, c]);
  }

  //  +recalc: after the cells in `edited` ([s, r, c]) changed, recompute
  //  every formula that reads them, however indirectly, and the formulas
  //  in `also` themselves. Returns the cells whose stored value changed.
  recalc(edited, also = []) {
    this.changed = [];
    this.usedCache.clear();
    this.total = 0;
    const hit = new Map();
    for (const e of also) hit.set(e.k, e);
    //  the cells whose readers are still to be found. Each formula joins
    //  once, so the search ends, and each cell looks its readers up
    //  instead of every formula being tried against it.
    const queue = edited.map(([s, r, c]) => [s, r, c]);
    const take = (e) => { if (!e.dead && !hit.has(e.k)) { hit.set(e.k, e); queue.push([e.s, e.r, e.c]); } };
    //  what an earlier search did not get to is computed now, and what
    //  reads it after it
    for (const e of this.missed) take(e);
    this.missed = new Set();
    const { rows, cols, wild } = this.readers;
    const left = new Map();       // a list of tall rectangles, less the formulas found
    const among = (k, list, s, r, c) => {
      const rest = [];
      for (const t of list) {
        const e = t[0];
        if (e.dead || hit.has(e.k)) continue;
        this.checks++;
        if (s === t[1] && r >= t[2] && r <= t[4] && c >= t[3] && c <= t[5]) take(e); else rest.push(t);
      }
      left.set(k, rest);
    };
    if (queue.length) for (const e of wild) take(e);
    this.checks = 0;
    let q = 0;
    for (; q < queue.length && this.checks <= this.maxChecks; q++) {
      const [s, r, c] = queue[q];
      const list = rows.get(rowKey(s, r));
      if (list) for (const [e, c1, c2] of list) { this.checks++; if (c >= c1 && c <= c2) take(e); }
      const ck = rowKey(s, c);
      const col = left.get(ck) || cols.get(ck);
      if (col && col.length) among(ck, col, s, r, c);
      const wide = left.get(-1) || this.readers.wide;
      if (wide.length) among(-1, wide, s, r, c);
    }
    //  the search was cut short: what it did not reach may read the edit,
    //  so every formula it did not reach is marked, and computed at the
    //  next edit
    if (q < queue.length) for (const e of this.formulas) if (!hit.has(e.k)) { this.stale.add(e.k); this.cut.add(e.k); this.missed.add(e); }
    this.pending = new Map(hit);
    this.deep = [];
    for (const e of hit.values()) if (this.pending.has(e.k)) this.compute(e);
    //  formulas that ran out of stack were come to before the cells they
    //  read. Taken from the far end they are come to after them, so a
    //  long chain read from the bottom is computed link by link. What
    //  still runs out stays marked.
    for (let pass = 0; pass < 2 && this.deep.length; pass++) {
      const again = this.deep;
      this.deep = [];
      for (const k of again) if (hit.has(k)) this.pending.set(k, hit.get(k));
      for (let i = again.length - 1; i >= 0; i--) { const e = this.pending.get(again[i]); if (e) this.compute(e); }
    }
    //  a formula that stopped only because a formula it pulled in used up
    //  its budget is tried again, now that one is computed
    const retry = this.retry;
    this.retry = [];
    for (const e of retry) if (this.stale.has(e.k) && this.total <= this.maxTotal) { this.pending.set(e.k, e); this.compute(e); }
    this.pending.clear();
    //  what is marked is shown with the value it had, and saved with none
    for (const k of this.cut) {
      const c = k % 16384, r = Math.floor(k / 16384) % 1048576, s = Math.floor(k / 17179869184);
      const sheet = this.doc.sheets[s];
      if (sheet && cellAt(sheet, r, c).f && !cellAt(sheet, r, c).unsure) setUnsure(sheet, r, c);
    }
    return this.changed;
  }

  //  a formula cell was written, replaced or removed at (s, r, c)
  setFormula(s, r, c, f) {
    //  the old entry stays in the index, marked dead, and is passed over
    this.formulas = this.formulas.filter((e) => { if (e.s !== s || e.r !== r || e.c !== c) return true; e.dead = true; this.dead++; return false; });
    //  until the dead outnumber the living: then the index is made again
    if (this.dead > this.formulas.length + 64) {
      this.readers = { rows: new Map(), cols: new Map(), wide: [], wild: [] };
      this.dead = 0;
      for (const e of this.formulas) this.index(e);
    }
    this.stale.delete(key(s, r, c));
    this.cut.delete(key(s, r, c));
    if (!f) return null;
    const e = this.index(this.entry(s, r, c, f));
    this.formulas.push(e);
    return e;
  }

  isStale(s, r, c) { return this.stale.has(key(s, r, c)); }
}

export { rowCount, MAX_COLS };
