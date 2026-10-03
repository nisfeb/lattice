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
    if (mode !== 'know') renderTree();
  }
  async function openShared(it) {
    if (!(await guardDirty())) return;
    history.replaceState(null, '', '/apps/lattice/app?grub=' + encodeURIComponent(it.path) +
      '&ship=' + encodeURIComponent(it.host));
    openGrub(it.path, it.host);
  }
  // keys for the collapsed list: a leading space is in no page name, so a
  // page can never share a fold with this folder
  const SWM = ' shared';
  // appended by renderTree, after the pages
  function renderShared(coll) {
    const fold = (key, label, depth) => {
      const row = document.createElement('div');
      row.className = 'fld';
      row.style.marginLeft = (depth * 14) + 'px';
      const cx = document.createElement('span');
      cx.className = 'cx';
      cx.textContent = coll.includes(key) ? '▸' : '▾';
      const lb = document.createElement('span');
      lb.textContent = '\u{1F4C1} ' + label;
      row.append(cx, lb);
      row.onclick = () => {
        const c = collapsed();
        const i = c.indexOf(key);
        if (i >= 0) c.splice(i, 1); else c.push(key);
        setCollapsed(c);
        renderTree();
      };
      treeList.appendChild(row);
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
        a.append(nm, md, x);
        a.onclick = (e) => { e.preventDefault(); openShared(it); };
        treeList.appendChild(a);
      }
    }
  }
  // deferred to boot, same reason as loadPerms. See 67-perms.js.
