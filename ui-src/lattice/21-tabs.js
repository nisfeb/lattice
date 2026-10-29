  // ── document tabs ───────────────────────────────────────────────────────
  // Many documents open at once over ONE live editor. The editor's globals
  // (current, dirty, everTyped, grubPath, mode, src) stay the truth for the
  // tab in front. A tab that is not in front holds `snap`: what the editor
  // held for it when it was last in front, and above all whether that was
  // unsaved. A parked tab's unsaved buffer exists nowhere else, so
  // __latUnsaved and beforeunload count it (20-state.js, 35-pages.js).
  //
  // One tab per document: opening one that is already open focuses its tab,
  // so a document has one buffer, one dirty flag and one autosave, and two
  // tabs can never write over each other's typing.
  let tabs = [];
  let activeTab = null;
  let tabSeq = 0;
  // >0 while the tab model itself is painting the editor. setOpen calls
  // tabFollow on every paint, and these paints are the tab model's own steps,
  // not the user going somewhere.
  let tabNav = 0;
  // the tab whose open is still on its way in. Until its document lands the
  // paints are the open's own steps (openKnow's setMode passes through "no
  // memory" on its way to the key), so tabFollow leaves this tab alone. Only
  // until it lands, though: an open's promise can run on for seconds after
  // the paint (openPage's upgrade fetch), and what the user does meanwhile
  // must still be followed.
  let tabLoading = null;

  const mkTab = (kind, key, ship, { pinned = false, read = false } = {}) =>
    ({ id: 't' + (++tabSeq), kind, key, ship: ship || null, pinned, read,
       back: [], fwd: [], snap: null });
  const sameDoc = (t, d) =>
    t.kind === d.kind && t.key === d.key && (t.ship || null) === (d.ship || null);
  // a Back or Forward entry. Kind and ship ride along, since one tab can go
  // from a page to a memory to a grub.
  const tabEnc = (t) => JSON.stringify([t.kind, t.key, t.ship || null]);
  const tabDec = (s) => { const [kind, key, ship] = JSON.parse(s); return { kind, key, ship }; };

  // what the live editor shows, as a tab would name it: the one editor kind
  // whose live() claims it. null for a folder, which is a view in a tab and
  // not a document of its own.
  const liveDoc = () => {
    for (const [kind, k] of Object.entries(TAB_KINDS)) {
      const d = k.live && k.live();
      if (d) return { kind, key: d.key, ship: d.ship || null };
    }
    return null;
  };
  // shows(t) for every editor kind: the live editor is this tab's document
  const showsLive = (t) => { const d = liveDoc(); return !!d && sameDoc(t, d); };

  // Park: the editor's state for this tab goes into its snap, and the
  // editor is released for the next one. A page or memory first gets the
  // same flush guardDirty gives it, minus the question: whatever the flush
  // cannot save simply stays in the snap, unsaved and counted. A grub never
  // autosaves, so its buffer goes straight into the snap.
  //
  // Only a tab whose document really is in the editor owns what is there.
  // While a slow open is still loading, the editor shows the document
  // before it, and filing that text under this tab would hand one
  // document's words to another's autosave. When such text is still unsaved
  // after the flush (a page deleted elsewhere and not yet recreated, typing
  // in a load window), it belongs to no tab, so it gets guardDirty's
  // question, and a cancel keeps it and the switch does not happen.
  // Answers false then.
  async function parkDoc(t) {
    const label = current || pname.value.trim() || 'this';
    await flushNoAsk();
    const mine = TAB_KINDS[t.kind].shows(t);
    if (dirty && !mine &&
        !(await askConfirm('discard unsaved changes to ' + label + '?', 'discard')))
      return false;
    t.snap = mine ? {
      body: src.value, dirty, everTyped,
      sel: [src.selectionStart, src.selectionEnd], scroll: src.scrollTop,
      kind: curKind, pkind: pkind.value, rev: curRev, shown: pname.value,
    } : null;
    // the buffer lives in the snap now. The next open's own guardDirty must
    // not ask about it again, and its debounce must not save it under
    // whatever document comes next (autosave reads `current` when it fires).
    dirty = false;
    clearTimeout(autoTimer);
    return true;
  }
  // The kinds of tab. switchTab and openIn only ever look a kind up here,
  // so a new kind is a new entry and nothing else.
  //   open(t)        show the document fresh, from the ship or a cache.
  //                  Answers false when that failed with nothing shown.
  //   restore(t, s)  paint a parked unsaved buffer back, with no fetch
  //   park(t)        hand the editor back, keeping what is unsaved in t.snap.
  //                  Answers false when the user chose to stay.
  //   shows(t)       whether the editor is showing this tab's document
  //   live()         editor kinds only: {key, ship} when the live editor
  //                  holds a document of this kind, else null. The editor
  //                  kinds claim mutually exclusive states. A kind without
  //                  live() is never rewritten by tabFollow.
  //   icon, label    for the strip
  const TAB_KINDS = {
    page: {
      icon: 'doc',
      label: (t) => t.key ? t.key.split('/').pop() : 'new page',
      open: async (t) => {
        if (t.key) return openPage(t.key);
        exitRev();
        newFile('', false);
        return true;
      },
      restore: (t, s) => {
        exitRev();
        if (!t.key) {
          newFile('', false);
          setOpen(null, { shown: s.shown });
          if (s.pkind) pkind.value = s.pkind;
          src.value = s.body;
          render();
          return;
        }
        exitGrub();
        if (mode === 'know') setMode('pages');
        setFolderCtx(t.key);
        const n = nodes.find((x) => x.page && x.path === t.key);
        applyPage(t.key, { body: s.body, kind: s.kind || s.pkind, rev: s.rev,
          share: (n && n.share) || 'private' }, true);
      },
      park: parkDoc,
      shows: showsLive,
      live: () => (!grubPath && mode !== 'know' && curFolder === null
        ? { key: current || '' } : null),
    },
    know: {
      icon: 'know',
      label: (t) => t.key ? t.key.split('/').pop() : 'new memory',
      open: async (t) => {
        if (t.key) return openKnow(t.key);
        setMode('know');
        return true;
      },
      restore: (t, s) => {
        if (mode !== 'know') setMode('know');
        if (!t.key) {
          setOpen(null, { shown: s.shown });
          src.value = s.body;
          render();
          return;
        }
        applyKnow(t.key, { body: s.body, tags: (knowEntry(t.key) || { tags: [] }).tags,
          updated: 'unsaved here' });
      },
      park: parkDoc,
      shows: showsLive,
      live: () => (!grubPath && mode === 'know' ? { key: current || '' } : null),
    },
    grub: {
      icon: 'file',
      label: (t) => {
        const pg = /\/page\/(.+)\/code$/.exec(t.key);
        const n = pg ? pg[1] : t.key.split('/').pop();
        return t.ship ? t.ship + ': ' + n : n;
      },
      open: async (t) => {
        // grub mode is an overlay on the pages view (40-grub.js)
        if (mode === 'know') setMode('pages');
        exitRev();
        return openGrub(t.key, t.ship);
      },
      restore: (t, s) => {
        if (mode === 'know') setMode('pages');
        exitRev();
        enterGrub(t.key, t.ship);
        src.value = s.body;
        src.readOnly = false;
        if (s.pkind) pkind.value = s.pkind;
        curKind = s.kind;
        render();
        pname.dispatchEvent(new Event('input'));
        st('unsaved · press Save or Cmd+S');
      },
      park: parkDoc,
      shows: showsLive,
      live: () => (grubPath ? { key: grubPath, ship: grubShip } : null),
    },
  };

  // ── persistence ──────────────────────────────────────────────────────
  // Which documents are open, never their bodies: a body in localStorage
  // could come back in another window as if it were that window's work.
  const tabsSave = () => {
    try {
      localStorage.appTabs = JSON.stringify({
        tabs: tabs.map(({ kind, key, ship, pinned, read }) => ({ kind, key, ship, pinned, read })),
        active: tabs.indexOf(activeTab),
      });
    } catch {}
  };
  const tabsChanged = () => { tabsSave(); paintTabs(); };

  // ── showing a tab ────────────────────────────────────────────────────
  // Every switch, close and in-place open runs through one queue, so two
  // quick clicks can never park the same buffer twice or interleave their
  // halves. The queue waits for the park and for the paint to begin, not
  // for a slow fetch: the next switch supersedes an open still loading
  // (openSeq), and parks nothing for it, since nothing of it is shown yet.
  let tabQ = Promise.resolve();
  let tabShown = 0;         // counts showTab calls, so a late landing knows it is late
  const tabSerial = (fn) => {
    const run = tabQ.then(fn, fn);
    tabQ = run.catch(() => {});
    return run;
  };

  // show `t`, already the active tab, in the editor
  function showTab(t) {
    const k = TAB_KINDS[t.kind];
    const s = t.snap;
    t.snap = null;          // in front, the live editor is its state
    const gen = ++tabShown;
    src.readOnly = false;   // a blank or a binary grub left it locked
    openSeq++;              // an open still loading for the tab left behind may not land
    if (s && s.dirty) {
      tabLoading = null;
      tabNav++;
      try {
        k.restore(t, s);
        dirty = true;
        everTyped = s.everTyped;
        // a page or memory whose flush failed tries again on the usual
        // debounce, exactly as if it had just been typed
        clearTimeout(autoTimer);
        autoTimer = setTimeout(autosave, 2000);
        tabCaret(s);
      } finally { tabNav--; }
      paintTabs();
      return Promise.resolve(true);
    }
    tabLoading = t;
    const settle = () => { if (gen === tabShown && tabLoading === t) tabLoading = null; };
    let p;
    try { p = Promise.resolve(k.open(t)); } catch (e) { p = Promise.reject(e); }
    return p.then((ok) => {
      settle();
      if (activeTab !== t || gen !== tabShown) return ok;
      // failed with nothing shown: an empty, locked editor under this tab's
      // name, never the previous document wearing this tab's title
      if (ok === false && !k.shows(t)) tabBlank(t);
      else if (!k.shows(t)) tabFollow();   // something else opened over it
      else if (s && !dirty) tabCaret(s);
      paintTabs();
      return ok;
    }, (e) => { settle(); throw e; });
  }
  const tabCaret = (s) => {
    try { src.setSelectionRange(s.sel[0], s.sel[1]); } catch {}
    src.scrollTop = s.scroll;
    sync();
  };
  function tabBlank(t) {
    tabNav++;
    try {
      exitGrub();
      setOpen(null, { shown: TAB_KINDS[t.kind].label(t), readOnly: true });
      src.value = '';
      src.readOnly = true;
      dirty = false;
      render();
      prevBlank();
    } finally { tabNav--; }
  }

  // park whatever is in front and bring `t` there. false: the user stayed
  async function tabTo(t) {
    const from = activeTab;
    if (from === t) {
      if (!TAB_KINDS[t.kind].shows(t)) showTab(t);
      return;
    }
    if (from && tabs.includes(from) && (await TAB_KINDS[from.kind].park(from)) === false)
      return false;
    activeTab = t;
    tabsChanged();
    showTab(t);
  }

  // ── the entry points ─────────────────────────────────────────────────
  // openIn: how every click on a document opens it. An open document
  // focuses its tab. A new tab comes from Ctrl/Cmd+click, a middle click,
  // opts.newTab, or a pinned tab in front. Anything else replaces the
  // document in the front tab, after guardDirty, and that tab's Back
  // remembers what it replaced.
  function openIn(kind, key, { ev, ship, newTab } = {}) {
    return tabSerial(async () => {
      const want = { kind, key, ship: ship || null };
      const hit = key ? tabs.find((t) => sameDoc(t, want)) : null;
      if (hit) return tabTo(hit);
      const fresh = newTab || (ev && (ev.ctrlKey || ev.metaKey || ev.button === 1))
        || !activeTab || activeTab.pinned;
      if (fresh) {
        const t = mkTab(kind, key, ship);
        tabs.splice(activeTab ? tabs.indexOf(activeTab) + 1 : tabs.length, 0, t);
        if ((await tabTo(t)) === false) { tabs.splice(tabs.indexOf(t), 1); tabsChanged(); }
        return;
      }
      if (!(await guardDirty())) return;
      // flushed, or the user said discard: either way nothing here is owed
      dirty = false;
      const t = activeTab;
      if (t.key) { t.back.push(tabEnc(t)); t.fwd = []; }
      Object.assign(t, want);
      t.snap = null;
      tabsChanged();
      showTab(t);
    });
  }
  const switchTab = (id) => tabSerial(async () => {
    const t = tabs.find((x) => x.id === id);
    if (t) await tabTo(t);
  });
  // closeTab: false when the user kept it. guardDirty runs on the tab being
  // closed, in front, the one place it can flush or ask, so a background tab
  // holding unsaved work comes forward first.
  const closeTab = (id) => tabSerial(async () => {
    const t = tabs.find((x) => x.id === id);
    if (!t) return false;
    if (t !== activeTab && t.snap && t.snap.dirty && (await tabTo(t)) === false) return false;
    if (t === activeTab) {
      if (!(await guardDirty())) return false;
      dirty = false;
      clearTimeout(autoTimer);
    }
    const i = tabs.indexOf(t);
    tabs.splice(i, 1);
    if (t !== activeTab) { tabsChanged(); return true; }
    activeTab = null;
    let next = tabs[i] || tabs[i - 1];
    if (!next) { next = mkTab('page', ''); tabs.push(next); }
    activeTab = next;
    tabsChanged();
    showTab(next);
    return true;
  });
  // Back and Forward within the front tab. A step is an in-place open, so
  // it guards like one. A step onto a document open in another tab goes
  // to that tab instead.
  const tabStep = (from, to) => tabSerial(async () => {
    const t = activeTab;
    if (!t || !t[from].length) return;
    if (!(await guardDirty())) return;
    dirty = false;
    const d = tabDec(t[from].pop());
    const twin = d.key && tabs.find((x) => x !== t && sameDoc(x, d));
    if (twin) { tabsChanged(); return tabTo(twin); }
    if (t.key) t[to].push(tabEnc(t));
    Object.assign(t, d);
    t.snap = null;
    tabsChanged();
    showTab(t);
  });
  const tabBack = () => tabStep('back', 'fwd');
  const tabFwd = () => tabStep('fwd', 'back');
  const tabCycle = (dir) => {
    if (tabs.length < 2) return;
    const i = tabs.indexOf(activeTab);
    switchTab(tabs[(i + dir + tabs.length) % tabs.length].id);
  };
  // a new tab with a new page in it: the strip's +. Then newFile again, the
  // way the + file button calls it, so the page gets named (the name field,
  // or the create dialog where that field is hidden, 96-deskmenu.js)
  const tabNew = async () => {
    await openIn('page', '', { newTab: true });
    if (activeTab && activeTab.kind === 'page' && !activeTab.key) newFile('');
  };

  // tabFollow: the editor moved to another document by a road that did not
  // come through openIn (a rename, a delete, the mode pill, a template, a
  // new page in place, the live sync). The front tab follows, so the tab
  // and what it parks always name the document that is really shown.
  function tabFollow() {
    if (tabNav || !activeTab) return;
    const t = activeTab;
    // a tab that is not an editor document (no live()) keeps its identity
    if (!TAB_KINDS[t.kind].live) return;
    if (tabLoading === t) {
      if (TAB_KINDS[t.kind].shows(t)) tabLoading = null;
      return;
    }
    const d = liveDoc();
    if (!d || sameDoc(t, d)) return;
    if (t.key) { t.back.push(tabEnc(t)); t.fwd = []; }
    Object.assign(t, d);
    t.snap = null;
    // one tab per document: a clean twin elsewhere is now redundant
    const twin = d.key && tabs.find((x) => x !== t && sameDoc(x, d) && !(x.snap && x.snap.dirty));
    if (twin) tabs.splice(tabs.indexOf(twin), 1);
    tabsChanged();
  }
  // a move or rename: tabs naming the old path, or anything under it, name
  // the new one, so a parked buffer is never saved back to where it was
  function tabsRemap(kind, from, to) {
    for (const t of tabs) {
      if (t.kind !== kind || !t.key) continue;
      if (t.key === from) t.key = to;
      else if (t.key.startsWith(from + '/')) t.key = to + t.key.slice(from.length);
    }
    tabsChanged();
  }

  // ── boot ─────────────────────────────────────────────────────────────
  // The saved list, and then the address on top of it: a ?name, ?grub or
  // ?view=know&key names a document, which gets its tab focused or a new
  // one. An entry that does not parse as a tab is dropped, and nothing at
  // all leaves one new page. Nothing is opened here; boot (99-boot.js) shows
  // the tab this returns. `fresh` says the list was made up rather than
  // restored, which is when a bare launch may resume the last page.
  function tabsBoot() {
    let saved = null;
    try { saved = JSON.parse(localStorage.appTabs || 'null'); } catch {}
    const list = saved && Array.isArray(saved.tabs) ? saved.tabs : [];
    for (const e of list) {
      if (!e || !TAB_KINDS[e.kind] || typeof e.key !== 'string') continue;
      if (e.ship != null && typeof e.ship !== 'string') continue;
      if (e.key && tabs.some((t) => sameDoc(t, e))) continue;
      tabs.push(mkTab(e.kind, e.key, e.ship, { pinned: e.pinned === true, read: e.read === true }));
    }
    activeTab = (Number.isInteger(saved && saved.active) && tabs[saved.active]) || tabs[0] || null;
    const want = qs.get('grub') ? { kind: 'grub', key: qs.get('grub'), ship: qs.get('ship') || null }
      : qs.get('view') === 'know' ? { kind: 'know', key: qs.get('key') || '', ship: null }
      : qs.get('name') ? { kind: 'page', key: qs.get('name'), ship: null } : null;
    if (want) {
      const hit = activeTab && sameDoc(activeTab, want) ? activeTab
        : tabs.find((t) => sameDoc(t, want));
      if (hit) activeTab = hit;
      else {
        const t = mkTab(want.kind, want.key, want.ship);
        tabs.splice(activeTab ? tabs.indexOf(activeTab) + 1 : 0, 0, t);
        activeTab = t;
      }
    }
    const fresh = !activeTab;
    if (fresh) { activeTab = mkTab('page', ''); tabs.push(activeTab); }
    tabsChanged();
    return { tab: activeTab, fresh };
  }
  // boot showing a tab through the tab model, for every kind without a
  // boot path of its own
  const tabShowBoot = (t) => tabSerial(() => showTab(t));

  // ── the strip ────────────────────────────────────────────────────────
  // First in the center column, level with the corner toggles. Back and
  // Forward at its start, the tabs, then + for a new page.
  const tabStrip = document.createElement('div');
  tabStrip.id = 'doctabs';
  tabStrip.className = 'doctabs';
  tabStrip.innerHTML =
    sbtn('id="tabback"', 'left', 'Back', 'Alt+Left') +
    sbtn('id="tabfwd"', 'right', 'Forward', 'Alt+Right') +
    '<div class="dtlist" role="tablist" aria-label="Open documents"></div>' +
    sbtn('id="tabnew"', 'plus', 'New page');
  $('center').prepend(tabStrip);
  const tabList = tabStrip.querySelector('.dtlist');
  $('tabback').onclick = () => tabBack();
  $('tabfwd').onclick = () => tabFwd();
  $('tabnew').onclick = () => tabNew();

  // Each tab is two buttons side by side in one wrapper: the tab itself
  // and its close, so the close is a real button a keyboard can reach (a
  // button cannot sit inside another). The state classes (on, dirty,
  // pinned) go on both: the wrapper draws the tab, the tab button is what
  // scripts and suites address.
  function paintTabs() {
    tabList.textContent = '';
    for (const t of tabs) {
      const k = TAB_KINDS[t.kind];
      const name = k.label(t);
      const w = document.createElement('div');
      w.setAttribute('role', 'presentation');
      const b = document.createElement('button');
      b.type = 'button';
      for (const [el, base] of [[w, 'dtw'], [b, 'dtab']])
        el.className = base + (t === activeTab ? ' on' : '') + (t.pinned ? ' pinned' : '');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t === activeTab ? 'true' : 'false');
      b.dataset.id = t.id;
      b.dataset.kind = t.kind;
      b.dataset.key = t.key;
      b.title = (t.ship ? t.ship + ' ' : '') + (t.key || name);
      b.innerHTML = ico(t.pinned ? 'pin' : k.icon) + '<span class="dtn"></span>'
        + '<span class="dtdot" aria-hidden="true"></span>';
      b.querySelector('.dtn').textContent = name;
      b.onclick = () => switchTab(t.id);
      const x = tip(document.createElement('button'), 'Close ' + name);
      x.type = 'button';
      x.className = 'dtx';
      x.innerHTML = ico('x');
      x.onclick = () => closeTab(t.id);
      // a middle click closes, and must not start the browser's autoscroll
      w.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); };
      w.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } };
      w.oncontextmenu = (e) => { e.preventDefault(); tabMenu(t, e.clientX, e.clientY); };
      w.append(b, x);
      tabList.append(w);
    }
    $('tabback').disabled = !activeTab || !activeTab.back.length;
    $('tabfwd').disabled = !activeTab || !activeTab.fwd.length;
    paintTabDirty();
    const on = tabList.querySelector('.dtw.on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  // The dot. `dirty` is set by typing and cleared by four save paths, so the
  // dot is read off the state on a short beat instead of from each of them.
  function paintTabDirty() {
    for (const w of tabList.children) {
      const b = w.firstChild;
      const t = tabs.find((x) => x.id === b.dataset.id);
      const on = !!t && (t === activeTab ? dirty === true : !!(t.snap && t.snap.dirty));
      w.classList.toggle('dirty', on);
      b.classList.toggle('dirty', on);
    }
  }
  setInterval(paintTabDirty, 400);

  // the context menu: pin, close, close the others
  let tabMenuEl = null;
  const tabMenuClose = () => { if (tabMenuEl) { tabMenuEl.remove(); tabMenuEl = null; } };
  function tabMenu(t, x, y) {
    tabMenuClose();
    const m = document.createElement('div');
    m.className = 'dtmenu';
    m.setAttribute('role', 'menu');
    const item = (label, run) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      b.onclick = () => { tabMenuClose(); run(); };
      m.append(b);
    };
    item(t.pinned ? 'Unpin' : 'Pin', () => { t.pinned = !t.pinned; tabsChanged(); });
    item('Close', () => closeTab(t.id));
    item('Close others', async () => {
      for (const o of tabs.filter((x) => x !== t)) await closeTab(o.id);
    });
    m.style.left = x + 'px';
    m.style.top = y + 'px';
    document.body.append(m);
    tabMenuEl = m;
    m.querySelector('button').focus();
  }
  addEventListener('mousedown', (e) => {
    if (tabMenuEl && !tabMenuEl.contains(e.target)) tabMenuClose();
  }, true);
  addEventListener('keydown', (e) => {
    if (tabMenuEl && e.key === 'Escape') { tabMenuClose(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      if (activeTab) closeTab(activeTab.id);
    } else if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      tabCycle(e.shiftKey ? -1 : 1);
    } else if (e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      // in a text field Alt+Arrow moves by word on a Mac, and that wins
      && !(e.target.closest && e.target.closest('input, textarea, select, [contenteditable]'))) {
      e.preventDefault();
      if (e.key === 'ArrowLeft') tabBack(); else tabFwd();
    }
  });
  // a link to a document: a click goes through openIn with its event, so
  // Ctrl/Cmd and the middle button open a new tab
  const tabLink = (el, kind, key, opts = {}) => {
    const go = (e) => { e.preventDefault(); openIn(kind, key, { ...opts, ev: e }); };
    el.onclick = go;
    el.onauxclick = (e) => { if (e.button === 1) go(e); };
  };

  // for the browser suites, which cannot reach this scope
  window.latTabs = {
    openIn, switchTab, closeTab, tabBack, tabFwd,
    list: () => tabs.map(({ id, kind, key, ship, pinned }) => ({ id, kind, key, ship, pinned })),
    state: () => ({
      tabs: tabs.map(({ id, kind, key, ship, pinned, snap }) =>
        ({ id, kind, key, ship, pinned, dirty: !!(snap && snap.dirty) })),
      active: tabs.indexOf(activeTab),
      shows: !!activeTab && TAB_KINDS[activeTab.kind].shows(activeTab),
    }),
  };
