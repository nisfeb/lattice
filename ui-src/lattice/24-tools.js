  // ── tool tabs and the ribbon ─────────────────────────────────────────────
  // A tool tab holds no document: the comments inbox, access & groups, the
  // sync conflicts, or a same-origin page in a frame (Settings, the memory
  // review). Its key names the tool ('inbox', 'access', 'conflicts') or the
  // frame ('frame:/apps/lattice/settings'). While one is in front the
  // document area is hidden and #toolhost takes the center. The editor
  // underneath keeps whatever the parked tab left there, untouched: the
  // tool kind has no live(), so nothing a tool does is ever filed under a
  // document's tab.
  const toolHost = document.createElement('div');
  toolHost.id = 'toolhost';
  toolHost.className = 'toolhost';
  toolHost.hidden = true;
  $('docarea').after(toolHost);

  // the client tools: their name, icon, the overlay element each one used
  // to be (72-acl.js, 73-comments.js, 80-conflicts.js) and what fills it
  const TOOLS = {
    inbox: { name: 'Comments inbox', icon: 'inbox', wrap: 'cmwrap', load: () => cmLoad() },
    access: { name: 'Access & groups', icon: 'key', wrap: 'aclwrap', load: () => aclLoad() },
    conflicts: { name: 'Sync conflicts', icon: 'conflict', wrap: 'cfwrap', load: () => renderConflicts() },
  };
  const FRAMES = {
    '/apps/lattice/settings': ['Settings', 'gear'],
    '/apps/lattice/know?lint=1': ['Memory review', 'tidy'],
  };
  const SETTINGS = 'frame:/apps/lattice/settings';
  // only a lattice path on this origin, whatever the key says: a frame is
  // dressed by reaching into it, and a key can come from typed input
  const frameUrl = (key) => {
    if (!key.startsWith('frame:')) return null;
    let u;
    try { u = new URL(key.slice(6), location.origin); } catch { return null; }
    if (u.origin !== location.origin || !/^\/apps\/lattice(\/|$)/.test(u.pathname)) return null;
    return u.pathname + u.search;
  };
  const toolMeta = (key) => {
    if (TOOLS[key]) return [TOOLS[key].name, TOOLS[key].icon];
    const u = frameUrl(key);
    return u ? FRAMES[u] || [u, 'globe'] : [key, 'gear'];
  };
  // every way into a tool. A tool gets a tab of its own rather than
  // replacing the document in front, and an open one is focused. On a phone
  // the drawer it was opened from goes away, also when the tool was in
  // front already.
  const toolOpen = async (id) => {
    await openIn('tool', id === 'settings' ? SETTINGS : id, { newTab: true });
    drawersClose();
  };

  // which tool the host shows, null while a document is in front
  let toolShown = null;
  TAB_KINDS.tool = {
    icon: (t) => toolMeta(t.key)[1],
    label: (t) => toolMeta(t.key)[0],
    open: async (t) => {
      toolSync();
      if (TOOLS[t.key]) TOOLS[t.key].load();
      return true;
    },
    // a tool has no buffer, so nothing to park and nothing to restore
    restore: () => {},
    park: async () => true,
    shows: (t) => t === activeTab && toolShown === t.key,
  };

  // Called by paintHead on every change of the tab in front. Shows the host
  // or the document area, and in the host only the front tool. A wrap that
  // is not in front is hidden, which is how 90-sync.js knows the inbox is
  // not being read. A frame whose tab has closed goes away.
  function toolSync() {
    const t = activeTab && activeTab.kind === 'tool' ? activeTab : null;
    const was = toolShown;
    toolShown = t ? t.key : null;
    $('docarea').hidden = !!t;
    toolHost.hidden = !t;
    if (t) toolMount(t.key);
    for (const f of [...toolHost.querySelectorAll('iframe')])
      if (!tabs.some((x) => x.kind === 'tool' && x.key === f.dataset.tool)) f.remove();
    for (const c of toolHost.children) c.hidden = c.dataset.tool !== toolShown;
    // the right pane goes by what is in front (76-outline.js)
    if (was !== toolShown) rpSoon();
  }
  function toolMount(key) {
    if (TOOLS[key]) {
      const w = $(TOOLS[key].wrap);
      if (!w || w.parentNode === toolHost) return;
      w.classList.add('intab');
      w.dataset.tool = key;
      toolHost.append(w);
      return;
    }
    const url = frameUrl(key);
    if (!url || [...toolHost.querySelectorAll('iframe')].some((f) => f.dataset.tool === key)) return;
    const f = document.createElement('iframe');
    f.className = 'toolframe';
    f.dataset.tool = key;
    f.title = toolMeta(key)[0];
    f.onload = () => frameDress(f);
    f.src = url;
    toolHost.append(f);
  }
  // Each load of a frame: the reader's own bar is hidden, since the shell
  // around it is the chrome now. A link in it to a document in the editor
  // opens that document in a new tab of the shell, never over the frame's
  // own tab and never as a second editor nested in the frame. Any other
  // link navigates the frame as usual.
  function frameDress(f) {
    let d = null;
    try { d = f.contentDocument; } catch {}
    if (!d || !d.head) return;
    const s = d.createElement('style');
    s.textContent = 'form.bar{display:none}';
    d.head.append(s);
    d.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || e.defaultPrevented) return;
      let u;
      try { u = new URL(a.href); } catch { return; }
      if (u.origin !== location.origin || !/^\/apps\/lattice\/app\/?$/.test(u.pathname)) return;
      const q = u.searchParams;
      const go = q.get('grub') ? ['grub', q.get('grub'), q.get('ship') || null]
        : q.get('view') === 'know' ? ['know', q.get('key') || '', null]
          : q.get('name') ? ['page', q.get('name'), null] : null;
      if (!go) return;
      e.preventDefault();
      openIn(go[0], go[1], { ship: go[2], newTab: true });
    });
  }
  // Escape used to close the overlays. A tab is closed by its own close,
  // so here Escape only lets go of a field.
  addEventListener('keydown', (e) => {
    const a = document.activeElement;
    if (e.key === 'Escape' && a && a !== document.body && toolHost.contains(a)) a.blur();
  });

  // ── today's brief ────────────────────────────────────────────────────────
  // orrery writes the brief to journal/<day>. Whether that day is padded is
  // not settled, so the first of the two forms that exists wins, and with
  // neither the unpadded one is the name a new page starts with.
  const briefForms = (d) => {
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    const p2 = (n) => String(n).padStart(2, '0');
    return ['journal/' + y + '.' + m + '.' + day, 'journal/' + y + '.' + p2(m) + '.' + p2(day)];
  };
  const hasPage = (k) => nodes.some((n) => n.page && n.path === k);
  function briefKey(d) {
    const forms = briefForms(d);
    return forms.find(hasPage) || forms[0];
  }
  async function openBrief(ev) {
    const d = new Date();
    let key = briefKey(d);
    let found = hasPage(key);
    // an empty tree has not loaded yet, so the ship says which form exists.
    // Opening a missing page would leave the tab blank and locked.
    if (!nodes.length) {
      for (const k of briefForms(d)) {
        const r = await fetch(api + '/page-source?name=' + encodeURIComponent(k)).catch(() => null);
        if (r && r.ok) { key = k; found = true; break; }
      }
    }
    if (found) return openIn('page', key, { ev });
    await openIn('page', '', { ev });
    if (activeTab && activeTab.kind === 'page' && !activeTab.key && current === null)
      setOpen(null, { shown: key });
  }

  // ── leaving the editor ───────────────────────────────────────────────────
  // Browser, Forum and Explorer navigate the window. The front document gets
  // guardDirty, and the parked tabs holding unsaved work get one question
  // naming them. Once the user has said discard, nothing is owed, so the
  // unload guard (35-pages.js) does not ask a second time.
  // With autosave off the parked tabs hold ordinary unsaved pages, so the
  // question offers to save them all, each brought forward and saved in
  // turn. One that does not save stops the leaving, with it in front.
  const leaveThen = (go) => tabSerial(async () => {
    if (!(await guardDirty())) return;
    const bg = tabs.filter((t) => t !== activeTab && t.snap && t.snap.dirty);
    const names = bg.map((t) => TAB_KINDS[t.kind].label(t)).join(', ');
    if (bg.length && autosaveOn()) {
      if (!(await askConfirm('discard unsaved changes to ' + names + '?', 'discard'))) return;
    } else if (bg.length) {
      const pick = await askChoice('unsaved changes to ' + names + '. save them?',
        ['save all', 'discard']);
      if (pick === null) return;
      if (pick === 'save all') {
        for (const t of bg) {
          if ((await tabTo(t)) === false) return;
          if (!(await saveNow())) return;
        }
      }
    }
    dirty = false;
    clearTimeout(autoTimer);
    //  a saved tab came to the front, where it has no snap
    for (const t of bg) if (t.snap) t.snap.dirty = false;
    await go();
  });
  const leaveTo = (url) => leaveThen(() => { location.href = url; });
  // Settings > Connection and mounts, and Settings > Backup > Scheduled
  // backups (section 'backups'), on the desktop. The shell rebuilds the
  // window onto its own manager page (open_manager in
  // desktop/src/commands.rs), and no unload guard sees a window go, so the
  // same questions come first.
  window.latOpenManager = (section) => leaveThen(async () => {
    try { await window.__TAURI__.core.invoke('open_manager', { section: section || null }); }
    catch (e) { st('could not open the desktop settings: ' + e, false); }
  });

  // the Settings tab, opened or focused, with its frame scrolled to the
  // section #anchor. A frame still loading scrolls once it has. Sections
  // above the anchor fill in after load (the key list), so the anchor is
  // held at the top while the page settles, until the user scrolls or
  // clicks or two seconds pass. Preferences on the desktop does not come
  // here: it opens the manager page (latOpenManager above).
  function frameScroll(f, anchor) {
    let d = null;
    try { d = f.contentDocument; } catch {}
    const e = d && d.getElementById(anchor);
    if (!e) return false;
    e.scrollIntoView({ block: 'start' });
    const ro = new f.contentWindow.ResizeObserver(() => e.scrollIntoView({ block: 'start' }));
    ro.observe(d.body);
    const stop = () => ro.disconnect();
    setTimeout(stop, 2000);
    for (const t of ['wheel', 'keydown', 'pointerdown', 'touchstart'])
      d.addEventListener(t, stop, { once: true });
    return true;
  }
  window.latOpenSettings = async (anchor) => {
    await toolOpen('settings');
    const f = [...toolHost.querySelectorAll('iframe')].find((x) => x.dataset.tool === SETTINGS);
    if (!f || !anchor) return;
    let ready = false;
    try { ready = f.contentDocument.readyState === 'complete' && f.contentDocument.URL !== 'about:blank'; } catch {}
    if (ready && frameScroll(f, anchor)) return;
    f.addEventListener('load', () => frameScroll(f, anchor), { once: true });
  };

  // the command palette (26-palette.js) sets this to its opener
  let paletteOpen = () => {};

  // top to bottom, with Settings in the lower group
  ribbonAdd({ id: 'brief', icon: 'cal', name: "Today's brief", run: (ev) => openBrief(ev) });
  ribbonAdd({ id: 'browser', icon: 'globe', name: 'Browser', run: () => leaveTo('/apps/lattice') });
  ribbonAdd({ id: 'forum', icon: 'forum', name: 'Forum', run: () => leaveTo('/apps/lattice/forum') });
  // the unread badge (73-comments.js) and the conflict count
  // (80-conflicts.js) are painted onto these two
  ribbonAdd({ id: 'inbox', icon: 'inbox', name: 'Comments inbox', run: () => toolOpen('inbox') });
  ribbonAdd({ id: 'access', icon: 'key', name: 'Access & groups', run: () => toolOpen('access') });
  ribbonAdd({ id: 'explorer', icon: 'tree', name: 'Explorer', run: () => leaveTo('/apps/lattice/x') });
  ribbonAdd({ id: 'conflicts', icon: 'conflict', name: 'Sync conflicts', run: () => toolOpen('conflicts') })
    .hidden = true;
  ribbonAdd({ id: 'palette', icon: 'term', name: 'Command palette', keys: 'Ctrl+P', run: () => paletteOpen() });
  ribbonAdd({ id: 'settings', icon: 'gear', name: 'Settings', bottom: true, run: () => toolOpen('settings') });
