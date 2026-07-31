  // ── open / new / save ────────────────────────────────────────────────────
  const setFolderCtx = (name) =>
    { folderCtx = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''; };

  // Opening a page should cost nothing. Three tiers, cheapest first:
  //   1. seen this session -> pageCache has the rendered answer: 0 requests.
  //   2. body came with the tree dump -> paint the editor NOW, then fetch
  //      render=1 only to fill in `share` and the preview.
  //   3. no body (oversized page, or a tree we never loaded) -> as before.
  // History and backlinks stay lazy on panel expand — they were 2 more ~2s
  // round-trips paid on every open whether or not anyone looked at them.
  // Which open is current. Opening a page is an explicit user act, so the ONLY
  // reason to discard a landed response is that the user opened something else
  // while it was in flight — not that the editor was dirty, and not that
  // `current` had not been set yet. Guarding on those meant an explicit open
  // was silently dropped: after an unsaved edit, clicking another file did
  // nothing, and a page absent from the local tree never applied at all.
  let openSeq = 0;
  async function openPage(name) {
    const my = ++openSeq;
    // leaving grub mode: clear the flag or the save button would keep writing
    // to the grub while the editor shows a page
    grubPath = null;
    src.readOnly = false;
    setFolderCtx(name);
    const hit = pageCache.get(name);
    if (hit) { applyPage(name, hit); snapPage(name, hit); return; }
    const node = nodes.find((n) => n.page && n.path === name);
    const painted = !!node && typeof node.body === 'string';
    // `quiet`: the render=1 request below carries the preview and the error
    // report, so painting must not also fire refreshPreview/checkErrors.
    if (painted) applyPage(name, node, true);
    let d = null;
    try {
      const r = await fetch(api + '/page-source?name=' + encodeURIComponent(name) + '&render=1');
      if (!r.ok) { if (!painted) st('open failed ' + r.status, false); return; }
      d = await r.json();
    } catch { if (!painted) st('open failed', false); return; }
    pageCache.set(name, d);
    snapPage(name, d);
    // a later openPage supersedes this one; anything else still applies
    if (my !== openSeq) return;
    applyPage(name, d);
  }
  function applyPage(name, d, quiet) {
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
    else if (!quiet) refreshPreview();
    if (!CONTENT() && !quiet) checkErrors();
    if (isMobile()) setMv('code');
  }

  // focusName: only when the USER asked for a new file. Boot calls this to
  // land on an empty page, and focusing the name field there summons the
  // phone keyboard before you have done anything — you arrive at the app
  // already typing a filename you did not ask to type.
  function newFile(into, focusName = true) {
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
    if (focusName) pname.focus();
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
    // we know exactly what we just wrote: patch the local copies so reopening
    // this page paints the saved text, not the dump's pre-save body. The
    // cached render is stale by definition — drop it and let it re-render.
    pageCache.delete(name);
    const nd = nodes.find((n) => n.page && n.path === name);
    if (nd) { nd.body = sent; nd.kind = kind; persistTree(); }
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
    if (mode !== 'know') {
      pageCache.delete(current);
      const nd = nodes.find((n) => n.page && n.path === current);
      if (nd) { nd.body = sent; persistTree(); }
    }
    st('autosaved');
    if (mode !== 'know' && !CONTENT()) setTimeout(checkErrors, 800);
    if (savePending) { savePending = false; if (dirty) autosave(); }
  }
