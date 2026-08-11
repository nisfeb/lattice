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
    // pname is set from a dozen places (applyPage, newFile, rename, the
    // offline replay). Rather than find them all, watch the field itself.
    new MutationObserver(paint).observe(pname, { attributes: true, attributeFilter: ['value'] });
    pname.addEventListener('input', paint);
    pname.addEventListener('change', paint);
    setInterval(paint, 500);

    // ── naming a new page ───────────────────────────────────────────────────
    // With the field read-only, File > New page had nowhere to put a name:
    // newFile focuses pname and waits for typing, which now cannot happen.
    // Ask for it up front instead. The kind comes from the extension, since
    // the kind dropdown is gone too — "notes/todo.md" is a more natural thing
    // to type than a name plus a separate menu.
    const KINDS = ['md', 'gmi', 'html', 'text', 'txt', 'js', 'css', 'hoon'];
    //  Wrap +newFile itself rather than the toolbar button. Hooking the
    //  button covered File > New page and missed the green + on every tree
    //  folder, which calls newFile(path) straight — so it set a name into a
    //  hidden field, focused something display:none, and looked like a dead
    //  button. Everything user-initiated routes through here: the toolbar
    //  (newFile('')), the File menu (which clicks it), and the tree.
    //
    //  Boot also calls newFile, with focusName false, to land on an empty
    //  page. That must not be interrupted by a dialog, and it is the one
    //  caller that says so.
    const baseNewFile = newFile;
    newFile = function (into, focusName = true) {
      if (!focusName) return baseNewFile(into, false);
      //  reset the editor first, without the focus that cannot land
      baseNewFile(into, false);
      (async () => {
        //  a folder's + pre-fills that folder; the toolbar keeps offering the
        //  open page's path, which is what it did before this existed
        const seed = into ? into.replace(/\/+$/, '') + '/' : (pname.value || '');
        const raw = await ask('page name (e.g. notes/todo.md)', seed, 'create');
        if (!raw) return;
        let name = raw.trim().replace(/^\/+/, '');
        if (!name) return;
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
        if (KINDS.includes(ext)) {
          pkind.value = ext === 'txt' ? 'text' : ext;
          name = name.slice(0, dot);
        }
        pname.value = name;
        paint();
        src.focus();
      })();
    };
  }
