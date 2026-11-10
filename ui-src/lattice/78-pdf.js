  // ── Export PDF ───────────────────────────────────────────────────────────
  // The page as it reads, not its source: each kind goes through the same
  // renderer its preview uses, and ui-app/pdf.js (loaded on first use, never
  // at boot) lays that out for print and hands it to the runtime. A browser
  // gets its print dialog, where Save as PDF is one choice; the desktop app
  // writes the file through a save dialog of its own (desktop/src/pdf.rs).
  let pdfLoad = null;
  const pdfReady = () => (window.LatPdf ? Promise.resolve(window.LatPdf)
    : pdfLoad || (pdfLoad = new Promise((ok, no) => {
      const s = document.createElement('script');
      const fail = () => { pdfLoad = null; s.remove(); no(new Error('could not load the PDF export')); };
      s.src = '/apps/lattice/app/pdf.js?h=' + PDF_H;
      s.onload = () => (window.LatPdf ? ok(window.LatPdf) : fail());
      s.onerror = fail;
      document.head.append(s);
    })));
  const PDF_KINDS = ['md', 'gmi', 'html', 'text', 'tex', 'fodt', 'fods', 'scad', 'js', 'css', 'hoon'];
  // what pdf.js lays out: `html` is a fragment, or a whole document when
  // `doc` is set (an html page, a Writer document)
  async function pdfBody(kind, body) {
    if (kind === 'md') return { html: mdToHtml(body) };
    if (kind === 'gmi') return { html: gmiToHtml(body) };
    if (kind === 'text') return { html: '<pre class="text">' + mdEsc(body) + '</pre>' };
    if (kind === 'html') return { html: body, doc: true };
    if (isRich(kind)) {
      const W = await writerReady(kind);
      const h = W.render(body, true);
      if (!h) throw new Error('this document cannot be shown');
      return { html: h, doc: true, writer: true };
    }
    if (kind === 'tex') {
      // pandoc's MathML where the desktop has it, else the source: the ship
      // has no TeX, and the web has no converter
      const rust = texRust();
      if (rust) {
        try { return { html: cleanTexHtml(await rust.invoke('convert_tex', { src: body })) }; } catch {}
      }
      return { html: '<pre class="code">' + mdEsc(body) + '</pre>' };
    }
    const lang = LMAP[kind];
    const g = window.Prism && lang && Prism.languages[lang];
    let code = '';
    // the main thread, so a bounded text (ghostHl in 28-splits.js says why)
    if (g && body.length <= 200000) { try { code = Prism.highlight(body, g, lang); } catch {} }
    return { html: '<pre class="code language-' + lang + '">' + (code || mdEsc(body)) + '</pre>' };
  }
  async function exportPdf(name, kind, body) {
    if (!PDF_KINDS.includes(kind)) { st('no PDF for a ' + kind + ' page', false); return; }
    stWork('preparing PDF…');
    try {
      const r = await pdfBody(kind, body);
      const P = await pdfReady();
      const out = await P.save(Object.assign(r, { title: String(name).split('/').pop() || 'page' }));
      st(out.path ? 'saved ' + out.path : out.cancelled ? 'PDF not saved' : 'PDF ready to print');
    } catch (e) {
      st('PDF: ' + String(e && e.message ? e.message : e).slice(0, 160), false);
    }
  }
  // the open page, its unsaved text included
  function exportOpenPdf() {
    if (!current || grubPath || curFolder !== null) return;
    writerSync();
    exportPdf(current, mode === 'know' ? 'md' : (pkind.value || 'md'), src.value);
  }
  // a tree row's page: the editor's text when it is the open one
  async function exportPagePdf(name) {
    if (name === current && mode !== 'know' && !grubPath) { exportOpenPdf(); return; }
    stWork('preparing PDF…');
    let d = null;
    try {
      const r = await fetch(api + '/page-source?name=' + encodeURIComponent(name));
      d = r.ok ? await r.json() : null;
    } catch {}
    if (!d || typeof d.body !== 'string') { st('could not read ' + name, false); return; }
    exportPdf(name, d.kind || 'md', d.body);
  }
