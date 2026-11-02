//  schema.js: the ProseMirror schema for a Writer document, from the
//  spec's mapping table (Mapping to the editor model).
//
//  Every node that came from the file carries `src`, its span in the
//  source ([start, end], or null when lattice made it), and `xattrs`, its
//  attributes in source order as [name, raw] pairs, so attributes lattice
//  does not know ride along. The serializer copies a node whose content
//  is unchanged byte for byte from `src`.
//
//  Anything the table does not name is opaque: an opaque_block or an
//  opaque_inline atom carrying the element's raw XML, moved or deleted
//  whole and never edited inside.
import { Schema } from 'prosemirror-model';

const base = { src: { default: null }, xattrs: { default: [] } };
const textBlock = (tag, extra = {}) => ({
  attrs: { ...base, style: { default: null }, pageBreak: { default: false }, quote: { default: false }, ...extra },
  content: 'inline*',
  group: 'block',
  defining: true,
});

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      ...textBlock('text:p', { placeholder: { default: false } }),
      parseDOM: [{ tag: 'p' }],
      toDOM: (n) => ['p', n.attrs.quote ? { class: 'fodt-quote' } : {}, 0],
    },
    heading: {
      ...textBlock('text:h', { level: { default: 1 } }),
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: 'h' + level, attrs: { level } })),
      toDOM: (n) => ['h' + Math.min(6, Math.max(1, n.attrs.level)), 0],
    },
    list: {
      attrs: { ...base },
      content: 'list_item+',
      group: 'block',
      toDOM: () => ['ul', 0],
    },
    list_item: {
      attrs: { ...base, header: { default: false } },
      content: 'block+',
      defining: true,
      toDOM: () => ['li', 0],
    },
    table: {
      //  `pre` is the raw XML between the start tag and the first row (the
      //  column declarations), `hdr` the raw start tag of
      //  table:table-header-rows when the table has one
      attrs: { ...base, pre: { default: null }, hdr: { default: null } },
      content: 'table_row+',
      group: 'block',
      isolating: true,
      tableRole: 'table',
      toDOM: () => ['table', ['tbody', 0]],
    },
    table_row: {
      attrs: { ...base, header: { default: false } },
      content: 'table_cell+',
      tableRole: 'row',
      toDOM: () => ['tr', 0],
    },
    table_cell: {
      attrs: { ...base, colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } },
      content: 'block+',
      isolating: true,
      tableRole: 'cell',
      toDOM: () => ['td', 0],
    },
    section: {
      attrs: { ...base },
      content: 'block+',
      group: 'block',
      toDOM: () => ['div', { class: 'fodt-sec' }, 0],
    },
    opaque_block: {
      attrs: { src: { default: null }, raw: { default: '' }, name: { default: '' }, label: { default: '' } },
      group: 'block',
      atom: true,
      selectable: true,
      toDOM: (n) => ['div', { class: 'fodt-op', 'data-el': n.attrs.name }, n.attrs.label],
    },
    text: { group: 'inline' },
    hard_break: {
      attrs: { src: { default: null } },
      inline: true,
      group: 'inline',
      selectable: false,
      toDOM: () => ['br'],
    },
    opaque_inline: {
      attrs: { src: { default: null }, raw: { default: '' }, name: { default: '' }, label: { default: '' } },
      inline: true,
      group: 'inline',
      atom: true,
      leafText: (n) => n.attrs.label,
      toDOM: (n) => ['span', { class: 'fodt-opi', 'data-el': n.attrs.name }, n.attrs.label],
    },
  },
  //  the order is the nesting order in the file: a link wraps a span
  marks: {
    //  text:a. `xattrs` keeps every attribute; `href` is the decoded
    //  xlink:href, which the serializer writes back when it changes
    link: {
      attrs: { href: { default: '' }, xattrs: { default: [] } },
      inclusive: false,
      toDOM: (m) => ['a', { 'data-href': m.attrs.href }, 0],
    },
    //  a named text style (office:styles)
    charStyle: {
      attrs: { name: {} },
      toDOM: (m) => ['span', { 'data-style': m.attrs.name }, 0],
    },
    //  what a span's automatic style holds beyond the four marks below:
    //  `name` the style it came from (reused while the formatting matches),
    //  `rest` its other text properties as sorted [name, value] pairs,
    //  `xattrs` the span's attributes other than text:style-name
    spanStyle: {
      //  `extra`, `other` and `opaque` carry the rest of the automatic
      //  style (its other attributes and properties elements) and
      //  `unknown` marks a style the document does not define
      attrs: {
        name: { default: null }, rest: { default: [] }, xattrs: { default: [] },
        extra: { default: [] }, other: { default: {} }, opaque: { default: '' }, unknown: { default: false },
      },
      toDOM: () => ['span', 0],
    },
    //  each keeps the property group it came from, so a double or wave
    //  underline, or a bold that also sets the Asian and complex weights,
    //  is written back as it was
    strong: { attrs: { props: { default: [['fo:font-weight', 'bold']] } }, toDOM: () => ['strong', 0] },
    em: { attrs: { props: { default: [['fo:font-style', 'italic']] } }, toDOM: () => ['em', 0] },
    underline: {
      attrs: { props: { default: [['style:text-underline-color', 'font-color'], ['style:text-underline-style', 'solid'], ['style:text-underline-width', 'auto']] } },
      toDOM: () => ['u', 0],
    },
    strike: {
      attrs: { props: { default: [['style:text-line-through-style', 'solid'], ['style:text-line-through-type', 'single']] } },
      toDOM: () => ['s', 0],
    },
  },
});

//  the elements every mark owns in a text style's properties
export const MARK_PROPS = {
  strong: (k) => /^(fo|style):font-weight(-asian|-complex)?$/.test(k),
  em: (k) => /^(fo|style):font-style(-asian|-complex)?$/.test(k),
  underline: (k) => k.startsWith('style:text-underline-'),
  strike: (k) => k.startsWith('style:text-line-through-'),
};

//  whether an inline element ends a run of white space, as LibreOffice
//  reads it: anything that puts a character or object in the text does,
//  a zero-width marker (bookmark, reference mark, change mark, index
//  mark, comment end, soft page break) does not
export const ZERO_WIDTH = /^(text:bookmark|text:reference-mark|text:change|text:toc-mark|text:alphabetical-index-mark|text:user-index-mark|text:soft-page-break|office:annotation-end|#)/;
