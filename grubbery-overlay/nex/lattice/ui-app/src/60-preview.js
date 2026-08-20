  // ── preview pane: <lat-preview> ──────────────────────────────────────────
  // Content kinds render locally (srcdoc). Computed kinds (hoon,
  // js, css) show the page's live DATA via /f/<name>, refreshed after save/cmd.
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
        '<iframe class="prev" id="prev" title="live preview" sandbox="allow-scripts"></iframe>';
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
    return body;   // html: the document is already its own rendering
  };
  const paintLocal = () => {
    if (!CONTENT() || document.hidden) return;
    if (isMobile() && ws.dataset.mv !== 'prev') return;
    try {
      // html pages own their whole document, chrome and all. The content kinds
      // get the same bare shell the markdown preview always used.
      if (pkind.value === 'html') { prev.srcdoc = src.value; return; }
      // color-scheme belongs on :root, not body — on body it does not reach the
      // canvas, so the frame painted opaque WHITE in dark theme. That was true
      // of every local paint since it landed and went unseen because only the
      // BLANK pane was ever checked for theme; wiring this into the open path
      // is what finally put it on screen. Backgrounds match prevBlank exactly,
      // so a document appearing cannot flash a different colour than the empty
      // pane it replaces.
      prev.srcdoc = '<!doctype html><meta charset="utf-8">'
        + '<style>:root{color-scheme:light dark}'
        + 'body{margin:0;padding:14px;font:15px/1.6 system-ui,sans-serif;background:#fafafa}'
        + '@media(prefers-color-scheme:dark){body{background:#1a1a1a}}'
        + 'img{max-width:100%}pre{overflow-x:auto}'
        + 'table{border-collapse:collapse}td,th{border:1px solid #8886;padding:.3em .5em}'
        + '</style>' + localHtml(pkind.value, src.value);
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
      prev.src = api + '/f/' + current + '?t=' + Date.now();
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
