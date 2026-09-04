  // ── move / rename ────────────────────────────────────────────────────────
  // page-move does the whole thing server-side (copy + share carry-over +
  // delete, wikilink self-references rewritten) in ONE request. The old
  // client choreography was 3 round-trips per page plus one per folder.
  // Memories use the know-move route, which culls the source key outright.
  // Only the current body carries over, not the history: the new key's own
  // history starts fresh at rev 1.
  // rn: the realName() split of the new name. Its dname is ALWAYS sent: ''
  // (the typed name was a valid path) clears the one the move would
  // otherwise carry over; dnames names the folders the move creates.
  async function movePage(oldName, newName, rn) {
    const r = await mutate(api + '/page-move?from=' + encodeURIComponent(oldName) +
      '&to=' + encodeURIComponent(newName) + '&dname=' + encodeURIComponent((rn && rn.dname) || '') +
      (rn && rn.dnames ? '&dnames=' + encodeURIComponent(rn.dnames) : ''));
    if (!r.ok) { st('move failed' + await errText(r), false); return false; }
    // the server moves the WHOLE subtree (a page can parent nested pages, and
    // move-pages rewrites every rel under it). Renaming only the exact node
    // left those children pointing at paths that no longer exist — ghosts in
    // the tree until the next full loadTree. Same suffix-preserving remap as
    // moveFolder, and as the offline queue's own move reconciliation.
    const mapped = (p) => newName + p.slice(oldName.length);
    for (const n of nodes)
      if (n.path === oldName || n.path.startsWith(oldName + '/')) n.path = mapped(n.path);
    if (newName.includes('/')) addFolderNodes(newName.slice(0, newName.lastIndexOf('/')));
    applyDnames(rn || { name: newName, dname: '', dnames: '' });
    snapTree();
    renderTree();
    //  the response, not a bare true: the caller's message must say when the
    //  move was queued offline, and only the response knows.
    return r;
  }

  async function moveFolder(oldPath) {
    let seed = oldPath;
    for (;;) {
      const typed = await askName('move / rename folder ' + oldPath + ' to:', seed, 'move');
      if (!typed) return;
      const rn = realName(typed);
      const newPath = rn.name;
      if (newPath === oldPath && !rn.dname) return;
      const mapped = (p) => newPath + p.slice(oldPath.length);
      st('moving ' + oldPath + ' \u2192 ' + newPath + '\u2026');
      const r = await mutate(api + '/page-move?from=' + encodeURIComponent(oldPath) +
        '&to=' + encodeURIComponent(newPath) + '&dname=' + encodeURIComponent(rn.dname) +
        (rn.dnames ? '&dnames=' + encodeURIComponent(rn.dnames) : ''));
      if (!(r.ok || r.offline)) {
        // the server refused this name \u2014 loop back into askName seeded with
        // it, so the retry is an edit, not a full retype
        st('move failed' + await errText(r), false);
        seed = typed;
        continue;
      }
      let moved = 0;
      for (const n of nodes)
        if (n.path === oldPath || n.path.startsWith(oldPath + '/')) {
          if (n.page) moved++;
          n.path = mapped(n.path);
        }
      if (newPath.includes('/')) addFolderNodes(newPath.slice(0, newPath.lastIndexOf('/')));
      applyDnames(rn);
      if (current && (current === oldPath || current.startsWith(oldPath + '/')))
        current = mapped(current);
      snapTree();
      renderTree();
      st('moved ' + oldPath + ' \u2192 ' + newPath +
        (r.offline ? ' offline' : '') + ' (' + moved + ' pages)');
      if (current) openPage(current);
      else if (curFolder === oldPath) selectFolder(newPath);
      return;
    }
  }
