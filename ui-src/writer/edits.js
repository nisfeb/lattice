//  edits.js: the scripted edits of tests/writer/corpus/edits.json, applied
//  to the ProseMirror document with ordinary transforms, the way the
//  editor's commands will. The round-trip harness (step 2) and the unit
//  suite use them; the editor view (Task 9) has its own commands.
//
//  `find` picks the first text block whose text starts with it.
import { Transform } from 'prosemirror-transform';
import { schema } from './schema.js';

const S = schema.nodes;
const M = schema.marks;

//  +findBlock: the first paragraph or heading whose text starts with
//  `prefix`, as { node, pos }
export function findBlock(doc, prefix) {
  let hit = null;
  doc.descendants((n, pos) => {
    if (hit) return false;
    if (n.isTextblock) {
      if (n.textContent.startsWith(prefix)) hit = { node: n, pos };
      return false;
    }
    return true;
  });
  return hit;
}

//  +findText: the document range of the first `word` in a text block, by
//  its text (atoms count as one position and no text)
export function findText(block, word) {
  let text = '';
  const at = [];
  block.node.forEach((c, off) => {
    if (c.isText) for (let i = 0; i < c.text.length; i++) { text += c.text[i]; at.push(block.pos + 1 + off + i); }
  });
  const i = text.indexOf(word);
  if (i < 0) return null;
  return { from: at[i], to: at[i + word.length - 1] + 1 };
}

const markOf = (name) => {
  const t = M[name];
  if (!t) throw new Error('no mark ' + name);
  return t.create();
};

//  +applyEdit: the parse result with the edit applied to its document,
//  or { error }
export function applyEdit(parsed, e) {
  try {
    const doc = parsed.doc;
    const tr = new Transform(doc);
    const need = (b, what) => { if (!b) throw new Error(`no ${what} starting "${e.find}"`); return b; };
    switch (e.op) {
      case 'insertText': {
        const b = need(findBlock(doc, e.find), 'block');
        const pos = e.at === 'start' ? b.pos + 1 : b.pos + 1 + b.node.content.size;
        const $p = doc.resolve(pos);
        const marks = (e.at === 'start' ? $p.marksAcross($p) : $p.marks()) || [];
        tr.insert(pos, schema.text(e.text, marks.filter((m) => m.type !== M.link)));
        break;
      }
      case 'insertParagraph': {
        const b = need(findBlock(doc, e.find), 'block');
        tr.insert(b.pos + b.node.nodeSize, S.paragraph.create({ style: e.style ?? b.node.attrs.style }, e.text ? schema.text(e.text) : null));
        break;
      }
      case 'toggleMark': {
        const b = need(findBlock(doc, e.find), 'block');
        const r = findText(b, e.word);
        if (!r) throw new Error(`no "${e.word}" in "${e.find}"`);
        const m = markOf(e.mark);
        if (doc.rangeHasMark(r.from, r.to, m.type)) tr.removeMark(r.from, r.to, m.type);
        else tr.addMark(r.from, r.to, m);
        break;
      }
      case 'setLink': {
        const b = need(findBlock(doc, e.find), 'block');
        const r = findText(b, e.word);
        if (!r) throw new Error(`no "${e.word}" in "${e.find}"`);
        tr.addMark(r.from, r.to, M.link.create({ href: e.href, xattrs: [['xlink:type', 'simple']] }));
        break;
      }
      case 'setBlockStyle': {
        const b = need(findBlock(doc, e.find), 'block');
        tr.setNodeMarkup(b.pos, null, { ...b.node.attrs, style: e.style });
        break;
      }
      case 'addListItem': {
        const b = need(findBlock(doc, e.find), 'block');
        const $b = doc.resolve(b.pos);
        let d = $b.depth;
        while (d > 0 && $b.node(d).type !== S.list_item) d--;
        if (!d) throw new Error(`"${e.find}" is not in a list`);
        const item = S.list_item.create(null, S.paragraph.create({ style: b.node.attrs.style }, schema.text(e.text)));
        tr.insert($b.after(d), item);
        break;
      }
      case 'addTableRow': {
        let t = null;
        doc.descendants((n, pos) => {
          if (t) return false;
          if (n.type === S.table && n.attrs.xattrs.some(([k, v]) => k === 'table:name' && v === e.table)) { t = { node: n, pos }; return false; }
          return true;
        });
        if (!t) throw new Error(`no table ${e.table}`);
        const last = t.node.lastChild;
        if (last.childCount !== e.cells.length) throw new Error('the row has the wrong number of cells');
        const cells = e.cells.map((txt, i) => {
          const like = last.child(i);
          const p = like.firstChild;
          return S.table_cell.create({ xattrs: like.attrs.xattrs },
            S.paragraph.create({ style: p.attrs.style }, txt ? schema.text(txt) : null));
        });
        tr.insert(t.pos + t.node.nodeSize - 1, S.table_row.create({ xattrs: last.attrs.xattrs }, cells));
        break;
      }
      default: throw new Error('unknown edit ' + e.op);
    }
    return { ...parsed, doc: tr.doc };
  } catch (err) {
    return { error: err.message };
  }
}
