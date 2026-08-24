  // ── controls pane: <lat-ctl> frame ───────────────────────────────────────
  // Renders the pane skeleton with one tag per panel. The panel components
  // (lat-knowtags 68, lat-share 66, lat-history/lat-links 77) upgrade when
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
  <lat-share></lat-share>
  <lat-shared></lat-shared>
  <lat-history></lat-history>
  <lat-links></lat-links>
  <button id="mv" class="mvbtn">move / rename</button>
  <button id="del" class="del">delete page</button>
</aside>`;
      cerr = $('cerr');
    }
  });
  // stale-shell guard: swap a cached pre-component shell's literal pane
  if (!document.querySelector('lat-ctl')) {
    const stale = document.querySelector('aside.ctl');
    if (stale) stale.remove();
    const el = document.createElement('lat-ctl');
    el.style.display = 'contents';
    document.getElementById('ws').appendChild(el);
  }

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
