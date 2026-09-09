  // ── preview pane: <lat-preview> ──────────────────────────────────────────
  // Content kinds render locally (srcdoc). Computed kinds (hoon,
  // js, css) show the page's live DATA via /f/<name>, refreshed after save/cmd.
  // fit state for the document currently in the frame (see the message
  // handler below). fitCur is the seq previewFit stamped into that document;
  // null forces the next report to start a new document.
  let fitCur = null, fitH = 0, fitOff = false;
  customElements.define('lat-preview', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML =
        // SANDBOXED, and this is load-bearing rather than defensive.
        //
        // The pane renders page content, and an html page is served into it as
        // its own document — including its scripts. Pages are not all
        // hand-written: the clipper archives arbitrary web pages verbatim. On
        // a same-origin frame, opening one of those in the editor ran its
        // JavaScript with this session, which is read every page, rewrite the
        // ACLs, exfiltrate the store. Verified before this line existed: a
        // page containing <script>parent.__PWNED=1</script> set that global on
        // the app and rewrote its title.
        //
        // allow-scripts WITHOUT allow-same-origin is the pair that matters.
        // Scripts still run, so the footnote-anchor handler the ship injects
        // into every server render keeps working, but the frame gets an opaque
        // origin: no parent, no cookies, no session. The two together would
        // hand the sandbox straight back.
        //
        // allow-top-navigation-by-user-activation is a narrower third token,
        // added for a different reason: a wikilink is a plain <a> pointing at
        // the app's own route, and clicking one used to navigate the frame
        // itself, straight into the opaque origin's missing cookies, a live
        // 403 in place of the page. This token opens exactly one door out of
        // the sandbox, and only on an actual click. Nothing running inside
        // the frame can drive the top page anywhere on its own; the click has
        // to be real. The base target below is what points those clicks
        // upward instead of at the frame.
        // The frame sits in a scrolling DIV and is sized to its own content
        // (see previewFit), so the frame's document never scrolls and never
        // shows the engine's native scrollbar. That bar is the one WebKitGTK
        // paints light no matter what: measured on 2.50, a sub-frame's bar
        // ignores color-scheme, ::-webkit-scrollbar, scrollbar-color, the
        // GTK dark variant and gtk-application-prefer-dark-theme alike.
        // The div scrolls with the app's own styled bars instead.
        '<div class="prevwrap"><iframe class="prev" id="prev" title="live preview" '
          + 'sandbox="allow-scripts allow-top-navigation-by-user-activation"></iframe></div>';
      prev = $('prev');
      // the frame reports its content height once its document has loaded;
      // the wrap scrolls. The FIRST report per document wins, measured with
      // the frame at pane height (previewFit clears min-height before every
      // write). If the content then grows in response to the frame growing,
      // the document is viewport-relative (a 100vh slide deck) and fitting
      // can never settle: drop the fit and let it scroll inside the frame,
      // whose own bars are hidden. A late image load trips the same rule and
      // degrades the same way, which beats a frame that grows without bound.
      window.addEventListener('message', (e) => {
        if (e.source !== prev.contentWindow) return;
        const m = e.data;
        if (!m || typeof m.latPrev !== 'number' || !(m.latPrev > 0)) return;
        if (m.seq !== fitCur) { fitCur = m.seq; fitH = 0; fitOff = false; }
        if (fitOff) return;
        if (!fitH) { fitH = m.latPrev; prev.style.minHeight = fitH + 'px'; return; }
        if (m.latPrev > fitH + 2) { fitOff = true; prev.style.minHeight = ''; }
      });
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
  //  tex is here for the same reason html is: the ship cannot render it, so
  //  the local paint IS the preview and there is no server answer to wait
  //  for. It differs in one way, that its renderer is a subprocess and
  //  therefore async, which is what texPreviewHtml in 71-latex.js handles.
  const CONTENT = () => ['md', 'gmi', 'html', 'text', 'tex'].includes(pkind.value);

  // Paint locally NOW, and let the ship's answer replace it when it arrives.
  //
  // The server render is the source of truth and stays that way. What changed
  // is that it is no longer the ONLY thing that ever fills this pane, because
  // it costs a pier round trip every time: measured against a real ship, 1.36s
  // for an eight byte document and 3.0s for 106 KB. The floor is the pier, not
  // the rendering, so the wait did not shrink with the document and a one line
  // note took as long as a long one.
  //
  // All four content kinds paint locally now. md and gmi run the hand-written
  // renderers (59-md.js) that the ship's answer then corrects. html is its own
  // output, so it srcdocs directly — the one case where local IS authoritative.
  // text is an escaped <pre>. Only the computed kinds (hoon, js, css) still
  // wait on the ship, because their preview is the page's live DATA, not text.
  const localHtml = (kind, body) => {
    if (kind === 'md') return mdToHtml(body);
    if (kind === 'gmi') return gmiToHtml(body);
    if (kind === 'text') return '<pre>' + mdEsc(body) + '</pre>';
    //  pandoc is a subprocess, so it cannot answer inside this synchronous
    //  call. It returns whatever the last conversion produced and schedules
    //  another, which repaints when it lands. Same contract as a cache.
    if (kind === 'tex') return texPreviewHtml(body);
    return body;   // html: the document is already its own rendering
  };
  // color-scheme first: WebKit picks its NATIVE scrollbar colours from the
  // document's colour scheme, and older WebKitGTK builds honour nothing else
  // below. A document that declares none is light, whatever the app is, so
  // its bars stayed white in a dark editor even with these rules present.
  // The rules that follow style them where the engine supports that.
  // WebKitGTK paints a sub-frame's OWN scrollbar light whatever the theme or
  // the document's colour scheme say, so the frame's bar is hidden outright
  // and the pane scrolls instead. Two things measured in a bare WebKit view:
  // html::-webkit-scrollbar{display:none} does hide it, and ANY standard
  // scrollbar-width / scrollbar-color on the document switches every
  // ::-webkit-scrollbar rule off, so neither may appear in a preview
  // document. Scoped to html so an inner scroll box (a wide <pre>) keeps its
  // own styled bar.
  const PREVIEW_SCROLLBARS = '<style>:root{color-scheme:light dark}html::-webkit-scrollbar{display:none}</style>';
  // the height reporter the wrap listens for: posts once the document has
  // loaded, and again when its body resizes. Each call stamps a fresh seq so
  // the parent can tell a new document from a resize of the old one. Mirrored
  // (without the seq) in app.hoon (+preview-scrollbar-css) for the /f/
  // computed-kind preview. Clearing min-height here is deliberate: every
  // srcdoc write goes through this, and the first measurement must be taken
  // with the frame at pane height, not at the previous document's.
  let fitSeq = 0;
  const previewFit = () => {
    if (prev) prev.style.minHeight = '';
    return PREVIEW_SCROLLBARS
      + '<script>(function(){var S=' + (++fitSeq) + ';function s(){var d=document.documentElement,b=document.body;parent.postMessage({latPrev:Math.max(d.scrollHeight,b?b.scrollHeight:0),seq:S},"*")}addEventListener("load",function(){s();if(document.body)new ResizeObserver(s).observe(document.body)})})()</script>';
  };
  const withPreviewScrollbars = (html) => {
    const head = /<head\b[^>]*>/i.exec(html);
    const fit = previewFit();
    if (head) return html.slice(0, head.index + head[0].length) + fit + html.slice(head.index + head[0].length);
    const root = /<html\b[^>]*>/i.exec(html);
    if (root) return html.slice(0, root.index + root[0].length) + fit + html.slice(root.index + root[0].length);
    return fit + html;
  };
  const paintLocal = () => {
    if (!CONTENT() || document.hidden) return;
    if (isMobile() && ws.dataset.mv !== 'prev') return;
    try {
      // html pages own their whole document, chrome and all. The content kinds
      // get the same bare shell the markdown preview always used.
      // ...but a document that styles no scrollbars gets the engine's NATIVE
      // ones, which on WebKitGTK follow the window theme and drew white in a
      // dark editor. Slip the same flat scrollbar rules the rest of the
      // editor uses into the preview copy only: after <head> when there is
      // one, else after <html>, else in front. The rules touch nothing but
      // scrollbars (an alpha grey that reads on both schemes), so the
      // document's own colour scheme is left exactly as written.
      if (pkind.value === 'html') { prev.srcdoc = withPreviewScrollbars(src.value); return; }
      // color-scheme belongs on :root, not body — on body it does not reach the
      // canvas, so the frame painted opaque WHITE in dark theme. That was true
      // of every local paint since it landed and went unseen because only the
      // BLANK pane was ever checked for theme; wiring this into the open path
      // is what finally put it on screen. Backgrounds match prevBlank exactly,
      // so a document appearing cannot flash a different colour than the empty
      // pane it replaces.
      // <base target="_top"> sends every plain link in this shell to the real
      // top-level page instead of the sandboxed frame it is written into. A
      // wikilink used to navigate the frame itself and land on an
      // authenticated route the opaque origin has no cookies for; escaping
      // to the top page is what the sandbox token above actually permits.
      prev.srcdoc = '<!doctype html><meta charset="utf-8"><base target="_top">'
        + '<style>:root{color-scheme:light dark}'
        + 'body{margin:0;padding:14px;font:15px/1.6 system-ui,sans-serif;background:#fafafa}'
        + '@media(prefers-color-scheme:dark){body{background:#1a1a1a}}'
        // NO scrollbar-width / scrollbar-color here: either one switches the
        // ::-webkit-scrollbar rules off, including the html-level hide that
        // previewFit appends. Inner scroll boxes (a wide <pre>) keep flat bars.
        + 'pre::-webkit-scrollbar{width:10px;height:10px}'
        + 'pre::-webkit-scrollbar-thumb{background:#8886;border-radius:5px;border:2px solid transparent;background-clip:padding-box}'
        + 'img{max-width:100%}pre{overflow-x:auto}'
        + 'table{border-collapse:collapse}td,th{border:1px solid #8886;padding:.3em .5em}'
        + '</style>' + previewFit() + localHtml(pkind.value, src.value);
    } catch {}
  };

  async function refreshPreview() {
    // a hidden pane renders to nobody, but the POST still costs ~2s of pier
    // time and delays the autosave queued behind it (worst on mobile, where
    // the code tab hides the preview entirely).
    if (document.hidden) return;
    if (isMobile() && ws.dataset.mv !== 'prev') return;
    if (CONTENT()) {
      // Paint locally FIRST, on every path into this function, not just while
      // typing. The local render used to hang off the input event alone, so
      // typing was instant and everything else — opening a page, switching to
      // the preview pane, restoring a revision, a sync — still sat on the pier
      // for its first frame. That is the slow case people actually report,
      // because you open a document far more often than you type the first
      // character into one. src.value is already the new body at every call
      // site (applyPage sets it well before it calls here), so this paints the
      // document that is about to be rendered, not the one leaving the screen.
      // ...and the local paint IS the preview. The pier's "correcting"
      // render is gone: every content kind here (CONTENT ≡ md/gmi/html/text)
      // has a client renderer, and posting the whole document so the ship's
      // renderer could overrule ours cost ~2s of serial pier time per save
      // to fix divergence that would be a renderer BUG, not a runtime
      // condition — the boot snapshot has always trusted the local render.
      // Computed kinds (hoon, js, css) take the /f/ branch below: their
      // preview is the page's live data, which no client renderer can know.
      paintLocal();
    } else if (current) {
      prev.removeAttribute('srcdoc');
      fitCur = null; prev.style.minHeight = '';
      // preview=1: the ship adds the editor's scrollbar rules to an html
      // answer, so a computed page's live document scrolls like the rest of
      // the editor instead of with the engine's native, theme-following bars
      prev.src = api + '/f/' + current + '?preview=1&t=' + Date.now();
    }
  }
  let localTimer = null;
  src.addEventListener('input', () => {
    if (!CONTENT()) return;
    // Typing sends nothing to the ship. The local render IS the preview for
    // every content kind (md/gmi/html/text), with no second authoritative
    // render behind it to wait for. refreshPreview says why. Computed kinds
    // (hoon, js, css) return above; their preview is the page's live data and
    // arrives from refreshPreview's /f/ branch after a save.
    //
    // local first, on a delay short enough to feel like typing
    clearTimeout(localTimer);
    localTimer = setTimeout(paintLocal, 60);
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
