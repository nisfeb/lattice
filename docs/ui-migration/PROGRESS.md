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
- [ ] M5 Mobile + toggles + beacon refresh
- [ ] M6 Parity audit + cord deletion + docs
- [ ] M7 /know in the app
