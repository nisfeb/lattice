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
  let openSeq = 0;
  async function openPage(name) {
    // guardDirty covers a dirty grub, page, or memory in one place (see
    // 20-state.js): it flushes what it can and only asks when the flush
    // still leaves something unsaved.
    if (!(await guardDirty())) return;
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
      return;
    }
    const hit = pageCache.get(name);
    if (hit) { applyPage(name, hit); snapPage(name, hit); return; }
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
    if (!painted) stWork('opening ' + name + '\u2026');
    const shown = src.value;
    let d = null;
    try {
      const r = await fetch(api + '/page-source?name=' + encodeURIComponent(name) + '&render=1');
      if (!r.ok) { if (!painted) st('open failed' + await errText(r), false); return; }
      d = await r.json();
    } catch { if (!painted) st('open failed', false); return; }
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
    if (painted && src.value !== shown) return;
    // Cache and snapshot BELOW the guards, not above. A stale or superseded
    // response that reached the cache here poisoned it with the pre-edit body:
    // the guard protected the editor but not the cache, so switching away and
    // back repainted the old text — the same data loss through a different
    // door. Only a response that is actually applied may be remembered.
    pageCache.set(name, d);
    snapPage(name, d);
    applyPage(name, d);
  }
  function applyPage(name, d, quiet) {
    current = name;
    curFolder = null;
    setCtlLabels();
    pname.value = name;
    pname.readOnly = true;
    curKind = d.kind;
    curRev = d.rev || 0;
    if ([...pkind.options].some((o) => o.value === d.kind)) pkind.value = d.kind;
    if (typeof refreshTexButton === 'function') refreshTexButton();
    src.value = d.body;
    dirty = false;
    // A fresh editor state begins here. everTyped answers "did the user type
    // since this view was established?" for boot's reconcile guard; carrying
    // it across a navigation would mark every later untouched page as touched.
    everTyped = false;
    render(); sync();
    history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
    markCurrent();
    st(d.kind + ' · rev ' + d.rev);
    exitRev();
    resetPanels();
    showShare(d.share || 'private');
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
    //  a tex page's server render is its SOURCE as escaped text, because the
    //  ship has no LaTeX and is not getting one. The local conversion is the
    //  only true render, and it arrives first, so letting the ship's answer
    //  land here would overwrite a rendered document with its own source.
    if (typeof d.html === 'string' && d.kind !== 'tex') {
      prev.removeAttribute('src'); prev.srcdoc = d.html;
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

  // focusName: only when the USER asked for a new file. Boot calls this to
  // land on an empty page, and focusing the name field there summons the
  // phone keyboard before you have done anything. You arrive at the app
  // already typing a filename you did not ask to type.
  function newFile(into, focusName = true) {
    folderCtx = into || '';
    current = null;
    curFolder = null;
    curKind = null;
    if (typeof refreshTexButton === 'function') refreshTexButton();
    exitGrub();
    exitRev();
    $('histsec').hidden = true;
    $('linksec').hidden = true;
    setCtlLabels();
    pname.readOnly = false;
    pname.value = into ? into + '/' : '';
    src.value = '';
    dirty = false;
    everTyped = false;   // a new file is a fresh editor state, like applyPage
    render();
    history.replaceState(null, '', '/apps/lattice/app');
    renderTree();
    if (focusName) pname.focus();
    st('new page — name it, write, save');
    prevBlank();
    showShare('private');
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
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
      const r = await mutate(api + '/folder-new?name=' + encodeURIComponent(name) + dnameQ(rn.dname));
      if (r.ok || r.offline) {
        st(r.offline ? 'folder created offline' : 'folder created');
        addFolderNodes(name);
        setNodeDname(name, rn.dname);
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

  //  a save arriving mid-flight only set savePending, which now carries the
  //  kindOverride that call wanted (or bare `true` for a plain save with
  //  none). A re-run that forgot it and fell back to autosave's own
  //  curKind/pkind guess is how a restore's revision kind used to vanish.
  //  Take the trailing save now, honoring that kind, and only if the text
  //  really is still unsaved.
  const flushPending = () => {
    if (!savePending) return;
    const pending = savePending;
    savePending = false;
    if (!dirty) return;
    if (pending === true) autosave(); else save(pending);
  };
  //  the echo window covers OUR OWN beacon bump. A fixed 4s assumed the bump
  //  lands promptly; on a queued pier it arrives after the save's own round
  //  trip again, so scale the window to what the pier just showed us. Too
  //  short meant refetching the page we just wrote — two more pier requests
  //  to learn nothing.
  const noteRtt = (sentAt) => {
    echoUntil = Date.now() + Math.max(4000, 2 * (Date.now() - sentAt));
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
  window.addEventListener('beforeunload', (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // the display name the desktop create dialog split off the typed name
  // before seeding #pname with the real path; save() consumes it on create
  let newDname = '';
  async function save(kindOverride) {
    if (curFolder) { st('folder selected — open a page to edit', false); return; }
    if (viewingRev !== null) { st('viewing rev ' + viewingRev + ' — use restore', false); return; }
    let name = pname.value.trim().replace(/^\/+|\/+$/g, '');
    if (!name) { st('name required', false); return; }
    const creating = current === null;
    // carry kindOverride into the re-arm: a bare `true` here forgot which
    // kind THIS call wanted, and the trailing run picked whatever the
    // picker happened to show by the time it fired
    if (saving) { savePending = kindOverride || true; return; }
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
    // the typed leaf as the display name (the tree shows that, the name
    // field shows the real path). newDname is the desktop dialog's copy of
    // the same split, made before it seeded the field with the slug.
    const dname = creating ? (rn.dname || newDname) : '';
    newDname = '';
    if (rn.name !== name) { name = rn.name; pname.value = name; }
    const url = api + '/page-save?name=' + encodeURIComponent(name) +
      '&type=' + kind + (creating ? '&new=1' : '') + dnameQ(dname);
    let r = null;
    //  a save is user activity even when it arrives by hotkey or autosave,
    //  so the background lane (bgFetch) holds its traffic out of its way
    lastAction = Date.now();
    const sentAt = Date.now();
    try { r = await tfetch(url, { method: 'POST', body: sent || '\n' }); }
    catch {}
    finally {
      saving = false;
      noteRtt(sentAt);
    }
    if (shipGone(r)) {
      // the ship is unreachable. Queue the edit and complete the save's
      // LOCAL bookkeeping exactly as a successful save would, so the editor
      // does not care which kind it got
      // A failed queue write means this edit exists ONLY in the textarea.
      // Clearing dirty there would tell the editor the work is safe and let
      // the next navigation drop it, so the bookkeeping stays untouched and
      // the page keeps behaving as unsaved. enqueueSave has already said so.
      if (!(await enqueueSave(name, kind, sent, creating, dname))) {
        cerr.textContent = 'NOT saved'; cerr.className = 'err';
        return;
      }
      current = name;
      curKind = kind;
      pname.readOnly = true;
      if (src.value === sent) dirty = false;
      history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
      if (creating) { addTreeNode(name, kind); setNodeDname(name, dname); snapTree(); renderTree(); }
      cerr.textContent = 'saved offline'; cerr.className = 'ok';
      flushPending();
      return;
    }
    if (r && r.status === 409) { st('that page already exists', false); return; }
    if (!r || !r.ok) { st('save failed' + await errText(r), false); return; }
    pendingEchoes++;                  // this save's own beacon bump
    bustPages(name);
    current = name;
    curKind = kind;
    pname.readOnly = true;
    if (src.value === sent) dirty = false;
    // the response carries the new revision (no re-read needed) and whether
    // this save landed on top of a revision made elsewhere
    let vr = null;
    try { vr = await r.json(); } catch {}
    if (vr && vr.rev) curRev = vr.rev;
    if (vr && vr.conflicted) {
      st('saved — replaced an edit from elsewhere; it is kept at ' + vr.kept, false);
    } else if (dname) st('saved as ' + name + ' (shown as ' + dname + ')');
    else st(CONTENT() ? 'saved' : 'compiling\u2026');
    history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
    // only a CREATE changes the tree. Refetching it after every save was a
    // 2.3s pier round-trip to learn nothing. Patch the local copy on create.
    if (creating) { addTreeNode(name, kind); setNodeDname(name, dname); snapTree(); renderTree(); }
    patchLocal(name, kind, sent);
    // the preview already shows this exact body (the input debounce rendered
    // it). Re-POSTing it after the save was a duplicate 1.8s render.
    if (CONTENT()) { cerr.textContent = 'saved'; cerr.className = 'ok'; }
    else { setTimeout(checkErrors, 800); setTimeout(checkErrors, 2200); }
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
    if (saving) { savePending = true; return; }
    saving = true;
    const sent = src.value;
    const url = mode === 'know'
      ? api + '/know-save?key=' + encodeURIComponent(current)
      : api + '/page-save?name=' + encodeURIComponent(current) +
        '&type=' + (curKind || pkind.value);
    let r = null;
    lastAction = Date.now();       // saves are user activity (see above)
    const sentAt = Date.now();
    try { r = await tfetch(url, { method: 'POST', body: sent || '\n' }); } catch {}
    saving = false;
    noteRtt(sentAt);
    if (r && r.ok) {
      pendingEchoes++;                // this save's own beacon bump
      bustPages(current);
    }
    if (shipGone(r)) {
      //  same rule on the autosave path: if it did not queue, it is not saved,
      //  so the editor stays dirty and keeps the text under the cursor
      if (mode === 'know') {
        if (!(await enqueueKnow(current, sent))) return;
        if (src.value === sent) dirty = false;
        flushPending();
        return;
      }
      if (!(await enqueueSave(current, curKind || pkind.value, sent))) return;
      if (src.value === sent) dirty = false;
      flushPending();
      return;
    }
    if (!r || !r.ok) { st('autosave failed' + await errText(r), false); return; }
    if (src.value === sent) dirty = false;   // typed during the request? stay dirty
    let vr = null;
    if (mode !== 'know') {
      try { vr = await r.json(); } catch {}
      if (vr && vr.rev) curRev = vr.rev;
    }
    //  no kind: an autosave writes the page's existing kind, it never sets one
    if (mode !== 'know') patchLocal(current, null, sent);
    // the conflict verdict must be the LAST word, not clobbered by the
    // ordinary confirmation a line later
    if (vr && vr.conflicted)
      st('autosaved — replaced an edit from elsewhere; it is kept at ' + vr.kept, false);
    else st('autosaved');
    if (mode !== 'know' && !CONTENT()) setTimeout(checkErrors, 800);
    flushPending();
    if (offCount) replayQueue(true);     // this autosave proves the ship is back too
  }
