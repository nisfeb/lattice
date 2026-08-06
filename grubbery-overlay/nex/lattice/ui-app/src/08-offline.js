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
  let offbadge = null;       // assigned by <lat-bar> (12-bar.js)
  // The persistent offline indicator. The status line reports EVENTS and the
  // next one overwrites it, so "saved offline" scrolls away while you are
  // still offline and still queueing. This reports the CONDITION and stays up
  // until the queue is empty and the ship answers again.
  //
  // The two halves are independent: the ship can be unreachable with nothing
  // queued yet, and the queue can be non-empty while the ship is back but the
  // replay has not finished.
  const renderOffline = () => {
    if (!offbadge) return;
    const q = offCount ? offCount + ' queued' : '';
    if (!degraded && !offCount) { offbadge.hidden = true; return; }
    offbadge.hidden = false;
    offbadge.textContent = degraded ? (q ? 'offline \u00b7 ' + q : 'offline') : q;
    offbadge.title = degraded
      ? 'the ship is not answering. Edits are saved on this device and sent when it returns.'
      : 'edits saved on this device, syncing now.';
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
      // Structural ops (delete, move, rename) are an ORDERED LOG, not a map.
      // Saves coalesce because only the last body matters and autosave writes
      // constantly. Deletes and moves do not: "rename A to B" then "delete B"
      // is not the same as the reverse, and both are things a person does on
      // purpose a handful of times, so there is nothing to coalesce away.
      if (!d.objectStoreNames.contains('ops'))
        d.createObjectStore('ops', { autoIncrement: true });
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
  const idbGet = async (name) => {
    const s = await offStore('readonly'); return s ? offReq(s.get(name)) : null;
  };
  const idbAll = async () => {
    const s = await offStore('readonly'); return (s && await offReq(s.getAll())) || [];
  };
  const opStore = async (mode) => {
    const d = await offOpen();
    try { return d && d.transaction('ops', mode).objectStore('ops'); } catch { return null; }
  };
  //  getAll and getAllKeys both come back in key order, which is the order
  //  they were queued in. That ordering IS the data structure here. The keys
  //  come along so a partly drained queue can delete exactly what landed.
  const idbOpAll = async () => {
    const s = await opStore('readonly');
    if (!s) return [];
    //  both requests are issued before either is awaited: a transaction ends
    //  once the microtask queue drains with nothing pending on it
    const vp = offReq(s.getAll());
    const kp = offReq(s.getAllKeys());
    const vals = (await vp) || [];
    const keys = (await kp) || [];
    return vals.map((v, i) => ({ ...v, _k: keys[i] }));
  };
  const idbOpPut = async (rec) => {
    const s = await opStore('readwrite'); if (s) await offReq(s.add(rec));
    await offRecount();
  };
  const idbOpDel = async (k) => {
    const s = await opStore('readwrite'); if (s) await offReq(s.delete(k));
    await offRecount();
  };
  // ── where the queue actually lives ───────────────────────────────────
  // In a browser: IndexedDB, which is all there is. In the desktop shell:
  // Rust, on disk, under the app's data dir and keyed by ship.
  //
  // The difference is not performance, it is survival. Web storage is keyed
  // by ORIGIN, and the origin here is the bridge's port. Anything that moved
  // that port moved the queue with it, so a relaunch that could not reclaim
  // the canonical port came up unable to see edits queued minutes earlier.
  // They were on disk the whole time, under an origin nothing would ask for
  // again. A ship-keyed store on the Rust side cannot be lost that way: not
  // by a port change, not by an upgrade, not by a second window.
  const qrust = () => (window.__TAURI__ && window.__TAURI__.core) || null;
  const qcall = async (cmd, args) => {
    const d = qrust();
    if (!d) return null;
    return d.invoke(cmd, args || {});
  };

  const offGet = async (name) => {
    if (!qrust()) return idbGet(name);
    //  one file, not the whole queue: this runs on every page open
    try { return (await qcall('queue_get', { name })) || null; } catch { return null; }
  };
  const offAll = async () => {
    if (!qrust()) return idbAll();
    try { return (await qcall('queue_list')) || []; } catch { return []; }
  };
  //  the one that must never lie: it reports whether the edit is really down
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

  // One-time adoption. A desktop user upgrading into this has edits sitting
  // in the IndexedDB of whatever origin they were queued under, and the one
  // we can still reach is our own. Move those across rather than leaving
  // somebody's writing in a store nothing reads any more.
  async function adoptIdbQueue() {
    if (!qrust()) return;
    let mine = [];
    try { mine = await idbAll(); } catch { mine = []; }
    for (const rec of mine) {
      try { await qcall('queue_put', { rec }); await idbDel(rec.name); } catch {}
    }
    // The ops too. Leaving them behind was a data-loss bug inside the very
    // migration that exists to prevent one: a delete or a rename queued before
    // the upgrade would be dropped, the tree would come back from the ship on
    // the next load, and the change would silently undo itself.
    //
    // In order, and one at a time: the sequence is assigned on the Rust side,
    // so the order they are pushed IS the order they replay in. `_k` is the
    // old IndexedDB handle and must not travel with the record.
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
    offCount = (await offAll()).length + (await opAll()).length;
    renderOffline();
  };
  // Resolve TRUE only when the write actually completed. offReq resolves the
  // request's RESULT, which for a put is the key, and a key is not a success
  // signal you can trust. This one exists so a failed write is distinguishable
  // from a successful one, because everything below depends on never claiming
  // a save that did not happen.
  const offOk = (rq) => new Promise((res) => {
    if (!rq) return res(false);
    rq.onsuccess = () => res(true);
    rq.onerror = () => res(false);
  });
  //  returns whether the record is now durably in the queue
  const idbPut = async (rec) => {
    const s = await offStore('readwrite');
    let ok = false;
    if (s) { try { ok = await offOk(s.put(rec)); } catch { ok = false; } }
    return ok;
  };
  const idbDel = async (name) => {
    const s = await offStore('readwrite'); if (s) await offReq(s.delete(name));
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
  //
  // The default is what the LIVE saves use, and it was 10s, which is the
  // tightest deadline in the app. Replay gets 20s an item and 120s a batch.
  // That was backwards. The pier serialises, so opening the app spends four
  // or five round-trips before you touch anything, and on a loaded ship the
  // first save is still queued behind them when its own clock runs out. It
  // then gets treated as an outage: the edit is queued, replayed later, and
  // lands on top of whatever happened in between as a conflicts/ page. A
  // false offline FABRICATES a conflict and splits one page into two.
  //
  // Waiting longer to notice a genuinely dead ship costs the user some
  // seconds. Guessing wrong costs them a duplicate page and the belief that
  // their edit was lost. So the default is generous now, and the checks that
  // are actually cheap (the reconnect probe at 5s) stay short.
  const tfetch = (url, opts = {}, ms = 30000) => {
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

  // queue one page's edit and make it the visible truth everywhere a read
  // could come from: the render cache, the tree dump body, the boot snapshot.
  // Returns whether the edit is actually safe. The old version returned
  // nothing and said "saved offline" unconditionally, including when the
  // queue write had silently failed, which is the worst thing this file can
  // do: the editor then cleared its dirty flag and the work was gone with the
  // UI reporting success. If the queue cannot take it, say so and say it in
  // the words that matter, because there is nowhere else the edit now lives.
  async function enqueueSave(name, kind, body) {
    const queued = await offPut({ name, kind, body, baseRev: curRev || 0, queuedAt: Date.now() });
    setDegraded(true);
    if (!queued) {
      st('NOT SAVED — this device cannot store offline edits. Copy your text '
        + 'somewhere safe before closing this page.', false);
      return false;
    }
    pageCache.delete(name);
    const nd = nodes.find((n) => n.page && n.path === name);
    if (nd) { nd.body = body; nd.kind = kind; persistTree(); }
    snapPage(name, { body, kind, rev: curRev || 0 });
    st('saved offline — ' + offCount + ' waiting to sync');
    return true;
  }
  // Queue a delete or a move. The caller has already done the local tree work
  // (dropTreeNodes, or remapping the paths) because that is the same work it
  // does when the ship answers, so all that is left is remembering the intent.
  //
  // The queued SAVES are reconciled here, immediately, which is what lets the
  // replay run every op before any save and still be right. Deleting a page
  // drops the save nobody will ever want again. Renaming one carries its
  // pending body along to the new name. Without that, a page edited and then
  // renamed offline would replay as a move of the OLD body plus a save under
  // the old name, resurrecting what was just renamed away.
  const under = (name, p) => name === p || name.startsWith(p + '/');
  async function enqueueOp(rec) {
    for (const q of await offAll()) {
      if (q.kind === 'know') continue;
      if (rec.op === 'del' && under(q.name, rec.name)) await offDel(q.name);
      if (rec.op === 'move' && under(q.name, rec.from)) {
        await offDel(q.name);
        await offPut({ ...q, name: rec.to + q.name.slice(rec.from.length) });
      }
    }
    for (const k of [...pageCache.keys()])
      if (under(k, rec.op === 'del' ? rec.name : rec.from)) pageCache.delete(k);
    // the boot snapshot names one page. If that page was just deleted or moved
    // away, the snapshot is stale: the next boot would paint a body whose name
    // no longer resolves in the tree (it reads as "my change reverted"). Drop
    // it so the boot defers to the network instead of painting a ghost.
    try {
      const p = JSON.parse(localStorage.appPage || 'null');
      if (p && p.name && under(p.name, rec.op === 'del' ? rec.name : rec.from))
        localStorage.removeItem('appPage');
    } catch {}
    await opPut({ ...rec, queuedAt: Date.now() });
    setDegraded(true);
    st(rec.op === 'del'
      ? 'deleted offline — ' + offCount + ' waiting to sync'
      : 'moved offline — ' + offCount + ' waiting to sync');
  }

  // know memories share the queue under a 'know:' prefix. Page names cannot
  // contain a colon, so the two namespaces cannot collide in the one store.
  // No baseRev: memories are last-write-wins (no CAS, no conflicts/ pages),
  // matching what know-save itself does.
  async function enqueueKnow(key, body) {
    const queued = await offPut({ name: 'know:' + key, kind: 'know', body, queuedAt: Date.now() });
    setDegraded(true);
    if (!queued) {
      st('NOT SAVED — this device cannot store offline edits. Copy your text '
        + 'somewhere safe before closing this page.', false);
      return false;
    }
    knowGen++;
    const k = knowEntry(key);
    if (k) k.bytes = body.length;
    else knowKeys.push({ key, tags: [], updated: '', bytes: body.length });
    renderKnowChips();
    renderKnowTree();
    st('saved offline — ' + offCount + ' waiting to sync');
    return true;
  }

  // Drain through page-save-batch. The batch is all-or-nothing, right for
  // uploads, wrong for replay. One poisoned record would block the queue
  // forever. A rejected batch falls back to per-item saves so the bad record
  // is isolated and DROPPED (it can never apply; review gap 3).
  let replaying = false;
  // The guard has to be taken BEFORE the first await. It used to be set four
  // lines further down, after two of them, so two callers could both pass the
  // check and drain the queue at the same time. Four things call this (boot,
  // the reconnect probe, a save that succeeds, and refreshAll) and they fire
  // close together by design.
  //
  // Concurrent drains are not merely wasteful. Both send the same baseRev; the
  // first applies and moves the revision on; the second is then a CAS miss,
  // which the server records as a conflict. That is a conflicts/ page invented
  // out of one queue draining twice, which is the same failure as a false
  // offline: a conflict manufactured where the user made none.
  //
  // try/finally because an exception part way through used to leave this true
  // for the life of the page, and replay never ran again.
  async function replayQueue() {
    if (replaying) return;
    replaying = true;
    try { await drainQueue(); } finally { replaying = false; }
  }
  async function drainQueue() {
    const whole = await offAll();
    const ops = await opAll();
    if (!whole.length && !ops.length) return;
    const all = whole.filter((q) => q.kind !== 'know');
    const knows = whole.filter((q) => q.kind === 'know');
    const total = whole.length + ops.length;
    stWork('syncing ' + total + ' offline edit' + (total === 1 ? '' : 's') + '…');
    let stuck = false;
    const conflicts = [];

    // Structural ops go FIRST, in the order they were made. Their effect on
    // the pending saves was already applied when they were queued, so a save
    // landing afterwards is always a save the user still wants, under the name
    // they want it under.
    //
    // An op the ship REJECTS is dropped, not retried. It means the intent was
    // already satisfied some other way: deleting a page that only ever existed
    // in this queue, or moving one whose source the queue never sent. Retrying
    // that forever would wedge everything behind it, and there is nothing to
    // recover because no content lives in an op.
    for (const o of ops) {
      if (stuck) break;
      //  a record of any other shape is corrupt. Falling through to the move
      //  branch would POST from=undefined&to=undefined, which is a confusing
      //  400 rather than a dropped bad record.
      if (o.op !== 'del' && o.op !== 'move') { await opDel(o._k); continue; }
      const u = o.op === 'del'
        ? api + '/page-del?name=' + encodeURIComponent(o.name)
        : api + '/page-move?from=' + encodeURIComponent(o.from) +
          '&to=' + encodeURIComponent(o.to);
      let r = null;
      try { r = await tfetch(u, { method: 'POST' }, 30000); } catch {}
      if (shipGone(r)) { stuck = true; break; }
      if (!(r && r.ok)) {
        st('offline ' + o.op + ' no longer applies: ' +
          (o.name || o.from) + ' (skipped)', false);
      }
      await opDel(o._k);
    }
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
