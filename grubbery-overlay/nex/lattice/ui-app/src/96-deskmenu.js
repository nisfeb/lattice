  // ── desktop: these commands live in the native File menu ─────────────────
  // The desktop window has a real menubar (desktop/src/main.rs). A "+ file"
  // button in the sidebar sitting next to a File > New page menu item is the
  // same command offered twice, in the one place a desktop user is least
  // likely to look for it.
  //
  // HIDDEN, never removed. The menu works by clicking these very elements, so
  // there is exactly one implementation of "new page" and no Rust counterpart
  // to drift out of step. Removing them would take their handlers with them.
  //
  // Web and mobile are untouched: without the desktop shell there is no
  // menubar to move anything into, and the buttons are the only affordance.
  //
  // The flag is set by the desktop build that HAS the menu (commands.rs, an
  // initialization_script), not inferred from __TAURI__. This UI ships from
  // the ship and the menu ships in the binary, so they update independently:
  // testing for the desktop alone would hide these on an older build with no
  // menubar behind them and make every one of these commands unreachable.
  if (window.__TAURI__ && window.__LATTICE_FILE_MENU__) {
    for (const id of ['newfile', 'newfolder', 'newtmpl', 'upfiles', 'updir', 'save']) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    // Both button rows are now empty, and an empty flex row still draws its
    // gap and margin — a blank band above the tree that reads as a rendering
    // fault. Hide a row only when everything in it went, so a row that keeps
    // a button (a later one added to it) still shows.
    for (const row of document.querySelectorAll('#tree .newbtns')) {
      if ([...row.children].every((c) => c.hidden)) row.hidden = true;
    }

    // ── the bar's name field becomes a label ────────────────────────────────
    // Typing a path into a text box is how you named a page when there was
    // nowhere else to do it. Creation lives in the File menu now, so the bar
    // can just say which page is open — centred, and not something you can
    // edit by accident mid-sentence.
    //
    // Both controls stay in the DOM and keep their values. Everything reads
    // pname.value and pkind.value — save, applyPage, the share flow, the
    // matrix — and rewriting all of that to read from somewhere else would be
    // a much larger change than this is worth.
    ws.classList.add('deskbar');
    const label = document.createElement('div');
    label.id = 'pathlabel';
    label.setAttribute('aria-live', 'polite');
    pname.after(label);
    const paint = () => {
      const v = (pname.value || '').trim();
      label.textContent = v || 'no page open';
      label.className = v ? '' : 'muted';
      label.title = v ? v + ' · ' + (pkind.value || '') : '';
    };
    paint();
    pname.addEventListener('input', paint);
    pname.addEventListener('change', paint);
    // pname is set from a dozen places (applyPage, newFile, rename, the
    // offline replay) and every one of them assigns the value PROPERTY. That
    // fires no event and leaves the value attribute alone, so a
    // MutationObserver cannot see it either. Until those writers go through
    // one setter, the poll is the mechanism here, not a safety net. The
    // mobile bar (97-mobar.js) polls its own label for the same reason.
    setInterval(paint, 500);
  }

  // ── naming a new page when the name field is not on screen ───────────────
  //  Wrap +newFile itself rather than any one button. Hooking the toolbar
  //  button covered File > New page and missed the green + on every tree
  //  folder, which calls newFile(path) straight — so it set a name into a
  //  hidden field, focused something display:none, and looked like a dead
  //  button. Everything user-initiated routes through here: the toolbar
  //  (newFile('')), the File menu (which clicks it), the tree, and the
  //  mobile bar's label.
  //
  //  The field is hidden in two independent states — the desktop shell
  //  (deskbar, set above) and phone width (the 820px CSS block) — and a
  //  resize crosses the second one live, so the decision is made per call,
  //  not at load.
  //
  //  Boot also calls newFile, with focusName false, to land on an empty
  //  page. That must not be interrupted by a dialog, and it is the one
  //  caller that says so.
  const nameFieldHidden = () =>
    ws.classList.contains('deskbar') || matchMedia('(max-width: 820px)').matches;
  const baseNewFile = newFile;
  newFile = function (into, focusName = true) {
    if (!focusName || !nameFieldHidden()) return baseNewFile(into, focusName);
    //  reset the editor first, without the focus that cannot land
    baseNewFile(into, false);
    (async () => {
      //  a folder's + pre-fills that folder; the toolbar keeps offering the
      //  open page's path, which is what it did before this existed
      const seed = into ? into.replace(/\/+$/, '') + '/' : (pname.value || '');
      //  the kind is picked IN the dialog. The bar carries that control and
      //  the desktop shell hides the bar, so this was the one place a desktop
      //  user could name a file and the one place they could not say what it
      //  was. Everything arrived as md.
      const picked = await askNameKind('page name (e.g. notes/todo)', seed,
        'create', pkind.value);
      if (!picked) return;
      let name = picked.name;
      let kind = picked.kind;
      //  a typed extension still wins, because typing notes/todo.md and being
      //  given a page called "todo.md" would be absurd. The table is EXT_KIND
      //  in 30-tree.js, the same one the uploader files by.
      const dot = name.lastIndexOf('.');
      const typed = dot > 0 ? extKind(name.slice(dot + 1)) : null;
      if (typed) { kind = typed; name = name.slice(0, dot); }
      pkind.value = kind;
      pname.value = name;
      //  both labels (desktop deskbar, mobile bar) repaint off this event
      pname.dispatchEvent(new Event('change'));
      //  Show it in the tree NOW, pulsing, before the ship has agreed. The
      //  write is a pier round trip and the tree sitting unchanged through it
      //  reads as nothing having happened, which is the report that started
      //  all of this. The pulse is the honest part: it says recorded, not yet
      //  confirmed. Cleared on success, and the row is dropped on failure so
      //  a page that does not exist is never left sitting there.
      const already = nodes.some((n) => n.page && n.path === name);
      if (!already) { addTreeNode(name, kind, true); snapTree(); renderTree(); }
      //  the button says create, so write the page here. Naming the buffer
      //  and leaving it unwritten read as a create that did nothing, and a
      //  page abandoned before its first keystroke left no trace at all.
      //  save() owns the whole create: 409, the offline queue, the tree
      //  patch and the url, so this must not reimplement any of it.
      await save();
      if (!already) {
        //  save() sets `current` on any outcome it considers a success,
        //  including a queued offline write, which IS a success here.
        if (current === name) setTreePending(name, false);
        else { dropTreeNodes(name); snapTree(); renderTree(); }
      }
      src.focus();
    })();
  };
