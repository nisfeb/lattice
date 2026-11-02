  // ── the frame header: a browsing tab's back, forward and address ─────────
  // A browsing frame (the reader, the forum, the explorer, 24-tools.js) used
  // to keep the reader's bar inside its page: a second, taller row of
  // chrome in a style of its own. The frame now hides that bar and its
  // group shows this header instead, one per group (28-splits.js), above the
  // group's tool host, for the browsing tab in front of that group. Two
  // browser tabs side by side each show their own address.
  //
  // On a phone (the 820px block) the group in front is the only one shown,
  // and its header sits in the top row between the two drawer toggles, with
  // no Forward: the page gets the row the header would take.
  //
  // History is the shell's, per tab. A frame's own history.back() walks the
  // window's joint history, which takes back whichever frame navigated last,
  // so the in-frame Back of one tab could undo another's. Here each tab
  // keeps the addresses its frame loaded, Back and Forward replace the
  // frame's page with the one before or after (location.replace, adding no
  // entry), and any other load (a link, a form, a redirect, Return here)
  // starts a new branch.
  //
  // location.replace refetches the page, about a second from the ship, where
  // the frame's own history.go comes back in well under 100ms. So `jh`
  // mirrors the joint history's entries made by frame loads, one tab key
  // each, and Back or Forward use history.go when the entry they would
  // cross is this tab's own. Anything that could put the mirror out of step
  // (a replace, a closed tab) clears it, and the replace path takes over.
  const fnav = {};   // tab key -> { back, fwd, cur, addr, go, bar, kept }
  const jh = { keys: [], pos: -1 };
  const jhClear = () => { jh.keys = []; jh.pos = -1; };
  const fnavOf = (key) => fnav[key] || (fnav[key] = { back: [], fwd: [], cur: null, addr: '', go: null, bar: null, kept: [] });
  // an address as the stacks hold it: less the service worker's u=sw<time>
  const fnavNorm = (url) => { try { const u = new URL(url); u.searchParams.delete('u'); return u.href; } catch { return url; } };

  // What the address field shows for a frame's page: the urb:// address or
  // query the reader's bar was served with, or else the page's route under
  // /apps/lattice (a forum board or thread, an explorer path). Home is
  // empty, so the field shows its placeholder.
  function fnavAddr(d) {
    if (!d) return '';
    const i = d.querySelector('form.bar input[name=url], form.cbar input[name=url]');
    if (i && i.value.trim()) return i.value.trim();
    let u;
    try { u = new URL(d.URL); } catch { return ''; }
    if (u.origin !== location.origin) return d.URL;
    // less the service worker's cache-buster (u=sw<time>), as its page
    // cache leaves it off
    u.searchParams.delete('u');
    const r = u.pathname.replace(/^\/apps\/lattice(?=\/|$)/, '') + u.search;
    return r === '' || r === '/' ? '' : r;
  }
  // Where Return goes, the frame bar's rule: a route (a leading /) is a
  // lattice page on this origin, anything else is what the bar's form sent,
  // the reader's ?url= (an urb:// address or a search).
  function fnavTarget(v) {
    v = v.trim();
    if (!v) return location.origin + '/apps/lattice';
    if (v.startsWith('/')) {
      const u = frameUrl('frame:' + (v.startsWith('/apps/') ? v : '/apps/lattice' + v));
      if (u) return location.origin + u;
    }
    return location.origin + '/apps/lattice?url=' + encodeURIComponent(v);
  }

  // each load of a browsing frame (toolMount's onload, before frameDress)
  function fnavLoad(f) {
    const key = f.dataset.tool;
    if (!key || !browsing(key)) return;
    const n = fnavOf(key);
    let url = null, d = null;
    try { d = f.contentDocument; url = f.contentWindow.location.href; } catch {}
    if (url === 'about:blank') return;
    // the service worker's reload adds u=sw<time>: the same page, not a step
    url = fnavNorm(url);
    // a frame made by a step (fkeepBeside): the stacks moved then
    if (f.latStep) f.latStep = false;
    else if (n.go) n.go = null;       // Back or Forward landed: the stacks moved then
    else if (n.cur !== null && url !== n.cur) {
      n.back.push(n.cur); n.fwd = [];
      jh.keys.length = jh.pos + 1; jh.keys.push(key); jh.pos++;
      fkeepTrim();
    }
    fnavShown(f, d, url);
    // the bar's star and orrery button paint after load
    if (n.bar) new MutationObserver(() => fhPaintKey(key))
      .observe(n.bar, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  // the tab's page is now `f`'s: the address, the bar and the title
  function fnavShown(f, d, url) {
    const key = f.dataset.tool;
    const n = fnavOf(key);
    n.cur = url;
    n.addr = fnavAddr(d);
    n.bar = d ? d.querySelector('form.bar, form.cbar') : null;
    fhPaintKey(key);
  }
  // 'back', 'fwd', or 'to' an address typed or picked
  function fnavGo(key, how, v) {
    const f = frameOf(key);
    if (!f) return;
    const n = fnavOf(key);
    if (how === 'to') {
      n.addr = v.trim();
      try { f.contentWindow.location.href = fnavTarget(v); } catch {}
      fhPaintKey(key);
      return;
    }
    const from = how === 'back' ? n.back : n.fwd;
    if (!from.length) return;
    const url = from.pop();
    const was = n.cur;
    if (n.cur !== null) (how === 'back' ? n.fwd : n.back).push(n.cur);
    // the page kept is shown again; with none, it opens beside this one,
    // which is kept for the step back
    const e = n.kept.find((x) => x.url === url && x.f.isConnected);
    if (e || fkeepCan(f)) {
      jhClear();
      if (e) fkeepSwap(key, f, e, was);
      else { n.cur = url; fkeepBeside(key, f, url, was); }
      fkeepTrim();
      fhPaintKey(key);
      return;
    }
    n.go = how;
    const at = how === 'back' ? jh.pos : jh.pos + 1;
    if (jh.keys[at] === key && jh.keys.every((k) => frameOf(k))) {
      jh.pos += how === 'back' ? -1 : 1;
      try { f.contentWindow.history.go(how === 'back' ? -1 : 1); } catch {}
    } else {
      jhClear();
      try { f.contentWindow.location.replace(url); } catch {}
    }
    fhPaintKey(key);
  }

  // ── kept documents ───────────────────────────────────────────────────────
  // Back in a frame used to be a navigation of the frame: commit, parse and
  // layout of the page before, about 60 ms, as frames get no back/forward
  // cache. Now the page a frame leaves stays alive beside it, hidden, and
  // Back or Forward show it again: a swap of two frames.
  //
  // Leaving is caught in the page (the Navigation API's navigate event): a
  // push to a lattice page on this origin (a link, a GET form, a script,
  // the address field) is stopped and opened in a new frame next to this
  // one, which is then kept. A POST, a reload, a replace, a page elsewhere
  // and an engine with no Navigation API (webkitgtk) navigate the frame as
  // before. The tab's frame is the one with data-tool, and its name moves
  // with it, so a form aimed at the tab lands in the frame shown.
  //
  // Fresh: a kept page is hidden, so frameSeen tells it lathidden, and its
  // live stream closes and its refetch clock stops, as in a parked tab.
  // Shown again it hears latshown, once it has stayed in sight 0.3 s (the
  // wait a cached paint makes before its refetch), and catches up the same
  // way: a refetch (+sse-script), then location.replace when the page
  // changed meanwhile.
  //
  // Bounded: two kept per tab (the ones nearest its page), six in all (two
  // on a device with 2 GB or less), none older than five minutes, and all
  // let go when the shell has been hidden a minute or is frozen, or when
  // the JS heap is over 60% of its limit.
  const KEEP_TAB = 2, KEEP_MS = 5 * 60 * 1000, KEEP_QUIET = 300;
  const KEEP_ALL = (navigator.deviceMemory || 8) <= 2 ? 2 : 6;
  let keepTimer = 0, keepHid = 0;
  // (a suite shortens the time with localStorage.latKeepMs)
  const keepMs = () => (+localStorage.latKeepMs) || KEEP_MS;
  const keptAll = () => Object.values(fnav).flatMap((n) => n.kept.map((e) => ({ n, e })));
  // whether a step may open a frame beside `f`: only where leaving is caught
  const fkeepCan = (f) => { try { return KEEP_ALL > 0 && !!f.contentWindow.navigation; } catch { return false; } };
  const frameGone = (f) => { frameSeen.unobserve(f); frameSeenAll.delete(f); f.remove(); };
  function fkeepDrop(n, e) {
    n.kept = n.kept.filter((x) => x !== e);
    frameGone(e.f);
  }
  function fkeepDropKey(key) {
    const n = fnav[key];
    if (n) for (const e of n.kept.slice()) fkeepDrop(n, e);
  }
  const heapFull = () => {
    try { const m = performance.memory; return !!m && m.usedJSHeapSize > 0.6 * m.jsHeapSizeLimit; }
    catch { return false; }
  };
  // how many steps from the tab's page a kept one is, by its stacks
  const keptSteps = (n, e) => Math.min(...[n.back, n.fwd].map((s) => {
    const i = s.lastIndexOf(e.url);
    return i < 0 ? Infinity : s.length - 1 - i;
  }));
  // let go of what the bound says, `all` for everything
  function fkeepTrim(all) {
    const now = Date.now();
    const full = !all && heapFull();
    for (const n of Object.values(fnav))
      for (const e of n.kept.slice())
        if (all || full || !e.f.isConnected || now - e.at > keepMs() || keptSteps(n, e) === Infinity) fkeepDrop(n, e);
    for (const n of Object.values(fnav)) {
      const ks = n.kept.slice().sort((a, b) => keptSteps(n, b) - keptSteps(n, a));
      while (ks.length > KEEP_TAB) fkeepDrop(n, ks.shift());
    }
    const every = keptAll().sort((a, b) => a.e.at - b.e.at);
    while (every.length > KEEP_ALL) { const x = every.shift(); fkeepDrop(x.n, x.e); }
    // one no tab holds any more: its tab closed
    const held = new Set(keptAll().map((x) => x.e.f));
    for (const f of document.querySelectorAll('.toolhost iframe[data-kept]')) if (!held.has(f)) frameGone(f);
    clearTimeout(keepTimer);
    keepTimer = held.size ? setTimeout(() => fkeepTrim(), 60000) : 0;
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(keepHid);
    if (document.hidden) keepHid = setTimeout(() => fkeepTrim(true), 60000);
  });
  document.addEventListener('freeze', () => fkeepTrim(true));
  // `f` is the tab's frame no more; kept as `url`, or let go with none
  // The name goes with the window too: Chrome leaves a frame's window
  // name as it was when the attribute changes, and a form aimed at the
  // tab (formAgain) then went to the kept page, the first of the two.
  const frameName = (f, n) => {
    f.name = n;
    try { f.contentWindow.name = n; } catch {}
  };
  function fkeepPark(key, f, url) {
    delete f.dataset.tool;
    f.dataset.kept = key;
    frameName(f, '');
    if (!url || KEEP_ALL < 1) { frameGone(f); return; }
    fnavOf(key).kept.push({ f, url, at: Date.now() });
  }
  // a new frame for the tab at `url`, beside `f`, which is kept as `was`
  function fkeepBeside(key, f, url, was) {
    const g = frameMake(key, url);
    g.name = f.name;
    g.latAct = f.latAct;
    g.latStep = true;
    f.parentNode.insertBefore(g, f);
    fkeepPark(key, f, was);
    if (!f.isConnected) return g;
    // the page left stays painted over the new one until that one loads,
    // as a frame's own navigation holds its old paint
    f.classList.add('fcover');
    const un = () => { f.classList.remove('fcover'); if (!f.dataset.tool) f.hidden = true; };
    g.addEventListener('load', un, { once: true });
    setTimeout(un, 3000);
    return g;
  }
  // the kept `e` is the tab's frame again, and `f` is kept as `was`
  function fkeepSwap(key, f, e, was) {
    const n = fnavOf(key);
    const k = e.f;
    n.kept = n.kept.filter((x) => x !== e);
    const name = f.name;
    fkeepPark(key, f, was);
    frameName(k, name);
    if (f.isConnected) { f.classList.remove('fcover'); f.hidden = true; }
    // it hears latshown once it has stayed in sight a beat (frameSeen)
    k.latQuiet = Date.now() + KEEP_QUIET;
    delete k.dataset.kept;
    k.dataset.tool = key;
    k.classList.remove('fcover');
    k.hidden = false;
    let d = null;
    try { d = k.contentDocument; } catch {}
    fnavShown(k, d, e.url);
    const t = d && d.title.trim();
    if (t && frameTitles[key] !== t) { frameTitles[key] = t; paintTabs(); }
    if (k.latStale) {
      const u = k.latStale;
      k.latStale = null;
      try { k.contentWindow.location.replace(u); } catch {}
    }
  }
  // catch the page in `f` leaving (frameDress, at each load)
  function fkeepWatch(f, d, key) {
    const nav = d.defaultView && d.defaultView.navigation;
    if (!nav || KEEP_ALL < 1) return;
    nav.addEventListener('navigate', (e) => {
      // A kept page goes nowhere out of sight: what it asks for meanwhile
      // (its catch-up's replace, landing after Forward hid it) waits until
      // it is shown again (fkeepSwap). It went out as a navigation under
      // the request of whatever was clicked next.
      if (f.dataset.tool !== key) {
        if (f.dataset.kept === key && e.cancelable && !e.destination.sameDocument && !e.formData) {
          e.preventDefault();
          f.latStale = e.destination.url;
        }
        return;
      }
      if (e.navigationType !== 'push' || !e.cancelable || e.hashChange
        || e.destination.sameDocument || e.downloadRequest !== null || e.formData) return;
      let u;
      try { u = new URL(e.destination.url); } catch { return; }
      if (u.origin !== location.origin || !/^\/apps\/lattice(\/|$)/.test(u.pathname) || editorGo(u.href)) return;
      const n = fnavOf(key);
      const to = fnavNorm(u.href);
      if (n.cur === null || to === n.cur) return;
      e.preventDefault();
      jhClear();
      const was = n.cur;
      n.back.push(was);
      n.fwd = [];
      n.cur = to;
      fkeepBeside(key, f, u.href, was);
      fkeepTrim();
      fhPaintKey(key);
    });
  }
  // for the browser suites: what is kept, after a trim when asked
  window.latKept = (trim) => (trim && fkeepTrim(), keptAll()).map(({ e }) => ({ key: e.f.dataset.kept, url: e.url, at: e.at }));

  // ── the omnibar ──────────────────────────────────────────────────────────
  // An address field and its completion list: the reader's saved and
  // visited addresses (/omni-suggest), drawn in the shell's style. Arrow
  // keys move through the list, Return takes the row picked or else what is
  // typed, a tap on a row takes it, Escape gives up. `go` gets the address.
  function omniWire(inp, list, go) {
    let items = [], sel = -1, timer = 0, seq = 0;
    const hide = () => { list.hidden = true; sel = -1; };
    const pick = (i) => { const it = items[i]; hide(); if (it) go(it.url); };
    const draw = () => {
      list.textContent = '';
      if (!items.length) { hide(); return; }
      items.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'fhrow' + (i === sel ? ' on' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', i === sel ? 'true' : 'false');
        const s = document.createElement('span');
        s.className = 'fhsrc' + (it.source === 'bookmark' ? ' bookmark' : '');
        s.textContent = it.source === 'bookmark' ? 'saved' : 'visited';
        const t = document.createElement('span');
        t.className = 'fhttl';
        t.textContent = it.title || it.url;
        const u = document.createElement('span');
        u.className = 'fhurl';
        u.textContent = it.url;
        row.append(s, t, u);
        // the field keeps its focus through the press
        row.addEventListener('mousedown', (e) => e.preventDefault());
        row.addEventListener('click', () => pick(i));
        list.append(row);
      });
      list.hidden = false;
    };
    const fetchSug = async () => {
      const my = ++seq;
      let j = { items: [] };
      try {
        const r = await fetch(api + '/omni-suggest?q=' + encodeURIComponent(inp.value.trim()));
        if (r.ok) j = await r.json();
      } catch {}
      if (my !== seq || document.activeElement !== inp) return;
      items = j.items || [];
      sel = -1;
      draw();
    };
    const soon = () => { clearTimeout(timer); timer = setTimeout(fetchSug, 140); };
    inp.addEventListener('input', soon);
    inp.addEventListener('focus', () => { inp.select(); soon(); });
    inp.addEventListener('blur', () => { clearTimeout(timer); seq++; setTimeout(hide, 120); });
    inp.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !list.hidden) {
        e.preventDefault();
        sel = e.key === 'ArrowDown' ? Math.min(sel + 1, items.length - 1) : Math.max(sel - 1, -1);
        draw();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const i = list.hidden ? -1 : sel;
        hide();
        seq++;
        if (i >= 0) pick(i); else go(inp.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hide();
        inp.blur();
      }
    });
    return { hide };
  }

  // ── a group's header ─────────────────────────────────────────────────────
  function fhMake(g) {
    const h = document.createElement('div');
    h.className = 'fhead';
    h.hidden = true;
    h.innerHTML = sbtn('data-fh="back"', 'left', 'Back')
      + sbtn('data-fh="fwd"', 'right', 'Forward')
      + '<div class="fhomni"><input class="fhin" type="text" autocomplete="off" spellcheck="false"'
      + ' autocapitalize="off" enterkeyhint="go" aria-label="Address"'
      + ' placeholder="urb:// address or search your pages">'
      + '<div class="fhlist" role="listbox" aria-label="Suggestions" hidden></div></div>'
      + '<span class="fhx"></span>'
      // ponytail: the star keeps one slot at the right end, reserved even
      // while the page loads or has no star, so it never shifts
      + '<button type="button" class="sbtn fhbm" data-fh="bm" disabled>' + ico('mark') + '</button>';
    h.key = null;
    const inp = h.querySelector('.fhin');
    h.querySelector('[data-fh=back]').onclick = () => h.key && fnavGo(h.key, 'back');
    h.querySelector('[data-fh=fwd]').onclick = () => h.key && fnavGo(h.key, 'fwd');
    h.omni = omniWire(inp, h.querySelector('.fhlist'), (v) => {
      inp.blur();
      if (h.key) fnavGo(h.key, 'to', v);
    });
    // left without going anywhere, the field shows the address again
    inp.addEventListener('blur', () => setTimeout(() => fhPaint(g), 130));
    return h;
  }
  // the reader bar's own extras, which hide with it: the bookmark star, the
  // orrery button, the forum's refused-posts link. Each shows here as a
  // button that clicks the original, so its own script still does the work.
  // The star is updated in its fixed slot, never rebuilt.
  function fhExtras(h, bar) {
    const x = h.querySelector('.fhx');
    const star = h.querySelector('[data-fh=bm]');
    x.textContent = '';
    const bm = bar && bar.isConnected ? bar.querySelector('.bm') : null;
    const live = bm && !bm.closest('[hidden]');
    const on = !!live && /★/.test(bm.textContent);
    star.disabled = !live;
    star.classList.toggle('on', on);
    star.style.visibility = live ? '' : 'hidden';
    tip(star, on ? 'Bookmarked' : 'Bookmark this page');
    star.onclick = live ? () => bm.click() : null;
    if (!bar || !bar.isConnected) return;
    for (const el of bar.querySelectorAll('#orw button, #orw a, a[href*="forum-notes"]')) {
      if (el.closest('[hidden]')) continue;
      const b = document.createElement('button');
      b.className = 'fhtxt' + (/forum-notes/.test(el.getAttribute('href') || '') ? ' err' : '');
      b.textContent = el.textContent.trim();
      if (el.title) b.title = el.title;
      b.type = 'button';
      b.onclick = () => el.click();
      x.append(b);
    }
  }
  function fhPaint(g) {
    const h = g.fhead;
    if (!h || !h.key) return;
    const n = fnavOf(h.key);
    for (const [k, st_] of [['back', n.back], ['fwd', n.fwd]]) {
      const b = h.querySelector('[data-fh=' + k + ']');
      b.disabled = !st_.length;
      b.setAttribute('aria-disabled', b.disabled ? 'true' : 'false');
    }
    const inp = h.querySelector('.fhin');
    if (document.activeElement !== inp) inp.value = n.addr;
    fhExtras(h, n.bar);
  }
  const fhPaintKey = (key) => {
    for (const g of groups) if (g.fhead && g.fhead.key === key) fhPaint(g);
  };
  // from toolSync: `key` is the tool in front of `g`, or null. A browsing
  // one gets the header, made the first time a group needs it.
  function fhSync(g, key) {
    const on = !!key && browsing(key);
    if (!g.fhead) {
      if (!on) return;
      g.fhead = fhMake(g);
      g.el.insertBefore(g.fhead, g.host);
    }
    g.fhead.hidden = !on;
    const k = on ? key : null;
    if (g.fhead.key !== k) {
      g.fhead.key = k;
      g.fhead.omni.hide();
      const inp = g.fhead.querySelector('.fhin');
      if (document.activeElement === inp) inp.blur();
    }
    fhPaint(g);
  }
  // for the browser suites
  window.latFnav = (key) => { const n = fnav[key]; return n && { back: n.back.slice(), fwd: n.fwd.slice(), cur: n.cur, addr: n.addr }; };
