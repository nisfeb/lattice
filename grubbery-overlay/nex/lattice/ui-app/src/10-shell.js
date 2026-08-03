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
    const me = strip(p);
    if (!me) return p;
    const segs = me.split('/');
    let n = 1;
    const tail = () => segs.slice(-n).join('/');
    const clashes = () =>
      all.some((q) => q !== p && strip(q).split('/').slice(-n).join('/') === tail());
    while (n < segs.length && clashes()) n++;
    // Out of segments and STILL ambiguous. strip() drops an optional "page/",
    // so /…/page/foo and /…/foo both reduce to "foo" with nothing left to
    // extend, and two different grants rendered identically in the ACL pane.
    // Fall back to keeping that prefix, which is what actually distinguishes
    // them. Showing a longer path beats showing the wrong one.
    if (clashes()) return p.replace(/^\/apps\/lattice\.lattice_app\//, '');
    return (n < segs.length ? '\u2026/' : '') + tail();
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
      if (ext) window.__TAURI__.core.invoke('plugin:opener|open_url', { url: a.href });
      else location.href = a.href;
    });
