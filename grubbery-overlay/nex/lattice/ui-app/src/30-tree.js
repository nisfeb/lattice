  // ── tree pane: <lat-tree> ────────────────────────────────────────────────
  // The pane's buttons are wired where their handlers live (45-templates,
  // 70-upload). Those files run after this component upgrades, so their
  // $-lookups find the rendered elements.
  let treeList;
  customElements.define('lat-tree', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<aside class="tree" id="tree">
  <div class="newbtns">
    <button class="nf" id="newfile">+ file</button>
    <button class="nf" id="newfolder">+ folder</button>
    <button class="nf" id="newtmpl">+ template</button>
  </div>
  <div class="newbtns">
    <button class="nf" id="upfiles">&#8613; files</button>
    <button class="nf" id="updir">&#8613; dir</button>
  </div>
  <input type="file" id="fpick" multiple hidden>
  <input type="file" id="dpick" webkitdirectory hidden>
  <input type="file" id="vpick" accept=".tar,application/x-tar" hidden>
  <div id="uppanel" class="uppanel" hidden>
    <div id="upmsg"></div>
    <div class="upbar"><div id="upfill"></div></div>
    <div id="uperr" class="uperr"></div>
  </div>
  <div id="chips" class="chips" hidden></div>
  <div class="sec" id="treesec">files</div>
  <div id="treelist"></div>
</aside>`;
      treeList = $('treelist');
    }
  });
  // stale-shell guard: swap a cached pre-component shell's literal pane
  if (!document.querySelector('lat-tree')) {
    const stale = document.getElementById('tree');
    if (stale) stale.remove();
    const el = document.createElement('lat-tree');
    el.style.display = 'contents';
    document.getElementById('ws').appendChild(el);
  }
  // page-dump, not page-tree: it returns the same nodes PLUS every page's body
  // inline from ONE deep peek, and measures FASTER than page-tree (which
  // re-peeks each code grub). Those bodies are what make opening a page cost
  // zero requests. See openPage. Bodies over 256KB are omitted by the server.
  // Such a node has no `body` and falls back to the per-page fetch.
  // ponytail: whole-store payload (~55KB today). If the tree ever grows past
  // a megabyte, page it or go back to page-tree plus a lazy body cache.
  async function loadTree() {
    const gen = treeGen;
    const r = await fetch(api + '/page-dump');
    if (!r.ok) { st('tree failed ' + r.status, false); return; }
    const d = await r.json();
    if (gen !== treeGen) return;   // a local patch superseded this response
    // the dump's beacon rev is the baseline for a FIRST-EVER session: the
    // stream only reports from registration onward, and with nothing
    // remembered the registration comparison had nothing to catch a bump
    // that landed between this snapshot and that registration. Never
    // overwrite a stream-observed rev — the snapshot may already trail it.
    if (!lastRev && d.rev != null) noteRev(String(d.rev));
    nodes = d.nodes;
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
    renderTree();
  }

  // selection changes only move the `cur` class. Never rebuild the pane's DOM
  // for that. rowByPath is rebuilt by renderTree/renderKnowTree.
  let rowByPath = new Map();
  function markCurrent() {
    for (const [p, row] of rowByPath)
      row.classList.toggle('cur',
        row.classList.contains('pg') ? p === current : p === curFolder);
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
  function addTreeNode(name, kind) {
    if (name.includes('/')) addFolderNodes(name.slice(0, name.lastIndexOf('/')));
    const n = nodes.find((x) => x.path === name && x.page);
    if (n) n.kind = kind;
    else nodes.push({ path: name, page: true, kind, share: 'private' });
  }
  function dropTreeNodes(path) {
    nodes = nodes.filter((n) => n.path !== path && !n.path.startsWith(path + '/'));
  }

  function renderTree() {
    const coll = collapsed();
    const byPath = [...nodes].sort((a, b) => a.path.localeCompare(b.path));
    treeList.textContent = '';
    rowByPath = new Map();
    for (const n of byPath) {
      const depth = n.path.split('/').length - 1;
      const parent = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
      const hidden = coll.some((c) => n.path === c ? false : n.path.startsWith(c + '/'));
      const row = document.createElement(n.page ? 'a' : 'div');
      row.style.marginLeft = (depth * 14) + 'px';
      if (hidden) row.style.display = 'none';
      if (n.page) {
        row.className = 'pg' + (n.path === current ? ' cur' : '');
        row.href = '/apps/lattice/app?name=' + encodeURIComponent(n.path);
        row.textContent = n.path.split('/').pop() + '.' + extOf(n.kind);
        row.onclick = (e) => { e.preventDefault(); openPage(n.path); };
      } else {
        row.className = 'fld' + (n.path === curFolder ? ' cur' : '');
        const cx = document.createElement('span');
        cx.className = 'cx';
        cx.textContent = coll.includes(n.path) ? '▸' : '▾';
        cx.onclick = (e) => {
          e.stopPropagation();
          const c = collapsed();
          const i = c.indexOf(n.path);
          if (i >= 0) c.splice(i, 1); else c.push(n.path);
          setCollapsed(c);
          renderTree();
        };
        const label = document.createElement('span');
        label.textContent = '\u{1F4C1} ' + n.path.split('/').pop();
        row.append(cx, label);
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
        add.onclick = (e) => { e.preventDefault(); e.stopPropagation(); newFile(n.path); };
        row.append(add);
        row.onclick = () => selectFolder(n.path);
      }
      rowByPath.set(n.path, row);
      treeList.appendChild(row);
    }
    // the conflict badge is a count of conflicts/ pages in this very tree, so
    // it repaints exactly when the tree does. Defined in 80-conflicts.js.
    if (typeof renderConfBadge === 'function') renderConfBadge();
  }

  const extOf = (kind) => ({ md: 'md', gmi: 'gmi', html: 'html', text: 'txt',
                             js: 'js', css: 'css', index: 'md' }[kind] || 'hoon');

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

  function selectFolder(path) {
    current = null;
    curFolder = path;
    curKind = null;
    exitRev();
    $('histsec').hidden = true;
    $('linksec').hidden = true;
    folderCtx = path;
    pname.value = path;
    pname.readOnly = true;
    src.value = '';
    render();
    prevBlank();
    cerr.textContent = ' '; cerr.className = 'ok';
    history.replaceState(null, '', '/apps/lattice/app?into=' + encodeURIComponent(path));
    markCurrent();
    setCtlLabels();
    showShare(treeShare(path));
    const c = pageCount(path);
    st('folder · ' + c + ' page' + (c === 1 ? '' : 's'));
  }
