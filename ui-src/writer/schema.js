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
import { css } from './styles.js';

//  the DOM of a text block: its style by name (the view's style sheet
//  matches on it), a page break and a quote as classes. Paste and copy
//  read the style back, never `src` or `xattrs`
const blockDom = (tag, n) => {
  const a = {};
  if (n.attrs.style != null) a['data-ps'] = n.attrs.style;
  const cls = [n.attrs.pageBreak && 'lw-pb', n.attrs.quote && 'fodt-quote'].filter(Boolean).join(' ');
  if (cls) a.class = cls;
  return [tag, a, 0];
};
const blockAttrs = (el) => ({
  style: el.getAttribute('data-ps') || null,
  quote: el.classList.contains('fodt-quote'),
  pageBreak: el.classList.contains('lw-pb'),
});
//  link targets a pasted link may keep: the schemes the reader makes live
export const SAFE_HREF = /^(https?:|mailto:|urb:|#|[^:]*$)/i;
export const safeHref = (h) => SAFE_HREF.test(String(h ?? '').replace(/[\u0000-\u0020\u007f]+/g, ''));
const NOFONTS = { fonts: new Map() };
//  the parse rules for a text-decoration line in a pasted element's style
const deco = (line) => ['text-decoration', 'text-decoration-line']
  .map((style) => ({ style, getAttrs: (v) => v.split(/\s+/).includes(line) && null }));

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
      parseDOM: [{ tag: 'p', getAttrs: blockAttrs }],
      toDOM: (n) => blockDom('p', n),
    },
    heading: {
      ...textBlock('text:h', { level: { default: 1 } }),
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: 'h' + level, getAttrs: (el) => ({ ...blockAttrs(el), level }) })),
      toDOM: (n) => blockDom('h' + Math.min(6, Math.max(1, n.attrs.level)), n),
    },
    list: {
      //  `kind` is only for a pasted ul or ol, until paste.js gives it the
      //  document's own list style
      attrs: { ...base, kind: { default: null } },
      content: 'list_item+',
      group: 'block',
      //  the list style decides bullet or number: the view's sheet matches
      //  data-ls, and a pasted ul or ol gets the document's own (paste.js)
      //  a list copied from a Writer document names its list style, which
      //  paste.js keeps when this document has one of that name
      parseDOM: [{ tag: 'ul', getAttrs: (el) => ({ kind: 'bullet', xattrs: el.hasAttribute('data-ls') ? [['text:style-name', el.getAttribute('data-ls')]] : [] }) },
        { tag: 'ol', getAttrs: () => ({ kind: 'number' }) }],
      toDOM: (n) => {
        const s = n.attrs.xattrs.find(([k]) => k === 'text:style-name');
        return ['ul', s ? { 'data-ls': s[1] } : {}, 0];
      },
    },
    list_item: {
      attrs: { ...base, header: { default: false } },
      content: 'block+',
      defining: true,
      parseDOM: [{ tag: 'li' }],
      toDOM: (n) => ['li', n.attrs.header ? { class: 'lw-lh' } : {}, 0],
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
      parseDOM: [{ tag: 'br' }],
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
      //  never an href: a link in the editor is not followed by a click
      //  (Ctrl+click opens a safe one, view.js)
      //  (a link copied from a Writer document carries its target as data-href)
      parseDOM: ['href', 'data-href'].map((a) => ({
        tag: 'a[' + a + ']', getAttrs: (el) => (safeHref(el.getAttribute(a)) ? { href: el.getAttribute(a) } : false),
      })),
      toDOM: (m) => ['a', { 'data-href': m.attrs.href, title: m.attrs.href }, 0],
    },
    //  a named text style (office:styles)
    charStyle: {
      attrs: { name: {} },
      //  paste.js drops one this document does not define
      parseDOM: [{ tag: 'span[data-cs]', getAttrs: (el) => ({ name: el.getAttribute('data-cs') }) }],
      toDOM: (m) => ['span', { 'data-cs': m.attrs.name }, 0],
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
      //  its other properties shown through the same whitelist as the
      //  style sheet, never as written
      toDOM: (m) => {
        const c = css(NOFONTS, Object.fromEntries(m.attrs.rest));
        return ['span', c ? { style: c } : {}, 0];
      },
    },
    //  each keeps the property group it came from, so a double or wave
    //  underline, or a bold that also sets the Asian and complex weights,
    //  is written back as it was
    strong: {
      attrs: { props: { default: [['fo:font-weight', 'bold']] } },
      //  Google Docs wraps a whole paste in <b style="font-weight:normal">,
      //  so a b that says normal is not bold, and a normal weight inside a
      //  bold one turns it off
      parseDOM: [{ tag: 'strong' }, { tag: 'b', getAttrs: (el) => !/^(normal|[1-5]00)$/.test(el.style.fontWeight) && null },
        { style: 'font-weight', getAttrs: (v) => /^(bold|bolder|[6-9]00)$/.test(v) && null },
        { style: 'font-weight', clearMark: (m) => m.type.name === 'strong', getAttrs: (v) => /^(normal|[1-5]00)$/.test(v) && null }],
      toDOM: () => ['strong', 0],
    },
    em: {
      attrs: { props: { default: [['fo:font-style', 'italic']] } },
      parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' },
        { style: 'font-style=normal', clearMark: (m) => m.type.name === 'em' }],
      toDOM: () => ['em', 0],
    },
    underline: {
      attrs: { props: { default: [['style:text-underline-color', 'font-color'], ['style:text-underline-style', 'solid'], ['style:text-underline-width', 'auto']] } },
      //  Google Docs and Word Online say it in the style
      parseDOM: [{ tag: 'u' }, ...deco('underline')],
      toDOM: () => ['u', 0],
    },
    strike: {
      attrs: { props: { default: [['style:text-line-through-style', 'solid'], ['style:text-line-through-type', 'single']] } },
      parseDOM: [{ tag: 's' }, { tag: 'strike' }, { tag: 'del' }, ...deco('line-through')],
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
//  mark, comment end) does not. A soft page break, text:s, text:tab and
//  text:line-break end it too (checked against LibreOffice 26.8)
export const ZERO_WIDTH = /^(text:bookmark|text:reference-mark|text:change|text:toc-mark|text:alphabetical-index-mark|text:user-index-mark|office:annotation-end|#)/;
