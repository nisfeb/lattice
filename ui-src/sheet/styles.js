//  styles.js: what a cell looks like and how its number is written.
//
//  Reads the document's cell, column and row styles and its number
//  formats (data styles), for display and for the text lattice caches in
//  a cell it recomputes. LibreOffice rewrites that text from the value and
//  the style when it opens the file, so a format lattice does not know
//  only degrades what lattice itself shows.
//
//  New formatting is an automatic style named by a hash of what it holds,
//  as the Writer core does: the same formatting gives the same name in
//  every session, and an existing style that already says it is reused.

import { attr, escAttr } from '../writer/xml.js';
import { general } from './funcs.js';

const kids = (el, name) => (el ? el.kids.filter((k) => k.name === name) : []);
const child = (el, name) => (el ? el.kids.find((k) => k.name === name) : undefined);

const UNIT = { cm: 37.795, mm: 3.7795, in: 96, pt: 1.3333, pc: 16, px: 1 };
//  a length ("2.258cm") in CSS pixels, or null
export function px(len) {
  const m = /^(-?[\d.]+)(cm|mm|in|pt|pc|px)$/.exec(len || '');
  return m ? Number(m[1]) * UNIT[m[2]] : null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const p2 = (n) => String(n).padStart(2, '0');

//  a number with fixed decimals, rounded half away from zero on its
//  decimal spelling (1.005 to two places is 1.01, as Calc shows it)
export function fixed(n, places, minInt = 1, group = false) {
  const neg = n < 0;
  let a = Math.abs(n);
  const f = 10 ** places;
  a = Math.round(a * f * (1 + 4 * Number.EPSILON)) / f;
  let [i, d = ''] = a.toFixed(Math.min(places, 20)).split('.');
  i = i.padStart(minInt, '0');
  if (minInt === 0 && i === '0') i = '';
  if (group) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const zero = Number(a) === 0;
  return (neg && !zero ? '-' : '') + i + (places ? '.' + d : '');
}

//  one data style element as a function from a value to its text
function compile(el, src) {
  const parts = [];
  const txt = (k) => src.slice(k.openEnd, k.closeStart).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  let unknown = false;
  let hasAmPm = false;
  for (const k of el.kids) if (k.name === 'number:am-pm') hasAmPm = true;
  for (const k of el.kids) {
    if (!k.name) continue;
    const long = attr(k, 'number:style') === 'long';
    switch (k.name) {
      case 'number:text': { const t = txt(k); parts.push(() => t); break; }
      case 'number:currency-symbol': { const t = txt(k); parts.push(() => t); break; }
      case 'number:number': {
        const dp = attr(k, 'number:decimal-places');
        const minInt = parseInt(attr(k, 'number:min-integer-digits') ?? '1', 10);
        const group = attr(k, 'number:grouping') === 'true';
        const factor = Number(attr(k, 'number:display-factor') || 1) || 1;
        if (dp === undefined) parts.push((v) => general(v / factor));
        else { const d = parseInt(dp, 10) || 0; parts.push((v) => fixed(v / factor, d, minInt, group)); }
        break;
      }
      case 'number:year': parts.push((v, d) => (long ? String(d.getUTCFullYear()) : p2(d.getUTCFullYear() % 100))); break;
      case 'number:month': {
        const textual = attr(k, 'number:textual') === 'true';
        parts.push((v, d) => (textual ? (long ? MONTHS[d.getUTCMonth()] : MONTHS[d.getUTCMonth()].slice(0, 3)) : long ? p2(d.getUTCMonth() + 1) : String(d.getUTCMonth() + 1)));
        break;
      }
      case 'number:day': parts.push((v, d) => (long ? p2(d.getUTCDate()) : String(d.getUTCDate()))); break;
      case 'number:day-of-week': parts.push((v, d) => (long ? DAYS[d.getUTCDay()] : DAYS[d.getUTCDay()].slice(0, 3))); break;
      case 'number:hours': parts.push((v, d, t) => { const h = hasAmPm ? (t.h % 12 || 12) : t.h; return long ? p2(h) : String(h); }); break;
      case 'number:minutes': parts.push((v, d, t) => (long ? p2(t.m) : String(t.m))); break;
      case 'number:seconds': parts.push((v, d, t) => (long ? p2(t.s) : String(t.s))); break;
      case 'number:am-pm': parts.push((v, d, t) => (t.h < 12 ? 'AM' : 'PM')); break;
      case 'number:boolean': parts.push((v) => (v ? 'TRUE' : 'FALSE')); break;
      case 'number:text-content': parts.push((v) => String(v)); break;
      case 'style:text-properties': case 'style:map': break;
      default: unknown = true;
    }
  }
  if (unknown || !parts.length) return null;
  const kind = el.name;
  const truncHours = attr(el, 'number:truncate-on-overflow') === 'false';
  return (v, nullDate) => {
    let d = null, t = null, show = v;
    if (kind === 'number:date-style' || kind === 'number:time-style') {
      const whole = Math.floor(v + 1e-9);
      const secs = Math.round((v - whole) * 86400);
      d = new Date((whole + nullDate) * 86400000 + (secs >= 86400 ? 86400000 : 0));
      const sod = secs % 86400;
      t = { h: Math.floor(sod / 3600), m: Math.floor(sod / 60) % 60, s: sod % 60 };
      if (truncHours) t.h += whole * 24;
    } else if (kind === 'number:percentage-style') show = v * 100;
    return parts.map((p) => p(show, d, t)).join('');
  };
}

const CELL_PROPS = ['style:text-properties', 'style:paragraph-properties', 'style:table-cell-properties'];

export class Styles {
  constructor(doc) {
    this.doc = doc;
    this.cell = new Map();      // name -> style element (table-cell family)
    this.col = new Map();
    this.row = new Map();
    this.data = new Map();      // name -> data style element
    this.fmt = new Map();       // data style name -> function | null
    this.look = new Map();      // cell style name -> resolved look
    this.byKey = new Map();     // canonical key -> automatic cell style name
    this.defaultCell = null;
    for (const box of [doc.styles, doc.auto]) {
      if (!box) continue;
      for (const k of box.kids) {
        if (!k.name) continue;
        if (k.name === 'style:style') {
          const fam = attr(k, 'style:family'), nm = attr(k, 'style:name');
          if (fam === 'table-cell') { this.cell.set(nm, k); if (box === doc.auto) this.byKey.set(this.keyOf(k), nm); }
          else if (fam === 'table-column') this.col.set(nm, k);
          else if (fam === 'table-row') this.row.set(nm, k);
        } else if (k.name === 'style:default-style') {
          if (attr(k, 'style:family') === 'table-cell') this.defaultCell = k;
        } else if (k.name.startsWith('number:')) this.data.set(attr(k, 'style:name'), k);
      }
    }
  }

  //  the canonical key of a cell style: its parent, data style and every
  //  property, sorted. Two styles with one key format alike.
  keyOf(el) {
    const parts = [`parent=${attr(el, 'style:parent-style-name') || ''}`, `data=${attr(el, 'style:data-style-name') || ''}`];
    for (const k of el.kids) {
      if (!k.name) continue;
      if (CELL_PROPS.includes(k.name) && !k.kids.some((x) => x.name)) {
        for (const [a, v] of k.attrs) parts.push(`${k.name}@${a}=${v}`);
      } else parts.push('raw=' + this.doc.text.slice(k.start, k.end));
    }
    return parts.sort().join('\n');
  }

  //  the look of a cell style, its parents folded in: { bold, italic,
  //  underline, strike, color, bg, align, wrap, size, data }
  lookOf(name) {
    if (this.look.has(name)) return this.look.get(name);
    const out = {};
    const seen = new Set();
    const chain = [];
    let n = name;
    while (n && !seen.has(n) && this.cell.has(n)) { seen.add(n); chain.push(this.cell.get(n)); n = attr(this.cell.get(n), 'style:parent-style-name'); }
    if (this.defaultCell) chain.push(this.defaultCell);
    for (const el of chain.reverse()) {
      const ds = attr(el, 'style:data-style-name');
      if (ds) out.data = ds;
      const tp = child(el, 'style:text-properties'), pp = child(el, 'style:paragraph-properties'), cp = child(el, 'style:table-cell-properties');
      if (tp) {
        const w = attr(tp, 'fo:font-weight'); if (w) out.bold = w === 'bold' || Number(w) >= 600;
        const i = attr(tp, 'fo:font-style'); if (i) out.italic = i === 'italic' || i === 'oblique';
        const u = attr(tp, 'style:text-underline-style'); if (u) out.underline = u !== 'none';
        const s = attr(tp, 'style:text-line-through-style'); if (s) out.strike = s !== 'none';
        const c = attr(tp, 'fo:color'); if (c && /^#[0-9a-fA-F]{6}$/.test(c)) out.color = c;
        const z = px(attr(tp, 'fo:font-size')); if (z) out.size = z;
      }
      if (pp) { const a = attr(pp, 'fo:text-align'); if (a) out.align = a === 'end' || a === 'right' ? 'right' : a === 'center' ? 'center' : a === 'justify' ? 'justify' : 'left'; }
      if (cp) {
        const b = attr(cp, 'fo:background-color'); if (b) out.bg = /^#[0-9a-fA-F]{6}$/.test(b) ? b : undefined;
        const w = attr(cp, 'fo:wrap-option'); if (w) out.wrap = w === 'wrap';
        const src = attr(cp, 'style:text-align-source'); if (src === 'value-type') delete out.align;
      }
    }
    this.look.set(name, out);
    return out;
  }

  //  the style in force at a cell: its own, else its column's default
  nameAt(sheet, cell, c) {
    if (cell.st) return cell.st;
    let at = 0;
    for (const col of sheet.cols) {
      if (c < at + col.rep) return col.cellSt || 'Default';
      at += col.rep;
    }
    return 'Default';
  }

  formatter(dataName) {
    if (!dataName) return null;
    if (this.fmt.has(dataName)) return this.fmt.get(dataName);
    const el = this.data.get(dataName);
    const f = el ? compile(el, this.doc.text) : null;
    this.fmt.set(dataName, f);
    return f;
  }

  //  +text: the display text of a value in a cell of this style
  text(styleName, v, vt) {
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v !== 'number') return '';
    const f = this.formatter(this.lookOf(styleName).data);
    if (f) { try { return f(v, this.doc.nullDate); } catch { /* fall through */ } }
    if (vt === 'percentage') return fixed(v * 100, 2) + '%';
    if (vt === 'date') {
      const d = new Date((Math.floor(v + 1e-9) + this.doc.nullDate) * 86400000);
      return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
    }
    if (vt === 'time') {
      const s = Math.round((v - Math.floor(v)) * 86400);
      return `${p2(Math.floor(s / 3600) + Math.floor(v) * 24)}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
    }
    if (vt === 'currency') return fixed(v, 2, 1, true);
    return general(v);
  }

  colWidth(name) { const el = this.col.get(name); return el ? px(attr(child(el, 'style:table-column-properties') || el, 'style:column-width')) : null; }
  rowHeight(name) { const el = this.row.get(name); return el ? px(attr(child(el, 'style:table-row-properties') || el, 'style:row-height')) : null; }
  rowHidden() { return false; }

  // ── new styles ─────────────────────────────────────────────────────────

  //  +restyle: the name of a cell style that is `base` with `change`
  //  applied, made (and queued on doc.newAuto) when the document has none.
  //  change: { bold, italic, underline, align, data } where a value of
  //  null takes the property away.
  restyle(base, change) {
    //  already so: the style it has, whatever attributes spell it
    const now = this.lookOf(base);
    if (Object.keys(change).every((k) => (k === 'data' ? (now.data || null) === (change.data || null) : (now[k] || false) === (change[k] || false)))) return base;
    const el = this.cell.get(base);
    const auto = el && this.doc.auto && this.doc.auto.kids.includes(el);
    //  a named style is the parent of the new one. An automatic style is
    //  copied, with its own parent.
    const parent = auto ? (attr(el, 'style:parent-style-name') || 'Default') : (el ? base : 'Default');
    let data = auto ? attr(el, 'style:data-style-name') : undefined;
    const props = { 'style:text-properties': [], 'style:paragraph-properties': [], 'style:table-cell-properties': [] };
    const raw = [];
    if (auto) {
      for (const k of el.kids) {
        if (!k.name) continue;
        if (CELL_PROPS.includes(k.name) && !k.kids.some((x) => x.name)) props[k.name].push(...k.attrs.map(([a, v]) => [a, v]));
        else raw.push(this.doc.text.slice(k.start, k.end));
      }
    }
    const set = (box, name, val) => {
      const list = props[box];
      const i = list.findIndex(([a]) => a === name);
      if (val === null) { if (i >= 0) list.splice(i, 1); } else if (i >= 0) list[i] = [name, val]; else list.push([name, val]);
    };
    if ('bold' in change) {
      for (const a of ['fo:font-weight', 'style:font-weight-asian', 'style:font-weight-complex']) set('style:text-properties', a, change.bold ? 'bold' : null);
    }
    if ('italic' in change) {
      for (const a of ['fo:font-style', 'style:font-style-asian', 'style:font-style-complex']) set('style:text-properties', a, change.italic ? 'italic' : null);
    }
    if ('underline' in change) {
      set('style:text-properties', 'style:text-underline-style', change.underline ? 'solid' : null);
      set('style:text-properties', 'style:text-underline-width', change.underline ? 'auto' : null);
      set('style:text-properties', 'style:text-underline-color', change.underline ? 'font-color' : null);
    }
    if ('align' in change) {
      const v = change.align;
      set('style:paragraph-properties', 'fo:text-align', v ? (v === 'right' ? 'end' : v === 'left' ? 'start' : v) : null);
      set('style:table-cell-properties', 'style:text-align-source', v ? 'fix' : null);
      set('style:table-cell-properties', 'style:repeat-content', v ? 'false' : null);
      if (!v) set('style:paragraph-properties', 'fo:margin-left', null);
    }
    if ('data' in change) data = change.data || undefined;
    const body = CELL_PROPS.filter((b) => props[b].length).map((b) => `<${b}${props[b].map(([a, v]) => ` ${a}="${v}"`).join('')}/>`).join('') + raw.join('');
    const parts = [`parent=${parent}`, `data=${data || ''}`];
    for (const b of CELL_PROPS) for (const [a, v] of props[b]) parts.push(`${b}@${a}=${v}`);
    for (const r of raw) parts.push('raw=' + r);
    const key = parts.sort().join('\n');
    if (!body && !data) return parent;
    //  nothing changed: the style it already has, not a twin of it
    if (auto && key === this.keyOf(el)) return base;
    const have = this.byKey.get(key);
    if (have) return have;
    const name = 'Lce' + hash(key);
    const xml = `<style:style style:name="${name}" style:family="table-cell" style:parent-style-name="${escAttr(parent)}"`
      + (data ? ` style:data-style-name="${escAttr(data)}"` : '') + (body ? `>${body}</style:style>` : '/>');
    this.doc.newAuto.push(xml);
    this.byKey.set(key, name);
    this.pending = (this.pending || new Map()).set(name, { parent, data, props });
    //  the look of a style not yet in the source: the base's, changed
    const look = { ...this.lookOf(base) };
    for (const k of ['bold', 'italic', 'underline', 'align']) if (k in change) { if (change[k]) look[k] = change[k]; else delete look[k]; }
    if ('data' in change) { if (data) look.data = data; else delete look.data; }
    this.look.set(name, look);
    return name;
  }

  //  +dataStyle: the name of a number format of one of lattice's kinds,
  //  made when the document has none: 'number' (two decimals, grouped),
  //  'percent', 'currency', 'date', 'time', or null for none
  dataStyle(kind) {
    if (!kind || kind === 'general') return null;
    const xml = DATA[kind];
    if (!xml) return null;
    const name = 'Ln' + hash(xml);
    if (!this.data.has(name) && !(this.madeData || (this.madeData = new Set())).has(name)) {
      this.madeData.add(name);
      this.doc.newAuto.push(xml.replace('NAME', name));
      this.fmt.set(name, DATA_FN[kind]);
      (this.madeKind || (this.madeKind = new Map())).set(name, kind);
    }
    return name;
  }

  //  +dataKind: what a number format is for: 'percent', 'currency',
  //  'date', 'time', or null for a plain number or none
  dataKind(name) {
    if (!name) return null;
    if (this.madeKind && this.madeKind.has(name)) { const k = this.madeKind.get(name); return k === 'number' ? null : k; }
    const el = this.data.get(name);
    return el ? DATA_KIND[el.name] || null : null;
  }
}

const DATA_KIND = {
  'number:percentage-style': 'percent', 'number:currency-style': 'currency', 'number:date-style': 'date', 'number:time-style': 'time',
};
const DATA = {
  number: '<number:number-style style:name="NAME"><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:number-style>',
  percent: '<number:percentage-style style:name="NAME"><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1"/><number:text>%</number:text></number:percentage-style>',
  currency: '<number:currency-style style:name="NAME"><number:currency-symbol number:language="en" number:country="US">$</number:currency-symbol><number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1" number:grouping="true"/></number:currency-style>',
  date: '<number:date-style style:name="NAME"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/></number:date-style>',
  time: '<number:time-style style:name="NAME"><number:hours number:style="long"/><number:text>:</number:text><number:minutes number:style="long"/><number:text>:</number:text><number:seconds number:style="long"/></number:time-style>',
};
const DATA_FN = {
  number: (v) => fixed(v, 2, 1, true),
  percent: (v) => fixed(v * 100, 2) + '%',
  currency: (v) => (v < 0 ? '-$' : '$') + fixed(Math.abs(v), 2, 1, true),
  date: (v, nd) => { const d = new Date((Math.floor(v + 1e-9) + nd) * 86400000); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`; },
  time: (v) => { const s = Math.round((v - Math.floor(v)) * 86400); return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`; },
};

//  eight hex digits of a string: FNV-1a, the same in every browser
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
