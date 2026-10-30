  // ── command palette: Ctrl/Cmd+P and the ribbon ───────────────────────────
  // An index over the homes, never a home itself (spec, principle 3). It
  // lists the actions their homes registered (13-frame.js, action()), then
  // pages and memories by name. An action row names its home and shortcut,
  // so the palette also teaches where a thing lives. Running a row does what
  // its home does: an action's run, or openIn for a document, which replaces
  // the front tab or, with Ctrl/Cmd held, opens a new one.
  //
  // Every action must have a home in the DOM: its element carries
  // data-action="<id>" (the suite checks each one). A home that is built
  // on demand is checked while its when() says it applies. PALETTE_ONLY
  // would name the exceptions, and it is empty by design.
  const PALETTE_ONLY = [];
  const pal = document.createElement('div');
  pal.id = 'palette';
  pal.className = 'dlg palette';
  pal.hidden = true;
  pal.setAttribute('role', 'dialog');
  pal.setAttribute('aria-modal', 'true');
  pal.setAttribute('aria-label', 'Command palette');
  pal.innerHTML = '<div class="dlgbox palbox">'
    + '<input id="palin" type="text" role="combobox" aria-expanded="true" aria-controls="pallist"'
    + ' aria-autocomplete="list" aria-label="Command palette" placeholder="run an action or open a page"'
    + ' autocomplete="off" spellcheck="false">'
    + '<div id="pallist" class="pallist" role="listbox" aria-label="Results"></div></div>';
  document.body.append(pal);
  const palIn = $('palin'), palList = $('pallist');
  let palRows = [];      // what is on screen: {kind, a?, key?}
  let palSel = 0;
  let palFrom = null;    // focus to hand back on close

  // Subsequence match, case-insensitive. Lower is better: the query as a
  // word start, then anywhere as one run, then spread out (tighter first).
  // null is no match.
  function palScore(q, s) {
    const t = s.toLowerCase();
    const at = t.indexOf(q);
    if (at === 0 || (at > 0 && /[^a-z0-9]/.test(t[at - 1]))) return at / 1e4;
    if (at > 0) return 1 + at / 1e4;
    let i = 0, first = -1, last = -1;
    for (let j = 0; j < t.length && i < q.length; j++) {
      if (t[j] !== q[i]) continue;
      if (first < 0) first = j;
      last = j;
      i++;
    }
    return i === q.length ? 2 + (last - first) / 1e4 : null;
  }
  // an action is listed while its home is there to use: present, not
  // hidden (a pane tab's own section does not count), not disabled. A home
  // built only while open says so itself (when).
  const palUsable = (a) => {
    if (a.when) return a.when();
    const el = actionHome(a.id);
    return !!el && !el.disabled && !el.closest('[hidden]:not([data-pane])');
  };
  const ranked = (q, items, name) => items
    .map((x, i) => ({ x, i, s: palScore(q, name(x)) }))
    .filter((r) => r.s !== null)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((r) => r.x);

  function palPaint() {
    const q = palIn.value.trim().toLowerCase();
    const acts = ACTIONS.filter(palUsable);
    palRows = (q ? ranked(q, acts, (a) => a.name) : acts).map((a) => ({ kind: 'action', a }));
    if (q) {
      const docs = nodes.filter((n) => n.page).map((n) => ({ kind: 'page', key: n.path }))
        .concat(knowKeys.map((k) => ({ kind: 'know', key: k.key.replace(/^\//, '') })));
      palRows = palRows.concat(ranked(q, docs, (d) => d.key).slice(0, 50));
    }
    palSel = 0;
    palList.textContent = '';
    palRows.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'palrow';
      row.id = 'palr' + i;
      row.setAttribute('role', 'option');
      row.dataset.kind = r.kind;
      const name = document.createElement('span');
      name.className = 'palname';
      const home = document.createElement('span');
      home.className = 'palhome muted';
      if (r.kind === 'action') {
        name.textContent = r.a.name;
        home.textContent = r.a.home;
      } else {
        row.dataset.key = r.key;
        name.textContent = r.key;
        home.textContent = r.kind === 'page' ? 'Page' : 'Memory';
      }
      row.append(name, home);
      if (r.kind === 'action' && r.a.keys) {
        const k = document.createElement('kbd');
        k.className = 'palkeys';
        k.textContent = r.a.keys;
        row.append(k);
      }
      // mousedown, so the input keeps focus until the row runs
      row.onmousedown = (e) => e.preventDefault();
      row.onclick = (e) => palRun(i, e);
      palList.append(row);
    });
    if (!palRows.length) {
      const none = document.createElement('div');
      none.className = 'muted palnone';
      none.textContent = 'nothing matches';
      palList.append(none);
    }
    palMark();
  }
  function palMark() {
    palRows.forEach((_, i) => {
      const row = $('palr' + i);
      const on = i === palSel;
      row.classList.toggle('on', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) row.scrollIntoView({ block: 'nearest' });
    });
    if (palRows.length) palIn.setAttribute('aria-activedescendant', 'palr' + palSel);
    else palIn.removeAttribute('aria-activedescendant');
  }

  function palShow() {
    if (!pal.hidden) { palIn.select(); return; }
    palFrom = document.activeElement;
    pal.hidden = false;
    palIn.value = '';
    palPaint();
    palIn.focus();
    // the memory list loads when its tab is first shown (95-know.js), and
    // the palette lists memories too
    if (!knowHave) loadKnow().then(() => { if (!pal.hidden) palPaint(); });
  }
  function palClose() {
    if (pal.hidden) return;
    pal.hidden = true;
    const f = palFrom; palFrom = null;
    if (f && f.isConnected) f.focus();
  }
  // closed first, so what the row opens (a menu, a dialog, a tab) gets
  // the focus, not the palette's leftover
  function palRun(i, ev) {
    const r = palRows[i];
    if (!r) return;
    palClose();
    if (r.kind === 'action') { r.a.run(ev); return; }
    openIn(r.kind, r.key, { ev });
    drawersClose();
  }
  paletteOpen = palShow;   // the ribbon's button (24-tools.js)

  palIn.oninput = palPaint;
  palIn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!palRows.length) return;
      palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palRows.length) % palRows.length;
      palMark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      palRun(palSel, e);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      palClose();
    }
  });
  // a click on the backdrop, outside the box, closes it
  pal.addEventListener('mousedown', (e) => { if (e.target === pal) palClose(); });

  // Ctrl/Cmd+P never reaches the print dialog. Vim keeps the chord while
  // the editor has focus, the rule Ctrl+E follows (23-tabhead.js), and an
  // open dialog is left to finish first.
  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || (e.key !== 'p' && e.key !== 'P')) return;
    e.preventDefault();
    if (localStorage.edVim === '1' && document.activeElement === src) return;
    if (!$('dlg').hidden) return;
    palShow();
  }, true);

  // for the browser suites, which cannot reach this scope
  //  `applies`: a home built on demand (a page menu item, a row's own
  //  control) says by its when() whether it is there to be found now
  window.latPalette = { ids: () => ACTIONS.map((a) => a.id), only: PALETTE_ONLY,
    applies: (id) => { const a = ACTIONS.find((x) => x.id === id); return !!a && (!a.when || !!a.when()); } };
