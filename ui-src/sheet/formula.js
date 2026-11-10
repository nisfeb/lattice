//  formula.js: OpenFormula as flat ODS stores it, and as a person types it.
//
//  A cell's formula is stored as  of:=SUM([.A1:.A3];[$'My Sheet'.B2])
//  and shown and typed as         =SUM(A1:A3,'My Sheet'.B2)
//
//  One tokenizer reads both spellings (mode 'of' or 'user'), one parser
//  builds the tree, and two printers write it back. A structural edit
//  (rows or columns inserted or deleted) moves references by splicing only
//  the reference tokens of the stored text, so the rest of a formula is
//  never respelled.

export class FormulaError extends Error {}
const bad = (why) => { throw new FormulaError(why); };

export const ERRORS = ['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#NULL!'];

//  functions newer than ODF 1.2 are stored under a vendor prefix
const OF_NAME = {
  IFS: 'COM.MICROSOFT.IFS', SWITCH: 'COM.MICROSOFT.SWITCH', TEXTJOIN: 'COM.MICROSOFT.TEXTJOIN',
  CONCAT: 'COM.MICROSOFT.CONCAT', MAXIFS: 'COM.MICROSOFT.MAXIFS', MINIFS: 'COM.MICROSOFT.MINIFS',
  'STDEV.S': 'COM.MICROSOFT.STDEV.S', 'STDEV.P': 'COM.MICROSOFT.STDEV.P',
  'VAR.S': 'COM.MICROSOFT.VAR.S', 'VAR.P': 'COM.MICROSOFT.VAR.P',
};
const USER_NAME = Object.fromEntries(Object.entries(OF_NAME).map(([u, o]) => [o, u]));

// ── cell addresses ───────────────────────────────────────────────────────

export function colName(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export function colIndex(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) & 31);
  return n - 1;
}
const PLAIN_SHEET = /^[A-Za-z_À-￿][A-Za-z0-9_À-￿]*$/;
export const quoteSheet = (n) => (PLAIN_SHEET.test(n) ? n : "'" + n.replace(/'/g, "''") + "'");

//  one end of a reference: { sheet, sheetAbs, c, cAbs, r, rAbs }, sheet
//  null when the reference names none
const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})/;
function readSheet(s, i) {
  //  an optional $ and a sheet name, quoted or plain, up to its separator
  let j = i;
  let abs = false;
  if (s[j] === '$') { abs = true; j++; }
  let name;
  if (s[j] === "'") {
    let k = j + 1;
    name = '';
    for (;;) {
      if (k >= s.length) return null;
      if (s[k] === "'") {
        if (s[k + 1] === "'") { name += "'"; k += 2; continue; }
        break;
      }
      name += s[k++];
    }
    j = k + 1;
  } else {
    const m = /^[A-Za-z_À-￿][A-Za-z0-9_À-￿]*/.exec(s.slice(j));
    if (!m) return null;
    name = m[0];
    j += name.length;
  }
  return { name, abs, end: j };
}
function readCell(s, i) {
  const m = CELL.exec(s.slice(i, i + 16));
  if (!m) return null;
  const c = colIndex(m[2]);
  const r = parseInt(m[4], 10) - 1;
  if (c < 0 || c >= 16384 || r < 0 || r >= 1048576) return null;
  return { c, cAbs: !!m[1], r, rAbs: !!m[3], end: i + m[0].length };
}

//  an endpoint in 'of' spelling ( .A1  $Sheet.A1  $'My Sheet'.$A$1 ) or
//  in 'user' spelling ( A1  Sheet.A1  'My Sheet'!A1 ), from s[i]
function readEnd(s, i, mode) {
  let sheet = null, sheetAbs = false, j = i;
  if (mode === 'of') {
    if (s[j] !== '.') {
      const sh = readSheet(s, j);
      if (!sh || s[sh.end] !== '.') return null;
      sheet = sh.name; sheetAbs = sh.abs; j = sh.end;
    }
    j++;
  } else {
    const sh = readSheet(s, j);
    if (sh && (s[sh.end] === '.' || s[sh.end] === '!') && readCell(s, sh.end + 1)) {
      sheet = sh.name; sheetAbs = sh.abs; j = sh.end + 1;
    }
  }
  const cell = readCell(s, j);
  if (!cell) return null;
  return { sheet, sheetAbs, c: cell.c, cAbs: cell.cAbs, r: cell.r, rAbs: cell.rAbs, end: cell.end };
}

function printEnd(e, mode, first) {
  let s = '';
  if (e.sheet !== null) s += (e.sheetAbs ? '$' : '') + quoteSheet(e.sheet) + '.';
  else if (mode === 'of') s += '.';
  void first;
  return s + (e.cAbs ? '$' : '') + colName(e.c) + (e.rAbs ? '$' : '') + (e.r + 1);
}
//  a reference: { a, b } (b null for one cell), or { bad: true }
export function printRef(ref, mode) {
  //  a reference to deleted cells is the bare error, as LibreOffice saves it
  if (ref.bad) return '#REF!';
  if (ref.full) {
    const d = mode === 'of' ? '.' : '';
    const end = (e) => (ref.full === 'c' ? (e.cAbs ? '$' : '') + colName(e.c) : (e.rAbs ? '$' : '') + (e.r + 1));
    const t = d + end(ref.a) + ':' + d + end(ref.b);
    return mode === 'of' ? '[' + t + ']' : t;
  }
  const body = printEnd(ref.a, mode, true) + (ref.b ? ':' + printEnd(ref.b, mode, false) : '');
  return mode === 'of' ? '[' + body + ']' : body;
}

// ── tokens ───────────────────────────────────────────────────────────────

const OPS2 = ['<>', '<=', '>='];
const OPS1 = '+-*/^&=<>%';

//  +tokenize: the tokens of a formula body (no leading "=" or "of:="),
//  each with its span [s, e) in the text
export function tokenize(text, mode) {
  const out = [];
  let i = 0;
  const L = text.length;
  while (i < L) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    const s = i;
    if (ch === '"') {
      let v = '';
      i++;
      for (;;) {
        if (i >= L) bad('a text that is not closed');
        if (text[i] === '"') {
          if (text[i + 1] === '"') { v += '"'; i += 2; continue; }
          i++;
          break;
        }
        v += text[i++];
      }
      out.push({ t: 'str', v, s, e: i });
      continue;
    }
    if (mode === 'of' && ch === '[') {
      const close = text.indexOf(']', i);
      if (close < 0) bad('a reference that is not closed');
      const a = readEnd(text, i + 1, 'of');
      let ref = fullRef(text.slice(i + 1, close), 'of') || { bad: true };
      if (a) {
        if (a.end === close) ref = { a: strip(a), b: null };
        else if (text[a.end] === ':') {
          const b = readEnd(text, a.end + 1, 'of');
          if (b && b.end === close) ref = { a: strip(a), b: strip(b) };
        }
      }
      i = close + 1;
      out.push({ t: 'ref', ref, s, e: i });
      continue;
    }
    if ((ch >= '0' && ch <= '9') || (ch === '.' && text[i + 1] >= '0' && text[i + 1] <= '9')) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text.slice(i));
      i += m[0].length;
      out.push({ t: 'num', v: Number(m[0]), s, e: i });
      continue;
    }
    if (ch === '#') {
      const hit = ERRORS.find((x) => text.startsWith(x, i));
      if (!hit) bad('an unknown error value');
      i += hit.length;
      out.push({ t: 'err', v: hit, s, e: i });
      continue;
    }
    if (mode === 'user') {
      //  whole columns or rows: A:A, $B:$D, 2:5
      const fm = /^(\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d{1,7}:\$?\d{1,7})(?![A-Za-z0-9_.(])/.exec(text.slice(i, i + 20));
      const fr = fm && fullRef(fm[1], 'user');
      if (fr) { i += fm[1].length; out.push({ t: 'ref', ref: fr, s, e: i }); continue; }
      //  a reference, unless it is a function name (LOG10 followed by "(")
      const a = readEnd(text, i, 'user');
      if (a && !/[A-Za-z0-9_.(]/.test(text[a.end] || '')) {
        let ref = { a: strip(a), b: null };
        i = a.end;
        if (text[i] === ':') {
          const b = readEnd(text, i + 1, 'user');
          if (b && !/[A-Za-z0-9_(]/.test(text[b.end] || '')) { ref = { a: strip(a), b: strip(b) }; i = b.end; }
        }
        //  A1:A1048576 is the whole column, and is stored as one
        if (ref.b && ref.a.sheet === null && ref.b.sheet === null) {
          const { a: p, b: q } = ref;
          if (p.r === 0 && q.r === 1048575 && !p.rAbs && !q.rAbs) ref.full = 'c';
          else if (p.c === 0 && q.c === 16383 && !p.cAbs && !q.cAbs) ref.full = 'r';
        }
        out.push({ t: 'ref', ref, s, e: i });
        continue;
      }
    }
    if (/[A-Za-z_À-￿]/.test(ch)) {
      const m = /^[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*/.exec(text.slice(i));
      i += m[0].length;
      out.push({ t: 'name', v: m[0], s, e: i });
      continue;
    }
    if (ch === '(') { out.push({ t: '(', s, e: ++i }); continue; }
    if (ch === ')') { out.push({ t: ')', s, e: ++i }); continue; }
    if (ch === ';' || (mode === 'user' && ch === ',')) { out.push({ t: ';', s, e: ++i }); continue; }
    if (ch === '{' || ch === '}' || ch === '|' || ch === '~' || ch === '!') bad('arrays and range operators are not supported here');
    const two = text.slice(i, i + 2);
    if (OPS2.includes(two)) { i += 2; out.push({ t: 'op', v: two, s, e: i }); continue; }
    if (OPS1.includes(ch)) { out.push({ t: 'op', v: ch, s, e: ++i }); continue; }
    bad('an unexpected character: ' + ch);
  }
  return out;
}
const strip = (e) => ({ sheet: e.sheet, sheetAbs: e.sheetAbs, c: e.c, cAbs: e.cAbs, r: e.r, rAbs: e.rAbs });

//  a whole-column or whole-row reference: [.A:.C] or [.2:.5] as stored,
//  A:C or 2:5 as typed. It is a range with `full` set ('c' or 'r'), so
//  everything that reads ranges reads it, and it prints as it came.
function fullRef(body, mode) {
  const dot = mode === 'of' ? '\\.' : '';
  let m = new RegExp(`^${dot}(\\$?)([A-Za-z]{1,3}):${dot}(\\$?)([A-Za-z]{1,3})$`).exec(body);
  if (m) {
    const c1 = colIndex(m[2]), c2 = colIndex(m[4]);
    if (c1 >= 16384 || c2 >= 16384) return null;
    return {
      full: 'c',
      a: { sheet: null, sheetAbs: false, c: c1, cAbs: !!m[1], r: 0, rAbs: false },
      b: { sheet: null, sheetAbs: false, c: c2, cAbs: !!m[3], r: 1048575, rAbs: false },
    };
  }
  m = new RegExp(`^${dot}(\\$?)(\\d{1,7}):${dot}(\\$?)(\\d{1,7})$`).exec(body);
  if (m) {
    const r1 = +m[2] - 1, r2 = +m[4] - 1;
    if (r1 < 0 || r2 < 0 || r1 >= 1048576 || r2 >= 1048576) return null;
    return {
      full: 'r',
      a: { sheet: null, sheetAbs: false, c: 0, cAbs: false, r: r1, rAbs: !!m[1] },
      b: { sheet: null, sheetAbs: false, c: 16383, cAbs: false, r: r2, rAbs: !!m[3] },
    };
  }
  return null;
}

// ── the tree ─────────────────────────────────────────────────────────────

//  precedence, loosest first: comparison, &, + -, * /, ^, unary, %
const LEVELS = [['=', '<>', '<', '>', '<=', '>='], ['&'], ['+', '-'], ['*', '/'], ['^']];

export function parse(text, mode) {
  const toks = tokenize(text, mode);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v) => peek() && peek().t === 'op' && (Array.isArray(v) ? v.includes(peek().v) : peek().v === v);
  function level(n) {
    if (n === LEVELS.length) return unary();
    let l = level(n + 1);
    while (isOp(LEVELS[n])) {
      const op = toks[p++].v;
      l = { t: 'bin', op, l, r: level(n + 1) };
    }
    return l;
  }
  function unary() {
    if (isOp(['-', '+'])) {
      const op = toks[p++].v;
      return { t: 'un', op, x: unary() };
    }
    let x = primary();
    while (isOp('%')) { p++; x = { t: 'pct', x }; }
    return x;
  }
  function primary() {
    const k = toks[p++];
    if (!k) bad('the formula ends too soon');
    if (k.t === 'num') return { t: 'num', v: k.v };
    if (k.t === 'str') return { t: 'str', v: k.v };
    if (k.t === 'err') return { t: 'err', v: k.v };
    if (k.t === 'ref') return { t: 'ref', ref: k.ref };
    if (k.t === '(') {
      if (++depth > 64) bad('nested too deep');
      const x = level(0);
      depth--;
      if (!peek() || peek().t !== ')') bad('a bracket that is not closed');
      p++;
      return { t: 'paren', x };
    }
    if (k.t === 'name') {
      if (peek() && peek().t === '(') {
        p++;
        if (++depth > 64) bad('nested too deep');
        const args = [];
        if (peek() && peek().t === ')') p++;
        else {
          for (;;) {
            if (peek() && (peek().t === ';' || peek().t === ')')) args.push({ t: 'missing' });
            else args.push(level(0));
            const n = toks[p++];
            if (!n) bad('a bracket that is not closed');
            if (n.t === ')') break;
            if (n.t !== ';') bad('expected a separator');
            if (peek() && peek().t === ')') { args.push({ t: 'missing' }); p++; break; }
          }
        }
        depth--;
        const up = k.v.toUpperCase();
        return { t: 'call', name: USER_NAME[up] || up, args };
      }
      const up = k.v.toUpperCase();
      if (up === 'TRUE' || up === 'FALSE') return { t: 'bool', v: up === 'TRUE' };
      return { t: 'name', name: k.v };
    }
    bad('unexpected ' + (k.v || k.t));
    return null;
  }
  const tree = level(0);
  if (p < toks.length) bad('unexpected ' + (toks[p].v || toks[p].t));
  return tree;
}

const strLit = (v) => '"' + v.replace(/"/g, '""') + '"';
const numLit = (n) => {
  let s = String(n);
  if (s.includes('e')) s = s.replace('e+', 'E').replace('e', 'E');
  return s;
};

//  +print: a tree as text, in 'of' or 'user' spelling
export function print(n, mode) {
  switch (n.t) {
    case 'num': return numLit(n.v);
    case 'str': return strLit(n.v);
    case 'bool': return n.v ? 'TRUE()' : 'FALSE()';
    case 'err': return n.v;
    case 'ref': return printRef(n.ref, mode);
    case 'name': return n.name;
    case 'missing': return '';
    case 'paren': return '(' + print(n.x, mode) + ')';
    case 'un': return n.op + print(n.x, mode);
    case 'pct': return print(n.x, mode) + '%';
    case 'bin': return print(n.l, mode) + n.op + print(n.r, mode);
    case 'call': {
      const name = mode === 'of' ? (OF_NAME[n.name] || n.name) : n.name;
      return name + '(' + n.args.map((a) => print(a, mode)).join(mode === 'of' ? ';' : ',') + ')';
    }
    default: return '';
  }
}

//  the stored attribute ("of:=...") to what the formula bar shows, and
//  what was typed ("=...") to the stored attribute. toUser never throws:
//  a formula lattice cannot read is shown as stored. toOf throws
//  FormulaError with the reason.
export function toUser(stored) {
  const body = bodyOf(stored);
  if (body === null) return stored;
  try { return '=' + print(parse(body, 'of'), 'user'); } catch { return '=' + body; }
}
export function toOf(typed) {
  const t = typed.trim();
  if (t[0] !== '=') bad('a formula starts with =');
  return 'of:=' + print(parse(t.slice(1), 'user'), 'of');
}
//  the body of a stored formula, without "of:=" (or "=", an old spelling)
export function bodyOf(stored) {
  if (typeof stored !== 'string') return null;
  if (stored.startsWith('of:=')) return stored.slice(4);
  if (stored.startsWith('=')) return stored.slice(1);
  const m = /^[a-z]+:=/.exec(stored);
  return m ? stored.slice(m[0].length) : null;
}

// ── moving references ────────────────────────────────────────────────────

//  an edit to the grid: on sheet `sheet` (a name), `n` rows (dim 'r') or
//  columns (dim 'c') inserted before index `at` (n > 0), or -n of them
//  deleted from `at` (n < 0)
function moveIndex(i, op) {
  if (op.n > 0) return i >= op.at ? i + op.n : i;
  const cnt = -op.n;
  if (i < op.at) return i;
  if (i >= op.at + cnt) return i - cnt;
  return null;      // inside the deleted span
}
const sameSheet = (a, b) => a.toLowerCase() === b.toLowerCase();

//  +moveRef: the reference after the edit, for a formula living on sheet
//  `home`. Returns the same object when nothing moved, { bad: true } when
//  what it pointed at was deleted.
export function moveRef(ref, home, op) {
  if (ref.bad) return ref;
  //  a whole column has no rows to move, and a whole row no columns
  if (ref.full && ref.full !== op.dim) return ref;
  const sa = ref.a.sheet ?? home;
  const sb = ref.b ? (ref.b.sheet ?? sa) : sa;
  const k = op.dim === 'r' ? 'r' : 'c';
  const max = op.dim === 'r' ? 1048576 : 16384;
  if (!ref.b) {
    if (!sameSheet(sa, op.sheet)) return ref;
    const v = moveIndex(ref.a[k], op);
    if (v === null || v >= max) return { bad: true };
    return v === ref.a[k] ? ref : { a: { ...ref.a, [k]: v }, b: null };
  }
  if (!sameSheet(sa, op.sheet) || !sameSheet(sb, op.sheet)) return ref;
  let lo = ref.a[k], hi = ref.b[k];
  const flip = lo > hi;
  if (flip) [lo, hi] = [hi, lo];
  let nlo, nhi;
  if (op.n > 0) {
    nlo = lo >= op.at ? lo + op.n : lo;
    nhi = hi >= op.at ? hi + op.n : hi;
    if (nhi >= max) nhi = max - 1;
    if (nlo >= max) return { bad: true };
  } else {
    const cnt = -op.n, end = op.at + cnt;      // deleted [at, end)
    if (lo >= op.at && hi < end) return { bad: true };
    nlo = lo < op.at ? lo : lo >= end ? lo - cnt : op.at;
    nhi = hi < op.at ? hi : hi >= end ? hi - cnt : op.at - 1;
  }
  if (nlo === lo && nhi === hi) return ref;
  return { ...ref, a: { ...ref.a, [k]: flip ? nhi : nlo }, b: { ...ref.b, [k]: flip ? nlo : nhi } };
}

//  +moveFormula: a stored formula after the edit. Only reference tokens
//  are respelled. Returns the same string when nothing moved. A formula
//  lattice cannot tokenize comes back as null: the caller must not guess.
export function moveFormula(stored, home, op) {
  const body = bodyOf(stored);
  if (body === null) return null;
  const head = stored.slice(0, stored.length - body.length);
  let toks;
  try { toks = tokenize(body, 'of'); } catch { return null; }
  let out = '';
  let pos = 0;
  let changed = false;
  for (const k of toks) {
    if (k.t !== 'ref') continue;
    const moved = moveRef(k.ref, home, op);
    if (moved === k.ref) continue;
    out += body.slice(pos, k.s) + printRef(moved, 'of');
    pos = k.e;
    changed = true;
  }
  return changed ? head + out + body.slice(pos) : stored;
}

//  a sheet rename: every reference naming `from` names `to`
export function renameInFormula(stored, from, to) {
  const body = bodyOf(stored);
  if (body === null) return null;
  const head = stored.slice(0, stored.length - body.length);
  let toks;
  try { toks = tokenize(body, 'of'); } catch { return null; }
  let out = '';
  let pos = 0;
  let changed = false;
  for (const k of toks) {
    if (k.t !== 'ref' || k.ref.bad) continue;
    const hitA = k.ref.a.sheet !== null && sameSheet(k.ref.a.sheet, from);
    const hitB = k.ref.b && k.ref.b.sheet !== null && sameSheet(k.ref.b.sheet, from);
    if (!hitA && !hitB) continue;
    const ref = { a: hitA ? { ...k.ref.a, sheet: to } : k.ref.a, b: k.ref.b && (hitB ? { ...k.ref.b, sheet: to } : k.ref.b) };
    out += body.slice(pos, k.s) + printRef(ref, 'of');
    pos = k.e;
    changed = true;
  }
  return changed ? head + out + body.slice(pos) : stored;
}

// ── plain addresses (named ranges, filters, print ranges) ────────────────

//  "Sheet.A1:Sheet.C5", "$Sheet.$B$2:.$B$5", "'My Sheet'.A1": one address
//  from s[i], as { ref, end }, or null
function readAddr(s, i) {
  const a = readEnd(s, i, 'of');
  if (!a) return null;
  if (s[a.end] !== ':') return { ref: { a: strip(a), b: null }, end: a.end };
  const b = readEnd(s, a.end + 1, 'of');
  if (!b) return null;
  return { ref: { a: strip(a), b: strip(b) }, end: b.end };
}
//  +parseAddrs: a space-separated address list, or null when any part of
//  it is not an address
export function parseAddrs(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ') { i++; continue; }
    const a = readAddr(s, i);
    if (!a || (a.end < s.length && s[a.end] !== ' ')) return null;
    out.push(a.ref);
    i = a.end;
  }
  return out;
}
const printAddr = (ref) => printEnd(ref.a, 'of') + (ref.b ? ':' + printEnd(ref.b, 'of') : '');
//  +moveAddrs: an address list after the edit, or null when it cannot be
//  read. An address whose cells were all deleted is dropped from a list.
export function moveAddrs(s, op) {
  const refs = parseAddrs(s);
  if (!refs) return null;
  const out = [];
  let changed = false;
  for (const ref of refs) {
    const home = ref.a.sheet ?? op.sheet;
    const moved = moveRef(ref, home, op);
    if (moved !== ref) changed = true;
    if (!moved.bad) out.push(printAddr(moved));
  }
  return changed ? out.join(' ') : s;
}

//  +offsetFormula: a stored formula as it reads when copied `dr` rows down
//  and `dc` columns right: relative parts move, absolute ($) parts stay.
//  null when lattice cannot tokenize it.
export function offsetFormula(stored, dr, dc) {
  const body = bodyOf(stored);
  if (body === null) return null;
  const head = stored.slice(0, stored.length - body.length);
  let toks;
  try { toks = tokenize(body, 'of'); } catch { return null; }
  const shift = (e, full) => {
    const r = e.rAbs || full === 'c' ? e.r : e.r + dr;
    const c = e.cAbs || full === 'r' ? e.c : e.c + dc;
    return r < 0 || c < 0 || r >= 1048576 || c >= 16384 ? null : { ...e, r, c };
  };
  let out = '';
  let pos = 0;
  for (const k of toks) {
    if (k.t !== 'ref' || k.ref.bad) continue;
    const a = shift(k.ref.a, k.ref.full);
    const b = k.ref.b ? shift(k.ref.b, k.ref.full) : null;
    const ref = !a || (k.ref.b && !b) ? { bad: true } : { ...k.ref, a, b };
    out += body.slice(pos, k.s) + printRef(ref, 'of');
    pos = k.e;
  }
  return head + out + body.slice(pos);
}

//  does a stored formula hold a reference that points at nothing
export const hasBadRef = (stored) => stored.includes('#REF!');
