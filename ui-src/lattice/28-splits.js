  // ── splits: tab groups side by side ─────────────────────────────────────
  // The center is a split tree of tab groups. A leaf is a group, whose tabs
  // 21-tabs.js keeps; a split is { d, k, s }: its children `k` side by side
  // (d 'r') or stacked (d 'd'), each taking its share of the sizes `s`. Any
  // group splits right or down, with no cap, as long as both halves keep a
  // group's least size (GMIN_W across, GMIN_H down). A split that would go
  // under it is refused, and its buttons are disabled with a tooltip that
  // says why.
  //
  // Each group is a section placed absolutely in #groot at its fractions of
  // the tree, so a group never moves in the page: a moved frame reloads,
  // and a group's tool host holds frames. Only the live editor (#glive:
  // the tab header, the link conflict bar and the document area) moves,
  // into the group in front. Every other group shows its front tab parked:
  // its own <lat-editor ghost>, painted from the tab's snap (or the tree's
  // copy of the page), with its own header. A click into one brings its
  // group to the front (gFocus, 21-tabs.js), and a click into its text
  // puts the caret where the click was.
  //
  // Keys: Ctrl+\ splits right, Ctrl+Shift+\ splits down, Ctrl+Shift+] and
  // Ctrl+Shift+[ bring the next and the previous group to the front (by
  // e.code, in the capture phase, so vim never sees them and a keyboard
  // layout's shifted character does not matter). Browsers keep none of
  // these, and vim's own Ctrl+[ (Escape) is unshifted.
  //
  // On a phone (the 820px block) one group shows at a time, the one in
  // front, and the tabs sheet switches groups (97-mobar.js).
  const GMIN_W = 360, GMIN_H = 200;
  let sroot = null;
  const groot = $('groot');
  const glive = $('glive');
  const isG = (n) => !!n && Array.isArray(n.tabs);

  // ── the tree ─────────────────────────────────────────────────────────
  function parentOf(x, n = sroot) {
    if (!n || isG(n)) return null;
    for (const c of n.k) {
      if (c === x) return n;
      const p = parentOf(x, c);
      if (p) return p;
    }
    return null;
  }
  function replaceNode(old, nu) {
    if (sroot === old) { sroot = nu; return; }
    const p = parentOf(old);
    if (p) p.k[p.k.indexOf(old)] = nu;
  }
  const leaves = (n = sroot) => (!n ? [] : isG(n) ? [n] : n.k.flatMap((c) => leaves(c)));
  // `ng` beside `target`: after it, or before it, in direction `dir`. A
  // split already running that way takes it as one more child, halving
  // the target's share; anything else becomes a new split of the two.
  function splitInsert(target, ng, dir, before = false) {
    const p = parentOf(target);
    if (p && p.d === dir) {
      const i = p.k.indexOf(target);
      const half = p.s[i] / 2;
      p.s[i] = half;
      p.k.splice(i + (before ? 0 : 1), 0, ng);
      p.s.splice(i + (before ? 0 : 1), 0, half);
      return;
    }
    replaceNode(target, { d: dir, k: before ? [ng, target] : [target, ng], s: [1, 1] });
  }
  // a group out of the tree: its share goes to the neighbour before it (or
  // after), and a split left with one child is that child
  function splitRemove(g) {
    const p = parentOf(g);
    if (!p) { if (sroot === g) sroot = null; return; }
    const i = p.k.indexOf(g);
    const j = i > 0 ? i - 1 : 1;
    p.s[j] += p.s[i];
    p.k.splice(i, 1);
    p.s.splice(i, 1);
    if (p.k.length === 1) replaceNode(p, p.k[0]);
  }
  // the group that takes the front when `g` closes: the nearest one in
  // the tree, the one before it first
  function gNeighbor(g) {
    const p = parentOf(g);
    if (p) {
      const i = p.k.indexOf(g);
      const sib = p.k[i - 1] || p.k[i + 1];
      const ls = leaves(sib);
      if (ls.length) return i > 0 ? ls[ls.length - 1] : ls[0];
    }
    return groups.find((x) => x !== g) || null;
  }
  // the tree for appTabs (21-tabs.js): a group is its index in `groups`
  const splitSave = () => {
    const enc = (n) => (isG(n) ? groups.indexOf(n)
      : { d: n.d, k: n.k.map(enc), s: n.s.map((v) => Math.round(v * 1e4) / 1e4) });
    return sroot ? enc(sroot) : 0;
  };
  // a saved tree over `made`, the groups in their saved order. It must name
  // each of them exactly once, with two or more children to a split and a
  // positive size for each; false otherwise, and the caller falls back to
  // one group.
  function splitLoad(x, made) {
    const seen = new Set();
    const dec = (n, depth) => {
      if (depth > 40) return null;
      if (Number.isInteger(n)) {
        if (n < 0 || n >= made.length || seen.has(n)) return null;
        seen.add(n);
        return made[n];
      }
      if (!n || typeof n !== 'object' || (n.d !== 'r' && n.d !== 'd')
        || !Array.isArray(n.k) || !Array.isArray(n.s) || n.k.length < 2 || n.s.length !== n.k.length
        || !n.s.every((v) => typeof v === 'number' && isFinite(v) && v > 0)) return null;
      const k = [];
      for (const c of n.k) {
        const d = dec(c, depth + 1);
        if (!d) return null;
        k.push(d);
      }
      return { d: n.d, k, s: n.s.slice() };
    };
    const t = dec(x, 0);
    if (!t || seen.size !== made.length) return false;
    sroot = t;
    return true;
  }

  // ── a group's elements ───────────────────────────────────────────────
  const gBtn = (sb, icon, name, keys) => {
    const b = tip(document.createElement('button'), name, keys);
    b.type = 'button';
    b.className = 'sbtn';
    b.dataset.sb = sb;
    b.innerHTML = ico(icon);
    return b;
  };
  const SPLIT_NAME = { r: ['Split right', 'Ctrl+\\'], d: ['Split down', 'Ctrl+Shift+\\'] };
  // the parts of a group: its strip (21-tabs.js paints the tabs), its
  // parked view (the ghost: a header and an editor, hidden while the
  // group is in front) and its tool host (24-tools.js)
  function gAdd(g) {
    if (!groups.includes(g)) groups.push(g);
    const el = document.createElement('section');
    el.className = 'tgroup';
    el.dataset.g = g.id;
    el.setAttribute('aria-label', 'Tab group');
    const strip = document.createElement('div');
    strip.className = 'doctabs';
    const list = document.createElement('div');
    list.className = 'dtlist';
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Open documents');
    const bnew = gBtn('new', 'plus', 'New page');
    const bsr = gBtn('r', 'splitr', ...SPLIT_NAME.r);
    const bsd = gBtn('d', 'splitd', ...SPLIT_NAME.d);
    bsr.classList.add('gsplit');
    bsd.classList.add('gsplit');
    strip.append(list, bnew, bsr, bsd);
    bnew.onclick = () => { gFocus(g); tabNew(); };
    bsr.onclick = () => gSplit(g, 'r');
    bsd.onclick = () => gSplit(g, 'd');

    // the parked view. Its buttons do what the live header's do, once the
    // group is in front.
    const ghost = document.createElement('div');
    ghost.className = 'gghost';
    ghost.hidden = true;
    ghost.innerHTML =
      '<div class="tabhead ghead">'
      + sbtn('data-go="tback"', 'left', 'Back', 'Alt+Left')
      + sbtn('data-go="tfwd"', 'right', 'Forward', 'Alt+Right')
      + '<button type="button" class="tpath" data-go="tpath"></button>'
      + '<div class="tread" role="group" aria-label="Edit or Read">'
      + '<button type="button" data-go="edit" title="Edit / Read (Ctrl+E)">' + ico('pen') + 'Edit</button>'
      + '<button type="button" data-go="read" title="Edit / Read (Ctrl+E)">' + ico('eye') + 'Read</button>'
      + '</div>'
      + sbtn('data-go="tmenu" aria-haspopup="menu"', 'dots', 'Page menu')
      + '</div>'
      + '<div class="gdoc"><lat-editor ghost></lat-editor>'
      + '<div class="prevwrap"><iframe class="prev" title="preview" sandbox="allow-scripts"></iframe></div></div>';
    const host = document.createElement('div');
    host.className = 'toolhost';
    host.hidden = true;
    el.append(strip, ghost, host);
    groot.append(el);
    Object.assign(g, { el, strip, list, bnew, bsr, bsd, ghost, host,
      ghead: ghost.querySelector('.ghead'), gdoc: ghost.querySelector('.gdoc'),
      gta: ghost.querySelector('.esrc'), ghl: ghost.querySelector('.ehl'),
      gprev: ghost.querySelector('.prev'), gmemo: null });

    const LIVE = { tback: '#tback', tfwd: '#tfwd', tpath: '#tpath', tmenu: '#tmenu',
      edit: '#tread [data-r="0"]', read: '#tread [data-r="1"]' };
    for (const b of ghost.querySelectorAll('[data-go]'))
      b.onclick = () => gThen(g, () => {
        const live = document.querySelector(LIVE[b.dataset.go]);
        if (live && !live.disabled) live.click();
      });
    // a press anywhere in a group that is not in front brings it there,
    // except on its tabs, which may be starting a drag (a click on one
    // switches to it, group and all), and on the parked view, whose parts
    // say where they lead themselves
    el.addEventListener('pointerdown', (e) => {
      if (g === focusG || !e.isPrimary) return;
      if (e.target.closest('.gghost, .dtw')) return;
      gFocus(g);
    }, true);
    // the parked text: the caret goes where the press put it in the ghost
    // (readonly, so the press only selects), once the group is in front
    const ta = g.gta;
    let down = false;
    ta.addEventListener('pointerdown', () => {
      down = true;
      addEventListener('pointerup', () => {
        down = false;
        if (g !== focusG) gCaret(g, ta.selectionStart, ta.selectionEnd, ta.scrollTop);
      }, { once: true });
    });
    ta.addEventListener('focus', () => {
      if (!down && g !== focusG) gCaret(g, ta.selectionStart, ta.selectionEnd, ta.scrollTop);
    });
    ta.addEventListener('scroll', () => {
      g.ghl.scrollTop = ta.scrollTop;
      g.ghl.scrollLeft = ta.scrollLeft;
    });
    g.gdoc.querySelector('.prevwrap').addEventListener('pointerdown', () => gFocus(g));
    gDragWire(g);
    return g;
  }
  // run `fn` once `g` is in front: at once, or after the queue brings it
  const gThen = (g, fn) => {
    if (gFocus(g)) fn();
    else tabSerial(async () => {}).then(() => { if (focusG === g) fn(); });
  };
  // the caret where a press in a parked group put it. Only when the live
  // editor came up on the same text, painted from the snap: an open still
  // loading puts the caret where its own load does.
  function gCaret(g, a, b, top) {
    const body = g.gta.value;
    gThen(g, () => {
      if (!docFront() || src.value !== body) return;
      src.focus({ preventScroll: true });
      try { src.setSelectionRange(a, b); } catch {}
      src.scrollTop = top;
      sync();
    });
  }
  // a group out: out of the tree and the page. The live editor never
  // leaves the page with it (gTake puts it in the next group), and a tool
  // wrap waits in the stash (24-tools.js).
  function gDrop(g) {
    splitRemove(g);
    const i = groups.indexOf(g);
    if (i >= 0) groups.splice(i, 1);
    if (glive.parentNode === g.el) $('center').append(glive);
    for (const w of [...g.host.querySelectorAll('.intab')]) { w.hidden = true; toolStash.append(w); }
    g.el.remove();
    if (groups.includes(focusG)) splitPaint();
  }

  // ── painting ─────────────────────────────────────────────────────────
  // where everything goes: the live editor into the group in front, which
  // carries the ids (#doctabs, #tabnew, #toolhost) and the action homes,
  // the groups at their places, the handles between them, the buttons'
  // say on splitting
  function splitPaint() {
    if (!sroot && groups.length) sroot = groups[0];
    if (focusG && groups.includes(focusG) && glive.parentNode !== focusG.el) {
      const had = document.activeElement === src;
      // before the parked view, so the first .edwrap in the page is the live one
      focusG.el.insertBefore(glive, focusG.ghost);
      if (had) src.focus({ preventScroll: true });
    }
    for (const g of groups) {
      const on = g === focusG;
      g.el.classList.toggle('gfocus', on);
      for (const [el, id] of [[g.strip, 'doctabs'], [g.bnew, 'tabnew'], [g.host, 'toolhost']])
        if (on) el.id = id; else el.removeAttribute('id');
      for (const [el, a] of [[g.bnew, 'tabnew'], [g.bsr, 'splitr'], [g.bsd, 'splitd']])
        if (on) el.dataset.action = a; else delete el.dataset.action;
      delete g.el.dataset.action;
      delete g.strip.dataset.action;
    }
    // the homes of moving between groups: the group each one goes to
    const ls = leaves();
    const at = ls.indexOf(focusG);
    if (ls.length > 1 && at >= 0) {
      ls[(at + 1) % ls.length].strip.dataset.action = 'gnext';
      ls[(at - 1 + ls.length) % ls.length].el.dataset.action = 'gprev';
    }
    groot.classList.toggle('multi', groups.length > 1);
    layout();
    gPaintAll();
  }
  // each group at its fractions of the tree, and a handle on each inner
  // boundary. Handles are kept from one layout to the next, so one being
  // dragged is never replaced under the pointer.
  const handles = new Map();     // split node -> its handles
  function layout() {
    const used = new Set();
    const place = (n, x, y, w, h) => {
      if (isG(n)) {
        const s = n.el.style;
        s.left = x * 100 + '%';
        s.top = y * 100 + '%';
        s.width = w * 100 + '%';
        s.height = h * 100 + '%';
        // its share of #groot, which is how splitWhy sizes it
        n.fw = w;
        n.fh = h;
        n.el.classList.toggle('gl', x > 1e-6);
        n.el.classList.toggle('gt', y > 1e-6);
        return;
      }
      n.box = { x, y, w, h };
      const tot = n.s.reduce((a, b) => a + b, 0);
      if (!handles.has(n)) handles.set(n, []);
      const hs = handles.get(n);
      let off = 0;
      n.k.forEach((c, i) => {
        const f = n.s[i] / tot;
        if (n.d === 'r') place(c, x + off * w, y, f * w, h);
        else place(c, x, y + off * h, w, f * h);
        off += f;
        if (i === n.k.length - 1) return;
        let r = hs[i];
        if (!r) { r = document.createElement('div'); hs[i] = r; resWire(r, n, i); groot.append(r); }
        r.className = 'gres ' + n.d + (r.classList.contains('drag') ? ' drag' : '');
        const st_ = r.style;
        if (n.d === 'r') {
          Object.assign(st_, { left: (x + off * w) * 100 + '%', top: y * 100 + '%',
            height: h * 100 + '%', width: '' });
        } else {
          Object.assign(st_, { top: (y + off * h) * 100 + '%', left: x * 100 + '%',
            width: w * 100 + '%', height: '' });
        }
        used.add(r);
      });
      hs.length = n.k.length - 1;
    };
    if (sroot) place(sroot, 0, 0, 1, 1);
    for (const [n, hs] of handles) {
      for (const r of hs) if (r && !used.has(r)) r.remove();
      if (!hs.some((r) => r && used.has(r))) handles.delete(n);
    }
    splitButtons();
  }
  // the least size of a subtree along an axis: groups side by side add up,
  // stacked ones take the largest
  const minPx = (n, d) => (isG(n) ? (d === 'r' ? GMIN_W : GMIN_H)
    : n.d === d ? n.k.reduce((a, c) => a + minPx(c, d), 0) : Math.max(...n.k.map((c) => minPx(c, d))));
  // a handle between children i and i+1 of split n. A drag moves their
  // boundary, never past either side's least size; a double click shares
  // the two out evenly.
  function resWire(r, n, i) {
    r.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      r.setPointerCapture(e.pointerId);
      r.classList.add('drag');
      const box = groot.getBoundingClientRect();
      const span = n.d === 'r' ? n.box.w * box.width : n.box.h * box.height;
      const tot = n.s.reduce((a, b) => a + b, 0);
      const a0 = n.s[i], b0 = n.s[i + 1];
      const pair = ((a0 + b0) / tot) * span;
      const minA = minPx(n.k[i], n.d), minB = minPx(n.k[i + 1], n.d);
      const p0 = n.d === 'r' ? e.clientX : e.clientY;
      const move = (ev) => {
        const pa = (a0 / tot) * span + (n.d === 'r' ? ev.clientX : ev.clientY) - p0;
        if (pair < minA + minB) return;
        const ca = Math.max(minA, Math.min(pair - minB, pa));
        n.s[i] = ((a0 + b0) * ca) / pair;
        n.s[i + 1] = a0 + b0 - n.s[i];
        layout();
      };
      const up = () => {
        r.removeEventListener('pointermove', move);
        r.classList.remove('drag');
        tabsSave();
      };
      r.addEventListener('pointermove', move);
      r.addEventListener('pointerup', up, { once: true });
    });
    r.addEventListener('dblclick', () => {
      const v = (n.s[i] + n.s[i + 1]) / 2;
      n.s[i] = v;
      n.s[i + 1] = v;
      layout();
      tabsSave();
    });
  }
  // why `g` cannot split that way now, or '' when it can. A group's size
  // is its share of #groot times #groot's size as the ResizeObserver last
  // gave it, so asking never forces a layout. Measuring the group itself
  // did, and at boot that one read was the first full layout, 42 ms
  // inside the boot task. Only before the observer's first report does it
  // measure, and nothing asks then but a split attempted in that frame.
  let gsz = null;
  function splitWhy(g, dir) {
    if (!g) return 'no group';
    if (isMobile()) return 'one group at a time on a phone';
    const r = gsz && g.fw != null ? { width: g.fw * gsz.w, height: g.fh * gsz.h }
      : g.el.getBoundingClientRect();
    if (dir === 'r' && r.width < 2 * GMIN_W)
      return 'not enough room, each group needs at least ' + GMIN_W + 'px across';
    if (dir === 'd' && r.height < 2 * GMIN_H)
      return 'not enough room, each group needs at least ' + GMIN_H + 'px of height';
    return '';
  }
  function splitButtons() {
    if (!gsz) return;     // the observer's first report paints them
    for (const g of groups) {
      for (const [b, d] of [[g.bsr, 'r'], [g.bsd, 'd']]) {
        const why = splitWhy(g, d);
        const [name, keys] = SPLIT_NAME[d];
        b.disabled = !!why;
        tip(b, name, keys);
        if (why) b.title = name + ' (' + keys + '): ' + why;
      }
    }
  }
  new ResizeObserver((es) => {
    const r = es[es.length - 1].contentRect;
    gsz = { w: r.width, h: r.height };
    splitButtons();
  }).observe(groot);

  // ── the parked view ──────────────────────────────────────────────────
  // what the live editor showed a tab as it let go of it, so its group
  // paints exactly that: the highlighted text and the preview's document
  function gGhostKeep(t) {
    t.ghost = { body: src.value, hl: hl.innerHTML,
      prev: prev.getAttribute('srcdoc'), psrc: prev.getAttribute('src') };
  }
  // a tab's text when no snap holds it: the tree's copy of a page, or the
  // ship's, fetched once and painted when it lands. null: none (a grub,
  // which shows when its group comes to the front).
  function gCache(t) {
    if (t.kind === 'page') {
      if (!t.key) return '';
      const n = nodes.find((x) => x.page && x.path === t.key);
      if (n && typeof n.body === 'string') return n.body;
    }
    if (t.kind === 'know' && !t.key) return '';
    if (typeof t.gbody === 'string') return t.gbody;
    if (!t.key || t.kind === 'grub' || t.gfetch) return null;
    t.gfetch = true;
    const { key, kind } = t;
    const url = t.kind === 'know' ? api + '/know-read?key=' + encodeURIComponent(t.key)
      : api + '/page-source?name=' + encodeURIComponent(t.key);
    fetch(url).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (t.key !== key || t.kind !== kind) return;   // the tab took another document
      if (d && typeof d.body === 'string') { t.gbody = d.body; t.gkind = d.kind; gPaintAll(); }
    }).catch(() => {});
    return null;
  }
  const ghostHl = (body, kind) => {
    const lang = LMAP[kind];
    const g = window.Prism && lang && Prism.languages[lang];
    // the main thread, so only a short text: some grammars crawl on long
    // unterminated input (25-editor.js), which is why the live one uses a worker
    if (g && body.length <= 8000) {
      try { return Prism.highlight(body, g, lang) + '\n'; } catch {}
    }
    return esc(body) + '\n';
  };
  function gPaint(g) {
    const on = g === focusG;
    g.ghost.hidden = on;
    if (on) { g.gmemo = null; return; }
    const t = g.active;
    const k = t && TAB_KINDS[t.kind];
    const doc = !!k && !!k.live;
    // a browsing tab has its frame header instead (29-fhead.js)
    g.ghead.hidden = !!t && t.kind === 'tool' && browsing(t.key);
    const s = t && t.snap;
    const body = !doc ? null : s ? s.body : gCache(t);
    const memo = [t, s, body, t && t.read, t && t.ghost, t && t.key, t && t.back.length, t && t.fwd.length,
      t && k.label(t), t && t.key && linkRO(t.key)];
    if (g.gmemo && memo.every((v, i) => v === g.gmemo[i])) return;
    g.gmemo = memo;
    const path = g.ghead.querySelector('.tpath');
    const name = !t ? '' : doc ? ((s && s.shown) || t.key || k.label(t)) : k.label(t);
    path.textContent = name || 'no page open';
    path.classList.toggle('muted', !name);
    path.title = name;
    g.ghead.querySelector('[data-go="tback"]').disabled = !t || !t.back.length;
    g.ghead.querySelector('[data-go="tfwd"]').disabled = !t || !t.fwd.length;
    g.ghead.querySelector('.tread').hidden = !doc;
    g.ghead.querySelector('[data-go="tmenu"]').hidden = !doc;
    for (const b of g.ghead.querySelectorAll('.tread button')) {
      const p = (b.dataset.go === 'read') === !!(t && t.read);
      b.classList.toggle('on', p);
      b.setAttribute('aria-pressed', p ? 'true' : 'false');
    }
    g.gdoc.hidden = !doc;
    if (!doc) return;
    const kind = t.kind === 'know' ? 'md' : (s && (s.kind || s.pkind)) || t.gkind
      || ((nodes.find((x) => x.page && x.path === t.key) || {}).kind) || 'md';
    const ta = g.gta;
    ta.value = body === null ? '' : body;
    ta.placeholder = body === null ? 'click to show ' + k.label(t) : '';
    // a link this editor may not write to is locked in its group as well
    // as in front (linkRO, 30-tree.js)
    ta.title = t.kind === 'page' && t.key && linkRO(t.key) ? 'read-only' : '';
    g.ghl.innerHTML = t.ghost && t.ghost.body === ta.value ? t.ghost.hl : ghostHl(ta.value, kind);
    ta.scrollTop = s ? s.scroll : 0;
    g.ghl.scrollTop = ta.scrollTop;
    g.gdoc.classList.toggle('gread', !!t.read);
    if (t.read) {
      const kept = t.ghost && t.ghost.body === ta.value ? t.ghost : null;
      if (kept && kept.psrc && !kept.prev) {
        if (g.gprev.getAttribute('src') !== kept.psrc) { g.gprev.removeAttribute('srcdoc'); g.gprev.src = kept.psrc; }
      } else {
        const d = (kept && kept.prev) || ghostDoc(kind, ta.value) || '';
        if (g.gprev.getAttribute('srcdoc') !== d) { g.gprev.removeAttribute('src'); g.gprev.srcdoc = d; }
      }
    }
  }
  const gPaintAll = () => { for (const g of groups) gPaint(g); };

  // ── splitting and moving between groups ─────────────────────────────
  // a new group beside `g` with a new page in it, in front. Refused, and
  // said so, when either half would be under a group's least size.
  const gSplit = (g = focusG, dir = 'r') => tabSerial(async () => {
    if (!g || !groups.includes(g)) return false;
    const why = splitWhy(g, dir);
    if (why) { st('cannot split: ' + why, false); return false; }
    const ng = mkGroup();
    ng.tabs.push(mkTab('page', ''));
    ng.active = ng.tabs[0];
    gAdd(ng);
    splitInsert(g, ng, dir);
    if (!(await gTo(ng))) { gDrop(ng); return false; }
    src.focus();
    return true;
  });
  // tab `t` into a new group beside `g` (a drop on its edge, or the tab
  // menu). The tab is the new group's only one; a group it leaves empty
  // closes.
  async function gSplitWith(g, dir, t, before = false) {
    const why = splitWhy(g, dir);
    if (why) { st('cannot split: ' + why, false); return false; }
    const ng = mkGroup();
    gAdd(ng);
    splitInsert(g, ng, dir, before);
    splitPaint();
    const ok = await gMove(t, ng, 0);
    if (groups.includes(ng) && !ng.tabs.length) gDrop(ng);
    return ok;
  }
  function gCycle(dir) {
    const ls = leaves();
    if (ls.length < 2 || isMobile()) return;
    const i = ls.indexOf(focusG);
    const g = ls[(i + dir + ls.length) % ls.length];
    gThen(g, () => { if (docFront() && !document.querySelector('.dlg:not([hidden])')) src.focus(); });
  }

  // ── dragging a tab ───────────────────────────────────────────────────
  // A tab drags to a strip, where it goes between the tabs it is dropped
  // between, or onto a group: its middle takes it as the group's last tab,
  // and an edge (the outer quarter) splits the group that way with the tab
  // alone in the new half, where there is room for one. The live editor's
  // own drop (text into the textarea) never sees a tab.
  let dragTab = null;
  let dropEl = null;
  const TAB_MIME = 'application/x-lat-tab';
  // a drag carrying a tab of ours. The type, not only dragTab: a strip
  // repainted mid-drag detaches the tab that started it, its dragend then
  // reaches nobody, and a stale dragTab took a later text drag for a tab.
  const tabDrag = (e) => !!dragTab && !!e.dataTransfer
    && [...(e.dataTransfer.types || [])].includes(TAB_MIME);
  const dragDone = () => {
    dragTab = null;
    dropHide();
    for (const w of document.querySelectorAll('.dtw.dragging')) w.classList.remove('dragging');
  };
  for (const ev of ['dragend', 'drop']) document.addEventListener(ev, () => setTimeout(dragDone, 0), true);
  const dropHide = () => { if (dropEl) dropEl.hidden = true; };
  function dropAt(g, e) {
    const sr = g.strip.getBoundingClientRect();
    if (e.clientY <= sr.bottom) {
      const ws_ = [...g.list.children];
      let at = ws_.length;
      for (let i = 0; i < ws_.length; i++) {
        const r = ws_[i].getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) { at = i; break; }
      }
      return { g, zone: 'strip', at };
    }
    const r = g.el.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - sr.bottom) / (r.bottom - sr.bottom);
    const edge = fx < 0.25 ? ['r', true] : fx > 0.75 ? ['r', false]
      : fy < 0.25 ? ['d', true] : fy > 0.75 ? ['d', false] : null;
    if (edge && !splitWhy(g, edge[0])) return { g, zone: 'edge', dir: edge[0], before: edge[1] };
    return { g, zone: 'mid' };
  }
  function dropShow(d) {
    if (!dropEl) { dropEl = document.createElement('div'); dropEl.className = 'gdrop'; groot.append(dropEl); }
    const gr = groot.getBoundingClientRect();
    const r = d.g.el.getBoundingClientRect();
    const sr = d.g.strip.getBoundingClientRect();
    let box = { l: r.left, t: sr.bottom, w: r.width, h: r.bottom - sr.bottom };
    if (d.zone === 'strip') box = { l: sr.left, t: sr.top, w: sr.width, h: sr.height };
    else if (d.zone === 'edge') {
      if (d.dir === 'r') box = { ...box, w: box.w / 2, l: d.before ? box.l : box.l + box.w / 2 };
      else box = { ...box, h: box.h / 2, t: d.before ? box.t : box.t + box.h / 2 };
    }
    Object.assign(dropEl.style, { left: box.l - gr.left + 'px', top: box.t - gr.top + 'px',
      width: box.w + 'px', height: box.h + 'px' });
    dropEl.hidden = false;
  }
  function gDragWire(g) {
    g.list.addEventListener('dragstart', (e) => {
      const w = e.target.closest && e.target.closest('.dtw');
      const t = w && allTabs().find((x) => x.id === w.dataset.id);
      if (!t) return;
      dragTab = t;
      w.classList.add('dragging');
      try {
        e.dataTransfer.setData(TAB_MIME, t.id);
        e.dataTransfer.effectAllowed = 'move';
      } catch {}
    });
    g.list.addEventListener('dragend', dragDone);
    g.el.addEventListener('dragover', (e) => {
      if (!tabDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      try { e.dataTransfer.dropEffect = 'move'; } catch {}
      dropShow(dropAt(g, e));
    }, true);
    g.el.addEventListener('dragleave', (e) => {
      if (dragTab && !(e.relatedTarget && g.el.contains(e.relatedTarget))) dropHide();
    });
    g.el.addEventListener('drop', (e) => {
      if (!tabDrag(e)) { dragDone(); return; }
      e.preventDefault();
      e.stopPropagation();
      const t = dragTab;
      dragTab = null;
      dropHide();
      const d = dropAt(g, e);
      if (d.zone === 'edge') gSplitWith(g, d.dir, t, d.before);
      else gMove(t, g, d.zone === 'strip' ? d.at : null);
    }, true);
  }

  // ── keys and actions ─────────────────────────────────────────────────
  addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === 'Backslash') {
      e.preventDefault();
      e.stopPropagation();
      gSplit(focusG, e.shiftKey ? 'd' : 'r');
    } else if (e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
      e.preventDefault();
      e.stopPropagation();
      gCycle(e.code === 'BracketRight' ? 1 : -1);
    }
  }, true);
  action({ id: 'splitr', name: 'Split right', home: 'Tab strip', keys: 'Ctrl+\\',
    run: () => gSplit(focusG, 'r'), when: () => !splitWhy(focusG, 'r') });
  action({ id: 'splitd', name: 'Split down', home: 'Tab strip', keys: 'Ctrl+Shift+\\',
    run: () => gSplit(focusG, 'd'), when: () => !splitWhy(focusG, 'd') });
  action({ id: 'gnext', name: 'Next group', home: 'Tab group', keys: 'Ctrl+Shift+]',
    run: () => gCycle(1), when: () => groups.length > 1 && !isMobile() });
  action({ id: 'gprev', name: 'Previous group', home: 'Tab group', keys: 'Ctrl+Shift+[',
    run: () => gCycle(-1), when: () => groups.length > 1 && !isMobile() });
  // a click into a frame in a group that is not in front: the frame takes
  // the focus and this window only sees its own blur
  addEventListener('blur', () => setTimeout(() => {
    const a = document.activeElement;
    const el = a && a.tagName === 'IFRAME' && a.closest('.tgroup');
    const g = el && groups.find((x) => x.el === el);
    if (g && g !== focusG) gFocus(g);
  }, 0));
  // the phone shows the group in front alone, and splits nothing
  matchMedia('(max-width: 820px)').addEventListener('change', () => splitButtons());

  // for the browser suites
  window.latSplits = {
    split: (dir) => gSplit(focusG, dir),
    why: (dir) => splitWhy(focusG, dir),
    tree: splitSave,
    move: (id, gi, dir, before = false) => {
      const t = allTabs().find((x) => x.id === id);
      return t && groups[gi] ? gSplitWith(groups[gi], dir, t, before) : Promise.resolve(false);
    },
  };
