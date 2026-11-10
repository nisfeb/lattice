//  engine.js: evaluates formulas over the model, and recalculates what an
//  edit makes stale.
//
//  Recalculation is narrow on purpose. Opening a sheet computes nothing,
//  so a file that was only looked at saves byte-identical. An edit
//  recomputes the cells that depend on it, directly or through other
//  formulas, and nothing else. A formula lattice cannot evaluate (a
//  function it does not know, an array, a syntax it cannot read) keeps the
//  result LibreOffice last cached and is reported stale, never guessed.

import { cellAt, extent, setCell, rowCount, MAX_COLS } from './model.js';
import { parse, bodyOf, parseAddrs } from './formula.js';
import { FUNCS, LAZY, Range, Err, E, Unsupported, toNum, toStr, compareOp, power } from './funcs.js';
import { attr } from '../writer/xml.js';

const key = (s, r, c) => s * 17179869184 + r * 16384 + c;
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
    this.changed = [];
    this.steps = 0;
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
    this.doc.sheets.forEach((sheet, s) => {
      let r = 0;
      for (const row of sheet.rows) {
        if (row.cells.some((c) => c.f)) {
          const reps = Math.min(row.rep, 2048);
          for (let i = 0; i < reps; i++) {
            let c = 0;
            for (const cell of row.cells) {
              if (cell.f) for (let j = 0; j < Math.min(cell.rep, 256); j++) this.formulas.push(this.entry(s, r + i, c + j, cell.f));
              c += cell.rep;
            }
          }
        }
        r += row.rep;
      }
    });
  }

  entry(s, r, c, f) {
    const e = { s, r, c, f, deps: null, bad: false };
    const ast = this.ast(f);
    if (!ast) { e.bad = true; e.deps = []; } else e.deps = this.depsOf(ast, s);
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
    const walk = (n) => {
      if (!n) return;
      switch (n.t) {
        case 'ref': { const rg = this.range(n.ref, home); if (rg instanceof Range) out.push([rg.s, rg.r1, rg.c1, rg.r2, rg.c2]); break; }
        case 'name': {
          const nm = this.names.get(n.name.toLowerCase());
          if (!nm || seen.has(n.name.toLowerCase())) break;
          seen.add(n.name.toLowerCase());
          if (nm.ref) { const rg = this.range(nm.ref, nm.home); if (rg instanceof Range) out.push([rg.s, rg.r1, rg.c1, rg.r2, rg.c2]); }
          else if (nm.ast) out.push(...this.depsOf(nm.ast, nm.home, seen));
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
    const k = key(s, r, c);
    const e = this.pending.get(k);
    if (e) return this.compute(e);
    const sheet = this.doc.sheets[s];
    return sheet ? cellValue(cellAt(sheet, r, c)) : E.ref;
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
      if (!row.cells.some((c) => c.vt)) continue;
      const lo = Math.max(top, r1), hi = Math.min(bot, r2);
      for (let rr = lo; rr <= hi; rr++) {
        let c = 0;
        for (const cell of row.cells) {
          const left = c, right = c + cell.rep - 1;
          c += cell.rep;
          if (right < c1) continue;
          if (left > c2) break;
          if (!cell.vt) continue;
          for (let cc = Math.max(left, c1); cc <= Math.min(right, c2); cc++) {
            //  a hostile run (a million rows of sixteen thousand cells) is
            //  not walked: the formula keeps its cached result
            if (++this.steps > 5000000) throw new Unsupported('too many cells');
            const v = this.pending.size ? this.value(s, rr, cc) : cellValue(cell);
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
    this.busy.add(k);
    let v;
    let ok = true;
    try { v = this.evaluate(e.f, e.s, e.r, e.c); } catch (x) {
      if (!(x instanceof Unsupported)) throw x;
      ok = false;
    }
    this.busy.delete(k);
    this.pending.delete(k);
    const sheet = this.doc.sheets[e.s];
    if (!ok) {
      this.stale.add(k);
      return cellValue(cellAt(sheet, e.r, e.c));
    }
    this.stale.delete(k);
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
    const hit = new Map();
    for (const e of also) hit.set(key(e.s, e.r, e.c), e);
    let front = edited.map(([s, r, c]) => [s, r, c]);
    let guard = 0;
    while (front.length && guard++ < 10000) {
      const next = [];
      for (const e of this.formulas) {
        const k = key(e.s, e.r, e.c);
        if (hit.has(k)) continue;
        let reads = false;
        for (const [ds, r1, c1, r2, c2] of e.deps) {
          for (const [s, r, c] of front) {
            if (s === ds && r >= r1 && r <= r2 && c >= c1 && c <= c2) { reads = true; break; }
          }
          if (reads) break;
        }
        if (reads) { hit.set(k, e); next.push([e.s, e.r, e.c]); }
      }
      front = next;
    }
    this.pending = new Map(hit);
    for (const e of hit.values()) if (this.pending.has(key(e.s, e.r, e.c))) this.compute(e);
    this.pending.clear();
    return this.changed;
  }

  //  a formula cell was written, replaced or removed at (s, r, c)
  setFormula(s, r, c, f) {
    this.formulas = this.formulas.filter((e) => !(e.s === s && e.r === r && e.c === c));
    this.stale.delete(key(s, r, c));
    if (!f) return null;
    const e = this.entry(s, r, c, f);
    this.formulas.push(e);
    return e;
  }

  isStale(s, r, c) { return this.stale.has(key(s, r, c)); }
}

export { rowCount, MAX_COLS };
