/* BUILT FILE — do not edit. Source: ui-app/src/, build: scripts/build-ui.mjs */
(function () {
'use strict';
// ── src/10-shell.js ───────────────────────────────────────────────────────
// lattice app — served from ui-app/src/, built by scripts/build-ui.mjs
  const $ = (id) => document.getElementById(id);
  const api = '/apps/lattice';
  let pname, pkind, status, spinner;   // assigned by <lat-bar>   (12-bar.js)
  let prev;                            // assigned by <lat-preview> (60-preview.js)
  // blank preview: about:blank defaults to light color-scheme, which
  // mismatches the app's declared scheme and makes the iframe an opaque
  // white canvas in dark theme — declare the scheme so it stays transparent
  // and the pane's theme background shows through.
  const prevBlank = () => {
    prev.removeAttribute('src');
    prev.srcdoc = '<style>:root{color-scheme:light dark}</style>';
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
  // app; only truly external http(s) leaves for the system browser.
  if (window.__TAURI__)
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[target="_blank"]');
      if (!a || !a.href) return;
      e.preventDefault();
      const ext = /^https?:/.test(a.href) && new URL(a.href).origin !== location.origin;
      if (ext) window.__TAURI__.core.invoke('plugin:opener|open_url', { url: a.href });
      else location.href = a.href;
    });

// ── src/12-bar.js ─────────────────────────────────────────────────────────
  // ── top bar + mobile tabs: <lat-bar>, <lat-tabs> ─────────────────────────
  // The spinner is part of the bar's own markup now (its CSS lives in the
  // shell stylesheet) — the old inject-styles-and-synthesize-elements guards
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
  <span class="grow"></span>
  <button id="wrapt" class="ico" title="toggle line wrap">&#8617;</button>
  <button id="treet" class="ico" title="toggle tree pane">&#9776;</button>
  <button id="ctlt" class="ico" title="toggle controls pane">&#9881;</button>
</header>`;
      pname = $('pname'); pkind = $('pkind');
      status = $('status'); spinner = $('spin');
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
  // ── in-app dialogs — NEVER browser-native prompt/confirm/alert ───────────
  // <lat-dialog> owns the dialog's markup AND wiring: the shell only carries
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
  // Rendered as real buttons in the app's own style, NEVER a <select>: a
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
    // arrow keys move between options; Enter takes the focused one
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
  let dirty = false;       // unsaved local edits — auto-refresh never clobbers them
  let viewingRev = null;   // non-null: a read-only historical revision is shown
  let curKind = null;      // the OPEN page's server kind; 'index' has no select
                           // option, so pkind.value would silently convert it
  let curFolder = null;    // selected folder path — right-pane ops target it
  let folderCtx = '';      // folder uploads land in (last into / open page's dir)
  let nodes = [];          // last page-tree
  let saving = false;      // a save round-trip is in flight — never overlap them:
  let savePending = false; // the pier serializes, so a second save just queues
                           // 3.7s of stale-body work behind the first
  let echoUntil = 0;       // our own save bumps the beacon; ignore that echo or
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
  // 30s poll). Bumped on every local mutation; stale responses are dropped.
  let treeGen = 0, knowGen = 0;
  // rendered page-source answers, by name. The tree dump already carries every
  // body, so this only adds what the dump lacks — `share` and the rendered
  // `html` — which makes re-opening a page cost ZERO requests instead of a
  // ~0.5s round-trip. Dropped whenever the ship reports a change (the beacon
  // clears it) or when this client writes the page.
  const pageCache = new Map();
  const snapTree = () => {
    treeGen++;
    try { localStorage.appTree = JSON.stringify(nodes); } catch {}
  };
  const snapPage = (name, d) => {
    try {
      localStorage.appPage = JSON.stringify(
        { name, body: d.body, kind: d.kind, share: d.share || 'private',
          rev: d.rev, html: typeof d.html === 'string' ? d.html : undefined });
    } catch {}
  };

  // every client-initiated write bumps the change beacon; hold the echo window
  // open while the request is in flight (a folder move pokes the writer many
  // times) plus a short tail, so the SSE handler never refetches what this
  // client just did itself.
  async function mutate(url, opts) {
    echoUntil = Date.now() + 60000;
    try { return await fetch(url, opts || { method: 'POST' }); }
    finally { echoUntil = Date.now() + 4000; }
  }

  const collapsed = () => {
    try { return JSON.parse(localStorage.appColl || '[]'); } catch { return []; }
  };
  const setCollapsed = (c) => { localStorage.appColl = JSON.stringify(c); };

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
  // frame; past ~60KB fall back to a trailing debounce (even one full highlight
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
  // called render() silently skipped the dirty flag, autosave and the preview
  // — a Tab indent was shown but never saved, and a live refresh reverted it.
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
  // the literal .edwrap block (and lacks the lat-* display rule) — swap it.
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
  // 70-upload) — those files run after this component upgrades, so their
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
  // zero requests — see openPage. Bodies over 256KB are omitted by the server;
  // such a node has no `body` and falls back to the per-page fetch.
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
    // clearing on every change cost every other page its cache; and comparing
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

  // selection changes only move the `cur` class — never rebuild the pane's DOM
  // for that. rowByPath is rebuilt by renderTree/renderKnowTree.
  let rowByPath = new Map();
  function markCurrent() {
    for (const [p, row] of rowByPath)
      row.classList.toggle('cur',
        row.classList.contains('pg') ? p === current : p === curFolder);
  }

  // local `nodes` patching: this client performed the write, so it already
  // knows the outcome — applying it locally replaces a page-tree refetch.
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
  // History and backlinks stay lazy on panel expand — they were 2 more ~2s
  // round-trips paid on every open whether or not anyone looked at them.
  async function openPage(name) {
    // leaving grub mode: clear the flag or the save button would keep writing
    // to the grub while the editor shows a page
    grubPath = null;
    src.readOnly = false;
    setFolderCtx(name);
    const hit = pageCache.get(name);
    if (hit) { applyPage(name, hit); snapPage(name, hit); return; }
    const node = nodes.find((n) => n.page && n.path === name);
    const painted = !!node && typeof node.body === 'string';
    // `quiet`: the render=1 request below carries the preview and the error
    // report, so painting must not also fire refreshPreview/checkErrors.
    if (painted) applyPage(name, node, true);
    let d = null;
    try {
      const r = await fetch(api + '/page-source?name=' + encodeURIComponent(name) + '&render=1');
      if (!r.ok) { if (!painted) st('open failed ' + r.status, false); return; }
      d = await r.json();
    } catch { if (!painted) st('open failed', false); return; }
    pageCache.set(name, d);
    snapPage(name, d);
    // the user may have moved to another page, or started typing, while this
    // was in flight — same rule the live refresh uses: local edits win.
    if (current !== name || dirty || viewingRev !== null) return;
    applyPage(name, d);
  }
  function applyPage(name, d, quiet) {
    current = name;
    curFolder = null;
    setCtlLabels();
    pname.value = name;
    pname.readOnly = true;
    curKind = d.kind;
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

  function newFile(into) {
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
    pname.focus();
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
    const url = api + '/page-save?name=' + encodeURIComponent(name) +
      '&type=' + kind + (creating ? '&new=1' : '');
    let r = null;
    try { r = await fetch(url, { method: 'POST', body: sent || '\n' }); }
    finally { saving = false; echoUntil = Date.now() + 4000; }
    if (r && r.status === 409) { st('that page already exists', false); return; }
    if (!r || !r.ok) { st('save failed' + (r ? ' ' + r.status : ''), false); return; }
    current = name;
    curKind = kind;
    pname.readOnly = true;
    if (src.value === sent) dirty = false;
    st(CONTENT() ? 'saved' : 'compiling\u2026');
    history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
    // only a CREATE changes the tree — refetching it after every save was a
    // 2.3s pier round-trip to learn nothing. Patch the local copy on create.
    if (creating) { addTreeNode(name, kind); snapTree(); renderTree(); }
    // we know exactly what we just wrote: patch the local copies so reopening
    // this page paints the saved text, not the dump's pre-save body. The
    // cached render is stale by definition — drop it and let it re-render.
    pageCache.delete(name);
    const nd = nodes.find((n) => n.page && n.path === name);
    if (nd) { nd.body = sent; nd.kind = kind; snapTree(); }
    // the preview already shows this exact body (the input debounce rendered
    // it); re-POSTing it after the save was a duplicate 1.8s render.
    if (CONTENT()) { cerr.textContent = 'saved'; cerr.className = 'ok'; }
    else { setTimeout(checkErrors, 800); setTimeout(checkErrors, 2200); }
    if (savePending) { savePending = false; if (dirty) autosave(); }
  }

  let autoTimer = null;
  async function autosave() {
    // GRUB MODE IS EXPLICIT-SAVE ONLY. Autosaving a lattice page is fine — it is
    // your own note and the editor has always worked that way. Autosaving
    // another app's source is not: a half-typed edit to calendar.html would go
    // live 2s after you paused, and the 5-minute history window may not have
    // kept a revision fine-grained enough to step back to. Save/Cmd+S only.
    // The 2s debounce still fires — it just reports instead of writing, so the
    // moment you stop typing you can see the edit is not yet on the ship.
    if (grubPath) { if (dirty) st('unsaved — press Save or Cmd+S'); return; }
    if (!current || curFolder || !dirty || viewingRev !== null) return;
    // never overlap saves: the pier serializes, so a second in-flight save is
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
    try { r = await fetch(url, { method: 'POST', body: sent || '\n' }); } catch {}
    saving = false;
    echoUntil = Date.now() + 4000;
    if (!r || !r.ok) { st('autosave failed' + (r ? ' ' + r.status : ''), false); return; }
    if (src.value === sent) dirty = false;   // typed during the request? stay dirty
    if (mode !== 'know') {
      pageCache.delete(current);
      const nd = nodes.find((n) => n.page && n.path === current);
      if (nd) { nd.body = sent; snapTree(); }
    }
    st('autosaved');
    if (mode !== 'know' && !CONTENT()) setTimeout(checkErrors, 800);
    if (savePending) { savePending = false; if (dirty) autosave(); }
  }

// ── src/40-grub.js ────────────────────────────────────────────────────────
  // ── editing an arbitrary grub (?grub=<ball path>) ────────────────────────
  // Any file in the ball, not just a lattice page: an app's html/js/css/hoon.
  // Deliberately NOT a third setMode branch — that function is wired into the
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
    // remote files ride /browse-file (bounded cross-ship peek); its JSON says
    // body/mark where grub-source says text/blot — normalize here, not there:
    // both routes have other consumers.
    const url = grubShip
      ? api + '/browse-file?ship=' + encodeURIComponent(grubShip) + '&path=' + encodeURIComponent(p)
      : api + '/grub-source?path=' + encodeURIComponent(p);
    let r = null;
    try { r = await fetch(url); } catch {}
    if (!r || !r.ok) { st('could not open ' + p + (r ? ' (' + r.status + ')' : ''), false); return; }
    const d = await r.json();
    src.value = d.text || d.body || '';
    // a binary/opaque grub has no text form — show it, never offer to save it
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
      // a remote save is verified server-side by revision bump: a peer that
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
      // the mark can reject the source; show ITS error, since the stored grub
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
    // a multi-page template lands as a folder: open its index if it made one,
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
      // Cmd+S matters more here than elsewhere — grub mode has no autosave.
      if (grubPath) saveGrub();
      else if (mode === 'know') saveKnow();
      else save();
    }
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
  // Typing `[[` opens a list of pages from the tree we already hold — no
  // request, no index. Wikilink names are absolute page paths, so a sibling
  // still has to be written in full; ranking exists to make that cheap.
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
  // geometry — correct on wrapped lines, where a column calculation is not.
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
  // once per [[ site; while the dropdown stays open only the short query after
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
  // Content kinds render through page-preview (srcdoc); computed kinds (hoon,
  // js, css) show the page's live DATA via /f/<name>, refreshed after save/cmd.
  customElements.define('lat-preview', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML =
        '<iframe class="prev" id="prev" title="live preview"></iframe>';
      prev = $('prev');
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
      refreshPreview();
    }
  }

// ── src/65-ctl.js ─────────────────────────────────────────────────────────
  // ── controls pane: <lat-ctl> frame ───────────────────────────────────────
  // Renders the pane skeleton with one tag per panel; the panel components
  // (lat-knowtags 68, lat-share 66, lat-history/lat-links 77) upgrade when
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
  <div id="cmdrow">
    <h3>command</h3>
    <div class="row"><input id="cmd" placeholder="command" autocomplete="off"><button id="csend">send</button></div>
  </div>
  <lat-knowtags></lat-knowtags>
  <lat-share></lat-share>
  <lat-perms></lat-perms>
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

  // ── command box ──────────────────────────────────────────────────────────
  async function sendCmd() {
    const c = $('cmd').value;
    if (!c || !current) return;
    await mutate(api + '/page-cmd?name=' + encodeURIComponent(current),
      { method: 'POST', body: 'cmd=' + encodeURIComponent(c) });
    $('cmd').value = '';
    setTimeout(refreshPreview, 600);
  }
  $('csend').onclick = sendCmd;
  $('cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCmd(); });

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
<div class="row"><input id="shwith" placeholder="~ship" autocomplete="off"><button id="shread">read</button><button id="shedit">edit</button></div>
<div id="shres" class="muted"></div>
</div>`;
      cwurl = $('cwurl');
    }
  });
  function showShare(m) {
    // the grant result names "this page", so it MUST NOT outlive the page it
    // was about — every target change (page open, new file, folder select,
    // beacon sync) routes through here. A fuzz run caught it claiming
    // "~nec can now edit this page" while a different page was open, which
    // is a permissions UI telling the user something false.
    $('shres').textContent = '';
    for (const b of document.querySelectorAll('.share button'))
      b.className = b.dataset.m === m ? 'on' : '';
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
        // share-tree sets every page under the folder — mirror that locally
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
  // after the ship), then notifies them; the response says whether the notice
  // arrived — the grant is durable either way.
  const shareWith = async (mode) => {
    const shp = $('shwith').value.trim();
    if (!current) { st('open a page first', false); return; }
    if (!shp) { st('enter a ship', false); return; }
    $('shres').textContent = 'granting…';
    const r = await mutate(api + '/share-file?name=' + encodeURIComponent(current) +
      '&ship=' + encodeURIComponent(shp) + '&mode=' + mode);
    if (!r || !r.ok) {
      let msg = r ? r.status : 'network';
      if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
      $('shres').textContent = '';
      st('share failed: ' + msg, false);
      return;
    }
    const j = await r.json();
    $('shres').textContent = shp + ' can now ' + mode + ' this page' +
      (j.notified ? ' — notified.' : ' — could not notify (offline?); the grant holds.');
    loadPerms();          // the peers panel shows the auto-group
  };
  $('shread').onclick = () => shareWith('read');
  $('shedit').onclick = () => shareWith('edit');

// ── src/67-perms.js ───────────────────────────────────────────────────────
  // ── permission editor: <lat-perms> — who can read/edit which files ───────
  // Backed by grubbery usergroups via /share-groups. The vocabulary here is
  // read (= weir peek) and edit (= weir make); poke grants and non-directory
  // rules are real but dojo territory — the server preserves them verbatim on
  // every save, and this panel only says how many exist.
  customElements.define('lat-perms', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="permsec">
<h3>peers</h3>
<div id="permlist" class="muted">loading…</div>
<div class="row"><input id="permname" placeholder="new group (e.g. friends)" autocomplete="off"><button id="permadd">group</button></div>
</div>`;
    }
  });
  let permGroups = [];
  async function loadPerms() {
    let r = null;
    try { r = await fetch(api + '/share-groups'); } catch {}
    if (!r || !r.ok) { $('permlist').textContent = 'could not load groups (' + (r ? r.status : 'network') + ')'; return; }
    permGroups = await r.json();
    renderPerms();
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
    // snap the panel back to what is actually in force rather than show the
    // grant the user believes they made.
    loadPerms();
  }
  function chipRow(host, items, label, onDel) {
    const row = document.createElement('div');
    row.className = 'chips';
    if (label) {
      const l = document.createElement('span');
      l.className = 'muted';
      l.textContent = label;
      row.appendChild(l);
    }
    for (const it of items) {
      const a = document.createElement('a');
      a.textContent = it + ' ×';
      a.title = 'remove';
      a.onclick = () => onDel(it);
      row.appendChild(a);
    }
    host.appendChild(row);
    return row;
  }
  function renderPerms() {
    const host = $('permlist');
    host.textContent = '';
    host.className = '';
    if (!permGroups.length) {
      host.className = 'muted';
      host.textContent = 'no groups yet — a group names ships and what they may read or edit.';
      return;
    }
    for (const g of permGroups) {
      const box = document.createElement('div');
      box.className = 'grp';
      const h = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = g.name;
      const del = document.createElement('button');
      del.textContent = '×';
      del.className = 'ico';
      del.title = 'delete group';
      del.onclick = async () => {
        if (!(await askConfirm('delete group ' + g.name + ' and every grant it carries?', 'delete'))) return;
        await fetch(api + '/share-group-del?name=' + encodeURIComponent(g.name), { method: 'POST' }).catch(() => null);
        loadPerms();
      };
      h.appendChild(b); h.appendChild(del);
      box.appendChild(h);
      chipRow(box, g.ships, 'ships', (v) => { g.ships = g.ships.filter((x) => x !== v); permSave(g); });
      const srow = document.createElement('div');
      srow.className = 'row';
      const sin = document.createElement('input');
      sin.placeholder = '~ship';
      const sadd = document.createElement('button');
      sadd.textContent = 'add ship';
      sadd.onclick = () => {
        const v = sin.value.trim();
        if (!v) return;
        if (!g.ships.includes(v)) { g.ships.push(v); permSave(g); }
        sin.value = '';
      };
      srow.appendChild(sin); srow.appendChild(sadd);
      box.appendChild(srow);
      chipRow(box, g.peek, 'read', (v) => { g.peek = g.peek.filter((x) => x !== v); permSave(g); });
      chipRow(box, g.make, 'edit', (v) => { g.make = g.make.filter((x) => x !== v); permSave(g); });
      const prow = document.createElement('div');
      prow.className = 'row';
      const pin = document.createElement('input');
      pin.placeholder = '/apps/lattice.lattice_app/pub';
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
      box.appendChild(prow);
      if ((g.poke && g.poke.length) || g.opaque) {
        const m = document.createElement('div');
        m.className = 'muted';
        const parts = [];
        if (g.poke && g.poke.length) parts.push(g.poke.length + ' poke');
        if (g.opaque) parts.push(g.opaque + ' advanced');
        m.textContent = parts.join(' + ') + ' rule(s) managed outside this panel — preserved on save.';
        box.appendChild(m);
      }
      host.appendChild(box);
    }
  }
  $('permadd').onclick = async () => {
    const v = $('permname').value.trim();
    if (!v) return;
    await permSave({ name: v, ships: [], peek: [], make: [] });
    $('permname').value = '';
  };
  // NOT called here: at parse time this put a pier round-trip AHEAD of the
  // tree and the open page, and the pier serializes — nothing about reading or
  // editing needs the group list. Boot calls it once the editor is usable.

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
  // ── shared with me: <lat-shared> — files other ships granted us ──────────
  // Fed by their share notices (claims, not capabilities — the entry proves
  // itself when opened, and a stale one can just be removed).
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
      a.textContent = it.host + ' ' + it.path.replace(/^\/apps\/lattice\.lattice_app\//, '') +
        ' (' + it.mode + ')';
      a.title = 'open in the editor';
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
  // deferred to boot, same reason as loadPerms — see 67-perms.js.

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
    // only create folders the tree does not already have — each folder-new is
    // a ~2s writer round-trip, and re-uploading into an existing tree used to
    // pay it for every directory.
    for (const d of [...dirs].sort()) {
      if (hasNode(d)) continue;
      try { await mutate(api + '/folder-new?name=' + encodeURIComponent(d)); }
      catch {}
    }
    let fails = 0;
    for (let i = 0; i < list.length; i++) {
      upProg(i, list.length, list[i].name);
      let r = null;
      try {
        r = await mutate(api + '/page-save?name=' + encodeURIComponent(list[i].name) +
          '&type=' + list[i].kind, { method: 'POST', body: (await list[i].file.text()) || '\n' });
      } catch {}
      if (!r || !r.ok) {
        fails++;
        upErr.textContent += `failed: ${list[i].name}${r ? ' (' + r.status + ')' : ''}\n`;
      } else {
        addTreeNode(list[i].name, list[i].kind);
      }
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

// ── src/75-move.js ────────────────────────────────────────────────────────
  // ── move / rename ────────────────────────────────────────────────────────
  // page-move does the whole thing server-side (copy + share carry-over +
  // delete, wikilink self-references rewritten) in ONE request — the old
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
  // Defined here (before this file's own $-lookups) — they upgrade inside the
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
  // fetched ONLY when the panel is expanded — this and history were two more
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

  // collapsed-by-default panels; first expand does the fetch
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
      // the body is already in the editor — rename in place, no refetch
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
  // mobile); the toggle still turns it off, and a saved preference wins.
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
  setMv('code');

// ── src/90-sync.js ────────────────────────────────────────────────────────
  // ── live refresh (beacon keep-SSE + focus + idle poll) ───────────────────
  // The writer bumps /beacon/rev on every mutation. On a real change refresh
  // the tree AND the open page — so an edit made on another device shows up
  // here without a reload. Local unsaved edits always win: `dirty` blocks the
  // content swap until the page is saved or reopened.
  async function refreshOpen() {
    if (!current || curFolder || dirty || document.hidden || viewingRev !== null) return;
    // remember WHAT we are fetching: by the time it lands the user may have opened
    // another page, switched mode, selected a folder, or entered history view —
    // applying a stale body then would show the wrong content or, across modes,
    // autosave a page body over a memory.
    const wasCurrent = current, wasMode = mode;
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
    // below returns early and the preview keeps rendering with the old builder
    // — forever, because the boot snapshot caches the rendered html too. This
    // request has no &render=1, so re-open the page properly rather than trying
    // to patch the preview from a response that does not contain one.
    if (mode !== 'know' && d.kind && d.kind !== curKind) { openPage(wasCurrent); return; }
    if (d.body === src.value) return;
    // the ship's copy moved under us: this page's cached render is stale
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
      // our own save bumps the beacon too — refetching tree + source to learn
      // about content this client just wrote was ~4s of pier time per save.
      // A remote edit inside the echo window is caught by the 30s poll/focus.
      if (Date.now() < echoUntil) return;
      clearTimeout(beaconTimer);
      beaconTimer = setTimeout(refreshAll, 300);
    });
  } catch {}
  // coming back to the tab/window is the moment staleness shows — catch it
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
  // one knowKeys entry by (normalized) key — keys may carry a leading slash
  const knowEntry = (key) =>
    knowKeys.find((x) => x.key.replace(/^\//, '') === key);

  async function openKnow(key) {
    const r = await fetch(api + '/know-read?key=' + encodeURIComponent(key));
    if (!r.ok) { st('open failed ' + r.status, false); return; }
    const d = await r.json();
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
        // this client made the change \u2014 patch the list it already holds
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
    // the writer case-folds tags; fold here too so the local patch matches
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
    const r = await mutate(api + '/know-save?key=' + encodeURIComponent(key),
      { method: 'POST', body: sent });
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
    // the toggle's visible result is the tree listing — make sure it can be
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
  // never again: the server marker is authoritative (it survives a new
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
    if (choice === null) return;            // dismissed — offer again next load
    if (choice === 'not now') {             // explicitly declined — quiet until
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
      // 504/502 is the reverse proxy giving up, not the ship failing: the
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
    // only latch when the SERVER says it finished; a partial run deliberately
    // leaves its marker unwritten so the offer returns and can be retried
    if (res.complete) localStorage.latLegacy = 'done';
    else delete sessionStorage.latLegacyAsked;
    knowGen++;
    st('imported ' + res.imported + ' memories from the old agent');
    if (mode === 'know') loadKnow(); else loadTree();
    // NEVER advise retiring the old agent while it still holds pages: this
    // import moves knowledge only (the agent exposes no arm for page bodies),
    // so an uninstall on that advice would destroy them permanently.
    const kept = res.imported + ' ' + (res.imported === 1 ? 'memory' : 'memories') +
      (res.skipped ? ' (' + res.skipped + ' already here, left untouched)' : '');
    const got = res.pagesImported || 0;
    let msg = 'Imported ' + kept + (got ? ', and ' + got + ' ' + (got === 1 ? 'page' : 'pages') : '') + '.';
    // The agent is cleared for retirement ONLY when the server says the whole
    // migration completed. Never infer it from a count: an unreadable page
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
  // paint from the last session's snapshot before the network answers: the
  // tree and (when it matches ?name) the page body + preview appear at 0ms,
  // then loadTree/refreshOpen reconcile in the background — local edits win,
  // same rules as any live refresh.
  function bootSnap() {
    let t = null, p = null;
    try {
      t = JSON.parse(localStorage.appTree || 'null');
      p = JSON.parse(localStorage.appPage || 'null');
    } catch {}
    if (!t || !t.length) return false;
    nodes = t;
    renderTree();
    const name = qs.get('name');
    if (name && p && p.name === name) applyPage(name, p);
    return true;
  }
  // the control-panel lists (sharing groups, shared-with-me) are never needed
  // to read or edit anything, so they load AFTER the editor is usable. Issued
  // at parse time they were two pier round-trips queued ahead of the tree, and
  // the pier serializes — pure delay on the only requests that matter.
  const loadPanels = () => { loadPerms(); loadShared(); };
  if (qs.get('grub')) {
    // arrived from the explorer's edit link: open that ball path directly. The
    // tree still lists lattice pages, so clicking one leaves grub mode.
    loadTree().then(loadPanels);
    openGrub(qs.get('grub'), qs.get('ship'));
  } else if (qs.get('view') === 'know') {
    setMode('know');
    legacyCheck();
    loadPanels();
  } else {
    const painted = bootSnap();
    loadTree().then(() => {
      const name = qs.get('name');
      const into = qs.get('into');
      if (name) {
        if (painted && current === name) refreshOpen();
        else openPage(name);
      }
      else if (into && nodes.some((n) => !n.page && n.path === into)) selectFolder(into);
      else if (into) newFile(into);
      else newFile('');
      legacyCheck();
      loadPanels();
    });
  }
})();
