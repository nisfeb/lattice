  // ── open / new / save ────────────────────────────────────────────────────
  const setFolderCtx = (name) =>
    { folderCtx = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''; };

  // opening a page is ONE request: page-source?render=1 carries the rendered
  // preview for content kinds, so the separate page-preview POST is skipped.
  // History and backlinks load lazily on panel expand — they were 2 more ~2s
  // round-trips paid on every open whether or not anyone looked at them.
  async function openPage(name) {
    // leaving grub mode: clear the flag or the save button would keep writing
    // to the grub while the editor shows a page
    grubPath = null;
    src.readOnly = false;
    setFolderCtx(name);
    const r = await fetch(api + '/page-source?name=' + encodeURIComponent(name) + '&render=1');
    if (!r.ok) { st('open failed ' + r.status, false); return; }
    const d = await r.json();
    snapPage(name, d);
    applyPage(name, d);
  }
  function applyPage(name, d) {
    current = name;
    curFolder = null;
    setCtlLabels();
    pname.value = name;
    pname.readOnly = true;
    curKind = d.kind;
    if (LMAP[d.kind] || d.kind === 'text') pkind.value = d.kind === 'text' ? 'text' : d.kind;
    src.value = d.body;
    dirty = false;
    render(); sync();
    history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
    markCurrent();
    st(d.kind + ' · rev ' + d.rev);
    exitRev();
    resetPanels();
    showShare(d.share || 'private');
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
    if (typeof d.html === 'string') { prev.removeAttribute('src'); prev.srcdoc = d.html; }
    else refreshPreview();
    if (!CONTENT()) checkErrors();
    if (isMobile()) setMv('code');
  }

  function newFile(into) {
    folderCtx = into || '';
    current = null;
    curFolder = null;
    curKind = null;
    exitRev();
    $('histsec').hidden = true;
    $('linksec').hidden = true;
    setCtlLabels();
    pname.readOnly = false;
    pname.value = into ? into + '/' : '';
    src.value = '';
    dirty = false;
    render();
    history.replaceState(null, '', '/apps/lattice/app');
    renderTree();
    pname.focus();
    st('new page — name it, write, save');
    prevBlank();
    showShare('private');
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
  }

  async function newFolder() {
    const raw = await ask('folder name (e.g. notes or notes/sub)',
      folderCtx ? folderCtx + '/' : '', 'create');
    if (!raw) return;
    const name = raw.trim().replace(/^\/+|\/+$/g, '');
    if (!name) return;
    const r = await mutate(api + '/folder-new?name=' + encodeURIComponent(name));
    if (!r.ok) { st('folder failed ' + r.status, false); return; }
    st('folder created');
    addFolderNodes(name);
    snapTree();
    renderTree();
  }

  async function save(kindOverride) {
    if (curFolder) { st('folder selected — open a page to edit', false); return; }
    if (viewingRev !== null) { st('viewing rev ' + viewingRev + ' — use restore', false); return; }
    const name = pname.value.trim().replace(/^\/+|\/+$/g, '');
    if (!name) { st('name required', false); return; }
    const creating = current === null;
    if (saving) { savePending = true; return; }
    saving = true;
    st('saving…');
    // capture the exact body being sent: keystrokes landing during the round-trip
    // must NOT be marked clean, or the next refresh swaps the stale server copy
    // in and the typed text is lost (same guard autosave has always had).
    const sent = src.value;
    const kind = kindOverride || curKind || pkind.value;
    const url = api + '/page-save?name=' + encodeURIComponent(name) +
      '&type=' + kind + (creating ? '&new=1' : '');
    let r = null;
    try { r = await fetch(url, { method: 'POST', body: sent || '\n' }); }
    finally { saving = false; echoUntil = Date.now() + 4000; }
    if (r && r.status === 409) { st('that page already exists', false); return; }
    if (!r || !r.ok) { st('save failed' + (r ? ' ' + r.status : ''), false); return; }
    current = name;
    curKind = kind;
    pname.readOnly = true;
    if (src.value === sent) dirty = false;
    st(CONTENT() ? 'saved' : 'compiling\u2026');
    history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
    // only a CREATE changes the tree — refetching it after every save was a
    // 2.3s pier round-trip to learn nothing. Patch the local copy on create.
    if (creating) { addTreeNode(name, kind); snapTree(); renderTree(); }
    // the preview already shows this exact body (the input debounce rendered
    // it); re-POSTing it after the save was a duplicate 1.8s render.
    if (CONTENT()) { cerr.textContent = 'saved'; cerr.className = 'ok'; }
    else { setTimeout(checkErrors, 800); setTimeout(checkErrors, 2200); }
    if (savePending) { savePending = false; if (dirty) autosave(); }
  }

  let autoTimer = null;
  async function autosave() {
    // GRUB MODE IS EXPLICIT-SAVE ONLY. Autosaving a lattice page is fine — it is
    // your own note and the editor has always worked that way. Autosaving
    // another app's source is not: a half-typed edit to calendar.html would go
    // live 2s after you paused, and the 5-minute history window may not have
    // kept a revision fine-grained enough to step back to. Save/Cmd+S only.
    // The 2s debounce still fires — it just reports instead of writing, so the
    // moment you stop typing you can see the edit is not yet on the ship.
    if (grubPath) { if (dirty) st('unsaved — press Save or Cmd+S'); return; }
    if (!current || curFolder || !dirty || viewingRev !== null) return;
    // never overlap saves: the pier serializes, so a second in-flight save is
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
    try { r = await fetch(url, { method: 'POST', body: sent || '\n' }); } catch {}
    saving = false;
    echoUntil = Date.now() + 4000;
    if (!r || !r.ok) { st('autosave failed' + (r ? ' ' + r.status : ''), false); return; }
    if (src.value === sent) dirty = false;   // typed during the request? stay dirty
    st('autosaved');
    if (mode !== 'know' && !CONTENT()) setTimeout(checkErrors, 800);
    if (savePending) { savePending = false; if (dirty) autosave(); }
  }
