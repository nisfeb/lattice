  // ── shared with me: a folder in the files tree ──────────────────────────
  // Pages other ships granted us, fed by their share notices: "shared with
  // me", a folder per ship, and each page by its own name on that ship.
  // These are claims, not capabilities. An entry proves itself when opened,
  // and a stale one can just be removed. The folder exists only while there
  // is something in it.
  //
  // A notice names the page's code grub, <their base>/page/<name>/code. The
  // base is wherever lattice is installed there, so only the tail is read.
  const sharedName = (p) => {
    const m = /\/page\/(.+)\/code$/.exec(p);
    return m ? m[1] : p.replace(/^\/+/, '');
  };
  //  bg as in loadPerms: only boot uses it
  async function loadShared(bg = false) {
    let r = null;
    try { r = await (bg ? bgFetch : fetch)(api + '/shared-with-me'); } catch {}
    if (!r || !r.ok) return;           // the folder just stays as it was
    sharedWithMe = await r.json();
    renderTree();
  }
  // keys for the collapsed list: a leading space is in no page name, so a
  // page can never share a fold with this folder
  const SWM = ' shared';
  // appended by renderTree, after the pages
  function renderShared(coll) {
    const fold = (key, label, depth) => {
      treeList.appendChild(folderRow(label, depth, coll.includes(key),
        () => { paneColl.flip(key); renderTree(); }, undefined, key));
      return !coll.includes(key);
    };
    if (!fold(SWM, 'shared with me', 0)) return;
    for (const host of [...new Set(sharedWithMe.map((s) => s.host))].sort()) {
      if (!fold(SWM + '/' + host, host, 1)) continue;
      const mine = sharedWithMe.filter((s) => s.host === host)
        .sort((a, b) => sharedName(a.path).localeCompare(sharedName(b.path)));
      for (const it of mine) {
        const a = document.createElement('a');
        a.className = 'pg swm';
        a.style.marginLeft = '28px';
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
        const x = document.createElement('span');
        x.className = 'swrm';
        x.textContent = '×';
        x.title = 'remove from this list (their grant is untouched)';
        x.onclick = async (e) => {
          e.preventDefault(); e.stopPropagation();
          const r = await fetch(api + '/shared-with-me-del?host=' + encodeURIComponent(host) +
            '&path=' + encodeURIComponent(it.path), { method: 'POST' }).catch(() => null);
          if (!r || !r.ok) { st('remove failed' + await errText(r), false); return; }
          loadShared();
        };
        // into my own tree as a link: this, or a drag onto a folder
        const mv = document.createElement('span');
        mv.className = 'swmv';
        mv.setAttribute('role', 'button');
        tip(mv, 'Move into my pages');
        mv.innerHTML = ico('link');
        mv.onclick = (e) => { e.preventDefault(); e.stopPropagation(); askMoveIn(it); };
        a.append(nm, md, mv, x);
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
        treeList.appendChild(a);
      }
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
    const r = await fetch(api + '/link-make?host=' + encodeURIComponent(it.host) +
      '&path=' + encodeURIComponent(it.path) + '&to=' + encodeURIComponent(to),
    { method: 'POST' }).catch(() => null);
    if (!r || !r.ok) { st('move failed' + await errText(r), false); return false; }
    let n = null;
    try { n = await r.json(); } catch {}
    sharedWithMe = sharedWithMe.filter((s) => !(s.host === it.host && s.path === it.path));
    if (to.includes('/')) addFolderNodes(to.slice(0, to.lastIndexOf('/')));
    dropTreeNodes(to);
    nodes.push(n && n.path === to ? n : { path: to, page: true, kind: 'md',
      link: { host: it.host, path: it.path, mode: it.mode, seen: { ok: true } } });
    snapTree();
    renderTree();
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
      moveIn(it, folder + '/' + swmLeaf(it));
    });
  }
  // the link at `name` back to shared with me. What is open on it closes
  // the way a deleted page's does.
  async function linkBack(name) {
    const lk = linkOf(name);
    if (!lk) return;
    if (current === name && !(await guardDirty())) return;
    const r = await fetch(api + '/link-unmake?name=' + encodeURIComponent(name),
      { method: 'POST' }).catch(() => null);
    if (!r || !r.ok) { st('move failed' + await errText(r), false); return; }
    dropTreeNodes(name);
    snapTree();
    if (current === name || (activeTab && activeTab.kind === 'page' && activeTab.key === name)) {
      dirty = false;
      newFile('', false);
    }
    renderTree();
    await loadShared();
    st('moved ' + name + ' back to shared with me');
  }
  // the palette's way in: which shared page, then the move dialog. Its
  // home is out of sight in the Files pane; the rows' own buttons are the
  // way a pointer goes.
  const swmHold = document.createElement('div');
  swmHold.hidden = true;
  swmHold.innerHTML = '<button type="button" id="swmmv" data-action="swm-move">Move into my pages</button>';
  $('tree').append(swmHold);
  $('swmmv').onclick = async () => {
    if (!sharedWithMe.length) { st('nothing is shared with you', false); return; }
    const label = (it) => it.host + '/' + sharedName(it.path);
    const pick = sharedWithMe.length === 1 ? label(sharedWithMe[0])
      : await askChoice('move which page into my pages?', sharedWithMe.map(label), 'pick');
    const it = sharedWithMe.find((x) => label(x) === pick);
    if (it) askMoveIn(it);
  };
  action({ id: 'swm-move', name: 'Move into my pages', home: 'Files \u203a shared with me',
    when: () => sharedWithMe.length > 0, run: () => $('swmmv').click() });
  // deferred to boot, same reason as loadPerms. See 67-perms.js.
