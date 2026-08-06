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

  // Paint locally NOW, and let the ship's answer replace it when it arrives.
  //
  // The server render is the source of truth and stays that way. What changed
  // is that it is no longer the ONLY thing that ever fills this pane, because
  // it costs a pier round trip every time: measured against a real ship, 1.36s
  // for an eight byte document and 3.0s for 106 KB. The floor is the pier, not
  // the rendering, so the wait did not shrink with the document and a one line
  // note took as long as a long one.
  //
  // Markdown only. gmi, html and text keep the old behaviour, since html is
  // already its own output and the other two are not worth a second renderer.
  const localPreviewable = () => pkind.value === 'md';
  const paintLocal = () => {
    if (!localPreviewable() || document.hidden) return;
    if (isMobile() && ws.dataset.mv !== 'prev') return;
    try {
      prev.srcdoc = '<!doctype html><meta charset="utf-8">'
        + '<style>body{margin:0;padding:14px;font:15px/1.6 system-ui,sans-serif;'
        + 'color-scheme:light dark}img{max-width:100%}pre{overflow-x:auto}'
        + 'table{border-collapse:collapse}td,th{border:1px solid #8886;padding:.3em .5em}'
        + '</style>' + mdToHtml(src.value);
    } catch {}
  };

  let prevTimer = null;
  let prevSeq = 0;
  async function refreshPreview() {
    // a hidden pane renders to nobody, but the POST still costs ~2s of pier
    // time and delays the autosave queued behind it (worst on mobile, where
    // the code tab hides the preview entirely).
    if (document.hidden) return;
    if (isMobile() && ws.dataset.mv !== 'prev') return;
    if (CONTENT()) {
      // A render is of the text that was SENT, and it lands a pier round trip
      // later. Painting it unconditionally means a render issued before an
      // edit can arrive after it and put the older document back on screen.
      //
      // That was survivable when every paint came from here and they mostly
      // queued in order. Now the local paint is instant, so a late reply
      // visibly reverts what you just typed: the edit looks lost.
      //
      // Two guards, because they catch different things. prevSeq drops a reply
      // that a newer request has already superseded. Comparing the text drops
      // one whose document has moved on even if no newer request went out yet,
      // which is the common case while typing.
      const mine = ++prevSeq;
      const sent = src.value;
      try {
        const r = await fetch(api + '/page-preview?type=' + pkind.value,
          { method: 'POST', body: sent });
        if (mine !== prevSeq || src.value !== sent) return;
        if (r.ok) prev.srcdoc = await r.text();
      } catch {}
    } else if (current) {
      prev.removeAttribute('srcdoc');
      prev.src = api + '/f/' + current + '?t=' + Date.now();
    }
  }
  let localTimer = null;
  src.addEventListener('input', () => {
    if (!CONTENT()) return;
    // local first, on a delay short enough to feel like typing
    clearTimeout(localTimer);
    localTimer = setTimeout(paintLocal, 60);
    // The authoritative render is now RARE, not merely less frequent.
    //
    // Every one of these is a POST of the WHOLE document to the ship. At 400ms
    // a long note re-uploaded itself after every pause in typing, previews
    // queued behind each other on a pier that serialises, and the autosave
    // queued behind those. Moving it to 1200ms made that less bad while
    // keeping the shape of the mistake: the file went over the wire again and
    // again to render text that had barely changed.
    //
    // Ten seconds of quiet, and only then. While you are actually typing the
    // ship sees nothing at all, and the pane is driven entirely by the local
    // render. This is a preview correcting itself, not a live feed.
    clearTimeout(prevTimer);
    prevTimer = setTimeout(refreshPreview, 10000);
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
