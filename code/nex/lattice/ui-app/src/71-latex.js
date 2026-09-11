  // ── LaTeX to HTML ────────────────────────────────────────────────────────
  //  A .tex page gets a convert button that runs pandoc on THIS machine and
  //  writes the result back as an ordinary html page. The ship never learns
  //  LaTeX: it stores tex source as text and serves the output as html, both
  //  of which it already knew how to do.
  //
  //  Desktop only, because the conversion is a local subprocess. On the web
  //  the button is simply absent, which is honest: there is nothing there that
  //  could run it.
  //
  //  pandoc is NOT bundled (it is GPL, and 150MB). We detect the user's own
  //  install and say where to get it when there is none.
  const texRust = () => (window.__TAURI__ && window.__TAURI__.core) || null;

  //  The output page's name. A page name is a key, so the source and its
  //  output cannot share one. The tree derives the shown extension from the
  //  kind, so `paper` (tex) lists as paper.tex and `paper-web` (html) lists
  //  as paper-web.html without either name carrying an extension itself.
  const texOut = (name) => name + '-web';

  let texProbe = null;         // last probe result, per page open

  const texBtn = () => $('texconv');

  //  Probed on every .tex page open rather than once at boot: someone who
  //  installs pandoc and comes back should find the button live without
  //  restarting the app.
  async function refreshTexButton() {
    const b = texBtn();
    if (!b) return;
    const rust = texRust();
    const isTex = curKind === 'tex' || pkind.value === 'tex';
    if (!rust || !isTex || mode === 'know') { b.hidden = true; return; }
    b.hidden = false;
    b.textContent = 'convert to html';
    b.disabled = false;                     // never a dead control: see below
    texProbe = await probePandoc(rust);
    b.title = texProbe.available
      ? 'convert this LaTeX to a sibling html page using ' +
        (texProbe.version || 'pandoc')
      : texProbe.stale
        ? 'this desktop build predates LaTeX support (click for what to do)'
        : 'needs pandoc installed on this machine (click to find out how)';
    //  The button stays CLICKABLE without pandoc, and explains itself when
    //  pressed. A disabled control with no explanation is a dead end: the
    //  person who most needs the message is the one who cannot click.
    b.classList.toggle('needsdep', !(texProbe && texProbe.available));
  }

  //  A rejected invoke means one of two very different things, and saying the
  //  wrong one sends someone off to install software they already have. An
  //  app built before these commands existed rejects with "not found"; a real
  //  probe answers {available:false} when pandoc is genuinely missing.
  async function probePandoc(rust) {
    try {
      const r = await rust.invoke('pandoc_probe');
      return r && typeof r === 'object' ? r : { available: false };
    } catch (e) {
      const msg = String((e && e.message) || e || '');
      return {
        available: false,
        stale: /not found|not allowlisted|unknown command|does not exist/i.test(msg),
        why: msg.slice(0, 200),
      };
    }
  }

  //  a double click must not launch two converts: both write the same output
  //  page and the second surfaces the race as a write failure.
  let texConvBusy = false;

  async function convertTex() {
    if (texConvBusy) return;
    texConvBusy = true;
    try { await runConvertTex(); }
    finally { texConvBusy = false; }
  }

  async function runConvertTex() {
    const rust = texRust();
    if (!rust) return;
    if (!texProbe) texProbe = await probePandoc(rust);
    if (texProbe.stale) {
      //  the UI comes from the ship and updates on reload. The commands it
      //  calls live in the binary, which does not. That gap is exactly what
      //  this branch exists to name.
      st('this desktop build has no LaTeX support yet', false);
      await askConfirm(
        'This copy of the desktop app was built before LaTeX support existed, ' +
        'so it has no converter to call. The web UI updated on its own; the ' +
        'app has to be rebuilt and reinstalled. Nothing is wrong with your ' +
        'pandoc install.', 'ok');
      return;
    }
    if (!texProbe.available) {
      st('pandoc is not installed on this machine', false);
      const go = await askConfirm(
        'Converting LaTeX needs pandoc, which is not installed. ' +
        'Open the pandoc install page?', 'open');
      if (go) rust.invoke('open_external_url', { url: 'https://pandoc.org/installing.html' });
      return;
    }
    if (!current) { st('save this page before converting', false); return; }
    const out = texOut(current);
    stWork('converting with pandoc…');
    let html = null;
    try { html = await rust.invoke('convert_tex', { src: src.value }); }
    catch (e) {
      //  pandoc names the line and the construct it choked on. Show that,
      //  not a generic failure.
      st('pandoc: ' + String(e && e.message ? e.message : e).slice(0, 160), false);
      return;
    }
    //  A derived page. Say so IN the file, because the next convert
    //  overwrites it and hand edits would vanish with no warning.
    const body = '<!-- generated from ' + current +
      '.tex by pandoc. Edits here are lost on the next convert. -->\n' + html;
    //  &new=1 only the first time: page-save answers 409 to a create over an
    //  existing name, and a re-convert is an overwrite by design.
    const known = nodes.some((n) => n.page && n.path === out);
    const url = api + '/page-save?name=' + encodeURIComponent(out) + '&type=html';
    let r = await mutate(url + (known ? '' : '&new=1'), { method: 'POST', body });
    //  the local tree can run behind the ship: a sibling created elsewhere
    //  answers our create with 409. The page exists, so retry the write the
    //  way every re-convert already works, as an overwrite.
    if (!known && r && r.status === 409)
      r = await mutate(url, { method: 'POST', body });
    if (!r || !r.ok) { st('could not write ' + out + await errText(r), false); return; }
    if (!known) { addTreeNode(out, 'html'); snapTree(); renderTree(); }
    bustPages(out);
    st('wrote ' + out + '.html');
  }

  //  wired here, where the handler lives (the same rule 45-templates and
  //  75-move follow)
  if (texBtn()) texBtn().onclick = convertTex;

  // ── live preview ─────────────────────────────────────────────────────────
  //  60-preview paints every content kind synchronously. pandoc is a
  //  subprocess and cannot answer inside that call, so this keeps the last
  //  conversion and hands it over immediately, then repaints when a fresh one
  //  lands. Declared with `function` rather than `const`: 60-preview.js loads
  //  first and names texPreviewHtml, so it must be hoisted, not in a TDZ.
  let texCache = { src: null, html: null };
  let texTimer = 0;
  let texBusy = false;

  //  400ms, not the 60ms the other kinds use. Those call a function; this
  //  spawns a process, and one per keystroke would be a fork bomb with a
  //  progress bar.
  const TEX_DEBOUNCE = 400;

  function texSourceFallback(body) {
    return '<pre>' + mdEsc(body) + '</pre>';
  }

  function texPreviewHtml(body) {
    //  On the web there is no pandoc, so show the source rather than an empty
    //  pane. A blank preview reads as broken; the source reads as honest.
    if (!texRust()) return texSourceFallback(body);
    if (texCache.src !== body) scheduleTexRender(body);
    //  until the first conversion returns, the source stands in. Typing then
    //  refines rather than flashing empty.
    return texCache.html === null ? texSourceFallback(body) : texCache.html;
  }

  function scheduleTexRender(body) {
    clearTimeout(texTimer);
    texTimer = setTimeout(() => { runTexRender(body); }, TEX_DEBOUNCE);
  }

  async function runTexRender(body) {
    const rust = texRust();
    if (!rust) return;
    //  never two pandocs at once. The newer body wins, so re-arm rather than
    //  queue: whatever is typed last is what anyone wants to see.
    if (texBusy) { scheduleTexRender(body); return; }
    if (!texProbe) texProbe = await probePandoc(rust);
    //  no renderer to call: leave the source showing rather than blanking the
    //  pane. The button carries the explanation; the preview stays quiet.
    if (!texProbe.available) { texCache = { src: body, html: null }; return; }
    texBusy = true;
    let html = null;
    let err = null;
    try { html = await rust.invoke('convert_tex', { src: body }); }
    catch (e) { err = String(e && e.message ? e.message : e); }
    texBusy = false;
    //  A broken document must SAY so. Freezing the last good render would
    //  leave a stale page on screen while the source no longer produces it.
    texCache = {
      src: body,
      html: html !== null ? html
        : '<pre style="color:#c33;white-space:pre-wrap">' +
          mdEsc(err || 'pandoc could not convert this document') + '</pre>',
    };
    //  the body may have moved on while pandoc ran
    if (src.value !== body) { scheduleTexRender(src.value); return; }
    if (typeof paintLocal === 'function') paintLocal();
  }
