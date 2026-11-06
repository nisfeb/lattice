//  parse.js: flat ODT text to a ProseMirror document (spec, Mapping to
//  the editor model).
//
//  The file is split in three: the head (everything up to and including
//  the <office:text> start tag), kept raw and read for styles; the body
//  (the children of office:text), which becomes the document; and the
//  tail (</office:text> to the end), kept raw.
//
//  Every node made from an element keeps its span (`src`) and its raw
//  attributes (`xattrs`). The whitespace between block elements is kept
//  beside the document, keyed by the span of the element after it, so a
//  serialization of an untouched neighbourhood writes it back as it was.
import { attr, child, decode, elements, parseXml, textOf } from './xml.js';
import { schema, ZERO_WIDTH } from './schema.js';
import { breaksPage, byName, isQuote, layout as pageLayout, lookup, readStyles } from './styles.js';

const S = schema.nodes;
const M = schema.marks;

//  +parseFodt: { doc, head, tail, styles, layout, tracking, opaque, ... }
//  or { error }. Never throws.
export function parseFodt(text) {
  try {
    return parseOrError(text);
  } catch (e) {
    return { error: 'could not open the document: ' + (e && e.message ? e.message : String(e)) };
  }
}

function parseOrError(text) {
  const x = parseXml(text);
  if (x.error) return { error: x.error };
  const doc = elements(x.root).find((e) => e.name === 'office:document');
  if (!doc) return { error: 'not a flat ODT document (no office:document)' };
  const body = child(doc, 'office:body');
  const otext = body && child(body, 'office:text');
  if (!otext || otext.empty) return { error: 'not a text document (no office:text)' };
  const st = readStyles(text, doc);
  const p = new Parser(text, st);
  let blocks = p.blocks(otext);
  if (!blocks.length) blocks = [S.paragraph.create({ placeholder: true })];
  const pmDoc = S.doc.create(null, blocks);
  const tc = otext.kids.find((k) => k.name === 'text:tracked-changes');
  const head = text.slice(0, otext.openEnd);
  const tail = text.slice(otext.closeStart);
  return {
    doc: pmDoc,
    head,
    tail,
    styles: st,
    layout: pageLayout(st),
    tracking: !!tc && attr(tc, 'text:track-changes') !== 'false',
    macros: hasMacros(child(doc, 'office:scripts')),
    opaque: p.opaque,
    //  what the serializer needs of the original, kept together so an
    //  edited copy of this object still carries the original document
    base: {
      src: text, doc: pmDoc, head, tail, styles: st,
      textEl: { start: otext.start, openEnd: otext.openEnd, closeStart: otext.closeStart },
      nodes: p.nodes, gaps: p.gaps, tails: p.tails, opens: p.opens,
    },
  };
}

const ws = (s) => /^[ \t\r\n]*$/.test(s);

//  the spaces text:s may spell out in one document: a 25-byte element
//  says up to 100000, so a small hostile file would otherwise open as
//  hundreds of millions of characters in the editor
export const SPACES = 1000000;

//  whether office:scripts holds a macro: a library, a module or an event
//  listener. LibreOffice writes an empty Basic libraries element in every
//  document, which is none
function hasMacros(el) {
  if (!el) return false;
  let found = false;
  const walk = (e) => {
    for (const k of elements(e)) {
      if (/^(ooo:library-|ooo:module|script:event-listener|office:event-listener|presentation:event-listener)/.test(k.name)) found = true;
      else walk(k);
      if (found) return;
    }
  };
  walk(el);
  return found;
}
//  a node's source span and its attributes as written, copied
const rawAttrs = (e) => e.attrs.map((a) => [a[0], a[1]]);
const spanOf = (e) => ({ src: [e.start, e.end], xattrs: rawAttrs(e) });

class Parser {
  constructor(src, st) {
    this.src = src;
    this.st = st;
    this.opaque = [];
    this.nodes = new Map(); // start -> the node made from that element
    this.gaps = new Map();  // start -> { gap, prevEnd }
    this.tails = new Map(); // container start -> { gap, prevEnd }
    this.opens = new Map(); // container start -> the end of its start tag
    this.spaces = 0;        // what text:s has spelled out so far
  }

  raw(el) { return this.src.slice(el.start, el.end); }

  //  the blocks of a container element, with the whitespace around them
  blocks(el) {
    this.opens.set(el.start, el.openEnd);
    const out = [];
    let prevEnd = el.openEnd;
    for (const k of el.kids) {
      if (!k.name) continue;
      const n = this.block(k);
      this.gaps.set(k.start, { gap: this.src.slice(prevEnd, k.start), prevEnd });
      out.push(n);
      prevEnd = k.end;
    }
    this.tails.set(el.start, { gap: this.src.slice(prevEnd, el.closeStart), prevEnd });
    return out;
  }

  //  text other than whitespace directly in a block container cannot be
  //  edited safely: the container is opaque then
  mixed(el) {
    return el.kids.some((k) => (k.text && !ws(this.src.slice(k.start, k.end))) || k.pi || k.comment);
  }

  keep(n, el) { this.nodes.set(el.start, n); return n; }

  opaqueBlock(el) {
    const raw = this.raw(el);
    this.opaque.push(raw);
    return this.keep(S.opaque_block.create({ src: [el.start, el.end], raw, name: el.name, label: label(this.src, el) }), el);
  }

  block(el) {
    switch (el.name) {
      case 'text:p': case 'text:h': return this.textBlock(el);
      case 'text:list': return this.list(el) || this.opaqueBlock(el);
      case 'table:table': return this.table(el) || this.opaqueBlock(el);
      case 'text:section': return this.section(el) || this.opaqueBlock(el);
      default: return this.opaqueBlock(el);
    }
  }

  textBlock(el) {
    const style = attr(el, 'text:style-name') ?? null;
    const at = {
      ...spanOf(el), style,
      pageBreak: style != null && breaksPage(this.st, style),
      quote: style != null && isQuote(this.st, style),
    };
    const content = this.inline(el);
    if (el.name === 'text:h') {
      const lv = parseInt(attr(el, 'text:outline-level') ?? '1', 10);
      return this.keep(S.heading.create({ ...at, level: lv > 0 ? lv : 1 }, content), el);
    }
    return this.keep(S.paragraph.create(at, content), el);
  }

  list(el) {
    if (this.mixed(el)) return null;
    this.opens.set(el.start, el.openEnd);
    const items = [];
    let prevEnd = el.openEnd;
    for (const k of el.kids) {
      if (!k.name) continue;
      if (k.name !== 'text:list-item' && k.name !== 'text:list-header') return null;
      if (this.mixed(k)) return null;
      const kids = this.blocks(k);
      if (!kids.length) return null;
      this.gaps.set(k.start, { gap: this.src.slice(prevEnd, k.start), prevEnd });
      items.push(this.keep(S.list_item.create(
        { ...spanOf(k), header: k.name === 'text:list-header' }, kids), k));
      prevEnd = k.end;
    }
    if (!items.length) return null;
    this.tails.set(el.start, { gap: this.src.slice(prevEnd, el.closeStart), prevEnd });
    return this.keep(S.list.create(spanOf(el), items), el);
  }

  section(el) {
    if (this.mixed(el)) return null;
    //  a linked section's content is a cache of another file: opaque
    if (el.kids.some((k) => k.name === 'text:section-source' || k.name === 'office:dde-source')) return null;
    const kids = this.blocks(el);
    if (!kids.length) return null;
    return this.keep(S.section.create(spanOf(el), kids), el);
  }

  //  a simple table: columns, an optional header-rows group, rows of
  //  cells. Anything else (merges, repeats, nested row groups, covered
  //  cells) and it opens as one opaque block (spec, phase 1)
  table(el) {
    if (this.mixed(el)) return null;
    const ks = elements(el);
    let i = 0;
    while (i < ks.length && ks[i].name === 'table:table-column') i++;
    const preEnd = i ? ks[i - 1].end : el.openEnd;
    let hdr = null;
    const rows = [];
    let prevEnd = preEnd;
    const row = (r, header, prev) => {
      if (r.name !== 'table:table-row' || this.mixed(r)) return null;
      if (attr(r, 'table:number-rows-repeated') != null) return null;
      this.opens.set(r.start, r.openEnd);
      const cells = [];
      let pe = r.openEnd;
      for (const c of r.kids) {
        if (!c.name) continue;
        if (c.name !== 'table:table-cell' || this.mixed(c)) return null;
        if (['table:number-columns-spanned', 'table:number-rows-spanned', 'table:number-columns-repeated']
          .some((a) => attr(c, a) != null)) return null;
        const kids = this.blocks(c);
        if (!kids.length) return null;
        this.gaps.set(c.start, { gap: this.src.slice(pe, c.start), prevEnd: pe });
        cells.push(this.keep(S.table_cell.create(spanOf(c), kids), c));
        pe = c.end;
      }
      if (!cells.length) return null;
      this.tails.set(r.start, { gap: this.src.slice(pe, r.closeStart), prevEnd: pe });
      this.gaps.set(r.start, { gap: this.src.slice(prev, r.start), prevEnd: prev });
      return this.keep(S.table_row.create({ ...spanOf(r), header }, cells), r);
    };
    for (; i < ks.length; i++) {
      const k = ks[i];
      if (k.name === 'table:table-header-rows') {
        if (hdr || rows.length || this.mixed(k)) return null;
        let pe = k.openEnd;
        for (const r of elements(k)) {
          const n = row(r, true, pe);
          if (!n) return null;
          rows.push(n);
          pe = r.end;
        }
        if (!rows.length) return null;
        this.tails.set(k.start, { gap: this.src.slice(pe, k.closeStart), prevEnd: pe });
        this.gaps.set(k.start, { gap: this.src.slice(prevEnd, k.start), prevEnd });
        hdr = { start: k.start, end: k.end, openEnd: k.openEnd, tag: this.src.slice(k.start, k.openEnd) };
        prevEnd = k.end;
        continue;
      }
      const n = row(k, false, prevEnd);
      if (!n) return null;
      rows.push(n);
      prevEnd = k.end;
    }
    if (!rows.length) return null;
    this.tails.set(el.start, { gap: this.src.slice(prevEnd, el.closeStart), prevEnd });
    const width = rows[0].childCount;
    if (rows.some((r) => r.childCount !== width)) return null;
    return this.keep(S.table.create({
      ...spanOf(el),
      pre: { text: this.src.slice(el.openEnd, preEnd), end: preEnd }, hdr,
    }, rows), el);
  }

  // -------------------------------------------------------------- inline
  inline(el) {
    const out = [];
    const ctx = { prevSpace: false, atStart: true };
    this.inlineInto(el, [], out, ctx);
    return out;
  }

  inlineInto(el, marks, out, ctx) {
    for (const k of el.kids) {
      if (k.text) {
        let t = k.cdata ? this.src.slice(k.start + 9, k.end - 3) : decode(this.src.slice(k.start, k.end));
        //  ODF white space: tabs and newlines are spaces, runs collapse to
        //  one, and leading white space in a paragraph is dropped
        t = t.replace(/[\t\r\n ]+/g, ' ');
        if (t[0] === ' ' && (ctx.prevSpace || ctx.atStart)) t = t.slice(1);
        if (!t) continue;
        ctx.prevSpace = t[t.length - 1] === ' ';
        ctx.atStart = false;
        out.push(schema.text(t, marks));
        continue;
      }
      if (!k.name) {
        //  a comment or processing instruction inside a paragraph: kept
        const raw = this.src.slice(k.start, k.end);
        this.opaque.push(raw);
        out.push(S.opaque_inline.create({ src: [k.start, k.end], raw, name: '#', label: '' }, null, marks));
        continue;
      }
      const plain = k.attrs.length === 0;
      if (k.name === 'text:s' && (plain || (k.attrs.length === 1 && k.attrs[0][0] === 'text:c'))) {
        const c = Math.min(Math.max(parseInt(attr(k, 'text:c') ?? '1', 10) || 1, 1), 100000);
        if ((this.spaces += c) > SPACES) throw new Error('it spells out more than a million spaces');
        out.push(schema.text(' '.repeat(c), marks));
        //  LibreOffice keeps a literal space after text:s, text:tab and
        //  text:line-break: they end a collapsing run
        ctx.prevSpace = false; ctx.atStart = false;
      } else if (k.name === 'text:tab' && plain) {
        out.push(schema.text('\t', marks));
        ctx.prevSpace = false; ctx.atStart = false;
      } else if (k.name === 'text:line-break' && plain) {
        out.push(S.hard_break.create({ src: [k.start, k.end] }, null, marks));
        ctx.prevSpace = false; ctx.atStart = false;
      } else if (k.name === 'text:span' && !this.mixedBlock(k)) {
        this.inlineInto(k, this.spanMarks(k, marks), out, ctx);
      } else if (k.name === 'text:a' && !this.mixedBlock(k)) {
        const link = M.link.create({ href: attr(k, 'xlink:href') ?? '', xattrs: rawAttrs(k) });
        this.inlineInto(k, link.addToSet(marks), out, ctx);
      } else {
        const raw = this.raw(k);
        this.opaque.push(raw);
        out.push(S.opaque_inline.create({ src: [k.start, k.end], raw, name: k.name, label: label(this.src, k) }, null, marks));
        if (!ZERO_WIDTH.test(k.name)) { ctx.prevSpace = false; ctx.atStart = false; }
      }
    }
  }

  //  a span or link holding a paragraph or other block (not ODF, but a
  //  hostile file can) is carried whole
  mixedBlock(el) {
    return el.kids.some((k) => k.name === 'text:p' || k.name === 'text:h' || k.name === 'text:list');
  }

  //  the marks of a text:span inside `outer`
  spanMarks(el, outer) {
    const name = attr(el, 'text:style-name');
    const xattrs = el.attrs.filter((a) => a[0] !== 'text:style-name').map((a) => [a[0], a[1]]);
    const outerSpan = outer.find((m) => m.type === M.spanStyle);
    let marks = outer;
    const s = name == null ? undefined : lookup(this.st, 'text', name);
    if (!s) {
      //  no style, or one the document does not define: kept by name
      return M.spanStyle.create({ name: name ?? null, rest: [], xattrs, unknown: true }).addToSet(marks);
    }
    if (!s.auto) {
      marks = M.charStyle.create({ name: s.name }).addToSet(marks);
      if (xattrs.length || outerSpan) {
        marks = M.spanStyle.create({ name: null, rest: outerSpan ? outerSpan.attrs.rest : [], xattrs }).addToSet(marks);
      }
      return marks;
    }
    if (s.parent) marks = M.charStyle.create({ name: s.parent }).addToSet(marks);
    const tp = s.props['style:text-properties'] || {};
    const rest = new Map(outerSpan ? outerSpan.attrs.rest : []);
    const group = { strong: [], em: [], underline: [], strike: [] };
    const on = {
      strong: /^(bold|[6-9]00)$/.test(tp['fo:font-weight'] ?? ''),
      em: /^(italic|oblique)$/.test(tp['fo:font-style'] ?? ''),
      underline: (tp['style:text-underline-style'] ?? 'none') !== 'none',
      strike: (tp['style:text-line-through-style'] ?? 'none') !== 'none',
    };
    for (const [k, v] of Object.entries(tp)) {
      const g = /font-weight/.test(k) ? 'strong' : /font-style/.test(k) ? 'em'
        : k.startsWith('style:text-underline-') ? 'underline' : k.startsWith('style:text-line-through-') ? 'strike' : null;
      if (g && on[g]) group[g].push([k, v]);
      else rest.set(k, v);
    }
    for (const g of Object.keys(group)) {
      const t = M[g];
      if (on[g]) marks = t.create({ props: group[g].sort(byName) }).addToSet(marks);
      //  an inner span that turns a mark off (fo:font-weight="normal")
      else if (Object.keys(tp).some((k) => (g === 'strong' ? /font-weight/ : g === 'em' ? /font-style/
        : g === 'underline' ? /^style:text-underline-/ : /^style:text-line-through-/).test(k))) marks = t.removeFromSet(marks);
    }
    const other = {};
    for (const [k, v] of Object.entries(s.props)) if (k !== 'style:text-properties') other[k] = v;
    return M.spanStyle.create({
      name: s.name, rest: [...rest].sort(byName), xattrs,
      extra: s.extra, other, opaque: s.opaque,
    }).addToSet(marks);
  }
}

//  what an opaque node shows: a field's current value, a note's marker,
//  the text of a block; nothing for markers, comments and drawings
function label(src, el) {
  const n = el.name;
  if (n === 'text:note') {
    const c = child(el, 'text:note-citation');
    return c ? textOf(src, c) : '';
  }
  if (/^(office:annotation|text:bookmark|text:reference-mark|text:change|text:soft-page-break|draw:|office:)/.test(n)) return '';
  if (n === 'text:tracked-changes' || n === 'text:sequence-decls' || n === 'text:user-field-decls'
    || n === 'text:variable-decls' || n === 'text:dde-connection-decls') return '';
  const t = textOf(src, el).replace(/\s+/g, ' ').trim();
  return t.length > 4000 ? t.slice(0, 4000) + '…' : t;
}

// ---------------------------------------------------------------- extractors
//  These take the body text and never throw: a document that cannot be
//  parsed gives an empty answer.

//  +fodtText: the words of the document, for search and the outline
export function fodtText(text) {
  const x = parseXml(String(text ?? ''));
  if (x.error) return '';
  const doc = elements(x.root).find((e) => e.name === 'office:document');
  const body = doc && child(doc, 'office:body');
  const otext = body && child(body, 'office:text');
  if (!otext) return '';
  let out = '';
  let spaces = 0;
  const walk = (el) => {
    for (const k of el.kids) {
      if (k.text) { out += decode(text.slice(k.start, k.end)).replace(/[\t\r\n ]+/g, ' '); continue; }
      if (!k.name) continue;
      if (k.name === 'text:tracked-changes' || k.name === 'office:annotation' || k.name === 'text:sequence-decls') continue;
      if (k.name === 'text:s') {
        const c = Math.min(parseInt(attr(k, 'text:c') ?? '1', 10) || 1, 1000, SPACES - spaces);
        if (c > 0) { out += ' '.repeat(c); spaces += c; }
        continue;
      }
      if (k.name === 'text:tab') { out += '\t'; continue; }
      if (k.name === 'text:line-break') { out += '\n'; continue; }
      const blk = k.name === 'text:p' || k.name === 'text:h';
      walk(k);
      if (blk) out += '\n';
    }
  };
  walk(otext);
  //  the spaces around each line break go. Not / *\n */, which backtracks
  //  over a long run of spaces with no break after it: quadratic, minutes
  //  on a few KB of text:s
  return out.split('\n').map(trimSpaces).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const trimSpaces = (l) => {
  let a = 0, b = l.length;
  while (a < b && l.charCodeAt(a) === 32) a++;
  while (b > a && l.charCodeAt(b - 1) === 32) b--;
  return l.slice(a, b);
};

//  +fodtOutline: the headings, with their position in the document
export function fodtOutline(text) {
  const p = parseFodt(text);
  if (p.error) return [];
  const out = [];
  p.doc.descendants((n, pos) => {
    if (n.type === S.heading) out.push({ level: n.attrs.level, text: n.textContent, pos });
    return n.type !== S.heading && n.type !== S.paragraph;
  });
  return out;
}

//  +fodtLinks: every link target (text:a), decoded
export function fodtLinks(text) {
  const x = parseXml(String(text ?? ''));
  if (x.error) return [];
  const out = [];
  const walk = (el) => {
    for (const k of el.kids) {
      if (!k.name) continue;
      if (k.name === 'text:a') { const h = attr(k, 'xlink:href'); if (h != null) out.push(h); }
      walk(k);
    }
  };
  walk(x.root);
  return out;
}
