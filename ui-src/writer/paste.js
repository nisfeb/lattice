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
import { Fragment, Slice } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import { schema } from './schema.js';
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

export function fixPasted(node, st) {
  const kids = [];
  node.content.forEach((c) => {
    if (c.type === S.opaque_inline && NAMED.test(c.attrs.name)) return;
    kids.push(fixPasted(c, st));
  });
  const content = node.isLeaf ? null : Fragment.from(kids);
  if (node.isText) return node;
  if (node.type === S.opaque_block || node.type === S.opaque_inline) return node;
  const attrs = { ...node.attrs };
  if ('src' in attrs) attrs.src = null;
  if ('xattrs' in attrs) attrs.xattrs = [];
  if (node.type === S.paragraph && attrs.style != null && !lookup(st, 'paragraph', attrs.style)) attrs.style = null;
  if (node.type === S.paragraph && attrs.style == null) attrs.style = bodyStyle(st);
  if (node.type === S.heading && (attrs.style == null || !lookup(st, 'paragraph', attrs.style))) attrs.style = headingStyle(st, attrs.level);
  if (node.type === S.list) {
    const name = listStyleFor(st, attrs.kind || 'bullet');
    attrs.xattrs = name ? [['text:style-name', name]] : [];
    attrs.kind = null;
  }
  return node.type.create(attrs, content, node.marks);
}

export function pastePlugin(ctl, st) {
  return new Plugin({
    props: {
      //  a drag that moves within this document is a move, not a paste:
      //  its markers, comments and attributes go with it, as they are
      transformPasted(slice, view) {
        const d = view && view.dragging;
        if (d && d.move && d.slice === slice) return slice;
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
