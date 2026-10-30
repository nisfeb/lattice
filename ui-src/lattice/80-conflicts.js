  // ── conflict inbox: <lat-conflicts> ─────────────────────────────────────
  // When a save lands on top of an edit made elsewhere, the ship keeps the
  // LOSING body as a real page under conflicts/ (see conflict-name in
  // app.hoon), and the save's response names it. That is careful, but it is
  // also write-only: nothing in the workspace ever listed them, so a conflict
  // was preserved in a place nobody looked. This is the read side.
  //
  // No server route and no fetch: a conflict IS an ordinary page in the tree
  // the client already holds, so the whole pane derives from `nodes`. The
  // badge counts them; the pane lists them with the live page they came from.
  customElements.define('lat-conflicts', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="cfwrap" hidden role="region" aria-label="sync conflicts">
  <div class="aclbar">
    <h2>Conflicts</h2>
    <span class="muted" id="cfsum"></span>
    <span class="grow"></span>
  </div>
  <div class="aclbody">
    <p class="aclnote">Each of these is a version that lost a sync race: your
    save went through, and the version it replaced was kept here so nothing was
    destroyed. Open one to read it next to the live page, then remove it when
    you have what you need. Removing is just deleting that conflicts/ page.</p>
    <div id="cflist"></div>
  </div>
</div>`;
    }
  });

  // conflicts/<name-with-dashes>-rev<N>, the inverse of the ship's
  // conflict-name. Best-effort: the rev suffix is stripped and the dashes
  // become slashes, which is unambiguous for any name that itself has no dash.
  const cfOriginal = (path) => {
    const m = path.match(/^conflicts\/(.+)-rev\d+$/);
    return m ? m[1].replace(/-/g, '/') : null;
  };
  const cfList = () => {
    const out = [];
    for (const n of nodes)
      if (n.page && n.path.startsWith('conflicts/')) out.push(n.path);
    return out.sort();
  };

  // the badge: a CONDITION (unresolved conflicts exist), so like the offline
  // badge it stays up rather than living in the scrolling status line. The
  // ribbon's Sync conflicts button (24-tools.js) shows only while there are
  // any, with their count.
  function renderConfBadge() {
    const b = $('rb-conflicts');
    if (!b) return;
    const n = cfList().length;
    b.hidden = n === 0;
    if (n) b.dataset.n = n > 99 ? '99+' : String(n);
    else delete b.dataset.n;
  }

  function renderConflicts() {
    const host = $('cflist');
    const sum = $('cfsum');
    if (!host) return;
    host.textContent = '';
    const list = cfList();
    sum.textContent = list.length ? list.length + ' to resolve' : '';
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'aclempty';
      e.textContent = 'No unresolved conflicts.';
      host.appendChild(e);
      return;
    }
    for (const path of list) {
      const card = document.createElement('div');
      card.className = 'aclcard';
      const head = document.createElement('header');

      const nm = document.createElement('b');
      nm.textContent = path;                       // textContent: names are content
      head.appendChild(nm);

      const orig = cfOriginal(path);
      if (orig && hasNode(orig)) {
        const live = document.createElement('a');
        live.textContent = 'open live (' + orig + ')';
        live.title = 'open the page this conflicted with';
        live.style.cursor = 'pointer';
        live.onclick = (e) => openIn('page', orig, { ev: e });
        head.appendChild(live);
      }

      const view = document.createElement('button');
      view.textContent = 'read it';
      view.onclick = (e) => openIn('page', path, { ev: e });
      head.appendChild(view);

      const del = document.createElement('button');
      del.textContent = 'resolve (delete)';
      del.className = 'acl-del';
      del.onclick = async () => {
        if (!(await askConfirm('delete ' + path + '? Open it first if you need its text.', 'delete'))) return;
        const r = await mutate(api + '/page-del?name=' + encodeURIComponent(path));
        if (!r.ok) { st('delete failed' + await errText(r), false); return; }
        dropTreeNodes(path);
        snapTree();
        renderConflicts();
        renderConfBadge();
        renderTree();
        st(r.offline ? 'resolved ' + path + ' offline' : 'resolved ' + path);
      };
      head.appendChild(del);
      card.appendChild(head);
      host.appendChild(card);
    }
  }

  // its tab's coming forward renders it (24-tools.js)
  const cfOpen = () => toolOpen('conflicts');
