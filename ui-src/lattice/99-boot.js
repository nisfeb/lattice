  // ── boot ─────────────────────────────────────────────────────────────────
  // paint from the last session's snapshot before the network answers. The
  // tree and (when it matches ?name) the page body + preview appear at 0ms.
  // Then loadTree/refreshOpen reconcile in the background. Local edits win,
  // same rules as any live refresh.
  // The PAGE snapshot is small synchronous localStorage, and it is what
  // makes resume paint at literally 0ms. The TREE snapshot moved to IDB
  // (phase 3), whose read is async but single-digit ms, imperceptible next
  // to the ~0.5s network floor. It also frees the tree (which carries every
  // page body) from localStorage's ~5MB ceiling.
  // `name` is the page the front tab names, null for a new page. Only a
  // `fresh` tab list (nothing saved, so a first run or a corrupt one) may
  // resume the snapshot without a name: a restored new-page tab is a new page.
  function bootSnap(name, fresh) {
    let p = null;
    try { p = JSON.parse(localStorage.appPage || 'null'); } catch {}
    if (!p || !p.name) return false;
    // No name means a bare launch, above all the PWA, whose start_url can
    // never carry one. Resume the snapshot page instead of landing on an
    // empty editor. "opens where I left off" is what an installed app means.
    // A name that does not match the snapshot still defers to the network.
    if (name ? p.name !== name : !fresh) return false;
    applyPage(p.name, p);
    // openPage sets the upload-target folder. The snapshot path must too,
    // or uploads land at the root until the next explicit open
    setFolderCtx(p.name);
    return true;
  }
  async function bootTree() {
    let t = await kvGet('tree');
    if (!t || !t.length) {
      // one-time migration from the localStorage era, then free the quota
      try { t = JSON.parse(localStorage.appTree || 'null'); } catch {}
      if (t && t.length) kvPut('tree', t);
    }
    try { localStorage.removeItem('appTree'); } catch {}
    // if the network dump (or any local activity) beat us here, it is fresher
    // than the snapshot. Also deliberately NO treeGen bump. A snapshot must
    // never supersede an in-flight loadTree the way a real local patch does
    if (!t || !t.length || nodes.length) return;
    nodes = t;
    renderTree();
    markCurrent();
  }
  // the control-panel lists (sharing groups, shared-with-me) are never needed
  // to read or edit anything, so they load AFTER the editor is usable. Issued
  // at parse time they were two pier round-trips queued ahead of the tree, and
  // the pier serializes, pure delay on the only requests that matter.
  //  background lane: these also yield to any user activity (see bgFetch),
  //  so a click during boot is no longer queued behind panel lists
  const loadPanels = () => { loadPerms(true); loadShared(true); };
  // a queue left by a previous session syncs on open. With no Background
  // Sync (the SW must not intercept API calls), next-open IS the replay
  // moment, and the UI says so rather than implying closed-app sync exists
  // Adoption first, replay after. On the desktop the durable queue is the
  // ship-keyed one in Rust, so anything still sitting in this origin's
  // IndexedDB is a leftover from before that existed. Move it across BEFORE
  // the replay looks at the queue, or the first drain would not include it.
  adoptIdbQueue().then(() => {
    setTimeout(() => { if (offCount) replayQueue(); }, 4000);
  });
  // Well after boot has settled, never during it. Boot already spends five
  // serialised pier requests and takes most of ten seconds on a slow ship. A
  // count landing in the middle of that puts the user's first save behind it
  // and can push the save past the offline timeout, which is a real failure
  // traded for a badge nobody is waiting on.
  setTimeout(() => { refreshCommentBadge(); }, 20000);
  // The tabs come back first (21-tabs.js) and boot shows the front one. A
  // page has the snapshot-first path below; every other kind shows through
  // the tab model, with the tree and the panels loading beside it.
  const { tab: bootTab, fresh: bootFresh } = tabsBoot();
  if (bootTab.kind !== 'page') {
    loadTree().then(() => { legacyCheck(); loadPanels(); });
    tabShowBoot(bootTab);
  } else {
    // a folder in the address (?into=, a reload while one was selected)
    // outranks the tab's page, as it did before tabs
    const into = qs.get('into');
    const name = into && !qs.get('name') ? null : bootTab.key || null;
    const painted = bootSnap(name, bootFresh && !into);
    // bootSnap's applyPage jumped the mobile pane to 'code'. Put it back to
    // the pane the user last saw (bootMv, captured in 85-layout before this
    // ran), so resuming a snapshot page on reload does not force the editor
    // over the tree or preview they had open. Only on a real resume: a fresh
    // ?name open below legitimately lands in the editor.
    if (painted) setMv(bootMv);
    bootTree();
    // what the snapshot painted, if anything. The baseline for "did the USER
    // do something while the dump was in flight?"
    const bootCurrent = current;
    loadTree().then(() => {
      // The tree paints from localStorage at 0ms, so it is clickable long
      // before this resolves. Anything boot does by default would then land on
      // top of the user's own action, opening a page and having it close a
      // second later, which is exactly what the trailing newFile('') did.
      // Compare against bootCurrent, not against null. A snapshot-painted page
      // is not a user action and still wants its refreshOpen reconcile.
      // everTyped, not dirty. A keystroke followed by an autosave clears dirty
      // before a slow dump lands, and this branch then repainted the editor
      // from the dump's PRE-edit copy. Typing is a user action whether or not
      // it has since been saved. Going to another tab is a user action too.
      const touched = current !== bootCurrent || curFolder !== null || dirty || everTyped
        || activeTab !== bootTab;
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
      // bare launch, snapshot resumed a page above. Reconcile it, do not
      // clobber it with an empty new-file view
      else if (current) refreshOpen();
      else newFile('', false);
      legacyCheck();
      loadPanels();
    });
  }
