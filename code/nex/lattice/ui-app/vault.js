/* Shared vault module. Served standalone at /apps/lattice/app/vault.js and
 * loaded by BOTH the editor bundle (ui-app/src/78-export.js) and the settings
 * page (settings-html), so the tar writer/reader and the export/restore
 * orchestration exist once. Two environment touchpoints, the status line and
 * the offline check, are INJECTED via LatticeVault.configure({...}): the
 * editor passes its own, the settings page shows status in its own pane.
 *
 * exportVault(autoId?) and restoreVault(file) are byte-for-byte the same paths
 * that ui-app/src/78-export.js used to own — moved here verbatim so a manual
 * export, a scheduled backup and a settings-page export are the SAME archive. */
(function () {
  'use strict';

  // ── tar writer ─────────────────────────────────────────────────────────────
  const te = new TextEncoder();
  const oct = (n, w) => n.toString(8).padStart(w - 1, '0') + '\0';
  const pad512 = (n) => new Uint8Array((512 - (n % 512)) % 512);
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
    put('0000644\0', 100, 8);
    put('0000000\0', 108, 8);
    put('0000000\0', 116, 8);
    put(oct(size, 12), 124, 12);
    put(oct(mtime, 12), 136, 12);
    h.fill(32, 148, 156);
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
      parts.push(tarHeader(f.name, data.length, f.mtime, '0'), data, pad512(data.length));
    }
    parts.push(new Uint8Array(1024));
    return new Blob(parts, { type: 'application/x-tar' });
  }

  // ── tar reader (verifies the checksum; refuses a truncated archive) ──────────
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
      if (zero) break;
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
      const want = parseInt(str(off + 148, 8).replace(/[^0-7]/g, '') || '-1', 8);
      if (want !== sum) throw new Error('checksum mismatch at byte ' + off);
      const size = parseInt(str(off + 124, 12).replace(/[^0-7]/g, '') || '0', 8) || 0;
      const type = str(off + 156, 1);
      const name = str(off, 100);
      const prefix = str(off + 345, 155);
      off += 512;
      if (off + size > u.length)
        throw new Error('truncated entry "' + name + '" at byte ' + off);
      const data = u.subarray(off, off + size);
      off += Math.ceil(size / 512) * 512;
      if (type === 'L') { longName = td.decode(data).replace(/\0+$/, ''); continue; }
      if (type !== '0' && type !== '') { longName = null; continue; }
      out.push({ name: longName || (prefix ? prefix + '/' + name : name),
        text: td.decode(data) });
      longName = null;
    }
    return out;
  }

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

  // extension the writer uses, and the reverse map the reader files pages back
  // through. `text` is the only kind whose extension differs from its name;
  // `index` is a page the ship generates and its file form is markdown.
  //
  // Twin of KIND_EXT/EXT_KIND in ui-app/src/30-tree.js, duplicated on purpose:
  // this file is also served alone to the Settings page, with no bundle around
  // it, so it cannot read the bundle's copy. The two must answer the same, and
  // lattice-fs-rs/src/projection.rs is the third copy, across the process line.
  const kindExt = (k) => (k === 'text' ? 'txt' : k === 'index' ? 'md' : (k || 'md'));
  const KMAP = { md: 'md', gmi: 'gmi', html: 'html', htm: 'html', txt: 'text',
    text: 'text', js: 'js', css: 'css', hoon: 'hoon', tex: 'tex', latex: 'tex' };

  const daToUnix = (s) => {
    const m = /^~(\d+)\.(\d+)\.(\d+)\.\.(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
    if (!m) return Math.floor(Date.now() / 1000);
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000);
  };

  // mirror of the server's +valid-name and of 10-shell.js's own copy (@ta
  // segments; no '.'/'..'): reject a bad name BEFORE it goes into a batch.
  // The bundle's copy is unreachable here — same reason KMAP/kindExt above
  // are duplicated rather than imported.
  const validName = (n) => String(n || '').split('/').every(
    (s) => s.length && s !== '.' && s !== '..' && /^[a-z0-9._~-]+$/.test(s));

  const RESTORE = `lattice vault export

pages/    every page you wrote, as a plain file named for its path and kind.
          Generated folder indexes are left out: the store rebuilds them from
          the folder itself, so they come back when their folder does.
know/     every memory, one file per key.
know.json the memories again, in the format /know-import reads.
share.json  the share mode of every non-private page (path -> shared|clearweb).
names.json  the display name of every page or folder that was named with
          capitals or spaces (path -> the name shown in the tree).
sensitive.json  every page or folder marked sensitive (a list of paths).
manifest.json  how many pages and memories the export meant to write, and
          anything it could not read.

To put it all back, use "restore vault" in Settings and pick this file. Pages
go back to the paths they came from, the memories go back with their tags and
dates, and any shared or public pages are re-shared once you confirm the list. Anything already there is
overwritten, and the version being replaced stays in that page's history. An
archive with no share.json restores everything private.

Nothing here needs lattice to read. The pages are plain files, so grep, an
editor, or git will do if you only want to look.
`;

  // ── injected environment ─────────────────────────────────────────────────────
  // Defaults are the browser/settings flavour; the editor overrides them.
  const cfg = {
    status: (msg) => { try { console.log('[vault]', msg); } catch (e) {} },
    isDegraded: () => false,
  };
  const api = '/apps/lattice';
  const desk = () => (window.__TAURI__ && window.__TAURI__.core) || null;
  function configure(o) { Object.assign(cfg, o || {}); }
  const st = (m, ok) => cfg.status(m, ok !== false);
  const mutate = (url, opts) =>
    fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}));

  // ── self-contained restore upload (mirrors 70-upload.js's page-save-batch) ───
  // The archive's pages/ entries as the pages a restore would write. Split out
  // of uploadPages so the confirm dialog can name what is about to be shared
  // before anything is written.
  function parsePages(pages) {
    const list = [];
    // skips are counted so the completion message can say the restore was
    // lossy, split by reason so an extension problem and a name problem don't
    // blur together. A silent skip once cost every tex page in the archive.
    let skipExt = 0, skipName = 0;
    for (const { rel, text } of pages) {
      const dot = rel.lastIndexOf('.');
      const kind = dot > 0 ? KMAP[rel.slice(dot + 1).toLowerCase()] : null;
      if (!kind) { skipExt++; continue; }          // an unknown extension is skipped, not guessed
      const name = rel.slice(0, dot);
      // rejected here, before it can reach a batch: a name the server would
      // 400 on takes the other 49 pages in its chunk down with it, since
      // /page-save-batch's plain mode is all-or-nothing.
      if (!name || !validName(name)) { skipName++; continue; }
      list.push({ name, kind, body: text });
    }
    return { list, skipExt, skipName };
  }

  // share.json and names.json are trusted only as far as the pages they
  // describe. A share mode applies to a page this restore actually saved. A
  // display name applies to a saved page, or to a folder holding one. So an
  // archive cannot publish, or rename, something it did not bring back.
  const covers = (saved, path) => {
    if (saved.has(path)) return true;
    const pre = path + '/';
    for (const n of saved) if (n.startsWith(pre)) return true;
    return false;
  };
  // 'urbit' is how /page-scopes labels ames-shared; the route's word is 'shared'
  const wireMode = (m) => (m === 'urbit' ? 'shared' : m);
  function restorePlan(share, names, saved) {
    const shareOk = [], namesOk = [];
    let dropped = 0;
    for (const [name, mode] of Object.entries(share || {})) {
      if (typeof mode !== 'string' || !mode) continue;
      if (saved.has(name)) shareOk.push([name, wireMode(mode)]); else dropped++;
    }
    for (const [path, dname] of Object.entries(names || {})) {
      if (typeof dname !== 'string' || !dname) continue;
      if (covers(saved, path)) namesOk.push([path, dname]); else dropped++;
    }
    return { share: shareOk, names: namesOk, dropped, saved };
  }
  // the confirm text. Every page the restore would make shared or clearweb is
  // named with its mode, not counted: a count cannot tell you which of your
  // pages is about to go public. The closing words are askPublish's own
  // warning (ui-src/lattice/15-dialog.js).
  function restoreMessage(npages, withKnow, publish) {
    let msg = 'restore ' + npages + ' page(s)' + (withKnow ? ' and the memories' : '') + '?';
    if (publish.length) {
      msg += '\n\nThis will publish ' + publish.length + ' page(s):\n'
        + publish.map(([n, m]) => '  ' + n + ' (' + m + ')').join('\n')
        + '\n\nOnce published, deletion is not assured. Anyone who has read '
        + 'these pages can keep a copy, and the network may go on serving them after '
        + 'you unpublish or delete them.';
    }
    return msg;
  }

  // -> the counts, and `saved`: the Set of page names the ship actually took.
  // Everything restored after the pages is filtered through that set.
  async function uploadPages(list) {
    const saved = new Set();
    const dirs = new Set();
    for (const { name } of list) {
      const pp = name.split('/'); pp.pop();
      for (let i = 1; i <= pp.length; i++) dirs.add(pp.slice(0, i).join('/'));
    }
    for (const d of [...dirs].sort()) {
      try { await mutate(api + '/folder-new?name=' + encodeURIComponent(d), { method: 'POST' }); } catch (e) {}
    }
    const CHUNK = 50;
    let ok = 0, bad = 0;
    const failed = [];        // first few names the ship itself refused
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      let r = null;
      try {
        r = await mutate(api + '/page-save-batch', {
          method: 'POST',
          body: JSON.stringify(part.map((it) => ({ name: it.name, type: it.kind, body: it.body || '\n' }))),
        });
      } catch (e) {}
      if (r && r.ok) { ok += part.length; for (const it of part) saved.add(it.name); continue; }
      // the chunk was refused whole, same all-or-nothing shape the offline
      // queue's drain hits on replay (08-offline.js ~509-549). Fall back to
      // the single-page route one page at a time, so only the record that
      // actually fails is the one that's lost, not the other 49.
      for (const it of part) {
        let one = null;
        try {
          one = await mutate(api + '/page-save?name=' + encodeURIComponent(it.name) +
            '&type=' + it.kind, { method: 'POST', body: it.body || '\n' });
        } catch (e) {}
        if (one && one.ok) { ok++; saved.add(it.name); continue; }
        bad++;
        if (failed.length < 5) failed.push(it.name);
      }
    }
    return { ok, bad, failed, saved };
  }

  async function restoreVault(file) {
    if (cfg.isDegraded()) { st('a restore writes many pages, so it needs the ship', false); return; }
    let entries = null;
    try { entries = untar(await file.arrayBuffer()); }
    catch (e) { st('not a readable archive: ' + e.message, false); return; }

    const pages = [];
    let knowJson = null, shareJson = null, namesJson = null, sensJson = null;
    for (const e of entries) {
      if (e.name === 'know.json') knowJson = e.text;
      else if (e.name === 'share.json') shareJson = e.text;
      else if (e.name === 'names.json') namesJson = e.text;
      else if (e.name === 'sensitive.json') sensJson = e.text;
      else if (e.name.startsWith('pages/')) pages.push({ rel: e.name.slice(6), text: e.text });
    }
    if (!pages.length && !knowJson) { st('that archive has no pages/ and no know.json in it', false); return; }

    let share = {};
    if (shareJson) { try { share = JSON.parse(shareJson) || {}; } catch (e) { st('share.json is unreadable — pages will come back private', false); } }
    let names = {};
    if (namesJson) { try { names = JSON.parse(namesJson) || {}; } catch (e) { st('names.json is unreadable — display names will not come back', false); } }
    let sens = [];
    if (sensJson) { try { sens = JSON.parse(sensJson) || []; } catch (e) { st('sensitive.json is unreadable — sensitive marks will not come back', false); } }

    // what the confirm names: every share entry for a page this archive could
    // put back. The pages are not written yet, so this is the most it can be.
    const parsed = parsePages(pages);
    const willShare = restorePlan(share, {}, new Set(parsed.list.map((it) => it.name))).share
      .filter(([, m]) => m !== 'private');
    if (!window.confirm(restoreMessage(pages.length, !!knowJson, willShare))) return;

    let plan = restorePlan({}, {}, new Set());
    if (pages.length) {
      st('restoring pages…');
      const u = await uploadPages(parsed.list);
      plan = restorePlan(share, names, u.saved);
      // "restoring pages…" is the only status this leaves behind on a clean
      // run unless something replaces it below, so the summary paints every
      // time, not only when something went wrong.
      const bits = ['pages: ' + u.ok + ' restored'];
      if (parsed.skipExt) bits.push(parsed.skipExt + ' skipped (unknown extension)');
      if (parsed.skipName) bits.push(parsed.skipName + ' skipped (bad name)');
      if (u.bad) {
        const more = u.bad > u.failed.length ? ' and ' + (u.bad - u.failed.length) + ' more' : '';
        bits.push(u.bad + ' failed: ' + u.failed.join(', ') + more);
      }
      if (plan.dropped) bits.push(plan.dropped + ' share mode or name entries ignored (no restored page)');
      st(bits.join(', '), !u.bad);
    }

    // sensitive marks before share modes, and as soon as the pages are in,
    // for any restored page or a folder holding one (the same trust rule as
    // names.json)
    const marks = Array.isArray(sens)
      ? sens.filter((p) => typeof p === 'string' && p && covers(plan.saved, p)) : [];
    if (marks.length) {
      st('restoring sensitive marks…');
      let bad = 0;
      for (const path of marks) {
        try {
          const r = await mutate(api + '/page-sensitive?name=' + encodeURIComponent(path) + '&on=1', { method: 'POST' });
          if (!(r && r.ok)) bad++;
        } catch (e) { bad++; }
      }
      if (bad) st('sensitive marks: ' + bad + ' failed', false);
    }

    if (plan.share.length) {
      st('restoring share modes…');
      let ok = 0, bad = 0;
      for (const [name, mode] of plan.share) {
        try {
          const r = await mutate(api + '/page-share?name=' + encodeURIComponent(name) +
            '&mode=' + encodeURIComponent(mode), { method: 'POST' });
          if (r && r.ok) ok++; else bad++;
        } catch (e) { bad++; }
      }
      if (bad) st('share modes: ' + ok + ' restored, ' + bad + ' failed', false);
    }

    // display names go back through page-move to the same path, which the
    // ship treats as "set the display name" for a page or a folder
    if (plan.names.length) {
      st('restoring display names…');
      let bad = 0;
      for (const [path, dname] of plan.names) {
        try {
          const r = await mutate(api + '/page-move?from=' + encodeURIComponent(path) +
            '&to=' + encodeURIComponent(path) + '&dname=' + encodeURIComponent(dname), { method: 'POST' });
          if (!(r && r.ok)) bad++;
        } catch (e) { bad++; }
      }
      if (bad) st('display names: ' + bad + ' failed', false);
    }

    if (knowJson) {
      st('restoring memories…');
      let r = null;
      try { r = await mutate(api + '/know-import', { method: 'POST', body: knowJson }); } catch (e) {}
      if (r && r.ok) st('memories restored');
      else st('pages restored, but the memories did not: ' + (r ? r.status : 'no answer'), false);
    }
  }

  // ── export ───────────────────────────────────────────────────────────────────
  // autoId, when given, is a scheduled backup: build the SAME archive and hand
  // it to Rust's backup_write instead of a save dialog.
  async function exportVault(autoId) {
    if (cfg.isDegraded()) { st('the ship is not answering, so there is nothing to export from', false); return; }
    st('reading the store…');
    let dump = null;
    try { dump = await (await mutate(api + '/page-dump')).json(); } catch (e) {}
    if (!dump) { st('export failed: could not read the page tree', false); return; }

    const now = Math.floor(Date.now() / 1000);
    const files = [];
    //  two different things, kept apart on purpose. `missing` is a FAILURE: a
    //  page whose body could not be read, which makes the archive incomplete
    //  and says so loudly. `excluded` is a deliberate omission of content the
    //  store regenerates. Reporting the second as the first would mark every
    //  backup of a store with folders INCOMPLETE, and a warning that fires on
    //  every healthy run is a warning nobody reads when it finally matters.
    const missing = [];
    const excluded = [];
    // A folder index is generated: its body is the hoon that builds the
    // listing, not anything the user wrote, and no extension files it back as
    // an index page. Naming it beats writing a file the restore would either
    // skip or put back as a markdown page full of hoon.
    const pages = [];
    for (const n of (dump.nodes || [])) {
      if (!n.page) continue;
      if (n.kind === 'index') { excluded.push(n.path); continue; }
      pages.push(n);
    }
    for (const n of pages) {
      let body = n.body;
      if (typeof body !== 'string') {
        st('fetching ' + n.path + '…');
        try {
          const r = await mutate(api + '/page-source?name=' + encodeURIComponent(n.path));
          body = r.ok ? (await r.json()).body : null;
        } catch (e) { body = null; }
      }
      if (typeof body !== 'string') { missing.push(n.path); continue; }
      files.push({ name: 'pages/' + n.path + '.' + kindExt(n.kind), body, mtime: daToUnix(n.mtime) });
    }

    st('reading memories…');
    let know = null;
    try { know = await (await mutate(api + '/know-all')).json(); } catch (e) {}
    if (know) {
      for (const it of (know.items || []))
        files.push({ name: 'know/' + String(it.key || '').replace(/^\/+/, '') + '.md', body: it.body || '', mtime: daToUnix(it.updated) });
      files.push({ name: 'know.json', body: JSON.stringify(know, null, 1), mtime: now });
    } else missing.push('the memories');

    let scopes = null;
    try { scopes = await (await mutate(api + '/page-scopes')).json(); } catch (e) {}
    if (scopes && scopes.items) {
      const share = {};
      for (const it of scopes.items) if (it.scope && it.scope !== 'private') share[it.path] = it.scope;
      files.push({ name: 'share.json', body: JSON.stringify(share, null, 1), mtime: now });
    } else missing.push('the share modes');

    // names.json: share.json's twin for display names (path -> shown name),
    // pages and folders alike, straight off the dump the pages came from
    const names = {};
    for (const n of (dump.nodes || [])) if (n.dname) names[n.path] = n.dname;
    // sensitive.json: the pages and folders carrying their own sensitive mark.
    // Without it a restore brought them back readable by uncleared keys.
    const sensitive = (dump.nodes || []).filter((n) => n.sensitive).map((n) => n.path);
    files.push({ name: 'sensitive.json', body: JSON.stringify(sensitive, null, 1), mtime: now });
    if (Object.keys(names).length)
      files.push({ name: 'names.json', body: JSON.stringify(names, null, 1), mtime: now });

    // manifest.json: what this export MEANT to write. The tar alone cannot
    // say it is short, so the desktop's verify holds the archive to this.
    files.push({ name: 'manifest.json', mtime: now, body: JSON.stringify({
      pages: pages.length,
      memories: know ? (know.items || []).length : null,
      missing,
    }, null, 1) });
    files.push({ name: 'README.txt', body: RESTORE, mtime: now });

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fname = 'lattice-vault-' + stamp + '.tar';
    const blob = tarBlob(files);
    const gaps = missing.length
      ? ', but could NOT read: ' + missing.slice(0, 5).join(', ') +
        (missing.length > 5 ? ' and ' + (missing.length - 5) + ' more' : '') : '';
    //  said plainly, and never as a failure: these come back when the folder
    //  does, so their absence costs nothing on restore.
    const skipped = excluded.length
      ? ' (' + excluded.length + ' generated folder index'
        + (excluded.length === 1 ? '' : 'es') + ' not included, they rebuild themselves)'
      : '';

    if (autoId) {
      const d = desk();
      if (!d) return;
      try {
        // complete: false keeps the archive out of retention and leaves the
        // schedule due (desktop/src/backup.rs)
        const where = await d.invoke('backup_write',
          { id: autoId, b64: await blobToB64(blob), complete: missing.length === 0 });
        if (gaps) st('backed up ' + pages.length + ' page(s) to ' + where + gaps + ' — backup INCOMPLETE', false);
        else st('backed up ' + pages.length + ' page(s) to ' + where + skipped);
      } catch (e) { st('scheduled backup failed: ' + e, false); }
      return;
    }
    const d = desk();
    if (d) {
      let where = '';
      try { where = await d.invoke('save_vault', { name: fname, b64: await blobToB64(blob) }); }
      catch (e) { st('export failed: ' + e, false); return; }
      if (!where) { st('export cancelled'); return; }
      if (gaps) st('exported ' + pages.length + ' page(s) to ' + where + gaps, false);
      else st('exported ' + pages.length + ' page(s) to ' + where + skipped);
      return;
    }
    const url = globalThis.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname; a.click();
    setTimeout(() => globalThis.URL.revokeObjectURL(url), 30000);
    if (gaps) st('exported ' + pages.length + ' page(s)' + gaps, false);
    else st('exported ' + pages.length + ' page(s) and '
      + ((know && (know.items || []).length) || 0) + ' memories' + skipped);
  }

  // ── settings-page UI ─────────────────────────────────────────────────────────
  // Renders into the Backup section of settings-html: the manual export/restore
  // buttons for everyone. The automated-backup schedules live on the desktop
  // app's own manager page (desktop/ui/manager.html), which only the user's
  // clicks there can change. settings-html links to it with a desktop-only
  // "Scheduled backups" button.
  const el = (tag, props, kids) => {
    const n = document.createElement(tag);
    if (props) for (const k in props) { if (k === 'class') n.className = props[k]; else if (k === 'text') n.textContent = props[k]; else n[k] = props[k]; }
    for (const c of (kids || [])) n.append(c);
    return n;
  };

  // manual export and restore: the browser (download / file input) and the
  // desktop shell (native save / open dialog, chosen inside exportVault/desk())
  // both get these. This is also where the module's status callback is
  // installed, so mounting the pane is what wires up its status line.
  function mountManual(root) {
    const status = el('span', { class: 'muted' });
    configure({
      status: (m, ok) => { status.textContent = m || ''; status.className = ok === false ? 'err' : 'muted'; },
    });

    const exportBtn = el('button', { type: 'button', class: 'btn', text: 'Export vault' });
    exportBtn.onclick = () => exportVault();
    const pick = el('input', { type: 'file', accept: '.tar,application/x-tar', hidden: true });
    pick.onchange = () => { const f = pick.files[0]; pick.value = ''; if (f) restoreVault(f); };
    const restoreBtn = el('button', { type: 'button', class: 'btn', text: 'Restore vault…' });
    restoreBtn.onclick = async () => {
      const d = desk();
      if (!d) { pick.click(); return; }
      let b64 = '';
      try { b64 = await d.invoke('pick_vault'); } catch (e) { st('could not read that file: ' + e, false); return; }
      if (!b64) return;
      const bytes = b64ToBytes(b64);
      restoreVault({ arrayBuffer: async () => bytes.buffer });
    };
    root.append(
      el('p', { class: 'muted' }, [document.createTextNode('Download every page and memory as one tar, or restore from one. The archive is plain files, readable without lattice.')]),
      el('p', null, [exportBtn, document.createTextNode(' '), restoreBtn, pick, document.createTextNode(' '), status]),
    );
  }

  // the scheduled-backup CRUD: list, verify, add. Desktop only, and it talks
  // to the shell rather than to the ship.
  function mountSettings(root) {
    mountManual(root);
    // automated: desktop only. In a browser there is no scheduler and nowhere on
    // the machine to write to, so say that rather than showing dead controls.
    // On the desktop (this page is usually a frame of the editor, so its
    // bridge is the top window's) the Scheduled backups button says the rest.
    let onDesk = !!desk();
    try { onDesk = onDesk || !!window.top.__TAURI__; } catch (e) {}
    if (onDesk) return;
    root.append(el('p', { class: 'muted', text: 'Automatic scheduled backups run in the lattice desktop app. Open lattice on your computer to set them up.' }));
  }

  //  the editor (78-export.js) configures and runs exportVault for the
  //  desktop scheduler; the settings page mounts the pane. Nothing else
  //  reaches in.
  window.LatticeVault = { configure, exportVault, mountSettings };
})();
