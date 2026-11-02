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
  //  The ship copies what it holds, so the text in the editor goes out
  //  first, and no autosave or parked save writes the old name while the
  //  move runs (`moving`, 35-pages.js). One landing in the folder being
  //  moved was deleted with it, or made the old folder again.
  const moveReq = async (from, to, rn) => {
    //  held first: the save the flush makes queues an autosave behind it,
    //  and that one would go out beside the move, under the old name
    moving++;
    try {
      await flushNoAsk();
      await waitSave();
      return await mutate(api + '/page-move?from=' + encodeURIComponent(from) +
        '&to=' + encodeURIComponent(to) + '&dname=' + encodeURIComponent((rn && rn.dname) || '') +
        (rn && rn.dnames ? '&dnames=' + encodeURIComponent(rn.dnames) : ''));
    } finally { moving--; }
  };
  // the server moves the WHOLE subtree (a page can parent nested pages, and
  // move-pages rewrites every rel under it). Renaming only the exact node
  // left those children pointing at paths that no longer exist, ghosts in
  // the tree until the next full loadTree. So the local tree gets the same
  // suffix-preserving remap, as does the offline queue's own move
  // reconciliation. Returns how many pages moved.
  const remapMoved = (from, to, rn) => {
    tabsRemap('page', from, to);       // and the tabs naming them (21-tabs.js)
    let moved = 0;
    for (const n of nodes)
      if (n.path === from || n.path.startsWith(from + '/')) {
        if (n.page) moved++;
        n.path = to + n.path.slice(from.length);
      }
    // and the editor, when it shows a page that moved: renamed in place,
    // so text typed during the move saves under the new name, never as
    // the old page made again
    if (mode !== 'know' && !grubPath && current &&
        (current === from || current.startsWith(from + '/'))) {
      const nn = to + current.slice(from.length);
      setOpen(nn, { readOnly: pname.readOnly, url: '/apps/lattice/app?name=' + encodeURIComponent(nn) });
    }
    if (to.includes('/')) addFolderNodes(to.slice(0, to.lastIndexOf('/')));
    applyDnames(rn || { name: to, dname: '', dnames: '' });
    return moved;
  };
  async function movePage(oldName, newName, rn) {
    const r = await moveReq(oldName, newName, rn);
    if (!r.ok) { st('move failed' + await errText(r), false); return false; }
    remapMoved(oldName, newName, rn);
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
      st('moving ' + oldPath + ' \u2192 ' + newPath + '\u2026');
      const r = await moveReq(oldPath, newPath, rn);
      if (!(r.ok || r.offline)) {
        // the server refused this name \u2014 loop back into askName seeded with
        // it, so the retry is an edit, not a full retype
        st('move failed' + await errText(r), false);
        seed = typed;
        continue;
      }
      const moved = remapMoved(oldPath, newPath, rn);
      if (current && (current === oldPath || current.startsWith(oldPath + '/')))
        current = newPath + current.slice(oldPath.length);
      snapTree();
      renderTree();
      st('moved ' + oldPath + ' \u2192 ' + newPath +
        (r.offline ? ' offline' : '') + ' (' + moved + ' pages)');
      if (current) openPage(current);
      else if (curFolder === oldPath) selectFolder(newPath);
      return;
    }
  }
