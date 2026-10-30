  // ── page kind <-> extension, once for the whole bundle ───────────────────
  // `kind` is what the ship stores (page-save?type=); `ext` is what a filename
  // shows. They differ for `text`, and `index` is a page the ship generates
  // (+make-folder-index) whose file form is markdown. Everything in the bundle
  // reads these two tables: the tree below, the uploader (70-upload.js) and
  // the desktop File menu (96-deskmenu.js). Those files are numbered after
  // this one and the build concatenates in filename order into one scope, so
  // the names are visible there.
  //
  // Two copies live outside the bundle and have to be kept in step by hand:
  // ui-app/vault.js, which is also served alone to the Settings page with no
  // bundle around it, and lattice-fs-rs/src/projection.rs, another process in
  // another language.
  //
  // `htm` and `text` are INBOUND-ONLY aliases: archives written before the
  // extension was conventionalised named those files `.text`, and a restore
  // has to keep reading archives this app already handed out.
  const KIND_EXT = { md: 'md', gmi: 'gmi', html: 'html', text: 'txt', js: 'js',
                     css: 'css', hoon: 'hoon', index: 'md', tex: 'tex' };
  const EXT_KIND = { md: 'md', gmi: 'gmi', html: 'html', htm: 'html', txt: 'text',
                     text: 'text', js: 'js', css: 'css', hoon: 'hoon', tex: 'tex',
                     latex: 'tex' };
  //  an unknown kind shows as hoon, the kind that holds arbitrary source
  const kindExt = (k) => KIND_EXT[k] || 'hoon';
  //  an unknown extension is null, never guessed: the caller skips that file
  const extKind = (e) => EXT_KIND[String(e || '').toLowerCase()] || null;

  // ── tree pane: <lat-tree> ────────────────────────────────────────────────
  // The pane's buttons are wired where their handlers live (45-templates,
  // 70-upload). Those files run after this component upgrades, so their
  // $-lookups find the rendered elements. The create and upload buttons sit
  // in their own .newbtns group because the desktop File menu takes them
  // over and hides that group (96-deskmenu.js); sort and collapse stay.
  let treeList;
  // pages other ships shared with us (/shared-with-me), drawn as a folder
  // after the pages. Filled by 69-shared.js.
  let sharedWithMe = [];
  customElements.define('lat-tree', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<aside class="tree" id="tree">
  <div class="ptool" role="toolbar" aria-label="Files">
    <div class="newbtns">
      ${sbtn('id="newfile" data-action="newfile"', 'plus', 'New page')}
      ${sbtn('id="newfolder" data-action="newfolder"', 'fplus', 'New folder')}
      ${sbtn('id="newtmpl" data-action="newtmpl"', 'tpl', 'New from template')}
      ${sbtn('id="upfiles" data-action="upfiles"', 'upload', 'Upload files')}
      ${sbtn('id="updir" data-action="updir"', 'updir', 'Upload a folder')}
    </div>
    <span class="grow"></span>
    ${sbtn('id="tsort" data-action="tsort"', 'sort', 'Sort: name')}
    ${sbtn('id="tcoll" data-action="tcoll"', 'fold', 'Collapse all')}
  </div>
  <input type="file" id="fpick" multiple hidden>
  <input type="file" id="dpick" webkitdirectory hidden>
  <div id="uppanel" class="uppanel" hidden>
    <div id="upmsg"></div>
    <div class="upbar"><div id="upfill"></div></div>
    <div id="uperr" class="uperr"></div>
  </div>
  <div class="sec" id="treesec">files</div>
  <div id="treelist"></div>
</aside>`;
      treeList = $('treelist');
      treeKeys(treeList, 'Files');
    }
  });
  // page-dump, not page-tree: it returns the same nodes PLUS every page's body
  // inline from ONE deep peek, and measures FASTER than page-tree (which
  // re-peeks each code grub). Those bodies are what make opening a page cost
  // zero requests. See openPage. Bodies over 256KB are omitted by the server.
  // Such a node has no `body` and falls back to the per-page fetch.
  // ponytail: whole-store payload (~55KB today). If the tree ever grows past
  // a megabyte, page it or go back to page-tree plus a lazy body cache.
  // the beacon rev the last applied dump was fetched at (see revFresh)
  let treeAt = '';
  // whether `nodes` carries each page's share mode: a dump with a `since`
  // token does (a share-less node is private). A tree an older ship sent,
  // or one restored from before it did, does not, and absent there means
  // unknown, not private.
  let treeShares = false;
  async function loadTree() {
    const gen = treeGen;
    const at = lastRev;
    let d = null;
    // this one RESOLVES, always. Boot chains its whole reconcile off it
    // (99-boot.js) with no .catch, so a rejection here would silently cancel
    // loadPanels, the open/reconcile branch and legacyCheck, and show nothing.
    // A dead pier is a reportable condition, the way openPage and loadPerms
    // already report theirs. Offline is a state this app is built for.
    try {
      const r = await fetch(api + '/page-dump');
      if (!r.ok) {
        if (await sessionGone(r)) return;
        st('tree failed' + await errText(r), false); return;
      }
      d = await r.json();
    } catch { st('tree failed (network)', false); return; }
    if (gen !== treeGen) return;   // a local patch superseded this response
    // the dump's beacon rev is the baseline for a FIRST-EVER session: the
    // stream only reports from registration onward, and with nothing
    // remembered the registration comparison had nothing to catch a bump
    // that landed between this snapshot and that registration. Never
    // overwrite a stream-observed rev — the snapshot may already trail it.
    //
    // From `since`, the token string, never `rev`: that is a JSON number near
    // 1.7e38, which JSON.parse rounds, so String(d.rev) read
    // "1.701411845081946e+38" against the stream's exact digits. They never
    // matched, and every first session refetched the whole dump once the
    // stream registered.
    if (!lastRev && typeof d.since === 'string') noteRev(d.since);
    nodes = d.nodes;
    treeShares = typeof d.since === 'string';
    treeAt = at;
    // drop only the cached renders the dump says have moved FORWARD. Blanket-
    // clearing on every change cost every other page its cache. Comparing
    // for mere inequality evicted good entries whenever the dump trailed
    // page-source by a revision, which it does right after a write (the
    // evaluator settles after the writer).
    for (const [name, c] of pageCache) {
      const n = nodes.find((x) => x.page && x.path === name);
      if (!n || (typeof n.rev === 'number' && n.rev > c.rev)) pageCache.delete(name);
    }
    snapTree();
    // always: #treelist holds only the files tree (the memory tree has its
    // own #knowlist), so a memory tab in front is no reason to leave Files
    // stale behind the Knowledge tab
    renderTree();
  }

  // selection changes only move the `cur` class. Never rebuild the pane's DOM
  // for that. rowByPath is rebuilt by renderTree, knowRows by renderKnowTree
  // (95-know.js). `current` names a page or a memory by the mode, so each
  // tree marks it only in its own mode.
  let rowByPath = new Map();
  let knowRows = new Map();
  function markCurrent() {
    for (const [p, row] of rowByPath)
      row.classList.toggle('cur', row.classList.contains('pg')
        ? mode !== 'know' && p === current : p === curFolder);
    for (const [k, row] of knowRows) row.classList.toggle('cur', mode === 'know' && k === current);
    paintLink();
  }

  // ── links: another ship's page in this tree ─────────────────────────────
  // A node with `link` is a link the owner made from shared with me. It
  // opens as a page tab: page-source and page-save go through it to the
  // host, conflict-checked. linkOf names the open link, or null.
  function linkOf(name) {
    const n = name ? nodes.find((x) => x.page && x.path === name) : null;
    return n && n.link && n.link.host ? n.link : null;
  }
  // where a link points, as ~host/<their page>. The path names the page's
  // code grub under wherever lattice is installed there, so only the tail
  // is read (the same rule as sharedName, 69-shared.js).
  function linkFrom(lk) {
    const m = /\/page\/(.+)\/code$/.exec(lk.path || '');
    return lk.host + '/' + (m ? m[1] : String(lk.path || '').replace(/^\/+/, ''));
  }
  // @da (ship UTC) in the viewer's own zone, as the history list shows it
  function daLocal(da) {
    const m = /^~(\d+)\.(\d+)\.(\d+)\.\.(\d+)\.(\d+)\.(\d+)/.exec(da || '');
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toLocaleString(undefined,
      { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  }
  // the badge for a link whose last read failed: {copy, since}, or null.
  // The owner's ship cannot tell a revoke from being offline, so it says
  // both. `at` is when a read first failed, which the ship keeps as is
  // while reads go on failing.
  function linkBadge(lk) {
    if (!lk.seen || lk.seen.ok !== false) return null;
    const at = daLocal(lk.seen.at);
    return { copy: lk.host + ' unreachable or no longer sharing', since: at ? 'since ' + at : '' };
  }
  // the badge as a tree row shows it, on a line of its own under the name
  function linkBadgeEl(bad) {
    const w = document.createElement('span');
    w.className = 'lbadw';
    const b = document.createElement('span');
    b.className = 'lbad';
    b.textContent = bad.copy;
    w.append(b);
    if (bad.since) {
      const s = document.createElement('span');
      s.className = 'lbsince';
      s.textContent = bad.since;
      w.append(' ', s);
    }
    return w;
  }
  // the links this editor must not write to just now: a conflicted one
  // (35-pages.js, its save was refused as stale) and a stale one (its open
  // fell back on the last-known copy). A read grant is locked always.
  const linkCf = new Set();
  const linkStale = new Set();
  function linkRO(name) {
    const lk = linkOf(name);
    return !!lk && (lk.mode === 'read' || linkStale.has(name));
  }
  // what a live read through a link just found. The ship records it too
  // (the badge survives a reload); this repaints without waiting for that.
  function linkSeen(name, ok) {
    const lk = linkOf(name);
    if (!lk || !lk.seen || lk.seen.ok === ok) return;
    const t = new Date();
    const p = (v) => String(v).padStart(2, '0');
    lk.seen = { ok, at: '~' + t.getUTCFullYear() + '.' + (t.getUTCMonth() + 1) + '.' + t.getUTCDate()
      + '..' + p(t.getUTCHours()) + '.' + p(t.getUTCMinutes()) + '.' + p(t.getUTCSeconds()) };
    snapTree();
    renderTree();
  }

  // local `nodes` patching: this client performed the write, so it already
  // knows the outcome. Applying it locally replaces a page-tree refetch.
  const hasNode = (path) => nodes.some((n) => n.path === path);
  function addFolderNodes(path) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!hasNode(dir)) nodes.push({ path: dir, page: false });
    }
  }
  function addTreeNode(name, kind, pending) {
    if (name.includes('/')) addFolderNodes(name.slice(0, name.lastIndexOf('/')));
    const n = nodes.find((x) => x.path === name && x.page);
    if (n) { n.kind = kind; if (pending !== undefined) n.pending = pending; }
    else nodes.push({ path: name, page: true, kind, share: 'private', pending: !!pending });
  }
  // the display name of a page or folder node ('' clears it). Mirrors the
  // `dname` the ship sends in page-dump, so a local patch matches a refetch.
  function setNodeDname(path, dname) {
    const n = nodes.find((x) => x.path === path);
    if (!n) return;
    if (dname) n.dname = dname; else delete n.dname;
  }
  // apply a realName() split to the local tree: the leaf follows rn.dname
  // ('' clears, the way a rename to a valid name does on the ship); a parent
  // folder is only ever SET, never cleared, because an existing folder keeps
  // its own name when something is made inside it under the plain slug.
  function applyDnames(rn) {
    if (!rn) return;
    const segs = rn.name.split('/');
    const per = rn.dnames ? rn.dnames.split('/') : [];
    for (let i = 0; i + 1 < segs.length; i++)
      if (per[i]) setNodeDname(segs.slice(0, i + 1).join('/'), per[i]);
    setNodeDname(rn.name, rn.dname);
  }
  //  A node added before the ship has confirmed it. The row pulses until the
  //  write lands, so the tree can answer instantly without claiming something
  //  that has not happened yet. Clearing it is the success signal; dropping
  //  the node is the failure one.
  function setTreePending(name, pending) {
    const n = nodes.find((x) => x.path === name && x.page);
    if (!n) return;
    if (pending) n.pending = true; else delete n.pending;
    renderTree();
  }
  function dropTreeNodes(path) {
    nodes = nodes.filter((n) => n.path !== path && !n.path.startsWith(path + '/'));
  }

  // one folder row, the same in all three trees (files, shared with me,
  // memories): the fold arrow, then the folder icon (open when unfolded)
  // and its label, both inside the label span, indented
  // by depth. `fold` folds or unfolds it and repaints. A click anywhere on
  // the row folds, unless the row has a `pick` of its own (the files tree
  // selects the folder): then the row picks and only the arrow folds.
  // `key`, in a tree that treeKeys drives, makes the row one of its items.
  function folderRow(label, depth, folded, fold, pick, key) {
    const row = document.createElement('div');
    row.className = 'fld';
    row.style.marginLeft = (depth * 14) + 'px';
    if (key !== undefined) {
      treeItem(row, depth, key);
      row.setAttribute('aria-expanded', folded ? 'false' : 'true');
      row.latFold = fold;
    }
    const cx = document.createElement('span');
    cx.className = 'cx';
    cx.textContent = folded ? '▸' : '▾';
    const lb = document.createElement('span');
    lb.className = 'fln';
    lb.innerHTML = ico(folded ? 'folder' : 'open');
    lb.append(label);
    row.append(cx, lb);
    if (pick) {
      cx.onclick = (e) => { e.stopPropagation(); fold(); };
      row.onclick = pick;
    } else row.onclick = fold;
    return row;
  }

  // ── keyboard: the files and memory trees as ARIA trees ──────────────────
  // The rows are flat siblings indented by depth, so the shape is read from
  // aria-level: a folder's children are the shown rows after it with a
  // deeper level, and its parent the nearest shown row before it with a
  // shallower one. One row at a time is in the tab order (roving tabindex).
  // Enter is the row's own click, with Ctrl/Cmd carried, so a page opens
  // through openIn (tabLink) and Ctrl+Enter gives it a new tab.
  // treeItem marks up one row. `key` names it across a repaint: a fold
  // rebuilds the whole list, and the focus has to land on the same row.
  function treeItem(row, depth, key) {
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', depth + 1);
    row.tabIndex = -1;
    row.dataset.tk = key;
    return row;
  }
  const treeRows = (list) => [...list.querySelectorAll('[role=treeitem]')]
    .filter((r) => r.style.display !== 'none');
  // after a paint: the row last focused, else the open one, else the first,
  // is the one Tab reaches. `refocus` when the focus was in the list before
  // the paint took its rows away.
  // A list with no rows (loading, or an empty-state note) is not a tree:
  // a tree has to own treeitems, so the role comes and goes with them.
  function treeRove(list, refocus) {
    const rows = treeRows(list);
    if (rows.length) list.setAttribute('role', 'tree'); else list.removeAttribute('role');
    const to = rows.find((r) => r.dataset.tk === list.latKey)
      || rows.find((r) => r.classList.contains('cur')) || rows[0];
    if (!to) return;
    to.tabIndex = 0;
    if (refocus) to.focus();
  }
  function treeKeys(list, label) {
    list.setAttribute('aria-label', label);
    const lv = (r) => +r.getAttribute('aria-level');
    list.addEventListener('focusin', (e) => {
      const row = e.target.closest('[role=treeitem]');
      if (!row) return;
      for (const r of list.querySelectorAll('[role=treeitem][tabindex="0"]')) r.tabIndex = -1;
      row.tabIndex = 0;
      list.latKey = row.dataset.tk;
    });
    list.addEventListener('keydown', (e) => {
      const row = e.target.closest('[role=treeitem]');
      if (!row || e.altKey) return;
      const rows = treeRows(list);
      const i = rows.indexOf(row);
      const open = row.getAttribute('aria-expanded');
      const mod = e.ctrlKey || e.metaKey;
      let to = null;
      if (e.key === 'Enter') {
        // on a control inside the row (a folder's +), that control acts
        const hit = e.target !== row && e.target.closest('a, button') ? e.target : row;
        hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true,
          ctrlKey: e.ctrlKey, metaKey: e.metaKey }));
      } else if (mod || (e.shiftKey && e.key.length > 1)) return;
      else if (e.key === 'ArrowDown') to = rows[i + 1];
      else if (e.key === 'ArrowUp') to = rows[i - 1];
      else if (e.key === 'Home') to = rows[0];
      else if (e.key === 'End') to = rows[rows.length - 1];
      // a fold repaints, and treeRove puts the focus back on this row
      else if (e.key === 'ArrowRight') {
        if (open === 'false') row.latFold();
        else if (open === 'true' && rows[i + 1] && lv(rows[i + 1]) > lv(row)) to = rows[i + 1];
      } else if (e.key === 'ArrowLeft') {
        if (open === 'true') row.latFold();
        else for (let j = i - 1; j >= 0 && !to; j--) if (lv(rows[j]) < lv(row)) to = rows[j];
      } else if (e.key.length === 1 && e.key !== ' ') {
        // type-ahead: the next row whose name starts with the letter. A
        // folder's name is its label, not the fold arrow ahead of it.
        const k = e.key.toLowerCase();
        const name = (r) => (r.querySelector('.fln') || r).textContent.trim().toLowerCase();
        for (let n = 1; n <= rows.length && !to; n++) {
          const r = rows[(i + n) % rows.length];
          if (name(r).startsWith(k)) to = r;
        }
      } else return;
      e.preventDefault();
      if (to) to.focus();
    });
  }
  // Alt+1: the Files tab (the pane opened if shut), its tree focused, the
  // first of the left pane's tabs. By e.code, since Option+1 on a Mac
  // types a character, and so in a text field there it is left to type.
  // Not while a dialog or the palette is up: focus behind a modal is lost.
  // Registered on the Files tab's own action (13-frame.js), so the tab's
  // tooltip and the palette both show it.
  function treeFocus() {
    treeRove(treeList, false);
    const r = treeList.querySelector('[role=treeitem][tabindex="0"]');
    if (r) r.focus();
  }
  addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'Digit1'
      && !(e.key !== '1' && e.target.closest && e.target.closest('input, textarea, select, [contenteditable]'))
      && !document.querySelector('.dlg:not([hidden])')) {
      e.preventDefault();
      e.stopPropagation();
      ACTIONS.find((a) => a.id === 'pt-files').run();
    }
  }, true);

  // ── sort order and collapse all ─────────────────────────────────────────
  // Siblings sort by name, folders first, ascending or descending
  // (localStorage.appSort). The order is per level, so a folder's pages stay
  // under it whichever way its siblings run.
  const SORTS = { name: 'Sort: name', 'name-desc': 'Sort: name, descending' };
  const treeSort = () => (localStorage.appSort === 'name-desc' ? 'name-desc' : 'name');
  function treeOrder(list) {
    const dir = treeSort() === 'name-desc' ? -1 : 1;
    return list.map((n) => ({ n, s: n.path.split('/') })).sort((a, b) => {
      const m = Math.min(a.s.length, b.s.length);
      for (let i = 0; i < m; i++) {
        if (a.s[i] === b.s[i]) continue;
        const fa = i < a.s.length - 1 || !a.n.page;
        const fb = i < b.s.length - 1 || !b.n.page;
        if (fa !== fb) return fa ? -1 : 1;
        return dir * a.s[i].localeCompare(b.s[i]);
      }
      return (a.s.length - b.s.length) || (a.n.page - b.n.page);
    }).map((x) => x.n);
  }
  const paintSort = () => tip($('tsort'), SORTS[treeSort()]);
  paintSort();
  $('tsort').onclick = () => {
    try { localStorage.appSort = treeSort() === 'name' ? 'name-desc' : 'name'; } catch {}
    paintSort();
    renderTree();
  };
  $('tcoll').onclick = () => {
    paneColl.set([...new Set([...paneColl.get(),
      ...nodes.filter((n) => !n.page).map((n) => n.path)])]);
    renderTree();
  };
  // the toolbar's palette actions. The create and upload buttons are wired
  // in 45-templates.js and 70-upload.js; a click reaches those handlers.
  for (const [id, name] of [['newfile', 'New page'], ['newfolder', 'New folder'],
    ['newtmpl', 'New from template'], ['upfiles', 'Upload files'], ['updir', 'Upload a folder'],
    ['tsort', 'Flip sort order'], ['tcoll', 'Collapse all folders']])
    clickAction(id, name, 'Files toolbar');

  function renderTree() {
    const coll = paneColl.get();
    const byPath = treeOrder(nodes);
    const had = treeList.contains(document.activeElement);
    treeList.textContent = '';
    rowByPath = new Map();
    for (const n of byPath) {
      const depth = n.path.split('/').length - 1;
      const hidden = coll.some((c) => n.path === c ? false : n.path.startsWith(c + '/'));
      let row;
      if (n.page) {
        row = document.createElement('a');
        row.style.marginLeft = (depth * 14) + 'px';
        const lk = n.link && n.link.host ? n.link : null;
        row.className = 'pg' + (lk ? ' lnk' : '') + (mode !== 'know' && n.path === current ? ' cur' : '')
          + (n.pending ? ' pend' : '');
        row.href = '/apps/lattice/app?name=' + encodeURIComponent(n.path);
        // the display name when there is one (a typed name that was not a
        // valid path), the path segment otherwise; the real path in the tip
        row.innerHTML = ico(lk ? 'link' : kindExt(n.kind));
        row.append(document.createTextNode((n.dname || n.path.split('/').pop()) + '.' + kindExt(n.kind)));
        if (n.dname) row.title = n.path;
        // a link to another ship's page: whose it is on hover, and the
        // badge once a read through it has failed
        if (lk) {
          row.dataset.host = lk.host;
          row.dataset.path = n.path;
          row.title = linkFrom(lk);
          const bad = linkBadge(lk);
          if (bad) row.append(linkBadgeEl(bad));
        }
        treeItem(row, depth, 'p:' + n.path);
        if (n.share === 'clearweb') {
          const cw = document.createElement('span');
          cw.className = 'cw';
          cw.textContent = '\u{1F310}';
          cw.title = n.path + ' is clearweb public';
          row.append(cw);
        }
        tabLink(row, 'page', n.path);
      } else {
        row = folderRow(n.dname || n.path.split('/').pop(), depth, coll.includes(n.path),
          () => { paneColl.flip(n.path); renderTree(); }, () => pickFolder(n.path), 'f:' + n.path);
        linkDrop(row, n.path);       // a shared-with-me row dropped here (69-shared.js)
        if (n.path === curFolder) row.classList.add('cur');
        if (n.dname) row.lastChild.title = n.path;     // the label's tip
        if (treeShare(n.path) === 'clearweb') {
          const cw = document.createElement('span');
          cw.className = 'cw';
          cw.textContent = '\u{1F310}';
          cw.title = n.path + ' is clearweb public';
          row.append(cw);
        }
        const add = document.createElement('a');
        add.className = 'addf';
        add.textContent = '+';
        add.title = 'new file in ' + n.path;
        add.href = '#';
        add.tabIndex = -1;          // the tree is one tab stop; New page does this
        add.onclick = async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (await guardDirty()) newFile(n.path);
        };
        row.append(add);
      }
      if (hidden) row.style.display = 'none';
      rowByPath.set(n.path, row);
      treeList.appendChild(row);
    }
    if (sharedWithMe.length) renderShared(coll);
    treeRove(treeList, had);
    paintLink();                 // the Page tab's link section (65-ctl.js)
    // the Published pages list (72-acl.js) reads these share modes
    const aw = $('aclwrap');
    if (aw && !aw.hidden) renderPublished();
    // the conflict badge is a count of conflicts/ pages in this very tree, so
    // it repaints exactly when the tree does. Defined in 80-conflicts.js.
    renderConfBadge();
  }

  // ── folder selection ─────────────────────────────────────────────────────
  // A folder's share state is derived from its pages: uniform → that mode,
  // differing → 'mixed', empty → 'private'.
  const treeShare = (path) => {
    const pages = nodes.filter((n) => n.page && n.path.startsWith(path + '/'));
    if (!pages.length) return 'private';
    const s = pages[0].share || 'private';
    return pages.every((p) => (p.share || 'private') === s) ? s : 'mixed';
  };

  const pageCount = (path) =>
    nodes.filter((n) => n.page && n.path.startsWith(path + '/')).length;

  const setCtlLabels = () => {
    const t = mode === 'know' ? 'memory' : curFolder ? 'folder' : 'page';
    $('del').textContent = 'delete ' + t;
    $('mv').textContent = t === 'page' ? 'move / rename' : 'move / rename ' + t;
  };

  // a folder picked by the user: it paints over the editor, so it gets a
  // document tab if a tool is in front, and what is unsaved there goes
  // through guardDirty first, like any other way off a document
  async function pickFolder(path) {
    if (!(await docTab()) || !(await guardDirty())) return;
    dirty = false;
    clearTimeout(autoTimer);
    selectFolder(path);
  }
  function selectFolder(path) {
    curFolder = path;
    curKind = null;
    exitGrub();
    exitRev();
    folderCtx = path;
    setOpen(null, { shown: path, readOnly: true,
      url: '/apps/lattice/app?into=' + encodeURIComponent(path) });
    src.value = '';
    render();
    prevBlank();
    cerr.textContent = ' '; cerr.className = 'ok';
    markCurrent();
    setCtlLabels();
    showShare(treeShare(path));
    const c = pageCount(path);
    st('folder · ' + c + ' page' + (c === 1 ? '' : 's'));
  }
