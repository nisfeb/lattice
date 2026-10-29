  // ── phone: drawers and the bottom bar ────────────────────────────────────
  // At phone width (the 820px block) the side panes are drawers over the
  // document. Every way into a pane opens its drawer (paneOpen, 13-frame.js:
  // the corner toggles, a pane tab's action, search), and so does a swipe in
  // from that edge. The scrim, Escape or opening a document shuts them. The
  // ribbon rides at the top of the left drawer by CSS alone, so its buttons
  // stay the one set they are.
  //
  // The bottom bar holds what a thumb reaches for most: a new page, search,
  // today's brief and the open tabs. Like the drawers it is built always and
  // shown only by the 820px block, so a resize across the breakpoint just
  // works, with no load-time isMobile branching to go stale.
  {
    const drawn = () => ws.classList.contains('ldraw') || ws.classList.contains('rdraw');
    const scrim = document.createElement('div');
    scrim.id = 'scrim';
    scrim.onclick = drawersClose;
    ws.append(scrim);
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawn()) drawersClose(); });
    // across the breakpoint the drawers start shut, and the corner toggles
    // repaint for the layout that is now showing
    matchMedia('(max-width: 820px)').addEventListener('change', drawersClose);

    // the edge swipe: it starts within EDGE px of a screen edge and travels
    // EDGE px inward, more across than down. Never while text in the editor
    // is selected, where dragging a handle to the edge means the selection.
    const EDGE = 24;
    const selecting = () => document.activeElement === src && src.selectionStart !== src.selectionEnd;
    let sw = null;
    addEventListener('touchstart', (e) => {
      sw = null;
      if (!isMobile() || e.touches.length !== 1 || drawn() || selecting()
        || document.querySelector('.dlg:not([hidden])')) return;
      const { clientX: x, clientY: y } = e.touches[0];
      const side = x <= EDGE ? 'l' : x >= innerWidth - EDGE ? 'r' : null;
      if (side) sw = { side, x, y };
    }, { passive: true });
    addEventListener('touchmove', (e) => {
      if (!sw) return;
      if (selecting()) { sw = null; return; }
      const t = e.touches[0];
      const dx = (t.clientX - sw.x) * (sw.side === 'l' ? 1 : -1);
      const dy = Math.abs(t.clientY - sw.y);
      if (dy > EDGE && dy >= dx) { sw = null; return; }   // a scroll, not a swipe
      if (dx >= EDGE && dx > dy) { const s = sw.side; sw = null; drawer(s, true); }
    }, { passive: true });
    addEventListener('touchend', () => { sw = null; }, { passive: true });

    // the open-tabs sheet: one row per tab, the tab in front marked. A row
    // switches to its tab; its x closes it, asking first as the strip's does.
    const sheet = document.createElement('div');
    sheet.id = 'mtsheet';
    sheet.className = 'mtsheet';
    sheet.setAttribute('role', 'menu');
    sheet.setAttribute('aria-label', 'Open tabs');
    sheet.hidden = true;
    const sheetPaint = () => {
      sheet.textContent = '';
      for (const t of tabs) {
        const k = TAB_KINDS[t.kind];
        const name = k.label(t);
        const row = document.createElement('div');
        row.className = 'mtrow' + (t === activeTab ? ' on' : '');
        row.dataset.key = t.key;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mtname';
        b.setAttribute('role', 'menuitem');
        b.innerHTML = ico(t.pinned ? 'pin' : typeof k.icon === 'function' ? k.icon(t) : k.icon)
          + '<span></span>';
        b.lastChild.textContent = name;
        b.onclick = () => { sheet.hidden = true; switchTab(t.id); };
        const x = tip(document.createElement('button'), 'Close ' + name);
        x.type = 'button';
        x.className = 'sbtn mtx';
        x.innerHTML = ico('x');
        x.onclick = async () => { await closeTab(t.id); if (!sheet.hidden) sheetPaint(); };
        row.append(b, x);
        sheet.append(row);
      }
    };

    // the bottom bar. Each button is its own home in the palette, listed
    // only while the bar is on screen.
    const mbar = document.createElement('nav');
    mbar.id = 'mbar';
    mbar.className = 'mbar';
    mbar.setAttribute('aria-label', 'Bottom bar');
    const mitem = (id, icon, name, run) => {
      const b = tip(document.createElement('button'), name);
      b.type = 'button';
      b.className = 'sbtn';
      b.id = id;
      b.dataset.action = id;
      b.innerHTML = ico(icon);
      b.onclick = (ev) => run(ev);
      action({ id, name, home: 'Bottom bar', run, when: isMobile });
      mbar.append(b);
      return b;
    };
    // the Files toolbar's new page does the same: newFile paints over the
    // editor, so what is unsaved there goes through guardDirty first
    mitem('mb-new', 'plus', 'New page', async () => { if (await guardDirty()) newFile(''); });
    mitem('mb-search', 'search', 'Search', () => qOpen());
    mitem('mb-brief', 'cal', "Today's brief", (ev) => openBrief(ev));
    const tabsw = mitem('mtabsw', 'tabs', 'Open tabs', () => {
      if (sheet.hidden) sheetPaint();
      sheet.hidden = !sheet.hidden;
    });
    ws.append(mbar, sheet);
    // tapping anywhere else puts the sheet away
    document.addEventListener('click', (e) => {
      if (!sheet.hidden && !sheet.contains(e.target) && !tabsw.contains(e.target)) sheet.hidden = true;
    });
    // the button carries the tab count, read off the strip it summarises
    const count = () => { tabsw.dataset.n = String(tabs.length); };
    count();
    new MutationObserver(count).observe(tabList, { childList: true });

    // the unread badge lives on the ribbon's inbox, which a phone shows
    // only with the left drawer open; mirror it onto that drawer's toggle
    const mirror = () => {
      const n = $('rb-inbox').dataset.n;
      if (n) $('treet').dataset.n = n; else delete $('treet').dataset.n;
    };
    mirror();
    new MutationObserver(mirror).observe($('rb-inbox'), { attributes: true, attributeFilter: ['data-n'] });
  }
