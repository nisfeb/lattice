//  paste.js: what a paste brings into a Writer document (plan, Task 9;
//  spec, Security for the editor view). Pasted HTML, from LibreOffice, a
//  browser page or this editor, goes through ProseMirror's DOMParser with
//  the schema, so no element or attribute the schema does not name gets
//  in: a <script> is dropped, an onclick never read, a javascript: link
//  becomes plain text (schema.js). Plain text becomes paragraphs.
//
//  Here the pasted nodes get this document's styles: a paragraph with no
//  style takes the body style, a heading the document's Heading N, and a
//  list the document's bullet or numbered list style. Nothing pasted keeps
//  a source span or file attributes, so it is written as a new node.
//
//  HTML cannot carry everything a document holds: an opaque node is raw
//  XML, and a table or section has its file attributes. A copy or cut of
//  those is remembered here, by this editor, under a key no page can
//  guess, and the key is all the clipboard gets. A paste that brings the
//  key back to the same document gets the nodes as they were copied. Any
//  other HTML is untrusted: it can become text blocks, lists and line
//  breaks, never an opaque node or a table, whatever it claims to be.
import { DOMSerializer, Fragment, Slice } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import { schema } from './schema.js';
import { decode, escAttr } from './xml.js';
import { listKind, lookup } from './styles.js';
import { bodyStyle, headingStyle } from './keys.js';

const S = schema.nodes;

//  the list style a new list of `kind` takes: LibreOffice's List 1 or
//  Numbering 123 when the document has them, else the first of that kind
export function listStyleFor(st, kind) {
  const pref = kind === 'number' ? 'Numbering_20_123' : 'List_20_1';
  if (st.lists.has(pref) && listKind(st, pref) === kind) return pref;
  for (const name of st.lists.keys()) if (listKind(st, name) === kind) return name;
  return null;
}

//  markers that name themselves (bookmarks, reference marks, change and
//  comment anchors): a pasted copy would be a second one of the same name,
//  or half a pair, so a paste leaves them behind
const NAMED = /^(text:bookmark|text:reference-mark|text:change|office:annotation)/;

const isOpaque = (n) => n.type === S.opaque_block || n.type === S.opaque_inline;
//  the containers a paste from outside is never given: their content is
//  pasted without them
const BARE = new Set([S.table, S.table_row, S.table_cell, S.section]);
const FLAGS = ['pageBreak', 'quote', 'header', 'placeholder'];

//  whether a copy holds what clipboard HTML cannot carry
export function beyondHtml(frag) {
  let yes = false;
  frag.descendants((n) => { if (isOpaque(n) || BARE.has(n.type)) yes = true; return !yes; });
  return yes;
}

//  A slice parsed from clipboard HTML, with nothing but what HTML may
//  make. ProseMirror builds wrapper nodes of any type, with any
//  attributes, from the JSON a page puts in data-pm-slice, so the node
//  types are checked here and the attributes in fixPasted.
export function fromOutside(slice) {
  const strip = (n) => {
    if (n.isText) return [n];
    if (isOpaque(n)) return [];
    const kids = [];
    n.content.forEach((c) => kids.push(...strip(c)));
    if (BARE.has(n.type)) return kids;
    return [n.isLeaf ? n.type.create(null, null, n.marks) : n.copy(Fragment.from(kids))];
  };
  //  how deep a side is still open once the wrappers on it are gone
  const open = (depth, last) => {
    let kept = 0;
    for (let f = slice.content, d = 0; d < depth && f.childCount; d++) {
      const n = last ? f.lastChild : f.firstChild;
      if (n.isLeaf) break;
      if (!BARE.has(n.type)) kept++;
      f = n.content;
    }
    return kept;
  };
  const kids = [];
  slice.content.forEach((c) => kids.push(...strip(c)));
  return new Slice(Fragment.from(kids), open(slice.openStart, false), open(slice.openEnd, true));
}

//  a copy made in this document, pasted back into it: as it was, but for
//  the markers that name themselves
export function ownPasted(frag) {
  const kids = [];
  frag.forEach((c) => {
    if (c.type === S.opaque_inline && NAMED.test(c.attrs.name)) return;
    kids.push(c.isLeaf || c.isText ? c : c.copy(ownPasted(c.content)));
  });
  return Fragment.from(kids);
}

export function fixPasted(node, st) {
  const kids = [];
  node.content.forEach((c) => {
    if (c.type === S.opaque_inline && NAMED.test(c.attrs.name)) return;
    kids.push(fixPasted(c, st));
  });
  const content = node.isLeaf ? null : Fragment.from(kids);
  //  a character style this document does not define would be a dangling
  //  reference in the file
  const marks = node.marks.filter((m) => m.type !== schema.marks.charStyle || lookup(st, 'text', m.attrs.name));
  if (node.isText) return marks.length === node.marks.length ? node : node.mark(marks);
  if (node.type === S.opaque_block || node.type === S.opaque_inline) return node;
  const attrs = { ...node.attrs };
  if ('src' in attrs) attrs.src = null;
  if ('xattrs' in attrs) attrs.xattrs = [];
  //  a flag is a boolean, a style a name and a level 1 to 10, whatever
  //  the clipboard said
  for (const k of FLAGS) if (k in attrs) attrs[k] = attrs[k] === true;
  if ('style' in attrs && typeof attrs.style !== 'string') attrs.style = null;
  if (node.type === S.heading) {
    const lv = Math.trunc(Number(attrs.level));
    attrs.level = lv >= 1 && lv <= 10 ? lv : 1;
  }
  if (node.type === S.paragraph && attrs.style != null && !lookup(st, 'paragraph', attrs.style)) attrs.style = null;
  if (node.type === S.paragraph && attrs.style == null) attrs.style = bodyStyle(st);
  if (node.type === S.heading && (attrs.style == null || !lookup(st, 'paragraph', attrs.style))) attrs.style = headingStyle(st, attrs.level);
  if (node.type === S.list) {
    //  the list style a copy from a Writer document names, if this
    //  document has it, else this document's own of that kind
    const xa = Array.isArray(node.attrs.xattrs) ? node.attrs.xattrs : [];
    const was = xa.find((a) => Array.isArray(a) && a[0] === 'text:style-name' && typeof a[1] === 'string');
    const own = was && decode(was[1]);
    const name = own && st.lists.has(own) ? own : listStyleFor(st, attrs.kind === 'number' ? 'number' : 'bullet');
    attrs.xattrs = name ? [['text:style-name', escAttr(name)]] : [];
    attrs.kind = null;
  }
  return node.type.create(attrs, content, marks);
}

//  the clipboard's HTML, with the key of a remembered copy on its first
//  element
class ClipSerializer extends DOMSerializer {
  constructor(stamp) {
    super(DOMSerializer.nodesFromSchema(schema), DOMSerializer.marksFromSchema(schema));
    this.stamp = stamp;
    this.depth = 0;
  }

  serializeFragment(frag, opts, target) {
    this.depth++;
    let out;
    try { out = super.serializeFragment(frag, opts, target); } finally { this.depth--; }
    if (!this.depth) this.stamp(out);
    return out;
  }
}

const KEY = 'data-lw-clip';
const NOT_KEPT = 'Pasted as plain text: footnotes, fields, pictures and tables are kept only when copied and pasted inside one document.';

export function pastePlugin(ctl, st) {
  //  the last copy that held more than HTML carries, and its key
  let kept = null, copying = null, pasting = null, lost = false, n = 0;
  const nonce = [...crypto.getRandomValues(new Uint32Array(4))].map((x) => x.toString(36)).join('');
  const stamp = (out) => {
    const slice = copying;
    copying = null;
    const el = slice && beyondHtml(slice.content) ? out.firstElementChild : null;
    if (!el) return;
    kept = { key: nonce + '-' + (++n), slice };
    el.setAttribute(KEY, kept.key);
  };
  return new Plugin({
    props: {
      clipboardSerializer: new ClipSerializer(stamp),
      transformCopied(slice) { copying = slice; return slice; },
      transformPastedHTML(html) {
        const m = /\sdata-lw-clip="([a-z0-9-]+)"/.exec(html);
        pasting = m && kept && m[1] === kept.key ? kept.slice : null;
        lost = !!m && !pasting;
        return html;
      },
      //  a drag that moves within this document is a move, not a paste:
      //  its markers, comments and attributes go with it, as they are
      transformPasted(slice, view, plain) {
        const d = view && view.dragging;
        if (d && d.move && d.slice === slice) return slice;
        const own = pasting, say = lost;
        pasting = null; lost = false;
        if (own && !plain) return new Slice(ownPasted(own.content), own.openStart, own.openEnd);
        if (say && !plain && ctl.say) ctl.say(NOT_KEPT);
        //  a copy dragged inside this view is its own nodes, anything else
        //  was parsed from the clipboard
        if (!(d && d.slice === slice)) slice = fromOutside(slice);
        const kids = [];
        slice.content.forEach((c) => {
          if (c.type === S.opaque_inline && NAMED.test(c.attrs.name)) return;
          kids.push(fixPasted(c, st));
        });
        return new Slice(Fragment.from(kids), slice.openStart, slice.openEnd);
      },
    },
  });
}
