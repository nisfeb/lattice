  // ── Writer pages (fodt) ──────────────────────────────────────────────────
  // writer.js, loaded when a fodt page shows, mounts over #src, the one
  // buffer, and writes it back (view.js, ctl.sync).
  let wrLoad = null, wr = null, wrHost = null, wrSeq = 0, wrQ = false;
  // the document the editor was mounted for: its tab, and wrDoc, which
  // applyPage and blankPage move on for each new document in front. Two
  // pages with the same body never share an editor or its undo history.
  // A rename or a new page's first save keeps it.
  let wrDoc = 0, wrFor = null;
  const writerNewDoc = () => { wrDoc++; };
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
  // headings and links (76-outline.js) once writer.js is here
  const wrX = (f, b) => window.LatWriter ? LatWriter.extract[f](b) : (writerReady().then(() => rpSoon(), () => {}), []);
  const wrNote = document.createElement('div');
  wrNote.className = 'lnkcf';
  wrNote.hidden = true;
  $('docarea').before(wrNote);
  // in the live .edwrap; `msg` and the ship's render until writer.js is here
  function wrBox(msg) {
    if (!wrHost) wrHost = document.createElement('lat-writer');
    if (wrHost.parentNode !== src.parentNode) src.parentNode.append(wrHost);
    if (msg) {
      wrHost.replaceChildren($('wrload').content.cloneNode(true));
      const c = current && pageCache.get(current);
      wrHost.firstChild.textContent = msg;
      wrHost.lastChild.srcdoc = (c && c.html) || '';
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
    wrNote.textContent = why;
    if (!fodtHere() || writerSourceOn()) return writerOff();
    const body = src.value, ed = !src.readOnly && viewingRev === null;
    wrShow(true);
    const doc = { tab: activeTab, n: wrDoc };
    if (wr && wrFor && wrFor.tab === doc.tab && wrFor.n === doc.n && wr.base() === body) return wr.setEditable(ed);
    writerDrop();
    if (!window.LatWriter) wrBox('Loading the Writer editor…');
    const my = wrSeq;
    writerReady().then((LW) => {
      if (my !== wrSeq || src.value !== body || !fodtHere() || writerSourceOn()) return;
      const c = LW.mount(wrBox(), { text: body, editable: ed, name: current, cur: () => src.value, onChange: writerChanged,
        onText: (t) => { src.value = t; edited(); }, onRefuse: (e) => st('not saved: ' + e, false) });
      if (c.error) { wrSrc.set(wrKey(), c.error); writerApply(); } else { wr = c; wrFor = doc; }
    }, () => { if (my === wrSeq) wrBox('The Writer editor did not load. Source in the page menu shows the XML.'); });
  }
  function writerChanged() {
    dirty = everTyped = true;
    clearTimeout(autoTimer);
  }
  // false: it refused (a broken marker pair), the last good text stays
  function writerSync() { return !wr || wr.sync(); }
  function writerDrop() {
    wrSeq++;
    if (wr) wr.destroy();
    wr = null;
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
