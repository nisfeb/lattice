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
    const hit = pageCache.get(name);
    if (hit) { applyPage(name, hit); snapPage(name, hit); return true; }
    const node = nodes.find((n) => n.page && n.path === name);
    const painted = !!node && typeof node.body === 'string';
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
    let d = null;
    try {
      const r = await fetch(api + '/page-source?name=' + encodeURIComponent(name) + '&render=1');
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
    // a later openPage supersedes this one. Anything else still applies
    if (my !== openSeq) return;
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
    if (painted && src.value !== shown) return true;
    // Cache and snapshot BELOW the guards, not above. A stale or superseded
    // response that reached the cache here poisoned it with the pre-edit body:
    // the guard protected the editor but not the cache, so switching away and
    // back repainted the old text — the same data loss through a different
    // door. Only a response that is actually applied may be remembered.
    pageCache.set(name, d);
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
    render(); sync();
    markCurrent();
    st(d.kind + ' · rev ' + d.rev);
    exitRev();
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
    if (isMobile()) setMv('code');
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
      const seed = into ? into.replace(/\/+$/, '') + '/'
        : mode === 'know' ? '' : (pname.value || '');
      const picked = await askNameKind('page name (e.g. notes/todo)', seed,
        'create', pkind.value);
      if (!picked) return;
      //  reset the editor only once the create is confirmed, so a cancel
      //  leaves the open page exactly as it was
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
      await save();
      if (!already) {
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
    if (!dirty) return;
    if (typeof pending === 'function') pending(); else autosave();
  };
  //  we know exactly what we just wrote. Patch the local copies so reopening
  //  this page paints the saved text, not the dump's pre-save body. The
  //  cached render is stale by definition. Drop it and let it re-render.
  //  Only a save that can change the kind passes one.
  const patchLocal = (name, kind, sent) => {
    pageCache.delete(name);
    const nd = nodes.find((n) => n.page && n.path === name);
    if (nd) { nd.body = sent; if (kind) nd.kind = kind; persistTree(); }
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

  // the realName() split the create dialog (newFile) made before seeding
  // #pname with the real path; save() consumes it on create
  let newRn = null;
  async function save(kindOverride) {
    if (curFolder) { st('folder selected — open a page to edit', false); return; }
    if (viewingRev !== null) { st('viewing rev ' + viewingRev + ' — use restore', false); return; }
    let name = pname.value.trim().replace(/^\/+|\/+$/g, '');
    if (!name) { st('name required', false); return; }
    const creating = current === null;
    // carry kindOverride into the re-arm: a bare `true` here forgot which
    // kind THIS call wanted, and the trailing run picked whatever the
    // picker happened to show by the time it fired
    if (saving) { savePending = () => save(kindOverride); return; }
    saving = true;
    st('saving…');
    // capture the exact body being sent: keystrokes landing during the round-trip
    // must NOT be marked clean, or the next refresh swaps the stale server copy
    // in and the typed text is lost (same guard autosave has always had).
    const sent = src.value;
    const kind = kindOverride || curKind || pkind.value;
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
    const rnc = !creating ? null : rn.dnames ? rn : newRn;
    newRn = null;
    const dname = rnc ? rnc.dname : '';
    //  the field shows the slug from here on; nothing else about what is
    //  open changes, so `current` and the lock are passed through as they are
    if (rn.name !== name) {
      name = rn.name;
      setOpen(current, { shown: name, readOnly: pname.readOnly });
    }
    const url = api + '/page-save?name=' + encodeURIComponent(name) +
      '&type=' + kind + (creating ? '&new=1' : '') + dnameQ(rnc);
    let w = { gone: true };
    try { w = await shipWrite(url, { method: 'POST', body: sent || '\n' }, { save: true }); }
    finally { saving = false; }
    const r = w.r;
    if (w.gone) {
      // the ship is unreachable. Queue the edit and complete the save's
      // LOCAL bookkeeping exactly as a successful save would, so the editor
      // does not care which kind it got
      // A failed queue write means this edit exists ONLY in the textarea.
      // Clearing dirty there would tell the editor the work is safe and let
      // the next navigation drop it, so the bookkeeping stays untouched and
      // the page keeps behaving as unsaved. enqueueSave has already said so.
      if (!(await enqueueSave(name, kind, sent, creating, rnc))) {
        cerr.textContent = 'NOT saved'; cerr.className = 'err';
        return;
      }
      if (creating) { addTreeNode(name, kind); applyDnames(rnc); snapTree(); renderTree(); }
      // same stillHere guard as the online path: only touch live editor state
      // if the editor has not moved to another document during the round-trip.
      const stillHere = current === name || (current === null && src.value === sent);
      if (stillHere) {
        current = name;
        tabFollow();         // a new page's tab is named now (21-tabs.js)
        curKind = kind;
        pname.readOnly = true;
        if (src.value === sent) dirty = false;
        history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
        cerr.textContent = 'saved offline'; cerr.className = 'ok';
      }
      flushPending();
      return;
    }
    if (r && r.status === 409) { st('that page already exists', false); return; }
    if (!r.ok) { st('save failed' + await errText(r), false); return; }
    // the response carries the new revision and whether this save landed
    // on top of a revision made elsewhere; parse it regardless of focus.
    let vr = null;
    try { vr = await r.json(); } catch {}
    // saved-document bookkeeping, applied whether or not the editor still
    // shows it, so a New clicked mid-save keeps both documents. Only a
    // CREATE changes the tree.
    if (creating) { addTreeNode(name, kind); applyDnames(rnc); snapTree(); renderTree(); }
    patchLocal(name, kind, sent);
    // live-editor state ONLY if the editor still shows the saved document.
    // A New or open during the round-trip moved it; rewriting current, the
    // name field, dirty or the URL here would brand the new page as this save.
    const stillHere = current === name || (current === null && src.value === sent);
    if (stillHere) {
      current = name;
      tabFollow();           // a new page's tab is named now (21-tabs.js)
      curKind = kind;
      pname.readOnly = true;
      if (src.value === sent) dirty = false;
      if (vr && vr.rev) curRev = vr.rev;
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
  async function autosave() {
    // GRUB MODE IS EXPLICIT-SAVE ONLY. Autosaving a lattice page is fine. It is
    // your own note and the editor has always worked that way. Autosaving
    // another app's source is not. A half-typed edit to calendar.html would go
    // live 2s after you paused, and the 5-minute history window may not have
    // kept a revision fine-grained enough to step back to. Save/Cmd+S only.
    // The 2s debounce still fires. It just reports instead of writing, so the
    // moment you stop typing you can see the edit is not yet on the ship.
    if (grubPath) { if (dirty) st('unsaved — press Save or Cmd+S'); return; }
    if (!current || curFolder || !dirty || viewingRev !== null) return;
    // never overlap saves. The pier serializes, so a second in-flight save is
    // 3.7s of stale-body work queued behind the first, delaying every preview
    // behind it. Coalesce to one trailing save instead.
    //  never over an explicit save already waiting: that one names its kind
    if (saving) { if (!savePending) savePending = true; return; }
    saving = true;
    // the document this autosave owns. If the user navigates mid-flight,
    // `current` moves; everything below acts on `target`, not the new current.
    const target = current;
    const sent = src.value;
    const url = mode === 'know'
      ? api + '/know-save?key=' + encodeURIComponent(target)
      : api + '/page-save?name=' + encodeURIComponent(target) +
        '&type=' + (curKind || pkind.value);
    let w = { gone: true };
    try { w = await shipWrite(url, { method: 'POST', body: sent || '\n' }, { save: true }); }
    finally { saving = false; }
    const r = w.r;
    if (w.gone) {
      //  same rule on the autosave path: if it did not queue, it is not saved,
      //  so the editor stays dirty and keeps the text under the cursor
      if (mode === 'know') {
        if (!(await enqueueKnow(target, sent))) return;
        if (current === target && src.value === sent) dirty = false;
        flushPending();
        return;
      }
      if (!(await enqueueSave(target, curKind || pkind.value, sent))) return;
      if (current === target && src.value === sent) dirty = false;
      flushPending();
      return;
    }
    if (!r.ok) { st('autosave failed' + await errText(r), false); return; }
    let vr = null;
    if (mode !== 'know') { try { vr = await r.json(); } catch {} }
    //  patch the saved doc's local cache regardless of focus. No kind: an
    //  autosave writes the page's existing kind, it never sets one.
    if (mode !== 'know') patchLocal(target, null, sent);
    // live-editor state only if the editor is still on the doc we autosaved
    if (current === target) {
      if (src.value === sent) dirty = false;   // typed during the request? stay dirty
      if (mode !== 'know' && vr && vr.rev) curRev = vr.rev;
      // the conflict verdict must be the LAST word, not clobbered by the
      // ordinary confirmation a line later
      if (vr && vr.conflicted)
        st('autosaved — replaced an edit from elsewhere; it is kept at ' + vr.kept, false);
      else st('autosaved');
      if (mode !== 'know' && !CONTENT()) setTimeout(checkErrors, 800);
    }
    flushPending();
    if (offCount) replayQueue(true);     // this autosave proves the ship is back too
  }
