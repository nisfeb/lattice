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
  let folderCtx = '';      // folder uploads land in (last into / open page's dir)
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
        const mvf = document.createElement('a');
        mvf.className = 'mvf';
        mvf.textContent = '\u270e';
        mvf.title = 'move / rename ' + n.path;
        mvf.href = '#';
        mvf.onclick = (e) => { e.preventDefault(); e.stopPropagation(); moveFolder(n.path); };
        row.append(cx, label, mvf, add);
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
  const setFolderCtx = (name) =>
    { folderCtx = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''; };

  async function openPage(name) {
    setFolderCtx(name);
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
    folderCtx = into || '';
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

  $('save').onclick = () => (mode === 'know' ? saveKnow() : save());
  $('newfile').onclick = () => newFile('');
  $('newfolder').onclick = newFolder;
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (mode === 'know') saveKnow(); else save();
    }
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
    if (mode === 'know') { deleteKnow(); return; }
    if (!current) { st('nothing to delete', false); return; }
    if (!confirm('delete ' + current + '?')) return;
    const r = await fetch(api + '/page-del?name=' + encodeURIComponent(current), { method: 'POST' });
    if (!r.ok) { st('delete failed ' + r.status, false); return; }
    newFile('');
    loadTree();
    st('deleted');
  };

  // ── upload (pickers + drag-and-drop, progress panel) ─────────────────────
  const KMAP = { md: 'md', gmi: 'gmi', html: 'html', htm: 'html', txt: 'text',
                 js: 'js', css: 'css', hoon: 'hoon' };
  const seg = (x) => x.toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const upPanel = $('uppanel'), upMsg = $('upmsg'), upFill = $('upfill'), upErr = $('uperr');

  const upShow = () => { upPanel.hidden = false; upErr.textContent = ''; upFill.style.width = '0%'; };
  const upProg = (done, total, name) => {
    upMsg.textContent = `uploading ${done}/${total}${name ? ': ' + name : ''}`;
    upFill.style.width = Math.round(done * 100 / Math.max(total, 1)) + '%';
  };

  async function uploadItems(items) {
    const list = [];
    const dirs = new Set();
    let skipped = 0;
    for (const { file, rel } of items) {
      const dot = rel.lastIndexOf('.');
      const kind = dot > 0 ? KMAP[rel.slice(dot + 1).toLowerCase()] : null;
      if (!kind) { skipped++; continue; }
      const stem = rel.slice(0, dot);
      const parts = stem.split('/').map(seg).filter(Boolean);
      if (folderCtx) parts.unshift(...folderCtx.split('/'));
      const name = parts.join('/');
      if (!name) { skipped++; continue; }
      list.push({ file, name, kind });
      const pp = name.split('/'); pp.pop();
      for (let i = 1; i <= pp.length; i++) dirs.add(pp.slice(0, i).join('/'));
    }
    if (!list.length) {
      upShow();
      upMsg.textContent = 'no supported files (md gmi html txt js css hoon)';
      return;
    }
    upShow();
    upProg(0, list.length, '');
    if (skipped) upErr.textContent = `skipped ${skipped} unsupported\n`;
    for (const d of [...dirs].sort()) {
      try { await fetch(api + '/folder-new?name=' + encodeURIComponent(d), { method: 'POST' }); }
      catch {}
    }
    let fails = 0;
    for (let i = 0; i < list.length; i++) {
      upProg(i, list.length, list[i].name);
      let r = null;
      try {
        r = await fetch(api + '/page-save?name=' + encodeURIComponent(list[i].name) +
          '&type=' + list[i].kind, { method: 'POST', body: await list[i].file.text() });
      } catch {}
      if (!r || !r.ok) {
        fails++;
        upErr.textContent += `failed: ${list[i].name}${r ? ' (' + r.status + ')' : ''}\n`;
      }
    }
    upProg(list.length, list.length, '');
    upMsg.textContent = fails ? `done with ${fails} failures` : `uploaded ${list.length} files`;
    loadTree();
    if (!fails) setTimeout(() => { upPanel.hidden = true; }, 2500);
  }

  const fromFileList = (fl) =>
    [...fl].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));

  $('upfiles').onclick = () => $('fpick').click();
  $('updir').onclick = () => $('dpick').click();
  $('fpick').onchange = () => { if ($('fpick').files.length) uploadItems(fromFileList($('fpick').files)); };
  $('dpick').onchange = () => { if ($('dpick').files.length) uploadItems(fromFileList($('dpick').files)); };

  // drag-and-drop (files or whole directories via entry walking)
  const walkEntry = (entry, path, out) => new Promise((res) => {
    if (entry.isFile) entry.file((f) => { out.push({ file: f, rel: path + f.name }); res(); }, res);
    else if (entry.isDirectory) {
      const rd = entry.createReader();
      const subs = [];
      const step = () => rd.readEntries((es) => {
        if (!es.length) { Promise.all(subs).then(res); return; }
        for (const e of es) subs.push(walkEntry(e, path + entry.name + '/', out));
        step();
      }, res);
      step();
    } else res();
  });
  const treePane = $('tree');
  window.addEventListener('dragover', (e) => { e.preventDefault(); treePane.classList.add('dragover'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) treePane.classList.remove('dragover'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    treePane.classList.remove('dragover');
    const its = e.dataTransfer && e.dataTransfer.items;
    if (!its || !its.length) return;
    const out = [];
    const ps = [];
    for (const it of its) {
      const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (en) ps.push(walkEntry(en, '', out));
    }
    Promise.all(ps).then(() => { if (out.length) uploadItems(out); });
  });

  // ── move / rename ────────────────────────────────────────────────────────
  // No server rename route for pages: move = read source, save at the new
  // name (same kind), delete the old — the same pattern the FUSE client uses.
  // Folders move every descendant (structure first, then pages), then delete
  // the old folder. Memories use the know-move route (history preserved).
  async function movePage(oldName, newName) {
    const r = await fetch(api + '/page-source?name=' + encodeURIComponent(oldName));
    if (!r.ok) { st('read failed ' + r.status, false); return false; }
    const d = await r.json();
    const kind = d.kind === 'index' ? 'md' : d.kind;
    const w = await fetch(api + '/page-save?name=' + encodeURIComponent(newName) +
      '&type=' + kind, { method: 'POST', body: d.body });
    if (!w.ok) { st('save failed ' + w.status + ' at ' + newName, false); return false; }
    const x = await fetch(api + '/page-del?name=' + encodeURIComponent(oldName), { method: 'POST' });
    if (!x.ok) { st('cleanup failed ' + x.status + ' (copy exists at ' + newName + ')', false); return false; }
    return true;
  }

  async function moveFolder(oldPath) {
    const to = prompt('move folder ' + oldPath + ' to:', oldPath);
    if (!to || to === oldPath) return;
    const newPath = to.trim().replace(/^\/+|\/+$/g, '');
    if (!newPath) return;
    const under = nodes.filter((n) => n.path === oldPath || n.path.startsWith(oldPath + '/'));
    const mapped = (p) => newPath + p.slice(oldPath.length);
    st('moving ' + oldPath + ' \u2192 ' + newPath + '\u2026');
    for (const n of under.filter((n) => !n.page).sort((a, b) => a.path.localeCompare(b.path))) {
      try { await fetch(api + '/folder-new?name=' + encodeURIComponent(mapped(n.path)), { method: 'POST' }); }
      catch {}
    }
    let moved = 0;
    for (const n of under.filter((n) => n.page)) {
      if (!(await movePage(n.path, mapped(n.path)))) return;
      moved++;
      st('moving\u2026 ' + moved + ' page' + (moved === 1 ? '' : 's'));
    }
    await fetch(api + '/page-del?name=' + encodeURIComponent(oldPath), { method: 'POST' });
    if (current && (current === oldPath || current.startsWith(oldPath + '/')))
      current = mapped(current);
    st('moved ' + oldPath + ' \u2192 ' + newPath + ' (' + moved + ' pages)');
    loadTree();
    if (current) openPage(current);
  }

  $('mv').onclick = async () => {
    if (!current) { st('open something first', false); return; }
    const to = prompt('move ' + (mode === 'know' ? 'memory' : 'page') + ' ' + current + ' to:', current);
    if (!to || to === current) return;
    const newName = to.trim().replace(/^\/+|\/+$/g, '');
    if (!newName) return;
    if (mode === 'know') {
      const r = await fetch(api + '/know-move?from=' + encodeURIComponent(current) +
        '&to=' + encodeURIComponent(newName), { method: 'POST' });
      if (!r.ok) { st('move failed ' + r.status, false); return; }
      st('moved to ' + newName);
      openKnow(newName);
      loadKnow();
      return;
    }
    if (await movePage(current, newName)) {
      st('moved to ' + newName);
      loadTree();
      openPage(newName);
    }
  };

  // ── layout toggles + mobile tabs ─────────────────────────────────────────
  const ws = $('ws');
  const applyToggles = () => {
    ws.classList.toggle('nt', localStorage.appNT === '1');
    ws.classList.toggle('nc', localStorage.appNC === '1');
    ws.classList.toggle('wrap', localStorage.appWrap === '1');
    $('wrapt').className = 'ico' + (localStorage.appWrap === '1' ? ' on' : '');
    $('treet').className = 'ico' + (localStorage.appNT === '1' ? ' on' : '');
    $('ctlt').className = 'ico' + (localStorage.appNC === '1' ? ' on' : '');
  };
  const flip = (k) => { localStorage[k] = localStorage[k] === '1' ? '0' : '1'; applyToggles(); };
  $('wrapt').onclick = () => flip('appWrap');
  $('treet').onclick = () => flip('appNT');
  $('ctlt').onclick = () => flip('appNC');
  applyToggles();

  for (const b of document.querySelectorAll('.mtabs button')) {
    b.onclick = () => {
      ws.dataset.mv = b.dataset.mv;
      for (const x of document.querySelectorAll('.mtabs button'))
        x.className = x === b ? 'on' : '';
      if (b.dataset.mv === 'prev') refreshPreview();
    };
  }
  ws.dataset.mv = 'code';

  // ── live tree refresh (beacon keep-SSE) ──────────────────────────────────
  // The writer bumps /beacon/rev on every mutation; skip the initial snapshot
  // ('old') events and refresh the tree on real changes, debounced.
  try {
    const es = new EventSource('/grubbery/api/keep/apps/lattice.lattice_app/beacon/rev');
    let beaconTimer = null;
    es.addEventListener('upd', () => {
      clearTimeout(beaconTimer);
      beaconTimer = setTimeout(loadTree, 300);
    });
  } catch {}

  // ── knowledge mode ───────────────────────────────────────────────────────
  // The same workspace, pointed at the private memory store: browse keys as a
  // tree, filter by tag chips, read/edit/save entries, tag/untag, delete.
  let mode = 'pages';
  let knowKeys = [];        // [{key, tags, updated, bytes}] from know-list
  let knowTag = '';         // active tag filter ('' = all)
  const chipsEl = $('chips'), knowMeta = $('knowmeta'), ktagsEl = $('ktags');

  async function loadKnow() {
    const r = await fetch(api + '/know-list');
    if (!r.ok) { st('know-list failed ' + r.status, false); return; }
    knowKeys = (await r.json()).keys;
    renderKnowChips();
    renderKnowTree();
  }

  function renderKnowChips() {
    const tags = [...new Set(knowKeys.flatMap((k) => k.tags))].sort();
    chipsEl.textContent = '';
    const mk = (label, val) => {
      const a = document.createElement('a');
      a.textContent = label;
      a.className = (knowTag === val) ? 'on' : '';
      a.onclick = () => { knowTag = val; renderKnowChips(); renderKnowTree(); };
      chipsEl.appendChild(a);
    };
    mk('all', '');
    for (const t of tags) mk('#' + t, t);
  }

  function renderKnowTree() {
    const shown = knowTag ? knowKeys.filter((k) => k.tags.includes(knowTag)) : knowKeys;
    const keys = shown.map((k) => k.key.replace(/^\//, '')).sort();
    treeList.textContent = '';
    const seen = new Set();
    for (const key of keys) {
      const parts = key.split('/');
      for (let d = 0; d < parts.length - 1; d++) {
        const dir = parts.slice(0, d + 1).join('/');
        if (seen.has(dir)) continue;
        seen.add(dir);
        const row = document.createElement('div');
        row.className = 'fld';
        row.style.marginLeft = (d * 14) + 'px';
        row.textContent = '\u{1F4C1} ' + parts[d];
        treeList.appendChild(row);
      }
      const row = document.createElement('a');
      row.className = 'pg' + (key === current ? ' cur' : '');
      row.style.marginLeft = ((parts.length - 1) * 14) + 'px';
      row.href = '#';
      row.textContent = parts[parts.length - 1];
      row.onclick = (e) => { e.preventDefault(); openKnow(key); };
      treeList.appendChild(row);
    }
  }

  async function openKnow(key) {
    const r = await fetch(api + '/know-read?key=' + encodeURIComponent(key));
    if (!r.ok) { st('open failed ' + r.status, false); return; }
    const d = await r.json();
    current = key;
    pname.value = key;
    pname.readOnly = true;
    src.value = d.body;
    render(); sync();
    renderKnowTree();
    renderKnowTags(d.tags || []);
    $('kupd').textContent = 'updated ' + (d.updated || '');
    st('memory · ' + (d.tags || []).map((t) => '#' + t).join(' '));
  }

  function renderKnowTags(tags) {
    ktagsEl.textContent = '';
    for (const t of tags.sort()) {
      const a = document.createElement('a');
      a.textContent = '#' + t + ' \u00d7';
      a.onclick = async () => {
        await fetch(api + '/know-untag?key=' + encodeURIComponent(current) +
          '&tag=' + encodeURIComponent(t), { method: 'POST' });
        openKnow(current);
        loadKnow();
      };
      ktagsEl.appendChild(a);
    }
  }

  $('ktagadd').onclick = async () => {
    const t = $('ktag').value.trim();
    if (!t || !current || mode !== 'know') return;
    await fetch(api + '/know-tag?key=' + encodeURIComponent(current) +
      '&tag=' + encodeURIComponent(t), { method: 'POST' });
    $('ktag').value = '';
    openKnow(current);
    loadKnow();
  };

  async function saveKnow() {
    const key = pname.value.trim().replace(/^\/+|\/+$/g, '');
    if (!key) { st('key required', false); return; }
    if (!src.value) { st('empty body', false); return; }
    const r = await fetch(api + '/know-save?key=' + encodeURIComponent(key),
      { method: 'POST', body: src.value });
    if (!r.ok) { st('save failed ' + r.status, false); return; }
    current = key;
    pname.readOnly = true;
    st('memory saved');
    loadKnow();
  }

  async function deleteKnow() {
    if (!current) return;
    if (!confirm('delete memory ' + current + '? (soft-delete, restorable)')) return;
    await fetch(api + '/know-delete?key=' + encodeURIComponent(current), { method: 'POST' });
    current = null;
    pname.value = '';
    pname.readOnly = false;
    src.value = '';
    render();
    st('memory deleted (restorable via know-restore)');
    loadKnow();
  }

  function setMode(m) {
    mode = m;
    ws.classList.toggle('know', m === 'know');
    $('modet').className = m === 'know' ? 'on' : '';
    $('modet').innerHTML = m === 'know' ? '\u270e pages' : '\u25c6 knowledge';
    chipsEl.hidden = m !== 'know';
    knowMeta.hidden = m !== 'know';
    $('treesec').textContent = m === 'know' ? 'memories' : 'files';
    $('del').textContent = m === 'know' ? 'delete memory' : 'delete page';
    $('mv').textContent = m === 'know' ? 'move / rename memory' : 'move / rename';
    current = null;
    pname.value = '';
    pname.readOnly = false;
    pname.placeholder = m === 'know' ? 'memory key (e.g. user/preferences)' : 'page name (e.g. notes/todo)';
    src.value = '';
    render();
    if (m === 'know') loadKnow(); else loadTree();
    history.replaceState(null, '', '/apps/lattice/app' + (m === 'know' ? '?view=know' : ''));
  }
  $('modet').onclick = () => setMode(mode === 'know' ? 'pages' : 'know');

  // ── boot ─────────────────────────────────────────────────────────────────
  if (qs.get('view') === 'know') {
    setMode('know');
  } else {
    loadTree().then(() => {
      const name = qs.get('name');
      const into = qs.get('into');
      if (name) openPage(name);
      else if (into) newFile(into);
      else newFile('');
    });
  }
})();
