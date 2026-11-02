//  toolbar.js: the Writer toolbar (plan, Task 9). Paragraph style by
//  display name, block type (body text, Heading 1 to 6), character style,
//  bold, italic, underline, strike, bullet and numbered lists, outdent and
//  indent, quote, link, page break, undo and redo. Built with DOM APIs:
//  every label is textContent.
//
//  A named style only changes text:style-name; direct formatting goes
//  through the serializer's automatic-style registry when it saves.
import { toggleMark } from 'prosemirror-commands';
import { undo, redo, undoDepth, redoDepth } from 'prosemirror-history';
import { safeHref } from './schema.js';
import { listKind, lookup, namedStyles } from './styles.js';
import { blocksIn, bodyStyle, headingStyle, lift, setBlock, sink, toList } from './keys.js';
import { listStyleFor } from './paste.js';

export function buildToolbar(bar, ctl, { schema, st }) {
  const S = schema.nodes;
  const M = schema.marks;
  const items = [];
  const view = () => ctl.view;
  const run = (cmd) => { const v = view(); if (!v || !ctl.editable) return; cmd(v.state, v.dispatch, v); v.focus(); };

  const button = (id, label, title, cmd, active) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.lw = id;
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    //  mousedown would take the focus, and with it the selection
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.onclick = () => run(cmd);
    bar.append(b);
    items.push({ el: b, cmd, active });
    return b;
  };
  const sep = () => { const s = document.createElement('span'); s.className = 'lw-sep'; bar.append(s); };
  const select = (id, title, options, onPick) => {
    const s = document.createElement('select');
    s.dataset.lw = id;
    s.title = title;
    s.setAttribute('aria-label', title);
    for (const [value, label] of options) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      s.append(o);
    }
    s.onchange = () => { const v = s.value; onPick(v); };
    bar.append(s);
    return s;
  };

  // ------------------------------------------------------------ styles
  const paraStyles = namedStyles(st, 'paragraph');
  const pStyle = select('pstyle', 'Paragraph style',
    [['', 'Paragraph style'], ...paraStyles.map((s) => [s.name, s.display])], (name) => {
      if (!name) return;
      const e = lookup(st, 'paragraph', name);
      const lv = e && e.extra.find(([k]) => k === 'style:default-outline-level');
      const level = lv ? Math.min(Math.max(parseInt(lv[1], 10) || 0, 0), 10) : 0;
      run(setBlock(st, level, name));
    });
  const block = select('block', 'Heading level',
    [['0', 'Body text'], ...[1, 2, 3, 4, 5, 6].map((i) => [String(i), 'Heading ' + i])], (v) => {
      const lv = parseInt(v, 10);
      run(setBlock(st, lv, lv ? headingStyle(st, lv) : bodyStyle(st)));
    });
  const charStyles = namedStyles(st, 'text');
  const cStyle = select('cstyle', 'Character style',
    [['', 'No character style'], ...charStyles.map((s) => [s.name, s.display])], (name) => {
      run((state, dispatch) => {
        const { from, to, empty } = state.selection;
        if (empty) return false;
        const tr = state.tr.removeMark(from, to, M.charStyle);
        if (name) tr.addMark(from, to, M.charStyle.create({ name }));
        dispatch(tr);
        return true;
      });
    });
  sep();

  // ------------------------------------------------------------ marks
  const markOn = (type) => (state) => {
    const { from, to, empty, $from } = state.selection;
    if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
    return state.doc.rangeHasMark(from, to, type);
  };
  button('bold', 'B', 'Bold (Ctrl+B)', toggleMark(M.strong), markOn(M.strong)).style.fontWeight = 'bold';
  button('italic', 'I', 'Italic (Ctrl+I)', toggleMark(M.em), markOn(M.em)).style.fontStyle = 'italic';
  button('underline', 'U', 'Underline (Ctrl+U)', toggleMark(M.underline), markOn(M.underline)).style.textDecoration = 'underline';
  button('strike', 'S', 'Strikethrough (Ctrl+Shift+X)', toggleMark(M.strike), markOn(M.strike)).style.textDecoration = 'line-through';
  sep();

  // ------------------------------------------------------------ lists
  const inListOf = (state, kind) => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const n = $from.node(d);
      if (n.type === S.list) {
        const s = n.attrs.xattrs.find(([k]) => k === 'text:style-name');
        return !kind || (s ? listKind(st, s[1]) || 'bullet' : 'bullet') === kind;
      }
    }
    return false;
  };
  const listCmd = (kind) => (state, dispatch) => {
    if (inListOf(state, null)) return lift(state, dispatch);
    const name = listStyleFor(st, kind);
    if (!name) {
      if (dispatch) ctl.say('This document has no ' + (kind === 'number' ? 'numbered' : 'bullet') + ' list style yet. Add a list in LibreOffice once and it can be used here.');
      return false;
    }
    return toList(name)(state, dispatch);
  };
  button('bullets', '•', 'Bullet list', listCmd('bullet'), (s) => inListOf(s, 'bullet'));
  button('numbers', '1.', 'Numbered list', listCmd('number'), (s) => inListOf(s, 'number'));
  button('outdent', '⇤', 'Outdent (Shift+Tab)', lift);
  button('indent', '⇥', 'Indent (Tab)', sink);
  sep();

  // ------------------------------------------------------------ blocks
  const quoteCmd = (state, dispatch) => {
    const bs = blocksIn(state);
    if (!bs.length) return false;
    const on = bs.every(([n]) => n.attrs.quote);
    return setBlock(st, 0, on ? bodyStyle(st) : 'Quotations')(state, dispatch);
  };
  button('quote', '❝', 'Quotation', quoteCmd, (s) => { const b = blocksIn(s); return b.length > 0 && b.every(([n]) => n.attrs.quote); });
  const breakCmd = (state, dispatch) => {
    const bs = blocksIn(state);
    if (!bs.length) return false;
    if (dispatch) {
      const on = !bs[0][0].attrs.pageBreak;
      const [n, pos] = bs[0];
      dispatch(state.tr.setNodeMarkup(pos, null, { ...n.attrs, pageBreak: on }));
    }
    return true;
  };
  button('pagebreak', '⤓', 'Page break before this paragraph', breakCmd, (s) => { const b = blocksIn(s); return b.length > 0 && b[0][0].attrs.pageBreak; });
  const linkBtn = button('link', '🔗', 'Link', () => true, (s) => markOn(M.link)(s));
  linkBtn.onclick = () => openLink();
  sep();
  button('undo', '↶', 'Undo (Ctrl+Z)', undo);
  button('redo', '↷', 'Redo (Ctrl+Y)', redo);

  // ------------------------------------------------------------ link
  //  a small form under the toolbar. An existing target is shown as it is
  //  written, with a warning when lattice will not open it; a new link
  //  must be one lattice would open
  let form = null;
  const closeLink = () => { if (form) { form.remove(); form = null; } };
  const linkAt = (state) => {
    const { $from, from, to } = state.selection;
    const none = { marks: [] };
    let m = M.link.isInSet($from.marks()) || M.link.isInSet(($from.nodeAfter || none).marks)
      || M.link.isInSet(($from.nodeBefore || none).marks);
    if (!m) state.doc.nodesBetween(from, to, (n) => { if (!m) m = M.link.isInSet(n.marks); });
    return m;
  };
  //  the run of the link mark around the cursor
  const linkRange = (state, m) => {
    const { $from } = state.selection;
    const start = $from.start();
    let run = null, hit = null;
    $from.parent.forEach((c, off) => {
      const a = start + off, b = a + c.nodeSize;
      if (!m.isInSet(c.marks)) { run = null; return; }
      if (run && run.to === a) run.to = b; else run = { from: a, to: b };
      if (run.from <= $from.pos && run.to >= $from.pos) hit = run;
    });
    return hit;
  };
  function openLink() {
    const v = view();
    if (!v) return;
    closeLink();
    const cur = linkAt(v.state);
    form = document.createElement('div');
    form.className = 'lw-link';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'https://…';
    input.value = cur ? cur.attrs.href : '';
    input.setAttribute('aria-label', 'Link target');
    input.readOnly = !ctl.editable;
    const warn = document.createElement('span');
    warn.className = 'lw-warn';
    const paint = () => {
      const h = input.value.trim();
      warn.textContent = h && !safeHref(h) ? 'Lattice will not open this link: ' + h : '';
      warn.hidden = !warn.textContent;
    };
    input.oninput = paint;
    paint();
    const btn = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.onclick = fn;
      form.append(b);
      return b;
    };
    form.append(input, warn);
    const apply = () => {
      const href = input.value.trim();
      if (!href) { remove(); return; }
      if (!safeHref(href)) { warn.textContent = 'Lattice will not make this link: ' + href; warn.hidden = false; return; }
      run((state, dispatch) => {
        const { from, to, empty } = state.selection;
        const old = linkAt(state);
        const mark = M.link.create({ href, xattrs: old ? old.attrs.xattrs : [['xlink:type', 'simple']] });
        let tr = state.tr;
        if (empty && old) {
          const r = linkRange(state, old);
          if (r) tr = tr.removeMark(r.from, r.to, M.link).addMark(r.from, r.to, mark);
        } else if (empty) {
          tr = tr.insert(from, schema.text(href, [mark]));
        } else tr = tr.removeMark(from, to, M.link).addMark(from, to, mark);
        dispatch(tr);
        return true;
      });
      closeLink();
    };
    const remove = () => {
      run((state, dispatch) => {
        const { from, to, empty } = state.selection;
        const old = linkAt(state);
        if (!old) return false;
        const r = empty ? linkRange(state, old) : { from, to };
        if (r) dispatch(state.tr.removeMark(r.from, r.to, M.link));
        return true;
      });
      closeLink();
    };
    if (ctl.editable) {
      btn('Apply', apply);
      if (cur) btn('Remove link', remove);
    }
    btn(ctl.editable ? 'Cancel' : 'Close', () => { closeLink(); v.focus(); });
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (ctl.editable) apply(); }
      if (e.key === 'Escape') { e.preventDefault(); closeLink(); v.focus(); }
    };
    bar.after(form);
    input.focus();
    input.select();
  }
  ctl.openLink = openLink;

  // ------------------------------------------------------------ state
  return {
    update(v) {
      const state = v.state;
      const ed = ctl.editable;
      for (const it of items) {
        const can = ed && (it.el.dataset.lw === 'link' || it.cmd(state));
        it.el.disabled = it.el.dataset.lw === 'link' ? false : !can;
        if (it.active) {
          const on = !!it.active(state);
          it.el.classList.toggle('on', on);
          it.el.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
      }
      if (!ed) { const u = items.find((i) => i.el.dataset.lw === 'undo'); if (u) u.el.disabled = true; }
      else {
        for (const [id, f] of [['undo', undoDepth], ['redo', redoDepth]]) {
          const it = items.find((i) => i.el.dataset.lw === id);
          if (it) it.el.disabled = f(state) === 0;
        }
      }
      for (const s of [pStyle, block, cStyle]) s.disabled = !ed;
      const bs = blocksIn(state);
      const first = bs[0] && bs[0][0];
      pStyle.value = first && first.attrs.style && paraStyles.some((s) => s.name === first.attrs.style) ? first.attrs.style : '';
      block.value = first && first.type === S.heading ? String(Math.min(6, first.attrs.level)) : '0';
      const { $from } = state.selection;
      const cs = M.charStyle.isInSet(state.storedMarks || $from.marks());
      cStyle.value = cs && charStyles.some((s) => s.name === cs.attrs.name) ? cs.attrs.name : '';
    },
  };
}
