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
  // Naming the new page is the same dialog everywhere (newFile, 35-pages.js).
  //
  // The flag is set by the desktop build that HAS the menu (commands.rs, an
  // initialization_script), not inferred from __TAURI__. This UI ships from
  // the ship and the menu ships in the binary, so they update independently:
  // testing for the desktop alone would hide these on an older build with no
  // menubar behind them and make every one of these commands unreachable.
  //
  // (The window's light/dark, set_theme, is ui-app/theme.js's job: a theme
  // can force it, and the reader pages need it too.)
  if (window.__TAURI__ && window.__LATTICE_FILE_MENU__) {
    for (const id of ['newfile', 'newfolder', 'newtmpl', 'upfiles', 'updir', 'save']) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    // The create and upload group is now empty, and an empty flex row still
    // draws its gap: a blank band in the toolbar that reads as a rendering
    // fault. Hide a group only when everything in it went, so one that keeps
    // a button (a later one added to it) still shows.
    for (const row of document.querySelectorAll('#tree .newbtns')) {
      if ([...row.children].every((c) => c.hidden)) row.hidden = true;
    }
    // The palette indexes every action, so these stay listed, homed in the
    // File menu. A hidden button would drop them (palUsable), and running
    // one clicks it, which is exactly what the menu item does.
    for (const a of ACTIONS) {
      if (!['newfile', 'newfolder', 'newtmpl', 'upfiles', 'updir'].includes(a.id)) continue;
      a.home = 'File menu';
      a.when = () => true;
    }
  }
