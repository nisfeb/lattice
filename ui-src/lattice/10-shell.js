// lattice app, served from ui-app/src/, built by scripts/build-ui.mjs
  const $ = (id) => document.getElementById(id);
  const api = '/apps/lattice';
  // ── flat icons ───────────────────────────────────────────────────────────
  // One-colour glyphs in place of colour emoji: the tree's folders and page
  // kinds (NERDTree with devicons), and the bar's search, comments and
  // access. folder/open/search/comment/key are GitHub's Octicons, the page
  // kinds Seti-UI's, the set NERDTree's devicons draw on; both MIT. Each is
  // [viewBox, path]; Seti's boxes are cropped to match the Octicons' size.
  // The colour is CSS (.ic-md and so on), currentColor where it has none.
  const ICON = {
    folder: ['0 0 16 16', 'M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z'],
    open: ['0 0 16 16', 'M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1H13a1 1 0 0 1 1 1v.5H2.75a.75.75 0 0 0 0 1.5h11.978a1 1 0 0 1 .994 1.117L15 13.25A1.75 1.75 0 0 1 13.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.91.513-1.237Z'],
    search: ['0 0 16 16', 'M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z'],
    comment: ['0 0 16 16', 'M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z'],
    key: ['0 0 16 16', 'M10.5 0a5.499 5.499 0 1 1-1.288 10.848l-.932.932a.749.749 0 0 1-.53.22H7v.75a.749.749 0 0 1-.22.53l-.5.5a.749.749 0 0 1-.53.22H5v.75a.749.749 0 0 1-.22.53l-.5.5a.749.749 0 0 1-.53.22h-2A1.75 1.75 0 0 1 0 14.25v-2c0-.199.079-.389.22-.53l4.932-4.932A5.5 5.5 0 0 1 10.5 0Zm-4 5.5c-.001.431.069.86.205 1.269a.75.75 0 0 1-.181.768L1.5 12.56v1.69c0 .138.112.25.25.25h1.69l.06-.06v-1.19a.75.75 0 0 1 .75-.75h1.19l.06-.06v-1.19a.75.75 0 0 1 .75-.75h1.19l1.023-1.025a.75.75 0 0 1 .768-.18A4 4 0 1 0 6.5 5.5ZM11 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z'],
    md: ['4 4 24 24', 'M20.7 6.7v9.9h3.8c-2.9 3-5.8 5.9-8.7 8.8-2.7-2.8-5.6-5.8-8.4-8.7h3.5V6.6c1.3.9 4.4 3.1 5 3.1.6 0 3.6-2.2 4.8-3z'],
    tex: ['4 4 24 24', 'M7.9 17.5H6.5v1.3h4.4v-1.3H9.6V11h.4c1.2 0 1.4.1 1.6 1h1.2l-.2-2.3H4.8l-.3 3.6h1.2v-.5c.2-1.7.3-1.8 1.8-1.8h.4v6.5zM15.8 21.1h-1.7v-2.8h.6c.7 0 .7 0 .7.9v.5h1.2v-4.1h-1.2v.5c0 .9 0 .9-.7.9h-.6v-2.4h1.6c1.5 0 1.6.4 1.7 1.8h1.2l-.3-3.2h-7v1.3h1v6.4h-1v1.3h7.1l.4-2.6h-1.3c0 1.1-.4 1.5-1.7 1.5zM21.7 17.6h-.5l1.5-2.2 1.5 2.2h-.3v1.1h3.6v-1.2H27c-.6 0-.6 0-.7-.2l-2.4-3.5 1.6-2.3c.2-.2.4-.6 1.1-.6h.5V9.6H24v1.2h.5l-.1.1-1.2 1.7-1.3-1.6h.3V9.6h-3.6V11h.5c.6 0 .6 0 .7.2l2.1 3.1-1.8 2.7-.3.3c-.2.2-.5.3-.8.3h-.5v1.2h3.2v-1.2z'],
    html: ['4 4 24 24', 'M8 15l6-5.6V12l-4.5 4 4.5 4v2.6L8 17v-2zm16 2.1l-6 5.6V20l4.6-4-4.6-4V9.3l6 5.6v2.2z'],
    css: ['4 4 24 24', 'M10.3 23.3l.8-4H8.6v-2.1h3l.5-2.5H9.5v-2.1h3.1l.8-3.9h2.8l-.8 3.9h2.8l.8-3.9h2.8l-.8 3.9h2.5v2.1h-2.9l-.6 2.5h2.6v2.1h-3l-.8 4H16l.8-4H14l-.8 4h-2.9zm6.9-6.1l.5-2.5h-2.8l-.5 2.5h2.8z'],
    js: ['4 4 24 24', 'M11.4 10h2.7v7.6c0 3.4-1.6 4.6-4.3 4.6-.6 0-1.5-.1-2-.3l.3-2.2c.4.2.9.3 1.4.3 1.1 0 1.9-.5 1.9-2.4V10zm5.1 9.2c.7.4 1.9.8 3 .8 1.3 0 1.9-.5 1.9-1.3s-.6-1.2-2-1.7c-2-.7-3.3-1.8-3.3-3.6 0-2.1 1.7-3.6 4.6-3.6 1.4 0 2.4.3 3.1.6l-.6 2.2c-.5-.2-1.3-.6-2.5-.6s-1.8.5-1.8 1.2c0 .8.7 1.1 2.2 1.7 2.1.8 3.1 1.9 3.1 3.6 0 2-1.6 3.7-4.9 3.7-1.4 0-2.7-.4-3.4-.7l.6-2.3z'],
    file: ['250 150 700 700', 'M394.1 537.8h411.7v54.7H394.1v-54.7zm0-130.3H624v54.7H394.1v-54.7zm0-130.3h411.7v54.7H394.1v-54.7zm0 390.9H700v54.7H394.1v-54.7z'],
  };
  const ico = (name) => {
    const k = ICON[name] ? name : 'file';
    return `<svg class="ic ic-${k}" viewBox="${ICON[k][0]}" fill="currentColor" aria-hidden="true"><path d="${ICON[k][1]}"/></svg>`;
  };
  // ── background requests yield to the user ────────────────────────────────
  // The pier runs one event at a time, so every request this client sends is
  // one the user's next click queues behind — measured: a page open landed at
  // 6.2s because three background fetches were in line ahead of it. There is
  // no cancelling a request already on the wire, so priority here means one
  // thing: do not SEND background traffic near user activity. bgFetch holds
  // its request until BG_IDLE_MS have passed since the last pointer/key
  // event; while you are actively browsing, background traffic is silent.
  //
  // For badges and syncs only. Anything the user asked for — opens, saves,
  // panel loads — uses fetch directly and must never come through here.
  //  seeded with NOW: page load counts as activity, so boot's background
  //  lane waits out the window in which a user's FIRST click arrives — the
  //  one click pointerdown cannot have preceded. Measured before this: the
  //  first open queued behind three boot fetches and took 5.2s.
  let lastAction = Date.now();
  addEventListener('pointerdown', () => { lastAction = Date.now(); }, true);
  addEventListener('keydown', () => { lastAction = Date.now(); }, true);
  const BG_IDLE_MS = 4000;
  //  ONE background request at a time, idle re-checked before EACH send.
  //  Releasing them together is an ambush: the gate opens after 4 idle
  //  seconds, three requests hit the pier's FIFO queue at once (~2s each),
  //  and the user's next click waits behind all of them — measured, that
  //  was 6s to open a page. Sequenced, the worst a click can land behind
  //  is the single background request already on the wire.
  let bgChain = Promise.resolve();
  const bgFetch = (url, opts) => {
    const run = async () => {
      for (;;) {
        const wait = BG_IDLE_MS - (Date.now() - lastAction);
        if (wait <= 0) break;
        await new Promise((r) => setTimeout(r, Math.max(wait, 250)));
      }
      return fetch(url, opts);
    };
    const p = bgChain.then(run);
    //  errors stay with the caller; the chain itself must survive them
    bgChain = p.catch(() => {});
    return p;
  };
  // the reader's LRU pages cache (sw-js serves it with NO revalidation, and
  // its beacon script converges stale paints QUIETLY — the next view is
  // fresh, not this one). Fine for edits from elsewhere; a lie for our own:
  // save here, Back into the reader, and the pre-save copy would paint with
  // nothing visibly correcting it. So every successful write busts the
  // cached views it could have changed — any entry naming the page, plus
  // home, whose listings change under every write.
  const bustPages = (name) => {
    if (!('caches' in window)) return;
    // ball paths arrive with a leading slash (spud); the needle below adds
    // its own, and '//' matches no URL — normalize or the bust is a no-op
    name = String(name || '').replace(/^\/+/, '') || null;
    caches.open('lattice-pages').then(async (c) => {
      const home = location.origin + '/apps/lattice';
      for (const k of await c.keys()) {
        let d = k.url;
        try { d = decodeURIComponent(k.url); } catch {}
        if (k.url === home || (name && d.indexOf('/' + name) >= 0)) c.delete(k.url);
      }
    }).catch(() => {});
  };
  // mirror of the server's +valid-name (@ta segments; no '.'/'..'): reject
  // BEFORE saving or queueing. The server answers 400 — cryptic online, and
  // fatal offline: the drain treats 400 as unsyncable and discards the
  // queued document it earlier reported "saved offline".
  const validName = (n) => String(n || '').split('/').every(
    (s) => s.length && s !== '.' && s !== '..' && /^[a-z0-9._~-]+$/.test(s));
  // realName: what a typed name becomes. A valid path is used as it is and
  // gets NO display name (a name is never stored twice). Anything else —
  // capitals, spaces, punctuation — is slugged per segment the way the
  // uploader slugs file names, and each segment that changed keeps its
  // typed text as the display name of the page or folder at that depth:
  // `dname` is the leaf's, `dnames` is every segment's, '/'-joined with ''
  // where the segment was fine as typed (so "notes/My Page" -> "/My Page").
  // null when even the slug is empty: there is nothing to name it by.
  const slugSeg = (s) => s.toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const realName = (typed) => {
    const t = String(typed || '').trim().replace(/^\/+|\/+$/g, '');
    if (!t) return null;
    if (validName(t)) return { name: t, dname: '', dnames: '' };
    const segs = t.split('/').map((s) => s.trim());
    const slugs = segs.map(slugSeg);
    const name = slugs.join('/');
    if (!validName(name)) return null;
    const per = segs.map((s, i) => (s === slugs[i] ? '' : s));
    return { name, dname: per[per.length - 1], dnames: per.some(Boolean) ? per.join('/') : '' };
  };
  // the query-string form of a realName() result (nothing for a valid name)
  const dnameQ = (rn) => (!rn ? '' :
    (rn.dname ? '&dname=' + encodeURIComponent(rn.dname) : '') +
    (rn.dnames ? '&dnames=' + encodeURIComponent(rn.dnames) : ''));
  // failure statuses name the actual cause. Every send-err answer carries
  // {"error": msg}, and dropping it for a bare status code wasted a cause
  // the pier already paid a round trip to deliver. Same parse the grub save
  // path uses. The body has ONE read, so a caller hands the response here
  // and reads nothing else from it.
  const errText = async (r) => {
    let msg = r ? ' ' + r.status : '';
    if (r) { try { const j = await r.json(); if (j && j.error) msg = ': ' + j.error; } catch {} }
    return msg;
  };
  // bulk writes (vault restore, drag-drop upload, know-import) name their
  // targets only in the POST body — no per-name bust is possible from the
  // URL, and a restore legitimately invalidates everything. Drop the whole
  // pages cache; it rebuilds one view at a time.
  const bustAll = () => {
    if (!('caches' in window)) return;
    // spare the /__pv marker: it is the SW's record of which page-format
    // version this cache holds, and deleting it with the cache made the
    // next activate read a mismatch and wipe every freshly cached page
    // again. Read it out, drop the cache, put it back.
    caches.open('lattice-pages').then(async (c) => {
      const hit = await c.match('/__pv');
      const pv = hit ? await hit.text() : null;
      await caches.delete('lattice-pages');
      if (pv !== null)
        await (await caches.open('lattice-pages')).put('/__pv', new Response(pv));
    }).catch(() => {});
  };
  let pname, pkind, status, spinner;   // assigned by <lat-bar>   (12-bar.js)
  let prev;                            // assigned by <lat-preview> (60-preview.js)
  // blank preview: about:blank defaults to light color-scheme, which
  // mismatches the app's declared scheme and makes the iframe an opaque
  // white canvas in dark theme. Declare the scheme so it stays transparent
  // and the pane's theme background shows through.
  // the preview frame is its own document, out of the theme's reach, so it
  // gets a copy of what theme.js set inline on <html>: the colours, the
  // forced color-scheme, Talon's font. Empty when none is set, so the frame
  // follows the OS as it always did. (An installed font is a face of THIS
  // document, so the frame gets its name and falls back unless the system
  // has it too.)
  // the theme into a preview document, and its link and selection colours
  // only where it names them: unset, the page keeps the engine's own
  const themeRoot = () => {
    const s = document.documentElement.style;
    if (!s.colorScheme && !s.getPropertyValue('--font')) return '';
    return 'html:root{' + s.cssText + '}'
      + (s.getPropertyValue('--link') ? 'a{color:var(--link)}' : '')
      + (s.getPropertyValue('--selection') ? '::selection{background:var(--selection)}' : '');
  };
  const prevBlank = () => {
    prev.removeAttribute('src');
    prev.style.minHeight = '';
    // the srcdoc paints its OWN theme background rather than relying on the
    // engine to composite a mismatched-scheme iframe as transparent. That
    // reliance is exactly the kind of behavior that differs between the
    // Chromium the tests run and the webkitgtk the desktop runs
    prev.srcdoc = '<style>:root{color-scheme:light dark}' +
      'body{margin:0;background:var(--bg,#fafafa)}' +
      '@media(prefers-color-scheme:dark){body{background:var(--bg,#1a1a1a)}}' + themeRoot() + '</style>';
  };
  // grant paths are shown in the share/ACL surfaces, and every one carries
  // the same app base, pure noise on screen: /apps/lattice.lattice_app, or
  // a desk install's longer path ending in it. Strip it, then keep the
  // SHORTEST tail that stays unique among the paths shown alongside (`all`),
  // growing only where disambiguation demands. Callers put the full path in
  // `title`, so hover always has the truth.
  const shortPath = (p, all) => {
    const strip = (x) => x.replace(/^.*?\/lattice\.lattice_app\/(page\/)?/, '');
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
      if (clashes()) return x.replace(/^.*?\/lattice\.lattice_app\//, '');
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
    status.title = msg;                      // in full, when the bar cuts it short
    status.style.color = ok ? '' : '#c0392b';
  };
  // stWork: a status that keeps spinning until the next plain st()
  const stWork = (msg) => {
    status.textContent = msg;
    status.title = msg;
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
