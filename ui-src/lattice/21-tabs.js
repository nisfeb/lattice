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
  //
  // Splits (28-splits.js): the tabs live in groups, laid out side by side
  // in a split tree. One group is in front (focusG). Its list IS `tabs`
  // and its front tab IS `activeTab`, so everything above stays about the
  // group in front, and the live editor sits in that group. The front tab
  // of every other group is parked, painted read-only into its group from
  // its snap (a ghost), and becomes live when its group comes to the front
  // (gTo). One tab per document holds across every group.
  let tabs = [];
  let activeTab = null;
  let tabSeq = 0;
  let groups = [];          // every group, in the order they were made
  let focusG = null;        // the group in front
  // a group's front tab: the live one for the group in front
  const gFront = (g) => (g === focusG ? activeTab : g.active);
  const allTabs = () => groups.flatMap((g) => g.tabs);
  const groupOf = (t) => groups.find((g) => g.tabs.includes(t)) || null;
  // the queue below is running something: a park, a switch, an open
  let tabRunning = 0;
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
  let gSeq = 0;
  const mkGroup = () => ({ id: 'g' + (++gSeq), tabs: [], active: null });
  const sameDoc = (t, d) =>
    t.kind === d.kind && t.key === d.key && (t.ship || null) === (d.ship || null);
  // a Back or Forward entry. Kind and ship ride along, since one tab can go
  // from a page to a memory to a grub.
  // a tab taking another document in place: what its group painted of the
  // last one while parked (28-splits.js) goes with it
  const retarget = (t, d) => {
    Object.assign(t, d);
    t.ghost = null;
    t.gbody = undefined;
    t.gkind = undefined;
    t.gfetch = false;
  };
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
  // whether the tab in front is a document in the editor: its kind has
  // live(). A tool tab is not, so the controls of the editor (Save, Edit /
  // Read, rename, the Page tab) leave the document underneath alone.
  const docFront = () => !activeTab || !!TAB_KINDS[activeTab.kind].live;
  // shows(t) for every editor kind: the live editor is this tab's document
  const showsLive = (t) => { const d = liveDoc(); return !!d && sameDoc(t, d); };

  // Park: the editor's state for this tab goes into its snap, and the
  // editor is released for the next one. A page or memory first gets the
  // same flush guardDirty gives it, minus the question: whatever the flush
  // cannot save simply stays in the snap, unsaved and counted. A grub never
  // autosaves, so its buffer goes straight into the snap, and so does every
  // buffer with autosave off (flushNoAsk writes nothing then).
  //
  // Only a tab whose document really is in the editor owns what is there.
  // While a slow open is still loading, the editor shows the document
  // before it, and filing that text under this tab would hand one
  // document's words to another's autosave. When such text is still unsaved
  // after the flush (a page deleted elsewhere and not yet recreated, typing
  // in a load window), it belongs to no tab, so it gets guardDirty's
  // question, and a cancel keeps it and the switch does not happen.
  // Answers false then.
  // what the live editor holds for the tab it shows
  // (`hist`: an old revision was on show, which is never the page's text)
  const snapNow = () => ({
    body: src.value, dirty, everTyped,
    sel: [src.selectionStart, src.selectionEnd], scroll: src.scrollTop,
    kind: curKind, pkind: pkind.value, rev: curRev, shown: pname.value,
    hist: viewingRev !== null,
  });
  async function parkDoc(t) {
    const label = current || pname.value.trim() || 'this';
    await flushNoAsk();
    const mine = TAB_KINDS[t.kind].shows(t);
    if (dirty && !mine &&
        !(await askConfirm('discard unsaved changes to ' + label + '?', 'discard')))
      return false;
    t.snap = mine ? snapNow() : null;
    if (mine) gGhostKeep(t);
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
  //   icon, label    for the strip. icon is a name, or a function of the tab
  const TAB_KINDS = {
    page: {
      // a link (30-tree.js) is titled with its whole local path: its name
      // alone would read as a page of my own
      icon: (t) => (linkOf(t.key) ? 'link' : 'doc'),
      label: (t) => !t.key ? 'new page' : linkOf(t.key) ? t.key : t.key.split('/').pop(),
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
        const e = knowEntry(t.key) || { tags: [] };
        applyKnow(t.key, { body: s.body, tags: e.tags,
          updated: s.dirty ? 'unsaved here' : e.updated || '' });
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
        if (s.dirty) st('unsaved, Ctrl+S to save');
      },
      park: parkDoc,
      shows: showsLive,
      live: () => (grubPath ? { key: grubPath, ship: grubShip } : null),
    },
  };


  // ── persistence ──────────────────────────────────────────────────────
  // Which documents are open, never their bodies: a body in localStorage
  // could come back in another window as if it were that window's work.
  // Every group's tabs and front tab, the group in front, and the split
  // tree with its sizes (28-splits.js). `tabs` and `active` also name the
  // group in front on their own, the shape this had before splits.
  const tabRec = ({ kind, key, ship, pinned, read }) => ({ kind, key, ship, pinned, read });
  const tabsSave = () => {
    try {
      localStorage.appTabs = JSON.stringify({
        v: 2,
        groups: groups.map((g) => ({ tabs: g.tabs.map(tabRec), active: g.tabs.indexOf(gFront(g)) })),
        focus: groups.indexOf(focusG),
        tree: splitSave(),
        tabs: tabs.map(tabRec),
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
    const go = async () => {
      tabRunning++;
      try { return await fn(); } finally { tabRunning--; }
    };
    const run = tabQ.then(go, go);
    tabQ = run.catch(() => {});
    return run;
  };

  // show `t`, already the active tab, in the editor. `snapOk`: a group
  // coming to the front (gTake) paints a clean page or memory back from its
  // snap at once, as its group showed it while parked, and then asks the
  // ship for anything newer (refreshOpen), rather than leaving the last
  // group's text in the editor while a fetch runs.
  function showTab(t, { snapOk = false } = {}) {
    const k = TAB_KINDS[t.kind];
    const s = t.snap;
    t.snap = null;          // in front, the live editor is its state
    const gen = ++tabShown;
    src.readOnly = false;   // a blank or a binary grub left it locked
    openSeq++;              // an open still loading for the tab left behind may not land
    const quick = snapOk && !!s && !s.hist && !!t.key && (t.kind === 'page' || t.kind === 'know');
    // a new page or memory already named (its create may still be queued,
    // and runs here once the name is back in the field) comes back named
    // even when clean. Opened fresh it would be a blank, nameless page.
    if (s && (s.dirty || (!t.key && s.shown) || quick)) {
      tabLoading = null;
      tabNav++;
      try {
        k.restore(t, s);
        dirty = s.dirty;
        everTyped = s.everTyped;
        // a page or memory whose flush failed tries again on the usual
        // debounce, exactly as if it had just been typed
        clearTimeout(autoTimer);
        if (dirty) autoTimer = setTimeout(autosave, 2000);
        tabCaret(s);
      } finally { tabNav--; }
      paintTabs();
      if (quick && !s.dirty) refreshOpen();
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

  // park whatever is in front and bring `t` there. false: the user stayed.
  // A tab in another group brings its group to the front first.
  async function tabTo(t) {
    const g = groupOf(t);
    if (g && g !== focusG && !(await gTo(g))) return false;
    const from = activeTab;
    if (from === t) {
      if (!TAB_KINDS[t.kind].shows(t) && tabLoading !== t) showTab(t);
      return;
    }
    if (from && tabs.includes(from) && (await TAB_KINDS[from.kind].park(from)) === false)
      return false;
    activeTab = t;
    tabsChanged();
    showTab(t);
  }

  // ── groups ───────────────────────────────────────────────────────────
  // gRelease: the live editor lets go of the tab in front at once, with no
  // flush and no question. What is unsaved stays in its snap, where
  // __latUnsaved and beforeunload count it, and a page or memory saves it
  // from there in the background on autosave's terms (saveParked,
  // 35-pages.js). false when that cannot be done at once, with nothing
  // changed: the editor holds typing no tab owns yet (an open still
  // loading), or a create is in flight that names this tab when it lands.
  // gTo then parks it the slow way, which flushes and asks.
  function gRelease() {
    const t = activeTab;
    if (!t) return true;
    const k = TAB_KINDS[t.kind];
    if (!k.live) return true;          // a tool stays in its own group's host
    const mine = k.shows(t);
    if (dirty && !mine) return false;
    if (saving && !t.key) return false;
    if (mine) { t.snap = snapNow(); gGhostKeep(t); }
    dirty = false;
    clearTimeout(autoTimer);
    openSeq++;                         // an open in flight lands nowhere now
    if (tabLoading === t) tabLoading = null;
    if (t.snap && t.snap.dirty) saveParked(t);
    return true;
  }
  // gTake: group `g` comes to the front with nothing live to let go of
  // (gRelease ran, or the group in front just closed). The live editor
  // moves into it (splitPaint, 28-splits.js) and shows its front tab.
  function gTake(g) {
    if (focusG && groups.includes(focusG)) focusG.active = activeTab;
    focusG = g;
    tabs = g.tabs;
    activeTab = g.active && g.tabs.includes(g.active) ? g.active : g.tabs[0] || null;
    if (!activeTab) { activeTab = mkTab('page', ''); tabs.push(activeTab); }
    g.active = activeTab;
    splitPaint();
    tabsChanged();
    showTab(activeTab, { snapOk: true });
    rpSoon();
  }
  // gTo: group `g` to the front, inside the queue. false: the user stayed
  async function gTo(g) {
    if (g === focusG) return true;
    if (!gRelease()) {
      const t = activeTab;
      if ((await TAB_KINDS[t.kind].park(t)) === false) return false;
    }
    gTake(g);
    return true;
  }
  // gFocus: the same from a click or a key. At once when the queue is
  // idle, so a click into a group never waits on a save, else behind
  // what is running. Answers whether the group is in front now.
  function gFocus(g) {
    if (!g || g === focusG || !groups.includes(g)) return true;
    if (!tabRunning && gRelease()) { gTake(g); return true; }
    tabSerial(() => gTo(g));
    return false;
  }
  // a tab leaves its group without being shown (a clean twin,
  // tabFollow). Never the front tab of the group in front.
  function gDropTab(x) {
    const g = groupOf(x);
    if (!g) return;
    const i = g.tabs.indexOf(x);
    g.tabs.splice(i, 1);
    if (g === focusG) return;
    if (!g.tabs.length) { gDrop(g); return; }
    if (g.active === x) g.active = g.tabs[i] || g.tabs[i - 1];
  }
  // gMove: a tab to group `g` at `at` (the end when null), in front there.
  // The tab is parked on its way out, so the group it leaves never keeps a
  // buffer it no longer holds. A group left empty closes.
  const gMove = (t, g, at = null) => tabSerial(async () => {
    const from = groupOf(t);
    if (!from || !groups.includes(g)) return false;
    if (from === g) {
      const i = g.tabs.indexOf(t);
      let j = at === null ? g.tabs.length : at;
      g.tabs.splice(i, 1);
      if (j > i) j--;
      g.tabs.splice(Math.max(0, Math.min(j, g.tabs.length)), 0, t);
      tabsChanged();
      return true;
    }
    if (t === activeTab && !gRelease()
      && (await TAB_KINDS[t.kind].park(t)) === false) return false;
    const i = from.tabs.indexOf(t);
    from.tabs.splice(i, 1);
    if (gFront(from) === t) {
      const next = from.tabs[i] || from.tabs[i - 1] || null;
      from.active = next;
      if (from === focusG) activeTab = next;   // parked, not shown: nothing is live
    }
    const j = at === null ? g.tabs.length : Math.max(0, Math.min(at, g.tabs.length));
    g.tabs.splice(j, 0, t);
    if (!from.tabs.length) gDrop(from);
    if (g === focusG) return (await tabTo(t)) !== false;
    g.active = t;
    if (groups.includes(focusG) && focusG.tabs.length && !gRelease()
      && (await TAB_KINDS[activeTab.kind].park(activeTab)) === false) {
      tabsChanged();
      splitPaint();
      return false;
    }
    gTake(g);
    return true;
  });

  // ── the entry points ─────────────────────────────────────────────────
  // openIn: how every click on a document opens it. An open document
  // focuses its tab, in whichever group it is. A new tab comes from
  // Ctrl/Cmd+click, a middle click, opts.newTab, or a pinned tab in front.
  // Anything else replaces the document in the front tab, after
  // guardDirty, and that tab's Back remembers what it replaced.
  function openIn(kind, key, { ev, ship, newTab } = {}) {
    return tabSerial(async () => {
      const want = { kind, key, ship: ship || null };
      const hit = key ? allTabs().find((t) => sameDoc(t, want)) : null;
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
      retarget(t, want);
      t.snap = null;
      tabsChanged();
      showTab(t);
    });
  }
  const switchTab = (id) => tabSerial(async () => {
    const t = allTabs().find((x) => x.id === id);
    if (t) await tabTo(t);
  });
  // closeTab: false when the user kept it. A tab in another group brings
  // its group to the front first. guardDirty runs on the tab being
  // closed, in front, the one place it can flush or ask, so a background
  // tab holding unsaved work comes forward first. A kind with no buffer
  // may still hold typing of its own (held: a frame's half-written post),
  // which also comes forward and is asked about. The last tab of a group
  // closes the group, unless it is the only one.
  const closeTab = (id) => tabSerial(async () => {
    const t = allTabs().find((x) => x.id === id);
    if (!t) return false;
    const g = groupOf(t);
    const k0 = TAB_KINDS[t.kind];
    // a clean tab in a group not in front closes where it is: the editor
    // stays in the group being worked in. One holding unsaved work, or
    // typing in its frame, comes forward to be asked about.
    if (g !== focusG && !(t.snap && t.snap.dirty) && !(k0.held && k0.held(t))) {
      const i = g.tabs.indexOf(t);
      g.tabs.splice(i, 1);
      if (!g.tabs.length) gDrop(g);
      else if (g.active === t) g.active = g.tabs[i] || g.tabs[i - 1];
      tabsChanged();
      return true;
    }
    if (g !== focusG && !(await gTo(g))) return false;
    if (t !== activeTab && t.snap && t.snap.dirty && (await tabTo(t)) === false) return false;
    const k = TAB_KINDS[t.kind];
    if (k.held && k.held(t)) {
      if (t !== activeTab && (await tabTo(t)) === false) return false;
      if (!(await askConfirm('discard what you typed in ' + k.label(t) + '?', 'discard'))) return false;
    }
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
    if (!next && groups.length > 1) {
      const nb = gNeighbor(focusG);
      gDrop(focusG);
      gTake(nb);
      return true;
    }
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
    const twin = d.key && allTabs().find((x) => x !== t && sameDoc(x, d));
    if (twin) { tabsChanged(); return tabTo(twin); }
    if (t.key) t[to].push(tabEnc(t));
    retarget(t, d);
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
  // a tool tab in front hides the editor. Anything about to paint the
  // editor (a new page, a folder) first gets a document tab of its own,
  // as the strip's + gives one, so it never lands unseen under the tool.
  // false: no document tab came to the front.
  const docTab = async () => {
    if (docFront()) return true;
    await openIn('page', '', { newTab: true });
    return docFront() && !!activeTab && activeTab.kind === 'page' && !activeTab.key;
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
    retarget(t, d);
    t.snap = null;
    // one tab per document: a clean twin elsewhere, in any group, is now
    // redundant
    const twin = d.key && allTabs().find((x) => x !== t && sameDoc(x, d) && !(x.snap && x.snap.dirty));
    if (twin) gDropTab(twin);
    tabsChanged();
  }
  // a create that ran from the queue after its tab was left (save(),
  // 35-pages.js). `own.tab` is the tab it was queued from, and only that
  // tab, still unnamed and still showing the name it was created as, is
  // the page's tab now. Named, it opens the page when it comes back
  // (current set), so its later saves update the page instead of creating
  // it again, which the ship refuses as a page that already exists.
  // true: that tab is in front again, so the editor is on the page and
  // save() takes it as still here.
  function tabAdopt(own, name) {
    const trim = (v) => v.trim().replace(/^\/+|\/+$/g, '');
    const t = allTabs().find((x) => x.id === own.tab);
    if (!t || t.kind !== 'page' || t.key) return false;
    if (t === activeTab)
      return showsLive(t) && current === null && trim(pname.value) === own.name;
    if (!t.snap || trim(t.snap.shown || '') !== own.name) return false;
    t.key = name;
    t.snap.shown = name;
    tabsChanged();
    return false;
  }
  // a move or rename: tabs naming the old path, or anything under it, name
  // the new one, so a parked buffer is never saved back to where it was
  function tabsRemap(kind, from, to) {
    for (const t of allTabs()) {
      if (t.kind !== kind || !t.key) continue;
      if (t.key === from) t.key = to;
      else if (t.key.startsWith(from + '/')) t.key = to + t.key.slice(from.length);
    }
    tabsChanged();
  }
  // a save of `name` that landed after its tab was parked (35-pages.js,
  // 95-know.js): the snap holding exactly what was sent is clean now, and
  // a page's snap takes the new revision, which a link's next save claims
  function tabLanded(kind, name, sent, rev, ship = null) {
    for (const t of allTabs()) {
      if (t.kind !== kind || t.key !== name || (t.ship || null) !== ship || !t.snap) continue;
      if (t.snap.body === sent && t.snap.dirty) t.snap.dirty = false;
      if (rev) t.snap.rev = rev;
    }
  }

  // ── boot ─────────────────────────────────────────────────────────────
  // The saved groups, and then the address on top of them: a ?name, ?grub
  // or ?view=know&key names a document, which gets its tab focused, in
  // whichever group, or a new one in the group in front. An entry that
  // does not parse as a tab is dropped, and so is a second tab on one
  // document. A layout that does not name every group once (28-splits.js)
  // falls back to one group holding every tab, and nothing at all leaves
  // one new page. Nothing is opened here; boot (99-boot.js) shows the tab
  // this returns, and the other groups paint from their caches. `fresh`
  // says the list was made up rather than restored, which is when a bare
  // launch may resume the last page.
  function tabsBoot() {
    let saved = null;
    try { saved = JSON.parse(localStorage.appTabs || 'null'); } catch {}
    if (!saved || typeof saved !== 'object') saved = null;
    const lists = saved && Array.isArray(saved.groups) && saved.groups.length ? saved.groups
      : saved && Array.isArray(saved.tabs) ? [{ tabs: saved.tabs, active: saved.active }] : [];
    const seen = [];
    let made = lists.map((e) => {
      const g = mkGroup();
      for (const r of (e && Array.isArray(e.tabs) ? e.tabs : [])) {
        if (!r || !TAB_KINDS[r.kind] || typeof r.key !== 'string') continue;
        if (r.ship != null && typeof r.ship !== 'string') continue;
        if (r.key && seen.some((t) => sameDoc(t, r))) continue;
        const t = mkTab(r.kind, r.key, r.ship, { pinned: r.pinned === true, read: r.read === true });
        g.tabs.push(t);
        seen.push(t);
      }
      g.active = (e && Number.isInteger(e.active) && g.tabs[e.active]) || g.tabs[0] || null;
      return g;
    });
    let fi = saved && Number.isInteger(saved.focus) && made[saved.focus] ? saved.focus : 0;
    if (made.length > 1 && (made.some((g) => !g.tabs.length) || !splitLoad(saved.tree, made))) {
      // one group, every tab in order, the one in front still in front
      const one = mkGroup();
      one.tabs = made.flatMap((g) => g.tabs);
      one.active = (made[fi] && made[fi].active) || one.tabs[0] || null;
      made = [one];
      fi = 0;
    }
    if (!made.length) made = [mkGroup()];
    if (made.length === 1) splitLoad(0, made);
    for (const g of made) gAdd(g);
    focusG = made[fi];
    tabs = focusG.tabs;
    activeTab = focusG.active;
    const want = qs.get('grub') ? { kind: 'grub', key: qs.get('grub'), ship: qs.get('ship') || null }
      : qs.get('view') === 'know' ? { kind: 'know', key: qs.get('key') || '', ship: null }
      : qs.get('name') ? { kind: 'page', key: qs.get('name'), ship: null } : null;
    if (want) {
      const hit = activeTab && sameDoc(activeTab, want) ? activeTab
        : allTabs().find((t) => sameDoc(t, want));
      if (hit) {
        focusG = groupOf(hit);
        tabs = focusG.tabs;
        activeTab = hit;
      } else {
        const t = mkTab(want.kind, want.key, want.ship);
        tabs.splice(activeTab ? tabs.indexOf(activeTab) + 1 : 0, 0, t);
        activeTab = t;
      }
    }
    const fresh = !activeTab && allTabs().length === 0;
    if (!activeTab) { activeTab = mkTab('page', ''); tabs.push(activeTab); }
    focusG.active = activeTab;
    splitPaint();
    tabsChanged();
    return { tab: activeTab, fresh };
  }
  // boot showing a tab through the tab model, for every kind without a
  // boot path of its own
  const tabShowBoot = (t) => tabSerial(() => showTab(t));

  // ── the strips ───────────────────────────────────────────────────────
  // Each group has its own, first in the group (built by gAdd,
  // 28-splits.js): its tabs, then + for a new page and the two splits.
  // The group in front's strip is #doctabs and its + is #tabnew.
  //
  // Each tab is two buttons side by side in one wrapper: the tab itself
  // and its close, so the close is a real button a keyboard can reach (a
  // button cannot sit inside another). The state classes (on, dirty,
  // pinned) go on both: the wrapper draws the tab, the tab button is what
  // scripts and suites address. A tab drags to another group's strip, or
  // to an edge of a group to split it (28-splits.js).
  function paintStrip(g) {
    const front = gFront(g);
    g.list.textContent = '';
    for (const t of g.tabs) {
      const k = TAB_KINDS[t.kind];
      const name = k.label(t);
      const w = document.createElement('div');
      w.setAttribute('role', 'presentation');
      w.draggable = true;
      w.dataset.id = t.id;
      const b = document.createElement('button');
      b.type = 'button';
      for (const [el, base] of [[w, 'dtw'], [b, 'dtab']])
        el.className = base + (t === front ? ' on' : '') + (t.pinned ? ' pinned' : '');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t === front ? 'true' : 'false');
      b.dataset.id = t.id;
      b.dataset.kind = t.kind;
      b.dataset.key = t.key;
      b.title = (t.ship ? t.ship + ' ' : '') + (t.key || name);
      b.innerHTML = ico(t.pinned ? 'pin' : typeof k.icon === 'function' ? k.icon(t) : k.icon)
        + '<span class="dtn"></span>'
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
      g.list.append(w);
    }
    // the tab in front into view, in the next frame's rAF, before it lays
    // out. Done here, it forced a layout of the whole shell in the middle
    // of boot (46 ms), which the boot's later DOM work then threw away.
    if (!g.scrollRaf) g.scrollRaf = requestAnimationFrame(() => {
      g.scrollRaf = 0;
      const on = g.list.querySelector('.dtw.on');
      if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  function paintTabs() {
    for (const g of groups) paintStrip(g);
    paintTabDirty();
    if (!focusG) return;
    paintHead();   // the header under the strip (23-tabhead.js)
    gPaintAll();   // the other groups' parked fronts (28-splits.js)
    document.dispatchEvent(new Event('lat-tabs'));
  }
  // The dot. `dirty` is set by typing and cleared by four save paths, so the
  // dot is read off the state on a short beat instead of from each of them.
  function paintTabDirty() {
    for (const g of groups) {
      for (const w of g.list.children) {
        const b = w.firstChild;
        const t = g.tabs.find((x) => x.id === b.dataset.id);
        const on = !!t && (t === activeTab ? dirty === true : !!(t.snap && t.snap.dirty));
        w.classList.toggle('dirty', on);
        b.classList.toggle('dirty', on);
      }
    }
  }
  setInterval(paintTabDirty, 400);
  clickAction('tabnew', 'New page in a new tab', 'Tab strip');

  // the context menu: pin, close, close the others, and move to a new
  // group beside or below (the way to split without a drag)
  let tabMenuEl = null;
  const tabMenuClose = () => { if (tabMenuEl) { tabMenuEl.remove(); tabMenuEl = null; } };
  function tabMenu(t, x, y) {
    tabMenuClose();
    const m = document.createElement('div');
    m.className = 'dtmenu';
    m.setAttribute('role', 'menu');
    const item = (label, run, why) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      if (why) { b.disabled = true; b.title = why; }
      b.onclick = () => { tabMenuClose(); run(); };
      m.append(b);
    };
    const g = groupOf(t);
    item(t.pinned ? 'Unpin' : 'Pin', () => { t.pinned = !t.pinned; tabsChanged(); });
    item('Close', () => closeTab(t.id));
    item('Close others', async () => {
      for (const o of g.tabs.filter((x) => x !== t)) await closeTab(o.id);
    });
    item('Move to new group right', () => gSplitWith(g, 'r', t), splitWhy(g, 'r'));
    item('Move to new group below', () => gSplitWith(g, 'd', t), splitWhy(g, 'd'));
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
    // every group: its tabs (dirty: unsaved, live or parked), its front,
    // and which group is in front
    groups: () => groups.map((g) => ({
      id: g.id,
      focus: g === focusG,
      active: g.tabs.indexOf(gFront(g)),
      tabs: g.tabs.map((t) => ({ id: t.id, kind: t.kind, key: t.key,
        dirty: t === activeTab ? dirty === true : !!(t.snap && t.snap.dirty) })),
    })),
    focus: (i) => gFocus(groups[i]),
    move: (id, i, at = null) => {
      const t = allTabs().find((x) => x.id === id);
      return t && groups[i] ? gMove(t, groups[i], at) : Promise.resolve(false);
    },
  };
