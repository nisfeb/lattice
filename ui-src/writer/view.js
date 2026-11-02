//  view.js: the Writer editor view (plan, Task 9; spec, Where the model
//  lives in the client, Rendering fidelity, Security for the editor view).
//
//  mount(host, opts) puts a ProseMirror view of a flat ODT body into
//  `host` (a <lat-writer> element): a toolbar, any notes, and a sheet of
//  the document's page width and margins. The shell owns the text: the
//  view tells it when the document changed (`onChange`) and hands the
//  serialized body back when asked (`ctl.text()`), and the shell writes
//  that into #src. Nothing here saves.
//
//  The look comes from the document's own styles, turned into CSS by the
//  strict grammar in styles.js and matched on the style names the schema
//  writes into the DOM, quoted for CSS here. Opaque nodes are read-only
//  boxes whose text is set with textContent. A step that would delete one
//  half of a paired marker is refused, and the toolbar says why.
//
//  render(text) is the same projection as an HTML document, for the
//  preview and a parked tab: no script, no live link, nothing fetched.
import { DOMSerializer } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history } from 'prosemirror-history';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { attr, elements } from './xml.js';
import { schema, safeHref } from './schema.js';
import { parseFodt } from './parse.js';
import { serializeFodt, pairGuard } from './serialize.js';
import { cssLength, styleCss } from './styles.js';
import { buildKeys } from './keys.js';
import { buildToolbar } from './toolbar.js';
import { pastePlugin } from './paste.js';

const S = schema.nodes;

// ---------------------------------------------------------------- CSS
//  a string for a CSS attribute selector: every character that is not a
//  letter, digit, - or _ as a hex escape, so a style name can never end
//  the string or the rule
export const cssStr = (s) => '"' + String(s).replace(/[^A-Za-z0-9_-]/g, (c) => '\\' + c.codePointAt(0).toString(16) + ' ') + '"';

const PX = { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 96 / 72, pc: 16, px: 1 };
export function toPx(len) {
  const v = cssLength(len, false);
  if (!v) return null;
  const m = /^(-?[\d.]+)([a-z]+)$/.exec(v);
  return m ? parseFloat(m[1]) * PX[m[2]] : null;
}

const NUMFMT = { 1: 'decimal', a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman', '': 'none' };
const BULLET = { '•': 'disc', '●': 'disc', '◦': 'circle', '○': 'circle', '▪': 'square', '■': 'square', '–': 'square', '-': 'square' };

//  what a list style's level looks like, as list-style-type
function levelType(lv) {
  if (!lv) return null;
  if (lv.name === 'text:list-level-style-number') return NUMFMT[attr(lv, 'style:num-format') ?? '1'] || 'decimal';
  if (lv.name === 'text:list-level-style-bullet') return BULLET[attr(lv, 'text:bullet-char') ?? ''] || 'disc';
  return 'none';
}

//  the style sheet of one document, every rule under `scope`
export function docCss(st, scope) {
  const out = [];
  const base = styleCss(st, 'paragraph', null);
  if (base) out.push(`${scope} .lw-doc{${base}}`);
  for (const s of st.styles.values()) {
    if (s.family === 'paragraph') {
      const c = styleCss(st, 'paragraph', s.name);
      if (c) out.push(`${scope} [data-ps=${cssStr(s.name)}]{${c}}`);
    } else if (s.family === 'text' && !s.auto) {
      const c = styleCss(st, 'text', s.name);
      if (c) out.push(`${scope} [data-cs=${cssStr(s.name)}]{${c}}`);
    }
  }
  for (const [name, e] of st.lists) {
    const lv = elements(e);
    let sel = `${scope} ul[data-ls=${cssStr(name)}]`;
    for (let i = 0; i < 4; i++) {
      const t = levelType(lv[i]);
      if (t) out.push(`${sel}{list-style-type:${t}}`);
      sel += '>li>ul:not([data-ls])';
    }
  }
  return out.join('\n');
}

//  the page: width and margins of the first master page's layout, Letter
//  with 2 cm margins when the document says nothing usable
export function pageBox(layout) {
  const w = toPx(layout.width) || 816;
  const m = (v, d) => { const p = toPx(v); return p != null && p >= 0 && p < w / 2 ? p : d; };
  return { width: w, top: m(layout.marginTop, 76), bottom: m(layout.marginBottom, 76), left: m(layout.marginLeft, 76), right: m(layout.marginRight, 76) };
}

//  the view's own look, once per document
const BASE_CSS = `
lat-writer{display:flex;flex-direction:column;min-height:0;height:100%;overflow:hidden}
.lw-bar{display:flex;gap:2px;align-items:center;padding:4px 6px;border-bottom:1px solid var(--border,#8884);overflow-x:auto;flex:none;scrollbar-width:thin}
.lw-bar button,.lw-bar select{flex:none;font:inherit;font-size:13px;min-height:30px;min-width:30px;padding:2px 6px;border:1px solid transparent;border-radius:4px;background:none;color:inherit;cursor:pointer}
.lw-bar select{max-width:11em;border-color:var(--border,#8884)}
.lw-bar button:hover:not(:disabled){border-color:var(--border,#8886)}
.lw-bar button.on{background:var(--accent-bg,#8883);border-color:var(--border,#8886)}
.lw-bar button:disabled,.lw-bar select:disabled{opacity:.45;cursor:default}
.lw-bar .lw-sep{flex:none;width:1px;height:20px;background:var(--border,#8884);margin:0 3px}
.lw-notes:empty{display:none}
.lw-note{display:flex;gap:8px;align-items:center;padding:6px 10px;font-size:13px;border-bottom:1px solid var(--border,#8884);background:var(--note-bg,#f0c04022)}
.lw-note.lw-ro{background:var(--warn-bg,#e0606022)}
.lw-note span{flex:1}
.lw-note button{font:inherit;font-size:12px;padding:2px 8px;border:1px solid var(--border,#8886);border-radius:4px;background:none;color:inherit;cursor:pointer}
.lw-link{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--border,#8884);font-size:13px}
.lw-link input{flex:1;min-width:12em;font:inherit;padding:3px 6px}
.lw-link .lw-warn{flex-basis:100%;color:var(--err,#c33)}
.lw-link button{font:inherit;font-size:12px;padding:2px 8px}
.lw-scroll{flex:1;overflow:auto;padding:16px 8px;background:var(--sheet-bg,#8881)}
.lw-sheet{margin:0 auto;background:#fff;color:#000;box-shadow:0 1px 4px #0003;min-height:60vh;box-sizing:border-box}
.lw-doc{outline:none;white-space:pre-wrap;word-wrap:break-word;font-family:"Liberation Serif","Times New Roman",Times,serif;font-size:12pt;line-height:1.15;color:#000}
.lw-doc p,.lw-doc h1,.lw-doc h2,.lw-doc h3,.lw-doc h4,.lw-doc h5,.lw-doc h6{margin:0;font-size:inherit;font-weight:inherit;min-height:1.15em}
.lw-doc h1:not([data-ps]){font-size:1.6em;font-weight:bold}.lw-doc h2:not([data-ps]){font-size:1.4em;font-weight:bold}
.lw-doc h3:not([data-ps]){font-size:1.2em;font-weight:bold}.lw-doc h4:not([data-ps]),.lw-doc h5:not([data-ps]),.lw-doc h6:not([data-ps]){font-weight:bold}
.lw-doc ul{margin:0;padding-left:1.6em}
.lw-doc li.lw-lh{list-style:none}
.lw-doc table{border-collapse:collapse;width:100%;margin:4px 0}
.lw-doc td{border:1px solid #888;padding:2px 5px;vertical-align:top}
.lw-doc a[data-href]{color:#000080;text-decoration:underline;cursor:text}
.lw-doc .fodt-quote{margin-left:1cm;margin-right:1cm}
.lw-doc .lw-pb{border-top:1px dashed #888;margin-top:18px;padding-top:4px;position:relative}
.lw-doc .lw-pb::before{content:"page break";position:absolute;top:-16px;right:0;font:10px/1 system-ui,sans-serif;color:#888}
.lw-doc .fodt-op{border:1px dashed #999;border-radius:3px;padding:4px 8px;margin:4px 0;font:12px/1.4 system-ui,sans-serif;color:#555;background:#f6f6f6;white-space:pre-wrap;user-select:none}
.lw-doc .fodt-op:is([data-el="text:sequence-decls"],[data-el="text:variable-decls"],[data-el="text:user-field-decls"],[data-el="text:dde-connection-decls"],[data-el="text:tracked-changes"]){display:none}
.lw-doc .fodt-op::before{content:"Kept from LibreOffice: " attr(data-el);display:block;font-size:10px;color:#888}
.lw-doc .fodt-op.ProseMirror-selectednode,.lw-doc .fodt-opi.ProseMirror-selectednode{outline:2px solid #4a90d9}
.lw-doc .fodt-opi{background:#eee;border-radius:2px;color:#555}
.lw-doc .fodt-opi:empty{display:inline-block;width:2px;height:1em;vertical-align:text-bottom;background:#9bf}
.lw-doc .fodt-sec{border-left:2px solid #ddd;padding-left:4px}
.lw-doc .ProseMirror-gapcursor{display:none;pointer-events:none;position:absolute}
.lw-doc .ProseMirror-gapcursor:after{content:"";display:block;position:absolute;top:-2px;width:20px;border-top:1px solid black;animation:lw-blink 1.1s steps(2,start) infinite}
@keyframes lw-blink{to{visibility:hidden}}
.lw-doc.ProseMirror-focused .ProseMirror-gapcursor{display:block}
.lw-doc .ProseMirror-hideselection *::selection{background:transparent}
.lw-doc li{position:relative}
`;
let baseInstalled = false;
function installBase() {
  if (baseInstalled || typeof document === 'undefined') return;
  baseInstalled = true;
  const el = document.createElement('style');
  el.id = 'lw-base';
  el.textContent = BASE_CSS;
  document.head.append(el);
}

// ---------------------------------------------------------------- plugins
//  A split or a paste copies a node's attributes, `src` and `xattrs`
//  with them, so two nodes would claim one source span and one xml:id
//  (LibreOffice writes one on every text:list). After any step that adds
//  structure, the second node with a span loses it, its xml:id and its
//  page break: it is a new node, written fresh.
function dedupe() {
  const structural = (tr) => tr.steps.some((s) => {
    const sl = s.slice;
    if (!sl || !sl.size) return false;
    if (sl.openStart || sl.openEnd) return true;
    let block = false;
    sl.content.descendants((n) => { if (!n.isInline) block = true; return !block; });
    return block;
  });
  return new Plugin({
    appendTransaction(trs, _old, state) {
      if (!trs.some((t) => t.docChanged && structural(t))) return null;
      const seen = new Set();
      const ids = new Set();
      let tr = null;
      state.doc.descendants((n, pos) => {
        if (!n.isBlock || n.type === S.opaque_block) return n.isBlock;
        const s = n.attrs.src;
        const xa = n.attrs.xattrs || [];
        const id = xa.find(([k]) => k === 'xml:id');
        const dupSrc = s && seen.has(s[0]);
        const dupId = id && ids.has(id[1]);
        if (s) seen.add(s[0]);
        if (id) ids.add(id[1]);
        if (dupSrc || dupId) {
          const attrs = { ...n.attrs, src: null, xattrs: xa.filter(([k]) => k !== 'xml:id') };
          if (dupSrc && 'pageBreak' in attrs) attrs.pageBreak = false;
          tr = (tr || state.tr).setNodeMarkup(pos, null, attrs);
        }
        return true;
      });
      return tr;
    },
  });
}

//  The declaration blocks the view hides (sequence, variable and user
//  field declarations, the tracked-changes log) hold what fields and
//  change marks refer to. No one can see them, so no one can mean to
//  delete them: a step that drops one, typing over a node selection of
//  one or clearing the document, gets it back at the top of the body,
//  where LibreOffice writes them.
const HIDDEN = /^text:(sequence-decls|variable-decls|user-field-decls|dde-connection-decls|tracked-changes)$/;
const hidden = (doc) => {
  const out = [];
  doc.descendants((n) => {
    if (n.type === S.opaque_block && HIDDEN.test(n.attrs.name)) out.push(n);
    return !n.isTextblock;
  });
  return out;
};
export function keepHidden() {
  return new Plugin({
    appendTransaction(trs, old, state) {
      if (!trs.some((t) => t.docChanged)) return null;
      const have = new Set(hidden(state.doc).map((n) => n.attrs.raw));
      const lost = hidden(old.doc).filter((n) => !have.has(n.attrs.raw));
      return lost.length ? state.tr.insert(0, lost) : null;
    },
  });
}

const PAIR_WHAT = 'one half of a bookmark, reference mark, comment or tracked change';

// ---------------------------------------------------------------- mount
//  mount(host, opts): the controller, or { error } when the body cannot be
//  opened (the shell then shows Source view with the reason).
//  opts: text, editable, draftNote, onChange(), onDraftSeen(), onNote(msg)
export function mount(host, opts = {}) {
  const text = String(opts.text ?? '');
  const parsed = parseFodt(text);
  if (parsed.error) return { error: parsed.error };
  installBase();
  const st = parsed.styles;
  host.replaceChildren();
  host.classList.add('lw-host');
  const scope = 'lat-writer[data-lw="' + (++mountSeq) + '"]';
  host.setAttribute('data-lw', String(mountSeq));
  const sheetCss = document.createElement('style');
  sheetCss.textContent = docCss(st, scope);
  const bar = document.createElement('div');
  bar.className = 'lw-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Formatting');
  const notes = document.createElement('div');
  notes.className = 'lw-notes';
  const scroll = document.createElement('div');
  scroll.className = 'lw-scroll';
  const sheet = document.createElement('div');
  sheet.className = 'lw-sheet';
  scroll.append(sheet);
  host.append(sheetCss, bar, notes, scroll);

  const box = pageBox(parsed.layout);
  const fit = () => {
    const avail = Math.max(120, scroll.clientWidth - 16);
    const k = Math.min(1, avail / box.width);
    sheet.style.width = Math.round(box.width * k) + 'px';
    sheet.style.padding = `${Math.round(box.top * k)}px ${Math.round(box.right * k)}px ${Math.round(box.bottom * k)}px ${Math.round(box.left * k)}px`;
    sheet.dataset.scale = k.toFixed(3);
  };
  fit();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
  if (ro) ro.observe(scroll);

  const ctl = {
    parsed,
    original: text,
    tracking: !!parsed.tracking,
    macros: !!parsed.macros,
    editableWanted: opts.editable !== false,
    get editable() { return this.editableWanted && !this.tracking; },
    view: null,
    host,
  };

  // ------------------------------------------------------------ notes
  const note = (cls, msg, button, onButton) => {
    const n = document.createElement('div');
    n.className = 'lw-note ' + cls;
    n.setAttribute('role', 'status');
    const s = document.createElement('span');
    s.textContent = msg;
    n.append(s);
    if (button) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = button;
      b.onclick = () => { n.remove(); if (onButton) onButton(); };
      n.append(b);
    }
    notes.append(n);
    return n;
  };
  if (ctl.tracking) {
    note('lw-ro lw-track', 'This document records tracked changes, so lattice opens it read-only. '
      + 'Edit it in LibreOffice, or turn off Edit, Track Changes, Record there to edit it here.');
  }
  if (opts.draftNote) {
    note('lw-draft', 'Draft layout: lines and page breaks will not fall where LibreOffice puts them, '
      + 'and headers, footers and page numbers are kept in the file but not shown here.',
    'Got it', () => { if (opts.onDraftSeen) opts.onDraftSeen(); });
  }
  let flash = null;
  let flashTimer = 0;
  ctl.say = (msg) => {
    if (opts.onNote) opts.onNote(msg);
    if (!flash || !flash.isConnected) flash = note('lw-say', msg);
    else flash.firstChild.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (flash) flash.remove(); flash = null; }, 6000);
  };

  // ------------------------------------------------------------ view
  let refusedAt = 0;
  const guard = new Plugin({
    filterTransaction(tr, state) {
      if (pairGuard(tr, state)) return true;
      if (Date.now() - refusedAt > 500) ctl.say('Not deleted: that would leave ' + PAIR_WHAT + ' without its other end. Select both ends to delete it.');
      refusedAt = Date.now();
      return false;
    },
  });
  const toolbar = buildToolbar(bar, ctl, { schema, st });
  //  the caret starts in the first text, never as a node selection of a
  //  hidden declaration block the first key would replace
  const state = EditorState.create({
    doc: parsed.doc,
    selection: TextSelection.findFrom(parsed.doc.resolve(0), 1, true) || undefined,
    plugins: [guard, dedupe(), keepHidden(), ...buildKeys(ctl), history(), dropCursor(), gapCursor(), pastePlugin(ctl, st)],
  });
  const view = new EditorView(sheet, {
    state,
    editable: () => ctl.editable,
    attributes: { class: 'lw-doc', spellcheck: 'true', 'aria-label': 'Document', role: 'textbox', 'aria-multiline': 'true' },
    dispatchTransaction(tr) {
      const next = view.state.apply(tr);
      view.updateState(next);
      toolbar.update(view);
      if (tr.docChanged && opts.onChange) opts.onChange();
    },
    handleDOMEvents: {
      //  a link is never followed by a plain click; Ctrl or Cmd and click
      //  opens a safe one in a new tab, and says why for any other
      click(v, e) {
        const a = e.target && e.target.closest && e.target.closest('a[data-href]');
        if (!a || !(e.ctrlKey || e.metaKey)) return false;
        const href = a.getAttribute('data-href');
        e.preventDefault();
        if (safeHref(href) && !href.startsWith('#')) window.open(href, '_blank', 'noopener');
        else ctl.say('That link does not open from lattice: ' + href);
        return true;
      },
    },
  });
  ctl.view = view;
  toolbar.update(view);

  ctl.text = () => serializeFodt(view.state, text);
  ctl.setEditable = (on) => {
    ctl.editableWanted = !!on;
    view.setProps({ editable: () => ctl.editable });
    toolbar.update(view);
  };
  ctl.focus = () => view.focus();
  ctl.destroy = () => {
    if (ro) ro.disconnect();
    clearTimeout(flashTimer);
    view.destroy();
    host.replaceChildren();
    host.removeAttribute('data-lw');
  };
  return ctl;
}
let mountSeq = 0;

// ---------------------------------------------------------------- render
//  the body as a self-contained HTML document, or null when it cannot be
//  parsed. Built with DOM APIs in a detached document, so every text and
//  attribute is escaped by the serializer; no href, no script, no url.
export function render(text) {
  const p = parseFodt(String(text ?? ''));
  if (p.error || typeof document === 'undefined') return null;
  const d = document.implementation.createHTMLDocument('');
  const page = d.createElement('lat-writer');
  page.setAttribute('data-lw', 'r');
  const sheet = d.createElement('div');
  sheet.className = 'lw-sheet';
  const docEl = d.createElement('div');
  docEl.className = 'lw-doc';
  docEl.append(DOMSerializer.fromSchema(schema).serializeFragment(p.doc.content, { document: d }));
  sheet.append(docEl);
  page.append(sheet);
  const box = pageBox(p.layout);
  const css = BASE_CSS + docCss(p.styles, 'lat-writer[data-lw="r"]')
    + `\nbody{margin:0}lat-writer{display:block;height:auto;overflow:visible}`
    + `.lw-sheet{max-width:${Math.round(box.width)}px;padding:${Math.round(box.top)}px ${Math.round(box.right)}px ${Math.round(box.bottom)}px ${Math.round(box.left)}px;box-shadow:none;min-height:0}`
    + `@media (max-width:${Math.round(box.width)}px){.lw-sheet{padding:16px}}`;
  const style = d.createElement('style');
  style.textContent = css;
  return '<!doctype html><html><head><meta charset="utf-8"><base target="_top">' + style.outerHTML
    + '</head><body>' + page.outerHTML + '</body></html>';
}
