//  view.js: the grid. Mounts a Book over a host element and lets a person
//  edit it: select, type, the formula bar, the keyboard, copy and paste,
//  formats, rows and columns, sheets, undo.
//
//  Only the cells on screen exist in the DOM. The scroller holds one
//  element as large as the sheet, and a layer of absolutely placed cells
//  is rebuilt for the visible window as it scrolls, so a sheet of any
//  size costs the same to show.
//
//  The shell's contract is the Writer view's (ui-src/writer/view.js): the
//  page's text is the one buffer, opts.cur() reads it, opts.onText writes
//  it 300 ms after a change and at sync(), and opts.onChange says the
//  document is dirty.

import { Book } from './book.js';
import { colName, toUser } from './formula.js';
import { rowCount, MAX_ROWS, MAX_COLS } from './model.js';
import { exportOds, exportCsv } from './ods.js';

const HDR_W = 46, HDR_H = 24, COL_W = 85, ROW_H = 22;
const BIG = 2 * 1024 * 1024;

const BASE_CSS = `
lat-sheet{display:flex;flex-direction:column;min-height:0;height:100%;overflow:hidden;font-size:13px}
.ls-bar{display:flex;flex-wrap:wrap;gap:2px;align-items:center;padding:4px 6px;border-bottom:1px solid var(--border,#8884);flex:none}
.ls-bar button,.ls-bar select{font:inherit;font-size:13px;min-width:28px;height:28px;padding:0 7px;border:1px solid transparent;border-radius:4px;background:none;color:inherit;cursor:pointer}
.ls-bar select{border-color:var(--border,#8884);max-width:9em}
.ls-bar button:hover:not(:disabled){border-color:var(--border,#8886)}
.ls-bar button.on{background:var(--accent-tint,#8883);border-color:var(--border,#8886)}
.ls-bar button:disabled,.ls-bar select:disabled{opacity:.4;cursor:default}
.ls-bar .ls-sep{flex:none;width:1px;height:20px;background:var(--border,#8884);margin:0 3px}
.ls-fx{display:flex;align-items:stretch;border-bottom:1px solid var(--border,#8884);flex:none}
.ls-fx .ls-at{flex:none;width:76px;padding:4px 6px;border-right:1px solid var(--border,#8884);font-variant-numeric:tabular-nums;color:var(--muted,#888);overflow:hidden;white-space:nowrap}
.ls-fx input{flex:1;min-width:0;font:inherit;padding:4px 8px;border:0;background:none;color:inherit;outline:none}
.ls-note{display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--border,#8884);background:var(--note-bg,#f0c04022);flex:none}
.ls-note.ls-ro{background:var(--warn-bg,#e0606022)}
.ls-note span{flex:1}
.ls-note button{font:inherit;font-size:12px;padding:2px 8px;border:1px solid var(--border,#8886);border-radius:4px;background:none;color:inherit;cursor:pointer}
.ls-scroll{flex:1;min-height:0;overflow:auto;position:relative;outline:none;background:var(--bg,#fff);overscroll-behavior:contain}
.ls-size{position:absolute;left:0;top:0;pointer-events:none}
.ls-layer{position:absolute;left:0;top:0}
.ls-c{position:absolute;box-sizing:border-box;padding:0 4px;border-right:1px solid var(--border-soft,#8883);border-bottom:1px solid var(--border-soft,#8883);overflow:hidden;white-space:nowrap;line-height:21px;cursor:cell;user-select:none;-webkit-user-select:none}
.ls-c.ls-num{text-align:right;font-variant-numeric:tabular-nums}
.ls-c.ls-mid{text-align:center}
.ls-c.ls-err{color:var(--err,#c33)}
.ls-c.ls-wrap{white-space:pre-wrap;line-height:1.3}
.ls-c.ls-stale::after{content:"";position:absolute;right:1px;top:1px;border:4px solid transparent;border-top-color:var(--muted,#888);border-right-color:var(--muted,#888)}
.ls-h{position:absolute;box-sizing:border-box;background:var(--surface,#8881);border-right:1px solid var(--border,#8884);border-bottom:1px solid var(--border,#8884);color:var(--muted,#888);text-align:center;line-height:23px;font-size:12px;user-select:none;-webkit-user-select:none;cursor:default;overflow:hidden}
.ls-h.ls-on{color:var(--text,inherit);background:var(--accent-tint,#8883);font-weight:600}
.ls-cols,.ls-rows,.ls-corner{position:sticky;z-index:3;height:0;width:0}
.ls-cols{top:0;left:0}
.ls-rows{left:0;top:0}
.ls-corner{left:0;top:0;z-index:4}
.ls-corner div{position:absolute;left:0;top:0;width:${HDR_W}px;height:${HDR_H}px;box-sizing:border-box;background:var(--surface,#8881);border-right:1px solid var(--border,#8884);border-bottom:1px solid var(--border,#8884)}
.ls-colhold{position:absolute;top:0;left:0;height:${HDR_H}px;background:var(--bg,#fff)}
.ls-rowhold{position:absolute;top:0;left:0;width:${HDR_W}px;background:var(--bg,#fff)}
.ls-grip{position:absolute;top:0;width:7px;height:${HDR_H}px;cursor:col-resize;z-index:1}
.ls-sel{position:absolute;box-sizing:border-box;background:var(--sel,#4a7c5922);pointer-events:none;z-index:1}
.ls-cur{position:absolute;box-sizing:border-box;border:2px solid var(--accent,#4a7c59);pointer-events:none;z-index:2}
.ls-ed{position:absolute;z-index:5;box-sizing:border-box;font:inherit;line-height:20px;padding:0 3px;margin:0;border:2px solid var(--accent,#4a7c59);background:var(--bg,#fff);color:var(--text,inherit);outline:none;resize:none;overflow:hidden;white-space:pre}
.ls-ed.ls-idle{opacity:0;pointer-events:none;width:2px!important;height:2px!important;border:0;padding:0}
.ls-tabs{display:flex;gap:2px;align-items:center;padding:3px 6px;border-top:1px solid var(--border,#8884);overflow-x:auto;flex:none;scrollbar-width:thin}
.ls-tabs button{flex:none;font:inherit;font-size:12px;padding:3px 10px;border:1px solid transparent;border-radius:4px;background:none;color:var(--muted,#888);cursor:pointer;white-space:nowrap}
.ls-tabs button.on{color:var(--text,inherit);border-color:var(--border,#8886);background:var(--surface,#8881);font-weight:600}
.ls-menu{position:fixed;z-index:50;min-width:170px;padding:4px;border:1px solid var(--border,#8886);border-radius:6px;background:var(--bg,#fff);box-shadow:0 4px 16px #0003}
.ls-menu button{display:block;width:100%;text-align:left;font:inherit;font-size:13px;padding:6px 10px;border:0;border-radius:4px;background:none;color:inherit;cursor:pointer}
.ls-menu button:hover{background:var(--accent-tint,#8883)}
`;
let baseIn = false;
function installBase() {
  if (baseIn) return;
  baseIn = true;
  const s = document.createElement('style');
  s.textContent = BASE_CSS;
  document.head.append(s);
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

//  opts: text, editable, name, cur(), onChange(), onText(text), onRefuse(msg)
export function mount(host, opts = {}) {
  const text = String(opts.text ?? '');
  const book = new Book(text);
  if (book.error) return { error: 'The spreadsheet editor cannot open this page (' + book.error + '), so it shows as XML.' };
  installBase();
  host.replaceChildren();

  const ctl = {};
  let base = text, dirty = false, syncTimer = 0;
  let cur = 0;                         // the sheet in front
  let ar = 0, ac = 0, fr = 0, fc = 0;  // selection: anchor and focus
  let editing = false, editFrom = '';  // the cell editor is open, and where from
  let wanted = opts.editable !== false;
  const big = text.length > BIG;
  const locked = () => !wanted || big || book.doc.tracked;
  let clip = null;                     // what lattice last copied, to paste formulas

  // ── the frame ──────────────────────────────────────────────────────────
  const bar = el('div', 'ls-bar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Spreadsheet');
  const notes = el('div');
  const fx = el('div', 'ls-fx');
  const at = el('div', 'ls-at');
  const fxIn = el('input');
  fxIn.setAttribute('aria-label', 'Cell content');
  fxIn.spellcheck = false;
  fxIn.autocomplete = 'off';
  fx.append(at, fxIn);
  const scroll = el('div', 'ls-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'grid');
  const size = el('div', 'ls-size');
  const corner = el('div', 'ls-corner');
  corner.append(el('div'));
  const colsBox = el('div', 'ls-cols'), colHold = el('div', 'ls-colhold');
  const rowsBox = el('div', 'ls-rows'), rowHold = el('div', 'ls-rowhold');
  colsBox.append(colHold);
  rowsBox.append(rowHold);
  const layer = el('div', 'ls-layer');
  const selBox = el('div', 'ls-sel'), curBox = el('div', 'ls-cur');
  const ed = el('textarea', 'ls-ed ls-idle');
  ed.setAttribute('aria-label', 'Cell editor');
  ed.spellcheck = false;
  ed.autocapitalize = 'off';
  ed.rows = 1;
  scroll.append(corner, colsBox, rowsBox, size, layer, selBox, curBox, ed);
  const tabs = el('div', 'ls-tabs');
  tabs.setAttribute('role', 'tablist');
  host.append(bar, notes, fx, scroll, tabs);

  ctl.say = (msg, ro) => {
    const n = el('div', 'ls-note' + (ro ? ' ls-ro' : ''));
    n.append(el('span', '', msg));
    if (!ro) { const x = el('button', '', 'OK'); x.onclick = () => n.remove(); n.append(x); setTimeout(() => n.remove(), 9000); }
    notes.replaceChildren(...[...notes.children].filter((c) => c.classList.contains('ls-ro')), n);
  };
  if (big) ctl.say('This spreadsheet is large, so lattice shows it without editing. Open it in LibreOffice through a mount to change it.', true);
  else if (book.doc.tracked) ctl.say('This spreadsheet records changes, which lattice cannot keep, so it is shown without editing.', true);

  // ── geometry ───────────────────────────────────────────────────────────
  let nRows = 0, nCols = 0;            // how much of the sheet the scroller covers
  let colX = [0], rowY = [0];          // edges: colX[c] is where column c starts
  const sheet = () => book.sheets[cur];

  function measure() {
    const sh = sheet();
    const [er, ec] = book.extent(cur);
    nRows = Math.min(MAX_ROWS, Math.max(er + 60, fr + 40, nRows && curMeasured === cur ? nRows : 0, 120));
    nCols = Math.min(MAX_COLS, Math.max(ec + 12, fc + 8, nCols && curMeasured === cur ? nCols : 0, 30));
    curMeasured = cur;
    colX = new Array(nCols + 1);
    let x = 0, c = 0;
    for (const col of sh.cols) {
      const w = Math.max((col.st && book.styles.colWidth(col.st)) || COL_W, 12);
      for (let i = 0; i < col.rep && c < nCols; i++, c++) { colX[c] = x; x += w; }
      if (c >= nCols) break;
    }
    for (; c < nCols; c++) { colX[c] = x; x += COL_W; }
    colX[nCols] = x;
    rowY = new Array(nRows + 1);
    let y = 0, r = 0;
    for (const row of sh.rows) {
      const st = row.attrs.find(([k]) => k === 'table:style-name');
      const h = Math.max((st && book.styles.rowHeight(st[1])) || ROW_H, ROW_H);
      for (let i = 0; i < row.rep && r < nRows; i++, r++) { rowY[r] = y; y += h; }
      if (r >= nRows) break;
    }
    for (; r < nRows; r++) { rowY[r] = y; y += ROW_H; }
    rowY[nRows] = y;
    size.style.width = (x + HDR_W) + 'px';
    size.style.height = (y + HDR_H) + 'px';
    colHold.style.width = (x + HDR_W) + 'px';
    rowHold.style.height = (y + HDR_H) + 'px';
  }
  let curMeasured = -1;
  //  the index whose span holds a pixel offset
  const seek = (edges, n, px) => {
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (edges[mid] <= px) lo = mid; else hi = mid - 1; }
    return lo;
  };

  // ── painting ───────────────────────────────────────────────────────────
  let win = '';
  function paint(force) {
    const top = scroll.scrollTop, left = scroll.scrollLeft;
    const r1 = seek(rowY, nRows, top), r2 = Math.min(nRows - 1, seek(rowY, nRows, top + scroll.clientHeight) + 1);
    const c1 = seek(colX, nCols, left), c2 = Math.min(nCols - 1, seek(colX, nCols, left + scroll.clientWidth) + 1);
    const key = `${cur}:${r1}:${r2}:${c1}:${c2}`;
    if (!force && key === win) return;
    win = key;
    const frag = document.createDocumentFragment();
    const sh = sheet();
    //  walk the row runs once to the first visible row, then along
    let ri = 0, rAt = 0;
    while (ri < sh.rows.length && rAt + sh.rows[ri].rep <= r1) rAt += sh.rows[ri++].rep;
    for (let r = r1; r <= r2; r++) {
      while (ri < sh.rows.length && rAt + sh.rows[ri].rep <= r) rAt += sh.rows[ri++].rep;
      const row = sh.rows[ri];
      let ci = 0, cAt = 0;
      for (let c = c1; c <= c2; c++) {
        let cell = null;
        if (row) {
          while (ci < row.cells.length && cAt + row.cells[ci].rep <= c) cAt += row.cells[ci++].rep;
          cell = row.cells[ci] || null;
        }
        if (cell && cell.covered) continue;
        const d = el('div', 'ls-c');
        let w = colX[c + 1] - colX[c], h = rowY[r + 1] - rowY[r];
        if (cell && (cell.cs > 1 || cell.rs > 1)) {
          w = colX[Math.min(c + cell.cs, nCols)] - colX[c];
          h = rowY[Math.min(r + cell.rs, nRows)] - rowY[r];
          d.style.zIndex = '1';
          d.style.background = 'var(--bg,#fff)';
        }
        d.style.left = (colX[c] + HDR_W) + 'px';
        d.style.top = (rowY[r] + HDR_H) + 'px';
        d.style.width = w + 'px';
        d.style.height = h + 'px';
        d.dataset.r = r;
        d.dataset.c = c;
        if (cell && (cell.text || cell.st || cell.vt)) {
          const look = book.look(cur, r, c);
          if (cell.text) d.textContent = cell.text;
          if (cell.err) d.classList.add('ls-err');
          const align = look.align || (cell.err ? 'center' : cell.vt && cell.vt !== 'string' ? (cell.vt === 'boolean' ? 'center' : 'right') : '');
          if (align === 'right') d.classList.add('ls-num');
          else if (align === 'center') d.classList.add('ls-mid');
          if (look.bold) d.style.fontWeight = '700';
          if (look.italic) d.style.fontStyle = 'italic';
          if (look.underline || look.strike) d.style.textDecoration = (look.underline ? 'underline ' : '') + (look.strike ? 'line-through' : '');
          if (look.color) d.style.color = look.color;
          if (look.bg) d.style.background = look.bg;
          if (look.wrap || cell.text.includes('\n')) d.classList.add('ls-wrap');
          if (cell.f && book.stale(cur, r, c)) { d.classList.add('ls-stale'); d.title = 'Not recalculated in lattice. LibreOffice will compute it.'; }
        } else if (!cell || !cell.st) {
          const look = row ? book.look(cur, r, c) : null;
          if (look && look.bg) d.style.background = look.bg;
        }
        frag.append(d);
      }
    }
    layer.replaceChildren(frag);
    //  headers
    const [sr1, sr2, sc1, sc2] = box();
    const ch = document.createDocumentFragment();
    for (let c = c1; c <= c2; c++) {
      const h = el('div', 'ls-h' + (c >= sc1 && c <= sc2 ? ' ls-on' : ''), colName(c));
      h.style.left = (colX[c] + HDR_W) + 'px';
      h.style.top = '0';
      h.style.width = (colX[c + 1] - colX[c]) + 'px';
      h.style.height = HDR_H + 'px';
      h.dataset.col = c;
      const g = el('div', 'ls-grip');
      g.style.left = (colX[c + 1] + HDR_W - 4) + 'px';
      g.dataset.grip = c;
      ch.append(h, g);
    }
    colHold.replaceChildren(ch);
    const rh = document.createDocumentFragment();
    for (let r = r1; r <= r2; r++) {
      const h = el('div', 'ls-h' + (r >= sr1 && r <= sr2 ? ' ls-on' : ''), String(r + 1));
      h.style.left = '0';
      h.style.top = (rowY[r] + HDR_H) + 'px';
      h.style.width = HDR_W + 'px';
      h.style.height = (rowY[r + 1] - rowY[r]) + 'px';
      h.dataset.row = r;
      rh.append(h);
    }
    rowHold.replaceChildren(rh);
    place();
  }

  //  the selection as [r1, r2, c1, c2]
  const box = () => [Math.min(ar, fr), Math.max(ar, fr), Math.min(ac, fc), Math.max(ac, fc)];
  //  the rectangle of the active cell, a merged one whole
  function cellRect(r, c) {
    const cell = book.cell(cur, r, c);
    const r2 = Math.min(r + (cell.rs || 1), nRows), c2 = Math.min(c + (cell.cs || 1), nCols);
    return [colX[c] + HDR_W, rowY[r] + HDR_H, colX[c2] - colX[c], rowY[r2] - rowY[r]];
  }
  function place() {
    const [r1, r2, c1, c2] = box();
    const many = r1 !== r2 || c1 !== c2;
    selBox.style.display = many ? '' : 'none';
    if (many) {
      selBox.style.left = (colX[c1] + HDR_W) + 'px';
      selBox.style.top = (rowY[r1] + HDR_H) + 'px';
      selBox.style.width = (colX[Math.min(c2 + 1, nCols)] - colX[c1]) + 'px';
      selBox.style.height = (rowY[Math.min(r2 + 1, nRows)] - rowY[r1]) + 'px';
    }
    const [x, y, w, h] = cellRect(ar, ac);
    curBox.style.left = x + 'px';
    curBox.style.top = y + 'px';
    curBox.style.width = (w + 1) + 'px';
    curBox.style.height = (h + 1) + 'px';
    if (!editing) { ed.style.left = x + 'px'; ed.style.top = y + 'px'; }
  }

  function refresh() {
    measure();
    paint(true);
    bars();
  }

  //  the formula bar, the address box and the toolbar follow the selection
  function bars() {
    const [r1, r2, c1, c2] = box();
    at.textContent = colName(ac) + (ar + 1) + (r1 !== r2 || c1 !== c2 ? ':' + colName(fc) + (fr + 1) : '');
    if (document.activeElement !== fxIn && !editing) fxIn.value = book.input(cur, ar, ac);
    fxIn.readOnly = locked();
    const look = book.look(cur, ar, ac);
    for (const b of bar.querySelectorAll('[data-look]')) b.classList.toggle('on', b.dataset.val ? look[b.dataset.look] === b.dataset.val : !!look[b.dataset.look]);
    for (const b of bar.querySelectorAll('button,select')) if (!b.dataset.always) b.disabled = locked();
    const kind = book.styles.dataKind(look.data);
    fmtSel.value = kind || (look.data && book.styles.data.has(look.data) && book.styles.data.get(look.data).name === 'number:number-style' && look.data !== 'N0' ? 'number' : 'general');
    undoB.disabled = locked() || !book.history.length;
    redoB.disabled = locked() || !book.future.length;
  }

  function select(r, c, extend) {
    r = Math.max(0, Math.min(r, MAX_ROWS - 1));
    c = Math.max(0, Math.min(c, MAX_COLS - 1));
    //  a covered cell selects the merged cell over it
    if (!extend) {
      const sh = sheet();
      const cell = book.cell(cur, r, c);
      if (cell.covered) {
        find: for (let rr = r; rr >= Math.max(0, r - 200); rr--) {
          for (let cc = c; cc >= Math.max(0, c - 200); cc--) {
            const m = book.cell(cur, rr, cc);
            if (!m.covered && rr + m.rs > r && cc + m.cs > c) { r = rr; c = cc; break find; }
          }
        }
      }
      void sh;
    }
    fr = r; fc = c;
    if (!extend) { ar = r; ac = c; }
    if (r >= nRows - 2 || c >= nCols - 2) { measure(); win = ''; }
    reveal(r, c);
    paint(true);
    bars();
  }
  function reveal(r, c) {
    const x = colX[c], y = rowY[r], w = colX[c + 1] - x, h = rowY[r + 1] - y;
    const vw = scroll.clientWidth - HDR_W, vh = scroll.clientHeight - HDR_H;
    if (x < scroll.scrollLeft) scroll.scrollLeft = x;
    else if (x + w > scroll.scrollLeft + vw) scroll.scrollLeft = x + w - vw;
    if (y < scroll.scrollTop) scroll.scrollTop = y;
    else if (y + h > scroll.scrollTop + vh) scroll.scrollTop = y + h - vh;
  }

  // ── changes ────────────────────────────────────────────────────────────
  function changed() {
    dirty = true;
    clearTimeout(syncTimer);
    if (opts.onText) syncTimer = setTimeout(flush, 300);
    if (opts.onChange) opts.onChange();
  }
  //  run an edit as one undo step, then show it
  function edit(fn) {
    if (locked()) return false;
    const steps = book.history.length;
    const before = book.text();
    book.mark();
    let r;
    //  an edit that throws part way is taken back whole: the book goes
    //  back to the text it had, and the undo step made for it is dropped
    try { r = fn(); } catch (e) {
      if (book.history.length > steps) book.history.pop();
      book.load(before);
      ctl.say('That change could not be made, so nothing was changed.');
      refresh();
      return false;
    }
    if (r && r.error) {
      //  nothing was changed: drop the undo mark made for it
      if (book.history.length && book.history[book.history.length - 1] === book.text()) book.history.pop();
      ctl.say(r.error);
      refresh();
      return false;
    }
    changed();
    refresh();
    return true;
  }

  // ── the cell editor ────────────────────────────────────────────────────
  function openEd(initial, from) {
    if (locked() || book.cell(cur, ar, ac).covered) return;
    editing = true;
    editFrom = from || 'cell';
    reveal(ar, ac);
    const [x, y, w, h] = cellRect(ar, ac);
    ed.classList.remove('ls-idle');
    ed.style.left = x + 'px';
    ed.style.top = y + 'px';
    ed.style.minWidth = (w + 1) + 'px';
    ed.style.height = (h + 1) + 'px';
    ed.value = initial ?? book.input(cur, ar, ac);
    fxIn.value = ed.value;
    fit();
    if (from !== 'bar') { ed.focus(); ed.setSelectionRange(ed.value.length, ed.value.length); }
  }
  function fit() {
    ed.style.width = Math.min(Math.max(ed.value.length * 8 + 16, parseFloat(ed.style.minWidth) || COL_W), 600) + 'px';
    const lines = ed.value.split('\n').length;
    if (lines > 1) ed.style.height = (lines * 20 + 6) + 'px';
  }
  function closeEd(commit, dr = 0, dc = 0, quiet = false) {
    if (!editing) return true;
    const val = editFrom === 'bar' ? fxIn.value : ed.value;
    editing = false;
    ed.classList.add('ls-idle');
    ed.value = '';
    let ok = true;
    if (commit && val !== book.input(cur, ar, ac)) ok = edit(() => book.enter(cur, ar, ac, val));
    if (ok && (dr || dc)) select(ar + dr, ac + dc);
    else { bars(); paint(true); }
    if (!quiet) focusGrid();
    return ok;
  }
  const touch = () => matchMedia('(pointer: coarse)').matches;
  //  the hidden editor holds the focus, so a typed or composed character
  //  lands in it and opens it. On a phone that would raise the keyboard on
  //  every tap, so there the grid itself takes the focus.
  function focusGrid() { if (touch()) scroll.focus({ preventScroll: true }); else ed.focus({ preventScroll: true }); }

  ed.addEventListener('input', () => {
    if (!editing) {
      if (locked()) { ed.value = ''; return; }
      const typed = ed.value;
      openEd(typed);
    }
    fxIn.value = ed.value;
    fit();
  });
  ed.addEventListener('compositionstart', () => { if (!editing && !locked()) openEd(''); });
  fxIn.addEventListener('focus', () => { if (!editing && !locked()) { editing = true; editFrom = 'bar'; } });
  fxIn.addEventListener('input', () => { if (editing && editFrom === 'bar') { /* the bar is the editor */ } });
  fxIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); editing = true; editFrom = 'bar'; closeEd(true, 1, 0); }
    else if (e.key === 'Escape') { e.preventDefault(); editing = false; fxIn.value = book.input(cur, ar, ac); focusGrid(); }
    else if (e.key === 'Tab') { e.preventDefault(); editing = true; editFrom = 'bar'; closeEd(true, 0, e.shiftKey ? -1 : 1); }
  });
  fxIn.addEventListener('blur', () => { if (editing && editFrom === 'bar') { editing = true; closeEd(true); } });

  // ── keyboard ───────────────────────────────────────────────────────────
  const page = () => Math.max(1, Math.floor((scroll.clientHeight - HDR_H) / ROW_H) - 1);
  function key(e) {
    if (e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (editing) {
      if (e.key === 'Enter' && !e.altKey && !mod) { e.preventDefault(); closeEd(true, e.shiftKey ? -1 : 1, 0); }
      else if (e.key === 'Enter') { e.preventDefault(); const s = ed.selectionStart; ed.setRangeText('\n', s, ed.selectionEnd, 'end'); ed.dispatchEvent(new Event('input')); }
      else if (e.key === 'Tab') { e.preventDefault(); closeEd(true, 0, e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeEd(false); }
      return;
    }
    const mv = (dr, dc) => { e.preventDefault(); select(fr + dr, fc + dc, e.shiftKey); };
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      else if (k === 'b') { e.preventDefault(); toggle('bold'); }
      else if (k === 'i') { e.preventDefault(); toggle('italic'); }
      else if (k === 'u') { e.preventDefault(); toggle('underline'); }
      else if (k === 'a') { e.preventDefault(); const [r, c] = book.extent(cur); ar = 0; ac = 0; fr = Math.max(r - 1, 0); fc = Math.max(c - 1, 0); paint(true); bars(); }
      else if (e.key === 'Home') { e.preventDefault(); select(0, 0, e.shiftKey); }
      else if (e.key === 'End') { e.preventDefault(); const [r, c] = book.extent(cur); select(Math.max(r - 1, 0), Math.max(c - 1, 0), e.shiftKey); }
      return;
    }
    switch (e.key) {
      case 'ArrowUp': mv(-1, 0); break;
      case 'ArrowDown': mv(1, 0); break;
      case 'ArrowLeft': mv(0, -1); break;
      case 'ArrowRight': mv(0, 1); break;
      case 'PageUp': mv(-page(), 0); break;
      case 'PageDown': mv(page(), 0); break;
      case 'Home': e.preventDefault(); select(fr, 0, e.shiftKey); break;
      case 'End': e.preventDefault(); select(fr, Math.max(book.extent(cur)[1] - 1, 0), e.shiftKey); break;
      case 'Tab': e.preventDefault(); select(ar, ac + (e.shiftKey ? -1 : 1)); break;
      case 'Enter': e.preventDefault(); select(ar + (e.shiftKey ? -1 : 1), ac); break;
      case 'F2': e.preventDefault(); openEd(); break;
      case 'Delete': case 'Backspace': e.preventDefault(); clear(); break;
      case 'Escape': clip = null; break;
      default:
        //  the grid has the focus (a phone, or after a click on it): a
        //  typed character opens the editor with it
        if (e.target === scroll && e.key.length === 1 && !e.altKey) { e.preventDefault(); openEd(e.key); }
    }
  }
  scroll.addEventListener('keydown', key);

  function clear() {
    const [r1, r2, c1, c2] = box();
    edit(() => {
      const [er, ec] = book.extent(cur);
      for (let r = r1; r <= Math.min(r2, er - 1); r++) {
        for (let c = c1; c <= Math.min(c2, ec - 1); c++) {
          const cell = book.cell(cur, r, c);
          if ((cell.vt || cell.f) && !cell.covered) book.enter(cur, r, c, '');
        }
      }
      return null;
    });
  }
  function undo() { if (!locked() && book.undo()) { changed(); refresh(); } }
  function redo() { if (!locked() && book.redo()) { changed(); refresh(); } }
  function toggle(prop, val) {
    const [r1, r2, c1, c2] = box();
    const now = book.look(cur, ar, ac)[prop];
    const want = val ? (now === val ? null : val) : !now;
    const [er, ec] = book.extent(cur);
    edit(() => book.format(cur, r1, c1, Math.min(r2, Math.max(er, r1 + 200)), Math.min(c2, Math.max(ec, c1 + 50)), { [prop]: want }));
  }

  // ── the pointer ────────────────────────────────────────────────────────
  let drag = null, lastDown = null;
  //  the cell under a pointer event, from where it is and not from what
  //  it hit: a press repaints the cells, so by the release (and so for a
  //  click or a double click) the element pressed is gone
  const hit = (e) => {
    const box0 = scroll.getBoundingClientRect();
    const x = e.clientX - box0.left, y = e.clientY - box0.top;
    if (x < HDR_W || y < HDR_H || x > scroll.clientWidth || y > scroll.clientHeight) return null;
    const px = x + scroll.scrollLeft - HDR_W, py = y + scroll.scrollTop - HDR_H;
    if (px >= colX[nCols] || py >= rowY[nRows]) return null;
    return [seek(rowY, nRows, py), seek(colX, nCols, px)];
  };
  scroll.addEventListener('pointerdown', (e) => {
    if (e.button > 0 && e.button !== 2) return;
    const grip = e.target.dataset && e.target.dataset.grip;
    if (grip !== undefined && !locked()) {
      e.preventDefault();
      const c = +grip, x0 = e.clientX, w0 = colX[c + 1] - colX[c];
      const move = (m) => { const w = Math.max(20, w0 + m.clientX - x0); ed.dataset.w = w; };
      const up = (m) => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        const w = Math.max(20, w0 + m.clientX - x0);
        if (Math.abs(w - w0) > 2) { book.mark(); book.resize(cur, 'c', c, w); changed(); refresh(); }
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      return;
    }
    const col = e.target.dataset && e.target.dataset.col, row = e.target.dataset && e.target.dataset.row;
    if (col !== undefined || row !== undefined) {
      if (editing && !closeEd(true)) return;
      const [er, ec] = book.extent(cur);
      if (col !== undefined) { ar = 0; ac = +col; fr = Math.max(er - 1, 0); fc = +col; } else { ar = +row; ac = 0; fr = +row; fc = Math.max(ec - 1, 0); }
      paint(true);
      bars();
      if (e.button === 2 || e.pointerType === 'touch') menu(e, col !== undefined ? 'c' : 'r', col !== undefined ? +col : +row);
      e.preventDefault();
      focusGrid();
      return;
    }
    if (e.target === ed && editing) return;      // a click inside the open editor
    const h = hit(e);
    if (!h) return;
    if (editing && !closeEd(true)) return;
    if (e.button === 2) {
      const [r1, r2, c1, c2] = box();
      if (h[0] < r1 || h[0] > r2 || h[1] < c1 || h[1] > c2) select(h[0], h[1]);
      return;
    }
    //  a second press on the same cell soon after the first is a double
    //  click. The browser's own dblclick never comes: the press repaints
    //  the cells, and a click whose pressed element is gone is not sent.
    const now = Date.now();
    const twice = lastDown && now - lastDown.t < 450 && lastDown.r === h[0] && lastDown.c === h[1] && !e.shiftKey;
    lastDown = twice ? null : { t: now, r: h[0], c: h[1] };
    select(h[0], h[1], e.shiftKey);
    if (twice) { e.preventDefault(); openEd(); return; }
    if (e.pointerType !== 'touch') {
      drag = true;
      e.preventDefault();
      ed.focus({ preventScroll: true });
    }
  });
  scroll.addEventListener('pointermove', (e) => {
    if (!drag || !(e.buttons & 1)) { drag = null; return; }
    const h = hit(e);
    if (h && (h[0] !== fr || h[1] !== fc)) { fr = h[0]; fc = h[1]; paint(true); bars(); }
  });
  //  on the window, since a drag can end outside the grid. Taken off again
  //  in destroy: left on, every mount kept its book and its undo history
  //  alive for the life of the page.
  const dragEnd = () => { drag = null; };
  addEventListener('pointerup', dragEnd);

  scroll.addEventListener('contextmenu', (e) => {
    const col = e.target.dataset && e.target.dataset.col, row = e.target.dataset && e.target.dataset.row;
    if (col !== undefined) { e.preventDefault(); menu(e, 'c', +col); } else if (row !== undefined) { e.preventDefault(); menu(e, 'r', +row); } else if (hit(e)) { e.preventDefault(); menu(e, 'cell'); }
  });
  let raf = 0;
  scroll.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      //  near the edge: the sheet goes on
      if (scroll.scrollTop + scroll.clientHeight > rowY[nRows] - 200 && nRows < MAX_ROWS) { nRows = Math.min(MAX_ROWS, nRows + 100); measure(); }
      if (scroll.scrollLeft + scroll.clientWidth > colX[nCols] - 200 && nCols < MAX_COLS) { nCols = Math.min(MAX_COLS, nCols + 20); measure(); }
      paint();
    });
  }, { passive: true });

  // ── rows and columns ───────────────────────────────────────────────────
  function shift(dim, where, n) {
    if (editing && !closeEd(true)) return;
    edit(() => book.shift(cur, dim, where, n));
  }
  let openMenu = null;
  function menu(e, kind, idx) {
    if (openMenu) openMenu.remove();
    if (locked()) return;
    const [r1, r2, c1, c2] = box();
    const m = el('div', 'ls-menu');
    const item = (label, fn) => { const b = el('button', '', label); b.onclick = () => { m.remove(); openMenu = null; fn(); }; m.append(b); };
    const nr = r2 - r1 + 1, nc = c2 - c1 + 1;
    const rows = (n) => (n === 1 ? 'row' : n + ' rows'), cols = (n) => (n === 1 ? 'column' : n + ' columns');
    if (kind !== 'c') {
      item(`Insert ${rows(nr)} above`, () => shift('r', r1, nr));
      item(`Insert ${rows(nr)} below`, () => shift('r', r2 + 1, nr));
      item(`Delete ${rows(nr)}`, () => shift('r', r1, -nr));
    }
    if (kind !== 'r') {
      item(`Insert ${cols(nc)} left`, () => shift('c', c1, nc));
      item(`Insert ${cols(nc)} right`, () => shift('c', c2 + 1, nc));
      item(`Delete ${cols(nc)}`, () => shift('c', c1, -nc));
    }
    void idx;
    document.body.append(m);
    const x = Math.min(e.clientX, innerWidth - 190), y = Math.min(e.clientY, innerHeight - m.offsetHeight - 8);
    m.style.left = Math.max(4, x) + 'px';
    m.style.top = Math.max(4, y) + 'px';
    openMenu = m;
    setTimeout(() => addEventListener('pointerdown', function away(ev) {
      if (m.contains(ev.target)) return;
      m.remove();
      if (openMenu === m) openMenu = null;
      removeEventListener('pointerdown', away, true);
    }, true), 0);
  }

  // ── copy and paste ─────────────────────────────────────────────────────
  function copyOut(e, cut) {
    if (editing) return;
    const [r1, r2, c1, c2] = box();
    const rows = [];
    const cells = [];
    for (let r = r1; r <= Math.min(r2, r1 + 5000); r++) {
      const line = [];
      for (let c = c1; c <= Math.min(c2, c1 + 500); c++) {
        const cell = book.cell(cur, r, c);
        line.push(cell.text.replace(/[\t\n]/g, ' '));
        cells.push({ r, c, f: cell.f, vt: cell.vt, v: cell.v, text: cell.text, cur: cell.cur });
      }
      rows.push(line.join('\t'));
    }
    const tsv = rows.join('\n');
    e.clipboardData.setData('text/plain', tsv);
    e.preventDefault();
    clip = { tsv, r1, c1, cells, sheet: cur };
    if (cut) clear();
  }
  function pasteIn(e) {
    if (editing || locked()) return;
    const t = e.clipboardData.getData('text/plain');
    if (t === '') return;
    e.preventDefault();
    const [r1, , c1] = box();
    edit(() => {
      if (clip && clip.tsv === t.replace(/\r/g, '')) {
        //  lattice's own copy: formulas come along, their references moved
        for (const k of clip.cells) {
          const r = r1 + (k.r - clip.r1), c = c1 + (k.c - clip.c1);
          if (r < MAX_ROWS && c < MAX_COLS && !book.cell(cur, r, c).covered) book.copyCell(k, cur, r, c);
        }
        return null;
      }
      const lines = t.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').slice(0, 5000);
      let err = null;
      lines.forEach((line, i) => line.split('\t').slice(0, 500).forEach((v, j) => {
        const r = r1 + i, c = c1 + j;
        if (r >= MAX_ROWS || c >= MAX_COLS || book.cell(cur, r, c).covered) return;
        //  pasted text is data: a leading = from outside is not run
        const res = book.enter(cur, r, c, v[0] === '=' ? "'" + v : v);
        if (res.error) err = res;
      }));
      return err && lines.length === 1 ? err : null;
    });
  }
  scroll.addEventListener('copy', (e) => copyOut(e, false));
  scroll.addEventListener('cut', (e) => { if (!locked()) copyOut(e, true); });
  scroll.addEventListener('paste', pasteIn);

  // ── toolbar ────────────────────────────────────────────────────────────
  const btn = (label, title, fn, attrs = {}) => {
    const b = el('button', '', label);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    Object.assign(b.dataset, attrs);
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => { if (editing && !closeEd(true)) return; fn(); focusGrid(); };
    bar.append(b);
    return b;
  };
  const sep = () => bar.append(el('span', 'ls-sep'));
  const undoB = btn('↶', 'Undo', undo);
  const redoB = btn('↷', 'Redo', redo);
  sep();
  btn('B', 'Bold', () => toggle('bold'), { look: 'bold' }).style.fontWeight = '700';
  btn('I', 'Italic', () => toggle('italic'), { look: 'italic' }).style.fontStyle = 'italic';
  btn('U', 'Underline', () => toggle('underline'), { look: 'underline' }).style.textDecoration = 'underline';
  sep();
  btn('⇤', 'Align left', () => toggle('align', 'left'), { look: 'align', val: 'left' });
  btn('↔', 'Align centre', () => toggle('align', 'center'), { look: 'align', val: 'center' });
  btn('⇥', 'Align right', () => toggle('align', 'right'), { look: 'align', val: 'right' });
  sep();
  const fmtSel = el('select');
  fmtSel.title = 'Number format';
  fmtSel.setAttribute('aria-label', 'Number format');
  for (const [v, label] of [['general', 'General'], ['number', '1,234.00'], ['percent', 'Percent'], ['currency', 'Currency'], ['date', 'Date'], ['time', 'Time']]) {
    const o = el('option', '', label);
    o.value = v;
    fmtSel.append(o);
  }
  fmtSel.onchange = () => {
    const [r1, r2, c1, c2] = box();
    const [er, ec] = book.extent(cur);
    edit(() => book.format(cur, r1, c1, Math.min(r2, Math.max(er, r1 + 200)), Math.min(c2, Math.max(ec, c1 + 50)), { number: fmtSel.value }));
    focusGrid();
  };
  bar.append(fmtSel);
  sep();
  btn('+ row', 'Insert a row below', () => { const [, r2] = box(); shift('r', r2 + 1, 1); });
  btn('+ col', 'Insert a column to the right', () => { const [, , , c2] = box(); shift('c', c2 + 1, 1); });
  btn('− row', 'Delete the selected rows', () => { const [r1, r2] = box(); shift('r', r1, -(r2 - r1 + 1)); });
  btn('− col', 'Delete the selected columns', () => { const [, , c1, c2] = box(); shift('c', c1, -(c2 - c1 + 1)); });
  sep();
  //  the spreadsheet out as a file: .ods for LibreOffice, .csv of this sheet
  const save = (blob, ext) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = String(opts.name || 'spreadsheet').split('/').pop() + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  };
  btn('.ods', 'Download as an .ods file', () => { const e = exportOds(book.text()); if (e.error) ctl.say(e.error); else save(e.blob, '.ods'); }, { always: '1' });
  btn('.csv', 'Download this sheet as a .csv file', () => {
    const e = exportCsv(book.text(), cur);
    if (e.error) ctl.say(e.error); else save(new Blob([e.text], { type: 'text/csv' }), '.csv');
  }, { always: '1' });

  // ── sheets ─────────────────────────────────────────────────────────────
  function drawTabs() {
    tabs.replaceChildren();
    book.sheets.forEach((sh, i) => {
      const b = el('button', i === cur ? 'on' : '', sh.name);
      b.setAttribute('role', 'tab');
      b.onclick = () => { if (editing && !closeEd(true)) return; show(i); };
      tabs.append(b);
    });
    if (!locked()) {
      const add = el('button', '', '+');
      add.title = 'Add a sheet';
      add.setAttribute('aria-label', 'Add a sheet');
      add.onclick = () => {
        if (editing && !closeEd(true)) return;
        book.mark();
        const r = book.addSheet('');
        if (r.error) return ctl.say(r.error);
        changed();
        show(r.sheet);
      };
      tabs.append(add);
    }
  }
  function show(i) {
    cur = Math.max(0, Math.min(i, book.sheets.length - 1));
    ar = ac = fr = fc = 0;
    nRows = nCols = 0;
    scroll.scrollTop = scroll.scrollLeft = 0;
    drawTabs();
    refresh();
    focusGrid();
  }
  const refreshAll = refresh;
  refresh = () => { if (cur >= book.sheets.length) cur = book.sheets.length - 1; drawTabs(); refreshAll(); };

  // ── the shell's side ───────────────────────────────────────────────────
  ctl.book = book;
  ctl.text = () => book.text();
  ctl.base = () => base;
  //  the model's text into the shell's buffer. The timer calls this 300 ms
  //  after a change, and it leaves an open cell editor alone: what is
  //  being typed is not in the model yet.
  function flush() {
    clearTimeout(syncTimer);
    if (!dirty || (opts.cur && opts.cur() !== base)) return true;
    dirty = false;
    const t = book.text();
    if (t !== base && opts.onText) opts.onText(base = t);
    return true;
  }
  //  the shell calls this before a save, a tab switch or a park: what is
  //  being typed is committed first, so it is not lost
  ctl.sync = () => {
    if (editing) closeEd(true, 0, 0, true);
    return flush();
  };
  ctl.setEditable = (on) => { wanted = !!on; if (!wanted && editing) closeEd(false); drawTabs(); bars(); };
  ctl.focus = () => focusGrid();
  ctl.select = (s, r, c) => { if (s !== cur) show(s); select(r, c); };
  //  the outline's nth entry is the nth sheet
  ctl.heading = (i) => show(i);
  ctl.destroy = () => {
    clearTimeout(syncTimer);
    if (ro) ro.disconnect();
    removeEventListener('pointerup', dragEnd);
    if (openMenu) openMenu.remove();
    host.replaceChildren();
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => paint(true)) : null;
  if (ro) ro.observe(scroll);
  drawTabs();
  refreshAll();
  return ctl;
}

// ── a spreadsheet as a document to look at ───────────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SHOW_ROWS = 500, SHOW_COLS = 50, SHOW_SHEETS = 20;

//  +render: a self-contained HTML document of the sheets' cached values,
//  or null when the text is not a spreadsheet. Every string is escaped
//  and the styles are built from parsed values, so nothing of the file's
//  own markup reaches the page. For the preview pane and for printing.
export function render(text, print = false) {
  const book = new Book(String(text ?? ''));
  if (book.error) return null;
  let body = '';
  book.sheets.slice(0, SHOW_SHEETS).forEach((sh, s) => {
    const [rows, cols] = book.extent(s);
    const R = Math.min(rows, SHOW_ROWS), C = Math.min(cols, SHOW_COLS);
    body += `<h3>${esc(sh.name)}</h3>`;
    if (!R || !C) { body += '<p class="n">Empty sheet.</p>'; return; }
    body += '<table><tbody>';
    for (let r = 0; r < R; r++) {
      body += '<tr>';
      for (let c = 0; c < C; c++) {
        const cell = book.cell(s, r, c);
        if (cell.covered) continue;
        const look = book.look(s, r, c);
        let css = '';
        const align = look.align || (cell.err ? 'center' : cell.vt && cell.vt !== 'string' ? (cell.vt === 'boolean' ? 'center' : 'right') : '');
        if (align && align !== 'left') css += `text-align:${align};`;
        if (look.bold) css += 'font-weight:700;';
        if (look.italic) css += 'font-style:italic;';
        if (look.underline) css += 'text-decoration:underline;';
        if (look.color) css += `color:${look.color};`;
        if (look.bg) css += `background:${look.bg};`;
        const span = (cell.cs > 1 ? ` colspan="${Math.min(cell.cs, C - c)}"` : '') + (cell.rs > 1 ? ` rowspan="${Math.min(cell.rs, R - r)}"` : '');
        body += `<td${span}${css ? ` style="${css}"` : ''}>${esc(cell.text).replace(/\n/g, '<br>')}</td>`;
      }
      body += '</tr>';
    }
    body += '</tbody></table>';
    if (rows > R || cols > C) body += `<p class="n">${rows > R ? `${rows - R} more rows` : ''}${rows > R && cols > C ? ' and ' : ''}${cols > C ? `${cols - C} more columns` : ''} not shown.</p>`;
  });
  if (book.sheets.length > SHOW_SHEETS) body += `<p class="n">${book.sheets.length - SHOW_SHEETS} more sheets not shown.</p>`;
  const css = 'body{font:13px/1.4 system-ui,sans-serif;margin:12px;color:#1a1a1a;background:#fff}'
    + 'h3{font-size:14px;margin:16px 0 6px}table{border-collapse:collapse}'
    + 'td{border:1px solid #8886;padding:2px 6px;white-space:pre-wrap;vertical-align:top;min-width:2em;height:1.4em}'
    + '.n{color:#888;font-size:12px}'
    + (print ? '@page{margin:12mm}h3{break-after:avoid}tr{break-inside:avoid}' : '@media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#e6e6e6}}');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body class="fods">${body}</body></html>`;
}

//  every cell's text and every sheet's name, for search
export function fodsText(text) {
  const book = new Book(String(text ?? ''));
  if (book.error) return '';
  const out = [];
  book.sheets.forEach((sh) => {
    out.push(sh.name);
    let n = 0;
    for (const row of sh.rows) {
      for (const cell of row.cells) if (cell.text && n++ < 200000) out.push(cell.text);
    }
  });
  return out.join('\n');
}
//  the sheets, as the outline lists them: [{ level, text }]
export function fodsOutline(text) {
  const book = new Book(String(text ?? ''));
  return book.error ? [] : book.sheets.map((sh) => ({ level: 1, text: sh.name }));
}

export { toUser, rowCount };
