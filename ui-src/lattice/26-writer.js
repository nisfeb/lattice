  // ── Writer pages (fodt) ──────────────────────────────────────────────────
  // writer.js, loaded when a fodt page shows, mounts over #src, which stays
  // the one buffer. Its text lands there through edited() 300 ms after a
  // change and at writerSync (save, autosave, park).
  let wrLoad = null, wr = null, wrHost = null, wrText = null;
  let wrDirty = false, wrTimer = 0, wrSeq = 0, wrQ = false;
  const wrSrc = new Map();     // page -> why it shows as XML
  const wrKey = () => current || '';
  const fodtHere = () => mode !== 'know' && !grubPath && curFolder === null && pkind.value === 'fodt';
  const writerSourceOn = () => fodtHere() && wrSrc.has(wrKey());
  const writerReady = () => (window.LatWriter ? Promise.resolve(window.LatWriter)
    : wrLoad || (wrLoad = new Promise((ok, no) => {
      const s = document.createElement('script');
      const fail = () => { wrLoad = null; s.remove(); no(); };
      s.src = '/apps/lattice/app/writer.js?h=' + WRITER_H;
      s.onload = () => (window.LatWriter ? ok(window.LatWriter) : fail());
      s.onerror = fail;
      document.head.append(s);
    })));
  const wrNote = document.createElement('div');
  wrNote.className = 'lnkcf';
  wrNote.hidden = true;
  $('docarea').before(wrNote);
  // in the live .edwrap; `msg` and the ship's render until writer.js is here
  function wrBox(msg) {
    if (!wrHost) {
      wrHost = document.createElement('lat-writer');
      wrHost.style.cssText = 'position:absolute;inset:0;z-index:3;background:var(--bg)';
    }
    if (wrHost.parentNode !== src.parentNode) src.parentNode.append(wrHost);
    if (msg) {
      const p = document.createElement('p'), f = document.createElement('iframe');
      const c = current && pageCache.get(current);
      p.textContent = msg;
      f.setAttribute('sandbox', '');
      f.style.cssText = 'border:0;width:100%;height:90%';
      f.srcdoc = (c && c.html) || '';
      wrHost.replaceChildren(p, f);
    }
    return wrHost;
  }
  function wrShow(on) {
    if (wrHost) wrHost.hidden = !on;
    src.style.visibility = hl.style.visibility = on ? 'hidden' : '';
  }
  // after render() (any new text or kind), once readOnly is set too
  function writerFollow() {
    if (!wrQ) { wrQ = true; queueMicrotask(writerApply); }
  }
  function writerApply() {
    wrQ = false;
    const why = writerSourceOn() && wrSrc.get(wrKey());
    wrNote.hidden = !why;
    wrNote.textContent = 'The Writer editor cannot open this document (' + why + '), so it shows as XML.';
    if (!fodtHere() || writerSourceOn()) return writerOff();
    const body = src.value, ed = !src.readOnly && viewingRev === null;
    wrShow(true);
    if (wr && wrText === body) return wr.setEditable(ed);
    writerDrop();
    wrText = body;
    if (!window.LatWriter) wrBox('Loading the Writer editor…');
    const my = wrSeq;
    writerReady().then((LW) => {
      if (my !== wrSeq || src.value !== body || !fodtHere() || writerSourceOn()) return;
      const c = LW.mount(wrBox(), { text: body, editable: ed, onChange: writerChanged });
      if (c.error) { wrSrc.set(wrKey(), c.error); writerApply(); } else wr = c;
    }, () => { if (my === wrSeq) wrBox('The Writer editor did not load. Source in the page menu shows the XML.'); });
  }
  function writerChanged() {
    wrDirty = dirty = everTyped = true;
    clearTimeout(autoTimer);
    clearTimeout(wrTimer);
    wrTimer = setTimeout(writerSync, 300);
  }
  // false: it refused (a broken marker pair), the last good text stays
  function writerSync() {
    clearTimeout(wrTimer);
    if (!wr || !wrDirty || src.value !== wrText) return true;
    wrDirty = false;
    const r = wr.text();
    if (r.error) return st('not saved: ' + r.error, false), false;
    if (r.text !== src.value) { src.value = wrText = r.text; edited(); }
    return true;
  }
  function writerDrop() {
    wrSeq++;
    wrDirty = false;
    if (wr) wr.destroy();
    wr = wrText = null;
  }
  function writerOff() {
    writerSync();
    writerDrop();
    if (wrHost) wrHost.replaceChildren();
    wrShow(false);
  }
  function writerSource(on) {
    writerSync();
    if (on) wrSrc.set(wrKey(), ''); else wrSrc.delete(wrKey());
    writerApply();
  }
  // fodt stays fodt, and nothing with text becomes one. A new page's kind
  // is its text's: XML of a Writer document, other text, or none yet
  function kindSwitchOk(to) {
    const t = src.value.trim();
    const from = current ? curKind : !t ? to : /^(<\?xml[^>]*>\s*)?<office:document[\s/>]/.test(t) ? 'fodt' : 'text';
    if ((from === 'fodt') === (to === 'fodt')) return true;
    st(from === 'fodt' ? 'a Writer document cannot change kind' : 'a page with text cannot become a Writer document', false);
    return false;
  }
  // a new fodt page: LibreOffice's blank document, from writer.js
  async function writerBlank() {
    try { src.value = (await writerReady()).blank; } catch { st('the Writer editor did not load', false); return false; }
    wrSrc.delete(wrKey());
    render();
    return true;
  }
