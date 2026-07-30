  // ── upload (pickers + drag-and-drop, progress panel) ─────────────────────
  const KMAP = { md: 'md', gmi: 'gmi', html: 'html', htm: 'html', txt: 'text',
                 js: 'js', css: 'css', hoon: 'hoon' };
  const seg = (x) => x.toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const upPanel = $('uppanel'), upMsg = $('upmsg'), upFill = $('upfill'), upErr = $('uperr');

  const upShow = () => { upPanel.hidden = false; upErr.textContent = ''; upFill.style.width = '0%'; };
  const upProg = (done, total, name) => {
    upMsg.textContent = `uploading ${done}/${total}${name ? ': ' + name : ''}`;
    upFill.style.width = Math.round(done * 100 / Math.max(total, 1)) + '%';
  };

  async function uploadItems(items) {
    const list = [];
    const dirs = new Set();
    let skipped = 0;
    for (const { file, rel } of items) {
      const dot = rel.lastIndexOf('.');
      const kind = dot > 0 ? KMAP[rel.slice(dot + 1).toLowerCase()] : null;
      if (!kind) { skipped++; continue; }
      const stem = rel.slice(0, dot);
      const parts = stem.split('/').map(seg).filter(Boolean);
      if (folderCtx) parts.unshift(...folderCtx.split('/'));
      const name = parts.join('/');
      if (!name) { skipped++; continue; }
      list.push({ file, name, kind });
      const pp = name.split('/'); pp.pop();
      for (let i = 1; i <= pp.length; i++) dirs.add(pp.slice(0, i).join('/'));
    }
    if (!list.length) {
      upShow();
      upMsg.textContent = 'no supported files (md gmi html txt js css hoon)';
      return;
    }
    upShow();
    upProg(0, list.length, '');
    if (skipped) upErr.textContent = `skipped ${skipped} unsupported\n`;
    // only create folders the tree does not already have — each folder-new is
    // a ~2s writer round-trip, and re-uploading into an existing tree used to
    // pay it for every directory.
    for (const d of [...dirs].sort()) {
      if (hasNode(d)) continue;
      try { await mutate(api + '/folder-new?name=' + encodeURIComponent(d)); }
      catch {}
    }
    let fails = 0;
    for (let i = 0; i < list.length; i++) {
      upProg(i, list.length, list[i].name);
      let r = null;
      try {
        r = await mutate(api + '/page-save?name=' + encodeURIComponent(list[i].name) +
          '&type=' + list[i].kind, { method: 'POST', body: (await list[i].file.text()) || '\n' });
      } catch {}
      if (!r || !r.ok) {
        fails++;
        upErr.textContent += `failed: ${list[i].name}${r ? ' (' + r.status + ')' : ''}\n`;
      } else {
        addTreeNode(list[i].name, list[i].kind);
      }
    }
    upProg(list.length, list.length, '');
    upMsg.textContent = fails ? `done with ${fails} failures` : `uploaded ${list.length} files`;
    snapTree();
    renderTree();
    if (!fails) setTimeout(() => { upPanel.hidden = true; }, 2500);
  }

  const fromFileList = (fl) =>
    [...fl].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));

  $('upfiles').onclick = () => $('fpick').click();
  $('updir').onclick = () => $('dpick').click();
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
  window.addEventListener('dragover', (e) => { e.preventDefault(); treePane.classList.add('dragover'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) treePane.classList.remove('dragover'); });
  window.addEventListener('drop', (e) => {
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
