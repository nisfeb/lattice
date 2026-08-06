  // ── move / rename ────────────────────────────────────────────────────────
  // page-move does the whole thing server-side (copy + share carry-over +
  // delete, wikilink self-references rewritten) in ONE request. The old
  // client choreography was 3 round-trips per page plus one per folder.
  // Memories use the know-move route (history preserved).
  async function movePage(oldName, newName) {
    const r = await mutate(api + '/page-move?from=' + encodeURIComponent(oldName) +
      '&to=' + encodeURIComponent(newName));
    if (!r.ok) { st('move failed ' + r.status, false); return false; }
    // the server moves the WHOLE subtree (a page can parent nested pages, and
    // move-pages rewrites every rel under it). Renaming only the exact node
    // left those children pointing at paths that no longer exist — ghosts in
    // the tree until the next full loadTree. Same suffix-preserving remap as
    // moveFolder, and as the offline queue's own move reconciliation.
    const mapped = (p) => newName + p.slice(oldName.length);
    for (const n of nodes)
      if (n.path === oldName || n.path.startsWith(oldName + '/')) n.path = mapped(n.path);
    if (newName.includes('/')) addFolderNodes(newName.slice(0, newName.lastIndexOf('/')));
    snapTree();
    renderTree();
    return true;
  }

  async function moveFolder(oldPath) {
    const to = await ask('move / rename folder ' + oldPath + ' to:', oldPath, 'move');
    if (!to || to === oldPath) return;
    const newPath = to.trim().replace(/^\/+|\/+$/g, '');
    if (!newPath) return;
    const mapped = (p) => newPath + p.slice(oldPath.length);
    st('moving ' + oldPath + ' \u2192 ' + newPath + '\u2026');
    const r = await mutate(api + '/page-move?from=' + encodeURIComponent(oldPath) +
      '&to=' + encodeURIComponent(newPath));
    if (!r.ok) { st('move failed ' + r.status, false); return; }
    let moved = 0;
    for (const n of nodes)
      if (n.path === oldPath || n.path.startsWith(oldPath + '/')) {
        if (n.page) moved++;
        n.path = mapped(n.path);
      }
    if (newPath.includes('/')) addFolderNodes(newPath.slice(0, newPath.lastIndexOf('/')));
    if (current && (current === oldPath || current.startsWith(oldPath + '/')))
      current = mapped(current);
    snapTree();
    renderTree();
    st('moved ' + oldPath + ' \u2192 ' + newPath + ' (' + moved + ' pages)');
    if (current) openPage(current);
    else if (curFolder === oldPath) selectFolder(newPath);
  }
