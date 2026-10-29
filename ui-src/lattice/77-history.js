  // ── history + backlinks panels: <lat-history>, <lat-links> ───────────────
  // Defined here (before this file's own $-lookups). They upgrade inside
  // their right pane tabs (13-frame.js), which load them when shown and
  // when the document changes under them (76-outline.js, rpPaint).
  customElements.define('lat-history', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="histsec" hidden>
  <h3 id="histh">history</h3>
  <div id="histview" class="row" hidden>
    <button id="hrestore">restore</button>
    <button id="hback">back to latest</button>
  </div>
  <div id="histlist" class="chips"></div>
</div>`;
    }
  });
  customElements.define('lat-links', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="linksec" hidden>
  <h3 id="linkh">linked from</h3>
  <div id="linklist" class="chips"></div>
</div>`;
    }
  });

  // ── backlinks: pages that wikilink [[this page]] ─────────────────────────
  // fetched ONLY while the Backlinks tab is in front. This and history were
  // two more ~2s round-trips paid on every page open whether or not anyone
  // looked.
  const linkList = $('linklist');
  async function loadBacklinks() {
    linkList.textContent = '';
    if (!current || mode === 'know') return;
    const want = current;
    let j = null;
    // a panel nobody can see is not worth a rejection: an unreachable ship
    // leaves the list empty, the same as a refused request already does
    try {
      const r = await fetch(api + '/page-backlinks?name=' + encodeURIComponent(want));
      if (!r.ok) return;
      j = await r.json();
    } catch { return; }
    // the document changed while this was in flight: its own load follows
    if (current !== want) return;
    const links = (j.links || []).filter((p) => p !== current);
    if (!links.length) {
      const d = document.createElement('div');
      d.className = 'muted';
      d.textContent = 'nothing links here yet';
      linkList.appendChild(d);
      return;
    }
    for (const pth of links) {
      const a = document.createElement('a');
      a.textContent = pth;
      tabLink(a, 'page', pth);
      linkList.appendChild(a);
    }
  }

  // A page or memory was painted fresh. rpPaint reloads whichever of these
  // tabs is in front if it was about another document, and the other one
  // when it is next shown. The same document painted again (the upgrade
  // after a quiet open) costs nothing. History covers memories too.
  // Backlinks stay pages-only, since a wikilink search over the vault is a
  // different feature nobody asked for (rpApplies).
  function resetPanels() {
    histView.hidden = true;
    rpSoon();
  }

  // ── version history (born keeps every save; autosave makes it dense) ────
  const histList = $('histlist'), histView = $('histview');
  let revKind = null;
  const exitRev = () => {
    viewingRev = null;
    revKind = null;
    src.readOnly = false;
    histView.hidden = true;
  };
  async function loadHistory() {
    histList.textContent = '';
    if (!current) return;
    const want = current;
    let j = null;
    // same rules as loadBacklinks: an unreachable ship leaves the panel
    // empty, and an answer about a document no longer open is dropped
    try {
      const r = await fetch(mode === 'know'
        ? api + '/know-history?key=' + encodeURIComponent(want)
        : api + '/page-history?name=' + encodeURIComponent(want));
      if (!r.ok) return;
      j = await r.json();
    } catch { return; }
    if (current !== want) return;
    const revs = j.revisions || [];
    if (revs.length < 2) {               // a single revision is just "now"
      const d = document.createElement('div');
      d.className = 'muted';
      d.textContent = 'no history yet';
      histList.appendChild(d);
      return;
    }
    for (const v of revs.slice(0, 30)) {
      const a = document.createElement('a');
      // @da is always ship UTC. daToUnix (vault.js) runs the same fields
      // through Date.UTC for the export mtime; do the same here so a chip
      // reads in the viewer's own zone instead of bare, unlabeled ship time.
      const m = /^~(\d+)\.(\d+)\.(\d+)\.\.(\d+)\.(\d+)\.(\d+)/.exec(v.updated || '');
      const when = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
      const label = when && when.toLocaleString(undefined,
        { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      // label by timestamp, not the raw clay revision id. prune-hist thins
      // keystroke-scale autosaves, so the id skips (1, 2, 16) and the gaps
      // read as missing versions. The id lives on dataset.rev for restore.
      a.textContent = label || ('rev ' + v.rev);
      a.dataset.rev = v.rev;
      a.className = v.rev === viewingRev ? 'on' : '';
      a.onclick = () => openRev(v.rev, label);
      histList.appendChild(a);
    }
  }
  async function openRev(rev, lbl) {
    // guardDirty covers a dirty grub, page, or memory in one place (see
    // 20-state.js): it flushes what it can and only asks when the flush
    // still leaves something unsaved.
    if (!(await guardDirty())) return;
    let d = null;
    try {
      const r = await fetch(mode === 'know'
        ? api + '/know-read-at?key=' + encodeURIComponent(current) + '&rev=' + rev
        : api + '/page-source-at?name=' + encodeURIComponent(current) + '&rev=' + rev);
      if (!r.ok) {
        st('revision load failed' + await errText(r), false);
        // prune-hist coalesces revisions inside its window on every save, so
        // a chip the pane still lists can genuinely be gone. Resync the list
        // instead of leaving a chip that will fail forever.
        if (r.status === 404) loadHistory();
        return;
      }
      d = await r.json();
    } catch { st('revision load failed (network)', false); return; }
    viewingRev = rev;
    // restore under the REVISION's own kind. Memories carry no kind at all
    revKind = mode === 'know' ? null : (d.kind === 'index' ? 'md' : d.kind);
    dirty = false;
    src.value = d.body;
    src.readOnly = true;
    render(); sync();
    histView.hidden = false;
    for (const a of histList.children)
      a.className = +a.dataset.rev === rev ? 'on' : '';
    st('viewing ' + (lbl || 'an earlier version') + ' \u00b7 read-only');
    if (mode !== 'know' && CONTENT()) refreshPreview();
  }
  $('hback').onclick = () => {
    exitRev();
    if (mode === 'know') openKnow(current); else openPage(current);
  };
  $('hrestore').onclick = async () => {
    if (viewingRev === null) return;
    const rev = viewingRev;
    if (mode === 'know') {
      exitRev();
      // the dedicated restore route re-imports the revision's OWN tags via
      // %import, so the tag set that rev actually held comes back with it
      const r = await mutate(api + '/know-restore-rev?key=' + encodeURIComponent(current) +
        '&rev=' + rev);
      if (!r.ok) { st('restore failed' + await errText(r), false); return; }
      knowGen++;
      await openKnow(current);   // repaints body + tags from the restored entry
      st('restored that version as the newest revision');
      loadHistory();
      return;
    }
    const kind = revKind;
    exitRev();
    dirty = true;          // the historical body is now an unsaved local edit
    await save(kind);      // under the revision's OWN kind, not the current select
    // save() reports its own failures and leaves dirty SET on every path
    // that did not durably hold the body — do not paint success over that
    if (!dirty) st('restored that version as the newest revision');
    loadHistory();
  };

  $('mv').onclick = async () => {
    if (viewingRev !== null) { st('viewing rev ' + viewingRev + ' — use restore', false); return; }
    if (curFolder) { moveFolder(curFolder); return; }
    if (!current) { st('open something first', false); return; }
    let seed = current;
    for (;;) {
      const typed = await askName('move ' + (mode === 'know' ? 'memory' : 'page') + ' ' + current + ' to:',
        seed, 'move');
      if (!typed) return;
      const rn = realName(typed);
      const newName = rn.name;
      // same path with a display name is still a rename (My Page over my-page)
      if (newName === current && !(mode !== 'know' && rn.dname)) return;
      if (mode === 'know') {
        const r = await mutate(api + '/know-move?from=' + encodeURIComponent(current) +
          '&to=' + encodeURIComponent(newName));
        if (!(r.ok || r.offline)) {
          // the server refused this name — loop back into askName seeded with
          // it, so the retry is an edit, not a full retype
          st('move failed' + await errText(r), false);
          seed = newName;
          continue;
        }
        // the body is already in the editor. Rename in place, no refetch
        knowGen++;
        const k = knowKeys.find((x) => x.key.replace(/^\//, '') === current);
        if (k) k.key = newName;
        tabsRemap('know', current, newName);
        setOpen(newName, { readOnly: true });
        renderKnowChips();
        renderKnowTree();
        st('moved to ' + newName);
        return;
      }
      const mv = await movePage(current, newName, rn);
      if (mv) {
        st('moved to ' + newName + (mv.offline ? ' offline' : ''));
        openPage(newName);
        return;
      }
      // movePage already reported the cause — loop back into askName seeded
      // with the rejected name
      seed = typed;
    }
  };
