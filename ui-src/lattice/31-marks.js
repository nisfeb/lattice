  // ── bookmarks: <lat-marks> ───────────────────────────────────────────────
  // The left pane's Bookmarks tab: the urb:// and web bookmarks the reader
  // keeps (GET /bookmarks-json, newest first), grouped by folder, with a
  // filter, and per bookmark a refile and a remove. A click opens the
  // bookmark in the reader, in this window for now (the reader becomes a
  // tab later), so it leaves the editor through guardDirty like any other
  // navigation. Ctrl/Cmd or a middle click is the browser's own new tab and
  // leaves nothing.
  customElements.define('lat-marks', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<aside class="tree" id="markpane">
  <input id="mfilter" type="search" placeholder="filter bookmarks" aria-label="Filter bookmarks" autocomplete="off" spellcheck="false">
  <div id="marklist"><div class="muted kwait">loading bookmarks…</div></div>
</aside>`;
    }
  });
  let marks = null;                      // [{url, title, folder}], null until loaded
  let marksSeq = 0;
  const marksColl = collStore('marksColl');
  const markList = $('marklist');
  const readerUrl = (url) => '/apps/lattice/?q=' + encodeURIComponent(url);

  async function loadMarks() {
    const my = ++marksSeq;
    let d = null;
    try {
      const r = await fetch(api + '/bookmarks-json');
      if (r.ok) d = await r.json();
    } catch {}
    if (my !== marksSeq) return;
    if (!Array.isArray(d)) {
      if (!marks) markList.replaceChildren(marksNote('bookmarks did not load'));
      return;
    }
    marks = d;
    renderMarks();
  }
  const marksNote = (t) => {
    const e = document.createElement('div');
    e.className = 'muted';
    e.style.padding = '4px 8px';
    e.textContent = t;
    return e;
  };

  // leaving the editor for the reader: the same question every other way
  // out asks. guardDirty flushes the front document or asks about it, and a
  // parked tab's unsaved buffer still gets beforeunload (35-pages.js).
  async function markGo(e, url) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (!(await guardDirty())) return;
    dirty = false;                       // flushed, or the user said discard
    clearTimeout(autoTimer);
    location.href = readerUrl(url);
  }
  async function markMove(b) {
    const f = await ask('move ' + (b.title || b.url) + ' to folder (empty for none):',
      b.folder, 'move');
    if (f === null) return;
    const r = await mutate(api + '/bookmark-move?url=' + encodeURIComponent(b.url)
      + '&folder=' + encodeURIComponent(f.trim()));
    if (!r.ok) { st('move failed' + await errText(r), false); return; }
    st(f.trim() ? 'moved to ' + f.trim() : 'moved out of its folder');
    loadMarks();
  }
  async function markDrop(b) {
    if (!(await askConfirm('remove bookmark ' + (b.title || b.url) + '?', 'remove'))) return;
    const r = await mutate(api + '/unbookmark?url=' + encodeURIComponent(b.url));
    if (!r.ok) { st('remove failed' + await errText(r), false); return; }
    st('bookmark removed');
    loadMarks();
  }

  function markRow(b, depth) {
    const row = document.createElement('div');
    row.className = 'mrow';
    row.style.marginLeft = (depth * 14) + 'px';
    const a = document.createElement('a');
    a.className = 'pg';
    a.href = readerUrl(b.url);
    a.title = b.url;
    a.textContent = b.title || b.url;    // titles are content: textContent
    a.onclick = (e) => markGo(e, b.url);
    const mv = tip(document.createElement('button'), 'Move to folder');
    const rm = tip(document.createElement('button'), 'Remove bookmark');
    for (const [x, icon, run] of [[mv, 'folder', markMove], [rm, 'x', markDrop]]) {
      x.type = 'button';
      x.className = 'sbtn';
      x.innerHTML = ico(icon);
      x.onclick = () => run(b);
    }
    row.append(a, mv, rm);
    return row;
  }

  // folders first by name, then the unfiled ones, each newest first as the
  // ship keeps them. A filter shows every match, folded folder or not.
  function renderMarks() {
    if (!marks) return;
    const q = $('mfilter').value.trim().toLowerCase();
    const hit = (b) => !q || [b.title, b.url, b.folder]
      .some((x) => String(x || '').toLowerCase().includes(q));
    const shown = marks.filter(hit);
    markList.textContent = '';
    if (!shown.length) {
      markList.append(marksNote(q ? 'no bookmark matches that'
        : 'no bookmarks yet. The reader’s star keeps one.'));
      return;
    }
    const byFolder = new Map();
    for (const b of shown) {
      const f = b.folder || '';
      if (!byFolder.has(f)) byFolder.set(f, []);
      byFolder.get(f).push(b);
    }
    const coll = marksColl.get();
    for (const f of [...byFolder.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b))) {
      const folded = !q && coll.includes(f);
      markList.append(folderRow(f, 0, folded, () => { marksColl.flip(f); renderMarks(); }));
      if (!folded) for (const b of byFolder.get(f)) markList.append(markRow(b, 1));
    }
    for (const b of byFolder.get('') || []) markList.append(markRow(b, 0));
  }
  $('mfilter').oninput = renderMarks;
  // fetched each time the tab is shown: the reader adds and removes
  // bookmarks in other windows, and this is one small request
  document.addEventListener('lat-pane', (e) => {
    if (e.detail.side === 'l' && e.detail.id === 'marks') loadMarks();
  });
  if (paneShows('l', 'marks')) loadMarks();
