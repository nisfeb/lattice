  // ── the files tree's own menu, and its Delete key ───────────────────────
  // A right-click on a row, a long press on a phone, or the keyboard's menu
  // key (Shift+F10) opens a small menu for that row: a page or a folder of
  // mine, or an entry in shared with me. Nothing in it needs the row opened
  // first, and nothing changes what is open, except a delete or a move of
  // the very page that is (65-ctl.js deletePath, 75-move.js, 77-history.js).
  // Every delete in it asks first, in the same modal the page menu's does.
  //
  // What a row is comes from its tree key (treeItem, 30-tree.js): p:<path>
  // a page, f:<path> a folder, and under shared with me (SWM, 69-shared.js)
  // <SWM>/<host>/<path> an entry. The shared with me folder and its ship
  // folders are not anything to delete, so they get no menu.
  function treeTarget(row) {
    const tk = (row && row.dataset.tk) || '';
    if (tk.startsWith('p:')) return { kind: 'page', path: tk.slice(2) };
    if (tk.startsWith('f:')) return { kind: 'folder', path: tk.slice(2) };
    if (tk.startsWith(SWM + '/')) {
      const rest = tk.slice(SWM.length + 1);
      const cut = rest.indexOf('/');
      if (cut < 0) return null;
      const host = rest.slice(0, cut), path = rest.slice(cut + 1);
      const it = sharedWithMe.find((s) => s.host === host && s.path === path);
      return it ? { kind: 'swm', it } : null;
    }
    return null;
  }
  // a delete from the tree: the row's own path, confirmed (deletePath)
  function treeDelete(row) {
    const t = treeTarget(row);
    if (!t) return;
    if (t.kind === 'swm') removeShared(t.it);
    else deletePath(t.path, t.kind === 'folder');
  }
  treeList.latDel = treeDelete;

  let treeMenuEl = null;
  let treeMenuRow = null;
  let treeMenuAt = 0;
  function treeMenuClose(refocus) {
    if (!treeMenuEl) return;
    treeMenuEl.remove();
    treeMenuEl = null;
    const row = treeMenuRow;
    treeMenuRow = null;
    if (refocus && row && row.isConnected) row.focus();
  }
  //  `right`: x is where the menu's right edge goes (the row's ⋯ button)
  function treeMenu(row, x, y, right) {
    const t = treeTarget(row);
    if (!t) return false;
    if (treeMenuEl && treeMenuRow === row) return true;
    treeMenuClose(false);
    const m = document.createElement('div');
    m.className = 'dtmenu treemenu';
    m.setAttribute('role', 'menu');
    const item = (id, label, run) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.dataset.mi = id;
      b.textContent = label;
      //  the row takes the focus back first, so the dialog the item opens
      //  hands it back there when it closes (dlgClose, 15-dialog.js)
      b.onclick = () => { treeMenuClose(true); run(); };
      if (id === 'del') b.classList.add('danger');
      m.append(b);
    };
    if (t.kind === 'page') {
      item('link', 'Copy link', () => copyLink(pageUrb(t.path)));
      item('mv', 'Rename / move', () => askMovePage(t.path));
      item('pdf', 'Export PDF', () => exportPagePdf(t.path));
      item('del', 'Delete', () => treeDelete(row));
    } else if (t.kind === 'folder') {
      item('new', 'New page here', async () => { if (await guardDirty()) newFile(t.path); });
      item('mv', 'Rename / move', () => moveFolder(t.path));
      item('del', 'Delete', () => treeDelete(row));
    } else {
      item('link', 'Copy link', () => copyLink(swmUrb(t.it)));
      item('in', 'Move into my pages', () => askMoveIn(t.it));
      item('del', 'Remove from list', () => treeDelete(row));
    }
    m.onkeydown = (e) => {
      const bs = [...m.querySelectorAll('button')];
      const i = bs.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length].focus();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        treeMenuClose(true);
      }
    };
    m.style.visibility = 'hidden';
    document.body.append(m);
    //  kept on screen: a row near the bottom or the right edge opens it
    //  upward or leftward instead of half off the page
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(4, Math.min(right ? x - w : x, innerWidth - w - 4)) + 'px';
    m.style.top = Math.max(4, y + h > innerHeight - 4 ? y - h : y) + 'px';
    m.style.visibility = '';
    treeMenuEl = m;
    treeMenuRow = row;
    treeMenuAt = performance.now();
    m.querySelector('button').focus();
    return true;
  }
  //  where a menu opened from the keyboard goes: under the row, since a
  //  keyboard contextmenu event carries no pointer position
  const rowSpot = (row) => {
    const r = row.getBoundingClientRect();
    return [r.left + 16, r.bottom];
  };
  treeList.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[role=treeitem]');
    if (!row || !treeTarget(row)) return;
    e.preventDefault();
    //  a phone's own long press (Android fires contextmenu for it) and ours
    //  are one gesture: the tap that ends it must not open the row
    if (lpDown) { lpFired = true; clearTimeout(lpTimer); }
    const [x, y] = e.clientX || e.clientY ? [e.clientX, e.clientY] : rowSpot(row);
    treeMenu(row, x, y);
  });

  // ── the row's ⋯ button ──────────────────────────────────────────────────
  // The menu, where a user can see it: faint at the row's right end, shown
  // on hover or focus, and always on a touch screen (index.html, .rmore).
  // Its own click opens the menu under it and goes no further, so the row
  // never sees it; everywhere else on the row clicks as before. Out of the
  // tab order like a folder's +: the tree is one tab stop, and the keyboard
  // has the menu key (Shift+F10) and Delete on the row itself.
  function rowMore(row, name, rowName = name) {
    //  the row keeps its own name: read from its content, it would take in
    //  the button's label too
    if (!row.hasAttribute('aria-label')) row.setAttribute('aria-label', rowName);
    const b = document.createElement('span');
    b.className = 'rmore';
    b.setAttribute('role', 'button');
    b.tabIndex = -1;
    b.setAttribute('aria-label', 'More actions for ' + name);
    b.title = 'More actions';
    b.innerHTML = ico('more');
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (treeMenuEl && treeMenuRow === row) { treeMenuClose(true); return; }
      const r = b.getBoundingClientRect();
      treeMenu(row, r.right, r.bottom + 2, true);
    });
    //  a middle click on it opens nothing in a new tab either
    b.addEventListener('auxclick', (e) => { e.preventDefault(); e.stopPropagation(); });
    row.append(b);
    return b;
  }

  // ── long press, for a phone ──────────────────────────────────────────────
  // Held still for half a second on a row: the menu. A finger that moves
  // is a scroll, and a short tap still opens the row, so only a press that
  // fired swallows the click it ends with.
  const LP_MS = 500, LP_SLOP = 10;
  let lpTimer = 0, lpDown = null, lpFired = false;
  const lpCancel = () => { clearTimeout(lpTimer); lpDown = null; };
  treeList.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const row = e.target.closest('[role=treeitem]');
    if (!row || !treeTarget(row)) return;
    lpDown = { row, x: e.clientX, y: e.clientY };
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      const d = lpDown;
      if (!d || !d.row.isConnected) return;
      lpFired = true;
      if (navigator.vibrate) try { navigator.vibrate(10); } catch {}
      treeMenu(d.row, d.x, d.y);
    }, LP_MS);
  });
  treeList.addEventListener('pointermove', (e) => {
    if (lpDown && Math.hypot(e.clientX - lpDown.x, e.clientY - lpDown.y) > LP_SLOP) lpCancel();
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) treeList.addEventListener(t, lpCancel);
  treeList.addEventListener('scroll', lpCancel, true);
  treeList.addEventListener('click', (e) => {
    if (!lpFired) return;
    lpFired = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  //  any later press or key starts fresh, so a press that fired can never
  //  swallow a click that comes from somewhere else (Enter on a row is one)
  addEventListener('pointerdown', (e) => {
    lpFired = false;
    //  a press on the open menu's own ⋯ is left to its click, which shuts it
    const more = e.target.closest && e.target.closest('.rmore');
    if (more && treeMenuRow && treeMenuRow.contains(more)) return;
    if (treeMenuEl && !treeMenuEl.contains(e.target)) treeMenuClose(false);
  }, true);
  addEventListener('keydown', () => { lpFired = false; }, true);
  addEventListener('resize', () => treeMenuClose(false));
  //  a scroll shuts it, but not one already on its way when it opened:
  //  scroll events land a frame late, so a row scrolled into view by the
  //  press itself (focus on pointerdown) shut the menu as it appeared
  addEventListener('scroll', (e) => {
    if (treeMenuEl && !treeMenuEl.contains(e.target)
      && performance.now() - treeMenuAt > 300) treeMenuClose(false);
  }, true);

  // for the browser suites, which cannot reach this scope
  window.latTreeMenu = { open: (tk) => {
    const row = [...treeList.querySelectorAll('[role=treeitem]')].find((r) => r.dataset.tk === tk);
    if (!row) return false;
    const [x, y] = rowSpot(row);
    return treeMenu(row, x, y);
  } };
