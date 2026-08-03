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
  // Applies the list-continuation edit if the caret is in a list. Shared by
  // the keydown path and the beforeinput path below, which is the ONLY one a
  // phone reliably takes.
  const continueList = () => {
    if (src.readOnly) return false;
    if (!(mode === 'know' || ['md', 'text', 'gmi'].includes(pkind.value))) return false;
    // know memories are prose, so they follow the markdown rules
    const flavor = mode === 'know' ? 'md' : pkind.value;
    const r = listEnter(src.value, src.selectionStart, src.selectionEnd, flavor);
    if (!r) return false;
    src.setSelectionRange(r.from, r.to);
    // execCommand keeps the textarea's OWN undo stack, so Ctrl+Z steps back
    // through these edits like any typing. Assigning src.value wipes that
    // stack outright, which is why the Tab handler below loses undo.
    // Deprecated, not gone, and there is no replacement that preserves
    // undo; setRangeText is the fallback when an engine refuses.
    let ok = false;
    try { ok = document.execCommand('insertText', false, r.text); } catch {}
    if (!ok) src.setRangeText(r.text, r.from, r.to, 'end');
    src.setSelectionRange(r.caret, r.caret);
    edited();
    return true;
  };
  let plainBreak = false;
  // A soft keyboard usually does NOT report Enter as a keydown. Android and
  // GBoard send keyCode 229 (or key "Unidentified") because the IME owns the
  // composition, so the keydown branch below never matched and lists simply
  // did not continue on a phone. beforeinput carries insertLineBreak on every
  // engine that matters, which is why the real handler hangs off it too.
  //
  // On a desktop press keydown gets there first and calls preventDefault,
  // which cancels beforeinput, so exactly one of these two ever fires.
  src.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;
    // the autocomplete owns Enter while it is open, as on the keydown path
    if (ac.open) return;
    if (plainBreak) { plainBreak = false; return; }
    if (continueList()) e.preventDefault();
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
    // Smart list continuation. Prose kinds only: a "- " in a hoon or js file is
    // not a list item. Shift+Enter is the deliberate escape hatch, and it is
    // also what the browser gives a user who wants a plain newline.
    //
    // A modifier here means "just break the line", and the beforeinput handler
    // below has no modifier state of its own, so record the decision for it.
    if (e.key === 'Enter') plainBreak = e.shiftKey || e.metaKey || e.ctrlKey || e.altKey;
    if (e.key === 'Enter' && !plainBreak && continueList()) {
      e.preventDefault();
      return;
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
