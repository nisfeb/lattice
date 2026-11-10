//  view.js: the scad page's 3D pane. The viewer, the customizer, the
//  console and the export buttons, over one runner.
//
//  The shell (ui-src/lattice/26-scad.js) mounts it and hands it the page's
//  text. It renders after a pause in typing, keeps the last good part on
//  screen while the next one renders, and stops a render nobody wants any
//  more. A customizer change is drawn at once with -D while a slider moves,
//  and written into the source line, through the shell, when it is let go.

import { makeRunner } from './runner.js';
import { parseStl, MAX_TRIS } from './stl.js';
import { collect } from './includes.js';
import { parseParams, rewriteLine, defineArg, fmtValue } from './customizer.js';
import { makeViewer } from './viewer.js';

const STYLE = `
.lscad{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg);color:var(--text);font:13px/1.45 var(--font,system-ui,sans-serif)}
.lscad-bar{display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:5px 8px;border-bottom:1px solid var(--border-soft,#8884)}
.lscad-bar button{font:inherit;padding:3px 10px;border:1px solid var(--border,#8886);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.lscad-bar button:hover{border-color:var(--green,var(--accent,#1a6ed8))}
.lscad-bar button[aria-pressed=true]{border-color:var(--green,var(--accent,#1a6ed8));color:var(--green,var(--accent,#1a6ed8))}
.lscad-bar button:disabled{opacity:.4;cursor:default}
.lscad-st{flex:1;min-width:8em;color:var(--muted,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lscad-st.err{color:var(--err,#c0392b)}
.lscad-main{position:relative;flex:1;min-height:160px}
.lscad-main canvas{position:absolute;inset:0;width:100%;height:100%;display:block;outline:none}
.lscad-dims{position:absolute;left:8px;bottom:6px;font-size:12px;color:var(--muted,#888);pointer-events:none;font-variant-numeric:tabular-nums}
.lscad-busy{position:absolute;right:8px;top:6px;font-size:12px;color:var(--muted,#888);pointer-events:none}
.lscad-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:16px;text-align:center;color:var(--muted,#888)}
.lscad-msg button{font:inherit;padding:6px 14px;border:1px solid var(--border,#8886);border-radius:8px;background:transparent;color:var(--text);cursor:pointer}
.lscad details{border-top:1px solid var(--border-soft,#8884)}
.lscad summary{cursor:pointer;padding:5px 8px;color:var(--muted,#888);user-select:none}
.lscad-params{max-height:45%;overflow:auto}
.lscad-params[open]{flex:none}
.lscad-pg{margin:2px 8px 8px}
.lscad-pg h4{margin:6px 0 2px;font-size:12px;font-weight:600;color:var(--muted,#888);text-transform:uppercase;letter-spacing:.03em}
.lscad-p{display:grid;grid-template-columns:minmax(7em,30%) 1fr auto;gap:2px 8px;align-items:center;padding:3px 0}
.lscad-p label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lscad-p .d{grid-column:1/-1;font-size:12px;color:var(--muted,#888);margin-top:-2px}
.lscad-p input[type=range]{width:100%;accent-color:var(--green,var(--accent,#1a6ed8))}
.lscad-p input[type=number],.lscad-p input[type=text],.lscad-p select{font:inherit;color:inherit;background:transparent;border:1px solid var(--border,#8886);border-radius:5px;padding:2px 5px;min-width:0;color-scheme:inherit}
.lscad-p input[type=number]{width:6em}
.lscad-p .v{font-variant-numeric:tabular-nums;min-width:3em;text-align:right}
.lscad-con pre{margin:0;padding:4px 8px 8px;max-height:30vh;overflow:auto;font:12px/1.4 var(--mono,ui-monospace,monospace);white-space:pre-wrap}
.lscad-con .e{color:var(--err,#c0392b)}.lscad-con .w{color:#b8860b}
.lscad-con a{color:inherit;text-decoration:underline;cursor:pointer}
@media (max-width:820px){.lscad-p{grid-template-columns:1fr auto}.lscad-p input[type=range]{grid-column:1/-1}}
`;

let styled = false;
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const leaf = (name) => (name || 'part').split('/').pop();
const mm = (v) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2)).replace(/\.?0+$/, '');

function download(name, data, type) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 10000);
}

//  opts: { runtime: { wasm, js }, text, name, editable, readPage(name),
//    onEdit(line, newText, oldText) -> bool, onJump(line), onSnapshot(png),
//    askFirst: text or '' (ask before the first download, on a phone) }
export function mount(host, opts) {
  if (!styled) { styled = true; const s = document.createElement('style'); s.textContent = STYLE; document.head.append(s); }
  const o = { ...opts };
  const root = el('div', 'lscad');
  const bar = el('div', 'lscad-bar');
  const st = el('span', 'lscad-st', '');
  const btn = (t, title, on) => { const b = el('button', '', t); b.type = 'button'; b.title = title; b.onclick = on; bar.append(b); return b; };
  bar.append(st);
  const bFit = btn('Fit', 'Fit the part in the view (double click the view too)', () => vw && vw.fit());
  const bSmooth = btn('Smooth', 'Smooth or flat shading', () => {
    const on = bSmooth.getAttribute('aria-pressed') !== 'true';
    bSmooth.setAttribute('aria-pressed', String(on));
    if (vw) vw.setSmooth(on);
  });
  bSmooth.setAttribute('aria-pressed', 'false');
  const bStl = btn('STL', 'Download the part as STL', () => exportAs('stl'));
  const b3mf = btn('3MF', 'Download the part as 3MF', () => exportAs('3mf'));
  const bPng = btn('PNG', 'Download a PNG of this view', () => { if (vw) download(leaf(o.name) + '.png', vw.snapshot()); });
  const bSnap = o.onSnapshot ? btn('Save view', 'Save a PNG of this view as a page beside this one', () => { if (vw) o.onSnapshot(vw.snapshot()); }) : null;
  const main = el('div', 'lscad-main');
  const canvas = el('canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D view of the part. Drag to turn it, scroll to zoom.');
  const dims = el('div', 'lscad-dims');
  const busy = el('div', 'lscad-busy');
  const msg = el('div', 'lscad-msg');
  msg.hidden = true;
  main.append(canvas, dims, busy, msg);
  const params = el('details', 'lscad-params');
  const psum = el('summary', '', 'Customizer');
  const pbody = el('div');
  params.append(psum, pbody);
  params.open = true;
  const con = el('details', 'lscad-con');
  const csum = el('summary', '', 'Console');
  const cpre = el('pre');
  con.append(csum, cpre);
  root.append(bar, main, params, con);
  host.replaceChildren(root);

  const vw = makeViewer(canvas);
  //  the theme's background, light or dark, from what the pane paints
  const dark = () => {
    const c = (getComputedStyle(root).backgroundColor.match(/[\d.]+/g) || []).map(Number);
    if (c.length < 3 || c[3] === 0) return matchMedia('(prefers-color-scheme: dark)').matches;
    return c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114 < 128;
  };
  if (vw) vw.setDark(dark());
  else { msg.hidden = false; msg.textContent = 'This browser cannot draw 3D (no WebGL). Export still works.'; }

  const runner = makeRunner(o.runtime);
  let text = o.text || '', ps = [], defs = new Map(), job = null, timer = 0, busyT = 0, seq = 0;
  let lastKey = null, lastStl = null, asked = !o.askFirst, dead = false, pending = false, jobAt = 0;
  const setSt = (t, bad) => { st.textContent = t; st.className = 'lscad-st' + (bad ? ' err' : ''); st.title = t; };

  //  ── console ──
  function showLog(log, notes) {
    cpre.replaceChildren();
    let errs = 0, warns = 0;
    const lines = (notes || []).map((n) => [1, 'WARNING: ' + n]).concat(log || []);
    for (const [, s] of lines) {
      if (/^Could not initialize localization/.test(s)) continue;
      const line = el('div');
      const e = /^ERROR/.test(s), w = /^WARNING/.test(s);
      if (e) { line.className = 'e'; errs++; } else if (w) { line.className = 'w'; warns++; }
      const m = /in file ([^,]+), line (\d+)/.exec(s);
      if (m && m[1] === mainFile() && o.onJump) {
        const at = s.indexOf(m[0]);
        const a = el('a', '', 'line ' + m[2]);
        a.onclick = () => o.onJump(Number(m[2]) - 1);
        line.append(s.slice(0, at), a, s.slice(at + m[0].length));
      } else line.textContent = s;
      cpre.append(line);
    }
    csum.textContent = 'Console' + (errs ? ` (${errs} error${errs > 1 ? 's' : ''})` : warns ? ` (${warns} warning${warns > 1 ? 's' : ''})` : '');
    if (errs) con.open = true;
    return errs;
  }
  const mainFile = () => '/w/' + (o.name || 'untitled') + '.scad';

  //  ── customizer ──
  function paintParams() {
    const keep = document.activeElement && pbody.contains(document.activeElement) ? document.activeElement.dataset.p : null;
    pbody.replaceChildren();
    params.hidden = !ps.length;
    if (!ps.length) return;
    psum.textContent = 'Customizer (' + ps.length + ')';
    const groups = new Map();
    for (const p of ps) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); }
    const global = groups.get('Global') || [];
    for (const [g, list] of groups) {
      if (g === 'Global' && groups.size > 1) continue;
      const box = el('div', 'lscad-pg');
      if (groups.size > 1 || g !== 'Parameters') box.append(el('h4', '', g));
      for (const p of (g === 'Global' ? list : list.concat(global))) box.append(row(p));
      pbody.append(box);
    }
    if (keep) { const f = pbody.querySelector(`[data-p="${CSS.escape(keep)}"]`); if (f) f.focus(); }
  }
  function row(p) {
    const r = el('div', 'lscad-p');
    const id = 'lscad-' + p.name;
    const lab = el('label', '', p.name.replace(/_/g, ' '));
    lab.htmlFor = id; lab.title = p.name;
    const cur = defs.has(p.name) ? defs.get(p.name) : p.value;
    let f, v = el('span', 'v');
    if (p.type === 'boolean') {
      f = el('input'); f.type = 'checkbox'; f.checked = !!cur;
      f.onchange = () => commit(p, f.checked);
    } else if (p.options) {
      f = el('select');
      p.options.forEach((op, i) => { const x = el('option', '', op.name); x.value = String(i); if (op.value === cur) x.selected = true; f.append(x); });
      f.onchange = () => commit(p, p.options[Number(f.value)].value);
    } else if (p.type === 'number' && !Array.isArray(p.value) && p.min !== undefined && p.max !== undefined && p.max > p.min) {
      f = el('input'); f.type = 'range'; f.min = p.min; f.max = p.max; f.step = p.step || 1; f.value = cur;
      v.textContent = fmtValue(cur, p.step);
      f.oninput = () => { const x = Number(f.value); v.textContent = fmtValue(x, p.step); live(p, x); };
      f.onchange = () => commit(p, Number(f.value));
    } else if (p.type === 'number' && !Array.isArray(p.value)) {
      f = el('input'); f.type = 'number'; f.step = p.step || 'any'; f.value = cur;
      f.onchange = () => { const x = Number(f.value); if (Number.isFinite(x)) commit(p, x); };
    } else if (Array.isArray(p.value)) {
      f = el('input'); f.type = 'text'; f.value = fmtValue(cur);
      f.onchange = () => { const x = f.value.replace(/^\[|\]$/g, '').split(',').map((s) => Number(s.trim())); if (x.length === p.value.length && x.every(Number.isFinite)) commit(p, x); else f.value = fmtValue(cur); };
    } else {
      f = el('input'); f.type = 'text'; f.value = cur; if (p.maxLength) f.maxLength = p.maxLength;
      f.onchange = () => commit(p, f.value);
    }
    f.id = id; f.dataset.p = p.name;
    r.append(lab, f, v);
    if (p.description) r.append(el('div', 'd', p.description));
    return r;
  }
  //  a slider moving: draw it with -D, write nothing yet
  function live(p, x) { defs.set(p.name, x); schedule(90); }
  //  a value settled: write the line when the page may be written, else
  //  keep it as a -D for this view only
  function commit(p, x) {
    defs.set(p.name, x);
    if (o.editable && o.onEdit) {
      const lines = text.split('\n');
      const old = lines[p.line];
      const nl = old === undefined ? null : rewriteLine(old, p, x);
      if (nl === null || !o.onEdit(p.line, nl, old)) {
        setSt('that line changed since it was read, so it was not written', true);
      }
    }
    schedule(0);
  }

  //  ── rendering ──
  function key() { return text + '\0' + JSON.stringify([...defs]); }
  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(render, ms);
  }
  async function render() {
    if (dead) return;
    if (!asked) { askNow(); return; }
    const k = key();
    if (k === lastKey && lastStl) return;
    //  a render under way finishes first when it is young, so a slider
    //  being dragged keeps drawing. One that has run a while is stopped:
    //  its text is stale and the new one may be quicker.
    if (job && performance.now() - jobAt < 1500) { pending = true; return; }
    if (job) job.cancel();
    pending = false;
    jobAt = performance.now();
    const my = ++seq;
    clearTimeout(busyT);
    busyT = setTimeout(() => { busy.textContent = 'rendering…'; }, 150);
    const inc = await collect(o.name || 'untitled', text, o.readPage || (async () => null));
    if (my !== seq) return;
    const args = [mainFile(), '-o', '/out.stl', '--export-format', 'binstl'];
    for (const [n, x] of defs) { const p = ps.find((q) => q.name === n); if (p) args.push('-D', defineArg(p, x)); }
    job = runner.run({ files: inc.files, args, out: '/out.stl', timeout: o.timeout });
    const r = await job.promise;
    if (my !== seq || r.cancelled) return;
    job = null;
    if (pending) { pending = false; schedule(0); }
    clearTimeout(busyT); busy.textContent = '';
    const errs = showLog(r.log, inc.notes);
    if (r.timeout) { setSt(`stopped: the render ran past ${Math.round((o.timeout || 60000) / 1000)} s`, true); return; }
    if (r.rc !== 0 || !r.data) {
      setSt(errs ? 'OpenSCAD reported an error, see the console' : 'no part: the model made nothing to draw', true);
      if (errs) con.open = true;
      return;
    }
    const m = parseStl(r.data);
    if (m.error) { setSt(m.error, true); return; }
    lastKey = k; lastStl = r.data;
    msg.hidden = true;
    if (vw) vw.setMesh(m, { keepView: true });
    dims.textContent = m.tris
      ? `${mm(m.max[0] - m.min[0])} × ${mm(m.max[1] - m.min[1])} × ${mm(m.max[2] - m.min[2])} mm · ${m.tris.toLocaleString()} triangles`
      : 'empty';
    setSt(`rendered in ${(r.ms / 1000).toFixed(1)} s`);
  }
  function askNow() {
    msg.hidden = false;
    msg.replaceChildren(el('div', '', o.askFirst));
    const b = el('button', '', 'Draw it');
    b.onclick = () => { asked = true; msg.hidden = true; if (o.onAsked) o.onAsked(); render(); };
    msg.append(b);
  }

  async function exportAs(fmt) {
    if (fmt === 'stl' && lastStl && lastKey === key()) { download(leaf(o.name) + '.stl', lastStl, 'model/stl'); return; }
    setSt('making the ' + fmt.toUpperCase() + '…');
    const inc = await collect(o.name || 'untitled', text, o.readPage || (async () => null));
    const out = '/out.' + fmt;
    const args = [mainFile(), '-o', out, '--export-format', fmt === 'stl' ? 'binstl' : '3mf'];
    for (const [n, x] of defs) { const p = ps.find((q) => q.name === n); if (p) args.push('-D', defineArg(p, x)); }
    const r = await runner.run({ files: inc.files, args, out, timeout: o.timeout }).promise;
    if (r.rc !== 0 || !r.data) { showLog(r.log, inc.notes); setSt('could not make the ' + fmt.toUpperCase(), true); return; }
    if (fmt === 'stl' && r.data.length > 84 + MAX_TRIS * 50 * 4) { setSt('the part is too large to export here', true); return; }
    download(leaf(o.name) + '.' + fmt, r.data, fmt === 'stl' ? 'model/stl' : 'model/3mf');
    setSt(fmt.toUpperCase() + ' downloaded');
  }

  function update(t, more = {}) {
    Object.assign(o, more);
    if (more.name !== undefined || more.editable !== undefined) {
      if (bSnap) bSnap.disabled = !o.editable;
    }
    if (t === text && !more.force) return;
    const was = text;
    text = t;
    ps = parseParams(text);
    //  a -D whose value the source now holds is done with; a parameter
    //  that went away takes its -D with it
    for (const [n, x] of [...defs]) {
      const p = ps.find((q) => q.name === n);
      if (!p || fmtValue(p.value, p.step) === fmtValue(x, p.step)) defs.delete(n);
    }
    paintParams();
    schedule(was === '' ? 0 : 350);
  }

  if (bSnap) bSnap.disabled = !o.editable;
  update(text, { force: true });
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onScheme = () => vw && vw.setDark(dark());
  mq.addEventListener('change', onScheme);
  return {
    update,
    render: () => schedule(0),
    setDark: (on) => vw && vw.setDark(on),
    retheme: () => vw && vw.setDark(dark()),
    params: () => ps.slice(),
    mesh: () => (vw ? vw.mesh() : null),
    destroy() {
      dead = true;
      clearTimeout(timer); clearTimeout(busyT);
      if (job) job.cancel();
      mq.removeEventListener('change', onScheme);
      if (vw) vw.destroy();
      host.replaceChildren();
    },
  };
}
