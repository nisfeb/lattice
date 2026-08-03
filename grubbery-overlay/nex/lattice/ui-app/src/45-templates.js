  $('save').onclick = () =>
    (grubPath ? saveGrub() : mode === 'know' ? saveKnow() : save());
  // ── new page-tree from a template ────────────────────────────────────────
  // Templates stamp out a whole tree (the `site` template is four pages), and
  // each page is its own writer round-trip, so this is deliberately slow and
  // says so. Instantiation rewrites the template's self-references to the name
  // you choose.
  async function newFromTemplate() {
    let names = [];
    try {
      const r = await fetch(api + '/template-list');
      if (r.ok) names = (await r.json()).templates || [];
    } catch {}
    if (!names.length) { st('no templates available', false); return; }
    const tmpl = await askChoice('start from which template?', names, 'next');
    if (!tmpl) return;
    const raw = await ask('name for the new ' + tmpl,
      folderCtx ? folderCtx + '/' + tmpl : tmpl, 'create');
    if (!raw) return;
    const name = raw.trim().replace(/^\/+|\/+$/g, '');
    if (!name) return;
    stWork('creating ' + name + ' from ' + tmpl + '\u2026 (one save per page)');
    let r = null;
    try {
      r = await mutate(api + '/template-new?template=' + encodeURIComponent(tmpl) +
        '&name=' + encodeURIComponent(name));
    } catch {}
    if (r && r.status === 409) { st('a page by that name exists', false); return; }
    if (!r || !r.ok) { st('template failed' + (r ? ' ' + r.status : ''), false); return; }
    await loadTree();
    // a multi-page template lands as a folder. Open its index if it made one,
    // else the page itself, else just select the new folder.
    const has = (p) => nodes.some((n) => n.page && n.path === p);
    if (has(name)) await openPage(name);
    else if (has(name + '/index')) await openPage(name + '/index');
    else if (nodes.some((n) => !n.page && n.path === name)) selectFolder(name);
    st('created ' + name + ' from ' + tmpl);
  }
  $('newtmpl').onclick = newFromTemplate;
  $('newfile').onclick = () => newFile('');
  $('newfolder').onclick = newFolder;
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      // grubPath first: it is the only mode with no `current`, and page save()
      // would write to the wrong place (or nowhere) while a grub is open.
      // Cmd+S matters more here than elsewhere, since grub mode has no autosave.
      if (grubPath) saveGrub();
      else if (mode === 'know') saveKnow();
      else save();
    }
  });
  src.addEventListener('keydown', (e) => {
    // autocomplete owns these keys while it is open
    if (ac.open) {
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); acAccept(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault(); ac.sel = (ac.sel + 1) % ac.items.length; acRender(); return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault(); ac.sel = (ac.sel - 1 + ac.items.length) % ac.items.length; acRender(); return;
      }
      if (e.key === 'Escape') { e.preventDefault(); acClose(); return; }
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (src.readOnly) return;   // readOnly blocks typing, not scripted edits
      const s = src.selectionStart;
      src.value = src.value.slice(0, s) + '  ' + src.value.slice(src.selectionEnd);
      src.selectionStart = src.selectionEnd = s + 2;
      edited();
    }
  });
