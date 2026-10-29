  // ── knowledge: <lat-know>, the memories and the editor's memory mode ────
  // The Knowledge tab lists the private memory store as a tree, filtered by
  // tag chips, with its own toolbar. `mode` is the editor's state for the
  // document tab in front (21-tabs.js): a memory tab sets it to 'know', so
  // read, edit, save, tag and delete go to the memory routes. Nothing else
  // switches it any more, and the listing never depends on it. (`mode`
  // itself is declared in 20-state.js, since the files tree reads it.)
  customElements.define('lat-know', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<aside class="tree" id="knowpane">
  <div class="ptool" role="toolbar" aria-label="Knowledge">
    ${sbtn('id="knew" data-action="knew"', 'plus', 'New memory')}
    ${sbtn('id="ktidy" data-action="ktidy"', 'tidy', 'Tidy memories')}
    ${sbtn('id="ktrash" data-action="ktrash" aria-pressed="false"', 'trash', 'Trash')}
  </div>
  <div id="ktrashlist" class="ktrash" hidden></div>
  <!-- the tag chips outgrew the pane top (one row per dozen tags), so they
       fold under a heading like history does. Native details: the fold,
       the keyboard and the marker come free. -->
  <details id="tagsec">
    <summary class="sec" id="tagsh">tags</summary>
    <div id="chips" class="chips"></div>
  </details>
  <div class="sec">memories</div>
  <div id="knowlist"><div class="muted kwait">loading memories\u2026</div></div>
</aside>`;
    }
  });
  let knowKeys = [];        // [{key, tags, updated, bytes}] from know-list
  let knowTag = '';         // active tag filter ('' = all)
  let knowHave = false;     // a know-list has landed this session
  const chipsEl = $('chips'), knowMeta = $('knowmeta'), ktagsEl = $('ktags');
  const knowList = $('knowlist');
  treeKeys(knowList, 'Memories');
  // folded by default and remembered, like the other layout choices
  const tagSec = $('tagsec'), tagSum = $('tagsh');
  tagSec.open = localStorage.knowTagsOpen === '1';
  tagSec.addEventListener('toggle', () => { localStorage.knowTagsOpen = tagSec.open ? '1' : '0'; });

  // the memory beacon the last applied know-list was fetched at (knowFresh)
  let knowAt = '';
  async function loadKnow() {
    const gen = knowGen;
    const at = lastKnow;
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
    knowAt = at;
    knowHave = true;
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
    // folded, the heading still says what the tree is filtered by, so a
    // hidden filter can never silently narrow it
    tagSum.textContent = 'tags \u00b7 ' + (knowTag ? '#' + knowTag : tags.length);
  }

  const knowColl = collStore('knowColl');

  function renderKnowTree() {
    const shown = knowTag ? knowKeys.filter((k) => k.tags.includes(knowTag)) : knowKeys;
    const keys = shown.map((k) => k.key.replace(/^\//, '')).sort();
    const had = knowList.contains(document.activeElement);
    knowList.textContent = '';
    knowRows = new Map();
    if (!keys.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.style.padding = '4px 8px';
      empty.textContent = knowTag
        ? 'no memories tagged #' + knowTag
        : 'no memories yet. New memory starts one.';
      knowList.appendChild(empty);
      return;
    }
    const coll = knowColl.get();
    const folded = (path) => coll.some((c) => path !== c && path.startsWith(c + '/'));
    const seen = new Set();
    for (const key of keys) {
      const parts = key.split('/');
      for (let d = 0; d < parts.length - 1; d++) {
        const dir = parts.slice(0, d + 1).join('/');
        if (seen.has(dir)) continue;
        seen.add(dir);
        const row = folderRow(parts[d], d, coll.includes(dir),
          () => { knowColl.flip(dir); renderKnowTree(); }, undefined, 'f:' + dir);
        if (folded(dir)) row.style.display = 'none';
        knowList.appendChild(row);
      }
      const row = document.createElement('a');
      row.className = 'pg' + (mode === 'know' && key === current ? ' cur' : '');
      row.style.marginLeft = ((parts.length - 1) * 14) + 'px';
      if (folded(key)) row.style.display = 'none';
      row.href = '/apps/lattice/app?view=know&key=' + encodeURIComponent(key);
      row.textContent = parts[parts.length - 1];
      tabLink(row, 'know', key);
      treeItem(row, parts.length - 1, 'p:' + key);
      knowRows.set(key, row);
      knowList.appendChild(row);
    }
    treeRove(knowList, had);
  }
  // one knowKeys entry by (normalized) key. Keys may carry a leading slash
  const knowEntry = (key) =>
    knowKeys.find((x) => x.key.replace(/^\//, '') === key);

  // false when the open failed and nothing was painted, so the tab model
  // (21-tabs.js) can tell a failure from an open a later one superseded
  async function openKnow(key) {
    // guardDirty covers a dirty grub, page, or memory in one place (see
    // 20-state.js): it flushes what it can and only asks when the flush
    // still leaves something unsaved.
    if (!(await guardDirty())) return false;
    // the same sequence openPage keeps: a later open of anything supersedes
    // this one, so a slow answer cannot paint a memory over the page (or
    // the other memory) opened after it
    const my = ++openSeq;
    if (mode !== 'know') setMode('know');
    // a queued edit outranks the ship's copy, same rule as pages
    const q = await offGet('know:' + key);
    let d = null;
    if (q) d = { body: q.body, tags: (knowEntry(key) || { tags: [] }).tags, updated: 'queued offline' };
    else {
      let r = null;
      try { r = await fetch(api + '/know-read?key=' + encodeURIComponent(key)); } catch {}
      if (my !== openSeq) return;
      if (!r || !r.ok) { st('open failed' + (r ? await errText(r) : ' — offline'), false); return false; }
      d = await r.json();
    }
    if (my !== openSeq) return;
    applyKnow(key, d);
    return true;
  }
  // paint a memory that is already in hand: openKnow's answer, or a tab's
  // own unsaved buffer coming back to the front (21-tabs.js)
  function applyKnow(key, d) {
    setOpen(key, { readOnly: true,
      url: '/apps/lattice/app?view=know&key=' + encodeURIComponent(key) });
    src.value = d.body;
    dirty = false;
    render(); sync();
    paintLocal();                    // the preview pane shows the memory too
    markCurrent();
    renderKnowTags(d.tags || []);
    $('kupd').textContent = 'updated ' + (d.updated || '');
    exitRev();
    resetPanels();
    st('memory · ' + (d.tags || []).map((t) => '#' + t).join(' '));
    drawersClose();
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

  const knowField = () => pname.value.trim().replace(/^\/+|\/+$/g, '');
  //  the editor still shows memory `key`: its own, or the new one the name
  //  field names (the rule save() keeps for a page create, 35-pages.js)
  const knowHere = (key) => mode === 'know' && !grubPath &&
    (current === key || (current === null && knowField() === key));
  // `create`: New memory writes the key before anything is typed, so an
  // empty body is sent as a newline (as a new page is) rather than refused
  async function saveKnow(create) {
    const key = knowField();
    if (!key) { st('key required', false); return; }
    if (!validName(key)) {
      st('bad key — lowercase letters, digits, and - . _ ~ (no spaces)', false);
      return;
    }
    if (!src.value && !create) { st('empty body', false); return; }
    if (viewingRev !== null) { st('viewing a revision — use restore', false); return; }
    // the pier serializes every write behind one shared `saving` flag, know
    // or page (see save()/autosave()/saveGrub()). Without this guard,
    // guardDirty's flush against a memory whose autosave was already mid-
    // flight fired a second, fully concurrent POST to the same /know-save key.
    //  queued for this memory: it runs only if the editor still shows it,
    //  and a create runs even on a clean buffer, as a page create does
    if (saving) {
      queueSave(() => { if (knowHere(key)) return saveKnow(create); }, create);
      return;
    }
    saving = true;
    const sent = src.value || '\n';
    let w = { gone: true };
    try {
      w = await shipWrite(api + '/know-save?key=' + encodeURIComponent(key),
        { method: 'POST', body: sent }, { save: true });
    } finally { saving = false; }
    const r = w.r;
    //  the editor may have moved during the round trip (a page opened, New
    //  memory again). Only the memory still shown takes the key and its
    //  tab, never whatever is in front now.
    const claim = () => {
      if (!knowHere(key)) return;
      current = key;
      tabFollow();             // a new memory's tab is named now (21-tabs.js)
      pname.readOnly = true;
      if (src.value === sent) dirty = false;
    };
    if (w.gone) {
      //  if the queue would not take it, it is NOT saved: leave the editor
      //  dirty and the key still editable, so the text under the cursor is not
      //  presented as stored. Same rule the page paths enforce (35-pages.js),
      //  and enqueueKnow has already said why it refused.
      if (!(await enqueueKnow(key, sent))) { flushPending(); return; }
      claim();
      flushPending();
      return;
    }
    if (!r.ok) { st('save failed' + await errText(r), false); flushPending(); return; }
    claim();
    st('memory saved');
    knowGen++;
    const k = knowEntry(key);
    if (k) k.bytes = sent.length;
    else knowKeys.push({ key, tags: [], updated: '', bytes: sent.length });
    renderKnowChips();
    renderKnowTree();
    flushPending();
  }

  async function deleteKnow() {
    if (!current) return;
    if (!(await askConfirm('delete memory ' + current + '? (soft-delete, restorable)', 'delete'))) return;
    const doomed = current;
    const r = await mutate(api + '/know-delete?key=' + encodeURIComponent(doomed));
    if (!r.ok) { st('delete failed' + await errText(r), false); return; }
    // a delete reachable from inside a revision view (mode='know' skips the
    // viewingRev guard the pages path enforces) must not leave the editor
    // behind it read-only forever. Exit ONLY on success: exiting up front
    // left a declined confirm holding the old revision's body, editable and
    // uncued, one keystroke from autosaving history over the live memory.
    // An aborted delete keeps the revision view exactly as it was.
    exitRev();
    setOpen(null);
    src.value = '';
    render();
    st('memory deleted (restorable via know-restore)');
    knowGen++;
    knowKeys = knowKeys.filter((x) => x.key.replace(/^\//, '') !== doomed);
    renderKnowChips();
    renderKnowTree();
  }

  // The editor's mode, set by what the front tab opens: openKnow and the
  // know tab kind to 'know', openPage and the page and grub kinds back to
  // 'pages'. Each of those has already passed guardDirty, so this does not
  // ask again. It resets the editor to a blank document of that mode; the
  // open that called it then paints its document.
  function setMode(m) {
    mode = m;
    curKind = null;
    exitGrub();                      // Save must stop pointing at an app file
    exitRev();                       // else readOnly leaks into the memory editor
    ws.classList.toggle('know', m === 'know');
    knowMeta.hidden = m !== 'know';
    curFolder = null;
    setCtlLabels();
    setOpen(null, { url: '/apps/lattice/app' + (m === 'know' ? '?view=know' : '') });
    pname.placeholder = m === 'know' ? 'memory key (e.g. user/preferences)' : 'page name (e.g. notes/todo)';
    src.value = '';
    render();
    prevBlank();
    markCurrent();
    // both listings are always painted in their own tabs. Refetch the one
    // this mode works on only when the beacon says it moved (revFresh,
    // knowFresh in 90-sync.js), never to learn nothing.
    if (m === 'know') { if (!knowFresh(knowAt)) loadKnow(); }
    else if (!revFresh(treeAt)) loadTree();
    st(m === 'know' ? 'knowledge' : 'pages');
  }

  // ── the Knowledge tab: lazy listing ─────────────────────────────────────
  // Fetched the first time the tab is seen, and again when the memory
  // beacon has moved since (knowFresh). Memories are one request the editor
  // does not otherwise need, so a session that never looks never pays it.
  const knowShow = () => { if (!knowHave || !knowFresh(knowAt)) loadKnow(); };
  // whether the memory listing is worth keeping current: in memory mode, or
  // once it has been loaded and is sitting in its tab (90-sync.js, the drain)
  const knowLive = () => mode === 'know' || knowHave;
  document.addEventListener('lat-pane', (e) => {
    if (e.detail.side === 'l' && e.detail.id === 'know') knowShow();
  });
  if (paneShows('l', 'know')) knowShow();

  // ── toolbar ─────────────────────────────────────────────────────────────
  // New memory: the page create dialog, its kind fixed at md (a memory has
  // no other), then a fresh memory tab named with the key and written at
  // once, the way a new page is (newFile, 35-pages.js). The dialog comes
  // first, so a cancel leaves the front tab exactly as it was.
  $('knew').onclick = async (ev) => {
    let seed = '';
    let note = '';
    let key = '';
    for (;;) {
      const picked = await askNameKind(note + 'memory key (e.g. user/preferences)', seed,
        'create', 'md', true);
      if (!picked) return;
      key = picked.name.replace(/\.md$/i, '');
      if (validName(key)) break;
      seed = key;
      note = 'a key is lowercase letters, digits and - . _ ~ (no spaces). ';
    }
    // the key must be free, and the ship is the one to ask: knowKeys is
    // empty until the lazy list lands, or if it failed, and /know-save has
    // no create-only form, so a write here would put a newline over an
    // existing memory. A key that exists opens instead; a check that cannot
    // complete creates nothing.
    if (!knowEntry(key)) {
      let r = null;
      try { r = await fetch(api + '/know-read?key=' + encodeURIComponent(key)); } catch {}
      if (!r || (!r.ok && r.status !== 404)) {
        st('could not check whether ' + key + ' exists' + (r ? await errText(r) : ' (offline)')
          + ', so nothing was created', false);
        return;
      }
      if (r.ok) {
        await openIn('know', key, { ev });
        st(key + ' already exists, so it is open instead');
        return;
      }
    } else { openIn('know', key, { ev }); return; }
    await openIn('know', '', { ev });
    if (!activeTab || activeTab.kind !== 'know' || activeTab.key || current !== null) return;
    setOpen(null, { shown: key });
    await saveKnow(true);
    src.focus();
  };
  // Tidy: the memory review (/know?lint=1) as a tool tab (24-tools.js)
  $('ktidy').onclick = () => toolOpen('frame:/apps/lattice/know?lint=1');
  // Trash: the soft-deleted memories (GET /know-trash), each with Restore
  const trashList = $('ktrashlist');
  const kmuted = (t) => {
    const d = document.createElement('div');
    d.className = 'muted';
    d.style.padding = '4px 8px';
    d.textContent = t;
    return d;
  };
  async function loadTrash() {
    trashList.replaceChildren(kmuted('loading trash\u2026'));
    let d = null;
    try {
      const r = await fetch(api + '/know-trash');
      if (r.ok) d = await r.json();
    } catch {}
    if (trashList.hidden) return;
    if (!d) { trashList.replaceChildren(kmuted('the trash did not load')); return; }
    const keys = (d.keys || []).map((k) => String(k.key || '').replace(/^\//, '')).sort();
    const head = document.createElement('div');
    head.className = 'sec';
    head.textContent = 'trash \u00b7 ' + keys.length;
    trashList.replaceChildren(head);
    if (!keys.length) { trashList.append(kmuted('nothing in the trash')); return; }
    for (const key of keys) {
      const row = document.createElement('div');
      row.className = 'ktr';
      row.dataset.key = key;
      const n = document.createElement('span');
      n.className = 'ktn';
      n.textContent = key;           // keys are content: textContent
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'restore';
      b.onclick = async () => {
        b.disabled = true;
        const r = await mutate(api + '/know-restore?key=' + encodeURIComponent(key));
        if (!r.ok) { b.disabled = false; st('restore failed' + await errText(r), false); return; }
        st('restored ' + key);
        loadKnow();
        loadTrash();
      };
      row.append(n, b);
      trashList.append(row);
    }
  }
  $('ktrash').onclick = () => {
    const on = trashList.hidden;
    trashList.hidden = !on;
    $('ktrash').classList.toggle('on', on);
    $('ktrash').setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) loadTrash();
  };
  clickAction('knew', 'New memory', 'Knowledge toolbar');
  clickAction('ktidy', 'Tidy memories', 'Knowledge toolbar');
  clickAction('ktrash', 'Memory trash', 'Knowledge toolbar');
