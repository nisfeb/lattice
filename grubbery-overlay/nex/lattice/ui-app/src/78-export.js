  // ── vault export ─────────────────────────────────────────────────────────
  // One action, the whole store, as a plain tar you can unpack anywhere. No
  // new route and no new dependency: page-dump already carries every body and
  // know-all is already the format the bulk importer reads back, so all this
  // does is arrange them into files and hand the browser a Blob.
  //
  // Tar rather than zip because tar needs no compression, no CRC table and no
  // central directory. It is a header and the bytes, which is about forty
  // lines, where a zip writer is a dependency or a much longer afternoon.
  const te = new TextEncoder();
  const oct = (n, w) => n.toString(8).padStart(w - 1, '0') + '\0';
  const pad512 = (n) => new Uint8Array((512 - (n % 512)) % 512);

  // ustar stores a path as prefix(155) + '/' + name(100). Anything that fits
  // that way is portable everywhere. Anything that does not gets a GNU
  // @LongLink record, which bsdtar and GNU tar both read. Truncating instead
  // would be silent corruption, and this is the one feature where the whole
  // point is that nothing goes missing.
  const splitName = (p) => {
    if (p.length <= 100) return ['', p];
    for (let i = Math.max(0, p.length - 101); i < p.length; i++)
      if (p[i] === '/' && p.length - i - 1 <= 100 && i <= 155)
        return [p.slice(0, i), p.slice(i + 1)];
    return null;
  };

  function tarHeader(name, size, mtime, type) {
    const h = new Uint8Array(512);
    const put = (s, at, len) => h.set(te.encode(s).subarray(0, len), at);
    const sp = splitName(name);
    put(sp ? sp[1] : name.slice(0, 100), 0, 100);
    put('0000644\0', 100, 8);          // mode
    put('0000000\0', 108, 8);          // uid
    put('0000000\0', 116, 8);          // gid
    put(oct(size, 12), 124, 12);
    put(oct(mtime, 12), 136, 12);
    h.fill(32, 148, 156);              // checksum field reads as spaces while summed
    put(type || '0', 156, 1);
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    if (sp && sp[0]) put(sp[0], 345, 155);
    let sum = 0;
    for (const b of h) sum += b;
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    return h;
  }

  function tarBlob(files) {
    const parts = [];
    for (const f of files) {
      const data = te.encode(f.body);
      if (!splitName(f.name)) {
        const nb = te.encode(f.name + '\0');
        parts.push(tarHeader('././@LongLink', nb.length, f.mtime, 'L'), nb, pad512(nb.length));
      }
      // size is the BYTE length. A body with any non-ascii character in it
      // would otherwise declare short and the archive would desynchronise
      // from that entry onward.
      parts.push(tarHeader(f.name, data.length, f.mtime, '0'), data, pad512(data.length));
    }
    parts.push(new Uint8Array(1024));   // two zero blocks end the archive
    return new Blob(parts, { type: 'application/x-tar' });
  }

  // The desktop shell reaches the disk through Rust, not the DOM. Bytes cross
  // the IPC base64-encoded: the webview's structured clone of a multi-megabyte
  // array of numbers is slow enough to read as a hang, and this is the path
  // whose entire job is that the bytes arrive exactly as they left.
  const desk = () => (window.__TAURI__ && window.__TAURI__.core) || null;
  const blobToB64 = (b) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = () => rej(new Error('could not read the archive'));
    fr.readAsDataURL(b);
  });
  const b64ToBytes = (s) => {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };

  // ── reading one back ─────────────────────────────────────────────────────
  // The inverse of the writer, and deliberately not only of THIS writer: it
  // reads ordinary ustar, so an archive you made with `tar cf` restores too.
  // The checksum is verified rather than trusted. A restore is the one path
  // where reading garbage confidently is worse than refusing.
  const td = new TextDecoder();
  function untar(buf) {
    const u = new Uint8Array(buf);
    const out = [];
    let off = 0;
    let longName = null;
    const str = (at, len) => {
      const s = u.subarray(at, at + len);
      const e = s.indexOf(0);
      return td.decode(e === -1 ? s : s.subarray(0, e));
    };
    while (off + 512 <= u.length) {
      const h = u.subarray(off, off + 512);
      let zero = true;
      for (const b of h) if (b) { zero = false; break; }
      if (zero) break;                    // the two zero blocks that end it
      // the checksum is computed with its own field read as eight spaces
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
      const want = parseInt(str(off + 148, 8).replace(/[^0-7]/g, '') || '-1', 8);
      if (want !== sum) throw new Error('checksum mismatch at byte ' + off);
      const size = parseInt(str(off + 124, 12).replace(/[^0-7]/g, '') || '0', 8) || 0;
      const type = str(off + 156, 1);
      const name = str(off, 100);
      const prefix = str(off + 345, 155);
      off += 512;
      // a truncated archive (a partial download) must not restore its last
      // page silently short. subarray would clamp and hand back fewer bytes
      // than the header declared, with no signal. Refuse the whole thing.
      if (off + size > u.length)
        throw new Error('truncated entry "' + name + '" at byte ' + off);
      const data = u.subarray(off, off + size);
      off += Math.ceil(size / 512) * 512;
      // 'L' carries the next entry's real name. '0' and '' are regular files.
      // Directories and links have nothing to restore, so they are skipped
      // rather than treated as pages.
      if (type === 'L') { longName = td.decode(data).replace(/\0+$/, ''); continue; }
      if (type !== '0' && type !== '') { longName = null; continue; }
      out.push({ name: longName || (prefix ? prefix + '/' + name : name),
        text: td.decode(data) });
      longName = null;
    }
    return out;
  }

  async function restoreVault(file) {
    if (degraded || offCount) {
      st('a restore writes many pages, so it needs the ship', false);
      return;
    }
    let entries = null;
    try { entries = untar(await file.arrayBuffer()); }
    catch (e) { st('not a readable archive: ' + e.message, false); return; }

    const pages = [];
    let knowJson = null;
    let shareJson = null;
    for (const e of entries) {
      if (e.name === 'know.json') knowJson = e.text;
      else if (e.name === 'share.json') shareJson = e.text;
      else if (e.name.startsWith('pages/'))
        pages.push({ file: { text: async () => e.text }, rel: e.name.slice(6) });
    }
    if (!pages.length && !knowJson) {
      st('that archive has no pages/ and no know.json in it', false);
      return;
    }
    // the sharing map is advisory. An archive without one (every export before
    // this) restores exactly as it always did, all-private.
    let share = {};
    if (shareJson) {
      try { share = JSON.parse(shareJson) || {}; }
      catch { st('share.json is unreadable — pages will come back private', false); }
    }
    const shared = Object.keys(share).length;

    // Say what will be overwritten BEFORE doing it. Overwrites are recoverable
    // (the old body stays in that page's history) but a restore that silently
    // buries newer work is not something to find out about afterwards.
    const stem = (rel) => { const d = rel.lastIndexOf('.'); return d > 0 ? rel.slice(0, d) : rel; };
    const clash = pages.filter((p) => hasNode(stem(p.rel))).length;
    const msg = 'restore ' + pages.length + ' page(s)' +
      (knowJson ? ' and the memories' : '') +
      (shared ? ' (' + shared + ' shared/public)' : '') +
      (clash ? '? ' + clash + ' of them already exist and will be overwritten. The '
        + 'version you have now stays in each page\'s history.'
        : '?');
    if (!(await askConfirm(msg, 'restore'))) return;

    if (pages.length) await uploadItems(pages, { verbatim: true });

    // re-apply the share modes AFTER the pages exist. page-share is per page,
    // so a tree mode is re-stated page by page — cheap for a personal store,
    // and a page the restore did not write is left exactly as it is.
    if (shared) {
      stWork('restoring share modes…');
      let ok = 0, bad = 0;
      for (const [name, mode] of Object.entries(share)) {
        try {
          // archives carry /page-scopes labels, where ames-shared is
          // 'urbit'; the share route's word is 'shared', and its unknown-
          // mode default is PRIVATE — the one mapping this loop must not
          // get wrong. (The route now also accepts 'urbit', for archives
          // restored by clients older than this line.)
          const wire = mode === 'urbit' ? 'shared' : mode;
          const r = await mutate(api + '/page-share?name=' + encodeURIComponent(name) +
            '&mode=' + encodeURIComponent(wire));
          if (r && r.ok) ok++; else bad++;
        } catch { bad++; }
      }
      if (bad) st('share modes: ' + ok + ' restored, ' + bad + ' failed', false);
    }

    if (knowJson) {
      stWork('restoring memories…');
      let r = null;
      try { r = await mutate(api + '/know-import', { method: 'POST', body: knowJson }); } catch {}
      if (r && r.ok) { st('memories restored'); bustAll(); }
      else st('pages restored, but the memories did not: ' + (r ? r.status : 'no answer'), false);
    }
    loadTree();
  }

  // The extension a kind is conventionally written with. Only `text` differs
  // from its own kind name, and it matters both ways. The export's whole
  // promise is a directory readable without lattice, where a .txt is a .txt,
  // and the restore reads extensions back through KMAP, which knows `txt` and
  // would have skipped every `.text` file as an unsupported type.
  const kindExt = (k) => (k === 'text' ? 'txt' : (k || 'md'));

  //  ~2026.08.04..23.35.53..8360.0000.0000.0001 -> unix seconds
  const daToUnix = (s) => {
    const m = /^~(\d+)\.(\d+)\.(\d+)\.\.(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
    if (!m) return Math.floor(Date.now() / 1000);
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000);
  };

  const RESTORE = `lattice vault export

pages/    every page, as a plain file named for its path and kind.
know/     every memory, one file per key.
know.json the memories again, in the format /know-import reads.
share.json  the share mode of every non-private page (path -> shared|clearweb).

To put it all back, use "restore vault" in the controls pane and pick this
file. Pages go back to the paths they came from, the memories go back with
their tags and dates, and any shared or public pages are re-shared. Anything
already there is overwritten, and the version being replaced stays in that
page's history. An archive with no share.json restores everything private.

Nothing here needs lattice to read. The pages are plain files, so grep, an
editor, or git will do if you only want to look.
`;

  // `autoId`, when given, is a backup schedule's id: build exactly the same
  // archive but hand it to the scheduler instead of a save dialog. Same code
  // path deliberately — a scheduled backup that differed from the one you can
  // make by hand is a backup nobody has actually tested restoring.
  async function exportVault(autoId) {
    if (degraded) { st('the ship is not answering, so there is nothing to export from', false); return; }
    stWork('reading the store…');
    let dump = null;
    try { dump = await (await fetch(api + '/page-dump')).json(); } catch {}
    if (!dump) { st('export failed: could not read the page tree', false); return; }

    const now = Math.floor(Date.now() / 1000);
    const files = [];
    const missing = [];
    const pages = (dump.nodes || []).filter((n) => n.page);
    for (const n of pages) {
      let body = n.body;
      // Bodies over the dump's inline cap (256 KB) are not in the dump, only
      // their size is. Fetching them one at a time is slow on a serialising
      // pier, and it is the difference between a backup and a nearly-backup.
      if (typeof body !== 'string') {
        stWork('fetching ' + n.path + '…');
        try {
          const r = await fetch(api + '/page-source?name=' + encodeURIComponent(n.path));
          body = r.ok ? (await r.json()).body : null;
        } catch { body = null; }
      }
      if (typeof body !== 'string') { missing.push(n.path); continue; }
      files.push({ name: 'pages/' + n.path + '.' + kindExt(n.kind),
        body, mtime: daToUnix(n.mtime) });
    }

    stWork('reading memories…');
    let know = null;
    try { know = await (await fetch(api + '/know-all')).json(); } catch {}
    if (know) {
      for (const it of (know.items || []))
        files.push({ name: 'know/' + String(it.key || '').replace(/^\/+/, '') + '.md',
          body: it.body || '', mtime: daToUnix(it.updated) });
      files.push({ name: 'know.json', body: JSON.stringify(know, null, 1), mtime: now });
    } else missing.push('the memories');

    // Share state is content too: a restore that brings every page back
    // private is a backup that silently unpublished a site. page-scopes is the
    // same one-peek map the search badge uses, {path, scope} per page.
    let scopes = null;
    try { scopes = await (await fetch(api + '/page-scopes')).json(); } catch {}
    if (scopes && scopes.items) {
      const share = {};
      for (const it of scopes.items)
        if (it.scope && it.scope !== 'private') share[it.path] = it.scope;
      files.push({ name: 'share.json', body: JSON.stringify(share, null, 1), mtime: now });
    } else missing.push('the share modes');

    files.push({ name: 'README.txt', body: RESTORE, mtime: now });

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fname = 'lattice-vault-' + stamp + '.tar';
    const blob = tarBlob(files);
    // Scheduled backup: Rust names the file and decides where it lands, so
    // retention can recognise its own archives. Failures are reported the same
    // way a manual export's are — a backup that quietly stopped happening is
    // the failure this whole feature exists to prevent.
    // What could not be read is named, not swallowed — in EVERY shell. The
    // scheduled and desktop branches used to return before the missing
    // report, quoting a count of pages that were not in the tar: a backup
    // you believe is complete when it is not is the one outcome worse than
    // no backup at all, and it is worst on the path that runs unattended.
    const gaps = missing.length
      ? ', but could NOT read: ' + missing.slice(0, 5).join(', ') +
        (missing.length > 5 ? ' and ' + (missing.length - 5) + ' more' : '')
      : '';
    if (autoId) {
      const d = desk();
      if (!d) return;
      try {
        const where = await d.invoke('backup_write', { id: autoId, b64: await blobToB64(blob) });
        if (gaps) st('backed up ' + pages.length + ' page(s) to ' + where +
          gaps + ' — backup INCOMPLETE', false);
        else st('backed up ' + pages.length + ' page(s) to ' + where);
      } catch (e) { st('scheduled backup failed: ' + e, false); }
      return;
    }
    const d = desk();
    if (d) {
      // The shell has no download handling of any kind, so an <a download>
      // click here does nothing at all and the export looked like it worked.
      // Hand the bytes to Rust and let it open a real save dialog.
      let where = '';
      try { where = await d.invoke('save_vault', { name: fname, b64: await blobToB64(blob) }); }
      catch (e) { st('export failed: ' + e, false); return; }
      if (!where) { st('export cancelled'); return; }
      if (gaps) st('exported ' + pages.length + ' page(s) to ' + where + gaps, false);
      else st('exported ' + pages.length + ' page(s) to ' + where);
      return;
    }
    const url = globalThis.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    setTimeout(() => globalThis.URL.revokeObjectURL(url), 30000);

    if (gaps) st('exported ' + pages.length + ' page(s)' + gaps, false);
    else st('exported ' + pages.length + ' page(s) and ' +
      ((know && (know.items || []).length) || 0) + ' memories');
  }

  // wrapped, NOT `onclick = exportVault`: that hands the click Event straight
  // in as autoId, and a MouseEvent is truthy, so every manual export would
  // have taken the scheduled-backup path and never opened the save dialog.
  $('vault').onclick = () => exportVault();
  // How the scheduler asks for one. It lives on window because the caller is
  // Rust, reaching in with eval — there is no other channel from the menu bar
  // or a timer thread into this page.
  if (window.__TAURI__) window.__latticeBackup = (id) => exportVault(id);

  // A file input cannot read a tar in the shell, so the desktop path goes
  // through Rust's own picker and hands the bytes back. restoreVault only
  // wants something with arrayBuffer(), which is all a File ever was to it.
  $('vrestore').onclick = async () => {
    const d = desk();
    if (!d) { $('vpick').click(); return; }
    let b64 = '';
    try { b64 = await d.invoke('pick_vault'); }
    catch (e) { st('could not read that file: ' + e, false); return; }
    if (!b64) return;                 // cancelled, which is not an error
    const bytes = b64ToBytes(b64);
    restoreVault({ arrayBuffer: async () => bytes.buffer });
  };
  $('vpick').onchange = () => {
    const f = $('vpick').files[0];
    $('vpick').value = '';            // same file twice in a row must re-fire
    if (f) restoreVault(f);
  };
