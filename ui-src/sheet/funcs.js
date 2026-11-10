//  funcs.js: the spreadsheet functions lattice evaluates, and the value
//  rules they share. LibreOffice Calc is the reference: scripts/sheet-unit
//  and scripts/sheet-oracle check these against its results.
//
//  A value is a number, a string, a boolean, null (an empty cell) or an
//  Err. A function gets its arguments evaluated, except that a reference
//  argument arrives as a Range, so SUM can walk it and ROW can ask where
//  it is. None of these reach the network, the clock aside (TODAY, NOW),
//  or any other document.

export class Err {
  constructor(code) { this.code = code; }
}
export const E = {
  div0: new Err('#DIV/0!'), value: new Err('#VALUE!'), ref: new Err('#REF!'), name: new Err('#NAME?'),
  num: new Err('#NUM!'), na: new Err('#N/A'), cycle: new Err('Err:522'), arg: new Err('Err:511'), param: new Err('Err:504'),
  illegal: new Err('Err:502'),
};
//  thrown for anything lattice does not evaluate: the cell keeps the
//  result LibreOffice last cached
export class Unsupported extends Error {}

//  a rectangle of cells on one sheet, read through the engine
export class Range {
  constructor(eng, s, r1, c1, r2, c2) {
    this.eng = eng; this.s = s;
    this.r1 = Math.min(r1, r2); this.r2 = Math.max(r1, r2);
    this.c1 = Math.min(c1, c2); this.c2 = Math.max(c1, c2);
  }
  get rows() { return this.r2 - this.r1 + 1; }
  get cols() { return this.c2 - this.c1 + 1; }
  get single() { return this.r1 === this.r2 && this.c1 === this.c2; }
  at(i, j) { return this.eng.value(this.s, this.r1 + i, this.c1 + j); }
  //  every stored cell that holds something, in row order
  each(fn) { this.eng.each(this.s, this.r1, this.c1, this.r2, this.c2, fn); }
}

const isErr = (v) => v instanceof Err;
const NUMERIC = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

//  a number shown as text with no format: what & and TEXT-less joins use
export function general(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a >= 1e16 || a < 1e-15) {
    //  1.23456789012346E+017: fifteen digits and a three-digit exponent
    const m = /^(-?[\d.]+)e([+-])(\d+)$/.exec(n.toExponential(14));
    const mant = m[1].includes('.') ? m[1].replace(/\.?0+$/, '') : m[1];
    return `${mant}E${m[2]}${m[3].padStart(3, '0')}`;
  }
  let s = String(Number(n.toPrecision(15)));
  if (s.includes('e')) s = Number(n.toPrecision(15)).toFixed(25).replace(/\.?0+$/, '');
  return s;
}

//  text LibreOffice reads as a number without asking: a plain number, an
//  ISO date, a time of day. The date serial is on the default null date.
const ISO_DATE = /^\s*(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d(?:\.\d+)?))?)?\s*$/;
const CLOCK = /^\s*(\d+):(\d\d)(?::(\d\d(?:\.\d+)?))?\s*$/;
function textNum(v) {
  if (NUMERIC.test(v)) return Number(v);
  let m = ISO_DATE.exec(v);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 + 25569 + (m[4] ? (+m[4] * 3600 + +m[5] * 60 + +(m[6] || 0)) / 86400 : 0);
  m = CLOCK.exec(v);
  if (m) return (+m[1] * 3600 + +m[2] * 60 + +(m[3] || 0)) / 86400;
  return E.value;
}

export function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  if (isErr(v)) return v;
  if (typeof v === 'string') return textNum(v);
  return E.value;
}
export function toStr(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return general(v);
  //  a logical value is a number to Calc: TRUE()&"" is "1"
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v === null || v === undefined) return '';
  return v;
}
export function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null || v === undefined) return false;
  if (isErr(v)) return v;
  return E.value;
}

//  numbers sort before text; text compares without case
export function compare(a, b) {
  if (a === null || a === undefined) a = typeof b === 'string' ? '' : 0;
  if (b === null || b === undefined) b = typeof a === 'string' ? '' : 0;
  if (typeof a === 'boolean') a = a ? 1 : 0;
  if (typeof b === 'boolean') b = b ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase(), y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return typeof a === 'number' ? -1 : 1;
}

//  the comparison operators: as +compare, but text differs by case, as
//  Calc's default "case sensitive" setting has it. Lookups and criteria
//  (VLOOKUP, COUNTIF) ignore case and use +compare.
export function compareOp(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return 0;
    const k = a.localeCompare(b, 'en', { sensitivity: 'variant' });
    return k < 0 ? -1 : k > 0 ? 1 : a < b ? -1 : 1;
  }
  return compare(a, b);
}

//  a scalar from an argument: a one-cell range is its cell, a larger one
//  has no single value
const scalar = (a) => {
  if (a instanceof Range) return a.single ? a.at(0, 0) : E.value;
  return a;
};

//  every number in the arguments, as aggregates take them: cells that
//  hold text or nothing are skipped, a direct text argument must be a
//  number. An error anywhere is the result.
function numbers(args, opts = {}) {
  const out = [];
  for (const a of args) {
    if (a instanceof Range) {
      let err = null;
      a.each((v) => {
        if (err) return;
        if (isErr(v)) err = v;
        else if (typeof v === 'number') out.push(v);
        else if (typeof v === 'boolean') out.push(v ? 1 : 0);
        else if (opts.textAsZero && typeof v === 'string') out.push(0);
      });
      if (err) return err;
    } else if (a === undefined) continue;
    else {
      //  a text argument is an error here, even "3": only cells are skipped
      const n = typeof a === 'string' ? E.value : toNum(a);
      if (isErr(n)) return n;
      out.push(n);
    }
  }
  return out;
}
//  every value in the arguments, empty cells left out
function values(args) {
  const out = [];
  for (const a of args) {
    if (a instanceof Range) a.each((v) => out.push(v));
    else if (a !== undefined && a !== null) out.push(a);
  }
  return out;
}

//  a criterion as SUMIF and COUNTIF read it: ">3", "<>x", "abc", 4
function criterion(c) {
  c = scalar(c);
  if (isErr(c)) return () => false;
  if (typeof c !== 'string') return (v) => v !== null && compare(v, c) === 0 && typeof v !== 'string';
  const m = /^(<>|<=|>=|=|<|>)?(.*)$/s.exec(c);
  const op = m[1] || '=';
  const raw = m[2];
  const num = NUMERIC.test(raw) ? Number(raw) : null;
  const want = num !== null ? num : raw;
  //  wildcards: * and ? in a text criterion
  let rx = null;
  if (num === null && /[*?]/.test(raw) && (op === '=' || op === '<>')) {
    rx = new RegExp('^' + raw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'is');
  }
  return (v) => {
    if (isErr(v)) return false;
    if (typeof v === 'boolean') v = v ? 1 : 0;
    if (op === '=' || op === '<>') {
      let eq;
      if (v === null) eq = raw === '';
      else if (rx) eq = typeof v === 'string' && rx.test(v);
      else if (typeof want === 'number') eq = typeof v === 'number' && v === want;
      else eq = typeof v === 'string' && v.toLowerCase() === want.toLowerCase();
      return op === '=' ? eq : !eq;
    }
    if (v === null) return false;
    if (typeof v !== typeof want) return false;
    const k = compare(v, want);
    return op === '<' ? k < 0 : op === '>' ? k > 0 : op === '<=' ? k <= 0 : k >= 0;
  };
}

//  the cells of a range and, beside each, the cell at the same offset in
//  another range (SUMIF's sum range). Walks the whole rectangle, clamped
//  to what the sheet holds.
function pairs(test, other, fn) {
  const [rows, cols] = test.eng.used(test.s);
  const r2 = Math.min(test.r2, Math.max(rows - 1, test.r1));
  const c2 = Math.min(test.c2, Math.max(cols - 1, test.c1));
  for (let r = test.r1; r <= r2; r++) {
    for (let c = test.c1; c <= c2; c++) {
      const v = test.eng.value(test.s, r, c);
      fn(v, other ? other.eng.value(other.s, other.r1 + (r - test.r1), other.c1 + (c - test.c1)) : v);
    }
  }
}

const round = (n, d, mode) => {
  const f = 10 ** d;
  const x = n * f;
  let y;
  if (mode === 'up') y = n < 0 ? -Math.ceil(-x - 1e-9) : Math.ceil(x - 1e-9);
  else if (mode === 'down') y = n < 0 ? -Math.floor(-x + 1e-9) : Math.floor(x + 1e-9);
  else y = n < 0 ? -Math.round(-x + 1e-9) : Math.round(x + 1e-9);
  return y / f;
};

const num1 = (f) => (a) => { const n = toNum(scalar(a)); return isErr(n) ? n : f(n); };
const num2 = (f) => (a, b) => {
  const x = toNum(scalar(a)), y = toNum(scalar(b));
  if (isErr(x)) return x;
  if (isErr(y)) return y;
  return f(x, y);
};
const fin = (n) => (Number.isFinite(n) ? n : E.num);
//  a power as Calc takes it: an odd root of a negative number is real
export function power(a, b) {
  if (a === 0 && b < 0) return E.div0;
  if (a < 0 && !Number.isInteger(b)) {
    const inv = 1 / b;
    if (Math.abs(inv - Math.round(inv)) < 1e-9 && Math.abs(Math.round(inv)) % 2 === 1) return -((-a) ** b);
    return E.num;
  }
  return fin(a ** b);
}
const str1 = (f) => (a) => { const s = scalar(a); return isErr(s) ? s : f(toStr(s)); };
const need = (args, lo, hi = lo) => (args.length < lo || args.length > hi ? E.arg : null);

//  a sum that does not drift: Neumaier's compensated summation, which is
//  what keeps Calc's totals of cents exact
export function ksum(ns) {
  let s = 0, comp = 0;
  for (const n of ns) {
    const t = s + n;
    comp += Math.abs(s) >= Math.abs(n) ? (s - t) + n : (n - t) + s;
    s = t;
  }
  return s + comp;
}
function stat(args, f) {
  const ns = numbers(args);
  return isErr(ns) ? ns : f(ns);
}
const variance = (ns, pop) => {
  const n = ns.length;
  if (n < (pop ? 1 : 2)) return E.div0;
  const mean = ns.reduce((a, b) => a + b, 0) / n;
  return ns.reduce((a, b) => a + (b - mean) ** 2, 0) / (pop ? n : n - 1);
};

const DAY = 86400000;
//  a serial day as a UTC date, on the engine's null date
const dateOf = (eng, n) => new Date((Math.floor(n + 1e-9) + eng.doc.nullDate) * DAY);
const serialOf = (eng, y, m, d) => Date.UTC(y, m, d) / DAY - eng.doc.nullDate;

function lookup(needle, vec, exact) {
  needle = scalar(needle);
  if (isErr(needle)) return needle;
  if (exact) {
    for (let i = 0; i < vec.length; i++) {
      const v = vec[i];
      if (v !== null && typeof v === typeof needle && compare(v, needle) === 0) return i;
      if (typeof v === 'boolean' && typeof needle === 'number' && (v ? 1 : 0) === needle) return i;
    }
    return E.na;
  }
  //  sorted: the last entry not greater than the needle
  let hit = -1;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    if (v === null || typeof v !== typeof needle) continue;
    if (compare(v, needle) <= 0) hit = i; else break;
  }
  return hit < 0 ? E.na : hit;
}
const column = (rg, j) => { const out = []; for (let i = 0; i < Math.min(rg.rows, rg.eng.used(rg.s)[0] - rg.r1); i++) out.push(rg.at(i, j)); return out; };
const rowOf = (rg, i) => { const out = []; for (let j = 0; j < Math.min(rg.cols, rg.eng.used(rg.s)[1] - rg.c1); j++) out.push(rg.at(i, j)); return out; };

//  name -> fn(args, eng, ctx). Arguments are values or Ranges; a missing
//  argument is undefined.
export const FUNCS = {
  // ── sums and statistics
  SUM: (a) => stat(a, ksum),
  PRODUCT: (a) => stat(a, (ns) => ns.reduce((x, y) => x * y, ns.length ? 1 : 0)),
  AVERAGE: (a) => stat(a, (ns) => (ns.length ? ksum(ns) / ns.length : E.div0)),
  MIN: (a) => stat(a, (ns) => (ns.length ? Math.min(...ns) : 0)),
  MAX: (a) => stat(a, (ns) => (ns.length ? Math.max(...ns) : 0)),
  COUNT: (a) => {
    let n = 0;
    for (const x of a) {
      if (x instanceof Range) x.each((v) => { if (typeof v === 'number' || typeof v === 'boolean') n++; });
      else if (typeof x === 'number' || typeof x === 'boolean' || (typeof x === 'string' && NUMERIC.test(x))) n++;
    }
    return n;
  },
  COUNTA: (a) => values(a).length,
  COUNTBLANK: (a) => {
    const rg = a[0];
    if (!(rg instanceof Range)) return E.value;
    let full = 0;
    rg.each((v) => { if (v !== '' && v !== null) full++; });
    return rg.rows * rg.cols - full;
  },
  MEDIAN: (a) => stat(a, (ns) => {
    if (!ns.length) return E.num;
    ns.sort((x, y) => x - y);
    const m = ns.length >> 1;
    return ns.length % 2 ? ns[m] : (ns[m - 1] + ns[m]) / 2;
  }),
  MODE: (a) => stat(a, (ns) => {
    const seen = new Map();
    let best = null, top = 1;
    for (const n of ns) {
      const k = (seen.get(n) || 0) + 1;
      seen.set(n, k);
      if (k > top || (k === top && k > 1 && best !== null && n < best && seen.get(best) === k)) { top = k; best = n; }
    }
    return best === null ? E.value : best;
  }),
  VAR: (a) => stat(a, (ns) => variance(ns, false)),
  VARP: (a) => stat(a, (ns) => variance(ns, true)),
  STDEV: (a) => stat(a, (ns) => { const v = variance(ns, false); return isErr(v) ? v : Math.sqrt(v); }),
  STDEVP: (a) => stat(a, (ns) => { const v = variance(ns, true); return isErr(v) ? v : Math.sqrt(v); }),
  LARGE: (a) => { const k = toNum(scalar(a[1])); return stat([a[0]], (ns) => (isErr(k) ? k : k < 1 || k > ns.length ? E.value : ns.sort((x, y) => y - x)[Math.floor(k) - 1])); },
  SMALL: (a) => { const k = toNum(scalar(a[1])); return stat([a[0]], (ns) => (isErr(k) ? k : k < 1 || k > ns.length ? E.value : ns.sort((x, y) => x - y)[Math.floor(k) - 1])); },
  RANK: (a) => {
    const v = toNum(scalar(a[0]));
    if (isErr(v)) return v;
    const asc = a[2] !== undefined && toNum(scalar(a[2])) !== 0;
    return stat([a[1]], (ns) => (ns.includes(v) ? 1 + ns.filter((n) => (asc ? n < v : n > v)).length : E.value));
  },
  SUMIF: (a) => {
    if (!(a[0] instanceof Range)) return E.value;
    const ok = criterion(a[1]);
    const other = a[2] instanceof Range ? a[2] : null;
    const ns = [];
    let err = null;
    pairs(a[0], other, (v, w) => { if (ok(v)) { if (isErr(w)) err = w; else if (typeof w === 'number') ns.push(w); else if (typeof w === 'boolean') ns.push(w ? 1 : 0); } });
    return err || ksum(ns);
  },
  COUNTIF: (a) => {
    if (!(a[0] instanceof Range)) return E.value;
    const ok = criterion(a[1]);
    let n = 0;
    pairs(a[0], null, (v) => { if (ok(v)) n++; });
    return n;
  },
  AVERAGEIF: (a) => {
    if (!(a[0] instanceof Range)) return E.value;
    const ok = criterion(a[1]);
    const other = a[2] instanceof Range ? a[2] : null;
    const ns = [];
    pairs(a[0], other, (v, w) => { if (ok(v) && typeof w === 'number') ns.push(w); });
    return ns.length ? ksum(ns) / ns.length : E.div0;
  },
  SUMIFS: (a) => ifs(a, 1, (acc, w) => (typeof w === 'number' ? acc + w : acc), 0),
  COUNTIFS: (a) => ifs([null, ...a], 1, (acc) => acc + 1, 0),
  SUMPRODUCT: (a) => {
    if (!a.length || !a.every((x) => x instanceof Range)) return E.value;
    const [f] = a;
    if (a.some((x) => x.rows !== f.rows || x.cols !== f.cols)) return E.value;
    const [rows, cols] = f.eng.used(f.s);
    let s = 0;
    for (let i = 0; i < Math.min(f.rows, Math.max(rows - f.r1, 0)); i++) {
      for (let j = 0; j < Math.min(f.cols, Math.max(cols - f.c1, 0)); j++) {
        let p = 1;
        for (const rg of a) {
          const v = rg.at(i, j);
          if (isErr(v)) return v;
          p *= typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0;
        }
        s += p;
      }
    }
    return s;
  },

  // ── maths
  ABS: (a) => num1(Math.abs)(a[0]),
  SIGN: (a) => num1(Math.sign)(a[0]),
  INT: (a) => num1(Math.floor)(a[0]),
  TRUNC: (a) => num2((n, d) => round(n, d, 'down'))(a[0], a[1] ?? 0),
  ROUND: (a) => num2((n, d) => round(n, d))(a[0], a[1] ?? 0),
  ROUNDUP: (a) => num2((n, d) => round(n, d, 'up'))(a[0], a[1] ?? 0),
  ROUNDDOWN: (a) => num2((n, d) => round(n, d, 'down'))(a[0], a[1] ?? 0),
  MOD: (a) => num2((n, d) => (d === 0 ? E.div0 : n - d * Math.floor(n / d)))(a[0], a[1]),
  QUOTIENT: (a) => num2((n, d) => (d === 0 ? E.div0 : Math.trunc(n / d)))(a[0], a[1]),
  POWER: (a) => num2(power)(a[0], a[1]),
  SQRT: (a) => num1((n) => (n < 0 ? E.illegal : Math.sqrt(n)))(a[0]),
  EXP: (a) => num1((n) => fin(Math.exp(n)))(a[0]),
  LN: (a) => num1((n) => (n <= 0 ? E.illegal : Math.log(n)))(a[0]),
  LOG10: (a) => num1((n) => (n <= 0 ? E.illegal : Math.log10(n)))(a[0]),
  LOG: (a) => num2((n, b) => (n <= 0 || b <= 0 ? E.illegal : Math.log(n) / Math.log(b)))(a[0], a[1] ?? 10),
  PI: () => Math.PI,
  SIN: (a) => num1(Math.sin)(a[0]),
  COS: (a) => num1(Math.cos)(a[0]),
  TAN: (a) => num1(Math.tan)(a[0]),
  ASIN: (a) => num1((n) => fin(Math.asin(n)))(a[0]),
  ACOS: (a) => num1((n) => fin(Math.acos(n)))(a[0]),
  ATAN: (a) => num1(Math.atan)(a[0]),
  ATAN2: (a) => num2((x, y) => Math.atan2(y, x))(a[0], a[1]),
  DEGREES: (a) => num1((n) => n * 180 / Math.PI)(a[0]),
  RADIANS: (a) => num1((n) => n * Math.PI / 180)(a[0]),
  EVEN: (a) => num1((n) => { const s = n < 0 ? -1 : 1; return s * 2 * Math.ceil(Math.abs(n) / 2 - 1e-12); })(a[0]),
  ODD: (a) => num1((n) => { const s = n < 0 ? -1 : 1; const m = Math.ceil(Math.abs(n) - 1e-12); return s * (m % 2 ? m : m + 1); })(a[0]),
  FACT: (a) => num1((n) => { if (n < 0) return E.arg; let f = 1; for (let i = 2; i <= Math.floor(n); i++) f *= i; return fin(f); })(a[0]),
  CEILING: (a) => num2((n, s) => (s === 0 ? 0 : n < 0 && s < 0 ? Math.floor(n / s + 1e-12) * s : Math.ceil(n / s - 1e-12) * s))(a[0], a[1] ?? 1),
  FLOOR: (a) => num2((n, s) => (s === 0 ? E.div0 : n < 0 && s < 0 ? Math.ceil(n / s - 1e-12) * s : Math.floor(n / s + 1e-12) * s))(a[0], a[1] ?? 1),
  MROUND: (a) => num2((n, s) => (s === 0 ? 0 : Math.round(n / s) * s))(a[0], a[1]),
  GCD: (a) => stat(a, (ns) => ns.map((n) => Math.floor(Math.abs(n))).reduce((x, y) => { while (y) [x, y] = [y, x % y]; return x; }, 0)),
  LCM: (a) => stat(a, (ns) => ns.map((n) => Math.floor(Math.abs(n))).reduce((x, y) => { if (!x || !y) return 0; let g = x, h = y; while (h) [g, h] = [h, g % h]; return x / g * y; }, 1)),
  RAND: () => Math.random(),
  RANDBETWEEN: (a) => num2((lo, hi) => Math.floor(lo + Math.random() * (hi - lo + 1)))(a[0], a[1]),

  // ── logic
  TRUE: () => true,
  FALSE: () => false,
  NOT: (a) => { const b = toBool(scalar(a[0])); return isErr(b) ? b : !b; },
  NA: () => E.na,
  ISBLANK: (a) => (a[0] instanceof Range ? a[0].single && a[0].at(0, 0) === null : false),
  ISNUMBER: (a) => { const v = scalar(a[0]); return typeof v === 'number' || typeof v === 'boolean'; },
  ISTEXT: (a) => typeof scalar(a[0]) === 'string',
  ISNONTEXT: (a) => typeof scalar(a[0]) !== 'string',
  ISLOGICAL: (a) => typeof scalar(a[0]) === 'boolean',
  ISERROR: (a) => isErr(scalar(a[0])),
  ISERR: (a) => { const v = scalar(a[0]); return isErr(v) && v !== E.na; },
  ISNA: (a) => scalar(a[0]) === E.na,
  ISEVEN: (a) => num1((n) => Math.trunc(n) % 2 === 0)(a[0]),
  ISODD: (a) => num1((n) => Math.trunc(n) % 2 !== 0)(a[0]),
  N: (a) => { const v = scalar(a[0]); return isErr(v) ? v : typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0; },
  T: (a) => { const v = scalar(a[0]); return typeof v === 'string' ? v : isErr(v) ? v : ''; },

  // ── text
  LEN: (a) => str1((s) => [...s].length)(a[0]),
  UPPER: (a) => str1((s) => s.toUpperCase())(a[0]),
  LOWER: (a) => str1((s) => s.toLowerCase())(a[0]),
  PROPER: (a) => str1((s) => s.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (m, p, c) => p + c.toUpperCase()))(a[0]),
  TRIM: (a) => str1((s) => s.replace(/ +/g, ' ').replace(/^ | $/g, ''))(a[0]),
  LEFT: (a) => textCut(a, (s, n) => s.slice(0, n)),
  RIGHT: (a) => textCut(a, (s, n) => (n ? s.slice(-n) : [])),
  MID: (a) => {
    const s = scalar(a[0]), st = toNum(scalar(a[1])), n = toNum(scalar(a[2]));
    for (const x of [s, st, n]) if (isErr(x)) return x;
    if (st < 1 || n < 0) return E.arg;
    return [...toStr(s)].slice(Math.floor(st) - 1, Math.floor(st) - 1 + Math.floor(n)).join('');
  },
  CONCATENATE: (a) => joinAll(a.map(scalar)),
  CONCAT: (a) => joinAll(values(a)),
  TEXTJOIN: (a) => {
    const d = scalar(a[0]), skip = toBool(scalar(a[1]));
    if (isErr(d)) return d;
    if (isErr(skip)) return skip;
    const parts = [];
    for (const x of a.slice(2)) {
      if (x instanceof Range) {
        const [rows, cols] = x.eng.used(x.s);
        for (let i = 0; i < Math.min(x.rows, Math.max(rows - x.r1, 0)); i++) {
          for (let j = 0; j < Math.min(x.cols, Math.max(cols - x.c1, 0)); j++) parts.push(x.at(i, j));
        }
      } else parts.push(x);
    }
    const err = parts.find(isErr);
    if (err) return err;
    return parts.map(toStr).filter((s) => !skip || s !== '').join(toStr(d));
  },
  REPT: (a) => { const s = scalar(a[0]), n = toNum(scalar(a[1])); if (isErr(s)) return s; if (isErr(n)) return n; return n < 0 || n * toStr(s).length > 65535 ? E.value : toStr(s).repeat(Math.floor(n)); },
  EXACT: (a) => { const x = scalar(a[0]), y = scalar(a[1]); if (isErr(x)) return x; if (isErr(y)) return y; return toStr(x) === toStr(y); },
  FIND: (a) => textFind(a, false),
  SEARCH: (a) => textFind(a, true),
  SUBSTITUTE: (a) => {
    const s = scalar(a[0]), from = scalar(a[1]), to = scalar(a[2]);
    for (const x of [s, from, to]) if (isErr(x)) return x;
    const S = toStr(s), F = toStr(from), T = toStr(to);
    if (!F) return S;
    if (a[3] === undefined) return S.split(F).join(T);
    const n = toNum(scalar(a[3]));
    if (isErr(n)) return n;
    let at = -1;
    for (let i = 0; i < n; i++) { at = S.indexOf(F, at + 1); if (at < 0) return S; }
    return S.slice(0, at) + T + S.slice(at + F.length);
  },
  REPLACE: (a) => {
    const s = scalar(a[0]), st = toNum(scalar(a[1])), n = toNum(scalar(a[2])), w = scalar(a[3]);
    for (const x of [s, st, n, w]) if (isErr(x)) return x;
    const ch = [...toStr(s)];
    return ch.slice(0, st - 1).join('') + toStr(w) + ch.slice(st - 1 + n).join('');
  },
  VALUE: (a) => { const v = scalar(a[0]); const n = typeof v === 'string' ? toNum(v.replace(/,/g, '')) : toNum(v); return n === E.value ? E.illegal : n; },
  CHAR: (a) => num1((n) => (n < 1 || n > 255 ? E.arg : String.fromCharCode(n)))(a[0]),
  CODE: (a) => str1((s) => (s ? s.charCodeAt(0) : E.value))(a[0]),

  // ── lookup
  VLOOKUP: (a) => {
    const rg = a[1];
    if (!(rg instanceof Range)) return E.value;
    const col = toNum(scalar(a[2]));
    if (isErr(col)) return col;
    if (col < 1 || col > rg.cols) return E.illegal;
    const exact = a[3] !== undefined && toNum(scalar(a[3])) === 0;
    const i = lookup(a[0], column(rg, 0), exact);
    return isErr(i) ? i : rg.at(i, Math.floor(col) - 1);
  },
  HLOOKUP: (a) => {
    const rg = a[1];
    if (!(rg instanceof Range)) return E.value;
    const row = toNum(scalar(a[2]));
    if (isErr(row)) return row;
    if (row < 1 || row > rg.rows) return E.illegal;
    const exact = a[3] !== undefined && toNum(scalar(a[3])) === 0;
    const j = lookup(a[0], rowOf(rg, 0), exact);
    return isErr(j) ? j : rg.at(Math.floor(row) - 1, j);
  },
  MATCH: (a) => {
    const rg = a[1];
    if (!(rg instanceof Range) || (rg.rows > 1 && rg.cols > 1)) return E.na;
    const type = a[2] === undefined ? 1 : toNum(scalar(a[2]));
    if (isErr(type)) return type;
    const vec = rg.cols === 1 ? column(rg, 0) : rowOf(rg, 0);
    if (type < 0) {
      const needle = scalar(a[0]);
      let hit = -1;
      for (let i = 0; i < vec.length; i++) { if (vec[i] !== null && typeof vec[i] === typeof needle && compare(vec[i], needle) >= 0) hit = i; else break; }
      return hit < 0 ? E.na : hit + 1;
    }
    const i = lookup(a[0], vec, type === 0);
    return isErr(i) ? i : i + 1;
  },
  INDEX: (a) => {
    const rg = a[0];
    if (!(rg instanceof Range)) return E.value;
    let r = a[1] === undefined ? 0 : toNum(scalar(a[1]));
    let c = a[2] === undefined ? 0 : toNum(scalar(a[2]));
    if (isErr(r)) return r;
    if (isErr(c)) return c;
    if (rg.rows === 1 && a[2] === undefined && r > 0) { c = r; r = 1; }
    if (r === 0 && rg.rows === 1) r = 1;
    if (c === 0 && rg.cols === 1) c = 1;
    if (r < 1 || c < 1 || r > rg.rows || c > rg.cols) return r === 0 || c === 0 ? E.value : E.ref;
    return rg.at(Math.floor(r) - 1, Math.floor(c) - 1);
  },
  CHOOSE: (a) => {
    const n = toNum(scalar(a[0]));
    if (isErr(n)) return n;
    return n < 1 || n >= a.length ? E.illegal : scalar(a[Math.floor(n)]);
  },
  ROW: (a, eng, ctx) => (a[0] instanceof Range ? a[0].r1 + 1 : a.length ? E.value : ctx.r + 1),
  COLUMN: (a, eng, ctx) => (a[0] instanceof Range ? a[0].c1 + 1 : a.length ? E.value : ctx.c + 1),
  ROWS: (a) => (a[0] instanceof Range ? a[0].rows : 1),
  COLUMNS: (a) => (a[0] instanceof Range ? a[0].cols : 1),

  // ── dates and times
  DATE: (a, eng) => {
    const [y, m, d] = a.slice(0, 3).map((x) => toNum(scalar(x)));
    for (const x of [y, m, d]) if (isErr(x)) return x;
    return serialOf(eng, Math.floor(y), Math.floor(m) - 1, Math.floor(d));
  },
  TIME: (a) => {
    const [h, m, s] = a.slice(0, 3).map((x) => toNum(scalar(x)));
    for (const x of [h, m, s]) if (isErr(x)) return x;
    const t = (h * 3600 + m * 60 + s) / 86400;
    return t - Math.floor(t);
  },
  YEAR: (a, eng) => num1((n) => dateOf(eng, n).getUTCFullYear())(a[0]),
  MONTH: (a, eng) => num1((n) => dateOf(eng, n).getUTCMonth() + 1)(a[0]),
  DAY: (a, eng) => num1((n) => dateOf(eng, n).getUTCDate())(a[0]),
  HOUR: (a) => num1((n) => Math.floor(Math.round((n - Math.floor(n)) * 86400) / 3600) % 24)(a[0]),
  MINUTE: (a) => num1((n) => Math.floor(Math.round((n - Math.floor(n)) * 86400) / 60) % 60)(a[0]),
  SECOND: (a) => num1((n) => Math.round((n - Math.floor(n)) * 86400) % 60)(a[0]),
  WEEKDAY: (a, eng) => {
    const n = toNum(scalar(a[0])), type = a[1] === undefined ? 1 : toNum(scalar(a[1]));
    if (isErr(n)) return n;
    if (isErr(type)) return type;
    const d = dateOf(eng, n).getUTCDay();      // 0 is Sunday
    return type === 2 ? (d + 6) % 7 + 1 : type === 3 ? (d + 6) % 7 : d + 1;
  },
  DAYS: (a) => num2((end, start) => end - start)(a[0], a[1]),
  EDATE: (a, eng) => num2((n, m) => {
    const d = dateOf(eng, n);
    const y = d.getUTCFullYear(), mo = d.getUTCMonth() + Math.trunc(m);
    const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    return serialOf(eng, y, mo, Math.min(d.getUTCDate(), last));
  })(a[0], a[1]),
  EOMONTH: (a, eng) => num2((n, m) => {
    const d = dateOf(eng, n);
    return serialOf(eng, d.getUTCFullYear(), d.getUTCMonth() + Math.trunc(m) + 1, 0);
  })(a[0], a[1]),
  TODAY: (a, eng) => { const d = new Date(); return serialOf(eng, d.getFullYear(), d.getMonth(), d.getDate()); },
  NOW: (a, eng) => { const d = new Date(); return serialOf(eng, d.getFullYear(), d.getMonth(), d.getDate()) + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400; },
};

function ifs(a, first, step, init) {
  const sum = a[0];
  const tests = [];
  for (let i = first; i + 1 < a.length; i += 2) {
    if (!(a[i] instanceof Range)) return E.value;
    tests.push([a[i], criterion(a[i + 1])]);
  }
  if (!tests.length) return E.arg;
  const f = tests[0][0];
  const [rows, cols] = f.eng.used(f.s);
  let acc = init;
  for (let i = 0; i < Math.min(f.rows, Math.max(rows - f.r1, 0)); i++) {
    for (let j = 0; j < Math.min(f.cols, Math.max(cols - f.c1, 0)); j++) {
      if (tests.every(([rg, ok]) => ok(rg.at(i, j)))) acc = step(acc, sum instanceof Range ? sum.at(i, j) : null);
    }
  }
  return acc;
}
function textCut(a, f) {
  const s = scalar(a[0]);
  const n = a[1] === undefined ? 1 : toNum(scalar(a[1]));
  if (isErr(s)) return s;
  if (isErr(n)) return n;
  if (n < 0) return E.arg;
  return f([...toStr(s)], Math.floor(n)).join('');
}
function joinAll(vs) {
  const err = vs.find(isErr);
  return err || vs.map(toStr).join('');
}
function textFind(a, loose) {
  const needle = scalar(a[0]), hay = scalar(a[1]);
  const st = a[2] === undefined ? 1 : toNum(scalar(a[2]));
  for (const x of [needle, hay, st]) if (isErr(x)) return x;
  let N = toStr(needle), H = toStr(hay);
  if (loose) { N = N.toLowerCase(); H = H.toLowerCase(); }
  if (st < 1) return E.value;
  const at = H.indexOf(N, st - 1);
  return at < 0 ? E.value : at + 1;
}

//  the functions that take their arguments unevaluated, because they
//  must not evaluate every branch: fn(nodes, ev) where ev(node) evaluates
export const LAZY = {
  IF: (n, ev) => {
    if (n.length < 1 || n.length > 3) return E.arg;
    const c = toBool(scalar(ev(n[0])));
    if (isErr(c)) return c;
    //  a branch left empty is 0, and no else branch is FALSE
    if (c) return n.length > 1 && n[1].t !== 'missing' ? ev(n[1]) : n.length > 1 ? 0 : true;
    return n.length > 2 && n[2].t !== 'missing' ? ev(n[2]) : n.length > 2 ? 0 : false;
  },
  IFERROR: (n, ev) => { const v = scalar(ev(n[0])); return isErr(v) ? (n[1] ? ev(n[1]) : '') : v; },
  IFNA: (n, ev) => { const v = scalar(ev(n[0])); return v === E.na ? (n[1] ? ev(n[1]) : '') : v; },
  IFS: (n, ev) => {
    for (let i = 0; i + 1 < n.length; i += 2) {
      const c = toBool(scalar(ev(n[i])));
      if (isErr(c)) return c;
      if (c) return ev(n[i + 1]);
    }
    return E.na;
  },
  SWITCH: (n, ev) => {
    const v = scalar(ev(n[0]));
    if (isErr(v)) return v;
    let i = 1;
    for (; i + 1 < n.length; i += 2) {
      const w = scalar(ev(n[i]));
      if (isErr(w)) return w;
      if (typeof w === typeof v && compare(v, w) === 0) return ev(n[i + 1]);
    }
    return i < n.length ? ev(n[i]) : E.na;
  },
  AND: (n, ev) => logic(n, ev, (acc, b) => acc && b, true),
  OR: (n, ev) => logic(n, ev, (acc, b) => acc || b, false),
  XOR: (n, ev) => logic(n, ev, (acc, b) => acc !== b, false),
};
function logic(nodes, ev, step, init) {
  let acc = init, seen = 0, err = null;
  for (const node of nodes) {
    const v = ev(node);
    if (v instanceof Range) {
      v.each((x) => {
        if (err) return;
        if (isErr(x)) err = x;
        else if (typeof x === 'number' || typeof x === 'boolean') { acc = step(acc, !!x); seen++; }
      });
    } else {
      const b = toBool(v);
      if (isErr(b)) err = err || b; else { acc = step(acc, b); seen++; }
    }
    if (err) return err;
  }
  return seen ? acc : E.value;
}
export { need };
