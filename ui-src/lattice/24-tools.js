  // ── tool tabs and the ribbon ─────────────────────────────────────────────
  // A tool tab holds no document: the comments inbox, access & groups, the
  // sync conflicts, or a same-origin page in a frame (Settings, the memory
  // review, the forum, the explorer, a browser). Its key names the tool
  // ('inbox', 'access', 'conflicts') or the frame
  // ('frame:/apps/lattice/settings'). While one is in front of its group
  // the group's document area is hidden and the group's own tool host
  // (.toolhost, 28-splits.js) takes its place. Each group has one, so a
  // frame never moves (a moved frame reloads) when another group comes to
  // the front; the one in front is #toolhost. The editor underneath keeps
  // whatever the parked tab left there, untouched: the tool kind has no
  // live(), so nothing a tool does is ever filed under a document's tab.
  const allFrames = () => [...document.querySelectorAll('.toolhost iframe')];
  const frameOf = (key) => allFrames().find((f) => f.dataset.tool === key);
  // where a tool's wrap waits while no group shows it
  const toolStash = document.createElement('div');
  toolStash.hidden = true;
  document.body.append(toolStash);

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
    '/apps/lattice': ['Browser', 'globe'],
    '/apps/lattice/forum': ['Forum', 'forum'],
    '/apps/lattice/x': ['Explorer', 'tree'],
  };
  // the tools a frame opens by name: Settings, and the two browsing frames
  // that are one tab each. A browser is a new tab every time (browseIn).
  const FRAME_KEYS = {
    settings: 'frame:/apps/lattice/settings',
    forum: 'frame:/apps/lattice/forum',
    explorer: 'frame:/apps/lattice/x',
  };
  const SETTINGS = FRAME_KEYS.settings;
  // A browsing frame (the reader, the forum, the explorer) is navigated
  // inside, so its tab is titled by the page it is on, and its group shows
  // the frame header (29-fhead.js): Back, Forward and the omnibar, the way
  // to an urb:// address. Settings and the memory review are single pages
  // with no header. Every frame's own reader bar is hidden.
  // only a lattice path on this origin, whatever the key says: a frame is
  // dressed by reaching into it, and a key can come from typed input
  const frameUrl = (key) => {
    if (!key.startsWith('frame:')) return null;
    let u;
    try { u = new URL(key.slice(6), location.origin); } catch { return null; }
    if (u.origin !== location.origin || !/^\/apps\/lattice(\/|$)/.test(u.pathname)) return null;
    return u.pathname + u.search;
  };
  const SINGLE = ['/apps/lattice/settings', '/apps/lattice/know?lint=1'];
  const browsing = (key) => { const u = frameUrl(key); return !!u && !SINGLE.includes(u); };
  const toolMeta = (key) => {
    if (TOOLS[key]) return [TOOLS[key].name, TOOLS[key].icon];
    const u = frameUrl(key);
    return u ? FRAMES[u] || ['Browser', 'globe'] : [key, 'gear'];
  };
  // every way into a tool. A tool gets a tab of its own rather than
  // replacing the document in front, and an open one is focused. On a phone
  // the drawer it was opened from goes away, also when the tool was in
  // front already.
  const toolOpen = async (id) => {
    await openIn('tool', FRAME_KEYS[id] || id, { newTab: true });
    drawersClose();
  };
  // a browser tab at `url` (the reader home by default), new every time:
  // the key carries a #fragment of its own, which the frame's address
  // drops (frameUrl), so two tabs can show the same page
  const browseIn = async (url = '/apps/lattice') => {
    await openIn('tool', 'frame:' + url + '#b' + Date.now().toString(36)
      + (++browseSeq), { newTab: true });
    drawersClose();
  };
  let browseSeq = 0;

  // which tool the host shows, null while a document is in front
  let toolShown = null;
  // a browsing frame's page title, by tab key (frameDress)
  const frameTitles = {};
  // every frame the observer below watches (frameSeen)
  const frameSeenAll = new Set();
  TAB_KINDS.tool = {
    icon: (t) => toolMeta(t.key)[1],
    // a browsing frame's tab follows the title of the page it is on
    label: (t) => (browsing(t.key) && frameTitles[t.key]) || toolMeta(t.key)[0],
    open: async (t) => {
      toolSync();
      if (TOOLS[t.key]) TOOLS[t.key].load();
      return true;
    },
    // a tool has no buffer, so nothing to park and nothing to restore
    restore: () => {},
    park: async () => true,
    shows: (t) => t === activeTab && toolShown === t.key,
    // a frame holding text typed and not sent (a forum post, a settings
    // field) is not closed unasked (closeTab, 21-tabs.js)
    held: (t) => frameTyped(t.key),
  };
  // Whether a frame tab's page, or a same-origin frame in it (the reader's
  // comment box), holds a text field the user has typed into: not empty,
  // and not what the page put there. The reader's bar is left out, since
  // its omnibar always holds the address.
  const TEXTY = ['text', 'search', 'url', 'email', 'tel', 'number'];
  function frameTyped(key) {
    const f = frameOf(key);
    let d = null;
    try { d = f && f.contentDocument; } catch {}
    if (!d) return false;
    const docs = [d];
    for (const i of d.querySelectorAll('iframe')) {
      try { if (i.contentDocument) docs.push(i.contentDocument); } catch {}
    }
    return docs.some((doc) => [...doc.querySelectorAll('textarea, input')].some((el) =>
      !el.closest('form.bar') && !el.disabled && !el.readOnly
      && (el.tagName === 'TEXTAREA' || TEXTY.includes(el.type))
      && el.value.trim() !== '' && el.value !== el.defaultValue));
  }

  // Called by paintHead on every change of the tab in front. In each group,
  // shows the host or the document area, and in the host only that group's
  // front tool. A wrap that is not in front of a group is hidden, which is
  // how 90-sync.js knows the inbox is not being read. A frame whose tab has
  // closed goes away.
  function toolSync() {
    const t = activeTab && activeTab.kind === 'tool' ? activeTab : null;
    const was = toolShown;
    toolShown = t ? t.key : null;
    $('docarea').hidden = !!t;
    const open = allTabs();
    for (const f of allFrames())
      if (!open.some((x) => x.kind === 'tool' && x.key === f.dataset.tool)) {
        delete frameTitles[f.dataset.tool];
        delete fnav[f.dataset.tool];
        f.remove();
      }
    // a frame that left the page (closed here, or with its group, gDrop
    // in 28-splits.js) is let go: the observer would hold it for good
    for (const f of frameSeenAll)
      if (!f.isConnected) { frameSeen.unobserve(f); frameSeenAll.delete(f); }
    for (const g of groups) {
      const f = gFront(g);
      const key = f && f.kind === 'tool' ? f.key : null;
      g.host.hidden = !key;
      if (key) toolMount(key, g.host);
      for (const c of g.host.children) c.hidden = c.dataset.tool !== key;
      fhSync(g, key);
    }
    // a browsing tab's header stands in for the tab header (29-fhead.js)
    $('tabhead').hidden = !!t && browsing(t.key);
    // a wrap no group has in front waits in the stash, hidden
    for (const c of [...document.querySelectorAll('.toolhost > .intab')])
      if (!groups.some((g) => c.parentNode === g.host && !c.hidden)) { c.hidden = true; toolStash.append(c); }
    // the right pane goes by what is in front (76-outline.js)
    if (was !== toolShown) rpSoon();
  }
  // A frame in a hidden element still reads document.hidden false, so a
  // parked reader page kept its live stream open (+sse-script, app.hoon),
  // and six of them took every connection the browser gives this host:
  // the editor's saves then queued with no error. So each frame is told
  // when it is shown or put away, and its stream follows. A frame is
  // shown when it has a box: its tab can be parked, its host hidden, or
  // on a phone its group not the one in front (a CSS rule, index.html),
  // and a ResizeObserver hears each of them, after layout. The page's own
  // scripts (+page-cache-script) used to poll the frame's box ten times
  // a second instead, each poll a forced layout of the editor.
  const frameSeen = new ResizeObserver((es) => {
    for (const { target: f } of es) {
      const on = f.isConnected && f.getClientRects().length > 0;
      if (f.latOn === on) continue;
      f.latOn = on;
      try { f.contentWindow.dispatchEvent(new f.contentWindow.Event(on ? 'latshown' : 'lathidden')); }
      catch {}
    }
  });
  // into `toolHost`, a group's host. A frame there already stays; one in
  // another group's host (its tab was moved) moves, and reloads.
  function toolMount(key, toolHost) {
    if (TOOLS[key]) {
      const w = $(TOOLS[key].wrap);
      if (!w) return;
      w.classList.add('intab');
      w.dataset.tool = key;
      if (w.parentNode !== toolHost) toolHost.append(w);
      return;
    }
    const url = frameUrl(key);
    const had = frameOf(key);
    if (had) { if (had.parentNode !== toolHost) toolHost.append(had); return; }
    if (!url) return;
    const f = document.createElement('iframe');
    f.className = 'toolframe';
    f.dataset.tool = key;
    f.title = toolMeta(key)[0];
    // a name, so a form or link in it aimed at _top lands here (frameDress)
    f.name = 'latframe' + (++frameSeq);
    // Nothing in a frame may replace the editor's window: no top
    // navigation token, which holds for every frame nested in it too (a
    // page served sandboxed whose CSP would allow it, a site the frame
    // went to, a script setting top.location). Same origin and scripts
    // stay, for frameDress and the pages themselves.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups '
      + 'allow-popups-to-escape-sandbox allow-modals allow-downloads');
    // a load counts as activity only when the user's own event in the frame
    // led to it, within 10 s: a page that reloads itself on each keep event
    // must not hold the background lane shut
    f.onload = () => { if (Date.now() - (f.latAct || 0) < 10000) bgBusy(); fnavLoad(f); frameDress(f); };
    f.src = url;
    toolHost.append(f);
    frameSeen.observe(f);
    frameSeenAll.add(f);
  }
  let frameSeq = 0;
  // Each load of a frame. Every frame loses the reader's bar, since the
  // shell around it is the chrome: a browsing frame's group has the frame
  // header instead (29-fhead.js), and the bar's menu entries (editor,
  // knowledge, bookmarks, forum, settings) are ribbon buttons or pane tabs
  // of the shell already.
  // The tab takes the page's title. A link in it to a document in the
  // editor opens that document in a new tab of the shell, never over the
  // frame's own tab and never as a second editor nested in the frame. A
  // link carrying data-lat-tool (Settings > Advanced) opens that tool's
  // tab. Any other link navigates the frame as usual, and so does whatever
  // aims at _top (the reader's comment box): the whole window is the
  // editor's, never a page's to replace.
  function frameDress(f) {
    let d = null;
    try { d = f.contentDocument; } catch {}
    if (!d || !d.head) return;
    const key = f.dataset.tool;
    // the editor's note marks its frame (00-framed.js); anywhere else clears it
    if (!editorGo(d.URL)) delete f.dataset.latEd;
    frameTheme(f);
    // the frame's own theme.js rewrites these on <html>, so they go back on
    new MutationObserver(() => frameTheme(f))
      .observe(d.documentElement, { attributes: true, attributeFilter: ['style'] });
    const s = d.createElement('style');
    s.textContent = 'form.bar,form.cbar{display:none}';
    d.head.append(s);
    if (browsing(key)) {
      const title = () => {
        const t = d.title.trim();
        if (!t || frameTitles[key] === t) return;
        frameTitles[key] = t;
        paintTabs();
      };
      title();
      new MutationObserver(title).observe(d.head, { childList: true, subtree: true, characterData: true });
    }
    // _top and _parent are re-aimed here once at load, and again as a
    // link is followed or a form sent, which covers one a script adds
    // later. The frame's sandbox would only block the navigation.
    //
    // A frame inside the frame (the reader's srcdoc page, where the own
    // page's comment box lives) takes on the sandbox, and a sandboxed frame
    // may not navigate its parent: the box's post did nothing. So there a
    // link or form aimed at the frame tab is stopped and sent again from
    // this window, which may navigate any frame below it. An editor link
    // there opens the shell's tab, as in the frame's own document.
    const topish = (el, at) => !!el && /^_(top|parent)$/i.test(el.getAttribute(at) || '');
    const upward = (el, at) => topish(el, at) || (!!el && el.getAttribute(at) === f.name);
    //
    // In an inner doc the check runs last, on its window as the event
    // bubbles out, so the page's own handlers have had their say: one that
    // called preventDefault (a fetch-on-submit) is left alone. In the
    // frame's own doc it only re-aims, so it runs first, as it always did.
    const aimTop = (doc, inner) => {
      if (doc.latAimed) return;
      doc.latAimed = true;
      // what is done in the frame, the comment box's frame included, is done
      // in the shell (bgFetch, 10-shell.js)
      const act = () => { f.latAct = Date.now(); bgBusy(); };
      for (const t of ['pointerdown', 'keydown', 'input', 'click']) doc.addEventListener(t, act, true);
      for (const el of doc.querySelectorAll('[target=_top], [target=_parent]')) el.target = f.name;
      const on = inner ? (doc.defaultView || doc) : doc;
      on.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href], area[href]');
        if (!a) return;
        if (inner && !e.defaultPrevented) {
          const go = editorGo(a.href);
          if (go) { e.preventDefault(); editorOpen(go); return; }
          if (upward(a, 'target')) { e.preventDefault(); if (/^https?:/.test(a.href)) f.contentWindow.location.assign(a.href); }
          return;
        }
        if (topish(a, 'target')) a.target = f.name;
      }, !inner);
      on.addEventListener('submit', (e) => {
        const form = e.target;
        const sub = e.submitter;
        if (inner) {
          const up = sub && sub.hasAttribute('formtarget') ? upward(sub, 'formtarget') : upward(form, 'target');
          if (!up || e.defaultPrevented) return;
          e.preventDefault();
          formAgain(form, sub, f.name);
          return;
        }
        if (topish(form, 'target')) form.target = f.name;
        if (topish(sub, 'formtarget')) sub.formTarget = f.name;
      }, !inner);
    };
    aimTop(d, false);
    // the reader shows a page in a frame of its own (srcdoc), where the
    // comment box lives. A sandboxed one (a peer's page) is out of reach,
    // and has no box.
    for (const i of d.querySelectorAll('iframe')) {
      const inner = () => { try { if (i.contentDocument) aimTop(i.contentDocument, true); } catch {} };
      inner();
      i.addEventListener('load', inner);
    }
    // a key pressed in the frame never reaches this window, so the shell's
    // own chords (the palette, Search, Files) are handed up to it
    d.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const ours = (mod && !e.altKey && !e.shiftKey && (k === 'k' || k === 'p'))
        || (mod && e.shiftKey && !e.altKey && (k === 'f' || e.code === 'KeyL'));
      if (!ours) return;
      const up = new KeyboardEvent('keydown', { key: e.key, code: e.code, ctrlKey: e.ctrlKey,
        metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true });
      dispatchEvent(up);
      if (up.defaultPrevented) e.preventDefault();
    });
    d.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || e.defaultPrevented) return;
      if (a.dataset.latTool && FRAME_KEYS[a.dataset.latTool]) {
        e.preventDefault();
        toolOpen(a.dataset.latTool);
        return;
      }
      const go = editorGo(a.href);
      if (!go) return;
      e.preventDefault();
      editorOpen(go);
    });
  }
  // What an address of the editor asks for, null when it is not one: the
  // editor (/app, and /edit, which redirects there) with a document, a
  // folder to start a file in (?into=), or nothing in particular. An asset
  // under /app/ is not the editor.
  function editorGo(href) {
    let u;
    try { u = new URL(href, location.href); } catch { return null; }
    if (u.origin !== location.origin || !/^\/apps\/lattice\/(app|edit)\/?$/.test(u.pathname)) return null;
    const q = u.searchParams;
    return q.get('grub') ? ['grub', q.get('grub'), q.get('ship') || null]
      : q.get('view') === 'know' ? ['know', q.get('key') || '', null]
        : q.get('name') ? ['page', q.get('name'), null]
          : q.get('into') ? ['into', q.get('into')] : ['shell'];
  }
  // A document opens in a new tab of its own, never over the frame's. A
  // folder gets a new page tab started in it, as ?into= did at boot. The
  // bare editor is the shell itself: the nearest document tab comes to the
  // front, or a new page when there is none.
  async function editorOpen(go) {
    if (go[0] === 'into') {
      if (!(await docTab())) return;
      if (nodes.some((n) => !n.page && n.path === go[1])) selectFolder(go[1]);
      else newFile(go[1], false);
      return;
    }
    if (go[0] === 'shell') {
      const i = tabs.indexOf(activeTab);
      const docs = tabs.filter((t) => t.kind !== 'tool');
      const near = docs.filter((t) => tabs.indexOf(t) < i).pop() || docs[0];
      if (near) await switchTab(near.id);
      else await docTab();
      return;
    }
    await openIn(go[0], go[1], { ship: go[2], newTab: true });
  }
  // the editor's own page loaded in a frame anyway (00-framed.js) hands
  // its address here and does not start. Only from the frame tab in front
  // (or a frame inside it): a parked one has nothing the user just did.
  window.latFrameEditor = (href, from) => {
    let w = from;
    try { while (w && w.parent !== window) w = w === w.parent ? null : w.parent; } catch { w = null; }
    const f = w && allFrames().find((x) => x.contentWindow === w);
    if (!f || f.hidden || f.closest('.toolhost').hidden) return false;
    const go = editorGo(href);
    if (!go) return false;
    editorOpen(go);
    return true;
  };
  // A form from a frame inside a frame tab, sent again from this window
  // into the tab's frame `name`: the same method, encoding, address and
  // fields, the button that sent it included. Files go over in a file
  // input of their own. Read as attributes: a field named `action` or
  // `method` shadows the form's own properties (form.action would be the
  // input), so the replay would post to "[object HTMLInputElement]".
  function formAgain(form, sub, name) {
    const g = document.createElement('form');
    const attr = (k, fk) => (sub && sub.hasAttribute(fk) ? sub.getAttribute(fk) : form.getAttribute(k));
    g.hidden = true;
    g.method = attr('method', 'formmethod') || 'get';
    //  a dialog form closes its dialog and sends nothing; only http(s) goes
    if (/^dialog$/i.test(g.getAttribute('method'))) return;
    g.enctype = attr('enctype', 'formenctype') || 'application/x-www-form-urlencoded';
    const act = attr('action', 'formaction');
    g.action = act ? new URL(act, form.baseURI).href : form.ownerDocument.URL;
    if (!/^https?:/.test(g.action)) return;
    const cs = form.getAttribute('accept-charset');
    if (cs) g.acceptCharset = cs;
    if (form.hasAttribute('novalidate') || (sub && sub.hasAttribute('formnovalidate'))) g.noValidate = true;
    g.target = name;
    const files = {};
    let fd;
    // a webview whose FormData takes no submitter gets the button by hand
    try { fd = new FormData(form, sub || undefined); }
    catch { fd = new FormData(form); if (sub && sub.name) fd.append(sub.name, sub.value); }
    for (const [k, v] of fd) {
      if (typeof v === 'string') {
        const i = document.createElement('input');
        i.type = 'hidden';
        i.name = k;
        i.value = v;
        g.append(i);
      } else (files[k] = files[k] || []).push(v);
    }
    for (const [k, vs] of Object.entries(files)) {
      const dt = new DataTransfer();
      for (const v of vs) if (v.name || v.size) dt.items.add(v);
      const i = document.createElement('input');
      i.type = 'file';
      i.name = k;
      i.multiple = true;
      i.files = dt.files;
      g.append(i);
    }
    document.body.append(g);
    g.submit();
    g.remove();
  }
  // A frame wears the shell's look. theme.js sets the theme's colours inline
  // on <html> in every document, but with no theme (mode system) it sets
  // none and each stylesheet keeps its own: the shell's goes dark with the
  // system, the forum's does not. So the shell's inline colours are copied
  // onto each frame, and its ground, ink and scheme as it shows them, again
  // whenever the shell's change (a theme picked, the system going dark).
  const THEME_KEYS = ['color-scheme', '--bg', '--text', '--muted', '--pop', '--accent',
    '--accent-deep', '--on-accent', '--accent-tint', '--secondary', '--tertiary', '--link',
    '--raised', '--error', '--selection', '--border', '--border-soft', '--font'];
  const darkMq = matchMedia('(prefers-color-scheme: dark)');
  function frameTheme(f) {
    let d = null;
    try { d = f.contentDocument; } catch {}
    if (!d || !d.documentElement) return;
    const hs = document.documentElement.style;
    const cs = getComputedStyle(document.documentElement);
    const fs = d.documentElement.style;
    const shown = {
      'color-scheme': /dark/.test(cs.colorScheme) && (darkMq.matches || !/light/.test(cs.colorScheme))
        ? 'dark' : 'light',
      '--bg': cs.getPropertyValue('--bg').trim(),
      '--text': cs.getPropertyValue('--text').trim(),
    };
    for (const k of THEME_KEYS) {
      const v = hs.getPropertyValue(k).trim() || shown[k] || '';
      if (v && fs.getPropertyValue(k).trim() !== v) fs.setProperty(k, v);
      else if (!v && fs.getPropertyValue(k)) fs.removeProperty(k);
    }
  }
  const framesTheme = () => {
    for (const f of allFrames()) frameTheme(f);
  };
  addEventListener('lattheme', framesTheme);
  darkMq.addEventListener('change', framesTheme);
  new MutationObserver(framesTheme)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  // Escape used to close the overlays. A tab is closed by its own close,
  // so here Escape only lets go of a field.
  addEventListener('keydown', (e) => {
    const a = document.activeElement;
    if (e.key === 'Escape' && a && a !== document.body && a.closest && a.closest('.toolhost')) a.blur();
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
  // Only the desktop's manager page takes the window now (Browser, Forum
  // and Explorer are tabs). The front document gets guardDirty, and the
  // parked tabs holding unsaved work get one question naming them. Once
  // the user has said discard, nothing is owed, so the unload guard
  // (35-pages.js) does not ask a second time.
  // With autosave off the parked tabs hold ordinary unsaved pages, so the
  // question offers to save them all, each brought forward and saved in
  // turn. One that does not save stops the leaving, with it in front.
  const leaveThen = (go) => tabSerial(async () => {
    if (!(await guardDirty())) return;
    // a group left a moment ago is still saving its tab in the background
    // (saveParked, 35-pages.js): what lands is not asked about
    await savesSettled();
    const bg = allTabs().filter((t) => t !== activeTab && t.snap && t.snap.dirty);
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
    const f = frameOf(SETTINGS);
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
  ribbonAdd({ id: 'browser', icon: 'globe', name: 'Browser', run: () => browseIn() });
  ribbonAdd({ id: 'forum', icon: 'forum', name: 'Forum', run: () => toolOpen('forum') });
  // the unread badge (73-comments.js) and the conflict count
  // (80-conflicts.js) are painted onto these two
  ribbonAdd({ id: 'inbox', icon: 'inbox', name: 'Comments inbox', run: () => toolOpen('inbox') });
  ribbonAdd({ id: 'access', icon: 'key', name: 'Access & groups', run: () => toolOpen('access') });
  ribbonAdd({ id: 'conflicts', icon: 'conflict', name: 'Sync conflicts', run: () => toolOpen('conflicts') })
    .hidden = true;
  ribbonAdd({ id: 'palette', icon: 'term', name: 'Command palette', keys: 'Ctrl+K', run: () => paletteOpen() });
  ribbonAdd({ id: 'settings', icon: 'gear', name: 'Settings', bottom: true, run: () => toolOpen('settings') });
  // The explorer is a power tool: no ribbon button. Its home is the link in
  // Settings > Advanced, which lives in the Settings frame and so outside
  // this document, the one action the palette lists without a home here
  // (PALETTE_ONLY, 26-palette.js).
  action({ id: 'explorer', name: 'Explorer', home: 'Settings › Advanced',
    run: () => toolOpen('explorer') });
