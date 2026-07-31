  // ── boot ─────────────────────────────────────────────────────────────────
  // paint from the last session's snapshot before the network answers: the
  // tree and (when it matches ?name) the page body + preview appear at 0ms,
  // then loadTree/refreshOpen reconcile in the background — local edits win,
  // same rules as any live refresh.
  function bootSnap() {
    let t = null, p = null;
    try {
      t = JSON.parse(localStorage.appTree || 'null');
      p = JSON.parse(localStorage.appPage || 'null');
    } catch {}
    if (!t || !t.length) return false;
    nodes = t;
    renderTree();
    const name = qs.get('name');
    if (name && p && p.name === name) applyPage(name, p);
    return true;
  }
  if (qs.get('grub')) {
    // arrived from the explorer's edit link: open that ball path directly. The
    // tree still lists lattice pages, so clicking one leaves grub mode.
    loadTree();
    openGrub(qs.get('grub'), qs.get('ship'));
  } else if (qs.get('view') === 'know') {
    setMode('know');
    legacyCheck();
  } else {
    const painted = bootSnap();
    loadTree().then(() => {
      const name = qs.get('name');
      const into = qs.get('into');
      if (name) {
        if (painted && current === name) refreshOpen();
        else openPage(name);
      }
      else if (into && nodes.some((n) => !n.page && n.path === into)) selectFolder(into);
      else if (into) newFile(into);
      else newFile('');
      legacyCheck();
    });
  }
