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

  //  ~2026.08.04..23.35.53..8360.0000.0000.0001 -> unix seconds
  const daToUnix = (s) => {
    const m = /^~(\d+)\.(\d+)\.(\d+)\.\.(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
    if (!m) return Math.floor(Date.now() / 1000);
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000);
  };

  const RESTORE = `lattice vault export

pages/    every page, as a plain file named for its path and kind.
know/     every memory, one file per key.
know.json the memories again, in the format /know-import reads. Restoring
          them is one POST of this file to that route.

Pages restore by saving each file back under its path, which the desktop
client's folder sync does for a whole directory at once.
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
      files.push({ name: 'pages/' + n.path + '.' + (n.kind || 'md'),
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
