  // ── controls pane: <lat-ctl> frame ───────────────────────────────────────
  // Renders the Page tab's skeleton with one tag per panel. The panel
  // components (lat-knowtags 68, lat-share 66) upgrade when
  // NB: no lat-perms. Group EDITING lives in the full-window ACL pane now.
  // This column only points existing groups at the open file (66-share).
  // their own files run, in file order. Button handlers wired below in this
  // file (and in later files) find their elements because the frame renders
  // here first.
  let cerr;
  customElements.define('lat-ctl', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<aside class="ctl">
  <h3>status</h3>
  <div id="cerr" class="ok">&nbsp;</div>
  <lat-knowtags></lat-knowtags>
  <!-- a link to another ship's page (paintLink, below) -->
  <div id="lnkrow" hidden>
    <h3>linked</h3>
    <div id="lnkfrom"></div>
    <div id="lnkmode" class="muted"></div>
    <div id="lnkbad" class="lbad" hidden></div>
    <div id="lnkat" class="muted" hidden></div>
  </div>
  <div id="cmtrow" hidden>
    <h3>comments</h3>
    <!-- the box alone toggles, as with mark sensitive (66-share.js) -->
    <div class="chk"><input type="checkbox" id="cmton" data-action="cmton" aria-label="Comments on this page">
    <span class="muted">Comments on this page</span></div>
  </div>
  <lat-share></lat-share>
  <!-- move and delete are reached from the tab header's path and the page
       menu (23-tabhead.js), which click these. They stay, out of sight. -->
  <div hidden><button id="mv">move / rename</button><button id="del">delete page</button></div>
</aside>`;
      cerr = $('cerr');
    }
  });

  // ── a link: whose page this is ──────────────────────────────────────────
  // For a link in front (its tab, open or failed to open): where it points,
  // the grant, and the badge once a read failed. Comments and sharing are
  // the owner's, so this page's own controls for them stand down.
  function paintLink() {
    const row = $('lnkrow');
    if (!row) return;
    const t = activeTab;
    const name = t ? (t.kind === 'page' ? t.key : null)
      : (!grubPath && mode !== 'know' && curFolder === null ? current : null);
    const lk = linkOf(name);
    row.hidden = !lk;
    paintLinkCf(current);
    const sh = document.querySelector('lat-share');
    if (sh) sh.hidden = !!lk;
    if (lk) $('cmtrow').hidden = true;      // rpPaint shows it for a page
    if (!lk) return;
    // a read link stays locked. A reload paints the page from its snapshot
    // before the tree has loaded, when linkRO cannot know it is a link yet,
    // so the lock lands here, once the tree knows. Only ever locks: the
    // unlock belongs to applyPage.
    if (name === current && linkRO(name)) src.readOnly = true;
    $('lnkfrom').textContent = 'Linked from ' + linkFrom(lk);
    $('lnkmode').textContent = lk.mode === 'read' ? 'read only'
      : lk.mode === 'edit' ? 'can edit' : lk.mode;
    const bad = linkBadge(lk);
    $('lnkbad').hidden = !bad;
    $('lnkbad').textContent = bad ? bad.copy : '';
    $('lnkat').hidden = !bad || !bad.since;
    $('lnkat').textContent = bad ? bad.since : '';
  }

  // ── comments on this page ────────────────────────────────────────────────
  // Comments from other ships are opt-in per page (or per folder: the
  // nearest flag at or above a page wins). page-source reports the answer
  // for the open page as `comments`, and this box shows it. An open painted
  // from the tree dump has no answer yet; the box waits, disabled, for the
  // page-source fetch that follows. cmtOn is what the Comments tab goes by.
  let cmtOn = null;
  let cmtFor = null;
  function cmtShow(name, on) {
    const cb = $('cmton');
    cmtFor = name;
    cmtOn = typeof on === 'boolean' ? on : null;
    cb.checked = cmtOn === true;
    cb.disabled = !name || cmtOn === null;
    rpSoon();            // the Comments tab's post box goes by it too
  }
  $('cmton').onchange = async () => {
    const cb = $('cmton');
    const name = cmtFor;
    if (!name) return;
    const on = cb.checked;
    cb.disabled = true;
    const r = await mutate(api + '/page-comments?name=' + encodeURIComponent(name) +
      '&on=' + (on ? '1' : '0'));
    if (cmtFor !== name) return;
    cb.disabled = false;
    if (!r || !r.ok) { cb.checked = !on; st('comments switch failed' + await errText(r), false); return; }
    cmtOn = on;
    const hit = pageCache.get(name);
    if (hit) hit.comments = on;
    st(on ? 'comments on for ' + name : 'comments off for ' + name);
    rpSoon();
  };
  clickAction('cmton', 'Comments on this page', 'Right pane › Page');

  // NB: the command box is gone from this panel. It POSTed to /page-cmd, the
  // input channel for a programmable page. The ROUTE stays, since public form
  // submissions (POST /f/<page>) go through the same handler, but nothing in
  // the editor sends to it now.

  // ── delete ───────────────────────────────────────────────────────────────
  //  One confirm and one delete for every way to a page or a folder: the
  //  page menu's Delete (#del), the tree's menu and Delete key
  //  (34-treemenu.js) and a conflict's resolve (80-conflicts.js). Nothing
  //  deletes a page without coming through here, so nothing deletes one
  //  without the confirm.
  //
  //  The confirm says what goes: the name, how many pages go with it, what
  //  of it is published or granted (a reader's copy can outlive the delete),
  //  and that it is permanent. Pages carry no trash: the writer prunes
  //  every revision and offers no restore, unlike a memory's soft delete.
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  //  the page tabs, not in front, that hold a page at or under `path`
  const parkedUnder = (path) => allTabs().filter((t) => t !== activeTab && t.kind === 'page'
    && !t.ship && t.snap && t.key && (t.key === path || t.key.startsWith(path + '/')));
  function delWhat(path, folder) {
    const n = nodes.find((x) => x.page === !folder && x.path === path);
    const name = (n && n.dname ? n.dname + ' (' + path + ')' : path);
    const c = pageCount(path);
    const lines = [];
    if (folder) lines.push('delete folder ' + name
      + (c ? ' and the ' + plural(c, 'page') + ' in it?' : '? It is empty.'));
    else lines.push('delete ' + name
      + (c ? ' and the ' + plural(c, 'page') + ' under it?' : '?'));
    if (n && n.link && n.link.host)
      lines.push('This is a link to a page on ' + n.link.host
        + '. Only the link goes; their page is untouched.');
    //  published: the page's own share mode, or how many under the folder
    const under = nodes.filter((x) => x.page && (x.path === path || x.path.startsWith(path + '/')));
    const pub = under.filter((x) => x.share === 'shared' || x.share === 'clearweb');
    if (pub.length) {
      const web = pub.some((x) => x.share === 'clearweb');
      const how = ' published (' + (web ? 'on the clearweb' : 'over Urbit') + ').';
      lines.push(!folder && pub.length === 1 && pub[0].path === path
        ? 'It is' + how + ' Anyone who already read it may keep a copy.'
        : plural(pub.length, 'page') + (pub.length === 1 ? ' is' : ' are') + how
          + ' Anyone who already read them may keep a copy.');
    }
    //  granted to a ship or a group: the grant goes with the page
    if (selfBase && permsLoaded) {
      const pp = selfBase + '/page/' + path;
      const gs = permGroups.filter((g) => [...(g.peek || []), ...(g.make || [])]
        .some((x) => x === pp || x.startsWith(pp + '/')));
      if (gs.length) lines.push('It is shared with ' + gs.map((g) => g.name).join(', ')
        + '. Their access ends with it.');
    }
    if (path === 'conflicts')
      lines.push('Lattice makes this folder again on the next conflict.');
    const open = mode !== 'know' && !grubPath && current
      && (current === path || current.startsWith(path + '/'));
    if (open && dirty) lines.push('The open page has unsaved changes, and they go too.');
    const parked = parkedUnder(path).filter((t) => t.snap.dirty).length;
    if (parked) lines.push(plural(parked, 'other tab') + ' with unsaved changes to it'
      + (parked === 1 ? ' loses them.' : ' lose them.'));
    if (degraded || offCount) lines.push('You are offline: the delete is queued and runs when the ship is back.');
    lines.push('This is permanent and cannot be restored.');
    return lines.join('\n');
  }
  //  -> true once deleted. `folder` says which node the path names (a page
  //  can have pages under it and still be a page). `note` is a caller's own
  //  line for the confirm. What is open stays open unless it is the page
  //  deleted or is under the folder deleted; then a clean new page.
  async function deletePath(path, folder, note) {
    if (!path) return false;
    if (!(await askDanger(delWhat(path, folder) + (note ? '\n' + note : ''), 'delete'))) return false;
    const hit = (p) => !!p && (p === path || p.startsWith(path + '/'));
    //  what is open goes with it: the editor lets go of it first, so no
    //  autosave or trailing save can aim at it, and a save already on the
    //  wire lands before the delete does, never after it (it made the page
    //  again). A clean new page, and no focus: a focused newFile becomes
    //  the create dialog under the desktop wrapper.
    if ((mode !== 'know' && !grubPath && hit(current)) || hit(curFolder)) {
      clearTimeout(autoTimer);
      dirty = false;
      savePending = false;
      newFile('', false);
    }
    //  a tab not in front keeps its unsaved text in its snap, and brought
    //  back it would autosave that text (21-tabs.js), and a parked save
    //  still queued would send it (saveParked, 35-pages.js). Either one made
    //  the page again, so the text the user just agreed to lose is let go.
    const gone = parkedUnder(path).filter((t) => t.snap.dirty);
    for (const t of gone) t.snap.dirty = false;
    if (gone.length) paintTabs();
    //  settled, not only off the wire: a save whose write failed clears
    //  `saving` and only then queues its body offline. A delete sent in
    //  that gap queued before the save did, so the save outlived the
    //  delete's cull of the queue and replayed the page back. Capped, so
    //  a save that never answers cannot hold the delete forever.
    await savesSettled();
    const r = await mutate(api + '/page-del?name=' + encodeURIComponent(path));
    if (!r.ok) { st('delete failed' + await errText(r), false); return false; }
    dropTreeNodes(path);
    snapTree();
    renderTree();
    st(r.offline ? 'deleted ' + path + ' offline' : 'deleted ' + path);
    return true;
  }
  $('del').onclick = async () => {
    if (mode === 'know') { deleteKnow(); return; }
    if (viewingRev !== null) { st('viewing rev ' + viewingRev + ', use restore', false); return; }
    if (curFolder) { deletePath(curFolder, true); return; }
    if (!current) { st('nothing to delete', false); return; }
    deletePath(current, false);
  };
