/* BUILT FILE — do not edit. Source: ui-src/lattice/, build: scripts/build-ui.mjs */
(function () {
'use strict';
// the served writer.js's hash (build-ui.mjs, 26-writer.js)
const WRITER_H = '0v6.0532q.i6tsc.i97k0.o86tj.b5kh3';
// and pdf.js's (78-pdf.js)
const PDF_H = '0v4.0lj6i.p1nsf.a908q.16141.ep8rn';
// and skills.js's (95s-skills.js)
const SKILLS_H = '0vp8i1n.clpkn.kdlr1.tsp81.ofl5e';

// ── src/00-framed.js ──────────────────────────────────────────────────────
  if (window.top !== window) {
    let sent = false;
    let fe = null;
    try { fe = window.frameElement; } catch {}
    if (fe && fe.dataset.latEd === location.href) sent = true;
    else {
      try { sent = !!(window.top.latFrameEditor && window.top.latFrameEditor(location.href, window)); } catch {}
      if (sent && fe) fe.dataset.latEd = location.href;
    }
    const p = document.createElement('p');
    p.style.cssText = 'font:15px system-ui,sans-serif;margin:2rem;color:var(--text,inherit)';
    p.textContent = sent ? 'Opened in the editor. ' : 'The editor runs in a window of its own. ';
    const a = document.createElement('a');
    if (sent) {
      a.href = '#';
      a.textContent = 'Back';
      a.onclick = (e) => { e.preventDefault(); history.back(); };
    } else {
      a.href = location.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Open the editor';
    }
    p.append(a);
    document.title = 'Lattice';
    document.body.replaceChildren(p);
    return;
  }

// ── src/05-prefs.js ───────────────────────────────────────────────────────
  const FONTS = {
    mono: 'ui-monospace, Menlo, Consolas, monospace',
    system: 'system-ui, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    humanist: '"Iosevka", "JetBrains Mono", "Fira Code", ui-monospace, monospace',
  };
  function applyPrefs() {
    const r = document.documentElement.style;
    let f = null, s = null;
    try { f = localStorage.latFont; s = localStorage.latFontSize; } catch {}
    if (f && FONTS[f]) r.setProperty('--ed-font', FONTS[f]);
    else r.removeProperty('--ed-font');
    const n = parseInt(s, 10);
    if (n >= 9 && n <= 32) r.setProperty('--ed-size', n + 'px');
    else r.removeProperty('--ed-size');
  }
  applyPrefs();
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === 'latFont' || e.key === 'latFontSize') applyPrefs();
  });

// ── src/08-offline.js ─────────────────────────────────────────────────────
  let degraded = false;      // a save failed like the ship was unreachable
  let offCount = 0;          // queued page edits, drives the status text
  let offbadge = null;       // assigned by <lat-statusbar> (13-frame.js)
  let jobWait = false;
  const JOB_NOTE = 'a folder job is running, your save will land when it finishes';
  const NOT_SAVED = 'NOT SAVED — this device cannot store offline edits. Copy your text '
    + 'somewhere safe before closing this page.';
  const renderOffline = () => {
    if (!offbadge) return;
    const q = offCount ? offCount + ' queued' : '';
    if (!degraded && !offCount) { offbadge.hidden = true; return; }
    offbadge.hidden = false;
    offbadge.textContent = degraded ? (q ? 'offline \u00b7 ' + q : 'offline')
      : jobWait ? (q ? 'folder job \u00b7 ' + q : 'folder job') : q;
    offbadge.title = degraded
      ? 'the ship is not answering. Edits are saved on this device and sent when it returns.'
      : jobWait ? JOB_NOTE : 'edits saved on this device, syncing now.';
    offbadge.classList.toggle('syncing', !degraded);
  };
  let offDb = null;
  const offOpen = () => new Promise((res) => {
    if (offDb) return res(offDb);
    let rq = null;
    try { rq = indexedDB.open('lattice-offline', 3); } catch { return res(null); }
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains('saves'))
        d.createObjectStore('saves', { keyPath: 'name' });
      if (!d.objectStoreNames.contains('ops'))
        d.createObjectStore('ops', { autoIncrement: true });
      if (!d.objectStoreNames.contains('kv'))
        d.createObjectStore('kv', { keyPath: 'k' });
    };
    rq.onsuccess = () => { offDb = rq.result; res(offDb); };
    rq.onerror = () => res(null);   // no idb: the queue is off, saves fail loudly as before
  });
  const offReq = (rq) => new Promise((res) => {
    if (!rq) return res(null);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => res(null);
  });
  const idbStore = async (name, mode) => {
    const d = await offOpen();
    try { return d && d.transaction(name, mode).objectStore(name); } catch { return null; }
  };
  const idbGet = async (name) => {
    const s = await idbStore('saves', 'readonly'); return s ? offReq(s.get(name)) : null;
  };
  const idbAll = async () => {
    const s = await idbStore('saves', 'readonly'); return (s && await offReq(s.getAll())) || [];
  };
  const idbCount = async (name) => {
    const s = await idbStore(name, 'readonly'); return (s && await offReq(s.count())) || 0;
  };
  const idbOpAll = async () => {
    const s = await idbStore('ops', 'readonly');
    if (!s) return [];
    const vp = offReq(s.getAll());
    const kp = offReq(s.getAllKeys());
    const vals = (await vp) || [];
    const keys = (await kp) || [];
    return vals.map((v, i) => ({ ...v, _k: keys[i] }));
  };
  const idbOpPut = async (rec) => {
    const s = await idbStore('ops', 'readwrite'); if (s) await offReq(s.add(rec));
    await offRecount();
  };
  const idbOpDel = async (k) => {
    const s = await idbStore('ops', 'readwrite'); if (s) await offReq(s.delete(k));
    await offRecount();
  };
  const qrust = () => (window.__TAURI__ && window.__TAURI__.core) || null;
  const qcall = async (cmd, args) => {
    const d = qrust();
    if (!d) return null;
    return d.invoke(cmd, args || {});
  };

  const offGet = async (name) => {
    if (!qrust()) return idbGet(name);
    try { return (await qcall('queue_get', { name })) || null; } catch { return null; }
  };
  const offAll = async () => {
    if (!qrust()) return idbAll();
    try { return (await qcall('queue_list')) || []; } catch { return []; }
  };
  const offPut = async (rec) => {
    let ok = false;
    if (!qrust()) ok = await idbPut(rec);
    else { try { await qcall('queue_put', { rec }); ok = true; } catch { ok = false; } }
    await offRecount();
    return ok;
  };
  const offDel = async (name) => {
    if (!qrust()) await idbDel(name);
    else { try { await qcall('queue_del', { name }); } catch {} }
    bustPages(name);
    await offRecount();
  };
  const sameRec = (a, b) => a.queuedAt === b.queuedAt && a.body === b.body;
  let offKept = false;
  const offDone = async (q) => {
    if (!qrust()) await idbDelSent(q);
    else {
      try { await qcall('queue_del', { name: q.name, sent: { queuedAt: q.queuedAt, body: q.body } }); }
      catch {}
    }
    let v = null;
    try { v = await offGet(q.name); } catch {}
    const kept = !!v && !sameRec(v, q);
    if (kept && v.isNew) await offPut({ ...v, isNew: false, baseRev: 0 });
    if (kept) offKept = true;
    bustPages(q.name);
    await offRecount();
  };
  const opAll = async () => {
    if (!qrust()) return idbOpAll();
    try { return (await qcall('queue_ops')) || []; } catch { return []; }
  };
  const opPut = async (rec) => {
    if (!qrust()) return idbOpPut(rec);
    try { await qcall('queue_op_put', { rec }); } catch {}
    await offRecount();
  };
  const opDel = async (k) => {
    if (!qrust()) return idbOpDel(k);
    try { await qcall('queue_op_del', { seq: k }); } catch {}
    await offRecount();
  };

  async function adoptIdbQueue() {
    if (!qrust()) return;
    let mine = [];
    try { mine = await idbAll(); } catch { mine = []; }
    for (const rec of mine) {
      try { await qcall('queue_put', { rec }); await idbDel(rec.name); } catch {}
    }
    let ops = [];
    try { ops = await idbOpAll(); } catch { ops = []; }
    for (const o of ops) {
      const rec = { ...o };
      delete rec._k;
      try { await qcall('queue_op_put', { rec }); await idbOpDel(o._k); } catch {}
    }
    const n = mine.length + ops.length;
    if (n) st('recovered ' + n + ' offline change(s) from this device');
    await offRecount();
  }

  const offRecount = async () => {
    offCount = qrust()
      ? (await offAll()).length + (await opAll()).length
      : (await idbCount('saves')) + (await idbCount('ops'));
    renderOffline();
  };
  const offOk = (rq) => new Promise((res) => {
    if (!rq) return res(false);
    rq.onsuccess = () => res(true);
    rq.onerror = () => res(false);
  });
  const idbPut = async (rec) => {
    const s = await idbStore('saves', 'readwrite');
    let ok = false;
    if (s) { try { ok = await offOk(s.put(rec)); } catch { ok = false; } }
    return ok;
  };
  const idbDel = async (name) => {
    const s = await idbStore('saves', 'readwrite'); if (s) await offReq(s.delete(name));
  };
  const idbDelSent = async (q) => {
    const s = await idbStore('saves', 'readwrite');
    if (!s) return;
    return new Promise((res) => {
      const g = s.get(q.name);
      g.onsuccess = () => {
        const v = g.result;
        if (!v || !sameRec(v, q)) return res();
        const d = s.delete(q.name);
        d.onsuccess = d.onerror = () => res();
      };
      g.onerror = () => res();
    });
  };
  offRecount();
  const kvGet = async (k) => {
    const st = await idbStore('kv', 'readonly');
    const r = st && await offReq(st.get(k));
    return r ? r.v : null;
  };
  const kvPut = async (k, v) => {
    const st = await idbStore('kv', 'readwrite');
    if (st) await offReq(st.put({ k, v }));
  };

  const tfetch = (url, opts = {}, ms = 30000) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
  };
  const shipGone = (r) => !r || r.status === 502 || r.status === 504;
  const REPLAY_DROP = [400, 404, 409, 410, 413, 422];
  const replayDrop = (r) => !!r && REPLAY_DROP.includes(r.status);

  const treeJob = async () => {
    try {
      const r = await tfetch(api + '/tree-job', {}, 5000);
      if (r && r.ok) return (await r.json()).job || null;
    } catch {}
    return null;
  };
  let jobTimer = null;
  function waitJob() {
    jobWait = true;
    renderOffline();
    if (jobTimer) return;
    jobTimer = setInterval(async () => {
      if (await treeJob()) return;
      clearInterval(jobTimer); jobTimer = null;
      jobWait = false;
      renderOffline();
      replayQueue(true);
    }, 5000);
  }
  function saveStalled() {
    if (jobWait) return true;
    const was = degraded;
    setDegraded(true);
    if (!was) {
      treeJob().then((job) => {
        if (!job || !degraded) return;
        setDegraded(false);
        waitJob();
        st(JOB_NOTE);
        if (cerr && cerr.textContent === 'saved offline') cerr.textContent = 'saves after the folder job';
      });
    }
    return false;
  }
  setTimeout(async () => {
    let d = null;
    try {
      const r = await tfetch(api + '/tree-job', {}, 10000);
      if (r && r.ok) d = (await r.json()).dropped;
    } catch {}
    if (!d || !d.at) return;
    try {
      if (localStorage.latJobDropped === String(d.at)) return;
      localStorage.latJobDropped = String(d.at);
    } catch {}
    st('a folder ' + d.job + ' of ' + (d.path || 'your pages') + ' stopped part way and was '
      + 'dropped: some of its pages may still be published. Run it again.', false);
  }, 15000);
  async function dropQueued(name, at) {
    let q = null;
    try { q = await offGet(name); } catch {}
    if (q && !q.isNew && q.queuedAt <= at) await offDel(name);
  }

  let probeTimer = null;
  function setDegraded(on) {
    if (degraded === on) return;
    degraded = on;
    renderOffline();
    if (on) st('ship unreachable — edits are queued locally', false);
    if (on && !probeTimer) {
      probeTimer = setInterval(async () => {
        let r = null;
        try { r = await tfetch(api + '/legacy-status', {}, 5000); } catch {}
        if (r && r.ok) {
          clearInterval(probeTimer); probeTimer = null;
          degraded = false;
          renderOffline();   // ship is back; the badge now reports the drain
          replayQueue();
        }
      }, 20000);
    }
    if (!on && probeTimer) { clearInterval(probeTimer); probeTimer = null; }
  }

  async function enqueueSave(name, kind, body, isNew, rn, rev = curRev) {
    let prev = null;
    try { prev = await offGet(name); } catch {}
    const queued = await offPut({ name, kind, body, baseRev: jobWait || replaying ? 0 : rev || 0,
      isNew: !!isNew || !!(prev && prev.isNew), queuedAt: Date.now(),
      dname: (rn && rn.dname) || (prev && prev.dname) || '',
      dnames: (rn && rn.dnames) || (prev && prev.dnames) || '' });
    const job = saveStalled();
    if (!queued) {
      st(NOT_SAVED, false);
      return false;
    }
    pageCache.delete(name);
    const nd = nodes.find((n) => n.page && n.path === name);
    if (nd) { nd.body = body; nd.kind = kind; persistTree(); }
    snapPage(name, { body, kind, rev: rev || 0 });
    st(job ? JOB_NOTE : 'saved offline — ' + offCount + ' waiting to sync');
    return job ? 'job' : true;
  }
  const under = (name, p) => name === p || name.startsWith(p + '/');
  async function enqueueOp(rec) {
    if (rec.op !== 'mkdir') {
      for (const q of await offAll()) {
        if (q.kind === 'know') continue;
        if (rec.op === 'del' && under(q.name, rec.name)) await offDel(q.name);
        if (rec.op === 'move' && under(q.name, rec.from)) {
          await offDel(q.name);
          await offPut({ ...q, name: rec.to + q.name.slice(rec.from.length), baseRev: 0 });
        }
      }
      for (const k of [...pageCache.keys()])
        if (under(k, rec.op === 'del' ? rec.name : rec.from)) pageCache.delete(k);
      try {
        const p = JSON.parse(localStorage.appPage || 'null');
        if (p && p.name && under(p.name, rec.op === 'del' ? rec.name : rec.from))
          localStorage.removeItem('appPage');
      } catch {}
    }
    await opPut({ ...rec, queuedAt: Date.now() });
    setDegraded(true);
    st(({ del: 'deleted', mkdir: 'folder created' }[rec.op] || 'moved')
      + ' offline — ' + offCount + ' waiting to sync');
  }

  async function enqueueKnow(key, body) {
    const queued = await offPut({ name: 'know:' + key, kind: 'know', body, queuedAt: Date.now() });
    const job = saveStalled();
    if (!queued) {
      st(NOT_SAVED, false);
      return false;
    }
    knowGen++;
    const k = knowEntry(key);
    if (k) k.bytes = body.length;
    else knowKeys.push({ key, tags: [], updated: '', bytes: body.length });
    renderKnowChips();
    renderKnowTree();
    st(job ? JOB_NOTE : 'saved offline — ' + offCount + ' waiting to sync');
    return job ? 'job' : true;
  }

  let replaying = false;
  async function replayQueue(proven) {
    if (replaying || jobWait) return;
    replaying = true;
    srcFlight.clear();    // replayed writes: no open read from before is shared
    sensForget();         // and a replayed move or delete culls flags
    offKept = false;
    try { await drainQueue(proven); } finally { replaying = false; }
    if (offKept && !degraded) setTimeout(() => replayQueue(true), 0);
  }


  async function drainOps(ops) {
    for (const o of ops) {
      if (o.op !== 'del' && o.op !== 'move' && o.op !== 'mkdir') { await opDel(o._k); continue; }
      const u = o.op === 'del'
        ? api + '/page-del?name=' + encodeURIComponent(o.name)
        : o.op === 'mkdir'
          ? api + '/folder-new?name=' + encodeURIComponent(o.name)
          : api + '/page-move?from=' + encodeURIComponent(o.from) +
            '&to=' + encodeURIComponent(o.to);
      let r = null;
      try { r = await tfetch(u, { method: 'POST' }, 30000); } catch {}
      if (!(r && r.ok) && !replayDrop(r)) return false;
      if (!(r && r.ok)) {
        st('offline ' + o.op + ' no longer applies: ' +
          (o.name || o.from) + ' (skipped)', false);
      } else {
        bustPages(o.name || o.from);
        if (o.to) bustPages(o.to);
      }
      await opDel(o._k);
    }
    return true;
  }

  async function drainCreates(creates, conflicts) {
    for (const q of creates) {
      let one = null;
      try {
        one = await tfetch(api + '/page-save?name=' + encodeURIComponent(q.name) +
          '&type=' + q.kind + '&new=1' + dnameQ(q),
          { method: 'POST', body: q.body || '\n' }, 20000);
      } catch {}
      if (one && one.ok) { await offDone(q); continue; }
      if (!replayDrop(one)) return false;
      if (one && one.status === 409) {
        try {
          const sr = await tfetch(api + '/page-source?name=' +
            encodeURIComponent(q.name), {}, 20000);
          if (sr && sr.ok && ((await sr.json()).body || '') === (q.body || '\n')) {
            await offDone(q);
            continue;
          }
        } catch {}
        const alt = 'conflicts/offline-create-' + q.name.replace(/\//g, '-');
        if (!await keepAside(q, alt)) return false;
        conflicts.push(alt);
        await offDone(q);
        st('offline create collided: ' + q.name + ' exists on the ship — your ' +
          'version is kept at ' + alt, false);
        continue;
      }
      st('dropped an unsyncable offline create: ' + q.name, false);
      await offDone(q);
    }
    return true;
  }

  const keepAside = async (q, alt) => {
    try {
      const r = await tfetch(api + '/page-save?name=' + encodeURIComponent(alt) +
        '&type=' + q.kind, { method: 'POST', body: q.body || '\n' }, 20000);
      return !!(r && r.ok);
    } catch { return false; }
  };
  async function drainEdits(edits, conflicts) {
    for (let i = 0; i < edits.length; i += 50) {
      const part = edits.slice(i, i + 50);
      let r = null;
      try {
        r = await tfetch(api + '/page-save-batch?report=1', {
          method: 'POST',
          body: JSON.stringify(part.map((q) =>
            ({ name: q.name, type: q.kind, body: q.body || '\n', base: q.baseRev || 0 }))),
        }, 120000);
      } catch {}
      if (r && r.ok) {
        try {
          for (const it of ((await r.json()).items || []))
            if (it.conflicted) conflicts.push(it.kept || it.name);
        } catch {}
        for (const q of part) await offDone(q);
        continue;
      }
      if (r && !shipGone(r) && (r.status >= 500 || replayDrop(r))) {
        for (const q of part) {
          let one = null;
          try {
            one = await tfetch(api + '/page-save?name=' + encodeURIComponent(q.name) +
              '&type=' + q.kind + '&base=' + (q.baseRev || 0),
              { method: 'POST', body: q.body || '\n' }, 20000);
          } catch {}
          if (one && one.ok) {
            try {
              const j = await one.json();
              if (j.conflicted) conflicts.push(j.kept || q.name);
            } catch {}
            await offDone(q);
            continue;
          }
          if (!replayDrop(one)) return false;
          if (one && one.status === 409) {
            const alt = 'conflicts/offline-edit-' + q.name.replace(/\//g, '-');
            if (!await keepAside(q, alt)) return false;
            conflicts.push(alt);
            await offDone(q);
            st('offline edit refused: ' + q.name + ', your version is kept at ' + alt, false);
            continue;
          }
          st('dropped an unsyncable offline edit: ' + q.name, false);
          await offDone(q);
        }
        continue;
      }
      return false;
    }
    return true;
  }

  async function drainKnows(knows) {
    for (const q of knows) {
      let one = null;
      try {
        one = await tfetch(api + '/know-save?key=' + encodeURIComponent(q.name.slice(5)),
          { method: 'POST', body: q.body || '\n' }, 20000);
      } catch {}
      if (one && one.ok) { await offDone(q); continue; }
      if (!replayDrop(one)) return false;
      st('dropped an unsyncable offline edit: ' + q.name, false);
      await offDone(q);
    }
    return true;
  }

  async function drainQueue(proven) {
    const whole = await offAll();
    const ops = await opAll();
    if (!whole.length && !ops.length) return;
    if (proven && degraded) { degraded = false; renderOffline(); }
    const all = whole.filter((q) => q.kind !== 'know');
    const knows = whole.filter((q) => q.kind === 'know');
    const total = whole.length + ops.length;
    stWork('syncing ' + total + ' offline edit' + (total === 1 ? '' : 's') + '…');
    const conflicts = [];
    const landed = await drainOps(ops)
      && await drainCreates(all.filter((q) => q.isNew), conflicts)
      && await drainEdits(all.filter((q) => !q.isNew), conflicts)
      && await drainKnows(knows);
    if (!landed) {
      setDegraded(true);
      st(offCount + ' offline edit' + (offCount === 1 ? '' : 's') + ' still waiting', false);
      return;
    }
    setDegraded(false);
    if (conflicts.length) {
      st('synced — ' + conflicts.length + ' conflict(s): your offline version won; '
        + 'the other is saved at ' + conflicts.join(', '), false);
    } else st('offline edits synced');
    if (knows.length && knowLive()) loadKnow();
    loadTree();
  }

// ── src/10-shell.js ───────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const api = '/apps/lattice';
  const ICON = {
    folder: ['0 0 16 16', 'M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z'],
    open: ['0 0 16 16', 'M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1H13a1 1 0 0 1 1 1v.5H2.75a.75.75 0 0 0 0 1.5h11.978a1 1 0 0 1 .994 1.117L15 13.25A1.75 1.75 0 0 1 13.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.91.513-1.237Z'],
    search: ['0 0 16 16', 'M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z'],
    comment: ['0 0 16 16', 'M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z'],
    pl: ['0 0 24 24', 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 4v16', 'stroke'],
    pr: ['0 0 24 24', 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM15 4v16', 'stroke'],
    cal: ['0 0 24 24', 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 3v4M16 3v4M3 10h18', 'stroke'],
    globe: ['0 0 24 24', 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18', 'stroke'],
    forum: ['0 0 24 24', 'M3 4h12v8H8l-3 3v-3H3zM18 9h3v8h-2v3l-3-3h-6v-2', 'stroke'],
    inbox: ['0 0 24 24', 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5', 'stroke'],
    key: ['0 0 24 24', 'M4 15a4 4 0 1 0 8 0a4 4 0 1 0-8 0M11 12l9-9M16 7l3 3M14 9l2 2', 'stroke'],
    tree: ['0 0 24 24', 'M4 5h6M4 5v14M4 12h5M4 19h5M12 12h8M12 19h8', 'stroke'],
    conflict: ['0 0 24 24', 'M12 3l10 18H2zM12 10v5M12 18h.01', 'stroke'],
    term: ['0 0 24 24', 'M4 17l6-5-6-5M12 19h8', 'stroke'],
    gear: ['0 0 24 24', 'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1', 'stroke'],
    pen: ['0 0 24 24', 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', 'stroke'],
    fplus: ['0 0 24 24', 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6', 'stroke'],
    tpl: ['0 0 24 24', 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM3 9h18M9 9v12', 'stroke'],
    upload: ['0 0 24 24', 'M12 16V4M7 9l5-5 5 5M4 20h16', 'stroke'],
    updir: ['0 0 24 24', 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 16v-6M9 13l3-3 3 3', 'stroke'],
    trash: ['0 0 24 24', 'M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3', 'stroke'],
    tidy: ['0 0 24 24', 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z', 'stroke'],
    sort: ['0 0 24 24', 'M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4', 'stroke'],
    fold: ['0 0 24 24', 'M7 15l5 5 5-5M7 9l5-5 5 5', 'stroke'],
    out: ['0 0 24 24', 'M7 17L17 7M8 7h9v9', 'stroke'],
    back: ['0 0 24 24', 'M17 7L7 17M16 17H7V8', 'stroke'],
    list: ['0 0 24 24', 'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01', 'stroke'],
    hist: ['0 0 24 24', 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3', 'stroke'],
    eye: ['0 0 24 24', 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0', 'stroke'],
    x: ['0 0 24 24', 'M6 6l12 12M18 6L6 18', 'stroke'],
    left: ['0 0 24 24', 'M15 6l-6 6 6 6', 'stroke'],
    right: ['0 0 24 24', 'M9 6l6 6-6 6', 'stroke'],
    dots: ['0 0 24 24', 'M12 5h.01M12 12h.01M12 19h.01', 'stroke'],
    more: ['0 0 24 24', 'M5 12h.01M12 12h.01M19 12h.01', 'stroke'],
    menu: ['0 0 24 24', 'M4 6h16M4 12h16M4 18h16', 'stroke'],
    plus: ['0 0 24 24', 'M12 5v14M5 12h14', 'stroke'],
    save: ['0 0 24 24', 'M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 3v5h7V3M7 21v-7h10v7', 'stroke'],
    pin: ['0 0 24 24', 'M9 3h6l-1 6 3 4H7l3-4zM12 13v8', 'stroke'],
    tabs: ['0 0 24 24', 'M8 8h12v12H8zM4 16V4h12', 'stroke'],
    splitr: ['0 0 24 24', 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM12 4v16', 'stroke'],
    splitd: ['0 0 24 24', 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 12h18', 'stroke'],
    copy: ['0 0 24 24', 'M9 9h11v11H9zM5 15H4V4h11v1', 'stroke'],
    mark: ['0 0 24 24', 'M6 3h12v18l-6-4-6 4z', 'stroke'],
    know: ['0 0 24 24', 'M12 3l8 9-8 9-8-9z', 'stroke'],
    skill: ['0 0 24 24', 'M13 3L5 13h6l-1 8 8-10h-6z', 'stroke'],
    doc: ['0 0 24 24', 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5', 'stroke'],
    link: ['0 0 24 24', 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5', 'stroke'],
    md: ['4 4 24 24', 'M20.7 6.7v9.9h3.8c-2.9 3-5.8 5.9-8.7 8.8-2.7-2.8-5.6-5.8-8.4-8.7h3.5V6.6c1.3.9 4.4 3.1 5 3.1.6 0 3.6-2.2 4.8-3z'],
    tex: ['4 4 24 24', 'M7.9 17.5H6.5v1.3h4.4v-1.3H9.6V11h.4c1.2 0 1.4.1 1.6 1h1.2l-.2-2.3H4.8l-.3 3.6h1.2v-.5c.2-1.7.3-1.8 1.8-1.8h.4v6.5zM15.8 21.1h-1.7v-2.8h.6c.7 0 .7 0 .7.9v.5h1.2v-4.1h-1.2v.5c0 .9 0 .9-.7.9h-.6v-2.4h1.6c1.5 0 1.6.4 1.7 1.8h1.2l-.3-3.2h-7v1.3h1v6.4h-1v1.3h7.1l.4-2.6h-1.3c0 1.1-.4 1.5-1.7 1.5zM21.7 17.6h-.5l1.5-2.2 1.5 2.2h-.3v1.1h3.6v-1.2H27c-.6 0-.6 0-.7-.2l-2.4-3.5 1.6-2.3c.2-.2.4-.6 1.1-.6h.5V9.6H24v1.2h.5l-.1.1-1.2 1.7-1.3-1.6h.3V9.6h-3.6V11h.5c.6 0 .6 0 .7.2l2.1 3.1-1.8 2.7-.3.3c-.2.2-.5.3-.8.3h-.5v1.2h3.2v-1.2z'],
    html: ['4 4 24 24', 'M8 15l6-5.6V12l-4.5 4 4.5 4v2.6L8 17v-2zm16 2.1l-6 5.6V20l4.6-4-4.6-4V9.3l6 5.6v2.2z'],
    css: ['4 4 24 24', 'M10.3 23.3l.8-4H8.6v-2.1h3l.5-2.5H9.5v-2.1h3.1l.8-3.9h2.8l-.8 3.9h2.8l.8-3.9h2.8l-.8 3.9h2.5v2.1h-2.9l-.6 2.5h2.6v2.1h-3l-.8 4H16l.8-4H14l-.8 4h-2.9zm6.9-6.1l.5-2.5h-2.8l-.5 2.5h2.8z'],
    js: ['4 4 24 24', 'M11.4 10h2.7v7.6c0 3.4-1.6 4.6-4.3 4.6-.6 0-1.5-.1-2-.3l.3-2.2c.4.2.9.3 1.4.3 1.1 0 1.9-.5 1.9-2.4V10zm5.1 9.2c.7.4 1.9.8 3 .8 1.3 0 1.9-.5 1.9-1.3s-.6-1.2-2-1.7c-2-.7-3.3-1.8-3.3-3.6 0-2.1 1.7-3.6 4.6-3.6 1.4 0 2.4.3 3.1.6l-.6 2.2c-.5-.2-1.3-.6-2.5-.6s-1.8.5-1.8 1.2c0 .8.7 1.1 2.2 1.7 2.1.8 3.1 1.9 3.1 3.6 0 2-1.6 3.7-4.9 3.7-1.4 0-2.7-.4-3.4-.7l.6-2.3z'],
    file: ['250 150 700 700', 'M394.1 537.8h411.7v54.7H394.1v-54.7zm0-130.3H624v54.7H394.1v-54.7zm0-130.3h411.7v54.7H394.1v-54.7zm0 390.9H700v54.7H394.1v-54.7z'],
  };
  const ico = (name) => {
    const k = ICON[name] ? name : 'file';
    if (ICON[k][2] === 'stroke')
      return `<svg class="ic ic-${k}" viewBox="${ICON[k][0]}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON[k][1]}"/></svg>`;
    return `<svg class="ic ic-${k}" viewBox="${ICON[k][0]}" fill="currentColor" aria-hidden="true"><path d="${ICON[k][1]}"/></svg>`;
  };
  let lastAction = Date.now();
  const bgBusy = () => { lastAction = Date.now(); };
  for (const t of ['pointerdown', 'keydown', 'input', 'click']) addEventListener(t, bgBusy, true);
  const BG_IDLE_MS = 4000;
  const BG_HOLD_MS = 15000;
  const saveDue = () => saving || (dirty && autosaveOn());
  let bgChain = Promise.resolve();
  const bgFetch = (url, opts) => {
    const run = async () => {
      const t0 = Date.now();
      for (;;) {
        let wait = BG_IDLE_MS - (Date.now() - lastAction);
        if (wait <= 0 && saveDue() && Date.now() - t0 < BG_HOLD_MS) wait = 250;
        if (wait <= 0) break;
        await new Promise((r) => setTimeout(r, Math.max(wait, 250)));
      }
      return fetch(url, opts);
    };
    const p = bgChain.then(run);
    bgChain = p.catch(() => {});
    return p;
  };
  const bustPages = (name) => {
    if (!('caches' in window)) return;
    name = String(name || '').replace(/^\/+/, '') || null;
    caches.open('lattice-pages').then(async (c) => {
      const home = location.origin + '/apps/lattice';
      for (const k of await c.keys()) {
        let d = k.url;
        try { d = decodeURIComponent(k.url); } catch {}
        if (k.url === home || (name && d.indexOf('/' + name) >= 0)) c.delete(k.url);
      }
    }).catch(() => {});
  };
  const validName = (n) => String(n || '').split('/').every(
    (s) => s.length && s !== '.' && s !== '..' && /^[a-z0-9._~-]+$/.test(s));
  const slugSeg = (s) => s.toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const realName = (typed) => {
    const t = String(typed || '').trim().replace(/^\/+|\/+$/g, '');
    if (!t) return null;
    if (validName(t)) return { name: t, dname: '', dnames: '' };
    const segs = t.split('/').map((s) => s.trim());
    const slugs = segs.map(slugSeg);
    const name = slugs.join('/');
    if (!validName(name)) return null;
    const per = segs.map((s, i) => (s === slugs[i] ? '' : s));
    return { name, dname: per[per.length - 1], dnames: per.some(Boolean) ? per.join('/') : '' };
  };
  const dnameQ = (rn) => (!rn ? '' :
    (rn.dname ? '&dname=' + encodeURIComponent(rn.dname) : '') +
    (rn.dnames ? '&dnames=' + encodeURIComponent(rn.dnames) : ''));
  const errText = async (r) => {
    let msg = r ? ' ' + r.status : '';
    if (r) { try { const j = await r.json(); if (j && j.error) msg = ': ' + j.error; } catch {} }
    return msg;
  };
  const sessionGone = async (r) => {
    if (!r || (r.status !== 401 && r.status !== 403)) return false;
    if (r.status === 403) {
      let e = '';
      try { e = (await r.clone().json()).error; } catch {}
      if (e !== 'forbidden') return false;
    }
    try { localStorage.removeItem('appPage'); } catch {}
    try { await kvPut('tree', []); } catch {}
    try { if ('caches' in window) await caches.delete('lattice-pages'); } catch {}
    try { indexedDB.deleteDatabase('lattice-lru'); } catch {}
    nodes = []; pageCache.clear(); renderTree();
    st('the session has ended: log in to the ship again', false);
    return true;
  };
  const bustAll = () => {
    if (!('caches' in window)) return;
    caches.open('lattice-pages').then(async (c) => {
      const hit = await c.match('/__pv');
      const pv = hit ? await hit.text() : null;
      await caches.delete('lattice-pages');
      if (pv !== null)
        await (await caches.open('lattice-pages')).put('/__pv', new Response(pv));
    }).catch(() => {});
  };
  let pname, pkind;                    // assigned by the tab header (23-tabhead.js)
  let status, spinner;                 // assigned by <lat-statusbar> (13-frame.js)
  let prev;                            // assigned by <lat-preview> (60-preview.js)
  const themeRoot = () => {
    const s = document.documentElement.style;
    if (!s.colorScheme && !s.getPropertyValue('--font')) return '';
    return 'html:root{' + s.cssText + '}'
      + (s.getPropertyValue('--link') ? 'a{color:var(--link)}' : '')
      + (s.getPropertyValue('--selection') ? '::selection{background:var(--selection)}' : '');
  };
  const prevWK = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium/.test(navigator.userAgent);
  const navBusy = (f) => {
    if (!prevWK || !f || !f.isConnected) return;
    if (!f.latNav) {
      f.latNav = { busy: false, again: false };
      f.addEventListener('load', () => {
        const n = f.latNav;
        n.busy = false;
        if (!n.again || !f.isConnected) return;
        n.again = false;
        n.busy = true;
        if (f.hasAttribute('srcdoc')) f.srcdoc = f.getAttribute('srcdoc');
        else if (f.hasAttribute('src')) f.src = f.getAttribute('src');
        else n.busy = false;
      });
    }
    if (f.latNav.busy) f.latNav.again = true;
    f.latNav.busy = true;
  };
  const navDoc = (f, html) => { f.srcdoc = html; navBusy(f); };
  const navUrl = (f, url) => { f.removeAttribute('srcdoc'); f.src = url; navBusy(f); };
  const prevBusy = () => navBusy(prev);
  const prevDoc = (html) => navDoc(prev, html);
  const prevUrl = (url) => navUrl(prev, url);
  const prevBlank = () => {
    prev.removeAttribute('src');
    prev.style.minHeight = '';
    prevDoc('<style>:root{color-scheme:light dark}' +
      'body{margin:0;background:var(--bg,#fafafa)}' +
      '@media(prefers-color-scheme:dark){body{background:var(--bg,#1a1a1a)}}' + themeRoot() + '</style>');
  };
  const shortPath = (p, all) => {
    const strip = (x) => x.replace(/^.*?\/lattice\.lattice_app\/(page\/)?/, '');
    const label = (x) => {
      const me = strip(x);
      if (!me) return x;
      const segs = me.split('/');
      let n = 1;
      const tail = () => segs.slice(-n).join('/');
      const clashes = () =>
        all.some((q) => q !== x && strip(q).split('/').slice(-n).join('/') === tail());
      while (n < segs.length && clashes()) n++;
      if (clashes()) return x.replace(/^.*?\/lattice\.lattice_app\//, '');
      return (n < segs.length ? '\u2026/' : '') + tail();
    };
    const me = label(p);
    const leaf = (x) => x.slice(x.lastIndexOf('/') + 1);
    const near = all.filter((q) => q !== p && leaf(q) === leaf(p));
    if (near.some((q) => label(q) === me)) return p;
    return me;
  };
  const st = (msg, ok = true) => {
    spinner.classList.remove('on');          // any plain status ends the spin
    status.textContent = msg;
    status.title = msg;                      // in full, when the bar cuts it short
    status.style.color = ok ? '' : '#c0392b';
  };
  const stWork = (msg) => { st(msg); spinner.classList.add('on'); };
  const BUSY_MS = 180;
  const BUSY_MAX = 60000;
  const busyKeys = new Map();          // key -> the end of its wait
  const busyOn = new Map();            // region -> waits running in it
  const busyHome = () => {
    const ws = $('ws');
    return ws.classList.contains('ldraw') ? $('lpane')
      : ws.classList.contains('rdraw') ? $('rpane') : $('center');
  };
  function busy(key, region) {
    const el = region || busyHome();
    if (key) busyEnd(key);
    let live = true;
    busyOn.set(el, (busyOn.get(el) || 0) + 1);
    const show = setTimeout(() => { if (live) el.classList.add('lbusy'); }, BUSY_MS);
    const end = () => {
      if (!live) return;
      live = false;
      clearTimeout(show); clearTimeout(cap);
      if (key && busyKeys.get(key) === end) busyKeys.delete(key);
      const left = busyOn.get(el) - 1;
      busyOn.set(el, left);
      if (!left) el.classList.remove('lbusy');
    };
    const cap = setTimeout(end, BUSY_MAX);
    if (key) busyKeys.set(key, end);
    return end;
  }
  const busyEnd = (key) => { const end = busyKeys.get(key); if (end) end(); };
  const busyFetch = (url, opts, key, region) => {
    const end = busy(key, region);
    return fetch(url, opts).finally(end);
  };
  if (window.__TAURI__)
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[target="_blank"]');
      if (!a || !a.href) return;
      e.preventDefault();
      const ext = /^https?:/.test(a.href) && new URL(a.href).origin !== location.origin;
      if (ext) window.__TAURI__.core.invoke('open_external_url', { url: a.href });
      else location.href = a.href;
    });

// ── src/13-frame.js ───────────────────────────────────────────────────────
  const tip = (b, name, keys) => {
    const t = keys ? name + ' (' + keys + ')' : name;
    b.title = t;
    b.setAttribute('aria-label', t);
    return b;
  };
  const sbtn = (attrs, icon, name, keys) =>
    `<button type="button" class="sbtn" ${attrs} title="${name}${keys ? ' (' + keys + ')' : ''}"`
    + ` aria-label="${name}${keys ? ' (' + keys + ')' : ''}">${ico(icon)}</button>`;

  const ACTIONS = [];
  const action = (a) => { ACTIONS.push(a); };
  const actionHome = (id) => document.querySelector('[data-action="' + CSS.escape(id) + '"]');
  const clickAction = (id, name, home, keys) => action({ id, name, home, keys,
    run: () => { const b = actionHome(id); if (b) b.click(); } });

  const PANES = {
    l: [['files', 'doc', 'Files', 'Ctrl+Shift+L'], ['know', 'know', 'Knowledge'],
      ['search', 'search', 'Search', 'Ctrl+Shift+F'], ['marks', 'mark', 'Bookmarks']],
    r: [['page', 'gear', 'Page'], ['out', 'out', 'Outgoing links'],
      ['back', 'back', 'Backlinks'], ['outline', 'list', 'Outline'],
      ['comments', 'comment', 'Comments'], ['hist', 'hist', 'History']],
  };
  const FILL = {
    files: '<lat-tree></lat-tree>', know: '<lat-know></lat-know>',
    search: '<lat-search></lat-search>', marks: '<lat-marks></lat-marks>',
    page: '<lat-ctl></lat-ctl>',
    back: '<lat-links></lat-links>', hist: '<lat-history></lat-history>',
  };
  const paneHtml = (side, label) => `
<nav id="${side}tabs" class="ptabs" role="tablist" aria-label="${label}">
  ${PANES[side].map(([id, icon, name, keys]) =>
    sbtn(`role="tab" data-pt="${id}" data-action="pt-${id}" aria-selected="false"`, icon, name, keys)).join('\n  ')}
</nav>
<div id="${side}body" class="pbody">
  ${PANES[side].map(([id]) =>
    `<section data-pane="${id}" role="tabpanel" hidden>${FILL[id] || ''}</section>`).join('\n  ')}
</div>`;

  customElements.define('lat-ribbon', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="corner" id="lcorner">${sbtn('id="treet" data-action="treet" aria-pressed="true"', 'pl', 'Left pane')}</div>
<nav class="ribbon" id="ribbon" aria-label="Ribbon">
  <div class="rtop"></div>
  <div class="rbot"></div>
</nav>`;
    }
  });
  customElements.define('lat-lpane', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `<aside class="pane lp" id="lpane">${paneHtml('l', 'Left pane')}</aside>`;
    }
  });
  customElements.define('lat-rpane', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="corner" id="rcorner">${sbtn('id="ctlt" data-action="ctlt" aria-pressed="true"', 'pr', 'Right pane')}</div>
<aside class="pane rp" id="rpane">${paneHtml('r', 'Right pane')}</aside>`;
    }
  });
  customElements.define('lat-statusbar', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<footer class="statusbar" id="statusbar">
  <!-- role=status so "saved" and every failure are announced, not just
       painted onto a line a screen reader never revisits -->
  <span id="spin"></span><span id="status" class="muted" role="status" aria-live="polite"></span>
  <!-- Offline state is a CONDITION, not an event, so it cannot live in the
       status line: the next save, render or refresh overwrites that. This
       badge stays up for as long as the condition holds. -->
  <span id="offbadge" class="offbadge" role="status" aria-live="polite" hidden></span>
  <span class="grow"></span>
  <button type="button" id="errchip" class="errchip" hidden></button>
</footer>`;
      status = $('status'); spinner = $('spin'); offbadge = $('offbadge');
      renderOffline();   // a queue can outlive a session, so show it at boot
    }
  });

  const TABKEY = { l: 'appLTab', r: 'appRTab' };
  const TABDEF = { l: 'files', r: 'page' };
  function paneTab(side, id) {
    if (!PANES[side].some((p) => p[0] === id)) id = TABDEF[side];
    for (const b of document.querySelectorAll('#' + side + 'tabs [data-pt]')) {
      const on = b.dataset.pt === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const s of document.querySelectorAll('#' + side + 'body > section'))
      s.hidden = s.dataset.pane !== id;
    try { localStorage[TABKEY[side]] = id; } catch {}
    document.dispatchEvent(new CustomEvent('lat-pane', { detail: { side, id } }));
  }
  const paneShows = (side, id) =>
    !document.querySelector('#' + side + 'body > [data-pane=' + id + ']').hidden;
  const OPENKEY = { l: 'appNT', r: 'appNC' };
  const isMobile = () => matchMedia('(max-width: 820px)').matches;
  function paintPanes() {
    const ws = $('ws');
    const phone = isMobile();
    for (const [side, cls, id] of [['l', 'nt', 'treet'], ['r', 'nc', 'ctlt']]) {
      const shut = localStorage[OPENKEY[side]] === '1';
      ws.classList.toggle(cls, shut);
      const on = phone ? ws.classList.contains(side + 'draw') : !shut;
      const b = $(id);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  let drawerSeq = 0;
  function drawer(side, open) {
    const ws = $('ws');
    if (open === undefined) open = !ws.classList.contains(side + 'draw');
    if (open && !ws.classList.contains(side + 'draw')) drawerSeq++;
    ws.classList.toggle('ldraw', open && side === 'l');
    ws.classList.toggle('rdraw', open && side === 'r');
    paintPanes();
    return open;
  }
  const drawersClose = () => drawer('l', false);
  const drawersCloseSince = (seq) => { if (drawerSeq === seq) drawersClose(); };
  function paneOpen(side, open) {
    if (isMobile()) return drawer(side, open);
    if (open === undefined) open = localStorage[OPENKEY[side]] === '1';
    try { localStorage[OPENKEY[side]] = open ? '0' : '1'; } catch {}
    paintPanes();
    return open;
  }
  for (const side of ['l', 'r']) {
    for (const b of document.querySelectorAll('#' + side + 'tabs [data-pt]'))
      b.onclick = () => paneTab(side, b.dataset.pt);
    paneTab(side, localStorage[TABKEY[side]]);
  }
  $('treet').onclick = () => paneOpen('l');
  $('ctlt').onclick = () => paneOpen('r');
  paintPanes();
  clickAction('treet', 'Toggle left pane', 'Top-left corner');
  clickAction('ctlt', 'Toggle right pane', 'Top-right corner');
  for (const side of ['l', 'r']) {
    for (const [id, , name, keys] of PANES[side]) {
      const aid = 'pt-' + id;
      action({ id: aid, name: 'Show ' + name, home: side === 'l' ? 'Left pane' : 'Right pane', keys,
        run: id === 'search' ? () => qOpen()
          : () => {
            paneOpen(side, true);
            const b = actionHome(aid);
            if (b) b.click();
            if (id === 'files') treeFocus();
          } });
    }
  }

  function ribbonAdd({ id, icon, name, keys, run, bottom }) {
    const b = tip(document.createElement('button'), name, keys);
    b.type = 'button';
    b.className = 'sbtn';
    b.id = 'rb-' + id;
    b.dataset.rb = id;
    b.dataset.action = id;
    action({ id, name, home: 'Ribbon', keys, run });
    b.innerHTML = ico(icon);
    b.onclick = (ev) => run(ev);
    document.querySelector('#ribbon ' + (bottom ? '.rbot' : '.rtop')).append(b);
    return b;
  }

  {
    const chip = $('errchip');
    chip.title = 'Show the error in the Page tab';
    const sync = () => {
      const c = $('cerr');
      const t = c && c.className === 'err' ? c.textContent.trim() : '';
      chip.hidden = !t;
      chip.textContent = t.split('\n')[0];
    };
    new MutationObserver(sync).observe(document.querySelector('#rbody > [data-pane=page]'),
      { childList: true, characterData: true, subtree: true, attributes: true });
    chip.onclick = () => { paneOpen('r', true); paneTab('r', 'page'); };
    sync();
  }

  window.latShell = { paneTab, paneOpen, ribbonAdd, drawer };

// ── src/15-dialog.js ──────────────────────────────────────────────────────
  let dlg, dlgMsg, dlgIn, dlgSel, dlgOpts, dlgKind;
  let dlgDone = null;
  let dlgFrom = null;   // focus to hand back on close
  const dlgClose = (v) => {
    if (!dlgDone) return;
    dlg.hidden = true;
    const f = dlgFrom; dlgFrom = null;
    if (f && f.isConnected) f.focus();
    const d = dlgDone; dlgDone = null; d(v);
  };
  const dlgOpen = (msg, okLabel) => {
    dlgFrom = document.activeElement;
    dlgMsg.textContent = msg;
    $('dlgok').textContent = okLabel || 'ok';
    dlg.hidden = false;
    return new Promise((res) => { dlgDone = res; });
  };
  const ask = (msg, value, okLabel) => {
    dlgSel.hidden = true;
    dlgIn.hidden = false;
    dlgKind.hidden = true;
    dlgIn.value = value || '';
    const p = dlgOpen(msg, okLabel);
    dlgIn.focus();
    dlgIn.setSelectionRange(dlgIn.value.length, dlgIn.value.length);
    return p;
  };
  const askNameKind = async (msg, value, okLabel, kind, fixed) => {
    dlgKind.textContent = '';
    const src = $('pkind');
    if (src) for (const o of src.options) dlgKind.appendChild(o.cloneNode(true));
    dlgKind.value = kind || (src && src.value) || 'md';
    dlgKind.disabled = !!fixed;
    let seed = value || '';
    let note = '';
    for (;;) {
      dlgSel.hidden = true;
      dlgIn.hidden = false;
      dlgKind.hidden = false;
      dlgIn.value = seed;
      const p = dlgOpen(note + msg, okLabel);
      dlgIn.focus();
      dlgIn.setSelectionRange(dlgIn.value.length, dlgIn.value.length);
      const raw = await p;
      const picked = dlgKind.value;
      dlgKind.hidden = true;
      if (raw === null) return null;
      const name = raw.trim().replace(/^\/+|\/+$/g, '');
      if (!name) return null;
      if (realName(name)) return { name, kind: picked };
      seed = name;
      note = 'that name has nothing to go by — use at least one letter or digit. ';
    }
  };
  const askName = async (msg, value, okLabel) => {
    let seed = value || '';
    let note = '';
    for (;;) {
      const raw = await ask(note + msg, seed, okLabel);
      if (raw === null) return null;
      const name = raw.trim().replace(/^\/+|\/+$/g, '');
      if (!name) return null;
      if (realName(name)) return name;
      seed = name;
      note = 'that name has nothing to go by — use at least one letter or digit. ';
    }
  };
  const askConfirm = (msg, okLabel) => {
    dlgSel.hidden = true;
    dlgKind.hidden = true;
    dlgIn.hidden = true;
    const p = dlgOpen(msg, okLabel);
    $('dlgok').focus();
    return p.then((v) => v !== null);
  };
  const askDanger = (msg, okLabel) => {
    dlgSel.hidden = true;
    dlgKind.hidden = true;
    dlgIn.hidden = true;
    const ok = $('dlgok');
    const p = dlgOpen(msg, okLabel);
    ok.classList.add('danger');
    $('dlgcancel').focus();
    return p.then((v) => { ok.classList.remove('danger'); return v !== null; });
  };
  const askPublish = async () => {
    try { if (localStorage.latPubOk === '1') return true; } catch {}
    dlgSel.hidden = true;
    dlgKind.hidden = true;
    dlgIn.hidden = true;
    const row = $('dlgchkrow'), chk = $('dlgchk'), no = $('dlgcancel');
    chk.checked = false;
    row.hidden = false;
    const p = dlgOpen('Once published, deletion is not assured. Anyone who has read '
      + 'this page can keep a copy, and the network may go on serving it after '
      + 'you unpublish or delete it.', 'publish');
    no.textContent = 'abort';
    no.focus();
    const ok = (await p) !== null;
    row.hidden = true;
    no.textContent = 'cancel';
    if (ok && chk.checked) try { localStorage.latPubOk = '1'; } catch {}
    return ok;
  };
  const askChoice = (msg, options, okLabel) => {
    dlgIn.hidden = true;
    dlgSel.hidden = true;
    dlgKind.hidden = true;
    dlgOpts.textContent = '';
    dlgOpts.hidden = false;
    $('dlgok').hidden = true;          // each option is its own commit button
    const p = dlgOpen(msg, okLabel);
    const btns = options.map((o, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dlgopt' + (i === 0 ? ' on' : '');
      b.textContent = o;
      b.dataset.val = o;
      b.onclick = () => dlgClose(o);
      dlgOpts.appendChild(b);
      return b;
    });
    if (btns[0]) btns[0].focus();
    dlgOpts.onkeydown = (e) => {
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = (i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length;
        for (const b of btns) b.classList.remove('on');
        btns[n].classList.add('on');
        btns[n].focus();
      }
    };
    return p.then((v) => {
      dlgOpts.hidden = true;
      $('dlgok').hidden = false;
      return v;
    });
  };
  customElements.define('lat-dialog', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<!-- labelled by the prompt itself: dlgmsg carries the question, so it is
     the accessible name, like the aria-label on the overlay siblings -->
<div class="dlg" id="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgmsg" hidden>
  <form class="dlgbox" id="dlgform">
    <div id="dlgmsg"></div>
    <div id="dlgopts" class="dlgopts" hidden></div>
    <select id="dlgsel" hidden></select>
    <!-- every prompt that shows this asks for a name of some kind -->
    <input id="dlginput" aria-label="name" autocomplete="off" spellcheck="false">
    <!-- the kind to save as. Only askNameKind shows it. -->
    <select id="dlgkind" class="dlgkind" aria-label="page kind" hidden></select>
    <!-- only askPublish shows it -->
    <label id="dlgchkrow" class="dlgchk" hidden><input type="checkbox" id="dlgchk"> don't ask again</label>
    <div class="dlgbtns">
      <button type="button" id="dlgcancel">cancel</button>
      <button type="submit" id="dlgok">ok</button>
    </div>
  </form>
</div>`;
      dlg = $('dlg'); dlgMsg = $('dlgmsg'); dlgIn = $('dlginput');
      dlgSel = $('dlgsel'); dlgOpts = $('dlgopts'); dlgKind = $('dlgkind');
      $('dlgform').onsubmit = (e) => {
        e.preventDefault();
        dlgClose(!dlgSel.hidden ? dlgSel.value : dlgIn.hidden ? '' : dlgIn.value);
      };
      $('dlgcancel').onclick = () => dlgClose(null);
      dlg.onclick = (e) => { if (e.target === dlg) dlgClose(null); };
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !dlg.hidden) dlgClose(null);
      });
    }
  });

// ── src/20-state.js ───────────────────────────────────────────────────────
  let current = null;      // name of the open page, null = unsaved new page
  let dirty = false;       // unsaved local edits. Auto-refresh never clobbers them
  let mode = 'pages';      // 'know' while a memory is in front (95-know.js)
  window.__latUnsaved = () => dirty === true
    || allTabs().some((t) => t !== activeTab && t.snap && t.snap.dirty);
  let everTyped = false;
  async function guardDirty() {
    if (!dirty) return true;
    if (grubPath)
      return askConfirm('discard unsaved changes to ' + grubPath + '?', 'discard');
    const label = current || pname.value.trim() || 'this';
    if (await flushNoAsk()) return true;
    if (autosaveOn())
      return askConfirm('discard unsaved changes to ' + label + '?', 'discard');
    const pick = await askChoice('unsaved changes to ' + label + '. save them?',
      ['save', 'discard']);
    if (pick === 'discard') return true;
    if (pick !== 'save') return false;
    return saveNow();
  }
  async function saveNow() {
    await waitSave();
    if (!dirty) return true;
    if (saving) { st('a save is still running, try again', false); return false; }
    if (grubPath) await saveGrub(); else if (mode === 'know') await saveKnow(); else await save();
    await waitSave();
    return !dirty;
  }
  async function flushNoAsk() {
    if (!dirty) return true;
    if (grubPath) return false;
    await waitSave();
    if (!dirty) return true;
    if (!saving && autosaveOn()) {
      if (mode === 'know') await saveKnow(); else await save();
    }
    return !dirty;
  }
  async function waitSave() {
    const t0 = Date.now();
    while (saving && Date.now() - t0 < 35000)
      await (saveFlight || new Promise((r) => setTimeout(r, 50)));
  }
  function setOpen(name, { shown, readOnly = false, kind, url } = {}) {
    current = name;
    pname.value = shown === undefined ? (name || '') : shown;
    pname.readOnly = readOnly;
    if (kind && [...pkind.options].some((o) => o.value === kind)) pkind.value = kind;
    if (url) history.replaceState(null, '', url);
    pname.dispatchEvent(new Event('input'));
    tabFollow();
  }
  let viewingRev = null;   // non-null: a read-only historical revision is shown
  let curKind = null;      // the OPEN page's server kind; 'index' has no select
  let curRev = 0;          // the open page's server revision (offline baseRev)
  let curFolder = null;    // selected folder path. Right-pane ops target it
  let folderCtx = '';      // folder uploads land in (last into / open page's dir)
  let nodes = [];          // last page-tree
  let saving = false;      // a save round-trip is in flight. Never overlap them.
  let moving = 0;          // a move or rename is in flight (75-move.js): a
  let savePending = false; // The pier serializes, so a second save just queues
  const echoes = {
    rev: { n: 0, until: 0, at: 0, early: 0, fly: 0, tail: 0, timer: 0, wake: null },
    know: { n: 0, until: 0, at: 0, early: 0, fly: 0, tail: 0, timer: 0, wake: null },
  };
  const echoArm = (echo) => {
    clearTimeout(echo.timer);
    if (!echo.early || !echo.wake) return;
    echo.timer = setTimeout(() => {
      if (Date.now() < echo.until) { echoArm(echo); return; }
      echo.early = 0;
      echo.wake();
    }, Math.max(0, echo.until - Date.now()) + 50);
  };
  const echoSeen = (echo, wake) => {
    if (echo.n > 0) { echo.n--; return true; }
    if (Date.now() >= echo.until) return false;
    echo.early++;
    echo.wake = wake;
    echoArm(echo);
    return true;
  };
  const echoSent = (echo) => {
    echo.fly++;
    echo.until = Math.max(echo.until, Date.now() + 60000);
    echo.at = Date.now();             // when we last wrote (see refocused)
  };
  const echoLanded = (echo, ok, sentAt) => {
    const now = Date.now();
    const tail = now + Math.max(4000, 2 * (now - sentAt));
    echo.fly = Math.max(0, echo.fly - 1);
    echo.tail = Math.max(echo.tail, tail);
    echo.until = echo.fly ? Math.max(echo.until, tail) : echo.tail;
    if (ok) { if (echo.early > 0) echo.early--; else echo.n++; }
    echoArm(echo);
  };
  const echoOf = (url) => {
    let p = '';
    try { p = new URL(url, location.href).pathname; } catch {}
    return /\/know-(?!publish$)[a-z-]+$/.test(p) ? echoes.know : echoes.rev;
  };
  const qs = new URLSearchParams(location.search);

  let treeGen = 0, knowGen = 0;
  const persistTree = () => {
    kvPut('tree', nodes);
  };
  const pageCache = new Map();
  const sensKnown = new Map();
  let sensWait = null;
  let sensGen = 0;
  const sensForget = (url) => {
    sensGen++;
    if (!url || !/\/(page-save|know-save)\?/.test(url) || /[?&]new=1/.test(url)) sensKnown.clear();
  };
  const srcFlight = new Map();
  const srcRead = (name) => {
    let p = srcFlight.get(name);
    if (!p) {
      p = fetch(api + '/page-source?name=' + encodeURIComponent(name) + '&render=1');
      srcFlight.set(name, p);
      const done = () => { if (srcFlight.get(name) === p) srcFlight.delete(name); };
      p.then(done, done);
    }
    return p.then((r) => r.clone());
  };
  const snapTree = () => {
    treeGen++;                 // structural change: supersede in-flight fetches
    persistTree();
  };
  const snapPage = (name, d) => {
    try {
      localStorage.appPage = JSON.stringify(
        { name, body: d.body, kind: d.kind, share: d.share || 'private',
          rev: d.rev, html: typeof d.html === 'string' ? d.html : undefined });
    } catch {}
  };

  const offlineOp = (url) => {
    let u = null;
    try { u = new globalThis.URL(url, location.origin); } catch { return null; }
    const p = u.searchParams;
    if (u.pathname.endsWith('/page-del') && p.get('name'))
      return { op: 'del', name: p.get('name') };
    if (u.pathname.endsWith('/page-move') && p.get('from') && p.get('to'))
      return { op: 'move', from: p.get('from'), to: p.get('to') };
    if (u.pathname.endsWith('/folder-new') && p.get('name'))
      return { op: 'mkdir', name: p.get('name') };
    return null;
  };

  let saveFlight = null;
  async function shipWrite(url, init, { ms = 30000, save = false } = {}) {
    srcFlight.clear();    // a read from before this write is shared no more
    sensForget(url);
    const echo = echoOf(url);
    echoSent(echo);
    lastAction = Date.now();          // a write is user activity (see bgFetch)
    const sentAt = Date.now();
    const req = (ms ? tfetch(url, init, ms) : fetch(url, init)).catch(() => null);
    if (save) saveFlight = req;
    const end = save ? null : busy();
    let r = null;
    try { r = await req; }
    finally {
      if (end) end();
      if (saveFlight === req) saveFlight = null;
    }
    const gone = shipGone(r);
    echoLanded(echo, !gone && r.ok, sentAt);    // one bump is ours (see echoes)
    if (gone) return { gone: true, r };
    if (r.ok) {
      try {
        const q = new URL(url, location.href).searchParams;
        bustPages(q.get('name') || q.get('from') || q.get('key'));
        if (q.get('to')) bustPages(q.get('to'));
      } catch {}
    }
    return { r };
  }

  async function mutate(url, opts) {
    const offline = async () => {
      sensForget(url);      // a queued delete or move culls the flag too
      const q = offlineOp(url);
      if (q) {
        await enqueueOp(q);
        return { ok: true, offline: true, status: 200,
                 json: async () => ({ offline: true }) };
      }
      st('offline — edits are queued, but this change needs the ship', false);
      return { ok: false, status: 'offline', json: async () => ({ error: 'offline' }) };
    };
    if (degraded || offCount) return offline();
    const w = await shipWrite(url, opts || { method: 'POST' }, { ms: 0 });
    if (w.gone) { setDegraded(true); return offline(); }
    return w.r;
  }

  let basePr = null;
  const latBase = () => basePr || (basePr = (async () => {
    try { if (localStorage.latBase) return localStorage.latBase; } catch {}
    const r = await fetch(api + '/streams');
    const b = r.ok ? (await r.json()).base : null;
    if (!b) throw new Error('no base');
    try { localStorage.latBase = b; } catch {}
    return b;
  })().catch((e) => { basePr = null; throw e; }));
  const forgetBase = () => { basePr = null; try { delete localStorage.latBase; } catch {} };

  const collStore = (k) => {
    const get = () => {
      try { return JSON.parse(localStorage[k] || '[]'); } catch { return []; }
    };
    const flip = (key) => {
      const c = get();
      const i = c.indexOf(key);
      if (i >= 0) c.splice(i, 1); else c.push(key);
      localStorage[k] = JSON.stringify(c);
    };
    const set = (list) => { localStorage[k] = JSON.stringify(list); };
    return { get, flip, set };
  };
  const paneColl = collStore('appColl');

// ── src/21-tabs.js ────────────────────────────────────────────────────────
  let tabs = [];
  let activeTab = null;
  let tabSeq = 0;
  let groups = [];          // every group, in the order they were made
  let focusG = null;        // the group in front
  const gFront = (g) => (g === focusG ? activeTab : g.active);
  const allTabs = () => groups.flatMap((g) => g.tabs);
  const groupOf = (t) => groups.find((g) => g.tabs.includes(t)) || null;
  let tabRunning = 0;
  let tabNav = 0;
  let tabLoading = null;

  const mkTab = (kind, key, ship, { pinned = false, read = false } = {}) =>
    ({ id: 't' + (++tabSeq), kind, key, ship: ship || null, pinned, read,
       back: [], fwd: [], snap: null });
  let gSeq = 0;
  const mkGroup = () => ({ id: 'g' + (++gSeq), tabs: [], active: null });
  const sameDoc = (t, d) =>
    t.kind === d.kind && t.key === d.key && (t.ship || null) === (d.ship || null);
  const retarget = (t, d) => {
    Object.assign(t, d);
    t.ghost = null;
    t.gbody = undefined;
    t.gkind = undefined;
    t.gfetch = false;
  };
  const tabEnc = (t) => JSON.stringify([t.kind, t.key, t.ship || null]);
  const tabDec = (s) => { const [kind, key, ship] = JSON.parse(s); return { kind, key, ship }; };

  const liveDoc = () => {
    for (const [kind, k] of Object.entries(TAB_KINDS)) {
      const d = k.live && k.live();
      if (d) return { kind, key: d.key, ship: d.ship || null };
    }
    return null;
  };
  const docFront = () => !activeTab || !!TAB_KINDS[activeTab.kind].live;
  const showsLive = (t) => { const d = liveDoc(); return !!d && sameDoc(t, d); };

  const snapNow = () => (writerSync(), {
    body: src.value, dirty, everTyped,
    sel: [src.selectionStart, src.selectionEnd], scroll: src.scrollTop,
    kind: curKind, pkind: pkind.value, rev: curRev, shown: pname.value,
    hist: viewingRev !== null,
  });
  async function parkDoc(t) {
    const label = current || pname.value.trim() || 'this';
    await flushNoAsk();
    const mine = TAB_KINDS[t.kind].shows(t);
    if (dirty && !mine &&
        !(await askConfirm('discard unsaved changes to ' + label + '?', 'discard')))
      return false;
    t.snap = mine ? snapNow() : null;
    if (mine) gGhostKeep(t);
    dirty = false;
    clearTimeout(autoTimer);
    return true;
  }
  const TAB_KINDS = {
    page: {
      icon: (t) => (linkOf(t.key) ? 'link' : 'doc'),
      label: (t) => !t.key ? 'new page' : linkOf(t.key) ? t.key : t.key.split('/').pop(),
      open: async (t) => {
        if (t.key) return openPage(t.key);
        exitRev();
        newFile('', false);
        return true;
      },
      restore: (t, s) => {
        exitRev();
        if (!t.key) {
          newFile('', false);
          setOpen(null, { shown: s.shown });
          if (s.pkind) pkind.value = s.pkind;
          src.value = s.body;
          render();
          return;
        }
        exitGrub();
        if (mode === 'know') setMode('pages');
        setFolderCtx(t.key);
        const n = nodes.find((x) => x.page && x.path === t.key);
        applyPage(t.key, { body: s.body, kind: s.kind || s.pkind, rev: s.rev,
          share: (n && n.share) || 'private' }, true);
        if (!CONTENT()) refreshPreview();
      },
      park: parkDoc,
      shows: showsLive,
      live: () => (!grubPath && mode !== 'know' && curFolder === null
        ? { key: current || '' } : null),
    },
    know: {
      icon: 'know',
      label: (t) => t.key ? t.key.split('/').pop() : 'new memory',
      open: async (t) => {
        if (t.key) return openKnow(t.key);
        setMode('know');
        return true;
      },
      restore: (t, s) => {
        if (mode !== 'know') setMode('know');
        if (!t.key) {
          setOpen(null, { shown: s.shown });
          src.value = s.body;
          render();
          return;
        }
        const e = knowEntry(t.key) || { tags: [] };
        applyKnow(t.key, { body: s.body, tags: e.tags,
          updated: s.dirty ? 'unsaved here' : e.updated || '' });
      },
      park: parkDoc,
      shows: showsLive,
      live: () => (!grubPath && mode === 'know' ? { key: current || '' } : null),
    },
    grub: {
      icon: 'file',
      label: (t) => {
        const pg = /\/page\/(.+)\/code$/.exec(t.key);
        const n = pg ? pg[1] : t.key.split('/').pop();
        return t.ship ? t.ship + ': ' + n : n;
      },
      open: async (t) => {
        if (mode === 'know') setMode('pages');
        exitRev();
        return openGrub(t.key, t.ship);
      },
      restore: (t, s) => {
        if (mode === 'know') setMode('pages');
        exitRev();
        enterGrub(t.key, t.ship);
        src.value = s.body;
        src.readOnly = false;
        if (s.pkind) pkind.value = s.pkind;
        curKind = s.kind;
        render();
        pname.dispatchEvent(new Event('input'));
        refreshPreview();
        if (s.dirty) st('unsaved, Ctrl+S to save');
      },
      park: parkDoc,
      shows: showsLive,
      live: () => (grubPath ? { key: grubPath, ship: grubShip } : null),
    },
  };


  const tabRec = ({ kind, key, ship, pinned, read }) => ({ kind, key, ship, pinned, read });
  const tabsSave = () => {
    try {
      localStorage.appTabs = JSON.stringify({
        v: 2,
        groups: groups.map((g) => ({ tabs: g.tabs.map(tabRec), active: g.tabs.indexOf(gFront(g)) })),
        focus: groups.indexOf(focusG),
        tree: splitSave(),
        tabs: tabs.map(tabRec),
        active: tabs.indexOf(activeTab),
      });
    } catch {}
  };
  const tabsChanged = () => { tabsSave(); paintTabs(); };

  let tabQ = Promise.resolve();
  let tabShown = 0;         // counts showTab calls, so a late landing knows it is late
  const tabSerial = (fn) => {
    const go = async () => {
      tabRunning++;
      try { return await fn(); } finally { tabRunning--; }
    };
    const run = tabQ.then(go, go);
    tabQ = run.catch(() => {});
    return run;
  };

  function showTab(t, { snapOk = false } = {}) {
    const k = TAB_KINDS[t.kind];
    const s = t.snap;
    t.snap = null;          // in front, the live editor is its state
    st('');
    const gen = ++tabShown;
    src.readOnly = false;   // a blank or a binary grub left it locked
    openNext();             // an open still loading for the tab left behind may not land
    const quick = snapOk && !!s && !s.hist && !!t.key && (t.kind === 'page' || t.kind === 'know');
    if (s && (s.dirty || (!t.key && s.shown) || quick)) {
      tabLoading = null;
      tabNav++;
      try {
        k.restore(t, s);
        dirty = s.dirty;
        everTyped = s.everTyped;
        clearTimeout(autoTimer);
        if (dirty) autoTimer = setTimeout(autosave, 2000);
        tabCaret(s);
      } finally { tabNav--; }
      paintTabs();
      if (quick && !s.dirty) refreshOpen();
      return Promise.resolve(true);
    }
    tabLoading = t;
    const settle = () => { if (gen === tabShown && tabLoading === t) tabLoading = null; };
    let p;
    try { p = Promise.resolve(k.open(t)); } catch (e) { p = Promise.reject(e); }
    return p.then((ok) => {
      settle();
      if (activeTab !== t || gen !== tabShown) return ok;
      if (ok === false && !k.shows(t)) tabBlank(t);
      else if (!k.shows(t)) tabFollow();   // something else opened over it
      else if (s && !dirty) tabCaret(s);
      paintTabs();
      return ok;
    }, (e) => { settle(); throw e; });
  }
  const tabCaret = (s) => {
    try { src.setSelectionRange(s.sel[0], s.sel[1]); } catch {}
    src.scrollTop = s.scroll;
    sync();
  };
  function tabBlank(t) {
    tabNav++;
    try {
      exitGrub();
      setOpen(null, { shown: TAB_KINDS[t.kind].label(t), readOnly: true });
      src.value = '';
      src.readOnly = true;
      dirty = false;
      render();
      prevBlank();
    } finally { tabNav--; }
  }

  async function tabTo(t) {
    const g = groupOf(t);
    if (g && g !== focusG && !(await gTo(g))) return false;
    const from = activeTab;
    if (from === t) {
      if (!TAB_KINDS[t.kind].shows(t) && tabLoading !== t) showTab(t);
      return;
    }
    if (from && tabs.includes(from) && (await TAB_KINDS[from.kind].park(from)) === false)
      return false;
    activeTab = t;
    tabsChanged();
    showTab(t);
  }

  function gRelease() {
    const t = activeTab;
    if (!t) return true;
    const k = TAB_KINDS[t.kind];
    if (!k.live) return true;          // a tool stays in its own group's host
    const mine = k.shows(t);
    if (dirty && !mine) return false;
    if (saving && !t.key) return false;
    if (mine) { t.snap = snapNow(); gGhostKeep(t); }
    dirty = false;
    clearTimeout(autoTimer);
    openNext();                        // an open in flight lands nowhere now
    if (tabLoading === t) tabLoading = null;
    if (t.snap && t.snap.dirty) saveParked(t);
    return true;
  }
  function gTake(g) {
    if (focusG && groups.includes(focusG)) focusG.active = activeTab;
    focusG = g;
    tabs = g.tabs;
    activeTab = g.active && g.tabs.includes(g.active) ? g.active : g.tabs[0] || null;
    if (!activeTab) { activeTab = mkTab('page', ''); tabs.push(activeTab); }
    g.active = activeTab;
    splitPaint();
    tabsChanged();
    showTab(activeTab, { snapOk: true });
    rpSoon();
  }
  async function gTo(g) {
    if (g === focusG) return true;
    if (!gRelease()) {
      const t = activeTab;
      if ((await TAB_KINDS[t.kind].park(t)) === false) return false;
    }
    gTake(g);
    return true;
  }
  function gFocus(g) {
    if (!g || g === focusG || !groups.includes(g)) return true;
    if (!tabRunning && gRelease()) { gTake(g); return true; }
    tabSerial(() => gTo(g));
    return false;
  }
  function gDropTab(x) {
    const g = groupOf(x);
    if (!g) return;
    const i = g.tabs.indexOf(x);
    g.tabs.splice(i, 1);
    if (g === focusG) return;
    if (!g.tabs.length) { gDrop(g); return; }
    if (g.active === x) g.active = g.tabs[i] || g.tabs[i - 1];
  }
  const gMove = (t, g, at = null) => tabSerial(async () => {
    const from = groupOf(t);
    if (!from || !groups.includes(g)) return false;
    if (from === g) {
      const i = g.tabs.indexOf(t);
      let j = at === null ? g.tabs.length : at;
      g.tabs.splice(i, 1);
      if (j > i) j--;
      g.tabs.splice(Math.max(0, Math.min(j, g.tabs.length)), 0, t);
      tabsChanged();
      return true;
    }
    if (t === activeTab && !gRelease()
      && (await TAB_KINDS[t.kind].park(t)) === false) return false;
    const i = from.tabs.indexOf(t);
    from.tabs.splice(i, 1);
    if (gFront(from) === t) {
      const next = from.tabs[i] || from.tabs[i - 1] || null;
      from.active = next;
      if (from === focusG) activeTab = next;   // parked, not shown: nothing is live
    }
    const j = at === null ? g.tabs.length : Math.max(0, Math.min(at, g.tabs.length));
    g.tabs.splice(j, 0, t);
    if (!from.tabs.length) gDrop(from);
    if (g === focusG) return (await tabTo(t)) !== false;
    g.active = t;
    if (groups.includes(focusG) && focusG.tabs.length && !gRelease()
      && (await TAB_KINDS[activeTab.kind].park(activeTab)) === false) {
      tabsChanged();
      splitPaint();
      return false;
    }
    gTake(g);
    return true;
  });

  function openIn(kind, key, { ev, ship, newTab } = {}) {
    return tabSerial(async () => {
      const want = { kind, key, ship: ship || null };
      const hit = key ? allTabs().find((t) => sameDoc(t, want)) : null;
      if (hit) return tabTo(hit);
      const fresh = newTab || (ev && (ev.ctrlKey || ev.metaKey || ev.button === 1))
        || !activeTab || activeTab.pinned;
      if (fresh) {
        const t = mkTab(kind, key, ship);
        tabs.splice(activeTab ? tabs.indexOf(activeTab) + 1 : tabs.length, 0, t);
        if ((await tabTo(t)) === false) { tabs.splice(tabs.indexOf(t), 1); tabsChanged(); }
        return;
      }
      if (!(await guardDirty())) return;
      dirty = false;
      const t = activeTab;
      if (t.key) { t.back.push(tabEnc(t)); t.fwd = []; }
      retarget(t, want);
      t.snap = null;
      tabsChanged();
      showTab(t);
    });
  }
  const switchTab = (id) => tabSerial(async () => {
    const t = allTabs().find((x) => x.id === id);
    if (t) await tabTo(t);
  });
  const closeTab = (id) => tabSerial(async () => {
    const t = allTabs().find((x) => x.id === id);
    if (!t) return false;
    const g = groupOf(t);
    const k0 = TAB_KINDS[t.kind];
    if (g !== focusG && !(t.snap && t.snap.dirty) && !(k0.held && k0.held(t))) {
      const i = g.tabs.indexOf(t);
      g.tabs.splice(i, 1);
      if (!g.tabs.length) gDrop(g);
      else if (g.active === t) g.active = g.tabs[i] || g.tabs[i - 1];
      tabsChanged();
      return true;
    }
    if (g !== focusG && !(await gTo(g))) return false;
    if (t !== activeTab && t.snap && t.snap.dirty && (await tabTo(t)) === false) return false;
    const k = TAB_KINDS[t.kind];
    if (k.held && k.held(t)) {
      if (t !== activeTab && (await tabTo(t)) === false) return false;
      if (!(await askConfirm('discard what you typed in ' + k.label(t) + '?', 'discard'))) return false;
    }
    if (t === activeTab) {
      if (!(await guardDirty())) return false;
      dirty = false;
      clearTimeout(autoTimer);
    }
    const i = tabs.indexOf(t);
    tabs.splice(i, 1);
    if (t !== activeTab) { tabsChanged(); return true; }
    activeTab = null;
    let next = tabs[i] || tabs[i - 1];
    if (!next && groups.length > 1) {
      const nb = gNeighbor(focusG);
      gDrop(focusG);
      gTake(nb);
      return true;
    }
    if (!next) { next = mkTab('page', ''); tabs.push(next); }
    activeTab = next;
    tabsChanged();
    showTab(next);
    return true;
  });
  const tabStep = (from, to) => tabSerial(async () => {
    const t = activeTab;
    if (!t || !t[from].length) return;
    if (!(await guardDirty())) return;
    dirty = false;
    const d = tabDec(t[from].pop());
    const twin = d.key && allTabs().find((x) => x !== t && sameDoc(x, d));
    if (twin) { tabsChanged(); return tabTo(twin); }
    if (t.key) t[to].push(tabEnc(t));
    retarget(t, d);
    t.snap = null;
    tabsChanged();
    showTab(t);
  });
  const tabBack = () => tabStep('back', 'fwd');
  const tabFwd = () => tabStep('fwd', 'back');
  const tabCycle = (dir) => {
    if (tabs.length < 2) return;
    const i = tabs.indexOf(activeTab);
    switchTab(tabs[(i + dir + tabs.length) % tabs.length].id);
  };
  const tabNew = async () => {
    await openIn('page', '', { newTab: true });
    if (activeTab && activeTab.kind === 'page' && !activeTab.key) newFile('');
  };
  const docTab = async () => {
    if (docFront()) return true;
    await openIn('page', '', { newTab: true });
    return docFront() && !!activeTab && activeTab.kind === 'page' && !activeTab.key;
  };

  function tabFollow() {
    if (tabNav || !activeTab) return;
    const t = activeTab;
    if (!TAB_KINDS[t.kind].live) return;
    if (tabLoading === t) {
      if (TAB_KINDS[t.kind].shows(t)) tabLoading = null;
      return;
    }
    const d = liveDoc();
    if (!d || sameDoc(t, d)) return;
    if (t.key) { t.back.push(tabEnc(t)); t.fwd = []; }
    retarget(t, d);
    t.snap = null;
    const twin = d.key && allTabs().find((x) => x !== t && sameDoc(x, d) && !(x.snap && x.snap.dirty));
    if (twin) gDropTab(twin);
    tabsChanged();
  }
  function tabAdopt(own, name) {
    const trim = (v) => v.trim().replace(/^\/+|\/+$/g, '');
    const t = allTabs().find((x) => x.id === own.tab);
    if (!t || t.kind !== 'page' || t.key) return false;
    if (t === activeTab)
      return showsLive(t) && current === null && trim(pname.value) === own.name;
    if (!t.snap || trim(t.snap.shown || '') !== own.name) return false;
    t.key = name;
    t.snap.shown = name;
    tabsChanged();
    return false;
  }
  function tabsRemap(kind, from, to) {
    for (const t of allTabs()) {
      if (t.kind !== kind || !t.key) continue;
      if (t.key === from) t.key = to;
      else if (t.key.startsWith(from + '/')) t.key = to + t.key.slice(from.length);
    }
    tabsChanged();
  }
  function tabLanded(kind, name, sent, rev, ship = null) {
    for (const t of allTabs()) {
      if (t.kind !== kind || t.key !== name || (t.ship || null) !== ship || !t.snap) continue;
      if (t.snap.body === sent && t.snap.dirty) t.snap.dirty = false;
      if (rev) t.snap.rev = rev;
    }
  }

  function tabsBoot() {
    let saved = null;
    try { saved = JSON.parse(localStorage.appTabs || 'null'); } catch {}
    if (!saved || typeof saved !== 'object') saved = null;
    const lists = saved && Array.isArray(saved.groups) && saved.groups.length ? saved.groups
      : saved && Array.isArray(saved.tabs) ? [{ tabs: saved.tabs, active: saved.active }] : [];
    const seen = [];
    let made = lists.map((e) => {
      const g = mkGroup();
      for (const r of (e && Array.isArray(e.tabs) ? e.tabs : [])) {
        if (!r || !TAB_KINDS[r.kind] || typeof r.key !== 'string') continue;
        if (r.ship != null && typeof r.ship !== 'string') continue;
        if (r.key && seen.some((t) => sameDoc(t, r))) continue;
        const t = mkTab(r.kind, r.key, r.ship, { pinned: r.pinned === true, read: r.read === true });
        g.tabs.push(t);
        seen.push(t);
      }
      g.active = (e && Number.isInteger(e.active) && g.tabs[e.active]) || g.tabs[0] || null;
      return g;
    });
    let fi = saved && Number.isInteger(saved.focus) && made[saved.focus] ? saved.focus : 0;
    if (made.length > 1 && (made.some((g) => !g.tabs.length) || !splitLoad(saved.tree, made))) {
      const one = mkGroup();
      one.tabs = made.flatMap((g) => g.tabs);
      one.active = (made[fi] && made[fi].active) || one.tabs[0] || null;
      made = [one];
      fi = 0;
    }
    if (!made.length) made = [mkGroup()];
    if (made.length === 1) splitLoad(0, made);
    for (const g of made) gAdd(g);
    focusG = made[fi];
    tabs = focusG.tabs;
    activeTab = focusG.active;
    const want = qs.get('grub') ? { kind: 'grub', key: qs.get('grub'), ship: qs.get('ship') || null }
      : qs.get('view') === 'know' ? { kind: 'know', key: qs.get('key') || '', ship: null }
      : qs.get('name') ? { kind: 'page', key: qs.get('name'), ship: null } : null;
    if (want) {
      const hit = activeTab && sameDoc(activeTab, want) ? activeTab
        : allTabs().find((t) => sameDoc(t, want));
      if (hit) {
        focusG = groupOf(hit);
        tabs = focusG.tabs;
        activeTab = hit;
      } else {
        const t = mkTab(want.kind, want.key, want.ship);
        tabs.splice(activeTab ? tabs.indexOf(activeTab) + 1 : 0, 0, t);
        activeTab = t;
      }
    }
    const fresh = !activeTab && allTabs().length === 0;
    if (!activeTab) { activeTab = mkTab('page', ''); tabs.push(activeTab); }
    focusG.active = activeTab;
    splitPaint();
    tabsChanged();
    return { tab: activeTab, fresh };
  }
  const tabShowBoot = (t) => tabSerial(() => showTab(t));

  function paintStrip(g) {
    const front = gFront(g);
    g.list.textContent = '';
    for (const t of g.tabs) {
      const k = TAB_KINDS[t.kind];
      const name = k.label(t);
      const w = document.createElement('div');
      w.setAttribute('role', 'presentation');
      w.draggable = true;
      w.dataset.id = t.id;
      const b = document.createElement('button');
      b.type = 'button';
      for (const [el, base] of [[w, 'dtw'], [b, 'dtab']])
        el.className = base + (t === front ? ' on' : '') + (t.pinned ? ' pinned' : '');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t === front ? 'true' : 'false');
      b.dataset.id = t.id;
      b.dataset.kind = t.kind;
      b.dataset.key = t.key;
      if (t.kind === 'tool' && frameSlow(t.key)) b.classList.add('lload');
      b.title = (t.ship ? t.ship + ' ' : '') + (t.key || name);
      b.innerHTML = ico(t.pinned ? 'pin' : typeof k.icon === 'function' ? k.icon(t) : k.icon)
        + '<span class="dtn"></span>'
        + '<span class="dtdot" aria-hidden="true"></span>';
      b.querySelector('.dtn').textContent = name;
      b.onclick = () => switchTab(t.id);
      const x = tip(document.createElement('button'), 'Close ' + name);
      x.type = 'button';
      x.className = 'dtx';
      x.innerHTML = ico('x');
      x.onclick = () => closeTab(t.id);
      w.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); };
      w.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } };
      w.oncontextmenu = (e) => { e.preventDefault(); tabMenu(t, e.clientX, e.clientY); };
      w.append(b, x);
      g.list.append(w);
    }
    if (!g.scrollRaf) g.scrollRaf = requestAnimationFrame(() => {
      g.scrollRaf = 0;
      const on = g.list.querySelector('.dtw.on');
      if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  function paintTabs() {
    for (const g of groups) paintStrip(g);
    paintTabDirty();
    if (!focusG) return;
    paintHead();   // the header under the strip (23-tabhead.js)
    gPaintAll();   // the other groups' parked fronts (28-splits.js)
    document.dispatchEvent(new Event('lat-tabs'));
  }
  function paintTabDirty() {
    for (const g of groups) {
      for (const w of g.list.children) {
        const b = w.firstChild;
        const t = g.tabs.find((x) => x.id === b.dataset.id);
        const on = !!t && (t === activeTab ? dirty === true : !!(t.snap && t.snap.dirty));
        w.classList.toggle('dirty', on);
        b.classList.toggle('dirty', on);
      }
    }
  }
  setInterval(paintTabDirty, 400);
  clickAction('tabnew', 'New page in a new tab', 'Tab strip');

  let tabMenuEl = null;
  const tabMenuClose = () => { if (tabMenuEl) { tabMenuEl.remove(); tabMenuEl = null; } };
  function tabMenu(t, x, y) {
    tabMenuClose();
    const m = document.createElement('div');
    m.className = 'dtmenu';
    m.setAttribute('role', 'menu');
    const item = (label, run, why) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      if (why) { b.disabled = true; b.title = why; }
      b.onclick = () => { tabMenuClose(); run(); };
      m.append(b);
    };
    const g = groupOf(t);
    item(t.pinned ? 'Unpin' : 'Pin', () => { t.pinned = !t.pinned; tabsChanged(); });
    item('Close', () => closeTab(t.id));
    item('Close others', async () => {
      for (const o of g.tabs.filter((x) => x !== t)) await closeTab(o.id);
    });
    item('Move to new group right', () => gSplitWith(g, 'r', t), splitWhy(g, 'r'));
    item('Move to new group below', () => gSplitWith(g, 'd', t), splitWhy(g, 'd'));
    m.style.left = x + 'px';
    m.style.top = y + 'px';
    document.body.append(m);
    tabMenuEl = m;
    m.querySelector('button').focus();
  }
  addEventListener('mousedown', (e) => {
    if (tabMenuEl && !tabMenuEl.contains(e.target)) tabMenuClose();
  }, true);
  addEventListener('keydown', (e) => {
    if (tabMenuEl && e.key === 'Escape') { tabMenuClose(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      if (activeTab) closeTab(activeTab.id);
    } else if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      tabCycle(e.shiftKey ? -1 : 1);
    } else if (e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      && !(e.target.closest && e.target.closest('input, textarea, select, [contenteditable]'))) {
      e.preventDefault();
      if (e.key === 'ArrowLeft') tabBack(); else tabFwd();
    }
  });
  const tabLink = (el, kind, key, opts = {}) => {
    const go = (e) => { e.preventDefault(); openIn(kind, key, { ...opts, ev: e }); };
    el.onclick = go;
    el.onauxclick = (e) => { if (e.button === 1) go(e); };
  };

  window.latTabs = {
    openIn, switchTab, closeTab, tabBack, tabFwd,
    list: () => tabs.map(({ id, kind, key, ship, pinned }) => ({ id, kind, key, ship, pinned })),
    state: () => ({
      tabs: tabs.map(({ id, kind, key, ship, pinned, snap }) =>
        ({ id, kind, key, ship, pinned, dirty: !!(snap && snap.dirty) })),
      active: tabs.indexOf(activeTab),
      shows: !!activeTab && TAB_KINDS[activeTab.kind].shows(activeTab),
    }),
    groups: () => groups.map((g) => ({
      id: g.id,
      focus: g === focusG,
      active: g.tabs.indexOf(gFront(g)),
      tabs: g.tabs.map((t) => ({ id: t.id, kind: t.kind, key: t.key,
        dirty: t === activeTab ? dirty === true : !!(t.snap && t.snap.dirty) })),
    })),
    focus: (i) => gFocus(groups[i]),
    move: (id, i, at = null) => {
      const t = allTabs().find((x) => x.id === id);
      return t && groups[i] ? gMove(t, groups[i], at) : Promise.resolve(false);
    },
  };

// ── src/22-listedit.js ────────────────────────────────────────────────────
  const listEnter = (value, selStart, selEnd, flavor) => {
    const TAB = 4;
    const width = (s) => s.replace(/\t/g, ' '.repeat(TAB)).length;
    const ITEM = /^([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;
    const parse = (ln) => {
      const m = ln.match(ITEM);
      if (!m) return null;
      return {
        len: m[0].length, indent: m[1], bullet: m[2] || '',
        num: m[3] ? parseInt(m[3], 10) : null, delim: m[4] || '',
        gap: m[5], task: m[6] || '', w: width(m[1]),
      };
    };
    const before = value.slice(0, selStart);
    const fences = before.match(/^[ \t]*(?:```|~~~)/gm);
    if (fences && fences.length % 2 === 1) return null;

    if (flavor === 'gmi') {
      const gLineStart = before.lastIndexOf('\n') + 1;
      let gLineEnd = value.indexOf('\n', selEnd);
      if (gLineEnd === -1) gLineEnd = value.length;
      const g = value.slice(gLineStart, gLineEnd).match(/^\* +/);
      if (!g) return null;
      if (selStart < gLineStart + g[0].length) return null;   // caret in the marker
      if (!value.slice(gLineStart, gLineEnd).slice(g[0].length).trim()) {
        return { from: gLineStart, to: gLineEnd, text: '', caret: gLineStart };
      }
      const gText = '\n' + g[0];
      return { from: selStart, to: selEnd, text: gText, caret: selStart + gText.length };
    }

    const lineStart = before.lastIndexOf('\n') + 1;
    let lineEnd = value.indexOf('\n', selEnd);
    if (lineEnd === -1) lineEnd = value.length;
    const cur = parse(value.slice(lineStart, lineEnd));
    if (!cur) return null;
    if (selStart < lineStart + cur.len) return null;

    const lines = value.split('\n');
    const curIdx = before.split('\n').length - 1;

    let lastIdx = curIdx;
    for (let i = curIdx + 1; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.trim()) continue;                 // blank: might be a loose list
      const p = parse(ln);
      const lead = width(ln.match(/^[ \t]*/)[0]);
      if (!p && lead <= cur.w) break;           // ordinary paragraph, list over
      if (p && p.w < cur.w) break;              // stepped out to a parent level
      lastIdx = i;
    }

    const content = value.slice(lineStart, lineEnd).slice(cur.len);
    if (!content.trim()) {
      for (let i = curIdx - 1; i >= 0 && cur.w > 0; i--) {
        const p = parse(lines[i]);
        if (!p || p.w >= cur.w) continue;
        const marker = p.bullet
          ? p.bullet + ' '
          : String((p.num || 0) + 1) + p.delim + ' ';
        const text = p.indent + marker + (p.task ? '[ ] ' : '');
        return { from: lineStart, to: lineEnd, text, caret: lineStart + text.length };
      }
      return { from: lineStart, to: lineEnd, text: '', caret: lineStart };
    }

    if (cur.bullet) {
      const text = '\n' + cur.indent + cur.bullet + cur.gap + (cur.task ? '[ ] ' : '');
      return { from: selStart, to: selEnd, text, caret: selStart + text.length };
    }

    const sibs = [];
    for (let i = curIdx; i >= 0; i--) {
      const p = parse(lines[i]);
      if (!p) { if (lines[i].trim() && width(lines[i].match(/^[ \t]*/)[0]) <= cur.w) break; continue; }
      if (p.w < cur.w) break;
      if (p.w === cur.w) { if (!p.num) break; sibs.unshift(p.num); }
    }
    for (let i = curIdx + 1; i <= lastIdx; i++) {
      const p = parse(lines[i]);
      if (!p) continue;
      if (p.w === cur.w) { if (!p.num) break; sibs.push(p.num); }
    }
    const lazy = sibs.length > 1 && sibs.every((n) => n === sibs[0]);
    const nextNum = lazy ? cur.num : cur.num + 1;
    const marker = cur.indent + nextNum + cur.delim + cur.gap + (cur.task ? '[ ] ' : '');

    const blockEnd = Math.max(selEnd, lines.slice(0, lastIdx + 1).join('\n').length);
    const tail = value.slice(selEnd, blockEnd).split('\n');
    if (!lazy) {
      let n = nextNum;
      for (let i = 1; i < tail.length; i++) {
        const p = parse(tail[i]);
        if (!p) continue;
        if (p.w < cur.w) break;
        if (p.w > cur.w) continue;              // a sub-list numbers itself
        if (!p.num) break;                      // marker changed, new list
        n += 1;
        tail[i] = p.indent + n + p.delim + p.gap + p.task + tail[i].slice(p.len);
      }
    }
    const text = '\n' + marker + tail.join('\n');
    return { from: selStart, to: blockEnd, text, caret: selStart + 1 + marker.length };
  };

  const listTab = (value, selStart, selEnd, flavor, dir) => {
    if (flavor === 'gmi') return null;
    const ITEM = /^([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)/;
    const lineStart = value.slice(0, selStart).lastIndexOf('\n') + 1;
    const fences = value.slice(0, lineStart).match(/^[ \t]*(?:```|~~~)/gm);
    if (fences && fences.length % 2 === 1) return null;

    const effEnd = selEnd > selStart && value[selEnd - 1] === '\n' ? selEnd - 1 : selEnd;
    let spanEnd = value.indexOf('\n', Math.max(effEnd, selStart));
    if (spanEnd === -1) spanEnd = value.length;
    const span = value.slice(lineStart, spanEnd).split('\n');

    if (!span.some((ln) => ITEM.test(ln))) return null;

    let firstDelta = 0;   // how the FIRST line's start moved, for the caret
    const out = span.map((ln, i) => {
      if (!ITEM.test(ln)) return ln;
      if (dir > 0) {
        if (i === 0) firstDelta = 2;
        return '  ' + ln;
      }
      const cut = ln.startsWith('\t') ? 1 : Math.min(2, (ln.match(/^ */) || [''])[0].length);
      if (i === 0) firstDelta = -cut;
      return ln.slice(cut);
    });
    const text = out.join('\n');
    if (text === value.slice(lineStart, spanEnd)) return null;   // nothing to take out

    if (selStart === selEnd) {
      const caret = Math.max(lineStart, selStart + firstDelta);
      return { from: lineStart, to: spanEnd, text, caret };
    }
    return { from: lineStart, to: spanEnd, text, caret: lineStart, caretEnd: lineStart + text.length };
  };

// ── src/23-tabhead.js ─────────────────────────────────────────────────────

  const KINDS = ['md', 'gmi', 'html', 'text', 'js', 'css', 'tex', 'fodt', 'hoon'];
  const tabHead = document.createElement('div');
  tabHead.id = 'tabhead';
  tabHead.className = 'tabhead';
  tabHead.innerHTML =
    sbtn('id="tback" data-action="tback"', 'left', 'Back', 'Alt+Left') +
    sbtn('id="tfwd" data-action="tfwd"', 'right', 'Forward', 'Alt+Right') +
    '<button type="button" id="tpath" class="tpath" data-action="tpath"></button>' +
    '<div id="tread" class="tread" role="group" aria-label="Edit or Read">' +
      '<button type="button" data-r="0" data-action="edit">' + ico('pen') + 'Edit</button>' +
      '<button type="button" data-r="1" data-action="read">' + ico('eye') + 'Read</button>' +
    '</div>' +
    sbtn('id="save"', 'save', 'Save', 'Ctrl+S') +
    sbtn('id="tmenu" data-action="tmenu" aria-haspopup="menu"', 'dots', 'Page menu') +
    `<span id="tholder" hidden>
  <input id="pname" autocomplete="off" spellcheck="false">
  <select id="pkind">${KINDS.map((k) => `<option value="${k}">${k}</option>`).join('')}</select>
  <!-- LaTeX conversion runs on the user's own machine (71-latex.js); the
       page menu's Convert to HTML clicks this -->
  <button type="button" id="texconv" hidden>convert to html</button>
</span>`;
  $('docarea').before(tabHead);
  pname = $('pname'); pkind = $('pkind');
  for (const b of $('tread').children) b.title = 'Edit / Read (Ctrl+E)';
  $('tback').onclick = () => tabBack();
  $('tfwd').onclick = () => tabFwd();
  $('tpath').onclick = () => { if (docFront()) $('mv').click(); };
  clickAction('tback', 'Back', 'Tab header', 'Alt+Left');
  clickAction('tfwd', 'Forward', 'Tab header', 'Alt+Right');
  clickAction('tpath', 'Move or rename', 'Tab header');
  clickAction('edit', 'Edit', 'Tab header', 'Ctrl+E');
  clickAction('read', 'Read', 'Tab header', 'Ctrl+E');
  clickAction('tmenu', 'Page menu', 'Tab header');

  function applyRead() {
    const on = !!(activeTab && activeTab.read);
    const was = ws.classList.contains('ve');
    ws.classList.toggle('ve', !on);
    ws.classList.toggle('vp', on);
    for (const b of $('tread').children) {
      const p = (b.dataset.r === '1') === on;
      b.classList.toggle('on', p);
      b.setAttribute('aria-pressed', p ? 'true' : 'false');
    }
    if (on && was) showPreview();
    if (window.latVimSetInd) window.latVimSetInd();
  }
  function setRead(on) {
    if (!activeTab || !docFront()) return;
    activeTab.read = !!on;
    tabsSave();
    applyRead();
  }
  for (const b of $('tread').children) b.onclick = () => setRead(b.dataset.r === '1');
  const toggleRead = () => setRead(!(activeTab && activeTab.read));
  window.latSetRead = setRead;
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'e' || e.key === 'E')
      && !(localStorage.edVim === '1' && document.activeElement === src)) {
      e.preventDefault();
      toggleRead();
    }
  }, true);

  function paintPath() {
    const tool = !docFront();
    const v = tool ? TAB_KINDS[activeTab.kind].label(activeTab) : (pname.value || '').trim();
    const p = $('tpath');
    p.disabled = tool;
    p.textContent = v || 'no page open';
    p.classList.toggle('muted', !v);
    p.title = v && !tool ? v + ' · ' + (pkind.value || '') : '';
  }
  pname.addEventListener('input', paintPath);
  pkind.addEventListener('change', paintPath);

  function paintHead() {
    const tool = !docFront();
    $('tread').hidden = tool;
    $('tmenu').hidden = tool;
    $('ws').classList.toggle('grubfront', !!activeTab && activeTab.kind === 'grub');
    if (pmenuEl && pmenuTab !== activeTab) pmenuClose();
    for (const [id, st_] of [['tback', 'back'], ['tfwd', 'fwd']]) {
      const off = !activeTab || !activeTab[st_].length;
      const b = $(id);
      b.disabled = off;
      b.setAttribute('aria-disabled', off ? 'true' : 'false');
    }
    paintPath();
    applyRead();
    toolSync();
    paintLink();      // the Page tab's link section follows the tab in front
  }

  let pmenuEl = null;
  let pmenuTab = null;   // the tab the open menu was made for
  const pmenuClose = () => { if (pmenuEl) { pmenuEl.remove(); pmenuEl = null; } };

  async function dupPage() {
    if (!current || grubPath || mode === 'know' || curFolder !== null) return;
    writerSync();
    const body = src.value;
    const kind = pkind.value;
    const picked = await askName('duplicate ' + current + ' as:', current + '-copy', 'create');
    if (!picked) return;
    const rn = realName(picked);
    if (!rn) { st('bad name — use at least one letter or digit', false); return; }
    if (!(await guardDirty())) return;
    newFile('', false);
    newRn = rn;
    pkind.value = kind;
    setOpen(null, { shown: rn.name });
    src.value = body;
    render();
    await save();
  }

  const DLEXT = { text: 'txt' };
  function downloadDoc() {
    if (!current || grubPath || curFolder !== null) return;
    writerSync();
    const kind = mode === 'know' ? 'md' : (pkind.value || 'md');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([src.value], { type: 'text/plain' }));
    a.download = current.split('/').pop() + '.' + (DLEXT[kind] || kind);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function pmenuHas() {
    const doc = !grubPath && curFolder === null;       // a page or a memory
    const page = doc && mode !== 'know';
    const has = new Set(['wrap']);
    if (page) has.add('kind');
    if (page && current) { has.add('dup'); has.add('raw'); has.add('link'); }
    if (grubUrb()) has.add('link');
    if (doc && current) { has.add('download'); has.add('del'); }
    if (doc && current && PDF_KINDS.includes(mode === 'know' ? 'md' : pkind.value)) has.add('pdf');
    if (page && linkOf(current)) has.add('linkback');
    if (!grubPath && curFolder !== null) has.add('del');
    if (page && window.__TAURI__ && (curKind === 'tex' || pkind.value === 'tex')) has.add('tex');
    if (fodtHere()) { has.add('source'); if (wr && wr.macros) has.add('macros'); }
    return has;
  }
  function pageMenu() {
    if (pmenuEl) { pmenuClose(); return; }
    const t = activeTab;
    if (!t) return;
    const has = pmenuHas();
    const m = document.createElement('div');
    m.className = 'dtmenu tmenu';
    m.setAttribute('role', 'menu');
    const item = (id, label, run, checked) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', checked === undefined ? 'menuitem' : 'menuitemcheckbox');
      if (checked !== undefined) b.setAttribute('aria-checked', checked ? 'true' : 'false');
      b.dataset.mi = id;
      b.dataset.action = 'pm-' + id;
      b.textContent = label;
      b.onclick = () => run(b);
      m.append(b);
      return b;
    };
    const done = (fn) => () => { pmenuClose(); fn(); };
    if (has.has('kind')) {
      const sub = document.createElement('div');
      sub.className = 'tsub';
      sub.hidden = true;
      for (const k of KINDS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', k === pkind.value ? 'true' : 'false');
        b.dataset.kind = k;
        b.textContent = k;
        b.onclick = () => {
          pmenuClose();
          if (pkind.value === k) return;
          if (!kindSwitchOk(k)) return;
          pkind.value = k;
          pkind.dispatchEvent(new Event('change'));
        };
        sub.append(b);
      }
      item('kind', 'Kind ▸', () => { sub.hidden = !sub.hidden; });
      m.append(sub);
    }
    item('wrap', 'Line wrap', done(() => flip('appWrap')), localStorage.appWrap === '1');
    if (has.has('source')) item('source', 'Source', done(() => writerSource(!writerSourceOn())), writerSourceOn());
    if (has.has('macros')) item('macros', 'Contains macros, never run here', () => {}).disabled = true;
    if (has.has('link')) item('link', 'Copy link', done(() => copyLink(grubUrb() || pageUrb(current))));
    if (has.has('dup')) item('dup', 'Duplicate', done(dupPage));
    if (has.has('download')) item('download', 'Download', done(downloadDoc));
    if (has.has('pdf')) item('pdf', 'Export PDF', done(exportOpenPdf));
    if (has.has('tex')) item('tex', 'Convert to HTML', done(() => $('texconv').click())).title =
      $('texconv').title;
    if (has.has('raw')) item('raw', 'Open raw', done(() =>
      window.open(api + '/page-source?name=' + encodeURIComponent(current), '_blank', 'noopener')));
    if (has.has('linkback'))
      item('linkback', 'Move back to shared with me', done(() => linkBack(current)));
    if (has.has('del')) item('del', 'Delete', done(() => $('del').click()));
    const r = $('tmenu').getBoundingClientRect();
    m.style.top = r.bottom + 4 + 'px';
    m.style.right = Math.max(4, innerWidth - r.right) + 'px';
    document.body.append(m);
    pmenuEl = m;
    pmenuTab = t;
    m.querySelector('button').focus();
  }
  $('tmenu').onclick = pageMenu;
  for (const [id, name] of [['kind', 'Change page kind'], ['wrap', 'Line wrap'], ['source', 'Source view'],
    ['link', 'Copy link'], ['dup', 'Duplicate page'], ['download', 'Download'], ['pdf', 'Export PDF'], ['tex', 'Convert to HTML'],
    ['raw', 'Open raw'], ['linkback', 'Move back to shared with me'], ['del', 'Delete']]) {
    if (id === 'tex' && !window.__TAURI__) continue;
    action({ id: 'pm-' + id, name, home: 'Page menu',
      when: () => docFront() && pmenuHas().has(id),
      run: () => {
        pmenuClose();
        pageMenu();
        const b = pmenuEl && pmenuEl.querySelector('[data-mi="' + id + '"]');
        if (b) b.click();
      } });
  }
  addEventListener('mousedown', (e) => {
    if (pmenuEl && !pmenuEl.contains(e.target) && !$('tmenu').contains(e.target)) pmenuClose();
  }, true);
  addEventListener('keydown', (e) => {
    if (pmenuEl && e.key === 'Escape') { pmenuClose(); $('tmenu').focus(); }
  });

// ── src/24-tools.js ───────────────────────────────────────────────────────
  const allFrames = () => [...document.querySelectorAll('.toolhost iframe[data-tool]')];
  const frameOf = (key) => allFrames().find((f) => f.dataset.tool === key);
  const toolStash = document.createElement('div');
  toolStash.hidden = true;
  document.body.append(toolStash);

  const TOOLS = {
    inbox: { name: 'Inbox', icon: 'inbox', wrap: 'cmwrap', load: () => cmLoad() },
    access: { name: 'Access & groups', icon: 'key', wrap: 'aclwrap', load: () => aclLoad() },
    conflicts: { name: 'Sync conflicts', icon: 'conflict', wrap: 'cfwrap', load: () => renderConflicts() },
  };
  const FRAMES = {
    '/apps/lattice/settings': ['Settings', 'gear'],
    '/apps/lattice/know?lint=1': ['Memory review', 'tidy'],
    '/apps/lattice': ['Browser', 'globe'],
    '/apps/lattice/forum': ['Forum', 'forum'],
    '/apps/lattice/x': ['Explorer', 'tree'],
  };
  const FRAME_KEYS = {
    settings: 'frame:/apps/lattice/settings',
    forum: 'frame:/apps/lattice/forum',
    explorer: 'frame:/apps/lattice/x',
  };
  const SETTINGS = FRAME_KEYS.settings;
  const frameUrl = (key) => {
    if (!key.startsWith('frame:')) return null;
    let u;
    try { u = new URL(key.slice(6), location.origin); } catch { return null; }
    if (u.origin !== location.origin || !/^\/apps\/lattice(\/|$)/.test(u.pathname)) return null;
    return u.pathname + u.search;
  };
  const SINGLE = ['/apps/lattice/settings', '/apps/lattice/know?lint=1'];
  const browsing = (key) => { const u = frameUrl(key); return !!u && !SINGLE.includes(u); };
  const toolMeta = (key) => {
    if (TOOLS[key]) return [TOOLS[key].name, TOOLS[key].icon];
    const u = frameUrl(key);
    return u ? FRAMES[u] || ['Browser', 'globe'] : [key, 'gear'];
  };
  const toolOpen = async (id) => {
    await openIn('tool', FRAME_KEYS[id] || id, { newTab: true });
    drawersClose();
  };
  const browseIn = async (url = '/apps/lattice') => {
    await openIn('tool', 'frame:' + url + '#b' + Date.now().toString(36)
      + (++browseSeq), { newTab: true });
    drawersClose();
  };
  let browseSeq = 0;

  let toolShown = null;
  const frameTitles = {};
  const frameSeenAll = new Set();
  TAB_KINDS.tool = {
    icon: (t) => toolMeta(t.key)[1],
    label: (t) => (browsing(t.key) && frameTitles[t.key]) || toolMeta(t.key)[0],
    open: async (t) => {
      toolSync();
      if (TOOLS[t.key]) TOOLS[t.key].load();
      return true;
    },
    restore: () => {},
    park: async () => true,
    shows: (t) => t === activeTab && toolShown === t.key,
    held: (t) => frameTyped(t.key),
  };
  const TEXTY = ['text', 'search', 'url', 'email', 'tel', 'number'];
  function frameTyped(key) {
    const f = frameOf(key);
    let d = null;
    try { d = f && f.contentDocument; } catch {}
    if (!d) return false;
    const docs = [d];
    for (const i of d.querySelectorAll('iframe')) {
      try { if (i.contentDocument) docs.push(i.contentDocument); } catch {}
    }
    return docs.some((doc) => [...doc.querySelectorAll('textarea, input')].some((el) =>
      !el.closest('form.bar') && !el.disabled && !el.readOnly
      && (el.tagName === 'TEXTAREA' || TEXTY.includes(el.type))
      && el.value.trim() !== '' && el.value !== el.defaultValue));
  }

  function toolSync() {
    const t = activeTab && activeTab.kind === 'tool' ? activeTab : null;
    const was = toolShown;
    toolShown = t ? t.key : null;
    $('docarea').hidden = !!t;
    const open = allTabs();
    for (const f of allFrames())
      if (!open.some((x) => x.kind === 'tool' && x.key === f.dataset.tool)) {
        delete frameTitles[f.dataset.tool];
        delete fnav[f.dataset.tool];
        f.remove();
      }
    if (document.querySelector('.toolhost iframe[data-kept]')) fkeepTrim();
    for (const f of frameSeenAll)
      if (!f.isConnected) { frameSeen.unobserve(f); frameSeenAll.delete(f); }
    for (const g of groups) {
      const f = gFront(g);
      const key = f && f.kind === 'tool' ? f.key : null;
      g.host.hidden = !key;
      if (key) toolMount(key, g.host);
      for (const c of g.host.children) c.hidden = c.dataset.tool !== key;
      frameBusySync(g.host);
      fhSync(g, key);
    }
    $('tabhead').hidden = !!t && browsing(t.key);
    for (const c of [...document.querySelectorAll('.toolhost > .intab')])
      if (!groups.some((g) => c.parentNode === g.host && !c.hidden)) { c.hidden = true; toolStash.append(c); }
    if (was !== toolShown) rpSoon();
  }
  const frameSeen = new ResizeObserver((es) => {
    for (const { target: f } of es) frameSeenOne(f);
  });
  function frameSeenOne(f) {
    const on = f.isConnected && f.getClientRects().length > 0;
    if (f.latOn === on) return;
    const wait = on ? (f.latQuiet || 0) - Date.now() : 0;
    if (wait > 0) { clearTimeout(f.latQuietT); f.latQuietT = setTimeout(() => frameSeenOne(f), wait); return; }
    f.latOn = on;
    try { f.contentWindow.dispatchEvent(new f.contentWindow.Event(on ? 'latshown' : 'lathidden')); }
    catch {}
  }
  function toolMount(key, toolHost) {
    if (TOOLS[key]) {
      const w = $(TOOLS[key].wrap);
      if (!w) return;
      w.classList.add('intab');
      w.dataset.tool = key;
      if (w.parentNode !== toolHost) toolHost.append(w);
      return;
    }
    const url = frameUrl(key);
    const had = frameOf(key);
    if (had) {
      if (had.parentNode !== toolHost) { fkeepDropKey(key); frameLoading(had, true); toolHost.append(had); }
      return;
    }
    if (!url) return;
    toolHost.append(frameMake(key, url));
  }
  function frameMake(key, url) {
    const f = document.createElement('iframe');
    f.className = 'toolframe';
    f.dataset.tool = key;
    f.title = toolMeta(key)[0];
    f.name = 'latframe' + (++frameSeq);
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups '
      + 'allow-popups-to-escape-sandbox allow-modals allow-downloads');
    f.onload = () => {
      frameLoading(f, false);
      if (Date.now() - (f.latAct || 0) < 10000) bgBusy();
      fnavLoad(f); frameDress(f);
    };
    frameLoading(f, true);
    f.src = url;
    frameSeen.observe(f);
    frameSeenAll.add(f);
    return f;
  }
  let frameSeq = 0;
  function frameLoading(f, on) {
    clearTimeout(f.latLoadT); clearTimeout(f.latLoadCap);
    f.latLoadAt = on ? Date.now() : 0;
    if (on) {
      f.latLoadT = setTimeout(() => { frameBusySync(f.parentNode); frameTabSync(f.dataset.tool); }, BUSY_MS);
      f.latLoadCap = setTimeout(() => frameLoading(f, false), BUSY_MAX);
    }
    frameBusySync(f.parentNode);
    frameTabSync(f.dataset.tool);
  }
  const frameSlow = (key) => {
    const f = frameOf(key);
    return !!(f && f.latLoadAt && Date.now() - f.latLoadAt >= BUSY_MS - 10);
  };
  function frameTabSync(key) {
    if (!key) return;
    const on = frameSlow(key);
    for (const b of document.querySelectorAll('.dtab[data-kind="tool"]'))
      if (b.dataset.key === key) b.classList.toggle('lload', on);
  }
  const linkLeaves = (a, target, e) => e.button === 0 && !e.ctrlKey && !e.metaKey
    && !e.shiftKey && !e.altKey && !a.hasAttribute('download')
    && !/^_blank$/i.test(target || '') && /^https?:/.test(a.href)
    && !(a.hash && a.href.split('#')[0] === a.ownerDocument.URL.split('#')[0]);
  function frameBusySync(host) {
    if (!host || !host.classList || !host.classList.contains('toolhost')) return;
    const now = Date.now();
    const on = [...host.children].some((c) => c.tagName === 'IFRAME' && c.dataset.tool
      && !c.hidden && c.latLoadAt && now - c.latLoadAt >= BUSY_MS - 10);
    host.classList.toggle('lbusy', on);
  }
  function frameDress(f) {
    let d = null;
    try { d = f.contentDocument; } catch {}
    if (!d || !d.head) return;
    const key = f.dataset.tool || f.dataset.kept;
    if (!editorGo(d.URL)) delete f.dataset.latEd;
    frameTheme(f);
    new MutationObserver(() => frameTheme(f))
      .observe(d.documentElement, { attributes: true, attributeFilter: ['style'] });
    const s = d.createElement('style');
    s.textContent = 'form.bar,form.cbar{display:none}';
    d.head.append(s);
    if (browsing(key)) {
      const title = () => {
        if (f.dataset.tool !== key) return;
        const t = d.title.trim();
        if (!t || frameTitles[key] === t) return;
        frameTitles[key] = t;
        paintTabs();
      };
      title();
      new MutationObserver(title).observe(d.head, { childList: true, subtree: true, characterData: true });
    }
    const topish = (el, at) => !!el && /^_(top|parent)$/i.test(el.getAttribute(at) || '');
    const upward = (el, at) => topish(el, at) || (!!el && el.getAttribute(at) === f.name);
    const aimTop = (doc, inner) => {
      if (doc.latAimed) return;
      doc.latAimed = true;
      const act = () => { f.latAct = Date.now(); bgBusy(); };
      for (const t of ['pointerdown', 'keydown', 'input', 'click']) doc.addEventListener(t, act, true);
      for (const el of doc.querySelectorAll('[target=_top], [target=_parent]')) el.target = f.name;
      const on = inner ? (doc.defaultView || doc) : doc;
      on.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href], area[href]');
        if (!a) return;
        if (inner && !e.defaultPrevented) {
          const go = editorGo(a.href);
          if (go) { e.preventDefault(); editorOpen(go); return; }
          if (upward(a, 'target')) {
            e.preventDefault();
            if (/^https?:/.test(a.href)) { frameLoading(f, true); f.contentWindow.location.assign(a.href); }
          }
          return;
        }
        if (topish(a, 'target')) a.target = f.name;
      }, !inner);
      on.addEventListener('submit', (e) => {
        const form = e.target;
        const sub = e.submitter;
        if (inner) {
          const up = sub && sub.hasAttribute('formtarget') ? upward(sub, 'formtarget') : upward(form, 'target');
          if (!up || e.defaultPrevented) return;
          e.preventDefault();
          if (commentSend(f, form, sub)) return;
          frameLoading(f, true);
          formAgain(form, sub, f.name);
          return;
        }
        if (upward(form, 'target') && commentSend(f, form, sub)) { e.preventDefault(); return; }
        if (topish(form, 'target')) form.target = f.name;
        if (topish(sub, 'formtarget')) sub.formTarget = f.name;
      }, !inner);
    };
    aimTop(d, false);
    if (browsing(key)) fkeepWatch(f, d, key);
    const nav = d.defaultView && d.defaultView.navigation;
    if (nav) {
      nav.addEventListener('navigate', (e) => {
        if (e.defaultPrevented || e.destination.sameDocument || e.downloadRequest !== null) return;
        if (f.dataset.tool) frameLoading(f, true);
      });
      nav.addEventListener('navigateerror', () => frameLoading(f, false));
    } else if (d.defaultView) {
      d.defaultView.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href]');
        if (a && !e.defaultPrevented && linkLeaves(a, a.target, e)) frameLoading(f, true);
      });
      d.defaultView.addEventListener('submit', (e) => {
        if (!e.defaultPrevented && !/^_blank$/i.test(e.target.getAttribute('target') || '')) frameLoading(f, true);
      });
      d.defaultView.addEventListener('beforeunload', () => { if (f.dataset.tool) frameLoading(f, true); });
    }
    for (const i of d.querySelectorAll('iframe')) {
      const inner = () => { try { if (i.contentDocument) aimTop(i.contentDocument, true); } catch {} };
      inner();
      i.addEventListener('load', inner);
    }
    d.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const ours = (mod && !e.altKey && !e.shiftKey && (k === 'k' || k === 'p' || k === ','))
        || (mod && e.shiftKey && !e.altKey && (k === 'f' || e.code === 'KeyL'));
      if (!ours) return;
      const up = new KeyboardEvent('keydown', { key: e.key, code: e.code, ctrlKey: e.ctrlKey,
        metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true });
      dispatchEvent(up);
      if (up.defaultPrevented) e.preventDefault();
    });
    d.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || e.defaultPrevented) return;
      if (a.dataset.latTool && FRAME_KEYS[a.dataset.latTool]) {
        e.preventDefault();
        toolOpen(a.dataset.latTool);
        return;
      }
      const set = settingsAt(a.href);
      if (set !== null && key !== SETTINGS) {
        e.preventDefault();
        latOpenSettings(set || undefined);
        return;
      }
      const go = editorGo(a.href);
      if (!go) return;
      e.preventDefault();
      editorOpen(go);
    });
  }
  function settingsAt(href) {
    let u;
    try { u = new URL(href, location.href); } catch { return null; }
    if (u.origin !== location.origin || !/^\/apps\/lattice\/settings\/?$/.test(u.pathname)) return null;
    return decodeURIComponent(u.hash.slice(1));
  }
  function editorGo(href) {
    let u;
    try { u = new URL(href, location.href); } catch { return null; }
    if (u.origin !== location.origin || !/^\/apps\/lattice\/(app|edit)\/?$/.test(u.pathname)) return null;
    const q = u.searchParams;
    return q.get('grub') ? ['grub', q.get('grub'), q.get('ship') || null]
      : q.get('view') === 'know' ? ['know', q.get('key') || '', null]
        : q.get('name') ? ['page', q.get('name'), null]
          : q.get('into') ? ['into', q.get('into')] : ['shell'];
  }
  async function editorOpen(go) {
    if (go[0] === 'into') {
      if (!(await docTab())) return;
      if (nodes.some((n) => !n.page && n.path === go[1])) selectFolder(go[1]);
      else newFile(go[1], false);
      return;
    }
    if (go[0] === 'shell') {
      const i = tabs.indexOf(activeTab);
      const docs = tabs.filter((t) => t.kind !== 'tool');
      const near = docs.filter((t) => tabs.indexOf(t) < i).pop() || docs[0];
      if (near) await switchTab(near.id);
      else await docTab();
      return;
    }
    await openIn(go[0], go[1], { ship: go[2], newTab: true });
  }
  window.latFrameEditor = (href, from) => {
    let w = from;
    try { while (w && w.parent !== window) w = w === w.parent ? null : w.parent; } catch { w = null; }
    const f = w && allFrames().find((x) => x.contentWindow === w);
    if (!f || f.hidden || f.closest('.toolhost').hidden) return false;
    const go = editorGo(href);
    if (!go) return false;
    editorOpen(go);
    return true;
  };
  function commentSend(f, form, sub) {
    const attr = (k, fk) => (sub && sub.hasAttribute(fk) ? sub.getAttribute(fk) : form.getAttribute(k)) || '';
    if (!form.matches('form.cbox') || !/^post$/i.test(attr('method', 'formmethod'))
      || /multipart/i.test(attr('enctype', 'formenctype'))) return false;
    let url;
    try { url = new URL(attr('action', 'formaction') || form.ownerDocument.URL, form.baseURI); } catch { return false; }
    if (url.origin !== location.origin || !/^\/apps\/lattice\/comment(-remote)?$/.test(url.pathname)) return false;
    const d = form.ownerDocument;
    if (form.latSending) return true;
    form.latSending = true;
    let fd;
    try { fd = new FormData(form, sub || undefined); }
    catch { fd = new FormData(form); if (sub && sub.name) fd.append(sub.name, sub.value); }
    const body = new URLSearchParams();
    for (const [k, v] of fd) if (typeof v === 'string') body.append(k, v);
    form.setAttribute('aria-busy', 'true');
    const btns = [...form.querySelectorAll('button:not([type=button]), input[type=submit]')].filter((b) => !b.disabled);
    for (const b of btns) { b.disabled = true; b.setAttribute('data-lat-off', ''); }
    const old = d.getElementById('latcerr');
    if (old) old.remove();
    frameLoading(f, true);
    const done = (why) => {
      form.latSending = false;
      form.removeAttribute('aria-busy');
      form.removeAttribute('data-lat-sent');
      for (const b of form.querySelectorAll('[data-lat-off]')) { b.disabled = false; b.removeAttribute('data-lat-off'); }
      if (f.dataset.tool) frameLoading(f, false);
      if (!why) return;
      const p = d.createElement('p');
      p.id = 'latcerr';
      p.setAttribute('role', 'alert');
      p.style.cssText = 'margin:.4rem 0 0;color:var(--error,#b3261e);font-size:.9em';
      p.textContent = why;
      form.after(p);
    };
    fetch(url.href, { method: 'POST', body, redirect: 'manual', credentials: 'same-origin' }).then((r) => {
      if (r.type === 'opaqueredirect' || r.ok) {
        for (const t of form.querySelectorAll('textarea')) t.value = '';
        try { f.contentWindow.location.reload(); } catch { done(null); }
        return;
      }
      const said = (j) => (j && typeof j.error === 'string' && j.error.length < 200 ? ': ' + j.error : '');
      r.json().catch(() => null).then((j) => done('Not posted (the ship answered ' + r.status + said(j)
        + '). Your comment is still here.'));
    }, () => done('Not posted: no answer from the ship. Your comment is still here.'));
    return true;
  }
  function formAgain(form, sub, name) {
    const g = document.createElement('form');
    const attr = (k, fk) => (sub && sub.hasAttribute(fk) ? sub.getAttribute(fk) : form.getAttribute(k));
    g.hidden = true;
    g.method = attr('method', 'formmethod') || 'get';
    if (/^dialog$/i.test(g.getAttribute('method'))) return;
    g.enctype = attr('enctype', 'formenctype') || 'application/x-www-form-urlencoded';
    const act = attr('action', 'formaction');
    g.action = act ? new URL(act, form.baseURI).href : form.ownerDocument.URL;
    if (!/^https?:/.test(g.action)) return;
    const cs = form.getAttribute('accept-charset');
    if (cs) g.acceptCharset = cs;
    if (form.hasAttribute('novalidate') || (sub && sub.hasAttribute('formnovalidate'))) g.noValidate = true;
    g.target = name;
    const files = {};
    let fd;
    try { fd = new FormData(form, sub || undefined); }
    catch { fd = new FormData(form); if (sub && sub.name) fd.append(sub.name, sub.value); }
    for (const [k, v] of fd) {
      if (typeof v === 'string') {
        const i = document.createElement('input');
        i.type = 'hidden';
        i.name = k;
        i.value = v;
        g.append(i);
      } else (files[k] = files[k] || []).push(v);
    }
    for (const [k, vs] of Object.entries(files)) {
      const dt = new DataTransfer();
      for (const v of vs) if (v.name || v.size) dt.items.add(v);
      const i = document.createElement('input');
      i.type = 'file';
      i.name = k;
      i.multiple = true;
      i.files = dt.files;
      g.append(i);
    }
    document.body.append(g);
    g.submit();
    g.remove();
  }
  const THEME_KEYS = ['color-scheme', '--bg', '--text', '--muted', '--pop', '--accent',
    '--accent-deep', '--on-accent', '--accent-tint', '--secondary', '--tertiary', '--link',
    '--raised', '--error', '--selection', '--border', '--border-soft', '--font'];
  const darkMq = matchMedia('(prefers-color-scheme: dark)');
  function frameTheme(f) {
    let d = null;
    try { d = f.contentDocument; } catch {}
    if (!d || !d.documentElement) return;
    const hs = document.documentElement.style;
    const cs = getComputedStyle(document.documentElement);
    const fs = d.documentElement.style;
    const shown = {
      'color-scheme': /dark/.test(cs.colorScheme) && (darkMq.matches || !/light/.test(cs.colorScheme))
        ? 'dark' : 'light',
      '--bg': cs.getPropertyValue('--bg').trim(),
      '--text': cs.getPropertyValue('--text').trim(),
    };
    for (const k of THEME_KEYS) {
      const v = hs.getPropertyValue(k).trim() || shown[k] || '';
      if (v && fs.getPropertyValue(k).trim() !== v) fs.setProperty(k, v);
      else if (!v && fs.getPropertyValue(k)) fs.removeProperty(k);
    }
  }
  const framesTheme = () => {
    for (const f of document.querySelectorAll('.toolhost iframe')) frameTheme(f);
  };
  addEventListener('lattheme', framesTheme);
  darkMq.addEventListener('change', framesTheme);
  new MutationObserver(framesTheme)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  addEventListener('keydown', (e) => {
    const a = document.activeElement;
    if (e.key === 'Escape' && a && a !== document.body && a.closest && a.closest('.toolhost')) a.blur();
  });

  const briefForms = (d) => {
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    const p2 = (n) => String(n).padStart(2, '0');
    return ['journal/' + y + '-' + p2(m) + '-' + p2(day),
      'journal/' + y + '.' + m + '.' + day, 'journal/' + y + '.' + p2(m) + '.' + p2(day)];
  };
  const hasPage = (k) => nodes.some((n) => n.page && n.path === k);
  function briefKey(d) {
    const forms = briefForms(d);
    return forms.find(hasPage) || forms[1];
  }
  async function openBrief(ev) {
    const d = new Date();
    let key = briefKey(d);
    let found = hasPage(key);
    if (!nodes.length) {
      for (const k of briefForms(d)) {
        const r = await fetch(api + '/page-source?name=' + encodeURIComponent(k)).catch(() => null);
        if (r && r.ok) { key = k; found = true; break; }
      }
    }
    if (found) return openIn('page', key, { ev });
    await openIn('page', '', { ev });
    if (activeTab && activeTab.kind === 'page' && !activeTab.key && current === null)
      setOpen(null, { shown: key });
  }

  const leaveThen = (go) => tabSerial(async () => {
    if (!(await guardDirty())) return;
    await savesSettled();
    const bg = allTabs().filter((t) => t !== activeTab && t.snap && t.snap.dirty);
    const names = bg.map((t) => TAB_KINDS[t.kind].label(t)).join(', ');
    if (bg.length && autosaveOn()) {
      if (!(await askConfirm('discard unsaved changes to ' + names + '?', 'discard'))) return;
    } else if (bg.length) {
      const pick = await askChoice('unsaved changes to ' + names + '. save them?',
        ['save all', 'discard']);
      if (pick === null) return;
      if (pick === 'save all') {
        for (const t of bg) {
          if ((await tabTo(t)) === false) return;
          if (!(await saveNow())) return;
        }
      }
    }
    dirty = false;
    clearTimeout(autoTimer);
    for (const t of bg) if (t.snap) t.snap.dirty = false;
    await go();
  });
  window.latLeaveThen = (go) => leaveThen(go);
  window.latOpenManager = async (section) => {
    const inv = window.__TAURI__.core.invoke;
    if (await inv('status').then(() => true, () => false))
      return latOpenSettings(section || 'connection');
    return leaveThen(async () => {
      const go = (s) => inv('open_manager', { section: s });
      try { await go(section || null).catch(() => go(null)); }
      catch (e) { st('could not open the desktop settings: ' + e, false); }
    });
  };

  let urbTaking = null, urbAgain = false;
  window.latUrbArrived = () => {
    if (!window.__TAURI__) return Promise.resolve();
    if (urbTaking) { urbAgain = true; return urbTaking; }
    urbTaking = (async () => {
      do {
        urbAgain = false;
        let links = [];
        try { links = await window.__TAURI__.core.invoke('take_urb_links'); } catch { return; }
        for (const u of Array.isArray(links) ? links : [])
          if (typeof u === 'string' && /^urb:\/\/~[a-z-]+\/[^\s?#]+$/.test(u))
            await browseIn('/apps/lattice?url=' + encodeURIComponent(u));
      } while (urbAgain);
    })().finally(() => { urbTaking = null; });
    return urbTaking;
  };

  function frameScroll(f, anchor) {
    let d = null;
    try { d = f.contentDocument; } catch {}
    const e = d && d.getElementById(anchor);
    if (!e) return false;
    e.scrollIntoView({ block: 'start' });
    const ro = new f.contentWindow.ResizeObserver(() => e.scrollIntoView({ block: 'start' }));
    ro.observe(d.body);
    const stop = () => ro.disconnect();
    setTimeout(stop, 2000);
    for (const t of ['wheel', 'keydown', 'pointerdown', 'touchstart'])
      d.addEventListener(t, stop, { once: true });
    return true;
  }
  window.latOpenSettings = async (anchor) => {
    await toolOpen('settings');
    const f = frameOf(SETTINGS);
    if (!f || !anchor) return;
    let ready = false;
    try { ready = f.contentDocument.readyState === 'complete' && f.contentDocument.URL !== 'about:blank'; } catch {}
    if (ready && frameScroll(f, anchor)) return;
    f.addEventListener('load', () => frameScroll(f, anchor), { once: true });
  };

  let paletteOpen = () => {};

  ribbonAdd({ id: 'brief', icon: 'cal', name: "Today's brief", run: (ev) => openBrief(ev) });
  ribbonAdd({ id: 'browser', icon: 'globe', name: 'Browser', run: () => browseIn() });
  ribbonAdd({ id: 'forum', icon: 'forum', name: 'Forum', run: () => toolOpen('forum') });
  ribbonAdd({ id: 'inbox', icon: 'inbox', name: 'Inbox', run: () => toolOpen('inbox') });
  ribbonAdd({ id: 'access', icon: 'key', name: 'Access & groups', run: () => toolOpen('access') });
  ribbonAdd({ id: 'conflicts', icon: 'conflict', name: 'Sync conflicts', run: () => toolOpen('conflicts') })
    .hidden = true;
  ribbonAdd({ id: 'palette', icon: 'term', name: 'Command palette', keys: 'Ctrl+K', run: () => paletteOpen() });
  ribbonAdd({ id: 'settings', icon: 'gear', name: 'Settings', keys: 'Ctrl+,', bottom: true,
    run: () => toolOpen('settings') });
  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key !== ',') return;
    if (!$('dlg').hidden) return;
    e.preventDefault();
    toolOpen('settings');
  }, true);
  action({ id: 'explorer', name: 'Explorer', home: 'Settings › Advanced',
    run: () => toolOpen('explorer') });

// ── src/25-editor.js ──────────────────────────────────────────────────────
  let src, hl;   // assigned when <lat-editor> upgrades (below, synchronously)
  const LMAP = { md: 'markdown', gmi: 'gemtext', html: 'markup',
                 js: 'javascript', css: 'css', hoon: 'hoon', tex: 'latex' };
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const HL_PLAIN = 50, HL_DEADLINE = 1500, HL_STARTUP = 10000;
  let hlWorker = null, hlFresh = false, hlCur = null, hlNext = null, hlPlain = 0, hlKill = 0;
  const hlDone = () => {
    clearTimeout(hlPlain); clearTimeout(hlKill); hlCur = null;
    if (hlNext) { const j = hlNext; hlNext = null; hlRun(j); }
  };
  let hlPainted = () => {};
  const hlPaint = (body) => { hl.innerHTML = esc(body) + '\n'; sync(); hlPainted(); };
  const hlSplice = () => {
    const old = hl.textContent, now = src.value;
    if (!old.endsWith('\n') || old === now + '\n') return;
    const ol = old.length - 1, nl = now.length, m = Math.min(ol, nl);
    let a = 0; while (a < m && old.charCodeAt(a) === now.charCodeAt(a)) a++;
    let z = 0; while (z < m - a && old.charCodeAt(ol - 1 - z) === now.charCodeAt(nl - 1 - z)) z++;
    if (a && (old.charCodeAt(a - 1) & 0xfc00) === 0xd800) a--;
    if (z && (old.charCodeAt(ol - z) & 0xfc00) === 0xdc00) z--;
    const w = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT);
    let n, at = 0, rest = ol - z - a, host = null, hostAt = 0;
    while ((n = w.nextNode())) {
      const len = n.length, end = at + len;
      if (!host && a <= end) { host = n; hostAt = a - at; }
      if (rest > 0 && end > a) {
        const from = Math.max(0, a - at), k = Math.min(rest, len - from);
        if (k > 0) { n.deleteData(from, k); rest -= k; }
      }
      if (host && rest <= 0) break;
      at = end;
    }
    if (host) host.insertData(hostAt, now.slice(a, nl - z));
    hlPainted();
  };
  const hlRun = (job) => {
    if (hlCur) { hlNext = job; hlPaint(job.body); return; }
    if (!hlWorker) {
      try { hlWorker = new Worker('/apps/lattice/prism.js'); } catch { hlPaint(job.body); return; }
      hlFresh = true;
      hlWorker.onmessage = (e) => {
        hlFresh = false;
        const j = hlCur;
        if (j && j.body === src.value && j.lang === LMAP[pkind.value]) {
          hl.innerHTML = e.data + '\n'; sync(); hlPainted();
        } else if (j && !hlNext) {
          hlPaint(src.value);
          scheduleRender();
        }
        hlDone();
      };
      hlWorker.onerror = () => { hlWorker = null; hlDone(); };
    }
    hlCur = job;
    hlPlain = setTimeout(() => { if (job.body === src.value) hlPaint(job.body); }, HL_PLAIN);
    hlKill = setTimeout(() => {
      if (hlWorker) hlWorker.terminate();
      hlWorker = null; hlDone();
    }, HL_DEADLINE + (hlFresh ? HL_STARTUP : 0));
    hlWorker.postMessage(JSON.stringify({ language: job.lang, code: job.body }));
  };
  let rpHook = null;
  const render = () => {
    if (rpHook) rpHook();
    writerFollow();
    if (fodtHere() && !writerSourceOn()) { hl.textContent = ''; return; }
    const lang = LMAP[pkind.value];
    const g = lang && (!window.Prism || Prism.languages[lang]);
    if (!g || typeof Worker === 'undefined') { hl.innerHTML = esc(src.value) + '\n'; hlPainted(); return; }
    hlRun({ body: src.value, lang });
  };
  const sync = () => { hl.scrollTop = src.scrollTop; hl.scrollLeft = src.scrollLeft; };
  let syncRaf = 0;
  const syncSoon = () => {
    if (!syncRaf) syncRaf = requestAnimationFrame(() => { syncRaf = 0; sync(); });
  };
  let hlRaf = 0, hlTimer = 0;
  const scheduleRender = () => {
    if (src.value.length > 60000) {
      clearTimeout(hlTimer);
      hlTimer = setTimeout(() => { render(); sync(); }, 120);
    } else if (!hlRaf) {
      hlRaf = requestAnimationFrame(() => { hlRaf = 0; render(); sync(); });
    }
  };
  const edited = () => src.dispatchEvent(new Event('input'));
  customElements.define('lat-editor', class extends HTMLElement {
    connectedCallback() {
      if (this.built) return;
      this.built = true;
      if (this.hasAttribute('ghost')) {
        this.innerHTML = '<div class="edwrap"><pre class="ehl" aria-hidden="true"></pre>'
          + '<textarea class="esrc" spellcheck="false" readonly></textarea></div>';
        return;
      }
      this.innerHTML = `
<div class="edwrap">
  <div id="acmirror" aria-hidden="true"></div>
  <div id="ac" class="ac" hidden role="listbox" aria-label="page suggestions"></div>
  <pre id="hl" class="ehl" aria-hidden="true"></pre>
  <textarea id="src" class="esrc" spellcheck="false" placeholder="open a page from the tree, or name a new one and start typing"></textarea>
</div>`;
      src = $('src'); hl = $('hl');
      src.addEventListener('input', () => {
        dirty = true;
        everTyped = true;      // never cleared: see 20-state.js
        hlSplice();
        scheduleRender();
        clearTimeout(autoTimer);
        autoTimer = setTimeout(autosave, 2000);
      });
      src.addEventListener('scroll', sync);
    }
  });
  pkind.addEventListener('change', () => {
    if (!kindSwitchOk(pkind.value)) { pkind.value = curKind || (pkind.value === 'fodt' ? 'md' : 'fodt'); return; }
    curKind = pkind.value;
    if (curKind === 'fodt' && !src.value.trim()) writerBlank(); else render();
    if (current) edited();
    refreshTexButton();
  });

// ── src/26-palette.js ─────────────────────────────────────────────────────
  const PALETTE_ONLY = ['explorer'];
  const pal = document.createElement('div');
  pal.id = 'palette';
  pal.className = 'dlg palette';
  pal.hidden = true;
  pal.setAttribute('role', 'dialog');
  pal.setAttribute('aria-modal', 'true');
  pal.setAttribute('aria-label', 'Command palette');
  pal.innerHTML = '<div class="dlgbox palbox">'
    + '<input id="palin" type="text" role="combobox" aria-expanded="true" aria-controls="pallist"'
    + ' aria-autocomplete="list" aria-label="Command palette" placeholder="run an action or open a page"'
    + ' autocomplete="off" spellcheck="false">'
    + '<div id="pallist" class="pallist" role="listbox" aria-label="Results"></div></div>';
  document.body.append(pal);
  const palIn = $('palin'), palList = $('pallist');
  let palRows = [];      // what is on screen: {kind, a?, key?}
  let palSel = 0;
  let palFrom = null;    // focus to hand back on close

  function palScore(q, s) {
    const t = s.toLowerCase();
    const at = t.indexOf(q);
    if (at === 0 || (at > 0 && /[^a-z0-9]/.test(t[at - 1]))) return at / 1e4;
    if (at > 0) return 1 + at / 1e4;
    let i = 0, first = -1, last = -1;
    for (let j = 0; j < t.length && i < q.length; j++) {
      if (t[j] !== q[i]) continue;
      if (first < 0) first = j;
      last = j;
      i++;
    }
    return i === q.length ? 2 + (last - first) / 1e4 : null;
  }
  const palUsable = (a) => {
    if (PALETTE_ONLY.includes(a.id)) return true;
    if (a.when) return a.when();
    const el = actionHome(a.id);
    return !!el && !el.disabled && !el.closest('[hidden]:not([data-pane])');
  };
  const ranked = (q, items, name) => items
    .map((x, i) => ({ x, i, s: palScore(q, name(x)) }))
    .filter((r) => r.s !== null)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((r) => r.x);

  function palPaint() {
    const q = palIn.value.trim().toLowerCase();
    const acts = ACTIONS.filter(palUsable);
    palRows = (q ? ranked(q, acts, (a) => a.name) : acts).map((a) => ({ kind: 'action', a }));
    if (q) {
      const docs = nodes.filter((n) => n.page).map((n) => ({ kind: 'page', key: n.path }))
        .concat(knowKeys.map((k) => ({ kind: 'know', key: k.key.replace(/^\//, '') })));
      palRows = palRows.concat(ranked(q, docs, (d) => d.key).slice(0, 50));
    }
    palSel = 0;
    palList.textContent = '';
    palRows.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'palrow';
      row.id = 'palr' + i;
      row.setAttribute('role', 'option');
      row.dataset.kind = r.kind;
      const name = document.createElement('span');
      name.className = 'palname';
      const home = document.createElement('span');
      home.className = 'palhome muted';
      if (r.kind === 'action') {
        name.textContent = r.a.name;
        home.textContent = r.a.home;
      } else {
        row.dataset.key = r.key;
        name.textContent = r.key;
        home.textContent = r.kind === 'page' ? 'Page' : 'Memory';
      }
      row.append(name, home);
      if (r.kind === 'action' && r.a.keys) {
        const k = document.createElement('kbd');
        k.className = 'palkeys';
        k.textContent = r.a.keys;
        row.append(k);
      }
      row.onmousedown = (e) => e.preventDefault();
      row.onclick = (e) => palRun(i, e);
      palList.append(row);
    });
    if (!palRows.length) {
      const none = document.createElement('div');
      none.className = 'muted palnone';
      none.textContent = 'nothing matches';
      palList.append(none);
    }
    palMark();
  }
  function palMark() {
    palRows.forEach((_, i) => {
      const row = $('palr' + i);
      const on = i === palSel;
      row.classList.toggle('on', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) row.scrollIntoView({ block: 'nearest' });
    });
    if (palRows.length) palIn.setAttribute('aria-activedescendant', 'palr' + palSel);
    else palIn.removeAttribute('aria-activedescendant');
  }

  function palShow() {
    if (!pal.hidden) { palIn.select(); return; }
    palFrom = document.activeElement;
    pal.hidden = false;
    palIn.value = '';
    palPaint();
    palIn.focus();
    if (!knowHave) loadKnow().then(() => { if (!pal.hidden) palPaint(); });
  }
  function palClose() {
    if (pal.hidden) return;
    pal.hidden = true;
    const f = palFrom; palFrom = null;
    if (f && f.isConnected) f.focus();
  }
  function palRun(i, ev) {
    const r = palRows[i];
    if (!r) return;
    palClose();
    if (r.kind === 'action') { r.a.run(ev); return; }
    openIn(r.kind, r.key, { ev });
    drawersClose();
  }
  paletteOpen = palShow;   // the ribbon's button (24-tools.js)

  palIn.oninput = palPaint;
  palIn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!palRows.length) return;
      palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palRows.length) % palRows.length;
      palMark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      palRun(palSel, e);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      palClose();
    }
  });
  pal.addEventListener('mousedown', (e) => { if (e.target === pal) palClose(); });

  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'k' && k !== 'p') return;
    e.preventDefault();
    if (k === 'p' && localStorage.edVim === '1' && document.activeElement === src) return;
    if (!$('dlg').hidden) return;
    palShow();
  }, true);

  window.latPalette = { ids: () => ACTIONS.map((a) => a.id), only: PALETTE_ONLY,
    applies: (id) => { const a = ACTIONS.find((x) => x.id === id); return !!a && (!a.when || !!a.when()); } };

// ── src/26-writer.js ──────────────────────────────────────────────────────
  let wrLoad = null, wr = null, wrHost = null, wrSeq = 0, wrQ = false;
  const wrSrc = new Map();     // page -> why it shows as XML
  const wrKey = () => current || '';
  const fodtHere = () => mode !== 'know' && !grubPath && curFolder === null && pkind.value === 'fodt';
  const writerSourceOn = () => fodtHere() && wrSrc.has(wrKey());
  const writerReady = () => (window.LatWriter ? Promise.resolve(window.LatWriter)
    : wrLoad || (wrLoad = new Promise((ok, no) => {
      const s = document.createElement('script');
      const fail = () => { wrLoad = null; s.remove(); no(); };
      s.src = '/apps/lattice/app/writer.js?h=' + WRITER_H;
      s.onload = () => (window.LatWriter ? ok(window.LatWriter) : fail());
      s.onerror = fail;
      document.head.append(s);
    })));
  const wrX = (f, b) => window.LatWriter ? LatWriter.extract[f](b) : (writerReady().then(() => rpSoon(), () => {}), []);
  const wrNote = document.createElement('div');
  wrNote.className = 'lnkcf';
  wrNote.hidden = true;
  $('docarea').before(wrNote);
  function wrBox(msg) {
    if (!wrHost) wrHost = document.createElement('lat-writer');
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
    if (wrHost) wrHost.hidden = !on;
    src.style.visibility = hl.style.visibility = on ? 'hidden' : '';
  }
  function writerFollow() {
    if (!wrQ) { wrQ = true; queueMicrotask(writerApply); }
  }
  function writerApply() {
    wrQ = false;
    const why = writerSourceOn() && wrSrc.get(wrKey());
    wrNote.hidden = !why;
    wrNote.textContent = why;
    if (!fodtHere() || writerSourceOn()) return writerOff();
    const body = src.value, ed = !src.readOnly && viewingRev === null;
    wrShow(true);
    if (wr && wr.base() === body) return wr.setEditable(ed);
    writerDrop();
    if (!window.LatWriter) wrBox('Loading the Writer editor…');
    const my = wrSeq;
    writerReady().then((LW) => {
      if (my !== wrSeq || src.value !== body || !fodtHere() || writerSourceOn()) return;
      const c = LW.mount(wrBox(), { text: body, editable: ed, name: current, cur: () => src.value, onChange: writerChanged,
        onText: (t) => { src.value = t; edited(); }, onRefuse: (e) => st('not saved: ' + e, false) });
      if (c.error) { wrSrc.set(wrKey(), c.error); writerApply(); } else wr = c;
    }, () => { if (my === wrSeq) wrBox('The Writer editor did not load. Source in the page menu shows the XML.'); });
  }
  function writerChanged() {
    dirty = everTyped = true;
    clearTimeout(autoTimer);
  }
  function writerSync() { return !wr || wr.sync(); }
  function writerDrop() {
    wrSeq++;
    if (wr) wr.destroy();
    wr = null;
  }
  function writerOff() {
    writerSync();
    writerDrop();
    if (wrHost) wrHost.replaceChildren();
    wrShow(false);
  }
  function writerSource(on) {
    writerSync();
    if (on) wrSrc.set(wrKey(), ''); else wrSrc.delete(wrKey());
    writerApply();
  }
  function kindSwitchOk(to) {
    const t = src.value.trim();
    const from = current ? curKind : !t ? to : /^(<\?xml[^>]*>\s*)?<office:document[\s/>]/.test(t) ? 'fodt' : 'text';
    if ((from === 'fodt') === (to === 'fodt')) return true;
    st(from === 'fodt' ? 'a Writer document cannot change kind' : 'a page with text cannot become a Writer document', false);
    return false;
  }
  async function writerBlank() {
    try { src.value = (await writerReady()).blank; } catch { st('the Writer editor did not load', false); return false; }
    wrSrc.delete(wrKey());
    render();
    return true;
  }

// ── src/27-vim.js ─────────────────────────────────────────────────────────
/* ============================================================================
   VIM MODE for the lattice code editor.
   Self-contained vanilla JS, no dependencies. Operates on <textarea id="src">.
   ============================================================================ */
(function vimMode(){
  "use strict";

  var ta = document.getElementById("src");
  if(!ta) return;

  /* ---- persisted on/off flag (same pattern as edNT / edNC) ---- */
  var LS = "edVim";
  function vimOn(){ return localStorage.getItem(LS) === "1" && pkind.value !== "fodt"; }   // default OFF

  /* ---- mode indicator element (created once, lives by the status bar) ---- */
  var ind = document.createElement("span");
  ind.id = "vimInd";
  ind.style.cssText =
    "display:none;margin-left:8px;padding:1px 6px;border-radius:3px;"+
    "font:11px/1.6 monospace;font-weight:bold;letter-spacing:.5px;"+
    "color:#fff;background:#666;vertical-align:middle;";
  var stEl = document.getElementById("status");
  if(stEl && stEl.parentNode) stEl.parentNode.insertBefore(ind, stEl.nextSibling);
  else document.body.appendChild(ind);

  /* ---- state ---- */
  var MODE = "normal";        // "normal" | "insert" | "visual"
  var pending = "";           // pending operator/prefix: d c y g r f F t T
  var count = "";             // numeric count prefix (digits as a string)
  var reg = "";               // single unnamed register contents
  var regLinewise = false;    // was the register captured linewise?
  var visAnchor = 0;          // selection anchor index for visual mode
  var visCaret = 0;           // moving head of the visual selection
  var cmdActive = false;      // ex command-line (:) active?
  var cmdBuf = "";            // the typed ex command (without the leading :)

  /* ---- fire input so the live content preview refreshes ---- */
  function fireInput(){ ta.dispatchEvent(new Event("input", { bubbles:true })); }

  /* ---- indicator ---- */
  function setInd(){
    if(!vimOn()){ ind.style.display = "none"; drawCur(); return; }
    ind.style.display = "inline-block";
    var pv = document.getElementById("ws");
    if(pv && pv.classList.contains("vp")){
      ind.textContent = "-- PREVIEW --"; ind.style.background = "#607d8b"; drawCur(); return;
    }
    if(cmdActive){ ind.textContent = ":" + cmdBuf; ind.style.background = "#455a64"; return; }
    var label, bg;
    if(MODE === "insert"){ label = "-- INSERT --"; bg = "#2e7d32"; }
    else if(MODE === "visual"){ label = "-- VISUAL --"; bg = "#8e24aa"; }
    else { label = "-- NORMAL --"; bg = "#1565c0"; }
    if(pending || count) label += " " + count + pending;
    ind.textContent = label;
    ind.style.background = bg;
    drawCur();
  }

  /* ============================================================================
     THE CURSOR'S SHAPE: a block over the character in normal, visual and
     operator-pending (the : line too, which leaves the cursor where it was),
     an underline while r waits for its character, and the textarea's own bar
     in insert and with vim off. A textarea draws only a bar, so the block is
     an element over the editor, placed on the character as the highlight
     overlay (#hl) lays it out: that is the text on screen, and since the
     overlay is kept in step with every keystroke (hlSplice, 25-editor.js)
     and draws with the textarea's metrics, it is where a typed character
     lands. Redrawn at once on every key (setInd), and on the overlay's
     repaints, scroll, focus, clicks, resizes and font loads.
     ============================================================================ */
  var cur = document.createElement("div");
  cur.className = "vimcur";
  cur.setAttribute("aria-hidden", "true");
  cur.hidden = true;
  function curShape(){
    if(!vimOn() || MODE === "insert" || document.activeElement !== ta) return "";
    var ws = document.getElementById("ws");
    if(ws && ws.classList.contains("vp")) return "";
    return pending === "r" ? "under" : "block";
  }
  function hlAt(i){
    var w = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT), n, last = null;
    while((n = w.nextNode())){ if(i < n.length) return [n, i]; i -= n.length; last = n; }
    return last ? [last, last.length] : null;
  }
  function drawCur(){
    var shape = curShape(), v = val();
    var ok = shape && hl && hl.textContent === v + "\n";
    ta.classList.toggle("vim-block", !!ok);
    if(!ok){ cur.hidden = true; return; }
    var box = ta.parentNode;
    if(cur.parentNode !== box) box.appendChild(cur);
    var p = MODE === "visual" ? visCaret : pos();
    var two = (v.charCodeAt(p) & 0xfc00) === 0xd800;
    var a = hlAt(p), b = hlAt(p + (two ? 2 : 1));
    if(!a || !b){ cur.hidden = true; return; }
    var r = document.createRange();
    r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]);
    var rs = r.getClientRects(), rc = null;
    for(var i = rs.length - 1; i >= 0 && !rc; i--) if(rs[i].width > 0) rc = rs[i];
    var ch = v.slice(p, p + (two ? 2 : 1));
    if(!rc){
      var mk = document.createElement("span"), par;
      mk.textContent = "\u200b";
      r.collapse(true); r.insertNode(mk);
      rs = mk.getClientRects(); rc = rs[rs.length - 1];
      par = mk.parentNode; mk.remove(); par.normalize();
    }
    if(!rc){ cur.hidden = true; return; }
    var tb = ta.getBoundingClientRect(), bb = box.getBoundingClientRect();
    var mid = rc.top + rc.height / 2;
    if(mid < tb.top + ta.clientTop || mid > tb.top + ta.clientTop + ta.clientHeight
       || rc.left < tb.left || rc.left >= tb.left + ta.clientLeft + ta.clientWidth){
      cur.hidden = true; return;
    }
    cur.className = "vimcur" + (shape === "under" ? " under" : "");
    cur.textContent = (ch === "" || ch === "\n" || ch === "\t") ? " " : ch;
    cur.hidden = false;
    var lh = parseFloat(getComputedStyle(hl).lineHeight) || rc.height;
    cur.style.left = (rc.left - bb.left - box.clientLeft) + "px";
    cur.style.top = (mid - lh / 2 - bb.top - box.clientTop) + "px";
    cur.style.height = lh + "px";
    cur.style.width = rc.width > 0 ? rc.width + "px" : "";
  }
  var curRaf = 0;
  function curSoon(){ if(!curRaf) curRaf = requestAnimationFrame(function(){ curRaf = 0; drawCur(); }); }
  hlPainted = drawCur;
  ta.addEventListener("scroll", drawCur);
  ta.addEventListener("focus", curSoon);
  ta.addEventListener("blur", drawCur);
  document.addEventListener("selectionchange", function(){ if(vimOn()) curSoon(); });
  window.addEventListener("resize", curSoon);
  if(window.ResizeObserver) new ResizeObserver(curSoon).observe(ta);
  if(document.fonts && document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", curSoon);
  window.addEventListener("storage", curSoon);

  /* ---- caret / buffer helpers ---- */
  function val(){ return ta.value; }
  function pos(){ return ta.selectionStart; }
  function setPos(p){ p = clamp(p, 0, val().length); ta.selectionStart = ta.selectionEnd = p; }
  function setSel(a, b){ ta.selectionStart = a; ta.selectionEnd = b; }
  function clamp(n, lo, hi){ return n < lo ? lo : (n > hi ? hi : n); }

  function lineStart(p){ var v = val(); var i = v.lastIndexOf("\n", p - 1); return i + 1; }
  function lineEnd(p){ var v = val(); var i = v.indexOf("\n", p); return i < 0 ? v.length : i; }
  function lineText(p){ return val().slice(lineStart(p), lineEnd(p)); }
  function col(p){ return p - lineStart(p); }
  function lineLastCol(p){ var s = lineStart(p), e = lineEnd(p); return e > s ? e - 1 : s; }
  function normClamp(p){
    var ls = lineStart(p), le = lineEnd(p);
    if(le === ls) return ls;              // empty line
    return clamp(p, ls, le - 1);
  }
  function firstNonBlank(p){
    var ls = lineStart(p), le = lineEnd(p), v = val(), i = ls;
    while(i < le && (v[i] === " " || v[i] === "\t")) i++;
    return i < le ? i : ls;
  }
  function fixCaret(){
    if(MODE === "insert") return;
    var p = pos(), last = lineLastCol(p);
    if(p > last) setPos(last);
  }

  /* ============================================================================
     EDIT PRIMITIVES — use execCommand so native undo + preview both work.
     ============================================================================ */
  function tryExec(cmd, arg){
    try{
      if(cmd === "insertText") return document.execCommand("insertText", false, arg);
      if(cmd === "delete") return document.execCommand("delete", false, null);
    }catch(e){}
    return false;
  }
  function replaceRange(a, b, text, caret){
    if(ta.readOnly) return false;
    a = clamp(a, 0, val().length);
    b = clamp(b, 0, val().length);
    if(a > b){ var t = a; a = b; b = t; }
    ta.focus();
    setSel(a, b);
    var ok = false;
    if(a === b){
      if(text.length) ok = tryExec("insertText", text) || ta.setRangeText(text, a, b, "end") === undefined;
      else ok = true;
    } else if(text.length === 0){
      ok = tryExec("delete") || (ta.setRangeText("", a, b, "end") === undefined);
    } else {
      ok = tryExec("insertText", text) || (ta.setRangeText(text, a, b, "end") === undefined);
    }
    if(typeof caret === "number") setPos(caret);
    fireInput();
    return ok;
  }
  function insertAt(p, text){ replaceRange(p, p, text, p + text.length); }
  function deleteRange(a, b, caret){ replaceRange(a, b, "", typeof caret === "number" ? caret : Math.min(a, b)); }

  /* ---- register ---- */
  function yank(a, b, linewise){
    var v = val(); a = clamp(a, 0, v.length); b = clamp(b, 0, v.length);
    if(a > b){ var t = a; a = b; b = t; }
    var text = v.slice(a, b);
    if(linewise && text.charAt(text.length - 1) !== "\n") text += "\n";
    reg = text; regLinewise = !!linewise;
  }

  /* ============================================================================
     MODE SWITCHING
     ============================================================================ */
  function toInsert(){ MODE = "insert"; pending = ""; count = ""; setInd(); }
  function toNormal(){
    if(MODE === "insert"){                 // vim steps caret left when leaving insert
      var p = pos(), ls = lineStart(p);
      if(p > ls) setPos(p - 1);
    }
    MODE = "normal"; pending = ""; count = ""; fixCaret(); setInd();
  }
  function toVisual(){ MODE = "visual"; visAnchor = pos(); visCaret = pos(); pending = ""; count = ""; visSync(); setInd(); }

  /* ============================================================================
     VISUAL selection helpers (charwise, inclusive of char under caret)
     ============================================================================ */
  function visRange(){
    var a = visAnchor, b = visCaret;
    var lo = Math.min(a, b), hi = Math.max(a, b) + 1;
    return [lo, clamp(hi, 0, val().length)];
  }
  function visSync(){
    if(MODE !== "visual") return;
    var r = visRange();
    setSel(r[0], r[1]);
  }

  /* ============================================================================
     MOTIONS
     ============================================================================ */
  function charClass(c){
    if(c === undefined || c === "\n") return "nl";
    if(c === " " || c === "\t") return "sp";
    if(/[A-Za-z0-9_]/.test(c)) return "w";
    return "p";                            // punctuation
  }
  function wordFwd(p, n){
    var v = val(), len = v.length;
    for(var k = 0; k < n; k++){
      if(p >= len) break;
      var cls = charClass(v[p]);
      if(cls !== "sp" && cls !== "nl") while(p < len && charClass(v[p]) === cls) p++;
      while(p < len && (charClass(v[p]) === "sp" || charClass(v[p]) === "nl")) p++;
    }
    return clamp(p, 0, len);
  }
  function wordBack(p, n){
    var v = val();
    for(var k = 0; k < n; k++){
      if(p <= 0) break;
      p--;
      while(p > 0 && (charClass(v[p]) === "sp" || charClass(v[p]) === "nl")) p--;
      if(p <= 0){ p = 0; break; }
      var cls = charClass(v[p]);
      while(p > 0 && charClass(v[p - 1]) === cls) p--;
    }
    return clamp(p, 0, v.length);
  }
  function wordEnd(p, n){
    var v = val(), len = v.length;
    for(var k = 0; k < n; k++){
      if(p >= len - 1){ p = len - 1 < 0 ? 0 : len - 1; break; }
      p++;
      while(p < len && (charClass(v[p]) === "sp" || charClass(v[p]) === "nl")) p++;
      if(p >= len){ p = len - 1; break; }
      var cls = charClass(v[p]);
      while(p + 1 < len && charClass(v[p + 1]) === cls) p++;
    }
    return clamp(p, 0, len);
  }
  function changeWordEnd(p, n){
    var v = val();
    if(charClass(v[p]) === "sp" || charClass(v[p]) === "nl") return wordFwd(p, n);
    return clamp(wordEnd(p, n) + 1, p, v.length);
  }
  function vertical(p, delta){
    var v = val(), c = col(p), cur = p;
    if(delta > 0){
      for(var i = 0; i < delta; i++){
        var e = lineEnd(cur);
        if(e >= v.length) break;          // last line
        cur = e + 1;
      }
    } else {
      for(var j = 0; j < -delta; j++){
        var s = lineStart(cur);
        if(s === 0) break;                // first line
        cur = lineStart(s - 1);
      }
    }
    var ns = lineStart(cur), maxc = MODE === "visual" ? lineEnd(cur) : lineLastCol(cur);
    return clamp(ns + c, ns, maxc);
  }
  function paraFwd(p, n){
    var v = val(), len = v.length, i = p;
    for(var k = 0; k < n; k++){
      var e = lineEnd(i); i = e >= len ? len : e + 1;
      while(i < len){
        var ls = lineStart(i), le = lineEnd(i);
        if(le === ls) break;              // blank line
        i = le >= len ? len : le + 1;
      }
    }
    return clamp(i, 0, len);
  }
  function paraBack(p, n){
    var i = p;
    for(var k = 0; k < n; k++){
      var s = lineStart(i);
      i = s > 0 ? s - 1 : 0;
      i = lineStart(i);
      while(i > 0){
        var ls = lineStart(i), le = lineEnd(i);
        if(le === ls) break;              // blank line
        i = lineStart(i - 1);
      }
    }
    return clamp(i, 0, val().length);
  }
  function findChar(p, ch, forward, till){
    var v = val(), ls = lineStart(p), le = lineEnd(p);
    if(forward){
      for(var i = p + 1; i < le; i++) if(v[i] === ch) return till ? i - 1 : i;
    } else {
      for(var j = p - 1; j >= ls; j--) if(v[j] === ch) return till ? j + 1 : j;
    }
    return -1;
  }
  function lastLineStart(){ var v = val(); var i = v.lastIndexOf("\n"); return i === -1 ? 0 : i + 1; }
  function gotoLine(lineNo){
    var v = val(), idx = 0, cur = 1;
    if(lineNo <= 1) return firstNonBlank(0);
    while(cur < lineNo){
      var nl = v.indexOf("\n", idx);
      if(nl === -1) return firstNonBlank(lineStart(v.length));
      idx = nl + 1; cur++;
    }
    return firstNonBlank(idx);
  }

  /* ============================================================================
     LINEWISE span helpers (for dd/cc/yy/dj/dk and operator linewise motions)
     ============================================================================ */
  function lineSpan(p, cnt){
    var start = lineStart(p), end = start, v = val();
    for(var k = 0; k < cnt; k++){
      var le = lineEnd(end);
      if(le < v.length) end = le + 1;     // include the newline
      else { end = le; break; }
    }
    return [start, end];
  }
  function linewiseYank(p, cnt){
    var sp = lineSpan(p, cnt);
    yank(sp[0], sp[1], true);
  }
  function linewiseDelete(p, cnt){
    var v = val(), sp = lineSpan(p, cnt), a = sp[0], b = sp[1];
    yank(a, b, true);
    if(b >= v.length && a > 0 && v[a - 1] === "\n") a = a - 1;   // last line: eat preceding \n
    deleteRange(a, b, 0);
    setPos(firstNonBlank(clamp(a, 0, val().length)));
  }
  function linewiseChange(p, cnt){
    var sp = lineSpan(p, cnt), a = sp[0], b = sp[1], v = val();
    yank(a, b, true);
    var delTo = (b > a && v[b - 1] === "\n") ? b - 1 : b;
    deleteRange(a, delTo, a);
    setPos(a);
    toInsert();
  }

  /* ============================================================================
     PASTE
     ============================================================================ */
  function paste(after){
    if(reg === "") return;
    var p = pos(), v = val();
    if(regLinewise){
      var text = reg;
      if(text.charAt(text.length - 1) !== "\n") text += "\n";
      if(after){
        var le = lineEnd(p);
        if(le >= v.length){
          insertAt(v.length, "\n" + text.replace(/\n$/, ""));
          setPos(firstNonBlank(lineStart(val().length)));
        } else {
          insertAt(le + 1, text);
          setPos(firstNonBlank(le + 1));
        }
      } else {
        var ls = lineStart(p);
        insertAt(ls, text);
        setPos(firstNonBlank(ls));
      }
    } else {
      var at = after ? (v.length === 0 || v[p] === "\n" ? p : p + 1) : p;
      insertAt(at, reg);
      setPos(normClamp(at + reg.length - 1));
    }
  }

  /* ============================================================================
     OPERATOR + MOTION (charwise) — returns {end, linewise} or null.
     ============================================================================ */
  function operatorMotion(op, key, n){
    var p = pos();
    switch(key){
      case "w": return { end: op === "c" ? changeWordEnd(p, n) : wordFwd(p, n), linewise:false };
      case "b": return { end: wordBack(p, n), linewise:false };
      case "e": return { end: wordEnd(p, n) + 1, linewise:false };
      case "h": return { end: Math.max(lineStart(p), p - n), linewise:false };
      case "l": case " ": return { end: Math.min(lineEnd(p), p + n), linewise:false };
      case "0": return { end: lineStart(p), linewise:false };
      case "^": return { end: firstNonBlank(p), linewise:false };
      case "$": return { end: lineEnd(vertical(p, n - 1)), linewise:false };
      case "j": return { linewiseFrom: p, linewiseCount: n + 1, linewise:true };
      case "k": {
        var top = p;
        for(var i = 0; i < n; i++){ var ls = lineStart(top); if(ls === 0) break; top = lineStart(ls - 1); }
        return { linewiseFrom: top, linewiseCount: countLines(top, p) + 1, linewise:true };
      }
      case "G": {
        var destStart = count ? lineStart(gotoLine(parseInt(count, 10))) : lastLineStart();
        var lo = Math.min(p, destStart);
        return { linewiseFrom: lo, linewiseCount: countLines(lo, Math.max(p, destStart)) + 1, linewise:true };
      }
      default: return null;
    }
  }
  function countLines(a, b){
    var lo = Math.min(a, b), hi = Math.max(a, b), c = 0, v = val();
    for(var i = lo; i < hi; i++) if(v[i] === "\n") c++;
    return c;
  }
  function applyCharOp(op, a, b){
    if(a > b){ var t = a; a = b; b = t; }
    yank(a, b, false);
    if(op === "y"){ setPos(normClamp(a)); return; }
    deleteRange(a, b, a);
    if(op === "c"){ setPos(a); toInsert(); }
    else fixCaret();
  }
  function applyLinewiseOp(op, from, cnt){
    if(op === "y"){ linewiseYank(from, cnt); setPos(firstNonBlank(lineStart(from))); }
    else if(op === "c"){ setPos(from); linewiseChange(from, cnt); }
    else linewiseDelete(from, cnt);   // caret handling inside
  }

  /* ============================================================================
     COUNT helper
     ============================================================================ */
  function eff(){ return count === "" ? 1 : parseInt(count, 10); }
  function reset(){ pending = ""; count = ""; }

  /* ============================================================================
     EX COMMAND LINE  ( :w  :wa  :waq  ... all save the file )
     ============================================================================ */
  function cmdSave(){
    var sb = document.getElementById("save");   // the editor's Save button
    if(!sb) return;
    if(typeof sb.onclick === "function") sb.onclick(); else sb.click();
  }
  function runCmd(raw){
    var c = raw.trim();
    if(c.charAt(c.length - 1) === "!") c = c.slice(0, -1);   // tolerate a force !
    if(c === "w" || c === "wa" || c === "waq" || c === "wq" || c === "x"){ cmdSave(); return; }
    if(c === "") return;
    var st = document.getElementById("status");
    if(st) st.textContent = "not an editor command: :" + c;
  }
  function cmdKey(e){
    var k = e.key;
    if(k === "Escape" || (e.ctrlKey && k === "[")){ cmdActive = false; setInd(); return; }
    if(k === "Enter"){ var c = cmdBuf; cmdActive = false; setInd(); runCmd(c); return; }
    if(k === "Backspace"){
      if(cmdBuf.length === 0) cmdActive = false;   // backspace past the : exits
      else cmdBuf = cmdBuf.slice(0, -1);
      setInd(); return;
    }
    if(k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey){ cmdBuf += k; setInd(); }
  }

  /* ============================================================================
     NORMAL / VISUAL key handling. Returns true if consumed.
     ============================================================================ */
  function handleKey(e){
    var k = e.key;

    if(k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return true;

    if(k === "Escape" || (e.ctrlKey && k === "[")){
      if(MODE === "visual"){ var c = pos(); MODE = "normal"; setPos(normClamp(c)); }
      reset(); setInd(); return true;
    }
    if(e.ctrlKey && (k === "r" || k === "R")){
      if(!ta.readOnly) try{ document.execCommand("redo"); }catch(x){}
      fireInput(); reset(); fixCaret(); setInd(); return true;
    }

    if(pending === "r"){
      var n0 = eff(); pending = "";
      if(k.length === 1){
        var p0 = pos(), le0 = lineEnd(p0);
        if(p0 + n0 <= le0){
          var rep = ""; for(var ri = 0; ri < n0; ri++) rep += k;
          replaceRange(p0, p0 + n0, rep, p0 + n0 - 1);
        }
      }
      count = ""; setInd(); return true;
    }
    if(pending === "f" || pending === "F" || pending === "t" || pending === "T"){
      var fwd = (pending === "f" || pending === "t");
      var till = (pending === "t" || pending === "T");
      var nF = eff(); pending = "";
      if(k.length === 1){
        var base = (MODE === "visual") ? visCaret : pos();
        var target = base;
        for(var ci = 0; ci < nF; ci++){
          var r = findChar(target, k, fwd, till);
          if(r === -1){ target = base; break; }
          target = r;
        }
        if(target !== base){
          if(MODE === "visual"){ visCaret = target; visSync(); }
          else { setPos(target); fixCaret(); }
        }
      }
      count = ""; setInd(); return true;
    }
    if(pending === "g"){
      pending = "";
      if(k === "g"){
        var dest = count ? gotoLine(eff()) : firstNonBlank(0);
        if(MODE === "visual"){ visCaret = dest; visSync(); }
        else { setPos(dest); fixCaret(); }
      }
      count = ""; setInd(); return true;
    }

    if(/^[0-9]$/.test(k) && !(k === "0" && count === "")){
      count += k; setInd(); return true;
    }

    var n = eff();

    if(pending === "d" || pending === "c" || pending === "y"){
      var op = pending;
      if((op === "d" && k === "d") || (op === "c" && k === "c") || (op === "y" && k === "y")){
        reset(); applyLinewiseOp(op, pos(), n); setInd(); return true;
      }
      var mv = operatorMotion(op, k, n);
      reset();
      if(mv === null){ setInd(); return true; }        // unknown motion cancels
      if(mv.linewise) applyLinewiseOp(op, mv.linewiseFrom, mv.linewiseCount);
      else applyCharOp(op, pos(), mv.end);
      setInd(); return true;
    }

    if(MODE === "visual"){
      var vc = visCaret, moved = null;
      switch(k){
        case "h": case "ArrowLeft":  moved = clamp(vc - n, 0, val().length); break;
        case "l": case "ArrowRight": case " ": moved = clamp(vc + n, 0, val().length); break;
        case "j": case "ArrowDown":  moved = vertical(vc, n); break;
        case "k": case "ArrowUp":    moved = vertical(vc, -n); break;
        case "w": moved = wordFwd(vc, n); break;
        case "b": moved = wordBack(vc, n); break;
        case "e": moved = wordEnd(vc, n); break;
        case "0": moved = lineStart(vc); break;
        case "^": moved = firstNonBlank(vc); break;
        case "$": moved = lineLastCol(vc); break;
        case "{": moved = paraBack(vc, n); break;
        case "}": moved = paraFwd(vc, n); break;
        case "G": moved = count ? gotoLine(n) : firstNonBlank(lastLineStart()); break;
        case "g": pending = "g"; setInd(); return true;
        case "f": case "F": case "t": case "T": pending = k; setInd(); return true;
      }
      if(moved !== null){ visCaret = clamp(moved, 0, val().length); visSync(); reset(); setInd(); return true; }

      var r2 = visRange(), a = r2[0], b = r2[1];
      switch(k){
        case "d": case "x": yank(a, b, false); deleteRange(a, b, a); MODE = "normal"; setPos(normClamp(a)); reset(); setInd(); return true;
        case "c": case "s": yank(a, b, false); deleteRange(a, b, a); MODE = "normal"; setPos(a); reset(); toInsert(); return true;
        case "y": yank(a, b, false); MODE = "normal"; setPos(normClamp(a)); reset(); setInd(); return true;
        case "p": {
          var sText = reg, sLine = regLinewise;
          deleteRange(a, b, a);
          reg = sText; regLinewise = sLine;
          MODE = "normal";
          if(sLine){ setPos(a > 0 ? a - 1 : a); paste(true); }
          else { insertAt(a, reg); setPos(normClamp(a + reg.length - 1)); }
          reset(); setInd(); return true;
        }
        case "v": MODE = "normal"; setPos(normClamp(visCaret)); reset(); setInd(); return true;
      }
      if(k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey){ reset(); setInd(); return true; }
      reset(); setInd(); return true;
    }

    var p = pos();
    switch(k){
      case "h": case "ArrowLeft":  setPos(clamp(p - n, lineStart(p), p)); fixCaret(); break;
      case "l": case "ArrowRight": case " ": setPos(clamp(p + n, p, lineLastCol(p))); break;
      case "j": case "ArrowDown":  setPos(vertical(p, n)); break;
      case "k": case "ArrowUp":    setPos(vertical(p, -n)); break;
      case "w": setPos(normClamp(wordFwd(p, n))); break;
      case "b": setPos(normClamp(wordBack(p, n))); break;
      case "e": setPos(normClamp(wordEnd(p, n))); break;
      case "0": setPos(lineStart(p)); break;
      case "^": setPos(firstNonBlank(p)); break;
      case "$": { var lp = vertical(p, n - 1); setPos(lineLastCol(lp)); break; }
      case "{": setPos(normClamp(paraBack(p, n))); break;
      case "}": setPos(normClamp(paraFwd(p, n))); break;
      case "G": setPos(count ? gotoLine(n) : firstNonBlank(lastLineStart())); break;
      case "g": pending = "g"; setInd(); return true;
      case "f": case "F": case "t": case "T": pending = k; setInd(); return true;

      case "i": toInsert(); break;
      case "a": if(lineText(p).length) setPos(p + 1); toInsert(); break;
      case "I": setPos(firstNonBlank(p)); toInsert(); break;
      case "A": setPos(lineEnd(p)); toInsert(); break;
      case "o": { var le = lineEnd(p); insertAt(le, "\n"); setPos(le + 1); toInsert(); break; }
      case "O": { var ls = lineStart(p); insertAt(ls, "\n"); setPos(ls); toInsert(); break; }

      case "d": pending = "d"; setInd(); return true;
      case "c": pending = "c"; setInd(); return true;
      case "y": pending = "y"; setInd(); return true;
      case "r": pending = "r"; setInd(); return true;

      case "D": { var le2 = lineEnd(p); yank(p, le2, false); deleteRange(p, le2, p); fixCaret(); break; }
      case "C": { var le3 = lineEnd(p); yank(p, le3, false); deleteRange(p, le3, p); setPos(p); toInsert(); break; }
      case "s": {
        var le4 = lineEnd(p), end4 = clamp(p + n, p, le4);
        if(end4 > p) yank(p, end4, false);
        deleteRange(p, end4, p); setPos(p); toInsert();
        break;
      }
      case "S": linewiseChange(p, n); break;

      case "x": {
        var le5 = lineEnd(p), end5 = clamp(p + n, p, le5);
        if(end5 > p){ yank(p, end5, false); deleteRange(p, end5, p); fixCaret(); }
        break;
      }
      case "X": {
        var ls6 = lineStart(p), start6 = clamp(p - n, ls6, p);
        if(start6 < p){ yank(start6, p, false); deleteRange(start6, p, start6); }
        break;
      }

      case "p": paste(true); break;
      case "P": paste(false); break;

      case "v": toVisual(); break;

      case ":": cmdActive = true; cmdBuf = ""; pending = ""; count = ""; setInd(); return true;

      case "u": if(!ta.readOnly) try{ document.execCommand("undo"); }catch(x){} fireInput(); fixCaret(); break;

      default:
        reset(); setInd(); return true;
    }
    reset(); setInd(); return true;
  }

  /* ============================================================================
     THE TEXTAREA KEYDOWN LISTENER (capture phase — runs before the Tab handler)
     ============================================================================ */
  ta.addEventListener("keydown", function(e){
    if(!vimOn()) return;                    // vim off: native textarea (Tab, typing) unchanged

    if((e.metaKey || e.ctrlKey)
       && (e.key === "s" || e.key === "S" || e.key === "k" || e.key === "K")) return;

    if(MODE === "insert"){
      if(e.key === "Escape" || (e.ctrlKey && e.key === "[")){ e.preventDefault(); toNormal(); }
      return;
    }

    if(cmdActive){
      e.preventDefault();
      e.stopImmediatePropagation();
      cmdKey(e);
      return;
    }

    if((e.ctrlKey || e.metaKey) && !(e.ctrlKey && /^[rR[]$/.test(e.key))) return;

    handleKey(e);
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  ta.addEventListener("focus", function(){ if(vimOn() && MODE !== "insert") fixCaret(); });

  /* ============================================================================
     ON/OFF: localStorage, flipped from the settings page
     ============================================================================ */
  function applyVim(){
    if(vimOn()){
      MODE = (MODE === "insert") ? "insert" : "normal";
      ta.classList.add("vim-on");
      fixCaret();
    } else {
      MODE = "normal"; reset(); cmdActive = false;
      ta.classList.remove("vim-on");
    }
    setInd();
  }

  window.addEventListener("storage", function(e){
    if(!e.key || e.key === LS) applyVim();
  });
  applyVim();
  window.latVimSetInd = setInd;
})();

// ── src/28-splits.js ──────────────────────────────────────────────────────
  const GMIN_W = 360, GMIN_H = 200;
  let sroot = null;
  const groot = $('groot');
  const glive = $('glive');
  const isG = (n) => !!n && Array.isArray(n.tabs);

  function parentOf(x, n = sroot) {
    if (!n || isG(n)) return null;
    for (const c of n.k) {
      if (c === x) return n;
      const p = parentOf(x, c);
      if (p) return p;
    }
    return null;
  }
  function replaceNode(old, nu) {
    if (sroot === old) { sroot = nu; return; }
    const p = parentOf(old);
    if (p) p.k[p.k.indexOf(old)] = nu;
  }
  const leaves = (n = sroot) => (!n ? [] : isG(n) ? [n] : n.k.flatMap((c) => leaves(c)));
  function splitInsert(target, ng, dir, before = false) {
    const p = parentOf(target);
    if (p && p.d === dir) {
      const i = p.k.indexOf(target);
      const half = p.s[i] / 2;
      p.s[i] = half;
      p.k.splice(i + (before ? 0 : 1), 0, ng);
      p.s.splice(i + (before ? 0 : 1), 0, half);
      return;
    }
    replaceNode(target, { d: dir, k: before ? [ng, target] : [target, ng], s: [1, 1] });
  }
  function splitRemove(g) {
    const p = parentOf(g);
    if (!p) { if (sroot === g) sroot = null; return; }
    const i = p.k.indexOf(g);
    const j = i > 0 ? i - 1 : 1;
    p.s[j] += p.s[i];
    p.k.splice(i, 1);
    p.s.splice(i, 1);
    if (p.k.length === 1) replaceNode(p, p.k[0]);
  }
  function gNeighbor(g) {
    const p = parentOf(g);
    if (p) {
      const i = p.k.indexOf(g);
      const sib = p.k[i - 1] || p.k[i + 1];
      const ls = leaves(sib);
      if (ls.length) return i > 0 ? ls[ls.length - 1] : ls[0];
    }
    return groups.find((x) => x !== g) || null;
  }
  const splitSave = () => {
    const enc = (n) => (isG(n) ? groups.indexOf(n)
      : { d: n.d, k: n.k.map(enc), s: n.s.map((v) => Math.round(v * 1e4) / 1e4) });
    return sroot ? enc(sroot) : 0;
  };
  function splitLoad(x, made) {
    const seen = new Set();
    const dec = (n, depth) => {
      if (depth > 40) return null;
      if (Number.isInteger(n)) {
        if (n < 0 || n >= made.length || seen.has(n)) return null;
        seen.add(n);
        return made[n];
      }
      if (!n || typeof n !== 'object' || (n.d !== 'r' && n.d !== 'd')
        || !Array.isArray(n.k) || !Array.isArray(n.s) || n.k.length < 2 || n.s.length !== n.k.length
        || !n.s.every((v) => typeof v === 'number' && isFinite(v) && v > 0)) return null;
      const k = [];
      for (const c of n.k) {
        const d = dec(c, depth + 1);
        if (!d) return null;
        k.push(d);
      }
      return { d: n.d, k, s: n.s.slice() };
    };
    const t = dec(x, 0);
    if (!t || seen.size !== made.length) return false;
    sroot = t;
    return true;
  }

  const gBtn = (sb, icon, name, keys) => {
    const b = tip(document.createElement('button'), name, keys);
    b.type = 'button';
    b.className = 'sbtn';
    b.dataset.sb = sb;
    b.innerHTML = ico(icon);
    return b;
  };
  const SPLIT_NAME = { r: ['Split right', 'Ctrl+\\'], d: ['Split down', 'Ctrl+Shift+\\'] };
  function gAdd(g) {
    if (!groups.includes(g)) groups.push(g);
    const el = document.createElement('section');
    el.className = 'tgroup';
    el.dataset.g = g.id;
    el.setAttribute('aria-label', 'Tab group');
    const strip = document.createElement('div');
    strip.className = 'doctabs';
    const list = document.createElement('div');
    list.className = 'dtlist';
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Open documents');
    const bnew = gBtn('new', 'plus', 'New page');
    const bsr = gBtn('r', 'splitr', ...SPLIT_NAME.r);
    const bsd = gBtn('d', 'splitd', ...SPLIT_NAME.d);
    bsr.classList.add('gsplit');
    bsd.classList.add('gsplit');
    strip.append(list, bnew, bsr, bsd);
    bnew.onclick = () => { gFocus(g); tabNew(); };
    bsr.onclick = () => gSplit(g, 'r');
    bsd.onclick = () => gSplit(g, 'd');

    const ghost = document.createElement('div');
    ghost.className = 'gghost';
    ghost.hidden = true;
    const host = document.createElement('div');
    host.className = 'toolhost';
    host.hidden = true;
    el.append(strip, ghost, host);
    groot.append(el);
    Object.assign(g, { el, strip, list, bnew, bsr, bsd, ghost, host, gmemo: null });
    el.addEventListener('pointerdown', (e) => {
      if (g === focusG || !e.isPrimary) return;
      if (e.target.closest('.gghost, .dtw')) return;
      gFocus(g);
    }, true);
    gDragWire(g);
    return g;
  }
  function gGhostBuild(g) {
    if (g.ghead) return;
    const ghost = g.ghost;
    ghost.innerHTML =
      '<div class="tabhead ghead">'
      + sbtn('data-go="tback"', 'left', 'Back', 'Alt+Left')
      + sbtn('data-go="tfwd"', 'right', 'Forward', 'Alt+Right')
      + '<button type="button" class="tpath" data-go="tpath"></button>'
      + '<div class="tread" role="group" aria-label="Edit or Read">'
      + '<button type="button" data-go="edit" title="Edit / Read (Ctrl+E)">' + ico('pen') + 'Edit</button>'
      + '<button type="button" data-go="read" title="Edit / Read (Ctrl+E)">' + ico('eye') + 'Read</button>'
      + '</div>'
      + sbtn('data-go="tmenu" aria-haspopup="menu"', 'dots', 'Page menu')
      + '</div>'
      + '<div class="gdoc"><lat-editor ghost></lat-editor>'
      + '<div class="prevwrap"><iframe class="prev" title="preview" sandbox="allow-scripts"></iframe></div></div>';
    Object.assign(g, {
      ghead: ghost.querySelector('.ghead'), gdoc: ghost.querySelector('.gdoc'),
      gta: ghost.querySelector('.esrc'), ghl: ghost.querySelector('.ehl'),
      gprev: ghost.querySelector('.prev') });
    const LIVE = { tback: '#tback', tfwd: '#tfwd', tpath: '#tpath', tmenu: '#tmenu',
      edit: '#tread [data-r="0"]', read: '#tread [data-r="1"]' };
    for (const b of ghost.querySelectorAll('[data-go]'))
      b.onclick = () => gThen(g, () => {
        const live = document.querySelector(LIVE[b.dataset.go]);
        if (live && !live.disabled) live.click();
      });
    const ta = g.gta;
    let down = false;
    ta.addEventListener('pointerdown', () => {
      down = true;
      addEventListener('pointerup', () => {
        down = false;
        if (g !== focusG) gCaret(g, ta.selectionStart, ta.selectionEnd, ta.scrollTop);
      }, { once: true });
    });
    ta.addEventListener('focus', () => {
      if (!down && g !== focusG) gCaret(g, ta.selectionStart, ta.selectionEnd, ta.scrollTop);
    });
    ta.addEventListener('scroll', () => {
      g.ghl.scrollTop = ta.scrollTop;
      g.ghl.scrollLeft = ta.scrollLeft;
    });
    g.gdoc.querySelector('.prevwrap').addEventListener('pointerdown', () => gFocus(g));
  }
  const gThen = (g, fn) => {
    if (gFocus(g)) fn();
    else tabSerial(async () => {}).then(() => { if (focusG === g) fn(); });
  };
  function gCaret(g, a, b, top) {
    const body = g.gta.value;
    gThen(g, () => {
      if (!docFront() || src.value !== body) return;
      src.focus({ preventScroll: true });
      try { src.setSelectionRange(a, b); } catch {}
      src.scrollTop = top;
      sync();
    });
  }
  function gDrop(g) {
    splitRemove(g);
    const i = groups.indexOf(g);
    if (i >= 0) groups.splice(i, 1);
    if (glive.parentNode === g.el) liveMove($('center'), null);
    for (const w of [...g.host.querySelectorAll('.intab')]) { w.hidden = true; toolStash.append(w); }
    g.el.remove();
    if (groups.includes(focusG)) splitPaint();
  }

  function liveMove(parent, before) {
    if (parent.moveBefore) {
      try { parent.moveBefore(glive, before); return; } catch {}
    }
    parent.insertBefore(glive, before);
    if (prev && glive.contains(prev)) prevBusy();
  }

  function splitPaint() {
    if (!sroot && groups.length) sroot = groups[0];
    if (focusG && groups.includes(focusG) && glive.parentNode !== focusG.el) {
      const had = document.activeElement === src;
      liveMove(focusG.el, focusG.ghost);
      if (had) src.focus({ preventScroll: true });
    }
    for (const g of groups) {
      const on = g === focusG;
      g.el.classList.toggle('gfocus', on);
      for (const [el, id] of [[g.strip, 'doctabs'], [g.bnew, 'tabnew'], [g.host, 'toolhost']])
        if (on) el.id = id; else el.removeAttribute('id');
      for (const [el, a] of [[g.bnew, 'tabnew'], [g.bsr, 'splitr'], [g.bsd, 'splitd']])
        if (on) el.dataset.action = a; else delete el.dataset.action;
      delete g.el.dataset.action;
      delete g.strip.dataset.action;
    }
    const ls = leaves();
    const at = ls.indexOf(focusG);
    if (ls.length > 1 && at >= 0) {
      ls[(at + 1) % ls.length].strip.dataset.action = 'gnext';
      ls[(at - 1 + ls.length) % ls.length].el.dataset.action = 'gprev';
    }
    groot.classList.toggle('multi', groups.length > 1);
    layout();
    gPaintAll();
  }
  const handles = new Map();     // split node -> its handles
  function layout() {
    const used = new Set();
    const place = (n, x, y, w, h) => {
      if (isG(n)) {
        const s = n.el.style;
        s.left = x * 100 + '%';
        s.top = y * 100 + '%';
        s.width = w * 100 + '%';
        s.height = h * 100 + '%';
        n.fw = w;
        n.fh = h;
        n.el.classList.toggle('gl', x > 1e-6);
        n.el.classList.toggle('gt', y > 1e-6);
        return;
      }
      n.box = { x, y, w, h };
      const tot = n.s.reduce((a, b) => a + b, 0);
      if (!handles.has(n)) handles.set(n, []);
      const hs = handles.get(n);
      let off = 0;
      n.k.forEach((c, i) => {
        const f = n.s[i] / tot;
        if (n.d === 'r') place(c, x + off * w, y, f * w, h);
        else place(c, x, y + off * h, w, f * h);
        off += f;
        if (i === n.k.length - 1) return;
        let r = hs[i];
        if (!r) { r = document.createElement('div'); hs[i] = r; resWire(r, n, i); groot.append(r); }
        r.className = 'gres ' + n.d + (r.classList.contains('drag') ? ' drag' : '');
        const st_ = r.style;
        if (n.d === 'r') {
          Object.assign(st_, { left: (x + off * w) * 100 + '%', top: y * 100 + '%',
            height: h * 100 + '%', width: '' });
        } else {
          Object.assign(st_, { top: (y + off * h) * 100 + '%', left: x * 100 + '%',
            width: w * 100 + '%', height: '' });
        }
        used.add(r);
      });
      hs.length = n.k.length - 1;
    };
    if (sroot) place(sroot, 0, 0, 1, 1);
    for (const [n, hs] of handles) {
      for (const r of hs) if (r && !used.has(r)) r.remove();
      if (!hs.some((r) => r && used.has(r))) handles.delete(n);
    }
    splitButtons();
  }
  const minPx = (n, d) => (isG(n) ? (d === 'r' ? GMIN_W : GMIN_H)
    : n.d === d ? n.k.reduce((a, c) => a + minPx(c, d), 0) : Math.max(...n.k.map((c) => minPx(c, d))));
  function resWire(r, n, i) {
    r.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      r.setPointerCapture(e.pointerId);
      r.classList.add('drag');
      const box = groot.getBoundingClientRect();
      const span = n.d === 'r' ? n.box.w * box.width : n.box.h * box.height;
      const tot = n.s.reduce((a, b) => a + b, 0);
      const a0 = n.s[i], b0 = n.s[i + 1];
      const pair = ((a0 + b0) / tot) * span;
      const minA = minPx(n.k[i], n.d), minB = minPx(n.k[i + 1], n.d);
      const p0 = n.d === 'r' ? e.clientX : e.clientY;
      const move = (ev) => {
        const pa = (a0 / tot) * span + (n.d === 'r' ? ev.clientX : ev.clientY) - p0;
        if (pair < minA + minB) return;
        const ca = Math.max(minA, Math.min(pair - minB, pa));
        n.s[i] = ((a0 + b0) * ca) / pair;
        n.s[i + 1] = a0 + b0 - n.s[i];
        layout();
      };
      const up = () => {
        r.removeEventListener('pointermove', move);
        r.classList.remove('drag');
        tabsSave();
      };
      r.addEventListener('pointermove', move);
      r.addEventListener('pointerup', up, { once: true });
    });
    r.addEventListener('dblclick', () => {
      const v = (n.s[i] + n.s[i + 1]) / 2;
      n.s[i] = v;
      n.s[i + 1] = v;
      layout();
      tabsSave();
    });
  }
  let gsz = null;
  function splitWhy(g, dir) {
    if (!g) return 'no group';
    if (isMobile()) return 'one group at a time on a phone';
    const r = gsz && g.fw != null ? { width: g.fw * gsz.w, height: g.fh * gsz.h }
      : g.el.getBoundingClientRect();
    if (dir === 'r' && r.width < 2 * GMIN_W)
      return 'not enough room, each group needs at least ' + GMIN_W + 'px across';
    if (dir === 'd' && r.height < 2 * GMIN_H)
      return 'not enough room, each group needs at least ' + GMIN_H + 'px of height';
    return '';
  }
  function splitButtons() {
    if (!gsz) return;     // the observer's first report paints them
    for (const g of groups) {
      for (const [b, d] of [[g.bsr, 'r'], [g.bsd, 'd']]) {
        const why = splitWhy(g, d);
        const [name, keys] = SPLIT_NAME[d];
        b.disabled = !!why;
        tip(b, name, keys);
        if (why) b.title = name + ' (' + keys + '): ' + why;
      }
    }
  }
  new ResizeObserver((es) => {
    const r = es[es.length - 1].contentRect;
    gsz = { w: r.width, h: r.height };
    splitButtons();
  }).observe(groot);

  function gGhostKeep(t) {
    t.ghost = { body: src.value, hl: hl.innerHTML,
      prev: prev.getAttribute('srcdoc'), psrc: prev.getAttribute('src') };
  }
  function gCache(t) {
    if (t.kind === 'page') {
      if (!t.key) return '';
      const n = nodes.find((x) => x.page && x.path === t.key);
      if (n && typeof n.body === 'string') return n.body;
    }
    if (t.kind === 'know' && !t.key) return '';
    if (typeof t.gbody === 'string') return t.gbody;
    if (!t.key || t.kind === 'grub' || t.gfetch) return null;
    t.gfetch = true;
    const { key, kind } = t;
    const url = t.kind === 'know' ? api + '/know-read?key=' + encodeURIComponent(t.key)
      : api + '/page-source?name=' + encodeURIComponent(t.key);
    fetch(url).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (t.key !== key || t.kind !== kind) return;   // the tab took another document
      if (d && typeof d.body === 'string') { t.gbody = d.body; t.gkind = d.kind; gPaintAll(); }
    }).catch(() => {});
    return null;
  }
  const ghostHl = (body, kind) => {
    const lang = LMAP[kind];
    const g = window.Prism && lang && Prism.languages[lang];
    if (g && body.length <= 8000) {
      try { return Prism.highlight(body, g, lang) + '\n'; } catch {}
    }
    return esc(body) + '\n';
  };
  function gPaint(g) {
    const on = g === focusG;
    g.ghost.hidden = on;
    if (on) { g.gmemo = null; return; }
    gGhostBuild(g);
    const t = g.active;
    const k = t && TAB_KINDS[t.kind];
    const doc = !!k && !!k.live;
    g.ghead.hidden = !!t && t.kind === 'tool' && browsing(t.key);
    const s = t && t.snap;
    const body = !doc ? null : s ? s.body : gCache(t);
    const memo = [t, s, body, t && t.read, t && t.ghost, t && t.key, t && t.back.length, t && t.fwd.length,
      t && k.label(t), t && t.key && linkRO(t.key)];
    if (g.gmemo && memo.every((v, i) => v === g.gmemo[i])) return;
    g.gmemo = memo;
    const path = g.ghead.querySelector('.tpath');
    const name = !t ? '' : doc ? ((s && s.shown) || t.key || k.label(t)) : k.label(t);
    path.textContent = name || 'no page open';
    path.classList.toggle('muted', !name);
    path.title = name;
    g.ghead.querySelector('[data-go="tback"]').disabled = !t || !t.back.length;
    g.ghead.querySelector('[data-go="tfwd"]').disabled = !t || !t.fwd.length;
    g.ghead.querySelector('.tread').hidden = !doc;
    g.ghead.querySelector('[data-go="tmenu"]').hidden = !doc;
    for (const b of g.ghead.querySelectorAll('.tread button')) {
      const p = (b.dataset.go === 'read') === !!(t && t.read);
      b.classList.toggle('on', p);
      b.setAttribute('aria-pressed', p ? 'true' : 'false');
    }
    g.gdoc.hidden = !doc;
    if (!doc) return;
    const kind = t.kind === 'know' ? 'md' : (s && (s.kind || s.pkind)) || t.gkind
      || ((nodes.find((x) => x.page && x.path === t.key) || {}).kind) || 'md';
    const ta = g.gta;
    ta.value = body === null ? '' : body;
    ta.placeholder = body === null ? 'click to show ' + k.label(t) : '';
    ta.title = t.kind === 'page' && t.key && linkRO(t.key) ? 'read-only' : '';
    g.ghl.innerHTML = t.ghost && t.ghost.body === ta.value ? t.ghost.hl : ghostHl(ta.value, kind);
    ta.scrollTop = s ? s.scroll : 0;
    g.ghl.scrollTop = ta.scrollTop;
    const fodt = kind === 'fodt';
    g.gdoc.classList.toggle('gread', !!t.read || fodt);
    if (fodt) {
      const d = ghostDoc(kind, ta.value) || (writerReady().then(gPaintAll, () => {}), '');
      if (g.gprev.getAttribute('srcdoc') !== d) { g.gprev.removeAttribute('src'); navDoc(g.gprev, d); }
    } else if (t.read) {
      const kept = t.ghost && t.ghost.body === ta.value ? t.ghost : null;
      if (kept && kept.psrc && !kept.prev) {
        if (g.gprev.getAttribute('src') !== kept.psrc) navUrl(g.gprev, kept.psrc);
      } else {
        const d = (kept && kept.prev) || ghostDoc(kind, ta.value) || '';
        if (g.gprev.getAttribute('srcdoc') !== d) { g.gprev.removeAttribute('src'); navDoc(g.gprev, d); }
      }
    }
  }
  const gPaintAll = () => { for (const g of groups) gPaint(g); };

  const gSplit = (g = focusG, dir = 'r') => tabSerial(async () => {
    if (!g || !groups.includes(g)) return false;
    const why = splitWhy(g, dir);
    if (why) { st('cannot split: ' + why, false); return false; }
    const ng = mkGroup();
    ng.tabs.push(mkTab('page', ''));
    ng.active = ng.tabs[0];
    gAdd(ng);
    splitInsert(g, ng, dir);
    if (!(await gTo(ng))) { gDrop(ng); return false; }
    src.focus();
    return true;
  });
  async function gSplitWith(g, dir, t, before = false) {
    const why = splitWhy(g, dir);
    if (why) { st('cannot split: ' + why, false); return false; }
    const ng = mkGroup();
    gAdd(ng);
    splitInsert(g, ng, dir, before);
    splitPaint();
    const ok = await gMove(t, ng, 0);
    if (groups.includes(ng) && !ng.tabs.length) gDrop(ng);
    return ok;
  }
  function gCycle(dir) {
    const ls = leaves();
    if (ls.length < 2 || isMobile()) return;
    const i = ls.indexOf(focusG);
    const g = ls[(i + dir + ls.length) % ls.length];
    gThen(g, () => { if (docFront() && !document.querySelector('.dlg:not([hidden])')) src.focus(); });
  }

  let dragTab = null;
  let dropEl = null;
  const TAB_MIME = 'application/x-lat-tab';
  const tabDrag = (e) => !!dragTab && !!e.dataTransfer
    && [...(e.dataTransfer.types || [])].includes(TAB_MIME);
  const dragDone = () => {
    dragTab = null;
    dropHide();
    for (const w of document.querySelectorAll('.dtw.dragging')) w.classList.remove('dragging');
  };
  for (const ev of ['dragend', 'drop']) document.addEventListener(ev, () => setTimeout(dragDone, 0), true);
  const dropHide = () => { if (dropEl) dropEl.hidden = true; };
  function dropAt(g, e) {
    const sr = g.strip.getBoundingClientRect();
    if (e.clientY <= sr.bottom) {
      const ws_ = [...g.list.children];
      let at = ws_.length;
      for (let i = 0; i < ws_.length; i++) {
        const r = ws_[i].getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) { at = i; break; }
      }
      return { g, zone: 'strip', at };
    }
    const r = g.el.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - sr.bottom) / (r.bottom - sr.bottom);
    const edge = fx < 0.25 ? ['r', true] : fx > 0.75 ? ['r', false]
      : fy < 0.25 ? ['d', true] : fy > 0.75 ? ['d', false] : null;
    if (edge && !splitWhy(g, edge[0])) return { g, zone: 'edge', dir: edge[0], before: edge[1] };
    return { g, zone: 'mid' };
  }
  function dropShow(d) {
    if (!dropEl) { dropEl = document.createElement('div'); dropEl.className = 'gdrop'; groot.append(dropEl); }
    const gr = groot.getBoundingClientRect();
    const r = d.g.el.getBoundingClientRect();
    const sr = d.g.strip.getBoundingClientRect();
    let box = { l: r.left, t: sr.bottom, w: r.width, h: r.bottom - sr.bottom };
    if (d.zone === 'strip') box = { l: sr.left, t: sr.top, w: sr.width, h: sr.height };
    else if (d.zone === 'edge') {
      if (d.dir === 'r') box = { ...box, w: box.w / 2, l: d.before ? box.l : box.l + box.w / 2 };
      else box = { ...box, h: box.h / 2, t: d.before ? box.t : box.t + box.h / 2 };
    }
    Object.assign(dropEl.style, { left: box.l - gr.left + 'px', top: box.t - gr.top + 'px',
      width: box.w + 'px', height: box.h + 'px' });
    dropEl.hidden = false;
  }
  function gDragWire(g) {
    g.list.addEventListener('dragstart', (e) => {
      const w = e.target.closest && e.target.closest('.dtw');
      const t = w && allTabs().find((x) => x.id === w.dataset.id);
      if (!t) return;
      dragTab = t;
      w.classList.add('dragging');
      try {
        e.dataTransfer.setData(TAB_MIME, t.id);
        e.dataTransfer.effectAllowed = 'move';
      } catch {}
    });
    g.list.addEventListener('dragend', dragDone);
    g.el.addEventListener('dragover', (e) => {
      if (!tabDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      try { e.dataTransfer.dropEffect = 'move'; } catch {}
      dropShow(dropAt(g, e));
    }, true);
    g.el.addEventListener('dragleave', (e) => {
      if (dragTab && !(e.relatedTarget && g.el.contains(e.relatedTarget))) dropHide();
    });
    g.el.addEventListener('drop', (e) => {
      if (!tabDrag(e)) { dragDone(); return; }
      e.preventDefault();
      e.stopPropagation();
      const t = dragTab;
      dragTab = null;
      dropHide();
      const d = dropAt(g, e);
      if (d.zone === 'edge') gSplitWith(g, d.dir, t, d.before);
      else gMove(t, g, d.zone === 'strip' ? d.at : null);
    }, true);
  }

  addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === 'Backslash') {
      e.preventDefault();
      e.stopPropagation();
      gSplit(focusG, e.shiftKey ? 'd' : 'r');
    } else if (e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
      e.preventDefault();
      e.stopPropagation();
      gCycle(e.code === 'BracketRight' ? 1 : -1);
    }
  }, true);
  action({ id: 'splitr', name: 'Split right', home: 'Tab strip', keys: 'Ctrl+\\',
    run: () => gSplit(focusG, 'r'), when: () => !splitWhy(focusG, 'r') });
  action({ id: 'splitd', name: 'Split down', home: 'Tab strip', keys: 'Ctrl+Shift+\\',
    run: () => gSplit(focusG, 'd'), when: () => !splitWhy(focusG, 'd') });
  action({ id: 'gnext', name: 'Next group', home: 'Tab group', keys: 'Ctrl+Shift+]',
    run: () => gCycle(1), when: () => groups.length > 1 && !isMobile() });
  action({ id: 'gprev', name: 'Previous group', home: 'Tab group', keys: 'Ctrl+Shift+[',
    run: () => gCycle(-1), when: () => groups.length > 1 && !isMobile() });
  addEventListener('blur', () => setTimeout(() => {
    const a = document.activeElement;
    const el = a && a.tagName === 'IFRAME' && a.closest('.tgroup');
    const g = el && groups.find((x) => x.el === el);
    if (g && g !== focusG) gFocus(g);
  }, 0));
  matchMedia('(max-width: 820px)').addEventListener('change', () => splitButtons());

  window.latSplits = {
    split: (dir) => gSplit(focusG, dir),
    why: (dir) => splitWhy(focusG, dir),
    tree: splitSave,
    move: (id, gi, dir, before = false) => {
      const t = allTabs().find((x) => x.id === id);
      return t && groups[gi] ? gSplitWith(groups[gi], dir, t, before) : Promise.resolve(false);
    },
  };

// ── src/29-fhead.js ───────────────────────────────────────────────────────
  const fnav = {};   // tab key -> { back, fwd, cur, addr, go, bar, kept }
  const jh = { keys: [], pos: -1 };
  const jhClear = () => { jh.keys = []; jh.pos = -1; };
  const fnavOf = (key) => fnav[key] || (fnav[key] = { back: [], fwd: [], cur: null, addr: '', go: null, bar: null, kept: [] });
  const fnavNorm = (url) => { try { const u = new URL(url); u.searchParams.delete('u'); return u.href; } catch { return url; } };

  function fnavAddr(d) {
    if (!d) return '';
    const i = d.querySelector('form.bar input[name=url], form.cbar input[name=url]');
    if (i && i.value.trim()) return i.value.trim();
    let u;
    try { u = new URL(d.URL); } catch { return ''; }
    if (u.origin !== location.origin) return d.URL;
    u.searchParams.delete('u');
    const r = u.pathname.replace(/^\/apps\/lattice(?=\/|$)/, '') + u.search;
    return r === '' || r === '/' ? '' : r;
  }
  function fnavTarget(v) {
    v = v.trim();
    if (!v) return location.origin + '/apps/lattice';
    if (v.startsWith('/')) {
      const u = frameUrl('frame:' + (v.startsWith('/apps/') ? v : '/apps/lattice' + v));
      if (u) return location.origin + u;
    }
    return location.origin + '/apps/lattice?url=' + encodeURIComponent(v);
  }

  function fnavLoad(f) {
    const key = f.dataset.tool;
    if (!key || !browsing(key)) return;
    const n = fnavOf(key);
    let url = null, d = null;
    try { d = f.contentDocument; url = f.contentWindow.location.href; } catch {}
    if (url === 'about:blank') return;
    url = fnavNorm(url);
    if (f.latStep) f.latStep = false;
    else if (n.go) n.go = null;       // Back or Forward landed: the stacks moved then
    else if (n.cur !== null && url !== n.cur) {
      n.back.push(n.cur); n.fwd = [];
      jh.keys.length = jh.pos + 1; jh.keys.push(key); jh.pos++;
      fkeepTrim();
    }
    fnavShown(f, d, url);
    if (n.bar) new MutationObserver(() => fhPaintKey(key))
      .observe(n.bar, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  function fnavShown(f, d, url) {
    const key = f.dataset.tool;
    const n = fnavOf(key);
    n.cur = url;
    n.addr = fnavAddr(d);
    n.bar = d ? d.querySelector('form.bar, form.cbar') : null;
    fhPaintKey(key);
  }
  function fnavGo(key, how, v, fromTop) {
    const f = frameOf(key);
    if (!f) return false;
    const n = fnavOf(key);
    if (how === 'to') {
      n.addr = v.trim();
      frameLoading(f, true);
      try { f.contentWindow.location.href = fnavTarget(v); } catch {}
      fhPaintKey(key);
      return;
    }
    const from = how === 'back' ? n.back : n.fwd;
    if (!from.length) return false;
    const url = from.pop();
    const was = n.cur;
    if (n.cur !== null) (how === 'back' ? n.fwd : n.back).push(n.cur);
    const e = n.kept.find((x) => x.url === url && x.f.isConnected);
    if (e || fkeepCan(f)) {
      jhClear();
      if (!fromTop) topStep(key, how);
      if (e) fkeepSwap(key, f, e, was);
      else { n.cur = url; fkeepBeside(key, f, url, was); }
      fkeepTrim();
      fhPaintKey(key);
      return true;
    }
    n.go = how;
    frameLoading(f, true);
    const at = how === 'back' ? jh.pos : jh.pos + 1;
    if (!fromTop && jh.keys[at] === key && jh.keys.every((k) => frameOf(k))) {
      jh.pos += how === 'back' ? -1 : 1;
      try { f.contentWindow.history.go(how === 'back' ? -1 : 1); } catch {}
    } else {
      jhClear();
      try { f.contentWindow.location.replace(url); } catch {}
    }
    fhPaintKey(key);
    return true;
  }

  const th = new Map();   // the shell's history entry key -> tab key
  let thPend = [];        // entry keys topStep's traversals will land on
  const topNav = (() => { try { return window.navigation || null; } catch { return null; } })();
  function topPush(key) {
    if (!topNav) return;
    try { history.pushState(history.state, '', location.href); th.set(topNav.currentEntry.key, key); } catch {}
  }
  function topStep(key, how) {
    const c = topNav && topNav.currentEntry;
    if (!c) return;
    const es = topNav.entries();
    const i = thPend.length ? es.findIndex((x) => x.key === thPend[thPend.length - 1]) : c.index;
    const over = es[how === 'back' ? i : i + 1], to = es[how === 'back' ? i - 1 : i + 1];
    if (i >= 0 && over && to && th.get(over.key) === key) {
      thPend.push(to.key);
      try { how === 'back' ? history.back() : history.forward(); } catch { thPend = []; }
      return;
    }
    for (const [k, v] of th) if (v === key) th.delete(k);
  }
  if (topNav) topNav.addEventListener('currententrychange', (ev) => {
    if (ev.navigationType !== 'traverse' || !ev.from) return;
    const c = topNav.currentEntry;
    if (thPend.length && thPend[0] === c.key) { thPend.shift(); return; }
    thPend = [];
    const es = topNav.entries(), a = ev.from.index, b = c.index;
    if (a < 0 || b < 0 || a === b) return;
    let did = false;
    if (b < a) {
      for (let i = a; i > b; i--) if (th.has(es[i].key) && fnavGo(th.get(es[i].key), 'back', null, true)) did = true;
      if (!did && th.has(c.key)) history.back();
    } else {
      for (let i = a + 1; i <= b; i++) if (th.has(es[i].key) && fnavGo(th.get(es[i].key), 'fwd', null, true)) did = true;
      if (!did && es[b + 1] && th.has(es[b + 1].key)) history.forward();
    }
  });

  const KEEP_TAB = 2, KEEP_MS = 5 * 60 * 1000, KEEP_QUIET = 300;
  const KEEP_ALL = (navigator.deviceMemory || 8) <= 2 ? 2 : 6;
  let keepTimer = 0, keepHid = 0;
  const keepMs = () => (+localStorage.latKeepMs) || KEEP_MS;
  const keptAll = () => Object.values(fnav).flatMap((n) => n.kept.map((e) => ({ n, e })));
  const fkeepCan = (f) => { try { return KEEP_ALL > 0 && !!f.contentWindow.navigation; } catch { return false; } };
  const frameGone = (f) => { frameSeen.unobserve(f); frameSeenAll.delete(f); f.remove(); };
  function fkeepDrop(n, e) {
    n.kept = n.kept.filter((x) => x !== e);
    frameGone(e.f);
  }
  function fkeepDropKey(key) {
    const n = fnav[key];
    if (n) for (const e of n.kept.slice()) fkeepDrop(n, e);
  }
  const heapFull = () => {
    try { const m = performance.memory; return !!m && m.usedJSHeapSize > 0.6 * m.jsHeapSizeLimit; }
    catch { return false; }
  };
  const keptSteps = (n, e) => Math.min(...[n.back, n.fwd].map((s) => {
    const i = s.lastIndexOf(e.url);
    return i < 0 ? Infinity : s.length - 1 - i;
  }));
  function fkeepTrim(all) {
    const now = Date.now();
    const full = !all && heapFull();
    for (const n of Object.values(fnav))
      for (const e of n.kept.slice())
        if (all || full || !e.f.isConnected || now - e.at > keepMs() || keptSteps(n, e) === Infinity) fkeepDrop(n, e);
    for (const n of Object.values(fnav)) {
      const ks = n.kept.slice().sort((a, b) => keptSteps(n, b) - keptSteps(n, a));
      while (ks.length > KEEP_TAB) fkeepDrop(n, ks.shift());
    }
    const every = keptAll().sort((a, b) => a.e.at - b.e.at);
    while (every.length > KEEP_ALL) { const x = every.shift(); fkeepDrop(x.n, x.e); }
    const held = new Set(keptAll().map((x) => x.e.f));
    for (const f of document.querySelectorAll('.toolhost iframe[data-kept]')) if (!held.has(f)) frameGone(f);
    clearTimeout(keepTimer);
    keepTimer = held.size ? setTimeout(() => fkeepTrim(), 60000) : 0;
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(keepHid);
    if (document.hidden) keepHid = setTimeout(() => fkeepTrim(true), 60000);
  });
  document.addEventListener('freeze', () => fkeepTrim(true));
  const frameName = (f, n) => {
    f.name = n;
    try { f.contentWindow.name = n; } catch {}
  };
  function fkeepPark(key, f, url) {
    frameLoading(f, false);           // a kept page's load is no tab's wait
    delete f.dataset.tool;
    f.dataset.kept = key;
    frameName(f, '');
    if (!url || KEEP_ALL < 1) { frameGone(f); return; }
    fnavOf(key).kept.push({ f, url, at: Date.now() });
  }
  function fkeepBeside(key, f, url, was) {
    const g = frameMake(key, url);
    g.name = f.name;
    g.latAct = f.latAct;
    g.latStep = true;
    f.parentNode.insertBefore(g, f);
    fkeepPark(key, f, was);
    if (!f.isConnected) return g;
    f.classList.add('fcover');
    const un = () => { f.classList.remove('fcover'); if (!f.dataset.tool) f.hidden = true; };
    g.addEventListener('load', un, { once: true });
    setTimeout(un, 3000);
    return g;
  }
  function fkeepSwap(key, f, e, was) {
    const n = fnavOf(key);
    const k = e.f;
    n.kept = n.kept.filter((x) => x !== e);
    const name = f.name;
    fkeepPark(key, f, was);
    frameName(k, name);
    if (f.isConnected) { f.classList.remove('fcover'); f.hidden = true; }
    k.latQuiet = Date.now() + KEEP_QUIET;
    delete k.dataset.kept;
    k.dataset.tool = key;
    k.classList.remove('fcover');
    k.hidden = false;
    let d = null;
    try { d = k.contentDocument; } catch {}
    fnavShown(k, d, e.url);
    const t = d && d.title.trim();
    if (t && frameTitles[key] !== t) { frameTitles[key] = t; paintTabs(); }
    if (k.latStale) {
      const u = k.latStale;
      k.latStale = null;
      frameLoading(k, true);
      try { k.contentWindow.location.replace(u); } catch {}
    }
    frameBusySync(k.parentNode);
  }
  function fkeepWatch(f, d, key) {
    const nav = d.defaultView && d.defaultView.navigation;
    if (!nav || KEEP_ALL < 1) return;
    nav.addEventListener('navigate', (e) => {
      if (f.dataset.tool !== key) {
        if (f.dataset.kept === key && e.cancelable && !e.destination.sameDocument && !e.formData) {
          e.preventDefault();
          const g = f.classList.contains('fcover') && e.navigationType === 'push' && frameOf(key);
          if (g) { try { g.contentWindow.location.href = e.destination.url; } catch {} }
          else f.latStale = e.destination.url;
        }
        return;
      }
      if (e.navigationType !== 'push' || !e.cancelable || e.hashChange
        || e.destination.sameDocument || e.downloadRequest !== null || e.formData) return;
      let u;
      try { u = new URL(e.destination.url); } catch { return; }
      if (u.origin !== location.origin || !/^\/apps\/lattice(\/|$)/.test(u.pathname) || editorGo(u.href)) return;
      const n = fnavOf(key);
      const to = fnavNorm(u.href);
      if (n.cur === null || to === n.cur) return;
      e.preventDefault();
      jhClear();
      const was = n.cur;
      n.back.push(was);
      n.fwd = [];
      n.cur = to;
      fkeepBeside(key, f, u.href, was);
      topPush(key);
      fkeepTrim();
      fhPaintKey(key);
    });
  }
  window.latKept = (trim) => (trim && fkeepTrim(), keptAll()).map(({ e }) => ({ key: e.f.dataset.kept, url: e.url, at: e.at }));

  function omniWire(inp, list, go) {
    let items = [], sel = -1, timer = 0, seq = 0;
    const hide = () => { list.hidden = true; sel = -1; };
    const pick = (i) => { const it = items[i]; hide(); if (it) go(it.url); };
    const draw = () => {
      list.textContent = '';
      if (!items.length) { hide(); return; }
      items.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'fhrow' + (i === sel ? ' on' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', i === sel ? 'true' : 'false');
        const s = document.createElement('span');
        s.className = 'fhsrc' + (it.source === 'bookmark' ? ' bookmark' : '');
        s.textContent = it.source === 'bookmark' ? 'saved' : 'visited';
        const t = document.createElement('span');
        t.className = 'fhttl';
        t.textContent = it.title || it.url;
        const u = document.createElement('span');
        u.className = 'fhurl';
        u.textContent = it.url;
        row.append(s, t, u);
        row.addEventListener('mousedown', (e) => e.preventDefault());
        row.addEventListener('click', () => pick(i));
        list.append(row);
      });
      list.hidden = false;
    };
    const fetchSug = async () => {
      const my = ++seq;
      let j = { items: [] };
      try {
        const r = await fetch(api + '/omni-suggest?q=' + encodeURIComponent(inp.value.trim()));
        if (r.ok) j = await r.json();
      } catch {}
      if (my !== seq || document.activeElement !== inp) return;
      items = j.items || [];
      sel = -1;
      draw();
    };
    const soon = () => { clearTimeout(timer); timer = setTimeout(fetchSug, 140); };
    inp.addEventListener('input', soon);
    inp.addEventListener('focus', () => { inp.select(); soon(); });
    inp.addEventListener('blur', () => { clearTimeout(timer); seq++; setTimeout(hide, 120); });
    inp.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !list.hidden) {
        e.preventDefault();
        sel = e.key === 'ArrowDown' ? Math.min(sel + 1, items.length - 1) : Math.max(sel - 1, -1);
        draw();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const i = list.hidden ? -1 : sel;
        hide();
        seq++;
        if (i >= 0) pick(i); else go(inp.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hide();
        inp.blur();
      }
    });
    return { hide };
  }

  function fhMake(g) {
    const h = document.createElement('div');
    h.className = 'fhead';
    h.hidden = true;
    h.innerHTML = sbtn('data-fh="back"', 'left', 'Back')
      + sbtn('data-fh="fwd"', 'right', 'Forward')
      + '<div class="fhomni"><input class="fhin" type="text" autocomplete="off" spellcheck="false"'
      + ' autocapitalize="off" enterkeyhint="go" aria-label="Address"'
      + ' placeholder="urb:// address or search your pages">'
      + '<div class="fhlist" role="listbox" aria-label="Suggestions" hidden></div></div>'
      + '<span class="fhx"></span>'
      + '<button type="button" class="sbtn fhbm" data-fh="bm" disabled>' + ico('mark') + '</button>';
    h.key = null;
    const inp = h.querySelector('.fhin');
    h.querySelector('[data-fh=back]').onclick = () => h.key && fnavGo(h.key, 'back');
    h.querySelector('[data-fh=fwd]').onclick = () => h.key && fnavGo(h.key, 'fwd');
    h.omni = omniWire(inp, h.querySelector('.fhlist'), (v) => {
      inp.blur();
      if (h.key) fnavGo(h.key, 'to', v);
    });
    inp.addEventListener('blur', () => setTimeout(() => fhPaint(g), 130));
    return h;
  }
  function fhExtras(h, bar) {
    const x = h.querySelector('.fhx');
    const star = h.querySelector('[data-fh=bm]');
    x.textContent = '';
    const bm = bar && bar.isConnected ? bar.querySelector('.bm') : null;
    const live = bm && !bm.closest('[hidden]');
    const on = !!live && /★/.test(bm.textContent);
    star.disabled = !live;
    star.classList.toggle('on', on);
    star.style.visibility = live ? '' : 'hidden';
    tip(star, on ? 'Bookmarked' : 'Bookmark this page');
    star.onclick = live ? () => bm.click() : null;
    if (!bar || !bar.isConnected) return;
    for (const el of bar.querySelectorAll('#orw button, #orw a, a[href*="forum-notes"]')) {
      if (el.closest('[hidden]')) continue;
      const b = document.createElement('button');
      b.className = 'fhtxt' + (/forum-notes/.test(el.getAttribute('href') || '') ? ' err' : '');
      b.textContent = el.textContent.trim();
      if (el.title) b.title = el.title;
      b.type = 'button';
      b.onclick = () => el.click();
      x.append(b);
    }
  }
  function fhPaint(g) {
    const h = g.fhead;
    if (!h || !h.key) return;
    const n = fnavOf(h.key);
    for (const [k, st_] of [['back', n.back], ['fwd', n.fwd]]) {
      const b = h.querySelector('[data-fh=' + k + ']');
      b.disabled = !st_.length;
      b.setAttribute('aria-disabled', b.disabled ? 'true' : 'false');
    }
    const inp = h.querySelector('.fhin');
    if (document.activeElement !== inp) inp.value = n.addr;
    fhExtras(h, n.bar);
  }
  const fhPaintKey = (key) => {
    for (const g of groups) if (g.fhead && g.fhead.key === key) fhPaint(g);
  };
  function fhSync(g, key) {
    const on = !!key && browsing(key);
    if (!g.fhead) {
      if (!on) return;
      g.fhead = fhMake(g);
      g.el.insertBefore(g.fhead, g.host);
    }
    g.fhead.hidden = !on;
    const k = on ? key : null;
    if (g.fhead.key !== k) {
      g.fhead.key = k;
      g.fhead.omni.hide();
      const inp = g.fhead.querySelector('.fhin');
      if (document.activeElement === inp) inp.blur();
    }
    fhPaint(g);
  }
  window.latFnav = (key) => { const n = fnav[key]; return n && { back: n.back.slice(), fwd: n.fwd.slice(), cur: n.cur, addr: n.addr }; };

// ── src/30-tree.js ────────────────────────────────────────────────────────
  const KIND_EXT = { md: 'md', gmi: 'gmi', html: 'html', text: 'txt', js: 'js',
                     css: 'css', hoon: 'hoon', index: 'md', tex: 'tex', fodt: 'fodt' };
  const EXT_KIND = { md: 'md', gmi: 'gmi', html: 'html', htm: 'html', txt: 'text',
                     text: 'text', js: 'js', css: 'css', hoon: 'hoon', tex: 'tex',
                     latex: 'tex', fodt: 'fodt', odt: 'fodt' };
  const kindExt = (k) => KIND_EXT[k] || 'hoon';
  const extKind = (e) => EXT_KIND[String(e || '').toLowerCase()] || null;

  let treeList;
  let sharedWithMe = [];
  let folds = [];
  customElements.define('lat-tree', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<aside class="tree" id="tree">
  <div class="ptool" role="toolbar" aria-label="Files">
    <div class="newbtns">
      ${sbtn('id="newfile" data-action="newfile"', 'plus', 'New page')}
      ${sbtn('id="newfolder" data-action="newfolder"', 'fplus', 'New folder')}
      ${sbtn('id="newtmpl" data-action="newtmpl"', 'tpl', 'New from template')}
      ${sbtn('id="upfiles" data-action="upfiles"', 'upload', 'Upload files')}
      ${sbtn('id="updir" data-action="updir"', 'updir', 'Upload a folder')}
    </div>
    <span class="grow"></span>
    ${sbtn('id="tsort" data-action="tsort"', 'sort', 'Sort: name')}
    ${sbtn('id="tcoll" data-action="tcoll"', 'fold', 'Collapse all')}
  </div>
  <input type="file" id="fpick" multiple hidden>
  <input type="file" id="dpick" webkitdirectory hidden>
  <div id="uppanel" class="uppanel" hidden>
    <div id="upmsg"></div>
    <div class="upbar"><div id="upfill"></div></div>
    <div id="uperr" class="uperr"></div>
  </div>
  <div class="sec" id="treesec">files</div>
  <div id="treelist"></div>
</aside>`;
      treeList = $('treelist');
      treeKeys(treeList, 'Files');
    }
  });
  let treeAt = '';
  let treeShares = false;
  let treeSince = '';
  async function loadTree() {
    const gen = treeGen;
    const at = lastRev;
    const since = treeSince;
    let d = null;
    try {
      const r = await fetch(api + '/page-dump' + (since ? '?since=' + since : ''));
      if (!r.ok) {
        if (await sessionGone(r)) return false;
        st('tree failed' + await errText(r), false); return false;
      }
      d = await r.json();
    } catch { st('tree failed (network)', false); return false; }
    if (gen !== treeGen) return false;   // a local patch superseded this response
    if (since) {
      const had = new Map();
      for (const n of nodes) if (n.page && typeof n.body === 'string') had.set(n.path, n);
      for (const n of d.nodes) {
        if (!n.page || n.link || typeof n.body === 'string') continue;
        const o = had.get(n.path);
        if (o && !o.link && o.rev === n.rev && o.size === n.size) n.body = o.body;
      }
    }
    if (!lastRev && typeof d.since === 'string') noteRev(d.since);
    nodes = d.nodes;
    treeShares = typeof d.since === 'string';
    treeSince = treeShares ? d.since : '';
    treeAt = at;
    for (const [name, c] of pageCache) {
      const n = nodes.find((x) => x.page && x.path === name);
      if (!n || (typeof n.rev === 'number' && n.rev > c.rev)) pageCache.delete(name);
    }
    snapTree();
    renderTree();
    return true;
  }

  let rowByPath = new Map();
  let knowRows = new Map();
  function markCurrent() {
    for (const [p, row] of rowByPath)
      row.classList.toggle('cur', row.classList.contains('pg')
        ? mode !== 'know' && p === current : p === curFolder);
    for (const [k, row] of knowRows) row.classList.toggle('cur', mode === 'know' && k === current);
    paintLink();
  }

  function linkOf(name) {
    const n = name ? nodes.find((x) => x.page && x.path === name) : null;
    return n && n.link && n.link.host ? n.link : null;
  }
  function linkFrom(lk) {
    const m = /\/page\/(.+)\/code$/.exec(lk.path || '');
    return lk.host + '/' + (m ? m[1] : String(lk.path || '').replace(/^\/+/, ''));
  }
  function daLocal(da) {
    const m = /^~(\d+)\.(\d+)\.(\d+)\.\.(\d+)\.(\d+)\.(\d+)/.exec(da || '');
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toLocaleString(undefined,
      { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  }
  function linkBadge(lk) {
    if (!lk.seen || lk.seen.ok !== false) return null;
    const at = daLocal(lk.seen.at);
    return { copy: lk.host + ' unreachable or no longer sharing', since: at ? 'since ' + at : '' };
  }
  function linkBadgeEl(bad) {
    const w = document.createElement('span');
    w.className = 'lbadw';
    const b = document.createElement('span');
    b.className = 'lbad';
    b.textContent = bad.copy;
    w.append(b);
    if (bad.since) {
      const s = document.createElement('span');
      s.className = 'lbsince';
      s.textContent = bad.since;
      w.append(' ', s);
    }
    return w;
  }
  const linkCf = new Set();
  const linkStale = new Set();
  function linkRO(name) {
    const lk = linkOf(name);
    return !!lk && (lk.mode === 'read' || linkStale.has(name));
  }
  function linkSeen(name, ok) {
    const lk = linkOf(name);
    if (!lk || !lk.seen || lk.seen.ok === ok) return;
    const t = new Date();
    const p = (v) => String(v).padStart(2, '0');
    lk.seen = { ok, at: '~' + t.getUTCFullYear() + '.' + (t.getUTCMonth() + 1) + '.' + t.getUTCDate()
      + '..' + p(t.getUTCHours()) + '.' + p(t.getUTCMinutes()) + '.' + p(t.getUTCSeconds()) };
    snapTree();
    renderTree();
  }

  const cwBadge = (path) => {
    const cw = document.createElement('span');
    cw.className = 'cw';
    cw.textContent = '\u{1F310}';
    cw.title = path + ' is clearweb public';
    return cw;
  };
  const hasNode = (path) => nodes.some((n) => n.path === path);
  function addFolderNodes(path) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!hasNode(dir)) nodes.push({ path: dir, page: false });
    }
  }
  function addTreeNode(name, kind, pending) {
    if (name.includes('/')) addFolderNodes(name.slice(0, name.lastIndexOf('/')));
    const n = nodes.find((x) => x.path === name && x.page);
    if (n) { n.kind = kind; if (pending !== undefined) n.pending = pending; }
    else nodes.push({ path: name, page: true, kind, share: 'private', pending: !!pending });
  }
  function setNodeDname(path, dname) {
    const n = nodes.find((x) => x.path === path);
    if (!n) return;
    if (dname) n.dname = dname; else delete n.dname;
  }
  function applyDnames(rn) {
    if (!rn) return;
    const segs = rn.name.split('/');
    const per = rn.dnames ? rn.dnames.split('/') : [];
    for (let i = 0; i + 1 < segs.length; i++)
      if (per[i]) setNodeDname(segs.slice(0, i + 1).join('/'), per[i]);
    setNodeDname(rn.name, rn.dname);
  }
  function setTreePending(name, pending) {
    const n = nodes.find((x) => x.path === name && x.page);
    if (!n) return;
    if (pending) n.pending = true; else delete n.pending;
    renderTree();
  }
  function dropTreeNodes(path) {
    nodes = nodes.filter((n) => n.path !== path && !n.path.startsWith(path + '/'));
  }

  function folderRow(label, depth, folded, fold, pick, key) {
    const row = document.createElement('div');
    row.className = 'fld';
    row.style.marginLeft = (depth * 14) + 'px';
    if (key !== undefined) {
      treeItem(row, depth, key);
      row.setAttribute('aria-expanded', folded ? 'false' : 'true');
      row.latFold = fold;
    }
    const cx = document.createElement('span');
    cx.className = 'cx';
    cx.textContent = folded ? '▸' : '▾';
    const lb = document.createElement('span');
    lb.className = 'fln';
    lb.innerHTML = ico(folded ? 'folder' : 'open');
    lb.append(label);
    row.append(cx, lb);
    if (pick) {
      cx.onclick = (e) => { e.stopPropagation(); fold(); };
      row.onclick = pick;
    } else row.onclick = fold;
    return row;
  }

  const SYSF = {
    conflicts: [ico('conflict'), 'Made by lattice: when two edits of a page cross, the one '
      + 'that lost is kept here as a page (Sync conflicts lists them). Safe to delete once '
      + 'read: it is made again on the next conflict.'],
    shared: [ico('inbox'), 'Pages other ships shared with you. Not a folder in your pages: '
      + 'lattice shows it while anything is shared with you, and removing an entry leaves '
      + 'their grant as it is.'],
    following: [ico('inbox'), 'Folders other ships share that you follow, from a folder index\'s '
      + 'Follow button. Not in your pages: the count is what was added or changed since you '
      + 'last opened it, and the \u00d7 unfollows.'],
  };
  function sysFlair(row, which) {
    const [svg, what] = SYSF[which];
    const s = document.createElement('span');
    s.className = 'sysf';
    s.innerHTML = svg;
    s.title = what;
    s.setAttribute('aria-label', what);
    row.append(s);
    return s;
  }

  function treeItem(row, depth, key) {
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', depth + 1);
    row.tabIndex = -1;
    row.dataset.tk = key;
    return row;
  }
  const treeRows = (list) => [...list.querySelectorAll('[role=treeitem]')]
    .filter((r) => r.style.display !== 'none');
  function treeRove(list, refocus) {
    const rows = treeRows(list);
    if (rows.length) list.setAttribute('role', 'tree'); else list.removeAttribute('role');
    const to = rows.find((r) => r.dataset.tk === list.latKey)
      || rows.find((r) => r.classList.contains('cur')) || rows[0];
    if (!to) return;
    to.tabIndex = 0;
    if (refocus) to.focus();
  }
  const IS_MAC = /Mac|iPhone|iPad|iPod/.test((navigator.userAgentData && navigator.userAgentData.platform)
    || navigator.platform || '');
  function treeKeys(list, label) {
    list.setAttribute('aria-label', label);
    const lv = (r) => +r.getAttribute('aria-level');
    list.addEventListener('focusin', (e) => {
      const row = e.target.closest('[role=treeitem]');
      if (!row) return;
      for (const r of list.querySelectorAll('[role=treeitem][tabindex="0"]')) r.tabIndex = -1;
      row.tabIndex = 0;
      list.latKey = row.dataset.tk;
    });
    list.addEventListener('keydown', (e) => {
      const row = e.target.closest('[role=treeitem]');
      if (!row || e.altKey) return;
      if (list.latDel && !e.shiftKey && ((e.key === 'Delete' && !e.ctrlKey && !e.metaKey)
        || (e.key === 'Backspace' && IS_MAC && !e.ctrlKey))) {
        e.preventDefault();
        list.latDel(row);
        return;
      }
      const rows = treeRows(list);
      const i = rows.indexOf(row);
      const open = row.getAttribute('aria-expanded');
      const mod = e.ctrlKey || e.metaKey;
      let to = null;
      if (e.key === 'Enter') {
        const hit = e.target !== row && e.target.closest('a, button') ? e.target : row;
        hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true,
          ctrlKey: e.ctrlKey, metaKey: e.metaKey }));
      } else if (mod || (e.shiftKey && e.key.length > 1)) return;
      else if (e.key === 'ArrowDown') to = rows[i + 1];
      else if (e.key === 'ArrowUp') to = rows[i - 1];
      else if (e.key === 'Home') to = rows[0];
      else if (e.key === 'End') to = rows[rows.length - 1];
      else if (e.key === 'ArrowRight') {
        if (open === 'false') row.latFold();
        else if (open === 'true' && rows[i + 1] && lv(rows[i + 1]) > lv(row)) to = rows[i + 1];
      } else if (e.key === 'ArrowLeft') {
        if (open === 'true') row.latFold();
        else for (let j = i - 1; j >= 0 && !to; j--) if (lv(rows[j]) < lv(row)) to = rows[j];
      } else if (e.key.length === 1 && e.key !== ' ') {
        const k = e.key.toLowerCase();
        const name = (r) => (r.querySelector('.fln') || r).textContent.trim().toLowerCase();
        for (let n = 1; n <= rows.length && !to; n++) {
          const r = rows[(i + n) % rows.length];
          if (name(r).startsWith(k)) to = r;
        }
      } else return;
      e.preventDefault();
      if (to) to.focus();
    });
  }
  function treeFocus() {
    treeRove(treeList, false);
    const r = treeList.querySelector('[role=treeitem][tabindex="0"]');
    if (r) r.focus();
  }
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyL'
      && !document.querySelector('.dlg:not([hidden])')) {
      e.preventDefault();
      e.stopPropagation();
      ACTIONS.find((a) => a.id === 'pt-files').run();
    }
  }, true);

  const SORTS = { name: 'Sort: name', 'name-desc': 'Sort: name, descending' };
  const treeSort = () => (localStorage.appSort === 'name-desc' ? 'name-desc' : 'name');
  const treeColl = new Intl.Collator();
  function treeOrder(list) {
    const dir = treeSort() === 'name-desc' ? -1 : 1;
    const dirs = new Set();
    for (const n of list) {
      if (!n.page) dirs.add(n.path);
      for (let i = n.path.indexOf('/'); i > 0; i = n.path.indexOf('/', i + 1))
        dirs.add(n.path.slice(0, i));
    }
    return list.map((n) => ({ n, s: n.path.split('/'), d: dirs.has(n.path) })).sort((a, b) => {
      const m = Math.min(a.s.length, b.s.length);
      for (let i = 0; i < m; i++) {
        if (a.s[i] === b.s[i]) continue;
        const fa = i < a.s.length - 1 || a.d;
        const fb = i < b.s.length - 1 || b.d;
        if (fa !== fb) return fa ? -1 : 1;
        return dir * (treeColl.compare(a.s[i], b.s[i]) || (a.s[i] < b.s[i] ? -1 : 1));
      }
      return (a.s.length - b.s.length) || (a.n.page - b.n.page);
    }).map((x) => x.n);
  }
  const paintSort = () => tip($('tsort'), SORTS[treeSort()]);
  paintSort();
  $('tsort').onclick = () => {
    try { localStorage.appSort = treeSort() === 'name' ? 'name-desc' : 'name'; } catch {}
    paintSort();
    renderTree();
  };
  $('tcoll').onclick = () => {
    paneColl.set([...new Set([...paneColl.get(),
      ...nodes.filter((n) => !n.page).map((n) => n.path)])]);
    renderTree();
  };
  for (const [id, name] of [['newfile', 'New page'], ['newfolder', 'New folder'],
    ['newtmpl', 'New from template'], ['upfiles', 'Upload files'], ['updir', 'Upload a folder'],
    ['tsort', 'Flip sort order'], ['tcoll', 'Collapse all folders']])
    clickAction(id, name, 'Files toolbar');

  function renderTree() {
    const coll = paneColl.get();
    const byPath = treeOrder(nodes);
    const had = treeList.contains(document.activeElement);
    treeList.textContent = '';
    rowByPath = new Map();
    for (const n of byPath) {
      const depth = n.path.split('/').length - 1;
      const hidden = coll.some((c) => n.path === c ? false : n.path.startsWith(c + '/'));
      let row;
      if (n.page) {
        row = document.createElement('a');
        row.style.marginLeft = (depth * 14) + 'px';
        const lk = n.link && n.link.host ? n.link : null;
        row.className = 'pg' + (lk ? ' lnk' : '') + (mode !== 'know' && n.path === current ? ' cur' : '')
          + (n.pending ? ' pend' : '');
        row.href = '/apps/lattice/app?name=' + encodeURIComponent(n.path);
        row.innerHTML = ico(lk ? 'link' : kindExt(n.kind));
        row.append(document.createTextNode((n.dname || n.path.split('/').pop()) + '.' + kindExt(n.kind)));
        if (n.dname) row.title = n.path;
        if (lk) {
          row.dataset.host = lk.host;
          row.dataset.path = n.path;
          row.title = linkFrom(lk);
          const bad = linkBadge(lk);
          if (bad) row.append(linkBadgeEl(bad));
        }
        treeItem(row, depth, 'p:' + n.path);
        if (n.share === 'clearweb') row.append(cwBadge(n.path));
        tabLink(row, 'page', n.path);
        rowMore(row, (n.dname || n.path.split('/').pop()) + '.' + kindExt(n.kind));   // 34-treemenu.js
      } else {
        row = folderRow(n.dname || n.path.split('/').pop(), depth, coll.includes(n.path),
          () => { paneColl.flip(n.path); renderTree(); }, () => pickFolder(n.path), 'f:' + n.path);
        linkDrop(row, n.path);       // a shared-with-me row dropped here (69-shared.js)
        if (n.path === curFolder) row.classList.add('cur');
        if (n.dname) row.lastChild.title = n.path;     // the label's tip
        if (n.path === 'conflicts') sysFlair(row, 'conflicts');
        if (treeShare(n.path) === 'clearweb') row.append(cwBadge(n.path));
        const add = document.createElement('a');
        add.className = 'addf';
        add.textContent = '+';
        add.title = 'new file in ' + n.path;
        add.href = '#';
        add.tabIndex = -1;          // the tree is one tab stop; New page does this
        add.onclick = async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (await guardDirty()) newFile(n.path);
        };
        row.append(add);
        rowMore(row, 'folder ' + (n.dname || n.path.split('/').pop()), n.dname || n.path.split('/').pop());
      }
      if (hidden) row.style.display = 'none';
      rowByPath.set(n.path, row);
      treeList.appendChild(row);
    }
    if (sharedWithMe.length) renderShared(coll);
    if (folds.length) renderFolds(coll);
    treeRove(treeList, had);
    paintLink();                 // the Page tab's link section (65-ctl.js)
    const aw = $('aclwrap');
    if (aw && !aw.hidden) renderPublished();
    renderConfBadge();
  }

  const treeShare = (path) => {
    const f = nodes.find((n) => !n.page && n.path === path);
    if (f && f.dshare) return f.dshare;
    const pages = nodes.filter((n) => n.page && n.path.startsWith(path + '/'));
    if (!pages.length) return 'private';
    const s = pages[0].share || 'private';
    return pages.every((p) => (p.share || 'private') === s) ? s : 'mixed';
  };

  const pageCount = (path) =>
    nodes.filter((n) => n.page && n.path.startsWith(path + '/')).length;

  const setCtlLabels = () => {
    const t = mode === 'know' ? 'memory' : curFolder ? 'folder' : 'page';
    $('del').textContent = 'delete ' + t;
    $('mv').textContent = t === 'page' ? 'move / rename' : 'move / rename ' + t;
  };

  async function pickFolder(path) {
    if (!(await docTab()) || !(await guardDirty())) return;
    dirty = false;
    clearTimeout(autoTimer);
    selectFolder(path);
  }
  function selectFolder(path) {
    curFolder = path;
    curKind = null;
    exitGrub();
    exitRev();
    folderCtx = path;
    setOpen(null, { shown: path, readOnly: true,
      url: '/apps/lattice/app?into=' + encodeURIComponent(path) });
    src.value = '';
    render();
    prevBlank();
    cerr.textContent = ' '; cerr.className = 'ok';
    markCurrent();
    setCtlLabels();
    showShare((nodes.find((n) => !n.page && n.path === path) || {}).dshare || 'private');
    const c = pageCount(path);
    st('folder · ' + c + ' page' + (c === 1 ? '' : 's'));
  }

// ── src/31-marks.js ───────────────────────────────────────────────────────
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

  function markGo(e, url) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    browseIn(readerUrl(url));
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
    if (!(await askDanger('remove bookmark ' + (b.title || b.url) + '?', 'remove'))) return;
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
  document.addEventListener('lat-pane', (e) => {
    if (e.detail.side === 'l' && e.detail.id === 'marks') loadMarks();
  });
  if (paneShows('l', 'marks')) loadMarks();

// ── src/34-treemenu.js ────────────────────────────────────────────────────
  function treeTarget(row) {
    const tk = (row && row.dataset.tk) || '';
    if (tk.startsWith('p:')) return { kind: 'page', path: tk.slice(2) };
    if (tk.startsWith('f:')) return { kind: 'folder', path: tk.slice(2) };
    if (tk.startsWith(SWM + '/')) {
      const rest = tk.slice(SWM.length + 1);
      const cut = rest.indexOf('/');
      if (cut < 0) return null;
      const host = rest.slice(0, cut), path = rest.slice(cut + 1);
      const it = sharedWithMe.find((s) => s.host === host && s.path === path);
      return it ? { kind: 'swm', it } : null;
    }
    return null;
  }
  function treeDelete(row) {
    const t = treeTarget(row);
    if (!t) return;
    if (t.kind === 'swm') removeShared(t.it);
    else deletePath(t.path, t.kind === 'folder');
  }
  treeList.latDel = treeDelete;

  let treeMenuEl = null;
  let treeMenuRow = null;
  let treeMenuAt = 0;
  function treeMenuClose(refocus) {
    if (!treeMenuEl) return;
    treeMenuEl.remove();
    treeMenuEl = null;
    const row = treeMenuRow;
    treeMenuRow = null;
    if (refocus && row && row.isConnected) row.focus();
  }
  function treeMenu(row, x, y, right) {
    const t = treeTarget(row);
    if (!t) return false;
    if (treeMenuEl && treeMenuRow === row) return true;
    treeMenuClose(false);
    const m = document.createElement('div');
    m.className = 'dtmenu treemenu';
    m.setAttribute('role', 'menu');
    const item = (id, label, run) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.dataset.mi = id;
      b.textContent = label;
      b.onclick = () => { treeMenuClose(true); run(); };
      if (id === 'del') b.classList.add('danger');
      m.append(b);
    };
    if (t.kind === 'page') {
      item('link', 'Copy link', () => copyLink(pageUrb(t.path)));
      item('mv', 'Rename / move', () => askMovePage(t.path));
      item('pdf', 'Export PDF', () => exportPagePdf(t.path));
      item('del', 'Delete', () => treeDelete(row));
    } else if (t.kind === 'folder') {
      item('new', 'New page here', async () => { if (await guardDirty()) newFile(t.path); });
      item('share', 'Share folder', async () => {
        await pickFolder(t.path);
        if (curFolder !== t.path) return;
        paneOpen('r', true);
        paneTab('r', 'page');
        const sec = $('sharesec');
        if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'nearest' });
      });
      item('mv', 'Rename / move', () => moveFolder(t.path));
      item('del', 'Delete', () => treeDelete(row));
    } else {
      item('link', 'Copy link', () => copyLink(swmUrb(t.it)));
      item('in', 'Move into my pages', () => askMoveIn(t.it));
      item('del', 'Remove from list', () => treeDelete(row));
    }
    m.onkeydown = (e) => {
      const bs = [...m.querySelectorAll('button')];
      const i = bs.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length].focus();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        treeMenuClose(true);
      }
    };
    m.style.visibility = 'hidden';
    document.body.append(m);
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(4, Math.min(right ? x - w : x, innerWidth - w - 4)) + 'px';
    m.style.top = Math.max(4, y + h > innerHeight - 4 ? y - h : y) + 'px';
    m.style.visibility = '';
    treeMenuEl = m;
    treeMenuRow = row;
    treeMenuAt = performance.now();
    m.querySelector('button').focus();
    return true;
  }
  const rowSpot = (row) => {
    const r = row.getBoundingClientRect();
    return [r.left + 16, r.bottom];
  };
  treeList.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[role=treeitem]');
    if (!row || !treeTarget(row)) return;
    e.preventDefault();
    if (lpDown) { lpFired = true; clearTimeout(lpTimer); }
    const [x, y] = e.clientX || e.clientY ? [e.clientX, e.clientY] : rowSpot(row);
    treeMenu(row, x, y);
  });

  function rowMore(row, name, rowName = name) {
    if (!row.hasAttribute('aria-label')) row.setAttribute('aria-label', rowName);
    const b = document.createElement('span');
    b.className = 'rmore';
    b.setAttribute('role', 'button');
    b.tabIndex = -1;
    b.setAttribute('aria-label', 'More actions for ' + name);
    b.title = 'More actions';
    b.innerHTML = ico('more');
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (treeMenuEl && treeMenuRow === row) { treeMenuClose(true); return; }
      const r = b.getBoundingClientRect();
      treeMenu(row, r.right, r.bottom + 2, true);
    });
    b.addEventListener('auxclick', (e) => { e.preventDefault(); e.stopPropagation(); });
    row.append(b);
    return b;
  }

  const LP_MS = 500, LP_SLOP = 10;
  let lpTimer = 0, lpDown = null, lpFired = false;
  const lpCancel = () => { clearTimeout(lpTimer); lpDown = null; };
  treeList.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const row = e.target.closest('[role=treeitem]');
    if (!row || !treeTarget(row)) return;
    lpDown = { row, x: e.clientX, y: e.clientY };
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      const d = lpDown;
      if (!d || !d.row.isConnected) return;
      lpFired = true;
      if (navigator.vibrate) try { navigator.vibrate(10); } catch {}
      treeMenu(d.row, d.x, d.y);
    }, LP_MS);
  });
  treeList.addEventListener('pointermove', (e) => {
    if (lpDown && Math.hypot(e.clientX - lpDown.x, e.clientY - lpDown.y) > LP_SLOP) lpCancel();
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) treeList.addEventListener(t, lpCancel);
  treeList.addEventListener('scroll', lpCancel, true);
  treeList.addEventListener('click', (e) => {
    if (!lpFired) return;
    lpFired = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  addEventListener('pointerdown', (e) => {
    lpFired = false;
    const more = e.target.closest && e.target.closest('.rmore');
    if (more && treeMenuRow && treeMenuRow.contains(more)) return;
    if (treeMenuEl && !treeMenuEl.contains(e.target)) treeMenuClose(false);
  }, true);
  addEventListener('keydown', () => { lpFired = false; }, true);
  addEventListener('resize', () => treeMenuClose(false));
  addEventListener('scroll', (e) => {
    if (treeMenuEl && !treeMenuEl.contains(e.target)
      && performance.now() - treeMenuAt > 300) treeMenuClose(false);
  }, true);

  window.latTreeMenu = { open: (tk) => {
    const row = [...treeList.querySelectorAll('[role=treeitem]')].find((r) => r.dataset.tk === tk);
    if (!row) return false;
    const [x, y] = rowSpot(row);
    return treeMenu(row, x, y);
  } };

// ── src/35-pages.js ───────────────────────────────────────────────────────
  const setFolderCtx = (name) =>
    { folderCtx = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''; };

  let openSeq = 0;
  let openDrawers = 0;
  function openNext() { busyEnd('open'); openDrawers = drawerSeq; return ++openSeq; }
  async function openPage(name) {
    if (!(await guardDirty())) return false;
    const my = openNext();
    grubPath = null;
    if (mode === 'know') setMode('pages');
    src.readOnly = false;
    setFolderCtx(name);
    const q = await offGet(name);
    if (q) {
      const d = { body: q.body, kind: q.kind, rev: q.baseRev || 0, share: 'private' };
      applyPage(name, d, true);
      snapPage(name, d);
      return true;
    }
    const hit = !linkOf(name) && pageCache.get(name);
    if (hit) {
      const local = ['md', 'gmi', 'html', 'text'].includes(hit.kind);
      applyPage(name, local ? { ...hit, html: undefined } : hit, local);
      snapPage(name, hit);
      return true;
    }
    const node = nodes.find((n) => n.page && n.path === name);
    const painted = !!node && typeof node.body === 'string';
    if (!linkOf(name)) sensWait = name;
    try { return await openRead(name, my, node, painted); }
    finally {
      if (sensWait === name) {
        sensWait = null;
        if (current === name && !curFolder) refreshSensitive(name);
      }
    }
  }
  async function openRead(name, my, node, painted) {
    const owed = !painted || !['md', 'gmi', 'html', 'text'].includes(node.kind);
    const end = owed ? busy('open') : null;
    const late = painted ? 0
      : setTimeout(() => { if (my === openSeq) stWork('opening ' + name + '\u2026'); }, BUSY_MS);
    const bodyShown = (kind) => {
      clearTimeout(late);
      if (end && ['md', 'gmi', 'html', 'text'].includes(kind)) end();
    };
    try { return await openReadRun(name, my, node, painted, bodyShown); }
    finally { if (end) end(); clearTimeout(late); }
  }
  async function openReadRun(name, my, node, painted, bodyShown) {
    if (painted) {
      applyPage(name, node, true);
      snapPage(name, node);
    }
    let fromUrl = null;
    if (!painted) {
      fromUrl = location.pathname + location.search;
      history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
      if (node && !linkOf(name)) {
        const b = await bodyRead(name);
        if (my !== openSeq) return;
        if (b) {
          srcRead(name).catch(() => {});
          painted = true;
          applyPage(name, b, true);
          snapPage(name, b);
          bodyShown(b.kind || node.kind);
        }
      }
    }
    const unwind = () => { if (fromUrl && my === openSeq) history.replaceState(null, '', fromUrl); };
    const shown = src.value;
    let d = null, gen = -1;
    try {
      gen = sensGen;
      const r = await srcRead(name);
      if (r.status === 504 && linkOf(name)) {
        linkSeen(name, false);
        let j = null;
        try { j = await r.json(); } catch {}
        if (my !== openSeq) return;
        const why = (j && j.error) || linkOf(name).host + ' is unreachable or no longer shares this page';
        if (j && j.cached && typeof j.cached.body === 'string') {
          linkStale.add(name);
          applyPage(name, j.cached);
          st(why + '. Showing the last copy read, read-only', false);
          return true;
        }
        if (painted) return true;
        st('open failed: ' + why, false); unwind();
        return false;
      }
      if (!r.ok) {
        if (painted) return true;
        st('open failed' + await errText(r), false); unwind();
        return my === openSeq ? false : undefined;
      }
      d = await r.json();
    } catch {
      if (painted) return true;
      st('open failed', false); unwind();
      return my === openSeq ? false : undefined;
    }
    if (typeof d.sensitive === 'boolean' && sensGen === gen) sensKnown.set(name, d.sensitive);
    if (my !== openSeq) {
      const nd = nodes.find((n) => n.page && n.path === name);
      if (!d.link && !pageCache.has(name) && nd && !nd.link && nd.body === d.body
          && !(typeof nd.rev === 'number' && nd.rev > d.rev)) pageCache.set(name, d);
      return;
    }
    if (d.link) { linkSeen(name, true); linkStale.delete(name); linkCf.delete(name); }
    if (painted && src.value !== shown) {
      if (current === name && typeof d.comments === 'boolean') cmtShow(name, d.comments);
      return true;
    }
    if (!d.link) pageCache.set(name, d);
    snapPage(name, d);
    applyPage(name, d);
    return true;
  }
  const bodyRead = async (name) => {
    try {
      const r = await fetch(api + '/page-source?name=' + encodeURIComponent(name));
      if (!r.ok) return null;
      const d = await r.json();
      if (typeof d.body !== 'string' || d.link) return null;
      return { body: d.body, kind: d.kind, rev: d.rev, share: d.share, comments: d.comments };
    } catch { return null; }
  };
  function applyPage(name, d, quiet) {
    curFolder = null;
    setCtlLabels();
    setOpen(name, { readOnly: true, kind: d.kind,
      url: '/apps/lattice/app?name=' + encodeURIComponent(name) });
    curKind = d.kind;
    curRev = d.rev || 0;
    refreshTexButton();
    src.value = d.body;
    dirty = false;
    everTyped = false;
    render(); syncSoon();
    markCurrent();
    st(d.kind + ' · rev ' + d.rev);
    exitRev();
    src.readOnly = linkRO(name);
    resetPanels();
    showShare(d.share || 'private');
    cmtShow(name, d.comments);
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
    if (typeof d.html === 'string' && d.kind !== 'tex' && !(taskLive() && hasTask(d.body))) {
      prev.removeAttribute('src'); prevDoc(withPreviewScrollbars(d.html, true));
    }
    else if (!quiet) refreshPreview();
    else paintLocal();
    if (!CONTENT() && !quiet) checkErrors();
    drawersCloseSince(openDrawers);
  }

  function blankPage(into) {
    if (mode === 'know') setMode('pages');
    openNext();          // an open still in flight must not land over this
    folderCtx = into || '';
    curFolder = null;
    curKind = null;
    refreshTexButton();
    exitGrub();
    exitRev();
    setCtlLabels();
    setOpen(null, { shown: into ? into + '/' : '', url: '/apps/lattice/app' });
    src.value = '';
    dirty = false;
    everTyped = false;   // a new file is a fresh editor state, like applyPage
    render();
    renderTree();
    st('new page — name it, write, save');
    prevBlank();
    showShare('private');
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
  }

  function newFile(into, focusName = true) {
    if (!focusName) return blankPage(into);
    (async () => {
      const seed = into ? into.replace(/\/+$/, '') + '/'
        : mode === 'know' || !docFront() ? '' : (pname.value || '');
      const picked = await askNameKind('page name (e.g. notes/todo)', seed,
        'create', pkind.value);
      if (!picked) return;
      if (!(await docTab())) return;
      blankPage(into);
      let name = picked.name;
      let kind = picked.kind;
      const dot = name.lastIndexOf('.');
      const typed = dot > 0 ? extKind(name.slice(dot + 1)) : null;
      if (typed) { kind = typed; name = name.slice(0, dot); }
      const rn = realName(name);
      if (!rn) return;
      name = rn.name;
      newRn = rn;
      pkind.value = kind;
      if (kind === 'fodt' && !(await writerBlank())) return;
      setOpen(null, { shown: name });
      const already = nodes.some((n) => n.page && n.path === name);
      if (!already) { addTreeNode(name, kind, true); applyDnames(rn); snapTree(); renderTree(); }
      const queued = (await save()) === 'queued';
      if (!already && !queued) {
        if (current === name) setTreePending(name, false);
        else { dropTreeNodes(name); snapTree(); renderTree(); }
      }
      src.focus();
    })();
  }

  async function newFolder() {
    let seed = folderCtx ? folderCtx + '/' : '';
    for (;;) {
      const typed = await askName('folder name (e.g. notes or notes/sub)', seed, 'create');
      if (!typed) return;
      const rn = realName(typed);
      const name = rn.name;
      const r = await mutate(api + '/folder-new?name=' + encodeURIComponent(name) + dnameQ(rn));
      if (r.ok || r.offline) {
        st(r.offline ? 'folder created offline' : 'folder created');
        addFolderNodes(name);
        applyDnames(rn);
        snapTree();
        renderTree();
        return;
      }
      st('folder failed' + await errText(r), false);
      seed = typed;
    }
  }


  const flushPending = () => {
    if (!savePending) return;
    const pending = savePending;
    savePending = false;
    if (!dirty && !pending.create) return;
    if (typeof pending === 'function') pending(); else autosave();
  };
  const queueSave = (fn, create) => {
    const prev = savePending;
    const keep = typeof prev === 'function' && prev.create;
    savePending = Object.assign(keep
      ? async () => { await prev(); if (create || dirty) return fn(); } : fn,
    { create: !!create || keep });
  };
  const patchLocal = (name, kind, sent, rev) => {
    const c = pageCache.get(name);
    const k = kind || (c && c.kind);
    if (c && rev && ['md', 'gmi', 'html', 'text', 'tex'].includes(k)) {
      pageCache.set(name, { ...c, body: sent, kind: k, rev, html: undefined });
    } else pageCache.delete(name);
    const nd = nodes.find((n) => n.page && n.path === name);
    if (nd && !nd.link) { nd.body = sent; if (kind) nd.kind = kind; persistTree(); }
  };
  window.addEventListener('beforeunload', (e) => {
    if (!window.__latUnsaved()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  const linkBase = (name) => (linkOf(name) && curRev ? '&base=' + curRev : '');
  async function linkSaveFail(name, w) {
    const lk = linkOf(name);
    const r = w.r;
    if (!lk) return false;
    if (r && r.status === 409) {
      linkCf.add(name);           // autosave stands down; the bar offers the ways out
      st('not saved: ' + lk.host + ' changed this page since you opened it', false);
    } else if (w.gone) {
      if (r && r.status === 504) linkSeen(name, false);
      st('not saved: ' + lk.host + ' is unreachable or no longer shares this page', false);
    } else return false;
    if (current === name) { cerr.textContent = 'NOT saved'; cerr.className = 'err'; }
    paintLinkCf(current);
    return true;
  }

  let newRn = null;
  const createdHere = (creating, name) => creating && current === null && pname.value === name;
  const pageHere = () => mode !== 'know' && !grubPath;
  const madePage = (name) => {
    const rn = realName(name);
    return !!rn && nodes.some((n) => n.page && n.path === rn.name && !n.pending);
  };
  async function save(kindOverride, fixed) {
    if (!fixed) writerSync();     // a Writer page's text into src.value
    if (!fixed && curFolder) { st('folder selected — open a page to edit', false); return; }
    if (!fixed && viewingRev !== null) { st('viewing rev ' + viewingRev + ' — use restore', false); return; }
    let name = fixed ? fixed.name : pname.value.trim().replace(/^\/+|\/+$/g, '');
    if (!name) { st('name required', false); return; }
    const creating = !!fixed || current === null;
    if (saving) {
      const doc = current, shown = pname.value;
      const own = fixed || (creating ? { name, body: src.value,
        kind: kindOverride || curKind || pkind.value, rn: newRn,
        existed: madePage(name), tab: activeTab && activeTab.id } : null);
      if (creating && !fixed) newRn = null;
      queueSave(() => {
        if (own && !own.existed && madePage(own.name)) {
          const rn = realName(own.name);
          if (!fixed && mode !== 'know' && !grubPath && rn && current === rn.name && dirty)
            return save(kindOverride);
          return;
        }
        const here = !fixed && mode !== 'know' && !grubPath && current === doc
          && (doc !== null || pname.value === shown);
        if (here) { if (own) newRn = own.rn; return save(kindOverride); }
        if (own) return save(kindOverride, own);
      }, creating);
      return 'queued';
    }
    saving = true;
    st('saving…');
    const sent = fixed ? fixed.body : src.value;
    const kind = fixed ? fixed.kind : kindOverride || curKind || pkind.value;
    const rn = realName(name);
    if (!rn) {
      saving = false;
      st('bad name — use at least one letter or digit', false);
      return;
    }
    const rnc = !creating ? null : rn.dnames ? rn : fixed ? fixed.rn : newRn;
    if (!fixed) newRn = null;
    const dname = rnc ? rnc.dname : '';
    if (rn.name !== name) {
      name = rn.name;
      if (!fixed) setOpen(current, { shown: name, readOnly: pname.readOnly });
    }
    const failed = () => {
      if (creating && nodes.some((n) => n.page && n.path === name && n.pending)) {
        dropTreeNodes(name); snapTree(); renderTree();
      }
      flushPending();
    };
    const url = api + '/page-save?name=' + encodeURIComponent(name) +
      '&type=' + kind + (creating ? '&new=1' : '') + dnameQ(rnc) + (creating ? '' : linkBase(name));
    let w = { gone: true };
    const sentAt = Date.now();
    try {
      if (!(jobWait && !creating && !linkOf(name)))
        w = await shipWrite(url, { method: 'POST', body: sent || '\n' }, { save: true });
    } finally { saving = false; }
    const r = w.r;
    if (await linkSaveFail(name, w)) return failed();
    if (w.gone) {
      const queued = await enqueueSave(name, kind, sent, creating, rnc);
      if (!queued) {
        cerr.textContent = 'NOT saved'; cerr.className = 'err';
        return failed();
      }
      if (creating) { addTreeNode(name, kind, false); applyDnames(rnc); snapTree(); renderTree(); }
      const stillHere = fixed ? tabAdopt(fixed, name)
        : pageHere() && (current === name || createdHere(creating, name));
      if (!stillHere) tabLanded('page', name, sent);
      if (stillHere) {
        current = name;
        tabFollow();         // a new page's tab is named now (21-tabs.js)
        curKind = kind;
        pname.readOnly = true;
        if (src.value === sent) dirty = false;
        else if (!savePending) savePending = true;
        history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
        cerr.textContent = queued === 'job' ? 'saves after the folder job' : 'saved offline';
        cerr.className = 'ok';
      }
      flushPending();
      return;
    }
    if (r && r.status === 409) {
      const why = await errText(r);
      st(/ moved to /.test(why) ? 'not saved' + why : 'that page already exists', false);
      return failed();
    }
    if (!r.ok) { st('save failed' + await errText(r), false); return failed(); }
    let vr = null;
    try { vr = await r.json(); } catch {}
    if (creating) { addTreeNode(name, kind, false); applyDnames(rnc); snapTree(); renderTree(); }
    patchLocal(name, kind, sent, vr && vr.rev);
    await dropQueued(name, sentAt);
    const stillHere = fixed ? tabAdopt(fixed, name)
      : pageHere() && (current === name || createdHere(creating, name));
    if (!stillHere) tabLanded('page', name, sent, vr && vr.rev);
    if (stillHere) {
      current = name;
      tabFollow();           // a new page's tab is named now (21-tabs.js)
      curKind = kind;
      pname.readOnly = true;
      if (src.value === sent) dirty = false;
      else if (!savePending) savePending = true;   // flushPending below saves it
      if (vr && vr.rev) curRev = vr.rev;
      if (linkCf.delete(name)) paintLinkCf(name);   // a retried link save landed
      if (vr && vr.conflicted) {
        st('saved — replaced an edit from elsewhere; it is kept at ' + vr.kept, false);
      } else if (dname) st('saved as ' + name + ' (shown as ' + dname + ')');
      else st(CONTENT() ? 'saved' : 'compiling\u2026');
      history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
      if (CONTENT()) { cerr.textContent = 'saved'; cerr.className = 'ok'; }
      else { setTimeout(checkErrors, 800); setTimeout(checkErrors, 2200); }
    }
    flushPending();
    if (offCount) replayQueue(true);     // back online: drain the backlog
  }

  let autoTimer = null;
  const autosaveOn = () => { try { return localStorage.latAutosave !== '0'; } catch { return true; } };
  window.addEventListener('storage', (e) => {
    if (e.key !== 'latAutosave' || !autosaveOn() || !dirty) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(autosave, 2000);
  });
  async function autosave() {
    if (grubPath) { if (dirty) st('unsaved, Ctrl+S to save'); return; }
    writerSync();
    if (!current || curFolder || !dirty || viewingRev !== null) return;
    if (moving) { clearTimeout(autoTimer); autoTimer = setTimeout(autosave, 1000); return; }
    if (mode !== 'know' && linkCf.has(current) && linkOf(current)) {
      st('not saved: ' + linkOf(current).host + ' changed this page since you opened it', false);
      return;
    }
    if (!autosaveOn()) { st('unsaved, Ctrl+S to save'); return; }
    if (saving) { if (!savePending) savePending = true; return; }
    saving = true;
    const target = current;
    const sent = src.value;
    const know = mode === 'know';
    const tkind = curKind || pkind.value;
    const trev = curRev;
    const here = () => current === target && (mode === 'know') === know && !grubPath;
    const url = know
      ? api + '/know-save?key=' + encodeURIComponent(target)
      : api + '/page-save?name=' + encodeURIComponent(target) +
        '&type=' + tkind + linkBase(target);
    let w = { gone: true };
    const sentAt = Date.now();
    try {
      if (!(jobWait && !know && !linkOf(target)))
        w = await shipWrite(url, { method: 'POST', body: sent || '\n' }, { save: true });
    } finally { saving = false; }
    const r = w.r;
    if (!know && await linkSaveFail(target, w)) { flushPending(); return; }
    const tk = know ? 'know' : 'page';
    if (w.gone) {
      if (!(await (know ? enqueueKnow(target, sent) : enqueueSave(target, tkind, sent, false, null, trev)))) {
        flushPending();
        return;
      }
      if (here() && src.value === sent) dirty = false;
      else tabLanded(tk, target, sent);
      flushPending();
      return;
    }
    if (!r.ok) { st('autosave failed' + await errText(r), false); flushPending(); return; }
    let vr = null;
    if (!know) { try { vr = await r.json(); } catch {} }
    if (!know) { patchLocal(target, null, sent, vr && vr.rev); await dropQueued(target, sentAt); }
    if (!here()) tabLanded(tk, target, sent, vr && vr.rev);
    if (here()) {
      if (src.value === sent) dirty = false;   // typed during the request? stay dirty
      if (!know && vr && vr.rev) curRev = vr.rev;
      if (vr && vr.conflicted)
        st('autosaved — replaced an edit from elsewhere; it is kept at ' + vr.kept, false);
      else st('autosaved');
      if (!know && !CONTENT()) setTimeout(checkErrors, 800);
    }
    flushPending();
    if (offCount) replayQueue(true);     // this autosave proves the ship is back too
  }

  async function saveParked(t) {
    const s = t.snap;
    if (!s || !s.dirty || !t.key || !autosaveOn() || moving) return;
    if (t.kind !== 'page' && t.kind !== 'know') return;
    const know = t.kind === 'know';
    if (!know && linkCf.has(t.key) && linkOf(t.key)) return;
    parkedRun++;
    try { await parkedSave(t, s, know); } finally { parkedRun--; }
  }
  async function parkedSave(t, s, know) {
    await savesSettled(false);
    if (!know && linkCf.has(t.key) && linkOf(t.key)) return;
    if (t.snap !== s || !s.dirty || !allTabs().includes(t)) return;
    saving = true;
    const name = t.key;
    const sent = s.body;
    const kind = s.kind || s.pkind;
    const url = know ? api + '/know-save?key=' + encodeURIComponent(name)
      : api + '/page-save?name=' + encodeURIComponent(name) + '&type=' + kind
        + (linkOf(name) && s.rev ? '&base=' + s.rev : '');
    let w = { gone: true };
    const sentAt = Date.now();
    try {
      if (!(jobWait && !know && !linkOf(name)))
        w = await shipWrite(url, { method: 'POST', body: sent || '\n' }, { save: true });
    } finally { saving = false; }
    const landed = (rev) => {
      tabLanded(t.kind, name, sent, rev);
      if (t === activeTab && current === name && (mode === 'know') === know && !grubPath) {
        if (src.value === sent) dirty = false;
        if (!know && rev) curRev = rev;
      }
    };
    if (!know && await linkSaveFail(name, w)) { flushPending(); return; }
    if (w.gone) {
      if (await (know ? enqueueKnow(name, sent) : enqueueSave(name, kind, sent, false, null, s.rev)))
        landed(null);
      flushPending();
      return;
    }
    if (!w.r.ok) {
      st('autosave of ' + name + ' failed' + await errText(w.r), false);
      flushPending();
      return;
    }
    let vr = null;
    if (!know) {
      try { vr = await w.r.json(); } catch {}
      patchLocal(name, null, sent, vr && vr.rev);
      await dropQueued(name, sentAt);
    }
    else knowGen++;
    landed(vr && vr.rev);
    st('autosaved ' + name);
    flushPending();
    if (offCount) replayQueue(true);
  }

  let saveTail = 0, parkedRun = 0;
  const tailed = (fn) => async (...a) => {
    saveTail++;
    try { return await fn(...a); } finally { saveTail--; }
  };
  autosave = tailed(autosave);
  save = tailed(save);
  saveKnow = tailed(saveKnow);
  saveGrub = tailed(saveGrub);
  async function savesSettled(parked = true) {
    const t0 = Date.now();
    while ((saving || saveTail || (parked && parkedRun)) && Date.now() - t0 < 35000)
      await new Promise((r) => setTimeout(r, 50));
  }

  const lcfBar = document.createElement('div');
  lcfBar.id = 'lnkcf';
  lcfBar.className = 'lnkcf';
  lcfBar.hidden = true;
  lcfBar.setAttribute('role', 'alert');
  lcfBar.innerHTML = '<span id="lnkcfmsg"></span>' +
    '<button type="button" id="lnkcfre">Reload theirs</button>' +
    '<button type="button" id="lnkcfkeep">Keep mine as a copy</button>';
  $('docarea').before(lcfBar);
  function paintLinkCf(name) {
    const bar = $('lnkcf');
    if (!bar) return;
    const lk = name && name === current && linkCf.has(name) ? linkOf(name) : null;
    bar.hidden = !lk;
    if (lk) $('lnkcfmsg').textContent = lk.host + ' changed this page since you opened it. ' +
      'Your text here is not saved.';
  }
  async function linkReload() {
    const name = current;
    if (!linkOf(name)) return;
    dirty = false;
    clearTimeout(autoTimer);
    linkCf.delete(name);
    paintLinkCf(name);
    await openPage(name);
  }
  async function linkKeepMine() {
    const name = current;
    const lk = linkOf(name);
    if (!lk) return;
    const body = src.value;
    const kind = curKind || pkind.value;
    for (let i = 1; i < 100; i++) {
      const copy = name + '-mine' + (i > 1 ? '-' + i : '');
      if (nodes.some((n) => n.path === copy)) continue;
      const r = await fetch(api + '/page-save?name=' + encodeURIComponent(copy) + '&type=' + kind +
        '&new=1', { method: 'POST', body: body || '\n' }).catch(() => null);
      if (r && r.status === 409) continue;
      if (!r || !r.ok) { st('copy failed' + await errText(r) + ', your text is still here', false); return; }
      if (current !== name) return;
      addTreeNode(copy, kind, false);
      snapTree();
      renderTree();
      await linkReload();
      st('your text is kept at ' + copy + '; ' + name + ' shows ' + lk.host + '\u2019s again');
      return;
    }
  }
  $('lnkcfre').onclick = linkReload;
  $('lnkcfkeep').onclick = linkKeepMine;

// ── src/40-grub.js ────────────────────────────────────────────────────────
  let grubPath = null;
  let grubShip = null;   // '~ship' when the grub lives on ANOTHER ship; null = local
  let grubRev = null;
  let grubUnsure = null;
  let grubPrevKind = null;
  const exitGrub = () => {
    grubPath = null; grubShip = null; grubRev = null; grubUnsure = null;
    if (grubPrevKind !== null) { pkind.value = grubPrevKind; grubPrevKind = null; }
  };
  async function openGrub(p, ship) {
    const my = openNext();
    enterGrub(p, ship);
    st('loading ' + p + '…');
    const url = grubShip
      ? api + '/browse-file?ship=' + encodeURIComponent(grubShip) + '&path=' + encodeURIComponent(p)
      : api + '/grub-source?path=' + encodeURIComponent(p);
    let r = null;
    try { r = await busyFetch(url, undefined, 'open'); } catch {}
    if (my !== openSeq) return;
    if (!r || !r.ok) {
      st('could not open ' + p + (r ? ' (' + r.status + ')' : ''), false);
      return false;
    }
    const d = await r.json();
    if (my !== openSeq) return;
    src.value = d.text || d.body || '';
    if (grubShip && typeof d.rev === 'number') grubRev = d.rev;
    src.readOnly = !d.editable;
    dirty = false;
    const blot = d.blot || d.mark || '';
    const mk = d.builder || extKind(String(blot).split('/').pop()) || 'hoon';
    if ([...pkind.options].some((o) => o.value === mk)) pkind.value = mk;
    pname.dispatchEvent(new Event('input'));
    curKind = mk;
    render();
    refreshPreview();
    st(!d.editable ? 'read-only — ' + blot + ' has no text form'
       : grubShip ? 'on ' + grubShip + ': saves need its permission'
       : 'grub ' + blot + ', no autosave here: Ctrl+S to save');
    return true;
  }
  function enterGrub(p, ship) {
    src.value = '';
    src.readOnly = true;
    dirty = false;
    render();
    grubPath = p;
    grubShip = ship || null;
    grubRev = null;
    grubUnsure = null;
    if (grubPrevKind === null) grubPrevKind = pkind.value;
    curFolder = null;
    prevBlank();
    const pg = /\/page\/(.+)\/code$/.exec(p);
    setOpen(null, { shown: grubShip ? grubShip + ': ' + (pg ? pg[1] : p) : p, readOnly: true,
      url: '/apps/lattice/app?grub=' + encodeURIComponent(p) +
        (grubShip ? '&ship=' + encodeURIComponent(grubShip) : '') });
  }
  async function saveGrub() {
    if (!grubPath || src.readOnly) return;
    if (saving) {
      const p = grubPath, s = grubShip;
      queueSave(() => { if (grubPath === p && grubShip === s) return saveGrub(); });
      return;
    }
    saving = true;
    st('saving…');
    const sent = src.value;
    const p = grubPath, s = grubShip;
    if (s && grubUnsure !== null) {
      const was = grubUnsure;
      grubUnsure = null;
      try {
        const g = await tfetch(api + '/browse-file?ship=' + encodeURIComponent(s) +
          '&path=' + encodeURIComponent(p), {}, 15000);
        const d = g && g.ok ? await g.json() : null;
        if (d && typeof d.rev === 'number' && grubPath === p && grubShip === s
          && (d.text || d.body || '') === was) grubRev = d.rev;
      } catch {}
    }
    let r = null;
    try {
      r = await tfetch(s
        ? api + '/remote-save?ship=' + encodeURIComponent(s) +
          '&path=' + encodeURIComponent(p) +
          (grubRev !== null ? '&base=' + grubRev : '')
        : api + '/grub-save?path=' + encodeURIComponent(p),
        { method: 'POST', body: sent }, s ? 45000 : 30000);
    } catch {}
    saving = false;
    let j = null;
    if (s && r) { try { j = await r.clone().json(); } catch {} }
    const out = j && j.outcome;
    const here = grubPath === p && grubShip === s;
    if (out && out !== 'landed') {
      const say = {
        unverified: 'sent — ' + s + ' took it but did not confirm; reload to check',
        conflict: 'not saved — ' + s + ' changed this page since you opened it; copy your text and reopen',
        unreachable: (/may still land/.test(j.error || '') ? 'may not have saved — ' : 'not saved — ')
          + (j.error || s + ' did not answer'),
        refused: 'not saved — ' + s + ' refused the write' + (j.error ? ': ' + j.error : ''),
      }[out] || 'save rejected: ' + (j.error || r.status);
      if (here) st(say, false);
      if (here && (out === 'unverified' || /may still land/.test(j.error || ''))) grubUnsure = sent;
      flushPending();
      return;
    }
    if (!r || !r.ok) {
      if (shipGone(r)) {
        st(r ? 'ship unreachable — grub edits do not queue'
          : 'no answer — the save may still land; Ctrl+S to try again', false);
        flushPending();
        return;
      }
      st('save rejected' + await errText(r), false);
      flushPending();
      return;
    }
    if (here && j && typeof j.rev === 'number') grubRev = j.rev;
    if (here && src.value === sent) dirty = false;
    if (!here) tabLanded('grub', p, sent, null, s);
    if (here) st('saved');
    bustPages(String(p).replace(/\/[^/]*$/, ''));
    flushPending();
  }

// ── src/45-templates.js ───────────────────────────────────────────────────
  const saveFront = () => {
    if (!docFront()) return;
    if (grubPath) saveGrub();
    else if (mode === 'know') saveKnow();
    else save();
  };
  $('save').onclick = saveFront;
  async function newFromTemplate() {
    let names = [];
    try {
      const r = await busyFetch(api + '/template-list');
      if (r.ok) names = (await r.json()).templates || [];
    } catch {}
    if (!names.length) { st('no templates available', false); return; }
    const tmpl = await askChoice('start from which template?', names, 'next');
    if (!tmpl) return;
    let seed = folderCtx ? folderCtx + '/' + tmpl : tmpl;
    for (;;) {
      const typed = await askName('name for the new ' + tmpl, seed, 'create');
      if (!typed) return;
      const rn = realName(typed);
      const name = rn.name;
      stWork('creating ' + name + ' from ' + tmpl + '\u2026 (one save per page)');
      let r = null;
      try {
        r = await mutate(api + '/template-new?template=' + encodeURIComponent(tmpl) +
          '&name=' + encodeURIComponent(name) + dnameQ(rn));
      } catch {}
      if (r && (r.ok || r.offline)) {
        await loadTree();
        const has = (p) => nodes.some((n) => n.page && n.path === p);
        if (has(name)) await openIn('page', name);
        else if (has(name + '/index')) await openIn('page', name + '/index');
        else if (nodes.some((n) => !n.page && n.path === name)) await pickFolder(name);
        st('created ' + name + ' from ' + tmpl);
        return;
      }
      if (r && r.status === 409) st('a page by that name exists', false);
      else st('template failed' + await errText(r), false);
      seed = name;
    }
  }
  $('newtmpl').onclick = newFromTemplate;
  $('newfile').onclick = async () => { if (await guardDirty()) newFile(''); };
  $('newfolder').onclick = newFolder;
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      saveFront();
    }
  });
  const proseFlavor = () => {
    if (mode === 'know') return 'md';
    return ['md', 'text', 'gmi'].includes(pkind.value) ? pkind.value : null;
  };
  const applyEdit = (r) => {
    src.setSelectionRange(r.from, r.to);
    let ok = false;
    try { ok = document.execCommand('insertText', false, r.text); } catch {}
    if (!ok) src.setRangeText(r.text, r.from, r.to, 'end');
    src.setSelectionRange(r.caret, r.caretEnd == null ? r.caret : r.caretEnd);
    edited();
  };
  const continueList = () => {
    if (src.readOnly) return false;
    const flavor = proseFlavor();
    if (!flavor) return false;
    const r = listEnter(src.value, src.selectionStart, src.selectionEnd, flavor);
    if (!r) return false;
    applyEdit(r);
    return true;
  };
  let plainBreak = false;
  src.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;
    if (ac.open) return;
    if (plainBreak) { plainBreak = false; return; }
    if (continueList()) e.preventDefault();
  });
  src.addEventListener('keydown', (e) => {
    if (ac.open) {
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); acAccept(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault(); ac.sel = (ac.sel + 1) % ac.items.length; acRender(); return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault(); ac.sel = (ac.sel - 1 + ac.items.length) % ac.items.length; acRender(); return;
      }
      if (e.key === 'Escape') { e.preventDefault(); acClose(); return; }
    }
    if (e.key === 'Enter') plainBreak = e.shiftKey || e.metaKey || e.ctrlKey || e.altKey;
    if (e.key === 'Enter' && !plainBreak && continueList()) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (src.readOnly) return;   // readOnly blocks typing, not scripted edits
      const flavor = proseFlavor();
      if (flavor) {
        const r = listTab(src.value, src.selectionStart, src.selectionEnd,
          flavor, e.shiftKey ? -1 : 1);
        if (r) { applyEdit(r); return; }
      }
      if (e.shiftKey) return;
      applyEdit({ from: src.selectionStart, to: src.selectionEnd,
        text: '  ', caret: src.selectionStart + 2 });
    }
  });

  const ltab = (dir) => {
    if (src.readOnly) return;
    const flavor = proseFlavor();
    if (!flavor) return;
    const r = listTab(src.value, src.selectionStart, src.selectionEnd, flavor, dir);
    if (r) applyEdit(r);
  };
  const lbtns = document.createElement('div');
  lbtns.id = 'lbtns';
  for (const [id, glyph, title, dir] of [
    ['loutd', '\u21e4', 'list item out a level', -1],
    ['lind', '\u21e5', 'list item in a level', 1],
  ]) {
    const b = document.createElement('button');
    b.id = id; b.type = 'button'; b.textContent = glyph;
    b.title = title; b.setAttribute('aria-label', title);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); ltab(dir); });
    lbtns.appendChild(b);
  }
  $('ws').appendChild(lbtns);
  let lbTimer = null;
  const lbPaint = () => {
    clearTimeout(lbTimer);
    lbTimer = setTimeout(() => {
      const flavor = document.activeElement === src && !src.readOnly && proseFlavor();
      const on = !!flavor && !!(
        listTab(src.value, src.selectionStart, src.selectionEnd, flavor, 1) ||
        listTab(src.value, src.selectionStart, src.selectionEnd, flavor, -1));
      lbtns.classList.toggle('on', on);
    }, 120);
  };
  document.addEventListener('selectionchange', lbPaint);
  src.addEventListener('input', lbPaint);
  src.addEventListener('blur', lbPaint);

// ── src/55-autocomplete.js ────────────────────────────────────────────────
  const acEl = $('ac'), acMirror = $('acmirror');
  let ac = { open: false, start: -1, items: [], sel: 0 };

  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const segOf = (p) => p.slice(p.lastIndexOf('/') + 1);

  function acRank(q) {
    const here = current ? dirOf(current) : folderCtx || '';
    const ql = q.toLowerCase();
    const out = [];
    for (const n of nodes) {
      if (!n.page || n.path === current) continue;
      const path = n.path, seg = segOf(path).toLowerCase(), pl = path.toLowerCase();
      let sc;
      if (!ql) sc = 10;
      else if (seg === ql) sc = 130;
      else if (seg.startsWith(ql)) sc = 100;
      else if (pl.startsWith(ql)) sc = 80;
      else if (seg.includes(ql)) sc = 55;
      else if (pl.includes(ql)) sc = 30;
      else continue;
      const d = dirOf(path);
      if (d === here) sc += 40;                      // sibling of what you are editing
      else if (here && d.startsWith(here + '/')) sc += 20;   // below you
      sc -= (path.split('/').length - 1) * 2;        // prefer shallower
      sc -= path.length * 0.02;                      // prefer shorter
      out.push({ path, sc });
    }
    return out.sort((a, b) => b.sc - a.sc).slice(0, 8).map((x) => x.path);
  }

  let acAnchor = null;   // {start, left, top, lh} - raw mirror offsets at ac.start
  const acCtx = document.createElement('canvas').getContext('2d');
  function acMeasureAnchor(pos) {
    const cs = getComputedStyle(src);
    for (const k of ['fontFamily', 'fontSize', 'lineHeight', 'padding', 'letterSpacing',
                     'whiteSpace', 'overflowWrap', 'tabSize'])
      acMirror.style[k] = cs[k];
    acMirror.style.width = src.clientWidth + 'px';
    acMirror.textContent = src.value.slice(0, pos);
    const mark = document.createElement('span');
    mark.textContent = '\u200b';
    acMirror.appendChild(mark);
    const a = { start: pos, left: mark.offsetLeft, top: mark.offsetTop,
                lh: parseFloat(cs.lineHeight || '18') };
    acMirror.textContent = '';
    acCtx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    return a;
  }
  function caretXY() {
    if (!acAnchor || acAnchor.start !== ac.start) acAnchor = acMeasureAnchor(ac.start);
    const q = src.value.slice(ac.start, src.selectionStart);
    const x = acAnchor.left + acCtx.measureText(q).width - src.scrollLeft;
    const y = acAnchor.top - src.scrollTop + acAnchor.lh;
    return [x, y];
  }

  const acClose = () => { ac.open = false; acEl.hidden = true; acAnchor = null; };

  function acRender() {
    acEl.textContent = '';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Tab to complete \u00b7 \u2191\u2193 to choose \u00b7 Esc to dismiss';
    acEl.appendChild(hint);
    ac.items.forEach((path, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (i === ac.sel ? ' on' : '');
      const nm = document.createElement('span');
      nm.className = 'nm'; nm.textContent = segOf(path);
      const dir = document.createElement('span');
      dir.className = 'dir'; dir.textContent = dirOf(path) || '/';
      row.append(nm, dir);
      row.onmousedown = (e) => { e.preventDefault(); acAccept(i); };
      acEl.appendChild(row);
    });
    const [x, y] = caretXY();
    acEl.hidden = false;
    const w = src.clientWidth, h = src.clientHeight;
    acEl.style.left = Math.max(4, Math.min(x, w - acEl.offsetWidth - 8)) + 'px';
    acEl.style.top = (y + acEl.offsetHeight > h ? Math.max(4, y - acEl.offsetHeight - 20) : y) + 'px';
  }

  function acScan() {
    if (src.readOnly || mode === 'know' || pkind.value === 'fodt') return acClose();
    const upto = src.value.slice(0, src.selectionStart);
    const line = upto.slice(upto.lastIndexOf('\n') + 1);
    const i = line.lastIndexOf('[[');
    if (i < 0) return acClose();
    const q = line.slice(i + 2);
    if (q.includes(']]') || q.includes('[')) return acClose();
    if (!/^[a-z0-9/._~-]*$/i.test(q)) return acClose();
    const items = acRank(q);
    if (!items.length) return acClose();
    ac = { open: true, start: src.selectionStart - q.length, items, sel: 0 };
    acRender();
  }

  function acAccept(i) {
    if (!ac.open) return;
    const path = ac.items[i === undefined ? ac.sel : i];
    if (!path) return;
    const to = src.selectionStart +
      (src.value.slice(src.selectionStart).startsWith(']]') ? 2 : 0);
    const caret = ac.start + path.length + 2;
    applyEdit({ from: ac.start, to, text: path + ']]', caret });
    acClose();
  }

  src.addEventListener('input', acScan);
  src.addEventListener('click', acClose);
  src.addEventListener('blur', acClose);

// ── src/59-md.js ──────────────────────────────────────────────────────────
  const mdEsc = (t) => String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const mdUnesc = (t) => String(t)
    .replace(/&quot;/g, '"').replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<').replace(/&amp;/g, '&');

  const mdHref = (u) => {
    const s = mdUnesc(u).trim();
    return /^(https?:\/\/|urb:\/\/|mailto:|#|\/)/i.test(s) ? mdEsc(s) : '';
  };

  const CD_RE = /&CD(\d+);/g;
  const mdInline = (t) => {
    let s = mdEsc(t);
    const code = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      code.push(c);
      return '&CD' + (code.length - 1) + ';';
    });
    const tags = [];
    const tag = (html) => { tags.push(html); return '&TG' + (tags.length - 1) + ';'; };
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt, u) => {
      const h = mdHref(u);
      return h ? tag('<img alt="' + alt + '" src="' + h + '">') : m;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, txt, u) => {
      const h = mdHref(u);
      return h ? tag('<a href="' + h + '">') + txt + '</a>' : m;
    });
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_, tgt, label) => tag('<a href="'
        + mdHref('/apps/lattice/app?name=' + encodeURIComponent(mdUnesc(tgt).trim())) + '">')
        + (label || tgt.trim().replace(/\/+$/, '').split('/').pop() || tgt) + '</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/&TG(\d+);/g, (_, i) => tags[+i]);
    s = s.replace(CD_RE, (_, i) => '<code>' + code[+i] + '</code>');
    return s;
  };

  function mdToHtml(input, tasks, base = 0) {
    const lines = String(input == null ? '' : input).split('\n').map((l) => l.replace(/\r$/, ''));
    const out = [];
    let i = 0;
    const listStack = [];
    const closeLists = (toDepth) => {
      while (listStack.length > toDepth) out.push(listStack.pop() === 'ol' ? '</ol>' : '</ul>');
    };
    while (i < lines.length) {
      const ln = lines[i];

      const fence = ln.match(/^\s*(```|~~~)(.*)$/);
      if (fence) {
        closeLists(0);
        const close = fence[1];
        const body = [];
        i += 1;
        while (i < lines.length && !lines[i].trimStart().startsWith(close)) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1;                                   // the closing fence
        out.push('<pre><code>' + mdEsc(body.join('\n')) + '</code></pre>');
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) {
        closeLists(0); out.push('<hr>'); i += 1; continue;
      }

      const h = ln.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeLists(0);
        const n = h[1].length;
        out.push('<h' + n + '>' + mdInline(h[2]) + '</h' + n + '>');
        i += 1;
        continue;
      }

      if (/^\s*>\s?/.test(ln)) {
        closeLists(0);
        const q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          q.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push('<blockquote>' + mdToHtml(q.join('\n'), tasks, base + i - q.length) + '</blockquote>');
        continue;
      }

      if (ln.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        closeLists(0);
        const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
        const head = cells(ln);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(cells(lines[i]));
          i += 1;
        }
        out.push('<table><thead><tr>'
          + head.map((c) => '<th>' + mdInline(c) + '</th>').join('')
          + '</tr></thead><tbody>'
          + rows.map((r) => '<tr>' + r.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('')
          + '</tbody></table>');
        continue;
      }

      const li = ln.match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
      if (li) {
        const depth = Math.floor(li[1].replace(/\t/g, '    ').length / 2) + 1;
        const want = li[2] ? 'ul' : 'ol';
        while (listStack.length > depth) closeLists(listStack.length - 1);
        while (listStack.length < depth) {
          out.push(want === 'ol' ? '<ol>' : '<ul>');
          listStack.push(want);
        }
        let body = li[4];
        const task = body.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          body = '<input type="checkbox"' + (tasks ? ' data-line="' + (base + i) + '"' : ' disabled')
            + (task[1] === ' ' ? '' : ' checked') + '> ' + mdInline(task[2]);
        } else body = mdInline(body);
        out.push('<li>' + body + '</li>');
        i += 1;
        continue;
      }

      if (!ln.trim()) { closeLists(0); i += 1; continue; }

      const para = [];
      while (i < lines.length && lines[i].trim()
             && !/^\s*(#{1,6}\s|>|```|~~~|-{3,}\s*$)/.test(lines[i])
             && !/^(\s*)(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
        para.push(lines[i]);
        i += 1;
      }
      if (para.length) {
        closeLists(0);
        out.push('<p>' + mdInline(para.join('\n')) + '</p>');
      } else i += 1;
    }
    closeLists(0);
    return out.join('\n');
  }

  const TASK_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\](?=\s)/;
  const TASK_ANY = new RegExp(TASK_RE.source, 'm');
  const hasTask = (text) => typeof text === 'string' && TASK_ANY.test(text);
  function taskToggle(text, line, on) {
    let at = 0;
    for (let n = 0; n < line; n++) {
      at = text.indexOf('\n', at) + 1;
      if (!at) return null;
    }
    const end = text.indexOf('\n', at);
    const m = TASK_RE.exec(text.slice(at, end < 0 ? text.length : end));
    if (!m || (m[2] !== ' ') === !!on) return null;
    return { at: at + m[1].length, ch: on ? 'x' : ' ' };
  }

  const gmiToHtml = (input) => {
    const out = [];
    let pre = null;
    for (const ln of String(input == null ? '' : input).split('\n')) {
      if (pre !== null) {
        if (ln.trimEnd() === '```') { out.push('<pre>' + mdEsc(pre) + '</pre>'); pre = null; }
        else pre = pre === '' ? ln : pre + '\n' + ln;
        continue;
      }
      if (ln.trimEnd() === '```') { pre = ''; continue; }
      const h = ln.match(/^(#{1,3}) (.*)$/);
      if (h) { out.push('<h' + h[1].length + '>' + mdEsc(h[2]) + '</h' + h[1].length + '>'); continue; }
      if (ln.startsWith('=> ')) {
        const rest = ln.slice(3).replace(/^\s+/, '');
        const sp = rest.indexOf(' ');
        const raw = sp < 0 ? rest : rest.slice(0, sp);
        const desc = mdEsc((sp < 0 ? rest : rest.slice(sp + 1)).replace(/^\s+/, ''));
        if (raw.startsWith('urb://'))
          out.push('<p><a href="/apps/lattice?url=' + mdEsc(raw) + '">' + desc + '</a></p>');
        else if (/^https?:\/\//.test(raw))
          out.push('<p><a href="' + mdEsc(raw) + '" target="_blank" rel="noopener noreferrer">' + desc + '</a></p>');
        else out.push('<p>' + desc + '</p>');
        continue;
      }
      if (ln.startsWith('> ')) { out.push('<blockquote>' + mdEsc(ln.slice(2)) + '</blockquote>'); continue; }
      if (!ln.trim()) continue;
      out.push('<p>' + mdEsc(ln) + '</p>');
    }
    if (pre !== null) out.push('<pre>' + mdEsc(pre) + '</pre>');
    return out.join('\n');
  };

// ── src/60-preview.js ─────────────────────────────────────────────────────
  let fitCur = null, fitH = 0, fitOff = false;
  customElements.define('lat-preview', class extends HTMLElement {
    connectedCallback() {
      if (this.built) return;
      this.built = true;
      this.innerHTML = '<div class="prevwrap"></div>';
      prev = document.createElement('iframe');
      prev.className = 'prev';
      prev.id = 'prev';
      prev.title = 'live preview';
      prev.setAttribute('sandbox', 'allow-scripts allow-top-navigation-by-user-activation');
      const wrap = this.querySelector('.prevwrap');
      setTimeout(() => { if (!prev.parentNode) { wrap.append(prev); prevBusy(); } }, 0);
      window.addEventListener('message', (e) => {
        if (e.source !== prev.contentWindow) return;
        const m = e.data;
        if (!m || typeof m.latPrev !== 'number' || !(m.latPrev > 0)) return;
        if (m.seq !== fitCur) { fitCur = m.seq; fitH = 0; fitOff = false; }
        if (fitOff) return;
        if (!fitH) { fitH = m.latPrev; prev.style.minHeight = fitH + 'px'; return; }
        if (m.latPrev > fitH + 2) { fitOff = true; prev.style.minHeight = ''; }
      });
      prevBlank();
    }
  });
  const kindNow = () => (mode === 'know' ? 'md' : pkind.value);
  const CONTENT = () => ['md', 'gmi', 'html', 'text', 'tex'].includes(kindNow())
    || (kindNow() === 'fodt' && !!window.LatWriter);

  const localHtml = (kind, body, tasks) => {
    if (kind === 'md') return mdToHtml(body, tasks);
    if (kind === 'gmi') return gmiToHtml(body);
    if (kind === 'text') return '<pre>' + mdEsc(body) + '</pre>';
    if (kind === 'tex') return texPreviewHtml(body);
    return body;   // html: the document is already its own rendering
  };
  const previewScrollbars = () => '<style>html:root{color-scheme:'
    + (document.documentElement.style.colorScheme || 'light dark') + '}html::-webkit-scrollbar{display:none}</style>';
  let fitSeq = 0;
  const previewFit = () => {
    if (prev) prev.style.minHeight = '';
    return previewScrollbars()
      + '<script>(function(){var S=' + (++fitSeq) + ';function s(){var d=document.documentElement,b=document.body;parent.postMessage({latPrev:Math.max(d.scrollHeight,b?b.scrollHeight:0),seq:S},"*")}addEventListener("load",function(){s();if(document.body)new ResizeObserver(s).observe(document.body)})})()</script>';
  };
  const withPreviewScrollbars = (html, ours) => {
    const head = /<head\b[^>]*>/i.exec(html);
    const fit = previewFit() + (ours && themeRoot() ? '<style>' + themeRoot() + '</style>' : '');
    if (head) return html.slice(0, head.index + head[0].length) + fit + html.slice(head.index + head[0].length);
    const root = /<html\b[^>]*>/i.exec(html);
    if (root) return html.slice(0, root.index + root[0].length) + fit + html.slice(root.index + root[0].length);
    return fit + html;
  };
  const previewHidden = () => ws.classList.contains('ve');
  const paintLocal = () => {
    if (!CONTENT() || document.hidden) return;
    if (previewHidden()) return;
    try {
      if (pkind.value === 'html') { prevDoc(withPreviewScrollbars(src.value)); return; }
      if (kindNow() === 'fodt') { writerSync(); prevDoc(withPreviewScrollbars(LatWriter.show(src.value))); return; }
      const tasks = taskLive();
      prevDoc(localShell(previewFit()) + localHtml(kindNow(), src.value, tasks) + (tasks ? TASK_JS : ''));
    } catch {}
  };
  const taskLive = () => kindNow() === 'md' && !src.readOnly && viewingRev === null && !curFolder;
  const TASK_JS = '<script>addEventListener("click",function(e){var t=e.target;'
    + 'if(t&&t.matches&&t.matches("input[data-line]"))parent.postMessage({latTask:+t.dataset.line,on:t.checked},"*")})</script>';
  function taskFlip(line, on) {
    if (!taskLive()) return paintLocal();
    const r = taskToggle(src.value, line, on);
    if (!r) return paintLocal();
    const wrap = src.closest('.edwrap'), hid = !!wrap && !src.offsetParent;
    const keep = wrap ? wrap.style.cssText : '';
    const had = document.activeElement === src;
    const a = src.selectionStart, b = src.selectionEnd, dir = src.selectionDirection;
    const top = src.scrollTop, left = src.scrollLeft;
    if (hid) wrap.style.cssText = keep + ';display:block;position:fixed;left:-10000px;top:0;width:400px;height:200px';
    let ok = false;
    try {
      src.focus({ preventScroll: true });
      src.setSelectionRange(r.at, r.at + 1);
      ok = document.activeElement === src && document.execCommand('insertText', false, r.ch);
    } catch {}
    if (!ok) src.setRangeText(r.ch, r.at, r.at + 1, 'preserve');
    src.setSelectionRange(a, b, dir);
    src.scrollTop = top; src.scrollLeft = left;
    if (hid) wrap.style.cssText = keep;
    if (!had) src.blur();
    if (!ok) edited();
  }
  window.addEventListener('message', (e) => {
    if (!prev || e.source !== prev.contentWindow) return;
    const m = e.data;
    if (m && Number.isInteger(m.latTask) && m.latTask >= 0) taskFlip(m.latTask, !!m.on);
  });
  const localShell = (fit) => '<!doctype html><meta charset="utf-8"><base target="_top">'
        + '<style>:root{color-scheme:light dark}'
        + 'body{margin:0;padding:14px;font:15px/1.6 var(--font,system-ui,sans-serif);background:var(--bg,#fafafa);color:var(--text)}'
        + '@media(prefers-color-scheme:dark){body{background:var(--bg,#1a1a1a)}}' + themeRoot()
        + 'pre::-webkit-scrollbar{width:10px;height:10px}'
        + 'pre::-webkit-scrollbar-thumb{background:#8886;border-radius:5px;border:2px solid transparent;background-clip:padding-box}'
        + 'img{max-width:100%}pre{overflow-x:auto}'
        + 'table{border-collapse:collapse}td,th{border:1px solid #8886;padding:.3em .5em}'
        + '</style>' + fit;
  const ghostDoc = (kind, body) => {
    if (kind === 'fodt') return window.LatWriter ? previewScrollbars() + LatWriter.show(body) : null;
    if (!['md', 'gmi', 'html', 'text'].includes(kind)) return null;
    try {
      return kind === 'html' ? previewScrollbars() + body : localShell('') + localHtml(kind, body);
    } catch { return null; }
  };

  const prevNone = () => {
    prev.removeAttribute('src');
    prev.style.minHeight = '';
    prevDoc(localShell('') + '<p style="opacity:.6;text-align:center;margin-top:3em">'
      + 'No preview for this file</p>');
  };
  window.addEventListener('lattheme', () => {
    if (CONTENT() && (current || src.value)) paintLocal();
    else if (grubPath && !CONTENT()) prevNone();
    else if (!current) prevBlank();
  });
  async function refreshPreview() {
    if (document.hidden) return;
    if (previewHidden()) return;
    if (CONTENT()) {
      paintLocal();
    } else if (grubPath) {
      prevNone();
    } else if (current) {
      fitCur = null; prev.style.minHeight = '';
      prevUrl(api + '/f/' + current + '?preview=1&t=' + Date.now());
    }
  }
  function showPreview() {
    const n = prev.cloneNode(false);
    n.removeAttribute('srcdoc'); n.removeAttribute('src'); n.style.minHeight = '';
    prev.replaceWith(n); prev = n; fitCur = null;
    if (CONTENT() || current || grubPath) refreshPreview(); else prevBlank();
  }
  let localTimer = null;
  src.addEventListener('input', () => {
    if (!CONTENT()) return;
    clearTimeout(localTimer);
    localTimer = setTimeout(paintLocal, 60);
  });

  async function checkErrors() {
    if (!current) return;
    let t = '';
    try { t = await (await fetch(api + '/page-errors?name=' + encodeURIComponent(current))).text(); } catch {}
    if (t.trim()) {
      cerr.textContent = t;
      cerr.className = 'err';
      st('error', false);
    } else {
      cerr.textContent = CONTENT() ? 'saved' : 'compiled ok';
      cerr.className = 'ok';
      if (!CONTENT()) st('compiled ok');
      refreshPreview();
    }
  }

// ── src/65-ctl.js ─────────────────────────────────────────────────────────
  let cerr;
  customElements.define('lat-ctl', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<aside class="ctl">
  <h3>status</h3>
  <div id="cerr" class="ok">&nbsp;</div>
  <lat-knowtags></lat-knowtags>
  <!-- a link to another ship's page (paintLink, below) -->
  <div id="lnkrow" hidden>
    <h3>linked</h3>
    <div id="lnkfrom"></div>
    <div id="lnkmode" class="muted"></div>
    <div id="lnkbad" class="lbad" hidden></div>
    <div id="lnkat" class="muted" hidden></div>
  </div>
  <div id="cmtrow" hidden>
    <h3>comments</h3>
    <!-- the box alone toggles, as with mark sensitive (66-share.js) -->
    <div class="chk"><input type="checkbox" id="cmton" data-action="cmton" aria-label="Comments on this page">
    <span class="muted">Comments on this page</span></div>
    <!-- comets (anonymous ships): open, held for review, or off. Planets
         and moons go by the box above alone. -->
    <div id="cometrow" class="chk" hidden><span class="muted">Anonymous (comet) comments</span>
    <select id="cometmode" aria-label="Anonymous (comet) comments">
      <option value="open">open</option><option value="held">held for review</option>
      <option value="off">off</option></select></div>
    <div id="cometq" hidden></div>
  </div>
  <lat-share></lat-share>
  <!-- move and delete are reached from the tab header's path and the page
       menu (23-tabhead.js), which click these. They stay, out of sight. -->
  <div hidden><button id="mv">move / rename</button><button id="del">delete page</button></div>
</aside>`;
      cerr = $('cerr');
    }
  });

  function paintLink() {
    const row = $('lnkrow');
    if (!row) return;
    const t = activeTab;
    const name = t ? (t.kind === 'page' ? t.key : null)
      : (!grubPath && mode !== 'know' && curFolder === null ? current : null);
    const lk = linkOf(name);
    row.hidden = !lk;
    paintLinkCf(current);
    const sh = document.querySelector('lat-share');
    if (sh) sh.hidden = !!lk;
    if (lk) $('cmtrow').hidden = true;      // rpPaint shows it for a page
    if (!lk) return;
    if (name === current && linkRO(name)) src.readOnly = true;
    $('lnkfrom').textContent = 'Linked from ' + linkFrom(lk);
    $('lnkmode').textContent = lk.mode === 'read' ? 'read only'
      : lk.mode === 'edit' ? 'can edit' : lk.mode;
    const bad = linkBadge(lk);
    $('lnkbad').hidden = !bad;
    $('lnkbad').textContent = bad ? bad.copy : '';
    $('lnkat').hidden = !bad || !bad.since;
    $('lnkat').textContent = bad ? bad.since : '';
  }

  let cmtOn = null;
  let cmtFor = null;
  function cmtShow(name, on) {
    const cb = $('cmton');
    cmtFor = name;
    cmtOn = typeof on === 'boolean' ? on : null;
    cb.checked = cmtOn === true;
    cb.disabled = !name || cmtOn === null;
    cometLoad(name);
    rpSoon();            // the Comments tab's post box goes by it too
  }

  let cometFor = null;
  async function cometLoad(name, fg) {
    const row = $('cometrow'), q = $('cometq');
    cometFor = cmtOn === true ? name : null;
    if (!cometFor) { row.hidden = q.hidden = true; return; }
    let d = null;
    try {
      const u = api + '/page-comets?name=' + encodeURIComponent(name);
      const r = await (fg ? busyFetch(u) : bgFetch(u));
      if (r.ok) d = await r.json();
    } catch {}
    if (cometFor !== name) return;
    if (!d) { row.hidden = q.hidden = true; return; }
    row.hidden = false;
    $('cometmode').value = d.mode || 'open';
    cometPaint(name, d.pending || []);
  }
  function cometPaint(name, items) {
    const q = $('cometq');
    q.textContent = '';
    q.hidden = !items.length;
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = 'aclnote';
    h.textContent = items.length + ' held for review';
    q.appendChild(h);
    for (const c of items) {
      const card = document.createElement('div');
      card.className = 'aclcard';
      const who = document.createElement('b');
      who.textContent = c.author;
      const when = document.createElement('div');
      when.className = 'aclnote';
      when.textContent = new Date(c.when).toLocaleString();
      const body = document.createElement('div');
      body.style.whiteSpace = 'pre-wrap';
      body.style.overflowWrap = 'anywhere';
      body.textContent = c.body;           // text, never HTML
      card.append(who, when, body);
      for (const [act, label] of [['approve', 'approve'], ['reject', 'reject']]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = async () => {
          b.disabled = true;
          const r = await mutate(api + '/comet-pending?page=' + encodeURIComponent(name)
            + '&id=' + encodeURIComponent(c.id) + '&do=' + act);
          if (!r || !r.ok) st(act + ' failed' + await errText(r), false);
          else st(act === 'approve' ? 'comment approved' : 'comment rejected');
          cometLoad(name, true);
        };
        card.appendChild(b);
      }
      q.appendChild(card);
    }
  }
  $('cometmode').onchange = async () => {
    const sel = $('cometmode');
    const name = cometFor;
    if (!name) return;
    sel.disabled = true;
    const r = await mutate(api + '/page-comets?name=' + encodeURIComponent(name)
      + '&mode=' + sel.value);
    sel.disabled = false;
    if (!r || !r.ok) st('comet mode failed' + await errText(r), false);
    else st('comet comments ' + sel.value + ' for ' + name);
    cometLoad(name, true);
  };
  $('cmton').onchange = async () => {
    const cb = $('cmton');
    const name = cmtFor;
    if (!name) return;
    const on = cb.checked;
    cb.disabled = true;
    const r = await mutate(api + '/page-comments?name=' + encodeURIComponent(name) +
      '&on=' + (on ? '1' : '0'));
    if (cmtFor !== name) return;
    cb.disabled = false;
    if (!r || !r.ok) { cb.checked = !on; st('comments switch failed' + await errText(r), false); return; }
    cmtOn = on;
    cometLoad(name, true);
    const hit = pageCache.get(name);
    if (hit) hit.comments = on;
    st(on ? 'comments on for ' + name : 'comments off for ' + name);
    rpSoon();
  };
  clickAction('cmton', 'Comments on this page', 'Right pane › Page');


  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const parkedUnder = (path) => allTabs().filter((t) => t !== activeTab && t.kind === 'page'
    && !t.ship && t.snap && t.key && (t.key === path || t.key.startsWith(path + '/')));
  function delWhat(path, folder) {
    const n = nodes.find((x) => x.page === !folder && x.path === path);
    const name = (n && n.dname ? n.dname + ' (' + path + ')' : path);
    const c = pageCount(path);
    const lines = [];
    if (folder) lines.push('delete folder ' + name
      + (c ? ' and the ' + plural(c, 'page') + ' in it?' : '? It is empty.'));
    else lines.push('delete ' + name
      + (c ? ' and the ' + plural(c, 'page') + ' under it?' : '?'));
    if (n && n.link && n.link.host)
      lines.push('This is a link to a page on ' + n.link.host
        + '. Only the link goes; their page is untouched.');
    const under = nodes.filter((x) => x.page && (x.path === path || x.path.startsWith(path + '/')));
    const pub = under.filter((x) => x.share === 'shared' || x.share === 'clearweb');
    if (pub.length) {
      const web = pub.some((x) => x.share === 'clearweb');
      const how = ' published (' + (web ? 'on the clearweb' : 'over Urbit') + ').';
      lines.push(!folder && pub.length === 1 && pub[0].path === path
        ? 'It is' + how + ' Anyone who already read it may keep a copy.'
        : plural(pub.length, 'page') + (pub.length === 1 ? ' is' : ' are') + how
          + ' Anyone who already read them may keep a copy.');
    }
    if (selfBase && permsLoaded) {
      const pp = selfBase + '/page/' + path;
      const gs = permGroups.filter((g) => [...(g.peek || []), ...(g.make || [])]
        .some((x) => x === pp || x.startsWith(pp + '/')));
      if (gs.length) lines.push('It is shared with ' + gs.map((g) => g.name).join(', ')
        + '. Their access ends with it.');
    }
    if (path === 'conflicts')
      lines.push('Lattice makes this folder again on the next conflict.');
    const open = mode !== 'know' && !grubPath && current
      && (current === path || current.startsWith(path + '/'));
    if (open && dirty) lines.push('The open page has unsaved changes, and they go too.');
    const parked = parkedUnder(path).filter((t) => t.snap.dirty).length;
    if (parked) lines.push(plural(parked, 'other tab') + ' with unsaved changes to it'
      + (parked === 1 ? ' loses them.' : ' lose them.'));
    if (degraded || offCount) lines.push('You are offline: the delete is queued and runs when the ship is back.');
    lines.push('This is permanent and cannot be restored.');
    return lines.join('\n');
  }
  async function deletePath(path, folder, note) {
    if (!path) return false;
    if (!(await askDanger(delWhat(path, folder) + (note ? '\n' + note : ''), 'delete'))) return false;
    const hit = (p) => !!p && (p === path || p.startsWith(path + '/'));
    if ((mode !== 'know' && !grubPath && hit(current)) || hit(curFolder)) {
      clearTimeout(autoTimer);
      dirty = false;
      savePending = false;
      newFile('', false);
    }
    const gone = parkedUnder(path).filter((t) => t.snap.dirty);
    for (const t of gone) t.snap.dirty = false;
    if (gone.length) paintTabs();
    const end = busy();
    let r;
    try {
      await savesSettled();
      r = await mutate(api + '/page-del?name=' + encodeURIComponent(path));
    } finally { end(); }
    if (!r.ok) { st('delete failed' + await errText(r), false); return false; }
    dropTreeNodes(path);
    snapTree();
    renderTree();
    st(r.offline ? 'deleted ' + path + ' offline' : 'deleted ' + path);
    return true;
  }
  $('del').onclick = async () => {
    if (mode === 'know') { deleteKnow(); return; }
    if (viewingRev !== null) { st('viewing rev ' + viewingRev + ', use restore', false); return; }
    if (curFolder) { deletePath(curFolder, true); return; }
    if (!current) { st('nothing to delete', false); return; }
    deletePath(current, false);
  };

// ── src/66-share.js ───────────────────────────────────────────────────────
  let cwurl;
  customElements.define('lat-share', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="sharesec">
<h3>sharing</h3>
<div class="share" id="share">
  <button data-m="private" data-action="share-private">private</button>
  <button data-m="shared" data-action="share-shared">shared</button>
  <button data-m="clearweb" data-action="share-clearweb">clearweb</button>
</div>
<div id="sharewhat" class="muted sharewhat"></div>
<div id="shvia" class="muted" hidden></div>
<div class="row"><button id="shcopy" type="button" data-action="share-copylink">copy link</button></div>
<div id="cwurl" class="muted"></div>
<h3>give a ship access</h3>
<div class="row"><input id="shwith" placeholder="~ship" autocomplete="off"><button id="shread">read</button><button id="shedit">edit</button></div>
<div id="shres" class="muted"></div>
<h3 class="grouphead">give a group access <a id="aclopen" data-action="aclopen" title="create and edit groups">manage &rarr;</a></h3>
<div id="grouplist" class="muted"></div>
<h3>sensitive</h3>
<!-- only the box toggles: the words beside it are plain text, not a label
     around both, so a click on them changes nothing. They describe it. -->
<div class="chk"><input type="checkbox" id="shsens" data-action="shsens" aria-label="Mark sensitive" aria-describedby="shsensd">
<span id="shsensd" class="muted">mark sensitive: agents without clearance can't see or write it</span></div>
<div id="shsensres" class="muted"></div>
</div>
<div id="orrsec" hidden><h3>orrery</h3><div id="orr"></div></div>`;
      cwurl = $('cwurl');
    }
  });
  const cwUrl = (target) => location.origin + api + '/c/' + target;
  let ourShip = '';
  const urbUrl = (target) => (ourShip ? 'urb://' + ourShip + '/' + target : null);
  const urbMissing = () => (ourShip === null ? 'address unavailable' : 'loading address');
  async function copyText(t) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch {}
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    const back = document.activeElement;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    if (back && back.focus) back.focus();
    return ok;
  }
  const pageUrb = (name) => {
    const lk = linkOf(name);
    return lk ? 'urb://' + linkFrom(lk) : urbUrl(name);
  };
  const swmUrb = (it) => 'urb://' + linkFrom(it);
  const grubUrb = () => {
    const m = grubShip && /\/page\/(.+)\/code$/.exec(grubPath || '');
    return m ? 'urb://' + grubShip + '/' + m[1] : null;
  };
  async function copyLink(u) {
    if (!u) { st('no link to copy: ' + urbMissing(), false); return false; }
    if (await copyText(u)) { st('link copied: ' + u); return true; }
    st('could not copy ' + u, false);
    return false;
  }
  let shareShown = null;
  queueMicrotask(() => fetch('/~/host').then((r) => (r.ok ? r.text() : '')).catch(() => '').then((t) => {
    ourShip = t.trim() || null;
    if (shareShown) paintShareCopy(shareShown);
    renderPublished();
  }));
  const at = (u) => (u ? 'at ' + u : '(' + urbMissing() + ')');
  const SHARE_COPY = {
    private: () => 'Private: only you, and any ship or group you give access below. '
      + 'Not published anywhere.',
    shared: (u) => 'Shared: any ship can read it over Urbit ' + at(u) + '. Not on the web.',
    clearweb: (u, w) => 'Clearweb: anyone with the link can read it on the web at '
      + w + ', no login needed. Any ship can also read it over Urbit ' + at(u) + '.',
  };
  const KEEP = ' Pages added or moved in later are shared too. A page with its own '
    + 'setting, or marked sensitive, keeps its own.';
  const FOLDER_COPY = {
    private: () => 'Private: the folder shares nothing. Its pages keep their own settings.',
    shared: (u) => 'Shared: any ship can read every page in it over Urbit, with an index '
      + at(u) + '. Not on the web.' + KEEP,
    clearweb: (u, w) => 'Clearweb: anyone with the link can read every page in it on the web at '
      + w + ', no login needed, and any ship over Urbit ' + at(u) + '.' + KEEP,
  };
  function paintShareCopy(m) {
    shareShown = m;
    const target = curFolder || current;
    const copy = curFolder ? FOLDER_COPY : SHARE_COPY;
    const t = target ? target + (curFolder ? '/' : '') : 'this-page';
    const u = urbUrl(t), w = cwUrl(t);
    for (const b of document.querySelectorAll('.share button')) b.title = copy[b.dataset.m](u, w);
    $('sharewhat').textContent = copy[m] ? copy[m](u, w) : '';
    $('shcopy').hidden = curFolder ? m === 'private' : !current;
  }
  $('shcopy').onclick = () => copyLink(curFolder ? urbUrl(curFolder + '/')
    : current ? pageUrb(current) : null);

  const folderOf = (path) => {
    for (let p = path; p.includes('/');) {
      p = p.slice(0, p.lastIndexOf('/'));
      const f = nodes.find((x) => !x.page && x.path === p);
      if (f && f.dshare) return f;
    }
    return null;
  };
  function paintVia() {
    const el = $('shvia');
    el.textContent = '';
    const n = !curFolder && current ? nodes.find((x) => x.page && x.path === current) : null;
    const f = n ? (n.via ? nodes.find((x) => !x.page && x.path === n.via) || { path: n.via }
      : folderOf(n.path)) : null;
    el.hidden = !f;
    if (!f) return;
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = f.path + '/';
    a.title = 'Open the folder\u2019s settings';
    a.onclick = (e) => { e.preventDefault(); pickFolder(f.path); };
    if (n.via) {
      el.append('Shared via folder ', a, '. Pick a mode above to give this page its own.');
      return;
    }
    el.append('Its own setting. Folder ', a, ' is ' + f.dshare + '. ');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'use folder setting';
    b.onclick = async () => {
      const name = current;
      const r = await mutate(api + '/page-share-clear?name=' + encodeURIComponent(name));
      if (!r.ok) { st('share failed' + await errText(r), false); return; }
      st('sharing: from folder ' + f.path);
      await loadTree();
      const m = nodes.find((x) => x.page && x.path === name);
      if (name === current) showShare((m && m.share) || 'private');
    };
    el.append(b);
  }

  function showShare(m) {
    $('shres').textContent = '';
    for (const b of document.querySelectorAll('.share button'))
      b.className = b.dataset.m === m ? 'on' : '';
    renderGroupAccess();
    paintShareCopy(m);
    paintVia();
    orreryShow();
    refreshSensitive(curFolder || current);
    const target = curFolder || current;
    const suffix = curFolder ? '/' : '';
    cwurl.textContent = '';
    if (m === 'clearweb' && target) {
      const url = cwUrl(target + suffix);
      cwurl.appendChild(document.createTextNode('public: '));
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '/c/' + target + suffix;   // textContent: names are content
      cwurl.appendChild(a);
    } else if (m === 'mixed') {
      cwurl.textContent = 'mixed: pages under this folder differ';
    }
  }
  for (const b of document.querySelectorAll('.share button')) {
    b.onclick = async () => {
      const m = b.dataset.m;
      const was = curFolder ? (nodes.find((x) => !x.page && x.path === curFolder) || {}).dshare
        : (nodes.find((x) => x.page && x.path === current) || {}).share;
      const pub = (x) => x === 'shared' || x === 'clearweb';
      if (pub(m) && !pub(was) && !(await askPublish())) return;
      const btns = document.querySelectorAll('.share button');
      for (const x of btns) x.disabled = true;
      stWork('setting ' + m + '…');
      try {
        if (curFolder) {
          const f = curFolder;
          const r = await mutate(api + '/page-share-dir?name=' + encodeURIComponent(f) +
            '&mode=' + m);
          if (!r.ok) { st('share failed' + await errText(r), false); return; }
          const fn = nodes.find((x) => !x.page && x.path === f);
          if (fn) { if (m === 'private') delete fn.dshare; else fn.dshare = m; }
          if (curFolder === f) showShare(m);
          st(m === 'private' ? 'folder ' + f + ' shares nothing'
            : m === 'clearweb' ? 'folder shared at /c/' + f + '/' : 'folder ' + f + ' shared');
          await loadTree();
          return;
        }
        const name = current;
        if (!name) { st('save the page first', false); return; }
        const r = await mutate(api + '/page-share?name=' + encodeURIComponent(name) +
          '&mode=' + m);
        if (!r.ok) { st('share failed' + await errText(r), false); return; }
        if (current === name && !curFolder) showShare(m);
        st('sharing: ' + m);
        const n = nodes.find((x) => x.page && x.path === name);
        if (n) { n.share = m; delete n.via; }
        paintVia();
        snapTree();
        renderTree();
      } finally {
        for (const x of btns) x.disabled = false;
      }
    };
  }

  const shareWith = async (mode) => {
    const shp = $('shwith').value.trim();
    if (!current) { st('open a page first', false); return; }
    if (!shp) { st('enter a ship', false); return; }
    const page = current;
    $('shres').textContent = 'granting…';
    const r = await mutate(api + '/share-file?name=' + encodeURIComponent(page) +
      '&ship=' + encodeURIComponent(shp) + '&mode=' + mode);
    if (!r || !r.ok) {
      $('shres').textContent = '';
      st('share failed' + await errText(r), false);
      return;
    }
    const j = await r.json();
    $('shres').textContent = shp + ' can now ' + mode + ' ' + page +
      (j.notified ? ' — notified.' : ' — could not notify (offline?); the grant holds.');
    loadPerms();          // the peers panel shows the auto-group
  };
  $('shread').onclick = () => shareWith('read');
  $('shedit').onclick = () => shareWith('edit');

  let sensSetting = null;
  const refreshSensitive = async (target) => {
    const cb = $('shsens');
    if (!cb) return;
    if (target && target === sensSetting) return;
    $('shsensres').textContent = '';
    if (!target) { cb.checked = false; cb.disabled = true; return; }
    cb.disabled = false;
    if (sensKnown.has(target)) { cb.checked = sensKnown.get(target); return; }
    if (sensWait === target) { cb.checked = false; return; }
    const gen = sensGen;
    try {
      const r = await fetch(api + '/page-sensitive?name=' + encodeURIComponent(target));
      const on = r.ok && (await r.json()).on === true;
      if (r.ok && gen === sensGen) sensKnown.set(target, on);
      if ((curFolder || current) !== target) return;
      cb.checked = on;
    } catch { if ((curFolder || current) === target) cb.checked = false; }
  };
  $('shsens').onchange = async () => {
    const target = curFolder || current;
    const cb = $('shsens');
    if (!target) { st('open a page first', false); cb.checked = false; return; }
    cb.disabled = true;
    const want = cb.checked;
    sensSetting = target;
    let r = null;
    try {
      r = await mutate(api + '/page-sensitive?name=' + encodeURIComponent(target) +
        '&on=' + (want ? '1' : '0'));
    } finally { sensSetting = null; }
    const here = (curFolder || current) === target;
    if (here) cb.disabled = false;
    if (!r || !r.ok) {
      if (here) cb.checked = !want;
      st('sensitive failed' + await errText(r), false);
      return;
    }
    sensKnown.set(target, want);
    if (!here) return;
    cb.checked = want;
    $('shsensres').textContent = want
      ? target + ' is sensitive'
      : target + ' is no longer sensitive';
  };

  const pagePath = (name) => selfBase + '/page/' + name;

  function renderGroupAccess() {
    const host = $('grouplist');
    if (!host) return;
    host.textContent = '';
    const target = curFolder || current;
    if (!target) {
      host.className = 'muted';
      host.textContent = 'open a page to grant access.';
      return;
    }
    if (!permsLoaded) {
      host.className = 'muted';
      host.textContent = 'loading groups…';
      return;
    }
    if (!permGroups.length) {
      host.className = 'muted';
      host.textContent = 'no groups yet — use manage → to make one.';
      return;
    }
    host.className = '';
    const path = pagePath(target);
    for (const g of permGroups) {
      const row = document.createElement('div');
      row.className = 'grow-row';
      const nm = document.createElement('span');
      nm.className = 'gname';
      nm.textContent = g.name;
      row.appendChild(nm);
      const mk = (label, on, fn) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (on) b.className = 'on';
        b.onclick = fn;
        row.appendChild(b);
      };
      const canRead = g.peek.includes(path);
      const canEdit = g.make.includes(path);
      mk('read', canRead, () => {
        if (canRead) {
          g.peek = g.peek.filter((x) => x !== path);
          g.make = g.make.filter((x) => x !== path);
        } else g.peek.push(path);
        permSave(g);
      });
      mk('edit', canEdit, () => {
        if (canEdit) g.make = g.make.filter((x) => x !== path);
        else {
          if (!g.peek.includes(path)) g.peek.push(path);   // edit implies read
          g.make.push(path);
        }
        permSave(g);
      });
      host.appendChild(row);
    }
  }
  $('aclopen').onclick = () => aclOpen();
  clickAction('share-private', 'Make private', 'Right pane › Page');
  clickAction('share-shared', 'Share over Urbit', 'Right pane › Page');
  clickAction('share-clearweb', 'Publish to the clearweb', 'Right pane › Page');
  clickAction('shsens', 'Mark sensitive', 'Right pane › Page');
  clickAction('aclopen', 'Manage groups', 'Right pane › Page');

// ── src/67-perms.js ───────────────────────────────────────────────────────
  let permGroups = [];
  let permsLoaded = false;
  let selfBase = null;
  async function loadPerms(bg = false) {
    const get = bg ? bgFetch : fetch;
    let r = null;
    try {
      const [b, g] = await Promise.all([latBase().catch(() => null), get(api + '/share-groups')]);
      selfBase = b;
      r = g;
    } catch {}
    if (!r || !r.ok || !selfBase) {
      st('could not load groups (' + (r ? r.status : 'network') + ')', false);
      return;
    }
    permGroups = await r.json();
    permsLoaded = true;
    renderAcl();
    renderGroupAccess();
  }
  async function permSave(g) {
    const r = await busyFetch(api + '/share-group-save?name=' + encodeURIComponent(g.name), {
      method: 'POST',
      body: JSON.stringify({ ships: g.ships, peek: g.peek, make: g.make }),
    }).catch(() => null);
    if (!r || !r.ok) st('permissions' + await errText(r), false);
    loadPerms();
  }

// ── src/68-knowtags.js ────────────────────────────────────────────────────
  customElements.define('lat-knowtags', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="knowmeta" hidden>
  <h3>tags</h3>
  <div id="ktags" class="chips"></div>
  <div class="row"><input id="ktag" placeholder="add tag" autocomplete="off"><button id="ktagadd">tag</button></div>
  <div id="kupd" class="muted"></div>
</div>`;
    }
  });

// ── src/69-shared.js ──────────────────────────────────────────────────────
  const sharedName = (p) => {
    const m = /\/page\/(.+)\/code$/.exec(p);
    return m ? m[1] : p.replace(/^\/+/, '');
  };
  async function loadShared(bg = false) {
    let r = null;
    try { r = await (bg ? bgFetch : fetch)(api + '/shared-with-me'); } catch {}
    if (!r || !r.ok) return;           // the folder just stays as it was
    sharedWithMe = await r.json();
    swmAt = Date.now();
    renderTree();
  }
  let swmAt = 0;
  let swmTimer = null;
  const sharesBumped = (data) => {
    clearTimeout(swmTimer);
    swmTimer = setTimeout(loadShared, 300);
    let j = null;
    try { j = JSON.parse(data); } catch {}
    if (j && j.op === 'add' && j.host && j.path) shareToast(j);
  };
  let swmFly = null;
  const sharesRefocused = () => {
    if (document.hidden || swmFly || Date.now() - swmAt < 60000) return;
    swmFly = loadShared(true).finally(() => { swmFly = null; });
  };
  window.addEventListener('focus', sharesRefocused);
  document.addEventListener('visibilitychange', sharesRefocused);
  let toastEl = null;
  function shareToast(j) {
    if (toastEl) toastEl.remove();
    const t = toastEl = document.createElement('a');
    t.className = 'swtoast';
    t.setAttribute('role', 'status');
    t.href = '/apps/lattice/app?grub=' + encodeURIComponent(j.path) +
      '&ship=' + encodeURIComponent(j.host);
    t.textContent = j.host + ' shared ' + sharedName(j.path) + ' with you';
    t.title = 'open it';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 8000);
  }
  async function removeShared(it) {
    const what = 'remove ' + it.host + '/' + sharedName(it.path) + ' from shared with me?\n'
      + 'Nothing is deleted: the page is ' + it.host + "'s, and their grant to you stays. "
      + 'It comes back here if they share it again.';
    if (!(await askDanger(what, 'remove'))) return false;
    const r = await busyFetch(api + '/shared-with-me-del?host=' + encodeURIComponent(it.host) +
      '&path=' + encodeURIComponent(it.path), { method: 'POST' }).catch(() => null);
    if (!r || !r.ok) { st('remove failed' + await errText(r), false); return false; }
    st('removed ' + sharedName(it.path) + ' from shared with me');
    loadShared();
    return true;
  }
  const SWM = ' shared';
  function renderShared(coll) {
    const fold = (key, label, depth) => {
      const row = folderRow(label, depth, coll.includes(key),
        () => { paneColl.flip(key); renderTree(); }, undefined, key);
      if (key === SWM) sysFlair(row, 'shared');
      treeList.appendChild(row);
      return !coll.includes(key);
    };
    if (!fold(SWM, 'shared with me', 0)) return;
    for (const host of [...new Set(sharedWithMe.map((s) => s.host))].sort()) {
      if (!fold(SWM + '/' + host, host, 1)) continue;
      const mine = sharedWithMe.filter((s) => s.host === host)
        .sort((a, b) => sharedName(a.path).localeCompare(sharedName(b.path)));
      for (const it of mine) {
        const a = document.createElement('a');
        a.className = 'pg swm';
        a.href = '/apps/lattice/app?grub=' + encodeURIComponent(it.path) +
          '&ship=' + encodeURIComponent(host);
        a.title = host + ' ' + it.path;
        const nm = document.createElement('span');
        nm.className = 'swn';
        nm.textContent = sharedName(it.path);
        const md = document.createElement('span');
        md.className = 'swmode';
        md.textContent = it.mode;
        const x = document.createElement('span');
        x.className = 'swrm';
        x.textContent = '×';
        x.title = 'remove from this list (their grant is untouched)';
        x.onclick = (e) => {
          e.preventDefault(); e.stopPropagation();
          removeShared(it);
        };
        a.append(nm, md, x);
        rowMore(a, sharedName(it.path) + ' from ' + host);   // its Remove from list (34-treemenu.js)
        a.draggable = true;
        a.ondragstart = (e) => {
          swmDrag = it;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(SWM_DRAG, it.host + ' ' + it.path);
        };
        a.ondragend = () => { swmDrag = null; };
        treeItem(a, 2, SWM + '/' + host + '/' + it.path);
        tabLink(a, 'grub', it.path, { ship: host });
        const mv = document.createElement('button');
        mv.type = 'button';
        mv.className = 'swmv';
        mv.dataset.action = 'swm-move';
        tip(mv, 'Move into my pages');
        mv.innerHTML = ico('link');
        mv.onclick = () => askMoveIn(it);
        const w = document.createElement('div');
        w.className = 'swrow';
        w.style.marginLeft = '28px';
        w.append(a, mv);
        treeList.appendChild(w);
      }
    }
  }

  const SWM_DRAG = 'application/x-lattice-shared';
  let swmDrag = null;          // the entry being dragged, for the drop
  const swmLeaf = (it) => sharedName(it.path).split('/').pop();
  async function moveIn(it, to) {
    stWork('moving ' + swmLeaf(it) + ' into ' + to + '\u2026');
    const r = await busyFetch(api + '/link-make?host=' + encodeURIComponent(it.host) +
      '&path=' + encodeURIComponent(it.path) + '&to=' + encodeURIComponent(to),
    { method: 'POST' }).catch(() => null);
    if (!r || !r.ok) { st('move failed' + await errText(r), false); return false; }
    let n = null;
    try { n = await r.json(); } catch {}
    sharedWithMe = sharedWithMe.filter((s) => !(s.host === it.host && s.path === it.path));
    if (to.includes('/')) addFolderNodes(to.slice(0, to.lastIndexOf('/')));
    if (n && n.path === to) {
      dropTreeNodes(to);
      nodes.push(n);
      snapTree();
      renderTree();
    } else await loadTree();
    st('moved into ' + to + ', linked from ' + it.host);
    return true;
  }
  async function askMoveIn(it, folder) {
    let seed = (folder ? folder + '/' : '') + swmLeaf(it);
    for (;;) {
      const typed = await askName('move ' + it.host + '/' + sharedName(it.path) +
        ' into my pages as:', seed, 'move');
      if (!typed) return;
      const rn = realName(typed);
      if (await moveIn(it, rn.name)) return;
      seed = typed;
    }
  }
  function linkDrop(row, folder) {
    row.addEventListener('dragover', (e) => {
      if (!swmDrag || ![...e.dataTransfer.types].includes(SWM_DRAG)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drop');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop');
      const it = swmDrag;
      if (!it || ![...e.dataTransfer.types].includes(SWM_DRAG)) return;
      e.preventDefault();
      swmDrag = null;
      moveIn(it, folder + '/' + swmLeaf(it)).then((ok) => { if (!ok) askMoveIn(it, folder); });
    });
  }
  async function linkBack(name) {
    const lk = linkOf(name);
    if (!lk) return;
    for (const t of allTabs().filter((x) => x.kind === 'page' && x.key === name))
      if ((await closeTab(t.id)) === false) return;
    const r = await busyFetch(api + '/link-unmake?name=' + encodeURIComponent(name),
      { method: 'POST' }).catch(() => null);
    if (!r || !r.ok) { st('move failed' + await errText(r), false); return; }
    dropTreeNodes(name);
    linkCf.delete(name);
    linkStale.delete(name);
    snapTree();
    renderTree();
    await loadShared();
    st('moved ' + name + ' back to shared with me');
  }
  action({ id: 'swm-move', name: 'Move into my pages', home: 'Files \u203a shared with me',
    when: () => !!actionHome('swm-move'),
    run: () => {
      const all = document.querySelectorAll('[data-action="swm-move"]');
      if (all.length === 1) { all[0].click(); return; }
      if (all[0]) { all[0].focus(); st('pick the page to move: its Move into my pages button'); }
    } });

// ── src/69x-follow.js ─────────────────────────────────────────────────────
  const FOL = ' following';
  const foldName = (f) => f.host + f.path;
  const foldLeaf = (f, p) => p.key.slice(f.path.length + 1);
  const foldUrl = (host, path) => 'urb://' + host + path;
  async function loadFolds(bg = false) {
    let r = null;
    try { r = await (bg ? bgFetch : fetch)(api + '/folder-follows'); } catch {}
    if (!r || !r.ok) return;
    try { folds = await r.json(); } catch { return; }
    renderTree();
  }
  async function checkFolds(f) {
    const q = f ? '?host=' + encodeURIComponent(f.host) + '&path=' + encodeURIComponent(f.path) : '';
    if (!f && !folds.length) return;
    try { await fetch(api + '/folder-check' + q, { method: 'POST' }); } catch {}
    loadFolds(true);
  }
  setInterval(() => { if (!document.hidden) checkFolds(); }, 20 * 60000);
  let foldTimer = null;
  const foldsBumped = (data) => {
    let j = null;
    try { j = JSON.parse(data); } catch {}
    if (j && j.op === 'stale' && j.host && j.path) {
      for (const ms of [0, 4000, 12000]) setTimeout(() => checkFolds(j), ms);
      return;
    }
    if (j && j.op === 'new')
      window.dispatchEvent(new CustomEvent('lattice:folder-new',
        { detail: { host: j.host, path: j.path, new: j.new } }));
    clearTimeout(foldTimer);
    foldTimer = setTimeout(loadFolds, 300);
  };
  const foldPost = (route, f, extra = '') => fetch(api + route + '?host=' + encodeURIComponent(f.host)
    + '&path=' + encodeURIComponent(f.path) + extra, { method: 'POST' }).catch(() => null);
  async function unfollowFold(f) {
    const r = await foldPost('/folder-unfollow', f);
    if (!r || !r.ok) { st('unfollow failed' + await errText(r), false); return; }
    folds = folds.filter((x) => !(x.host === f.host && x.path === f.path));
    renderTree();
    st('unfollowed ' + foldName(f));
  }
  function openFoldPage(f, p) {
    if (p.new) {
      p.new = false;
      f.new = Math.max(0, f.new - 1);
      renderTree();
      foldPost('/folder-seen', f, '&key=' + encodeURIComponent(p.key));
    }
    browseIn(api + '?url=' + encodeURIComponent(foldUrl(f.host, p.key)));
  }
  function renderFolds(coll) {
    const all = folds.reduce((n, f) => n + (f.ok ? f.new : 0), 0);
    const top = folderRow('following', 0, coll.includes(FOL),
      () => { paneColl.flip(FOL); renderTree(); }, undefined, FOL);
    sysFlair(top, 'following');
    if (all) top.append(foldBadge(all + ' new'));
    treeList.appendChild(top);
    if (coll.includes(FOL)) return;
    for (const f of [...folds].sort((a, b) => foldName(a).localeCompare(foldName(b)))) {
      const key = FOL + '/' + foldName(f);
      const row = folderRow(foldName(f), 1, coll.includes(key),
        () => { paneColl.flip(key); renderTree(); }, undefined, key);
      row.classList.add('fol');
      row.dataset.fold = foldName(f);
      if (!f.ok) {
        const b = foldBadge('unavailable');
        b.classList.add('gone');
        b.title = f.host + ' no longer shares this folder with you, or cannot be reached';
        row.append(b);
      } else if (f.new) row.append(foldBadge(f.new + ' new'));
      const ix = document.createElement('a');
      ix.className = 'folix';
      ix.href = api + '?url=' + encodeURIComponent(foldUrl(f.host, f.path) + '/');
      ix.textContent = '↗';
      ix.title = 'open the folder\'s index';
      ix.onclick = (e) => {
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
        e.preventDefault();
        browseIn(ix.href);
      };
      const x = document.createElement('span');
      x.className = 'swrm folrm';
      x.textContent = '×';
      x.title = 'unfollow';
      x.onclick = (e) => { e.stopPropagation(); unfollowFold(f); };
      row.append(ix, x);
      treeList.appendChild(row);
      if (coll.includes(key)) continue;
      for (const p of f.pages) {
        const a = document.createElement('a');
        a.className = 'pg swm folpg' + (p.new ? ' new' : '');
        a.href = api + '?url=' + encodeURIComponent(foldUrl(f.host, p.key));
        a.title = f.host + p.key + (p.new ? ' (new)' : '');
        const nm = document.createElement('span');
        nm.className = 'swn';
        nm.textContent = p.title || foldLeaf(f, p);
        a.append(nm);
        a.onclick = (e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
          e.preventDefault();
          openFoldPage(f, p);
        };
        treeItem(a, 2, key + '/' + p.key);
        a.style.marginLeft = '28px';
        treeList.appendChild(a);
      }
    }
  }
  function foldBadge(t) {
    const b = document.createElement('span');
    b.className = 'folnew';
    b.textContent = t;
    return b;
  }

// ── src/70-upload.js ──────────────────────────────────────────────────────
  const upPanel = $('uppanel'), upMsg = $('upmsg'), upFill = $('upfill'), upErr = $('uperr');

  const upShow = () => { upPanel.hidden = false; upErr.textContent = ''; upFill.style.width = '0%'; };
  const upProg = (done, total, name, verb) => {
    upMsg.textContent = `${verb || 'uploading'} ${done}/${total}${name ? ': ' + name : ''}`;
    upFill.style.width = Math.round(done * 100 / Math.max(total, 1)) + '%';
  };

  async function uploadItems(items) {
    if (degraded || offCount) {
      upShow();
      upMsg.textContent = 'offline — uploads need the ship (queued edits will sync first)';
      return;
    }
    const list = [];
    const skippedNames = [];
    for (const { file, rel } of items) {
      const dot = rel.lastIndexOf('.');
      const kind = dot > 0 ? extKind(rel.slice(dot + 1)) : null;
      if (!kind) { skippedNames.push(rel); continue; }
      const stem = rel.slice(0, dot);
      const parts = stem.split('/').map(slugSeg).filter(Boolean);
      if (folderCtx) parts.unshift(...folderCtx.split('/'));
      const name = parts.join('/');
      if (!name) { skippedNames.push(rel); continue; }
      list.push({ file, name, kind, odt: /\.odt$/i.test(rel) });
    }
    if (!list.length) {
      upShow();
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
    const CHUNK = 50;
    let fails = 0, done = 0;
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      let r = null;
      const payload = [];
      try {
        for (const it of part) {
          const c = it.odt ? await (await writerReady()).importOdt(await it.file.arrayBuffer()) : { text: await it.file.text() };
          if (c.error || c.note) upErr.textContent += it.name + ': ' + (c.error || c.note) + '\n';
          if (c.error) { fails++; continue; }
          payload.push({ name: it.name, type: it.kind, body: c.text || '\n' });
          upProg(done + payload.length, list.length, it.name, 'reading');
        }
        r = await mutate(api + '/page-save-batch',
          { method: 'POST', body: JSON.stringify(payload) });
      } catch {}
      if (!r || !r.ok) {
        fails += part.length;
        let msg = r ? r.status : 'network';
        if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
        const names = part.map((it) => it.name);
        const held = names.length > 6
          ? names.slice(0, 6).join(', ') + ', and ' + (names.length - 6) + ' more'
          : names.join(', ');
        upErr.textContent += `failed: ${part.length} file(s) — ${msg}\n  ${held}\n`;
      } else {
        for (const it of payload) {
          pageCache.delete(it.name);
          const nd = nodes.find((n) => n.page && n.path === it.name);
          if (nd) { nd.body = it.body; nd.kind = it.type; }
          else addTreeNode(it.name, it.type);
        }
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

// ── src/71-latex.js ───────────────────────────────────────────────────────
  const texRust = () => (window.__TAURI__ && window.__TAURI__.core) || null;

  const texOut = (name) => name + '-web';

  const TEX_DROP = 'script,style,iframe,frame,object,embed,video,audio,source,track,form,base,meta,link,svg';
  const TEX_SRC = ['src', 'srcset', 'poster', 'action', 'formaction', 'data', 'background'];
  function cleanTexHtml(html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    t.content.querySelectorAll(TEX_DROP).forEach((e) => e.remove());
    for (const e of t.content.querySelectorAll('*')) {
      for (const a of [...e.attributes]) {
        const n = a.name.toLowerCase();
        const v = a.value.replace(/[\u0000-\u0020]/g, '').replace(/\\/g, '/');
        const abs = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(v);
        const bad = n.startsWith('on')
          || ((n === 'href' || n === 'xlink:href') && abs && !/^(https?|mailto):/i.test(v))
          || (TEX_SRC.includes(n) && abs);
        if (bad) e.removeAttribute(a.name);
      }
    }
    return t.innerHTML;
  }

  let texProbe = null;         // last probe result, per page open

  const texBtn = () => $('texconv');

  async function refreshTexButton() {
    const b = texBtn();
    if (!b) return;
    const rust = texRust();
    const isTex = curKind === 'tex' || pkind.value === 'tex';
    if (!rust || !isTex || mode === 'know') { b.hidden = true; return; }
    b.hidden = false;
    b.textContent = 'convert to html';
    b.disabled = false;                     // never a dead control: see below
    texProbe = await probePandoc(rust);
    b.title = texProbe.available
      ? 'convert this LaTeX to a sibling html page using ' +
        (texProbe.version || 'pandoc')
      : texProbe.stale
        ? 'this desktop build predates LaTeX support (click for what to do)'
        : 'needs pandoc installed on this machine (click to find out how)';
    b.classList.toggle('needsdep', !(texProbe && texProbe.available));
  }

  async function probePandoc(rust) {
    try {
      const r = await rust.invoke('pandoc_probe');
      return r && typeof r === 'object' ? r : { available: false };
    } catch (e) {
      const msg = String((e && e.message) || e || '');
      return {
        available: false,
        stale: /not found|not allowlisted|unknown command|does not exist/i.test(msg),
        why: msg.slice(0, 200),
      };
    }
  }

  let texConvBusy = false;

  async function convertTex() {
    if (texConvBusy) return;
    texConvBusy = true;
    try { await runConvertTex(); }
    finally { texConvBusy = false; }
  }

  async function runConvertTex() {
    const rust = texRust();
    if (!rust) return;
    if (!texProbe) texProbe = await probePandoc(rust);
    if (texProbe.stale) {
      st('this desktop build has no LaTeX support yet', false);
      await askConfirm(
        'This copy of the desktop app was built before LaTeX support existed, ' +
        'so it has no converter to call. The web UI updated on its own; the ' +
        'app has to be rebuilt and reinstalled. Nothing is wrong with your ' +
        'pandoc install.', 'ok');
      return;
    }
    if (!texProbe.available) {
      st('pandoc is not installed on this machine', false);
      const go = await askConfirm(
        'Converting LaTeX needs pandoc, which is not installed. ' +
        'Open the pandoc install page?', 'open');
      if (go) rust.invoke('open_external_url', { url: 'https://pandoc.org/installing.html' });
      return;
    }
    if (!current) { st('save this page before converting', false); return; }
    const out = texOut(current);
    stWork('converting with pandoc…');
    let html = null;
    try { html = cleanTexHtml(await rust.invoke('convert_tex', { src: src.value })); }
    catch (e) {
      st('pandoc: ' + String(e && e.message ? e.message : e).slice(0, 160), false);
      return;
    }
    const body = '<!-- generated from ' + current +
      '.tex by pandoc. Edits here are lost on the next convert. -->\n' + html;
    const known = nodes.some((n) => n.page && n.path === out);
    const url = api + '/page-save?name=' + encodeURIComponent(out) + '&type=html';
    let r = await mutate(url + (known ? '' : '&new=1'), { method: 'POST', body });
    if (!known && r && r.status === 409)
      r = await mutate(url, { method: 'POST', body });
    if (!r || !r.ok) { st('could not write ' + out + await errText(r), false); return; }
    if (!known) { addTreeNode(out, 'html'); snapTree(); renderTree(); }
    bustPages(out);
    st('wrote ' + out + '.html');
  }

  if (texBtn()) texBtn().onclick = convertTex;

  let texCache = { src: null, html: null };
  let texTimer = 0;
  let texBusy = false;

  const TEX_DEBOUNCE = 400;

  function texSourceFallback(body) {
    return '<pre>' + mdEsc(body) + '</pre>';
  }

  function texPreviewHtml(body) {
    if (!texRust()) return texSourceFallback(body);
    if (texCache.src !== body) scheduleTexRender(body);
    return texCache.html === null ? texSourceFallback(body) : texCache.html;
  }

  function scheduleTexRender(body) {
    clearTimeout(texTimer);
    texTimer = setTimeout(() => { runTexRender(body); }, TEX_DEBOUNCE);
  }

  async function runTexRender(body) {
    const rust = texRust();
    if (!rust) return;
    if (texBusy) { scheduleTexRender(body); return; }
    if (!texProbe) texProbe = await probePandoc(rust);
    if (!texProbe.available) { texCache = { src: body, html: null }; return; }
    texBusy = true;
    let html = null;
    let err = null;
    try { html = cleanTexHtml(await rust.invoke('convert_tex', { src: body })); }
    catch (e) { err = String(e && e.message ? e.message : e); }
    texBusy = false;
    texCache = {
      src: body,
      html: html !== null ? html
        : '<pre style="color:#c33;white-space:pre-wrap">' +
          mdEsc(err || 'pandoc could not convert this document') + '</pre>',
    };
    if (src.value !== body) { scheduleTexRender(src.value); return; }
    paintLocal();
  }

// ── src/72-acl.js ─────────────────────────────────────────────────────────
  customElements.define('lat-acl', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="aclwrap" hidden role="region" aria-label="access control">
  <div class="aclbar">
    <h2>Access control</h2>
    <span class="muted" id="aclsum"></span>
    <span class="grow"></span>
    <button id="aclreload" class="ico" title="reload from ship">&#8635;</button>
  </div>
  <div class="aclbody">
    <div class="row">
      <input id="aclnew" placeholder="new group name (e.g. friends)" autocomplete="off">
      <button id="aclnewbtn">create group</button>
    </div>
    <div id="aclgrid" class="aclgrid"></div>
    <section class="aclpub" id="aclpub" data-action="published" aria-labelledby="aclpubh">
      <h4 id="aclpubh">published pages</h4>
      <p class="aclnote">Pages anyone can read without a grant. Any ship can read
      a shared page over Urbit at its urb:// address. Anyone can read a clearweb
      page in a browser at its https link.</p>
      <div id="publist"></div>
    </section>
    <div class="aclban">
      <h4>banned ships</h4>
      <p class="aclnote">A banned ship cannot share anything with you and
      cannot be granted access — banning revokes what it already had. It does
      NOT hide pages you have published: those are readable by anyone, so
      unpublish to stop a read.</p>
      <div class="row">
        <input id="banship" placeholder="~ship" autocomplete="off" spellcheck="false">
        <button id="banadd">ban</button>
      </div>
      <div id="banlist" class="chips"></div>
    </div>
  </div>
  <datalist id="aclpaths"></datalist>
</div>`;
    }
  });

  const aclOpen = () => toolOpen('access');
  const aclLoad = () => {
    if (!permsLoaded) loadPerms(); else renderAcl();
    loadBans();
    renderPublished();
  };

  function renderPublished() {
    const host = $('publist');
    if (!host) return;
    host.textContent = '';
    const note = (t) => {
      const e = document.createElement('div');
      e.className = 'aclnote';
      e.textContent = t;
      host.appendChild(e);
    };
    if (!treeShares) { note('share modes are not known yet: they come with the file tree.'); return; }
    const pages = nodes.filter((n) => n.page).sort((a, b) => a.path.localeCompare(b.path));
    const groups = [['shared over Urbit', 'shared', urbUrl], ['clearweb', 'clearweb', cwUrl]];
    let any = false;
    for (const [title, mode, addr] of groups) {
      const mine = pages.filter((n) => n.share === mode);
      if (!mine.length) continue;
      any = true;
      const h = document.createElement('h5');
      h.textContent = title + ' (' + mine.length + ')';
      host.appendChild(h);
      for (const n of mine) {
        const u = addr(n.path);
        const row = document.createElement('div');
        row.className = 'pubrow';
        row.dataset.share = mode;
        row.dataset.page = n.path;
        const b = tip(document.createElement('button'), 'Copy address');
        b.type = 'button';
        b.className = 'sbtn';
        b.innerHTML = ico('copy');
        if (!u) {
          const m = document.createElement('span');
          m.className = 'aclnote';
          m.textContent = n.path + ': ' + urbMissing();
          b.disabled = true;
          row.append(m, b);
          host.appendChild(row);
          continue;
        }
        const a = document.createElement('a');
        a.textContent = u;
        if (mode === 'clearweb') { a.href = u; a.target = '_blank'; a.rel = 'noopener'; }
        else {
          a.href = api + '?url=' + encodeURIComponent(u);
          a.onclick = (e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
            e.preventDefault();
            browseIn(api + '?url=' + encodeURIComponent(u));
          };
        }
        b.onclick = () => copyLink(u);
        row.append(a, b);
        host.appendChild(row);
      }
    }
    if (!any) note('nothing is published. Share a page from its Page tab and it shows here.');
  }
  action({ id: 'published', name: 'Published pages', home: 'Ribbon › Access & groups',
    run: async () => { await aclOpen(); $('aclpub').scrollIntoView({ block: 'start' }); } });

  function aclPathOptions() {
    const dl = $('aclpaths');
    if (!dl) return;
    dl.textContent = '';
    const base = selfBase;
    const seen = new Set([base + '/pub', base + '/page']);
    for (const n of nodes) seen.add(base + '/page/' + n.path);
    for (const p of seen) {
      const o = document.createElement('option');
      o.value = p;
      dl.appendChild(o);
    }
  }

  function aclChips(host, items, onDel, label) {
    const row = document.createElement('div');
    row.className = 'chips';
    if (!items.length) {
      const e = document.createElement('span');
      e.className = 'aclnote';
      e.textContent = 'none';
      row.appendChild(e);
    }
    for (const it of items) {
      const a = document.createElement('a');
      a.textContent = (label ? label(it) : it) + ' ×';
      a.title = 'remove ' + it;
      a.onclick = () => onDel(it);
      row.appendChild(a);
    }
    host.appendChild(row);
  }

  function aclSection(card, label, items, onDel, disp) {
    const h = document.createElement('h4');
    h.textContent = label;
    card.appendChild(h);
    aclChips(card, items, onDel, disp);
  }

  function aclHead(g) {
    const head = document.createElement('header');
    const b = document.createElement('b');
    b.textContent = g.name;
    const del = document.createElement('button');
    del.textContent = 'delete';
    del.className = 'acl-del';
    del.onclick = async () => {
      if (!(await askDanger('delete group ' + g.name + ' and every grant it carries?', 'delete'))) return;
      const r = await busyFetch(api + '/share-group-del?name=' + encodeURIComponent(g.name),
        { method: 'POST' }).catch(() => null);
      if (!r || !r.ok) st('could not delete ' + g.name + await errText(r), false);
      loadPerms();
    };
    head.appendChild(b); head.appendChild(del);
    return head;
  }

  function aclShips(card, g) {
    aclSection(card, 'ships', g.ships, (v) => {
      g.ships = g.ships.filter((x) => x !== v); permSave(g);
    });
    const srow = document.createElement('div');
    srow.className = 'row';
    const sin = document.createElement('input');
    sin.placeholder = '~ship';
    sin.autocomplete = 'off';
    const sadd = document.createElement('button');
    sadd.textContent = 'add ship';
    const addShip = () => {
      const v = sin.value.trim();
      if (!v) return;
      if (!g.ships.includes(v)) { g.ships.push(v); permSave(g); }
      sin.value = '';
    };
    sadd.onclick = addShip;
    sin.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addShip(); } };
    srow.appendChild(sin); srow.appendChild(sadd);
    card.appendChild(srow);
  }

  function aclPathRow(card, g) {
    const prow = document.createElement('div');
    prow.className = 'row';
    const pin = document.createElement('input');
    pin.placeholder = selfBase + '/pub';
    pin.setAttribute('list', 'aclpaths');
    pin.autocomplete = 'off';
    const radd = document.createElement('button');
    radd.textContent = '+read';
    const eadd = document.createElement('button');
    eadd.textContent = '+edit';
    const addPath = (edit) => {
      const v = pin.value.trim();
      if (!v) { st('enter a path to grant', false); return; }
      if (!g.peek.includes(v)) g.peek.push(v);           // edit implies read
      if (edit && !g.make.includes(v)) g.make.push(v);
      permSave(g);
      pin.value = '';
    };
    radd.onclick = () => addPath(false);
    eadd.onclick = () => addPath(true);
    prow.appendChild(pin); prow.appendChild(radd); prow.appendChild(eadd);
    card.appendChild(prow);
  }

  function aclReadOnlyNote(card, g) {
    if (!(g.poke && g.poke.length) && !g.opaque) return;
    const h = document.createElement('h4');
    h.textContent = 'not editable here';
    card.appendChild(h);
    const m = document.createElement('div');
    m.className = 'aclnote';
    const parts = [];
    if (g.poke && g.poke.length) parts.push(g.poke.length + ' poke grant(s)');
    if (g.opaque) parts.push(g.opaque + ' advanced rule(s)');
    m.textContent = parts.join(' + ') +
      ' — preserved exactly as they are on every save. Poke grants eval' +
      ' power, so they stay a dojo-level act.';
    card.appendChild(m);
    if (g.poke && g.poke.length) {
      const l = document.createElement('div');
      l.className = 'aclnote';
      l.textContent = g.poke.join(', ');
      card.appendChild(l);
    }
  }

  function aclCard(g, disp) {
    const card = document.createElement('div');
    card.className = 'aclcard';
    card.appendChild(aclHead(g));
    aclShips(card, g);
    aclSection(card, 'read', g.peek, (v) => {
      g.peek = g.peek.filter((x) => x !== v);
      g.make = g.make.filter((x) => x !== v);
      permSave(g);
    }, disp);
    aclSection(card, 'edit', g.make, (v) => {
      g.make = g.make.filter((x) => x !== v); permSave(g);
    }, disp);
    aclPathRow(card, g);
    aclReadOnlyNote(card, g);
    return card;
  }

  function renderAcl() {
    const grid = $('aclgrid');
    if (!grid) return;
    aclPathOptions();             // after a load, so selfBase is known
    grid.textContent = '';
    $('aclsum').textContent = permGroups.length
      ? permGroups.length + ' group' + (permGroups.length === 1 ? '' : 's')
      : '';
    if (!permGroups.length) {
      const e = document.createElement('div');
      e.className = 'aclempty';
      e.textContent = 'No groups yet. A group names ships and what they may read or edit.';
      grid.appendChild(e);
      return;
    }
    const allPaths = permGroups.flatMap((x) => [...x.peek, ...x.make]);
    const disp = (v) => shortPath(v, allPaths);
    for (const g of permGroups) grid.appendChild(aclCard(g, disp));
  }

  let banned = [];
  async function loadBans() {
    try {
      const r = await fetch(api + '/banlist');
      if (!r.ok) return;
      banned = await r.json();
    } catch { return; }
    renderBans();
  }
  function renderBans() {
    const host = $('banlist');
    if (!host) return;
    host.textContent = '';
    if (!banned.length) {
      const e = document.createElement('span');
      e.className = 'aclnote';
      e.textContent = 'nobody is banned.';
      host.appendChild(e);
      return;
    }
    for (const w of banned) {
      const a = document.createElement('a');
      a.textContent = w + ' ×';
      a.title = 'unban ' + w;
      a.onclick = async () => {
        const r = await busyFetch(api + '/unban?ship=' + encodeURIComponent(w), { method: 'POST' })
          .catch(() => null);
        if (!r || !r.ok) st('could not unban ' + w + await errText(r), false);
        else st('unbanned ' + w + ' — it holds no access until you grant it again');
        loadBans();
      };
      host.appendChild(a);
    }
  }
  $('banadd').onclick = async () => {
    const w = $('banship').value.trim();
    if (!w) return;
    if (!(await askDanger('ban ' + w + '? this revokes every grant it holds, and unban will not restore them', 'ban'))) return;
    const r = await busyFetch(api + '/ban?ship=' + encodeURIComponent(w), { method: 'POST' })
      .catch(() => null);
    if (!r || !r.ok) { st('could not ban ' + w + await errText(r), false); return; }
    const j = await r.json().catch(() => ({}));
    st('banned ' + w + (j.revoked ? ' — revoked from ' + j.revoked + ' group(s)' : ''));
    $('banship').value = '';
    loadBans();
    loadPerms();          // membership changed server-side. Repaint the groups
  };
  $('banship').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('banadd').click(); }
  };

  $('aclreload').onclick = () => { loadPerms(); loadBans(); };
  $('aclnewbtn').onclick = async () => {
    const v = $('aclnew').value.trim();
    if (!v) return;
    await permSave({ name: v, ships: [], peek: [], make: [] });
    $('aclnew').value = '';
  };
  $('aclnew').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('aclnewbtn').click(); }
  };

// ── src/73-comments.js ────────────────────────────────────────────────────
  customElements.define('lat-comments', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="cmwrap" hidden role="region" aria-label="inbox">
  <div class="aclbar">
    <h2>Inbox</h2>
    <span class="ibtabs" role="tablist">
      <button id="ibtab-held" role="tab" data-ib="held">Held</button>
      <button id="ibtab-act" role="tab" data-ib="act">Activity</button>
      <button id="ibtab-cm" role="tab" data-ib="cm">Comments</button>
    </span>
    <span class="muted" id="cmsum"></span>
    <span class="grow"></span>
    <button id="ibreadall" hidden>mark all read</button>
    <button id="cmreload" class="ico" title="reload from ship">&#8635;</button>
  </div>
  <div class="aclbody">
    <div id="ibheld" hidden></div>
    <div id="ibact" hidden></div>
    <div id="cmlist" hidden></div>
  </div>
</div>`;
    }
  });

  let inbox = [];
  async function loadComments() {
    const host = $('cmlist');
    if (host && !host.childElementCount) {
      host.className = 'aclempty';
      host.textContent = 'loading…';
    }
    let d = null;
    try {
      const r = await busyFetch(api + '/comments-inbox');
      if (!r.ok) { st('comments failed' + await errText(r), false); return; }
      d = await r.json();
    } catch { st('comments failed', false); return; }
    inbox = d.items || [];
    renderComments(d.total || inbox.length);
  }

  function renderComments(total, {
    host = $('cmlist'), items = inbox, sum = $('cmsum'), reload = loadComments,
    empty = 'No comments. They are opt-in per page: switch them on in a '
      + 'page\'s Page tab.',
    pageLink = true,
  } = {}) {
    if (!host) return;
    host.textContent = '';
    host.className = '';
    if (sum) {
      sum.textContent = items.length
        ? items.length + (total > items.length ? ' of ' + total : '') + ' comment'
          + (total === 1 ? '' : 's')
        : '';
    }
    if (!items.length) {
      host.className = 'aclempty';
      host.textContent = empty;
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'aclgrid';
    for (const c of items) {
      const card = document.createElement('div');
      card.className = 'aclcard';
      const head = document.createElement('header');
      const who = document.createElement('b');
      who.textContent = c.author;
      const del = document.createElement('button');
      del.textContent = 'remove';
      del.className = 'acl-del';
      del.onclick = async () => {
        if (!(await askDanger('remove this comment by ' + c.author + '?', 'remove'))) return;
        const r = await busyFetch(api + '/comment-del?page=' + encodeURIComponent(c.page) +
          '&id=' + encodeURIComponent(c.id), { method: 'POST' }).catch(() => null);
        if (!r || !r.ok) { st('remove failed' + await errText(r), false); return; }
        st('comment removed');
        reload();
      };
      head.appendChild(who); head.appendChild(del);
      card.appendChild(head);

      if (pageLink) {
        const on = document.createElement('a');
        on.className = 'gname';
        on.textContent = c.page;
        on.style.cursor = 'pointer';
        on.onclick = (e) => openIn('page', c.page, { ev: e });
        card.appendChild(on);
      }

      const body = document.createElement('div');
      body.style.whiteSpace = 'pre-wrap';
      body.style.overflowWrap = 'anywhere';
      body.textContent = c.body;
      card.appendChild(body);

      const when = document.createElement('div');
      when.className = 'aclnote';
      when.textContent = c.when;
      card.appendChild(when);
      grid.appendChild(card);
    }
    host.appendChild(grid);
  }

  let ibTab = null;
  let held = [];
  let acts = [];
  const ago = (ms) => new Date(ms).toLocaleString();

  function ibShow(tab) {
    ibTab = tab;
    for (const b of document.querySelectorAll('#cmwrap .ibtabs button')) {
      b.setAttribute('aria-selected', String(b.dataset.ib === tab));
    }
    $('ibheld').hidden = tab !== 'held';
    $('ibact').hidden = tab !== 'act';
    $('cmlist').hidden = tab !== 'cm';
    $('ibreadall').hidden = tab !== 'act' || !acts.some((a) => !a.read);
    const sum = $('cmsum');
    if (tab === 'held') sum.textContent = held.length ? held.length + ' held' : '';
    else if (tab === 'act') {
      const n = acts.filter((a) => !a.read).length;
      sum.textContent = n ? n + ' unread' : '';
    } else renderComments(inbox.length);
  }
  for (const b of document.querySelectorAll('#cmwrap .ibtabs button')) {
    b.onclick = () => ibShow(b.dataset.ib);
  }

  function ibCard(author, label, onLabel, body, when) {
    const card = document.createElement('div');
    card.className = 'aclcard';
    const head = document.createElement('header');
    const who = document.createElement('b');
    who.textContent = author;
    head.appendChild(who);
    card.appendChild(head);
    if (label) {
      const on = document.createElement('a');
      on.className = 'gname';
      on.textContent = label;
      on.style.cursor = 'pointer';
      on.onclick = onLabel;
      card.appendChild(on);
    }
    const b = document.createElement('div');
    b.style.whiteSpace = 'pre-wrap';
    b.style.overflowWrap = 'anywhere';
    b.textContent = body;               // text, never HTML
    card.appendChild(b);
    const w = document.createElement('div');
    w.className = 'aclnote';
    w.textContent = ago(when);
    card.appendChild(w);
    return card;
  }
  const ibButton = (card, label, run) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = async () => { b.disabled = true; await run(); b.disabled = false; };
    card.querySelector('header').appendChild(b);
    return b;
  };
  function ibEmpty(host, text) {
    host.className = 'aclempty';
    host.textContent = text;
  }

  async function loadHeld() {
    try {
      const r = await busyFetch(api + '/held-comments');
      if (!r.ok) { st('held comments failed' + await errText(r), false); return; }
      held = (await r.json()).items || [];
    } catch { st('held comments failed', false); return; }
    const host = $('ibheld');
    host.textContent = '';
    host.className = '';
    if (!held.length) {
      ibEmpty(host, 'Nothing held. Comet comments wait here when a page\'s comet '
        + 'comments are set to held in its Page tab.');
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'aclgrid';
    for (const c of held) {
      const card = ibCard(c.author, c.page, (e) => openIn('page', c.page, { ev: e }), c.body, c.when);
      for (const act of ['approve', 'reject']) {
        ibButton(card, act, async () => {
          const r = await mutate(api + '/comet-pending?page=' + encodeURIComponent(c.page)
            + '&id=' + encodeURIComponent(c.id) + '&do=' + act);
          if (!r || !r.ok) { st(act + ' failed' + await errText(r), false); return; }
          st(act === 'approve' ? 'comment approved' : 'comment rejected');
          await loadHeld();
          ibShow(ibTab);
          refreshInboxBadge(true);
        });
      }
      grid.appendChild(card);
    }
    host.appendChild(grid);
  }

  const actLabel = (a) => {
    if (a.kind === 'comment') return 'comment on ' + a.where;
    const t = a.title ? ': ' + a.title : '';
    if (a.kind === 'remote') return 'reply on ' + a.host + '/' + a.where + t;
    if (a.kind === 'reply') return 'reply on ' + a.where + t;
    if (a.kind === 'folder') return a.title || a.where;
    return a.where;
  };
  const actOpen = (a, e) => {
    if (a.kind === 'folder') return browseIn(api + '?url=' + encodeURIComponent('urb://' + a.host + a.where + '/'));
    if (a.kind === 'comment') return openIn('page', a.where, { ev: e });
    const tail = encodeURIComponent(a.where) + '/' + a.post;
    return browseIn(a.kind === 'remote'
      ? '/apps/lattice/forum-remote/' + a.host + '/' + tail
      : '/apps/lattice/forum/' + tail);
  };
  async function markRead(q) {
    const r = await mutate(api + '/notify-read?' + q);
    if (!r || !r.ok) { st('mark read failed' + await errText(r), false); return false; }
    return true;
  }

  async function loadActivity() {
    try {
      const r = await busyFetch(api + '/notify');
      if (!r.ok) { st('activity failed' + await errText(r), false); return; }
      acts = (await r.json()).items || [];
    } catch { st('activity failed', false); return; }
    const host = $('ibact');
    host.textContent = '';
    host.className = '';
    if (!acts.length) {
      ibEmpty(host, 'No activity yet. Comments from other ships on your pages, and '
        + 'replies to your forum posts and comments, show here.');
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'aclgrid';
    for (const a of acts) {
      const read = async () => {
        if (a.read || !(await markRead('id=' + encodeURIComponent(a.id)))) return;
        a.read = true;
        card.classList.remove('unread');
        if (mk) mk.remove();
        ibShow(ibTab);
        refreshInboxBadge(true);
      };
      const card = ibCard(a.who, actLabel(a), (e) => { read(); actOpen(a, e); }, a.body, a.when);
      card.classList.toggle('unread', !a.read);
      const mk = a.read ? null : ibButton(card, 'mark read', read);
      ibButton(card, 'open', async () => { read(); await actOpen(a); });
      grid.appendChild(card);
    }
    host.appendChild(grid);
  }
  $('ibreadall').onclick = async () => {
    if (!(await markRead('all=1'))) return;
    st('all activity marked read');
    await loadActivity();
    ibShow('act');
    refreshInboxBadge(true);
  };

  function paintUnread(n) {
    const b = $('rb-inbox');
    if (!b) return;
    if (n > 0) { b.dataset.n = n > 99 ? '99+' : String(n); b.classList.add('has-unread'); }
    else { delete b.dataset.n; b.classList.remove('has-unread'); }
    tip(b, n > 0 ? 'Inbox, ' + b.dataset.n + ' unread' : 'Inbox');
  }

  const BADGE_MS = 60000;
  let badgeAt = 0;
  async function refreshInboxBadge(now) {
    if (!now && Date.now() - badgeAt < BADGE_MS) return;
    badgeAt = Date.now();
    let d = null;
    try {
      const r = await bgFetch(api + '/notify-count');
      if (!r.ok) return;                 // a failed count is not worth reporting
      d = await r.json();
    } catch { return; }
    paintUnread((d.held || 0) + (d.unread || 0));
  }
  const refreshCommentBadge = () => refreshInboxBadge(false);

  const cmLoad = () => {
    Promise.all([loadHeld(), loadActivity(), loadComments()]).then(() => {
      ibShow(ibTab || (held.length ? 'held' : 'act'));
      refreshInboxBadge(true);
    });
  };
  $('cmreload').onclick = cmLoad;

// ── src/74-orrery.js ──────────────────────────────────────────────────────
  function orreryShow() {
    const sec = $('orrsec'), el = $('orr');
    if (!sec || !el || !window.LatticeOrrery) return;
    if (curFolder || !current) {
      LatticeOrrery.unmount(el);
      sec.hidden = true;
      return;
    }
    const path = current;
    LatticeOrrery.mount(el, path, () => {
      const n = nodes.find((x) => x.path === path);
      return { title: (n && n.dname) || path.split('/').pop(), text: src.value };
    }, sec);
  }

// ── src/75-move.js ────────────────────────────────────────────────────────
  const moveReq = async (from, to, rn) => {
    moving++;
    const end = busy();      // the line from the click, the flush included
    try {
      await flushNoAsk();
      await waitSave();
      return await mutate(api + '/page-move?from=' + encodeURIComponent(from) +
        '&to=' + encodeURIComponent(to) + '&dname=' + encodeURIComponent((rn && rn.dname) || '') +
        (rn && rn.dnames ? '&dnames=' + encodeURIComponent(rn.dnames) : ''));
    } finally { end(); moving--; }
  };
  const remapMoved = (from, to, rn) => {
    tabsRemap('page', from, to);       // and the tabs naming them (21-tabs.js)
    let moved = 0;
    for (const n of nodes)
      if (n.path === from || n.path.startsWith(from + '/')) {
        if (n.page) moved++;
        n.path = to + n.path.slice(from.length);
      }
    if (mode !== 'know' && !grubPath && current &&
        (current === from || current.startsWith(from + '/'))) {
      const nn = to + current.slice(from.length);
      setOpen(nn, { readOnly: pname.readOnly, url: '/apps/lattice/app?name=' + encodeURIComponent(nn) });
    }
    if (to.includes('/')) addFolderNodes(to.slice(0, to.lastIndexOf('/')));
    applyDnames(rn || { name: to, dname: '', dnames: '' });
    return moved;
  };
  async function movePage(oldName, newName, rn) {
    const r = await moveReq(oldName, newName, rn);
    if (!r.ok) { st('move failed' + await errText(r), false); return false; }
    remapMoved(oldName, newName, rn);
    snapTree();
    renderTree();
    return r;
  }

  async function moveFolder(oldPath) {
    let seed = oldPath;
    for (;;) {
      const typed = await askName('move / rename folder ' + oldPath + ' to:', seed, 'move');
      if (!typed) return;
      const rn = realName(typed);
      const newPath = rn.name;
      if (newPath === oldPath && !rn.dname) return;
      st('moving ' + oldPath + ' \u2192 ' + newPath + '\u2026');
      const r = await moveReq(oldPath, newPath, rn);
      if (!(r.ok || r.offline)) {
        st('move failed' + await errText(r), false);
        seed = typed;
        continue;
      }
      const inside = (p) => !!p && (p === oldPath || p.startsWith(oldPath + '/'));
      const wasOpen = mode !== 'know' && !grubPath && inside(current);
      const moved = remapMoved(oldPath, newPath, rn);
      snapTree();
      renderTree();
      st('moved ' + oldPath + ' \u2192 ' + newPath +
        (r.offline ? ' offline' : '') + ' (' + moved + ' pages)');
      if (wasOpen && current) openPage(current);
      else if (inside(curFolder)) selectFolder(newPath + curFolder.slice(oldPath.length));
      return;
    }
  }

// ── src/76-outline.js ─────────────────────────────────────────────────────

  function outLinks(body, kind) {
    if (kind === 'fodt') return wrX('out', body);
    const html = kind === 'md' ? mdToHtml(body) : kind === 'gmi' ? gmiToHtml(body) : '';
    const out = [];
    for (const m of html.matchAll(/<a href="([^"]*)"/g)) {
      let t = mdUnesc(m[1]);
      const pg = /^\/apps\/lattice\/app\?name=([^&#]*)$/.exec(t);
      const urb = /^\/apps\/lattice\?url=(urb:\/\/.*)$/.exec(t);
      if (pg) { try { t = decodeURIComponent(pg[1]); } catch { continue; } }
      else if (urb) t = urb[1];
      else if (t.startsWith('#')) continue;      // an anchor in the page itself
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  }

  function outline(body, kind) {
    const out = [];
    if (kind === 'fodt') return wrX('outline', body);
    if (kind !== 'md' && kind !== 'gmi') return out;
    const lines = String(body == null ? '' : body).split('\n');
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (kind === 'gmi') {
        if (ln.trimEnd() === '```') { fence = fence ? null : '```'; continue; }
        if (fence) continue;
      } else {
        if (fence) { if (ln.trimStart().startsWith(fence)) fence = null; continue; }
        const f = ln.match(/^\s*(```|~~~)/);
        if (f) { fence = f[1]; continue; }
      }
      const h = ln.match(kind === 'gmi' ? /^(#{1,3}) (.*)$/ : /^(#{1,6})\s+(.*)$/);
      if (h) out.push({ level: h[1].length, text: h[2].trim(), line: i + 1 });
    }
    return out;
  }

  const rpSec = (id) => document.querySelector('#rbody > [data-pane=' + id + ']');
  const NONE = '<p class="rpnone muted" hidden>Nothing here for this tab.</p>';
  rpSec('out').innerHTML = NONE + '<div id="outsec"><h3>outgoing links</h3><div id="outlist"></div></div>';
  rpSec('outline').innerHTML = NONE + '<div id="olsec"><h3>outline</h3><div id="ollist"></div></div>';
  rpSec('comments').innerHTML = NONE + `<div id="rpcmsec">
  <h3>comments on this page</h3>
  <div id="rpcmlist"></div>
  <textarea id="rpcmbody" rows="3" placeholder="Write a comment"></textarea>
  <div class="row"><span id="rpcmnote" class="muted grow"></span><button id="rpcmpost">Post</button></div>
</div>`;
  for (const id of ['back', 'hist', 'page']) rpSec(id).insertAdjacentHTML('afterbegin', NONE);

  const rpDoc = () => {
    if (activeTab && !['page', 'know', 'grub'].includes(activeTab.kind)) return null;
    if (grubPath) return { kind: 'grub', key: grubPath };
    if (curFolder !== null) return null;
    return { kind: mode === 'know' ? 'know' : 'page', key: current };
  };
  const rpApplies = (id, d) => !!d && (
    id === 'out' || id === 'outline' ? d.kind !== 'grub'
      : id === 'hist' ? d.kind !== 'grub' && !!d.key
        : d.kind === 'page' && !!d.key);
  const RP_BODY = { out: 'outsec', outline: 'olsec', back: 'linksec', comments: 'rpcmsec', hist: 'histsec' };
  const rpText = () => (mode === 'know' ? 'md' : pkind.value);

  const rpLoaded = {};
  let rpTimer = 0;
  let rpForce = null;
  function rpPaint() {
    rpTimer = 0;
    const force = rpForce;
    rpForce = null;
    const d = rpDoc();
    const key = d && d.key ? d.kind + ':' + d.key : null;
    const tool = !docFront();
    rpSec('page').querySelector('.rpnone').hidden = !tool;
    rpSec('page').querySelector('lat-ctl').hidden = tool;
    for (const id of Object.keys(RP_BODY)) {
      const ok = rpApplies(id, d);
      rpSec(id).querySelector('.rpnone').hidden = ok;
      $(RP_BODY[id]).hidden = !ok;
      if (!ok || !paneShows('r', id)) continue;
      if (id === 'out') paintOut();
      else if (id === 'outline') paintOutline();
      else if (force === id || rpLoaded[id] !== key) {
        rpLoaded[id] = key;
        if (id === 'back') loadBacklinks();
        else if (id === 'hist') loadHistory();
        else loadPageComments();
      }
    }
    $('cmtrow').hidden = !(d && d.kind === 'page' && d.key && !linkOf(d.key));
    if (rpApplies('comments', d)) paintCmBox();
  }
  function rpSoon(ms = 30) {
    clearTimeout(rpTimer);
    rpTimer = setTimeout(rpPaint, ms);
  }
  pname.addEventListener('input', () => rpSoon());
  rpHook = () => rpSoon(300);
  document.addEventListener('lat-pane', (e) => {
    if (e.detail.side !== 'r') return;
    rpForce = e.detail.id;
    rpSoon(0);
  });
  rpSoon(0);

  function paintOut() {
    const host = $('outlist');
    host.textContent = '';
    const links = outLinks(src.value, rpText());
    if (!links.length) {
      host.innerHTML = '<div class="muted">no outgoing links</div>';
      return;
    }
    for (const t of links) {
      const a = document.createElement('a');
      a.className = 'olrow';
      a.textContent = t;
      if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/')) {
        a.href = t.startsWith('urb://') ? '/apps/lattice?url=' + encodeURIComponent(t) : t;
        if (/^https?:/i.test(t)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      } else {
        a.href = '/apps/lattice/app?name=' + encodeURIComponent(t);
        if (!nodes.some((n) => n.page && n.path === t)) {
          a.classList.add('muted');
          a.title = t + ' does not exist yet';
        }
        tabLink(a, 'page', t);
      }
      host.append(a);
    }
  }

  function paintOutline() {
    const host = $('ollist');
    host.textContent = '';
    const hs = outline(src.value, rpText());
    if (!hs.length) {
      host.innerHTML = '<div class="muted">no headings</div>';
      return;
    }
    hs.forEach((h, i) => {
      const a = document.createElement('a');
      a.className = 'olrow';
      a.href = '#';
      a.style.paddingLeft = (h.level - 1) * 12 + 'px';
      a.textContent = h.text || '(untitled)';
      a.onclick = (e) => { e.preventDefault(); goHeading(h.line, i); };
      host.append(a);
    });
  }
  function goHeading(line, idx) {
    if ($('ws').classList.contains('vp')) {
      let doc = null;
      try { doc = prev.contentDocument; } catch {}
      const el = doc && doc.querySelectorAll('h1, h2, h3, h4, h5, h6')[idx];
      if (el) el.scrollIntoView({ block: 'start' });
      return;
    }
    if (wr) return wr.heading(idx);
    const lines = src.value.split('\n');
    let off = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
    src.focus();
    src.setSelectionRange(off, off);
    const lh = parseFloat(getComputedStyle(src).lineHeight) || 20;
    src.scrollTop = Math.max(0, (line - 1) * lh - src.clientHeight / 3);
    sync();
  }

  async function loadPageComments() {
    const host = $('rpcmlist');
    const want = current;
    paintCmBox();
    host.className = 'muted';
    host.textContent = 'loading…';
    let d = null;
    try {
      const r = await busyFetch(api + '/comments-inbox', undefined, 'rp:comments', $('rpane'));
      if (!r.ok) { host.textContent = ''; st('comments failed' + await errText(r), false); return; }
      d = await r.json();
    } catch { host.textContent = ''; st('comments failed', false); return; }
    if (current !== want) return;
    const items = (d.items || []).filter((c) => c.page === want);
    renderComments(items.length, {
      host, items, sum: null, pageLink: false,
      reload: () => { rpForce = 'comments'; rpSoon(0); },
      empty: 'No comments on this page.',
    });
  }
  function paintCmBox() {
    const off = cmtFor !== current || cmtOn !== true;
    $('rpcmbody').disabled = off;
    $('rpcmpost').disabled = off;
    $('rpcmnote').textContent = cmtFor === current && cmtOn === false
      ? 'Comments are off for this page. Switch them on in the Page tab.' : '';
  }
  $('rpcmpost').onclick = async () => {
    const page = current;
    const body = $('rpcmbody').value.trim();
    if (!page || !body) return;
    $('rpcmpost').disabled = true;
    const r = await busyFetch(api + '/comment?page=' + encodeURIComponent(page), {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'body=' + encodeURIComponent(body),
    }, null, $('rpane')).catch(() => null);
    $('rpcmpost').disabled = false;
    if (!r || !(r.ok || r.type === 'opaqueredirect')) { st('comment failed' + await errText(r), false); return; }
    if (current === page) $('rpcmbody').value = '';
    st('comment posted');
    setTimeout(() => { if (current === page) { rpForce = 'comments'; rpSoon(0); } }, 1500);
  };

// ── src/77-history.js ─────────────────────────────────────────────────────
  customElements.define('lat-history', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="histsec" hidden>
  <h3 id="histh">history</h3>
  <div id="histview" class="row" hidden>
    <button id="hrestore">restore</button>
    <button id="hback">back to latest</button>
  </div>
  <div id="histlist" class="chips"></div>
</div>`;
    }
  });
  customElements.define('lat-links', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="linksec" hidden>
  <h3 id="linkh">linked from</h3>
  <div id="linklist" class="chips"></div>
</div>`;
    }
  });

  const linkList = $('linklist');
  async function loadBacklinks() {
    linkList.textContent = '';
    if (!current || mode === 'know') return;
    const want = current;
    let j = null;
    try {
      const r = await busyFetch(api + '/page-backlinks?name=' + encodeURIComponent(want), undefined, 'rp:back', $('rpane'));
      if (!r.ok) return;
      j = await r.json();
    } catch { return; }
    if (current !== want) return;
    const links = (j.links || []).filter((p) => p !== current);
    if (!links.length) {
      const d = document.createElement('div');
      d.className = 'muted';
      d.textContent = 'nothing links here yet';
      linkList.appendChild(d);
      return;
    }
    for (const pth of links) {
      const a = document.createElement('a');
      a.textContent = pth;
      tabLink(a, 'page', pth);
      linkList.appendChild(a);
    }
  }

  function resetPanels() {
    histView.hidden = true;
    rpSoon();
  }

  const histList = $('histlist'), histView = $('histview');
  let revKind = null;
  const exitRev = () => {
    viewingRev = null;
    revKind = null;
    src.readOnly = false;
    histView.hidden = true;
  };
  async function loadHistory() {
    histList.textContent = '';
    if (!current) return;
    const want = current;
    let j = null;
    try {
      const r = await busyFetch(mode === 'know'
        ? api + '/know-history?key=' + encodeURIComponent(want)
        : api + '/page-history?name=' + encodeURIComponent(want), undefined, 'rp:hist', $('rpane'));
      if (!r.ok) return;
      j = await r.json();
    } catch { return; }
    if (current !== want) return;
    const revs = j.revisions || [];
    if (revs.length < 2) {               // a single revision is just "now"
      const d = document.createElement('div');
      d.className = 'muted';
      d.textContent = 'no history yet';
      histList.appendChild(d);
      return;
    }
    for (const v of revs.slice(0, 30)) {
      const a = document.createElement('a');
      const m = /^~(\d+)\.(\d+)\.(\d+)\.\.(\d+)\.(\d+)\.(\d+)/.exec(v.updated || '');
      const when = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
      const label = when && when.toLocaleString(undefined,
        { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      a.textContent = label || ('rev ' + v.rev);
      a.dataset.rev = v.rev;
      a.className = v.rev === viewingRev ? 'on' : '';
      a.onclick = () => openRev(v.rev, label);
      histList.appendChild(a);
    }
  }
  async function openRev(rev, lbl) {
    if (!(await guardDirty())) return;
    let d = null;
    try {
      const r = await busyFetch(mode === 'know'
        ? api + '/know-read-at?key=' + encodeURIComponent(current) + '&rev=' + rev
        : api + '/page-source-at?name=' + encodeURIComponent(current) + '&rev=' + rev);
      if (!r.ok) {
        st('revision load failed' + await errText(r), false);
        if (r.status === 404) loadHistory();
        return;
      }
      d = await r.json();
    } catch { st('revision load failed (network)', false); return; }
    viewingRev = rev;
    revKind = mode === 'know' ? null : (d.kind === 'index' ? 'md' : d.kind);
    dirty = false;
    src.value = d.body;
    src.readOnly = true;
    render(); sync();
    histView.hidden = false;
    for (const a of histList.children)
      a.className = +a.dataset.rev === rev ? 'on' : '';
    st('viewing ' + (lbl || 'an earlier version') + ' \u00b7 read-only');
    if (mode !== 'know' && CONTENT()) refreshPreview();
  }
  $('hback').onclick = () => {
    exitRev();
    if (mode === 'know') openKnow(current); else openPage(current);
  };
  $('hrestore').onclick = async () => {
    if (viewingRev === null) return;
    const rev = viewingRev;
    if (mode === 'know') {
      exitRev();
      const r = await mutate(api + '/know-restore-rev?key=' + encodeURIComponent(current) +
        '&rev=' + rev);
      if (!r.ok) { st('restore failed' + await errText(r), false); return; }
      knowGen++;
      await openKnow(current);   // repaints body + tags from the restored entry
      st('restored that version as the newest revision');
      loadHistory();
      return;
    }
    const kind = revKind;
    exitRev();
    dirty = true;          // the historical body is now an unsaved local edit
    await save(kind);      // under the revision's OWN kind, not the current select
    if (!dirty) st('restored that version as the newest revision');
    loadHistory();
  };

  $('mv').onclick = async () => {
    if (viewingRev !== null) { st('viewing rev ' + viewingRev + ' — use restore', false); return; }
    if (curFolder) { moveFolder(curFolder); return; }
    if (!current) { st('open something first', false); return; }
    if (mode !== 'know') { askMovePage(current); return; }
    let seed = current;
    for (;;) {
      const typed = await askName('move memory ' + current + ' to:', seed, 'move');
      if (!typed) return;
      const newName = realName(typed).name;
      if (newName === current) return;
      const from = current;
      const r = await mutate(api + '/know-move?from=' + encodeURIComponent(from) +
        '&to=' + encodeURIComponent(newName));
      if (!(r.ok || r.offline)) {
        st('move failed' + await errText(r), false);
        seed = newName;
        continue;
      }
      knowGen++;
      const k = knowKeys.find((x) => x.key.replace(/^\//, '') === from);
      if (k) k.key = newName;
      tabsRemap('know', from, newName);
      if (mode === 'know' && current === from) setOpen(newName, { readOnly: true });
      renderKnowChips();
      renderKnowTree();
      st('moved to ' + newName);
      return;
    }
  };
  async function askMovePage(from) {
    let seed = from;
    for (;;) {
      const typed = await askName('move page ' + from + ' to:', seed, 'move');
      if (!typed) return;
      const rn = realName(typed);
      const newName = rn.name;
      if (newName === from && !rn.dname) return;
      const mv = await movePage(from, newName, rn);
      if (mv) {
        st('moved to ' + newName + (mv.offline ? ' offline' : ''));
        if (mode !== 'know' && !grubPath && (current === from || current === newName))
          openPage(newName);
        return;
      }
      seed = typed;
    }
  }

// ── src/78-export.js ──────────────────────────────────────────────────────
  function vaultHook() {
    if (!window.LatticeVault) return;
    LatticeVault.configure({
      status: (m, ok) => st(m, ok),
      isDegraded: () => degraded || !!offCount,
    });
    if (window.__TAURI__) {
      window.__latticeBackup = (id) => LatticeVault.exportVault(id);
      const pend = new URLSearchParams(location.search).get('backup');
      if (pend) {
        const q = new URLSearchParams(location.search);
        q.delete('backup');
        const rest = q.toString();
        history.replaceState(history.state, '',
          location.pathname + (rest ? '?' + rest : '') + location.hash);
        setTimeout(() => window.__latticeBackup(pend), 3000);
      }
    }
  }

// ── src/78-pdf.js ─────────────────────────────────────────────────────────
  let pdfLoad = null;
  const pdfReady = () => (window.LatPdf ? Promise.resolve(window.LatPdf)
    : pdfLoad || (pdfLoad = new Promise((ok, no) => {
      const s = document.createElement('script');
      const fail = () => { pdfLoad = null; s.remove(); no(new Error('could not load the PDF export')); };
      s.src = '/apps/lattice/app/pdf.js?h=' + PDF_H;
      s.onload = () => (window.LatPdf ? ok(window.LatPdf) : fail());
      s.onerror = fail;
      document.head.append(s);
    })));
  const PDF_KINDS = ['md', 'gmi', 'html', 'text', 'tex', 'fodt', 'js', 'css', 'hoon'];
  async function pdfBody(kind, body) {
    if (kind === 'md') return { html: mdToHtml(body) };
    if (kind === 'gmi') return { html: gmiToHtml(body) };
    if (kind === 'text') return { html: '<pre class="text">' + mdEsc(body) + '</pre>' };
    if (kind === 'html') return { html: body, doc: true };
    if (kind === 'fodt') {
      const W = await writerReady();
      const h = W.render(body, true);
      if (!h) throw new Error('this document cannot be shown');
      return { html: h, doc: true, writer: true };
    }
    if (kind === 'tex') {
      const rust = texRust();
      if (rust) {
        try { return { html: cleanTexHtml(await rust.invoke('convert_tex', { src: body })) }; } catch {}
      }
      return { html: '<pre class="code">' + mdEsc(body) + '</pre>' };
    }
    const lang = LMAP[kind];
    const g = window.Prism && lang && Prism.languages[lang];
    let code = '';
    if (g && body.length <= 200000) { try { code = Prism.highlight(body, g, lang); } catch {} }
    return { html: '<pre class="code language-' + lang + '">' + (code || mdEsc(body)) + '</pre>' };
  }
  async function exportPdf(name, kind, body) {
    if (!PDF_KINDS.includes(kind)) { st('no PDF for a ' + kind + ' page', false); return; }
    stWork('preparing PDF…');
    try {
      const r = await pdfBody(kind, body);
      const P = await pdfReady();
      const out = await P.save(Object.assign(r, { title: String(name).split('/').pop() || 'page' }));
      st(out.path ? 'saved ' + out.path : out.cancelled ? 'PDF not saved' : 'PDF ready to print');
    } catch (e) {
      st('PDF: ' + String(e && e.message ? e.message : e).slice(0, 160), false);
    }
  }
  function exportOpenPdf() {
    if (!current || grubPath || curFolder !== null) return;
    writerSync();
    exportPdf(current, mode === 'know' ? 'md' : (pkind.value || 'md'), src.value);
  }
  async function exportPagePdf(name) {
    if (name === current && mode !== 'know' && !grubPath) { exportOpenPdf(); return; }
    stWork('preparing PDF…');
    let d = null;
    try {
      const r = await fetch(api + '/page-source?name=' + encodeURIComponent(name));
      d = r.ok ? await r.json() : null;
    } catch {}
    if (!d || typeof d.body !== 'string') { st('could not read ' + name, false); return; }
    exportPdf(name, d.kind || 'md', d.body);
  }

// ── src/79-search.js ──────────────────────────────────────────────────────
  customElements.define('lat-search', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="tree qpane" id="qpane" role="search" aria-label="Search">
  <input id="qinput" type="search" placeholder="search your pages and notes" aria-label="Search your pages and notes" autocomplete="off" spellcheck="false">
  <div class="muted" id="qsum"></div>
  <div id="qlist" class="aclempty">type at least two characters</div>
</div>`;
    }
  });

  let qScopes = null;          // path -> 'private' | 'urbit' | 'clearweb'
  let qKnow = [];              // [{key, body}]
  let qKnowFailed = false;     // /know-all never answered this visit
  let qLoading = null;         // in-flight load, shared
  let qAt = '';                // both beacons when both last loaded (bothAt)
  let qCtxAttempts = 0;
  let qResults = [];
  let qRows = [];
  let qSel = -1;
  function qLoadContext() {
    if (qLoading) return qLoading;
    qLoading = qLoadContextOnce().finally(() => { qLoading = null; });
    return qLoading;
  }
  async function qLoadContextOnce() {
    qCtxAttempts += 1;
    const at = bothAt();
    if (treeShares) {
      const m = new Map();
      for (const n of nodes) {
        if (n.page) m.set(n.path, n.share === 'clearweb' ? 'clearweb' : n.share === 'shared' ? 'urbit' : 'private');
      }
      qScopes = m;
    } else try {
      const r = await fetch(api + '/page-scopes');
      if (r.ok) {
        const m = new Map();
        for (const it of ((await r.json()).items || [])) m.set(it.path, it.scope);
        qScopes = m;
      }
    } catch {}
    try {
      const r = await fetch(api + '/know-all');
      if (r.ok) { qKnow = (await r.json()).items || []; qKnowFailed = false; }
      else qKnowFailed = true;
    } catch { qKnowFailed = true; }
    qAt = qScopes && !qKnowFailed ? at : '';
  }

  const qCount = (hay, needle) => needle ? hay.split(needle).length - 1 : 0;
  const qSnip = (body, at, len) => {
    const from = Math.max(0, at - 40);
    const to = Math.min(body.length, at + len + 40);
    return (from ? '…' : '') + body.slice(from, to).replace(/\s+/g, ' ') + (to < body.length ? '…' : '');
  };

  const qTx = new Map();
  const searchText = (k, b, p) => {
    if (k !== 'fodt') return b;
    let m = qTx.get(p);
    if (!m || m[0] !== b) qTx.set(p, m = [b, window.LatWriter ? LatWriter.extract.text(b) : (b.split('<office:body>')[1] || '')
      .replace(/<\/text:[ph]>|<text:(s|tab|line-break)\b[^>]*>/g, ' ').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&')]);
    return m[1];
  };
  const qHit = (key, body, q, scope, know) => {
    const hay = body.toLowerCase();
    const at = hay.indexOf(q);
    const inPath = key.toLowerCase().includes(q);
    if (at < 0 && !inPath) return null;
    return {
      key, scope, inPath, know,
      hits: at < 0 ? 0 : qCount(hay, q),
      snip: at < 0 ? '' : qSnip(body, at, q.length),
    };
  };

  function qScan(q) {
    const out = [];
    let skipped = 0;
    for (const n of nodes) {
      if (!n.page) continue;
      if (typeof n.body !== 'string') { skipped += 1; continue; }
      const h = qHit(n.path, searchText(n.kind, n.body, n.path), q, (qScopes && qScopes.get(n.path)) || 'unknown', false);
      if (h) out.push(h);
    }
    for (const k of qKnow) {
      const h = qHit(String(k.key || '').replace(/^\/+/, ''),
        String(k.body || ''), q, 'knowledge', true);
      if (h) out.push(h);
    }
    out.sort((a, b) => (b.inPath - a.inPath) || (b.hits - a.hits) || a.key.localeCompare(b.key));
    return { out, skipped };
  }

  const qOpenResult = (h, ev) => openIn(h.know ? 'know' : 'page', h.key, { ev });

  function qHighlight() {
    qRows.forEach((a, i) => { a.style.background = i === qSel ? 'var(--surface)' : ''; });
  }

  function qPaint(host, sum, out, skipped) {
    const parts = [];
    if (out.length) parts.push(out.length + ' result' + (out.length === 1 ? '' : 's'));
    if (skipped) parts.push(skipped + ' large page(s) not scanned');
    if (qKnowFailed) parts.push('memories not searched');
    sum.textContent = parts.join(' · ');
    host.textContent = '';
    qSel = -1;
    qRows = [];
    if (!out.length) {
      qResults = [];
      host.className = 'aclempty';
      host.textContent = nodes.some((n) => n.page) ? 'nothing matches that' : 'pages still loading…';
      return;
    }
    host.className = '';
    qResults = out.slice(0, 100);
    const ul = document.createElement('ul');
    ul.className = 'qlist';
    for (const h of qResults) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      const b = document.createElement('span');
      b.className = 'qbadge ' + h.scope;
      b.textContent = h.scope;
      const n = document.createElement('span');
      n.className = 'qname';
      n.textContent = h.key;                 // textContent: names are content
      a.appendChild(b);
      a.appendChild(n);
      if (h.snip) {
        const s = document.createElement('span');
        s.className = 'qprev muted';
        s.textContent = h.snip;              // and so are bodies
        a.appendChild(s);
      }
      a.onclick = (e) => { e.preventDefault(); qOpenResult(h, e); };
      a.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); qOpenResult(h, e); } };
      qRows.push(a);
      li.appendChild(a);
      ul.appendChild(li);
    }
    host.appendChild(ul);
  }

  let qSeq = 0;
  async function runSearch(raw) {
    const host = $('qlist');
    const sum = $('qsum');
    const q = String(raw || '').trim().toLowerCase();
    if (q.length < 2) {
      host.className = 'aclempty';
      host.textContent = 'type at least two characters';
      sum.textContent = '';
      return;
    }
    const mine = ++qSeq;
    if (!qScopes && qCtxAttempts < 2) {
      host.className = 'aclempty';
      host.textContent = 'searching\u2026';
      const end = busy(null, $('lpane'));
      try { await qLoadContext(); } finally { end(); }
      if (mine !== qSeq) return;
    }
    const { out, skipped } = qScan(q);
    qPaint(host, sum, out, skipped);
  }

  const qPrime = () => {
    if (streamLive && qAt && qAt === bothAt()) return;
    qScopes = null;                          // refresh exposure
    qCtxAttempts = 0;                        // this visit gets its own retry
    qLoadContext();
  };
  document.addEventListener('lat-pane', (e) => {
    if (e.detail.side === 'l' && e.detail.id === 'search') qPrime();
  });
  const qOpen = () => {
    paneOpen('l', true);
    paneTab('l', 'search');
    const i = $('qinput');
    i.focus();
    i.select();
  };

  let qTimer = null;
  $('qinput').oninput = () => {
    clearTimeout(qTimer);
    const v = $('qinput').value;
    qTimer = setTimeout(() => runSearch(v), 80);
  };
  $('qinput').onkeydown = (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && qResults.length) {
      e.preventDefault();
      qSel = e.key === 'ArrowDown'
        ? (qSel + 1) % qResults.length
        : (qSel - 1 + qResults.length) % qResults.length;
      qHighlight();
      qRows[qSel].scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      clearTimeout(qTimer);
      if (qSel >= 0 && qResults[qSel]) { e.preventDefault(); qOpenResult(qResults[qSel], e); return; }
      runSearch($('qinput').value);
    }
  };

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      e.stopPropagation();
      qOpen();
    }
  }, true);

// ── src/80-conflicts.js ───────────────────────────────────────────────────
  customElements.define('lat-conflicts', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="cfwrap" hidden role="region" aria-label="sync conflicts">
  <div class="aclbar">
    <h2>Conflicts</h2>
    <span class="muted" id="cfsum"></span>
    <span class="grow"></span>
  </div>
  <div class="aclbody">
    <p class="aclnote">Each of these is a version that lost a sync race: your
    save went through, and the version it replaced was kept here so nothing was
    destroyed. Open one to read it next to the live page, then remove it when
    you have what you need. Removing is just deleting that conflicts/ page.</p>
    <div id="cflist"></div>
  </div>
</div>`;
    }
  });

  const cfOriginal = (path) => {
    const m = path.match(/^conflicts\/(.+)-rev\d+$/);
    return m ? m[1].replace(/-/g, '/') : null;
  };
  const cfList = () => {
    const out = [];
    for (const n of nodes)
      if (n.page && n.path.startsWith('conflicts/')) out.push(n.path);
    return out.sort();
  };

  function renderConfBadge() {
    const b = $('rb-conflicts');
    if (!b) return;
    const n = cfList().length;
    b.hidden = n === 0;
    if (n) b.dataset.n = n > 99 ? '99+' : String(n);
    else delete b.dataset.n;
  }

  function renderConflicts() {
    const host = $('cflist');
    const sum = $('cfsum');
    if (!host) return;
    host.textContent = '';
    const list = cfList();
    sum.textContent = list.length ? list.length + ' to resolve' : '';
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'aclempty';
      e.textContent = 'No unresolved conflicts.';
      host.appendChild(e);
      return;
    }
    for (const path of list) {
      const card = document.createElement('div');
      card.className = 'aclcard';
      const head = document.createElement('header');

      const nm = document.createElement('b');
      nm.textContent = path;                       // textContent: names are content
      head.appendChild(nm);

      const orig = cfOriginal(path);
      if (orig && hasNode(orig)) {
        const live = document.createElement('a');
        live.textContent = 'open live (' + orig + ')';
        live.title = 'open the page this conflicted with';
        live.style.cursor = 'pointer';
        live.onclick = (e) => openIn('page', orig, { ev: e });
        head.appendChild(live);
      }

      const view = document.createElement('button');
      view.textContent = 'read it';
      view.onclick = (e) => openIn('page', path, { ev: e });
      head.appendChild(view);

      const del = document.createElement('button');
      del.textContent = 'resolve (delete)';
      del.className = 'acl-del';
      del.onclick = async () => {
        if (!(await deletePath(path, false, 'Read it first if you need its text.'))) return;
        renderConflicts();
        renderConfBadge();
      };
      head.appendChild(del);
      card.appendChild(head);
      host.appendChild(card);
    }
  }

// ── src/85-layout.js ──────────────────────────────────────────────────────
  const ws = $('ws');
  if (!('appWrap' in localStorage)) localStorage.appWrap = '1';
  const applyToggles = () => {
    paintPanes();   // the side panes and their corner toggles (13-frame.js)
    ws.classList.toggle('wrap', localStorage.appWrap === '1');
    applyRead();
    if (window.latVimSetInd) window.latVimSetInd();
  };
  const flip = (k) => { localStorage[k] = localStorage[k] === '1' ? '0' : '1'; applyToggles(); };
  try { applyToggles(); } catch (e) { console.error('[lattice] layout init failed', e); }
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === 'appWrap') try { applyToggles(); } catch {}
  });

  try { localStorage.removeItem('appMv'); localStorage.removeItem('appFull'); } catch {}

  {
    let panes = {};
    try { panes = JSON.parse(localStorage.appPanes || '{}'); } catch {}
    const applyPanes = () => {
      ws.style.setProperty('--wtree', panes.tree ? panes.tree + 'px' : '');
      ws.style.setProperty('--wctl', panes.ctl ? panes.ctl + 'px' : '');
    };
    applyPanes();
    const lim = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const wire = (id, key, drag) => {
      const h = $(id);
      let lastTap = 0;
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        h.classList.add('drag');
        const x0 = e.clientX;
        let moved = false;
        const move = (ev) => {
          if (!moved && Math.abs(ev.clientX - x0) <= 3) return;   // tap jitter
          moved = true;
          drag(ev.clientX);
          applyPanes();
        };
        const up = () => {
          h.removeEventListener('pointermove', move);
          h.classList.remove('drag');
          if (!moved && Date.now() - lastTap < 450) { delete panes[key]; applyPanes(); }
          lastTap = moved ? 0 : Date.now();
          try { localStorage.appPanes = JSON.stringify(panes); } catch {}
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up, { once: true });
      });
    };
    wire('ph1', 'tree', (x) => {
      panes.tree = Math.round(lim(x - $('ribbon').getBoundingClientRect().right, 130, 480));
    });
    wire('ph3', 'ctl', (x) => { panes.ctl = Math.round(lim(innerWidth - x, 190, 520)); });
  }

  {
    const q = location.search.match(/[?&]diag=([01])/);
    try { if (q) localStorage.latDiag = q[1]; } catch {}
    let diag = false;
    try { diag = localStorage.latDiag === '1'; } catch {}
    if (diag) {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99;'
        + 'font:11px/1.3 ui-monospace,monospace;background:#000d;color:#0f0;'
        + 'padding:4px 6px;pointer-events:none;white-space:pre-wrap';
      document.body.append(d);
      const name = (el) => el === document.scrollingElement ? 'ROOT'
        : el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
          + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '');
      const scrollers = () => [document.scrollingElement, ...[...document.querySelectorAll('*')]
        .filter((el) => el.offsetParent !== null && /(auto|scroll)/.test(getComputedStyle(el).overflowY))];
      let before = [];
      const show = (moved) => {
        const can = scrollers().filter((el) => el.scrollHeight > el.clientHeight)
          .map((el) => `${name(el)} ${el.scrollTop.toFixed(2)}/${el.scrollHeight - el.clientHeight}`
            + ` h=${el.getBoundingClientRect().height.toFixed(2)}`);
        d.textContent = `last swipe moved: ${moved}\nscrollers (at/max): ${can.join(', ') || 'none'}`
          + `\ninner=${innerHeight} vv=${window.visualViewport ? visualViewport.height.toFixed(1) : '-'}`
          + ` ${navigator.userAgent.replace(/^.*Chrome\//, 'Chrome/').split(' ')[0]}`;
      };
      addEventListener('touchstart', () => { before = scrollers().map((el) => [el, el.scrollTop]); },
        { passive: true, capture: true });
      addEventListener('touchend', () => setTimeout(() => {
        const moved = before.filter(([el, t]) => el.scrollTop !== t)
          .map(([el, t]) => `${name(el)} ${(el.scrollTop - t).toFixed(2)}`);
        show(moved.join(', ') || 'nothing');
      }, 800), { passive: true, capture: true });
      show('(no swipe yet)');
    }
  }

// ── src/90-sync.js ────────────────────────────────────────────────────────
  async function refreshOpen() {
    if (!current || curFolder || dirty || document.hidden || viewingRev !== null) return;
    const wasCurrent = current, wasMode = mode;
    if (await offGet(mode === 'know' ? 'know:' + current : current)) return;
    const url = mode === 'know'
      ? api + '/know-read?key=' + encodeURIComponent(current)
      : api + '/page-source?name=' + encodeURIComponent(current);
    let d = null;
    let notFound = false;
    try {
      const r = await fetch(url);
      if (r.status === 404) notFound = true;
      else if (!r.ok) return;
      else d = await r.json();
    } catch { return; }
    if (dirty || current !== wasCurrent || mode !== wasMode) return;
    if (curFolder || viewingRev !== null) return;
    if (notFound) {
      if (mode !== 'know') {
        const doomed = current;
        current = null;
        pname.readOnly = false;
        dropTreeNodes(doomed);
        pageCache.delete(doomed);
        snapTree();
        renderTree();
        resetPanels();
        st('this page was deleted elsewhere — save to recreate it', false);
      }
      return;
    }
    if (d.link && linkStale.has(wasCurrent)) { openPage(wasCurrent); return; }
    if (mode !== 'know' && d.kind && d.kind !== curKind) { openPage(wasCurrent); return; }
    if (mode !== 'know' && d.rev) curRev = d.rev;
    if (d.body === src.value) return;
    if (mode !== 'know') pageCache.delete(wasCurrent);
    const top = src.scrollTop;
    src.value = d.body;
    render();
    src.scrollTop = top;
    sync();
    if (mode === 'know') {
      renderKnowTags(d.tags || []);
      st('memory updated from ship');
    } else {
      snapPage(current, d);
      showShare(d.share || 'private');
      if (typeof d.comments === 'boolean') cmtShow(current, d.comments);
      refreshPreview();
      st('updated from ship \u00b7 rev ' + d.rev);
    }
  }
  const openMoved = () => {
    if (!current || curFolder) return false;
    const n = nodes.find((x) => x.page && x.path === current);
    return !n || !!n.link || typeof n.rev !== 'number' || n.rev !== curRev ||
      (!!n.kind && n.kind !== curKind);
  };
  const refreshAll = () => {
    if (document.hidden) return;
    if (degraded || offCount) { replayQueue(); return; }
    sensKnown.clear();
    const tree = (mode !== 'know' || !revFresh(treeAt)) ? loadTree() : null;
    if (mode === 'know' || (knowLive() && !knowFresh(knowAt))) loadKnow();
    if (mode === 'know' || !tree) refreshOpen();
    else tree.then((ok) => { if (!ok || openMoved()) refreshOpen(); });
    refreshCommentBadge();
  };
  let streamLive = false;
  let lastShares = '';
  let lastFolds = '';
  let beaconTimer = null;
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const sharesRevs = new Set();
  let lastNotify = '';
  let liveRevs = [];
  const revBumped = (data) => {
    liveRevs.push(digits(data));
    clearTimeout(beaconTimer);
    beaconTimer = setTimeout(() => {
      const all = liveRevs.length && liveRevs.every((r) => r && sharesRevs.has(r));
      liveRevs = [];
      sharesRevs.clear();
      if (!all) refreshAll();
    }, 300);
  };
  const bumped = () => revBumped('');
  const knowBumped = () => { if (knowLive()) bumped(); };
  let cmBeaconTimer = null;
  const commentBumped = () => {
    clearTimeout(cmBeaconTimer);
    cmBeaconTimer = setTimeout(() => {
      refreshCommentBadge();
    }, 300);
  };
  let lastRev = '';
  try { lastRev = localStorage.latBeaconRev || ''; } catch {}
  const noteRev = (rev) => {
    if (!rev) return;
    lastRev = rev;
    try { localStorage.latBeaconRev = rev; } catch {}
  };
  const revFresh = (at) => streamLive && !!at && at === lastRev;
  let lastKnow = '';
  try { lastKnow = localStorage.latBeaconKnow || ''; } catch {}
  const noteKnow = (rev) => {
    if (!rev) return;
    lastKnow = rev;
    try { localStorage.latBeaconKnow = rev; } catch {}
  };
  const knowFresh = (at) => streamLive && !!at && at === lastKnow;
  const bothAt = () => lastRev + '|' + lastKnow;
  let dropStream = null;
  let fail = 0;
  const streamFail = (fail, registered, livedMs, bumpedLive) =>
    (registered && (livedMs >= 60000 || bumpedLive)) ? 0 : Math.min(fail + 1, 5);
  (async () => {
    await null;
    for (;;) {
      if (document.hidden) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      let registered = false, registeredAt = 0, bumpedLive = false;
      try {
        const ac = new AbortController();
        dropStream = () => ac.abort();
        const resp = await fetch('/grubbery/api/keep' + await latBase() + '/beacon/rev',
          { headers: { Accept: 'text/event-stream' }, signal: ac.signal });
        if (!resp.ok) forgetBase();
        const rd = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const evs = buf.split('\n\n');
          buf = evs.pop();
          for (const ev of evs) {
            let name = '', data = '';
            for (const ln of ev.split('\n')) {
              if (ln.startsWith('event: ')) name = ln.slice(7).trim();
              else if (ln.startsWith('data: ')) data = ln.slice(6).trim();
            }
            if (!name) continue;
            if (name.slice(-6) === ' /know') {
              if (name.slice(0, 3) === 'old') {
                echoes.know.n = 0;
                if (lastKnow && data && data !== lastKnow && knowLive()) bumped();
                noteKnow(data);
                continue;
              }
              noteKnow(data);
              if (echoSeen(echoes.know, knowBumped)) continue;
              knowBumped();
              continue;
            }
            if (name.slice(-8) === ' /shares') {
              if (data === lastShares) continue;
              const was = lastShares;
              lastShares = data;
              const sr = /"rev"\s*:\s*"?(\d+)/.exec(data);
              if (sr) sharesRevs.add(sr[1]);
              if (name.slice(0, 3) !== 'old') sharesBumped(data);
              else if (was) loadShared();
              continue;
            }
            if (name.slice(-8) === ' /notify') {
              if (data === lastNotify) continue;
              const was = lastNotify;
              lastNotify = data;
              const nr = /"rev"\s*:\s*"?(\d+)/.exec(data);
              if (nr) sharesRevs.add(nr[1]);
              if (name.slice(0, 3) !== 'old' || was) refreshInboxBadge(true);
              continue;
            }
            if (name.slice(-7) === ' /folds') {
              if (data === lastFolds) continue;
              const was = lastFolds;
              lastFolds = data;
              const fr = /"rev"\s*:\s*"?(\d+)/.exec(data);
              if (fr) sharesRevs.add(fr[1]);
              if (name.slice(0, 3) !== 'old') foldsBumped(data);
              else if (was) loadFolds();
              continue;
            }
            if (name.slice(-5) !== ' /rev') {
              if (name.slice(-10) === ' /comments' && name.slice(0, 3) !== 'old') commentBumped();
              continue;
            }
            if (name.slice(0, 3) === 'old') {
              echoes.rev.n = 0;
              streamLive = true;
              registered = true;
              registeredAt = Date.now();
              if (lastRev && data && data !== lastRev) bumped();
              noteRev(data);
              continue;
            }
            bumpedLive = true;
            noteRev(data);
            if (echoSeen(echoes.rev, bumped)) continue;
            revBumped(data);
          }
        }
      } catch {}
      streamLive = false;
      fail = streamFail(fail, registered, registered ? Date.now() - registeredAt : 0, bumpedLive);
      const base = Math.min(3000 * (1 << Math.max(0, fail - 1)), 30000);
      const wait = Math.min(Math.round(base * (0.5 + Math.random())), 30000);
      await new Promise((r) => setTimeout(r, wait));
    }
  })();
  let focusAt = 0;
  const refocused = () => {
    const wroteLately = Date.now() - Math.max(echoes.rev.at, echoes.know.at) < 30000;
    if (streamLive && !wroteLately && Date.now() - focusAt < 30000) return;
    focusAt = Date.now();
    bumped();
  };
  window.addEventListener('focus', refocused);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (dropStream) dropStream(); return; }
    refocused();
  });
  setInterval(() => { if (!streamLive && !document.hidden) refreshOpen(); }, 30000);

// ── src/95-know.js ────────────────────────────────────────────────────────
  customElements.define('lat-know', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<aside class="tree" id="knowpane">
  <div class="ptool" role="toolbar" aria-label="Knowledge">
    ${sbtn('id="knew" data-action="knew"', 'plus', 'New memory')}
    ${sbtn('id="ktidy" data-action="ktidy"', 'tidy', 'Tidy memories')}
    ${sbtn('id="kskills" data-action="kskills"', 'skill', 'Skills')}
    ${sbtn('id="ktrash" data-action="ktrash" aria-pressed="false"', 'trash', 'Trash')}
  </div>
  <div id="ktrashlist" class="ktrash" hidden></div>
  <!-- the tag chips outgrew the pane top (one row per dozen tags), so they
       fold under a heading like history does. Native details: the fold,
       the keyboard and the marker come free. -->
  <details id="tagsec">
    <summary class="sec" id="tagsh">tags</summary>
    <div id="chips" class="chips"></div>
  </details>
  <div class="sec">memories</div>
  <div id="knowlist"><div class="muted kwait">loading memories\u2026</div></div>
</aside>`;
    }
  });
  let knowKeys = [];        // [{key, tags, updated, bytes}] from know-list
  let knowTag = '';         // active tag filter ('' = all)
  let knowHave = false;     // a know-list has landed this session
  const chipsEl = $('chips'), knowMeta = $('knowmeta'), ktagsEl = $('ktags');
  const knowList = $('knowlist');
  treeKeys(knowList, 'Memories');
  const tagSec = $('tagsec'), tagSum = $('tagsh');
  tagSec.open = localStorage.knowTagsOpen === '1';
  tagSec.addEventListener('toggle', () => { localStorage.knowTagsOpen = tagSec.open ? '1' : '0'; });

  let knowAt = '';
  async function loadKnow() {
    const gen = knowGen;
    const at = lastKnow;
    let d = null;
    try {
      const r = await fetch(api + '/know-list');
      if (!r.ok) { st('know-list failed' + await errText(r), false); return; }
      d = await r.json();
    } catch { st('know-list failed (network)', false); return; }
    if (gen !== knowGen) return;   // a local patch superseded this response
    knowKeys = d.keys;
    knowAt = at;
    knowHave = true;
    renderKnowChips();
    renderKnowTree();
  }

  function renderKnowChips() {
    const tags = [...new Set(knowKeys.flatMap((k) => k.tags))].sort();
    chipsEl.textContent = '';
    const mk = (label, val) => {
      const a = document.createElement('a');
      a.textContent = label;
      a.className = (knowTag === val) ? 'on' : '';
      a.onclick = () => { knowTag = val; renderKnowChips(); renderKnowTree(); };
      chipsEl.appendChild(a);
    };
    mk('all', '');
    for (const t of tags) mk('#' + t, t);
    tagSum.textContent = 'tags \u00b7 ' + (knowTag ? '#' + knowTag : tags.length);
  }

  const knowColl = collStore('knowColl');

  function renderKnowTree() {
    const shown = knowTag ? knowKeys.filter((k) => k.tags.includes(knowTag)) : knowKeys;
    const keys = shown.map((k) => k.key.replace(/^\//, '')).sort();
    const had = knowList.contains(document.activeElement);
    knowList.textContent = '';
    knowRows = new Map();
    if (!keys.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.style.padding = '4px 8px';
      empty.textContent = knowTag
        ? 'no memories tagged #' + knowTag
        : 'no memories yet. New memory starts one.';
      knowList.appendChild(empty);
      treeRove(knowList, false);      // no rows, so no tree role either
      return;
    }
    const coll = knowColl.get();
    const folded = (path) => coll.some((c) => path !== c && path.startsWith(c + '/'));
    const seen = new Set();
    for (const key of keys) {
      const parts = key.split('/');
      for (let d = 0; d < parts.length - 1; d++) {
        const dir = parts.slice(0, d + 1).join('/');
        if (seen.has(dir)) continue;
        seen.add(dir);
        const row = folderRow(parts[d], d, coll.includes(dir),
          () => { knowColl.flip(dir); renderKnowTree(); }, undefined, 'f:' + dir);
        if (folded(dir)) row.style.display = 'none';
        knowList.appendChild(row);
      }
      const row = document.createElement('a');
      row.className = 'pg' + (mode === 'know' && key === current ? ' cur' : '');
      row.style.marginLeft = ((parts.length - 1) * 14) + 'px';
      if (folded(key)) row.style.display = 'none';
      row.href = '/apps/lattice/app?view=know&key=' + encodeURIComponent(key);
      row.textContent = parts[parts.length - 1];
      tabLink(row, 'know', key);
      treeItem(row, parts.length - 1, 'p:' + key);
      knowRows.set(key, row);
      knowList.appendChild(row);
    }
    treeRove(knowList, had);
  }
  const knowEntry = (key) =>
    knowKeys.find((x) => x.key.replace(/^\//, '') === key);

  async function openKnow(key) {
    if (!(await guardDirty())) return false;
    const my = openNext();
    if (mode !== 'know') setMode('know');
    const q = await offGet('know:' + key);
    let d = null;
    if (q) d = { body: q.body, tags: (knowEntry(key) || { tags: [] }).tags, updated: 'queued offline' };
    else {
      let r = null;
      try { r = await busyFetch(api + '/know-read?key=' + encodeURIComponent(key), undefined, 'open'); } catch {}
      if (my !== openSeq) return;
      if (!r || !r.ok) { st('open failed' + (r ? await errText(r) : ' — offline'), false); return false; }
      d = await r.json();
    }
    if (my !== openSeq) return;
    applyKnow(key, d);
    return true;
  }
  function applyKnow(key, d) {
    setOpen(key, { readOnly: true,
      url: '/apps/lattice/app?view=know&key=' + encodeURIComponent(key) });
    src.value = d.body;
    dirty = false;
    render(); sync();
    paintLocal();                    // the preview pane shows the memory too
    markCurrent();
    renderKnowTags(d.tags || []);
    $('kupd').textContent = 'updated ' + (d.updated || '');
    exitRev();
    resetPanels();
    st('memory · ' + (d.tags || []).map((t) => '#' + t).join(' '));
    drawersClose();
  }

  function renderKnowTags(tags) {
    ktagsEl.textContent = '';
    for (const t of tags.sort()) {
      const a = document.createElement('a');
      a.textContent = '#' + t + ' \u00d7';
      a.onclick = async () => {
        const r = await mutate(api + '/know-untag?key=' + encodeURIComponent(current) +
          '&tag=' + encodeURIComponent(t));
        if (!r.ok) { st('untag failed' + await errText(r), false); return; }
        knowGen++;
        const k = knowEntry(current);
        if (k) k.tags = k.tags.filter((x) => x !== t);
        renderKnowTags(k ? k.tags : []);
        renderKnowChips();
        renderKnowTree();
      };
      ktagsEl.appendChild(a);
    }
  }

  $('ktagadd').onclick = async () => {
    const t = $('ktag').value.trim().toLowerCase();
    if (!t || !current || mode !== 'know') return;
    const r = await mutate(api + '/know-tag?key=' + encodeURIComponent(current) +
      '&tag=' + encodeURIComponent(t));
    if (!r.ok) { st('tag failed' + await errText(r), false); return; }
    $('ktag').value = '';
    knowGen++;
    const k = knowEntry(current);
    if (k && !k.tags.includes(t)) k.tags.push(t);
    renderKnowTags(k ? k.tags : [t]);
    renderKnowChips();
  };

  const knowField = () => pname.value.trim().replace(/^\/+|\/+$/g, '');
  const knowHere = (key) => mode === 'know' && !grubPath &&
    (current === key || (current === null && knowField() === key));
  async function saveKnow(create) {
    const key = knowField();
    if (!key) { st('key required', false); return; }
    if (!validName(key)) {
      st('bad key — lowercase letters, digits, and - . _ ~ (no spaces)', false);
      return;
    }
    if (!src.value && !create) { st('empty body', false); return; }
    if (viewingRev !== null) { st('viewing a revision — use restore', false); return; }
    if (saving) {
      queueSave(() => { if (knowHere(key)) return saveKnow(create); }, create);
      return;
    }
    saving = true;
    const sent = src.value || '\n';
    let w = { gone: true };
    try {
      w = await shipWrite(api + '/know-save?key=' + encodeURIComponent(key),
        { method: 'POST', body: sent }, { save: true });
    } finally { saving = false; }
    const r = w.r;
    const claim = () => {
      if (!knowHere(key)) { tabLanded('know', key, sent); return; }
      current = key;
      tabFollow();             // a new memory's tab is named now (21-tabs.js)
      pname.readOnly = true;
      if (src.value === sent) dirty = false;
    };
    if (w.gone) {
      if (!(await enqueueKnow(key, sent))) { flushPending(); return; }
      claim();
      flushPending();
      return;
    }
    if (!r.ok) { st('save failed' + await errText(r), false); flushPending(); return; }
    claim();
    st('memory saved');
    knowGen++;
    const k = knowEntry(key);
    if (k) k.bytes = sent.length;
    else knowKeys.push({ key, tags: [], updated: '', bytes: sent.length });
    renderKnowChips();
    renderKnowTree();
    flushPending();
  }

  async function deleteKnow() {
    if (!current) return;
    if (!(await askDanger('delete memory ' + current + '? (soft-delete, restorable)', 'delete'))) return;
    const doomed = current;
    const r = await mutate(api + '/know-delete?key=' + encodeURIComponent(doomed));
    if (!r.ok) { st('delete failed' + await errText(r), false); return; }
    exitRev();
    setOpen(null);
    src.value = '';
    render();
    st('memory deleted (restorable via know-restore)');
    knowGen++;
    knowKeys = knowKeys.filter((x) => x.key.replace(/^\//, '') !== doomed);
    renderKnowChips();
    renderKnowTree();
  }

  function setMode(m) {
    mode = m;
    curKind = null;
    exitGrub();                      // Save must stop pointing at an app file
    exitRev();                       // else readOnly leaks into the memory editor
    ws.classList.toggle('know', m === 'know');
    knowMeta.hidden = m !== 'know';
    curFolder = null;
    setCtlLabels();
    setOpen(null, { url: '/apps/lattice/app' + (m === 'know' ? '?view=know' : '') });
    pname.placeholder = m === 'know' ? 'memory key (e.g. user/preferences)' : 'page name (e.g. notes/todo)';
    src.value = '';
    render();
    prevBlank();
    markCurrent();
    if (m === 'know') { if (!knowFresh(knowAt)) loadKnow(); }
    else if (!revFresh(treeAt)) loadTree();
    st(m === 'know' ? 'knowledge' : 'pages');
  }

  const knowShow = () => { if (!knowHave || !knowFresh(knowAt)) loadKnow(); };
  const knowLive = () => mode === 'know' || knowHave;
  document.addEventListener('lat-pane', (e) => {
    if (e.detail.side === 'l' && e.detail.id === 'know') knowShow();
  });
  if (paneShows('l', 'know')) knowShow();

  $('knew').onclick = async (ev) => {
    let seed = '';
    let note = '';
    let key = '';
    for (;;) {
      const picked = await askNameKind(note + 'memory key (e.g. user/preferences)', seed,
        'create', 'md', true);
      if (!picked) return;
      key = picked.name.replace(/\.md$/i, '');
      if (validName(key)) break;
      seed = key;
      note = 'a key is lowercase letters, digits and - . _ ~ (no spaces). ';
    }
    if (!knowEntry(key)) {
      let r = null;
      try { r = await fetch(api + '/know-read?key=' + encodeURIComponent(key)); } catch {}
      if (!r || (!r.ok && r.status !== 404)) {
        st('could not check whether ' + key + ' exists' + (r ? await errText(r) : ' (offline)')
          + ', so nothing was created', false);
        return;
      }
      if (r.ok) {
        await openIn('know', key, { ev });
        st(key + ' already exists, so it is open instead');
        return;
      }
    } else { openIn('know', key, { ev }); return; }
    await openIn('know', '', { ev });
    if (!activeTab || activeTab.kind !== 'know' || activeTab.key || current !== null) return;
    setOpen(null, { shown: key });
    await saveKnow(true);
    src.focus();
  };
  $('ktidy').onclick = () => toolOpen('frame:/apps/lattice/know?lint=1');
  const trashList = $('ktrashlist');
  const kmuted = (t) => {
    const d = document.createElement('div');
    d.className = 'muted';
    d.style.padding = '4px 8px';
    d.textContent = t;
    return d;
  };
  async function loadTrash() {
    trashList.replaceChildren(kmuted('loading trash\u2026'));
    let d = null;
    try {
      const r = await fetch(api + '/know-trash');
      if (r.ok) d = await r.json();
    } catch {}
    if (trashList.hidden) return;
    if (!d) { trashList.replaceChildren(kmuted('the trash did not load')); return; }
    const keys = (d.keys || []).map((k) => String(k.key || '').replace(/^\//, '')).sort();
    const head = document.createElement('div');
    head.className = 'sec';
    head.textContent = 'trash \u00b7 ' + keys.length;
    trashList.replaceChildren(head);
    if (!keys.length) { trashList.append(kmuted('nothing in the trash')); return; }
    for (const key of keys) {
      const row = document.createElement('div');
      row.className = 'ktr';
      row.dataset.key = key;
      const n = document.createElement('span');
      n.className = 'ktn';
      n.textContent = key;           // keys are content: textContent
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'restore';
      b.onclick = async () => {
        b.disabled = true;
        const r = await mutate(api + '/know-restore?key=' + encodeURIComponent(key));
        if (!r.ok) { b.disabled = false; st('restore failed' + await errText(r), false); return; }
        st('restored ' + key);
        loadKnow();
        loadTrash();
      };
      row.append(n, b);
      trashList.append(row);
    }
  }
  $('ktrash').onclick = () => {
    const on = trashList.hidden;
    trashList.hidden = !on;
    $('ktrash').classList.toggle('on', on);
    $('ktrash').setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) loadTrash();
  };
  clickAction('knew', 'New memory', 'Knowledge toolbar');
  clickAction('ktidy', 'Tidy memories', 'Knowledge toolbar');
  clickAction('ktrash', 'Memory trash', 'Knowledge toolbar');

// ── src/95s-skills.js ─────────────────────────────────────────────────────
  const skWrap = document.createElement('div');
  skWrap.className = 'aclwrap';
  skWrap.id = 'skwrap';
  skWrap.hidden = true;
  skWrap.setAttribute('role', 'region');
  skWrap.setAttribute('aria-label', 'skills');
  toolStash.append(skWrap);
  let skLoad = null;
  const skReady = () => (window.LatSkills ? Promise.resolve(window.LatSkills)
    : skLoad || (skLoad = new Promise((ok, no) => {
      const s = document.createElement('script');
      const fail = () => { skLoad = null; s.remove(); no(); };
      s.src = '/apps/lattice/app/skills.js?h=' + SKILLS_H;
      s.onload = () => (window.LatSkills ? ok(window.LatSkills) : fail());
      s.onerror = fail;
      document.head.append(s);
    })));
  TOOLS.skills = { name: 'Skills', icon: 'skill', wrap: 'skwrap',
    load: () => skReady().then((k) => k.show(skWrap, { api, st, ask, askConfirm, askDanger, md: mdToHtml }),
      () => st('skills.js did not load', false)) };
  $('kskills').onclick = () => toolOpen('skills');
  clickAction('kskills', 'Skills', 'Knowledge toolbar');

// ── src/96-deskmenu.js ────────────────────────────────────────────────────
  if (window.__TAURI__ && window.__LATTICE_FILE_MENU__) {
    for (const id of ['newfile', 'newfolder', 'newtmpl', 'upfiles', 'updir', 'save']) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    for (const row of document.querySelectorAll('#tree .newbtns')) {
      if ([...row.children].every((c) => c.hidden)) row.hidden = true;
    }
    for (const a of ACTIONS) {
      if (!['newfile', 'newfolder', 'newtmpl', 'upfiles', 'updir'].includes(a.id)) continue;
      a.home = 'File menu';
      a.when = () => true;
    }
  }

// ── src/97-mobar.js ───────────────────────────────────────────────────────
  {
    const drawn = () => ws.classList.contains('ldraw') || ws.classList.contains('rdraw');
    const scrim = document.createElement('div');
    scrim.id = 'scrim';
    scrim.onclick = drawersClose;
    ws.append(scrim);
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawn()) drawersClose(); });
    matchMedia('(max-width: 820px)').addEventListener('change', drawersClose);

    const EDGE = 24;
    const selecting = () => document.activeElement === src && src.selectionStart !== src.selectionEnd;
    let sw = null;
    addEventListener('touchstart', (e) => {
      sw = null;
      if (!isMobile() || e.touches.length !== 1 || drawn() || selecting()
        || document.querySelector('.dlg:not([hidden])')
        || (e.target.closest && e.target.closest('.dtlist'))) return;
      const { clientX: x, clientY: y } = e.touches[0];
      const side = x <= EDGE ? 'l' : x >= innerWidth - EDGE ? 'r' : null;
      if (side) sw = { side, x, y };
    }, { passive: true });
    addEventListener('touchmove', (e) => {
      if (!sw) return;
      if (selecting()) { sw = null; return; }
      const t = e.touches[0];
      const dx = (t.clientX - sw.x) * (sw.side === 'l' ? 1 : -1);
      const dy = Math.abs(t.clientY - sw.y);
      if (dy > EDGE && dy >= dx) { sw = null; return; }   // a scroll, not a swipe
      if (dx >= EDGE && dx > dy) { const s = sw.side; sw = null; drawer(s, true); }
    }, { passive: true });
    addEventListener('touchend', () => { sw = null; }, { passive: true });

    const sheet = document.createElement('div');
    sheet.id = 'mtsheet';
    sheet.className = 'mtsheet';
    sheet.setAttribute('role', 'menu');
    sheet.setAttribute('aria-label', 'Open tabs');
    sheet.hidden = true;
    const sheetPaint = () => {
      sheet.textContent = '';
      if (groups.length > 1) {
        const gr = document.createElement('div');
        gr.className = 'mtgrp';
        gr.setAttribute('role', 'group');
        gr.setAttribute('aria-label', 'Tab groups');
        leaves().forEach((g, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = g === focusG ? 'on' : '';
          b.setAttribute('aria-pressed', g === focusG ? 'true' : 'false');
          b.dataset.g = g.id;
          b.textContent = 'Group ' + (i + 1) + ' (' + g.tabs.length + ')';
          b.onclick = () => gThen(g, sheetPaint);
          gr.append(b);
        });
        sheet.append(gr);
      }
      for (const t of tabs) {
        const k = TAB_KINDS[t.kind];
        const name = k.label(t);
        const row = document.createElement('div');
        row.className = 'mtrow' + (t === activeTab ? ' on' : '');
        row.dataset.key = t.key;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mtname';
        b.setAttribute('role', 'menuitem');
        b.innerHTML = ico(t.pinned ? 'pin' : typeof k.icon === 'function' ? k.icon(t) : k.icon)
          + '<span></span>';
        b.lastChild.textContent = name;
        b.onclick = () => { sheet.hidden = true; switchTab(t.id); };
        const x = tip(document.createElement('button'), 'Close ' + name);
        x.type = 'button';
        x.className = 'sbtn mtx';
        x.innerHTML = ico('x');
        x.onclick = async () => { await closeTab(t.id); if (!sheet.hidden) sheetPaint(); };
        row.append(b, x);
        sheet.append(row);
      }
    };

    const mbar = document.createElement('nav');
    mbar.id = 'mbar';
    mbar.className = 'mbar';
    mbar.setAttribute('aria-label', 'Bottom bar');
    const mitem = (id, icon, name, run) => {
      const b = tip(document.createElement('button'), name);
      b.type = 'button';
      b.className = 'sbtn';
      b.id = id;
      b.dataset.action = id;
      b.innerHTML = ico(icon);
      b.onclick = (ev) => run(ev);
      action({ id, name, home: 'Bottom bar', run, when: isMobile });
      mbar.append(b);
      return b;
    };
    mitem('mb-new', 'plus', 'New page', async () => { if (await guardDirty()) newFile(''); });
    mitem('mb-search', 'search', 'Search', () => qOpen());
    mitem('mb-brief', 'cal', "Today's brief", (ev) => openBrief(ev));
    const tabsw = mitem('mtabsw', 'tabs', 'Open tabs', () => {
      if (sheet.hidden) sheetPaint();
      sheet.hidden = !sheet.hidden;
    });
    ws.append(mbar, sheet);
    document.addEventListener('click', (e) => {
      if (!sheet.hidden && !sheet.contains(e.target) && !tabsw.contains(e.target)) sheet.hidden = true;
    });
    const count = () => { tabsw.dataset.n = String(tabs.length); };
    count();
    document.addEventListener('lat-tabs', count);

    const mirror = () => {
      const n = $('rb-inbox').dataset.n;
      if (n) $('treet').dataset.n = n; else delete $('treet').dataset.n;
    };
    mirror();
    new MutationObserver(mirror).observe($('rb-inbox'), { attributes: true, attributeFilter: ['data-n'] });
  }

// ── src/98-legacy.js ──────────────────────────────────────────────────────
  async function legacyCheck() {
    if (localStorage.latLegacy === 'done') return;
    let d = null;
    try { d = await (await bgFetch(api + '/legacy-status')).json(); } catch { return; }
    if (!d) return;
    if (d.reason === 'resolved') { localStorage.latLegacy = 'done'; return; }
    if (!d.prompt) return;
    if (sessionStorage.latLegacyAsked === '1') return;
    const choice = await askChoice(
      'An older lattice agent is still installed on this ship, from before ' +
      'this store existed. Import the memories it holds?\n\nAnything already ' +
      'here is left exactly as it is, and nothing is removed from the old agent.',
      ['import them now', 'not now', 'never ask again'], 'ok');
    if (choice === null) return;            // dismissed. Offer again next load
    if (choice === 'not now') {             // explicitly declined, quiet until
      sessionStorage.latLegacyAsked = '1';  // the next browser session
      return;
    }
    if (choice === 'never ask again') {
      await mutate(api + '/legacy-dismiss');
      localStorage.latLegacy = 'done';
      st('legacy import dismissed');
      return;
    }
    stWork('importing from the old agent… this can take a few minutes');
    let r = null;
    try { r = await mutate(api + '/legacy-migrate'); } catch {}
    if (!r || !r.ok) {
      let after = null;
      try { after = await (await fetch(api + '/legacy-status')).json(); } catch {}
      if (after && after.reason === 'resolved') {
        localStorage.latLegacy = 'done';
        knowGen++;
        if (knowLive()) loadKnow();
        st('legacy import completed');
        return;
      }
      const cut = r && shipGone(r);
      let listed = null;
      try { listed = await (await fetch(api + '/know-list')).json(); } catch {}
      const have = listed && listed.keys ? listed.keys.length : null;
      st((cut ? 'the connection timed out mid-import' : 'legacy import failed' + await errText(r)) +
         (have !== null ? ' — ' + have + ' memories are here now' : '') +
         ' · nothing was removed from the old agent · run it again to finish', false);
      if (cut) {
        await askConfirm(
          'The request was cut off before it finished — the ship kept working, ' +
          'so some of it landed' + (have !== null ? ' (' + have + ' memories now here)' : '') +
          '.\n\nNothing was lost and nothing was removed from the old agent. ' +
          'Run the import again to finish; anything already here is skipped, ' +
          'so it cannot duplicate.\n\nIf this keeps happening, the reverse ' +
          'proxy in front of this ship is closing long requests — raise ' +
          'proxy_read_timeout for it (nginx defaults to 60s).',
          'got it');
        delete sessionStorage.latLegacyAsked;   // let it offer again immediately
      }
      return;
    }
    const res = await r.json();
    if (res.complete) localStorage.latLegacy = 'done';
    else delete sessionStorage.latLegacyAsked;
    knowGen++;
    st('imported ' + res.imported + ' memories from the old agent');
    if (knowLive()) loadKnow();
    loadTree();
    const kept = res.imported + ' ' + (res.imported === 1 ? 'memory' : 'memories') +
      (res.skipped ? ' (' + res.skipped + ' already here, left untouched)' : '');
    const got = res.pagesImported || 0;
    let msg = 'Imported ' + kept + (got ? ', and ' + got + ' ' + (got === 1 ? 'page' : 'pages') : '') + '.';
    if (!res.complete) {
      const left = [];
      if (!res.pagesKnown) left.push('its page list could not be read');
      else if ((res.pages || 0) > got + (res.pagesCollided || 0))
        left.push(((res.pages || 0) - got - (res.pagesCollided || 0)) + ' page(s) did not arrive in time');
      if (res.pagesCollided) left.push(res.pagesCollided + ' page(s) share a name with pages you already have, so they were left alone');
      msg += '\n\nNot everything moved: ' + left.join('; ') + '.' +
        '\n\nThe old agent still holds the only copy — do NOT run ' +
        '|uninstall %lattice. Reopen the editor to retry; you will be asked again.';
    } else {
      msg += '\n\nEverything it held is now here. Once you have checked your ' +
        'pages and memories, you can retire it from the dojo:\n\n    |uninstall %lattice';
    }
    await askConfirm(msg, 'got it');
    loadTree();
  }

// ── src/99-boot.js ────────────────────────────────────────────────────────
  function bootSnap(name, fresh) {
    let p = null;
    try { p = JSON.parse(localStorage.appPage || 'null'); } catch {}
    if (!p || !p.name) return false;
    if (name ? p.name !== name : !fresh) return false;
    applyPage(p.name, p);
    setFolderCtx(p.name);
    return true;
  }
  async function bootTree() {
    let t = await kvGet('tree');
    if (!t || !t.length) {
      try { t = JSON.parse(localStorage.appTree || 'null'); } catch {}
      if (t && t.length) kvPut('tree', t);
    }
    try { localStorage.removeItem('appTree'); } catch {}
    if (!t || !t.length || nodes.length) return;
    nodes = t;
    renderTree();
    markCurrent();
  }
  const loadPanels = () => {
    loadPerms(true); loadShared(true);
    loadFolds(true).then(() => checkFolds());
  };
  let sideOn = false;
  function sideScripts() {
    if (sideOn) return;
    sideOn = true;
    if (window.__latSwReg) window.__latSwReg();
    const ready = { '/apps/lattice/app/vault.js': vaultHook, '/apps/lattice/app/orrery.js': orreryShow };
    for (const u of ['/apps/lattice/app/theme.js', '/apps/lattice/prism.js',
      '/apps/lattice/app/vault.js', '/apps/lattice/app/orrery.js']) {
      const s = document.createElement('script');
      s.src = u;
      s.async = false;
      if (ready[u]) s.onload = () => ready[u]();
      document.head.append(s);
    }
  }
  queueMicrotask(() => {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) sideScripts();
    else setTimeout(sideScripts, 8000);
    adoptIdbQueue().then(() => {
      setTimeout(() => { if (offCount) replayQueue(); }, 4000);
    });
    setTimeout(() => { refreshCommentBadge(); }, 20000);
    const { tab: bootTab, fresh: bootFresh } = tabsBoot();
    window.latUrbArrived();
    const setTab = qs.get('settings');
    if (setTab) {
      const u = new URL(location.href);
      u.searchParams.delete('settings');
      history.replaceState(history.state, '', u);
      latOpenSettings(setTab);
    }
    if (bootTab.kind !== 'page') {
      loadTree().then(() => { legacyCheck(); sideScripts(); loadPanels(); });
      tabShowBoot(bootTab);
    } else {
      const into = qs.get('into');
      const name = into && !qs.get('name') ? null : bootTab.key || null;
      const painted = bootSnap(name, bootFresh && !into);
      bootTree();
      const bootCurrent = current;
      const bootShown = pname.value;
      loadTree().then(() => {
        const touched = current !== bootCurrent || curFolder !== null || dirty || everTyped
          || activeTab !== bootTab || pname.value !== bootShown;
        if (touched) {
          legacyCheck();
          sideScripts();
          loadPanels();
          return;
        }
        if (name) {
          if (painted && current === name) refreshOpen();
          else openPage(name);
        }
        else if (into && nodes.some((n) => !n.page && n.path === into)) selectFolder(into);
        else if (into) newFile(into, false);
        else if (current) refreshOpen();
        else newFile('', false);
        legacyCheck();
        sideScripts();
        loadPanels();
      });
    }
  });
})();
