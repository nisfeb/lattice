  // ── offline edits: queue, detection, replay (docs/offline-edits.md) ──────
  // Saves only: pages and know memories. The queue lives in IndexedDB, one per
  // page, coalesced. Re-editing a queued page replaces its record, the same
  // way autosave coalesces savePending. localStorage is synchronous and ~5MB,
  // which is why the tree snapshot moved here too (phase 3).
  //
  // Detection is from RESPONSES, never navigator.onLine. The desktop webview
  // talks to a localhost bridge that always answers and returns 502 when the
  // ship is unreachable, and onLine lies about captive portals on mobile.
  //
  // THE QUEUE IS THE TOP READ TIER. Without that, cache-first opens painted
  // the pre-edit body over a queued edit. The edit looked lost, and the next
  // autosave would queue the OLD body back (review gap 1 in the design doc).
  let degraded = false;      // a save failed like the ship was unreachable
  let offCount = 0;          // queued page edits, drives the status text
  let offDb = null;
  const offOpen = () => new Promise((res) => {
    if (offDb) return res(offDb);
    let rq = null;
    try { rq = indexedDB.open('lattice-offline', 2); } catch { return res(null); }
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains('saves'))
        d.createObjectStore('saves', { keyPath: 'name' });
      // kv: the tree snapshot (phase 3). It lived in localStorage, which is
      // ~5MB, synchronous, and was re-STRINGIFIED whole on every save. IDB
      // stores the structured clone directly and scales to the disk.
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
  const offStore = async (mode) => {
    const d = await offOpen();
    try { return d && d.transaction('saves', mode).objectStore('saves'); } catch { return null; }
  };
  const offGet = async (name) => {
    const s = await offStore('readonly'); return s ? offReq(s.get(name)) : null;
  };
  const offAll = async () => {
    const s = await offStore('readonly'); return (s && await offReq(s.getAll())) || [];
  };
  const offRecount = async () => { offCount = (await offAll()).length; };
  const offPut = async (rec) => {
    const s = await offStore('readwrite'); if (s) await offReq(s.put(rec));
    await offRecount();
  };
  const offDel = async (name) => {
    const s = await offStore('readwrite'); if (s) await offReq(s.delete(name));
    await offRecount();
  };
  offRecount();
  const kvStore = async (mode) => {
    const d = await offOpen();
    try { return d && d.transaction('kv', mode).objectStore('kv'); } catch { return null; }
  };
  const kvGet = async (k) => {
    const st = await kvStore('readonly');
    const r = st && await offReq(st.get(k));
    return r ? r.v : null;
  };
  // fire-and-forget by design: persistTree's callers are synchronous save
  // paths, and a snapshot write that loses a race with app close costs one
  // boot's paint, not data. The ship copy is the durable one.
  const kvPut = async (k, v) => {
    const st = await kvStore('readwrite');
    if (st) await offReq(st.put({ k, v }));
  };

  // fetch with a REAL deadline. "Detect offline by timeout" was in the design
  // from day one, but nothing implemented a timeout. No AbortController
  // anywhere, no ureq timeout in the bridge. So against a dead remote ship
  // "degraded" was the OS TCP timeout, minutes away (review gap 2).
  const tfetch = (url, opts = {}, ms = 10000) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
  };
  // the bridge answers 502 when the ship is unreachable. A proxy in front of
  // eyre may say 504. Anything else means the ship SPOKE. That is a real
  // error, not an outage, and must never be queued over.
  const shipGone = (r) => !r || r.status === 502 || r.status === 504;

  let probeTimer = null;
  function setDegraded(on) {
    if (degraded === on) return;
    degraded = on;
    if (on) st('ship unreachable — edits are queued locally', false);
    if (on && !probeTimer) {
      probeTimer = setInterval(async () => {
        let r = null;
        try { r = await tfetch(api + '/legacy-status', {}, 5000); } catch {}
        if (r && r.ok) {
          clearInterval(probeTimer); probeTimer = null;
          degraded = false;
          replayQueue();
        }
      }, 20000);
    }
    if (!on && probeTimer) { clearInterval(probeTimer); probeTimer = null; }
  }

  // queue one page's edit and make it the visible truth everywhere a read
  // could come from: the render cache, the tree dump body, the boot snapshot.
  async function enqueueSave(name, kind, body) {
    await offPut({ name, kind, body, baseRev: curRev || 0, queuedAt: Date.now() });
    pageCache.delete(name);
    const nd = nodes.find((n) => n.page && n.path === name);
    if (nd) { nd.body = body; nd.kind = kind; persistTree(); }
    snapPage(name, { body, kind, rev: curRev || 0 });
    setDegraded(true);
    st('saved offline — ' + offCount + ' waiting to sync');
  }
  // know memories share the queue under a 'know:' prefix. Page names cannot
  // contain a colon, so the two namespaces cannot collide in the one store.
  // No baseRev: memories are last-write-wins (no CAS, no conflicts/ pages),
  // matching what know-save itself does.
  async function enqueueKnow(key, body) {
    await offPut({ name: 'know:' + key, kind: 'know', body, queuedAt: Date.now() });
    knowGen++;
    const k = knowEntry(key);
    if (k) k.bytes = body.length;
    else knowKeys.push({ key, tags: [], updated: '', bytes: body.length });
    renderKnowChips();
    renderKnowTree();
    setDegraded(true);
    st('saved offline — ' + offCount + ' waiting to sync');
  }

  // Drain through page-save-batch. The batch is all-or-nothing, right for
  // uploads, wrong for replay. One poisoned record would block the queue
  // forever. A rejected batch falls back to per-item saves so the bad record
  // is isolated and DROPPED (it can never apply; review gap 3).
  let replaying = false;
  async function replayQueue() {
    if (replaying) return;
    const whole = await offAll();
    if (!whole.length) return;
    const all = whole.filter((q) => q.kind !== 'know');
    const knows = whole.filter((q) => q.kind === 'know');
    replaying = true;
    stWork('syncing ' + whole.length + ' offline edit' + (whole.length === 1 ? '' : 's') + '…');
    let stuck = false;
    const conflicts = [];
    for (let i = 0; i < all.length && !stuck; i += 50) {
      const part = all.slice(i, i + 50);
      let r = null;
      try {
        r = await tfetch(api + '/page-save-batch?report=1', {
          method: 'POST',
          body: JSON.stringify(part.map((q) =>
            ({ name: q.name, type: q.kind, body: q.body || '\n', base: q.baseRev || 0 }))),
        }, 120000);
      } catch {}
      if (r && r.ok) {
        // per-item verdicts: an edit whose base the ship moved past still
        // APPLIED (it is the newest revision), but the overwritten revision
        // is named so it can be recovered from history. Apply-and-flag,
        // never silently drop either side
        try {
          for (const it of ((await r.json()).items || []))
            if (it.conflicted) conflicts.push(it.kept || it.name);
        } catch {}
        for (const q of part) await offDel(q.name);
        continue;
      }
      if (r && !shipGone(r)) {
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
            await offDel(q.name);
            continue;
          }
          if (shipGone(one)) { stuck = true; break; }
          st('dropped an unsyncable offline edit: ' + q.name, false);
          await offDel(q.name);
        }
        continue;
      }
      stuck = true;
    }
    // memories drain per-item. There is no know batch route, and last-write-
    // wins means a plain re-save with no verdict to collect
    for (const q of knows) {
      if (stuck) break;
      let one = null;
      try {
        one = await tfetch(api + '/know-save?key=' + encodeURIComponent(q.name.slice(5)),
          { method: 'POST', body: q.body || '\n' }, 20000);
      } catch {}
      if (one && one.ok) { await offDel(q.name); continue; }
      if (shipGone(one)) { stuck = true; break; }
      st('dropped an unsyncable offline edit: ' + q.name, false);
      await offDel(q.name);
    }
    replaying = false;
    if (stuck) { setDegraded(true); st(offCount + ' offline edit(s) still waiting', false); return; }
    setDegraded(false);
    if (conflicts.length) {
      st('synced — ' + conflicts.length + ' conflict(s): your offline version won; '
        + 'the other is saved at ' + conflicts.join(', '), false);
    } else st('offline edits synced');
    // reconcile ONLY after the drain. refreshAll on reconnect would repaint
    // queued pages from the server dump before their edits landed (gap 4)
    if (knows.length && mode === 'know') loadKnow();
    loadTree();
  }
