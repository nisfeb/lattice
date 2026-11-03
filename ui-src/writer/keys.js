//  keys.js: the Writer keymap (plan, Task 9) and the commands the toolbar
//  shares with it. Ctrl+B, I and U, Ctrl+1 to 6 for headings (Ctrl+Alt
//  too, since a browser keeps Ctrl+1 to 8 for its own tabs), Ctrl+0 for
//  body text, Enter and Backspace in lists, Tab in tables and lists.
import { keymap } from 'prosemirror-keymap';
import { Selection } from 'prosemirror-state';
import { baseKeymap, chainCommands, toggleMark, splitBlock } from 'prosemirror-commands';
import { undo, redo } from 'prosemirror-history';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { goToNextCell } from 'prosemirror-tables';
import { schema } from './schema.js';
import { isQuote, lookup } from './styles.js';

const S = schema.nodes;
const M = schema.marks;

//  the text blocks the selection touches, as [node, pos]
export function blocksIn(state) {
  const out = [];
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, to, (n, pos) => {
    if (n.isTextblock) { out.push([n, pos]); return false; }
    return true;
  });
  return out;
}

//  the style a document gives a new paragraph after one in `style`: its
//  style:next-style-name, else the same style for a paragraph
function nextStyle(st, node) {
  const s = node.attrs.style != null ? lookup(st, 'paragraph', node.attrs.style) : null;
  const n = s && s.extra.find(([k]) => k === 'style:next-style-name');
  if (n) return n[1];
  if (node.type === S.heading) return lookup(st, 'paragraph', 'Text_20_body') ? 'Text_20_body' : null;
  return node.attrs.style;
}

//  the body text style of this document
export const bodyStyle = (st) => (lookup(st, 'paragraph', 'Text_20_body') ? 'Text_20_body'
  : lookup(st, 'paragraph', 'Standard') ? 'Standard' : null);

//  +setBlock: every text block in the selection becomes a paragraph or a
//  heading of `level` in `style`. Attributes the file had ride along
export const setBlock = (st, level, style) => (state, dispatch) => {
  const bs = blocksIn(state);
  if (!bs.length) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const [n, pos] of bs) {
      const type = level ? S.heading : S.paragraph;
      const attrs = { ...n.attrs, style, quote: isQuote(st, style) };
      if (level) attrs.level = level; else delete attrs.level;
      for (const k of Object.keys(attrs)) if (!(k in type.spec.attrs)) delete attrs[k];
      tr.setNodeMarkup(pos, type, attrs);
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};

//  the heading style for a level: the document's Heading N when it has
//  one, else none (LibreOffice then shows its default for the level)
export const headingStyle = (st, level) => {
  const n = 'Heading_20_' + level;
  return lookup(st, 'paragraph', n) ? n : null;
};

//  Enter at the end of a text block starts a paragraph in the style the
//  document says comes next, with none of the old block's attributes.
//  Elsewhere it splits the block (the second half loses its span, view.js)
const enterBlock = (st) => (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parentOffset < $from.parent.content.size) return splitBlock(state, dispatch);
  if (dispatch) {
    const style = nextStyle(st, $from.parent);
    const p = S.paragraph.create({ style, quote: isQuote(st, style) });
    const at = $from.after();
    const tr = state.tr.insert(at, p);
    tr.setSelection(Selection.near(tr.doc.resolve(at + 1)));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

//  Backspace at the start of a list item's first block lifts it out
const backLift = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const d = $from.depth - 1;
  if (d < 1 || $from.node(d).type !== S.list_item || $from.index(d) !== 0) return false;
  return liftListItem(S.list_item)(state, dispatch);
};

//  Tab: the next cell in a table, a level in a list, else a tab character
const tab = (dir) => (state, dispatch) => {
  if (goToNextCell(dir)(state, dispatch)) return true;
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === S.list_item) {
      return (dir > 0 ? sinkListItem(S.list_item) : liftListItem(S.list_item))(state, dispatch) || true;
    }
  }
  if (dir < 0) return true;
  if (dispatch) dispatch(state.tr.insertText('\t').scrollIntoView());
  return true;
};

export const hardBreak = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(S.hard_break.create()).scrollIntoView());
  return true;
};

//  +listCmd: wrap in a list of `kind` (bullet or number) in the given list
//  style, or lift out of one
export const toList = (style) => wrapInList(S.list, { xattrs: [['text:style-name', style]] });
export const lift = liftListItem(S.list_item);
export const sink = sinkListItem(S.list_item);

export function buildKeys(ctl) {
  const st = ctl.parsed.styles;
  const k = {
    'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo,
    'Mod-b': toggleMark(M.strong), 'Mod-i': toggleMark(M.em), 'Mod-u': toggleMark(M.underline),
    'Shift-Mod-x': toggleMark(M.strike),
    'Mod-0': setBlock(st, 0, bodyStyle(st)), 'Mod-Alt-0': setBlock(st, 0, bodyStyle(st)),
    'Shift-Enter': hardBreak,
    Enter: chainCommands(splitListItem(S.list_item), enterBlock(st)),
    Backspace: backLift,
    Tab: tab(1), 'Shift-Tab': tab(-1),
  };
  for (let i = 1; i <= 6; i++) {
    k['Mod-' + i] = setBlock(st, i, headingStyle(st, i));
    k['Mod-Alt-' + i] = setBlock(st, i, headingStyle(st, i));
  }
  //  read-only: nothing that edits runs (the view also refuses input)
  const guarded = {};
  for (const [key, cmd] of Object.entries(k)) guarded[key] = (s, d, v) => (ctl.editable ? cmd(s, d, v) : key.startsWith('Mod-') || key === 'Tab');
  const base = {};
  for (const [key, cmd] of Object.entries(baseKeymap)) base[key] = (s, d, v) => (ctl.editable ? cmd(s, d, v) : false);
  return [keymap(guarded), keymap(base)];
}
