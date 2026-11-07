  // ── shared with me: a folder in the files tree ──────────────────────────
  // Pages other ships granted us, fed by their share notices: "shared with
  // me", a folder per ship, and each page by its own name on that ship.
  // These are claims, not capabilities. An entry proves itself when opened,
  // and a stale one can just be removed. The folder exists only while there
  // is something in it.
  //
  // A notice names the page's code grub, <their base>/page/<name>/code. The
  // base is wherever lattice is installed there, so only the tail is read.
  // A folder shared whole is one entry naming its index grub,
  // <their base>/page/<folder>/dir-index, and reads as <folder>/.
  const swmDir = (p) => /\/page\/.+\/dir-index$/.test(p);
  const swmRel = (p) => '/' + /\/page\/(.+)\/dir-index$/.exec(p)[1];
  const sharedName = (p) => {
    if (swmDir(p)) return swmRel(p).slice(1) + '/';
    const m = /\/page\/(.+)\/code$/.exec(p);
    return m ? m[1] : p.replace(/^\/+/, '');
  };
  // the reader on urb://<host><rel>, a folder's index with a trailing /
  const swmRead = (host, rel) => api + '?url=' + encodeURIComponent('urb://' + host + rel);
  //  bg as in loadPerms: only boot uses it
  async function loadShared(bg = false) {
    let r = null;
    try { r = await (bg ? bgFetch : fetch)(api + '/shared-with-me'); } catch {}
    if (!r || !r.ok) return;           // the folder just stays as it was
    sharedWithMe = await r.json();
    swmAt = Date.now();
    renderTree();
  }
  // ── live: /beacon/shares (90-sync.js) ───────────────────────────────────
  // The ship stamps /beacon/shares whenever the list changes: a notice
  // landed, the host revoked one, or we curated it. The stream hands us
  // {op, host, path}, and the list is refetched rather than patched, so the
  // tree only ever shows what /shared-with-me says.
  let swmAt = 0;
  let swmTimer = null;
  const sharesBumped = (data) => {
    clearTimeout(swmTimer);
    swmTimer = setTimeout(loadShared, 300);
    let j = null;
    try { j = JSON.parse(data); } catch {}
    // a folder told again ('touch': a page made in it) reads its pages anew
    if (j && j.host && j.path) swmPages.delete(j.host + ' ' + j.path);
    if (j && j.op === 'add' && j.host && j.path) shareToast(j);
  };
  // the stream dropped (a hidden tab, a sleeping laptop): a window that
  // comes back refetches, at most once a minute. Un-hiding fires focus and
  // visibilitychange both, before the first answer sets swmAt, so the one
  // in flight is shared: it was two GETs of /shared-with-me each time.
  let swmFly = null;
  const sharesRefocused = () => {
    if (document.hidden || swmFly || Date.now() - swmAt < 60000) return;
    swmFly = loadShared(true).finally(() => { swmFly = null; });
  };
  window.addEventListener('focus', sharesRefocused);
  document.addEventListener('visibilitychange', sharesRefocused);
  // "~ship shared <page> with you": no sound, no badge, gone in 8s
  let toastEl = null;
  function shareToast(j) {
    if (toastEl) toastEl.remove();
    const t = toastEl = document.createElement('a');
    t.className = 'swtoast';
    t.setAttribute('role', 'status');
    t.href = swmDir(j.path) ? swmRead(j.host, swmRel(j.path) + '/')
      : '/apps/lattice/app?grub=' + encodeURIComponent(j.path) + '&ship=' + encodeURIComponent(j.host);
    t.textContent = j.host + ' shared ' + sharedName(j.path) + ' with you';
    t.title = 'open it';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 8000);
  }
  // the x at a row's end (the follow list's too, 69x-follow.js)
  function rmX(title, fn) {
    const x = document.createElement('span');
    x.className = 'swrm';
    x.textContent = '×';
    x.title = title;
    x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
    return x;
  }
  //  Take an entry off the list, after a confirm. Nothing is deleted:
  //  the page is theirs, and their grant stays as it is. The ×, the tree's
  //  menu and its Delete key (34-treemenu.js) all come here.
  async function removeShared(it) {
    const kind = swmDir(it.path) ? 'folder' : 'page';
    const what = 'remove ' + it.host + '/' + sharedName(it.path) + ' from shared with me?\n'
      + 'Nothing is deleted: the ' + kind + ' is ' + it.host + "'s, and their grant to you stays. "
      + 'It comes back here if they share it again.';
    if (!(await askDanger(what, 'remove'))) return false;
    const r = await busyFetch(api + '/shared-with-me-del?host=' + encodeURIComponent(it.host) +
      '&path=' + encodeURIComponent(it.path), { method: 'POST' }).catch(() => null);
    if (!r || !r.ok) { st('remove failed' + await errText(r), false); return false; }
    st('removed ' + sharedName(it.path) + ' from shared with me');
    loadShared();
    return true;
  }
  // keys for the collapsed list: a leading space is in no page name, so a
  // page can never share a fold with this folder
  const SWM = ' shared';
  // The list holds up to 2000 entries (+cap in lib/lattice-share), so a
  // ship's folder draws them a page of rows at a time, with a row for the
  // rest. The same goes for a shared folder's pages.
  const SWM_ROWS = 200;
  const swmShown = new Map();          // fold key -> rows drawn
  const moreRow = (key, left, depth) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swmore';
    b.style.marginLeft = (depth * 14) + 'px';
    b.textContent = left + ' more\u2026';
    b.onclick = () => { swmShown.set(key, (swmShown.get(key) || SWM_ROWS) + SWM_ROWS); renderTree(); };
    treeList.appendChild(b);
  };
  // a shared folder's pages, read on its first opening (/folder-pages)
  // and kept until a notice for it lands: host+' '+path -> rows, or
  // 'wait' while the read is out, or null when the folder would not read
  const swmPages = new Map();
  async function loadSwmPages(it) {
    const k = it.host + ' ' + it.path;
    swmPages.set(k, 'wait');
    let rows = null;
    try {
      const r = await fetch(api + '/folder-pages?host=' + encodeURIComponent(it.host) +
        '&path=' + encodeURIComponent(swmRel(it.path)));
      if (r.ok) rows = await r.json();
    } catch {}
    if (swmPages.get(k) === 'wait') swmPages.set(k, rows);
    renderTree();
  }
  // A folder entry: a folder row that opens its index (#397) and unfolds
  // to its pages. A followed folder (69x-follow.js) shows its pages as the
  // follow last read them, with its "N new"; any other reads them now.
  function renderSwmDir(it, host, coll) {
    const key = SWM + '/' + host + '/' + it.path;
    const okey = key + ' +';           // folded unless opened
    const shut = !coll.includes(okey);
    const rel = swmRel(it.path);
    const row = folderRow(sharedName(it.path), 2, shut,
      () => { paneColl.flip(okey); renderTree(); }, undefined, key);
    row.classList.add('swdir');
    row.title = host + ' ' + rel + '/';
    const f = folds.find((x) => x.host === host && x.path === rel);
    if (f && f.ok && f.new) row.append(foldBadge(f.new + ' new'));
    const md = document.createElement('span');
    md.className = 'swmode';
    md.textContent = it.mode;
    const ix = foldIx(host, rel);
    const x = rmX('remove from this list (their grant is untouched)', () => removeShared(it));
    row.append(md, ix, x);
    rowMore(row, sharedName(it.path) + ' from ' + host);
    treeList.appendChild(row);
    if (shut) return;
    let pages = f && f.ok ? f.pages : swmPages.get(host + ' ' + it.path);
    if (pages === undefined && !(f && f.ok)) { loadSwmPages(it); pages = 'wait'; }
    if (!Array.isArray(pages)) {
      const n = document.createElement('div');
      n.className = 'swnote';
      n.style.marginLeft = '42px';
      n.textContent = pages === 'wait' ? 'reading\u2026' : 'it does not read (unshared, or ' + host + ' is away)';
      treeList.appendChild(n);
      return;
    }
    const lim = swmShown.get(okey) || SWM_ROWS;
    for (const p of pages.slice(0, lim))
      foldPage(host, rel, p, 3, okey, () => (f && f.ok ? openFoldPage(f, p) : browseIn(swmRead(host, p.key))));
    if (pages.length > lim) moreRow(okey, pages.length - lim, 3);
  }
  // appended by renderTree, after the pages
  function renderShared(coll) {
    const fold = (key, label, depth) => {
      const row = folderRow(label, depth, coll.includes(key),
        () => { paneColl.flip(key); renderTree(); }, undefined, key);
      if (key === SWM) sysFlair(row, 'shared');
      treeList.appendChild(row);
      return !coll.includes(key);
    };
    if (!fold(SWM, 'shared with me', 0)) return;
    for (const host of [...new Set(sharedWithMe.map((s) => s.host))].sort()) {
      if (!fold(SWM + '/' + host, host, 1)) continue;
      const hk = SWM + '/' + host;
      const mine = sharedWithMe.filter((s) => s.host === host)
        .sort((a, b) => sharedName(a.path).localeCompare(sharedName(b.path)));
      const lim = swmShown.get(hk) || SWM_ROWS;
      if (mine.length > lim) mine.length = lim;
      for (const it of mine) {
        if (swmDir(it.path)) { renderSwmDir(it, host, coll); continue; }
        const a = document.createElement('a');
        a.className = 'pg swm';
        a.href = '/apps/lattice/app?grub=' + encodeURIComponent(it.path) +
          '&ship=' + encodeURIComponent(host);
        a.title = host + ' ' + it.path;
        // the name gives way to the tag and the ×, never the other way round
        const nm = document.createElement('span');
        nm.className = 'swn';
        nm.textContent = sharedName(it.path);
        const md = document.createElement('span');
        md.className = 'swmode';
        md.textContent = it.mode;
        const x = rmX('remove from this list (their grant is untouched)', () => removeShared(it));
        a.append(nm, md, x);
        rowMore(a, sharedName(it.path) + ' from ' + host);   // its Remove from list (34-treemenu.js)
        a.draggable = true;
        a.ondragstart = (e) => {
          swmDrag = it;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(SWM_DRAG, it.host + ' ' + it.path);
        };
        a.ondragend = () => { swmDrag = null; };
        treeItem(a, 2, SWM + '/' + host + '/' + it.path);
        // a grub tab; openGrub (by way of enterGrub) sets the address
        tabLink(a, 'grub', it.path, { ship: host });
        // into my own tree as a link: this, or a drag onto a folder. A
        // button of its own beside the row (a button cannot sit in a link),
        // so a keyboard reaches it too
        const mv = document.createElement('button');
        mv.type = 'button';
        mv.className = 'swmv';
        mv.dataset.action = 'swm-move';
        tip(mv, 'Move into my pages');
        mv.innerHTML = ico('link');
        mv.onclick = () => askMoveIn(it);
        const w = document.createElement('div');
        w.className = 'swrow';
        w.style.marginLeft = '28px';
        w.append(a, mv);
        treeList.appendChild(w);
      }
      const all = sharedWithMe.filter((s) => s.host === host).length;
      if (all > lim) moreRow(hk, all - lim, 2);
    }
  }

  // ── moving in and out: a shared page becomes a link in my tree ──────────
  // One home at a time: /link-make writes the link and drops the
  // shared-with-me entry, /link-unmake puts the entry back and drops the
  // link. Neither touches the owner's grant. Both need the host's page to
  // have a kind, so a make with the host offline is refused, not queued.
  const SWM_DRAG = 'application/x-lattice-shared';
  let swmDrag = null;          // the entry being dragged, for the drop
  // the link's local name: the folder it lands in, then the page's own name
  const swmLeaf = (it) => sharedName(it.path).split('/').pop();
  // -> true once the link is in, after saying why when it is not
  async function moveIn(it, to) {
    stWork('moving ' + swmLeaf(it) + ' into ' + to + '\u2026');
    const r = await busyFetch(api + '/link-make?host=' + encodeURIComponent(it.host) +
      '&path=' + encodeURIComponent(it.path) + '&to=' + encodeURIComponent(to),
    { method: 'POST' }).catch(() => null);
    if (!r || !r.ok) { st('move failed' + await errText(r), false); return false; }
    let n = null;
    try { n = await r.json(); } catch {}
    sharedWithMe = sharedWithMe.filter((s) => !(s.host === it.host && s.path === it.path));
    if (to.includes('/')) addFolderNodes(to.slice(0, to.lastIndexOf('/')));
    // the ship's node, kind and all (frozen at the host's). Without one,
    // the tree is fetched rather than guessed at.
    if (n && n.path === to) {
      dropTreeNodes(to);
      nodes.push(n);
      snapTree();
      renderTree();
    } else await loadTree();
    st('moved into ' + to + ', linked from ' + it.host);
    return true;
  }
  // the move dialog, seeded with the page's name (or <folder>/<name>), and
  // back into it seeded with what was typed when the ship refuses
  async function askMoveIn(it, folder) {
    let seed = (folder ? folder + '/' : '') + swmLeaf(it);
    for (;;) {
      const typed = await askName('move ' + it.host + '/' + sharedName(it.path) +
        ' into my pages as:', seed, 'move');
      if (!typed) return;
      const rn = realName(typed);
      if (await moveIn(it, rn.name)) return;
      seed = typed;
    }
  }
  // a folder row in Files takes a dragged shared-with-me row: the link
  // goes in under that folder by the page's own name
  function linkDrop(row, folder) {
    row.addEventListener('dragover', (e) => {
      if (!swmDrag || ![...e.dataTransfer.types].includes(SWM_DRAG)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drop');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop');
      const it = swmDrag;
      if (!it || ![...e.dataTransfer.types].includes(SWM_DRAG)) return;
      e.preventDefault();
      swmDrag = null;
      // refused (a name already there, the host away): the dialog, as the
      // button gives, seeded with this folder
      moveIn(it, folder + '/' + swmLeaf(it)).then((ok) => { if (!ok) askMoveIn(it, folder); });
    });
  }
  // the link at `name` back to shared with me. Every tab on it closes
  // first, through closeTab, so one holding unsaved text (in front or
  // not) asks, and keeping it stops the move.
  async function linkBack(name) {
    const lk = linkOf(name);
    if (!lk) return;
    for (const t of allTabs().filter((x) => x.kind === 'page' && x.key === name))
      if ((await closeTab(t.id)) === false) return;
    const r = await busyFetch(api + '/link-unmake?name=' + encodeURIComponent(name),
      { method: 'POST' }).catch(() => null);
    if (!r || !r.ok) { st('move failed' + await errText(r), false); return; }
    dropTreeNodes(name);
    linkCf.delete(name);
    linkStale.delete(name);
    snapTree();
    renderTree();
    await loadShared();
    st('moved ' + name + ' back to shared with me');
  }
  // the palette's way in is the rows' own buttons: with one shared page
  // it is that page's, with several it goes to the first, to pick there
  action({ id: 'swm-move', name: 'Move into my pages', home: 'Files \u203a shared with me',
    when: () => !!actionHome('swm-move'),
    run: () => {
      const all = document.querySelectorAll('[data-action="swm-move"]');
      if (all.length === 1) { all[0].click(); return; }
      if (all[0]) { all[0].focus(); st('pick the page to move: its Move into my pages button'); }
    } });
  // deferred to boot, same reason as loadPerms. See 67-perms.js.
