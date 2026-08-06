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
<div class="aclwrap" id="cfwrap" hidden role="dialog" aria-modal="true" aria-label="sync conflicts">
  <div class="aclbar">
    <h2>Conflicts</h2>
    <span class="muted" id="cfsum"></span>
    <span class="grow"></span>
    <button id="cfclose">close</button>
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
  // badge it stays up rather than living in the scrolling status line
  function renderConfBadge() {
    const b = $('cflt');
    if (!b) return;
    const n = cfList().length;
    b.hidden = n === 0;
    b.textContent = '⚑ ' + n;
    b.title = n + ' unresolved conflict' + (n === 1 ? '' : 's') +
      ' — a save replaced an edit from elsewhere';
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
        live.onclick = () => { cfClose(); openPage(orig); };
        head.appendChild(live);
      }

      const view = document.createElement('button');
      view.textContent = 'read it';
      view.onclick = () => { cfClose(); openPage(path); };
      head.appendChild(view);

      const del = document.createElement('button');
      del.textContent = 'resolve (delete)';
      del.className = 'acl-del';
      del.onclick = async () => {
        if (!(await askConfirm('delete ' + path + '? Open it first if you need its text.', 'delete'))) return;
        const r = await mutate(api + '/page-del?name=' + encodeURIComponent(path));
        if (!r.ok) { st('delete failed ' + r.status, false); return; }
        dropTreeNodes(path);
        snapTree();
        renderConflicts();
        renderConfBadge();
        renderTree();
        st('resolved ' + path);
      };
      head.appendChild(del);
      card.appendChild(head);
      host.appendChild(card);
    }
  }

  const cfOpen = () => { $('cfwrap').hidden = false; renderConflicts(); };
  const cfClose = () => { $('cfwrap').hidden = true; };
  $('cfclose').onclick = cfClose;
  $('cflt').onclick = cfOpen;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('cfwrap').hidden) cfClose();
  });
