/* Shared vault module. Served standalone at /apps/lattice/app/vault.js and
 * loaded by BOTH the editor bundle (ui-app/src/78-export.js) and the settings
 * page (settings-html), so the tar writer/reader and the export/restore
 * orchestration exist once. Environment touchpoints (status line, confirm
 * dialog, tree lookups) are INJECTED via LatticeVault.configure({...}); the
 * editor injects its rich helpers, the settings page injects simple ones.
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
  // through. `text` is the only kind whose extension differs from its name.
  const kindExt = (k) => (k === 'text' ? 'txt' : (k || 'md'));
  const KMAP = { md: 'md', gmi: 'gmi', html: 'html', htm: 'html', txt: 'text',
    text: 'text', js: 'js', css: 'css', hoon: 'hoon' };

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

To put it all back, use "restore vault" in Settings and pick this file. Pages
go back to the paths they came from, the memories go back with their tags and
dates, and any shared or public pages are re-shared. Anything already there is
overwritten, and the version being replaced stays in that page's history. An
archive with no share.json restores everything private.

Nothing here needs lattice to read. The pages are plain files, so grep, an
editor, or git will do if you only want to look.
`;

  // ── injected environment ─────────────────────────────────────────────────────
  // Defaults are the browser/settings flavour; the editor overrides them.
  const cfg = {
    api: '/apps/lattice',
    desk: () => (window.__TAURI__ && window.__TAURI__.core) || null,
    status: (msg) => { try { console.log('[vault]', msg); } catch (e) {} },
    confirm: (msg) => Promise.resolve(window.confirm(msg)),
    hasNode: () => false,       // no tree here, so no overwrite pre-count
    afterRestore: () => {},
    isDegraded: () => false,
  };
  function configure(o) { Object.assign(cfg, o || {}); }
  const st = (m, ok) => cfg.status(m, ok !== false);
  const mutate = (url, opts) =>
    fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}));

  // ── self-contained restore upload (mirrors 70-upload.js's page-save-batch) ───
  async function uploadPages(pages) {
    const list = [];
    const dirs = new Set();
    for (const { rel, text } of pages) {
      const dot = rel.lastIndexOf('.');
      const kind = dot > 0 ? KMAP[rel.slice(dot + 1).toLowerCase()] : null;
      if (!kind) continue;                         // an unknown extension is skipped, not guessed
      const name = rel.slice(0, dot);
      if (!name) continue;
      list.push({ name, kind, body: text });
      const pp = name.split('/'); pp.pop();
      for (let i = 1; i <= pp.length; i++) dirs.add(pp.slice(0, i).join('/'));
    }
    for (const d of [...dirs].sort())
      if (!cfg.hasNode(d)) { try { await mutate(cfg.api + '/folder-new?name=' + encodeURIComponent(d)); } catch (e) {} }
    const CHUNK = 50;
    let ok = 0, bad = 0;
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK).map((it) => ({ name: it.name, type: it.kind, body: it.body || '\n' }));
      let r = null;
      try { r = await mutate(cfg.api + '/page-save-batch', { method: 'POST', body: JSON.stringify(part) }); } catch (e) {}
      if (r && r.ok) ok += part.length; else bad += part.length;
    }
    return { ok, bad };
  }

  async function restoreVault(file) {
    if (cfg.isDegraded()) { st('a restore writes many pages, so it needs the ship', false); return; }
    let entries = null;
    try { entries = untar(await file.arrayBuffer()); }
    catch (e) { st('not a readable archive: ' + e.message, false); return; }

    const pages = [];
    let knowJson = null, shareJson = null;
    for (const e of entries) {
      if (e.name === 'know.json') knowJson = e.text;
      else if (e.name === 'share.json') shareJson = e.text;
      else if (e.name.startsWith('pages/')) pages.push({ rel: e.name.slice(6), text: e.text });
    }
    if (!pages.length && !knowJson) { st('that archive has no pages/ and no know.json in it', false); return; }

    let share = {};
    if (shareJson) { try { share = JSON.parse(shareJson) || {}; } catch (e) { st('share.json is unreadable — pages will come back private', false); } }
    const shared = Object.keys(share).length;

    const stem = (rel) => { const d = rel.lastIndexOf('.'); return d > 0 ? rel.slice(0, d) : rel; };
    const clash = pages.filter((p) => cfg.hasNode(stem(p.rel))).length;
    const msg = 'restore ' + pages.length + ' page(s)' +
      (knowJson ? ' and the memories' : '') +
      (shared ? ' (' + shared + ' shared/public)' : '') +
      (clash ? '? ' + clash + ' of them already exist and will be overwritten. The '
        + "version you have now stays in each page's history." : '?');
    if (!(await cfg.confirm(msg, 'restore'))) return;

    if (pages.length) {
      st('restoring pages…');
      const u = await uploadPages(pages);
      if (u.bad) st('pages: ' + u.ok + ' restored, ' + u.bad + ' failed', false);
    }

    if (shared) {
      st('restoring share modes…');
      let ok = 0, bad = 0;
      for (const [name, mode] of Object.entries(share)) {
        try {
          const wire = mode === 'urbit' ? 'shared' : mode;   // /page-scopes labels ames-shared 'urbit'; the route's word is 'shared'
          const r = await mutate(cfg.api + '/page-share?name=' + encodeURIComponent(name) + '&mode=' + encodeURIComponent(wire));
          if (r && r.ok) ok++; else bad++;
        } catch (e) { bad++; }
      }
      if (bad) st('share modes: ' + ok + ' restored, ' + bad + ' failed', false);
    }

    if (knowJson) {
      st('restoring memories…');
      let r = null;
      try { r = await mutate(cfg.api + '/know-import', { method: 'POST', body: knowJson }); } catch (e) {}
      if (r && r.ok) st('memories restored');
      else st('pages restored, but the memories did not: ' + (r ? r.status : 'no answer'), false);
    }
    cfg.afterRestore();
  }

  // ── export ───────────────────────────────────────────────────────────────────
  // autoId, when given, is a scheduled backup: build the SAME archive and hand
  // it to Rust's backup_write instead of a save dialog.
  async function exportVault(autoId) {
    if (cfg.isDegraded()) { st('the ship is not answering, so there is nothing to export from', false); return; }
    st('reading the store…');
    let dump = null;
    try { dump = await (await mutate(cfg.api + '/page-dump')).json(); } catch (e) {}
    if (!dump) { st('export failed: could not read the page tree', false); return; }

    const now = Math.floor(Date.now() / 1000);
    const files = [];
    const missing = [];
    const pages = (dump.nodes || []).filter((n) => n.page);
    for (const n of pages) {
      let body = n.body;
      if (typeof body !== 'string') {
        st('fetching ' + n.path + '…');
        try {
          const r = await mutate(cfg.api + '/page-source?name=' + encodeURIComponent(n.path));
          body = r.ok ? (await r.json()).body : null;
        } catch (e) { body = null; }
      }
      if (typeof body !== 'string') { missing.push(n.path); continue; }
      files.push({ name: 'pages/' + n.path + '.' + kindExt(n.kind), body, mtime: daToUnix(n.mtime) });
    }

    st('reading memories…');
    let know = null;
    try { know = await (await mutate(cfg.api + '/know-all')).json(); } catch (e) {}
    if (know) {
      for (const it of (know.items || []))
        files.push({ name: 'know/' + String(it.key || '').replace(/^\/+/, '') + '.md', body: it.body || '', mtime: daToUnix(it.updated) });
      files.push({ name: 'know.json', body: JSON.stringify(know, null, 1), mtime: now });
    } else missing.push('the memories');

    let scopes = null;
    try { scopes = await (await mutate(cfg.api + '/page-scopes')).json(); } catch (e) {}
    if (scopes && scopes.items) {
      const share = {};
      for (const it of scopes.items) if (it.scope && it.scope !== 'private') share[it.path] = it.scope;
      files.push({ name: 'share.json', body: JSON.stringify(share, null, 1), mtime: now });
    } else missing.push('the share modes');

    files.push({ name: 'README.txt', body: RESTORE, mtime: now });

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fname = 'lattice-vault-' + stamp + '.tar';
    const blob = tarBlob(files);
    const gaps = missing.length
      ? ', but could NOT read: ' + missing.slice(0, 5).join(', ') +
        (missing.length > 5 ? ' and ' + (missing.length - 5) + ' more' : '') : '';

    if (autoId) {
      const d = cfg.desk();
      if (!d) return;
      try {
        const where = await d.invoke('backup_write', { id: autoId, b64: await blobToB64(blob) });
        if (gaps) st('backed up ' + pages.length + ' page(s) to ' + where + gaps + ' — backup INCOMPLETE', false);
        else st('backed up ' + pages.length + ' page(s) to ' + where);
      } catch (e) { st('scheduled backup failed: ' + e, false); }
      return;
    }
    const d = cfg.desk();
    if (d) {
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
    a.href = url; a.download = fname; a.click();
    setTimeout(() => globalThis.URL.revokeObjectURL(url), 30000);
    if (gaps) st('exported ' + pages.length + ' page(s)' + gaps, false);
    else st('exported ' + pages.length + ' page(s) and ' + ((know && (know.items || []).length) || 0) + ' memories');
  }

  // ── settings-page UI ─────────────────────────────────────────────────────────
  // Renders into the Backup section of settings-html: the manual export/restore
  // buttons for everyone, and — only in the desktop shell, where a scheduler and
  // a place to write to both exist — the automated-backup schedules. The schedule
  // list is the same one the old "scheduled backups…" manager page drove, moved
  // here so backup lives in one place.
  const el = (tag, props, kids) => {
    const n = document.createElement(tag);
    if (props) for (const k in props) { if (k === 'class') n.className = props[k]; else if (k === 'text') n.textContent = props[k]; else n[k] = props[k]; }
    for (const c of (kids || [])) n.append(c);
    return n;
  };
  const period = (h) => (h === 24 ? 'daily' : h === 168 ? 'weekly' : h === 720 ? 'every 30 days' : h === 1 ? 'hourly' : 'every ' + h + 'h');
  const ago = (t) => {
    if (!t) return 'never run';
    const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
    if (s < 3600) return 'last run ' + Math.floor(s / 60) + 'm ago';
    if (s < 86400) return 'last run ' + Math.floor(s / 3600) + 'h ago';
    return 'last run ' + Math.floor(s / 86400) + 'd ago';
  };
  const bkId = () => 'bk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function mountSettings(root) {
    const status = el('span', { class: 'muted' });
    configure({
      status: (m, ok) => { status.textContent = m || ''; status.className = ok === false ? 'err' : 'muted'; },
      confirm: (m) => Promise.resolve(window.confirm(m)),
      hasNode: () => false,
      isDegraded: () => false,
      afterRestore: () => {},
    });

    // manual: works in the browser (download / file input) and the desktop shell
    // (native save / open dialog, chosen inside exportVault/desk()).
    const exportBtn = el('button', { type: 'button', class: 'btn', text: 'Export vault' });
    exportBtn.onclick = () => exportVault();
    const pick = el('input', { type: 'file', accept: '.tar,application/x-tar', hidden: true });
    pick.onchange = () => { const f = pick.files[0]; pick.value = ''; if (f) restoreVault(f); };
    const restoreBtn = el('button', { type: 'button', class: 'btn', text: 'Restore vault…' });
    restoreBtn.onclick = async () => {
      const d = cfg.desk();
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

    // automated: desktop only. In a browser there is no scheduler and nowhere on
    // the machine to write to, so say that rather than showing dead controls.
    const d = cfg.desk();
    if (!d) {
      root.append(el('p', { class: 'muted', text: 'Automatic scheduled backups run in the lattice desktop app. Open lattice on your computer to set them up.' }));
      return;
    }
    const invoke = window.__TAURI__.core.invoke;
    root.append(el('h3', { text: 'Automatic backups' }));
    root.append(el('p', { class: 'muted', text: 'Whole-store archives written to this machine on a schedule — the same tar as export above. They run while lattice is open; one that came due while it was closed runs shortly after you next open it.' }));
    const listEl = el('ul', { class: 'bklist' });
    const bkStatus = el('span', { class: 'err' });
    let backups = [];
    const save = async () => { await invoke('set_backup_schedules', { schedules: backups }); await refresh(); };
    async function refresh() {
      try { backups = await invoke('backup_schedules'); } catch (e) { backups = []; }
      listEl.innerHTML = '';
      for (const s of backups) {
        const keep = s.keep ? 'keeping ' + s.keep : 'keeping every one';
        const head = el('div', { text: s.label + ' — ' + period(s.every_hours) + ', ' + keep + (s.enabled ? '' : ' (paused)') });
        const sub = el('div', { class: 'muted', text: s.dir + ' · ' + ago(s.last_run) });
        const now = el('button', { type: 'button', class: 'btn', text: 'back up now' });
        now.onclick = async () => { bkStatus.textContent = ''; try { await invoke('run_backup_now', { id: s.id }); bkStatus.textContent = 'building…'; } catch (e) { bkStatus.textContent = String(e); } };
        const pause = el('button', { type: 'button', class: 'btn', text: s.enabled ? 'pause' : 'resume' });
        pause.onclick = async () => { s.enabled = !s.enabled; await save(); };
        const ver = el('button', { type: 'button', class: 'btn', text: 'verify latest' });
        ver.onclick = async () => {
          sub.textContent = 'reading the newest archive…'; sub.className = 'muted';
          try {
            const r = await invoke('verify_backup', { id: s.id });
            const bits = [r.pages + ' page(s)'];
            bits.push(r.has_share ? 'share modes' : 'NO share.json');
            bits.push(r.has_know ? 'memories' : 'NO know.json');
            sub.textContent = (r.problems.length ? '✗ ' : '✓ ') + bits.join(', ') + ' · ' + Math.round(r.bytes / 1024) + ' KB' + (r.problems.length ? ' — ' + r.problems.join('; ') : ' — reads clean');
            sub.className = r.problems.length ? 'err' : 'muted';
          } catch (e) { sub.textContent = String(e); sub.className = 'err'; }
        };
        const del = el('button', { type: 'button', class: 'btn', text: 'remove', title: 'stops the schedule — the archives already written stay' });
        del.onclick = async () => { backups = backups.filter((x) => x.id !== s.id); await save(); };
        listEl.append(el('li', null, [head, sub, el('div', { class: 'bkrow' }, [now, ver, pause, del])]));
      }
      if (!backups.length) listEl.append(el('li', { class: 'muted', text: 'no scheduled backups yet' }));
    }
    const inLabel = el('input', { placeholder: 'name (e.g. daily)' });
    const inEvery = el('select', null, [
      el('option', { value: '24', text: 'every day' }), el('option', { value: '168', text: 'every week' }),
      el('option', { value: '720', text: 'every 30 days' }), el('option', { value: '1', text: 'every hour' })]);
    const inKeep = el('input', { type: 'number', min: '0', max: '999', value: '7', title: 'how many to keep — 0 keeps every one' });
    inKeep.style.width = '5rem';
    const inDir = el('input', { placeholder: 'folder on this machine' });
    const pickDir = el('button', { type: 'button', class: 'btn', text: 'choose…' });
    pickDir.onclick = async () => { try { const dir = await invoke('pick_backup_dir'); if (dir) inDir.value = dir; } catch (e) { bkStatus.textContent = String(e); } };
    const addBtn = el('button', { type: 'button', class: 'btn', text: 'add schedule' });
    addBtn.onclick = async () => {
      bkStatus.textContent = '';
      const label = inLabel.value.trim(), dir = inDir.value.trim();
      if (!label || !dir) { bkStatus.textContent = 'a name and a folder are both needed'; return; }
      if (backups.some((b) => b.label.toLowerCase() === label.toLowerCase())) { bkStatus.textContent = 'there is already a schedule called ' + label; return; }
      backups.push({ id: bkId(), label, every_hours: Number(inEvery.value), keep: Math.max(0, Number(inKeep.value) || 0), dir, last_run: 0, enabled: true });
      await save();
      inLabel.value = '';
    };
    root.append(listEl,
      el('div', { class: 'bkrow' }, [inLabel, inEvery, inKeep]),
      el('div', { class: 'bkrow' }, [inDir, pickDir]),
      el('div', { class: 'bkrow' }, [addBtn, bkStatus]));
    refresh();
  }

  window.LatticeVault = { configure, exportVault, restoreVault, mountSettings,
    tarBlob, untar, b64ToBytes, blobToB64, isDesktop: () => !!cfg.desk() };
})();
