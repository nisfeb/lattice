  // ── Rich pages: Writer documents (fodt) and spreadsheets (fods) ──────────
  // A rich kind's page text is LibreOffice's flat XML, and its editor is a
  // side asset loaded when such a page shows: writer.js for fodt, sheet.js
  // for fods. Either mounts over #src, the one buffer, and writes it back
  // (ui-src/writer/view.js and ui-src/sheet/view.js, ctl.sync). This table
  // is all the shell knows that differs between them.
  const RICH = {
    fodt: { lib: 'LatWriter', js: 'writer.js', h: WRITER_H, tag: 'lat-writer', ed: 'Writer editor', a: 'a Writer document' },
    fods: { lib: 'LatSheet', js: 'sheet.js', h: SHEET_H, tag: 'lat-sheet', ed: 'spreadsheet editor', a: 'a spreadsheet' },
  };
  const isRich = (k) => Object.prototype.hasOwnProperty.call(RICH, k);
  const richLib = (k) => (isRich(k) && window[RICH[k].lib]) || null;
  // the rich kind a text is, by what it says it is, or ''
  const richOf = (t) => (!/^(<\?xml[^>]*>\s*)?<office:document[\s/>]/.test(t) ? ''
    : /office:mimetype="application\/vnd\.oasis\.opendocument\.spreadsheet/.test(t.slice(0, 8192)) || /<office:spreadsheet[\s>]/.test(t) ? 'fods' : 'fodt');
  let wr = null, wrSeq = 0, wrQ = false;
  const wrLoad = {}, wrHosts = {};
  // the document the editor was mounted for: its tab, and wrDoc, which
  // applyPage and blankPage move on for each new document in front. Two
  // pages with the same body never share an editor or its undo history.
  // A rename or a new page's first save keeps it.
  let wrDoc = 0, wrFor = null;
  const writerNewDoc = () => { wrDoc++; };
  const wrSrc = new Map();     // page -> why it shows as XML
  const wrKey = () => current || '';
  // the rich kind in front, or ''
  const richHere = () => (mode !== 'know' && !grubPath && curFolder === null && isRich(pkind.value) ? pkind.value : '');
  const writerSourceOn = () => !!richHere() && wrSrc.has(wrKey());
  const writerReady = (k = 'fodt') => (richLib(k) ? Promise.resolve(richLib(k))
    : wrLoad[k] || (wrLoad[k] = new Promise((ok, no) => {
      const s = document.createElement('script');
      const fail = () => { wrLoad[k] = null; s.remove(); no(); };
      s.src = '/apps/lattice/app/' + RICH[k].js + '?h=' + RICH[k].h;
      s.onload = () => (richLib(k) ? ok(richLib(k)) : fail());
      s.onerror = fail;
      document.head.append(s);
    })));
  // headings and links (76-outline.js) once writer.js is here
  const wrX = (f, b, k = 'fodt') => (richLib(k) ? richLib(k).extract[f](b) : (writerReady(k).then(() => rpSoon(), () => {}), []));
  const wrNote = document.createElement('div');
  wrNote.className = 'lnkcf';
  wrNote.hidden = true;
  $('docarea').before(wrNote);
  // in the live .edwrap; `msg` and the ship's render until writer.js is here
  function wrBox(k, msg) {
    const wrHost = wrHosts[k] || (wrHosts[k] = document.createElement(RICH[k].tag));
    for (const o of Object.keys(wrHosts)) if (o !== k) wrHosts[o].hidden = true;
    wrHost.hidden = false;
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
    if (!on) for (const o of Object.keys(wrHosts)) wrHosts[o].hidden = true;
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
    const k = richHere();
    if (!k || writerSourceOn()) return writerOff();
    const body = src.value, ed = !src.readOnly && viewingRev === null;
    wrShow(true);
    const doc = { tab: activeTab, n: wrDoc, k };
    if (wr && wrFor && wrFor.tab === doc.tab && wrFor.n === doc.n && wrFor.k === k && wr.base() === body) { wrBox(k); return wr.setEditable(ed); }
    writerDrop();
    if (!richLib(k)) wrBox(k, 'Loading the ' + RICH[k].ed + '…');
    const my = wrSeq;
    writerReady(k).then((LW) => {
      if (my !== wrSeq || src.value !== body || richHere() !== k || writerSourceOn()) return;
      const c = LW.mount(wrBox(k), { text: body, editable: ed, name: current, cur: () => src.value, onChange: writerChanged,
        onText: (t) => { src.value = t; edited(); }, onRefuse: (e) => st('not saved: ' + e, false) });
      if (c.error) { wrSrc.set(wrKey(), c.error); writerApply(); } else { wr = c; wrFor = doc; }
    }, () => { if (my === wrSeq) wrBox(k, 'The ' + RICH[k].ed + ' did not load. Source in the page menu shows the XML.'); });
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
    for (const o of Object.keys(wrHosts)) wrHosts[o].replaceChildren();
    wrShow(false);
  }
  function writerSource(on) {
    writerSync();
    if (on) wrSrc.set(wrKey(), ''); else wrSrc.delete(wrKey());
    writerApply();
  }
  // a rich page keeps its kind, and nothing with text becomes one. A new
  // page's kind is its text's: a Writer document's XML, a spreadsheet's,
  // other text, or none yet
  function kindSwitchOk(to) {
    const t = src.value.trim();
    const from = current ? curKind : !t ? to : richOf(t) || 'text';
    if (from === to || (!isRich(from) && !isRich(to))) return true;
    st(isRich(from) ? RICH[from].a + ' cannot change kind' : 'a page with text cannot become ' + RICH[to].a, false);
    return false;
  }
  // the kind to put the picker back on when a switch was refused
  const kindBack = () => curKind || richOf(src.value.trim()) || 'md';
  // a new rich page: LibreOffice's blank document, from its editor's asset
  async function writerBlank(k = 'fodt') {
    try { src.value = (await writerReady(k)).blank; } catch { st('the ' + RICH[k].ed + ' did not load', false); return false; }
    wrSrc.delete(wrKey());
    render();
    return true;
  }
