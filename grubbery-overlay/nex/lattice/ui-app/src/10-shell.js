// lattice app, served from ui-app/src/, built by scripts/build-ui.mjs
  const $ = (id) => document.getElementById(id);
  const api = '/apps/lattice';
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
    caches.open('lattice-pages').then(async (c) => {
      const home = location.origin + '/apps/lattice';
      for (const k of await c.keys()) {
        let d = k.url;
        try { d = decodeURIComponent(k.url); } catch {}
        if (k.url === home || (name && d.indexOf('/' + name) >= 0)) c.delete(k.url);
      }
    }).catch(() => {});
  };
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
