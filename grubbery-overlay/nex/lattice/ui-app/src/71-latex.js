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
    try { texProbe = await rust.invoke('pandoc_probe'); }
    catch { texProbe = { available: false }; }
    b.title = texProbe && texProbe.available
      ? 'convert this LaTeX to a sibling html page using ' +
        (texProbe.version || 'pandoc')
      : 'needs pandoc installed on this machine (click to find out how)';
    //  The button stays CLICKABLE without pandoc, and explains itself when
    //  pressed. A disabled control with no explanation is a dead end: the
    //  person who most needs the message is the one who cannot click.
    b.classList.toggle('needsdep', !(texProbe && texProbe.available));
  }

  async function convertTex() {
    const rust = texRust();
    if (!rust) return;
    if (!texProbe || !texProbe.available) {
      st('pandoc is not installed on this machine', false);
      const go = await askConfirm(
        'Converting LaTeX needs pandoc, which is not installed. ' +
        'Open the pandoc install page?', 'open');
      if (go) rust.invoke('open_external_url', { url: 'https://pandoc.org/installing.html' });
      return;
    }
    if (!current) { st('save this page before converting', false); return; }
    const out = texOut(current);
    st('converting with pandoc…');
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
    const url = api + '/page-save?name=' + encodeURIComponent(out) +
      '&type=html' + (known ? '' : '&new=1');
    const r = await mutate(url, { method: 'POST', body });
    if (!r || !r.ok) { st('could not write ' + out + (r ? ' (' + r.status + ')' : ''), false); return; }
    if (!known) { addTreeNode(out, 'html'); snapTree(); renderTree(); }
    bustPages(out);
    st('wrote ' + out + '.html');
  }

  //  wired here, where the handler lives (the same rule 45-templates and
  //  75-move follow)
  if (texBtn()) texBtn().onclick = convertTex;
