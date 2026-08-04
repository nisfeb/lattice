/* BUILT FILE — do not edit. Source: ui-app/src/, build: scripts/build-ui.mjs */
(function () {
'use strict';
// ── src/05-prefs.js ───────────────────────────────────────────────────────
  // ── typography preferences ───────────────────────────────────────────────
  // Set on the settings page, stored in localStorage, applied here. Two vars
  // only (--ed-font, --ed-size), because #src and #hl must keep byte-identical
  // metrics. See the note beside them in index.html.
  //
  // Costs ZERO requests. Preferences are a client concern, so they never touch
  // the pier. This file sorts first so the editor paints in the chosen font
  // rather than flashing the default and re-laying out.
  const FONTS = {
    mono: 'ui-monospace, Menlo, Consolas, monospace',
    system: 'system-ui, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    humanist: '"Iosevka", "JetBrains Mono", "Fira Code", ui-monospace, monospace',
  };
  function applyPrefs() {
    const r = document.documentElement.style;
    let f = null, s = null;
    try { f = localStorage.latFont; s = localStorage.latFontSize; } catch {}
    // an unknown key must fall back rather than write `undefined` into CSS
    if (f && FONTS[f]) r.setProperty('--ed-font', FONTS[f]);
    else r.removeProperty('--ed-font');
    const n = parseInt(s, 10);
    if (n >= 9 && n <= 32) r.setProperty('--ed-size', n + 'px');
    else r.removeProperty('--ed-size');
  }
  applyPrefs();
  // the settings page is a SEPARATE document on the same origin, so its writes
  // reach an open editor through the storage event (no reload, no polling).
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === 'latFont' || e.key === 'latFontSize') applyPrefs();
  });

// ── src/08-offline.js ─────────────────────────────────────────────────────
  // ── offline edits: queue, detection, replay (docs/offline-edits.md) ──────
  // Saves only: pages and know memories. The queue lives in IndexedDB, one per
  // page, coalesced. Re-editing a queued page replaces its record, the same
  // way autosave coalesces savePending. localStorage is synchronous and ~5MB,
  // which is why the tree snapshot moved here too (phase 3).
  //
  // Detection is from RESPONSES, never navigator.onLine. The desktop webview
  // talks to a localhost bridge that always answers and returns 502 when the
  // ship is unreachable, and onLine lies about captive portals on mobile.
  //
  // THE QUEUE IS THE TOP READ TIER. Without that, cache-first opens painted
  // the pre-edit body over a queued edit. The edit looked lost, and the next
  // autosave would queue the OLD body back (review gap 1 in the design doc).
  let degraded = false;      // a save failed like the ship was unreachable
  let offCount = 0;          // queued page edits, drives the status text
  let offbadge = null;       // assigned by <lat-bar> (12-bar.js)
  // The persistent offline indicator. The status line reports EVENTS and the
  // next one overwrites it, so "saved offline" scrolls away while you are
  // still offline and still queueing. This reports the CONDITION and stays up
  // until the queue is empty and the ship answers again.
  //
  // The two halves are independent: the ship can be unreachable with nothing
  // queued yet, and the queue can be non-empty while the ship is back but the
  // replay has not finished.
  const renderOffline = () => {
    if (!offbadge) return;
    const q = offCount ? offCount + ' queued' : '';
    if (!degraded && !offCount) { offbadge.hidden = true; return; }
    offbadge.hidden = false;
    offbadge.textContent = degraded ? (q ? 'offline \u00b7 ' + q : 'offline') : q;
    offbadge.title = degraded
      ? 'the ship is not answering. Edits are saved on this device and sent when it returns.'
      : 'edits saved on this device, syncing now.';
    offbadge.classList.toggle('syncing', !degraded);
  };
  let offDb = null;
  const offOpen = () => new Promise((res) => {
    if (offDb) return res(offDb);
    let rq = null;
    try { rq = indexedDB.open('lattice-offline', 2); } catch { return res(null); }
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains('saves'))
        d.createObjectStore('saves', { keyPath: 'name' });
      // kv: the tree snapshot (phase 3). It lived in localStorage, which is
      // ~5MB, synchronous, and was re-STRINGIFIED whole on every save. IDB
      // stores the structured clone directly and scales to the disk.
      if (!d.objectStoreNames.contains('kv'))
        d.createObjectStore('kv', { keyPath: 'k' });
    };
    rq.onsuccess = () => { offDb = rq.result; res(offDb); };
    rq.onerror = () => res(null);   // no idb: the queue is off, saves fail loudly as before
  });
  const offReq = (rq) => new Promise((res) => {
    if (!rq) return res(null);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => res(null);
  });
  const offStore = async (mode) => {
    const d = await offOpen();
    try { return d && d.transaction('saves', mode).objectStore('saves'); } catch { return null; }
  };
  const offGet = async (name) => {
    const s = await offStore('readonly'); return s ? offReq(s.get(name)) : null;
  };
  const offAll = async () => {
    const s = await offStore('readonly'); return (s && await offReq(s.getAll())) || [];
  };
  const offRecount = async () => { offCount = (await offAll()).length; renderOffline(); };
  const offPut = async (rec) => {
    const s = await offStore('readwrite'); if (s) await offReq(s.put(rec));
    await offRecount();
  };
  const offDel = async (name) => {
    const s = await offStore('readwrite'); if (s) await offReq(s.delete(name));
    await offRecount();
  };
  offRecount();
  const kvStore = async (mode) => {
    const d = await offOpen();
    try { return d && d.transaction('kv', mode).objectStore('kv'); } catch { return null; }
  };
  const kvGet = async (k) => {
    const st = await kvStore('readonly');
    const r = st && await offReq(st.get(k));
    return r ? r.v : null;
  };
  // fire-and-forget by design: persistTree's callers are synchronous save
  // paths, and a snapshot write that loses a race with app close costs one
  // boot's paint, not data. The ship copy is the durable one.
  const kvPut = async (k, v) => {
    const st = await kvStore('readwrite');
    if (st) await offReq(st.put({ k, v }));
  };

  // fetch with a REAL deadline. "Detect offline by timeout" was in the design
  // from day one, but nothing implemented a timeout. No AbortController
  // anywhere, no ureq timeout in the bridge. So against a dead remote ship
  // "degraded" was the OS TCP timeout, minutes away (review gap 2).
  const tfetch = (url, opts = {}, ms = 10000) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
  };
  // the bridge answers 502 when the ship is unreachable. A proxy in front of
  // eyre may say 504. Anything else means the ship SPOKE. That is a real
  // error, not an outage, and must never be queued over.
  const shipGone = (r) => !r || r.status === 502 || r.status === 504;

  let probeTimer = null;
  function setDegraded(on) {
    if (degraded === on) return;
    degraded = on;
    renderOffline();
    if (on) st('ship unreachable — edits are queued locally', false);
    if (on && !probeTimer) {
      probeTimer = setInterval(async () => {
        let r = null;
        try { r = await tfetch(api + '/legacy-status', {}, 5000); } catch {}
        if (r && r.ok) {
          clearInterval(probeTimer); probeTimer = null;
          degraded = false;
          renderOffline();   // ship is back; the badge now reports the drain
          replayQueue();
        }
      }, 20000);
    }
    if (!on && probeTimer) { clearInterval(probeTimer); probeTimer = null; }
  }

  // queue one page's edit and make it the visible truth everywhere a read
  // could come from: the render cache, the tree dump body, the boot snapshot.
  async function enqueueSave(name, kind, body) {
    await offPut({ name, kind, body, baseRev: curRev || 0, queuedAt: Date.now() });
    pageCache.delete(name);
    const nd = nodes.find((n) => n.page && n.path === name);
    if (nd) { nd.body = body; nd.kind = kind; persistTree(); }
    snapPage(name, { body, kind, rev: curRev || 0 });
    setDegraded(true);
    st('saved offline — ' + offCount + ' waiting to sync');
  }
  // know memories share the queue under a 'know:' prefix. Page names cannot
  // contain a colon, so the two namespaces cannot collide in the one store.
  // No baseRev: memories are last-write-wins (no CAS, no conflicts/ pages),
  // matching what know-save itself does.
  async function enqueueKnow(key, body) {
    await offPut({ name: 'know:' + key, kind: 'know', body, queuedAt: Date.now() });
    knowGen++;
    const k = knowEntry(key);
    if (k) k.bytes = body.length;
    else knowKeys.push({ key, tags: [], updated: '', bytes: body.length });
    renderKnowChips();
    renderKnowTree();
    setDegraded(true);
    st('saved offline — ' + offCount + ' waiting to sync');
  }

  // Drain through page-save-batch. The batch is all-or-nothing, right for
  // uploads, wrong for replay. One poisoned record would block the queue
  // forever. A rejected batch falls back to per-item saves so the bad record
  // is isolated and DROPPED (it can never apply; review gap 3).
  let replaying = false;
  async function replayQueue() {
    if (replaying) return;
    const whole = await offAll();
    if (!whole.length) return;
    const all = whole.filter((q) => q.kind !== 'know');
    const knows = whole.filter((q) => q.kind === 'know');
    replaying = true;
    stWork('syncing ' + whole.length + ' offline edit' + (whole.length === 1 ? '' : 's') + '…');
    let stuck = false;
    const conflicts = [];
    for (let i = 0; i < all.length && !stuck; i += 50) {
      const part = all.slice(i, i + 50);
      let r = null;
      try {
        r = await tfetch(api + '/page-save-batch?report=1', {
          method: 'POST',
          body: JSON.stringify(part.map((q) =>
            ({ name: q.name, type: q.kind, body: q.body || '\n', base: q.baseRev || 0 }))),
        }, 120000);
      } catch {}
      if (r && r.ok) {
        // per-item verdicts: an edit whose base the ship moved past still
        // APPLIED (it is the newest revision), but the overwritten revision
        // is named so it can be recovered from history. Apply-and-flag,
        // never silently drop either side
        try {
          for (const it of ((await r.json()).items || []))
            if (it.conflicted) conflicts.push(it.kept || it.name);
        } catch {}
        for (const q of part) await offDel(q.name);
        continue;
      }
      if (r && !shipGone(r)) {
        for (const q of part) {
          let one = null;
          try {
            one = await tfetch(api + '/page-save?name=' + encodeURIComponent(q.name) +
              '&type=' + q.kind + '&base=' + (q.baseRev || 0),
              { method: 'POST', body: q.body || '\n' }, 20000);
          } catch {}
          if (one && one.ok) {
            try {
              const j = await one.json();
              if (j.conflicted) conflicts.push(j.kept || q.name);
            } catch {}
            await offDel(q.name);
            continue;
          }
          if (shipGone(one)) { stuck = true; break; }
          st('dropped an unsyncable offline edit: ' + q.name, false);
          await offDel(q.name);
        }
        continue;
      }
      stuck = true;
    }
    // memories drain per-item. There is no know batch route, and last-write-
    // wins means a plain re-save with no verdict to collect
    for (const q of knows) {
      if (stuck) break;
      let one = null;
      try {
        one = await tfetch(api + '/know-save?key=' + encodeURIComponent(q.name.slice(5)),
          { method: 'POST', body: q.body || '\n' }, 20000);
      } catch {}
      if (one && one.ok) { await offDel(q.name); continue; }
      if (shipGone(one)) { stuck = true; break; }
      st('dropped an unsyncable offline edit: ' + q.name, false);
      await offDel(q.name);
    }
    replaying = false;
    if (stuck) { setDegraded(true); st(offCount + ' offline edit(s) still waiting', false); return; }
    setDegraded(false);
    if (conflicts.length) {
      st('synced — ' + conflicts.length + ' conflict(s): your offline version won; '
        + 'the other is saved at ' + conflicts.join(', '), false);
    } else st('offline edits synced');
    // reconcile ONLY after the drain. refreshAll on reconnect would repaint
    // queued pages from the server dump before their edits landed (gap 4)
    if (knows.length && mode === 'know') loadKnow();
    loadTree();
  }

// ── src/10-shell.js ───────────────────────────────────────────────────────
// lattice app, served from ui-app/src/, built by scripts/build-ui.mjs
  const $ = (id) => document.getElementById(id);
  const api = '/apps/lattice';
  let pname, pkind, status, spinner;   // assigned by <lat-bar>   (12-bar.js)
  let prev;                            // assigned by <lat-preview> (60-preview.js)
  // blank preview: about:blank defaults to light color-scheme, which
  // mismatches the app's declared scheme and makes the iframe an opaque
  // white canvas in dark theme. Declare the scheme so it stays transparent
  // and the pane's theme background shows through.
  const prevBlank = () => {
    prev.removeAttribute('src');
    // the srcdoc paints its OWN theme background rather than relying on the
    // engine to composite a mismatched-scheme iframe as transparent. That
    // reliance is exactly the kind of behavior that differs between the
    // Chromium the tests run and the webkitgtk the desktop runs
    prev.srcdoc = '<style>:root{color-scheme:light dark}' +
      'body{margin:0;background:#fafafa}' +
      '@media(prefers-color-scheme:dark){body{background:#1a1a1a}}</style>';
  };
  // grant paths are shown in the share/ACL surfaces, and every one carries
  // the same app base, pure noise on screen. Strip it, then keep the
  // SHORTEST tail that stays unique among the paths shown alongside (`all`),
  // growing only where disambiguation demands. Callers put the full path in
  // `title`, so hover always has the truth.
  const shortPath = (p, all) => {
    const strip = (x) => x.replace(/^\/apps\/lattice\.lattice_app\/(page\/)?/, '');
    const label = (x) => {
      const me = strip(x);
      if (!me) return x;
      const segs = me.split('/');
      let n = 1;
      const tail = () => segs.slice(-n).join('/');
      const clashes = () =>
        all.some((q) => q !== x && strip(q).split('/').slice(-n).join('/') === tail());
      while (n < segs.length && clashes()) n++;
      // Out of segments and STILL ambiguous. strip() drops an optional "page/",
      // so /…/page/foo and /…/foo both reduce to "foo" with nothing left to
      // extend, and two different grants rendered identically in the ACL pane.
      // Fall back to keeping that prefix, which is what actually distinguishes
      // them. Showing a longer path beats showing the wrong one.
      if (clashes()) return x.replace(/^\/apps\/lattice\.lattice_app\//, '');
      return (n < segs.length ? '\u2026/' : '') + tail();
    };
    // Growing the tail compares TAILS, which is not the same as comparing
    // LABELS. /…/page/b keeps its "page/" by the rule above and /…/page/page/b
    // grows into those same two segments, so the pair collided anyway: found
    // by property, not by eye, in scripts/ui-props.mjs. Once even the labels
    // agree, nothing shorter than the whole path tells the grants apart.
    // Every label ends in its own last segment, so only same-leaf grants can
    // collide: that filter keeps this off the O(n²) path on a long ACL.
    const me = label(p);
    const leaf = (x) => x.slice(x.lastIndexOf('/') + 1);
    const near = all.filter((q) => q !== p && leaf(q) === leaf(p));
    if (near.some((q) => label(q) === me)) return p;
    return me;
  };
  const st = (msg, ok = true) => {
    spinner.classList.remove('on');          // any plain status ends the spin
    status.textContent = msg;
    status.style.color = ok ? '' : '#c0392b';
  };
  // stWork: a status that keeps spinning until the next plain st()
  const stWork = (msg) => {
    status.textContent = msg;
    status.style.color = '';
    spinner.classList.add('on');
  };
  // desktop shell: wry denies target=_blank new windows (the clearweb share
  // link would be a dead click). Same-origin and urb:// links stay in the
  // app. Only truly external http(s) leaves for the system browser.
  if (window.__TAURI__)
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[target="_blank"]');
      if (!a || !a.href) return;
      e.preventDefault();
      const ext = /^https?:/.test(a.href) && new URL(a.href).origin !== location.origin;
      if (ext) window.__TAURI__.core.invoke('open_external_url', { url: a.href });
      else location.href = a.href;
    });

// ── src/12-bar.js ─────────────────────────────────────────────────────────
  // ── top bar + mobile tabs: <lat-bar>, <lat-tabs> ─────────────────────────
  // The spinner is part of the bar's own markup now (its CSS lives in the
  // shell stylesheet). The old inject-styles-and-synthesize-elements guards
  // existed only because the shell and JS could cache-skew apart.
  customElements.define('lat-bar', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<header class="bar">
  <a class="home" href="/apps/lattice" title="lattice home">&#8962;</a>
  <button id="modet" title="switch pages / knowledge">&#9998; pages</button>
  <input id="pname" placeholder="page name (e.g. notes/todo)" autocomplete="off" spellcheck="false">
  <select id="pkind" title="page kind">
    <option value="md">md</option>
    <option value="gmi">gmi</option>
    <option value="html">html</option>
    <option value="text">txt</option>
    <option value="js">js</option>
    <option value="css">css</option>
    <option value="hoon">hoon</option>
  </select>
  <button id="save">save</button>
  <span id="spin"></span><span id="status" class="muted"></span>
  <!-- Offline state is a CONDITION, not an event, so it cannot live in the
       status line: the next save, render or refresh overwrites that. This
       badge stays up for as long as the condition holds. -->
  <span id="offbadge" class="offbadge" hidden></span>
  <span class="grow"></span>
  <button id="wrapt" class="ico" title="toggle line wrap">&#8617;</button>
  <!-- a KEY, not U+26BF: that codepoint has almost no font coverage and
       rendered as an empty box, which is worse than no button at all. -->
  <button id="cmt" class="ico" title="comments from other ships">&#128172;</button>
  <button id="aclt" class="ico" title="access control &mdash; groups, sharing, banned ships">&#128273;</button>
  <button id="treet" class="ico" title="toggle tree pane">&#9776;</button>
  <button id="ctlt" class="ico" title="toggle controls pane">&#9881;</button>
</header>`;
      pname = $('pname'); pkind = $('pkind');
      status = $('status'); spinner = $('spin'); offbadge = $('offbadge');
      renderOffline();   // a queue can outlive a session, so show it at boot
    }
  });
  customElements.define('lat-tabs', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<nav class="mtabs" id="mtabs">
  <button data-mv="tree">tree</button>
  <button data-mv="code" class="on">code</button>
  <button data-mv="prev">preview</button>
  <button data-mv="ctl">controls</button>
</nav>`;
    }
  });
  // stale-shell guard: replace a cached pre-component shell's literal bar and
  // tabs. The bar relies on source order for its grid row, so it is PREPENDED.
  if (!document.querySelector('lat-bar')) {
    for (const sel of ['header.bar', 'nav.mtabs']) {
      const stale = document.querySelector(sel);
      if (stale) stale.remove();
    }
    const wsEl = document.getElementById('ws');
    const tabs = document.createElement('lat-tabs');
    const bar = document.createElement('lat-bar');
    tabs.style.display = 'contents';
    bar.style.display = 'contents';
    wsEl.prepend(tabs);
    wsEl.prepend(bar);
  }

// ── src/15-dialog.js ──────────────────────────────────────────────────────
  // ── in-app dialogs, NEVER browser-native prompt/confirm/alert ────────────
  // <lat-dialog> owns the dialog's markup AND wiring. The shell only carries
  // the tag, so the served HTML can never be missing an element this file
  // expects (the old cache-skew guards existed exactly for that gap).
  let dlg, dlgMsg, dlgIn, dlgSel, dlgOpts;
  let dlgDone = null;
  const dlgClose = (v) => {
    if (!dlgDone) return;
    dlg.hidden = true;
    const d = dlgDone; dlgDone = null; d(v);
  };
  const dlgOpen = (msg, okLabel) => {
    dlgMsg.textContent = msg;
    $('dlgok').textContent = okLabel || 'ok';
    dlg.hidden = false;
    return new Promise((res) => { dlgDone = res; });
  };
  // ask: text-input dialog → string | null (cancel)
  const ask = (msg, value, okLabel) => {
    dlgSel.hidden = true;
    dlgIn.hidden = false;
    dlgIn.value = value || '';
    const p = dlgOpen(msg, okLabel);
    dlgIn.focus(); dlgIn.select();
    return p;
  };
  // askConfirm: yes/no dialog → boolean
  const askConfirm = (msg, okLabel) => {
    dlgSel.hidden = true;
    dlgIn.hidden = true;
    const p = dlgOpen(msg, okLabel);
    $('dlgok').focus();
    return p.then((v) => v !== null);
  };
  // askChoice: pick one of a list -> the chosen value, or null on cancel.
  // Rendered as real buttons in the app's own style, NEVER a <select>. A
  // select opens an OS-drawn list, which is a browser-native popup, and this
  // UI does not use those anywhere.
  const askChoice = (msg, options, okLabel) => {
    dlgIn.hidden = true;
    dlgSel.hidden = true;
    dlgOpts.textContent = '';
    dlgOpts.hidden = false;
    $('dlgok').hidden = true;          // each option is its own commit button
    const p = dlgOpen(msg, okLabel);
    const btns = options.map((o, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dlgopt' + (i === 0 ? ' on' : '');
      b.textContent = o;
      b.dataset.val = o;
      b.onclick = () => dlgClose(o);
      dlgOpts.appendChild(b);
      return b;
    });
    if (btns[0]) btns[0].focus();
    // arrow keys move between options. Enter takes the focused one
    dlgOpts.onkeydown = (e) => {
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = (i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length;
        for (const b of btns) b.classList.remove('on');
        btns[n].classList.add('on');
        btns[n].focus();
      }
    };
    return p.then((v) => {
      dlgOpts.hidden = true;
      $('dlgok').hidden = false;
      return v;
    });
  };
  customElements.define('lat-dialog', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="dlg" id="dlg" hidden>
  <form class="dlgbox" id="dlgform">
    <div id="dlgmsg"></div>
    <div id="dlgopts" class="dlgopts" hidden></div>
    <select id="dlgsel" hidden></select>
    <input id="dlginput" autocomplete="off" spellcheck="false">
    <div class="dlgbtns">
      <button type="button" id="dlgcancel">cancel</button>
      <button type="submit" id="dlgok">ok</button>
    </div>
  </form>
</div>`;
      dlg = $('dlg'); dlgMsg = $('dlgmsg'); dlgIn = $('dlginput');
      dlgSel = $('dlgsel'); dlgOpts = $('dlgopts');
      $('dlgform').onsubmit = (e) => {
        e.preventDefault();
        dlgClose(!dlgSel.hidden ? dlgSel.value : dlgIn.hidden ? '' : dlgIn.value);
      };
      $('dlgcancel').onclick = () => dlgClose(null);
      dlg.onclick = (e) => { if (e.target === dlg) dlgClose(null); };
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !dlg.hidden) dlgClose(null);
      });
    }
  });
  // stale-shell guard: a cached index.html predating <lat-dialog> still
  // carries the literal #dlg block, which would shadow the component's ids.
  // Swap it out so dialogs keep working during the skew window (the service
  // worker caches the shell and this file independently).
  if (!document.querySelector('lat-dialog')) {
    const stale = document.getElementById('dlg');
    if (stale) stale.remove();
    document.body.appendChild(document.createElement('lat-dialog'));
  }

// ── src/20-state.js ───────────────────────────────────────────────────────
  // ── state ────────────────────────────────────────────────────────────────
  let current = null;      // name of the open page, null = unsaved new page
  let dirty = false;       // unsaved local edits. Auto-refresh never clobbers them
  let viewingRev = null;   // non-null: a read-only historical revision is shown
  let curKind = null;      // the OPEN page's server kind; 'index' has no select
                           // option, so pkind.value would silently convert it
  let curRev = 0;          // the open page's server revision (offline baseRev)
  let curFolder = null;    // selected folder path. Right-pane ops target it
  let folderCtx = '';      // folder uploads land in (last into / open page's dir)
  let nodes = [];          // last page-tree
  let saving = false;      // a save round-trip is in flight. Never overlap them.
  let savePending = false; // The pier serializes, so a second save just queues
                           // 3.7s of stale-body work behind the first
  let echoUntil = 0;       // our own save bumps the beacon. Ignore that echo or
                           // every save triggers a tree+source refetch of content
                           // this client just wrote (~4s of pier time each)
  const qs = new URLSearchParams(location.search);

  // every request to the ship costs ~2s and they serialize (single-threaded
  // pier), so the rules here are: never re-fetch what this client already
  // knows, patch `nodes`/`knowKeys` locally after our own writes, and snapshot
  // to localStorage so the next boot paints before the network answers.
  // generation counters: a list fetch issued BEFORE a local patch must not
  // land AFTER it and clobber newer local state with a stale server snapshot
  // (the own-write echo is suppressed, so nothing would correct it until the
  // 30s poll). Bumped on every local mutation. Stale responses are dropped.
  let treeGen = 0, knowGen = 0;
  // persistTree: save the tree WITHOUT bumping the generation. The counter
  // exists so a STRUCTURAL local patch (a page created, moved, deleted) is not
  // overwritten by a list fetch that was issued before it. A body-only update
  // changes no structure, so bumping for one just discards a legitimate
  // in-flight refresh, which silently lost pages created while an autosave
  // was in flight.
  const persistTree = () => {
    // IDB, not localStorage (phase 3): the tree carries every page BODY via
    // page-dump, so a growing vault was marching toward the ~5MB quota.
    // Stringifying the whole tree on every save was main-thread work paid at
    // the worst time. The structured clone goes straight in. The PAGE
    // snapshot (appPage) stays in localStorage on purpose. It is small and
    // synchronous, which is what keeps resume painting at 0ms.
    kvPut('tree', nodes);
  };
  // rendered page-source answers, by name. The tree dump already carries every
  // body, so this only adds what the dump lacks (`share` and the rendered
  // `html`), which makes re-opening a page cost ZERO requests instead of a
  // ~0.5s round-trip. Dropped whenever the ship reports a change (the beacon
  // clears it) or when this client writes the page.
  const pageCache = new Map();
  const snapTree = () => {
    treeGen++;                 // structural change: supersede in-flight fetches
    persistTree();
  };
  const snapPage = (name, d) => {
    try {
      localStorage.appPage = JSON.stringify(
        { name, body: d.body, kind: d.kind, share: d.share || 'private',
          rev: d.rev, html: typeof d.html === 'string' ? d.html : undefined });
    } catch {}
  };

  // every client-initiated write bumps the change beacon. Hold the echo window
  // open while the request is in flight (a folder move pokes the writer many
  // times) plus a short tail, so the SSE handler never refetches what this
  // client just did itself.
  async function mutate(url, opts) {
    // Only SAVES queue (pages and know memories). Deletes, moves, shares: their
    // ordering dependencies are where offline systems get genuinely hard, so
    // they refuse honestly instead of pretending (design doc, Phasing).
    if (degraded || offCount) {
      st('offline — edits are queued, but this change needs the ship', false);
      return { ok: false, status: 'offline', json: async () => ({ error: 'offline' }) };
    }
    echoUntil = Date.now() + 60000;
    try { return await fetch(url, opts || { method: 'POST' }); }
    finally { echoUntil = Date.now() + 4000; }
  }

  const collapsed = () => {
    try { return JSON.parse(localStorage.appColl || '[]'); } catch { return []; }
  };
  const setCollapsed = (c) => { localStorage.appColl = JSON.stringify(c); };

// ── src/22-listedit.js ────────────────────────────────────────────────────
  // ── smart list continuation ──────────────────────────────────────────────
  // Pure on purpose. It takes the text and the selection and returns the edit
  // to apply, touching no DOM, so the fiddly parts (nesting, mixed markers,
  // renumbering) are unit tested by scripts/ui-listedit.mjs in milliseconds
  // with no browser and no ship. The editor's keydown handler is the only
  // place that knows about textareas.
  //
  // Returns null when Enter should do its ordinary thing. Otherwise
  // {from, to, text, caret}: replace [from, to) with text, then put the caret
  // at `caret`.
  const listEnter = (value, selStart, selEnd, flavor) => {
    const TAB = 4;
    const width = (s) => s.replace(/\t/g, ' '.repeat(TAB)).length;
    // indent, then either a bullet or a number+delimiter, then the gap, then
    // an optional task box. Kept in one place: every scan below reuses it.
    const ITEM = /^([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;
    const parse = (ln) => {
      const m = ln.match(ITEM);
      if (!m) return null;
      return {
        len: m[0].length, indent: m[1], bullet: m[2] || '',
        num: m[3] ? parseInt(m[3], 10) : null, delim: m[4] || '',
        gap: m[5], task: m[6] || '', w: width(m[1]),
      };
    };
    // A fenced block is literal text: a "- " in a shell snippet is not a list.
    // In gemtext ``` toggles a preformatted block, which is the same rule.
    const before = value.slice(0, selStart);
    const fences = before.match(/^[ \t]*(?:```|~~~)/gm);
    if (fences && fences.length % 2 === 1) return null;

    // Gemtext is not markdown with fewer features, it is a different grammar.
    // Its ONLY list form is "* " at the very start of a line: no ordered
    // lists, no nesting, and leading whitespace makes a line ordinary text.
    // Continuing markdown markers here would write "- " and "2." that gemtext
    // renders as literal characters, so it gets its own small rule set.
    if (flavor === 'gmi') {
      const gLineStart = before.lastIndexOf('\n') + 1;
      let gLineEnd = value.indexOf('\n', selEnd);
      if (gLineEnd === -1) gLineEnd = value.length;
      const g = value.slice(gLineStart, gLineEnd).match(/^\* +/);
      if (!g) return null;
      if (selStart < gLineStart + g[0].length) return null;   // caret in the marker
      if (!value.slice(gLineStart, gLineEnd).slice(g[0].length).trim()) {
        return { from: gLineStart, to: gLineEnd, text: '', caret: gLineStart };
      }
      const gText = '\n' + g[0];
      return { from: selStart, to: selEnd, text: gText, caret: selStart + gText.length };
    }

    const lineStart = before.lastIndexOf('\n') + 1;
    let lineEnd = value.indexOf('\n', selEnd);
    if (lineEnd === -1) lineEnd = value.length;
    const cur = parse(value.slice(lineStart, lineEnd));
    if (!cur) return null;
    // Caret inside the marker itself, including at the very start of the line.
    // Enter there pushes the item down and leaves it intact, which is what
    // every editor does. Continuing would emit a second marker ("- - one") or
    // split the marker in half ("1" / "2. . one").
    if (selStart < lineStart + cur.len) return null;

    const lines = value.split('\n');
    // index of the line the caret sits on, by counting newlines before it
    const curIdx = before.split('\n').length - 1;

    // How far this list block reaches. A blank line does not end it (loose
    // lists have them), nor does a deeper-indented continuation. A line at or
    // left of our indent that is not an item does.
    let lastIdx = curIdx;
    for (let i = curIdx + 1; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.trim()) continue;                 // blank: might be a loose list
      const p = parse(ln);
      const lead = width(ln.match(/^[ \t]*/)[0]);
      if (!p && lead <= cur.w) break;           // ordinary paragraph, list over
      if (p && p.w < cur.w) break;              // stepped out to a parent level
      lastIdx = i;
    }

    // ── an item with nothing in it: Enter leaves the list ─────────────────
    const content = value.slice(lineStart, lineEnd).slice(cur.len);
    if (!content.trim()) {
      // Nested, so step out one level instead of dropping the list entirely.
      // The parent's own marker decides what we become, which is what makes a
      // mixed list (numbers outside, dashes inside) walk back up correctly.
      for (let i = curIdx - 1; i >= 0 && cur.w > 0; i--) {
        const p = parse(lines[i]);
        if (!p || p.w >= cur.w) continue;
        const marker = p.bullet
          ? p.bullet + ' '
          : String((p.num || 0) + 1) + p.delim + ' ';
        const text = p.indent + marker + (p.task ? '[ ] ' : '');
        return { from: lineStart, to: lineEnd, text, caret: lineStart + text.length };
      }
      // top level: clear the marker and end the list
      return { from: lineStart, to: lineEnd, text: '', caret: lineStart };
    }

    // ── continue the list ─────────────────────────────────────────────────
    if (cur.bullet) {
      // Unordered needs no bookkeeping: same bullet, same indent. A task item
      // continues as an UNCHECKED box, never inheriting the tick.
      const text = '\n' + cur.indent + cur.bullet + cur.gap + (cur.task ? '[ ] ' : '');
      return { from: selStart, to: selEnd, text, caret: selStart + text.length };
    }

    // Ordered. Collect this level's siblings inside the block so we can tell
    // sequential numbering from the "all 1." style, which is valid markdown
    // and must not be silently rewritten into 1, 2, 3.
    const sibs = [];
    for (let i = curIdx; i >= 0; i--) {
      const p = parse(lines[i]);
      if (!p) { if (lines[i].trim() && width(lines[i].match(/^[ \t]*/)[0]) <= cur.w) break; continue; }
      if (p.w < cur.w) break;
      if (p.w === cur.w) { if (!p.num) break; sibs.unshift(p.num); }
    }
    for (let i = curIdx + 1; i <= lastIdx; i++) {
      const p = parse(lines[i]);
      if (!p) continue;
      if (p.w === cur.w) { if (!p.num) break; sibs.push(p.num); }
    }
    const lazy = sibs.length > 1 && sibs.every((n) => n === sibs[0]);
    const nextNum = lazy ? cur.num : cur.num + 1;
    const marker = cur.indent + nextNum + cur.delim + cur.gap + (cur.task ? '[ ] ' : '');

    // Everything from the caret to the end of the block gets rewritten in one
    // edit: the text after the caret becomes the new item's content, and the
    // items below it shift up by one. One replacement means one undo step.
    // The replaced region must cover the whole selection AND the rest of the
    // block. A selection reaching past the last item would otherwise be
    // clamped to the block, leaving the part below it alive: the user's
    // selection came back after being typed over.
    const blockEnd = Math.max(selEnd, lines.slice(0, lastIdx + 1).join('\n').length);
    const tail = value.slice(selEnd, blockEnd).split('\n');
    if (!lazy) {
      let n = nextNum;
      for (let i = 1; i < tail.length; i++) {
        const p = parse(tail[i]);
        if (!p) continue;
        if (p.w < cur.w) break;
        if (p.w > cur.w) continue;              // a sub-list numbers itself
        if (!p.num) break;                      // marker changed, new list
        n += 1;
        tail[i] = p.indent + n + p.delim + p.gap + p.task + tail[i].slice(p.len);
      }
    }
    const text = '\n' + marker + tail.join('\n');
    return { from: selStart, to: blockEnd, text, caret: selStart + 1 + marker.length };
  };

// ── src/25-editor.js ──────────────────────────────────────────────────────
  // ── editor pane: <lat-editor> + highlighting (Prism overlay) ─────────────
  let src, hl;   // assigned when <lat-editor> upgrades (below, synchronously)
  const LMAP = { md: 'markdown', gmi: 'gemtext', html: 'markup',
                 js: 'javascript', css: 'css', hoon: 'hoon' };
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const render = () => {
    const lang = LMAP[pkind.value];
    const g = window.Prism && lang && Prism.languages[lang];
    hl.innerHTML = (g ? Prism.highlight(src.value, g, lang) : esc(src.value)) + '\n';
  };
  const sync = () => { hl.scrollTop = src.scrollTop; hl.scrollLeft = src.scrollLeft; };
  // per-keystroke highlight throttle: Prism re-tokenizes the WHOLE document on
  // every render, which drops frames on large pages. Coalesce to one render per
  // frame. Past ~60KB fall back to a trailing debounce (even one full highlight
  // per frame is too heavy there).
  let hlRaf = 0, hlTimer = 0;
  const scheduleRender = () => {
    if (src.value.length > 60000) {
      clearTimeout(hlTimer);
      hlTimer = setTimeout(() => { render(); sync(); }, 120);
    } else if (!hlRaf) {
      hlRaf = requestAnimationFrame(() => { hlRaf = 0; render(); sync(); });
    }
  };
  // +edited: announce a PROGRAMMATIC change to the editor exactly as if it had
  // been typed. Setting src.value fires no input event, so anything that only
  // called render() silently skipped the dirty flag, autosave and the preview.
  // A Tab indent was shown but never saved, and a live refresh reverted it.
  // Always route scripted edits through here.
  const edited = () => src.dispatchEvent(new Event('input'));
  customElements.define('lat-editor', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="edwrap">
  <div id="acmirror" aria-hidden="true"></div>
  <div id="ac" class="ac" hidden role="listbox" aria-label="page suggestions"></div>
  <pre id="hl" aria-hidden="true"></pre>
  <textarea id="src" spellcheck="false" placeholder="open a page from the tree, or name a new one and start typing"></textarea>
</div>`;
      src = $('src'); hl = $('hl');
      src.addEventListener('input', () => {
        dirty = true;
        scheduleRender();
        clearTimeout(autoTimer);
        autoTimer = setTimeout(autosave, 2000);
      });
      src.addEventListener('scroll', sync);
    }
  });
  // stale-shell guard: a cached index.html predating <lat-editor> still has
  // the literal .edwrap block (and lacks the lat-* display rule). Swap it.
  if (!document.querySelector('lat-editor')) {
    const stale = document.querySelector('.edwrap');
    if (stale) stale.remove();
    const el = document.createElement('lat-editor');
    el.style.display = 'contents';
    document.getElementById('ws').appendChild(el);
  }
  pkind.addEventListener('change', () => { curKind = pkind.value; render(); });

// ── src/30-tree.js ────────────────────────────────────────────────────────
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

// ── src/35-pages.js ───────────────────────────────────────────────────────
  // ── open / new / save ────────────────────────────────────────────────────
  const setFolderCtx = (name) =>
    { folderCtx = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''; };

  // Opening a page should cost nothing. Three tiers, cheapest first:
  //   1. seen this session -> pageCache has the rendered answer: 0 requests.
  //   2. body came with the tree dump -> paint the editor NOW, then fetch
  //      render=1 only to fill in `share` and the preview.
  //   3. no body (oversized page, or a tree we never loaded) -> as before.
  // History and backlinks stay lazy on panel expand. They were 2 more ~2s
  // round-trips paid on every open whether or not anyone looked at them.
  // Which open is current. Opening a page is an explicit user act, so the ONLY
  // reason to discard a landed response is that the user opened something else
  // while it was in flight, not that the editor was dirty, and not that
  // `current` had not been set yet. Guarding on those meant an explicit open
  // was silently dropped. After an unsaved edit, clicking another file did
  // nothing, and a page absent from the local tree never applied at all.
  let openSeq = 0;
  async function openPage(name) {
    const my = ++openSeq;
    // leaving grub mode: clear the flag or the save button would keep writing
    // to the grub while the editor shows a page
    grubPath = null;
    src.readOnly = false;
    setFolderCtx(name);
    // the queue outranks every other tier. A queued edit is the newest truth
    // for this page whether or not the ship is reachable right now
    const q = await offGet(name);
    if (q) {
      const d = { body: q.body, kind: q.kind, rev: q.baseRev || 0, share: 'private' };
      applyPage(name, d, true);
      snapPage(name, d);
      return;
    }
    const hit = pageCache.get(name);
    if (hit) { applyPage(name, hit); snapPage(name, hit); return; }
    const node = nodes.find((n) => n.page && n.path === name);
    const painted = !!node && typeof node.body === 'string';
    // `quiet`: the render=1 request below carries the preview and the error
    // report, so painting must not also fire refreshPreview/checkErrors.
    if (painted) {
      applyPage(name, node, true);
      // snapshot NOW, not only after the render fetch below. The snapshot is
      // what a bare launch (the PWA) resumes from, and a session that ends
      // during the fetch would otherwise remember nothing. The fetch's
      // snapPage upgrades this with the rendered html when it lands.
      snapPage(name, node);
    }
    let d = null;
    try {
      const r = await fetch(api + '/page-source?name=' + encodeURIComponent(name) + '&render=1');
      if (!r.ok) { if (!painted) st('open failed ' + r.status, false); return; }
      d = await r.json();
    } catch { if (!painted) st('open failed', false); return; }
    pageCache.set(name, d);
    snapPage(name, d);
    // a later openPage supersedes this one. Anything else still applies
    if (my !== openSeq) return;
    applyPage(name, d);
  }
  function applyPage(name, d, quiet) {
    current = name;
    curFolder = null;
    setCtlLabels();
    pname.value = name;
    pname.readOnly = true;
    curKind = d.kind;
    curRev = d.rev || 0;
    if (LMAP[d.kind] || d.kind === 'text') pkind.value = d.kind === 'text' ? 'text' : d.kind;
    src.value = d.body;
    dirty = false;
    render(); sync();
    history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
    markCurrent();
    st(d.kind + ' · rev ' + d.rev);
    exitRev();
    resetPanels();
    showShare(d.share || 'private');
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
    if (typeof d.html === 'string') { prev.removeAttribute('src'); prev.srcdoc = d.html; }
    else if (!quiet) refreshPreview();
    if (!CONTENT() && !quiet) checkErrors();
    if (isMobile()) setMv('code');
  }

  // focusName: only when the USER asked for a new file. Boot calls this to
  // land on an empty page, and focusing the name field there summons the
  // phone keyboard before you have done anything. You arrive at the app
  // already typing a filename you did not ask to type.
  function newFile(into, focusName = true) {
    folderCtx = into || '';
    current = null;
    curFolder = null;
    curKind = null;
    exitRev();
    $('histsec').hidden = true;
    $('linksec').hidden = true;
    setCtlLabels();
    pname.readOnly = false;
    pname.value = into ? into + '/' : '';
    src.value = '';
    dirty = false;
    render();
    history.replaceState(null, '', '/apps/lattice/app');
    renderTree();
    if (focusName) pname.focus();
    st('new page — name it, write, save');
    prevBlank();
    showShare('private');
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
  }

  async function newFolder() {
    const raw = await ask('folder name (e.g. notes or notes/sub)',
      folderCtx ? folderCtx + '/' : '', 'create');
    if (!raw) return;
    const name = raw.trim().replace(/^\/+|\/+$/g, '');
    if (!name) return;
    const r = await mutate(api + '/folder-new?name=' + encodeURIComponent(name));
    if (!r.ok) { st('folder failed ' + r.status, false); return; }
    st('folder created');
    addFolderNodes(name);
    snapTree();
    renderTree();
  }

  async function save(kindOverride) {
    if (curFolder) { st('folder selected — open a page to edit', false); return; }
    if (viewingRev !== null) { st('viewing rev ' + viewingRev + ' — use restore', false); return; }
    const name = pname.value.trim().replace(/^\/+|\/+$/g, '');
    if (!name) { st('name required', false); return; }
    const creating = current === null;
    if (saving) { savePending = true; return; }
    saving = true;
    st('saving…');
    // capture the exact body being sent: keystrokes landing during the round-trip
    // must NOT be marked clean, or the next refresh swaps the stale server copy
    // in and the typed text is lost (same guard autosave has always had).
    const sent = src.value;
    const kind = kindOverride || curKind || pkind.value;
    // NO base on live saves, deliberately: base is the OFFLINE queue's tool,
    // where the divergence window is real. Online, any dirty-blocked refresh
    // or panel-driven save can leave curRev one step behind, and every stale
    // base manufactures a false conflict page out of nothing (ui-matrix
    // caught exactly that). Online editing stays last-writer-wins.
    const url = api + '/page-save?name=' + encodeURIComponent(name) +
      '&type=' + kind + (creating ? '&new=1' : '');
    let r = null;
    try { r = await tfetch(url, { method: 'POST', body: sent || '\n' }); }
    catch {}
    finally { saving = false; echoUntil = Date.now() + 4000; }
    if (shipGone(r)) {
      // the ship is unreachable. Queue the edit and complete the save's
      // LOCAL bookkeeping exactly as a successful save would, so the editor
      // does not care which kind it got
      await enqueueSave(name, kind, sent);
      current = name;
      curKind = kind;
      pname.readOnly = true;
      if (src.value === sent) dirty = false;
      history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
      if (creating) { addTreeNode(name, kind); snapTree(); renderTree(); }
      cerr.textContent = 'saved offline'; cerr.className = 'ok';
      if (savePending) { savePending = false; if (dirty) autosave(); }
      return;
    }
    if (r && r.status === 409) { st('that page already exists', false); return; }
    if (!r || !r.ok) { st('save failed' + (r ? ' ' + r.status : ''), false); return; }
    current = name;
    curKind = kind;
    pname.readOnly = true;
    if (src.value === sent) dirty = false;
    // the response carries the new revision (no re-read needed) and whether
    // this save landed on top of a revision made elsewhere
    let vr = null;
    try { vr = await r.json(); } catch {}
    if (vr && vr.rev) curRev = vr.rev;
    if (vr && vr.conflicted) {
      st('saved — replaced an edit from elsewhere; it is kept at ' + vr.kept, false);
    } else st(CONTENT() ? 'saved' : 'compiling\u2026');
    history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
    // only a CREATE changes the tree. Refetching it after every save was a
    // 2.3s pier round-trip to learn nothing. Patch the local copy on create.
    if (creating) { addTreeNode(name, kind); snapTree(); renderTree(); }
    // we know exactly what we just wrote. Patch the local copies so reopening
    // this page paints the saved text, not the dump's pre-save body. The
    // cached render is stale by definition. Drop it and let it re-render.
    pageCache.delete(name);
    const nd = nodes.find((n) => n.page && n.path === name);
    if (nd) { nd.body = sent; nd.kind = kind; persistTree(); }
    // the preview already shows this exact body (the input debounce rendered
    // it). Re-POSTing it after the save was a duplicate 1.8s render.
    if (CONTENT()) { cerr.textContent = 'saved'; cerr.className = 'ok'; }
    else { setTimeout(checkErrors, 800); setTimeout(checkErrors, 2200); }
    if (savePending) { savePending = false; if (dirty) autosave(); }
    if (offCount) replayQueue();     // back online: drain the backlog
  }

  let autoTimer = null;
  async function autosave() {
    // GRUB MODE IS EXPLICIT-SAVE ONLY. Autosaving a lattice page is fine. It is
    // your own note and the editor has always worked that way. Autosaving
    // another app's source is not. A half-typed edit to calendar.html would go
    // live 2s after you paused, and the 5-minute history window may not have
    // kept a revision fine-grained enough to step back to. Save/Cmd+S only.
    // The 2s debounce still fires. It just reports instead of writing, so the
    // moment you stop typing you can see the edit is not yet on the ship.
    if (grubPath) { if (dirty) st('unsaved — press Save or Cmd+S'); return; }
    if (!current || curFolder || !dirty || viewingRev !== null) return;
    // never overlap saves. The pier serializes, so a second in-flight save is
    // 3.7s of stale-body work queued behind the first, delaying every preview
    // behind it. Coalesce to one trailing save instead.
    if (saving) { savePending = true; return; }
    saving = true;
    const sent = src.value;
    const url = mode === 'know'
      ? api + '/know-save?key=' + encodeURIComponent(current)
      : api + '/page-save?name=' + encodeURIComponent(current) +
        '&type=' + (curKind || pkind.value);
    let r = null;
    try { r = await tfetch(url, { method: 'POST', body: sent || '\n' }); } catch {}
    saving = false;
    echoUntil = Date.now() + 4000;
    if (shipGone(r)) {
      if (mode === 'know') {
        await enqueueKnow(current, sent);
        if (src.value === sent) dirty = false;
        if (savePending) { savePending = false; if (dirty) autosave(); }
        return;
      }
      await enqueueSave(current, curKind || pkind.value, sent);
      if (src.value === sent) dirty = false;
      if (savePending) { savePending = false; if (dirty) autosave(); }
      return;
    }
    if (!r || !r.ok) { st('autosave failed' + (r ? ' ' + r.status : ''), false); return; }
    if (src.value === sent) dirty = false;   // typed during the request? stay dirty
    let vr = null;
    if (mode !== 'know') {
      try { vr = await r.json(); } catch {}
      if (vr && vr.rev) curRev = vr.rev;
    }
    if (mode !== 'know') {
      pageCache.delete(current);
      const nd = nodes.find((n) => n.page && n.path === current);
      if (nd) { nd.body = sent; persistTree(); }
    }
    // the conflict verdict must be the LAST word, not clobbered by the
    // ordinary confirmation a line later
    if (vr && vr.conflicted)
      st('autosaved — replaced an edit from elsewhere; it is kept at ' + vr.kept, false);
    else st('autosaved');
    if (mode !== 'know' && !CONTENT()) setTimeout(checkErrors, 800);
    if (savePending) { savePending = false; if (dirty) autosave(); }
  }

// ── src/40-grub.js ────────────────────────────────────────────────────────
  // ── editing an arbitrary grub (?grub=<ball path>) ────────────────────────
  // Any file in the ball, not just a lattice page: an app's html/js/css/hoon.
  // Deliberately NOT a third setMode branch. That function is wired into the
  // tree, kind picker, chips and history panes, and a third mode would mean
  // touching every one of them. This is a thin overlay: same textarea and save
  // button, its own two endpoints.
  let grubPath = null;
  let grubShip = null;   // '~ship' when the grub lives on ANOTHER ship; null = local
  async function openGrub(p, ship) {
    grubPath = p;
    grubShip = ship || null;
    current = null;
    curFolder = null;
    pname.value = (grubShip ? grubShip + ' ' : '') + p;
    pname.readOnly = true;
    $('histsec').hidden = true;
    $('linksec').hidden = true;
    st('loading ' + p + '…');
    // remote files ride /browse-file (bounded cross-ship peek). Its JSON says
    // body/mark where grub-source says text/blot. Normalize here, not there,
    // since both routes have other consumers.
    const url = grubShip
      ? api + '/browse-file?ship=' + encodeURIComponent(grubShip) + '&path=' + encodeURIComponent(p)
      : api + '/grub-source?path=' + encodeURIComponent(p);
    let r = null;
    try { r = await fetch(url); } catch {}
    if (!r || !r.ok) { st('could not open ' + p + (r ? ' (' + r.status + ')' : ''), false); return; }
    const d = await r.json();
    src.value = d.text || d.body || '';
    // a binary/opaque grub has no text form. Show it, never offer to save it
    src.readOnly = !d.editable;
    dirty = false;
    render();
    const blot = d.blot || d.mark || '';
    st(!d.editable ? 'read-only — ' + blot + ' has no text form'
       : grubShip ? 'remote grub on ' + grubShip + ' — saves need their permission'
       : 'grub ' + blot);
  }
  async function saveGrub() {
    if (!grubPath || src.readOnly) return;
    if (saving) { savePending = true; return; }
    saving = true;
    st('saving…');
    const sent = src.value;
    let r = null;
    try {
      // a remote save is verified server-side by revision bump. A peer that
      // never granted make ACKS the poke and silently drops the write, and
      // "saved" on a dropped write is the one lie an editor must not tell.
      r = await fetch(grubShip
        ? api + '/remote-save?ship=' + encodeURIComponent(grubShip) +
          '&path=' + encodeURIComponent(grubPath)
        : api + '/grub-save?path=' + encodeURIComponent(grubPath),
        { method: 'POST', body: sent });
    } catch {}
    saving = false;
    if (!r || !r.ok) {
      // the mark can reject the source. Show ITS error, since the stored grub
      // still holds the previous content and the user needs to know why
      let msg = r ? ' ' + r.status : '';
      if (r) { try { const j = await r.json(); if (j && j.error) msg = ': ' + j.error; } catch {} }
      st('save rejected' + msg, false);
      return;
    }
    if (src.value === sent) dirty = false;
    st('saved');
    if (savePending) { savePending = false; if (dirty) saveGrub(); }
  }

// ── src/45-templates.js ───────────────────────────────────────────────────
  $('save').onclick = () =>
    (grubPath ? saveGrub() : mode === 'know' ? saveKnow() : save());
  // ── new page-tree from a template ────────────────────────────────────────
  // Templates stamp out a whole tree (the `site` template is four pages), and
  // each page is its own writer round-trip, so this is deliberately slow and
  // says so. Instantiation rewrites the template's self-references to the name
  // you choose.
  async function newFromTemplate() {
    let names = [];
    try {
      const r = await fetch(api + '/template-list');
      if (r.ok) names = (await r.json()).templates || [];
    } catch {}
    if (!names.length) { st('no templates available', false); return; }
    const tmpl = await askChoice('start from which template?', names, 'next');
    if (!tmpl) return;
    const raw = await ask('name for the new ' + tmpl,
      folderCtx ? folderCtx + '/' + tmpl : tmpl, 'create');
    if (!raw) return;
    const name = raw.trim().replace(/^\/+|\/+$/g, '');
    if (!name) return;
    stWork('creating ' + name + ' from ' + tmpl + '\u2026 (one save per page)');
    let r = null;
    try {
      r = await mutate(api + '/template-new?template=' + encodeURIComponent(tmpl) +
        '&name=' + encodeURIComponent(name));
    } catch {}
    if (r && r.status === 409) { st('a page by that name exists', false); return; }
    if (!r || !r.ok) { st('template failed' + (r ? ' ' + r.status : ''), false); return; }
    await loadTree();
    // a multi-page template lands as a folder. Open its index if it made one,
    // else the page itself, else just select the new folder.
    const has = (p) => nodes.some((n) => n.page && n.path === p);
    if (has(name)) await openPage(name);
    else if (has(name + '/index')) await openPage(name + '/index');
    else if (nodes.some((n) => !n.page && n.path === name)) selectFolder(name);
    st('created ' + name + ' from ' + tmpl);
  }
  $('newtmpl').onclick = newFromTemplate;
  $('newfile').onclick = () => newFile('');
  $('newfolder').onclick = newFolder;
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      // grubPath first: it is the only mode with no `current`, and page save()
      // would write to the wrong place (or nowhere) while a grub is open.
      // Cmd+S matters more here than elsewhere, since grub mode has no autosave.
      if (grubPath) saveGrub();
      else if (mode === 'know') saveKnow();
      else save();
    }
  });
  // Applies the list-continuation edit if the caret is in a list. Shared by
  // the keydown path and the beforeinput path below, which is the ONLY one a
  // phone reliably takes.
  const continueList = () => {
    if (src.readOnly) return false;
    if (!(mode === 'know' || ['md', 'text', 'gmi'].includes(pkind.value))) return false;
    // know memories are prose, so they follow the markdown rules
    const flavor = mode === 'know' ? 'md' : pkind.value;
    const r = listEnter(src.value, src.selectionStart, src.selectionEnd, flavor);
    if (!r) return false;
    src.setSelectionRange(r.from, r.to);
    // execCommand keeps the textarea's OWN undo stack, so Ctrl+Z steps back
    // through these edits like any typing. Assigning src.value wipes that
    // stack outright, which is why the Tab handler below loses undo.
    // Deprecated, not gone, and there is no replacement that preserves
    // undo; setRangeText is the fallback when an engine refuses.
    let ok = false;
    try { ok = document.execCommand('insertText', false, r.text); } catch {}
    if (!ok) src.setRangeText(r.text, r.from, r.to, 'end');
    src.setSelectionRange(r.caret, r.caret);
    edited();
    return true;
  };
  let plainBreak = false;
  // A soft keyboard usually does NOT report Enter as a keydown. Android and
  // GBoard send keyCode 229 (or key "Unidentified") because the IME owns the
  // composition, so the keydown branch below never matched and lists simply
  // did not continue on a phone. beforeinput carries insertLineBreak on every
  // engine that matters, which is why the real handler hangs off it too.
  //
  // On a desktop press keydown gets there first and calls preventDefault,
  // which cancels beforeinput, so exactly one of these two ever fires.
  src.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;
    // the autocomplete owns Enter while it is open, as on the keydown path
    if (ac.open) return;
    if (plainBreak) { plainBreak = false; return; }
    if (continueList()) e.preventDefault();
  });
  src.addEventListener('keydown', (e) => {
    // autocomplete owns these keys while it is open
    if (ac.open) {
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); acAccept(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault(); ac.sel = (ac.sel + 1) % ac.items.length; acRender(); return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault(); ac.sel = (ac.sel - 1 + ac.items.length) % ac.items.length; acRender(); return;
      }
      if (e.key === 'Escape') { e.preventDefault(); acClose(); return; }
    }
    // Smart list continuation. Prose kinds only: a "- " in a hoon or js file is
    // not a list item. Shift+Enter is the deliberate escape hatch, and it is
    // also what the browser gives a user who wants a plain newline.
    //
    // A modifier here means "just break the line", and the beforeinput handler
    // below has no modifier state of its own, so record the decision for it.
    if (e.key === 'Enter') plainBreak = e.shiftKey || e.metaKey || e.ctrlKey || e.altKey;
    if (e.key === 'Enter' && !plainBreak && continueList()) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (src.readOnly) return;   // readOnly blocks typing, not scripted edits
      const s = src.selectionStart;
      src.value = src.value.slice(0, s) + '  ' + src.value.slice(src.selectionEnd);
      src.selectionStart = src.selectionEnd = s + 2;
      edited();
    }
  });

// ── src/55-autocomplete.js ────────────────────────────────────────────────
  // ── wikilink autocomplete ────────────────────────────────────────────────
  // Typing `[[` opens a list of pages from the tree we already hold (no
  // request, no index). Wikilink names are absolute page paths, so a sibling
  // still has to be written in full. Ranking exists to make that cheap.
  const acEl = $('ac'), acMirror = $('acmirror');
  let ac = { open: false, start: -1, items: [], sel: 0 };

  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const segOf = (p) => p.slice(p.lastIndexOf('/') + 1);

  // rank: the last segment matching beats the path matching, a sibling of the
  // page being edited beats a stranger, shallower and shorter break ties.
  function acRank(q) {
    const here = current ? dirOf(current) : folderCtx || '';
    const ql = q.toLowerCase();
    const out = [];
    for (const n of nodes) {
      if (!n.page || n.path === current) continue;
      const path = n.path, seg = segOf(path).toLowerCase(), pl = path.toLowerCase();
      let sc;
      if (!ql) sc = 10;
      else if (seg === ql) sc = 130;
      else if (seg.startsWith(ql)) sc = 100;
      else if (pl.startsWith(ql)) sc = 80;
      else if (seg.includes(ql)) sc = 55;
      else if (pl.includes(ql)) sc = 30;
      else continue;
      const d = dirOf(path);
      if (d === here) sc += 40;                      // sibling of what you are editing
      else if (here && d.startsWith(here + '/')) sc += 20;   // below you
      sc -= (path.split('/').length - 1) * 2;        // prefer shallower
      sc -= path.length * 0.02;                      // prefer shorter
      out.push({ path, sc });
    }
    return out.sort((a, b) => b.sc - a.sc).slice(0, 8).map((x) => x.path);
  }

  // caret position, measured through a mirror that shares the textarea's
  // geometry, correct on wrapped lines, where a column calculation is not.
  let acAnchor = null;   // {start, left, top, lh} - raw mirror offsets at ac.start
  const acCtx = document.createElement('canvas').getContext('2d');
  function acMeasureAnchor(pos) {
    const cs = getComputedStyle(src);
    for (const k of ['fontFamily', 'fontSize', 'lineHeight', 'padding', 'letterSpacing',
                     'whiteSpace', 'overflowWrap', 'tabSize'])
      acMirror.style[k] = cs[k];
    acMirror.style.width = src.clientWidth + 'px';
    acMirror.textContent = src.value.slice(0, pos);
    const mark = document.createElement('span');
    mark.textContent = '\u200b';
    acMirror.appendChild(mark);
    const a = { start: pos, left: mark.offsetLeft, top: mark.offsetTop,
                lh: parseFloat(cs.lineHeight || '18') };
    acMirror.textContent = '';
    acCtx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    return a;
  }
  // the full-prefix mirror layout is expensive on large documents, so it runs
  // once per [[ site. While the dropdown stays open only the short query after
  // the anchor changes, and its width comes from measureText, not a relayout.
  function caretXY() {
    if (!acAnchor || acAnchor.start !== ac.start) acAnchor = acMeasureAnchor(ac.start);
    const q = src.value.slice(ac.start, src.selectionStart);
    const x = acAnchor.left + acCtx.measureText(q).width - src.scrollLeft;
    const y = acAnchor.top - src.scrollTop + acAnchor.lh;
    return [x, y];
  }

  const acClose = () => { ac.open = false; acEl.hidden = true; acAnchor = null; };

  function acRender() {
    acEl.textContent = '';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Tab to complete \u00b7 \u2191\u2193 to choose \u00b7 Esc to dismiss';
    acEl.appendChild(hint);
    ac.items.forEach((path, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (i === ac.sel ? ' on' : '');
      const nm = document.createElement('span');
      nm.className = 'nm'; nm.textContent = segOf(path);
      const dir = document.createElement('span');
      dir.className = 'dir'; dir.textContent = dirOf(path) || '/';
      row.append(nm, dir);
      row.onmousedown = (e) => { e.preventDefault(); acAccept(i); };
      acEl.appendChild(row);
    });
    const [x, y] = caretXY();
    acEl.hidden = false;
    // keep it inside the editor pane
    const w = src.clientWidth, h = src.clientHeight;
    acEl.style.left = Math.max(4, Math.min(x, w - acEl.offsetWidth - 8)) + 'px';
    acEl.style.top = (y + acEl.offsetHeight > h ? Math.max(4, y - acEl.offsetHeight - 20) : y) + 'px';
  }

  // open only inside an UNCLOSED [[ on the caret's own line
  function acScan() {
    if (src.readOnly || mode === 'know') return acClose();
    const upto = src.value.slice(0, src.selectionStart);
    const line = upto.slice(upto.lastIndexOf('\n') + 1);
    const i = line.lastIndexOf('[[');
    if (i < 0) return acClose();
    const q = line.slice(i + 2);
    if (q.includes(']]') || q.includes('[')) return acClose();
    if (!/^[a-z0-9/._~-]*$/i.test(q)) return acClose();
    const items = acRank(q);
    if (!items.length) return acClose();
    ac = { open: true, start: src.selectionStart - q.length, items, sel: 0 };
    acRender();
  }

  function acAccept(i) {
    if (!ac.open) return;
    const path = ac.items[i === undefined ? ac.sel : i];
    if (!path) return;
    const before = src.value.slice(0, ac.start);
    const after = src.value.slice(src.selectionStart);
    const tail = after.startsWith(']]') ? after.slice(2) : after;
    src.value = before + path + ']]' + tail;
    const caret = before.length + path.length + 2;
    src.setSelectionRange(caret, caret);
    acClose();
    edited();
  }

  src.addEventListener('input', acScan);
  src.addEventListener('click', acClose);
  src.addEventListener('blur', acClose);

// ── src/60-preview.js ─────────────────────────────────────────────────────
  // ── preview pane: <lat-preview> ──────────────────────────────────────────
  // Content kinds render through page-preview (srcdoc). Computed kinds (hoon,
  // js, css) show the page's live DATA via /f/<name>, refreshed after save/cmd.
  customElements.define('lat-preview', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML =
        '<iframe class="prev" id="prev" title="live preview"></iframe>';
      prev = $('prev');
      // blank it NOW, not when the first page opens. An iframe with no srcdoc
      // is an opaque white canvas, and the first thing that used to call
      // prevBlank was boot's trailing newFile(). So the pane sat white for
      // the whole load and then popped to the theme background.
      prevBlank();
    }
  });
  // stale-shell guard: swap a cached pre-component shell's literal iframe
  if (!document.querySelector('lat-preview')) {
    const stale = document.querySelector('iframe.prev');
    if (stale) stale.remove();
    const el = document.createElement('lat-preview');
    el.style.display = 'contents';
    document.getElementById('ws').appendChild(el);
  }
  const CONTENT = () => ['md', 'gmi', 'html', 'text'].includes(pkind.value);
  let prevTimer = null;
  async function refreshPreview() {
    // a hidden pane renders to nobody, but the POST still costs ~2s of pier
    // time and delays the autosave queued behind it (worst on mobile, where
    // the code tab hides the preview entirely).
    if (document.hidden) return;
    if (isMobile() && ws.dataset.mv !== 'prev') return;
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
      // clear the STATUS too, not just the error box. save() sets
      // 'compiling…' for computed kinds and only checkErrors can resolve it,
      // so without this every hoon/js/css page sat at "compiling…" forever
      // and looked wedged when it had in fact compiled fine.
      if (!CONTENT()) st('compiled ok');
      refreshPreview();
    }
  }

// ── src/65-ctl.js ─────────────────────────────────────────────────────────
  // ── controls pane: <lat-ctl> frame ───────────────────────────────────────
  // Renders the pane skeleton with one tag per panel. The panel components
  // (lat-knowtags 68, lat-share 66, lat-history/lat-links 77) upgrade when
  // NB: no lat-perms. Group EDITING lives in the full-window ACL pane now.
  // This column only points existing groups at the open file (66-share).
  // their own files run, in file order. Button handlers wired below in this
  // file (and in later files) find their elements because the frame renders
  // here first.
  let cerr;
  customElements.define('lat-ctl', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<aside class="ctl">
  <h3>status</h3>
  <div id="cerr" class="ok">&nbsp;</div>
  <lat-knowtags></lat-knowtags>
  <lat-share></lat-share>
  <lat-shared></lat-shared>
  <lat-history></lat-history>
  <lat-links></lat-links>
  <button id="mv" class="mvbtn">move / rename</button>
  <button id="del" class="del">delete page</button>
</aside>`;
      cerr = $('cerr');
    }
  });
  // stale-shell guard: swap a cached pre-component shell's literal pane
  if (!document.querySelector('lat-ctl')) {
    const stale = document.querySelector('aside.ctl');
    if (stale) stale.remove();
    const el = document.createElement('lat-ctl');
    el.style.display = 'contents';
    document.getElementById('ws').appendChild(el);
  }

  // NB: the command box is gone from this panel. It POSTed to /page-cmd, the
  // input channel for a programmable page. The ROUTE stays, since public form
  // submissions (POST /f/<page>) go through the same handler, but nothing in
  // the editor sends to it now.

  // ── delete ───────────────────────────────────────────────────────────────
  $('del').onclick = async () => {
    if (mode === 'know') { deleteKnow(); return; }
    if (curFolder) {
      const path = curFolder;
      const c = pageCount(path);
      const what = 'delete folder ' + path +
        (c ? ' and the ' + c + ' page' + (c === 1 ? '' : 's') + ' under it?' : '?');
      if (!(await askConfirm(what, 'delete'))) return;
      const r = await mutate(api + '/page-del?name=' + encodeURIComponent(path));
      if (!r.ok) { st('delete failed ' + r.status, false); return; }
      dropTreeNodes(path);
      snapTree();
      newFile('');
      st('deleted ' + path);
      return;
    }
    if (!current) { st('nothing to delete', false); return; }
    if (!(await askConfirm('delete ' + current + '?', 'delete'))) return;
    const doomed = current;
    const r = await mutate(api + '/page-del?name=' + encodeURIComponent(doomed));
    if (!r.ok) { st('delete failed ' + r.status, false); return; }
    dropTreeNodes(doomed);
    snapTree();
    newFile('');
    st('deleted');
  };

// ── src/66-share.js ───────────────────────────────────────────────────────
  // ── sharing panel: <lat-share> (pages and folder trees share it) ─────────
  let cwurl;
  customElements.define('lat-share', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="sharesec">
<h3>sharing</h3>
<div class="share" id="share">
  <button data-m="private">private</button>
  <button data-m="shared">shared</button>
  <button data-m="clearweb">clearweb</button>
</div>
<div id="cwurl" class="muted"></div>
<h3>give a ship access</h3>
<div class="row"><input id="shwith" placeholder="~ship" autocomplete="off"><button id="shread">read</button><button id="shedit">edit</button></div>
<div id="shres" class="muted"></div>
<h3 class="grouphead">give a group access <a id="aclopen" title="create and edit groups">manage &rarr;</a></h3>
<div id="grouplist" class="muted"></div>
</div>`;
      cwurl = $('cwurl');
    }
  });
  function showShare(m) {
    // the grant result names "this page", so it MUST NOT outlive the page it
    // was about. Every target change (page open, new file, folder select,
    // beacon sync) routes through here. A fuzz run caught it claiming
    // "~nec can now edit this page" while a different page was open, which
    // is a permissions UI telling the user something false.
    $('shres').textContent = '';
    for (const b of document.querySelectorAll('.share button'))
      b.className = b.dataset.m === m ? 'on' : '';
    // the group toggles are about THIS file, so they follow the same
    // every-target-change hook the grant message does
    renderGroupAccess();
    const target = curFolder || current;
    const suffix = curFolder ? '/' : '';
    cwurl.innerHTML =
      m === 'clearweb' && target
        ? 'public: <a href="' + api + '/c/' + target + suffix +
          '" target="_blank">/c/' + target + suffix + '</a>'
      : m === 'mixed' ? 'mixed — pages under this folder differ'
      : '';
  }
  for (const b of document.querySelectorAll('.share button')) {
    b.onclick = async () => {
      const m = b.dataset.m;
      if (curFolder) {
        const r = await mutate(api + '/page-share-tree?name=' + encodeURIComponent(curFolder) +
          '&mode=' + m);
        if (!r.ok) { st('share failed ' + r.status, false); return; }
        showShare(m);
        st(m === 'clearweb' ? 'published tree at /c/' + curFolder + '/' : 'tree set ' + m);
        // share-tree sets every page under the folder. Mirror that locally
        // instead of refetching the tree to learn what we just did.
        for (const n of nodes)
          if (n.page && n.path.startsWith(curFolder + '/')) n.share = m;
        snapTree();
        renderTree();
        return;
      }
      if (!current) { st('save the page first', false); return; }
      const r = await mutate(api + '/page-share?name=' + encodeURIComponent(current) +
        '&mode=' + m);
      if (!r.ok) { st('share failed ' + r.status, false); return; }
      showShare(m);
      st('sharing: ' + m);
      const n = nodes.find((x) => x.page && x.path === current);
      if (n) n.share = m;
      snapTree();
      renderTree();
    };
  }

  // ── per-file share-with: grant one ship read/edit on the OPEN page ───────
  // Writes through the same usergroups as the peers panel (an auto-group named
  // after the ship), then notifies them. The response says whether the notice
  // arrived. The grant is durable either way.
  const shareWith = async (mode) => {
    const shp = $('shwith').value.trim();
    if (!current) { st('open a page first', false); return; }
    if (!shp) { st('enter a ship', false); return; }
    // NAME the page rather than saying "this page". The editor's target can
    // change from eleven places (mode toggle, grub mode, memory open, rename,
    // …) and only four of them route through showShare, so a clear-on-change
    // hook is whack-a-mole. A fuzz run caught the message surviving the
    // pages/knowledge toggle. A message that names its own subject cannot go
    // false no matter what the editor does next, which is the property that
    // actually matters for a permissions UI.
    const page = current;
    $('shres').textContent = 'granting…';
    const r = await mutate(api + '/share-file?name=' + encodeURIComponent(page) +
      '&ship=' + encodeURIComponent(shp) + '&mode=' + mode);
    if (!r || !r.ok) {
      let msg = r ? r.status : 'network';
      if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
      $('shres').textContent = '';
      st('share failed: ' + msg, false);
      return;
    }
    const j = await r.json();
    $('shres').textContent = shp + ' can now ' + mode + ' ' + page +
      (j.notified ? ' — notified.' : ' — could not notify (offline?); the grant holds.');
    loadPerms();          // the peers panel shows the auto-group
  };
  $('shread').onclick = () => shareWith('read');
  $('shedit').onclick = () => shareWith('edit');

  // ── per-file group access ────────────────────────────────────────────────
  // The same read/edit grant as the ship row above, but pointed at a group
  // rather than one ship. This pane only SETS existing groups on this file.
  // Creating and editing the groups themselves is the ACL pane's job (there is
  // a link), which is what took the busy chip editor out of this narrow
  // column. Grants go through permSave, so both surfaces agree.
  //
  // A group's grant on a page is the page's own ball path in its peek/make,
  // exactly what the server's share-file writes, so a per-ship grant and a
  // per-group grant are the same kind of rule and read back the same way.
  const pagePath = (name) => '/apps/lattice.lattice_app/page/' + name;

  function renderGroupAccess() {
    const host = $('grouplist');
    if (!host) return;
    host.textContent = '';
    const target = curFolder || current;
    if (!target) {
      host.className = 'muted';
      host.textContent = 'open a page to grant access.';
      return;
    }
    if (!permsLoaded) {
      host.className = 'muted';
      host.textContent = 'loading groups…';
      return;
    }
    if (!permGroups.length) {
      host.className = 'muted';
      host.textContent = 'no groups yet — use manage → to make one.';
      return;
    }
    host.className = '';
    const path = pagePath(target);
    for (const g of permGroups) {
      const row = document.createElement('div');
      row.className = 'grow-row';
      const nm = document.createElement('span');
      nm.className = 'gname';
      nm.textContent = g.name;
      row.appendChild(nm);
      const mk = (label, on, fn) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (on) b.className = 'on';
        b.onclick = fn;
        row.appendChild(b);
      };
      const canRead = g.peek.includes(path);
      const canEdit = g.make.includes(path);
      mk('read', canRead, () => {
        if (canRead) {
          // dropping read drops edit. Edit without read cannot be exercised
          g.peek = g.peek.filter((x) => x !== path);
          g.make = g.make.filter((x) => x !== path);
        } else g.peek.push(path);
        permSave(g);
      });
      mk('edit', canEdit, () => {
        if (canEdit) g.make = g.make.filter((x) => x !== path);
        else {
          if (!g.peek.includes(path)) g.peek.push(path);   // edit implies read
          g.make.push(path);
        }
        permSave(g);
      });
      host.appendChild(row);
    }
  }
  $('aclopen').onclick = () => aclOpen();

// ── src/67-perms.js ───────────────────────────────────────────────────────
  // ── usergroups: the shared data layer ────────────────────────────────────
  // No UI of its own any more. The busy chip editor that used to live in the
  // editor's narrow right column moved to the full-window ACL pane (72-acl.js).
  // The right column now only SETS existing groups on the open file (66-share).
  // Both surfaces read permGroups and write through permSave, so they cannot
  // disagree about what is in force.
  //
  // Backed by grubbery usergroups via /share-groups. The vocabulary is read
  // and edit, where read is weir peek and edit is weir make. Poke grants and
  // non-directory rules are real but dojo territory. The server preserves
  // them verbatim on every save, and the ACL pane reports how many exist.
  let permGroups = [];
  // "no groups yet" and "not loaded yet" are different claims, and the group
  // list is deferred off boot's critical path. Without this flag the panel
  // asserts you have no groups for the second or two before the answer lands.
  let permsLoaded = false;
  async function loadPerms() {
    let r = null;
    try { r = await fetch(api + '/share-groups'); } catch {}
    if (!r || !r.ok) {
      st('could not load groups (' + (r ? r.status : 'network') + ')', false);
      return;
    }
    permGroups = await r.json();
    permsLoaded = true;
    // every surface that renders groups repaints from this one load
    if (typeof renderAcl === 'function') renderAcl();
    if (typeof renderGroupAccess === 'function') renderGroupAccess();
  }
  async function permSave(g) {
    const r = await fetch(api + '/share-group-save?name=' + encodeURIComponent(g.name), {
      method: 'POST',
      body: JSON.stringify({ ships: g.ships, peek: g.peek, make: g.make }),
    }).catch(() => null);
    if (!r || !r.ok) {
      let msg = r ? r.status : 'network';
      if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
      st('permissions: ' + msg, false);
    }
    // re-read either way: the server is the authority, and a failed save must
    // snap the panels back to what is actually in force rather than show the
    // grant the user believes they made.
    loadPerms();
  }

// ── src/68-knowtags.js ────────────────────────────────────────────────────
  // ── knowledge tags panel: <lat-knowtags> ─────────────────────────────────
  // Wiring and rendering live in 95-know.js (they are know-mode logic); this
  // component only owns the markup. 95 runs later, so its $-lookups resolve.
  customElements.define('lat-knowtags', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="knowmeta" hidden>
  <h3>tags</h3>
  <div id="ktags" class="chips"></div>
  <div class="row"><input id="ktag" placeholder="add tag" autocomplete="off"><button id="ktagadd">tag</button></div>
  <div id="kupd" class="muted"></div>
</div>`;
    }
  });

// ── src/69-shared.js ──────────────────────────────────────────────────────
  // ── shared with me: <lat-shared>, files other ships granted us ───────────
  // Fed by their share notices. These are claims, not capabilities. The entry
  // proves itself when opened, and a stale one can just be removed.
  customElements.define('lat-shared', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="swmsec">
<h3>shared with me</h3>
<div id="swmlist" class="muted">loading…</div>
</div>`;
    }
  });
  async function loadShared() {
    let r = null;
    try { r = await fetch(api + '/shared-with-me'); } catch {}
    if (!r || !r.ok) { $('swmlist').textContent = 'could not load'; return; }
    const items = await r.json();
    const host = $('swmlist');
    host.textContent = '';
    if (!items.length) {
      host.className = 'muted';
      host.textContent = 'nothing yet — when a peer shares a file with you it appears here.';
      return;
    }
    host.className = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'chips';
      const a = document.createElement('a');
      a.textContent = it.host + ' ' + shortPath(it.path, items.map((x) => x.path)) +
        ' (' + it.mode + ')';
      a.title = it.path + ' — open in the editor';
      a.href = '/apps/lattice/app?grub=' + encodeURIComponent(it.path) +
        '&ship=' + encodeURIComponent(it.host);
      const x = document.createElement('a');
      x.textContent = '×';
      x.title = 'remove from this list (does not touch their grant)';
      x.onclick = async () => {
        await fetch(api + '/shared-with-me-del?host=' + encodeURIComponent(it.host) +
          '&path=' + encodeURIComponent(it.path), { method: 'POST' }).catch(() => null);
        loadShared();
      };
      row.appendChild(a); row.appendChild(x);
      host.appendChild(row);
    }
  }
  // deferred to boot, same reason as loadPerms. See 67-perms.js.

// ── src/70-upload.js ──────────────────────────────────────────────────────
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
    if (degraded || offCount) {
      upShow();
      upMsg.textContent = 'offline — uploads need the ship (queued edits will sync first)';
      return;
    }
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
    // only create folders the tree does not already have. Each folder-new is
    // a ~2s writer round-trip, and re-uploading into an existing tree used to
    // pay it for every directory.
    for (const d of [...dirs].sort()) {
      if (hasNode(d)) continue;
      try { await mutate(api + '/folder-new?name=' + encodeURIComponent(d)); }
      catch {}
    }
    // ONE request per chunk, not one per file: every request pays the pier's
    // ~0.5s floor serially, so a 20-file drop used to be ~20 round-trips of
    // pure overhead doing work the server can batch. Chunked because the
    // route bounds a single transaction (200) and a whole folder should not
    // become one unbounded write.
    const CHUNK = 50;
    let fails = 0, done = 0;
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      upProg(done, list.length, part[0].name);
      let r = null;
      try {
        const payload = [];
        for (const it of part)
          payload.push({ name: it.name, type: it.kind, body: (await it.file.text()) || '\n' });
        r = await mutate(api + '/page-save-batch',
          { method: 'POST', body: JSON.stringify(payload) });
      } catch {}
      if (!r || !r.ok) {
        // the batch is all-or-nothing, so report the whole chunk rather than
        // implying some of it landed
        fails += part.length;
        let msg = r ? r.status : 'network';
        if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
        upErr.textContent += `failed: ${part.length} file(s) — ${msg}\n`;
      } else {
        for (const it of part) addTreeNode(it.name, it.kind);
      }
      done += part.length;
    }
    upProg(list.length, list.length, '');
    upMsg.textContent = fails ? `done with ${fails} failures` : `uploaded ${list.length} files`;
    snapTree();
    renderTree();
    if (!fails) setTimeout(() => { upPanel.hidden = true; }, 2500);
  }

  const fromFileList = (fl) =>
    [...fl].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));

  // desktop shell: webkit2gtk has no webkitdirectory (folder picks are dead
  // on Linux), so the tauri pick_upload command opens the native dialog and
  // hands back {rel, text} for user-picked files. Browsers keep the inputs.
  const deskPick = window.__TAURI__ && (async (dir) => {
    try {
      const picked = await window.__TAURI__.core.invoke('pick_upload',
        { dir, exts: Object.keys(KMAP) });
      if (picked.length)
        uploadItems(picked.map((p) => ({ file: { text: async () => p.text }, rel: p.rel })));
    } catch (e) {
      upShow(); upMsg.textContent = ''; upErr.textContent = 'native picker failed: ' + e;
    }
  });
  $('upfiles').onclick = deskPick ? () => deskPick(false) : () => $('fpick').click();
  $('updir').onclick = deskPick ? () => deskPick(true) : () => $('dpick').click();
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

// ── src/72-acl.js ─────────────────────────────────────────────────────────
  // ── access control pane: <lat-acl>, the peers panel with room to work ────
  // Same data and same endpoints as the narrow editor panel (67-perms.js).
  // This is a full-window overlay for organising it. Deliberately NOT a third
  // setMode branch. setMode is wired into the tree/editor lifecycle and access
  // control has nothing to do with either (same reasoning as 40-grub.js).
  //
  // Costs no boot requests. It renders permGroups, which boot already loads
  // off the critical path, and only fetches if the pane is opened before that
  // landed. Every mutation goes through permSave, so the narrow panel and this
  // one can never disagree.
  //
  // POKE GRANTS ARE READ-ONLY HERE, deliberately. The server preserves them
  // verbatim on save and refuses to set them from the editor ("the editor has
  // no business granting eval power"). A grant of eval capability stays a
  // dojo-level act. They are shown so this pane never hides live rules.
  customElements.define('lat-acl', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="aclwrap" hidden role="dialog" aria-modal="true" aria-label="access control">
  <div class="aclbar">
    <h2>Access control</h2>
    <span class="muted" id="aclsum"></span>
    <span class="grow"></span>
    <button id="aclreload" class="ico" title="reload from ship">&#8635;</button>
    <button id="aclclose">close</button>
  </div>
  <div class="aclbody">
    <div class="row">
      <input id="aclnew" placeholder="new group name (e.g. friends)" autocomplete="off">
      <button id="aclnewbtn">create group</button>
    </div>
    <div id="aclgrid" class="aclgrid"></div>
    <div class="aclban">
      <h4>banned ships</h4>
      <p class="aclnote">A banned ship cannot share anything with you and
      cannot be granted access — banning revokes what it already had. It does
      NOT hide pages you have published: those are readable by anyone, so
      unpublish to stop a read.</p>
      <div class="row">
        <input id="banship" placeholder="~ship" autocomplete="off" spellcheck="false">
        <button id="banadd">ban</button>
      </div>
      <div id="banlist" class="chips"></div>
    </div>
  </div>
  <datalist id="aclpaths"></datalist>
</div>`;
    }
  });

  const aclOpen = () => {
    $('aclwrap').hidden = false;
    aclPathOptions();
    // permGroups is populated by boot's deferred load. Only pay a request if
    // the pane was opened before that landed.
    if (!permGroups.length) loadPerms(); else renderAcl();
    loadBans();
  };
  const aclClose = () => { $('aclwrap').hidden = true; };

  // suggest the grantable paths this client already knows about, so a grant is
  // a pick rather than a hand-typed ball path. Built from the tree we have.
  function aclPathOptions() {
    const dl = $('aclpaths');
    if (!dl) return;
    dl.textContent = '';
    const base = '/apps/lattice.lattice_app';
    const seen = new Set([base + '/pub', base + '/page']);
    for (const n of nodes) seen.add(base + '/page/' + n.path);
    for (const p of seen) {
      const o = document.createElement('option');
      o.value = p;
      dl.appendChild(o);
    }
  }

  function aclChips(host, items, onDel, label) {
    const row = document.createElement('div');
    row.className = 'chips';
    if (!items.length) {
      const e = document.createElement('span');
      e.className = 'aclnote';
      e.textContent = 'none';
      row.appendChild(e);
    }
    for (const it of items) {
      const a = document.createElement('a');
      a.textContent = (label ? label(it) : it) + ' ×';
      a.title = 'remove ' + it;
      a.onclick = () => onDel(it);
      row.appendChild(a);
    }
    host.appendChild(row);
  }

  function aclSection(card, label, items, onDel, disp) {
    const h = document.createElement('h4');
    h.textContent = label;
    card.appendChild(h);
    aclChips(card, items, onDel, disp);
  }

  function renderAcl() {
    const grid = $('aclgrid');
    if (!grid) return;
    grid.textContent = '';
    $('aclsum').textContent = permGroups.length
      ? permGroups.length + ' group' + (permGroups.length === 1 ? '' : 's')
      : '';
    if (!permGroups.length) {
      const e = document.createElement('div');
      e.className = 'aclempty';
      e.textContent = 'No groups yet. A group names ships and what they may read or edit.';
      grid.appendChild(e);
      return;
    }
    for (const g of permGroups) {
      const card = document.createElement('div');
      card.className = 'aclcard';

      const head = document.createElement('header');
      const b = document.createElement('b');
      b.textContent = g.name;
      const del = document.createElement('button');
      del.textContent = 'delete';
      del.className = 'acl-del';
      del.onclick = async () => {
        if (!(await askConfirm('delete group ' + g.name + ' and every grant it carries?', 'delete'))) return;
        await fetch(api + '/share-group-del?name=' + encodeURIComponent(g.name), { method: 'POST' }).catch(() => null);
        loadPerms();
      };
      head.appendChild(b); head.appendChild(del);
      card.appendChild(head);

      aclSection(card, 'ships', g.ships, (v) => {
        g.ships = g.ships.filter((x) => x !== v); permSave(g);
      });
      const srow = document.createElement('div');
      srow.className = 'row';
      const sin = document.createElement('input');
      sin.placeholder = '~ship';
      sin.autocomplete = 'off';
      const sadd = document.createElement('button');
      sadd.textContent = 'add ship';
      const addShip = () => {
        const v = sin.value.trim();
        if (!v) return;
        if (!g.ships.includes(v)) { g.ships.push(v); permSave(g); }
        sin.value = '';
      };
      sadd.onclick = addShip;
      sin.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addShip(); } };
      srow.appendChild(sin); srow.appendChild(sadd);
      card.appendChild(srow);

      // one disambiguation scope for the whole pane, so the same page shows
      // the same short name in every card
      const allPaths = permGroups.flatMap((x) => [...x.peek, ...x.make]);
      const disp = (v) => shortPath(v, allPaths);
      aclSection(card, 'read', g.peek, (v) => {
        // dropping read must drop edit too. Edit without read is a grant that
        // cannot be exercised, and it would silently reappear as "read" on the
        // next save because addPath re-adds it.
        g.peek = g.peek.filter((x) => x !== v);
        g.make = g.make.filter((x) => x !== v);
        permSave(g);
      }, disp);
      aclSection(card, 'edit', g.make, (v) => {
        g.make = g.make.filter((x) => x !== v); permSave(g);
      }, disp);

      const prow = document.createElement('div');
      prow.className = 'row';
      const pin = document.createElement('input');
      pin.placeholder = '/apps/lattice.lattice_app/pub';
      pin.setAttribute('list', 'aclpaths');
      pin.autocomplete = 'off';
      const radd = document.createElement('button');
      radd.textContent = '+read';
      const eadd = document.createElement('button');
      eadd.textContent = '+edit';
      const addPath = (edit) => {
        const v = pin.value.trim();
        if (!v) { st('enter a path to grant', false); return; }
        if (!g.peek.includes(v)) g.peek.push(v);           // edit implies read
        if (edit && !g.make.includes(v)) g.make.push(v);
        permSave(g);
        pin.value = '';
      };
      radd.onclick = () => addPath(false);
      eadd.onclick = () => addPath(true);
      prow.appendChild(pin); prow.appendChild(radd); prow.appendChild(eadd);
      card.appendChild(prow);

      if ((g.poke && g.poke.length) || g.opaque) {
        const h = document.createElement('h4');
        h.textContent = 'not editable here';
        card.appendChild(h);
        const m = document.createElement('div');
        m.className = 'aclnote';
        const parts = [];
        if (g.poke && g.poke.length) parts.push(g.poke.length + ' poke grant(s)');
        if (g.opaque) parts.push(g.opaque + ' advanced rule(s)');
        m.textContent = parts.join(' + ') +
          ' — preserved exactly as they are on every save. Poke grants eval' +
          ' power, so they stay a dojo-level act.';
        card.appendChild(m);
        if (g.poke && g.poke.length) {
          const l = document.createElement('div');
          l.className = 'aclnote';
          l.textContent = g.poke.join(', ');
          card.appendChild(l);
        }
      }
      grid.appendChild(card);
    }
  }

  // ── banlist ──────────────────────────────────────────────────────────────
  // Deny is not something a weir can say, so it is the app's own list. Banning
  // revokes group membership server-side. The response says how many groups
  // changed, because "banned" with grants still live would be a lie.
  let banned = [];
  async function loadBans() {
    try {
      const r = await fetch(api + '/banlist');
      if (!r.ok) return;
      banned = await r.json();
    } catch { return; }
    renderBans();
  }
  function renderBans() {
    const host = $('banlist');
    if (!host) return;
    host.textContent = '';
    if (!banned.length) {
      const e = document.createElement('span');
      e.className = 'aclnote';
      e.textContent = 'nobody is banned.';
      host.appendChild(e);
      return;
    }
    for (const w of banned) {
      const a = document.createElement('a');
      a.textContent = w + ' ×';
      a.title = 'unban ' + w;
      a.onclick = async () => {
        await fetch(api + '/unban?ship=' + encodeURIComponent(w), { method: 'POST' })
          .catch(() => null);
        st('unbanned ' + w + ' — it holds no access until you grant it again');
        loadBans();
      };
      host.appendChild(a);
    }
  }
  $('banadd').onclick = async () => {
    const w = $('banship').value.trim();
    if (!w) return;
    const r = await fetch(api + '/ban?ship=' + encodeURIComponent(w), { method: 'POST' })
      .catch(() => null);
    if (!r || !r.ok) {
      let msg = r ? r.status : 'network';
      if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
      st('ban: ' + msg, false);
      return;
    }
    const j = await r.json().catch(() => ({}));
    st('banned ' + w + (j.revoked ? ' — revoked from ' + j.revoked + ' group(s)' : ''));
    $('banship').value = '';
    loadBans();
    loadPerms();          // membership changed server-side. Repaint the groups
  };
  $('banship').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('banadd').click(); }
  };

  $('aclclose').onclick = aclClose;
  $('aclreload').onclick = () => loadPerms();
  $('aclnewbtn').onclick = async () => {
    const v = $('aclnew').value.trim();
    if (!v) return;
    await permSave({ name: v, ships: [], peek: [], make: [] });
    $('aclnew').value = '';
  };
  $('aclnew').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('aclnewbtn').click(); }
  };
  $('aclt').onclick = aclOpen;
  // Escape closes, matching the in-app dialog's behaviour
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('aclwrap').hidden) aclClose();
  });

// ── src/73-comments.js ────────────────────────────────────────────────────
  // ── comments inbox: <lat-comments> ───────────────────────────────────────
  // Comments arrive from OTHER ships, and until now the workspace had no view
  // of them. The reader rendered a thread per page, so finding out anyone had
  // replied meant visiting each published page. This is the owner's side: what
  // came in, across every page, newest first, with a way to remove one.
  //
  // Reuses the .aclwrap/.aclbar/.aclbody overlay styles rather than growing a
  // second set that would drift from them.
  customElements.define('lat-comments', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="cmwrap" hidden role="dialog" aria-modal="true" aria-label="comments">
  <div class="aclbar">
    <h2>Comments</h2>
    <span class="muted" id="cmsum"></span>
    <span class="grow"></span>
    <button id="cmreload" class="ico" title="reload from ship">&#8635;</button>
    <button id="cmclose">close</button>
  </div>
  <div class="aclbody">
    <div id="cmlist"></div>
  </div>
</div>`;
    }
  });

  let inbox = [];
  async function loadComments() {
    const host = $('cmlist');
    if (host && !host.childElementCount) {
      host.className = 'aclempty';
      host.textContent = 'loading…';
    }
    let d = null;
    try {
      const r = await fetch(api + '/comments-inbox');
      if (!r.ok) { st('comments failed ' + r.status, false); return; }
      d = await r.json();
    } catch { st('comments failed', false); return; }
    inbox = d.items || [];
    renderComments(d.total || inbox.length);
  }

  function renderComments(total) {
    const host = $('cmlist');
    if (!host) return;
    host.textContent = '';
    host.className = '';
    $('cmsum').textContent = inbox.length
      ? inbox.length + (total > inbox.length ? ' of ' + total : '') + ' comment'
        + (total === 1 ? '' : 's')
      : '';
    if (!inbox.length) {
      host.className = 'aclempty';
      // say WHY it might be empty. Comments are opt-in per page, so "none yet"
      // and "never enabled anywhere" look identical and mean different things
      host.textContent = 'No comments. They are opt-in per page — turn them on '
        + 'from a page’s sharing controls.';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'aclgrid';
    for (const c of inbox) {
      const card = document.createElement('div');
      card.className = 'aclcard';
      const head = document.createElement('header');
      const who = document.createElement('b');
      who.textContent = c.author;
      const del = document.createElement('button');
      del.textContent = 'remove';
      del.className = 'acl-del';
      del.onclick = async () => {
        if (!(await askConfirm('remove this comment by ' + c.author + '?', 'remove'))) return;
        const r = await fetch(api + '/comment-del?page=' + encodeURIComponent(c.page) +
          '&id=' + encodeURIComponent(c.id), { method: 'POST' }).catch(() => null);
        if (!r || !r.ok) { st('remove failed' + (r ? ' ' + r.status : ''), false); return; }
        st('comment removed');
        loadComments();
      };
      head.appendChild(who); head.appendChild(del);
      card.appendChild(head);

      // the page it landed on, clickable. The point of an inbox is getting
      // to the thing being talked about
      const on = document.createElement('a');
      on.className = 'gname';
      on.textContent = c.page;
      on.style.cursor = 'pointer';
      on.onclick = () => { cmClose(); openPage(c.page); };
      card.appendChild(on);

      const body = document.createElement('div');
      body.style.whiteSpace = 'pre-wrap';
      body.style.overflowWrap = 'anywhere';
      body.textContent = c.body;
      card.appendChild(body);

      const when = document.createElement('div');
      when.className = 'aclnote';
      when.textContent = c.when;
      card.appendChild(when);
      grid.appendChild(card);
    }
    host.appendChild(grid);
  }

  const cmOpen = () => { $('cmwrap').hidden = false; loadComments(); };
  const cmClose = () => { $('cmwrap').hidden = true; };
  $('cmclose').onclick = cmClose;
  $('cmreload').onclick = loadComments;
  $('cmt').onclick = cmOpen;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('cmwrap').hidden) cmClose();
  });

// ── src/75-move.js ────────────────────────────────────────────────────────
  // ── move / rename ────────────────────────────────────────────────────────
  // page-move does the whole thing server-side (copy + share carry-over +
  // delete, wikilink self-references rewritten) in ONE request. The old
  // client choreography was 3 round-trips per page plus one per folder.
  // Memories use the know-move route (history preserved).
  async function movePage(oldName, newName) {
    const r = await mutate(api + '/page-move?from=' + encodeURIComponent(oldName) +
      '&to=' + encodeURIComponent(newName));
    if (!r.ok) { st('move failed ' + r.status, false); return false; }
    for (const n of nodes) if (n.page && n.path === oldName) n.path = newName;
    if (newName.includes('/')) addFolderNodes(newName.slice(0, newName.lastIndexOf('/')));
    snapTree();
    renderTree();
    return true;
  }

  async function moveFolder(oldPath) {
    const to = await ask('move / rename folder ' + oldPath + ' to:', oldPath, 'move');
    if (!to || to === oldPath) return;
    const newPath = to.trim().replace(/^\/+|\/+$/g, '');
    if (!newPath) return;
    const mapped = (p) => newPath + p.slice(oldPath.length);
    st('moving ' + oldPath + ' \u2192 ' + newPath + '\u2026');
    const r = await mutate(api + '/page-move?from=' + encodeURIComponent(oldPath) +
      '&to=' + encodeURIComponent(newPath));
    if (!r.ok) { st('move failed ' + r.status, false); return; }
    let moved = 0;
    for (const n of nodes)
      if (n.path === oldPath || n.path.startsWith(oldPath + '/')) {
        if (n.page) moved++;
        n.path = mapped(n.path);
      }
    if (newPath.includes('/')) addFolderNodes(newPath.slice(0, newPath.lastIndexOf('/')));
    if (current && (current === oldPath || current.startsWith(oldPath + '/')))
      current = mapped(current);
    snapTree();
    renderTree();
    st('moved ' + oldPath + ' \u2192 ' + newPath + ' (' + moved + ' pages)');
    if (current) openPage(current);
    else if (curFolder === oldPath) selectFolder(newPath);
  }

// ── src/77-history.js ─────────────────────────────────────────────────────
  // ── history + backlinks panels: <lat-history>, <lat-links> ───────────────
  // Defined here (before this file's own $-lookups). They upgrade inside the
  // <lat-ctl> frame rendered at 65.
  customElements.define('lat-history', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="histsec" hidden>
  <h3 id="histh">history &#9656;</h3>
  <div id="histview" class="row" hidden>
    <button id="hrestore">restore</button>
    <button id="hback">back to latest</button>
  </div>
  <div id="histlist" class="chips"></div>
</div>`;
    }
  });
  customElements.define('lat-links', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="linksec" hidden>
  <h3 id="linkh">linked from &#9656;</h3>
  <div id="linklist" class="chips"></div>
</div>`;
    }
  });

  // ── backlinks: pages that wikilink [[this page]] ─────────────────────────
  // fetched ONLY when the panel is expanded. This and history were two more
  // ~2s round-trips paid on every page open whether or not anyone looked.
  const linkSec = $('linksec'), linkList = $('linklist');
  async function loadBacklinks() {
    linkList.textContent = '';
    if (!current || mode === 'know') return;
    const r = await fetch(api + '/page-backlinks?name=' + encodeURIComponent(current));
    if (!r.ok) return;
    const links = ((await r.json()).links || []).filter((p) => p !== current);
    if (!links.length) {
      const d = document.createElement('div');
      d.className = 'muted';
      d.textContent = 'nothing links here yet';
      linkList.appendChild(d);
      return;
    }
    for (const pth of links) {
      const a = document.createElement('a');
      a.textContent = pth;
      a.onclick = () => openPage(pth);
      linkList.appendChild(a);
    }
  }

  // collapsed-by-default panels. First expand does the fetch
  let histOpen = false, linksOpen = false;
  const panelArrow = (el, base, open) => { el.textContent = base + (open ? ' ▾' : ' ▸'); };
  function resetPanels() {
    histOpen = false; linksOpen = false;
    histList.textContent = ''; linkList.textContent = '';
    histList.hidden = true; linkList.hidden = true;
    histView.hidden = true;
    const on = !!current && mode !== 'know';
    histSec.hidden = !on;
    linkSec.hidden = !on;
    panelArrow($('histh'), 'history', false);
    panelArrow($('linkh'), 'linked from', false);
  }
  $('histh').onclick = () => {
    if (histSec.hidden) return;
    histOpen = !histOpen;
    panelArrow($('histh'), 'history', histOpen);
    histList.hidden = !histOpen;
    if (!histOpen) histView.hidden = true;
    else if (!histList.childElementCount) loadHistory();
  };
  $('linkh').onclick = () => {
    if (linkSec.hidden) return;
    linksOpen = !linksOpen;
    panelArrow($('linkh'), 'linked from', linksOpen);
    linkList.hidden = !linksOpen;
    if (linksOpen && !linkList.childElementCount) loadBacklinks();
  };

  // ── version history (born keeps every save; autosave makes it dense) ────
  const histSec = $('histsec'), histList = $('histlist'), histView = $('histview');
  let revKind = null;
  const exitRev = () => {
    viewingRev = null;
    revKind = null;
    src.readOnly = false;
    histView.hidden = true;
  };
  async function loadHistory() {
    histList.textContent = '';
    if (!current || mode === 'know') return;
    const r = await fetch(api + '/page-history?name=' + encodeURIComponent(current));
    if (!r.ok) return;
    const revs = (await r.json()).revisions || [];
    if (revs.length < 2) {               // a single revision is just "now"
      const d = document.createElement('div');
      d.className = 'muted';
      d.textContent = 'no history yet';
      histList.appendChild(d);
      return;
    }
    for (const v of revs.slice(0, 30)) {
      const a = document.createElement('a');
      // ~2026.7.27..19.12.23..xxxx -> 7.27 19:12
      const m = (v.updated || '').match(/\.(\d+\.\d+)\.\.(\d+)\.(\d+)/);
      a.textContent = '#' + v.rev + (m ? ' \u00b7 ' + m[1] + ' ' + m[2] + ':' + m[3] : '');
      a.className = v.rev === viewingRev ? 'on' : '';
      a.onclick = () => openRev(v.rev);
      histList.appendChild(a);
    }
  }
  async function openRev(rev) {
    const r = await fetch(api + '/page-source-at?name=' + encodeURIComponent(current) +
      '&rev=' + rev);
    if (!r.ok) { st('revision load failed ' + r.status, false); return; }
    const d = await r.json();
    viewingRev = rev;
    revKind = d.kind === 'index' ? 'md' : d.kind;   // restore under the REVISION's kind
    dirty = false;
    src.value = d.body;
    src.readOnly = true;
    render(); sync();
    histView.hidden = false;
    for (const a of histList.children)
      a.className = a.textContent.split(' ')[0] === '#' + rev ? 'on' : '';
    st('viewing rev ' + rev + ' \u00b7 read-only');
    if (CONTENT()) refreshPreview();
  }
  $('hback').onclick = () => { exitRev(); openPage(current); };
  $('hrestore').onclick = async () => {
    if (viewingRev === null) return;
    const rev = viewingRev, kind = revKind;
    exitRev();
    dirty = true;          // the historical body is now an unsaved local edit
    await save(kind);      // under the revision's OWN kind, not the current select
    st('restored rev ' + rev + ' as the newest revision');
    loadHistory();
  };

  $('mv').onclick = async () => {
    if (curFolder) { moveFolder(curFolder); return; }
    if (!current) { st('open something first', false); return; }
    const to = await ask('move ' + (mode === 'know' ? 'memory' : 'page') + ' ' + current + ' to:',
      current, 'move');
    if (!to || to === current) return;
    const newName = to.trim().replace(/^\/+|\/+$/g, '');
    if (!newName) return;
    if (mode === 'know') {
      const r = await mutate(api + '/know-move?from=' + encodeURIComponent(current) +
        '&to=' + encodeURIComponent(newName));
      if (!r.ok) { st('move failed ' + r.status, false); return; }
      // the body is already in the editor. Rename in place, no refetch
      knowGen++;
      const k = knowKeys.find((x) => x.key.replace(/^\//, '') === current);
      if (k) k.key = newName;
      current = newName;
      pname.value = newName;
      renderKnowChips();
      renderKnowTree();
      st('moved to ' + newName);
      return;
    }
    if (await movePage(current, newName)) {
      st('moved to ' + newName);
      openPage(newName);
    }
  };

// ── src/85-layout.js ──────────────────────────────────────────────────────
  // ── layout toggles + mobile tabs ─────────────────────────────────────────
  const ws = $('ws');
  // soft-wrap is the default (long lines running off-screen are unusable on
  // mobile). The toggle still turns it off, and a saved preference wins.
  if (!('appWrap' in localStorage)) localStorage.appWrap = '1';
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

  const isMobile = () => matchMedia('(max-width: 820px)').matches;
  const setMv = (v) => {
    ws.dataset.mv = v;
    for (const x of document.querySelectorAll('.mtabs button'))
      x.className = x.dataset.mv === v ? 'on' : '';
    if (v === 'prev') refreshPreview();
  };
  for (const b of document.querySelectorAll('.mtabs button'))
    b.onclick = () => setMv(b.dataset.mv);
  // On a phone the code pane is the wrong place to land. With no file open it
  // is an empty box, and the tree is how you get anywhere. Start on the tree
  // and let opening a file move us. applyPage switches to 'code' on mobile,
  // so a remembered or ?name page still lands in the editor. Desktop shows
  // every pane at once, so 'code' remains right there.
  setMv(isMobile() ? 'tree' : 'code');

  // ── pane resize: drag a boundary, double-click it to reset ───────────────
  // Widths live in CSS custom properties on #ws (see .psplit in the shell
  // css). Outer panes store px. The editor/preview boundary stores the
  // editor's fr share against the preview's fixed 1fr, so it keeps meaning
  // when the window or the outer panes change size.
  {
    let panes = {};
    try { panes = JSON.parse(localStorage.appPanes || '{}'); } catch {}
    const applyPanes = () => {
      ws.style.setProperty('--wtree', panes.tree ? panes.tree + 'px' : '');
      ws.style.setProperty('--wed', panes.ed ? panes.ed + 'fr' : '');
      ws.style.setProperty('--wctl', panes.ctl ? panes.ctl + 'px' : '');
    };
    applyPanes();
    const lim = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const wire = (id, key, drag) => {
      const h = $(id);
      if (!h) return;                    // stale cached shell without handles
      // the reset gesture is detected from pointerup pairs, NOT dblclick.
      // pointerdown must preventDefault (otherwise native selection starts
      // and eats the pointer stream mid-drag), and a cancelled pointerdown
      // never produces the derived click/dblclick events at all.
      let lastTap = 0;
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        h.classList.add('drag');
        const x0 = e.clientX;
        let moved = false;
        const move = (ev) => {
          if (!moved && Math.abs(ev.clientX - x0) <= 3) return;   // tap jitter
          moved = true;
          drag(ev.clientX);
          applyPanes();
        };
        const up = () => {
          h.removeEventListener('pointermove', move);
          h.classList.remove('drag');
          if (!moved && Date.now() - lastTap < 450) { delete panes[key]; applyPanes(); }
          lastTap = moved ? 0 : Date.now();
          try { localStorage.appPanes = JSON.stringify(panes); } catch {}
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up, { once: true });
      });
    };
    wire('ph1', 'tree', (x) => { panes.tree = Math.round(lim(x, 130, 480)); });
    wire('ph3', 'ctl', (x) => { panes.ctl = Math.round(lim(innerWidth - x, 190, 520)); });
    wire('ph2', 'ed', (x) => {
      const ed = document.querySelector('.edwrap').getBoundingClientRect();
      const pv = document.querySelector('.prev').getBoundingClientRect();
      panes.ed = Math.round(lim((x - ed.left) / Math.max(60, pv.right - x), 0.25, 4) * 1000) / 1000;
    });
  }

// ── src/90-sync.js ────────────────────────────────────────────────────────
  // ── live refresh (beacon keep-SSE + focus + idle poll) ───────────────────
  // The writer bumps /beacon/rev on every mutation. On a real change refresh
  // the tree AND the open page. So an edit made on another device shows up
  // here without a reload. Local unsaved edits always win. `dirty` blocks the
  // content swap until the page is saved or reopened.
  async function refreshOpen() {
    if (!current || curFolder || dirty || document.hidden || viewingRev !== null) return;
    // remember WHAT we are fetching. By the time it lands the user may have opened
    // another page, switched mode, selected a folder, or entered history view.
    // Applying a stale body then would show the wrong content or, across modes,
    // autosave a page body over a memory.
    const wasCurrent = current, wasMode = mode;
    // a queued edit outranks the ship's copy. Reconciling now would paint
    // the stale server body over work that has not synced yet
    if (await offGet(mode === 'know' ? 'know:' + current : current)) return;
    const url = mode === 'know'
      ? api + '/know-read?key=' + encodeURIComponent(current)
      : api + '/page-source?name=' + encodeURIComponent(current);
    let d = null;
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      d = await r.json();
    } catch { return; }
    if (dirty || current !== wasCurrent || mode !== wasMode) return;
    if (curFolder || viewingRev !== null) return;
    // A KIND change with an UNCHANGED body still needs handling. Retagging a
    // page (gmi -> md, say) leaves the text byte-identical, so the body check
    // below returns early and the preview keeps rendering with the old builder.
    // That lasts forever, because the boot snapshot caches the rendered html
    // too. This request has no &render=1, so re-open the page properly rather
    // than trying to patch the preview from a response that does not contain
    // one.
    if (mode !== 'know' && d.kind && d.kind !== curKind) { openPage(wasCurrent); return; }
    // track the rev even when the BODY is unchanged. A save from elsewhere
    // that landed the same text still moved the revision, and a stale curRev
    // makes the next save carry a stale base, manufacturing a false
    // conflict (and a conflicts/ page) out of nothing
    if (mode !== 'know' && d.rev) curRev = d.rev;
    if (d.body === src.value) return;
    // the ship's copy moved under us. This page's cached render is stale
    if (mode !== 'know') pageCache.delete(wasCurrent);
    const top = src.scrollTop;
    src.value = d.body;
    render();
    src.scrollTop = top;
    sync();
    if (mode === 'know') {
      renderKnowTags(d.tags || []);
      st('memory updated from ship');
    } else {
      snapPage(current, d);
      showShare(d.share || 'private');
      refreshPreview();
      st('updated from ship \u00b7 rev ' + d.rev);
    }
  }
  const refreshAll = () => {
    if (document.hidden) return;
    // replay WINS the reconnect race. loadTree would repaint queued pages
    // from the server dump before their edits landed (design doc, gap 4)
    if (degraded || offCount) { replayQueue(); return; }
    // NB: stale cached renders are dropped by loadTree, which prunes against
    // the revs in the fresh dump. Clearing the whole cache here instead meant
    // one page's edit cost every other page its cache.
    if (mode === 'know') loadKnow(); else loadTree();
    refreshOpen();
  };
  try {
    const es = new EventSource('/grubbery/api/keep/apps/lattice.lattice_app/beacon/rev');
    let beaconTimer = null;
    es.addEventListener('upd', () => {
      // our own save bumps the beacon too. Refetching tree + source to learn
      // about content this client just wrote was ~4s of pier time per save.
      // A remote edit inside the echo window is caught by the 30s poll/focus.
      if (Date.now() < echoUntil) return;
      clearTimeout(beaconTimer);
      beaconTimer = setTimeout(refreshAll, 300);
    });
  } catch {}
  // coming back to the tab/window is the moment staleness shows. Catch it
  // directly, plus a gentle 30s idle poll in case the SSE stream died.
  window.addEventListener('focus', refreshAll);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
  setInterval(refreshOpen, 30000);

// ── src/95-know.js ────────────────────────────────────────────────────────
  // ── knowledge mode ───────────────────────────────────────────────────────
  // The same workspace, pointed at the private memory store: browse keys as a
  // tree, filter by tag chips, read/edit/save entries, tag/untag, delete.
  let mode = 'pages';
  let knowKeys = [];        // [{key, tags, updated, bytes}] from know-list
  let knowTag = '';         // active tag filter ('' = all)
  const chipsEl = $('chips'), knowMeta = $('knowmeta'), ktagsEl = $('ktags');

  async function loadKnow() {
    const gen = knowGen;
    const r = await fetch(api + '/know-list');
    if (!r.ok) { st('know-list failed ' + r.status, false); return; }
    const d = await r.json();
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
    // a queued edit outranks the ship's copy, same rule as pages
    const q = await offGet('know:' + key);
    let d = null;
    if (q) d = { body: q.body, tags: (knowEntry(key) || { tags: [] }).tags, updated: 'queued offline' };
    else {
      let r = null;
      try { r = await fetch(api + '/know-read?key=' + encodeURIComponent(key)); } catch {}
      if (!r || !r.ok) { st('open failed ' + (r ? r.status : '— offline'), false); return; }
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
        if (!r.ok) { st('untag failed ' + r.status, false); return; }
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
    if (!r.ok) { st('tag failed ' + r.status, false); return; }
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
    if (!src.value) { st('empty body', false); return; }
    if (viewingRev !== null) { st('viewing a revision — use restore', false); return; }
    const sent = src.value;
    echoUntil = Date.now() + 60000;
    let r = null;
    try { r = await tfetch(api + '/know-save?key=' + encodeURIComponent(key),
      { method: 'POST', body: sent }); } catch {}
    echoUntil = Date.now() + 4000;
    if (shipGone(r)) {
      await enqueueKnow(key, sent);
      current = key;
      pname.readOnly = true;
      if (src.value === sent) dirty = false;
      return;
    }
    if (!r.ok) { st('save failed ' + r.status, false); return; }
    current = key;
    pname.readOnly = true;
    if (src.value === sent) dirty = false;
    st('memory saved');
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
    if (!r.ok) { st('delete failed ' + r.status, false); return; }
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

// ── src/98-legacy.js ──────────────────────────────────────────────────────
  // ── legacy agent import (one-time offer) ─────────────────────────────────
  // A ship upgraded from the pre-grubbery %lattice gall agent may still have
  // it installed with knowledge this store never saw. Ask once, in-app, then
  // never again. The server marker is authoritative (it survives a new
  // browser), and the localStorage flag keeps resolved installs from spending
  // a request on the check at all.
  async function legacyCheck() {
    if (localStorage.latLegacy === 'done') return;
    let d = null;
    try { d = await (await fetch(api + '/legacy-status')).json(); } catch { return; }
    if (!d) return;
    // ONLY the server's marker is permanent. 'absent' can mean the agent is
    // merely suspended (|revive brings it back), and caching that as done
    // would silently strand the user's data forever. Never infer permanence
    // from a negative or transient answer.
    if (d.reason === 'resolved') { localStorage.latLegacy = 'done'; return; }
    if (!d.prompt) return;
    // Quiet for the session only once the user has actually DECLINED. Setting
    // this merely because the dialog was shown meant dismissing it (Esc, click
    // outside, or a reload mid-dialog) locked the offer out of that tab
    // entirely, with no way back short of a new tab.
    if (sessionStorage.latLegacyAsked === '1') return;
    const choice = await askChoice(
      'An older lattice agent is still installed on this ship, from before ' +
      'this store existed. Import the memories it holds?\n\nAnything already ' +
      'here is left exactly as it is, and nothing is removed from the old agent.',
      ['import them now', 'not now', 'never ask again'], 'ok');
    if (choice === null) return;            // dismissed. Offer again next load
    if (choice === 'not now') {             // explicitly declined, quiet until
      sessionStorage.latLegacyAsked = '1';  // the next browser session
      return;
    }
    if (choice === 'never ask again') {
      await mutate(api + '/legacy-dismiss');
      localStorage.latLegacy = 'done';
      st('legacy import dismissed');
      return;
    }
    stWork('importing from the old agent… this can take a few minutes');
    let r = null;
    try { r = await mutate(api + '/legacy-migrate'); } catch {}
    if (!r || !r.ok) {
      // the import can outlive the request (one serial writer poke per entry).
      // Ask the server what actually happened before reporting a failure.
      let after = null;
      try { after = await (await fetch(api + '/legacy-status')).json(); } catch {}
      if (after && after.reason === 'resolved') {
        localStorage.latLegacy = 'done';
        knowGen++;
        if (mode === 'know') loadKnow();
        st('legacy import completed');
        return;
      }
      // 504/502 is the reverse proxy giving up, not the ship failing. The
      // import keeps running server-side and is usually PARTLY done. Say what
      // landed, and name the cause, because the fix is a proxy setting.
      const cut = r && (r.status === 504 || r.status === 502);
      let listed = null;
      try { listed = await (await fetch(api + '/know-list')).json(); } catch {}
      const have = listed && listed.keys ? listed.keys.length : null;
      st((cut ? 'the connection timed out mid-import' : 'legacy import failed' + (r ? ' ' + r.status : '')) +
         (have !== null ? ' — ' + have + ' memories are here now' : '') +
         ' · nothing was removed from the old agent · run it again to finish', false);
      if (cut) {
        await askConfirm(
          'The request was cut off before it finished — the ship kept working, ' +
          'so some of it landed' + (have !== null ? ' (' + have + ' memories now here)' : '') +
          '.\n\nNothing was lost and nothing was removed from the old agent. ' +
          'Run the import again to finish; anything already here is skipped, ' +
          'so it cannot duplicate.\n\nIf this keeps happening, the reverse ' +
          'proxy in front of this ship is closing long requests — raise ' +
          'proxy_read_timeout for it (nginx defaults to 60s).',
          'got it');
        delete sessionStorage.latLegacyAsked;   // let it offer again immediately
      }
      return;
    }
    const res = await r.json();
    // only latch when the SERVER says it finished. A partial run deliberately
    // leaves its marker unwritten so the offer returns and can be retried
    if (res.complete) localStorage.latLegacy = 'done';
    else delete sessionStorage.latLegacyAsked;
    knowGen++;
    st('imported ' + res.imported + ' memories from the old agent');
    if (mode === 'know') loadKnow(); else loadTree();
    // NEVER advise retiring the old agent while it still holds pages. This
    // import moves knowledge only (the agent exposes no arm for page bodies),
    // so an uninstall on that advice would destroy them permanently.
    const kept = res.imported + ' ' + (res.imported === 1 ? 'memory' : 'memories') +
      (res.skipped ? ' (' + res.skipped + ' already here, left untouched)' : '');
    const got = res.pagesImported || 0;
    let msg = 'Imported ' + kept + (got ? ', and ' + got + ' ' + (got === 1 ? 'page' : 'pages') : '') + '.';
    // The agent is cleared for retirement ONLY when the server says the whole
    // migration completed. Never infer it from a count. An unreadable page
    // list reads as zero pages, and telling someone to uninstall on that
    // would destroy the only copy of them.
    if (!res.complete) {
      const left = [];
      if (!res.pagesKnown) left.push('its page list could not be read');
      else if ((res.pages || 0) > got + (res.pagesCollided || 0))
        left.push(((res.pages || 0) - got - (res.pagesCollided || 0)) + ' page(s) did not arrive in time');
      if (res.pagesCollided) left.push(res.pagesCollided + ' page(s) share a name with pages you already have, so they were left alone');
      msg += '\n\nNot everything moved: ' + left.join('; ') + '.' +
        '\n\nThe old agent still holds the only copy — do NOT run ' +
        '|uninstall %lattice. Reopen the editor to retry; you will be asked again.';
    } else {
      msg += '\n\nEverything it held is now here. Once you have checked your ' +
        'pages and memories, you can retire it from the dojo:\n\n    |uninstall %lattice';
    }
    await askConfirm(msg, 'got it');
    loadTree();
  }

// ── src/99-boot.js ────────────────────────────────────────────────────────
  // ── boot ─────────────────────────────────────────────────────────────────
  // paint from the last session's snapshot before the network answers. The
  // tree and (when it matches ?name) the page body + preview appear at 0ms.
  // Then loadTree/refreshOpen reconcile in the background. Local edits win,
  // same rules as any live refresh.
  // The PAGE snapshot is small synchronous localStorage, and it is what
  // makes resume paint at literally 0ms. The TREE snapshot moved to IDB
  // (phase 3), whose read is async but single-digit ms, imperceptible next
  // to the ~0.5s network floor. It also frees the tree (which carries every
  // page body) from localStorage's ~5MB ceiling.
  function bootSnap() {
    let p = null;
    try { p = JSON.parse(localStorage.appPage || 'null'); } catch {}
    if (!p || !p.name) return false;
    const name = qs.get('name');
    // No ?name means a bare launch, above all the PWA, whose start_url can
    // never carry one. Resume the snapshot page instead of landing on an
    // empty editor. "opens where I left off" is what an installed app means.
    // A ?name that does not match the snapshot still defers to the network.
    if (name && p.name !== name) return false;
    applyPage(p.name, p);
    // openPage sets the upload-target folder. The snapshot path must too,
    // or uploads land at the root until the next explicit open
    setFolderCtx(p.name);
    return true;
  }
  async function bootTree() {
    let t = await kvGet('tree');
    if (!t || !t.length) {
      // one-time migration from the localStorage era, then free the quota
      try { t = JSON.parse(localStorage.appTree || 'null'); } catch {}
      if (t && t.length) kvPut('tree', t);
    }
    try { localStorage.removeItem('appTree'); } catch {}
    // if the network dump (or any local activity) beat us here, it is fresher
    // than the snapshot. Also deliberately NO treeGen bump. A snapshot must
    // never supersede an in-flight loadTree the way a real local patch does
    if (!t || !t.length || nodes.length) return;
    nodes = t;
    renderTree();
    markCurrent();
  }
  // the control-panel lists (sharing groups, shared-with-me) are never needed
  // to read or edit anything, so they load AFTER the editor is usable. Issued
  // at parse time they were two pier round-trips queued ahead of the tree, and
  // the pier serializes, pure delay on the only requests that matter.
  const loadPanels = () => { loadPerms(); loadShared(); };
  // a queue left by a previous session syncs on open. With no Background
  // Sync (the SW must not intercept API calls), next-open IS the replay
  // moment, and the UI says so rather than implying closed-app sync exists
  setTimeout(() => { if (offCount) replayQueue(); }, 4000);
  if (qs.get('grub')) {
    // arrived from the explorer's edit link. Open that ball path directly. The
    // tree still lists lattice pages, so clicking one leaves grub mode.
    loadTree().then(loadPanels);
    openGrub(qs.get('grub'), qs.get('ship'));
  } else if (qs.get('view') === 'know') {
    setMode('know');
    legacyCheck();
    loadPanels();
  } else {
    const painted = bootSnap();
    bootTree();
    // what the snapshot painted, if anything. The baseline for "did the USER
    // do something while the dump was in flight?"
    const bootCurrent = current;
    loadTree().then(() => {
      const name = qs.get('name');
      const into = qs.get('into');
      // The tree paints from localStorage at 0ms, so it is clickable long
      // before this resolves. Anything boot does by default would then land on
      // top of the user's own action, opening a page and having it close a
      // second later, which is exactly what the trailing newFile('') did.
      // Compare against bootCurrent, not against null. A snapshot-painted page
      // is not a user action and still wants its refreshOpen reconcile.
      const touched = current !== bootCurrent || curFolder !== null || dirty;
      if (touched) {
        legacyCheck();
        loadPanels();
        return;
      }
      if (name) {
        if (painted && current === name) refreshOpen();
        else openPage(name);
      }
      else if (into && nodes.some((n) => !n.page && n.path === into)) selectFolder(into);
      // no focus: boot did not ask for a new file, the user did not either
      else if (into) newFile(into, false);
      // bare launch, snapshot resumed a page above. Reconcile it, do not
      // clobber it with an empty new-file view
      else if (current) refreshOpen();
      else newFile('', false);
      legacyCheck();
      loadPanels();
    });
  }
})();
