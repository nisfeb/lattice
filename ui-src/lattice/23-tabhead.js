  // ── tab header ───────────────────────────────────────────────────────────
  // Between the tab strip and the document: Back and Forward, the path of
  // what is open, Edit / Read, and the page menu. The old bar's controls
  // stay in the DOM, hidden, because they are the stores and the handlers
  // these buttons call (#pname, #pkind, #mv, #del, #texconv).
  //
  // Edit and Read are one choice per tab, kept on the tab (`read`, which
  // 21-tabs.js persists). There is no split: Edit hides the preview, Read
  // hides the editor.
  const tabHead = document.createElement('div');
  tabHead.id = 'tabhead';
  tabHead.className = 'tabhead';
  tabHead.innerHTML =
    sbtn('id="tback" data-action="tback"', 'left', 'Back', 'Alt+Left') +
    sbtn('id="tfwd" data-action="tfwd"', 'right', 'Forward', 'Alt+Right') +
    '<button type="button" id="tpath" class="tpath" data-action="tpath"></button>' +
    '<div id="tread" class="tread" role="group" aria-label="Edit or Read">' +
      '<button type="button" data-r="0" data-action="edit">' + ico('pen') + 'Edit</button>' +
      '<button type="button" data-r="1" data-action="read">' + ico('eye') + 'Read</button>' +
    '</div>' +
    sbtn('id="tmenu" data-action="tmenu" aria-haspopup="menu"', 'dots', 'Page menu');
  $('center').insertBefore(tabHead, $('docarea'));
  for (const b of $('tread').children) b.title = 'Edit / Read (Ctrl+E)';
  $('tback').onclick = () => tabBack();
  $('tfwd').onclick = () => tabFwd();
  // the move / rename flow of the controls pane, unchanged. A tab that is
  // not a document shows only its title there.
  $('tpath').onclick = () => { if (docFront()) $('mv').click(); };
  clickAction('tback', 'Back', 'Tab header', 'Alt+Left');
  clickAction('tfwd', 'Forward', 'Tab header', 'Alt+Right');
  clickAction('tpath', 'Move or rename', 'Tab header');
  clickAction('edit', 'Edit', 'Tab header', 'Ctrl+E');
  clickAction('read', 'Read', 'Tab header', 'Ctrl+E');
  clickAction('tmenu', 'Page menu', 'Tab header');

  // Read for the tab in front. Entering it shows the preview, which skipped
  // its renders while off screen (60-preview.js)
  function applyRead() {
    const on = !!(activeTab && activeTab.read);
    const was = ws.classList.contains('ve');
    ws.classList.toggle('ve', !on);
    ws.classList.toggle('vp', on);
    for (const b of $('tread').children) {
      const p = (b.dataset.r === '1') === on;
      b.classList.toggle('on', p);
      b.setAttribute('aria-pressed', p ? 'true' : 'false');
    }
    if (on && was) showPreview();
    // the vim indicator reads PREVIEW in Read
    if (window.latVimSetInd) window.latVimSetInd();
  }
  function setRead(on) {
    if (!activeTab || !docFront()) return;
    activeTab.read = !!on;
    tabsSave();
    applyRead();
  }
  for (const b of $('tread').children) b.onclick = () => setRead(b.dataset.r === '1');
  const toggleRead = () => setRead(!(activeTab && activeTab.read));
  // the desktop View menu evals these (desktop/src/main.rs)
  window.latSetRead = setRead;
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'e' || e.key === 'E')
      && !isMobile()
      // vim keeps Ctrl+E (scroll) while the editor has focus
      && !(localStorage.edVim === '1' && document.activeElement === src)) {
      e.preventDefault();
      toggleRead();
    }
  }, true);

  function paintPath() {
    const tool = !docFront();
    const v = tool ? TAB_KINDS[activeTab.kind].label(activeTab) : (pname.value || '').trim();
    const p = $('tpath');
    p.disabled = tool;
    p.textContent = v || 'no page open';
    p.classList.toggle('muted', !v);
    p.title = v && !tool ? v + ' · ' + (pkind.value || '') : '';
  }
  // every writer of the name goes through setOpen (20-state.js), which fires
  // 'input' on the field, and typing fires it natively
  pname.addEventListener('input', paintPath);
  pkind.addEventListener('change', paintPath);

  // called by paintTabs: the tab in front changed, or its stacks did. A tab
  // that is not a document (a tool, 24-tools.js) has no Edit / Read and no
  // page menu.
  function paintHead() {
    const tool = !docFront();
    $('tread').hidden = tool;
    $('tmenu').hidden = tool;
    if (pmenuEl && pmenuTab !== activeTab) pmenuClose();
    for (const [id, st_] of [['tback', 'back'], ['tfwd', 'fwd']]) {
      const off = !activeTab || !activeTab[st_].length;
      const b = $(id);
      b.disabled = off;
      b.setAttribute('aria-disabled', off ? 'true' : 'false');
    }
    paintPath();
    applyRead();
    toolSync();
  }

  // ── the page menu ────────────────────────────────────────────────────────
  // Each item calls the handler that already exists. An item that does not
  // apply to what is open is left out, not greyed: a grub has no kind, a
  // memory has no raw source.
  const KINDS = ['md', 'gmi', 'html', 'text', 'js', 'css', 'tex', 'hoon'];
  let pmenuEl = null;
  let pmenuTab = null;   // the tab the open menu was made for
  const pmenuClose = () => { if (pmenuEl) { pmenuEl.remove(); pmenuEl = null; } };

  // Duplicate: a new page beside this one, same kind and body, named
  // <name>-copy until the user says otherwise
  async function dupPage() {
    if (!current || grubPath || mode === 'know' || curFolder !== null) return;
    const body = src.value;
    const kind = pkind.value;
    const picked = await askName('duplicate ' + current + ' as:', current + '-copy', 'create');
    if (!picked) return;
    const rn = realName(picked);
    if (!rn) { st('bad name — use at least one letter or digit', false); return; }
    if (!(await guardDirty())) return;
    newFile('', false);
    newRn = rn;
    pkind.value = kind;
    setOpen(null, { shown: rn.name });
    src.value = body;
    render();
    await save();
  }

  // Download: what is in the editor now, as a file named for the last path
  // segment. A memory is markdown.
  const DLEXT = { text: 'txt' };
  function downloadDoc() {
    if (!current || grubPath || curFolder !== null) return;
    const kind = mode === 'know' ? 'md' : (pkind.value || 'md');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([src.value], { type: 'text/plain' }));
    a.download = current.split('/').pop() + '.' + (DLEXT[kind] || kind);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // which items apply to what is open. The menu shows these and the
  // palette lists these, so the two never disagree.
  function pmenuHas() {
    const doc = !grubPath && curFolder === null;       // a page or a memory
    const page = doc && mode !== 'know';
    const has = new Set(['wrap']);
    if (page) has.add('kind');
    if (page && current) { has.add('dup'); has.add('raw'); }
    if (doc && current) { has.add('download'); has.add('del'); }
    if (page && window.__TAURI__ && (curKind === 'tex' || pkind.value === 'tex')) has.add('tex');
    return has;
  }
  function pageMenu() {
    if (pmenuEl) { pmenuClose(); return; }
    const t = activeTab;
    if (!t) return;
    const has = pmenuHas();
    const m = document.createElement('div');
    m.className = 'dtmenu tmenu';
    m.setAttribute('role', 'menu');
    const item = (id, label, run, checked) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemcheckbox');
      if (checked !== undefined) b.setAttribute('aria-checked', checked ? 'true' : 'false');
      b.dataset.mi = id;
      b.dataset.action = 'pm-' + id;
      b.textContent = label;
      b.onclick = () => run(b);
      m.append(b);
      return b;
    };
    const done = (fn) => () => { pmenuClose(); fn(); };
    if (has.has('kind')) {
      const sub = document.createElement('div');
      sub.className = 'tsub';
      sub.hidden = true;
      for (const k of KINDS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', k === pkind.value ? 'true' : 'false');
        b.dataset.kind = k;
        b.textContent = k;
        b.onclick = () => {
          pmenuClose();
          if (pkind.value === k) return;
          pkind.value = k;
          pkind.dispatchEvent(new Event('change'));
        };
        sub.append(b);
      }
      item('kind', 'Kind ▸', () => { sub.hidden = !sub.hidden; });
      m.append(sub);
    }
    item('wrap', 'Line wrap', done(() => flip('appWrap')), localStorage.appWrap === '1');
    if (has.has('dup')) item('dup', 'Duplicate', done(dupPage));
    if (has.has('download')) item('download', 'Download', done(downloadDoc));
    if (has.has('tex')) item('tex', 'Convert to HTML', done(() => $('texconv').click()));
    if (has.has('raw')) item('raw', 'Open raw', done(() =>
      window.open(api + '/page-source?name=' + encodeURIComponent(current), '_blank', 'noopener')));
    if (has.has('del')) item('del', 'Delete', done(() => $('del').click()));
    const r = $('tmenu').getBoundingClientRect();
    m.style.top = r.bottom + 4 + 'px';
    m.style.right = Math.max(4, innerWidth - r.right) + 'px';
    document.body.append(m);
    pmenuEl = m;
    pmenuTab = t;
    m.querySelector('button').focus();
  }
  $('tmenu').onclick = pageMenu;
  // The items are built when the menu opens, so a palette action opens it
  // and clicks the item, which is the menu's own path. Kind opens the menu
  // with its list unfolded, as clicking Kind does. Convert to HTML exists
  // only in the desktop app.
  for (const [id, name] of [['kind', 'Change page kind'], ['wrap', 'Line wrap'],
    ['dup', 'Duplicate page'], ['download', 'Download'], ['tex', 'Convert to HTML'],
    ['raw', 'Open raw'], ['del', 'Delete']]) {
    if (id === 'tex' && !window.__TAURI__) continue;
    action({ id: 'pm-' + id, name, home: 'Page menu',
      when: () => docFront() && pmenuHas().has(id),
      run: () => {
        pmenuClose();
        pageMenu();
        const b = pmenuEl && pmenuEl.querySelector('[data-mi="' + id + '"]');
        if (b) b.click();
      } });
  }
  addEventListener('mousedown', (e) => {
    if (pmenuEl && !pmenuEl.contains(e.target) && !$('tmenu').contains(e.target)) pmenuClose();
  }, true);
  addEventListener('keydown', (e) => {
    if (pmenuEl && e.key === 'Escape') { pmenuClose(); $('tmenu').focus(); }
  });
