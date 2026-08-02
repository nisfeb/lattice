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
    // No ?name means a bare launch — above all the PWA, whose start_url can
    // never carry one. Resume the snapshot page instead of landing on an
    // empty editor: "opens where I left off" is what an installed app means.
    // A ?name that does not match the snapshot still defers to the network.
    if (p && p.name && (!name || p.name === name)) {
      applyPage(p.name, p);
      // openPage sets the upload-target folder; the snapshot path must too,
      // or uploads land at the root until the next explicit open
      setFolderCtx(p.name);
    }
    return true;
  }
  // the control-panel lists (sharing groups, shared-with-me) are never needed
  // to read or edit anything, so they load AFTER the editor is usable. Issued
  // at parse time they were two pier round-trips queued ahead of the tree, and
  // the pier serializes — pure delay on the only requests that matter.
  const loadPanels = () => { loadPerms(); loadShared(); };
  // a queue left by a previous session syncs on open — with no Background
  // Sync (the SW must not intercept API calls), next-open IS the replay
  // moment, and the UI says so rather than implying closed-app sync exists
  setTimeout(() => { if (offCount) replayQueue(); }, 4000);
  if (qs.get('grub')) {
    // arrived from the explorer's edit link: open that ball path directly. The
    // tree still lists lattice pages, so clicking one leaves grub mode.
    loadTree().then(loadPanels);
    openGrub(qs.get('grub'), qs.get('ship'));
  } else if (qs.get('view') === 'know') {
    setMode('know');
    legacyCheck();
    loadPanels();
  } else {
    const painted = bootSnap();
    // what the snapshot painted, if anything — the baseline for "did the USER
    // do something while the dump was in flight?"
    const bootCurrent = current;
    loadTree().then(() => {
      const name = qs.get('name');
      const into = qs.get('into');
      // The tree paints from localStorage at 0ms, so it is clickable long
      // before this resolves. Anything boot does by default would then land on
      // top of the user's own action — opening a page and having it close a
      // second later, which is exactly what the trailing newFile('') did.
      // Compare against bootCurrent, not against null: a snapshot-painted page
      // is not a user action and still wants its refreshOpen reconcile.
      const touched = current !== bootCurrent || curFolder !== null || dirty;
      if (touched) {
        legacyCheck();
        loadPanels();
        return;
      }
      if (name) {
        if (painted && current === name) refreshOpen();
        else openPage(name);
      }
      else if (into && nodes.some((n) => !n.page && n.path === into)) selectFolder(into);
      // no focus: boot did not ask for a new file, the user did not either
      else if (into) newFile(into, false);
      // bare launch, snapshot resumed a page above: reconcile it, do not
      // clobber it with an empty new-file view
      else if (current) refreshOpen();
      else newFile('', false);
      legacyCheck();
      loadPanels();
    });
  }
