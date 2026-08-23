  // ── knowledge mode ───────────────────────────────────────────────────────
  // The same workspace, pointed at the private memory store: browse keys as a
  // tree, filter by tag chips, read/edit/save entries, tag/untag, delete.
  let mode = 'pages';
  let knowKeys = [];        // [{key, tags, updated, bytes}] from know-list
  let knowTag = '';         // active tag filter ('' = all)
  const chipsEl = $('chips'), knowMeta = $('knowmeta'), ktagsEl = $('ktags');

  async function loadKnow() {
    const gen = knowGen;
    let d = null;
    // resolves either way, like loadTree: the drain and the mode switch both
    // call this without a .catch, and a rejection there would take the rest of
    // their work with it.
    try {
      const r = await fetch(api + '/know-list');
      if (!r.ok) { st('know-list failed' + await errText(r), false); return; }
      d = await r.json();
    } catch { st('know-list failed (network)', false); return; }
    if (gen !== knowGen) return;   // a local patch superseded this response
    knowKeys = d.keys;
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

  const kColl = () => {
    try { return JSON.parse(localStorage.knowColl || '[]'); } catch { return []; }
  };
  const setKColl = (c) => { localStorage.knowColl = JSON.stringify(c); };

  function renderKnowTree() {
    const shown = knowTag ? knowKeys.filter((k) => k.tags.includes(knowTag)) : knowKeys;
    const keys = shown.map((k) => k.key.replace(/^\//, '')).sort();
    treeList.textContent = '';
    rowByPath = new Map();
    if (!keys.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.style.padding = '4px 8px';
      empty.textContent = knowTag
        ? 'no memories tagged #' + knowTag
        : 'no memories yet — name one above and save';
      treeList.appendChild(empty);
      return;
    }
    const coll = kColl();
    const folded = (path) => coll.some((c) => path !== c && path.startsWith(c + '/'));
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
        if (folded(dir)) row.style.display = 'none';
        const cx = document.createElement('span');
        cx.className = 'cx';
        cx.textContent = coll.includes(dir) ? '▸' : '▾';
        const label = document.createElement('span');
        label.textContent = '\u{1F4C1} ' + parts[d];
        row.append(cx, label);
        row.onclick = () => {
          const c = kColl();
          const i = c.indexOf(dir);
          if (i >= 0) c.splice(i, 1); else c.push(dir);
          setKColl(c);
          renderKnowTree();
        };
        treeList.appendChild(row);
      }
      const row = document.createElement('a');
      row.className = 'pg' + (key === current ? ' cur' : '');
      row.style.marginLeft = ((parts.length - 1) * 14) + 'px';
      if (folded(key)) row.style.display = 'none';
      row.href = '#';
      row.textContent = parts[parts.length - 1];
      row.onclick = (e) => { e.preventDefault(); openKnow(key); };
      rowByPath.set(key, row);
      treeList.appendChild(row);
    }
  }
  // one knowKeys entry by (normalized) key. Keys may carry a leading slash
  const knowEntry = (key) =>
    knowKeys.find((x) => x.key.replace(/^\//, '') === key);

  async function openKnow(key) {
    // a dirty memory lives nowhere but this textarea until it saves, the
    // same reason openPage guards a dirty grub and openRev guards a dirty
    // revision before repainting over it
    if (mode === 'know' && current && dirty &&
        !(await askConfirm('discard unsaved changes to ' + current + '?', 'discard'))) return;
    if (mode !== 'know') setMode('know');
    // a queued edit outranks the ship's copy, same rule as pages
    const q = await offGet('know:' + key);
    let d = null;
    if (q) d = { body: q.body, tags: (knowEntry(key) || { tags: [] }).tags, updated: 'queued offline' };
    else {
      let r = null;
      try { r = await fetch(api + '/know-read?key=' + encodeURIComponent(key)); } catch {}
      if (!r || !r.ok) { st('open failed' + (r ? await errText(r) : ' — offline'), false); return; }
      d = await r.json();
    }
    current = key;
    pname.value = key;
    pname.readOnly = true;
    src.value = d.body;
    dirty = false;
    render(); sync();
    markCurrent();
    renderKnowTags(d.tags || []);
    $('kupd').textContent = 'updated ' + (d.updated || '');
    exitRev();
    resetPanels();
    st('memory · ' + (d.tags || []).map((t) => '#' + t).join(' '));
    if (isMobile()) setMv('code');
  }

  function renderKnowTags(tags) {
    ktagsEl.textContent = '';
    for (const t of tags.sort()) {
      const a = document.createElement('a');
      a.textContent = '#' + t + ' \u00d7';
      a.onclick = async () => {
        const r = await mutate(api + '/know-untag?key=' + encodeURIComponent(current) +
          '&tag=' + encodeURIComponent(t));
        if (!r.ok) { st('untag failed' + await errText(r), false); return; }
        // this client made the change. Patch the list it already holds
        knowGen++;
        const k = knowEntry(current);
        if (k) k.tags = k.tags.filter((x) => x !== t);
        renderKnowTags(k ? k.tags : []);
        renderKnowChips();
        renderKnowTree();
      };
      ktagsEl.appendChild(a);
    }
  }

  $('ktagadd').onclick = async () => {
    // the writer case-folds tags. Fold here too so the local patch matches
    const t = $('ktag').value.trim().toLowerCase();
    if (!t || !current || mode !== 'know') return;
    const r = await mutate(api + '/know-tag?key=' + encodeURIComponent(current) +
      '&tag=' + encodeURIComponent(t));
    if (!r.ok) { st('tag failed' + await errText(r), false); return; }
    $('ktag').value = '';
    knowGen++;
    const k = knowEntry(current);
    if (k && !k.tags.includes(t)) k.tags.push(t);
    renderKnowTags(k ? k.tags : [t]);
    renderKnowChips();
  };

  async function saveKnow() {
    const key = pname.value.trim().replace(/^\/+|\/+$/g, '');
    if (!key) { st('key required', false); return; }
    if (!validName(key)) {
      st('bad key — lowercase letters, digits, and - . _ ~ (no spaces)', false);
      return;
    }
    if (!src.value) { st('empty body', false); return; }
    if (viewingRev !== null) { st('viewing a revision — use restore', false); return; }
    const sent = src.value;
    echoUntil = Date.now() + 60000;
    let r = null;
    try { r = await tfetch(api + '/know-save?key=' + encodeURIComponent(key),
      { method: 'POST', body: sent }); } catch {}
    echoUntil = Date.now() + 4000;
    if (shipGone(r)) {
      //  if the queue would not take it, it is NOT saved: leave the editor
      //  dirty and the key still editable, so the text under the cursor is not
      //  presented as stored. Same rule the page paths enforce (35-pages.js),
      //  and enqueueKnow has already said why it refused.
      if (!(await enqueueKnow(key, sent))) return;
      current = key;
      pname.readOnly = true;
      if (src.value === sent) dirty = false;
      return;
    }
    if (!r.ok) { st('save failed' + await errText(r), false); return; }
    current = key;
    pname.readOnly = true;
    if (src.value === sent) dirty = false;
    st('memory saved');
    bustPages(key);
    knowGen++;
    const k = knowEntry(key);
    if (k) k.bytes = sent.length;
    else knowKeys.push({ key, tags: [], updated: '', bytes: sent.length });
    renderKnowChips();
    renderKnowTree();
  }

  async function deleteKnow() {
    if (!current) return;
    if (!(await askConfirm('delete memory ' + current + '? (soft-delete, restorable)', 'delete'))) return;
    const doomed = current;
    const r = await mutate(api + '/know-delete?key=' + encodeURIComponent(doomed));
    if (!r.ok) { st('delete failed' + await errText(r), false); return; }
    current = null;
    pname.value = '';
    pname.readOnly = false;
    src.value = '';
    render();
    st('memory deleted (restorable via know-restore)');
    knowGen++;
    knowKeys = knowKeys.filter((x) => x.key.replace(/^\//, '') !== doomed);
    renderKnowChips();
    renderKnowTree();
  }

  function setMode(m) {
    mode = m;
    curKind = null;
    exitGrub();                      // Save must stop pointing at an app file
    exitRev();                       // else readOnly leaks into the memory editor
    $('histsec').hidden = true;
    $('linksec').hidden = true;
    ws.classList.toggle('know', m === 'know');
    $('modet').className = m === 'know' ? 'on' : '';
    $('modet').innerHTML = m === 'know' ? '\u25c6 knowledge' : '\u270e pages';
    chipsEl.hidden = m !== 'know';
    knowMeta.hidden = m !== 'know';
    $('treesec').textContent = m === 'know' ? 'memories' : 'files';
    curFolder = null;
    setCtlLabels();
    current = null;
    pname.value = '';
    pname.readOnly = false;
    pname.placeholder = m === 'know' ? 'memory key (e.g. user/preferences)' : 'page name (e.g. notes/todo)';
    src.value = '';
    render();
    if (m === 'know') loadKnow(); else loadTree();
    history.replaceState(null, '', '/apps/lattice/app' + (m === 'know' ? '?view=know' : ''));
    // the toggle's visible result is the tree listing. Make sure it can be
    // seen: un-hide the pane on desktop, jump to the tree tab on mobile.
    if (localStorage.appNT === '1') { localStorage.appNT = '0'; applyToggles(); }
    if (isMobile()) setMv('tree');
    st(m === 'know' ? 'knowledge — pick a memory from the tree' : 'pages');
  }
  $('modet').onclick = () => setMode(mode === 'know' ? 'pages' : 'know');
