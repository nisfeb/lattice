  // ── following: shared folders this ship follows ─────────────────────────
  // A peer's shared folder (urb://~host/<folder>/) followed from its index
  // page's Follow button. The ship keeps the list and the pages each folder
  // listed when last read (/folder-follows); a page added or changed since
  // it was seen counts as new. Pull, nothing asked of the publisher: the
  // ship reads every folder again on boot and every 20 minutes while this
  // is open (/folder-check), and at once when a share notice lands under
  // one ('stale' on /beacon/folds, 90-sync.js).
  //
  // For whatever wants to act on it (notifications): every /beacon/folds
  // stamp with op 'new' is also a window event, lattice:folder-new, whose
  // detail is {host, path, new}.
  const FOL = ' following';
  const foldName = (f) => f.host + f.path;
  const foldUrl = (host, path) => 'urb://' + host + path;
  async function loadFolds(bg = false) {
    let r = null;
    try { r = await (bg ? bgFetch : fetch)(api + '/folder-follows'); } catch {}
    if (!r || !r.ok) return;
    try { folds = await r.json(); } catch { return; }
    renderTree();
  }
  // read one folder again (its host and path), or every one
  async function checkFolds(f) {
    const q = f ? '?host=' + encodeURIComponent(f.host) + '&path=' + encodeURIComponent(f.path) : '';
    if (!f && !folds.length) return;
    try { await fetch(api + '/folder-check' + q, { method: 'POST' }); } catch {}
    loadFolds(true);
  }
  setInterval(() => { if (!document.hidden) checkFolds(); }, 20 * 60000);
  let foldTimer = null;
  const foldsBumped = (data) => {
    let j = null;
    try { j = JSON.parse(data); } catch {}
    // the notice can beat the folder's index being written again on the
    // host, so it is read now and twice more shortly after
    if (j && j.op === 'stale' && j.host && j.path) {
      for (const ms of [0, 4000, 12000]) setTimeout(() => checkFolds(j), ms);
      return;
    }
    if (j && j.op === 'new')
      window.dispatchEvent(new CustomEvent('lattice:folder-new',
        { detail: { host: j.host, path: j.path, new: j.new } }));
    clearTimeout(foldTimer);
    foldTimer = setTimeout(loadFolds, 300);
  };
  const foldPost = (route, f, extra = '') => fetch(api + route + '?host=' + encodeURIComponent(f.host)
    + '&path=' + encodeURIComponent(f.path) + extra, { method: 'POST' }).catch(() => null);
  async function unfollowFold(f) {
    const r = await foldPost('/folder-unfollow', f);
    if (!r || !r.ok) { st('unfollow failed' + await errText(r), false); return; }
    folds = folds.filter((x) => !(x.host === f.host && x.path === f.path));
    renderTree();
    st('unfollowed ' + foldName(f));
  }
  // a page opened from the list is seen
  function openFoldPage(f, p) {
    if (p.new) {
      p.new = false;
      f.new = Math.max(0, f.new - 1);
      renderTree();
      foldPost('/folder-seen', f, '&key=' + encodeURIComponent(p.key));
    }
    browseIn(api + '?url=' + encodeURIComponent(foldUrl(f.host, p.key)));
  }
  // appended by renderTree, after shared with me
  function renderFolds(coll) {
    const all = folds.reduce((n, f) => n + (f.ok ? f.new : 0), 0);
    const top = folderRow('following', 0, coll.includes(FOL),
      () => { paneColl.flip(FOL); renderTree(); }, undefined, FOL);
    sysFlair(top, 'following');
    if (all) top.append(foldBadge(all + ' new'));
    treeList.appendChild(top);
    if (coll.includes(FOL)) return;
    for (const f of [...folds].sort((a, b) => foldName(a).localeCompare(foldName(b)))) {
      const key = FOL + '/' + foldName(f);
      const row = folderRow(foldName(f), 1, coll.includes(key),
        () => { paneColl.flip(key); renderTree(); }, undefined, key);
      row.classList.add('fol');
      row.dataset.fold = foldName(f);
      if (!f.ok) {
        const b = foldBadge('unavailable');
        b.classList.add('gone');
        b.title = f.host + ' no longer shares this folder with you, or cannot be reached';
        row.append(b);
      } else if (f.new) row.append(foldBadge(f.new + ' new'));
      const x = rmX('unfollow', () => unfollowFold(f));
      x.classList.add('folrm');
      row.append(foldIx(f.host, f.path), x);
      treeList.appendChild(row);
      if (coll.includes(key)) continue;
      for (const p of f.pages) foldPage(f.host, f.path, p, 2, key, () => openFoldPage(f, p));
    }
  }
  // the way to a folder's index, beside its row
  function foldIx(host, rel) {
    const ix = document.createElement('a');
    ix.className = 'folix';
    ix.href = api + '?url=' + encodeURIComponent(foldUrl(host, rel) + '/');
    ix.textContent = '↗';
    ix.title = 'open the folder\'s index';
    ix.onclick = (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
      e.preventDefault();
      browseIn(ix.href);
    };
    return ix;
  }
  // the x at a row's end
  function rmX(title, fn) {
    const x = document.createElement('span');
    x.className = 'swrm';
    x.textContent = '×';
    x.title = title;
    x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
    return x;
  }
  // one page of a folder `rel` on `host`, by its title, bold while new
  function foldPage(host, rel, p, depth, key, open) {
    const a = document.createElement('a');
    a.className = 'pg swm folpg' + (p.new ? ' new' : '');
    a.href = api + '?url=' + encodeURIComponent(foldUrl(host, p.key));
    a.title = host + p.key + (p.new ? ' (new)' : '');
    const nm = document.createElement('span');
    nm.className = 'swn';
    nm.textContent = p.title || p.key.slice(rel.length + 1);
    a.append(nm);
    a.onclick = (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
      e.preventDefault();
      open();
    };
    treeItem(a, depth, key + '/' + p.key);
    a.style.marginLeft = (depth * 14) + 'px';
    treeList.appendChild(a);
  }
  function foldBadge(t) {
    const b = document.createElement('span');
    b.className = 'folnew';
    b.textContent = t;
    return b;
  }
