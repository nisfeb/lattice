  // ── open / new / save ────────────────────────────────────────────────────
  const setFolderCtx = (name) =>
    { folderCtx = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''; };

  // Opening a page should cost nothing. Three tiers, cheapest first:
  //   1. seen this session -> pageCache has the rendered answer: 0 requests.
  //   2. body came with the tree dump -> paint the editor NOW, then fetch
  //      render=1 only to fill in `share` and the preview.
  //   3. no body (oversized page, or a tree we never loaded) -> as before.
  // History and backlinks stay lazy on panel expand. They were 2 more ~2s
  // round-trips paid on every open whether or not anyone looked at them.
  // Which open is current. Opening a page is an explicit user act, so the ONLY
  // reason to discard a landed response is that the user opened something else
  // while it was in flight, not that the editor was dirty, and not that
  // `current` had not been set yet. Guarding on those meant an explicit open
  // was silently dropped. After an unsaved edit, clicking another file did
  // nothing, and a page absent from the local tree never applied at all.
  // openKnow and openGrub take a number from the same sequence, and so does
  // a tab switch (21-tabs.js), so any later open supersedes this one.
  //
  // Answers false when the open failed with nothing painted, which the tab
  // model tells apart from an open that a later one superseded.
  let openSeq = 0;
  async function openPage(name) {
    // guardDirty covers a dirty grub, page, or memory in one place (see
    // 20-state.js): it flushes what it can and only asks when the flush
    // still leaves something unsaved.
    if (!(await guardDirty())) return false;
    const my = ++openSeq;
    // leaving grub mode: clear the flag or the save button would keep writing
    // to the grub while the editor shows a page
    grubPath = null;
    // and knowledge mode: search results and the comments inbox open pages
    // from know mode, and a stale mode routed the next save to /know-save —
    // a new memory named after the page, while the page kept its old body
    if (mode === 'know') setMode('pages');
    src.readOnly = false;
    setFolderCtx(name);
    // the queue outranks every other tier. A queued edit is the newest truth
    // for this page whether or not the ship is reachable right now
    const q = await offGet(name);
    if (q) {
      const d = { body: q.body, kind: q.kind, rev: q.baseRev || 0, share: 'private' };
      applyPage(name, d, true);
      snapPage(name, d);
      return true;
    }
    // a link reads live from its host every time (the spec's rule), so the
    // session cache never answers for one
    const hit = !linkOf(name) && pageCache.get(name);
    if (hit) { applyPage(name, hit); snapPage(name, hit); return true; }
    const node = nodes.find((n) => n.page && n.path === name);
    const painted = !!node && typeof node.body === 'string';
    // the render=1 read below brings the page's sensitive flag, so the
    // Page tab's checkbox waits for it rather than asking on its own
    // (66-share.js refreshSensitive). Whatever way the read ends, the
    // checkbox is settled once it has.
    if (!linkOf(name)) sensWait = name;
    try { return await openRead(name, my, node, painted); }
    finally {
      if (sensWait === name) {
        sensWait = null;
        if (current === name && !curFolder) refreshSensitive(name);
      }
    }
  }
  async function openRead(name, my, node, painted) {
    // `quiet`: the render=1 request below carries the preview and the error
    // report, so painting must not also fire refreshPreview/checkErrors.
    if (painted) {
      applyPage(name, node, true);
      // snapshot NOW, not only after the render fetch below. The snapshot is
      // what a bare launch (the PWA) resumes from, and a session that ends
      // during the fetch would otherwise remember nothing. The fetch's
      // snapPage upgrades this with the rendered html when it lands.
      snapPage(name, node);
    }
    // What the editor shows as the fetch leaves. When `painted`, the open has
    // already visibly happened and the fetch below is an UPGRADE (share, the
    // rendered html) — not the open itself.
    //
    // When NOT painted (a body the dump did not carry), the user just clicked
    // and nothing changed on screen — on a slow pier that silence lasts
    // seconds and reads as a dead click. Say the open is happening; every
    // exit below already replaces this status.
    let fromUrl = null;
    if (!painted) {
      stWork('opening ' + name + '\u2026');
      // commit the address NOW, before the fetch. A reload mid-open (the
      // service-worker takeover) must resume THIS page. Painted opens already
      // set the address synchronously via applyPage; this fetch lands seconds
      // later on a slow pier, and until it did the address still named the
      // page open before the click, so a reload resumed the wrong document.
      // Remember the old address so a FAILED open puts it back: without that,
      // a reload after a 404 would strand on the bad name instead of resuming
      // the document the editor is still showing.
      fromUrl = location.pathname + location.search;
      history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
    }
    //  undo the speculative address on a failed open, but only if no later
    //  open has run meanwhile (that one owns the address now, so leave it).
    const unwind = () => { if (fromUrl && my === openSeq) history.replaceState(null, '', fromUrl); };
    const shown = src.value;
    let d = null, gen = -1;
    try {
      gen = sensGen;
      const r = await srcRead(name);
      // a link whose host did not answer: its badge from now, and the last
      // copy read, which the ship sends its owner along with the failure.
      // Shown locked (linkStale): a save from it would claim a rev the host
      // may have moved past, and there is no host to save to anyway.
      if (r.status === 504 && linkOf(name)) {
        linkSeen(name, false);
        let j = null;
        try { j = await r.json(); } catch {}
        if (my !== openSeq) return;
        const why = (j && j.error) || linkOf(name).host + ' is unreachable or no longer shares this page';
        if (j && j.cached && typeof j.cached.body === 'string') {
          linkStale.add(name);
          applyPage(name, j.cached);
          st(why + '. Showing the last copy read, read-only', false);
          return true;
        }
        if (painted) return true;
        st('open failed: ' + why, false); unwind();
        return false;
      }
      if (!r.ok) {
        if (painted) return true;
        st('open failed' + await errText(r), false); unwind();
        return my === openSeq ? false : undefined;
      }
      d = await r.json();
    } catch {
      if (painted) return true;
      st('open failed', false); unwind();
      return my === openSeq ? false : undefined;
    }
    // the ship's flag as of this read replaces the kept one, unless a
    // write of ours (a toggle, a move, a delete) went out since it was sent
    if (typeof d.sensitive === 'boolean' && sensGen === gen) sensKnown.set(name, d.sensitive);
    // a later openPage supersedes this one. Anything else still applies
    if (my !== openSeq) {
      // ...but it is still the ship's answer for this page, so a switch
      // back to it need not ask again. Remembered only when it holds the
      // body the tree holds, the text a painted open would show anyway:
      // a save from here since then patched the tree (patchLocal), and
      // this older answer then stays out of the cache.
      const nd = nodes.find((n) => n.page && n.path === name);
      if (!d.link && !pageCache.has(name) && nd && !nd.link && nd.body === d.body
          && !(typeof nd.rev === 'number' && nd.rev > d.rev)) pageCache.set(name, d);
      return;
    }
    // a live read: the badge, the lock on a last-known copy and a conflict
    // latched on this link all end here
    if (d.link) { linkSeen(name, true); linkStale.delete(name); linkCf.delete(name); }
    // An upgrade of an ALREADY-PAINTED open must never clobber keystrokes
    // typed while it was in flight. On a busy pier this fetch lands many
    // seconds after the paint, and it carries the PRE-edit body: applying it
    // replaced what you just typed, and the next autosave wrote that stale
    // text back over the good save. The editor ate work the ship had.
    //
    // Compared by TEXT, not by `dirty`: autosave clears dirty inside this very
    // window, which is how the old dirty-guards kept failing to catch it.
    // The !painted arm stays unconditional on purpose — there the fetch IS the
    // open, and an explicit open must always land (see the head comment).
    // The flag is not the body, though: the comments switch takes it from
    // this answer whatever was typed meanwhile, or it stays unknown.
    if (painted && src.value !== shown) {
      if (current === name && typeof d.comments === 'boolean') cmtShow(name, d.comments);
      return true;
    }
    // Cache and snapshot BELOW the guards, not above. A stale or superseded
    // response that reached the cache here poisoned it with the pre-edit body:
    // the guard protected the editor but not the cache, so switching away and
    // back repainted the old text — the same data loss through a different
    // door. Only a response that is actually applied may be remembered.
    if (!d.link) pageCache.set(name, d);
    snapPage(name, d);
    applyPage(name, d);
    return true;
  }
  function applyPage(name, d, quiet) {
    curFolder = null;
    setCtlLabels();
    setOpen(name, { readOnly: true, kind: d.kind,
      url: '/apps/lattice/app?name=' + encodeURIComponent(name) });
    curKind = d.kind;
    curRev = d.rev || 0;
    refreshTexButton();
    src.value = d.body;
    dirty = false;
    // A fresh editor state begins here. everTyped answers "did the user type
    // since this view was established?" for boot's reconcile guard; carrying
    // it across a navigation would mark every later untouched page as touched.
    everTyped = false;
    render(); syncSoon();
    markCurrent();
    st(d.kind + ' · rev ' + d.rev);
    exitRev();
    // after exitRev, which unlocks: a link with a read grant, or one shown
    // from its last-known copy, stays locked (30-tree.js linkRO). The tab
    // restore comes through here too.
    src.readOnly = linkRO(name);
    resetPanels();
    showShare(d.share || 'private');
    cmtShow(name, d.comments);
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
    //  a tex page's server render is its SOURCE as escaped text, because the
    //  ship has no LaTeX and is not getting one. The local conversion is the
    //  only true render, and it arrives first, so letting the ship's answer
    //  land here would overwrite a rendered document with its own source.
    //  ...and through the same fit wrapper the local paint uses: the frame
    //  is sized to its content by a reporter inside the document, and the
    //  ship's render has none. Written verbatim it replaced the fitted local
    //  paint a moment later, and the frame scrolled itself again with the
    //  engine's native (light) bar. Every screenshot taken before this answer
    //  landed looked fixed; the one the user looks at is after it.
    if (typeof d.html === 'string' && d.kind !== 'tex') {
      prev.removeAttribute('src'); prev.srcdoc = withPreviewScrollbars(d.html, true);
    }
    else if (!quiet) refreshPreview();
    // A quiet open is the COMMON one: the tree dump already carried the body,
    // so the editor painted instantly and the render=1 fetch is an upgrade.
    // refreshPreview is suppressed there to avoid a second render — but that
    // left the PREVIEW alone on the pier, still showing the document you just
    // navigated away from until the fetch landed. That is the "previews are
    // slow" report: the editor was never slow, the pane beside it was.
    // Paint locally now; the fetch still corrects it when it arrives.
    else paintLocal();
    if (!CONTENT() && !quiet) checkErrors();
    drawersClose();
  }

  // blankPage: the editor reset a new page starts from. Nothing named is
  // open, the field (where shown) is editable, and `into` is the folder an
  // upload or a save lands in. A page is never written in memory mode: the
  // autosave there goes to /know-save, so a memory in front leaves it first.
  function blankPage(into) {
    if (mode === 'know') setMode('pages');
    openSeq++;           // an open still in flight must not land over this
    folderCtx = into || '';
    curFolder = null;
    curKind = null;
    refreshTexButton();
    exitGrub();
    exitRev();
    setCtlLabels();
    setOpen(null, { shown: into ? into + '/' : '', url: '/apps/lattice/app' });
    src.value = '';
    dirty = false;
    everTyped = false;   // a new file is a fresh editor state, like applyPage
    render();
    renderTree();
    st('new page — name it, write, save');
    prevBlank();
    showShare('private');
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
  }

  // ── new page: one name and kind dialog for web, desktop and phone ────────
  //  Everything user-initiated routes through newFile: the toolbar
  //  (newFile('')), the desktop File menu (which clicks it), the green + on
  //  every tree folder (newFile(path)), the strip's + and the phone bar's
  //  label. The name field left the screen with the old bar, so the dialog
  //  is the one way a page gets its name, and its kind.
  //
  //  focusName false is boot and the tab model landing on an empty page.
  //  That must not be interrupted by a dialog, and they are the callers that
  //  say so: a plain reset, nothing asked.
  function newFile(into, focusName = true) {
    if (!focusName) return blankPage(into);
    (async () => {
      //  a folder's + pre-fills that folder; the toolbar keeps offering the
      //  open page's path (never a memory's key: that names no page). Read
      //  it BEFORE the reset below, which clears the field it comes from.
      //  A tool tab in front hides the editor, so its name field is no seed.
      const seed = into ? into.replace(/\/+$/, '') + '/'
        : mode === 'know' || !docFront() ? '' : (pname.value || '');
      const picked = await askNameKind('page name (e.g. notes/todo)', seed,
        'create', pkind.value);
      if (!picked) return;
      //  reset the editor only once the create is confirmed, so a cancel
      //  leaves the open page exactly as it was. Under a tool tab the page
      //  gets a document tab of its own first (docTab, 21-tabs.js).
      if (!(await docTab())) return;
      blankPage(into);
      let name = picked.name;
      let kind = picked.kind;
      //  a typed extension still wins, because typing notes/todo.md and being
      //  given a page called "todo.md" would be absurd. The table is EXT_KIND
      //  in 30-tree.js, the same one the uploader files by.
      const dot = name.lastIndexOf('.');
      const typed = dot > 0 ? extKind(name.slice(dot + 1)) : null;
      if (typed) { kind = typed; name = name.slice(0, dot); }
      //  the field is seeded with the REAL path; the typed leaf, when it was
      //  not a valid path, rides to save() as the display name
      const rn = realName(name);
      if (!rn) return;
      name = rn.name;
      newRn = rn;
      pkind.value = kind;
      //  blankPage above left nothing open; this names the buffer, and
      //  setOpen's event repaints the labels
      setOpen(null, { shown: name });
      //  Show it in the tree NOW, pulsing, before the ship has agreed. The
      //  write is a pier round trip and the tree sitting unchanged through it
      //  reads as nothing having happened. The pulse is the honest part: it
      //  says recorded, not yet confirmed. Cleared on success, and the row is
      //  dropped on failure so a page that does not exist is never left there.
      const already = nodes.some((n) => n.page && n.path === name);
      if (!already) { addTreeNode(name, kind, true); applyDnames(rn); snapTree(); renderTree(); }
      //  the button says create, so write the page here. Naming the buffer
      //  and leaving it unwritten read as a create that did nothing. save()
      //  owns the whole create: 409, the offline queue, the tree patch and
      //  the url, so this must not reimplement any of it.
      //  queued behind another save, the create has not happened yet: the
      //  row keeps pulsing, and save() settles it when the create runs
      const queued = (await save()) === 'queued';
      if (!already && !queued) {
        //  save() sets `current` on any outcome it considers a success,
        //  including a queued offline write, which IS a success here.
        if (current === name) setTreePending(name, false);
        else { dropTreeNodes(name); snapTree(); renderTree(); }
      }
      src.focus();
    })();
  }

  async function newFolder() {
    // a server-side rejection (colliding with an existing page, say) used to
    // leave nothing to retype into: the dialog already closed the moment the
    // typed name passed client-side validName(). Loop back into askName
    // instead, seeded with the name that just failed, so the fix is an edit
    // rather than a full restart.
    let seed = folderCtx ? folderCtx + '/' : '';
    for (;;) {
      const typed = await askName('folder name (e.g. notes or notes/sub)', seed, 'create');
      if (!typed) return;
      const rn = realName(typed);
      const name = rn.name;
      const r = await mutate(api + '/folder-new?name=' + encodeURIComponent(name) + dnameQ(rn));
      if (r.ok || r.offline) {
        st(r.offline ? 'folder created offline' : 'folder created');
        addFolderNodes(name);
        applyDnames(rn);
        snapTree();
        renderTree();
        return;
      }
      st('folder failed' + await errText(r), false);
      seed = typed;
    }
  }

  //  The three steps save() and autosave() both owe. They are two policies
  //  over one protocol: what genuinely differs (a name to validate, 409 and
  //  the create branch on one side, the debounce and the know branch on the
  //  other) stays in each arm, and the bookkeeping that must never drift
  //  between them lives here.

  //  a save arriving mid-flight only set savePending: the save itself, to
  //  run again (an explicit save with the kindOverride it wanted, or a
  //  memory save), or bare `true` for an autosave. A re-run that forgot the
  //  kind and fell back to autosave's curKind/pkind guess is how a
  //  restore's revision kind used to vanish. And `true` for an explicit
  //  save made it an autosave, which does nothing for a page or memory not
  //  yet named: a Save clicked while another save was in flight on a slow
  //  pier was simply lost. Take the trailing save now, only if the text
  //  really is still unsaved.
  const flushPending = () => {
    if (!savePending) return;
    const pending = savePending;
    savePending = false;
    if (!dirty && !pending.create) return;
    if (typeof pending === 'function') pending(); else autosave();
  };
  //  queue `fn` behind the save in flight, replacing what waits there,
  //  except a create: that is a page the user asked for and nothing else
  //  would write it, so it is kept and runs first. `create` runs even on a
  //  clean buffer (flushPending).
  const queueSave = (fn, create) => {
    const prev = savePending;
    const keep = typeof prev === 'function' && prev.create;
    savePending = Object.assign(keep
      ? async () => { await prev(); if (create || dirty) return fn(); } : fn,
    { create: !!create || keep });
  };
  //  we know exactly what we just wrote. Patch the local copies so reopening
  //  this page paints the saved text, not the dump's pre-save body. The
  //  cached render is stale by definition. A content page's preview is
  //  the local paint, so its cached answer is kept with the saved text and
  //  rev and without the html: reopening it costs no page-source read.
  //  Any other kind's render is the ship's: drop it and let it re-render.
  //  Only a save that can change the kind passes one.
  const patchLocal = (name, kind, sent, rev) => {
    const c = pageCache.get(name);
    const k = kind || (c && c.kind);
    if (c && rev && ['md', 'gmi', 'html', 'text', 'tex'].includes(k)) {
      pageCache.set(name, { ...c, body: sent, kind: k, rev, html: undefined });
    } else pageCache.delete(name);
    const nd = nodes.find((n) => n.page && n.path === name);
    // not a link's: its text is the host's, read live, and the rev beside
    // a body here would be a base the next save claims falsely
    if (nd && !nd.link) { nd.body = sent; if (kind) nd.kind = kind; persistTree(); }
  };
  // an accidental tab close is the same data-loss shape as the grub-discard
  // guard up in openPage: a dirty edit, grub or page, exists only here
  // until it is saved. That guard catches deliberate in-app navigation. This
  // one catches the close and reload that never go through openPage at all.
  // A parked tab's buffer counts too (__latUnsaved, 20-state.js).
  window.addEventListener('beforeunload', (e) => {
    if (!window.__latUnsaved()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  //  A save through a link (30-tree.js) claims the owner's rev this editor
  //  read, as ?base=. Unlike a page of our own, a link has nowhere to keep
  //  a replaced body, so a stale claim is refused (409) and nothing is
  //  written. linkBase is that claim for a save of `name`, '' for a page
  //  (and for a link with no rev read yet: the ship then claims its cached
  //  rev, never nothing).
  const linkBase = (name) => (linkOf(name) && curRev ? '&base=' + curRev : '');
  //  a save through a link that did not land: the host's page moved on past
  //  what this editor read, or the host did not answer (a 502 or 504 the
  //  ship itself sent, never queued: the queue is for this ship being
  //  away). The text stays here, unsaved. -> true when it was one of those.
  //  And a link save is NEVER queued for later, also when this ship is the
  //  one away: a replay could only claim a base the host may have moved
  //  past, and the queue drops what is refused. The text stays here.
  async function linkSaveFail(name, w) {
    const lk = linkOf(name);
    const r = w.r;
    if (!lk) return false;
    if (r && r.status === 409) {
      linkCf.add(name);           // autosave stands down; the bar offers the ways out
      st('not saved: ' + lk.host + ' changed this page since you opened it', false);
    } else if (w.gone) {
      if (r && r.status === 504) linkSeen(name, false);
      st('not saved: ' + lk.host + ' is unreachable or no longer shares this page', false);
    } else return false;
    if (current === name) { cerr.textContent = 'NOT saved'; cerr.className = 'err'; }
    paintLinkCf(current);
    return true;
  }

  // the realName() split the create dialog (newFile) made before seeding
  // #pname with the real path; save() consumes it on create
  let newRn = null;
  // a create that lands with nothing else opened meanwhile: nothing is
  // named yet and the name field still names this page. Not the body:
  // text typed during the round trip changes it, which left the page
  // unnamed and its typing never autosaved (autosave needs `current`), and
  // two empty pages have the same one, so a create landing under a second
  // New took the second page's blank buffer for its own.
  const createdHere = (creating, name) => creating && current === null && pname.value === name;
  //  the editor holds a page: a group brought to the front during a save
  //  (28-splits.js) can hold a memory or a grub of the same name
  const pageHere = () => mode !== 'know' && !grubPath;
  //  the page `name` (as typed) is on the ship, or queued for it, and not
  //  a create's pulsing row still waiting for its answer
  const madePage = (name) => {
    const rn = realName(name);
    return !!rn && nodes.some((n) => n.page && n.path === rn.name && !n.pending);
  };
  //  `fixed`: a queued create whose page the editor no longer shows (see
  //  below). It names what to write, and the editor is left alone.
  async function save(kindOverride, fixed) {
    if (!fixed && curFolder) { st('folder selected — open a page to edit', false); return; }
    if (!fixed && viewingRev !== null) { st('viewing rev ' + viewingRev + ' — use restore', false); return; }
    let name = fixed ? fixed.name : pname.value.trim().replace(/^\/+|\/+$/g, '');
    if (!name) { st('name required', false); return; }
    const creating = !!fixed || current === null;
    // carry kindOverride into the re-arm: a bare `true` here forgot which
    // kind THIS call wanted, and the trailing run picked whatever the
    // picker happened to show by the time it fired
    //  a create queued here runs even when the buffer is clean by then (an
    //  empty new page is clean from the start): flushPending sees `create`
    //  It is queued for THIS document. By the time it runs the editor may
    //  show another, and save() writes whatever name and buffer it finds
    //  then, so it runs from the editor only if the editor still shows
    //  this one. A create carries what it creates (name, body, kind, the
    //  dialog's split), so a second New during the round trip still gets
    //  the first page written. 'queued' tells newFile it has not run yet.
    //  A create also waits behind the create before it for the same page (a
    //  second Ctrl+S during the round trip). Once that one has made the page
    //  it skips itself: a second create is a 409 about our own page. A page
    //  that was already there when it was queued still gets its honest 409.
    if (saving) {
      const doc = current, shown = pname.value;
      const own = fixed || (creating ? { name, body: src.value,
        kind: kindOverride || curKind || pkind.value, rn: newRn,
        existed: madePage(name), tab: activeTab && activeTab.id } : null);
      if (creating && !fixed) newRn = null;
      queueSave(() => {
        if (own && !own.existed && madePage(own.name)) {
          const rn = realName(own.name);
          if (!fixed && mode !== 'know' && !grubPath && rn && current === rn.name && dirty)
            return save(kindOverride);
          return;
        }
        const here = !fixed && mode !== 'know' && !grubPath && current === doc
          && (doc !== null || pname.value === shown);
        if (here) { if (own) newRn = own.rn; return save(kindOverride); }
        if (own) return save(kindOverride, own);
      }, creating);
      return 'queued';
    }
    saving = true;
    st('saving…');
    // capture the exact body being sent: keystrokes landing during the round-trip
    // must NOT be marked clean, or the next refresh swaps the stale server copy
    // in and the typed text is lost (same guard autosave has always had).
    const sent = fixed ? fixed.body : src.value;
    const kind = fixed ? fixed.kind : kindOverride || curKind || pkind.value;
    // NO base on live saves, deliberately: base is the OFFLINE queue's tool,
    // where the divergence window is real. Online, any dirty-blocked refresh
    // or panel-driven save can leave curRev one step behind, and every stale
    // base manufactures a false conflict page out of nothing (ui-matrix
    // caught exactly that). Online editing stays last-writer-wins.
    const rn = realName(name);
    if (!rn) {
      saving = false;
      st('bad name — use at least one letter or digit', false);
      return;
    }
    // a typed name that is not a valid path saves under its slug and keeps
    // the typed text as display names (the tree shows those, the name
    // field shows the real path). newRn is the create dialog's copy of
    // the same split, made before it seeded the field with the slug.
    const rnc = !creating ? null : rn.dnames ? rn : fixed ? fixed.rn : newRn;
    if (!fixed) newRn = null;
    const dname = rnc ? rnc.dname : '';
    //  the field shows the slug from here on; nothing else about what is
    //  open changes, so `current` and the lock are passed through as they are
    if (rn.name !== name) {
      name = rn.name;
      if (!fixed) setOpen(current, { shown: name, readOnly: pname.readOnly });
    }
    //  a write that did not land: a create's pulsing row goes (newFile put
    //  it there, and a create that ran from the queue settles its own row),
    //  and the save queued behind this one still runs. It checks what it
    //  was queued for, so it never writes another document.
    const failed = () => {
      if (creating && nodes.some((n) => n.page && n.path === name && n.pending)) {
        dropTreeNodes(name); snapTree(); renderTree();
      }
      flushPending();
    };
    const url = api + '/page-save?name=' + encodeURIComponent(name) +
      '&type=' + kind + (creating ? '&new=1' : '') + dnameQ(rnc) + (creating ? '' : linkBase(name));
    let w = { gone: true };
    //  behind a folder job a save would only wait out its timeout and land
    //  after the queued ones: it joins the queue, which keeps the newest
    const sentAt = Date.now();
    try {
      if (!(jobWait && !creating && !linkOf(name)))
        w = await shipWrite(url, { method: 'POST', body: sent || '\n' }, { save: true });
    } finally { saving = false; }
    const r = w.r;
    if (await linkSaveFail(name, w)) return failed();
    if (w.gone) {
      // the ship is unreachable. Queue the edit and complete the save's
      // LOCAL bookkeeping exactly as a successful save would, so the editor
      // does not care which kind it got
      // A failed queue write means this edit exists ONLY in the textarea.
      // Clearing dirty there would tell the editor the work is safe and let
      // the next navigation drop it, so the bookkeeping stays untouched and
      // the page keeps behaving as unsaved. enqueueSave has already said so.
      const queued = await enqueueSave(name, kind, sent, creating, rnc);
      if (!queued) {
        cerr.textContent = 'NOT saved'; cerr.className = 'err';
        return failed();
      }
      if (creating) { addTreeNode(name, kind, false); applyDnames(rnc); snapTree(); renderTree(); }
      // same stillHere guard as the online path: only touch live editor state
      // if the editor has not moved to another document during the round-trip.
      const stillHere = fixed ? tabAdopt(fixed, name)
        : pageHere() && (current === name || createdHere(creating, name));
      if (!stillHere) tabLanded('page', name, sent);
      if (stillHere) {
        current = name;
        tabFollow();         // a new page's tab is named now (21-tabs.js)
        curKind = kind;
        pname.readOnly = true;
        if (src.value === sent) dirty = false;
        else if (!savePending) savePending = true;
        history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
        cerr.textContent = queued === 'job' ? 'saves after the folder job' : 'saved offline';
        cerr.className = 'ok';
      }
      flushPending();
      return;
    }
    if (r && r.status === 409) { st('that page already exists', false); return failed(); }
    if (!r.ok) { st('save failed' + await errText(r), false); return failed(); }
    // the response carries the new revision and whether this save landed
    // on top of a revision made elsewhere; parse it regardless of focus.
    let vr = null;
    try { vr = await r.json(); } catch {}
    // saved-document bookkeeping, applied whether or not the editor still
    // shows it, so a New clicked mid-save keeps both documents. Only a
    // CREATE changes the tree, and it confirms a row newFile left pulsing.
    if (creating) { addTreeNode(name, kind, false); applyDnames(rnc); snapTree(); renderTree(); }
    patchLocal(name, kind, sent, vr && vr.rev);
    await dropQueued(name, sentAt);
    // live-editor state ONLY if the editor still shows the saved document.
    // A New or open during the round-trip moved it; rewriting current, the
    // name field, dirty or the URL here would brand the new page as this save.
    //  A create run from the queue (`fixed`) is still here only when its
    //  own tab came back to the front, unnamed, during the round trip;
    //  in the background that tab is named for it instead (tabAdopt).
    const stillHere = fixed ? tabAdopt(fixed, name)
      : pageHere() && (current === name || createdHere(creating, name));
    if (!stillHere) tabLanded('page', name, sent, vr && vr.rev);
    if (stillHere) {
      current = name;
      tabFollow();           // a new page's tab is named now (21-tabs.js)
      curKind = kind;
      pname.readOnly = true;
      if (src.value === sent) dirty = false;
      else if (!savePending) savePending = true;   // flushPending below saves it
      if (vr && vr.rev) curRev = vr.rev;
      if (linkCf.delete(name)) paintLinkCf(name);   // a retried link save landed
      if (vr && vr.conflicted) {
        st('saved — replaced an edit from elsewhere; it is kept at ' + vr.kept, false);
      } else if (dname) st('saved as ' + name + ' (shown as ' + dname + ')');
      else st(CONTENT() ? 'saved' : 'compiling\u2026');
      history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
      if (CONTENT()) { cerr.textContent = 'saved'; cerr.className = 'ok'; }
      else { setTimeout(checkErrors, 800); setTimeout(checkErrors, 2200); }
    }
    flushPending();
    if (offCount) replayQueue(true);     // back online: drain the backlog
  }

  let autoTimer = null;
  const autosaveOn = () => { try { return localStorage.latAutosave !== '0'; } catch { return true; } };
  // turned back on in Settings (another document) while text waits unsaved:
  // it goes out on the usual debounce, as if just typed
  window.addEventListener('storage', (e) => {
    if (e.key !== 'latAutosave' || !autosaveOn() || !dirty) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(autosave, 2000);
  });
  async function autosave() {
    // GRUB MODE IS EXPLICIT-SAVE ONLY. Autosaving a lattice page is fine. It is
    // your own note and the editor has always worked that way. Autosaving
    // another app's source is not. A half-typed edit to calendar.html would go
    // live 2s after you paused, and the 5-minute history window may not have
    // kept a revision fine-grained enough to step back to. Save/Cmd+S only.
    // The 2s debounce still fires. It just reports instead of writing, so the
    // moment you stop typing you can see the edit is not yet on the ship.
    if (grubPath) { if (dirty) st('unsaved, Ctrl+S to save'); return; }
    if (!current || curFolder || !dirty || viewingRev !== null) return;
    // a link whose save was refused as stale: no more writes until the
    // user picks one of the bar's ways out, or saves on purpose (Ctrl+S)
    if (mode !== 'know' && linkCf.has(current) && linkOf(current)) {
      st('not saved: ' + linkOf(current).host + ' changed this page since you opened it', false);
      return;
    }
    // Settings > Editor > Autosave pages, off: manual only. This debounce
    // stops, and so do the flushes a tab switch or a navigation makes
    // (flushNoAsk and guardDirty, 20-state.js, which ask instead). Only
    // Ctrl+S, the save button and :w write.
    if (!autosaveOn()) { st('unsaved, Ctrl+S to save'); return; }
    // never overlap saves. The pier serializes, so a second in-flight save is
    // 3.7s of stale-body work queued behind the first, delaying every preview
    // behind it. Coalesce to one trailing save instead.
    //  never over an explicit save already waiting: that one names its kind
    if (saving) { if (!savePending) savePending = true; return; }
    saving = true;
    // the document this autosave owns. If the user navigates mid-flight,
    // `current` moves; everything below acts on `target`, not the new current.
    //  and what it is: a group coming to the front (28-splits.js) can
    //  change the mode and the kind in the editor while this flies
    const target = current;
    const sent = src.value;
    const know = mode === 'know';
    const tkind = curKind || pkind.value;
    const trev = curRev;
    const here = () => current === target && (mode === 'know') === know && !grubPath;
    const url = know
      ? api + '/know-save?key=' + encodeURIComponent(target)
      : api + '/page-save?name=' + encodeURIComponent(target) +
        '&type=' + tkind + linkBase(target);
    let w = { gone: true };
    const sentAt = Date.now();
    try {
      if (!(jobWait && !know && !linkOf(target)))
        w = await shipWrite(url, { method: 'POST', body: sent || '\n' }, { save: true });
    } finally { saving = false; }
    const r = w.r;
    if (!know && await linkSaveFail(target, w)) { flushPending(); return; }
    //  a document parked meanwhile keeps its own copy (21-tabs.js), which
    //  is what was sent unless it was typed into after
    const tk = know ? 'know' : 'page';
    if (w.gone) {
      //  same rule on the autosave path: if it did not queue, it is not saved,
      //  so the editor stays dirty and keeps the text under the cursor
      if (!(await (know ? enqueueKnow(target, sent) : enqueueSave(target, tkind, sent, false, null, trev)))) {
        flushPending();
        return;
      }
      if (here() && src.value === sent) dirty = false;
      else tabLanded(tk, target, sent);
      flushPending();
      return;
    }
    if (!r.ok) { st('autosave failed' + await errText(r), false); flushPending(); return; }
    let vr = null;
    if (!know) { try { vr = await r.json(); } catch {} }
    //  patch the saved doc's local cache regardless of focus. No kind: an
    //  autosave writes the page's existing kind, it never sets one.
    if (!know) { patchLocal(target, null, sent, vr && vr.rev); await dropQueued(target, sentAt); }
    if (!here()) tabLanded(tk, target, sent, vr && vr.rev);
    // live-editor state only if the editor is still on the doc we autosaved
    if (here()) {
      if (src.value === sent) dirty = false;   // typed during the request? stay dirty
      if (!know && vr && vr.rev) curRev = vr.rev;
      // the conflict verdict must be the LAST word, not clobbered by the
      // ordinary confirmation a line later
      if (vr && vr.conflicted)
        st('autosaved — replaced an edit from elsewhere; it is kept at ' + vr.kept, false);
      else st('autosaved');
      if (!know && !CONTENT()) setTimeout(checkErrors, 800);
    }
    flushPending();
    if (offCount) replayQueue(true);     // this autosave proves the ship is back too
  }

  // ── saving a parked buffer ──────────────────────────────────────────────
  // A group that leaves the front (gRelease, 21-tabs.js) does not wait for
  // its flush: its tab's unsaved text goes into the tab's snap, and this
  // writes it from there, on autosave's terms. Pages and memories only,
  // with a name, autosave on, and never a link autosave stands down for.
  // It takes its turn behind any save in flight (one write at a time) and
  // gives up once the tab is not parked any more, since then the live
  // editor's own autosave owns the text. What lands marks the snap clean
  // only if it still holds what was sent; a tab that came back to the
  // front meanwhile is marked clean live, by the same rule.
  async function saveParked(t) {
    const s = t.snap;
    if (!s || !s.dirty || !t.key || !autosaveOn()) return;
    if (t.kind !== 'page' && t.kind !== 'know') return;
    const know = t.kind === 'know';
    if (!know && linkCf.has(t.key) && linkOf(t.key)) return;
    parkedRun++;
    try { await parkedSave(t, s, know); } finally { parkedRun--; }
  }
  async function parkedSave(t, s, know) {
    // settled, not only off the wire: a save clears `saving` before its
    // bookkeeping (tabLanded) marks this snap clean and gives it the new
    // rev, and a write from the gap was a duplicate, on a link one that
    // claimed the old rev and drew a false conflict
    await savesSettled(false);
    if (!know && linkCf.has(t.key) && linkOf(t.key)) return;
    if (t.snap !== s || !s.dirty || !allTabs().includes(t)) return;
    saving = true;
    const name = t.key;
    const sent = s.body;
    const kind = s.kind || s.pkind;
    const url = know ? api + '/know-save?key=' + encodeURIComponent(name)
      : api + '/page-save?name=' + encodeURIComponent(name) + '&type=' + kind
        + (linkOf(name) && s.rev ? '&base=' + s.rev : '');
    let w = { gone: true };
    //  behind a folder job a page's save queues instead of going out, as
    //  the live editor's does (jobWait, 08-offline.js)
    const sentAt = Date.now();
    try {
      if (!(jobWait && !know && !linkOf(name)))
        w = await shipWrite(url, { method: 'POST', body: sent || '\n' }, { save: true });
    } finally { saving = false; }
    const landed = (rev) => {
      tabLanded(t.kind, name, sent, rev);
      // back in front by now: the live editor holds it
      if (t === activeTab && current === name && (mode === 'know') === know && !grubPath) {
        if (src.value === sent) dirty = false;
        if (!know && rev) curRev = rev;
      }
    };
    if (!know && await linkSaveFail(name, w)) { flushPending(); return; }
    if (w.gone) {
      if (await (know ? enqueueKnow(name, sent) : enqueueSave(name, kind, sent, false, null, s.rev)))
        landed(null);
      flushPending();
      return;
    }
    if (!w.r.ok) {
      st('autosave of ' + name + ' failed' + await errText(w.r), false);
      flushPending();
      return;
    }
    let vr = null;
    //  and a queued edit older than this save is superseded by it
    if (!know) {
      try { vr = await w.r.json(); } catch {}
      patchLocal(name, null, sent, vr && vr.rev);
      await dropQueued(name, sentAt);
    }
    else knowGen++;
    landed(vr && vr.rev);
    st('autosaved ' + name);
    flushPending();
    if (offCount) replayQueue(true);
  }

  // Every save is counted from its start to the end of its bookkeeping
  // (saveTail), and every background save of a parked tab while it runs
  // (parkedRun). savesSettled waits until none is left, `parked` saying
  // whether the parked ones count, capped past a save's own timeout.
  let saveTail = 0, parkedRun = 0;
  const tailed = (fn) => async (...a) => {
    saveTail++;
    try { return await fn(...a); } finally { saveTail--; }
  };
  autosave = tailed(autosave);
  save = tailed(save);
  saveKnow = tailed(saveKnow);
  saveGrub = tailed(saveGrub);
  async function savesSettled(parked = true) {
    const t0 = Date.now();
    while ((saving || saveTail || (parked && parkedRun)) && Date.now() - t0 < 35000)
      await new Promise((r) => setTimeout(r, 50));
  }

  // ── a link whose save was refused as stale ──────────────────────────────
  // The host's page moved on past the rev this editor read, so the text
  // here was not written and is the only copy. A bar over the document
  // offers the two ways out; until one is taken autosave stands down for
  // that link (linkCf, 30-tree.js) and only Ctrl+S tries again.
  const lcfBar = document.createElement('div');
  lcfBar.id = 'lnkcf';
  lcfBar.className = 'lnkcf';
  lcfBar.hidden = true;
  lcfBar.setAttribute('role', 'alert');
  lcfBar.innerHTML = '<span id="lnkcfmsg"></span>' +
    '<button type="button" id="lnkcfre">Reload theirs</button>' +
    '<button type="button" id="lnkcfkeep">Keep mine as a copy</button>';
  $('docarea').before(lcfBar);
  //  by id, not lcfBar: paintLink (65-ctl.js) can run before this file has
  function paintLinkCf(name) {
    const bar = $('lnkcf');
    if (!bar) return;
    const lk = name && name === current && linkCf.has(name) ? linkOf(name) : null;
    bar.hidden = !lk;
    if (lk) $('lnkcfmsg').textContent = lk.host + ' changed this page since you opened it. ' +
      'Your text here is not saved.';
  }
  // drop what is here and read theirs again
  async function linkReload() {
    const name = current;
    if (!linkOf(name)) return;
    dirty = false;
    clearTimeout(autoTimer);
    linkCf.delete(name);
    paintLinkCf(name);
    await openPage(name);
  }
  // what is here becomes a page of my own beside the link (<name>-mine, or
  // -mine-2 and on when that is taken), then theirs is read again
  async function linkKeepMine() {
    const name = current;
    const lk = linkOf(name);
    if (!lk) return;
    const body = src.value;
    const kind = curKind || pkind.value;
    for (let i = 1; i < 100; i++) {
      const copy = name + '-mine' + (i > 1 ? '-' + i : '');
      if (nodes.some((n) => n.path === copy)) continue;
      const r = await fetch(api + '/page-save?name=' + encodeURIComponent(copy) + '&type=' + kind +
        '&new=1', { method: 'POST', body: body || '\n' }).catch(() => null);
      if (r && r.status === 409) continue;
      if (!r || !r.ok) { st('copy failed' + await errText(r) + ', your text is still here', false); return; }
      if (current !== name) return;
      addTreeNode(copy, kind, false);
      snapTree();
      renderTree();
      await linkReload();
      st('your text is kept at ' + copy + '; ' + name + ' shows ' + lk.host + '\u2019s again');
      return;
    }
  }
  $('lnkcfre').onclick = linkReload;
  $('lnkcfkeep').onclick = linkKeepMine;
