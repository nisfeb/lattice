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
  $('del').onclick = async () => {
    if (mode === 'know') { deleteKnow(); return; }
    if (viewingRev !== null) { st('viewing rev ' + viewingRev + ' — use restore', false); return; }
    if (curFolder) {
      const path = curFolder;
      const c = pageCount(path);
      // pages carry no trash: the writer prunes every revision and never
      // offers a restore route, unlike the memory delete confirm a click
      // away, which correctly says restorable. Say permanent here instead.
      const what = 'delete folder ' + path +
        (c ? ' and the ' + c + ' page' + (c === 1 ? '' : 's') + ' under it' : '') +
        '? (permanent, not restorable)';
      if (!(await askConfirm(what, 'delete'))) return;
      const r = await mutate(api + '/page-del?name=' + encodeURIComponent(path));
      if (!r.ok) { st('delete failed' + await errText(r), false); return; }
      dropTreeNodes(path);
      snapTree();
      // no focus: a focused newFile becomes the create dialog under the
      // desktop wrapper, and nobody asked to create a page by deleting one
      newFile('', false);
      st(r.offline ? 'deleted ' + path + ' offline' : 'deleted ' + path);
      return;
    }
    if (!current) { st('nothing to delete', false); return; }
    const doomed = current;
    // the server culls the page's whole dir, nested pages included, and
    // dropTreeNodes below assumes exactly that. Count what goes the way the
    // folder branch does, so the confirm is proportional to the loss
    const c = pageCount(doomed);
    // same reason as the folder confirm above: no trash, no restore, so say so
    const what = 'delete ' + doomed +
      (c ? ' and the ' + c + ' page' + (c === 1 ? '' : 's') + ' under it' : '') +
      '? (permanent, not restorable)';
    if (!(await askConfirm(what, 'delete'))) return;
    const r = await mutate(api + '/page-del?name=' + encodeURIComponent(doomed));
    if (!r.ok) { st('delete failed' + await errText(r), false); return; }
    dropTreeNodes(doomed);
    snapTree();
    newFile('', false);
    st(r.offline ? 'deleted ' + doomed + ' offline' : 'deleted ' + doomed);
  };
