/* BUILT FILE — do not edit. Source: ui-app/src/, build: scripts/build-ui.mjs */
(function () {
'use strict';
// ── src/05-prefs.js ───────────────────────────────────────────────────────
  // ── typography preferences ───────────────────────────────────────────────
  // Set on the settings page, stored in localStorage, applied here. Two vars
  // only (--ed-font, --ed-size), because #src and #hl must keep byte-identical
  // metrics. See the note beside them in index.html.
  //
  // Costs ZERO requests. Preferences are a client concern, so they never touch
  // the pier. This file sorts first so the editor paints in the chosen font
  // rather than flashing the default and re-laying out.
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
    // an unknown key must fall back rather than write `undefined` into CSS
    if (f && FONTS[f]) r.setProperty('--ed-font', FONTS[f]);
    else r.removeProperty('--ed-font');
    const n = parseInt(s, 10);
    if (n >= 9 && n <= 32) r.setProperty('--ed-size', n + 'px');
    else r.removeProperty('--ed-size');
  }
  applyPrefs();
  // the settings page is a SEPARATE document on the same origin, so its writes
  // reach an open editor through the storage event (no reload, no polling).
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === 'latFont' || e.key === 'latFontSize') applyPrefs();
  });

// ── src/08-offline.js ─────────────────────────────────────────────────────
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
  async function enqueueSave(name, kind, body, isNew) {
    const queued = await offPut({ name, kind, body, baseRev: curRev || 0,
      isNew: !!isNew, queuedAt: Date.now() });
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
    // mkdir affects no queued save (it carries no content), so the
    // reconciliation below only runs for del/move. A folder create is recorded
    // and drained as-is; the local tree work (addFolderNodes) already happened.
    if (rec.op !== 'mkdir') {
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
    }
    await opPut({ ...rec, queuedAt: Date.now() });
    setDegraded(true);
    st(rec.op === 'del'
      ? 'deleted offline — ' + offCount + ' waiting to sync'
      : rec.op === 'mkdir'
        ? 'folder created offline — ' + offCount + ' waiting to sync'
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
      if (o.op !== 'del' && o.op !== 'move' && o.op !== 'mkdir') { await opDel(o._k); continue; }
      const u = o.op === 'del'
        ? api + '/page-del?name=' + encodeURIComponent(o.name)
        : o.op === 'mkdir'
          ? api + '/folder-new?name=' + encodeURIComponent(o.name)
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
    // Creates go PER-ITEM with new=1, never through the batch: the batch is an
    // unconditional upsert, so a name that already exists on the ship would be
    // silently overwritten. A create must keep its 409-on-exists protection,
    // or an offline "new page" could clobber a page someone else made online.
    const creates = all.filter((q) => q.isNew);
    const edits = all.filter((q) => !q.isNew);
    for (const q of creates) {
      if (stuck) break;
      let one = null;
      try {
        one = await tfetch(api + '/page-save?name=' + encodeURIComponent(q.name) +
          '&type=' + q.kind + '&new=1',
          { method: 'POST', body: q.body || '\n' }, 20000);
      } catch {}
      if (one && one.ok) { await offDel(q.name); continue; }
      if (shipGone(one)) { stuck = true; break; }
      // 409: the name is taken on the ship. Do NOT drop the user's body — move
      // it out of the way as a conflict page so nothing is lost, then let them
      // rename. Overwriting is the one thing a create must never do. The alt
      // write needs no new=1 (it is a preservation write, not a create-claim),
      // and %make creates the conflicts/ parent server-side, as it does for
      // the ship's own conflict pages.
      if (one && one.status === 409) {
        const alt = 'conflicts/offline-create-' + q.name.replace(/\//g, '-');
        let two = null;
        try {
          two = await tfetch(api + '/page-save?name=' + encodeURIComponent(alt) +
            '&type=' + q.kind, { method: 'POST', body: q.body || '\n' }, 20000);
        } catch {}
        if (two && two.ok) {
          conflicts.push(alt);
          await offDel(q.name);
          st('offline create collided: ' + q.name + ' exists on the ship — your ' +
            'version is kept at ' + alt, false);
        } else { stuck = true; }
        continue;
      }
      st('dropped an unsyncable offline create: ' + q.name, false);
      await offDel(q.name);
    }
    for (let i = 0; i < edits.length && !stuck; i += 50) {
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

// ── src/10-shell.js ───────────────────────────────────────────────────────
// lattice app, served from ui-app/src/, built by scripts/build-ui.mjs
  const $ = (id) => document.getElementById(id);
  const api = '/apps/lattice';
  // ── background requests yield to the user ────────────────────────────────
  // The pier runs one event at a time, so every request this client sends is
  // one the user's next click queues behind — measured: a page open landed at
  // 6.2s because three background fetches were in line ahead of it. There is
  // no cancelling a request already on the wire, so priority here means one
  // thing: do not SEND background traffic near user activity. bgFetch holds
  // its request until BG_IDLE_MS have passed since the last pointer/key
  // event; while you are actively browsing, background traffic is silent.
  //
  // For badges and syncs only. Anything the user asked for — opens, saves,
  // panel loads — uses fetch directly and must never come through here.
  //  seeded with NOW: page load counts as activity, so boot's background
  //  lane waits out the window in which a user's FIRST click arrives — the
  //  one click pointerdown cannot have preceded. Measured before this: the
  //  first open queued behind three boot fetches and took 5.2s.
  let lastAction = Date.now();
  addEventListener('pointerdown', () => { lastAction = Date.now(); }, true);
  addEventListener('keydown', () => { lastAction = Date.now(); }, true);
  const BG_IDLE_MS = 4000;
  //  ONE background request at a time, idle re-checked before EACH send.
  //  Releasing them together is an ambush: the gate opens after 4 idle
  //  seconds, three requests hit the pier's FIFO queue at once (~2s each),
  //  and the user's next click waits behind all of them — measured, that
  //  was 6s to open a page. Sequenced, the worst a click can land behind
  //  is the single background request already on the wire.
  let bgChain = Promise.resolve();
  const bgFetch = (url, opts) => {
    const run = async () => {
      for (;;) {
        const wait = BG_IDLE_MS - (Date.now() - lastAction);
        if (wait <= 0) break;
        await new Promise((r) => setTimeout(r, Math.max(wait, 250)));
      }
      return fetch(url, opts);
    };
    const p = bgChain.then(run);
    //  errors stay with the caller; the chain itself must survive them
    bgChain = p.catch(() => {});
    return p;
  };
  let pname, pkind, status, spinner;   // assigned by <lat-bar>   (12-bar.js)
  let prev;                            // assigned by <lat-preview> (60-preview.js)
  // blank preview: about:blank defaults to light color-scheme, which
  // mismatches the app's declared scheme and makes the iframe an opaque
  // white canvas in dark theme. Declare the scheme so it stays transparent
  // and the pane's theme background shows through.
  const prevBlank = () => {
    prev.removeAttribute('src');
    // the srcdoc paints its OWN theme background rather than relying on the
    // engine to composite a mismatched-scheme iframe as transparent. That
    // reliance is exactly the kind of behavior that differs between the
    // Chromium the tests run and the webkitgtk the desktop runs
    prev.srcdoc = '<style>:root{color-scheme:light dark}' +
      'body{margin:0;background:#fafafa}' +
      '@media(prefers-color-scheme:dark){body{background:#1a1a1a}}</style>';
  };
  // grant paths are shown in the share/ACL surfaces, and every one carries
  // the same app base, pure noise on screen. Strip it, then keep the
  // SHORTEST tail that stays unique among the paths shown alongside (`all`),
  // growing only where disambiguation demands. Callers put the full path in
  // `title`, so hover always has the truth.
  const shortPath = (p, all) => {
    const strip = (x) => x.replace(/^\/apps\/lattice\.lattice_app\/(page\/)?/, '');
    const label = (x) => {
      const me = strip(x);
      if (!me) return x;
      const segs = me.split('/');
      let n = 1;
      const tail = () => segs.slice(-n).join('/');
      const clashes = () =>
        all.some((q) => q !== x && strip(q).split('/').slice(-n).join('/') === tail());
      while (n < segs.length && clashes()) n++;
      // Out of segments and STILL ambiguous. strip() drops an optional "page/",
      // so /…/page/foo and /…/foo both reduce to "foo" with nothing left to
      // extend, and two different grants rendered identically in the ACL pane.
      // Fall back to keeping that prefix, which is what actually distinguishes
      // them. Showing a longer path beats showing the wrong one.
      if (clashes()) return x.replace(/^\/apps\/lattice\.lattice_app\//, '');
      return (n < segs.length ? '\u2026/' : '') + tail();
    };
    // Growing the tail compares TAILS, which is not the same as comparing
    // LABELS. /…/page/b keeps its "page/" by the rule above and /…/page/page/b
    // grows into those same two segments, so the pair collided anyway: found
    // by property, not by eye, in scripts/ui-props.mjs. Once even the labels
    // agree, nothing shorter than the whole path tells the grants apart.
    // Every label ends in its own last segment, so only same-leaf grants can
    // collide: that filter keeps this off the O(n²) path on a long ACL.
    const me = label(p);
    const leaf = (x) => x.slice(x.lastIndexOf('/') + 1);
    const near = all.filter((q) => q !== p && leaf(q) === leaf(p));
    if (near.some((q) => label(q) === me)) return p;
    return me;
  };
  const st = (msg, ok = true) => {
    spinner.classList.remove('on');          // any plain status ends the spin
    status.textContent = msg;
    status.style.color = ok ? '' : '#c0392b';
  };
  // stWork: a status that keeps spinning until the next plain st()
  const stWork = (msg) => {
    status.textContent = msg;
    status.style.color = '';
    spinner.classList.add('on');
  };
  // desktop shell: wry denies target=_blank new windows (the clearweb share
  // link would be a dead click). Same-origin and urb:// links stay in the
  // app. Only truly external http(s) leaves for the system browser.
  if (window.__TAURI__)
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[target="_blank"]');
      if (!a || !a.href) return;
      e.preventDefault();
      const ext = /^https?:/.test(a.href) && new URL(a.href).origin !== location.origin;
      if (ext) window.__TAURI__.core.invoke('open_external_url', { url: a.href });
      else location.href = a.href;
    });

// ── src/12-bar.js ─────────────────────────────────────────────────────────
  // ── top bar + mobile tabs: <lat-bar>, <lat-tabs> ─────────────────────────
  // The spinner is part of the bar's own markup now (its CSS lives in the
  // shell stylesheet). The old inject-styles-and-synthesize-elements guards
  // existed only because the shell and JS could cache-skew apart.
  customElements.define('lat-bar', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<header class="bar">
  <a class="home" href="/apps/lattice" title="lattice home">&#8962;</a>
  <button id="modet" title="switch pages / knowledge">&#9998; pages</button>
  <input id="pname" placeholder="page name (e.g. notes/todo)" autocomplete="off" spellcheck="false">
  <select id="pkind" title="page kind">
    <option value="md">md</option>
    <option value="gmi">gmi</option>
    <option value="html">html</option>
    <option value="text">txt</option>
    <option value="js">js</option>
    <option value="css">css</option>
    <option value="hoon">hoon</option>
  </select>
  <button id="save">save</button>
  <span id="spin"></span><span id="status" class="muted"></span>
  <!-- Offline state is a CONDITION, not an event, so it cannot live in the
       status line: the next save, render or refresh overwrites that. This
       badge stays up for as long as the condition holds. -->
  <span id="offbadge" class="offbadge" hidden></span>
  <span class="grow"></span>
  <button id="wrapt" class="ico" title="toggle line wrap">&#8617;</button>
  <!-- a KEY, not U+26BF: that codepoint has almost no font coverage and
       rendered as an empty box, which is worse than no button at all. -->
  <button id="qt" class="ico" title="search your pages and notes (ctrl-K)">&#128269;</button>
  <button id="cmt" class="ico" title="comments from other ships">&#128172;</button>
  <!-- a save that replaced an edit from elsewhere keeps the losing body as a
       conflicts/ page. Those are invisible unless you already know to look,
       which is the one failure a conflict design must not have. This badge
       counts them and opens the resolve pane. -->
  <button id="cflt" class="ico" title="sync conflicts to resolve" hidden>&#9873;</button>
  <button id="aclt" class="ico" title="access control &mdash; groups, sharing, banned ships">&#128273;</button>
  <button id="treet" class="ico" title="toggle tree pane">&#9776;</button>
  <button id="ctlt" class="ico" title="toggle controls pane">&#9881;</button>
</header>`;
      pname = $('pname'); pkind = $('pkind');
      status = $('status'); spinner = $('spin'); offbadge = $('offbadge');
      renderOffline();   // a queue can outlive a session, so show it at boot
    }
  });
  customElements.define('lat-tabs', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<nav class="mtabs" id="mtabs">
  <button data-mv="tree">tree</button>
  <button data-mv="code" class="on">code</button>
  <button data-mv="prev">preview</button>
  <button data-mv="ctl">controls</button>
</nav>`;
    }
  });
  // stale-shell guard: replace a cached pre-component shell's literal bar and
  // tabs. The bar relies on source order for its grid row, so it is PREPENDED.
  if (!document.querySelector('lat-bar')) {
    for (const sel of ['header.bar', 'nav.mtabs']) {
      const stale = document.querySelector(sel);
      if (stale) stale.remove();
    }
    const wsEl = document.getElementById('ws');
    const tabs = document.createElement('lat-tabs');
    const bar = document.createElement('lat-bar');
    tabs.style.display = 'contents';
    bar.style.display = 'contents';
    wsEl.prepend(tabs);
    wsEl.prepend(bar);
  }

// ── src/15-dialog.js ──────────────────────────────────────────────────────
  // ── in-app dialogs, NEVER browser-native prompt/confirm/alert ────────────
  // <lat-dialog> owns the dialog's markup AND wiring. The shell only carries
  // the tag, so the served HTML can never be missing an element this file
  // expects (the old cache-skew guards existed exactly for that gap).
  let dlg, dlgMsg, dlgIn, dlgSel, dlgOpts;
  let dlgDone = null;
  const dlgClose = (v) => {
    if (!dlgDone) return;
    dlg.hidden = true;
    const d = dlgDone; dlgDone = null; d(v);
  };
  const dlgOpen = (msg, okLabel) => {
    dlgMsg.textContent = msg;
    $('dlgok').textContent = okLabel || 'ok';
    dlg.hidden = false;
    return new Promise((res) => { dlgDone = res; });
  };
  // ask: text-input dialog → string | null (cancel)
  const ask = (msg, value, okLabel) => {
    dlgSel.hidden = true;
    dlgIn.hidden = false;
    dlgIn.value = value || '';
    const p = dlgOpen(msg, okLabel);
    dlgIn.focus(); dlgIn.select();
    return p;
  };
  // askConfirm: yes/no dialog → boolean
  const askConfirm = (msg, okLabel) => {
    dlgSel.hidden = true;
    dlgIn.hidden = true;
    const p = dlgOpen(msg, okLabel);
    $('dlgok').focus();
    return p.then((v) => v !== null);
  };
  // askChoice: pick one of a list -> the chosen value, or null on cancel.
  // Rendered as real buttons in the app's own style, NEVER a <select>. A
  // select opens an OS-drawn list, which is a browser-native popup, and this
  // UI does not use those anywhere.
  const askChoice = (msg, options, okLabel) => {
    dlgIn.hidden = true;
    dlgSel.hidden = true;
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
    // arrow keys move between options. Enter takes the focused one
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
<div class="dlg" id="dlg" hidden>
  <form class="dlgbox" id="dlgform">
    <div id="dlgmsg"></div>
    <div id="dlgopts" class="dlgopts" hidden></div>
    <select id="dlgsel" hidden></select>
    <input id="dlginput" autocomplete="off" spellcheck="false">
    <div class="dlgbtns">
      <button type="button" id="dlgcancel">cancel</button>
      <button type="submit" id="dlgok">ok</button>
    </div>
  </form>
</div>`;
      dlg = $('dlg'); dlgMsg = $('dlgmsg'); dlgIn = $('dlginput');
      dlgSel = $('dlgsel'); dlgOpts = $('dlgopts');
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
  // stale-shell guard: a cached index.html predating <lat-dialog> still
  // carries the literal #dlg block, which would shadow the component's ids.
  // Swap it out so dialogs keep working during the skew window (the service
  // worker caches the shell and this file independently).
  if (!document.querySelector('lat-dialog')) {
    const stale = document.getElementById('dlg');
    if (stale) stale.remove();
    document.body.appendChild(document.createElement('lat-dialog'));
  }

// ── src/20-state.js ───────────────────────────────────────────────────────
  // ── state ────────────────────────────────────────────────────────────────
  let current = null;      // name of the open page, null = unsaved new page
  let dirty = false;       // unsaved local edits. Auto-refresh never clobbers them
  // Whether the user has typed since the current editor view was established.
  // Cleared by applyPage/newFile (a fresh view), NEVER by autosave — and that
  // is the point: `dirty` cannot answer "did the user do something while
  // boot's dump was in flight", because autosave clears it. The sequence
  // type -> autosave -> dump-lands then looked untouched, and boot's reconcile
  // called openPage, which repainted the editor from the PRE-edit dump copy.
  // The next autosave wrote that stale body back over the good save: the
  // editor visibly ate work the ship already had.
  let everTyped = false;
  let viewingRev = null;   // non-null: a read-only historical revision is shown
  let curKind = null;      // the OPEN page's server kind; 'index' has no select
                           // option, so pkind.value would silently convert it
  let curRev = 0;          // the open page's server revision (offline baseRev)
  let curFolder = null;    // selected folder path. Right-pane ops target it
  let folderCtx = '';      // folder uploads land in (last into / open page's dir)
  let nodes = [];          // last page-tree
  let saving = false;      // a save round-trip is in flight. Never overlap them.
  let savePending = false; // The pier serializes, so a second save just queues
                           // 3.7s of stale-body work behind the first
  //  every successful mutation of ours produces exactly one beacon bump,
  //  eventually — and on a queued pier "eventually" outlives any time
  //  window (measured: 14s behind the background lane's own traffic). So
  //  count them: each expected echo swallows one 'upd'. A pier-side
  //  coalesce or an untracked mutation can make this swallow a real remote
  //  update; the 30s poll / focus refresh is the floor that catches it,
  //  the same tradeoff the time window has always accepted.
  let pendingEchoes = 0;
  let echoUntil = 0;       // our own save bumps the beacon. Ignore that echo or
                           // every save triggers a tree+source refetch of content
                           // this client just wrote (~4s of pier time each)
  const qs = new URLSearchParams(location.search);

  // every request to the ship costs ~2s and they serialize (single-threaded
  // pier), so the rules here are: never re-fetch what this client already
  // knows, patch `nodes`/`knowKeys` locally after our own writes, and snapshot
  // to localStorage so the next boot paints before the network answers.
  // generation counters: a list fetch issued BEFORE a local patch must not
  // land AFTER it and clobber newer local state with a stale server snapshot
  // (the own-write echo is suppressed, so nothing would correct it until the
  // 30s poll). Bumped on every local mutation. Stale responses are dropped.
  let treeGen = 0, knowGen = 0;
  // persistTree: save the tree WITHOUT bumping the generation. The counter
  // exists so a STRUCTURAL local patch (a page created, moved, deleted) is not
  // overwritten by a list fetch that was issued before it. A body-only update
  // changes no structure, so bumping for one just discards a legitimate
  // in-flight refresh, which silently lost pages created while an autosave
  // was in flight.
  const persistTree = () => {
    // IDB, not localStorage (phase 3): the tree carries every page BODY via
    // page-dump, so a growing vault was marching toward the ~5MB quota.
    // Stringifying the whole tree on every save was main-thread work paid at
    // the worst time. The structured clone goes straight in. The PAGE
    // snapshot (appPage) stays in localStorage on purpose. It is small and
    // synchronous, which is what keeps resume painting at 0ms.
    kvPut('tree', nodes);
  };
  // rendered page-source answers, by name. The tree dump already carries every
  // body, so this only adds what the dump lacks (`share` and the rendered
  // `html`), which makes re-opening a page cost ZERO requests instead of a
  // ~0.5s round-trip. Dropped whenever the ship reports a change (the beacon
  // clears it) or when this client writes the page.
  const pageCache = new Map();
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

  // every client-initiated write bumps the change beacon. Hold the echo window
  // open while the request is in flight (a folder move pokes the writer many
  // times) plus a short tail, so the SSE handler never refetches what this
  // client just did itself.
  // Deletes and moves that can be queued. Sharing and the ACL routes are
  // deliberately NOT here. A grant that appears to work offline and is refused
  // an hour later is a security surprise, and there is no version of that
  // which is better than saying so now.
  const offlineOp = (url) => {
    let u = null;
    try { u = new globalThis.URL(url, location.origin); } catch { return null; }
    const p = u.searchParams;
    if (u.pathname.endsWith('/page-del') && p.get('name'))
      return { op: 'del', name: p.get('name') };
    if (u.pathname.endsWith('/page-move') && p.get('from') && p.get('to'))
      return { op: 'move', from: p.get('from'), to: p.get('to') };
    // folder-new carries no content, so it is a structural op like del/move,
    // not a save. Idempotent on the ship (folder-new over an existing folder
    // is a no-op), so a replayed mkdir can never conflict.
    if (u.pathname.endsWith('/folder-new') && p.get('name'))
      return { op: 'mkdir', name: p.get('name') };
    return null;
  };

  async function mutate(url, opts) {
    // Saves coalesce in a map, structural ops go in an ordered log, and both
    // drain together. Everything else (sharing, tagging, the legacy migration)
    // still refuses honestly rather than pretending.
    if (degraded || offCount) {
      const q = offlineOp(url);
      if (q) {
        await enqueueOp(q);
        //  the caller now does exactly the local tree work it does when the
        //  ship answers: drop the nodes, or remap their paths
        return { ok: true, status: 200, json: async () => ({ offline: true }) };
      }
      st('offline — edits are queued, but this change needs the ship', false);
      return { ok: false, status: 'offline', json: async () => ({ error: 'offline' }) };
    }
    echoUntil = Date.now() + 60000;
    const sentAt = Date.now();
    try {
      const r = await fetch(url, opts || { method: 'POST' });
      if (r.ok) pendingEchoes++;      // one bump is ours; consume it on arrival
      return r;
    }
    //  RTT-scaled like the save paths: our own bump arrives a queue-length
    //  late on a slow pier, and a window it misses turns into refetches
    finally { echoUntil = Date.now() + Math.max(4000, 2 * (Date.now() - sentAt)); }
  }

  const collapsed = () => {
    try { return JSON.parse(localStorage.appColl || '[]'); } catch { return []; }
  };
  const setCollapsed = (c) => { localStorage.appColl = JSON.stringify(c); };

// ── src/22-listedit.js ────────────────────────────────────────────────────
  // ── smart list continuation ──────────────────────────────────────────────
  // Pure on purpose. It takes the text and the selection and returns the edit
  // to apply, touching no DOM, so the fiddly parts (nesting, mixed markers,
  // renumbering) are unit tested by scripts/ui-listedit.mjs in milliseconds
  // with no browser and no ship. The editor's keydown handler is the only
  // place that knows about textareas.
  //
  // Returns null when Enter should do its ordinary thing. Otherwise
  // {from, to, text, caret}: replace [from, to) with text, then put the caret
  // at `caret`.
  const listEnter = (value, selStart, selEnd, flavor) => {
    const TAB = 4;
    const width = (s) => s.replace(/\t/g, ' '.repeat(TAB)).length;
    // indent, then either a bullet or a number+delimiter, then the gap, then
    // an optional task box. Kept in one place: every scan below reuses it.
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
    // A fenced block is literal text: a "- " in a shell snippet is not a list.
    // In gemtext ``` toggles a preformatted block, which is the same rule.
    const before = value.slice(0, selStart);
    const fences = before.match(/^[ \t]*(?:```|~~~)/gm);
    if (fences && fences.length % 2 === 1) return null;

    // Gemtext is not markdown with fewer features, it is a different grammar.
    // Its ONLY list form is "* " at the very start of a line: no ordered
    // lists, no nesting, and leading whitespace makes a line ordinary text.
    // Continuing markdown markers here would write "- " and "2." that gemtext
    // renders as literal characters, so it gets its own small rule set.
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
    // Caret inside the marker itself, including at the very start of the line.
    // Enter there pushes the item down and leaves it intact, which is what
    // every editor does. Continuing would emit a second marker ("- - one") or
    // split the marker in half ("1" / "2. . one").
    if (selStart < lineStart + cur.len) return null;

    const lines = value.split('\n');
    // index of the line the caret sits on, by counting newlines before it
    const curIdx = before.split('\n').length - 1;

    // How far this list block reaches. A blank line does not end it (loose
    // lists have them), nor does a deeper-indented continuation. A line at or
    // left of our indent that is not an item does.
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

    // ── an item with nothing in it: Enter leaves the list ─────────────────
    const content = value.slice(lineStart, lineEnd).slice(cur.len);
    if (!content.trim()) {
      // Nested, so step out one level instead of dropping the list entirely.
      // The parent's own marker decides what we become, which is what makes a
      // mixed list (numbers outside, dashes inside) walk back up correctly.
      for (let i = curIdx - 1; i >= 0 && cur.w > 0; i--) {
        const p = parse(lines[i]);
        if (!p || p.w >= cur.w) continue;
        const marker = p.bullet
          ? p.bullet + ' '
          : String((p.num || 0) + 1) + p.delim + ' ';
        const text = p.indent + marker + (p.task ? '[ ] ' : '');
        return { from: lineStart, to: lineEnd, text, caret: lineStart + text.length };
      }
      // top level: clear the marker and end the list
      return { from: lineStart, to: lineEnd, text: '', caret: lineStart };
    }

    // ── continue the list ─────────────────────────────────────────────────
    if (cur.bullet) {
      // Unordered needs no bookkeeping: same bullet, same indent. A task item
      // continues as an UNCHECKED box, never inheriting the tick.
      const text = '\n' + cur.indent + cur.bullet + cur.gap + (cur.task ? '[ ] ' : '');
      return { from: selStart, to: selEnd, text, caret: selStart + text.length };
    }

    // Ordered. Collect this level's siblings inside the block so we can tell
    // sequential numbering from the "all 1." style, which is valid markdown
    // and must not be silently rewritten into 1, 2, 3.
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

    // Everything from the caret to the end of the block gets rewritten in one
    // edit: the text after the caret becomes the new item's content, and the
    // items below it shift up by one. One replacement means one undo step.
    // The replaced region must cover the whole selection AND the rest of the
    // block. A selection reaching past the last item would otherwise be
    // clamped to the block, leaving the part below it alive: the user's
    // selection came back after being typed over.
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

  // ── indent / outdent a list item ─────────────────────────────────────────
  // Tab on a list line moves it a level deeper; Shift-Tab a level out. Same
  // contract as listEnter: pure, returns {from, to, text, caret} or null for
  // "not a list edit — let Tab do its ordinary thing". A selection spanning
  // several lines moves every LIST line in it together, which is what makes
  // reshaping a pasted outline a two-keystroke job.
  //
  // One level is TWO SPACES, because that is what the local renderer counts
  // (59-md.js: depth = floor(indent/2) + 1). A tab character is one level of
  // its own on the way out.
  const listTab = (value, selStart, selEnd, flavor, dir) => {
    // gemtext has no nesting: "* " at column zero is the whole grammar, and
    // an indented line is ordinary text. Tab must stay a plain tab there.
    if (flavor === 'gmi') return null;
    const ITEM = /^([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)/;
    // fenced code is literal text (the same rule listEnter applies): a Tab
    // inside a fence is indentation for CODE, not for a list that is not one
    const fences = value.slice(0, selStart).match(/^[ \t]*(?:```|~~~)/gm);
    if (fences && fences.length % 2 === 1) return null;

    const lineStart = value.slice(0, selStart).lastIndexOf('\n') + 1;
    let spanEnd = value.indexOf('\n', Math.max(selEnd, selStart));
    if (spanEnd === -1) spanEnd = value.length;
    const span = value.slice(lineStart, spanEnd).split('\n');

    // only item lines move; a selection that contains none is not a list edit
    if (!span.some((ln) => ITEM.test(ln))) return null;

    let firstDelta = 0;   // how the FIRST line's start moved, for the caret
    const out = span.map((ln, i) => {
      if (!ITEM.test(ln)) return ln;
      if (dir > 0) {
        if (i === 0) firstDelta = 2;
        return '  ' + ln;
      }
      // outdent: one tab is one level; otherwise up to two spaces
      const cut = ln.startsWith('\t') ? 1 : Math.min(2, (ln.match(/^ */) || [''])[0].length);
      if (i === 0) firstDelta = -cut;
      return ln.slice(cut);
    });
    const text = out.join('\n');
    if (text === value.slice(lineStart, spanEnd)) return null;   // nothing to take out

    if (selStart === selEnd) {
      // keep the caret on the same character it was on, clamped to its line
      const caret = Math.max(lineStart, selStart + firstDelta);
      return { from: lineStart, to: spanEnd, text, caret };
    }
    // a multi-line selection stays a selection over the moved lines
    return { from: lineStart, to: spanEnd, text, caret: lineStart, caretEnd: lineStart + text.length };
  };

// ── src/25-editor.js ──────────────────────────────────────────────────────
  // ── editor pane: <lat-editor> + highlighting (Prism overlay) ─────────────
  let src, hl;   // assigned when <lat-editor> upgrades (below, synchronously)
  const LMAP = { md: 'markdown', gmi: 'gemtext', html: 'markup',
                 js: 'javascript', css: 'css', hoon: 'hoon' };
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const render = () => {
    const lang = LMAP[pkind.value];
    const g = window.Prism && lang && Prism.languages[lang];
    hl.innerHTML = (g ? Prism.highlight(src.value, g, lang) : esc(src.value)) + '\n';
  };
  const sync = () => { hl.scrollTop = src.scrollTop; hl.scrollLeft = src.scrollLeft; };
  // per-keystroke highlight throttle: Prism re-tokenizes the WHOLE document on
  // every render, which drops frames on large pages. Coalesce to one render per
  // frame. Past ~60KB fall back to a trailing debounce (even one full highlight
  // per frame is too heavy there).
  let hlRaf = 0, hlTimer = 0;
  const scheduleRender = () => {
    if (src.value.length > 60000) {
      clearTimeout(hlTimer);
      hlTimer = setTimeout(() => { render(); sync(); }, 120);
    } else if (!hlRaf) {
      hlRaf = requestAnimationFrame(() => { hlRaf = 0; render(); sync(); });
    }
  };
  // +edited: announce a PROGRAMMATIC change to the editor exactly as if it had
  // been typed. Setting src.value fires no input event, so anything that only
  // called render() silently skipped the dirty flag, autosave and the preview.
  // A Tab indent was shown but never saved, and a live refresh reverted it.
  // Always route scripted edits through here.
  const edited = () => src.dispatchEvent(new Event('input'));
  customElements.define('lat-editor', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="edwrap">
  <div id="acmirror" aria-hidden="true"></div>
  <div id="ac" class="ac" hidden role="listbox" aria-label="page suggestions"></div>
  <pre id="hl" aria-hidden="true"></pre>
  <textarea id="src" spellcheck="false" placeholder="open a page from the tree, or name a new one and start typing"></textarea>
</div>`;
      src = $('src'); hl = $('hl');
      src.addEventListener('input', () => {
        dirty = true;
        everTyped = true;      // never cleared: see 20-state.js
        scheduleRender();
        clearTimeout(autoTimer);
        autoTimer = setTimeout(autosave, 2000);
      });
      src.addEventListener('scroll', sync);
    }
  });
  // stale-shell guard: a cached index.html predating <lat-editor> still has
  // the literal .edwrap block (and lacks the lat-* display rule). Swap it.
  if (!document.querySelector('lat-editor')) {
    const stale = document.querySelector('.edwrap');
    if (stale) stale.remove();
    const el = document.createElement('lat-editor');
    el.style.display = 'contents';
    document.getElementById('ws').appendChild(el);
  }
  pkind.addEventListener('change', () => { curKind = pkind.value; render(); });

// ── src/27-vim.js ─────────────────────────────────────────────────────────
  // ── vim mode ─────────────────────────────────────────────────────────────
  // RESTORED. This shipped in 7eff5b1 and was lost in 11d7f9b, the migration
  // that deleted the editor's HTML-and-JS-in-cords: its parity audit listed
  // what survived and this was not on it, so it went silently. Recovered from
  // that commit rather than rewritten.
  //
  // It was stored base64-encoded in a hoon cord and eval'd. Here it is just a
  // source file the build concatenates, so there is no eval and no dependency.
  //
  // Self-contained, and inert unless localStorage.edVim is "1": the keydown
  // listener returns immediately when off, so the ordinary editor is untouched.
  //
  // Sorts before 45-templates.js on purpose. In normal mode it consumes keys
  // with stopImmediatePropagation, which is what keeps Enter from ALSO running
  // list continuation and Tab from inserting two spaces. Registration order
  // decides that, and the filename decides registration order.
/* ============================================================================
   VIM MODE for the lattice code editor.
   Self-contained vanilla JS, no dependencies. Operates on <textarea id="src">.
   Inline this INSIDE (or right after) the existing editor IIFE; it re-fetches
   `ta` itself so ordering is not critical.
   ============================================================================ */
(function vimMode(){
  "use strict";

  var ta = document.getElementById("src");
  if(!ta) return;

  /* ---- persisted on/off flag (same pattern as edNT / edNC) ---- */
  var LS = "edVim";
  function vimOn(){ return localStorage.getItem(LS) === "1"; }   // default OFF

  /* ---- mode indicator element (created once, lives by the status bar) ---- */
  var ind = document.getElementById("vimInd");
  if(!ind){
    ind = document.createElement("span");
    ind.id = "vimInd";
    ind.style.cssText =
      "display:none;margin-left:8px;padding:1px 6px;border-radius:3px;"+
      "font:11px/1.6 monospace;font-weight:bold;letter-spacing:.5px;"+
      "color:#fff;background:#666;vertical-align:middle;";
    var stEl = document.getElementById("status");
    if(stEl && stEl.parentNode) stEl.parentNode.insertBefore(ind, stEl.nextSibling);
    else document.body.appendChild(ind);
  }

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
    if(!vimOn()){ ind.style.display = "none"; return; }
    ind.style.display = "inline-block";
    if(cmdActive){ ind.textContent = ":" + cmdBuf; ind.style.background = "#455a64"; return; }
    var label, bg;
    if(MODE === "insert"){ label = "-- INSERT --"; bg = "#2e7d32"; }
    else if(MODE === "visual"){ label = "-- VISUAL --"; bg = "#8e24aa"; }
    else { label = "-- NORMAL --"; bg = "#1565c0"; }
    if(pending || count) label += " " + count + pending;
    ind.textContent = label;
    ind.style.background = bg;
  }

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
  // In NORMAL mode the caret rests ON a char, so max column is lineEnd-1
  // (unless the line is empty, where it sits at lineStart).
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
  // Keep caret legal for the current mode.
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
  // Replace [a,b) with text. execCommand keeps the native undo stack; setRangeText
  // is the fallback. Always fires input for the live preview.
  function replaceRange(a, b, text, caret){
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
  // Show the selection, but leave the logical caret (visCaret) as the moving head.
  function visSync(){
    if(MODE !== "visual") return;
    var r = visRange();
    // put the DOM caret AT visCaret so pos()-based motions read the right spot,
    // then extend the visible selection to cover the range.
    if(visCaret >= visAnchor) setSel(r[0], r[1]);
    else setSel(r[0], r[1]);
    // keep selectionStart at visCaret side for motion reads is not needed;
    // visual handler uses visCaret directly.
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
  // cw behaves like ce: change to end of current word, do not eat trailing space.
  function changeWordEnd(p, n){
    var v = val();
    if(charClass(v[p]) === "sp" || charClass(v[p]) === "nl") return wordFwd(p, n);
    return clamp(wordEnd(p, n) + 1, p, v.length);
  }
  // vertical move preserving column. delta>0 down, delta<0 up.
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
  // f/F/t/T within the current line
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
  // 1-based line addressing; returns firstNonBlank of that line.
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
  // [start, end] covering `cnt` whole lines starting at the line of p,
  // where end includes the trailing newline of the last line when present.
  function lineSpan(p, cnt){
    var start = lineStart(p), end = start, v = val();
    for(var k = 0; k < cnt; k++){
      var le = lineEnd(end);
      if(le < v.length) end = le + 1;     // include the newline
      else { end = le; break; }
    }
    return [start, end];
  }
  // Linewise yank of cnt lines from p.
  function linewiseYank(p, cnt){
    var sp = lineSpan(p, cnt);
    yank(sp[0], sp[1], true);
  }
  // Linewise delete of cnt lines from p; caret -> first non-blank of resulting line.
  // Handles the last-line case (eat the preceding newline so no blank line lingers).
  function linewiseDelete(p, cnt){
    var v = val(), sp = lineSpan(p, cnt), a = sp[0], b = sp[1];
    yank(a, b, true);
    if(b >= v.length && a > 0 && v[a - 1] === "\n") a = a - 1;   // last line: eat preceding \n
    deleteRange(a, b, 0);
    setPos(firstNonBlank(clamp(a, 0, val().length)));
  }
  // Linewise change of cnt lines: blank the block down to one empty line, enter insert.
  function linewiseChange(p, cnt){
    var sp = lineSpan(p, cnt), a = sp[0], b = sp[1], v = val();
    yank(a, b, true);
    // keep one line: drop the trailing newline from the delete span if present
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
          // last line, no trailing newline: prepend a newline, drop reg's trailing one
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
      // linewise motions on an operator: dj / dk (and cc-ish via count are handled elsewhere)
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
    // :w and its aliases (:wa, :waq, and the common :wq / :x) all just save.
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

    // Esc / Ctrl-[ -> clear pending, drop to NORMAL from visual
    if(k === "Escape" || (e.ctrlKey && k === "[")){
      if(MODE === "visual"){ var c = pos(); MODE = "normal"; setPos(normClamp(c)); }
      reset(); setInd(); return true;
    }
    // Ctrl-R redo
    if(e.ctrlKey && (k === "r" || k === "R")){
      try{ document.execCommand("redo"); }catch(x){}
      fireInput(); reset(); fixCaret(); setInd(); return true;
    }

    // ---- pending single-char consumers: r, f/F/t/T ----
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

    // ---- digits -> count (0 is a motion when count is empty) ----
    if(/^[0-9]$/.test(k) && !(k === "0" && count === "")){
      count += k; setInd(); return true;
    }

    var n = eff();

    // ---- operator pending (d / c / y) ----
    if(pending === "d" || pending === "c" || pending === "y"){
      var op = pending;
      // doubled operator = linewise (dd, cc, yy)
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

    // ---- VISUAL: motions move visCaret (the head) and extend the selection ----
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
        case "$": moved = lineEnd(vc); break;
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
          // paste over selection: snapshot register BEFORE the delete clobbers it
          var sText = reg, sLine = regLinewise;
          deleteRange(a, b, a);
          reg = sText; regLinewise = sLine;
          MODE = "normal"; setPos(a > 0 ? a - 1 : a); paste(true);
          reset(); setInd(); return true;
        }
        case "v": MODE = "normal"; setPos(normClamp(visCaret)); reset(); setInd(); return true;
      }
      // swallow any other printable key in visual
      if(k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey){ reset(); setInd(); return true; }
      reset(); setInd(); return true;
    }

    // ---- NORMAL: single-key commands ----
    var p = pos();
    switch(k){
      // motions
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

      // enter insert
      case "i": toInsert(); break;
      case "a": if(lineText(p).length) setPos(p + 1); toInsert(); break;
      case "I": setPos(firstNonBlank(p)); toInsert(); break;
      case "A": setPos(lineEnd(p)); toInsert(); break;
      case "o": { var le = lineEnd(p); insertAt(le, "\n"); setPos(le + 1); toInsert(); break; }
      case "O": { var ls = lineStart(p); insertAt(ls, "\n"); setPos(ls); toInsert(); break; }

      // operators (pending)
      case "d": pending = "d"; setInd(); return true;
      case "c": pending = "c"; setInd(); return true;
      case "y": pending = "y"; setInd(); return true;
      case "r": pending = "r"; setInd(); return true;

      // whole-line / end-of-line edits
      case "D": { var le2 = lineEnd(p); yank(p, le2, false); deleteRange(p, le2, p); fixCaret(); break; }
      case "C": { var le3 = lineEnd(p); yank(p, le3, false); deleteRange(p, le3, p); setPos(p); toInsert(); break; }
      case "s": {
        var le4 = lineEnd(p), end4 = clamp(p + n, p, le4);
        if(end4 > p) yank(p, end4, false);
        deleteRange(p, end4, p); setPos(p); toInsert();
        break;
      }
      case "S": linewiseChange(p, n); break;

      // char deletes
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

      // paste
      case "p": paste(true); break;
      case "P": paste(false); break;

      // visual
      case "v": toVisual(); break;

      // ex command line (:w / :wa / :waq ...)
      case ":": cmdActive = true; cmdBuf = ""; pending = ""; count = ""; setInd(); return true;

      // undo
      case "u": try{ document.execCommand("undo"); }catch(x){} fireInput(); fixCaret(); break;

      default:
        // swallow any other printable key so it never types into the buffer
        reset(); setInd(); return true;
    }
    reset(); setInd(); return true;
  }

  /* ============================================================================
     THE TEXTAREA KEYDOWN LISTENER (capture phase — runs before the Tab handler)
     ============================================================================ */
  ta.addEventListener("keydown", function(e){
    if(!vimOn()) return;                    // vim off: native textarea (Tab, typing) unchanged

    // Never intercept the app's OWN chords. This listener is capture-phase on
    // the textarea and consumes normal-mode keys with stopImmediatePropagation,
    // so anything it does not hand back never reaches the window-level
    // handlers at all. Save was exempted from the start. Search was not, and
    // with vim on that read as "ctrl-K does nothing" rather than "vim ate it",
    // which is the kind of bug people report as a missing feature.
    //
    // Listed explicitly rather than exempting every ctrl chord: vim's own
    // Ctrl-d/u/f/b are bindings here and must keep working.
    if((e.metaKey || e.ctrlKey)
       && (e.key === "s" || e.key === "S" || e.key === "k" || e.key === "K")) return;

    if(MODE === "insert"){
      // insert mode: only Esc / Ctrl-[ is special; everything else (incl. Tab=2sp) native
      if(e.key === "Escape" || (e.ctrlKey && e.key === "[")){ e.preventDefault(); toNormal(); }
      return;
    }

    // ex command line (:w etc.): own the keyboard until Enter runs it or Esc cancels.
    if(cmdActive){
      e.preventDefault();
      e.stopImmediatePropagation();
      cmdKey(e);
      return;
    }

    // NORMAL / VISUAL: we own the keyboard. Consume everything (so Tab, letters,
    // etc. never reach the bubble-phase Tab handler or type into the buffer).
    handleKey(e);
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // Keep caret legal when focus lands on the textarea while in normal/visual.
  ta.addEventListener("focus", function(){ if(vimOn() && MODE !== "insert") fixCaret(); });

  /* ============================================================================
     TOGGLE BUTTON + localStorage (same flip-flag-then-reapply pattern as edNT)
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
    if(btn) btn.textContent = "vim: " + (vimOn() ? "on" : "off");
  }
  // Global so an explicit template button `onclick="vimToggle()"` can drive it.
  window.vimToggle = function(){
    localStorage.setItem(LS, vimOn() ? "0" : "1");
    MODE = "normal"; reset();
    applyVim();
    ta.focus();
    var stEl2 = document.getElementById("status");
    if(stEl2) stEl2.textContent = "vim " + (vimOn() ? "on" : "off");
  };

  //  The toggle lives on the settings page, which is a SEPARATE document on
  //  this origin, exactly like the font and size preferences. It writes the
  //  flag and the storage event brings it here, so no button is injected into
  //  the bar (which is managed markup now).
  var btn = document.getElementById("vimToggle");
  if(btn) btn.onclick = window.vimToggle;
  window.addEventListener("storage", function(e){
    if(!e.key || e.key === LS) applyVim();
  });

  // Persist an explicit default of OFF on first run.
  if(localStorage.getItem(LS) === null) localStorage.setItem(LS, "0");
  applyVim();
})();

// ── src/30-tree.js ────────────────────────────────────────────────────────
  // ── tree pane: <lat-tree> ────────────────────────────────────────────────
  // The pane's buttons are wired where their handlers live (45-templates,
  // 70-upload). Those files run after this component upgrades, so their
  // $-lookups find the rendered elements.
  let treeList;
  customElements.define('lat-tree', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<aside class="tree" id="tree">
  <div class="newbtns">
    <button class="nf" id="newfile">+ file</button>
    <button class="nf" id="newfolder">+ folder</button>
    <button class="nf" id="newtmpl">+ template</button>
  </div>
  <div class="newbtns">
    <button class="nf" id="upfiles">&#8613; files</button>
    <button class="nf" id="updir">&#8613; dir</button>
  </div>
  <input type="file" id="fpick" multiple hidden>
  <input type="file" id="dpick" webkitdirectory hidden>
  <input type="file" id="vpick" accept=".tar,application/x-tar" hidden>
  <div id="uppanel" class="uppanel" hidden>
    <div id="upmsg"></div>
    <div class="upbar"><div id="upfill"></div></div>
    <div id="uperr" class="uperr"></div>
  </div>
  <div id="chips" class="chips" hidden></div>
  <div class="sec" id="treesec">files</div>
  <div id="treelist"></div>
</aside>`;
      treeList = $('treelist');
    }
  });
  // stale-shell guard: swap a cached pre-component shell's literal pane
  if (!document.querySelector('lat-tree')) {
    const stale = document.getElementById('tree');
    if (stale) stale.remove();
    const el = document.createElement('lat-tree');
    el.style.display = 'contents';
    document.getElementById('ws').appendChild(el);
  }
  // page-dump, not page-tree: it returns the same nodes PLUS every page's body
  // inline from ONE deep peek, and measures FASTER than page-tree (which
  // re-peeks each code grub). Those bodies are what make opening a page cost
  // zero requests. See openPage. Bodies over 256KB are omitted by the server.
  // Such a node has no `body` and falls back to the per-page fetch.
  // ponytail: whole-store payload (~55KB today). If the tree ever grows past
  // a megabyte, page it or go back to page-tree plus a lazy body cache.
  async function loadTree() {
    const gen = treeGen;
    const r = await fetch(api + '/page-dump');
    if (!r.ok) { st('tree failed ' + r.status, false); return; }
    const d = await r.json();
    if (gen !== treeGen) return;   // a local patch superseded this response
    nodes = d.nodes;
    // drop only the cached renders the dump says have moved FORWARD. Blanket-
    // clearing on every change cost every other page its cache. Comparing
    // for mere inequality evicted good entries whenever the dump trailed
    // page-source by a revision, which it does right after a write (the
    // evaluator settles after the writer).
    for (const [name, c] of pageCache) {
      const n = nodes.find((x) => x.page && x.path === name);
      if (!n || (typeof n.rev === 'number' && n.rev > c.rev)) pageCache.delete(name);
    }
    snapTree();
    renderTree();
  }

  // selection changes only move the `cur` class. Never rebuild the pane's DOM
  // for that. rowByPath is rebuilt by renderTree/renderKnowTree.
  let rowByPath = new Map();
  function markCurrent() {
    for (const [p, row] of rowByPath)
      row.classList.toggle('cur',
        row.classList.contains('pg') ? p === current : p === curFolder);
  }

  // local `nodes` patching: this client performed the write, so it already
  // knows the outcome. Applying it locally replaces a page-tree refetch.
  const hasNode = (path) => nodes.some((n) => n.path === path);
  function addFolderNodes(path) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!hasNode(dir)) nodes.push({ path: dir, page: false });
    }
  }
  function addTreeNode(name, kind) {
    if (name.includes('/')) addFolderNodes(name.slice(0, name.lastIndexOf('/')));
    const n = nodes.find((x) => x.path === name && x.page);
    if (n) n.kind = kind;
    else nodes.push({ path: name, page: true, kind, share: 'private' });
  }
  function dropTreeNodes(path) {
    nodes = nodes.filter((n) => n.path !== path && !n.path.startsWith(path + '/'));
  }

  function renderTree() {
    const coll = collapsed();
    const byPath = [...nodes].sort((a, b) => a.path.localeCompare(b.path));
    treeList.textContent = '';
    rowByPath = new Map();
    for (const n of byPath) {
      const depth = n.path.split('/').length - 1;
      const parent = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
      const hidden = coll.some((c) => n.path === c ? false : n.path.startsWith(c + '/'));
      const row = document.createElement(n.page ? 'a' : 'div');
      row.style.marginLeft = (depth * 14) + 'px';
      if (hidden) row.style.display = 'none';
      if (n.page) {
        row.className = 'pg' + (n.path === current ? ' cur' : '');
        row.href = '/apps/lattice/app?name=' + encodeURIComponent(n.path);
        row.textContent = n.path.split('/').pop() + '.' + extOf(n.kind);
        row.onclick = (e) => { e.preventDefault(); openPage(n.path); };
      } else {
        row.className = 'fld' + (n.path === curFolder ? ' cur' : '');
        const cx = document.createElement('span');
        cx.className = 'cx';
        cx.textContent = coll.includes(n.path) ? '▸' : '▾';
        cx.onclick = (e) => {
          e.stopPropagation();
          const c = collapsed();
          const i = c.indexOf(n.path);
          if (i >= 0) c.splice(i, 1); else c.push(n.path);
          setCollapsed(c);
          renderTree();
        };
        const label = document.createElement('span');
        label.textContent = '\u{1F4C1} ' + n.path.split('/').pop();
        row.append(cx, label);
        if (treeShare(n.path) === 'clearweb') {
          const cw = document.createElement('span');
          cw.className = 'cw';
          cw.textContent = '\u{1F310}';
          cw.title = n.path + ' is clearweb public';
          row.append(cw);
        }
        const add = document.createElement('a');
        add.className = 'addf';
        add.textContent = '+';
        add.title = 'new file in ' + n.path;
        add.href = '#';
        add.onclick = (e) => { e.preventDefault(); e.stopPropagation(); newFile(n.path); };
        row.append(add);
        row.onclick = () => selectFolder(n.path);
      }
      rowByPath.set(n.path, row);
      treeList.appendChild(row);
    }
    // the conflict badge is a count of conflicts/ pages in this very tree, so
    // it repaints exactly when the tree does. Defined in 80-conflicts.js.
    if (typeof renderConfBadge === 'function') renderConfBadge();
  }

  const extOf = (kind) => ({ md: 'md', gmi: 'gmi', html: 'html', text: 'txt',
                             js: 'js', css: 'css', index: 'md' }[kind] || 'hoon');

  // ── folder selection ─────────────────────────────────────────────────────
  // A folder's share state is derived from its pages: uniform → that mode,
  // differing → 'mixed', empty → 'private'.
  const treeShare = (path) => {
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

  function selectFolder(path) {
    current = null;
    curFolder = path;
    curKind = null;
    exitRev();
    $('histsec').hidden = true;
    $('linksec').hidden = true;
    folderCtx = path;
    pname.value = path;
    pname.readOnly = true;
    src.value = '';
    render();
    prevBlank();
    cerr.textContent = ' '; cerr.className = 'ok';
    history.replaceState(null, '', '/apps/lattice/app?into=' + encodeURIComponent(path));
    markCurrent();
    setCtlLabels();
    showShare(treeShare(path));
    const c = pageCount(path);
    st('folder · ' + c + ' page' + (c === 1 ? '' : 's'));
  }

// ── src/35-pages.js ───────────────────────────────────────────────────────
  // ── open / new / save ────────────────────────────────────────────────────
  const setFolderCtx = (name) =>
    { folderCtx = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''; };

  // Opening a page should cost nothing. Three tiers, cheapest first:
  //   1. seen this session -> pageCache has the rendered answer: 0 requests.
  //   2. body came with the tree dump -> paint the editor NOW, then fetch
  //      render=1 only to fill in `share` and the preview.
  //   3. no body (oversized page, or a tree we never loaded) -> as before.
  // History and backlinks stay lazy on panel expand. They were 2 more ~2s
  // round-trips paid on every open whether or not anyone looked at them.
  // Which open is current. Opening a page is an explicit user act, so the ONLY
  // reason to discard a landed response is that the user opened something else
  // while it was in flight, not that the editor was dirty, and not that
  // `current` had not been set yet. Guarding on those meant an explicit open
  // was silently dropped. After an unsaved edit, clicking another file did
  // nothing, and a page absent from the local tree never applied at all.
  let openSeq = 0;
  async function openPage(name) {
    const my = ++openSeq;
    // leaving grub mode: clear the flag or the save button would keep writing
    // to the grub while the editor shows a page
    grubPath = null;
    src.readOnly = false;
    setFolderCtx(name);
    // the queue outranks every other tier. A queued edit is the newest truth
    // for this page whether or not the ship is reachable right now
    const q = await offGet(name);
    if (q) {
      const d = { body: q.body, kind: q.kind, rev: q.baseRev || 0, share: 'private' };
      applyPage(name, d, true);
      snapPage(name, d);
      return;
    }
    const hit = pageCache.get(name);
    if (hit) { applyPage(name, hit); snapPage(name, hit); return; }
    const node = nodes.find((n) => n.page && n.path === name);
    const painted = !!node && typeof node.body === 'string';
    // `quiet`: the render=1 request below carries the preview and the error
    // report, so painting must not also fire refreshPreview/checkErrors.
    if (painted) {
      applyPage(name, node, true);
      // snapshot NOW, not only after the render fetch below. The snapshot is
      // what a bare launch (the PWA) resumes from, and a session that ends
      // during the fetch would otherwise remember nothing. The fetch's
      // snapPage upgrades this with the rendered html when it lands.
      snapPage(name, node);
    }
    // What the editor shows as the fetch leaves. When `painted`, the open has
    // already visibly happened and the fetch below is an UPGRADE (share, the
    // rendered html) — not the open itself.
    //
    // When NOT painted (a body the dump did not carry), the user just clicked
    // and nothing changed on screen — on a slow pier that silence lasts
    // seconds and reads as a dead click. Say the open is happening; every
    // exit below already replaces this status.
    if (!painted) stWork('opening ' + name + '\u2026');
    const shown = src.value;
    let d = null;
    try {
      const r = await fetch(api + '/page-source?name=' + encodeURIComponent(name) + '&render=1');
      if (!r.ok) { if (!painted) st('open failed ' + r.status, false); return; }
      d = await r.json();
    } catch { if (!painted) st('open failed', false); return; }
    // a later openPage supersedes this one. Anything else still applies
    if (my !== openSeq) return;
    // An upgrade of an ALREADY-PAINTED open must never clobber keystrokes
    // typed while it was in flight. On a busy pier this fetch lands many
    // seconds after the paint, and it carries the PRE-edit body: applying it
    // replaced what you just typed, and the next autosave wrote that stale
    // text back over the good save. The editor ate work the ship had.
    //
    // Compared by TEXT, not by `dirty`: autosave clears dirty inside this very
    // window, which is how the old dirty-guards kept failing to catch it.
    // The !painted arm stays unconditional on purpose — there the fetch IS the
    // open, and an explicit open must always land (see the head comment).
    if (painted && src.value !== shown) return;
    // Cache and snapshot BELOW the guards, not above. A stale or superseded
    // response that reached the cache here poisoned it with the pre-edit body:
    // the guard protected the editor but not the cache, so switching away and
    // back repainted the old text — the same data loss through a different
    // door. Only a response that is actually applied may be remembered.
    pageCache.set(name, d);
    snapPage(name, d);
    applyPage(name, d);
  }
  function applyPage(name, d, quiet) {
    current = name;
    curFolder = null;
    setCtlLabels();
    pname.value = name;
    pname.readOnly = true;
    curKind = d.kind;
    curRev = d.rev || 0;
    if (LMAP[d.kind] || d.kind === 'text') pkind.value = d.kind === 'text' ? 'text' : d.kind;
    src.value = d.body;
    dirty = false;
    // A fresh editor state begins here. everTyped answers "did the user type
    // since this view was established?" for boot's reconcile guard; carrying
    // it across a navigation would mark every later untouched page as touched.
    everTyped = false;
    render(); sync();
    history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
    markCurrent();
    st(d.kind + ' · rev ' + d.rev);
    exitRev();
    resetPanels();
    showShare(d.share || 'private');
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
    if (typeof d.html === 'string') { prev.removeAttribute('src'); prev.srcdoc = d.html; }
    else if (!quiet) refreshPreview();
    // A quiet open is the COMMON one: the tree dump already carried the body,
    // so the editor painted instantly and the render=1 fetch is an upgrade.
    // refreshPreview is suppressed there to avoid a second render — but that
    // left the PREVIEW alone on the pier, still showing the document you just
    // navigated away from until the fetch landed. That is the "previews are
    // slow" report: the editor was never slow, the pane beside it was.
    // Paint locally now; the fetch still corrects it when it arrives.
    else paintLocal();
    if (!CONTENT() && !quiet) checkErrors();
    if (isMobile()) setMv('code');
  }

  // focusName: only when the USER asked for a new file. Boot calls this to
  // land on an empty page, and focusing the name field there summons the
  // phone keyboard before you have done anything. You arrive at the app
  // already typing a filename you did not ask to type.
  function newFile(into, focusName = true) {
    folderCtx = into || '';
    current = null;
    curFolder = null;
    curKind = null;
    exitRev();
    $('histsec').hidden = true;
    $('linksec').hidden = true;
    setCtlLabels();
    pname.readOnly = false;
    pname.value = into ? into + '/' : '';
    src.value = '';
    dirty = false;
    everTyped = false;   // a new file is a fresh editor state, like applyPage
    render();
    history.replaceState(null, '', '/apps/lattice/app');
    renderTree();
    if (focusName) pname.focus();
    st('new page — name it, write, save');
    prevBlank();
    showShare('private');
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
  }

  async function newFolder() {
    const raw = await ask('folder name (e.g. notes or notes/sub)',
      folderCtx ? folderCtx + '/' : '', 'create');
    if (!raw) return;
    const name = raw.trim().replace(/^\/+|\/+$/g, '');
    if (!name) return;
    const r = await mutate(api + '/folder-new?name=' + encodeURIComponent(name));
    if (!r.ok) { st('folder failed ' + r.status, false); return; }
    st('folder created');
    addFolderNodes(name);
    snapTree();
    renderTree();
  }

  async function save(kindOverride) {
    if (curFolder) { st('folder selected — open a page to edit', false); return; }
    if (viewingRev !== null) { st('viewing rev ' + viewingRev + ' — use restore', false); return; }
    const name = pname.value.trim().replace(/^\/+|\/+$/g, '');
    if (!name) { st('name required', false); return; }
    const creating = current === null;
    if (saving) { savePending = true; return; }
    saving = true;
    st('saving…');
    // capture the exact body being sent: keystrokes landing during the round-trip
    // must NOT be marked clean, or the next refresh swaps the stale server copy
    // in and the typed text is lost (same guard autosave has always had).
    const sent = src.value;
    const kind = kindOverride || curKind || pkind.value;
    // NO base on live saves, deliberately: base is the OFFLINE queue's tool,
    // where the divergence window is real. Online, any dirty-blocked refresh
    // or panel-driven save can leave curRev one step behind, and every stale
    // base manufactures a false conflict page out of nothing (ui-matrix
    // caught exactly that). Online editing stays last-writer-wins.
    const url = api + '/page-save?name=' + encodeURIComponent(name) +
      '&type=' + kind + (creating ? '&new=1' : '');
    let r = null;
    //  a save is user activity even when it arrives by hotkey or autosave,
    //  so the background lane (bgFetch) holds its traffic out of its way
    lastAction = Date.now();
    const sentAt = Date.now();
    try { r = await tfetch(url, { method: 'POST', body: sent || '\n' }); }
    catch {}
    finally {
      saving = false;
      //  the echo window covers OUR OWN beacon bump. A fixed 4s assumed the
      //  bump lands promptly; on a queued pier it arrives after the save's
      //  own round trip again, so scale the window to what the pier just
      //  showed us. Too short meant refetching the page we just wrote —
      //  two more pier requests to learn nothing.
      echoUntil = Date.now() + Math.max(4000, 2 * (Date.now() - sentAt));
    }
    if (shipGone(r)) {
      // the ship is unreachable. Queue the edit and complete the save's
      // LOCAL bookkeeping exactly as a successful save would, so the editor
      // does not care which kind it got
      // A failed queue write means this edit exists ONLY in the textarea.
      // Clearing dirty there would tell the editor the work is safe and let
      // the next navigation drop it, so the bookkeeping stays untouched and
      // the page keeps behaving as unsaved. enqueueSave has already said so.
      if (!(await enqueueSave(name, kind, sent, creating))) {
        cerr.textContent = 'NOT saved'; cerr.className = 'err';
        return;
      }
      current = name;
      curKind = kind;
      pname.readOnly = true;
      if (src.value === sent) dirty = false;
      history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
      if (creating) { addTreeNode(name, kind); snapTree(); renderTree(); }
      cerr.textContent = 'saved offline'; cerr.className = 'ok';
      if (savePending) { savePending = false; if (dirty) autosave(); }
      return;
    }
    if (r && r.status === 409) { st('that page already exists', false); return; }
    if (!r || !r.ok) { st('save failed' + (r ? ' ' + r.status : ''), false); return; }
    pendingEchoes++;                  // this save's own beacon bump
    current = name;
    curKind = kind;
    pname.readOnly = true;
    if (src.value === sent) dirty = false;
    // the response carries the new revision (no re-read needed) and whether
    // this save landed on top of a revision made elsewhere
    let vr = null;
    try { vr = await r.json(); } catch {}
    if (vr && vr.rev) curRev = vr.rev;
    if (vr && vr.conflicted) {
      st('saved — replaced an edit from elsewhere; it is kept at ' + vr.kept, false);
    } else st(CONTENT() ? 'saved' : 'compiling\u2026');
    history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
    // only a CREATE changes the tree. Refetching it after every save was a
    // 2.3s pier round-trip to learn nothing. Patch the local copy on create.
    if (creating) { addTreeNode(name, kind); snapTree(); renderTree(); }
    // we know exactly what we just wrote. Patch the local copies so reopening
    // this page paints the saved text, not the dump's pre-save body. The
    // cached render is stale by definition. Drop it and let it re-render.
    pageCache.delete(name);
    const nd = nodes.find((n) => n.page && n.path === name);
    if (nd) { nd.body = sent; nd.kind = kind; persistTree(); }
    // the preview already shows this exact body (the input debounce rendered
    // it). Re-POSTing it after the save was a duplicate 1.8s render.
    if (CONTENT()) { cerr.textContent = 'saved'; cerr.className = 'ok'; }
    else { setTimeout(checkErrors, 800); setTimeout(checkErrors, 2200); }
    if (savePending) { savePending = false; if (dirty) autosave(); }
    if (offCount) replayQueue();     // back online: drain the backlog
  }

  let autoTimer = null;
  async function autosave() {
    // GRUB MODE IS EXPLICIT-SAVE ONLY. Autosaving a lattice page is fine. It is
    // your own note and the editor has always worked that way. Autosaving
    // another app's source is not. A half-typed edit to calendar.html would go
    // live 2s after you paused, and the 5-minute history window may not have
    // kept a revision fine-grained enough to step back to. Save/Cmd+S only.
    // The 2s debounce still fires. It just reports instead of writing, so the
    // moment you stop typing you can see the edit is not yet on the ship.
    if (grubPath) { if (dirty) st('unsaved — press Save or Cmd+S'); return; }
    if (!current || curFolder || !dirty || viewingRev !== null) return;
    // never overlap saves. The pier serializes, so a second in-flight save is
    // 3.7s of stale-body work queued behind the first, delaying every preview
    // behind it. Coalesce to one trailing save instead.
    if (saving) { savePending = true; return; }
    saving = true;
    const sent = src.value;
    const url = mode === 'know'
      ? api + '/know-save?key=' + encodeURIComponent(current)
      : api + '/page-save?name=' + encodeURIComponent(current) +
        '&type=' + (curKind || pkind.value);
    let r = null;
    lastAction = Date.now();       // saves are user activity (see above)
    const sentAt = Date.now();
    try { r = await tfetch(url, { method: 'POST', body: sent || '\n' }); } catch {}
    saving = false;
    echoUntil = Date.now() + Math.max(4000, 2 * (Date.now() - sentAt));  // see above
    if (r && r.ok) pendingEchoes++;   // this save's own beacon bump
    if (shipGone(r)) {
      //  same rule on the autosave path: if it did not queue, it is not saved,
      //  so the editor stays dirty and keeps the text under the cursor
      if (mode === 'know') {
        if (!(await enqueueKnow(current, sent))) return;
        if (src.value === sent) dirty = false;
        if (savePending) { savePending = false; if (dirty) autosave(); }
        return;
      }
      if (!(await enqueueSave(current, curKind || pkind.value, sent))) return;
      if (src.value === sent) dirty = false;
      if (savePending) { savePending = false; if (dirty) autosave(); }
      return;
    }
    if (!r || !r.ok) { st('autosave failed' + (r ? ' ' + r.status : ''), false); return; }
    if (src.value === sent) dirty = false;   // typed during the request? stay dirty
    let vr = null;
    if (mode !== 'know') {
      try { vr = await r.json(); } catch {}
      if (vr && vr.rev) curRev = vr.rev;
    }
    if (mode !== 'know') {
      pageCache.delete(current);
      const nd = nodes.find((n) => n.page && n.path === current);
      if (nd) { nd.body = sent; persistTree(); }
    }
    // the conflict verdict must be the LAST word, not clobbered by the
    // ordinary confirmation a line later
    if (vr && vr.conflicted)
      st('autosaved — replaced an edit from elsewhere; it is kept at ' + vr.kept, false);
    else st('autosaved');
    if (mode !== 'know' && !CONTENT()) setTimeout(checkErrors, 800);
    if (savePending) { savePending = false; if (dirty) autosave(); }
  }

// ── src/40-grub.js ────────────────────────────────────────────────────────
  // ── editing an arbitrary grub (?grub=<ball path>) ────────────────────────
  // Any file in the ball, not just a lattice page: an app's html/js/css/hoon.
  // Deliberately NOT a third setMode branch. That function is wired into the
  // tree, kind picker, chips and history panes, and a third mode would mean
  // touching every one of them. This is a thin overlay: same textarea and save
  // button, its own two endpoints.
  let grubPath = null;
  let grubShip = null;   // '~ship' when the grub lives on ANOTHER ship; null = local
  async function openGrub(p, ship) {
    grubPath = p;
    grubShip = ship || null;
    current = null;
    curFolder = null;
    pname.value = (grubShip ? grubShip + ' ' : '') + p;
    pname.readOnly = true;
    $('histsec').hidden = true;
    $('linksec').hidden = true;
    st('loading ' + p + '…');
    // remote files ride /browse-file (bounded cross-ship peek). Its JSON says
    // body/mark where grub-source says text/blot. Normalize here, not there,
    // since both routes have other consumers.
    const url = grubShip
      ? api + '/browse-file?ship=' + encodeURIComponent(grubShip) + '&path=' + encodeURIComponent(p)
      : api + '/grub-source?path=' + encodeURIComponent(p);
    let r = null;
    try { r = await fetch(url); } catch {}
    if (!r || !r.ok) { st('could not open ' + p + (r ? ' (' + r.status + ')' : ''), false); return; }
    const d = await r.json();
    src.value = d.text || d.body || '';
    // a binary/opaque grub has no text form. Show it, never offer to save it
    src.readOnly = !d.editable;
    dirty = false;
    render();
    const blot = d.blot || d.mark || '';
    st(!d.editable ? 'read-only — ' + blot + ' has no text form'
       : grubShip ? 'remote grub on ' + grubShip + ' — saves need their permission'
       : 'grub ' + blot);
  }
  async function saveGrub() {
    if (!grubPath || src.readOnly) return;
    if (saving) { savePending = true; return; }
    saving = true;
    st('saving…');
    const sent = src.value;
    let r = null;
    try {
      // a remote save is verified server-side by revision bump. A peer that
      // never granted make ACKS the poke and silently drops the write, and
      // "saved" on a dropped write is the one lie an editor must not tell.
      r = await fetch(grubShip
        ? api + '/remote-save?ship=' + encodeURIComponent(grubShip) +
          '&path=' + encodeURIComponent(grubPath)
        : api + '/grub-save?path=' + encodeURIComponent(grubPath),
        { method: 'POST', body: sent });
    } catch {}
    saving = false;
    if (!r || !r.ok) {
      // the mark can reject the source. Show ITS error, since the stored grub
      // still holds the previous content and the user needs to know why
      let msg = r ? ' ' + r.status : '';
      if (r) { try { const j = await r.json(); if (j && j.error) msg = ': ' + j.error; } catch {} }
      st('save rejected' + msg, false);
      return;
    }
    if (src.value === sent) dirty = false;
    st('saved');
    if (savePending) { savePending = false; if (dirty) saveGrub(); }
  }

// ── src/45-templates.js ───────────────────────────────────────────────────
  $('save').onclick = () =>
    (grubPath ? saveGrub() : mode === 'know' ? saveKnow() : save());
  // ── new page-tree from a template ────────────────────────────────────────
  // Templates stamp out a whole tree (the `site` template is four pages), and
  // each page is its own writer round-trip, so this is deliberately slow and
  // says so. Instantiation rewrites the template's self-references to the name
  // you choose.
  async function newFromTemplate() {
    let names = [];
    try {
      const r = await fetch(api + '/template-list');
      if (r.ok) names = (await r.json()).templates || [];
    } catch {}
    if (!names.length) { st('no templates available', false); return; }
    const tmpl = await askChoice('start from which template?', names, 'next');
    if (!tmpl) return;
    const raw = await ask('name for the new ' + tmpl,
      folderCtx ? folderCtx + '/' + tmpl : tmpl, 'create');
    if (!raw) return;
    const name = raw.trim().replace(/^\/+|\/+$/g, '');
    if (!name) return;
    stWork('creating ' + name + ' from ' + tmpl + '\u2026 (one save per page)');
    let r = null;
    try {
      r = await mutate(api + '/template-new?template=' + encodeURIComponent(tmpl) +
        '&name=' + encodeURIComponent(name));
    } catch {}
    if (r && r.status === 409) { st('a page by that name exists', false); return; }
    if (!r || !r.ok) { st('template failed' + (r ? ' ' + r.status : ''), false); return; }
    await loadTree();
    // a multi-page template lands as a folder. Open its index if it made one,
    // else the page itself, else just select the new folder.
    const has = (p) => nodes.some((n) => n.page && n.path === p);
    if (has(name)) await openPage(name);
    else if (has(name + '/index')) await openPage(name + '/index');
    else if (nodes.some((n) => !n.page && n.path === name)) selectFolder(name);
    st('created ' + name + ' from ' + tmpl);
  }
  $('newtmpl').onclick = newFromTemplate;
  $('newfile').onclick = () => newFile('');
  $('newfolder').onclick = newFolder;
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      // grubPath first: it is the only mode with no `current`, and page save()
      // would write to the wrong place (or nowhere) while a grub is open.
      // Cmd+S matters more here than elsewhere, since grub mode has no autosave.
      if (grubPath) saveGrub();
      else if (mode === 'know') saveKnow();
      else save();
    }
  });
  // Applies the list-continuation edit if the caret is in a list. Shared by
  // the keydown path and the beforeinput path below, which is the ONLY one a
  // phone reliably takes.
  // prose kinds get list behaviour; anything else is code, where "- " and
  // "1." are just characters. know memories are prose, so markdown rules.
  const proseFlavor = () => {
    if (mode === 'know') return 'md';
    return ['md', 'text', 'gmi'].includes(pkind.value) ? pkind.value : null;
  };
  // Apply a {from, to, text, caret} edit from the pure list functions.
  // execCommand keeps the textarea's OWN undo stack, so Ctrl+Z steps back
  // through these edits like any typing. Assigning src.value wipes that
  // stack outright (the old Tab handler's sin). Deprecated, not gone, and
  // there is no replacement that preserves undo; setRangeText is the
  // fallback when an engine refuses.
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
  // A soft keyboard usually does NOT report Enter as a keydown. Android and
  // GBoard send keyCode 229 (or key "Unidentified") because the IME owns the
  // composition, so the keydown branch below never matched and lists simply
  // did not continue on a phone. beforeinput carries insertLineBreak on every
  // engine that matters, which is why the real handler hangs off it too.
  //
  // On a desktop press keydown gets there first and calls preventDefault,
  // which cancels beforeinput, so exactly one of these two ever fires.
  src.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;
    // the autocomplete owns Enter while it is open, as on the keydown path
    if (ac.open) return;
    if (plainBreak) { plainBreak = false; return; }
    if (continueList()) e.preventDefault();
  });
  src.addEventListener('keydown', (e) => {
    // autocomplete owns these keys while it is open
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
    // Smart list continuation. Prose kinds only: a "- " in a hoon or js file is
    // not a list item. Shift+Enter is the deliberate escape hatch, and it is
    // also what the browser gives a user who wants a plain newline.
    //
    // A modifier here means "just break the line", and the beforeinput handler
    // below has no modifier state of its own, so record the decision for it.
    if (e.key === 'Enter') plainBreak = e.shiftKey || e.metaKey || e.ctrlKey || e.altKey;
    if (e.key === 'Enter' && !plainBreak && continueList()) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (src.readOnly) return;   // readOnly blocks typing, not scripted edits
      // On a list line, Tab is structure, not whitespace: indent the item a
      // level, Shift-Tab brings it back out. A multi-line selection moves
      // every list line in it together.
      const flavor = proseFlavor();
      if (flavor) {
        const r = listTab(src.value, src.selectionStart, src.selectionEnd,
          flavor, e.shiftKey ? -1 : 1);
        if (r) { applyEdit(r); return; }
      }
      // Shift-Tab outside a list has nothing to take back
      if (e.shiftKey) return;
      applyEdit({ from: src.selectionStart, to: src.selectionEnd,
        text: '  ', caret: src.selectionStart + 2 });
    }
  });

// ── src/55-autocomplete.js ────────────────────────────────────────────────
  // ── wikilink autocomplete ────────────────────────────────────────────────
  // Typing `[[` opens a list of pages from the tree we already hold (no
  // request, no index). Wikilink names are absolute page paths, so a sibling
  // still has to be written in full. Ranking exists to make that cheap.
  const acEl = $('ac'), acMirror = $('acmirror');
  let ac = { open: false, start: -1, items: [], sel: 0 };

  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const segOf = (p) => p.slice(p.lastIndexOf('/') + 1);

  // rank: the last segment matching beats the path matching, a sibling of the
  // page being edited beats a stranger, shallower and shorter break ties.
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

  // caret position, measured through a mirror that shares the textarea's
  // geometry, correct on wrapped lines, where a column calculation is not.
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
  // the full-prefix mirror layout is expensive on large documents, so it runs
  // once per [[ site. While the dropdown stays open only the short query after
  // the anchor changes, and its width comes from measureText, not a relayout.
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
    // keep it inside the editor pane
    const w = src.clientWidth, h = src.clientHeight;
    acEl.style.left = Math.max(4, Math.min(x, w - acEl.offsetWidth - 8)) + 'px';
    acEl.style.top = (y + acEl.offsetHeight > h ? Math.max(4, y - acEl.offsetHeight - 20) : y) + 'px';
  }

  // open only inside an UNCLOSED [[ on the caret's own line
  function acScan() {
    if (src.readOnly || mode === 'know') return acClose();
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
    const before = src.value.slice(0, ac.start);
    const after = src.value.slice(src.selectionStart);
    const tail = after.startsWith(']]') ? after.slice(2) : after;
    src.value = before + path + ']]' + tail;
    const caret = before.length + path.length + 2;
    src.setSelectionRange(caret, caret);
    acClose();
    edited();
  }

  src.addEventListener('input', acScan);
  src.addEventListener('click', acClose);
  src.addEventListener('blur', acClose);

// ── src/59-md.js ──────────────────────────────────────────────────────────
  // ── local markdown, for the live preview only ────────────────────────────
  // The preview POSTs the whole document to the ship and shows what comes
  // back. That is the source-of-truth renderer, which is why it was built that
  // way, and it costs a pier round trip EVERY time you stop typing. Measured
  // against a real ship: 1.36s for an eight byte document and 3.0s for 106 KB.
  // The floor is the pier, not the rendering, so no server-side work fixes it.
  //
  // So: paint this immediately, then let the server's answer replace it when it
  // lands. That ordering is what makes a hand-written renderer acceptable here.
  // It does not have to be perfect or complete, because anything it gets wrong
  // is corrected within a second by the renderer that actually defines the
  // page. It only has to be fast and safe.
  //
  // SAFE MATTERS MORE THAN COMPLETE. The preview iframe is not sandboxed, so
  // its srcdoc runs on the app's own origin. Pages are not all hand-written
  // either: the clipper archives arbitrary web pages. So every character of
  // document text is escaped and NO raw HTML is passed through. A note that
  // contains a <script> tag renders as the text of a script tag here. The
  // server render may choose differently; that is its call to make, and it
  // arrives a moment later.
  const mdEsc = (t) => String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Undo mdEsc. Inline rendering escapes the WHOLE line first, so by the time
  // a URL is captured out of it the entities are already in: a link whose
  // query holds & arrived here as &amp;, and escaping again produced
  // &amp;amp;, which the browser hands back to the server as a literal
  // "&amp;". Wikilinks were worse than cosmetic — [[a&b]] encoded to
  // name=a%26amp%3Bb and opened a page that does not exist.
  //
  // Reverses mdEsc's order: & LAST, or "&amp;lt;" would decode twice.
  const mdUnesc = (t) => String(t)
    .replace(/&quot;/g, '"').replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<').replace(/&amp;/g, '&');

  // Only http(s) and in-page anchors become links. A javascript: or data: href
  // in a clipped page must not become a live link on our origin.
  const mdHref = (u) => {
    // decode, THEN test the scheme: "javascript&#58;" must not sneak past a
    // check run against still-escaped text, and then re-escape for the attr.
    const s = mdUnesc(u).trim();
    return /^(https?:\/\/|urb:\/\/|mailto:|#|\/)/i.test(s) ? mdEsc(s) : '';
  };

  // Code-span placeholders. The token must be UNFORGEABLE by document text:
  // a page that can write the token literally could otherwise smuggle content
  // past the escaper. The trick is that the token contains '&', which mdEsc
  // turns into '&amp;'. A token typed into the document is mangled by the
  // escaper and can never match the restore regex; the only intact tokens are
  // the ones the extractor mints AFTER escaping. Extraction runs on the
  // ESCAPED string: mdEsc does not touch backticks, so code spans are still
  // findable there and their contents are already escaped.
  const CD_RE = /&CD(\d+);/g;
  const mdInline = (t) => {
    let s = mdEsc(t);
    // code first: its (already-escaped) contents must not be re-processed for
    // emphasis. The token is minted now, after the escape, so it survives.
    const code = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      code.push(c);
      return '&CD' + (code.length - 1) + ';';
    });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt, u) => {
      const h = mdHref(u);
      return h ? '<img alt="' + alt + '" src="' + h + '">' : m;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, txt, u) => {
      const h = mdHref(u);
      return h ? '<a href="' + h + '">' + txt + '</a>' : m;
    });
    //  wikilinks, which lattice writes a lot of. The target is a page name, so
    //  it is URI-encoded into the query — a name carrying &, = or quotes must
    //  not smuggle extra params or break out of the href.
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_, tgt, label) => '<a href="'
        + mdHref('/apps/lattice/app?name=' + encodeURIComponent(mdUnesc(tgt).trim())) + '">'
        + (label || tgt) + '</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // restore code spans. They were escaped when the whole string was, so no
    // re-escape here (that would double-escape). Only extractor-minted tokens
    // match; a forged one was mangled to '&amp;CD…;' by the escaper.
    s = s.replace(CD_RE, (_, i) => '<code>' + code[+i] + '</code>');
    return s;
  };

  //  block level. Deliberately a subset: headings, rules, fences, quotes,
  //  lists (including task lists), tables, paragraphs.
  function mdToHtml(input) {
    const lines = String(input == null ? '' : input).split('\n');
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
        out.push('<blockquote>' + mdToHtml(q.join('\n')) + '</blockquote>');
        continue;
      }

      //  a table needs a delimiter row under the header
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
          body = '<input type="checkbox" disabled'
            + (task[1] === ' ' ? '' : ' checked') + '> ' + mdInline(task[2]);
        } else body = mdInline(body);
        out.push('<li>' + body + '</li>');
        i += 1;
        continue;
      }

      if (!ln.trim()) { closeLists(0); i += 1; continue; }

      //  paragraph: consume until a blank line or a block starter
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

  // ── local gemtext, for the live preview only ────────────────────────────
  // Mirrors the ship's render-gmi (app.hoon) so the local paint matches the
  // authoritative one it corrects to: ```-fenced pre, #/##/### headings,
  // => links, > quotes, blank lines dropped, everything else a paragraph.
  // Same safety contract as the markdown above: EVERY line is escaped, links
  // only for urb:// and http(s) (a javascript: => target renders as text).
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
  // ── preview pane: <lat-preview> ──────────────────────────────────────────
  // Content kinds render locally (srcdoc). Computed kinds (hoon,
  // js, css) show the page's live DATA via /f/<name>, refreshed after save/cmd.
  customElements.define('lat-preview', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML =
        // SANDBOXED, and this is load-bearing rather than defensive.
        //
        // The pane renders page content, and an html page is served into it as
        // its own document — including its scripts. Pages are not all
        // hand-written: the clipper archives arbitrary web pages verbatim. On
        // a same-origin frame, opening one of those in the editor ran its
        // JavaScript with this session, which is read every page, rewrite the
        // ACLs, exfiltrate the store. Verified before this line existed: a
        // page containing <script>parent.__PWNED=1</script> set that global on
        // the app and rewrote its title.
        //
        // allow-scripts WITHOUT allow-same-origin is the pair that matters.
        // Scripts still run, so the footnote-anchor handler the ship injects
        // into every server render keeps working, but the frame gets an opaque
        // origin: no parent, no cookies, no session. The two together would
        // hand the sandbox straight back.
        '<iframe class="prev" id="prev" title="live preview" sandbox="allow-scripts"></iframe>';
      prev = $('prev');
      // blank it NOW, not when the first page opens. An iframe with no srcdoc
      // is an opaque white canvas, and the first thing that used to call
      // prevBlank was boot's trailing newFile(). So the pane sat white for
      // the whole load and then popped to the theme background.
      prevBlank();
    }
  });
  // stale-shell guard: swap a cached pre-component shell's literal iframe
  if (!document.querySelector('lat-preview')) {
    const stale = document.querySelector('iframe.prev');
    if (stale) stale.remove();
    const el = document.createElement('lat-preview');
    el.style.display = 'contents';
    document.getElementById('ws').appendChild(el);
  }
  const CONTENT = () => ['md', 'gmi', 'html', 'text'].includes(pkind.value);

  // Paint locally NOW, and let the ship's answer replace it when it arrives.
  //
  // The server render is the source of truth and stays that way. What changed
  // is that it is no longer the ONLY thing that ever fills this pane, because
  // it costs a pier round trip every time: measured against a real ship, 1.36s
  // for an eight byte document and 3.0s for 106 KB. The floor is the pier, not
  // the rendering, so the wait did not shrink with the document and a one line
  // note took as long as a long one.
  //
  // All four content kinds paint locally now. md and gmi run the hand-written
  // renderers (59-md.js) that the ship's answer then corrects. html is its own
  // output, so it srcdocs directly — the one case where local IS authoritative.
  // text is an escaped <pre>. Only the computed kinds (hoon, js, css) still
  // wait on the ship, because their preview is the page's live DATA, not text.
  const localPreviewable = () => ['md', 'gmi', 'html', 'text'].includes(pkind.value);
  const localHtml = (kind, body) => {
    if (kind === 'md') return mdToHtml(body);
    if (kind === 'gmi') return gmiToHtml(body);
    if (kind === 'text') return '<pre>' + mdEsc(body) + '</pre>';
    return body;   // html: the document is already its own rendering
  };
  const paintLocal = () => {
    if (!localPreviewable() || document.hidden) return;
    if (isMobile() && ws.dataset.mv !== 'prev') return;
    try {
      // html pages own their whole document, chrome and all. The content kinds
      // get the same bare shell the markdown preview always used.
      if (pkind.value === 'html') { prev.srcdoc = src.value; return; }
      // color-scheme belongs on :root, not body — on body it does not reach the
      // canvas, so the frame painted opaque WHITE in dark theme. That was true
      // of every local paint since it landed and went unseen because only the
      // BLANK pane was ever checked for theme; wiring this into the open path
      // is what finally put it on screen. Backgrounds match prevBlank exactly,
      // so a document appearing cannot flash a different colour than the empty
      // pane it replaces.
      prev.srcdoc = '<!doctype html><meta charset="utf-8">'
        + '<style>:root{color-scheme:light dark}'
        + 'body{margin:0;padding:14px;font:15px/1.6 system-ui,sans-serif;background:#fafafa}'
        + '@media(prefers-color-scheme:dark){body{background:#1a1a1a}}'
        + 'img{max-width:100%}pre{overflow-x:auto}'
        + 'table{border-collapse:collapse}td,th{border:1px solid #8886;padding:.3em .5em}'
        + '</style>' + localHtml(pkind.value, src.value);
    } catch {}
  };

  let prevTimer = null;
  async function refreshPreview() {
    // a hidden pane renders to nobody, but the POST still costs ~2s of pier
    // time and delays the autosave queued behind it (worst on mobile, where
    // the code tab hides the preview entirely).
    if (document.hidden) return;
    if (isMobile() && ws.dataset.mv !== 'prev') return;
    if (CONTENT()) {
      // Paint locally FIRST, on every path into this function, not just while
      // typing. The local render used to hang off the input event alone, so
      // typing was instant and everything else — opening a page, switching to
      // the preview pane, restoring a revision, a sync — still sat on the pier
      // for its first frame. That is the slow case people actually report,
      // because you open a document far more often than you type the first
      // character into one. src.value is already the new body at every call
      // site (applyPage sets it well before it calls here), so this paints the
      // document that is about to be rendered, not the one leaving the screen.
      // ...and the local paint IS the preview. The pier's "correcting"
      // render is gone: every content kind here (CONTENT ≡ md/gmi/html/text)
      // has a client renderer, and posting the whole document so the ship's
      // renderer could overrule ours cost ~2s of serial pier time per save
      // to fix divergence that would be a renderer BUG, not a runtime
      // condition — the boot snapshot has always trusted the local render.
      // Computed kinds (hoon, js, css) take the /f/ branch below: their
      // preview is the page's live data, which no client renderer can know.
      paintLocal();
    } else if (current) {
      prev.removeAttribute('srcdoc');
      prev.src = api + '/f/' + current + '?t=' + Date.now();
    }
  }
  let localTimer = null;
  src.addEventListener('input', () => {
    if (!CONTENT()) return;
    // local first, on a delay short enough to feel like typing
    clearTimeout(localTimer);
    localTimer = setTimeout(paintLocal, 60);
    // The authoritative render is now RARE, not merely less frequent.
    //
    // Every one of these is a POST of the WHOLE document to the ship. At 400ms
    // a long note re-uploaded itself after every pause in typing, previews
    // queued behind each other on a pier that serialises, and the autosave
    // queued behind those. Moving it to 1200ms made that less bad while
    // keeping the shape of the mistake: the file went over the wire again and
    // again to render text that had barely changed.
    //
    // Ten seconds of quiet, and only then. While you are actually typing the
    // ship sees nothing at all, and the pane is driven entirely by the local
    // render. This is a preview correcting itself, not a live feed.
    clearTimeout(prevTimer);
    prevTimer = setTimeout(refreshPreview, 10000);
  });

  // ── compile errors (hoon pages) ──────────────────────────────────────────
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
      // clear the STATUS too, not just the error box. save() sets
      // 'compiling…' for computed kinds and only checkErrors can resolve it,
      // so without this every hoon/js/css page sat at "compiling…" forever
      // and looked wedged when it had in fact compiled fine.
      if (!CONTENT()) st('compiled ok');
      refreshPreview();
    }
  }

// ── src/65-ctl.js ─────────────────────────────────────────────────────────
  // ── controls pane: <lat-ctl> frame ───────────────────────────────────────
  // Renders the pane skeleton with one tag per panel. The panel components
  // (lat-knowtags 68, lat-share 66, lat-history/lat-links 77) upgrade when
  // NB: no lat-perms. Group EDITING lives in the full-window ACL pane now.
  // This column only points existing groups at the open file (66-share).
  // their own files run, in file order. Button handlers wired below in this
  // file (and in later files) find their elements because the frame renders
  // here first.
  let cerr;
  customElements.define('lat-ctl', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<aside class="ctl">
  <h3>status</h3>
  <div id="cerr" class="ok">&nbsp;</div>
  <lat-knowtags></lat-knowtags>
  <lat-share></lat-share>
  <lat-shared></lat-shared>
  <lat-history></lat-history>
  <lat-links></lat-links>
  <button id="mv" class="mvbtn">move / rename</button>
  <button id="del" class="del">delete page</button>
  <button id="vault" class="mvbtn" title="download every page and memory as one tar">export vault</button>
  <button id="vrestore" class="mvbtn" title="restore pages and memories from a vault tar">restore vault</button>
</aside>`;
      cerr = $('cerr');
    }
  });
  // stale-shell guard: swap a cached pre-component shell's literal pane
  if (!document.querySelector('lat-ctl')) {
    const stale = document.querySelector('aside.ctl');
    if (stale) stale.remove();
    const el = document.createElement('lat-ctl');
    el.style.display = 'contents';
    document.getElementById('ws').appendChild(el);
  }

  // NB: the command box is gone from this panel. It POSTed to /page-cmd, the
  // input channel for a programmable page. The ROUTE stays, since public form
  // submissions (POST /f/<page>) go through the same handler, but nothing in
  // the editor sends to it now.

  // ── delete ───────────────────────────────────────────────────────────────
  $('del').onclick = async () => {
    if (mode === 'know') { deleteKnow(); return; }
    if (curFolder) {
      const path = curFolder;
      const c = pageCount(path);
      const what = 'delete folder ' + path +
        (c ? ' and the ' + c + ' page' + (c === 1 ? '' : 's') + ' under it?' : '?');
      if (!(await askConfirm(what, 'delete'))) return;
      const r = await mutate(api + '/page-del?name=' + encodeURIComponent(path));
      if (!r.ok) { st('delete failed ' + r.status, false); return; }
      dropTreeNodes(path);
      snapTree();
      newFile('');
      st('deleted ' + path);
      return;
    }
    if (!current) { st('nothing to delete', false); return; }
    if (!(await askConfirm('delete ' + current + '?', 'delete'))) return;
    const doomed = current;
    const r = await mutate(api + '/page-del?name=' + encodeURIComponent(doomed));
    if (!r.ok) { st('delete failed ' + r.status, false); return; }
    dropTreeNodes(doomed);
    snapTree();
    newFile('');
    st('deleted');
  };

// ── src/66-share.js ───────────────────────────────────────────────────────
  // ── sharing panel: <lat-share> (pages and folder trees share it) ─────────
  let cwurl;
  customElements.define('lat-share', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="sharesec">
<h3>sharing</h3>
<div class="share" id="share">
  <button data-m="private">private</button>
  <button data-m="shared">shared</button>
  <button data-m="clearweb">clearweb</button>
</div>
<div id="cwurl" class="muted"></div>
<h3>give a ship access</h3>
<div class="row"><input id="shwith" placeholder="~ship" autocomplete="off"><button id="shread">read</button><button id="shedit">edit</button></div>
<div id="shres" class="muted"></div>
<h3 class="grouphead">give a group access <a id="aclopen" title="create and edit groups">manage &rarr;</a></h3>
<div id="grouplist" class="muted"></div>
</div>`;
      cwurl = $('cwurl');
    }
  });
  function showShare(m) {
    // the grant result names "this page", so it MUST NOT outlive the page it
    // was about. Every target change (page open, new file, folder select,
    // beacon sync) routes through here. A fuzz run caught it claiming
    // "~nec can now edit this page" while a different page was open, which
    // is a permissions UI telling the user something false.
    $('shres').textContent = '';
    for (const b of document.querySelectorAll('.share button'))
      b.className = b.dataset.m === m ? 'on' : '';
    // the group toggles are about THIS file, so they follow the same
    // every-target-change hook the grant message does
    renderGroupAccess();
    const target = curFolder || current;
    const suffix = curFolder ? '/' : '';
    // Build the public link as DOM, never innerHTML: a page/folder name is
    // content (the codebase rule everywhere else), and interpolating it into
    // markup makes this sink depend on every name source staying sane-%ta.
    cwurl.textContent = '';
    if (m === 'clearweb' && target) {
      const url = api + '/c/' + target + suffix;
      cwurl.appendChild(document.createTextNode('public: '));
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '/c/' + target + suffix;   // textContent: names are content
      cwurl.appendChild(a);
    } else if (m === 'mixed') {
      cwurl.textContent = 'mixed — pages under this folder differ';
    }
  }
  for (const b of document.querySelectorAll('.share button')) {
    b.onclick = async () => {
      const m = b.dataset.m;
      if (curFolder) {
        const r = await mutate(api + '/page-share-tree?name=' + encodeURIComponent(curFolder) +
          '&mode=' + m);
        if (!r.ok) { st('share failed ' + r.status, false); return; }
        showShare(m);
        st(m === 'clearweb' ? 'published tree at /c/' + curFolder + '/' : 'tree set ' + m);
        // share-tree sets every page under the folder. Mirror that locally
        // instead of refetching the tree to learn what we just did.
        for (const n of nodes)
          if (n.page && n.path.startsWith(curFolder + '/')) n.share = m;
        snapTree();
        renderTree();
        return;
      }
      if (!current) { st('save the page first', false); return; }
      const r = await mutate(api + '/page-share?name=' + encodeURIComponent(current) +
        '&mode=' + m);
      if (!r.ok) { st('share failed ' + r.status, false); return; }
      showShare(m);
      st('sharing: ' + m);
      const n = nodes.find((x) => x.page && x.path === current);
      if (n) n.share = m;
      snapTree();
      renderTree();
    };
  }

  // ── per-file share-with: grant one ship read/edit on the OPEN page ───────
  // Writes through the same usergroups as the peers panel (an auto-group named
  // after the ship), then notifies them. The response says whether the notice
  // arrived. The grant is durable either way.
  const shareWith = async (mode) => {
    const shp = $('shwith').value.trim();
    if (!current) { st('open a page first', false); return; }
    if (!shp) { st('enter a ship', false); return; }
    // NAME the page rather than saying "this page". The editor's target can
    // change from eleven places (mode toggle, grub mode, memory open, rename,
    // …) and only four of them route through showShare, so a clear-on-change
    // hook is whack-a-mole. A fuzz run caught the message surviving the
    // pages/knowledge toggle. A message that names its own subject cannot go
    // false no matter what the editor does next, which is the property that
    // actually matters for a permissions UI.
    const page = current;
    $('shres').textContent = 'granting…';
    const r = await mutate(api + '/share-file?name=' + encodeURIComponent(page) +
      '&ship=' + encodeURIComponent(shp) + '&mode=' + mode);
    if (!r || !r.ok) {
      let msg = r ? r.status : 'network';
      if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
      $('shres').textContent = '';
      st('share failed: ' + msg, false);
      return;
    }
    const j = await r.json();
    $('shres').textContent = shp + ' can now ' + mode + ' ' + page +
      (j.notified ? ' — notified.' : ' — could not notify (offline?); the grant holds.');
    loadPerms();          // the peers panel shows the auto-group
  };
  $('shread').onclick = () => shareWith('read');
  $('shedit').onclick = () => shareWith('edit');

  // ── per-file group access ────────────────────────────────────────────────
  // The same read/edit grant as the ship row above, but pointed at a group
  // rather than one ship. This pane only SETS existing groups on this file.
  // Creating and editing the groups themselves is the ACL pane's job (there is
  // a link), which is what took the busy chip editor out of this narrow
  // column. Grants go through permSave, so both surfaces agree.
  //
  // A group's grant on a page is the page's own ball path in its peek/make,
  // exactly what the server's share-file writes, so a per-ship grant and a
  // per-group grant are the same kind of rule and read back the same way.
  const pagePath = (name) => '/apps/lattice.lattice_app/page/' + name;

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
          // dropping read drops edit. Edit without read cannot be exercised
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

// ── src/67-perms.js ───────────────────────────────────────────────────────
  // ── usergroups: the shared data layer ────────────────────────────────────
  // No UI of its own any more. The busy chip editor that used to live in the
  // editor's narrow right column moved to the full-window ACL pane (72-acl.js).
  // The right column now only SETS existing groups on the open file (66-share).
  // Both surfaces read permGroups and write through permSave, so they cannot
  // disagree about what is in force.
  //
  // Backed by grubbery usergroups via /share-groups. The vocabulary is read
  // and edit, where read is weir peek and edit is weir make. Poke grants and
  // non-directory rules are real but dojo territory. The server preserves
  // them verbatim on every save, and the ACL pane reports how many exist.
  let permGroups = [];
  // "no groups yet" and "not loaded yet" are different claims, and the group
  // list is deferred off boot's critical path. Without this flag the panel
  // asserts you have no groups for the second or two before the answer lands.
  let permsLoaded = false;
  //  bg: boot's deferred call yields to user activity (bgFetch). Panel
  //  opens and post-save re-reads stay on the user lane.
  async function loadPerms(bg = false) {
    let r = null;
    try { r = await (bg ? bgFetch : fetch)(api + '/share-groups'); } catch {}
    if (!r || !r.ok) {
      st('could not load groups (' + (r ? r.status : 'network') + ')', false);
      return;
    }
    permGroups = await r.json();
    permsLoaded = true;
    // every surface that renders groups repaints from this one load
    if (typeof renderAcl === 'function') renderAcl();
    if (typeof renderGroupAccess === 'function') renderGroupAccess();
  }
  async function permSave(g) {
    const r = await fetch(api + '/share-group-save?name=' + encodeURIComponent(g.name), {
      method: 'POST',
      body: JSON.stringify({ ships: g.ships, peek: g.peek, make: g.make }),
    }).catch(() => null);
    if (!r || !r.ok) {
      let msg = r ? r.status : 'network';
      if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
      st('permissions: ' + msg, false);
    }
    // re-read either way: the server is the authority, and a failed save must
    // snap the panels back to what is actually in force rather than show the
    // grant the user believes they made.
    loadPerms();
  }

// ── src/68-knowtags.js ────────────────────────────────────────────────────
  // ── knowledge tags panel: <lat-knowtags> ─────────────────────────────────
  // Wiring and rendering live in 95-know.js (they are know-mode logic); this
  // component only owns the markup. 95 runs later, so its $-lookups resolve.
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
  // ── shared with me: <lat-shared>, files other ships granted us ───────────
  // Fed by their share notices. These are claims, not capabilities. The entry
  // proves itself when opened, and a stale one can just be removed.
  customElements.define('lat-shared', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="swmsec">
<h3>shared with me</h3>
<div id="swmlist" class="muted">loading…</div>
</div>`;
    }
  });
  //  bg as in loadPerms: only boot uses it
  async function loadShared(bg = false) {
    let r = null;
    try { r = await (bg ? bgFetch : fetch)(api + '/shared-with-me'); } catch {}
    if (!r || !r.ok) { $('swmlist').textContent = 'could not load'; return; }
    const items = await r.json();
    const host = $('swmlist');
    host.textContent = '';
    if (!items.length) {
      host.className = 'muted';
      host.textContent = 'nothing yet — when a peer shares a file with you it appears here.';
      return;
    }
    host.className = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'chips';
      const a = document.createElement('a');
      a.textContent = it.host + ' ' + shortPath(it.path, items.map((x) => x.path)) +
        ' (' + it.mode + ')';
      a.title = it.path + ' — open in the editor';
      a.href = '/apps/lattice/app?grub=' + encodeURIComponent(it.path) +
        '&ship=' + encodeURIComponent(it.host);
      const x = document.createElement('a');
      x.textContent = '×';
      x.title = 'remove from this list (does not touch their grant)';
      x.onclick = async () => {
        await fetch(api + '/shared-with-me-del?host=' + encodeURIComponent(it.host) +
          '&path=' + encodeURIComponent(it.path), { method: 'POST' }).catch(() => null);
        loadShared();
      };
      row.appendChild(a); row.appendChild(x);
      host.appendChild(row);
    }
  }
  // deferred to boot, same reason as loadPerms. See 67-perms.js.

// ── src/70-upload.js ──────────────────────────────────────────────────────
  // ── upload (pickers + drag-and-drop, progress panel) ─────────────────────
  //  `text` maps to itself as well as from `txt`: exports written before the
  //  extension was conventionalised named those files `.text`, and a restore
  //  has to keep reading archives it already handed out.
  const KMAP = { md: 'md', gmi: 'gmi', html: 'html', htm: 'html', txt: 'text',
                 text: 'text', js: 'js', css: 'css', hoon: 'hoon' };
  const seg = (x) => x.toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const upPanel = $('uppanel'), upMsg = $('upmsg'), upFill = $('upfill'), upErr = $('uperr');

  const upShow = () => { upPanel.hidden = false; upErr.textContent = ''; upFill.style.width = '0%'; };
  const upProg = (done, total, name) => {
    upMsg.textContent = `uploading ${done}/${total}${name ? ': ' + name : ''}`;
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
    let skipped = 0;
    for (const { file, rel } of items) {
      const dot = rel.lastIndexOf('.');
      const kind = dot > 0 ? KMAP[rel.slice(dot + 1).toLowerCase()] : null;
      if (!kind) { skipped++; continue; }
      const stem = rel.slice(0, dot);
      const parts = verbatim
        ? stem.split('/').filter(Boolean)
        : stem.split('/').map(seg).filter(Boolean);
      if (folderCtx && !verbatim) parts.unshift(...folderCtx.split('/'));
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
      upProg(done, list.length, part[0].name);
      let r = null;
      try {
        const payload = [];
        for (const it of part)
          payload.push({ name: it.name, type: it.kind, body: (await it.file.text()) || '\n' });
        r = await mutate(api + '/page-save-batch',
          { method: 'POST', body: JSON.stringify(payload) });
      } catch {}
      if (!r || !r.ok) {
        // the batch is all-or-nothing, so report the whole chunk rather than
        // implying some of it landed
        fails += part.length;
        let msg = r ? r.status : 'network';
        if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
        upErr.textContent += `failed: ${part.length} file(s) — ${msg}\n`;
      } else {
        for (const it of part) addTreeNode(it.name, it.kind);
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
        { dir, exts: Object.keys(KMAP) });
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

// ── src/72-acl.js ─────────────────────────────────────────────────────────
  // ── access control pane: <lat-acl>, the peers panel with room to work ────
  // Same data and same endpoints as the narrow editor panel (67-perms.js).
  // This is a full-window overlay for organising it. Deliberately NOT a third
  // setMode branch. setMode is wired into the tree/editor lifecycle and access
  // control has nothing to do with either (same reasoning as 40-grub.js).
  //
  // Costs no boot requests. It renders permGroups, which boot already loads
  // off the critical path, and only fetches if the pane is opened before that
  // landed. Every mutation goes through permSave, so the narrow panel and this
  // one can never disagree.
  //
  // POKE GRANTS ARE READ-ONLY HERE, deliberately. The server preserves them
  // verbatim on save and refuses to set them from the editor ("the editor has
  // no business granting eval power"). A grant of eval capability stays a
  // dojo-level act. They are shown so this pane never hides live rules.
  customElements.define('lat-acl', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="aclwrap" hidden role="dialog" aria-modal="true" aria-label="access control">
  <div class="aclbar">
    <h2>Access control</h2>
    <span class="muted" id="aclsum"></span>
    <span class="grow"></span>
    <button id="aclreload" class="ico" title="reload from ship">&#8635;</button>
    <button id="aclclose">close</button>
  </div>
  <div class="aclbody">
    <div class="row">
      <input id="aclnew" placeholder="new group name (e.g. friends)" autocomplete="off">
      <button id="aclnewbtn">create group</button>
    </div>
    <div id="aclgrid" class="aclgrid"></div>
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

  const aclOpen = () => {
    $('aclwrap').hidden = false;
    aclPathOptions();
    // permGroups is populated by boot's deferred load. Only pay a request if
    // the pane was opened before that landed.
    if (!permGroups.length) loadPerms(); else renderAcl();
    loadBans();
  };
  const aclClose = () => { $('aclwrap').hidden = true; };

  // suggest the grantable paths this client already knows about, so a grant is
  // a pick rather than a hand-typed ball path. Built from the tree we have.
  function aclPathOptions() {
    const dl = $('aclpaths');
    if (!dl) return;
    dl.textContent = '';
    const base = '/apps/lattice.lattice_app';
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

  function renderAcl() {
    const grid = $('aclgrid');
    if (!grid) return;
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
    for (const g of permGroups) {
      const card = document.createElement('div');
      card.className = 'aclcard';

      const head = document.createElement('header');
      const b = document.createElement('b');
      b.textContent = g.name;
      const del = document.createElement('button');
      del.textContent = 'delete';
      del.className = 'acl-del';
      del.onclick = async () => {
        if (!(await askConfirm('delete group ' + g.name + ' and every grant it carries?', 'delete'))) return;
        await fetch(api + '/share-group-del?name=' + encodeURIComponent(g.name), { method: 'POST' }).catch(() => null);
        loadPerms();
      };
      head.appendChild(b); head.appendChild(del);
      card.appendChild(head);

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

      // one disambiguation scope for the whole pane, so the same page shows
      // the same short name in every card
      const allPaths = permGroups.flatMap((x) => [...x.peek, ...x.make]);
      const disp = (v) => shortPath(v, allPaths);
      aclSection(card, 'read', g.peek, (v) => {
        // dropping read must drop edit too. Edit without read is a grant that
        // cannot be exercised, and it would silently reappear as "read" on the
        // next save because addPath re-adds it.
        g.peek = g.peek.filter((x) => x !== v);
        g.make = g.make.filter((x) => x !== v);
        permSave(g);
      }, disp);
      aclSection(card, 'edit', g.make, (v) => {
        g.make = g.make.filter((x) => x !== v); permSave(g);
      }, disp);

      const prow = document.createElement('div');
      prow.className = 'row';
      const pin = document.createElement('input');
      pin.placeholder = '/apps/lattice.lattice_app/pub';
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

      if ((g.poke && g.poke.length) || g.opaque) {
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
      grid.appendChild(card);
    }
  }

  // ── banlist ──────────────────────────────────────────────────────────────
  // Deny is not something a weir can say, so it is the app's own list. Banning
  // revokes group membership server-side. The response says how many groups
  // changed, because "banned" with grants still live would be a lie.
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
        await fetch(api + '/unban?ship=' + encodeURIComponent(w), { method: 'POST' })
          .catch(() => null);
        st('unbanned ' + w + ' — it holds no access until you grant it again');
        loadBans();
      };
      host.appendChild(a);
    }
  }
  $('banadd').onclick = async () => {
    const w = $('banship').value.trim();
    if (!w) return;
    const r = await fetch(api + '/ban?ship=' + encodeURIComponent(w), { method: 'POST' })
      .catch(() => null);
    if (!r || !r.ok) {
      let msg = r ? r.status : 'network';
      if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
      st('ban: ' + msg, false);
      return;
    }
    const j = await r.json().catch(() => ({}));
    st('banned ' + w + (j.revoked ? ' — revoked from ' + j.revoked + ' group(s)' : ''));
    $('banship').value = '';
    loadBans();
    loadPerms();          // membership changed server-side. Repaint the groups
  };
  $('banship').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('banadd').click(); }
  };

  $('aclclose').onclick = aclClose;
  $('aclreload').onclick = () => loadPerms();
  $('aclnewbtn').onclick = async () => {
    const v = $('aclnew').value.trim();
    if (!v) return;
    await permSave({ name: v, ships: [], peek: [], make: [] });
    $('aclnew').value = '';
  };
  $('aclnew').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('aclnewbtn').click(); }
  };
  $('aclt').onclick = aclOpen;
  // Escape closes, matching the in-app dialog's behaviour
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('aclwrap').hidden) aclClose();
  });

// ── src/73-comments.js ────────────────────────────────────────────────────
  // ── comments inbox: <lat-comments> ───────────────────────────────────────
  // Comments arrive from OTHER ships, and until now the workspace had no view
  // of them. The reader rendered a thread per page, so finding out anyone had
  // replied meant visiting each published page. This is the owner's side: what
  // came in, across every page, newest first, with a way to remove one.
  //
  // Reuses the .aclwrap/.aclbar/.aclbody overlay styles rather than growing a
  // second set that would drift from them.
  customElements.define('lat-comments', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="cmwrap" hidden role="dialog" aria-modal="true" aria-label="comments">
  <div class="aclbar">
    <h2>Comments</h2>
    <span class="muted" id="cmsum"></span>
    <span class="grow"></span>
    <button id="cmreload" class="ico" title="reload from ship">&#8635;</button>
    <button id="cmclose">close</button>
  </div>
  <div class="aclbody">
    <div id="cmlist"></div>
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
      const r = await fetch(api + '/comments-inbox');
      if (!r.ok) { st('comments failed ' + r.status, false); return; }
      d = await r.json();
    } catch { st('comments failed', false); return; }
    inbox = d.items || [];
    renderComments(d.total || inbox.length);
  }

  function renderComments(total) {
    const host = $('cmlist');
    if (!host) return;
    host.textContent = '';
    host.className = '';
    $('cmsum').textContent = inbox.length
      ? inbox.length + (total > inbox.length ? ' of ' + total : '') + ' comment'
        + (total === 1 ? '' : 's')
      : '';
    if (!inbox.length) {
      host.className = 'aclempty';
      // say WHY it might be empty. Comments are opt-in per page, so "none yet"
      // and "never enabled anywhere" look identical and mean different things
      host.textContent = 'No comments. They are opt-in per page — turn them on '
        + 'from a page’s sharing controls.';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'aclgrid';
    for (const c of inbox) {
      const card = document.createElement('div');
      card.className = 'aclcard';
      const head = document.createElement('header');
      const who = document.createElement('b');
      who.textContent = c.author;
      const del = document.createElement('button');
      del.textContent = 'remove';
      del.className = 'acl-del';
      del.onclick = async () => {
        if (!(await askConfirm('remove this comment by ' + c.author + '?', 'remove'))) return;
        const r = await fetch(api + '/comment-del?page=' + encodeURIComponent(c.page) +
          '&id=' + encodeURIComponent(c.id), { method: 'POST' }).catch(() => null);
        if (!r || !r.ok) { st('remove failed' + (r ? ' ' + r.status : ''), false); return; }
        st('comment removed');
        loadComments();
      };
      head.appendChild(who); head.appendChild(del);
      card.appendChild(head);

      // the page it landed on, clickable. The point of an inbox is getting
      // to the thing being talked about
      const on = document.createElement('a');
      on.className = 'gname';
      on.textContent = c.page;
      on.style.cursor = 'pointer';
      on.onclick = () => { cmClose(); openPage(c.page); };
      card.appendChild(on);

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

  // ── unread ───────────────────────────────────────────────────────────────
  // A comment from another ship used to land in total silence: the inbox is
  // pull-only, so the only way to learn anyone had said anything was to open
  // it and look. That makes the feature invisible in practice.
  //
  // "Seen" is a high-water mark, not a per-comment flag: the @da the items
  // carry is zero-padded and fixed-width, so a lexical compare orders them and
  // one string in localStorage replaces a set that would need pruning.
  const seenKey = 'cmtSeen';
  const lastSeen = () => { try { return localStorage[seenKey] || ''; } catch { return ''; } };
  const markSeen = (when) => { try { if (when) localStorage[seenKey] = when; } catch {} };

  function paintUnread(n) {
    const b = $('cmt');
    if (!b) return;
    if (n > 0) { b.dataset.n = n > 99 ? '99+' : String(n); b.classList.add('has-unread'); }
    else { delete b.dataset.n; b.classList.remove('has-unread'); }
    b.title = n > 0
      ? n + ' new comment' + (n === 1 ? '' : 's') + ' from other ships'
      : 'comments from other ships';
  }

  // Counts without rendering, so it can run on a refresh without the pane open.
  // The pier serialises, so every count costs a real request in the same queue
  // the user's saves are waiting in. A badge is not worth that: it is throttled
  // to one count a minute no matter how often a sync asks for it. Opening the
  // panel does not go through here, so reading is always immediate.
  const BADGE_MS = 60000;
  let badgeAt = 0;
  // change detection: the /beacon/comments stamp as of the last full count,
  // and what that count was. Same stamp = nothing arrived = repaint the old
  // number for the price of ONE grub read, instead of the full inbox (every
  // comment body materialized — ~6s of the pier's serial time). Deletes
  // don't move the stamp, and don't need to: they can only lower a count,
  // and opening the panel recomputes for real.
  let stampSeen = null;
  let unreadSeen = 0;

  async function refreshCommentBadge() {
    if (Date.now() - badgeAt < BADGE_MS) return;
    badgeAt = Date.now();
    let stamp = null;
    try {
      // bgFetch: a badge must never queue ahead of something the user asked
      // for (this call is why page opens measured 6s+, see 10-shell.js)
      const r = await bgFetch(api + '/comments-latest');
      if (r.ok) {
        stamp = (await r.json()).latest;
        if (stamp !== null && stamp === stampSeen) { paintUnread(unreadSeen); return; }
      }
      // unknown stamp (old nexus, no comments yet) or a change: pay for the
      // real count
    } catch { return; }
    let d = null;
    try {
      const r = await bgFetch(api + '/comments-inbox');
      if (!r.ok) return;                 // a failed count is not worth reporting
      d = await r.json();
    } catch { return; }
    const items = d.items || [];
    const mark = lastSeen();
    unreadSeen = items.filter((c) => String(c.when || '') > mark).length;
    stampSeen = stamp;
    paintUnread(unreadSeen);
  }

  const cmOpen = () => {
    $('cmwrap').hidden = false;
    // opening IS reading: mark everything currently in the inbox as seen
    loadComments().then(() => {
      const newest = inbox.reduce((a, c) => (String(c.when) > a ? String(c.when) : a), lastSeen());
      markSeen(newest);
      paintUnread(0);
    });
  };
  const cmClose = () => { $('cmwrap').hidden = true; };
  $('cmclose').onclick = cmClose;
  $('cmreload').onclick = loadComments;
  $('cmt').onclick = cmOpen;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('cmwrap').hidden) cmClose();
  });

// ── src/75-move.js ────────────────────────────────────────────────────────
  // ── move / rename ────────────────────────────────────────────────────────
  // page-move does the whole thing server-side (copy + share carry-over +
  // delete, wikilink self-references rewritten) in ONE request. The old
  // client choreography was 3 round-trips per page plus one per folder.
  // Memories use the know-move route (history preserved).
  async function movePage(oldName, newName) {
    const r = await mutate(api + '/page-move?from=' + encodeURIComponent(oldName) +
      '&to=' + encodeURIComponent(newName));
    if (!r.ok) { st('move failed ' + r.status, false); return false; }
    // the server moves the WHOLE subtree (a page can parent nested pages, and
    // move-pages rewrites every rel under it). Renaming only the exact node
    // left those children pointing at paths that no longer exist — ghosts in
    // the tree until the next full loadTree. Same suffix-preserving remap as
    // moveFolder, and as the offline queue's own move reconciliation.
    const mapped = (p) => newName + p.slice(oldName.length);
    for (const n of nodes)
      if (n.path === oldName || n.path.startsWith(oldName + '/')) n.path = mapped(n.path);
    if (newName.includes('/')) addFolderNodes(newName.slice(0, newName.lastIndexOf('/')));
    snapTree();
    renderTree();
    return true;
  }

  async function moveFolder(oldPath) {
    const to = await ask('move / rename folder ' + oldPath + ' to:', oldPath, 'move');
    if (!to || to === oldPath) return;
    const newPath = to.trim().replace(/^\/+|\/+$/g, '');
    if (!newPath) return;
    const mapped = (p) => newPath + p.slice(oldPath.length);
    st('moving ' + oldPath + ' \u2192 ' + newPath + '\u2026');
    const r = await mutate(api + '/page-move?from=' + encodeURIComponent(oldPath) +
      '&to=' + encodeURIComponent(newPath));
    if (!r.ok) { st('move failed ' + r.status, false); return; }
    let moved = 0;
    for (const n of nodes)
      if (n.path === oldPath || n.path.startsWith(oldPath + '/')) {
        if (n.page) moved++;
        n.path = mapped(n.path);
      }
    if (newPath.includes('/')) addFolderNodes(newPath.slice(0, newPath.lastIndexOf('/')));
    if (current && (current === oldPath || current.startsWith(oldPath + '/')))
      current = mapped(current);
    snapTree();
    renderTree();
    st('moved ' + oldPath + ' \u2192 ' + newPath + ' (' + moved + ' pages)');
    if (current) openPage(current);
    else if (curFolder === oldPath) selectFolder(newPath);
  }

// ── src/77-history.js ─────────────────────────────────────────────────────
  // ── history + backlinks panels: <lat-history>, <lat-links> ───────────────
  // Defined here (before this file's own $-lookups). They upgrade inside the
  // <lat-ctl> frame rendered at 65.
  customElements.define('lat-history', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="histsec" hidden>
  <h3 id="histh">history &#9656;</h3>
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
  <h3 id="linkh">linked from &#9656;</h3>
  <div id="linklist" class="chips"></div>
</div>`;
    }
  });

  // ── backlinks: pages that wikilink [[this page]] ─────────────────────────
  // fetched ONLY when the panel is expanded. This and history were two more
  // ~2s round-trips paid on every page open whether or not anyone looked.
  const linkSec = $('linksec'), linkList = $('linklist');
  async function loadBacklinks() {
    linkList.textContent = '';
    if (!current || mode === 'know') return;
    const r = await fetch(api + '/page-backlinks?name=' + encodeURIComponent(current));
    if (!r.ok) return;
    const links = ((await r.json()).links || []).filter((p) => p !== current);
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
      a.onclick = () => openPage(pth);
      linkList.appendChild(a);
    }
  }

  // collapsed-by-default panels. First expand does the fetch
  let histOpen = false, linksOpen = false;
  const panelArrow = (el, base, open) => { el.textContent = base + (open ? ' ▾' : ' ▸'); };
  function resetPanels() {
    histOpen = false; linksOpen = false;
    histList.textContent = ''; linkList.textContent = '';
    histList.hidden = true; linkList.hidden = true;
    histView.hidden = true;
    const on = !!current && mode !== 'know';
    histSec.hidden = !on;
    linkSec.hidden = !on;
    panelArrow($('histh'), 'history', false);
    panelArrow($('linkh'), 'linked from', false);
  }
  $('histh').onclick = () => {
    if (histSec.hidden) return;
    histOpen = !histOpen;
    panelArrow($('histh'), 'history', histOpen);
    histList.hidden = !histOpen;
    if (!histOpen) histView.hidden = true;
    else if (!histList.childElementCount) loadHistory();
  };
  $('linkh').onclick = () => {
    if (linkSec.hidden) return;
    linksOpen = !linksOpen;
    panelArrow($('linkh'), 'linked from', linksOpen);
    linkList.hidden = !linksOpen;
    if (linksOpen && !linkList.childElementCount) loadBacklinks();
  };

  // ── version history (born keeps every save; autosave makes it dense) ────
  const histSec = $('histsec'), histList = $('histlist'), histView = $('histview');
  let revKind = null;
  const exitRev = () => {
    viewingRev = null;
    revKind = null;
    src.readOnly = false;
    histView.hidden = true;
  };
  async function loadHistory() {
    histList.textContent = '';
    if (!current || mode === 'know') return;
    const r = await fetch(api + '/page-history?name=' + encodeURIComponent(current));
    if (!r.ok) return;
    const revs = (await r.json()).revisions || [];
    if (revs.length < 2) {               // a single revision is just "now"
      const d = document.createElement('div');
      d.className = 'muted';
      d.textContent = 'no history yet';
      histList.appendChild(d);
      return;
    }
    for (const v of revs.slice(0, 30)) {
      const a = document.createElement('a');
      // ~2026.7.27..19.12.23..xxxx -> 7.27 19:12
      const m = (v.updated || '').match(/\.(\d+\.\d+)\.\.(\d+)\.(\d+)/);
      a.textContent = '#' + v.rev + (m ? ' \u00b7 ' + m[1] + ' ' + m[2] + ':' + m[3] : '');
      a.className = v.rev === viewingRev ? 'on' : '';
      a.onclick = () => openRev(v.rev);
      histList.appendChild(a);
    }
  }
  async function openRev(rev) {
    const r = await fetch(api + '/page-source-at?name=' + encodeURIComponent(current) +
      '&rev=' + rev);
    if (!r.ok) { st('revision load failed ' + r.status, false); return; }
    const d = await r.json();
    viewingRev = rev;
    revKind = d.kind === 'index' ? 'md' : d.kind;   // restore under the REVISION's kind
    dirty = false;
    src.value = d.body;
    src.readOnly = true;
    render(); sync();
    histView.hidden = false;
    for (const a of histList.children)
      a.className = a.textContent.split(' ')[0] === '#' + rev ? 'on' : '';
    st('viewing rev ' + rev + ' \u00b7 read-only');
    if (CONTENT()) refreshPreview();
  }
  $('hback').onclick = () => { exitRev(); openPage(current); };
  $('hrestore').onclick = async () => {
    if (viewingRev === null) return;
    const rev = viewingRev, kind = revKind;
    exitRev();
    dirty = true;          // the historical body is now an unsaved local edit
    await save(kind);      // under the revision's OWN kind, not the current select
    st('restored rev ' + rev + ' as the newest revision');
    loadHistory();
  };

  $('mv').onclick = async () => {
    if (curFolder) { moveFolder(curFolder); return; }
    if (!current) { st('open something first', false); return; }
    const to = await ask('move ' + (mode === 'know' ? 'memory' : 'page') + ' ' + current + ' to:',
      current, 'move');
    if (!to || to === current) return;
    const newName = to.trim().replace(/^\/+|\/+$/g, '');
    if (!newName) return;
    if (mode === 'know') {
      const r = await mutate(api + '/know-move?from=' + encodeURIComponent(current) +
        '&to=' + encodeURIComponent(newName));
      if (!r.ok) { st('move failed ' + r.status, false); return; }
      // the body is already in the editor. Rename in place, no refetch
      knowGen++;
      const k = knowKeys.find((x) => x.key.replace(/^\//, '') === current);
      if (k) k.key = newName;
      current = newName;
      pname.value = newName;
      renderKnowChips();
      renderKnowTree();
      st('moved to ' + newName);
      return;
    }
    if (await movePage(current, newName)) {
      st('moved to ' + newName);
      openPage(newName);
    }
  };

// ── src/78-export.js ──────────────────────────────────────────────────────
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
          const r = await mutate(api + '/page-share?name=' + encodeURIComponent(name) +
            '&mode=' + encodeURIComponent(mode));
          if (r && r.ok) ok++; else bad++;
        } catch { bad++; }
      }
      if (bad) st('share modes: ' + ok + ' restored, ' + bad + ' failed', false);
    }

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
    if (autoId) {
      const d = desk();
      if (!d) return;
      try {
        const where = await d.invoke('backup_write', { id: autoId, b64: await blobToB64(blob) });
        st('backed up ' + pages.length + ' page(s) to ' + where);
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
      st('exported ' + pages.length + ' page(s) to ' + where);
      return;
    }
    const url = globalThis.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
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

// ── src/79-search.js ──────────────────────────────────────────────────────
  // ── search: <lat-search> ─────────────────────────────────────────────────
  // Grep, not an index.
  //
  // The first version queried /content-search, the term index. Two things were
  // wrong with that and only one was obvious. The obvious one: the index is
  // exact whole words, so "zaphod" does not find "zaphodbeeblebrox" and
  // "markers" does not find "marker". Searching as you type then says "nothing
  // matches" for every keystroke until you finish a word.
  //
  // The one that actually decides it: THE INDEX IS STALE. It is rebuilt by
  // /search-reindex and by nothing else, so a page written a minute ago is not
  // in it. In a tool you write into all day, the material you most want to find
  // is exactly the material the index does not have.
  //
  // The client already holds the corpus. page-dump carries every page body
  // inline and is refetched as the tree changes, so a substring scan over what
  // is already in memory is live, matches partial words and phrases, costs no
  // request per keystroke, and needs no index to maintain. For a personal store
  // this is milliseconds.
  //
  // What the dump does NOT carry is the share mode, which is why /page-scopes
  // exists. A results list that cannot say which hits are published would show
  // private notes and clearweb pages looking identical, on a screen someone may
  // be sharing. That badge is a safety signal, so it is worth one request.
  customElements.define('lat-search', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="qwrap" hidden role="dialog" aria-modal="true" aria-label="search">
  <div class="aclbar">
    <h2>Search</h2>
    <input id="qinput" placeholder="search your pages and notes" autocomplete="off" spellcheck="false">
    <span class="muted" id="qsum"></span>
    <span class="grow"></span>
    <button id="qclose">close</button>
  </div>
  <div class="aclbody">
    <div id="qlist"></div>
  </div>
</div>`;
    }
  });

  // Loaded when the panel opens, not per keystroke: the scopes and the
  // memories are two requests, and then every keystroke is local.
  let qScopes = null;          // path -> 'private' | 'urbit' | 'clearweb'
  let qKnow = [];              // [{key, body}]
  let qLoading = null;         // in-flight load, shared
  //  Opening the panel starts this, and the first keystroke wants it too. The
  //  pier serialises, so letting both fire meant four queued requests and a
  //  wait long enough to look like a hang. One load, both await it.
  function qLoadContext() {
    if (qLoading) return qLoading;
    qLoading = qLoadContextOnce().finally(() => { qLoading = null; });
    return qLoading;
  }
  async function qLoadContextOnce() {
    try {
      const r = await fetch(api + '/page-scopes');
      if (r.ok) {
        const m = new Map();
        for (const it of ((await r.json()).items || [])) m.set(it.path, it.scope);
        qScopes = m;
      }
    } catch {}
    try {
      const r = await fetch(api + '/know-all');
      if (r.ok) qKnow = (await r.json()).items || [];
    } catch {}
  }

  const qCount = (hay, needle) => {
    if (!needle.length) return 0;   // indexOf('', i) is i: an empty needle loops forever
    let n = 0, i = 0;
    for (;;) {
      const at = hay.indexOf(needle, i);
      if (at < 0) return n;
      n += 1;
      i = at + needle.length;
    }
  };
  // a line of context around the hit, the way grep shows it
  const qSnip = (body, at, len) => {
    const from = Math.max(0, at - 40);
    const to = Math.min(body.length, at + len + 40);
    return (from ? '…' : '') + body.slice(from, to).replace(/\s+/g, ' ') + (to < body.length ? '…' : '');
  };

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
    if (!qScopes) {
      //  the exposure map and the memories are fetched once per open, and on a
      //  slow pier that is seconds. Say so, rather than showing an empty panel
      //  that reads as "no results".
      host.className = 'aclempty';
      host.textContent = 'searching\u2026';
      await qLoadContext();
      if (mine !== qSeq) return;
    }

    const out = [];
    let skipped = 0;
    for (const n of nodes) {
      if (!n.page) continue;
      // A body over the dump's inline cap is not here, only its size. Say so
      // rather than quietly returning a result set that is missing pages.
      if (typeof n.body !== 'string') { skipped += 1; continue; }
      const hay = n.body.toLowerCase();
      const at = hay.indexOf(q);
      const inPath = n.path.toLowerCase().includes(q);
      if (at < 0 && !inPath) continue;
      out.push({
        key: n.path,
        // NOT defaulted to 'private'. If the exposure lookup failed, or the
        // page is newer than it, calling it private would be a false safety
        // signal on a clearweb page: exactly the misread this badge exists to
        // prevent. Unknown says unknown.
        scope: (qScopes && qScopes.get(n.path)) || 'unknown',
        hits: at < 0 ? 0 : qCount(hay, q),
        inPath,
        snip: at < 0 ? '' : qSnip(n.body, at, q.length),
        know: false,
      });
    }
    for (const k of qKnow) {
      const body = String(k.body || '');
      const key = String(k.key || '').replace(/^\/+/, '');
      const hay = body.toLowerCase();
      const at = hay.indexOf(q);
      const inPath = key.toLowerCase().includes(q);
      if (at < 0 && !inPath) continue;
      out.push({
        key, scope: 'knowledge', hits: at < 0 ? 0 : qCount(hay, q),
        inPath, snip: at < 0 ? '' : qSnip(body, at, q.length), know: true,
      });
    }

    // a name match is what you meant more often than a body match, then
    // whichever mentions it most
    out.sort((a, b) => (b.inPath - a.inPath) || (b.hits - a.hits) || a.key.localeCompare(b.key));

    sum.textContent = (out.length ? out.length + ' result' + (out.length === 1 ? '' : 's') : '')
      + (skipped ? (out.length ? ' · ' : '') + skipped + ' large page(s) not scanned' : '');
    host.textContent = '';
    if (!out.length) {
      host.className = 'aclempty';
      host.textContent = 'nothing matches that';
      return;
    }
    host.className = '';
    const ul = document.createElement('ul');
    ul.className = 'qlist';
    for (const h of out.slice(0, 100)) {
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
      a.onclick = (e) => {
        e.preventDefault();
        qClose();
        if (h.know) openKnow(h.key); else openPage(h.key);
      };
      li.appendChild(a);
      ul.appendChild(li);
    }
    host.appendChild(ul);
  }

  const qClose = () => { $('qwrap').hidden = true; };
  const qOpen = () => {
    $('qwrap').hidden = false;
    const i = $('qinput');
    i.value = '';
    i.focus();
    $('qlist').className = 'aclempty';
    $('qlist').textContent = 'type at least two characters';
    $('qsum').textContent = '';
    qScopes = null;                          // refresh exposure each open
    qLoadContext();
  };

  // Local now, so this can be short. It exists to avoid rescanning on every
  // keystroke of a fast typist, not to avoid requests.
  let qTimer = null;
  $('qinput').oninput = () => {
    clearTimeout(qTimer);
    const v = $('qinput').value;
    qTimer = setTimeout(() => runSearch(v), 80);
  };
  $('qinput').onkeydown = (e) => {
    if (e.key === 'Enter') { clearTimeout(qTimer); runSearch($('qinput').value); }
  };
  $('qclose').onclick = qClose;
  $('qt').onclick = qOpen;

  // CAPTURE phase on window, so nothing downstream can swallow it. Vim mode's
  // handler is capture-phase on the textarea and consumes normal-mode keys
  // whole; being ahead of it is more robust than listing exemptions there.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('qwrap').hidden) { qClose(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      e.stopPropagation();
      if ($('qwrap').hidden) qOpen(); else qClose();
    }
  }, true);

// ── src/80-conflicts.js ───────────────────────────────────────────────────
  // ── conflict inbox: <lat-conflicts> ─────────────────────────────────────
  // When a save lands on top of an edit made elsewhere, the ship keeps the
  // LOSING body as a real page under conflicts/ (see conflict-name in
  // app.hoon), and the save's response names it. That is careful, but it is
  // also write-only: nothing in the workspace ever listed them, so a conflict
  // was preserved in a place nobody looked. This is the read side.
  //
  // No server route and no fetch: a conflict IS an ordinary page in the tree
  // the client already holds, so the whole pane derives from `nodes`. The
  // badge counts them; the pane lists them with the live page they came from.
  customElements.define('lat-conflicts', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="cfwrap" hidden role="dialog" aria-modal="true" aria-label="sync conflicts">
  <div class="aclbar">
    <h2>Conflicts</h2>
    <span class="muted" id="cfsum"></span>
    <span class="grow"></span>
    <button id="cfclose">close</button>
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

  // conflicts/<name-with-dashes>-rev<N>, the inverse of the ship's
  // conflict-name. Best-effort: the rev suffix is stripped and the dashes
  // become slashes, which is unambiguous for any name that itself has no dash.
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

  // the badge: a CONDITION (unresolved conflicts exist), so like the offline
  // badge it stays up rather than living in the scrolling status line
  function renderConfBadge() {
    const b = $('cflt');
    if (!b) return;
    const n = cfList().length;
    b.hidden = n === 0;
    b.textContent = '⚑ ' + n;
    b.title = n + ' unresolved conflict' + (n === 1 ? '' : 's') +
      ' — a save replaced an edit from elsewhere';
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
        live.onclick = () => { cfClose(); openPage(orig); };
        head.appendChild(live);
      }

      const view = document.createElement('button');
      view.textContent = 'read it';
      view.onclick = () => { cfClose(); openPage(path); };
      head.appendChild(view);

      const del = document.createElement('button');
      del.textContent = 'resolve (delete)';
      del.className = 'acl-del';
      del.onclick = async () => {
        if (!(await askConfirm('delete ' + path + '? Open it first if you need its text.', 'delete'))) return;
        const r = await mutate(api + '/page-del?name=' + encodeURIComponent(path));
        if (!r.ok) { st('delete failed ' + r.status, false); return; }
        dropTreeNodes(path);
        snapTree();
        renderConflicts();
        renderConfBadge();
        renderTree();
        st('resolved ' + path);
      };
      head.appendChild(del);
      card.appendChild(head);
      host.appendChild(card);
    }
  }

  const cfOpen = () => { $('cfwrap').hidden = false; renderConflicts(); };
  const cfClose = () => { $('cfwrap').hidden = true; };
  $('cfclose').onclick = cfClose;
  $('cflt').onclick = cfOpen;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('cfwrap').hidden) cfClose();
  });

// ── src/85-layout.js ──────────────────────────────────────────────────────
  // ── layout toggles + mobile tabs ─────────────────────────────────────────
  const ws = $('ws');
  // soft-wrap is the default (long lines running off-screen are unusable on
  // mobile). The toggle still turns it off, and a saved preference wins.
  if (!('appWrap' in localStorage)) localStorage.appWrap = '1';
  const applyToggles = () => {
    ws.classList.toggle('nt', localStorage.appNT === '1');
    ws.classList.toggle('nc', localStorage.appNC === '1');
    ws.classList.toggle('wrap', localStorage.appWrap === '1');
    $('wrapt').className = 'ico' + (localStorage.appWrap === '1' ? ' on' : '');
    $('treet').className = 'ico' + (localStorage.appNT === '1' ? ' on' : '');
    $('ctlt').className = 'ico' + (localStorage.appNC === '1' ? ' on' : '');
  };
  const flip = (k) => { localStorage[k] = localStorage[k] === '1' ? '0' : '1'; applyToggles(); };
  $('wrapt').onclick = () => flip('appWrap');
  $('treet').onclick = () => flip('appNT');
  $('ctlt').onclick = () => flip('appNC');
  applyToggles();

  // ── mobile: full-screen editing ──────────────────────────────────────────
  // Created here rather than in <lat-bar>, and appended to #ws, because it has
  // to survive the state it creates: full screen hides the bar, so a button
  // inside the bar would take the only way out with it.
  //
  // Labelled in words, not an icon. There is no full-screen glyph with broad
  // font coverage, and this codebase has already shipped an invisible button
  // once — the access-control key was U+26BF and drew as an empty box, which
  // every existence check passed. Two short words always render.
  //
  // The state persists: it reads as a preference ("I write full screen"),
  // matching the other layout toggles, and the way back is on screen the whole
  // time so a remembered full screen cannot trap anyone.
  const fullt = document.createElement('button');
  fullt.id = 'fullt';
  fullt.type = 'button';
  const setFull = (on) => {
    ws.classList.toggle('full', on);
    localStorage.appFull = on ? '1' : '0';
    fullt.textContent = on ? 'exit' : 'full';
    fullt.title = on ? 'leave full-screen editing' : 'full-screen editing';
    fullt.setAttribute('aria-label', fullt.title);
    fullt.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  fullt.onclick = () => setFull(!ws.classList.contains('full'));
  ws.appendChild(fullt);
  setFull(localStorage.appFull === '1');

  const isMobile = () => matchMedia('(max-width: 820px)').matches;
  const setMv = (v) => {
    ws.dataset.mv = v;
    for (const x of document.querySelectorAll('.mtabs button'))
      x.className = x.dataset.mv === v ? 'on' : '';
    if (v === 'prev') refreshPreview();
  };
  for (const b of document.querySelectorAll('.mtabs button'))
    b.onclick = () => setMv(b.dataset.mv);
  // On a phone the code pane is the wrong place to land. With no file open it
  // is an empty box, and the tree is how you get anywhere. Start on the tree
  // and let opening a file move us. applyPage switches to 'code' on mobile,
  // so a remembered or ?name page still lands in the editor. Desktop shows
  // every pane at once, so 'code' remains right there.
  setMv(isMobile() ? 'tree' : 'code');

  // ── pane resize: drag a boundary, double-click it to reset ───────────────
  // Widths live in CSS custom properties on #ws (see .psplit in the shell
  // css). Outer panes store px. The editor/preview boundary stores the
  // editor's fr share against the preview's fixed 1fr, so it keeps meaning
  // when the window or the outer panes change size.
  {
    let panes = {};
    try { panes = JSON.parse(localStorage.appPanes || '{}'); } catch {}
    const applyPanes = () => {
      ws.style.setProperty('--wtree', panes.tree ? panes.tree + 'px' : '');
      ws.style.setProperty('--wed', panes.ed ? panes.ed + 'fr' : '');
      ws.style.setProperty('--wctl', panes.ctl ? panes.ctl + 'px' : '');
    };
    applyPanes();
    const lim = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const wire = (id, key, drag) => {
      const h = $(id);
      if (!h) return;                    // stale cached shell without handles
      // the reset gesture is detected from pointerup pairs, NOT dblclick.
      // pointerdown must preventDefault (otherwise native selection starts
      // and eats the pointer stream mid-drag), and a cancelled pointerdown
      // never produces the derived click/dblclick events at all.
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
    wire('ph1', 'tree', (x) => { panes.tree = Math.round(lim(x, 130, 480)); });
    wire('ph3', 'ctl', (x) => { panes.ctl = Math.round(lim(innerWidth - x, 190, 520)); });
    wire('ph2', 'ed', (x) => {
      const ed = document.querySelector('.edwrap').getBoundingClientRect();
      const pv = document.querySelector('.prev').getBoundingClientRect();
      panes.ed = Math.round(lim((x - ed.left) / Math.max(60, pv.right - x), 0.25, 4) * 1000) / 1000;
    });
  }

// ── src/90-sync.js ────────────────────────────────────────────────────────
  // ── live refresh (beacon keep-SSE + focus + idle poll) ───────────────────
  // The writer bumps /beacon/rev on every mutation. On a real change refresh
  // the tree AND the open page. So an edit made on another device shows up
  // here without a reload. Local unsaved edits always win. `dirty` blocks the
  // content swap until the page is saved or reopened.
  async function refreshOpen() {
    if (!current || curFolder || dirty || document.hidden || viewingRev !== null) return;
    // remember WHAT we are fetching. By the time it lands the user may have opened
    // another page, switched mode, selected a folder, or entered history view.
    // Applying a stale body then would show the wrong content or, across modes,
    // autosave a page body over a memory.
    const wasCurrent = current, wasMode = mode;
    // a queued edit outranks the ship's copy. Reconciling now would paint
    // the stale server body over work that has not synced yet
    if (await offGet(mode === 'know' ? 'know:' + current : current)) return;
    const url = mode === 'know'
      ? api + '/know-read?key=' + encodeURIComponent(current)
      : api + '/page-source?name=' + encodeURIComponent(current);
    let d = null;
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      d = await r.json();
    } catch { return; }
    if (dirty || current !== wasCurrent || mode !== wasMode) return;
    if (curFolder || viewingRev !== null) return;
    // A KIND change with an UNCHANGED body still needs handling. Retagging a
    // page (gmi -> md, say) leaves the text byte-identical, so the body check
    // below returns early and the preview keeps rendering with the old builder.
    // That lasts forever, because the boot snapshot caches the rendered html
    // too. This request has no &render=1, so re-open the page properly rather
    // than trying to patch the preview from a response that does not contain
    // one.
    if (mode !== 'know' && d.kind && d.kind !== curKind) { openPage(wasCurrent); return; }
    // track the rev even when the BODY is unchanged. A save from elsewhere
    // that landed the same text still moved the revision, and a stale curRev
    // makes the next save carry a stale base, manufacturing a false
    // conflict (and a conflicts/ page) out of nothing
    if (mode !== 'know' && d.rev) curRev = d.rev;
    if (d.body === src.value) return;
    // the ship's copy moved under us. This page's cached render is stale
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
      refreshPreview();
      st('updated from ship \u00b7 rev ' + d.rev);
    }
  }
  const refreshAll = () => {
    if (document.hidden) return;
    // replay WINS the reconnect race. loadTree would repaint queued pages
    // from the server dump before their edits landed (design doc, gap 4)
    if (degraded || offCount) { replayQueue(); return; }
    // NB: stale cached renders are dropped by loadTree, which prunes against
    // the revs in the fresh dump. Clearing the whole cache here instead meant
    // one page's edit cost every other page its cache.
    if (mode === 'know') loadKnow(); else loadTree();
    refreshOpen();
    // a comment arriving from another ship bumps the beacon like any write, so
    // this is the same signal the tree refresh uses. Cheap: it counts, it does
    // not render, and it is skipped entirely while the pane is open.
    if ($('cmwrap') && $('cmwrap').hidden) refreshCommentBadge();
  };
  // ── the beacon stream, read raw ──────────────────────────────────────────
  // Not an EventSource: the stream's INITIAL event is named "old <path>" (a
  // dynamic name EventSource cannot subscribe to), and that event is the one
  // that matters most. It is the pier's proof of REGISTRATION — the keep is
  // a queued pier event of its own, so headers (and EventSource's onopen)
  // arrive long before the fiber actually watches, and any bump in that
  // window is missed with no replay. The old-event carries the CURRENT rev,
  // so the gap closes by comparison, not by clocks: remember the last rev
  // this client saw; if registration shows a different one, something
  // happened while nobody was watching — refresh. Bumps after registration
  // arrive as upd events, exactly as before.
  let streamLive = false;
  let beaconTimer = null;
  const bumped = () => { clearTimeout(beaconTimer); beaconTimer = setTimeout(refreshAll, 300); };
  let lastRev = '';
  try { lastRev = localStorage.latBeaconRev || ''; } catch {}
  const noteRev = (rev) => {
    if (!rev) return;
    lastRev = rev;
    try { localStorage.latBeaconRev = rev; } catch {}
  };
  (async () => {
    for (;;) {
      try {
        const resp = await fetch('/grubbery/api/keep/apps/lattice.lattice_app/beacon/rev',
          { headers: { Accept: 'text/event-stream' } });
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
            if (name.slice(0, 3) === 'old') {
              // registration. The stream is authoritative from HERE on;
              // a rev that moved since we last looked is a missed change.
              // Echoes still pending were emitted BEFORE this point and
              // will never arrive as upd — left counted, each would
              // swallow one real remote bump later.
              pendingEchoes = 0;
              streamLive = true;
              if (lastRev && data && data !== lastRev) bumped();
              noteRev(data);
              continue;
            }
            // a live bump. Our own save bumps the beacon too: refetching
            // tree + source to learn what this client just wrote was ~4s
            // of pier time per save, so our own expected echoes are
            // consumed by count (see pendingEchoes).
            noteRev(data);
            if (pendingEchoes > 0) { pendingEchoes--; continue; }
            if (Date.now() < echoUntil) continue;
            bumped();
          }
        }
      } catch {}
      // stream severed: pier restart or proxy hiccup. The rev comparison at
      // the NEXT registration covers whatever happens in this gap.
      streamLive = false;
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
  // coming back to the tab/window is the moment staleness shows. Catch it
  // directly. The 30s poll exists for a stream that is DOWN — while one is
  // registered it would have said so, and polling anyway cost one pier
  // request per open editor per 30s, forever (the same clock-vs-stream
  // trust the mount fixed in #160).
  window.addEventListener('focus', refreshAll);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(); });
  setInterval(() => { if (!streamLive) refreshOpen(); }, 30000);

// ── src/95-know.js ────────────────────────────────────────────────────────
  // ── knowledge mode ───────────────────────────────────────────────────────
  // The same workspace, pointed at the private memory store: browse keys as a
  // tree, filter by tag chips, read/edit/save entries, tag/untag, delete.
  let mode = 'pages';
  let knowKeys = [];        // [{key, tags, updated, bytes}] from know-list
  let knowTag = '';         // active tag filter ('' = all)
  const chipsEl = $('chips'), knowMeta = $('knowmeta'), ktagsEl = $('ktags');

  async function loadKnow() {
    const gen = knowGen;
    const r = await fetch(api + '/know-list');
    if (!r.ok) { st('know-list failed ' + r.status, false); return; }
    const d = await r.json();
    if (gen !== knowGen) return;   // a local patch superseded this response
    knowKeys = d.keys;
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
  }

  const kColl = () => {
    try { return JSON.parse(localStorage.knowColl || '[]'); } catch { return []; }
  };
  const setKColl = (c) => { localStorage.knowColl = JSON.stringify(c); };

  function renderKnowTree() {
    const shown = knowTag ? knowKeys.filter((k) => k.tags.includes(knowTag)) : knowKeys;
    const keys = shown.map((k) => k.key.replace(/^\//, '')).sort();
    treeList.textContent = '';
    rowByPath = new Map();
    if (!keys.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.style.padding = '4px 8px';
      empty.textContent = knowTag
        ? 'no memories tagged #' + knowTag
        : 'no memories yet — name one above and save';
      treeList.appendChild(empty);
      return;
    }
    const coll = kColl();
    const folded = (path) => coll.some((c) => path !== c && path.startsWith(c + '/'));
    const seen = new Set();
    for (const key of keys) {
      const parts = key.split('/');
      for (let d = 0; d < parts.length - 1; d++) {
        const dir = parts.slice(0, d + 1).join('/');
        if (seen.has(dir)) continue;
        seen.add(dir);
        const row = document.createElement('div');
        row.className = 'fld';
        row.style.marginLeft = (d * 14) + 'px';
        if (folded(dir)) row.style.display = 'none';
        const cx = document.createElement('span');
        cx.className = 'cx';
        cx.textContent = coll.includes(dir) ? '▸' : '▾';
        const label = document.createElement('span');
        label.textContent = '\u{1F4C1} ' + parts[d];
        row.append(cx, label);
        row.onclick = () => {
          const c = kColl();
          const i = c.indexOf(dir);
          if (i >= 0) c.splice(i, 1); else c.push(dir);
          setKColl(c);
          renderKnowTree();
        };
        treeList.appendChild(row);
      }
      const row = document.createElement('a');
      row.className = 'pg' + (key === current ? ' cur' : '');
      row.style.marginLeft = ((parts.length - 1) * 14) + 'px';
      if (folded(key)) row.style.display = 'none';
      row.href = '#';
      row.textContent = parts[parts.length - 1];
      row.onclick = (e) => { e.preventDefault(); openKnow(key); };
      rowByPath.set(key, row);
      treeList.appendChild(row);
    }
  }
  // one knowKeys entry by (normalized) key. Keys may carry a leading slash
  const knowEntry = (key) =>
    knowKeys.find((x) => x.key.replace(/^\//, '') === key);

  async function openKnow(key) {
    // a queued edit outranks the ship's copy, same rule as pages
    const q = await offGet('know:' + key);
    let d = null;
    if (q) d = { body: q.body, tags: (knowEntry(key) || { tags: [] }).tags, updated: 'queued offline' };
    else {
      let r = null;
      try { r = await fetch(api + '/know-read?key=' + encodeURIComponent(key)); } catch {}
      if (!r || !r.ok) { st('open failed ' + (r ? r.status : '— offline'), false); return; }
      d = await r.json();
    }
    current = key;
    pname.value = key;
    pname.readOnly = true;
    src.value = d.body;
    dirty = false;
    render(); sync();
    markCurrent();
    renderKnowTags(d.tags || []);
    $('kupd').textContent = 'updated ' + (d.updated || '');
    st('memory · ' + (d.tags || []).map((t) => '#' + t).join(' '));
    if (isMobile()) setMv('code');
  }

  function renderKnowTags(tags) {
    ktagsEl.textContent = '';
    for (const t of tags.sort()) {
      const a = document.createElement('a');
      a.textContent = '#' + t + ' \u00d7';
      a.onclick = async () => {
        const r = await mutate(api + '/know-untag?key=' + encodeURIComponent(current) +
          '&tag=' + encodeURIComponent(t));
        if (!r.ok) { st('untag failed ' + r.status, false); return; }
        // this client made the change. Patch the list it already holds
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
    // the writer case-folds tags. Fold here too so the local patch matches
    const t = $('ktag').value.trim().toLowerCase();
    if (!t || !current || mode !== 'know') return;
    const r = await mutate(api + '/know-tag?key=' + encodeURIComponent(current) +
      '&tag=' + encodeURIComponent(t));
    if (!r.ok) { st('tag failed ' + r.status, false); return; }
    $('ktag').value = '';
    knowGen++;
    const k = knowEntry(current);
    if (k && !k.tags.includes(t)) k.tags.push(t);
    renderKnowTags(k ? k.tags : [t]);
    renderKnowChips();
  };

  async function saveKnow() {
    const key = pname.value.trim().replace(/^\/+|\/+$/g, '');
    if (!key) { st('key required', false); return; }
    if (!src.value) { st('empty body', false); return; }
    if (viewingRev !== null) { st('viewing a revision — use restore', false); return; }
    const sent = src.value;
    echoUntil = Date.now() + 60000;
    let r = null;
    try { r = await tfetch(api + '/know-save?key=' + encodeURIComponent(key),
      { method: 'POST', body: sent }); } catch {}
    echoUntil = Date.now() + 4000;
    if (shipGone(r)) {
      await enqueueKnow(key, sent);
      current = key;
      pname.readOnly = true;
      if (src.value === sent) dirty = false;
      return;
    }
    if (!r.ok) { st('save failed ' + r.status, false); return; }
    current = key;
    pname.readOnly = true;
    if (src.value === sent) dirty = false;
    st('memory saved');
    knowGen++;
    const k = knowEntry(key);
    if (k) k.bytes = sent.length;
    else knowKeys.push({ key, tags: [], updated: '', bytes: sent.length });
    renderKnowChips();
    renderKnowTree();
  }

  async function deleteKnow() {
    if (!current) return;
    if (!(await askConfirm('delete memory ' + current + '? (soft-delete, restorable)', 'delete'))) return;
    const doomed = current;
    const r = await mutate(api + '/know-delete?key=' + encodeURIComponent(doomed));
    if (!r.ok) { st('delete failed ' + r.status, false); return; }
    current = null;
    pname.value = '';
    pname.readOnly = false;
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
    exitRev();                       // else readOnly leaks into the memory editor
    $('histsec').hidden = true;
    $('linksec').hidden = true;
    ws.classList.toggle('know', m === 'know');
    $('modet').className = m === 'know' ? 'on' : '';
    $('modet').innerHTML = m === 'know' ? '\u25c6 knowledge' : '\u270e pages';
    chipsEl.hidden = m !== 'know';
    knowMeta.hidden = m !== 'know';
    $('treesec').textContent = m === 'know' ? 'memories' : 'files';
    curFolder = null;
    setCtlLabels();
    current = null;
    pname.value = '';
    pname.readOnly = false;
    pname.placeholder = m === 'know' ? 'memory key (e.g. user/preferences)' : 'page name (e.g. notes/todo)';
    src.value = '';
    render();
    if (m === 'know') loadKnow(); else loadTree();
    history.replaceState(null, '', '/apps/lattice/app' + (m === 'know' ? '?view=know' : ''));
    // the toggle's visible result is the tree listing. Make sure it can be
    // seen: un-hide the pane on desktop, jump to the tree tab on mobile.
    if (localStorage.appNT === '1') { localStorage.appNT = '0'; applyToggles(); }
    if (isMobile()) setMv('tree');
    st(m === 'know' ? 'knowledge — pick a memory from the tree' : 'pages');
  }
  $('modet').onclick = () => setMode(mode === 'know' ? 'pages' : 'know');

// ── src/96-deskmenu.js ────────────────────────────────────────────────────
  // ── desktop: these commands live in the native File menu ─────────────────
  // The desktop window has a real menubar (desktop/src/main.rs). A "+ file"
  // button in the sidebar sitting next to a File > New page menu item is the
  // same command offered twice, in the one place a desktop user is least
  // likely to look for it.
  //
  // HIDDEN, never removed. The menu works by clicking these very elements, so
  // there is exactly one implementation of "new page" and no Rust counterpart
  // to drift out of step. Removing them would take their handlers with them.
  //
  // Web and mobile are untouched: without the desktop shell there is no
  // menubar to move anything into, and the buttons are the only affordance.
  //
  // The flag is set by the desktop build that HAS the menu (commands.rs, an
  // initialization_script), not inferred from __TAURI__. This UI ships from
  // the ship and the menu ships in the binary, so they update independently:
  // testing for the desktop alone would hide these on an older build with no
  // menubar behind them and make every one of these commands unreachable.
  if (window.__TAURI__ && window.__LATTICE_FILE_MENU__) {
    for (const id of ['newfile', 'newfolder', 'newtmpl', 'upfiles', 'updir', 'save']) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    // Both button rows are now empty, and an empty flex row still draws its
    // gap and margin — a blank band above the tree that reads as a rendering
    // fault. Hide a row only when everything in it went, so a row that keeps
    // a button (a later one added to it) still shows.
    for (const row of document.querySelectorAll('#tree .newbtns')) {
      if ([...row.children].every((c) => c.hidden)) row.hidden = true;
    }

    // ── the bar's name field becomes a label ────────────────────────────────
    // Typing a path into a text box is how you named a page when there was
    // nowhere else to do it. Creation lives in the File menu now, so the bar
    // can just say which page is open — centred, and not something you can
    // edit by accident mid-sentence.
    //
    // Both controls stay in the DOM and keep their values. Everything reads
    // pname.value and pkind.value — save, applyPage, the share flow, the
    // matrix — and rewriting all of that to read from somewhere else would be
    // a much larger change than this is worth.
    ws.classList.add('deskbar');
    const label = document.createElement('div');
    label.id = 'pathlabel';
    label.setAttribute('aria-live', 'polite');
    pname.after(label);
    const paint = () => {
      const v = (pname.value || '').trim();
      label.textContent = v || 'no page open';
      label.className = v ? '' : 'muted';
      label.title = v ? v + ' · ' + (pkind.value || '') : '';
    };
    paint();
    // pname is set from a dozen places (applyPage, newFile, rename, the
    // offline replay). Rather than find them all, watch the field itself.
    new MutationObserver(paint).observe(pname, { attributes: true, attributeFilter: ['value'] });
    pname.addEventListener('input', paint);
    pname.addEventListener('change', paint);
    setInterval(paint, 500);
  }

  // ── naming a new page when the name field is not on screen ───────────────
  //  Wrap +newFile itself rather than any one button. Hooking the toolbar
  //  button covered File > New page and missed the green + on every tree
  //  folder, which calls newFile(path) straight — so it set a name into a
  //  hidden field, focused something display:none, and looked like a dead
  //  button. Everything user-initiated routes through here: the toolbar
  //  (newFile('')), the File menu (which clicks it), the tree, and the
  //  mobile bar's label.
  //
  //  The field is hidden in two independent states — the desktop shell
  //  (deskbar, set above) and phone width (the 820px CSS block) — and a
  //  resize crosses the second one live, so the decision is made per call,
  //  not at load.
  //
  //  Boot also calls newFile, with focusName false, to land on an empty
  //  page. That must not be interrupted by a dialog, and it is the one
  //  caller that says so.
  const KINDS = ['md', 'gmi', 'html', 'text', 'txt', 'js', 'css', 'hoon'];
  const nameFieldHidden = () =>
    ws.classList.contains('deskbar') || matchMedia('(max-width: 820px)').matches;
  const baseNewFile = newFile;
  newFile = function (into, focusName = true) {
    if (!focusName || !nameFieldHidden()) return baseNewFile(into, focusName);
    //  reset the editor first, without the focus that cannot land
    baseNewFile(into, false);
    (async () => {
      //  a folder's + pre-fills that folder; the toolbar keeps offering the
      //  open page's path, which is what it did before this existed
      const seed = into ? into.replace(/\/+$/, '') + '/' : (pname.value || '');
      const raw = await ask('page name (e.g. notes/todo.md)', seed, 'create');
      if (!raw) return;
      let name = raw.trim().replace(/^\/+/, '');
      if (!name) return;
      const dot = name.lastIndexOf('.');
      const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
      if (KINDS.includes(ext)) {
        pkind.value = ext === 'txt' ? 'text' : ext;
        name = name.slice(0, dot);
      }
      pname.value = name;
      //  both labels (desktop deskbar, mobile bar) repaint off this event
      pname.dispatchEvent(new Event('change'));
      src.focus();
    })();
  };

// ── src/97-mobar.js ───────────────────────────────────────────────────────
  // ── mobile: one bar row + a ⋯ sheet ──────────────────────────────────────
  // At phone width the bar used to wrap into three rows — the icon cluster
  // was flex-wrap overflow, and the name input held a full-width row for a
  // once-per-page action — 184px of chrome before the tab strip's content.
  //
  // Same doctrine as the desktop deskbar (96-deskmenu.js): nothing is
  // removed, and the ⋯ sheet CLICKS the page's own hidden buttons, so there
  // is exactly one implementation of search/comments/access/mode and nothing
  // to drift. Everything here is built unconditionally and shown or hidden
  // by the 820px CSS block, so a resize across the breakpoint just works —
  // no load-time isMobile branching to go stale.
  {
    const bar = document.querySelector('.bar');

    // the label: which page is open. Sits where the name input was; the
    // input stays in the DOM with its value (everything reads pname.value).
    const mpath = document.createElement('div');
    mpath.id = 'mpath';
    mpath.setAttribute('aria-live', 'polite');
    pname.after(mpath);
    const mpaint = () => {
      const v = (pname.value || '').trim();
      mpath.textContent = v || 'no page open';
      mpath.className = v ? '' : 'muted';
    };
    mpaint();
    pname.addEventListener('input', mpaint);
    pname.addEventListener('change', mpaint);
    setInterval(mpaint, 500);

    // tap: rename what is open (the controls pane's own move/rename flow),
    // or start a page when nothing is. Both are existing buttons.
    mpath.addEventListener('click', () => {
      if (current || curFolder) $('mv').click();
      else newFile('');
    });

    // the ⋯ button and its sheet
    const more = document.createElement('button');
    more.id = 'mmore';
    more.className = 'ico';
    more.title = 'more';
    more.innerHTML = '&#8943;';
    bar.appendChild(more);
    const sheet = document.createElement('div');
    sheet.id = 'msheet';
    sheet.hidden = true;
    // [sheet row id to create, real button id to click, label]
    const rows = [
      ['ms-q', 'qt', '\u{1F50D} search'],
      ['ms-cm', 'cmt', '\u{1F4AC} comments'],
      ['ms-acl', 'aclt', '\u{1F511} access'],
      ['ms-mode', 'modet', ''],   // label mirrors the live mode button
    ];
    for (const [rid, target, label] of rows) {
      const b = document.createElement('button');
      b.id = rid;
      b.textContent = label;
      b.onclick = () => { sheet.hidden = true; $(target).click(); };
      sheet.appendChild(b);
    }
    bar.appendChild(sheet);
    more.onclick = () => {
      // the mode row's label is whatever the real button says right now
      $('ms-mode').textContent = $('modet').textContent;
      sheet.hidden = !sheet.hidden;
    };
    // tapping anywhere else puts it away
    document.addEventListener('click', (e) => {
      if (!sheet.hidden && !sheet.contains(e.target) && e.target !== more) sheet.hidden = true;
    });

    // the unread-comments badge lives on the hidden #cmt; mirror it onto ⋯
    // and the sheet row so hiding the button does not hide the signal.
    const mirror = () => {
      const un = $('cmt').classList.contains('has-unread');
      more.classList.toggle('has-unread', un);
      $('ms-cm').classList.toggle('has-unread', un);
    };
    mirror();
    new MutationObserver(mirror).observe($('cmt'), { attributes: true, attributeFilter: ['class'] });
  }

// ── src/98-legacy.js ──────────────────────────────────────────────────────
  // ── legacy agent import (one-time offer) ─────────────────────────────────
  // A ship upgraded from the pre-grubbery %lattice gall agent may still have
  // it installed with knowledge this store never saw. Ask once, in-app, then
  // never again. The server marker is authoritative (it survives a new
  // browser), and the localStorage flag keeps resolved installs from spending
  // a request on the check at all.
  async function legacyCheck() {
    if (localStorage.latLegacy === 'done') return;
    let d = null;
    //  background lane: a status check must never delay a user's click
    try { d = await (await bgFetch(api + '/legacy-status')).json(); } catch { return; }
    if (!d) return;
    // ONLY the server's marker is permanent. 'absent' can mean the agent is
    // merely suspended (|revive brings it back), and caching that as done
    // would silently strand the user's data forever. Never infer permanence
    // from a negative or transient answer.
    if (d.reason === 'resolved') { localStorage.latLegacy = 'done'; return; }
    if (!d.prompt) return;
    // Quiet for the session only once the user has actually DECLINED. Setting
    // this merely because the dialog was shown meant dismissing it (Esc, click
    // outside, or a reload mid-dialog) locked the offer out of that tab
    // entirely, with no way back short of a new tab.
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
      // the import can outlive the request (one serial writer poke per entry).
      // Ask the server what actually happened before reporting a failure.
      let after = null;
      try { after = await (await fetch(api + '/legacy-status')).json(); } catch {}
      if (after && after.reason === 'resolved') {
        localStorage.latLegacy = 'done';
        knowGen++;
        if (mode === 'know') loadKnow();
        st('legacy import completed');
        return;
      }
      // 504/502 is the reverse proxy giving up, not the ship failing. The
      // import keeps running server-side and is usually PARTLY done. Say what
      // landed, and name the cause, because the fix is a proxy setting.
      const cut = r && (r.status === 504 || r.status === 502);
      let listed = null;
      try { listed = await (await fetch(api + '/know-list')).json(); } catch {}
      const have = listed && listed.keys ? listed.keys.length : null;
      st((cut ? 'the connection timed out mid-import' : 'legacy import failed' + (r ? ' ' + r.status : '')) +
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
    // only latch when the SERVER says it finished. A partial run deliberately
    // leaves its marker unwritten so the offer returns and can be retried
    if (res.complete) localStorage.latLegacy = 'done';
    else delete sessionStorage.latLegacyAsked;
    knowGen++;
    st('imported ' + res.imported + ' memories from the old agent');
    if (mode === 'know') loadKnow(); else loadTree();
    // NEVER advise retiring the old agent while it still holds pages. This
    // import moves knowledge only (the agent exposes no arm for page bodies),
    // so an uninstall on that advice would destroy them permanently.
    const kept = res.imported + ' ' + (res.imported === 1 ? 'memory' : 'memories') +
      (res.skipped ? ' (' + res.skipped + ' already here, left untouched)' : '');
    const got = res.pagesImported || 0;
    let msg = 'Imported ' + kept + (got ? ', and ' + got + ' ' + (got === 1 ? 'page' : 'pages') : '') + '.';
    // The agent is cleared for retirement ONLY when the server says the whole
    // migration completed. Never infer it from a count. An unreadable page
    // list reads as zero pages, and telling someone to uninstall on that
    // would destroy the only copy of them.
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
  // ── boot ─────────────────────────────────────────────────────────────────
  // paint from the last session's snapshot before the network answers. The
  // tree and (when it matches ?name) the page body + preview appear at 0ms.
  // Then loadTree/refreshOpen reconcile in the background. Local edits win,
  // same rules as any live refresh.
  // The PAGE snapshot is small synchronous localStorage, and it is what
  // makes resume paint at literally 0ms. The TREE snapshot moved to IDB
  // (phase 3), whose read is async but single-digit ms, imperceptible next
  // to the ~0.5s network floor. It also frees the tree (which carries every
  // page body) from localStorage's ~5MB ceiling.
  function bootSnap() {
    let p = null;
    try { p = JSON.parse(localStorage.appPage || 'null'); } catch {}
    if (!p || !p.name) return false;
    const name = qs.get('name');
    // No ?name means a bare launch, above all the PWA, whose start_url can
    // never carry one. Resume the snapshot page instead of landing on an
    // empty editor. "opens where I left off" is what an installed app means.
    // A ?name that does not match the snapshot still defers to the network.
    if (name && p.name !== name) return false;
    applyPage(p.name, p);
    // openPage sets the upload-target folder. The snapshot path must too,
    // or uploads land at the root until the next explicit open
    setFolderCtx(p.name);
    return true;
  }
  async function bootTree() {
    let t = await kvGet('tree');
    if (!t || !t.length) {
      // one-time migration from the localStorage era, then free the quota
      try { t = JSON.parse(localStorage.appTree || 'null'); } catch {}
      if (t && t.length) kvPut('tree', t);
    }
    try { localStorage.removeItem('appTree'); } catch {}
    // if the network dump (or any local activity) beat us here, it is fresher
    // than the snapshot. Also deliberately NO treeGen bump. A snapshot must
    // never supersede an in-flight loadTree the way a real local patch does
    if (!t || !t.length || nodes.length) return;
    nodes = t;
    renderTree();
    markCurrent();
  }
  // the control-panel lists (sharing groups, shared-with-me) are never needed
  // to read or edit anything, so they load AFTER the editor is usable. Issued
  // at parse time they were two pier round-trips queued ahead of the tree, and
  // the pier serializes, pure delay on the only requests that matter.
  //  background lane: these also yield to any user activity (see bgFetch),
  //  so a click during boot is no longer queued behind panel lists
  const loadPanels = () => { loadPerms(true); loadShared(true); };
  // a queue left by a previous session syncs on open. With no Background
  // Sync (the SW must not intercept API calls), next-open IS the replay
  // moment, and the UI says so rather than implying closed-app sync exists
  // Adoption first, replay after. On the desktop the durable queue is the
  // ship-keyed one in Rust, so anything still sitting in this origin's
  // IndexedDB is a leftover from before that existed. Move it across BEFORE
  // the replay looks at the queue, or the first drain would not include it.
  adoptIdbQueue().then(() => {
    setTimeout(() => { if (offCount) replayQueue(); }, 4000);
  });
  // Well after boot has settled, never during it. Boot already spends five
  // serialised pier requests and takes most of ten seconds on a slow ship. A
  // count landing in the middle of that puts the user's first save behind it
  // and can push the save past the offline timeout, which is a real failure
  // traded for a badge nobody is waiting on.
  setTimeout(() => { refreshCommentBadge(); }, 20000);
  if (qs.get('grub')) {
    // arrived from the explorer's edit link. Open that ball path directly. The
    // tree still lists lattice pages, so clicking one leaves grub mode.
    loadTree().then(loadPanels);
    openGrub(qs.get('grub'), qs.get('ship'));
  } else if (qs.get('view') === 'know') {
    setMode('know');
    legacyCheck();
    loadPanels();
  } else {
    const painted = bootSnap();
    bootTree();
    // what the snapshot painted, if anything. The baseline for "did the USER
    // do something while the dump was in flight?"
    const bootCurrent = current;
    loadTree().then(() => {
      const name = qs.get('name');
      const into = qs.get('into');
      // The tree paints from localStorage at 0ms, so it is clickable long
      // before this resolves. Anything boot does by default would then land on
      // top of the user's own action, opening a page and having it close a
      // second later, which is exactly what the trailing newFile('') did.
      // Compare against bootCurrent, not against null. A snapshot-painted page
      // is not a user action and still wants its refreshOpen reconcile.
      // everTyped, not dirty. A keystroke followed by an autosave clears dirty
      // before a slow dump lands, and this branch then repainted the editor
      // from the dump's PRE-edit copy. Typing is a user action whether or not
      // it has since been saved.
      const touched = current !== bootCurrent || curFolder !== null || dirty || everTyped;
      if (touched) {
        legacyCheck();
        loadPanels();
        return;
      }
      if (name) {
        if (painted && current === name) refreshOpen();
        else openPage(name);
      }
      else if (into && nodes.some((n) => !n.page && n.path === into)) selectFolder(into);
      // no focus: boot did not ask for a new file, the user did not either
      else if (into) newFile(into, false);
      // bare launch, snapshot resumed a page above. Reconcile it, do not
      // clobber it with an empty new-file view
      else if (current) refreshOpen();
      else newFile('', false);
      legacyCheck();
      loadPanels();
    });
  }
})();
