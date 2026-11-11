//  shell.js: the scad page's place in the editor shell, the part that is
//  not the 3D pane itself. ui-src/lattice/26-scad.js keeps app.js to the
//  least it can: it loads scad.js when a scad page shows and calls
//  follow() on every change. This file does the rest, so the editor
//  bundle every boot loads carries none of it:
//
//    - the runtime's status, from /scad-status, once a session, and from
//      the last answer when offline
//    - the bar above the document: the install offer, the update offer,
//      an install that is running
//    - mounting the 3D pane (view.js) in the preview area, and the edits
//      the customizer makes, through the textarea as typing would
//    - Save view, a PNG of the 3D view as an html page beside the model
//
//  `h` is the shell's side: the editor's state and helpers, by name.

import { mount } from './view.js';

//  the fonts the install brings, by the name the ship serves and the worker
//  keeps them under
const FONTS = ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationMono-Regular.ttf'];
const mb = (n) => (Math.round(n / 1e5) / 10) + ' MB';

export function shell(h) {
  let st = null, stP = null, ctl = null, seq = 0, noUpdate = false;
  const store = () => { try { return JSON.parse(localStorage.latScadSt || 'null'); } catch { return null; } };
  function status(fresh) {
    if (st && !fresh) return Promise.resolve(st);
    if (stP && !fresh) return stP;
    stP = fetch(h.api + '/scad-status').then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j) => { st = j; try { localStorage.latScadSt = JSON.stringify(j); } catch {} return j; })
      .catch(() => (st = store()))
      .finally(() => { stP = null; });
    return stP;
  }
  const live = () => !!(st && st.have && st.files);

  //  ── the bar ──
  const bar = document.createElement('div');
  bar.className = 'lnkcf';
  bar.id = 'scadbar';
  bar.hidden = true;
  h.$('docarea').before(bar);
  function paintBar(s) {
    bar.replaceChildren();
    bar.hidden = true;
    if (!s) return;
    const say = (t) => bar.append(Object.assign(document.createElement('span'), { textContent: t }));
    const button = (t, on) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = t; b.onclick = on;
      bar.append(' ', b);
      return b;
    };
    if (s.busy) { say('Installing the OpenSCAD runtime on your ship…'); bar.hidden = false; return; }
    if (!s.have) {
      if (!s.source) return;
      say((s.error ? 'The last install failed: ' + s.error + '. ' : '')
        + 'This is an OpenSCAD model. Install the OpenSCAD runtime on your ship ('
        + mb(s.size) + ', once) to see it in 3D.');
      button('Install', install);
      bar.hidden = false;
      return;
    }
    if (s.have !== s.pin && s.source && !noUpdate) {
      say('OpenSCAD ' + s.pin + ' is available. You have ' + s.have + '.');
      button('Update (' + mb(s.size) + ')', install);
      button('Not now', () => { noUpdate = true; bar.hidden = true; });
      bar.hidden = false;
    }
  }
  //  the ship fetches and checks the runtime in a fiber of its own; this
  //  asks for it, then waits for the fiber to end
  async function install() {
    paintBar({ busy: true });
    let r = null;
    try { r = await fetch(h.api + '/scad-install', { method: 'POST' }); } catch {}
    if (!r || !r.ok) { h.st('the install request failed' + await h.errText(r), false); st = null; follow(); return; }
    for (let i = 0; i < 120; i++) {
      await new Promise((ok) => setTimeout(ok, 1500));
      const s = await status(true);
      if (s && !s.busy) break;
    }
    if (live()) h.st('the OpenSCAD runtime is installed');
    else if (st && st.error) h.st('the install failed: ' + st.error, false);
    h.refresh();
    follow();
  }

  //  ── the pane ──
  function off() {
    const da = h.$('docarea'), wrap = da.querySelector('.prevwrap');
    da.classList.remove('scadsplit');
    if (wrap) wrap.classList.remove('scadon');
    bar.hidden = true;
    h.setLive(false);
    if (ctl) { ctl.destroy(); ctl = null; }
  }
  async function follow() {
    if (!h.here()) return off();
    const my = ++seq;
    const s = await status();
    if (my !== seq || !h.here()) return;
    paintBar(s);
    const da = h.$('docarea'), wrap = da.querySelector('.prevwrap');
    const was = h.live();
    h.setLive(live());
    if (!live() || !wrap) {
      da.classList.remove('scadsplit');
      if (wrap) wrap.classList.remove('scadon');
      if (ctl) { ctl.destroy(); ctl = null; }
      //  the source shows in the frame again
      if (was) h.refresh();
      return;
    }
    da.classList.add('scadsplit');
    wrap.classList.add('scadon');
    let host = wrap.querySelector('.scadhost');
    if (!host) { host = document.createElement('div'); host.className = 'scadhost'; wrap.append(host); }
    //  a pane nobody sees (Edit on a phone) is drawn when it shows
    if (!wrap.offsetParent) return;
    const src = h.src();
    const opts = { name: h.name(), editable: h.editable() };
    if (ctl) { ctl.update(src.value, opts); return; }
    const f = st.files;
    ctl = mount(host, {
      ...opts,
      text: src.value,
      runtime: {
        wasm: h.api + '/scad/openscad.wasm?h=' + f['openscad.wasm'],
        js: h.api + '/scad/openscad.js?h=' + f['openscad.js'],
        fonts: FONTS.filter((n) => f[n]).map((n) => [n, h.api + '/scad/' + n + '?h=' + f[n]]),
      },
      readPage,
      onEdit: edit,
      onJump: jump,
      onSnapshot: snap,
      askFirst: h.isMobile() && localStorage.latScadOk !== '1'
        ? 'Drawing this part downloads the OpenSCAD runtime from your ship, ' + mb(st.size) + ', once.' : '',
      onAsked: () => { try { localStorage.latScadOk = '1'; } catch {} },
    });
  }

  //  an include's page text, or null
  async function readPage(name) {
    const c = h.pageCache.get(name);
    if (c && typeof c.body === 'string') return c.body;
    try {
      const r = await fetch(h.api + '/page-source?name=' + encodeURIComponent(name));
      if (!r.ok) return null;
      const d = await r.json();
      return typeof d.body === 'string' ? d.body : null;
    } catch { return null; }
  }
  //  replace characters a..b of the editor's text as typing would: native
  //  undo and the input event (dirty, autosave, repaint). taskFlip in
  //  60-preview.js does the same for a task box.
  function replace(a, b, text) {
    const src = h.src();
    const wrap = src.closest('.edwrap'), hid = !!wrap && !src.offsetParent;
    const keep = wrap ? wrap.style.cssText : '';
    const had = document.activeElement === src;
    let s0 = src.selectionStart, s1 = src.selectionEnd;
    const dir = src.selectionDirection, top = src.scrollTop, left = src.scrollLeft;
    const d = text.length - (b - a);
    if (s0 >= b) s0 += d;
    if (s1 >= b) s1 += d;
    if (hid) wrap.style.cssText = keep + ';display:block;position:fixed;left:-10000px;top:0;width:400px;height:200px';
    let ok = false;
    try {
      src.focus({ preventScroll: true });
      src.setSelectionRange(a, b);
      ok = document.activeElement === src && document.execCommand('insertText', false, text);
    } catch {}
    if (!ok) src.setRangeText(text, a, b, 'preserve');
    src.setSelectionRange(s0, s1, dir);
    src.scrollTop = top; src.scrollLeft = left;
    if (hid) wrap.style.cssText = keep;
    if (!had) src.blur();
    if (!ok) h.edited();
  }
  //  the customizer's change to one line, refused when the line moved on
  function edit(line, text, old) {
    if (!h.editable()) return false;
    const src = h.src();
    const lines = src.value.split('\n');
    if (lines[line] === undefined || lines[line].replace(/\r$/, '') !== old) return false;
    let at = 0;
    for (let i = 0; i < line; i++) at += lines[i].length + 1;
    replace(at, at + old.length, text);
    return true;
  }
  //  a console line link: the editor, at that line
  function jump(line) {
    h.toEdit();
    const src = h.src();
    const lines = src.value.split('\n');
    let at = 0;
    for (let i = 0; i < line && i < lines.length; i++) at += lines[i].length + 1;
    src.focus();
    src.setSelectionRange(at, at + (lines[line] || '').length);
    const lh = parseFloat(getComputedStyle(src).lineHeight) || 20;
    src.scrollTop = Math.max(0, line * lh - src.clientHeight / 3);
  }
  //  Save view: a PNG of the 3D view, as an html page beside the model
  //  (name-view), for a thumbnail or a forum post. One save, when asked.
  async function snap(png) {
    const cur = h.current();
    if (!cur || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png)) return;
    const out = cur + '-view';
    const leaf = cur.split('/').pop().replace(/[<>&"]/g, '');
    const body = '<!-- a view of ' + leaf + '.scad, saved from its 3D pane. Saving the view again replaces it. -->\n'
      + '<img alt="' + leaf + '" src="' + png + '" style="max-width:100%">\n';
    h.stWork('saving the view…');
    const r = await h.savePage(out, 'html', body);
    if (!r || !r.ok) { h.st('could not save ' + out + await h.errText(r), false); return; }
    h.st('saved the view as ' + out);
  }

  return {
    follow,
    off,
    retheme: () => { if (ctl) ctl.retheme(); },
    status: () => st,
  };
}
