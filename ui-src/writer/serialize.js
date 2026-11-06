//  serialize.js: the minimal-diff serializer (spec, The serializer).
//
//  Saving walks the editor document against the original source:
//
//  - a node whose content is unchanged is written by copying its source
//    bytes (its `src` span);
//  - a changed node is written again, its attributes in their source
//    order (`xattrs`) with the ones lattice changed;
//  - a new node is written in LibreOffice's layout, one block element a
//    line, one space of indent a level;
//  - the whitespace between two blocks that were neighbours in the source
//    is copied, so the lines around an edit do not move;
//  - the head is copied, with any new automatic styles inserted just
//    before </office:automatic-styles>, and the tail is copied.
//
//  So an open and save with no edit is byte-identical, and changing one
//  word changes one line.
//
//  Paired markers (bookmarks, reference marks, tracked-change ranges,
//  comment ranges) are checked: a document in which one half of a pair is
//  gone, and was not already gone in the source, is refused, so a bug
//  shows as a refused save, never a corrupt file.
import { decode, escAttr, escText } from './xml.js';
import { schema } from './schema.js';
import { parseFodt } from './parse.js';
import { breaksPage, isAuto, lookup, registry } from './styles.js';

const S = schema.nodes;
const M = schema.marks;

//  the last original parsed, so a serialization per keystroke idle does
//  not parse the source again
let memo = null;
const parsedOf = (x, original) => {
  if (x && x.base && x.base.src === original) return x.base;
  if (memo && memo.src === original) return memo;
  const p = parseFodt(original);
  if (p.error) return p;
  memo = p.base;
  return memo;
};

//  +serializeFodt: { text } or { error }. `x` is an EditorState, the
//  parse result, or anything with a `doc`; `original` the text the
//  document was opened from. `opts.rewrite` writes every node again
//  instead of copying the unchanged ones (the suites check that the
//  writer alone reproduces LibreOffice's layout).
export function serializeFodt(x, original, opts = {}) {
  try {
    const doc = x && x.doc;
    if (!doc || doc.type !== S.doc) return { error: 'no document to save' };
    const o = parsedOf(x, original);
    if (o.error) return { error: 'the original does not parse: ' + o.error };
    const bad = newlyUnbalanced(o, doc);
    if (bad) return { error: 'refused: it would leave ' + bad + ' without its other half' };
    const w = new Writer(o, !!opts.rewrite);
    const body = w.children(doc, o.textEl, w.indentOf(o.textEl.start) + 1, o.textEl.openEnd);
    return { text: w.head() + body + o.tail };
  } catch (e) {
    return { error: 'could not save the document: ' + (e && e.message ? e.message : String(e)) };
  }
}

class Writer {
  constructor(o, rewrite) {
    this.o = o;
    this.rewrite = rewrite;
    this.src = o.src;
    this.st = o.styles;
    this.reg = registry(o.styles);
  }

  indentOf(start) {
    const nl = this.src.lastIndexOf('\n', start - 1);
    const lead = this.src.slice(nl + 1, start);
    return /^ *$/.test(lead) ? lead.length : 0;
  }

  //  the original node this one was made from, if its content is unchanged
  same(n) {
    const s = n.attrs.src;
    if (!s || this.rewrite) return false;
    const orig = this.o.nodes.get(s[0]);
    if (!orig) return false;
    return orig === n || (orig.attrs.src[1] === s[1] && orig.eq(n));
  }

  head() {
    const h = this.o.head;
    const add = this.reg.added.map((a) => a.xml).join('');
    if (!add) return h;
    const st = this.st;
    if (st.autoClose >= 0) {
      const ls = h.lastIndexOf('\n', st.autoClose - 1) + 1;
      const at = /^[ \t]*$/.test(h.slice(ls, st.autoClose)) ? ls : st.autoClose;
      return h.slice(0, at) + (at === ls ? '' : '\n') + add + h.slice(at);
    }
    if (st.autoEmpty) {
      const e = st.autoEmpty;
      return h.slice(0, e.start) + '<office:automatic-styles>\n' + add + ' </office:automatic-styles>' + h.slice(e.end);
    }
    //  no automatic styles at all: before the master styles, else the body
    const m = /\n?[ \t]*<office:(master-styles|body)[\s>]/.exec(h);
    const at = m ? m.index : h.length;
    return h.slice(0, at) + '\n <office:automatic-styles>\n' + add + ' </office:automatic-styles>' + h.slice(at);
  }

  //  the children of a container, each after its separator, then the
  //  whitespace before the container's end tag
  children(parent, cont, indent, prev) {
    const r = this.seq(parent, cont, indent, prev, null);
    return r.out + this.tail(cont.start, r.prev, indent);
  }

  //  `only` filters the children; answers the text and the source end of
  //  the last child written
  seq(parent, cont, indent, prev, only) {
    let out = '';
    parent.forEach((n) => {
      if (only && !only(n)) return;
      if (n.type === S.paragraph && n.attrs.placeholder && n.content.size === 0) return;
      out += this.sep(n.attrs.src, prev, indent) + this.node(n, indent);
      prev = n.attrs.src ? n.attrs.src[1] : -1;
    });
    return { out, prev };
  }

  sep(src, prev, indent) {
    const g = src && this.o.gaps.get(src[0]);
    if (g && g.prevEnd === prev) return g.gap;
    return '\n' + ' '.repeat(indent);
  }

  tail(start, prev, indent) {
    const t = start != null && this.o.tails.get(start);
    if (t && t.prevEnd === prev) return t.gap;
    return '\n' + ' '.repeat(Math.max(0, indent - 1));
  }

  node(n, indent) {
    if (n.type === S.opaque_block || n.type === S.opaque_inline) return n.attrs.raw;
    if (this.same(n)) return this.src.slice(n.attrs.src[0], n.attrs.src[1]);
    const start = n.attrs.src ? n.attrs.src[0] : null;
    switch (n.type) {
      case S.paragraph: case S.heading: return this.textBlock(n);
      case S.list:
        return open('text:list', n.attrs.xattrs) + this.children(n, { start }, indent + 1, openEnd(this.o, n)) + '</text:list>';
      case S.list_item: {
        const tag = n.attrs.header ? 'text:list-header' : 'text:list-item';
        return open(tag, n.attrs.xattrs) + this.children(n, { start }, indent + 1, openEnd(this.o, n)) + `</${tag}>`;
      }
      case S.section:
        return open('text:section', n.attrs.xattrs) + this.children(n, { start }, indent + 1, openEnd(this.o, n)) + '</text:section>';
      case S.table: return this.table(n, indent);
      case S.table_row:
        return open('table:table-row', n.attrs.xattrs) + this.children(n, { start }, indent + 1, openEnd(this.o, n)) + '</table:table-row>';
      case S.table_cell: {
        const xa = n.attrs.src ? n.attrs.xattrs : (n.attrs.xattrs.length ? n.attrs.xattrs : [['office:value-type', 'string']]);
        return open('table:table-cell', xa) + this.children(n, { start }, indent + 1, openEnd(this.o, n)) + '</table:table-cell>';
      }
      default: throw new Error('cannot write a ' + n.type.name + ' here');
    }
  }

  table(n, indent) {
    const start = n.attrs.src ? n.attrs.src[0] : null;
    let out = open('table:table', n.attrs.xattrs);
    let prev;
    if (n.attrs.pre) {
      out += n.attrs.pre.text;
      prev = n.attrs.pre.end;
    } else {
      const w = n.firstChild ? n.firstChild.childCount : 1;
      out += '\n' + ' '.repeat(indent + 1) + (w > 1
        ? `<table:table-column table:number-columns-repeated="${w}"/>` : '<table:table-column/>');
      prev = -1;
    }
    const hasHdr = n.firstChild && n.firstChild.attrs.header;
    if (hasHdr) {
      const h = n.attrs.hdr;
      out += this.sep(h ? [h.start] : null, prev, indent + 1) + (h ? h.tag : '<table:table-header-rows>');
      let hp = h ? h.openEnd : -1;
      let first = true;
      const r = this.seq(n, { start: h ? h.start : null }, indent + 2, hp, (row) => {
        //  the leading run of header rows only
        if (!first) return false;
        if (!row.attrs.header) { first = false; return false; }
        return true;
      });
      hp = r.prev;
      out += r.out + this.tail(h ? h.start : null, hp, indent + 2) + '</table:table-header-rows>';
      prev = h ? h.end : -1;
      if (h && hp !== this.o.tails.get(h.start)?.prevEnd) prev = -1;
    }
    let inHdr = !!hasHdr;
    const r = this.seq(n, { start }, indent + 1, prev, (row) => {
      if (inHdr && row.attrs.header) return false;
      inHdr = false;
      return true;
    });
    return out + r.out + this.tail(start, r.prev, indent + 1) + '</table:table>';
  }

  // -------------------------------------------------------------- blocks
  textBlock(n) {
    const tag = n.type === S.heading ? 'text:h' : 'text:p';
    const xa = n.attrs.xattrs.filter(([k]) => tag === 'text:h' || k !== 'text:outline-level');
    let style = n.attrs.style;
    if (style != null && n.attrs.pageBreak !== breaksPage(this.st, style)) style = this.breakStyle(style, n.attrs.pageBreak);
    else if (style == null && n.attrs.pageBreak) style = this.breakStyle(null, true);
    setAttr(xa, 'text:style-name', style, 0);
    if (tag === 'text:h') setAttr(xa, 'text:outline-level', String(n.attrs.level), 1);
    const body = this.inline(n);
    if (!body) return open(tag, xa, true);
    return open(tag, xa) + body + `</${tag}>`;
  }

  //  an automatic paragraph style that adds or removes a page break
  //  before, on top of what `style` gives
  breakStyle(style, on) {
    const base = lookup(this.st, 'paragraph', style);
    const auto = base && isAuto(this.st, 'paragraph', style);
    const parent = auto ? base.parent : style;
    const props = {};
    if (auto) for (const [k, v] of Object.entries(base.props)) props[k] = { ...v };
    const pp = { ...(props['style:paragraph-properties'] || {}) };
    if (on) pp['fo:break-before'] = 'page';
    else if (parent != null && breaksPage(this.st, parent)) pp['fo:break-before'] = 'auto';
    else delete pp['fo:break-before'];
    props['style:paragraph-properties'] = pp;
    const extra = auto ? base.extra : [];
    if (!Object.values(props).some((p) => Object.keys(p).length) && !extra.length && parent != null) return parent;
    return this.reg.ensure({ family: 'paragraph', parent, extra, props, opaque: auto ? base.opaque : '' }, null);
  }

  // -------------------------------------------------------------- inline
  inline(n) {
    let out = '';
    const ws = { prevSpace: false, atStart: true };
    let link = null;  // the open link mark
    let span = null;  // the open span's start tag
    const closeSpan = () => { if (span) { out += '</text:span>'; span = null; } };
    const closeLink = () => { closeSpan(); if (link) { out += '</text:a>'; link = null; } };
    n.forEach((c) => {
      const lm = c.marks.find((m) => m.type === M.link) || null;
      if (!(lm === link || (lm && link && lm.eq(link)))) {
        closeLink();
        if (lm) { out += linkTag(lm); link = lm; }
      }
      const st = this.spanTag(c.marks);
      if (st !== span) {
        closeSpan();
        if (st) { out += st; span = st; }
      }
      if (c.isText) out += text(c.text, ws);
      else if (c.type === S.hard_break) { out += '<text:line-break/>'; ws.prevSpace = false; ws.atStart = false; }
      //  an inline element leaves the white space state alone, as
      //  LibreOffice writes it: a space after a field that follows a space
      //  is text:s. Reading keeps it either way
      else out += c.attrs.raw;
    });
    closeLink();
    return out;
  }

  //  the span start tag for a set of marks, or null for none
  spanTag(marks) {
    const cs = marks.find((m) => m.type === M.charStyle);
    const ss = marks.find((m) => m.type === M.spanStyle);
    const tp = {};
    let fmt = false;
    for (const m of marks) {
      if (m.type === M.strong || m.type === M.em || m.type === M.underline || m.type === M.strike) {
        fmt = true;
        for (const [k, v] of m.attrs.props) tp[k] = v;
      }
    }
    if (ss) for (const [k, v] of ss.attrs.rest) if (!(k in tp)) tp[k] = v;
    const other = ss ? ss.attrs.other : {};
    const extra = ss ? ss.attrs.extra : [];
    const plain = !fmt && !(ss && ss.attrs.rest.length) && !Object.keys(other).length && !extra.length && !(ss && ss.attrs.opaque);
    let name = null;
    if (ss && ss.attrs.unknown && !fmt && !cs) name = ss.attrs.name;
    else if (plain && cs) {
      //  a named character style, or the automatic style it came from
      //  when that holds nothing more
      const h = ss && ss.attrs.name && lookup(this.st, 'text', ss.attrs.name);
      name = h && h.auto && h.parent === cs.attrs.name && !Object.keys(h.props).length && !h.extra.length ? ss.attrs.name : cs.attrs.name;
    } else if (!plain) {
      name = this.reg.ensure({
        family: 'text', parent: cs ? cs.attrs.name : null, extra,
        props: { ...other, 'style:text-properties': tp }, opaque: ss ? ss.attrs.opaque : '',
      }, ss ? ss.attrs.name : null);
    }
    const xa = ss ? ss.attrs.xattrs.slice() : [];
    if (name == null && !xa.length) return null;
    if (name != null) xa.unshift(['text:style-name', escAttr(name)]);
    return open('text:span', xa);
  }
}

//  the end of a node's start tag in the source, the recorded
//  predecessor of its first child
const openEnd = (o, n) => (n.attrs.src ? o.opens.get(n.attrs.src[0]) ?? -1 : -1);

function open(tag, xa, empty = false) {
  return '<' + tag + xa.map(([k, v]) => ` ${k}="${v}"`).join('') + (empty ? '/>' : '>');
}

//  set an attribute (raw value escaped here), keeping its place, or add it
//  at `at`; null removes it
function setAttr(xa, name, value, at) {
  const i = xa.findIndex(([k]) => k === name);
  if (value == null) { if (i >= 0) xa.splice(i, 1); return; }
  const raw = escAttr(value);
  if (i >= 0) {
    if (decode(xa[i][1]) !== value) xa[i] = [name, raw];
  } else xa.splice(Math.min(at, xa.length), 0, [name, raw]);
}

function linkTag(m) {
  const xa = m.attrs.xattrs.slice();
  const i = xa.findIndex(([k]) => k === 'xlink:href');
  if (i < 0) {
    if (!xa.some(([k]) => k === 'xlink:type')) xa.push(['xlink:type', 'simple']);
    xa.push(['xlink:href', escAttr(m.attrs.href)]);
  } else if (decode(xa[i][1]) !== m.attrs.href) xa[i] = ['xlink:href', escAttr(m.attrs.href)];
  return open('text:a', xa);
}

//  text in ODF's white space rules: the first space of a run is literal
//  unless it starts the paragraph or follows a space, the rest are
//  text:s; tabs are text:tab and newlines (and Word's vertical tab, its
//  manual line break) text:line-break. As LibreOffice
//  writes it, a space right after a tab or a line break is literal
function text(t, ws) {
  let out = '';
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === ' ') {
      let j = i;
      while (j < t.length && t[j] === ' ') j++;
      let n = j - i;
      if (!(ws.atStart || ws.prevSpace)) { out += ' '; n--; }
      if (n === 1) out += '<text:s/>';
      else if (n > 1) out += `<text:s text:c="${n}"/>`;
      ws.prevSpace = true; ws.atStart = false;
      i = j;
    } else if (c === '\t') {
      out += '<text:tab/>'; ws.prevSpace = false; ws.atStart = false; i++;
    } else if (c === '\n' || c === '\r' || c === '\v') {
      out += '<text:line-break/>'; ws.prevSpace = false; ws.atStart = false; i++;
    } else {
      let j = i;
      while (j < t.length && t[j] !== ' ' && t[j] !== '\t' && t[j] !== '\n' && t[j] !== '\r' && t[j] !== '\v') j++;
      out += escText(t.slice(i, j));
      ws.prevSpace = false; ws.atStart = false;
      i = j;
    }
  }
  return out;
}

// ---------------------------------------------------------------- pairs
const PAIR = /<(text:bookmark-start|text:bookmark-end|text:reference-mark-start|text:reference-mark-end|text:change-start|text:change-end|office:annotation-end|office:annotation)(?=[\s>/])([^>]*)>/g;
const NAME = { 'text:change-start': 'text:change-id', 'text:change-end': 'text:change-id', 'office:annotation': 'office:name', 'office:annotation-end': 'office:name' };

//  the paired markers of a document that are missing their other half
export function unbalanced(doc) {
  const count = new Map();
  doc.descendants((n) => {
    if (n.type !== S.opaque_inline && n.type !== S.opaque_block) return true;
    for (const m of n.attrs.raw.matchAll(PAIR)) {
      const el = m[1];
      const an = NAME[el] || 'text:name';
      const v = new RegExp(`\\s${an}="([^"]*)"`).exec(m[2]);
      if (!v) continue;
      const kind = el.replace(/-(start|end)$/, '');
      const k = kind + ' "' + decode(v[1]) + '"';
      count.set(k, (count.get(k) || 0) + (el.endsWith('-end') ? -1 : 1));
    }
    return false;
  });
  return new Set([...count].filter(([, c]) => c !== 0).map(([k]) => k));
}

function newlyUnbalanced(o, after) {
  const was = o.unbalanced || (o.unbalanced = unbalanced(o.doc));
  for (const k of unbalanced(after)) if (!was.has(k)) return k.replace(/^text:|^office:/, '');
  return null;
}

//  a ProseMirror filterTransaction for the editor: refuses a step that
//  leaves one half of a pair (spec, Paired markers)
export function pairGuard(tr, state) {
  if (!tr.docChanged) return true;
  const was = unbalanced(state.doc);
  for (const k of unbalanced(tr.doc)) if (!was.has(k)) return false;
  return true;
}
