  // ── upload (pickers + drag-and-drop, progress panel) ─────────────────────
  //  which extensions arrive as which kind is EXT_KIND, in 30-tree.js
  const seg = (x) => x.toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const upPanel = $('uppanel'), upMsg = $('upmsg'), upFill = $('upfill'), upErr = $('uperr');

  const upShow = () => { upPanel.hidden = false; upErr.textContent = ''; upFill.style.width = '0%'; };
  const upProg = (done, total, name, verb) => {
    upMsg.textContent = `${verb || 'uploading'} ${done}/${total}${name ? ': ' + name : ''}`;
    upFill.style.width = Math.round(done * 100 / Math.max(total, 1)) + '%';
  };

  // opts.verbatim: the paths are ones this app itself wrote (a vault restore),
  // so take them as they are. seg() lowercases and rewrites characters, which
  // is right for a file dragged in off a disk and wrong for a page being put
  // back where it came from. folderCtx is ignored for the same reason: a
  // restore goes to the original path, not under whatever folder is selected.
  async function uploadItems(items, opts) {
    const verbatim = !!(opts && opts.verbatim);
    if (degraded || offCount) {
      upShow();
      upMsg.textContent = 'offline — uploads need the ship (queued edits will sync first)';
      return;
    }
    const list = [];
    const dirs = new Set();
    //  names, not just a count: a batch of thirty dropped files that skips
    //  three leaves the user guessing which three without this
    const skippedNames = [];
    for (const { file, rel } of items) {
      const dot = rel.lastIndexOf('.');
      const kind = dot > 0 ? extKind(rel.slice(dot + 1)) : null;
      if (!kind) { skippedNames.push(rel); continue; }
      const stem = rel.slice(0, dot);
      const parts = verbatim
        ? stem.split('/').filter(Boolean)
        : stem.split('/').map(seg).filter(Boolean);
      if (folderCtx && !verbatim) parts.unshift(...folderCtx.split('/'));
      const name = parts.join('/');
      if (!name) { skippedNames.push(rel); continue; }
      list.push({ file, name, kind });
      const pp = name.split('/'); pp.pop();
      for (let i = 1; i <= pp.length; i++) dirs.add(pp.slice(0, i).join('/'));
    }
    if (!list.length) {
      upShow();
      // EXT_KIND (30-tree.js) is the one table the picker filter and this
      // message both have to agree with, so read it instead of hand-listing
      // extensions that drift the moment a new kind is added.
      upMsg.textContent = 'no supported files (' + Object.keys(EXT_KIND).join(' ') + ')';
      return;
    }
    upShow();
    upProg(0, list.length, '');
    if (skippedNames.length) {
      const shown = skippedNames.length > 6
        ? skippedNames.slice(0, 6).join(', ') + ', and ' + (skippedNames.length - 6) + ' more'
        : skippedNames.join(', ');
      upErr.textContent = `skipped ${skippedNames.length} unsupported\n  ${shown}\n`;
    }
    // only create folders the tree does not already have. Each folder-new is
    // a ~2s writer round-trip, and re-uploading into an existing tree used to
    // pay it for every directory.
    for (const d of [...dirs].sort()) {
      if (hasNode(d)) continue;
      try { await mutate(api + '/folder-new?name=' + encodeURIComponent(d)); }
      catch {}
    }
    // ONE request per chunk, not one per file: every request pays the pier's
    // ~0.5s floor serially, so a 20-file drop used to be ~20 round-trips of
    // pure overhead doing work the server can batch. Chunked because the
    // route bounds a single transaction (200) and a whole folder should not
    // become one unbounded write.
    const CHUNK = 50;
    let fails = 0, done = 0;
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      let r = null;
      const payload = [];
      try {
        for (const it of part) {
          payload.push({ name: it.name, type: it.kind, body: (await it.file.text()) || '\n' });
          // the read is awaited one file at a time, so the bar can move with
          // it instead of sitting at 0% for the whole chunk and then jumping
          upProg(done + payload.length, list.length, it.name, 'reading');
        }
        r = await mutate(api + '/page-save-batch',
          { method: 'POST', body: JSON.stringify(payload) });
      } catch {}
      if (!r || !r.ok) {
        // the batch is all-or-nothing, so report the whole chunk rather than
        // implying some of it landed, and name what it held: a count alone
        // leaves the user diffing the tree by hand to find which files never
        // made it
        fails += part.length;
        let msg = r ? r.status : 'network';
        if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
        const names = part.map((it) => it.name);
        const held = names.length > 6
          ? names.slice(0, 6).join(', ') + ', and ' + (names.length - 6) + ' more'
          : names.join(', ');
        upErr.textContent += `failed: ${part.length} file(s) — ${msg}\n  ${held}\n`;
      } else {
        // an upload can OVERWRITE an existing page, and the batch's targets
        // live in the POST body where mutate() can't see them — so every
        // session tier must be told by hand, or openPage's pageCache hit
        // serves the pre-upload body with zero requests and the next
        // autosave buries the uploaded content under it.
        for (const it of payload) {
          pageCache.delete(it.name);
          const nd = nodes.find((n) => n.page && n.path === it.name);
          if (nd) { nd.body = it.body; nd.kind = it.type; }
          else addTreeNode(it.name, it.type);
        }
        // and the SW pages cache, blind to POST bodies the same way
        bustAll();
      }
      done += part.length;
    }
    upProg(list.length, list.length, '');
    upMsg.textContent = fails ? `done with ${fails} failures` : `uploaded ${list.length} files`;
    snapTree();
    renderTree();
    if (!fails) setTimeout(() => { upPanel.hidden = true; }, 2500);
  }

  const fromFileList = (fl) =>
    [...fl].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));

  // desktop shell: webkit2gtk has no webkitdirectory (folder picks are dead
  // on Linux), so the tauri pick_upload command opens the native dialog and
  // hands back {rel, text} for user-picked files. Browsers keep the inputs.
  const deskPick = window.__TAURI__ && (async (dir) => {
    try {
      const picked = await window.__TAURI__.core.invoke('pick_upload',
        { dir, exts: Object.keys(EXT_KIND) });
      if (picked.length)
        uploadItems(picked.map((p) => ({ file: { text: async () => p.text }, rel: p.rel })));
    } catch (e) {
      upShow(); upMsg.textContent = ''; upErr.textContent = 'native picker failed: ' + e;
    }
  });
  $('upfiles').onclick = deskPick ? () => deskPick(false) : () => $('fpick').click();
  $('updir').onclick = deskPick ? () => deskPick(true) : () => $('dpick').click();
  $('fpick').onchange = () => { if ($('fpick').files.length) uploadItems(fromFileList($('fpick').files)); };
  $('dpick').onchange = () => { if ($('dpick').files.length) uploadItems(fromFileList($('dpick').files)); };

  // drag-and-drop (files or whole directories via entry walking)
  const walkEntry = (entry, path, out) => new Promise((res) => {
    if (entry.isFile) entry.file((f) => { out.push({ file: f, rel: path + f.name }); res(); }, res);
    else if (entry.isDirectory) {
      const rd = entry.createReader();
      const subs = [];
      const step = () => rd.readEntries((es) => {
        if (!es.length) { Promise.all(subs).then(res); return; }
        for (const e of es) subs.push(walkEntry(e, path + entry.name + '/', out));
        step();
      }, res);
      step();
    } else res();
  });
  const treePane = $('tree');
  // A drag carries files, or it carries something else entirely, most often
  // a text selection dragged around inside the editor. window used to
  // preventDefault on every drag without asking which, which also cancels
  // the browser's native text drop and paints the tree as a target for a
  // drop it was never going to accept. types is populated the moment the
  // drag starts, well before any drop, so the two handlers below check the
  // same thing at two different points in the same gesture.
  const dragHasFiles = (e) => !!(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
  window.addEventListener('dragover', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    treePane.classList.add('dragover');
  });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) treePane.classList.remove('dragover'); });
  window.addEventListener('drop', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    treePane.classList.remove('dragover');
    const its = e.dataTransfer && e.dataTransfer.items;
    if (!its || !its.length) return;
    const out = [];
    const ps = [];
    for (const it of its) {
      const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (en) ps.push(walkEntry(en, '', out));
    }
    Promise.all(ps).then(() => { if (out.length) uploadItems(out); });
  });
