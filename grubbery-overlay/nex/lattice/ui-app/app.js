// lattice app — M2: editor core (tree, Prism editor, save).
(function () {
  const $ = (id) => document.getElementById(id);
  const api = '/apps/lattice';
  const pname = $('pname'), pkind = $('pkind'), status = $('status');
  const src = $('src'), hl = $('hl'), treeList = $('treelist');
  const prev = $('prev'), cerr = $('cerr'), cwurl = $('cwurl');

  const st = (msg, ok = true) => {
    status.textContent = msg;
    status.style.color = ok ? '' : '#c0392b';
  };

  // ── state ────────────────────────────────────────────────────────────────
  let current = null;      // name of the open page, null = unsaved new page
  let nodes = [];          // last page-tree
  const qs = new URLSearchParams(location.search);

  const collapsed = () => {
    try { return JSON.parse(localStorage.appColl || '[]'); } catch { return []; }
  };
  const setCollapsed = (c) => { localStorage.appColl = JSON.stringify(c); };

  // ── highlighting (Prism overlay) ─────────────────────────────────────────
  const LMAP = { md: 'markdown', gmi: 'gemtext', html: 'markup',
                 js: 'javascript', css: 'css', hoon: 'hoon' };
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const render = () => {
    const lang = LMAP[pkind.value];
    const g = window.Prism && lang && Prism.languages[lang];
    hl.innerHTML = (g ? Prism.highlight(src.value, g, lang) : esc(src.value)) + '\n';
  };
  const sync = () => { hl.scrollTop = src.scrollTop; hl.scrollLeft = src.scrollLeft; };
  src.addEventListener('input', render);
  src.addEventListener('scroll', sync);
  pkind.addEventListener('change', render);

  // ── tree ─────────────────────────────────────────────────────────────────
  async function loadTree() {
    const r = await fetch(api + '/page-tree');
    if (!r.ok) { st('tree failed ' + r.status, false); return; }
    nodes = (await r.json()).nodes;
    renderTree();
  }

  function renderTree() {
    const coll = collapsed();
    const byPath = [...nodes].sort((a, b) => a.path.localeCompare(b.path));
    treeList.textContent = '';
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
        row.className = 'fld';
        const cx = document.createElement('span');
        cx.className = 'cx';
        cx.textContent = coll.includes(n.path) ? '▸' : '▾';
        const label = document.createElement('span');
        label.textContent = '\u{1F4C1} ' + n.path.split('/').pop();
        const add = document.createElement('a');
        add.className = 'addf';
        add.textContent = '+';
        add.title = 'new file in ' + n.path;
        add.href = '#';
        add.onclick = (e) => { e.preventDefault(); e.stopPropagation(); newFile(n.path); };
        row.append(cx, label, add);
        row.onclick = () => {
          const c = collapsed();
          const i = c.indexOf(n.path);
          if (i >= 0) c.splice(i, 1); else c.push(n.path);
          setCollapsed(c);
          renderTree();
        };
      }
      treeList.appendChild(row);
    }
  }

  const extOf = (kind) => ({ md: 'md', gmi: 'gmi', html: 'html', text: 'txt',
                             js: 'js', css: 'css', index: 'md' }[kind] || 'hoon');

  // ── open / new / save ────────────────────────────────────────────────────
  async function openPage(name) {
    const r = await fetch(api + '/page-source?name=' + encodeURIComponent(name));
    if (!r.ok) { st('open failed ' + r.status, false); return; }
    const d = await r.json();
    current = name;
    pname.value = name;
    pname.readOnly = true;
    if (LMAP[d.kind] || d.kind === 'text') pkind.value = d.kind === 'text' ? 'text' : d.kind;
    src.value = d.body;
    render(); sync();
    history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
    renderTree();
    st(d.kind + ' · rev ' + d.rev);
    showShare(d.share || 'private');
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
    refreshPreview();
    if (!CONTENT()) checkErrors();
  }

  function newFile(into) {
    current = null;
    pname.readOnly = false;
    pname.value = into ? into + '/' : '';
    src.value = '';
    render();
    history.replaceState(null, '', '/apps/lattice/app');
    renderTree();
    pname.focus();
    st('new page — name it, write, save');
    prev.removeAttribute('srcdoc'); prev.src = 'about:blank';
    showShare('private');
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
  }

  async function newFolder() {
    const name = prompt('folder name (e.g. notes or notes/sub)');
    if (!name) return;
    const r = await fetch(api + '/folder-new?name=' + encodeURIComponent(name), { method: 'POST' });
    if (!r.ok) { st('folder failed ' + r.status, false); return; }
    st('folder created');
    loadTree();
  }

  async function save() {
    const name = pname.value.trim().replace(/^\/+|\/+$/g, '');
    if (!name) { st('name required', false); return; }
    const creating = current === null;
    st('saving…');
    const url = api + '/page-save?name=' + encodeURIComponent(name) +
      '&type=' + pkind.value + (creating ? '&new=1' : '');
    const r = await fetch(url, { method: 'POST', body: src.value });
    if (r.status === 409) { st('that page already exists', false); return; }
    if (!r.ok) { st('save failed ' + r.status, false); return; }
    current = name;
    pname.readOnly = true;
    st(CONTENT() ? 'saved' : 'compiling\u2026');
    history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
    loadTree();
    if (CONTENT()) { refreshPreview(); cerr.textContent = 'saved'; cerr.className = 'ok'; }
    else { setTimeout(checkErrors, 800); setTimeout(checkErrors, 2200); }
  }

  $('save').onclick = save;
  $('newfile').onclick = () => newFile('');
  $('newfolder').onclick = newFolder;
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
  });
  src.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = src.selectionStart;
      src.value = src.value.slice(0, s) + '  ' + src.value.slice(src.selectionEnd);
      src.selectionStart = src.selectionEnd = s + 2;
      render();
    }
  });

  // ── preview ──────────────────────────────────────────────────────────────
  // Content kinds render through page-preview (srcdoc); computed kinds (hoon,
  // js, css) show the page's live DATA via /f/<name>, refreshed after save/cmd.
  const CONTENT = () => ['md', 'gmi', 'html', 'text'].includes(pkind.value);
  let prevTimer = null;
  async function refreshPreview() {
    if (CONTENT()) {
      try {
        const r = await fetch(api + '/page-preview?type=' + pkind.value,
          { method: 'POST', body: src.value });
        if (r.ok) prev.srcdoc = await r.text();
      } catch {}
    } else if (current) {
      prev.removeAttribute('srcdoc');
      prev.src = api + '/f/' + current + '?t=' + Date.now();
    }
  }
  src.addEventListener('input', () => {
    if (!CONTENT()) return;
    clearTimeout(prevTimer);
    prevTimer = setTimeout(refreshPreview, 400);
  });

  // ── compile errors (hoon pages) ──────────────────────────────────────────
  async function checkErrors() {
    if (!current) return;
    let t = '';
    try { t = await (await fetch(api + '/page-errors?name=' + encodeURIComponent(current))).text(); } catch {}
    if (t.trim()) {
      cerr.textContent = t;
      cerr.className = 'err';
      st('error', false);
    } else {
      cerr.textContent = CONTENT() ? 'saved' : 'compiled ok';
      cerr.className = 'ok';
      refreshPreview();
    }
  }

  // ── sharing ──────────────────────────────────────────────────────────────
  function showShare(mode) {
    for (const b of document.querySelectorAll('.share button'))
      b.className = b.dataset.m === mode ? 'on' : '';
    cwurl.innerHTML = mode === 'clearweb' && current
      ? 'public: <a href="' + api + '/c/' + current + '" target="_blank">/c/' + current + '</a>'
      : '';
  }
  for (const b of document.querySelectorAll('.share button')) {
    b.onclick = async () => {
      if (!current) { st('save the page first', false); return; }
      const r = await fetch(api + '/page-share?name=' + encodeURIComponent(current) +
        '&mode=' + b.dataset.m, { method: 'POST' });
      if (!r.ok) { st('share failed ' + r.status, false); return; }
      showShare(b.dataset.m);
      st('sharing: ' + b.dataset.m);
    };
  }

  // ── command box ──────────────────────────────────────────────────────────
  async function sendCmd() {
    const c = $('cmd').value;
    if (!c || !current) return;
    await fetch(api + '/page-cmd?name=' + encodeURIComponent(current),
      { method: 'POST', body: 'cmd=' + encodeURIComponent(c) });
    $('cmd').value = '';
    setTimeout(refreshPreview, 600);
  }
  $('csend').onclick = sendCmd;
  $('cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCmd(); });

  // ── delete ───────────────────────────────────────────────────────────────
  $('del').onclick = async () => {
    if (!current) { st('nothing to delete', false); return; }
    if (!confirm('delete ' + current + '?')) return;
    const r = await fetch(api + '/page-del?name=' + encodeURIComponent(current), { method: 'POST' });
    if (!r.ok) { st('delete failed ' + r.status, false); return; }
    newFile('');
    loadTree();
    st('deleted');
  };

  // ── boot ─────────────────────────────────────────────────────────────────
  loadTree().then(() => {
    const name = qs.get('name');
    const into = qs.get('into');
    if (name) openPage(name);
    else if (into) newFile(into);
    else newFile('');
  });
})();
