# UI migration progress

- [x] M1 Scaffold — ui-app/ files, on-load rows, /apps/lattice/app serves;
      hello-world fetches page-tree and renders the tree count + list.
- [x] M2 Editor core — tree pane (collapse in localStorage, per-folder + buttons,
      into-context), Prism-overlaid editor, open via page-source, save with kind
      (create &new=1 / overwrite), Cmd+S, Tab-insert, URL state (?name / ?into).
- [x] M3 Preview / errors / command / share / delete — content kinds via
      page-preview srcdoc (debounced), computed kinds via live /f/<name> iframe;
      page-errors polling after hoon saves; page-cmd box; share buttons with
      clearweb URL (page-source now returns share mode); confirmed delete.
- [x] M4 Upload — files/dir pickers + window-wide drag-and-drop with directory
      entry walking, kind-mapped + name-sanitized, folders pre-created, progress
      panel (fill bar, per-file, error list survives failures), lands in the
      current folder context.
- [x] M5 Mobile + toggles + beacon refresh — pane tabs under 820px (tree/code/
      preview/controls), wrap + tree + controls toggles persisted in
      localStorage, and EventSource on the /beacon/rev keep refreshing the tree
      (debounced) on every writer mutation.
- [x] M6 Parity audit + cord deletion — every old-editor capability confirmed
      in the app (tree/collapse/into/newfolder, save+409, Cmd+S, Tab, Prism,
      preview, errors, cmd, share incl. mode read, delete, upload+drag-drop,
      mobile tabs, wrap/tree/ctl toggles). Intentional differences: computed-
      page preview shows live /f data (not the /x-embedded view); new pages
      start empty (no hoon starter templates). DELETED: edit-css,
      edit-template, md-template, starter-for, share-btn, edit-html, edit-js
      (210 lines of cords); /apps/lattice/edit now redirects to the app
      preserving ?name/?into; home + browser edit links point at the app.
- [ ] M7 /know in the app
