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
    for (const e of entries) {
      if (e.name === 'know.json') knowJson = e.text;
      else if (e.name.startsWith('pages/'))
        pages.push({ file: { text: async () => e.text }, rel: e.name.slice(6) });
    }
    if (!pages.length && !knowJson) {
      st('that archive has no pages/ and no know.json in it', false);
      return;
    }

    // Say what will be overwritten BEFORE doing it. Overwrites are recoverable
    // (the old body stays in that page's history) but a restore that silently
    // buries newer work is not something to find out about afterwards.
    const stem = (rel) => { const d = rel.lastIndexOf('.'); return d > 0 ? rel.slice(0, d) : rel; };
    const clash = pages.filter((p) => hasNode(stem(p.rel))).length;
    const msg = 'restore ' + pages.length + ' page(s)' +
      (knowJson ? ' and the memories' : '') +
      (clash ? '? ' + clash + ' of them already exist and will be overwritten. The '
        + 'version you have now stays in each page\'s history.'
        : '?');
    if (!(await askConfirm(msg, 'restore'))) return;

    if (pages.length) await uploadItems(pages, { verbatim: true });

    if (knowJson) {
      stWork('restoring memories…');
      let r = null;
      try { r = await mutate(api + '/know-import', { method: 'POST', body: knowJson }); } catch {}
      if (r && r.ok) st('memories restored');
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

To put it all back, use "restore vault" in the controls pane and pick this
file. Pages go back to the paths they came from and the memories go back with
their tags and dates. Anything already there is overwritten, and the version
being replaced stays in that page's history.

Nothing here needs lattice to read. The pages are plain files, so grep, an
editor, or git will do if you only want to look.
`;

  async function exportVault() {
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

    files.push({ name: 'README.txt', body: RESTORE, mtime: now });

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const url = globalThis.URL.createObjectURL(tarBlob(files));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lattice-vault-' + stamp + '.tar';
    a.click();
    setTimeout(() => globalThis.URL.revokeObjectURL(url), 30000);

    // What could not be read is named, not swallowed. A backup you believe is
    // complete when it is not is the only outcome here that is worse than no
    // backup at all.
    if (missing.length) {
      st('exported ' + pages.length + ' page(s), but could NOT read: ' +
        missing.slice(0, 5).join(', ') +
        (missing.length > 5 ? ' and ' + (missing.length - 5) + ' more' : ''), false);
    } else st('exported ' + pages.length + ' page(s) and ' +
      ((know && (know.items || []).length) || 0) + ' memories');
  }

  $('vault').onclick = exportVault;

  // The desktop shell has no working file input for this. Its native picker
  // (pick_upload) hands back decoded TEXT, which would corrupt a tar's bytes,
  // so restore is browser-only until that command can return raw bytes. Say
  // so rather than opening a picker that silently does nothing.
  $('vrestore').onclick = () => {
    if (window.__TAURI__) {
      st('restore needs a file picker the desktop shell cannot do yet — use the browser', false);
      return;
    }
    $('vpick').click();
  };
  $('vpick').onchange = () => {
    const f = $('vpick').files[0];
    $('vpick').value = '';            // same file twice in a row must re-fire
    if (f) restoreVault(f);
  };
