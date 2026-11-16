  // ── Rich pages: Writer documents (fodt), spreadsheets (fods), maps ──────
  // A rich kind's editor is a side asset loaded when such a page shows:
  // writer.js for fodt, sheet.js for fods, map.js for geojson. The first
  // two hold LibreOffice's flat XML, a map holds a GeoJSON collection.
  // Each mounts over #src, the one buffer, and writes it back
  // (ui-src/writer/view.js, ui-src/sheet/view.js, ui-src/map/view.js). This
  // table is all the shell knows that differs between them.
  const RICH = {
    fodt: { lib: 'LatWriter', js: 'writer.js', h: WRITER_H, tag: 'lat-writer', ed: 'Writer editor', a: 'a Writer document' },
    fods: { lib: 'LatSheet', js: 'sheet.js', h: SHEET_H, tag: 'lat-sheet', ed: 'spreadsheet editor', a: 'a spreadsheet' },
    geojson: { lib: 'LatMap', js: 'map.js', h: MAP_H, tag: 'lat-map', ed: 'map view', a: 'a map' },
  };
  const isRich = (k) => Object.prototype.hasOwnProperty.call(RICH, k);
  const richLib = (k) => (isRich(k) && window[RICH[k].lib]) || null;
  // the rich kind a text is, by what it says it is, or ''
  const richOf = (t) => (/^\{/.test(t) && /"type"\s*:\s*"FeatureCollection"/.test(t.slice(0, 65536)) ? 'geojson'
    : !/^(<\?xml[^>]*>\s*)?<office:document[\s/>]/.test(t) ? ''
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
  // ── a map's edits go through the textarea ──────────────────────────────
  // map.js hands back the whole body after each edit. Only the span that
  // changed is replaced, with execCommand, so the textarea's own undo
  // stack holds the edit (as a task box's tick does, 60-preview.js) and a
  // moved point is one line of history. #src is hidden under the map, so
  // it is shown for the one call and blurred again. Undo and redo in the
  // map run the textarea's own, and ctl.update draws what they left.
  function srcExec(fn) {
    const had = document.activeElement, vis = src.style.visibility;
    src.style.visibility = '';
    let ok = false;
    try { src.focus({ preventScroll: true }); ok = document.activeElement === src && fn(); } catch {}
    src.style.visibility = vis;
    src.blur();
    if (had && had !== src && had.focus) try { had.focus({ preventScroll: true }); } catch {}
    return ok;
  }
  function mapWrite(t) {
    const old = src.value;
    if (t === old) return;
    const n = Math.min(old.length, t.length);
    let a = 0, b = 0;
    while (a < n && old.charCodeAt(a) === t.charCodeAt(a)) a++;
    while (b < n - a && old.charCodeAt(old.length - 1 - b) === t.charCodeAt(t.length - 1 - b)) b++;
    const ins = t.slice(a, t.length - b);
    const ok = srcExec(() => {
      src.setSelectionRange(a, old.length - b);
      return document.execCommand(ins ? 'insertText' : 'delete', false, ins);
    });
    if (!ok || src.value !== t) { src.value = t; edited(); }
  }
  const mapUndo = (redo) => srcExec(() => document.execCommand(redo ? 'redo' : 'undo'));
  // whether map tiles can be had, and the tile route's limits. The ship
  // says whether it holds a Mapbox token. In the desktop app this
  // computer may hold one of its own, and its bridge then answers the
  // tile route itself (desktop/src/tiles.rs), so either token will do.
  // Asked once, and again after a token is saved in Settings (below). An
  // ask that failed is not kept and writes nothing: the map gets the last
  // answer this browser had, so offline it shows the tiles its worker
  // kept. With none it is null, and the map draws its grid alone.
  let tileSt = null;
  const tileLast = () => { try { return JSON.parse(localStorage.latTiles || 'null'); } catch { return null; } };
  const tileDesk = () => {
    const d = window.__TAURI__ && window.__TAURI__.core;
    return d ? d.invoke('map_token_status').then((on) => !!on, () => false) : false;
  };
  const tileStatus = () => tileSt || (tileSt = Promise.all([
    fetch(api + '/tile-status').then((r) => (r.ok ? r.json() : Promise.reject(new Error('tile-status ' + r.status)))),
    tileDesk(),
  ]).then(([j, desk]) => {
    const t = { token: !!j.token || desk, max: +j.max || 17, styles: j.styles, url: '/apps/lattice/tile/{s}/{z}/{x}/{y}' };
    try { localStorage.latTiles = JSON.stringify(t); } catch {}
    return t;
  }).catch(() => { tileSt = null; return tileLast(); }));
  // Settings touches latTilesAt when a token is saved or removed, the
  // ship's or this computer's. It is a frame of this window or another
  // window, so the change arrives here as a storage event. The answer is
  // dropped, and a map is mounted again with the new one: now when it is
  // in front, else when its tab next is.
  addEventListener('storage', (e) => {
    if (e.key !== 'latTilesAt') return;
    tileSt = null;
    if (wrFor && wrFor.k === 'geojson') wrFor = null;
    if (!$('docarea').hidden) writerFollow();
  });
  // another map page, read-only, for a map's layers
  const mapLayer = async (name) => {
    const d = await bodyRead(String(name));
    return d && d.kind === 'geojson' ? d.body : null;
  };
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
    //  a map takes an outside change (an undo, a save from elsewhere) in
    //  place, so its view stays where it was
    if (wr && wrFor && wrFor.tab === doc.tab && wrFor.n === doc.n && wrFor.k === k && wr.update && wr.update(body) !== false) {
      wrBox(k);
      return wr.setEditable(ed);
    }
    writerDrop();
    if (!richLib(k)) wrBox(k, 'Loading the ' + RICH[k].ed + '…');
    const my = wrSeq;
    Promise.all([writerReady(k), k === 'geojson' ? tileStatus() : null]).then(([LW, tiles]) => {
      if (my !== wrSeq || src.value !== body || richHere() !== k || writerSourceOn()) return;
      const opts = { text: body, editable: ed, name: current, cur: () => src.value, onChange: writerChanged,
        onText: (t) => { src.value = t; edited(); }, onRefuse: (e) => st('not saved: ' + e, false) };
      if (k === 'geojson') Object.assign(opts, { onText: mapWrite, undo: () => mapUndo(false), redo: () => mapUndo(true),
        tiles, layer: mapLayer, md: (t) => mdToHtml(String(t)), openSettings: () => latOpenSettings('maps'),
        openPage: (n) => openPage(String(n)) });
      const c = LW.mount(wrBox(k), opts);
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
