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
    let seed = folderCtx ? folderCtx + '/' + tmpl : tmpl;
    for (;;) {
      const name = await askName('name for the new ' + tmpl, seed, 'create');
      if (!name) return;
      stWork('creating ' + name + ' from ' + tmpl + '\u2026 (one save per page)');
      let r = null;
      try {
        r = await mutate(api + '/template-new?template=' + encodeURIComponent(tmpl) +
          '&name=' + encodeURIComponent(name));
      } catch {}
      if (r && (r.ok || r.offline)) {
        await loadTree();
        // a multi-page template lands as a folder. Open its index if it made
        // one, else the page itself, else just select the new folder.
        const has = (p) => nodes.some((n) => n.page && n.path === p);
        if (has(name)) await openPage(name);
        else if (has(name + '/index')) await openPage(name + '/index');
        else if (nodes.some((n) => !n.page && n.path === name)) selectFolder(name);
        st('created ' + name + ' from ' + tmpl);
        return;
      }
      // the server refused this name \u2014 loop back into askName seeded with
      // it (keeping the template pick), so the retry is an edit not a redo
      if (r && r.status === 409) st('a page by that name exists', false);
      else st('template failed' + await errText(r), false);
      seed = name;
    }
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
  // prose kinds get list behaviour; anything else is code, where "- " and
  // "1." are just characters. know memories are prose, so markdown rules.
  const proseFlavor = () => {
    if (mode === 'know') return 'md';
    return ['md', 'text', 'gmi'].includes(pkind.value) ? pkind.value : null;
  };
  // Apply a {from, to, text, caret} edit from the pure list functions.
  // execCommand keeps the textarea's OWN undo stack, so Ctrl+Z steps back
  // through these edits like any typing. Assigning src.value wipes that
  // stack outright (the old Tab handler's sin). Deprecated, not gone, and
  // there is no replacement that preserves undo; setRangeText is the
  // fallback when an engine refuses.
  const applyEdit = (r) => {
    src.setSelectionRange(r.from, r.to);
    let ok = false;
    try { ok = document.execCommand('insertText', false, r.text); } catch {}
    if (!ok) src.setRangeText(r.text, r.from, r.to, 'end');
    src.setSelectionRange(r.caret, r.caretEnd == null ? r.caret : r.caretEnd);
    edited();
  };
  const continueList = () => {
    if (src.readOnly) return false;
    const flavor = proseFlavor();
    if (!flavor) return false;
    const r = listEnter(src.value, src.selectionStart, src.selectionEnd, flavor);
    if (!r) return false;
    applyEdit(r);
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
      // On a list line, Tab is structure, not whitespace: indent the item a
      // level, Shift-Tab brings it back out. A multi-line selection moves
      // every list line in it together.
      const flavor = proseFlavor();
      if (flavor) {
        const r = listTab(src.value, src.selectionStart, src.selectionEnd,
          flavor, e.shiftKey ? -1 : 1);
        if (r) { applyEdit(r); return; }
      }
      // Shift-Tab outside a list has nothing to take back
      if (e.shiftKey) return;
      applyEdit({ from: src.selectionStart, to: src.selectionEnd,
        text: '  ', caret: src.selectionStart + 2 });
    }
  });

  // ── the same two moves, reachable by thumb ────────────────────────────────
  // A soft keyboard has no Tab key at all — the keydown branch above simply
  // never fires on a phone, the same hole Enter had before beforeinput. There
  // is no beforeinput for Tab, so mobile gets buttons: a small fixed pair
  // (like #fullt) that exists only while the caret sits somewhere listTab
  // would actually act. The predicate IS listTab: the cluster shows exactly
  // when a tap would do something, fences and gemtext included, because it
  // asks the same function the tap will call.
  const ltab = (dir) => {
    if (src.readOnly) return;
    const flavor = proseFlavor();
    if (!flavor) return;
    const r = listTab(src.value, src.selectionStart, src.selectionEnd, flavor, dir);
    if (r) applyEdit(r);
  };
  const lbtns = document.createElement('div');
  lbtns.id = 'lbtns';
  for (const [id, glyph, title, dir] of [
    ['loutd', '\u21e4', 'list item out a level', -1],
    ['lind', '\u21e5', 'list item in a level', 1],
  ]) {
    const b = document.createElement('button');
    b.id = id; b.type = 'button'; b.textContent = glyph;
    b.title = title; b.setAttribute('aria-label', title);
    // pointerdown + preventDefault: the tap must NOT move focus off the
    // textarea, or the keyboard drops and the caret (the thing the edit is
    // FOR) is gone before the handler runs.
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); ltab(dir); });
    lbtns.appendChild(b);
  }
  // inside .ws, not body: the show rule is scoped by the workspace's
  // data-mv, and a descendant selector needs the descendant part. By id,
  // not the `ws` binding — that const lives in 85-layout.js, which
  // evaluates AFTER this file (TDZ: reaching it here killed the bundle).
  $('ws').appendChild(lbtns);
  // shown while either direction would act. selectionchange covers taps and
  // caret movement; input covers typing a marker into existence. Debounced:
  // listTab scans fences over the whole document, which is nothing for the
  // documents phones edit but not worth running per keystroke.
  let lbTimer = null;
  const lbPaint = () => {
    clearTimeout(lbTimer);
    lbTimer = setTimeout(() => {
      const flavor = document.activeElement === src && !src.readOnly && proseFlavor();
      const on = !!flavor && !!(
        listTab(src.value, src.selectionStart, src.selectionEnd, flavor, 1) ||
        listTab(src.value, src.selectionStart, src.selectionEnd, flavor, -1));
      lbtns.classList.toggle('on', on);
    }, 120);
  };
  document.addEventListener('selectionchange', lbPaint);
  src.addEventListener('input', lbPaint);
  src.addEventListener('blur', lbPaint);
