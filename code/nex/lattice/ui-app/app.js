/* BUILT FILE — do not edit. Source: ui-src/lattice/, build: scripts/build-ui.mjs */
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
  let offbadge = null;       // assigned by <lat-statusbar> (13-frame.js)
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
  //  one object store of the three (saves, ops, kv), in its own transaction
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
  //  how many records, without reading them: a queued save carries its
  //  whole body, and the badge recount runs after every queue write
  const idbCount = async (name) => {
    const s = await idbStore(name, 'readonly'); return (s && await offReq(s.count())) || 0;
  };
  //  getAll and getAllKeys both come back in key order, which is the order
  //  they were queued in. That ordering IS the data structure here. The keys
  //  come along so a partly drained queue can delete exactly what landed.
  const idbOpAll = async () => {
    const s = await idbStore('ops', 'readonly');
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
    const s = await idbStore('ops', 'readwrite'); if (s) await offReq(s.add(rec));
    await offRecount();
  };
  const idbOpDel = async (k) => {
    const s = await idbStore('ops', 'readwrite'); if (s) await offReq(s.delete(k));
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
    // a queue entry leaves the queue because it LANDED (or was dropped with
    // a notice) — either way the reader's cached views of it are now lies
    bustPages(name);
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

  //  the desktop's Rust store has no count command, so there the lists
  //  are still read whole
  const offRecount = async () => {
    offCount = qrust()
      ? (await offAll()).length + (await opAll()).length
      : (await idbCount('saves')) + (await idbCount('ops'));
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
    const s = await idbStore('saves', 'readwrite');
    let ok = false;
    if (s) { try { ok = await offOk(s.put(rec)); } catch { ok = false; } }
    return ok;
  };
  const idbDel = async (name) => {
    const s = await idbStore('saves', 'readwrite'); if (s) await offReq(s.delete(name));
  };
  offRecount();
  const kvGet = async (k) => {
    const st = await idbStore('kv', 'readonly');
    const r = st && await offReq(st.get(k));
    return r ? r.v : null;
  };
  // fire-and-forget by design: persistTree's callers are synchronous save
  // paths, and a snapshot write that loses a race with app close costs one
  // boot's paint, not data. The ship copy is the durable one.
  const kvPut = async (k, v) => {
    const st = await idbStore('kv', 'readwrite');
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
  // replay uses a stricter rule. A queued record is the user's only copy, so
  // it is dropped only when the ship rejects it in a way a retry cannot fix:
  // a bad request, a missing target, a conflict, a body too large. Anything
  // else keeps it queued. That covers no response, any 5xx, an expired login
  // (401, 403), a timeout (408) and rate limiting (429).
  const REPLAY_DROP = [400, 404, 409, 410, 413, 422];
  const replayDrop = (r) => !!r && REPLAY_DROP.includes(r.status);

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
  async function enqueueSave(name, kind, body, isNew, rn) {
    // the queue coalesces by name, and the 2s autosave calls this WITHOUT
    // the create flag — overwriting a queued create as a plain edit would
    // route the replay around the 409 create protection and let an offline
    // "new page" clobber one made online meanwhile. Once a create, always
    // a create, until it drains. The display name rides with the create
    // the same way.
    let prev = null;
    try { prev = await offGet(name); } catch {}
    const queued = await offPut({ name, kind, body, baseRev: curRev || 0,
      isNew: !!isNew || !!(prev && prev.isNew), queuedAt: Date.now(),
      dname: (rn && rn.dname) || (prev && prev.dname) || '',
      dnames: (rn && rn.dnames) || (prev && prev.dnames) || '' });
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
          // drop the CAS claim: a save rebased by a move cannot know the
          // destination's rev (fresh rails land at 1, recreated ones at
          // prior+1, merges at oldRev+1 — two releases guessed numbers and
          // both were wrong somewhere). base 0 now MEANS "no base claim"
          // on both server write paths; the move itself guarantees the
          // destination's pre-save body is the one this edit was made from.
          await offPut({ ...q, name: rec.to + q.name.slice(rec.from.length), baseRev: 0 });
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
  async function replayQueue(proven) {
    if (replaying) return;
    replaying = true;
    try { await drainQueue(proven); } finally { replaying = false; }
  }

  //  Each drain phase returns FALSE when it could not finish. Usually that is
  //  the ship going away mid-drain, or any answer that is not a deterministic
  //  rejection (see replayDrop). drainCreates also returns false
  //  when the conflict-preservation write did not land for any other reason,
  //  because the alternative is dropping the user's only copy of a document.
  //  Either way everything the phase had not finished stays queued, in order,
  //  for the next replay, and the caller stops there and goes degraded. For a
  //  ship that is answering but refusing that one write, degraded is a
  //  deliberate over-report.

  // Structural ops go FIRST, in the order they were made. Their effect on
  // the pending saves was already applied when they were queued, so a save
  // landing afterwards is always a save the user still wants, under the name
  // they want it under.
  //
  // An op the ship REJECTS (see replayDrop) is dropped, not retried. It
  // means the intent was already satisfied some other way: deleting a page
  // that only ever existed in this queue, or moving one whose source the
  // queue never sent. Retrying that forever would wedge everything behind
  // it, and there is nothing to recover because no content lives in an op.
  // Any other failure keeps the op queued and stops the drain.
  async function drainOps(ops) {
    for (const o of ops) {
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

  // Creates go PER-ITEM with new=1, never through the batch: the batch is an
  // unconditional upsert, so a name that already exists on the ship would be
  // silently overwritten. A create must keep its 409-on-exists protection,
  // or an offline "new page" could clobber a page someone else made online.
  async function drainCreates(creates, conflicts) {
    for (const q of creates) {
      let one = null;
      try {
        one = await tfetch(api + '/page-save?name=' + encodeURIComponent(q.name) +
          '&type=' + q.kind + '&new=1' + dnameQ(q),
          { method: 'POST', body: q.body || '\n' }, 20000);
      } catch {}
      if (one && one.ok) { await offDel(q.name); continue; }
      //  409 is in the drop set, so it falls through to its own branch below
      if (!replayDrop(one)) return false;
      // 409: the name is taken on the ship. Do NOT drop the user's body — move
      // it out of the way as a conflict page so nothing is lost, then let them
      // rename. Overwriting is the one thing a create must never do. The alt
      // write needs no new=1 (it is a preservation write, not a create-claim),
      // and %make creates the conflicts/ parent server-side, as it does for
      // the ship's own conflict pages.
      if (one && one.status === 409) {
        // the 409 may be OUR OWN earlier attempt: tfetch's abort stops the
        // wait, not the write, so a timed-out create can land ship-side and
        // 409 its own replay (two tabs draining the shared queue race the
        // same way). The single-save and batch paths have an identical-body
        // dup rule for exactly this; a create must too, or a replay that
        // raced its own landed write fabricates a "collided" conflict page.
        try {
          const sr = await tfetch(api + '/page-source?name=' +
            encodeURIComponent(q.name), {}, 20000);
          if (sr && sr.ok && ((await sr.json()).body || '') === (q.body || '\n')) {
            await offDel(q.name);
            continue;
          }
        } catch {}
        const alt = 'conflicts/offline-create-' + q.name.replace(/\//g, '-');
        let two = null;
        try {
          two = await tfetch(api + '/page-save?name=' + encodeURIComponent(alt) +
            '&type=' + q.kind, { method: 'POST', body: q.body || '\n' }, 20000);
        } catch {}
        //  the preservation write is the only thing standing between the user
        //  and a lost document, so if it does not land the record stays queued
        if (!(two && two.ok)) return false;
        conflicts.push(alt);
        await offDel(q.name);
        st('offline create collided: ' + q.name + ' exists on the ship — your ' +
          'version is kept at ' + alt, false);
        continue;
      }
      st('dropped an unsyncable offline create: ' + q.name, false);
      await offDel(q.name);
    }
    return true;
  }

  // Drain through page-save-batch. The batch is all-or-nothing, right for
  // uploads, wrong for replay. One poisoned record would block the queue
  // forever. A rejected batch falls back to per-item saves so the bad record
  // is isolated and DROPPED (it can never apply; review gap 3).
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
      //  a 5xx from the batch may be one poisoned record, so retry per item
      //  to isolate it. No response, an outage, a lapsed login or a rate
      //  limit would fail the same way per item, so stop and keep them all.
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
            await offDel(q.name);
            continue;
          }
          if (!replayDrop(one)) return false;
          st('dropped an unsyncable offline edit: ' + q.name, false);
          await offDel(q.name);
        }
        continue;
      }
      return false;
    }
    return true;
  }

  // memories drain per-item. There is no know batch route, and last-write-
  // wins means a plain re-save with no verdict to collect
  async function drainKnows(knows) {
    for (const q of knows) {
      let one = null;
      try {
        one = await tfetch(api + '/know-save?key=' + encodeURIComponent(q.name.slice(5)),
          { method: 'POST', body: q.body || '\n' }, 20000);
      } catch {}
      if (one && one.ok) { await offDel(q.name); continue; }
      if (!replayDrop(one)) return false;
      st('dropped an unsyncable offline edit: ' + q.name, false);
      await offDel(q.name);
    }
    return true;
  }

  async function drainQueue(proven) {
    const whole = await offAll();
    const ops = await opAll();
    if (!whole.length && !ops.length) return;
    // a proven-live caller already has a round-trip that answered, so the
    // ship being gone is disproved before the first phase even runs. Clear
    // the badge now instead of leaving it amber for a drain that is, by
    // then, just bookkeeping.
    if (proven && degraded) { degraded = false; renderOffline(); }
    const all = whole.filter((q) => q.kind !== 'know');
    const knows = whole.filter((q) => q.kind === 'know');
    const total = whole.length + ops.length;
    stWork('syncing ' + total + ' offline edit' + (total === 1 ? '' : 's') + '…');
    const conflicts = [];
    //  ORDER IS THE CONTRACT: ops, then creates, then edits, then memories.
    //  && short-circuits, so the first phase that loses the ship stops the
    //  drain and leaves the rest of the queue untouched for the next replay.
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
    // reconcile ONLY after the drain. refreshAll on reconnect would repaint
    // queued pages from the server dump before their edits landed (gap 4)
    if (knows.length && knowLive()) loadKnow();
    loadTree();
  }

// ── src/10-shell.js ───────────────────────────────────────────────────────
// lattice app, served from ui-app/src/, built by scripts/build-ui.mjs
  const $ = (id) => document.getElementById(id);
  const api = '/apps/lattice';
  // ── flat icons ───────────────────────────────────────────────────────────
  // One-colour glyphs in place of colour emoji: the tree's folders and page
  // kinds (NERDTree with devicons), and the shell's buttons.
  // folder/open/search/comment/key are GitHub's Octicons, the page
  // kinds Seti-UI's, the set NERDTree's devicons draw on; both MIT. Each is
  // [viewBox, path]; Seti's boxes are cropped to match the Octicons' size.
  // The colour is CSS (.ic-md and so on), currentColor where it has none.
  const ICON = {
    folder: ['0 0 16 16', 'M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z'],
    open: ['0 0 16 16', 'M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1H13a1 1 0 0 1 1 1v.5H2.75a.75.75 0 0 0 0 1.5h11.978a1 1 0 0 1 .994 1.117L15 13.25A1.75 1.75 0 0 1 13.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.91.513-1.237Z'],
    search: ['0 0 16 16', 'M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z'],
    comment: ['0 0 16 16', 'M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z'],
    // Stroke icons for the editor shell: 24x24 line art, drawn by ico() with
    // fill none and a currentColor stroke. A third element 'stroke' marks them.
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
    menu: ['0 0 24 24', 'M4 6h16M4 12h16M4 18h16', 'stroke'],
    plus: ['0 0 24 24', 'M12 5v14M5 12h14', 'stroke'],
    save: ['0 0 24 24', 'M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 3v5h7V3M7 21v-7h10v7', 'stroke'],
    pin: ['0 0 24 24', 'M9 3h6l-1 6 3 4H7l3-4zM12 13v8', 'stroke'],
    tabs: ['0 0 24 24', 'M8 8h12v12H8zM4 16V4h12', 'stroke'],
    copy: ['0 0 24 24', 'M9 9h11v11H9zM5 15H4V4h11v1', 'stroke'],
    mark: ['0 0 24 24', 'M6 3h12v18l-6-4-6 4z', 'stroke'],
    know: ['0 0 24 24', 'M12 3l8 9-8 9-8-9z', 'stroke'],
    doc: ['0 0 24 24', 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5', 'stroke'],
    // a link to a page on another ship: a box with an arrow out of it
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
  // the reader's LRU pages cache (sw-js serves it with NO revalidation, and
  // its beacon script converges stale paints QUIETLY — the next view is
  // fresh, not this one). Fine for edits from elsewhere; a lie for our own:
  // save here, Back into the reader, and the pre-save copy would paint with
  // nothing visibly correcting it. So every successful write busts the
  // cached views it could have changed — any entry naming the page, plus
  // home, whose listings change under every write.
  const bustPages = (name) => {
    if (!('caches' in window)) return;
    // ball paths arrive with a leading slash (spud); the needle below adds
    // its own, and '//' matches no URL — normalize or the bust is a no-op
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
  // mirror of the server's +valid-name (@ta segments; no '.'/'..'): reject
  // BEFORE saving or queueing. The server answers 400 — cryptic online, and
  // fatal offline: the drain treats 400 as unsyncable and discards the
  // queued document it earlier reported "saved offline".
  const validName = (n) => String(n || '').split('/').every(
    (s) => s.length && s !== '.' && s !== '..' && /^[a-z0-9._~-]+$/.test(s));
  // realName: what a typed name becomes. A valid path is used as it is and
  // gets NO display name (a name is never stored twice). Anything else —
  // capitals, spaces, punctuation — is slugged per segment the way the
  // uploader slugs file names, and each segment that changed keeps its
  // typed text as the display name of the page or folder at that depth:
  // `dname` is the leaf's, `dnames` is every segment's, '/'-joined with ''
  // where the segment was fine as typed (so "notes/My Page" -> "/My Page").
  // null when even the slug is empty: there is nothing to name it by.
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
  // the query-string form of a realName() result (nothing for a valid name)
  const dnameQ = (rn) => (!rn ? '' :
    (rn.dname ? '&dname=' + encodeURIComponent(rn.dname) : '') +
    (rn.dnames ? '&dnames=' + encodeURIComponent(rn.dnames) : ''));
  // failure statuses name the actual cause. Every send-err answer carries
  // {"error": msg}, and dropping it for a bare status code wasted a cause
  // the pier already paid a round trip to deliver. Same parse the grub save
  // path uses. The body has ONE read, so a caller hands the response here
  // and reads nothing else from it.
  const errText = async (r) => {
    let msg = r ? ' ' + r.status : '';
    if (r) { try { const j = await r.json(); if (j && j.error) msg = ': ' + j.error; } catch {} }
    return msg;
  };
  // the eyre session is gone: an owner route answered 401, or 403 with the
  // gate's bare "forbidden" (every other refusal says why). What this browser
  // keeps of the owner's content goes, so whoever uses it next sees none of
  // it: the tree snapshot (every page body), the last page, the pages cache
  // and its index. The offline queue stays. It holds edits not sent yet,
  // and dropping it would lose them.
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
  // bulk writes (vault restore, drag-drop upload, know-import) name their
  // targets only in the POST body — no per-name bust is possible from the
  // URL, and a restore legitimately invalidates everything. Drop the whole
  // pages cache; it rebuilds one view at a time.
  const bustAll = () => {
    if (!('caches' in window)) return;
    // spare the /__pv marker: it is the SW's record of which page-format
    // version this cache holds, and deleting it with the cache made the
    // next activate read a mismatch and wipe every freshly cached page
    // again. Read it out, drop the cache, put it back.
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
  // blank preview: about:blank defaults to light color-scheme, which
  // mismatches the app's declared scheme and makes the iframe an opaque
  // white canvas in dark theme. Declare the scheme so it stays transparent
  // and the pane's theme background shows through.
  // the preview frame is its own document, out of the theme's reach, so it
  // gets a copy of what theme.js set inline on <html>: the colours, the
  // forced color-scheme, Talon's font. Empty when none is set, so the frame
  // follows the OS as it always did. (An installed font is a face of THIS
  // document, so the frame gets its name and falls back unless the system
  // has it too.)
  // the theme into a preview document, and its link and selection colours
  // only where it names them: unset, the page keeps the engine's own
  const themeRoot = () => {
    const s = document.documentElement.style;
    if (!s.colorScheme && !s.getPropertyValue('--font')) return '';
    return 'html:root{' + s.cssText + '}'
      + (s.getPropertyValue('--link') ? 'a{color:var(--link)}' : '')
      + (s.getPropertyValue('--selection') ? '::selection{background:var(--selection)}' : '');
  };
  const prevBlank = () => {
    prev.removeAttribute('src');
    prev.style.minHeight = '';
    // the srcdoc paints its OWN theme background rather than relying on the
    // engine to composite a mismatched-scheme iframe as transparent. That
    // reliance is exactly the kind of behavior that differs between the
    // Chromium the tests run and the webkitgtk the desktop runs
    prev.srcdoc = '<style>:root{color-scheme:light dark}' +
      'body{margin:0;background:var(--bg,#fafafa)}' +
      '@media(prefers-color-scheme:dark){body{background:var(--bg,#1a1a1a)}}' + themeRoot() + '</style>';
  };
  // grant paths are shown in the share/ACL surfaces, and every one carries
  // the same app base, pure noise on screen: /apps/lattice.lattice_app, or
  // a desk install's longer path ending in it. Strip it, then keep the
  // SHORTEST tail that stays unique among the paths shown alongside (`all`),
  // growing only where disambiguation demands. Callers put the full path in
  // `title`, so hover always has the truth.
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
      // Out of segments and STILL ambiguous. strip() drops an optional "page/",
      // so /…/page/foo and /…/foo both reduce to "foo" with nothing left to
      // extend, and two different grants rendered identically in the ACL pane.
      // Fall back to keeping that prefix, which is what actually distinguishes
      // them. Showing a longer path beats showing the wrong one.
      if (clashes()) return x.replace(/^.*?\/lattice\.lattice_app\//, '');
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
    status.title = msg;                      // in full, when the bar cuts it short
    status.style.color = ok ? '' : '#c0392b';
  };
  // stWork: a status that keeps spinning until the next plain st()
  const stWork = (msg) => {
    status.textContent = msg;
    status.title = msg;
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

// ── src/13-frame.js ───────────────────────────────────────────────────────
  // ── shell frame: <lat-ribbon>, <lat-lpane>, <lat-rpane>, <lat-statusbar> ──
  // The ribbon down the left edge, a tabbed pane either side of the editor,
  // the status bar along the bottom and a corner toggle above each pane.
  // The panes render the old components (lat-tree, lat-ctl, lat-history,
  // lat-links) as children, so those upgrade into their sections when their
  // own files run, with every id intact.
  //
  // Every icon button is titled "Name (shortcut)" with an identical
  // aria-label: the glyph is its whole content, so the title is its name.
  const tip = (b, name, keys) => {
    const t = keys ? name + ' (' + keys + ')' : name;
    b.title = t;
    b.setAttribute('aria-label', t);
    return b;
  };
  const sbtn = (attrs, icon, name, keys) =>
    `<button type="button" class="sbtn" ${attrs} title="${name}${keys ? ' (' + keys + ')' : ''}"`
    + ` aria-label="${name}${keys ? ' (' + keys + ')' : ''}">${ico(icon)}</button>`;

  // ── actions ─────────────────────────────────────────────────────────────
  // Every command the palette (26-palette.js) lists is registered by the
  // file that builds its home, with the home's element carrying
  // data-action="<id>". The palette is an index over those homes and holds
  // no feature of its own: run does what clicking the home does. Declared
  // here, ahead of every home, since files load in filename order.
  // {id, name, home, keys?, run, when?}: `when`, for a home that exists
  // only while it is open (the page menu), says whether it applies now.
  const ACTIONS = [];
  const action = (a) => { ACTIONS.push(a); };
  const actionHome = (id) => document.querySelector('[data-action="' + CSS.escape(id) + '"]');
  // the common case: the home is one element, and running is clicking it
  const clickAction = (id, name, home, keys) => action({ id, name, home, keys,
    run: () => { const b = actionHome(id); if (b) b.click(); } });

  // [id, icon, name, keys] per pane tab. Their sections are filled by the
  // components below and, for the empty ones, by later steps.
  const PANES = {
    l: [['files', 'doc', 'Files', 'Ctrl+Shift+F'], ['know', 'know', 'Knowledge'],
      ['search', 'search', 'Search', 'Ctrl+K'], ['marks', 'mark', 'Bookmarks']],
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

  // ── pane tabs and the corner toggles ────────────────────────────────────
  // One section per pane is shown. The choice persists per side, and an id
  // this build does not know (an older or newer layout) falls back to the
  // default rather than leaving the pane blank. Showing a section announces
  // it (lat-pane on document, detail {side, id}), so a section that loads
  // its list lazily (Knowledge, Bookmarks) fetches when it is first seen.
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
  // the section a pane shows right now, for a file whose listener was added
  // after the boot-time paneTab below had already announced it
  const paneShows = (side, id) =>
    !document.querySelector('#' + side + 'body > [data-pane=' + id + ']').hidden;
  // The stored keys still mean HIDDEN ('1'), as they always have, so a
  // layout saved before the frame comes back the same. The buttons say
  // whether the pane is OPEN: pressed means showing.
  //
  // On a phone the panes are drawers over the document instead (97-mobar.js
  // has the scrim and the swipe), one at a time, and the same calls drive
  // them: a corner toggle, a pane tab's action, search. Whether a drawer is
  // open is not kept, and the desktop columns' stored state is left alone.
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
  function drawer(side, open) {
    const ws = $('ws');
    if (open === undefined) open = !ws.classList.contains(side + 'draw');
    ws.classList.toggle('ldraw', open && side === 'l');
    ws.classList.toggle('rdraw', open && side === 'r');
    paintPanes();
    return open;
  }
  // opening a document puts both drawers away
  const drawersClose = () => drawer('l', false);
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
  // A pane tab's action also opens its pane, which is what reaching the
  // tab takes by hand. Search is Ctrl+K's qOpen (79-search.js), which
  // does the same and focuses the field.
  for (const side of ['l', 'r']) {
    for (const [id, , name, keys] of PANES[side]) {
      const aid = 'pt-' + id;
      action({ id: aid, name: 'Show ' + name, home: side === 'l' ? 'Left pane' : 'Right pane', keys,
        run: id === 'search' ? () => qOpen()
          : () => {
            paneOpen(side, true);
            const b = actionHome(aid);
            if (b) b.click();
            // Files' shortcut lands in its tree (30-tree.js)
            if (id === 'files') treeFocus();
          } });
    }
  }

  // ── ribbon ──────────────────────────────────────────────────────────────
  // Items are registered here by the feature that owns them, never written
  // into the markup, so each one has exactly one home. bottom puts it in the
  // lower group (settings). Each one is also a palette action.
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

  // ── compile error chip ──────────────────────────────────────────────────
  // The error itself lives in the Page tab (#cerr), which may be closed or
  // behind another tab. While it holds an error the status bar says so, and
  // a click brings the Page tab forward. Watched rather than called from
  // each writer, since four files set #cerr. The watch is on the Page
  // section because #cerr does not exist yet: <lat-ctl> upgrades later.
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

  // for the browser suites, which cannot reach this scope
  window.latShell = { paneTab, paneOpen, ribbonAdd, drawer };

// ── src/15-dialog.js ──────────────────────────────────────────────────────
  // ── in-app dialogs, NEVER browser-native prompt/confirm/alert ────────────
  // <lat-dialog> owns the dialog's markup AND wiring. The shell only carries
  // the tag, so the served HTML can never be missing an element this file
  // expects (the old cache-skew guards existed exactly for that gap).
  let dlg, dlgMsg, dlgIn, dlgSel, dlgOpts, dlgKind;
  let dlgDone = null;
  let dlgFrom = null;   // focus to hand back on close
  const dlgClose = (v) => {
    if (!dlgDone) return;
    dlg.hidden = true;
    //  hand focus back to where it was before the dialog took it. Hiding the
    //  focused element drops focus to body, which loses a keyboard or screen
    //  reader user's place. The element may have been removed meanwhile
    //  (a tree re-render replaces its rows), hence the isConnected guard.
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
  // ask: text-input dialog → string | null (cancel)
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
  //  askNameKind: a name AND the kind to save it as, in one dialog.
  //
  //  The kind used to be reachable only from the bar, which the desktop shell
  //  hides. So the one place a desktop user names a file was also the one
  //  place they could not say what it was, and everything arrived as md.
  //
  //  Options are cloned from the hidden kind picker (#pkind, 23-tabhead.js)
  //  rather than restated, so a kind added there (tex was) appears here with
  //  no second edit. `fixed` shows the kind without letting it change: a new
  //  memory is always md.
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
  // askName: ask() for a path-like name, re-prompting until the server would
  // accept it. Every one of these prompts feeds a route that enforces
  // +valid-name, and a rejection came back as a bare status code ("folder
  // failed 400") that never said what was wrong. Returns the CLEANED name,
  // so callers do not each re-implement the trim and slash strip. The name
  // is what was TYPED: callers put it through realName() for the path the
  // ship gets and the display name (if any) that goes with it.
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
  // askConfirm: yes/no dialog → boolean
  const askConfirm = (msg, okLabel) => {
    dlgSel.hidden = true;
    dlgKind.hidden = true;
    dlgIn.hidden = true;
    const p = dlgOpen(msg, okLabel);
    $('dlgok').focus();
    return p.then((v) => v !== null);
  };
  // askPublish: publishing cannot be fully taken back. Once a peer has
  // read a page, its copy and the network's cached answer can outlive an
  // unpublish or a delete. -> true to publish. "don't ask again" is kept
  // in localStorage, and only a publish sets it: ticking it and aborting
  // must not turn the next click into a silent publish.
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
  // askChoice: pick one of a list -> the chosen value, or null on cancel.
  // Rendered as real buttons in the app's own style, NEVER a <select>. A
  // select opens an OS-drawn list, which is a browser-native popup, and this
  // UI does not use those anywhere.
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
  // ── state ────────────────────────────────────────────────────────────────
  let current = null;      // name of the open page, null = unsaved new page
  let dirty = false;       // unsaved local edits. Auto-refresh never clobbers them
  let mode = 'pages';      // 'know' while a memory is in front (95-know.js)
  // read by the service-worker registration script, which lives in its own
  // inline <script> and cannot see this scope. It reloads the page when a new
  // worker takes over, and must never do that over typed work.
  // A parked tab (21-tabs.js) holds its own dirty buffer, so the live flag
  // alone misses work typed into any tab that is not in front.
  window.__latUnsaved = () => dirty === true || tabs.some((t) => t !== activeTab && t.snap && t.snap.dirty);
  // Whether the user has typed since the current editor view was established.
  // Cleared by applyPage/newFile (a fresh view), NEVER by autosave — and that
  // is the point: `dirty` cannot answer "did the user do something while
  // boot's dump was in flight", because autosave clears it. The sequence
  // type -> autosave -> dump-lands then looked untouched, and boot's reconcile
  // called openPage, which repainted the editor from the PRE-edit dump copy.
  // The next autosave wrote that stale body back over the good save: the
  // editor visibly ate work the ship already had.
  let everTyped = false;
  // guardDirty: the ONE place navigation asks "may I paint over what's here?"
  // Rounds two and three answered that per call site (a guard bolted onto
  // openKnow, another onto openPage, another onto openRev) and this round
  // found three MORE unguarded paths to the same loss: the pages/knowledge
  // toggle pill, a quick-open result crossing modes, and a same-mode page
  // click landing inside the autosave debounce window. Three guards missed
  // three doors. One chokepoint, called from every entry a user can click,
  // closes all of them at once.
  //
  // A dirty grub has nowhere else to go until Save is pressed, so it only
  // ever gets the dialog. A dirty page or memory usually CAN save itself in
  // the time it takes to click somewhere else, so try that first, using the
  // save path this mode already owns, and stay silent when it lands. Only a
  // flush that leaves the buffer dirty anyway (the offline queue refused it,
  // the ship rejected the write) falls back to naming what would be lost.
  //
  // With Settings > Editor > Autosave off, pages and memories save only when
  // asked to, so nothing here writes on its own: after any save already in
  // flight, unsaved text gets the question, with save as one answer.
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
  // saveNow: the save an answer of "save" asks for. A save already in
  // flight is waited out first (it may be this very text), then the front
  // document's own explicit save runs. Answers whether the buffer is clean.
  // Never a silent no-op: a failed save has said why, and a flight still
  // running past the cap says so here.
  async function saveNow() {
    await waitSave();
    if (!dirty) return true;
    if (saving) { st('a save is still running, try again', false); return false; }
    if (grubPath) await saveGrub(); else if (mode === 'know') await saveKnow(); else await save();
    await waitSave();
    return !dirty;
  }
  // flushNoAsk: guardDirty's flush without its question, answering whether
  // the buffer is clean afterwards. A tab switch (21-tabs.js) uses it on its
  // own: the tab it leaves keeps whatever is still unsaved, so there is
  // nothing to ask about. A dirty grub has no flush (explicit save only) and
  // answers false at once, and so does everything with autosave off, after
  // waiting out a save already in flight (an explicit one, still landing).
  async function flushNoAsk() {
    if (!dirty) return true;
    if (grubPath) return false;
    // save() coalesces concurrent calls by design. A save already in flight
    // just arms savePending and returns on the spot, so calling save() here
    // answered nothing while dirty stayed set. That read like a flush that
    // failed, when the real save was actually about to land. Wait for the
    // flight already under way instead. The cap keeps a hung request from
    // trapping navigation forever, and it must OUTLAST the save's own
    // timeout or the wait gives up on a flight that is still legal: tfetch
    // defaults to 30s (08-offline.js, widened deliberately for a queued
    // pier), so a shorter cap here reintroduced the false discard prompt
    // for any save landing past it. 30s of flight plus a beat to settle.
    //  a loop, not one wait: the save that lands can start the one that
    //  waited behind it (flushPending), and that one is this document's.
    //  And `saving` itself, not only the request: the request settles a
    //  few microtasks before the save that sent it clears `saving` and
    //  `dirty`, and waking in that gap offered to discard a save that was
    //  about to succeed. Capped past tfetch's 30s, since a grub save holds
    //  `saving` with no timeout of its own.
    await waitSave();
    if (!dirty) return true;
    // still dirty and nothing is in flight: the wait either never started or
    // timed out with the buffer untouched. Only now is a flush worth trying.
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
  // setOpen: what the tab header says is open, set in one place. `name` becomes
  // `current`, the open page or memory, or null when nothing named is open
  // (a new page, a folder, a grub, a fresh mode). The name field shows
  // `name` unless `shown` says otherwise (a folder's path, a grub's road, a
  // new page's folder prefix, a typed name slugged mid-save) and is locked
  // when readOnly. `kind` moves the kind picker when it has that option.
  // `url`, when given, replaces the address. Assigning .value fires no
  // event, so this ends by dispatching 'input' on the field: the desktop
  // and phone labels (96-deskmenu.js, 97-mobar.js) repaint on it. Then the
  // active document tab learns what it now shows (tabFollow, 21-tabs.js).
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
  //
  //  Two beacons, so two of each: a page write bumps /beacon/rev and a
  //  memory write /beacon/know. One shared count let a memory save's echo
  //  swallow a real page bump that arrived first. `n` is the bumps still
  //  owed to us, `until` the window while a write is in flight and after.
  //  Without them every save triggers a tree+source refetch of content
  //  this client just wrote (~4s of pier time each).
  const echoes = { rev: { n: 0, until: 0, at: 0 }, know: { n: 0, until: 0, at: 0 } };
  // the beacon a write route bumps: the memory routes bump /know, all the
  // rest /rev (know-publish too, since it publishes a page)
  const echoOf = (url) => {
    let p = '';
    try { p = new URL(url, location.href).pathname; } catch {}
    return /\/know-(?!publish$)[a-z-]+$/.test(p) ? echoes.know : echoes.rev;
  };
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

  // shipWrite: the one way a write reaches the ship, so what every write
  // needs is done the same way each time. The echo it causes is expected on
  // the right beacon (echoOf), held open while it flies and then for twice
  // the round trip (our own bump arrives a queue-length late on a slow
  // pier), and counted once it lands. The renders it touches are busted.
  // It answers {r}, or {gone: true} when the ship is unreachable (no
  // answer, or a bridge 502/504), and the caller queues what it can.
  //
  // `ms` is the timeout: 30s for a save (tfetch's own reasoning), 0 for none.
  // A folder move pokes the writer for every page, and timing that out would
  // read as offline and queue a second move. `save` marks a document save,
  // the flight guardDirty waits for.
  let saveFlight = null;
  async function shipWrite(url, init, { ms = 30000, save = false } = {}) {
    const echo = echoOf(url);
    echo.until = Date.now() + 60000;
    echo.at = Date.now();             // when we last wrote (see refocused)
    lastAction = Date.now();          // a write is user activity (see bgFetch)
    const sentAt = Date.now();
    const req = (ms ? tfetch(url, init, ms) : fetch(url, init)).catch(() => null);
    if (save) saveFlight = req;
    let r = null;
    try { r = await req; }
    finally {
      if (saveFlight === req) saveFlight = null;
      echo.until = Date.now() + Math.max(4000, 2 * (Date.now() - sentAt));
    }
    // `r` too: a 504 can be a link's host (35-pages.js), not this ship
    if (shipGone(r)) return { gone: true, r };
    if (r.ok) {
      echo.n++;                         // one bump is ours; consume it on arrival
      // every write names its target the same way; a move dirties both ends
      try {
        const q = new URL(url, location.href).searchParams;
        bustPages(q.get('name') || q.get('from') || q.get('key'));
        if (q.get('to')) bustPages(q.get('to'));
      } catch {}
    }
    return { r };
  }

  async function mutate(url, opts) {
    // Saves coalesce in a map, structural ops go in an ordered log, and both
    // drain together. Everything else (sharing, tagging, the legacy migration)
    // still refuses honestly rather than pretending.
    const offline = async () => {
      const q = offlineOp(url);
      if (q) {
        await enqueueOp(q);
        //  the caller now does exactly the local tree work it does when the
        //  ship answers: drop the nodes, or remap their paths. The flag sits
        //  on the object itself so the success message can say the change is
        //  queued without spending the body's single read
        return { ok: true, offline: true, status: 200,
                 json: async () => ({ offline: true }) };
      }
      st('offline — edits are queued, but this change needs the ship', false);
      return { ok: false, status: 'offline', json: async () => ({ error: 'offline' }) };
    };
    if (degraded || offCount) return offline();
    const w = await shipWrite(url, opts || { method: 'POST' }, { ms: 0 });
    // an unreachable ship: queue what can be queued and ENGAGE degraded.
    // The old path only queued when degraded was already true, so the FIRST
    // offline action being structural threw past every caller and did
    // nothing at all
    if (w.gone) { setDegraded(true); return offline(); }
    return w.r;
  }

  // where this install lives in the tree: /apps/lattice.lattice_app for the
  // ball-era instance, under /apps/shell.shell/desks/ for a desk install.
  // Grubbery's own endpoints (the beacon keep) and grant roads on our pages
  // spell it out. Asked of /streams once and remembered. forgetBase() when a
  // keep under it fails, so a moved install is found again.
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

  // a tree's folded folders, remembered under one localStorage key: get()
  // reads the list, flip(key) folds or unfolds one folder in it, set(list)
  // replaces it (collapse all). The files tree (with its shared-with-me
  // folder) keeps appColl; memories keep knowColl (95-know.js) and
  // bookmarks marksColl (31-marks.js).
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
  // ── document tabs ───────────────────────────────────────────────────────
  // Many documents open at once over ONE live editor. The editor's globals
  // (current, dirty, everTyped, grubPath, mode, src) stay the truth for the
  // tab in front. A tab that is not in front holds `snap`: what the editor
  // held for it when it was last in front, and above all whether that was
  // unsaved. A parked tab's unsaved buffer exists nowhere else, so
  // __latUnsaved and beforeunload count it (20-state.js, 35-pages.js).
  //
  // One tab per document: opening one that is already open focuses its tab,
  // so a document has one buffer, one dirty flag and one autosave, and two
  // tabs can never write over each other's typing.
  let tabs = [];
  let activeTab = null;
  let tabSeq = 0;
  // >0 while the tab model itself is painting the editor. setOpen calls
  // tabFollow on every paint, and these paints are the tab model's own steps,
  // not the user going somewhere.
  let tabNav = 0;
  // the tab whose open is still on its way in. Until its document lands the
  // paints are the open's own steps (openKnow's setMode passes through "no
  // memory" on its way to the key), so tabFollow leaves this tab alone. Only
  // until it lands, though: an open's promise can run on for seconds after
  // the paint (openPage's upgrade fetch), and what the user does meanwhile
  // must still be followed.
  let tabLoading = null;

  const mkTab = (kind, key, ship, { pinned = false, read = false } = {}) =>
    ({ id: 't' + (++tabSeq), kind, key, ship: ship || null, pinned, read,
       back: [], fwd: [], snap: null });
  const sameDoc = (t, d) =>
    t.kind === d.kind && t.key === d.key && (t.ship || null) === (d.ship || null);
  // a Back or Forward entry. Kind and ship ride along, since one tab can go
  // from a page to a memory to a grub.
  const tabEnc = (t) => JSON.stringify([t.kind, t.key, t.ship || null]);
  const tabDec = (s) => { const [kind, key, ship] = JSON.parse(s); return { kind, key, ship }; };

  // what the live editor shows, as a tab would name it: the one editor kind
  // whose live() claims it. null for a folder, which is a view in a tab and
  // not a document of its own.
  const liveDoc = () => {
    for (const [kind, k] of Object.entries(TAB_KINDS)) {
      const d = k.live && k.live();
      if (d) return { kind, key: d.key, ship: d.ship || null };
    }
    return null;
  };
  // whether the tab in front is a document in the editor: its kind has
  // live(). A tool tab is not, so the controls of the editor (Save, Edit /
  // Read, rename, the Page tab) leave the document underneath alone.
  const docFront = () => !activeTab || !!TAB_KINDS[activeTab.kind].live;
  // shows(t) for every editor kind: the live editor is this tab's document
  const showsLive = (t) => { const d = liveDoc(); return !!d && sameDoc(t, d); };

  // Park: the editor's state for this tab goes into its snap, and the
  // editor is released for the next one. A page or memory first gets the
  // same flush guardDirty gives it, minus the question: whatever the flush
  // cannot save simply stays in the snap, unsaved and counted. A grub never
  // autosaves, so its buffer goes straight into the snap, and so does every
  // buffer with autosave off (flushNoAsk writes nothing then).
  //
  // Only a tab whose document really is in the editor owns what is there.
  // While a slow open is still loading, the editor shows the document
  // before it, and filing that text under this tab would hand one
  // document's words to another's autosave. When such text is still unsaved
  // after the flush (a page deleted elsewhere and not yet recreated, typing
  // in a load window), it belongs to no tab, so it gets guardDirty's
  // question, and a cancel keeps it and the switch does not happen.
  // Answers false then.
  async function parkDoc(t) {
    const label = current || pname.value.trim() || 'this';
    await flushNoAsk();
    const mine = TAB_KINDS[t.kind].shows(t);
    if (dirty && !mine &&
        !(await askConfirm('discard unsaved changes to ' + label + '?', 'discard')))
      return false;
    t.snap = mine ? {
      body: src.value, dirty, everTyped,
      sel: [src.selectionStart, src.selectionEnd], scroll: src.scrollTop,
      kind: curKind, pkind: pkind.value, rev: curRev, shown: pname.value,
    } : null;
    // the buffer lives in the snap now. The next open's own guardDirty must
    // not ask about it again, and its debounce must not save it under
    // whatever document comes next (autosave reads `current` when it fires).
    dirty = false;
    clearTimeout(autoTimer);
    return true;
  }
  // The kinds of tab. switchTab and openIn only ever look a kind up here,
  // so a new kind is a new entry and nothing else.
  //   open(t)        show the document fresh, from the ship or a cache.
  //                  Answers false when that failed with nothing shown.
  //   restore(t, s)  paint a parked unsaved buffer back, with no fetch
  //   park(t)        hand the editor back, keeping what is unsaved in t.snap.
  //                  Answers false when the user chose to stay.
  //   shows(t)       whether the editor is showing this tab's document
  //   live()         editor kinds only: {key, ship} when the live editor
  //                  holds a document of this kind, else null. The editor
  //                  kinds claim mutually exclusive states. A kind without
  //                  live() is never rewritten by tabFollow.
  //   icon, label    for the strip. icon is a name, or a function of the tab
  const TAB_KINDS = {
    page: {
      // a link (30-tree.js) is titled with its whole local path: its name
      // alone would read as a page of my own
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
        applyKnow(t.key, { body: s.body, tags: (knowEntry(t.key) || { tags: [] }).tags,
          updated: 'unsaved here' });
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
        // grub mode is an overlay on the pages view (40-grub.js)
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
        st('unsaved, Ctrl+S to save');
      },
      park: parkDoc,
      shows: showsLive,
      live: () => (grubPath ? { key: grubPath, ship: grubShip } : null),
    },
  };

  // ── persistence ──────────────────────────────────────────────────────
  // Which documents are open, never their bodies: a body in localStorage
  // could come back in another window as if it were that window's work.
  const tabsSave = () => {
    try {
      localStorage.appTabs = JSON.stringify({
        tabs: tabs.map(({ kind, key, ship, pinned, read }) => ({ kind, key, ship, pinned, read })),
        active: tabs.indexOf(activeTab),
      });
    } catch {}
  };
  const tabsChanged = () => { tabsSave(); paintTabs(); };

  // ── showing a tab ────────────────────────────────────────────────────
  // Every switch, close and in-place open runs through one queue, so two
  // quick clicks can never park the same buffer twice or interleave their
  // halves. The queue waits for the park and for the paint to begin, not
  // for a slow fetch: the next switch supersedes an open still loading
  // (openSeq), and parks nothing for it, since nothing of it is shown yet.
  let tabQ = Promise.resolve();
  let tabShown = 0;         // counts showTab calls, so a late landing knows it is late
  const tabSerial = (fn) => {
    const run = tabQ.then(fn, fn);
    tabQ = run.catch(() => {});
    return run;
  };

  // show `t`, already the active tab, in the editor
  function showTab(t) {
    const k = TAB_KINDS[t.kind];
    const s = t.snap;
    t.snap = null;          // in front, the live editor is its state
    const gen = ++tabShown;
    src.readOnly = false;   // a blank or a binary grub left it locked
    openSeq++;              // an open still loading for the tab left behind may not land
    // a new page or memory already named (its create may still be queued,
    // and runs here once the name is back in the field) comes back named
    // even when clean. Opened fresh it would be a blank, nameless page.
    if (s && (s.dirty || (!t.key && s.shown))) {
      tabLoading = null;
      tabNav++;
      try {
        k.restore(t, s);
        dirty = s.dirty;
        everTyped = s.everTyped;
        // a page or memory whose flush failed tries again on the usual
        // debounce, exactly as if it had just been typed
        clearTimeout(autoTimer);
        if (dirty) autoTimer = setTimeout(autosave, 2000);
        tabCaret(s);
      } finally { tabNav--; }
      paintTabs();
      return Promise.resolve(true);
    }
    tabLoading = t;
    const settle = () => { if (gen === tabShown && tabLoading === t) tabLoading = null; };
    let p;
    try { p = Promise.resolve(k.open(t)); } catch (e) { p = Promise.reject(e); }
    return p.then((ok) => {
      settle();
      if (activeTab !== t || gen !== tabShown) return ok;
      // failed with nothing shown: an empty, locked editor under this tab's
      // name, never the previous document wearing this tab's title
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

  // park whatever is in front and bring `t` there. false: the user stayed
  async function tabTo(t) {
    const from = activeTab;
    if (from === t) {
      if (!TAB_KINDS[t.kind].shows(t)) showTab(t);
      return;
    }
    if (from && tabs.includes(from) && (await TAB_KINDS[from.kind].park(from)) === false)
      return false;
    activeTab = t;
    tabsChanged();
    showTab(t);
  }

  // ── the entry points ─────────────────────────────────────────────────
  // openIn: how every click on a document opens it. An open document
  // focuses its tab. A new tab comes from Ctrl/Cmd+click, a middle click,
  // opts.newTab, or a pinned tab in front. Anything else replaces the
  // document in the front tab, after guardDirty, and that tab's Back
  // remembers what it replaced.
  function openIn(kind, key, { ev, ship, newTab } = {}) {
    return tabSerial(async () => {
      const want = { kind, key, ship: ship || null };
      const hit = key ? tabs.find((t) => sameDoc(t, want)) : null;
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
      // flushed, or the user said discard: either way nothing here is owed
      dirty = false;
      const t = activeTab;
      if (t.key) { t.back.push(tabEnc(t)); t.fwd = []; }
      Object.assign(t, want);
      t.snap = null;
      tabsChanged();
      showTab(t);
    });
  }
  const switchTab = (id) => tabSerial(async () => {
    const t = tabs.find((x) => x.id === id);
    if (t) await tabTo(t);
  });
  // closeTab: false when the user kept it. guardDirty runs on the tab being
  // closed, in front, the one place it can flush or ask, so a background tab
  // holding unsaved work comes forward first.
  const closeTab = (id) => tabSerial(async () => {
    const t = tabs.find((x) => x.id === id);
    if (!t) return false;
    if (t !== activeTab && t.snap && t.snap.dirty && (await tabTo(t)) === false) return false;
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
    if (!next) { next = mkTab('page', ''); tabs.push(next); }
    activeTab = next;
    tabsChanged();
    showTab(next);
    return true;
  });
  // Back and Forward within the front tab. A step is an in-place open, so
  // it guards like one. A step onto a document open in another tab goes
  // to that tab instead.
  const tabStep = (from, to) => tabSerial(async () => {
    const t = activeTab;
    if (!t || !t[from].length) return;
    if (!(await guardDirty())) return;
    dirty = false;
    const d = tabDec(t[from].pop());
    const twin = d.key && tabs.find((x) => x !== t && sameDoc(x, d));
    if (twin) { tabsChanged(); return tabTo(twin); }
    if (t.key) t[to].push(tabEnc(t));
    Object.assign(t, d);
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
  // a new tab with a new page in it: the strip's +. Then newFile again, the
  // way the + file button calls it, so the page gets named (the name field,
  // or the create dialog where that field is hidden, 96-deskmenu.js)
  const tabNew = async () => {
    await openIn('page', '', { newTab: true });
    if (activeTab && activeTab.kind === 'page' && !activeTab.key) newFile('');
  };
  // a tool tab in front hides the editor. Anything about to paint the
  // editor (a new page, a folder) first gets a document tab of its own,
  // as the strip's + gives one, so it never lands unseen under the tool.
  // false: no document tab came to the front.
  const docTab = async () => {
    if (docFront()) return true;
    await openIn('page', '', { newTab: true });
    return docFront() && !!activeTab && activeTab.kind === 'page' && !activeTab.key;
  };

  // tabFollow: the editor moved to another document by a road that did not
  // come through openIn (a rename, a delete, the mode pill, a template, a
  // new page in place, the live sync). The front tab follows, so the tab
  // and what it parks always name the document that is really shown.
  function tabFollow() {
    if (tabNav || !activeTab) return;
    const t = activeTab;
    // a tab that is not an editor document (no live()) keeps its identity
    if (!TAB_KINDS[t.kind].live) return;
    if (tabLoading === t) {
      if (TAB_KINDS[t.kind].shows(t)) tabLoading = null;
      return;
    }
    const d = liveDoc();
    if (!d || sameDoc(t, d)) return;
    if (t.key) { t.back.push(tabEnc(t)); t.fwd = []; }
    Object.assign(t, d);
    t.snap = null;
    // one tab per document: a clean twin elsewhere is now redundant
    const twin = d.key && tabs.find((x) => x !== t && sameDoc(x, d) && !(x.snap && x.snap.dirty));
    if (twin) tabs.splice(tabs.indexOf(twin), 1);
    tabsChanged();
  }
  // a create that ran from the queue after its tab was left (save(),
  // 35-pages.js). `own.tab` is the tab it was queued from, and only that
  // tab, still unnamed and still showing the name it was created as, is
  // the page's tab now. Named, it opens the page when it comes back
  // (current set), so its later saves update the page instead of creating
  // it again, which the ship refuses as a page that already exists.
  // true: that tab is in front again, so the editor is on the page and
  // save() takes it as still here.
  function tabAdopt(own, name) {
    const trim = (v) => v.trim().replace(/^\/+|\/+$/g, '');
    const t = tabs.find((x) => x.id === own.tab);
    if (!t || t.kind !== 'page' || t.key) return false;
    if (t === activeTab)
      return showsLive(t) && current === null && trim(pname.value) === own.name;
    if (!t.snap || trim(t.snap.shown || '') !== own.name) return false;
    t.key = name;
    t.snap.shown = name;
    tabsChanged();
    return false;
  }
  // a move or rename: tabs naming the old path, or anything under it, name
  // the new one, so a parked buffer is never saved back to where it was
  function tabsRemap(kind, from, to) {
    for (const t of tabs) {
      if (t.kind !== kind || !t.key) continue;
      if (t.key === from) t.key = to;
      else if (t.key.startsWith(from + '/')) t.key = to + t.key.slice(from.length);
    }
    tabsChanged();
  }

  // ── boot ─────────────────────────────────────────────────────────────
  // The saved list, and then the address on top of it: a ?name, ?grub or
  // ?view=know&key names a document, which gets its tab focused or a new
  // one. An entry that does not parse as a tab is dropped, and nothing at
  // all leaves one new page. Nothing is opened here; boot (99-boot.js) shows
  // the tab this returns. `fresh` says the list was made up rather than
  // restored, which is when a bare launch may resume the last page.
  function tabsBoot() {
    let saved = null;
    try { saved = JSON.parse(localStorage.appTabs || 'null'); } catch {}
    const list = saved && Array.isArray(saved.tabs) ? saved.tabs : [];
    for (const e of list) {
      if (!e || !TAB_KINDS[e.kind] || typeof e.key !== 'string') continue;
      if (e.ship != null && typeof e.ship !== 'string') continue;
      if (e.key && tabs.some((t) => sameDoc(t, e))) continue;
      tabs.push(mkTab(e.kind, e.key, e.ship, { pinned: e.pinned === true, read: e.read === true }));
    }
    activeTab = (Number.isInteger(saved && saved.active) && tabs[saved.active]) || tabs[0] || null;
    const want = qs.get('grub') ? { kind: 'grub', key: qs.get('grub'), ship: qs.get('ship') || null }
      : qs.get('view') === 'know' ? { kind: 'know', key: qs.get('key') || '', ship: null }
      : qs.get('name') ? { kind: 'page', key: qs.get('name'), ship: null } : null;
    if (want) {
      const hit = activeTab && sameDoc(activeTab, want) ? activeTab
        : tabs.find((t) => sameDoc(t, want));
      if (hit) activeTab = hit;
      else {
        const t = mkTab(want.kind, want.key, want.ship);
        tabs.splice(activeTab ? tabs.indexOf(activeTab) + 1 : 0, 0, t);
        activeTab = t;
      }
    }
    const fresh = !activeTab;
    if (fresh) { activeTab = mkTab('page', ''); tabs.push(activeTab); }
    tabsChanged();
    return { tab: activeTab, fresh };
  }
  // boot showing a tab through the tab model, for every kind without a
  // boot path of its own
  const tabShowBoot = (t) => tabSerial(() => showTab(t));

  // ── the strip ────────────────────────────────────────────────────────
  // First in the center column, level with the corner toggles. The tabs,
  // then + for a new page (Back and Forward are in the tab header).
  const tabStrip = document.createElement('div');
  tabStrip.id = 'doctabs';
  tabStrip.className = 'doctabs';
  tabStrip.innerHTML =
    '<div class="dtlist" role="tablist" aria-label="Open documents"></div>' +
    sbtn('id="tabnew" data-action="tabnew"', 'plus', 'New page');
  $('center').prepend(tabStrip);
  const tabList = tabStrip.querySelector('.dtlist');
  $('tabnew').onclick = () => tabNew();
  clickAction('tabnew', 'New page in a new tab', 'Tab strip');

  // Each tab is two buttons side by side in one wrapper: the tab itself
  // and its close, so the close is a real button a keyboard can reach (a
  // button cannot sit inside another). The state classes (on, dirty,
  // pinned) go on both: the wrapper draws the tab, the tab button is what
  // scripts and suites address.
  function paintTabs() {
    tabList.textContent = '';
    for (const t of tabs) {
      const k = TAB_KINDS[t.kind];
      const name = k.label(t);
      const w = document.createElement('div');
      w.setAttribute('role', 'presentation');
      const b = document.createElement('button');
      b.type = 'button';
      for (const [el, base] of [[w, 'dtw'], [b, 'dtab']])
        el.className = base + (t === activeTab ? ' on' : '') + (t.pinned ? ' pinned' : '');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t === activeTab ? 'true' : 'false');
      b.dataset.id = t.id;
      b.dataset.kind = t.kind;
      b.dataset.key = t.key;
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
      // a middle click closes, and must not start the browser's autoscroll
      w.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); };
      w.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } };
      w.oncontextmenu = (e) => { e.preventDefault(); tabMenu(t, e.clientX, e.clientY); };
      w.append(b, x);
      tabList.append(w);
    }
    paintTabDirty();
    paintHead();   // the header under the strip (23-tabhead.js)
    const on = tabList.querySelector('.dtw.on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  // The dot. `dirty` is set by typing and cleared by four save paths, so the
  // dot is read off the state on a short beat instead of from each of them.
  function paintTabDirty() {
    for (const w of tabList.children) {
      const b = w.firstChild;
      const t = tabs.find((x) => x.id === b.dataset.id);
      const on = !!t && (t === activeTab ? dirty === true : !!(t.snap && t.snap.dirty));
      w.classList.toggle('dirty', on);
      b.classList.toggle('dirty', on);
    }
  }
  setInterval(paintTabDirty, 400);

  // the context menu: pin, close, close the others
  let tabMenuEl = null;
  const tabMenuClose = () => { if (tabMenuEl) { tabMenuEl.remove(); tabMenuEl = null; } };
  function tabMenu(t, x, y) {
    tabMenuClose();
    const m = document.createElement('div');
    m.className = 'dtmenu';
    m.setAttribute('role', 'menu');
    const item = (label, run) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      b.onclick = () => { tabMenuClose(); run(); };
      m.append(b);
    };
    item(t.pinned ? 'Unpin' : 'Pin', () => { t.pinned = !t.pinned; tabsChanged(); });
    item('Close', () => closeTab(t.id));
    item('Close others', async () => {
      for (const o of tabs.filter((x) => x !== t)) await closeTab(o.id);
    });
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
      // in a text field Alt+Arrow moves by word on a Mac, and that wins
      && !(e.target.closest && e.target.closest('input, textarea, select, [contenteditable]'))) {
      e.preventDefault();
      if (e.key === 'ArrowLeft') tabBack(); else tabFwd();
    }
  });
  // a link to a document: a click goes through openIn with its event, so
  // Ctrl/Cmd and the middle button open a new tab
  const tabLink = (el, kind, key, opts = {}) => {
    const go = (e) => { e.preventDefault(); openIn(kind, key, { ...opts, ev: e }); };
    el.onclick = go;
    el.onauxclick = (e) => { if (e.button === 1) go(e); };
  };

  // for the browser suites, which cannot reach this scope
  window.latTabs = {
    openIn, switchTab, closeTab, tabBack, tabFwd,
    list: () => tabs.map(({ id, kind, key, ship, pinned }) => ({ id, kind, key, ship, pinned })),
    state: () => ({
      tabs: tabs.map(({ id, kind, key, ship, pinned, snap }) =>
        ({ id, kind, key, ship, pinned, dirty: !!(snap && snap.dirty) })),
      active: tabs.indexOf(activeTab),
      shows: !!activeTab && TAB_KINDS[activeTab.kind].shows(activeTab),
    }),
  };

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
    const lineStart = value.slice(0, selStart).lastIndexOf('\n') + 1;
    // fenced code is literal text (the same rule listEnter applies): a Tab
    // inside a fence is indentation for CODE, not for a list that is not one.
    // Parity is counted up to LINE start, not caret: this is a line
    // operation, so the question is whether the line begins inside a fence —
    // and a caret-relative count changed its answer between an indent and
    // the outdent that undoes it when the line itself opens with a fence
    // marker (found by the round-trip property, seed 1105911052).
    const fences = value.slice(0, lineStart).match(/^[ \t]*(?:```|~~~)/gm);
    if (fences && fences.length % 2 === 1) return null;

    // a selection ending at column 0 does not include that line: shift-down
    // leaves the anchor there, and indenting a line the user never touched
    // is the surprise every editor avoids
    const effEnd = selEnd > selStart && value[selEnd - 1] === '\n' ? selEnd - 1 : selEnd;
    let spanEnd = value.indexOf('\n', Math.max(effEnd, selStart));
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

// ── src/23-tabhead.js ─────────────────────────────────────────────────────
  // ── tab header ───────────────────────────────────────────────────────────
  // Between the tab strip and the document: Back and Forward, the path of
  // what is open, Edit / Read, Save and the page menu. The name field, the
  // kind picker and the LaTeX convert button sit here in a hidden holder:
  // nothing shows them, but they are the stores and the handlers these
  // buttons call (#pname, #pkind, #texconv), as #mv and #del in the Page tab
  // are.
  //
  // Save is an icon on a phone while a grub is in front, the one document
  // with no autosave and, there, no keyboard for Ctrl+S. Everywhere else it
  // is hidden: pages and memories autosave, and the desktop has Ctrl+S and
  // the File menu, which clicks #save, as vim's :w does.
  //
  // Edit and Read are one choice per tab, kept on the tab (`read`, which
  // 21-tabs.js persists). There is no split: Edit hides the preview, Read
  // hides the editor.

  // the page kinds: the hidden picker's options and the page menu's Kind list
  const KINDS = ['md', 'gmi', 'html', 'text', 'js', 'css', 'tex', 'hoon'];
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
  $('center').insertBefore(tabHead, $('docarea'));
  pname = $('pname'); pkind = $('pkind');
  for (const b of $('tread').children) b.title = 'Edit / Read (Ctrl+E)';
  $('tback').onclick = () => tabBack();
  $('tfwd').onclick = () => tabFwd();
  // the move / rename flow of the controls pane, unchanged. A tab that is
  // not a document shows only its title there.
  $('tpath').onclick = () => { if (docFront()) $('mv').click(); };
  clickAction('tback', 'Back', 'Tab header', 'Alt+Left');
  clickAction('tfwd', 'Forward', 'Tab header', 'Alt+Right');
  clickAction('tpath', 'Move or rename', 'Tab header');
  clickAction('edit', 'Edit', 'Tab header', 'Ctrl+E');
  clickAction('read', 'Read', 'Tab header', 'Ctrl+E');
  clickAction('tmenu', 'Page menu', 'Tab header');

  // Read for the tab in front. Entering it shows the preview, which skipped
  // its renders while off screen (60-preview.js)
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
    // the vim indicator reads PREVIEW in Read
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
  // the desktop View menu evals these (desktop/src/main.rs)
  window.latSetRead = setRead;
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'e' || e.key === 'E')
      // vim keeps Ctrl+E (scroll) while the editor has focus
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
  // every writer of the name goes through setOpen (20-state.js), which fires
  // 'input' on the field, and typing fires it natively
  pname.addEventListener('input', paintPath);
  pkind.addEventListener('change', paintPath);

  // called by paintTabs: the tab in front changed, or its stacks did. A tab
  // that is not a document (a tool, 24-tools.js) has no Edit / Read and no
  // page menu.
  function paintHead() {
    const tool = !docFront();
    $('tread').hidden = tool;
    $('tmenu').hidden = tool;
    // Save's one showing, on a phone (the 820px block): a grub in front
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

  // ── the page menu ────────────────────────────────────────────────────────
  // Each item calls the handler that already exists. An item that does not
  // apply to what is open is left out, not greyed: a grub has no kind, a
  // memory has no raw source.
  let pmenuEl = null;
  let pmenuTab = null;   // the tab the open menu was made for
  const pmenuClose = () => { if (pmenuEl) { pmenuEl.remove(); pmenuEl = null; } };

  // Duplicate: a new page beside this one, same kind and body, named
  // <name>-copy until the user says otherwise
  async function dupPage() {
    if (!current || grubPath || mode === 'know' || curFolder !== null) return;
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

  // Download: what is in the editor now, as a file named for the last path
  // segment. A memory is markdown.
  const DLEXT = { text: 'txt' };
  function downloadDoc() {
    if (!current || grubPath || curFolder !== null) return;
    const kind = mode === 'know' ? 'md' : (pkind.value || 'md');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([src.value], { type: 'text/plain' }));
    a.download = current.split('/').pop() + '.' + (DLEXT[kind] || kind);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // which items apply to what is open. The menu shows these and the
  // palette lists these, so the two never disagree.
  function pmenuHas() {
    const doc = !grubPath && curFolder === null;       // a page or a memory
    const page = doc && mode !== 'know';
    const has = new Set(['wrap']);
    if (page) has.add('kind');
    if (page && current) { has.add('dup'); has.add('raw'); }
    if (doc && current) { has.add('download'); has.add('del'); }
    if (page && linkOf(current)) has.add('linkback');
    // a folder view: Delete is #del's folder branch, its own confirm and all
    if (!grubPath && curFolder !== null) has.add('del');
    if (page && window.__TAURI__ && (curKind === 'tex' || pkind.value === 'tex')) has.add('tex');
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
          pkind.value = k;
          pkind.dispatchEvent(new Event('change'));
        };
        sub.append(b);
      }
      item('kind', 'Kind ▸', () => { sub.hidden = !sub.hidden; });
      m.append(sub);
    }
    item('wrap', 'Line wrap', done(() => flip('appWrap')), localStorage.appWrap === '1');
    if (has.has('dup')) item('dup', 'Duplicate', done(dupPage));
    if (has.has('download')) item('download', 'Download', done(downloadDoc));
    // the hidden button's title says whether pandoc is there (71-latex.js)
    if (has.has('tex')) item('tex', 'Convert to HTML', done(() => $('texconv').click())).title =
      $('texconv').title;
    if (has.has('raw')) item('raw', 'Open raw', done(() =>
      window.open(api + '/page-source?name=' + encodeURIComponent(current), '_blank', 'noopener')));
    if (has.has('linkback'))
      item('linkback', 'Move back to shared with me', done(() => $('linkback').click()));
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
  // The items are built when the menu opens, so a palette action opens it
  // and clicks the item, which is the menu's own path. Kind opens the menu
  // with its list unfolded, as clicking Kind does. Convert to HTML exists
  // only in the desktop app.
  for (const [id, name] of [['kind', 'Change page kind'], ['wrap', 'Line wrap'],
    ['dup', 'Duplicate page'], ['download', 'Download'], ['tex', 'Convert to HTML'],
    ['raw', 'Open raw'], ['del', 'Delete']]) {
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
  // a link's way back out. Its home is the button in the Page tab's link
  // section (65-ctl.js), which is always there; the menu item clicks it.
  action({ id: 'linkback', name: 'Move back to shared with me', home: 'Page menu',
    when: () => docFront() && pmenuHas().has('linkback'),
    run: () => $('linkback').click() });
  addEventListener('mousedown', (e) => {
    if (pmenuEl && !pmenuEl.contains(e.target) && !$('tmenu').contains(e.target)) pmenuClose();
  }, true);
  addEventListener('keydown', (e) => {
    if (pmenuEl && e.key === 'Escape') { pmenuClose(); $('tmenu').focus(); }
  });

// ── src/24-tools.js ───────────────────────────────────────────────────────
  // ── tool tabs and the ribbon ─────────────────────────────────────────────
  // A tool tab holds no document: the comments inbox, access & groups, the
  // sync conflicts, or a same-origin page in a frame (Settings, the memory
  // review). Its key names the tool ('inbox', 'access', 'conflicts') or the
  // frame ('frame:/apps/lattice/settings'). While one is in front the
  // document area is hidden and #toolhost takes the center. The editor
  // underneath keeps whatever the parked tab left there, untouched: the
  // tool kind has no live(), so nothing a tool does is ever filed under a
  // document's tab.
  const toolHost = document.createElement('div');
  toolHost.id = 'toolhost';
  toolHost.className = 'toolhost';
  toolHost.hidden = true;
  $('docarea').after(toolHost);

  // the client tools: their name, icon, the overlay element each one used
  // to be (72-acl.js, 73-comments.js, 80-conflicts.js) and what fills it
  const TOOLS = {
    inbox: { name: 'Comments inbox', icon: 'inbox', wrap: 'cmwrap', load: () => cmLoad() },
    access: { name: 'Access & groups', icon: 'key', wrap: 'aclwrap', load: () => aclLoad() },
    conflicts: { name: 'Sync conflicts', icon: 'conflict', wrap: 'cfwrap', load: () => renderConflicts() },
  };
  const FRAMES = {
    '/apps/lattice/settings': ['Settings', 'gear'],
    '/apps/lattice/know?lint=1': ['Memory review', 'tidy'],
  };
  const SETTINGS = 'frame:/apps/lattice/settings';
  // only a lattice path on this origin, whatever the key says: a frame is
  // dressed by reaching into it, and a key can come from typed input
  const frameUrl = (key) => {
    if (!key.startsWith('frame:')) return null;
    let u;
    try { u = new URL(key.slice(6), location.origin); } catch { return null; }
    if (u.origin !== location.origin || !/^\/apps\/lattice(\/|$)/.test(u.pathname)) return null;
    return u.pathname + u.search;
  };
  const toolMeta = (key) => {
    if (TOOLS[key]) return [TOOLS[key].name, TOOLS[key].icon];
    const u = frameUrl(key);
    return u ? FRAMES[u] || [u, 'globe'] : [key, 'gear'];
  };
  // every way into a tool. A tool gets a tab of its own rather than
  // replacing the document in front, and an open one is focused. On a phone
  // the drawer it was opened from goes away, also when the tool was in
  // front already.
  const toolOpen = async (id) => {
    await openIn('tool', id === 'settings' ? SETTINGS : id, { newTab: true });
    drawersClose();
  };

  // which tool the host shows, null while a document is in front
  let toolShown = null;
  TAB_KINDS.tool = {
    icon: (t) => toolMeta(t.key)[1],
    label: (t) => toolMeta(t.key)[0],
    open: async (t) => {
      toolSync();
      if (TOOLS[t.key]) TOOLS[t.key].load();
      return true;
    },
    // a tool has no buffer, so nothing to park and nothing to restore
    restore: () => {},
    park: async () => true,
    shows: (t) => t === activeTab && toolShown === t.key,
  };

  // Called by paintHead on every change of the tab in front. Shows the host
  // or the document area, and in the host only the front tool. A wrap that
  // is not in front is hidden, which is how 90-sync.js knows the inbox is
  // not being read. A frame whose tab has closed goes away.
  function toolSync() {
    const t = activeTab && activeTab.kind === 'tool' ? activeTab : null;
    const was = toolShown;
    toolShown = t ? t.key : null;
    $('docarea').hidden = !!t;
    toolHost.hidden = !t;
    if (t) toolMount(t.key);
    for (const f of [...toolHost.querySelectorAll('iframe')])
      if (!tabs.some((x) => x.kind === 'tool' && x.key === f.dataset.tool)) f.remove();
    for (const c of toolHost.children) c.hidden = c.dataset.tool !== toolShown;
    // the right pane goes by what is in front (76-outline.js)
    if (was !== toolShown) rpSoon();
  }
  function toolMount(key) {
    if (TOOLS[key]) {
      const w = $(TOOLS[key].wrap);
      if (!w || w.parentNode === toolHost) return;
      w.classList.add('intab');
      w.dataset.tool = key;
      toolHost.append(w);
      return;
    }
    const url = frameUrl(key);
    if (!url || [...toolHost.querySelectorAll('iframe')].some((f) => f.dataset.tool === key)) return;
    const f = document.createElement('iframe');
    f.className = 'toolframe';
    f.dataset.tool = key;
    f.title = toolMeta(key)[0];
    f.onload = () => frameDress(f);
    f.src = url;
    toolHost.append(f);
  }
  // Each load of a frame: the reader's own bar is hidden, since the shell
  // around it is the chrome now. A link in it to a document in the editor
  // opens that document in a new tab of the shell, never over the frame's
  // own tab and never as a second editor nested in the frame. Any other
  // link navigates the frame as usual.
  function frameDress(f) {
    let d = null;
    try { d = f.contentDocument; } catch {}
    if (!d || !d.head) return;
    const s = d.createElement('style');
    s.textContent = 'form.bar{display:none}';
    d.head.append(s);
    d.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || e.defaultPrevented) return;
      let u;
      try { u = new URL(a.href); } catch { return; }
      if (u.origin !== location.origin || !/^\/apps\/lattice\/app\/?$/.test(u.pathname)) return;
      const q = u.searchParams;
      const go = q.get('grub') ? ['grub', q.get('grub'), q.get('ship') || null]
        : q.get('view') === 'know' ? ['know', q.get('key') || '', null]
          : q.get('name') ? ['page', q.get('name'), null] : null;
      if (!go) return;
      e.preventDefault();
      openIn(go[0], go[1], { ship: go[2], newTab: true });
    });
  }
  // Escape used to close the overlays. A tab is closed by its own close,
  // so here Escape only lets go of a field.
  addEventListener('keydown', (e) => {
    const a = document.activeElement;
    if (e.key === 'Escape' && a && a !== document.body && toolHost.contains(a)) a.blur();
  });

  // ── today's brief ────────────────────────────────────────────────────────
  // orrery writes the brief to journal/<day>. Whether that day is padded is
  // not settled, so the first of the two forms that exists wins, and with
  // neither the unpadded one is the name a new page starts with.
  const briefForms = (d) => {
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    const p2 = (n) => String(n).padStart(2, '0');
    return ['journal/' + y + '.' + m + '.' + day, 'journal/' + y + '.' + p2(m) + '.' + p2(day)];
  };
  const hasPage = (k) => nodes.some((n) => n.page && n.path === k);
  function briefKey(d) {
    const forms = briefForms(d);
    return forms.find(hasPage) || forms[0];
  }
  async function openBrief(ev) {
    const d = new Date();
    let key = briefKey(d);
    let found = hasPage(key);
    // an empty tree has not loaded yet, so the ship says which form exists.
    // Opening a missing page would leave the tab blank and locked.
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

  // ── leaving the editor ───────────────────────────────────────────────────
  // Browser, Forum and Explorer navigate the window. The front document gets
  // guardDirty, and the parked tabs holding unsaved work get one question
  // naming them. Once the user has said discard, nothing is owed, so the
  // unload guard (35-pages.js) does not ask a second time.
  // With autosave off the parked tabs hold ordinary unsaved pages, so the
  // question offers to save them all, each brought forward and saved in
  // turn. One that does not save stops the leaving, with it in front.
  const leaveThen = (go) => tabSerial(async () => {
    if (!(await guardDirty())) return;
    const bg = tabs.filter((t) => t !== activeTab && t.snap && t.snap.dirty);
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
    //  a saved tab came to the front, where it has no snap
    for (const t of bg) if (t.snap) t.snap.dirty = false;
    await go();
  });
  const leaveTo = (url) => leaveThen(() => { location.href = url; });
  // Settings > Connection and mounts, and Settings > Backup > Scheduled
  // backups (section 'backups'), on the desktop. The shell rebuilds the
  // window onto its own manager page (open_manager in
  // desktop/src/commands.rs), and no unload guard sees a window go, so the
  // same questions come first.
  window.latOpenManager = (section) => leaveThen(async () => {
    try { await window.__TAURI__.core.invoke('open_manager', { section: section || null }); }
    catch (e) { st('could not open the desktop settings: ' + e, false); }
  });

  // the Settings tab, opened or focused, with its frame scrolled to the
  // section #anchor. A frame still loading scrolls once it has. Sections
  // above the anchor fill in after load (the key list), so the anchor is
  // held at the top while the page settles, until the user scrolls or
  // clicks or two seconds pass. Preferences on the desktop does not come
  // here: it opens the manager page (latOpenManager above).
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
    const f = [...toolHost.querySelectorAll('iframe')].find((x) => x.dataset.tool === SETTINGS);
    if (!f || !anchor) return;
    let ready = false;
    try { ready = f.contentDocument.readyState === 'complete' && f.contentDocument.URL !== 'about:blank'; } catch {}
    if (ready && frameScroll(f, anchor)) return;
    f.addEventListener('load', () => frameScroll(f, anchor), { once: true });
  };

  // the command palette (26-palette.js) sets this to its opener
  let paletteOpen = () => {};

  // top to bottom, with Settings in the lower group
  ribbonAdd({ id: 'brief', icon: 'cal', name: "Today's brief", run: (ev) => openBrief(ev) });
  ribbonAdd({ id: 'browser', icon: 'globe', name: 'Browser', run: () => leaveTo('/apps/lattice') });
  ribbonAdd({ id: 'forum', icon: 'forum', name: 'Forum', run: () => leaveTo('/apps/lattice/forum') });
  // the unread badge (73-comments.js) and the conflict count
  // (80-conflicts.js) are painted onto these two
  ribbonAdd({ id: 'inbox', icon: 'inbox', name: 'Comments inbox', run: () => toolOpen('inbox') });
  ribbonAdd({ id: 'access', icon: 'key', name: 'Access & groups', run: () => toolOpen('access') });
  ribbonAdd({ id: 'explorer', icon: 'tree', name: 'Explorer', run: () => leaveTo('/apps/lattice/x') });
  ribbonAdd({ id: 'conflicts', icon: 'conflict', name: 'Sync conflicts', run: () => toolOpen('conflicts') })
    .hidden = true;
  ribbonAdd({ id: 'palette', icon: 'term', name: 'Command palette', keys: 'Ctrl+P', run: () => paletteOpen() });
  ribbonAdd({ id: 'settings', icon: 'gear', name: 'Settings', bottom: true, run: () => toolOpen('settings') });

// ── src/25-editor.js ──────────────────────────────────────────────────────
  // ── editor pane: <lat-editor> + highlighting (Prism overlay) ─────────────
  let src, hl;   // assigned when <lat-editor> upgrades (below, synchronously)
  const LMAP = { md: 'markdown', gmi: 'gemtext', html: 'markup',
                 js: 'javascript', css: 'css', hoon: 'hoon', tex: 'latex' };
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // Prism runs in a worker (prism.js installs a message handler there).
  // Some grammars scan to the end of the input from every start position
  // when a construct is unterminated, so 32 KiB of '[' took five seconds on
  // the main thread and froze the editor on every keystroke (security audit
  // run-1). One job in flight, the newest text queued behind it. A job slow
  // to answer leaves plain text painted, and past the deadline the worker
  // is killed and the text stays plain.
  // A fresh worker first fetches prism.js, which on the desktop goes through
  // the bridge to the ship and can take seconds, so its first job gets a
  // startup allowance on top of the deadline. Without it every new worker
  // was killed before it could answer, and the editor never highlighted.
  const HL_PLAIN = 50, HL_DEADLINE = 1500, HL_STARTUP = 10000;
  let hlWorker = null, hlFresh = false, hlCur = null, hlNext = null, hlPlain = 0, hlKill = 0;
  const hlDone = () => {
    clearTimeout(hlPlain); clearTimeout(hlKill); hlCur = null;
    if (hlNext) { const j = hlNext; hlNext = null; hlRun(j); }
  };
  const hlPaint = (body) => { hl.innerHTML = esc(body) + '\n'; sync(); };
  const hlRun = (job) => {
    // newer text while a job runs shows plain until its own turn
    if (hlCur) { hlNext = job; hlPaint(job.body); return; }
    if (!hlWorker) {
      try { hlWorker = new Worker('/apps/lattice/prism.js'); } catch { hlPaint(job.body); return; }
      hlFresh = true;
      hlWorker.onmessage = (e) => {
        hlFresh = false;
        const j = hlCur;
        if (j && j.body === src.value && j.lang === LMAP[pkind.value]) {
          hl.innerHTML = e.data + '\n'; sync();
        }
        hlDone();
      };
      hlWorker.onerror = () => { hlWorker = null; hlDone(); };
    }
    hlCur = job;
    hlPlain = setTimeout(() => hlPaint(job.body), HL_PLAIN);
    hlKill = setTimeout(() => {
      if (hlWorker) hlWorker.terminate();
      hlWorker = null; hlDone();
    }, HL_DEADLINE + (hlFresh ? HL_STARTUP : 0));
    hlWorker.postMessage(JSON.stringify({ language: job.lang, code: job.body }));
  };
  // the right pane's Outline and Outgoing read the text, so every paint of
  // it, typed or scripted, tells them (rpSoon, 76-outline.js, set there)
  let rpHook = null;
  const render = () => {
    if (rpHook) rpHook();
    const lang = LMAP[pkind.value];
    const g = window.Prism && lang && Prism.languages[lang];
    if (!g || typeof Worker === 'undefined') { hl.innerHTML = esc(src.value) + '\n'; return; }
    hlRun({ body: src.value, lang });
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
  pkind.addEventListener('change', () => {
    curKind = pkind.value;
    render();
    //  the kind rides every save as a query param, so switching it on an open
    //  page must dirty the editor or navigating away silently reverts the
    //  choice. A page with no name yet gets its kind from the first save.
    if (current) edited();
    refreshTexButton();
  });

// ── src/26-palette.js ─────────────────────────────────────────────────────
  // ── command palette: Ctrl/Cmd+P and the ribbon ───────────────────────────
  // An index over the homes, never a home itself (spec, principle 3). It
  // lists the actions their homes registered (13-frame.js, action()), then
  // pages and memories by name. An action row names its home and shortcut,
  // so the palette also teaches where a thing lives. Running a row does what
  // its home does: an action's run, or openIn for a document, which replaces
  // the front tab or, with Ctrl/Cmd held, opens a new one.
  //
  // Every action must have a home in the DOM: its element carries
  // data-action="<id>" (the suite checks each one). PALETTE_ONLY would name
  // the exceptions, and it is empty by design.
  const PALETTE_ONLY = [];
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

  // Subsequence match, case-insensitive. Lower is better: the query as a
  // word start, then anywhere as one run, then spread out (tighter first).
  // null is no match.
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
  // an action is listed while its home is there to use: present, not
  // hidden (a pane tab's own section does not count), not disabled. A home
  // built only while open says so itself (when).
  const palUsable = (a) => {
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
      // mousedown, so the input keeps focus until the row runs
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
    // the memory list loads when its tab is first shown (95-know.js), and
    // the palette lists memories too
    if (!knowHave) loadKnow().then(() => { if (!pal.hidden) palPaint(); });
  }
  function palClose() {
    if (pal.hidden) return;
    pal.hidden = true;
    const f = palFrom; palFrom = null;
    if (f && f.isConnected) f.focus();
  }
  // closed first, so what the row opens (a menu, a dialog, a tab) gets
  // the focus, not the palette's leftover
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
  // a click on the backdrop, outside the box, closes it
  pal.addEventListener('mousedown', (e) => { if (e.target === pal) palClose(); });

  // Ctrl/Cmd+P never reaches the print dialog. Vim keeps the chord while
  // the editor has focus, the rule Ctrl+E follows (23-tabhead.js), and an
  // open dialog is left to finish first.
  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || (e.key !== 'p' && e.key !== 'P')) return;
    e.preventDefault();
    if (localStorage.edVim === '1' && document.activeElement === src) return;
    if (!$('dlg').hidden) return;
    palShow();
  }, true);

  // for the browser suites, which cannot reach this scope
  window.latPalette = { ids: () => ACTIONS.map((a) => a.id), only: PALETTE_ONLY };

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
    if(!vimOn()){ ind.style.display = "none"; return; }
    ind.style.display = "inline-block";
    // preview-only view: the editor is off screen and vim keys do not apply,
    // so show the view, not a stale mode. (split and edit keep the mode.)
    var pv = document.getElementById("ws");
    if(pv && pv.classList.contains("vp")){
      ind.textContent = "-- PREVIEW --"; ind.style.background = "#607d8b"; return;
    }
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
    // the selection runs low to high whichever way the caret moved: the
    // visual handler reads visCaret directly, never the DOM caret.
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

    // A bare modifier keydown must not touch pending state. `rD` is r, then
    // Shift (to reach the capital), then D — Shift is its own keydown, and if
    // it fell through to the r-consumer below it would clear pending, so D
    // then ran as its own delete-to-end-of-line command. Swallow it and wait
    // for the real key. Same for any r/f/t followed by a shifted character.
    if(k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return true;

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
        // $ lands the head on the last real column, not on the newline, so
        // visRange's inclusive +1 stops at the line end and v$d/v$y keep the
        // line break instead of swallowing it and joining the next line.
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
          // paste over selection: snapshot register BEFORE the delete clobbers it
          var sText = reg, sLine = regLinewise;
          deleteRange(a, b, a);
          reg = sText; regLinewise = sLine;
          MODE = "normal";
          // A charwise register fills the deleted hole exactly at `a`. The old
          // `setPos(a-1); paste(true)` leaned on paste's after-offset, which
          // cannot reach index 0, so a selection anchored at column 0 pasted
          // one character late. Insert straight at `a`; a linewise register
          // still goes through paste for its line-insert handling.
          if(sLine){ setPos(a > 0 ? a - 1 : a); paste(true); }
          else { insertAt(a, reg); setPos(normClamp(a + reg.length - 1)); }
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

  //  The toggle lives on the settings page, which is a SEPARATE document on
  //  this origin, exactly like the font and size preferences. It writes the
  //  flag and the storage event brings it here, so no button is injected into
  //  the shell (which is managed markup). An unset flag is off: vimOn()
  //  and the settings checkbox both test for "1".
  window.addEventListener("storage", function(e){
    if(!e.key || e.key === LS) applyVim();
  });
  applyVim();
  // setInd lives inside this IIFE, so the layout toggles (85-layout.js, in the
  // outer shared scope) cannot see it directly. Expose it: a same-tab view
  // change there must refresh the indicator (it reads PREVIEW in preview-only).
  window.latVimSetInd = setInd;
})();

// ── src/30-tree.js ────────────────────────────────────────────────────────
  // ── page kind <-> extension, once for the whole bundle ───────────────────
  // `kind` is what the ship stores (page-save?type=); `ext` is what a filename
  // shows. They differ for `text`, and `index` is a page the ship generates
  // (+make-folder-index) whose file form is markdown. Everything in the bundle
  // reads these two tables: the tree below, the uploader (70-upload.js) and
  // the desktop File menu (96-deskmenu.js). Those files are numbered after
  // this one and the build concatenates in filename order into one scope, so
  // the names are visible there.
  //
  // Two copies live outside the bundle and have to be kept in step by hand:
  // ui-app/vault.js, which is also served alone to the Settings page with no
  // bundle around it, and lattice-fs-rs/src/projection.rs, another process in
  // another language.
  //
  // `htm` and `text` are INBOUND-ONLY aliases: archives written before the
  // extension was conventionalised named those files `.text`, and a restore
  // has to keep reading archives this app already handed out.
  const KIND_EXT = { md: 'md', gmi: 'gmi', html: 'html', text: 'txt', js: 'js',
                     css: 'css', hoon: 'hoon', index: 'md', tex: 'tex' };
  const EXT_KIND = { md: 'md', gmi: 'gmi', html: 'html', htm: 'html', txt: 'text',
                     text: 'text', js: 'js', css: 'css', hoon: 'hoon', tex: 'tex',
                     latex: 'tex' };
  //  an unknown kind shows as hoon, the kind that holds arbitrary source
  const kindExt = (k) => KIND_EXT[k] || 'hoon';
  //  an unknown extension is null, never guessed: the caller skips that file
  const extKind = (e) => EXT_KIND[String(e || '').toLowerCase()] || null;

  // ── tree pane: <lat-tree> ────────────────────────────────────────────────
  // The pane's buttons are wired where their handlers live (45-templates,
  // 70-upload). Those files run after this component upgrades, so their
  // $-lookups find the rendered elements. The create and upload buttons sit
  // in their own .newbtns group because the desktop File menu takes them
  // over and hides that group (96-deskmenu.js); sort and collapse stay.
  let treeList;
  // pages other ships shared with us (/shared-with-me), drawn as a folder
  // after the pages. Filled by 69-shared.js.
  let sharedWithMe = [];
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
  // page-dump, not page-tree: it returns the same nodes PLUS every page's body
  // inline from ONE deep peek, and measures FASTER than page-tree (which
  // re-peeks each code grub). Those bodies are what make opening a page cost
  // zero requests. See openPage. Bodies over 256KB are omitted by the server.
  // Such a node has no `body` and falls back to the per-page fetch.
  // ponytail: whole-store payload (~55KB today). If the tree ever grows past
  // a megabyte, page it or go back to page-tree plus a lazy body cache.
  // the beacon rev the last applied dump was fetched at (see revFresh)
  let treeAt = '';
  // whether `nodes` carries each page's share mode: a dump with a `since`
  // token does (a share-less node is private). A tree an older ship sent,
  // or one restored from before it did, does not, and absent there means
  // unknown, not private.
  let treeShares = false;
  async function loadTree() {
    const gen = treeGen;
    const at = lastRev;
    let d = null;
    // this one RESOLVES, always. Boot chains its whole reconcile off it
    // (99-boot.js) with no .catch, so a rejection here would silently cancel
    // loadPanels, the open/reconcile branch and legacyCheck, and show nothing.
    // A dead pier is a reportable condition, the way openPage and loadPerms
    // already report theirs. Offline is a state this app is built for.
    try {
      const r = await fetch(api + '/page-dump');
      if (!r.ok) {
        if (await sessionGone(r)) return;
        st('tree failed' + await errText(r), false); return;
      }
      d = await r.json();
    } catch { st('tree failed (network)', false); return; }
    if (gen !== treeGen) return;   // a local patch superseded this response
    // the dump's beacon rev is the baseline for a FIRST-EVER session: the
    // stream only reports from registration onward, and with nothing
    // remembered the registration comparison had nothing to catch a bump
    // that landed between this snapshot and that registration. Never
    // overwrite a stream-observed rev — the snapshot may already trail it.
    //
    // From `since`, the token string, never `rev`: that is a JSON number near
    // 1.7e38, which JSON.parse rounds, so String(d.rev) read
    // "1.701411845081946e+38" against the stream's exact digits. They never
    // matched, and every first session refetched the whole dump once the
    // stream registered.
    if (!lastRev && typeof d.since === 'string') noteRev(d.since);
    nodes = d.nodes;
    treeShares = typeof d.since === 'string';
    treeAt = at;
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
    // always: #treelist holds only the files tree (the memory tree has its
    // own #knowlist), so a memory tab in front is no reason to leave Files
    // stale behind the Knowledge tab
    renderTree();
  }

  // selection changes only move the `cur` class. Never rebuild the pane's DOM
  // for that. rowByPath is rebuilt by renderTree, knowRows by renderKnowTree
  // (95-know.js). `current` names a page or a memory by the mode, so each
  // tree marks it only in its own mode.
  let rowByPath = new Map();
  let knowRows = new Map();
  function markCurrent() {
    for (const [p, row] of rowByPath)
      row.classList.toggle('cur', row.classList.contains('pg')
        ? mode !== 'know' && p === current : p === curFolder);
    for (const [k, row] of knowRows) row.classList.toggle('cur', mode === 'know' && k === current);
    paintLink();
  }

  // ── links: another ship's page in this tree ─────────────────────────────
  // A node with `link` is a link the owner made from shared with me. It
  // opens as a page tab: page-source and page-save go through it to the
  // host, conflict-checked. linkOf names the open link, or null.
  function linkOf(name) {
    const n = name ? nodes.find((x) => x.page && x.path === name) : null;
    return n && n.link && n.link.host ? n.link : null;
  }
  // where a link points, as ~host/<their page>. The path names the page's
  // code grub under wherever lattice is installed there, so only the tail
  // is read (the same rule as sharedName, 69-shared.js).
  function linkFrom(lk) {
    const m = /\/page\/(.+)\/code$/.exec(lk.path || '');
    return lk.host + '/' + (m ? m[1] : String(lk.path || '').replace(/^\/+/, ''));
  }
  // @da (ship UTC) in the viewer's own zone, as the history list shows it
  function daLocal(da) {
    const m = /^~(\d+)\.(\d+)\.(\d+)\.\.(\d+)\.(\d+)\.(\d+)/.exec(da || '');
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toLocaleString(undefined,
      { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  }
  // the badge for a link whose last read failed. The owner's ship cannot
  // tell a revoke from being offline, so it says both. `at` is when a read
  // first failed: the last good read was before it.
  function linkBadge(lk) {
    if (!lk.seen || lk.seen.ok !== false) return null;
    const b = document.createElement('span');
    b.className = 'lbad';
    b.textContent = lk.host + ' unreachable or no longer sharing';
    const at = daLocal(lk.seen.at);
    if (at) b.title = 'not reached since ' + at;
    return b;
  }
  // what a live read through a link just found. The ship records it too
  // (the badge survives a reload); this repaints without waiting for that.
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
  function addTreeNode(name, kind, pending) {
    if (name.includes('/')) addFolderNodes(name.slice(0, name.lastIndexOf('/')));
    const n = nodes.find((x) => x.path === name && x.page);
    if (n) { n.kind = kind; if (pending !== undefined) n.pending = pending; }
    else nodes.push({ path: name, page: true, kind, share: 'private', pending: !!pending });
  }
  // the display name of a page or folder node ('' clears it). Mirrors the
  // `dname` the ship sends in page-dump, so a local patch matches a refetch.
  function setNodeDname(path, dname) {
    const n = nodes.find((x) => x.path === path);
    if (!n) return;
    if (dname) n.dname = dname; else delete n.dname;
  }
  // apply a realName() split to the local tree: the leaf follows rn.dname
  // ('' clears, the way a rename to a valid name does on the ship); a parent
  // folder is only ever SET, never cleared, because an existing folder keeps
  // its own name when something is made inside it under the plain slug.
  function applyDnames(rn) {
    if (!rn) return;
    const segs = rn.name.split('/');
    const per = rn.dnames ? rn.dnames.split('/') : [];
    for (let i = 0; i + 1 < segs.length; i++)
      if (per[i]) setNodeDname(segs.slice(0, i + 1).join('/'), per[i]);
    setNodeDname(rn.name, rn.dname);
  }
  //  A node added before the ship has confirmed it. The row pulses until the
  //  write lands, so the tree can answer instantly without claiming something
  //  that has not happened yet. Clearing it is the success signal; dropping
  //  the node is the failure one.
  function setTreePending(name, pending) {
    const n = nodes.find((x) => x.path === name && x.page);
    if (!n) return;
    if (pending) n.pending = true; else delete n.pending;
    renderTree();
  }
  function dropTreeNodes(path) {
    nodes = nodes.filter((n) => n.path !== path && !n.path.startsWith(path + '/'));
  }

  // one folder row, the same in all three trees (files, shared with me,
  // memories): the fold arrow, then the folder icon (open when unfolded)
  // and its label, both inside the label span, indented
  // by depth. `fold` folds or unfolds it and repaints. A click anywhere on
  // the row folds, unless the row has a `pick` of its own (the files tree
  // selects the folder): then the row picks and only the arrow folds.
  // `key`, in a tree that treeKeys drives, makes the row one of its items.
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

  // ── keyboard: the files and memory trees as ARIA trees ──────────────────
  // The rows are flat siblings indented by depth, so the shape is read from
  // aria-level: a folder's children are the shown rows after it with a
  // deeper level, and its parent the nearest shown row before it with a
  // shallower one. One row at a time is in the tab order (roving tabindex).
  // Enter is the row's own click, with Ctrl/Cmd carried, so a page opens
  // through openIn (tabLink) and Ctrl+Enter gives it a new tab.
  // treeItem marks up one row. `key` names it across a repaint: a fold
  // rebuilds the whole list, and the focus has to land on the same row.
  function treeItem(row, depth, key) {
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', depth + 1);
    row.tabIndex = -1;
    row.dataset.tk = key;
    return row;
  }
  const treeRows = (list) => [...list.querySelectorAll('[role=treeitem]')]
    .filter((r) => r.style.display !== 'none');
  // after a paint: the row last focused, else the open one, else the first,
  // is the one Tab reaches. `refocus` when the focus was in the list before
  // the paint took its rows away.
  // A list with no rows (loading, or an empty-state note) is not a tree:
  // a tree has to own treeitems, so the role comes and goes with them.
  function treeRove(list, refocus) {
    const rows = treeRows(list);
    if (rows.length) list.setAttribute('role', 'tree'); else list.removeAttribute('role');
    const to = rows.find((r) => r.dataset.tk === list.latKey)
      || rows.find((r) => r.classList.contains('cur')) || rows[0];
    if (!to) return;
    to.tabIndex = 0;
    if (refocus) to.focus();
  }
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
      const rows = treeRows(list);
      const i = rows.indexOf(row);
      const open = row.getAttribute('aria-expanded');
      const mod = e.ctrlKey || e.metaKey;
      let to = null;
      if (e.key === 'Enter') {
        // on a control inside the row (a folder's +), that control acts
        const hit = e.target !== row && e.target.closest('a, button') ? e.target : row;
        hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true,
          ctrlKey: e.ctrlKey, metaKey: e.metaKey }));
      } else if (mod || (e.shiftKey && e.key.length > 1)) return;
      else if (e.key === 'ArrowDown') to = rows[i + 1];
      else if (e.key === 'ArrowUp') to = rows[i - 1];
      else if (e.key === 'Home') to = rows[0];
      else if (e.key === 'End') to = rows[rows.length - 1];
      // a fold repaints, and treeRove puts the focus back on this row
      else if (e.key === 'ArrowRight') {
        if (open === 'false') row.latFold();
        else if (open === 'true' && rows[i + 1] && lv(rows[i + 1]) > lv(row)) to = rows[i + 1];
      } else if (e.key === 'ArrowLeft') {
        if (open === 'true') row.latFold();
        else for (let j = i - 1; j >= 0 && !to; j--) if (lv(rows[j]) < lv(row)) to = rows[j];
      } else if (e.key.length === 1 && e.key !== ' ') {
        // type-ahead: the next row whose name starts with the letter. A
        // folder's name is its label, not the fold arrow ahead of it.
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
  // Ctrl+Shift+F: the Files tab (the pane opened if shut), its tree focused.
  // F for Files; Ctrl+Shift+E was Firefox's network monitor, which a page
  // cannot take back. By e.key, so it is the F on the keyboard's own layout.
  // Not while a dialog or the palette is up: focus behind a modal is lost.
  // Registered on the Files tab's own action (13-frame.js), so the tab's
  // tooltip and the palette both show it.
  function treeFocus() {
    treeRove(treeList, false);
    const r = treeList.querySelector('[role=treeitem][tabindex="0"]');
    if (r) r.focus();
  }
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f'
      && !document.querySelector('.dlg:not([hidden])')) {
      e.preventDefault();
      e.stopPropagation();
      ACTIONS.find((a) => a.id === 'pt-files').run();
    }
  }, true);

  // ── sort order and collapse all ─────────────────────────────────────────
  // Siblings sort by name, folders first, ascending or descending
  // (localStorage.appSort). The order is per level, so a folder's pages stay
  // under it whichever way its siblings run.
  const SORTS = { name: 'Sort: name', 'name-desc': 'Sort: name, descending' };
  const treeSort = () => (localStorage.appSort === 'name-desc' ? 'name-desc' : 'name');
  function treeOrder(list) {
    const dir = treeSort() === 'name-desc' ? -1 : 1;
    return list.map((n) => ({ n, s: n.path.split('/') })).sort((a, b) => {
      const m = Math.min(a.s.length, b.s.length);
      for (let i = 0; i < m; i++) {
        if (a.s[i] === b.s[i]) continue;
        const fa = i < a.s.length - 1 || !a.n.page;
        const fb = i < b.s.length - 1 || !b.n.page;
        if (fa !== fb) return fa ? -1 : 1;
        return dir * a.s[i].localeCompare(b.s[i]);
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
  // the toolbar's palette actions. The create and upload buttons are wired
  // in 45-templates.js and 70-upload.js; a click reaches those handlers.
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
        // the display name when there is one (a typed name that was not a
        // valid path), the path segment otherwise; the real path in the tip
        row.innerHTML = ico(lk ? 'link' : kindExt(n.kind));
        row.append(document.createTextNode((n.dname || n.path.split('/').pop()) + '.' + kindExt(n.kind)));
        if (n.dname) row.title = n.path;
        // a link to another ship's page: whose it is on hover, and the
        // badge once a read through it has failed
        if (lk) {
          row.dataset.host = lk.host;
          row.dataset.path = n.path;
          row.title = linkFrom(lk);
          const bad = linkBadge(lk);
          if (bad) row.append(bad);
        }
        treeItem(row, depth, 'p:' + n.path);
        if (n.share === 'clearweb') {
          const cw = document.createElement('span');
          cw.className = 'cw';
          cw.textContent = '\u{1F310}';
          cw.title = n.path + ' is clearweb public';
          row.append(cw);
        }
        tabLink(row, 'page', n.path);
      } else {
        row = folderRow(n.dname || n.path.split('/').pop(), depth, coll.includes(n.path),
          () => { paneColl.flip(n.path); renderTree(); }, () => pickFolder(n.path), 'f:' + n.path);
        linkDrop(row, n.path);       // a shared-with-me row dropped here (69-shared.js)
        if (n.path === curFolder) row.classList.add('cur');
        if (n.dname) row.lastChild.title = n.path;     // the label's tip
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
        add.tabIndex = -1;          // the tree is one tab stop; New page does this
        add.onclick = async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (await guardDirty()) newFile(n.path);
        };
        row.append(add);
      }
      if (hidden) row.style.display = 'none';
      rowByPath.set(n.path, row);
      treeList.appendChild(row);
    }
    if (sharedWithMe.length) renderShared(coll);
    treeRove(treeList, had);
    paintLink();                 // the Page tab's link section (65-ctl.js)
    // the Published pages list (72-acl.js) reads these share modes
    const aw = $('aclwrap');
    if (aw && !aw.hidden) renderPublished();
    // the conflict badge is a count of conflicts/ pages in this very tree, so
    // it repaints exactly when the tree does. Defined in 80-conflicts.js.
    renderConfBadge();
  }

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

  // a folder picked by the user: it paints over the editor, so it gets a
  // document tab if a tool is in front, and what is unsaved there goes
  // through guardDirty first, like any other way off a document
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
    showShare(treeShare(path));
    const c = pageCount(path);
    st('folder · ' + c + ' page' + (c === 1 ? '' : 's'));
  }

// ── src/31-marks.js ───────────────────────────────────────────────────────
  // ── bookmarks: <lat-marks> ───────────────────────────────────────────────
  // The left pane's Bookmarks tab: the urb:// and web bookmarks the reader
  // keeps (GET /bookmarks-json, newest first), grouped by folder, with a
  // filter, and per bookmark a refile and a remove. A click opens the
  // bookmark in the reader, in this window for now (the reader becomes a
  // tab later), so it leaves the editor through guardDirty like any other
  // navigation. Ctrl/Cmd or a middle click is the browser's own new tab and
  // leaves nothing.
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

  // leaving the editor for the reader: the same question every other way
  // out asks. guardDirty flushes the front document or asks about it, and a
  // parked tab's unsaved buffer still gets beforeunload (35-pages.js).
  async function markGo(e, url) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (!(await guardDirty())) return;
    dirty = false;                       // flushed, or the user said discard
    clearTimeout(autoTimer);
    location.href = readerUrl(url);
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
    if (!(await askConfirm('remove bookmark ' + (b.title || b.url) + '?', 'remove'))) return;
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

  // folders first by name, then the unfiled ones, each newest first as the
  // ship keeps them. A filter shows every match, folded folder or not.
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
  // fetched each time the tab is shown: the reader adds and removes
  // bookmarks in other windows, and this is one small request
  document.addEventListener('lat-pane', (e) => {
    if (e.detail.side === 'l' && e.detail.id === 'marks') loadMarks();
  });
  if (paneShows('l', 'marks')) loadMarks();

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
  // openKnow and openGrub take a number from the same sequence, and so does
  // a tab switch (21-tabs.js), so any later open supersedes this one.
  //
  // Answers false when the open failed with nothing painted, which the tab
  // model tells apart from an open that a later one superseded.
  let openSeq = 0;
  async function openPage(name) {
    // guardDirty covers a dirty grub, page, or memory in one place (see
    // 20-state.js): it flushes what it can and only asks when the flush
    // still leaves something unsaved.
    if (!(await guardDirty())) return false;
    const my = ++openSeq;
    // leaving grub mode: clear the flag or the save button would keep writing
    // to the grub while the editor shows a page
    grubPath = null;
    // and knowledge mode: search results and the comments inbox open pages
    // from know mode, and a stale mode routed the next save to /know-save —
    // a new memory named after the page, while the page kept its old body
    if (mode === 'know') setMode('pages');
    src.readOnly = false;
    setFolderCtx(name);
    // the queue outranks every other tier. A queued edit is the newest truth
    // for this page whether or not the ship is reachable right now
    const q = await offGet(name);
    if (q) {
      const d = { body: q.body, kind: q.kind, rev: q.baseRev || 0, share: 'private' };
      applyPage(name, d, true);
      snapPage(name, d);
      return true;
    }
    // a link reads live from its host every time (the spec's rule), so the
    // session cache never answers for one
    const hit = !linkOf(name) && pageCache.get(name);
    if (hit) { applyPage(name, hit); snapPage(name, hit); return true; }
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
    let fromUrl = null;
    if (!painted) {
      stWork('opening ' + name + '\u2026');
      // commit the address NOW, before the fetch. A reload mid-open (the
      // service-worker takeover) must resume THIS page. Painted opens already
      // set the address synchronously via applyPage; this fetch lands seconds
      // later on a slow pier, and until it did the address still named the
      // page open before the click, so a reload resumed the wrong document.
      // Remember the old address so a FAILED open puts it back: without that,
      // a reload after a 404 would strand on the bad name instead of resuming
      // the document the editor is still showing.
      fromUrl = location.pathname + location.search;
      history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
    }
    //  undo the speculative address on a failed open, but only if no later
    //  open has run meanwhile (that one owns the address now, so leave it).
    const unwind = () => { if (fromUrl && my === openSeq) history.replaceState(null, '', fromUrl); };
    const shown = src.value;
    let d = null;
    try {
      const r = await fetch(api + '/page-source?name=' + encodeURIComponent(name) + '&render=1');
      if (!r.ok) {
        // a link whose host did not answer: its badge, from now
        if (r.status === 504) linkSeen(name, false);
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
    // a later openPage supersedes this one. Anything else still applies
    if (my !== openSeq) return;
    if (d.link) linkSeen(name, true);
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
    // The flag is not the body, though: the comments switch takes it from
    // this answer whatever was typed meanwhile, or it stays unknown.
    if (painted && src.value !== shown) {
      if (current === name && typeof d.comments === 'boolean') cmtShow(name, d.comments);
      return true;
    }
    // Cache and snapshot BELOW the guards, not above. A stale or superseded
    // response that reached the cache here poisoned it with the pre-edit body:
    // the guard protected the editor but not the cache, so switching away and
    // back repainted the old text — the same data loss through a different
    // door. Only a response that is actually applied may be remembered.
    if (!d.link) pageCache.set(name, d);
    snapPage(name, d);
    applyPage(name, d);
    return true;
  }
  function applyPage(name, d, quiet) {
    curFolder = null;
    setCtlLabels();
    setOpen(name, { readOnly: true, kind: d.kind,
      url: '/apps/lattice/app?name=' + encodeURIComponent(name) });
    curKind = d.kind;
    curRev = d.rev || 0;
    refreshTexButton();
    src.value = d.body;
    // a link with a read grant: the owner's page, shown, not editable
    src.readOnly = !!d.readonly;
    dirty = false;
    // A fresh editor state begins here. everTyped answers "did the user type
    // since this view was established?" for boot's reconcile guard; carrying
    // it across a navigation would mark every later untouched page as touched.
    everTyped = false;
    render(); sync();
    markCurrent();
    st(d.kind + ' · rev ' + d.rev);
    exitRev();
    resetPanels();
    showShare(d.share || 'private');
    cmtShow(name, d.comments);
    cerr.textContent = '\u00a0'; cerr.className = 'ok';
    //  a tex page's server render is its SOURCE as escaped text, because the
    //  ship has no LaTeX and is not getting one. The local conversion is the
    //  only true render, and it arrives first, so letting the ship's answer
    //  land here would overwrite a rendered document with its own source.
    //  ...and through the same fit wrapper the local paint uses: the frame
    //  is sized to its content by a reporter inside the document, and the
    //  ship's render has none. Written verbatim it replaced the fitted local
    //  paint a moment later, and the frame scrolled itself again with the
    //  engine's native (light) bar. Every screenshot taken before this answer
    //  landed looked fixed; the one the user looks at is after it.
    if (typeof d.html === 'string' && d.kind !== 'tex') {
      prev.removeAttribute('src'); prev.srcdoc = withPreviewScrollbars(d.html, true);
    }
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
    drawersClose();
  }

  // blankPage: the editor reset a new page starts from. Nothing named is
  // open, the field (where shown) is editable, and `into` is the folder an
  // upload or a save lands in. A page is never written in memory mode: the
  // autosave there goes to /know-save, so a memory in front leaves it first.
  function blankPage(into) {
    if (mode === 'know') setMode('pages');
    openSeq++;           // an open still in flight must not land over this
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

  // ── new page: one name and kind dialog for web, desktop and phone ────────
  //  Everything user-initiated routes through newFile: the toolbar
  //  (newFile('')), the desktop File menu (which clicks it), the green + on
  //  every tree folder (newFile(path)), the strip's + and the phone bar's
  //  label. The name field left the screen with the old bar, so the dialog
  //  is the one way a page gets its name, and its kind.
  //
  //  focusName false is boot and the tab model landing on an empty page.
  //  That must not be interrupted by a dialog, and they are the callers that
  //  say so: a plain reset, nothing asked.
  function newFile(into, focusName = true) {
    if (!focusName) return blankPage(into);
    (async () => {
      //  a folder's + pre-fills that folder; the toolbar keeps offering the
      //  open page's path (never a memory's key: that names no page). Read
      //  it BEFORE the reset below, which clears the field it comes from.
      //  A tool tab in front hides the editor, so its name field is no seed.
      const seed = into ? into.replace(/\/+$/, '') + '/'
        : mode === 'know' || !docFront() ? '' : (pname.value || '');
      const picked = await askNameKind('page name (e.g. notes/todo)', seed,
        'create', pkind.value);
      if (!picked) return;
      //  reset the editor only once the create is confirmed, so a cancel
      //  leaves the open page exactly as it was. Under a tool tab the page
      //  gets a document tab of its own first (docTab, 21-tabs.js).
      if (!(await docTab())) return;
      blankPage(into);
      let name = picked.name;
      let kind = picked.kind;
      //  a typed extension still wins, because typing notes/todo.md and being
      //  given a page called "todo.md" would be absurd. The table is EXT_KIND
      //  in 30-tree.js, the same one the uploader files by.
      const dot = name.lastIndexOf('.');
      const typed = dot > 0 ? extKind(name.slice(dot + 1)) : null;
      if (typed) { kind = typed; name = name.slice(0, dot); }
      //  the field is seeded with the REAL path; the typed leaf, when it was
      //  not a valid path, rides to save() as the display name
      const rn = realName(name);
      if (!rn) return;
      name = rn.name;
      newRn = rn;
      pkind.value = kind;
      //  blankPage above left nothing open; this names the buffer, and
      //  setOpen's event repaints the labels
      setOpen(null, { shown: name });
      //  Show it in the tree NOW, pulsing, before the ship has agreed. The
      //  write is a pier round trip and the tree sitting unchanged through it
      //  reads as nothing having happened. The pulse is the honest part: it
      //  says recorded, not yet confirmed. Cleared on success, and the row is
      //  dropped on failure so a page that does not exist is never left there.
      const already = nodes.some((n) => n.page && n.path === name);
      if (!already) { addTreeNode(name, kind, true); applyDnames(rn); snapTree(); renderTree(); }
      //  the button says create, so write the page here. Naming the buffer
      //  and leaving it unwritten read as a create that did nothing. save()
      //  owns the whole create: 409, the offline queue, the tree patch and
      //  the url, so this must not reimplement any of it.
      //  queued behind another save, the create has not happened yet: the
      //  row keeps pulsing, and save() settles it when the create runs
      const queued = (await save()) === 'queued';
      if (!already && !queued) {
        //  save() sets `current` on any outcome it considers a success,
        //  including a queued offline write, which IS a success here.
        if (current === name) setTreePending(name, false);
        else { dropTreeNodes(name); snapTree(); renderTree(); }
      }
      src.focus();
    })();
  }

  async function newFolder() {
    // a server-side rejection (colliding with an existing page, say) used to
    // leave nothing to retype into: the dialog already closed the moment the
    // typed name passed client-side validName(). Loop back into askName
    // instead, seeded with the name that just failed, so the fix is an edit
    // rather than a full restart.
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

  //  The three steps save() and autosave() both owe. They are two policies
  //  over one protocol: what genuinely differs (a name to validate, 409 and
  //  the create branch on one side, the debounce and the know branch on the
  //  other) stays in each arm, and the bookkeeping that must never drift
  //  between them lives here.

  //  a save arriving mid-flight only set savePending: the save itself, to
  //  run again (an explicit save with the kindOverride it wanted, or a
  //  memory save), or bare `true` for an autosave. A re-run that forgot the
  //  kind and fell back to autosave's curKind/pkind guess is how a
  //  restore's revision kind used to vanish. And `true` for an explicit
  //  save made it an autosave, which does nothing for a page or memory not
  //  yet named: a Save clicked while another save was in flight on a slow
  //  pier was simply lost. Take the trailing save now, only if the text
  //  really is still unsaved.
  const flushPending = () => {
    if (!savePending) return;
    const pending = savePending;
    savePending = false;
    if (!dirty && !pending.create) return;
    if (typeof pending === 'function') pending(); else autosave();
  };
  //  queue `fn` behind the save in flight, replacing what waits there,
  //  except a create: that is a page the user asked for and nothing else
  //  would write it, so it is kept and runs first. `create` runs even on a
  //  clean buffer (flushPending).
  const queueSave = (fn, create) => {
    const prev = savePending;
    const keep = typeof prev === 'function' && prev.create;
    savePending = Object.assign(keep
      ? async () => { await prev(); if (create || dirty) return fn(); } : fn,
    { create: !!create || keep });
  };
  //  we know exactly what we just wrote. Patch the local copies so reopening
  //  this page paints the saved text, not the dump's pre-save body. The
  //  cached render is stale by definition. Drop it and let it re-render.
  //  Only a save that can change the kind passes one.
  const patchLocal = (name, kind, sent) => {
    pageCache.delete(name);
    const nd = nodes.find((n) => n.page && n.path === name);
    // not a link's: its text is the host's, read live, and the rev beside
    // a body here would be a base the next save claims falsely
    if (nd && !nd.link) { nd.body = sent; if (kind) nd.kind = kind; persistTree(); }
  };
  // an accidental tab close is the same data-loss shape as the grub-discard
  // guard up in openPage: a dirty edit, grub or page, exists only here
  // until it is saved. That guard catches deliberate in-app navigation. This
  // one catches the close and reload that never go through openPage at all.
  // A parked tab's buffer counts too (__latUnsaved, 20-state.js).
  window.addEventListener('beforeunload', (e) => {
    if (!window.__latUnsaved()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  //  A save through a link (30-tree.js) claims the owner's rev this editor
  //  read, as ?base=. Unlike a page of our own, a link has nowhere to keep
  //  a replaced body, so a stale claim is refused (409) and nothing is
  //  written. linkBase is that claim for a save of `name`, '' for a page.
  const linkBase = (name) => (linkOf(name) ? '&base=' + (curRev || 0) : '');
  //  a save through a link that did not land: the host's page moved on past
  //  what this editor read, or the host did not answer (a 502 or 504 the
  //  ship itself sent, never queued: the queue is for this ship being
  //  away). The text stays here, unsaved. -> true when it was one of those.
  async function linkSaveFail(name, r) {
    const lk = linkOf(name);
    if (!lk || !r) return false;
    if (r.status === 409) {
      st('not saved: ' + lk.host + ' changed this page since you opened it. ' +
        'Copy your text, then reopen it', false);
    } else if (r.status === 502 || r.status === 504) {
      if (r.status === 504) linkSeen(name, false);
      st('not saved' + await errText(r), false);
    } else return false;
    if (current === name) { cerr.textContent = 'NOT saved'; cerr.className = 'err'; }
    return true;
  }

  // the realName() split the create dialog (newFile) made before seeding
  // #pname with the real path; save() consumes it on create
  let newRn = null;
  // a create that lands with nothing else opened meanwhile: nothing is
  // named yet and the name field still names this page. Not the body:
  // text typed during the round trip changes it, which left the page
  // unnamed and its typing never autosaved (autosave needs `current`), and
  // two empty pages have the same one, so a create landing under a second
  // New took the second page's blank buffer for its own.
  const createdHere = (creating, name) => creating && current === null && pname.value === name;
  //  the page `name` (as typed) is on the ship, or queued for it, and not
  //  a create's pulsing row still waiting for its answer
  const madePage = (name) => {
    const rn = realName(name);
    return !!rn && nodes.some((n) => n.page && n.path === rn.name && !n.pending);
  };
  //  `fixed`: a queued create whose page the editor no longer shows (see
  //  below). It names what to write, and the editor is left alone.
  async function save(kindOverride, fixed) {
    if (!fixed && curFolder) { st('folder selected — open a page to edit', false); return; }
    if (!fixed && viewingRev !== null) { st('viewing rev ' + viewingRev + ' — use restore', false); return; }
    let name = fixed ? fixed.name : pname.value.trim().replace(/^\/+|\/+$/g, '');
    if (!name) { st('name required', false); return; }
    const creating = !!fixed || current === null;
    // carry kindOverride into the re-arm: a bare `true` here forgot which
    // kind THIS call wanted, and the trailing run picked whatever the
    // picker happened to show by the time it fired
    //  a create queued here runs even when the buffer is clean by then (an
    //  empty new page is clean from the start): flushPending sees `create`
    //  It is queued for THIS document. By the time it runs the editor may
    //  show another, and save() writes whatever name and buffer it finds
    //  then, so it runs from the editor only if the editor still shows
    //  this one. A create carries what it creates (name, body, kind, the
    //  dialog's split), so a second New during the round trip still gets
    //  the first page written. 'queued' tells newFile it has not run yet.
    //  A create also waits behind the create before it for the same page (a
    //  second Ctrl+S during the round trip). Once that one has made the page
    //  it skips itself: a second create is a 409 about our own page. A page
    //  that was already there when it was queued still gets its honest 409.
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
    // capture the exact body being sent: keystrokes landing during the round-trip
    // must NOT be marked clean, or the next refresh swaps the stale server copy
    // in and the typed text is lost (same guard autosave has always had).
    const sent = fixed ? fixed.body : src.value;
    const kind = fixed ? fixed.kind : kindOverride || curKind || pkind.value;
    // NO base on live saves, deliberately: base is the OFFLINE queue's tool,
    // where the divergence window is real. Online, any dirty-blocked refresh
    // or panel-driven save can leave curRev one step behind, and every stale
    // base manufactures a false conflict page out of nothing (ui-matrix
    // caught exactly that). Online editing stays last-writer-wins.
    const rn = realName(name);
    if (!rn) {
      saving = false;
      st('bad name — use at least one letter or digit', false);
      return;
    }
    // a typed name that is not a valid path saves under its slug and keeps
    // the typed text as display names (the tree shows those, the name
    // field shows the real path). newRn is the create dialog's copy of
    // the same split, made before it seeded the field with the slug.
    const rnc = !creating ? null : rn.dnames ? rn : fixed ? fixed.rn : newRn;
    if (!fixed) newRn = null;
    const dname = rnc ? rnc.dname : '';
    //  the field shows the slug from here on; nothing else about what is
    //  open changes, so `current` and the lock are passed through as they are
    if (rn.name !== name) {
      name = rn.name;
      if (!fixed) setOpen(current, { shown: name, readOnly: pname.readOnly });
    }
    //  a write that did not land: a create's pulsing row goes (newFile put
    //  it there, and a create that ran from the queue settles its own row),
    //  and the save queued behind this one still runs. It checks what it
    //  was queued for, so it never writes another document.
    const failed = () => {
      if (creating && nodes.some((n) => n.page && n.path === name && n.pending)) {
        dropTreeNodes(name); snapTree(); renderTree();
      }
      flushPending();
    };
    const url = api + '/page-save?name=' + encodeURIComponent(name) +
      '&type=' + kind + (creating ? '&new=1' : '') + dnameQ(rnc) + (creating ? '' : linkBase(name));
    let w = { gone: true };
    try { w = await shipWrite(url, { method: 'POST', body: sent || '\n' }, { save: true }); }
    finally { saving = false; }
    const r = w.r;
    if (await linkSaveFail(name, r)) return failed();
    if (w.gone) {
      // the ship is unreachable. Queue the edit and complete the save's
      // LOCAL bookkeeping exactly as a successful save would, so the editor
      // does not care which kind it got
      // A failed queue write means this edit exists ONLY in the textarea.
      // Clearing dirty there would tell the editor the work is safe and let
      // the next navigation drop it, so the bookkeeping stays untouched and
      // the page keeps behaving as unsaved. enqueueSave has already said so.
      if (!(await enqueueSave(name, kind, sent, creating, rnc))) {
        cerr.textContent = 'NOT saved'; cerr.className = 'err';
        return failed();
      }
      if (creating) { addTreeNode(name, kind, false); applyDnames(rnc); snapTree(); renderTree(); }
      // same stillHere guard as the online path: only touch live editor state
      // if the editor has not moved to another document during the round-trip.
      const stillHere = fixed ? tabAdopt(fixed, name)
        : current === name || createdHere(creating, name);
      if (stillHere) {
        current = name;
        tabFollow();         // a new page's tab is named now (21-tabs.js)
        curKind = kind;
        pname.readOnly = true;
        if (src.value === sent) dirty = false;
        else if (!savePending) savePending = true;
        history.replaceState(null, '', '/apps/lattice/app?name=' + encodeURIComponent(name));
        cerr.textContent = 'saved offline'; cerr.className = 'ok';
      }
      flushPending();
      return;
    }
    if (r && r.status === 409) { st('that page already exists', false); return failed(); }
    if (!r.ok) { st('save failed' + await errText(r), false); return failed(); }
    // the response carries the new revision and whether this save landed
    // on top of a revision made elsewhere; parse it regardless of focus.
    let vr = null;
    try { vr = await r.json(); } catch {}
    // saved-document bookkeeping, applied whether or not the editor still
    // shows it, so a New clicked mid-save keeps both documents. Only a
    // CREATE changes the tree, and it confirms a row newFile left pulsing.
    if (creating) { addTreeNode(name, kind, false); applyDnames(rnc); snapTree(); renderTree(); }
    patchLocal(name, kind, sent);
    // live-editor state ONLY if the editor still shows the saved document.
    // A New or open during the round-trip moved it; rewriting current, the
    // name field, dirty or the URL here would brand the new page as this save.
    //  A create run from the queue (`fixed`) is still here only when its
    //  own tab came back to the front, unnamed, during the round trip;
    //  in the background that tab is named for it instead (tabAdopt).
    const stillHere = fixed ? tabAdopt(fixed, name)
      : current === name || createdHere(creating, name);
    if (stillHere) {
      current = name;
      tabFollow();           // a new page's tab is named now (21-tabs.js)
      curKind = kind;
      pname.readOnly = true;
      if (src.value === sent) dirty = false;
      else if (!savePending) savePending = true;   // flushPending below saves it
      if (vr && vr.rev) curRev = vr.rev;
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
  // turned back on in Settings (another document) while text waits unsaved:
  // it goes out on the usual debounce, as if just typed
  window.addEventListener('storage', (e) => {
    if (e.key !== 'latAutosave' || !autosaveOn() || !dirty) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(autosave, 2000);
  });
  async function autosave() {
    // GRUB MODE IS EXPLICIT-SAVE ONLY. Autosaving a lattice page is fine. It is
    // your own note and the editor has always worked that way. Autosaving
    // another app's source is not. A half-typed edit to calendar.html would go
    // live 2s after you paused, and the 5-minute history window may not have
    // kept a revision fine-grained enough to step back to. Save/Cmd+S only.
    // The 2s debounce still fires. It just reports instead of writing, so the
    // moment you stop typing you can see the edit is not yet on the ship.
    if (grubPath) { if (dirty) st('unsaved, Ctrl+S to save'); return; }
    if (!current || curFolder || !dirty || viewingRev !== null) return;
    // Settings > Editor > Autosave pages, off: manual only. This debounce
    // stops, and so do the flushes a tab switch or a navigation makes
    // (flushNoAsk and guardDirty, 20-state.js, which ask instead). Only
    // Ctrl+S, the save button and :w write.
    if (!autosaveOn()) { st('unsaved, Ctrl+S to save'); return; }
    // never overlap saves. The pier serializes, so a second in-flight save is
    // 3.7s of stale-body work queued behind the first, delaying every preview
    // behind it. Coalesce to one trailing save instead.
    //  never over an explicit save already waiting: that one names its kind
    if (saving) { if (!savePending) savePending = true; return; }
    saving = true;
    // the document this autosave owns. If the user navigates mid-flight,
    // `current` moves; everything below acts on `target`, not the new current.
    const target = current;
    const sent = src.value;
    const url = mode === 'know'
      ? api + '/know-save?key=' + encodeURIComponent(target)
      : api + '/page-save?name=' + encodeURIComponent(target) +
        '&type=' + (curKind || pkind.value) + linkBase(target);
    let w = { gone: true };
    try { w = await shipWrite(url, { method: 'POST', body: sent || '\n' }, { save: true }); }
    finally { saving = false; }
    const r = w.r;
    if (mode !== 'know' && await linkSaveFail(target, r)) { flushPending(); return; }
    if (w.gone) {
      //  same rule on the autosave path: if it did not queue, it is not saved,
      //  so the editor stays dirty and keeps the text under the cursor
      if (mode === 'know') {
        if (!(await enqueueKnow(target, sent))) { flushPending(); return; }
        if (current === target && src.value === sent) dirty = false;
        flushPending();
        return;
      }
      if (!(await enqueueSave(target, curKind || pkind.value, sent))) { flushPending(); return; }
      if (current === target && src.value === sent) dirty = false;
      flushPending();
      return;
    }
    if (!r.ok) { st('autosave failed' + await errText(r), false); flushPending(); return; }
    let vr = null;
    if (mode !== 'know') { try { vr = await r.json(); } catch {} }
    //  patch the saved doc's local cache regardless of focus. No kind: an
    //  autosave writes the page's existing kind, it never sets one.
    if (mode !== 'know') patchLocal(target, null, sent);
    // live-editor state only if the editor is still on the doc we autosaved
    if (current === target) {
      if (src.value === sent) dirty = false;   // typed during the request? stay dirty
      if (mode !== 'know' && vr && vr.rev) curRev = vr.rev;
      // the conflict verdict must be the LAST word, not clobbered by the
      // ordinary confirmation a line later
      if (vr && vr.conflicted)
        st('autosaved — replaced an edit from elsewhere; it is kept at ' + vr.kept, false);
      else st('autosaved');
      if (mode !== 'know' && !CONTENT()) setTimeout(checkErrors, 800);
    }
    flushPending();
    if (offCount) replayQueue(true);     // this autosave proves the ship is back too
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
  // the picker's value before a grub took it over, restored on exitGrub. Set
  // only on the FIRST entry (see the guard in openGrub), so browsing straight
  // from one grub to another still remembers the page kind that came before.
  let grubPrevKind = null;
  // Every editor reset that leaves grub mode MUST call this: Save gives
  // grubPath top precedence, so a reset that forgets it leaves Save pointed
  // at the app file while the textarea fills with unrelated content — an
  // overwrite wearing a 'saved' status. openPage clears inline; newFile,
  // selectFolder and setMode route through here.
  const exitGrub = () => {
    grubPath = null; grubShip = null;
    if (grubPrevKind !== null) { pkind.value = grubPrevKind; grubPrevKind = null; }
  };
  // Answers false when the open failed, like openPage (35-pages.js).
  async function openGrub(p, ship) {
    const my = ++openSeq;
    enterGrub(p, ship);
    st('loading ' + p + '…');
    // remote files ride /browse-file (bounded cross-ship peek). Its JSON says
    // body/mark where grub-source says text/blot. Normalize here, not there,
    // since both routes have other consumers.
    const url = grubShip
      ? api + '/browse-file?ship=' + encodeURIComponent(grubShip) + '&path=' + encodeURIComponent(p)
      : api + '/grub-source?path=' + encodeURIComponent(p);
    let r = null;
    try { r = await fetch(url); } catch {}
    if (my !== openSeq) return;
    if (!r || !r.ok) {
      // the editor stays as enterGrub left it, empty and locked
      st('could not open ' + p + (r ? ' (' + r.status + ')' : ''), false);
      return false;
    }
    const d = await r.json();
    if (my !== openSeq) return;
    src.value = d.text || d.body || '';
    // a binary/opaque grub has no text form. Show it, never offer to save it
    src.readOnly = !d.editable;
    dirty = false;
    render();
    const blot = d.blot || d.mark || '';
    // the picker drives syntax highlighting (LMAP) and list-continuation
    // rules (proseFlavor), so it needs to follow this file's real language.
    // Left alone it keeps whatever page kind was open before, and editing
    // calendar.html ends up highlighted and indented as that stale kind.
    // a shared lattice page arrives as its prose, with the builder it is
    // wrapped in, which is its page kind
    const mk = d.builder || extKind(String(blot).split('/').pop()) || 'hoon';
    if ([...pkind.options].some((o) => o.value === mk)) pkind.value = mk;
    //  setOpen ran before this file's kind was known, so tell the desktop
    //  label (its tip names the kind) the same way setOpen does
    pname.dispatchEvent(new Event('input'));
    curKind = mk;
    st(!d.editable ? 'read-only — ' + blot + ' has no text form'
       : grubShip ? 'on ' + grubShip + ': saves need its permission'
       : 'grub ' + blot + ', no autosave here: Ctrl+S to save');
    return true;
  }
  // grub mode on, for `p` (on `ship`, or here), with its label and address,
  // and an empty locked editor until its text is in: openGrub's first half,
  // and all a tab's own unsaved grub buffer needs to come back (21-tabs.js).
  // Empty, because grubPath is what Save and the tab model go by. Left
  // showing the document before it while the grub loaded, the editor
  // offered that text to Save as this grub's, and a tab switch in that
  // window filed it as the grub's unsaved buffer.
  function enterGrub(p, ship) {
    src.value = '';
    src.readOnly = true;
    dirty = false;
    render();
    grubPath = p;
    grubShip = ship || null;
    if (grubPrevKind === null) grubPrevKind = pkind.value;
    curFolder = null;
    // a shared lattice page reads as "~ship: its/name", not its whole ball
    // path; the name field is only a label here (Save goes by grubPath)
    const pg = /\/page\/(.+)\/code$/.exec(p);
    setOpen(null, { shown: grubShip ? grubShip + ': ' + (pg ? pg[1] : p) : p, readOnly: true,
      url: '/apps/lattice/app?grub=' + encodeURIComponent(p) +
        (grubShip ? '&ship=' + encodeURIComponent(grubShip) : '') });
  }
  async function saveGrub() {
    if (!grubPath || src.readOnly) return;
    //  queued for this grub: a page or memory in front by then is not it
    if (saving) {
      const p = grubPath, s = grubShip;
      queueSave(() => { if (grubPath === p && grubShip === s) return saveGrub(); });
      return;
    }
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
      // 'rejected' is the mark's word, and a 502 is the ship's absence, not
      // the mark's opinion of the content. Grub edits have nowhere to queue
      // the way page saves do, so the text just stays here until Save runs
      // again with the ship back.
      // the save queued behind this one still runs (flushPending, 35-pages.js)
      if (shipGone(r)) { st('ship unreachable — grub edits do not queue', false); flushPending(); return; }
      // the mark can reject the source. Show ITS error, since the stored grub
      // still holds the previous content and the user needs to know why
      st('save rejected' + await errText(r), false);
      flushPending();
      return;
    }
    if (src.value === sent) dirty = false;
    st('saved');
    // bust the page DIRECTORY, not the grub: the cached views are the /x/
    // dir listing and page view, and none of their URLs name '/code'
    bustPages(String(grubPath).replace(/\/[^/]*$/, ''));
    flushPending();
  }

// ── src/45-templates.js ───────────────────────────────────────────────────
  // Save, the button and Cmd+S alike. Nothing while the tab in front is not
  // a document (a tool tab): what the editor holds then is a parked tab's
  // buffer, and writing it from a screen that does not show it would leave
  // that tab's snap claiming unsaved work the ship already has.
  // grubPath first: it is the only mode with no `current`, and page save()
  // would write to the wrong place (or nowhere) while a grub is open.
  // Cmd+S matters more there than elsewhere, since grub mode has no autosave.
  const saveFront = () => {
    if (!docFront()) return;
    if (grubPath) saveGrub();
    else if (mode === 'know') saveKnow();
    else save();
  };
  $('save').onclick = saveFront;
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
        // a multi-page template lands as a folder. Open its index if it made
        // one, else the page itself, else just select the new folder.
        const has = (p) => nodes.some((n) => n.page && n.path === p);
        if (has(name)) await openIn('page', name);
        else if (has(name + '/index')) await openIn('page', name + '/index');
        else if (nodes.some((n) => !n.page && n.path === name)) await pickFolder(name);
        st('created ' + name + ' from ' + tmpl);
        return;
      }
      // the server refused this name \u2014 loop back into askName seeded with
      // it (keeping the template pick), so the retry is an edit not a redo
      if (r && r.status === 409) st('a page by that name exists', false);
      else st('template failed' + await errText(r), false);
      seed = name;
    }
  }
  $('newtmpl').onclick = newFromTemplate;
  // newFile paints over the editor, so whatever is unsaved there goes
  // through guardDirty first, like any other way off a document
  $('newfile').onclick = async () => { if (await guardDirty()) newFile(''); };
  $('newfolder').onclick = newFolder;
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      saveFront();
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

  // ── the same two moves, reachable by thumb ────────────────────────────────
  // A soft keyboard has no Tab key at all — the keydown branch above simply
  // never fires on a phone, the same hole Enter had before beforeinput. There
  // is no beforeinput for Tab, so mobile gets buttons: a small floating pair
  // that exists only while the caret sits somewhere listTab
  // would actually act. The predicate IS listTab: the cluster shows exactly
  // when a tap would do something, fences and gemtext included, because it
  // asks the same function the tap will call.
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
    // pointerdown + preventDefault: the tap must NOT move focus off the
    // textarea, or the keyboard drops and the caret (the thing the edit is
    // FOR) is gone before the handler runs.
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); ltab(dir); });
    lbtns.appendChild(b);
  }
  // inside .ws, not body: at phone width it is a grid item laid over the
  // center's bottom corner (the 820px block). By id,
  // not the `ws` binding — that const lives in 85-layout.js, which
  // evaluates AFTER this file (TDZ: reaching it here killed the bundle).
  $('ws').appendChild(lbtns);
  // shown while either direction would act. selectionchange covers taps and
  // caret movement; input covers typing a marker into existence. Debounced:
  // listTab scans fences over the whole document, which is nothing for the
  // documents phones edit but not worth running per keystroke.
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
    // through applyEdit, never src.value assignment: the latter wipes the
    // textarea's entire undo stack (45-templates documents this exact sin)
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
    //  a bare [[a/b/c]] shows just the last segment ("c"), the filename people
    //  expect, not the whole path. An explicit [[a/b/c|label]] still wins. The
    //  href/target is unchanged, so navigation and backlinks are unaffected.
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_, tgt, label) => '<a href="'
        + mdHref('/apps/lattice/app?name=' + encodeURIComponent(mdUnesc(tgt).trim())) + '">'
        + (label || tgt.trim().replace(/\/+$/, '').split('/').pop() || tgt) + '</a>');
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
  // fit state for the document currently in the frame (see the message
  // handler below). fitCur is the seq previewFit stamped into that document;
  // null forces the next report to start a new document.
  let fitCur = null, fitH = 0, fitOff = false;
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
        //
        // allow-top-navigation-by-user-activation is a narrower third token,
        // added for a different reason: a wikilink is a plain <a> pointing at
        // the app's own route, and clicking one used to navigate the frame
        // itself, straight into the opaque origin's missing cookies, a live
        // 403 in place of the page. This token opens exactly one door out of
        // the sandbox, and only on an actual click. Nothing running inside
        // the frame can drive the top page anywhere on its own; the click has
        // to be real. The base target below is what points those clicks
        // upward instead of at the frame.
        // The frame sits in a scrolling DIV and is sized to its own content
        // (see previewFit), so the frame's document never scrolls and never
        // shows the engine's native scrollbar. That bar is the one WebKitGTK
        // paints light no matter what: measured on 2.50, a sub-frame's bar
        // ignores color-scheme, ::-webkit-scrollbar, scrollbar-color, the
        // GTK dark variant and gtk-application-prefer-dark-theme alike.
        // The div scrolls with the app's own styled bars instead.
        '<div class="prevwrap"><iframe class="prev" id="prev" title="live preview" '
          + 'sandbox="allow-scripts allow-top-navigation-by-user-activation"></iframe></div>';
      prev = $('prev');
      // the frame reports its content height once its document has loaded;
      // the wrap scrolls. The FIRST report per document wins, measured with
      // the frame at pane height (previewFit clears min-height before every
      // write). If the content then grows in response to the frame growing,
      // the document is viewport-relative (a 100vh slide deck) and fitting
      // can never settle: drop the fit and let it scroll inside the frame,
      // whose own bars are hidden. A late image load trips the same rule and
      // degrades the same way, which beats a frame that grows without bound.
      window.addEventListener('message', (e) => {
        if (e.source !== prev.contentWindow) return;
        const m = e.data;
        if (!m || typeof m.latPrev !== 'number' || !(m.latPrev > 0)) return;
        if (m.seq !== fitCur) { fitCur = m.seq; fitH = 0; fitOff = false; }
        if (fitOff) return;
        if (!fitH) { fitH = m.latPrev; prev.style.minHeight = fitH + 'px'; return; }
        if (m.latPrev > fitH + 2) { fitOff = true; prev.style.minHeight = ''; }
      });
      // blank it NOW, not when the first page opens. An iframe with no srcdoc
      // is an opaque white canvas, and the first thing that used to call
      // prevBlank was boot's trailing newFile(). So the pane sat white for
      // the whole load and then popped to the theme background.
      prevBlank();
    }
  });
  //  tex is here for the same reason html is: the ship cannot render it, so
  //  the local paint IS the preview and there is no server answer to wait
  //  for. It differs in one way, that its renderer is a subprocess and
  //  therefore async, which is what texPreviewHtml in 71-latex.js handles.
  //  a memory has no kind picker: it is markdown (proseFlavor in 45-templates
  //  says the same), so knowledge mode previews like an md page
  const kindNow = () => (mode === 'know' ? 'md' : pkind.value);
  const CONTENT = () => ['md', 'gmi', 'html', 'text', 'tex'].includes(kindNow());

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
  const localHtml = (kind, body) => {
    if (kind === 'md') return mdToHtml(body);
    if (kind === 'gmi') return gmiToHtml(body);
    if (kind === 'text') return '<pre>' + mdEsc(body) + '</pre>';
    //  pandoc is a subprocess, so it cannot answer inside this synchronous
    //  call. It returns whatever the last conversion produced and schedules
    //  another, which repaints when it lands. Same contract as a cache.
    if (kind === 'tex') return texPreviewHtml(body);
    return body;   // html: the document is already its own rendering
  };
  // color-scheme first: WebKit picks its NATIVE scrollbar colours from the
  // document's colour scheme, and older WebKitGTK builds honour nothing else
  // below. A document that declares none is light, whatever the app is, so
  // its bars stayed white in a dark editor even with these rules present.
  // The rules that follow style them where the engine supports that.
  // WebKitGTK paints a sub-frame's OWN scrollbar light whatever the theme or
  // the document's colour scheme say, so the frame's bar is hidden outright
  // and the pane scrolls instead. Two things measured in a bare WebKit view:
  // html::-webkit-scrollbar{display:none} does hide it, and ANY standard
  // scrollbar-width / scrollbar-color on the document switches every
  // ::-webkit-scrollbar rule off, so neither may appear in a preview
  // document. Scoped to html so an inner scroll box (a wide <pre>) keeps its
  // own styled bar.
  // html:root, so a forced scheme outranks the document's own :root rule
  const previewScrollbars = () => '<style>html:root{color-scheme:'
    + (document.documentElement.style.colorScheme || 'light dark') + '}html::-webkit-scrollbar{display:none}</style>';
  // the height reporter the wrap listens for: posts once the document has
  // loaded, and again when its body resizes. Each call stamps a fresh seq so
  // the parent can tell a new document from a resize of the old one. Mirrored
  // (without the seq) in app.hoon (+preview-scrollbar-css) for the /f/
  // computed-kind preview. Clearing min-height here is deliberate: every
  // srcdoc write goes through this, and the first measurement must be taken
  // with the frame at pane height, not at the previous document's.
  let fitSeq = 0;
  const previewFit = () => {
    if (prev) prev.style.minHeight = '';
    return previewScrollbars()
      + '<script>(function(){var S=' + (++fitSeq) + ';function s(){var d=document.documentElement,b=document.body;parent.postMessage({latPrev:Math.max(d.scrollHeight,b?b.scrollHeight:0),seq:S},"*")}addEventListener("load",function(){s();if(document.body)new ResizeObserver(s).observe(document.body)})})()</script>';
  };
  // `ours`: the document is lattice's own render (the ship's reader css), so
  // it takes the theme's colours too. A user's html page keeps its own.
  const withPreviewScrollbars = (html, ours) => {
    const head = /<head\b[^>]*>/i.exec(html);
    const fit = previewFit() + (ours && themeRoot() ? '<style>' + themeRoot() + '</style>' : '');
    if (head) return html.slice(0, head.index + head[0].length) + fit + html.slice(head.index + head[0].length);
    const root = /<html\b[^>]*>/i.exec(html);
    if (root) return html.slice(0, root.index + root[0].length) + fit + html.slice(root.index + root[0].length);
    return fit + html;
  };
  // nobody sees the preview in Edit (23-tabhead.js), on a phone or not;
  // Read refreshes it on the way back
  const previewHidden = () => ws.classList.contains('ve');
  const paintLocal = () => {
    if (!CONTENT() || document.hidden) return;
    if (previewHidden()) return;
    try {
      // html pages own their whole document, chrome and all. The content kinds
      // get the same bare shell the markdown preview always used.
      // ...but a document that styles no scrollbars gets the engine's NATIVE
      // ones, which on WebKitGTK follow the window theme and drew white in a
      // dark editor. Slip the same flat scrollbar rules the rest of the
      // editor uses into the preview copy only: after <head> when there is
      // one, else after <html>, else in front. The rules touch nothing but
      // scrollbars (an alpha grey that reads on both schemes), so the
      // document's own colour scheme is left exactly as written.
      if (pkind.value === 'html') { prev.srcdoc = withPreviewScrollbars(src.value); return; }
      // color-scheme belongs on :root, not body — on body it does not reach the
      // canvas, so the frame painted opaque WHITE in dark theme. That was true
      // of every local paint since it landed and went unseen because only the
      // BLANK pane was ever checked for theme; wiring this into the open path
      // is what finally put it on screen. Backgrounds match prevBlank exactly,
      // so a document appearing cannot flash a different colour than the empty
      // pane it replaces.
      // <base target="_top"> sends every plain link in this shell to the real
      // top-level page instead of the sandboxed frame it is written into. A
      // wikilink used to navigate the frame itself and land on an
      // authenticated route the opaque origin has no cookies for; escaping
      // to the top page is what the sandbox token above actually permits.
      prev.srcdoc = '<!doctype html><meta charset="utf-8"><base target="_top">'
        + '<style>:root{color-scheme:light dark}'
        + 'body{margin:0;padding:14px;font:15px/1.6 var(--font,system-ui,sans-serif);background:var(--bg,#fafafa);color:var(--text)}'
        + '@media(prefers-color-scheme:dark){body{background:var(--bg,#1a1a1a)}}' + themeRoot()
        // NO scrollbar-width / scrollbar-color here: either one switches the
        // ::-webkit-scrollbar rules off, including the html-level hide that
        // previewFit appends. Inner scroll boxes (a wide <pre>) keep flat bars.
        + 'pre::-webkit-scrollbar{width:10px;height:10px}'
        + 'pre::-webkit-scrollbar-thumb{background:#8886;border-radius:5px;border:2px solid transparent;background-clip:padding-box}'
        + 'img{max-width:100%}pre{overflow-x:auto}'
        + 'table{border-collapse:collapse}td,th{border:1px solid #8886;padding:.3em .5em}'
        + '</style>' + previewFit() + localHtml(kindNow(), src.value);
    } catch {}
  };

  // a theme that lands after the frame was painted (theme.js runs after
  // this bundle, and the ship or another tab can change it later) repaints
  // it: the local render of a content page (an unsaved new one too), or
  // blank with nothing open. A computed page's frame is the ship's, and
  // refetching it costs a request.
  window.addEventListener('lattheme', () => {
    if (CONTENT() && (current || src.value)) paintLocal();
    else if (!current) prevBlank();
  });
  async function refreshPreview() {
    // a hidden pane renders to nobody, but the POST still costs ~2s of pier
    // time and delays the autosave queued behind it (worst on mobile, where
    // the code tab hides the preview entirely).
    if (document.hidden) return;
    if (previewHidden()) return;
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
      fitCur = null; prev.style.minHeight = '';
      // preview=1: the ship adds the editor's scrollbar rules to an html
      // answer, so a computed page's live document scrolls like the rest of
      // the editor instead of with the engine's native, theme-following bars
      prev.src = api + '/f/' + current + '?preview=1&t=' + Date.now();
    }
  }
  // The way back into view for the pane (the phone's preview tab, or a
  // desktop view that shows it again). Chromium never paints a sandboxed
  // frame whose first document loaded while its pane was display:none, or
  // was replaced by a second write before it painted. Later documents, even
  // written back to back, paint fine once one has. A phone hides the pane
  // from boot (the tree tab comes first), so the preview tab stayed blank.
  // So: a fresh frame, written exactly once while the pane is visible.
  function showPreview() {
    const n = prev.cloneNode(false);
    n.removeAttribute('srcdoc'); n.removeAttribute('src'); n.style.minHeight = '';
    prev.replaceWith(n); prev = n; fitCur = null;
    if (CONTENT() || current) refreshPreview(); else prevBlank();
  }
  let localTimer = null;
  src.addEventListener('input', () => {
    if (!CONTENT()) return;
    // Typing sends nothing to the ship. The local render IS the preview for
    // every content kind (md/gmi/html/text), with no second authoritative
    // render behind it to wait for. refreshPreview says why. Computed kinds
    // (hoon, js, css) return above; their preview is the page's live data and
    // arrives from refreshPreview's /f/ branch after a save.
    //
    // local first, on a delay short enough to feel like typing
    clearTimeout(localTimer);
    localTimer = setTimeout(paintLocal, 60);
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
  // Renders the Page tab's skeleton with one tag per panel. The panel
  // components (lat-knowtags 68, lat-share 66) upgrade when
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
  <!-- a link to another ship's page (paintLink, below) -->
  <div id="lnkrow" hidden>
    <h3>linked</h3>
    <div id="lnkfrom"></div>
    <div id="lnkmode" class="muted"></div>
    <div id="lnkbad" class="lbad" hidden></div>
    <div id="lnkat" class="muted" hidden></div>
    <button type="button" id="linkback" data-action="linkback">Move back to shared with me</button>
  </div>
  <div id="cmtrow" hidden>
    <h3>comments</h3>
    <!-- the box alone toggles, as with mark sensitive (66-share.js) -->
    <div class="chk"><input type="checkbox" id="cmton" data-action="cmton" aria-label="Comments on this page">
    <span class="muted">Comments on this page</span></div>
  </div>
  <lat-share></lat-share>
  <!-- move and delete are reached from the tab header's path and the page
       menu (23-tabhead.js), which click these. They stay, out of sight. -->
  <div hidden><button id="mv">move / rename</button><button id="del">delete page</button></div>
</aside>`;
      cerr = $('cerr');
    }
  });

  // ── a link: whose page this is ──────────────────────────────────────────
  // For a link in front (its tab, open or failed to open): where it points,
  // the grant, and the badge once a read failed. Comments and sharing are
  // the owner's, so this page's own controls for them stand down.
  function paintLink() {
    const row = $('lnkrow');
    if (!row) return;
    const t = activeTab;
    const name = t ? (t.kind === 'page' ? t.key : null)
      : (!grubPath && mode !== 'know' && curFolder === null ? current : null);
    const lk = linkOf(name);
    row.hidden = !lk;
    const sh = document.querySelector('lat-share');
    if (sh) sh.hidden = !!lk;
    if (lk) $('cmtrow').hidden = true;      // rpPaint shows it for a page
    if (!lk) return;
    row.dataset.name = name;
    $('lnkfrom').textContent = 'Linked from ' + linkFrom(lk);
    $('lnkmode').textContent = lk.mode === 'read' ? 'read only'
      : lk.mode === 'edit' ? 'can edit' : lk.mode;
    const bad = linkBadge(lk);
    $('lnkbad').hidden = !bad;
    $('lnkbad').textContent = bad ? bad.textContent : '';
    $('lnkat').hidden = !bad || !bad.title;
    $('lnkat').textContent = bad ? bad.title : '';
  }
  $('linkback').onclick = () => linkBack($('lnkrow').dataset.name);

  // ── comments on this page ────────────────────────────────────────────────
  // Comments from other ships are opt-in per page (or per folder: the
  // nearest flag at or above a page wins). page-source reports the answer
  // for the open page as `comments`, and this box shows it. An open painted
  // from the tree dump has no answer yet; the box waits, disabled, for the
  // page-source fetch that follows. cmtOn is what the Comments tab goes by.
  let cmtOn = null;
  let cmtFor = null;
  function cmtShow(name, on) {
    const cb = $('cmton');
    cmtFor = name;
    cmtOn = typeof on === 'boolean' ? on : null;
    cb.checked = cmtOn === true;
    cb.disabled = !name || cmtOn === null;
    rpSoon();            // the Comments tab's post box goes by it too
  }
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
    const hit = pageCache.get(name);
    if (hit) hit.comments = on;
    st(on ? 'comments on for ' + name : 'comments off for ' + name);
    rpSoon();
  };
  clickAction('cmton', 'Comments on this page', 'Right pane › Page');

  // NB: the command box is gone from this panel. It POSTed to /page-cmd, the
  // input channel for a programmable page. The ROUTE stays, since public form
  // submissions (POST /f/<page>) go through the same handler, but nothing in
  // the editor sends to it now.

  // ── delete ───────────────────────────────────────────────────────────────
  $('del').onclick = async () => {
    if (mode === 'know') { deleteKnow(); return; }
    if (viewingRev !== null) { st('viewing rev ' + viewingRev + ' — use restore', false); return; }
    if (curFolder) {
      const path = curFolder;
      const c = pageCount(path);
      // pages carry no trash: the writer prunes every revision and never
      // offers a restore route, unlike the memory delete confirm a click
      // away, which correctly says restorable. Say permanent here instead.
      const what = 'delete folder ' + path +
        (c ? ' and the ' + c + ' page' + (c === 1 ? '' : 's') + ' under it' : '') +
        '? (permanent, not restorable)';
      if (!(await askConfirm(what, 'delete'))) return;
      const r = await mutate(api + '/page-del?name=' + encodeURIComponent(path));
      if (!r.ok) { st('delete failed' + await errText(r), false); return; }
      dropTreeNodes(path);
      snapTree();
      // no focus: a focused newFile becomes the create dialog under the
      // desktop wrapper, and nobody asked to create a page by deleting one
      newFile('', false);
      st(r.offline ? 'deleted ' + path + ' offline' : 'deleted ' + path);
      return;
    }
    if (!current) { st('nothing to delete', false); return; }
    const doomed = current;
    // the server culls the page's whole dir, nested pages included, and
    // dropTreeNodes below assumes exactly that. Count what goes the way the
    // folder branch does, so the confirm is proportional to the loss
    const c = pageCount(doomed);
    // same reason as the folder confirm above: no trash, no restore, so say so
    const what = 'delete ' + doomed +
      (c ? ' and the ' + c + ' page' + (c === 1 ? '' : 's') + ' under it' : '') +
      '? (permanent, not restorable)';
    if (!(await askConfirm(what, 'delete'))) return;
    const r = await mutate(api + '/page-del?name=' + encodeURIComponent(doomed));
    if (!r.ok) { st('delete failed' + await errText(r), false); return; }
    dropTreeNodes(doomed);
    snapTree();
    newFile('', false);
    st(r.offline ? 'deleted ' + doomed + ' offline' : 'deleted ' + doomed);
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
  <button data-m="private" data-action="share-private">private</button>
  <button data-m="shared" data-action="share-shared">shared</button>
  <button data-m="clearweb" data-action="share-clearweb">clearweb</button>
</div>
<div id="sharewhat" class="muted sharewhat"></div>
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
  // ── what each mode does, said where it is picked ─────────────────────────
  // The three read as a set, and each says who can read the page and where
  // (apply-share in app.hoon): private is in no published copy at all;
  // shared puts a copy under /pub, which is publicly granted, so any ship
  // reads it over ames at its urb:// address; clearweb is shared plus the
  // unauthenticated /c/ route. A ship or group granted below reads a
  // private page too (share-file grants the code grub itself), so private
  // says so.
  //
  // The addresses are the real ones for the target. cwUrl is the one the
  // public link below shows and the Published pages list (72-acl.js)
  // copies, so the two can never disagree. urb:// has no folder form, so a
  // folder's copy points at its pages instead of printing one.
  const cwUrl = (target) => location.origin + api + '/c/' + target;
  // our own ship, for the urb:// address: Eyre's /~/host, asked once. ''
  // while it is on its way, null if it failed. Until then there is no
  // address, never a made-up one: nothing shows or copies a placeholder.
  let ourShip = '';
  const urbUrl = (target) => (ourShip ? 'urb://' + ourShip + '/' + target : null);
  const urbMissing = () => (ourShip === null ? 'address unavailable' : 'loading address');
  let shareShown = null;
  fetch('/~/host').then((r) => (r.ok ? r.text() : '')).catch(() => '').then((t) => {
    ourShip = t.trim() || null;
    if (shareShown) paintShareCopy(shareShown);
    renderPublished();
  });
  const at = (u) => (u ? 'at ' + u : '(' + urbMissing() + ')');
  const SHARE_COPY = {
    private: () => 'Private: only you, and any ship or group you give access below. '
      + 'Not published anywhere.',
    shared: (u) => 'Shared: any ship can read it over Urbit ' + at(u) + '. Not on the web.',
    clearweb: (u, w) => 'Clearweb: anyone with the link can read it on the web at '
      + w + ', no login needed. Any ship can also read it over Urbit ' + at(u) + '.',
  };
  const FOLDER_COPY = {
    private: SHARE_COPY.private,
    shared: () => 'Shared: any ship can read every page in it over Urbit, each at its '
      + 'own urb:// address (Access & groups lists them). Not on the web.',
    clearweb: (u, w) => 'Clearweb: anyone with the link can read it on the web at '
      + w + ', no login needed. Any ship can also read every page in it over Urbit.',
    mixed: () => 'Mixed: the pages in this folder are not all shared the same way. '
      + 'Access & groups lists the published ones.',
  };
  function paintShareCopy(m) {
    shareShown = m;
    const target = curFolder || current;
    const copy = curFolder ? FOLDER_COPY : SHARE_COPY;
    const t = target ? target + (curFolder ? '/' : '') : 'this-page';
    const u = curFolder ? null : urbUrl(t), w = cwUrl(t);
    for (const b of document.querySelectorAll('.share button')) b.title = copy[b.dataset.m](u, w);
    $('sharewhat').textContent = copy[m] ? copy[m](u, w) : '';
  }

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
    paintShareCopy(m);
    orreryShow();
    refreshSensitive(curFolder || current);
    const target = curFolder || current;
    const suffix = curFolder ? '/' : '';
    // Build the public link as DOM, never innerHTML: a page/folder name is
    // content (the codebase rule everywhere else), and interpolating it into
    // markup makes this sink depend on every name source staying sane-%ta.
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
      // going public from private (or from a folder, which may be mixed)
      // asks first; moving between the two public modes does not
      const was = curFolder ? null
        : (nodes.find((x) => x.page && x.path === current) || {}).share;
      const pub = (x) => x === 'shared' || x === 'clearweb';
      if (pub(m) && !pub(was) && !(await askPublish())) return;
      // a share write is a real round trip (0.3-2s), and all three buttons
      // stayed clickable through it — enough time for a second click to fire
      // a second mutation against the same target. Freeze the row for the
      // duration; the st() calls below already end the spin either way.
      const btns = document.querySelectorAll('.share button');
      for (const x of btns) x.disabled = true;
      stWork('setting ' + m + '…');
      try {
        if (curFolder) {
          const r = await mutate(api + '/page-share-tree?name=' + encodeURIComponent(curFolder) +
            '&mode=' + m);
          if (!r.ok) { st('share failed' + await errText(r), false); return; }
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
        if (!r.ok) { st('share failed' + await errText(r), false); return; }
        showShare(m);
        st('sharing: ' + m);
        const n = nodes.find((x) => x.page && x.path === current);
        if (n) n.share = m;
        snapTree();
        renderTree();
      } finally {
        for (const x of btns) x.disabled = false;
      }
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

  // ── mark-sensitive: the OPEN page or folder's OWN sensitive flag ─────────
  // A sensitive page (or folder, inherited by its pages) is invisible to an
  // agent key without the sensitive clearance, and such a key cannot write it.
  // The checkbox shows and sets this page's own marker; refreshed on every
  // target change through showShare, like the grant row above.
  const refreshSensitive = async (target) => {
    const cb = $('shsens');
    if (!cb) return;
    $('shsensres').textContent = '';
    if (!target) { cb.checked = false; cb.disabled = true; return; }
    cb.disabled = false;
    try {
      const r = await fetch(api + '/page-sensitive?name=' + encodeURIComponent(target));
      const on = r.ok && (await r.json()).on === true;
      // the target can change while this GET is in flight (same bug class the
      // showShare comment documents): only apply if it is still current.
      if ((curFolder || current) !== target) return;
      cb.checked = on;
    } catch { if ((curFolder || current) === target) cb.checked = false; }
  };
  $('shsens').onchange = async () => {
    const target = curFolder || current;
    const cb = $('shsens');
    if (!target) { st('open a page first', false); cb.checked = false; return; }
    cb.disabled = true;
    const r = await mutate(api + '/page-sensitive?name=' + encodeURIComponent(target) +
      '&on=' + (cb.checked ? '1' : '0'));
    cb.disabled = false;
    if (!r || !r.ok) { cb.checked = !cb.checked; st('sensitive failed' + await errText(r), false); return; }
    $('shsensres').textContent = cb.checked
      ? target + ' is sensitive'
      : target + ' is no longer sensitive';
  };

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
  // selfBase is set before permsLoaded, and nothing here runs before that.
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
  // the panel's palette actions. Going public still asks (askPublish),
  // since the action is the button's own click.
  clickAction('share-private', 'Make private', 'Right pane › Page');
  clickAction('share-shared', 'Share over Urbit', 'Right pane › Page');
  clickAction('share-clearweb', 'Publish to the clearweb', 'Right pane › Page');
  clickAction('shsens', 'Mark sensitive', 'Right pane › Page');
  clickAction('aclopen', 'Manage groups', 'Right pane › Page');

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
  // latBase(), once known: a grant on one of our pages is a road under it
  let selfBase = null;
  //  bg: boot's deferred call yields to user activity (bgFetch). Panel
  //  opens and post-save re-reads stay on the user lane.
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
    // every surface that renders groups repaints from this one load
    renderAcl();
    renderGroupAccess();
  }
  async function permSave(g) {
    const r = await fetch(api + '/share-group-save?name=' + encodeURIComponent(g.name), {
      method: 'POST',
      body: JSON.stringify({ ships: g.ships, peek: g.peek, make: g.make }),
    }).catch(() => null);
    if (!r || !r.ok) st('permissions' + await errText(r), false);
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
  // ── shared with me: a folder in the files tree ──────────────────────────
  // Pages other ships granted us, fed by their share notices: "shared with
  // me", a folder per ship, and each page by its own name on that ship.
  // These are claims, not capabilities. An entry proves itself when opened,
  // and a stale one can just be removed. The folder exists only while there
  // is something in it.
  //
  // A notice names the page's code grub, <their base>/page/<name>/code. The
  // base is wherever lattice is installed there, so only the tail is read.
  const sharedName = (p) => {
    const m = /\/page\/(.+)\/code$/.exec(p);
    return m ? m[1] : p.replace(/^\/+/, '');
  };
  //  bg as in loadPerms: only boot uses it
  async function loadShared(bg = false) {
    let r = null;
    try { r = await (bg ? bgFetch : fetch)(api + '/shared-with-me'); } catch {}
    if (!r || !r.ok) return;           // the folder just stays as it was
    sharedWithMe = await r.json();
    renderTree();
  }
  // keys for the collapsed list: a leading space is in no page name, so a
  // page can never share a fold with this folder
  const SWM = ' shared';
  // appended by renderTree, after the pages
  function renderShared(coll) {
    const fold = (key, label, depth) => {
      treeList.appendChild(folderRow(label, depth, coll.includes(key),
        () => { paneColl.flip(key); renderTree(); }, undefined, key));
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
        a.style.marginLeft = '28px';
        a.href = '/apps/lattice/app?grub=' + encodeURIComponent(it.path) +
          '&ship=' + encodeURIComponent(host);
        a.title = host + ' ' + it.path;
        // the name gives way to the tag and the ×, never the other way round
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
        x.onclick = async (e) => {
          e.preventDefault(); e.stopPropagation();
          const r = await fetch(api + '/shared-with-me-del?host=' + encodeURIComponent(host) +
            '&path=' + encodeURIComponent(it.path), { method: 'POST' }).catch(() => null);
          if (!r || !r.ok) { st('remove failed' + await errText(r), false); return; }
          loadShared();
        };
        // into my own tree as a link: this, or a drag onto a folder
        const mv = document.createElement('span');
        mv.className = 'swmv';
        mv.setAttribute('role', 'button');
        tip(mv, 'Move into my pages');
        mv.innerHTML = ico('link');
        mv.onclick = (e) => { e.preventDefault(); e.stopPropagation(); askMoveIn(it); };
        a.append(nm, md, mv, x);
        a.draggable = true;
        a.ondragstart = (e) => {
          swmDrag = it;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(SWM_DRAG, it.host + ' ' + it.path);
        };
        a.ondragend = () => { swmDrag = null; };
        treeItem(a, 2, SWM + '/' + host + '/' + it.path);
        // a grub tab; openGrub (by way of enterGrub) sets the address
        tabLink(a, 'grub', it.path, { ship: host });
        treeList.appendChild(a);
      }
    }
  }

  // ── moving in and out: a shared page becomes a link in my tree ──────────
  // One home at a time: /link-make writes the link and drops the
  // shared-with-me entry, /link-unmake puts the entry back and drops the
  // link. Neither touches the owner's grant. Both need the host's page to
  // have a kind, so a make with the host offline is refused, not queued.
  const SWM_DRAG = 'application/x-lattice-shared';
  let swmDrag = null;          // the entry being dragged, for the drop
  // the link's local name: the folder it lands in, then the page's own name
  const swmLeaf = (it) => sharedName(it.path).split('/').pop();
  // -> true once the link is in, after saying why when it is not
  async function moveIn(it, to) {
    stWork('moving ' + swmLeaf(it) + ' into ' + to + '\u2026');
    const r = await fetch(api + '/link-make?host=' + encodeURIComponent(it.host) +
      '&path=' + encodeURIComponent(it.path) + '&to=' + encodeURIComponent(to),
    { method: 'POST' }).catch(() => null);
    if (!r || !r.ok) { st('move failed' + await errText(r), false); return false; }
    let n = null;
    try { n = await r.json(); } catch {}
    sharedWithMe = sharedWithMe.filter((s) => !(s.host === it.host && s.path === it.path));
    if (to.includes('/')) addFolderNodes(to.slice(0, to.lastIndexOf('/')));
    dropTreeNodes(to);
    nodes.push(n && n.path === to ? n : { path: to, page: true, kind: 'md',
      link: { host: it.host, path: it.path, mode: it.mode, seen: { ok: true } } });
    snapTree();
    renderTree();
    st('moved into ' + to + ', linked from ' + it.host);
    return true;
  }
  // the move dialog, seeded with the page's name (or <folder>/<name>), and
  // back into it seeded with what was typed when the ship refuses
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
  // a folder row in Files takes a dragged shared-with-me row: the link
  // goes in under that folder by the page's own name
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
      moveIn(it, folder + '/' + swmLeaf(it));
    });
  }
  // the link at `name` back to shared with me. What is open on it closes
  // the way a deleted page's does.
  async function linkBack(name) {
    const lk = linkOf(name);
    if (!lk) return;
    if (current === name && !(await guardDirty())) return;
    const r = await fetch(api + '/link-unmake?name=' + encodeURIComponent(name),
      { method: 'POST' }).catch(() => null);
    if (!r || !r.ok) { st('move failed' + await errText(r), false); return; }
    dropTreeNodes(name);
    snapTree();
    if (current === name || (activeTab && activeTab.kind === 'page' && activeTab.key === name)) {
      dirty = false;
      newFile('', false);
    }
    renderTree();
    await loadShared();
    st('moved ' + name + ' back to shared with me');
  }
  // the palette's way in: which shared page, then the move dialog. Its
  // home is out of sight in the Files pane; the rows' own buttons are the
  // way a pointer goes.
  const swmHold = document.createElement('div');
  swmHold.hidden = true;
  swmHold.innerHTML = '<button type="button" id="swmmv" data-action="swm-move">Move into my pages</button>';
  $('tree').append(swmHold);
  $('swmmv').onclick = async () => {
    if (!sharedWithMe.length) { st('nothing is shared with you', false); return; }
    const label = (it) => it.host + '/' + sharedName(it.path);
    const pick = sharedWithMe.length === 1 ? label(sharedWithMe[0])
      : await askChoice('move which page into my pages?', sharedWithMe.map(label), 'pick');
    const it = sharedWithMe.find((x) => label(x) === pick);
    if (it) askMoveIn(it);
  };
  action({ id: 'swm-move', name: 'Move into my pages', home: 'Files \u203a shared with me',
    when: () => sharedWithMe.length > 0, run: () => $('swmmv').click() });
  // deferred to boot, same reason as loadPerms. See 67-perms.js.

// ── src/70-upload.js ──────────────────────────────────────────────────────
  // ── upload (pickers + drag-and-drop, progress panel) ─────────────────────
  //  which extensions arrive as which kind is EXT_KIND, in 30-tree.js. Each
  //  path segment is slugged by slugSeg (10-shell.js), the same rule a typed
  //  page name gets.
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
    //  names, not just a count: a batch of thirty dropped files that skips
    //  three leaves the user guessing which three without this
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
      list.push({ file, name, kind });
    }
    if (!list.length) {
      upShow();
      // EXT_KIND (30-tree.js) is the one table the picker filter and this
      // message both have to agree with, so read it instead of hand-listing
      // extensions that drift the moment a new kind is added.
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
    // No folder-new first: every name in the batch is a full path, and the
    // ship's %make-many creates each page's missing parent folders itself
    // (make-page, ensure-dirs), the way a single save does. A folder-new per
    // directory was a ~2s writer round-trip apiece for nothing.
    //
    // ONE request per chunk, not one per file: every request pays the pier's
    // ~0.5s floor serially, so a 20-file drop used to be ~20 round-trips of
    // pure overhead doing work the server can batch. Chunked because the
    // route bounds a single transaction (200) and a whole folder should not
    // become one unbounded write.
    const CHUNK = 50;
    let fails = 0, done = 0;
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      let r = null;
      const payload = [];
      try {
        for (const it of part) {
          payload.push({ name: it.name, type: it.kind, body: (await it.file.text()) || '\n' });
          // the read is awaited one file at a time, so the bar can move with
          // it instead of sitting at 0% for the whole chunk and then jumping
          upProg(done + payload.length, list.length, it.name, 'reading');
        }
        r = await mutate(api + '/page-save-batch',
          { method: 'POST', body: JSON.stringify(payload) });
      } catch {}
      if (!r || !r.ok) {
        // the batch is all-or-nothing, so report the whole chunk rather than
        // implying some of it landed, and name what it held: a count alone
        // leaves the user diffing the tree by hand to find which files never
        // made it
        fails += part.length;
        let msg = r ? r.status : 'network';
        if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
        const names = part.map((it) => it.name);
        const held = names.length > 6
          ? names.slice(0, 6).join(', ') + ', and ' + (names.length - 6) + ' more'
          : names.join(', ');
        upErr.textContent += `failed: ${part.length} file(s) — ${msg}\n  ${held}\n`;
      } else {
        // an upload can OVERWRITE an existing page, and the batch's targets
        // live in the POST body where mutate() can't see them — so every
        // session tier must be told by hand, or openPage's pageCache hit
        // serves the pre-upload body with zero requests and the next
        // autosave buries the uploaded content under it.
        for (const it of payload) {
          pageCache.delete(it.name);
          const nd = nodes.find((n) => n.page && n.path === it.name);
          if (nd) { nd.body = it.body; nd.kind = it.type; }
          else addTreeNode(it.name, it.type);
        }
        // and the SW pages cache, blind to POST bodies the same way
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

  // desktop shell: webkit2gtk has no webkitdirectory (folder picks are dead
  // on Linux), so the tauri pick_upload command opens the native dialog and
  // hands back {rel, text} for user-picked files. Browsers keep the inputs.
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
  // A drag carries files, or it carries something else entirely, most often
  // a text selection dragged around inside the editor. window used to
  // preventDefault on every drag without asking which, which also cancels
  // the browser's native text drop and paints the tree as a target for a
  // drop it was never going to accept. types is populated the moment the
  // drag starts, well before any drop, so the two handlers below check the
  // same thing at two different points in the same gesture.
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
  // ── LaTeX to HTML ────────────────────────────────────────────────────────
  //  A .tex page gets a convert button that runs pandoc on THIS machine and
  //  writes the result back as an ordinary html page. The ship never learns
  //  LaTeX: it stores tex source as text and serves the output as html, both
  //  of which it already knew how to do.
  //
  //  Desktop only, because the conversion is a local subprocess. On the web
  //  the button is simply absent, which is honest: there is nothing there that
  //  could run it.
  //
  //  pandoc is NOT bundled (it is GPL, and 150MB). We detect the user's own
  //  install and say where to get it when there is none.
  const texRust = () => (window.__TAURI__ && window.__TAURI__.core) || null;

  //  The output page's name. A page name is a key, so the source and its
  //  output cannot share one. The tree derives the shown extension from the
  //  kind, so `paper` (tex) lists as paper.tex and `paper-web` (html) lists
  //  as paper-web.html without either name carrying an extension itself.
  const texOut = (name) => name + '-web';

  //  pandoc copies \href and \includegraphics targets through as written,
  //  and the output is saved as an html page of OUR OWN, which runs as the
  //  owner. A .tex a peer may edit could carry a javascript: link or a
  //  remote media source. Links keep http(s), mailto and relative targets.
  //  Media keeps relative sources only, so viewing the page tells no other
  //  host. Anything that embeds or runs is dropped. A <template> parses
  //  inertly: nothing in it loads or runs while it is cleaned.
  const TEX_DROP = 'script,style,iframe,frame,object,embed,video,audio,source,track,form,base,meta,link,svg';
  const TEX_SRC = ['src', 'srcset', 'poster', 'action', 'formaction', 'data', 'background'];
  function cleanTexHtml(html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    t.content.querySelectorAll(TEX_DROP).forEach((e) => e.remove());
    for (const e of t.content.querySelectorAll('*')) {
      for (const a of [...e.attributes]) {
        const n = a.name.toLowerCase();
        //  browsers drop these characters inside a scheme ("java\tscript:")
        //  and read a backslash as a slash ("\\host" is "//host")
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

  //  Probed on every .tex page open rather than once at boot: someone who
  //  installs pandoc and comes back should find the button live without
  //  restarting the app.
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
    //  The button stays CLICKABLE without pandoc, and explains itself when
    //  pressed. A disabled control with no explanation is a dead end: the
    //  person who most needs the message is the one who cannot click.
    b.classList.toggle('needsdep', !(texProbe && texProbe.available));
  }

  //  A rejected invoke means one of two very different things, and saying the
  //  wrong one sends someone off to install software they already have. An
  //  app built before these commands existed rejects with "not found"; a real
  //  probe answers {available:false} when pandoc is genuinely missing.
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

  //  a double click must not launch two converts: both write the same output
  //  page and the second surfaces the race as a write failure.
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
      //  the UI comes from the ship and updates on reload. The commands it
      //  calls live in the binary, which does not. That gap is exactly what
      //  this branch exists to name.
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
      //  pandoc names the line and the construct it choked on. Show that,
      //  not a generic failure.
      st('pandoc: ' + String(e && e.message ? e.message : e).slice(0, 160), false);
      return;
    }
    //  A derived page. Say so IN the file, because the next convert
    //  overwrites it and hand edits would vanish with no warning.
    const body = '<!-- generated from ' + current +
      '.tex by pandoc. Edits here are lost on the next convert. -->\n' + html;
    //  &new=1 only the first time: page-save answers 409 to a create over an
    //  existing name, and a re-convert is an overwrite by design.
    const known = nodes.some((n) => n.page && n.path === out);
    const url = api + '/page-save?name=' + encodeURIComponent(out) + '&type=html';
    let r = await mutate(url + (known ? '' : '&new=1'), { method: 'POST', body });
    //  the local tree can run behind the ship: a sibling created elsewhere
    //  answers our create with 409. The page exists, so retry the write the
    //  way every re-convert already works, as an overwrite.
    if (!known && r && r.status === 409)
      r = await mutate(url, { method: 'POST', body });
    if (!r || !r.ok) { st('could not write ' + out + await errText(r), false); return; }
    if (!known) { addTreeNode(out, 'html'); snapTree(); renderTree(); }
    bustPages(out);
    st('wrote ' + out + '.html');
  }

  //  wired here, where the handler lives (the same rule 45-templates and
  //  75-move follow)
  if (texBtn()) texBtn().onclick = convertTex;

  // ── live preview ─────────────────────────────────────────────────────────
  //  60-preview paints every content kind synchronously. pandoc is a
  //  subprocess and cannot answer inside that call, so this keeps the last
  //  conversion and hands it over immediately, then repaints when a fresh one
  //  lands. Declared with `function` rather than `const`: 60-preview.js loads
  //  first and names texPreviewHtml, so it must be hoisted, not in a TDZ.
  let texCache = { src: null, html: null };
  let texTimer = 0;
  let texBusy = false;

  //  400ms, not the 60ms the other kinds use. Those call a function; this
  //  spawns a process, and one per keystroke would be a fork bomb with a
  //  progress bar.
  const TEX_DEBOUNCE = 400;

  function texSourceFallback(body) {
    return '<pre>' + mdEsc(body) + '</pre>';
  }

  function texPreviewHtml(body) {
    //  On the web there is no pandoc, so show the source rather than an empty
    //  pane. A blank preview reads as broken; the source reads as honest.
    if (!texRust()) return texSourceFallback(body);
    if (texCache.src !== body) scheduleTexRender(body);
    //  until the first conversion returns, the source stands in. Typing then
    //  refines rather than flashing empty.
    return texCache.html === null ? texSourceFallback(body) : texCache.html;
  }

  function scheduleTexRender(body) {
    clearTimeout(texTimer);
    texTimer = setTimeout(() => { runTexRender(body); }, TEX_DEBOUNCE);
  }

  async function runTexRender(body) {
    const rust = texRust();
    if (!rust) return;
    //  never two pandocs at once. The newer body wins, so re-arm rather than
    //  queue: whatever is typed last is what anyone wants to see.
    if (texBusy) { scheduleTexRender(body); return; }
    if (!texProbe) texProbe = await probePandoc(rust);
    //  no renderer to call: leave the source showing rather than blanking the
    //  pane. The button carries the explanation; the preview stays quiet.
    if (!texProbe.available) { texCache = { src: body, html: null }; return; }
    texBusy = true;
    let html = null;
    let err = null;
    try { html = cleanTexHtml(await rust.invoke('convert_tex', { src: body })); }
    catch (e) { err = String(e && e.message ? e.message : e); }
    texBusy = false;
    //  A broken document must SAY so. Freezing the last good render would
    //  leave a stale page on screen while the source no longer produces it.
    texCache = {
      src: body,
      html: html !== null ? html
        : '<pre style="color:#c33;white-space:pre-wrap">' +
          mdEsc(err || 'pandoc could not convert this document') + '</pre>',
    };
    //  the body may have moved on while pandoc ran
    if (src.value !== body) { scheduleTexRender(src.value); return; }
    paintLocal();
  }

// ── src/72-acl.js ─────────────────────────────────────────────────────────
  // ── access control pane: <lat-acl>, the peers panel with room to work ────
  // Same data and same endpoints as the narrow editor panel (67-perms.js).
  // This is a tool tab for organising it (24-tools.js). Deliberately NOT a
  // third setMode branch. setMode is wired into the tree/editor lifecycle and
  // access control has nothing to do with either (same reasoning as 40-grub.js).
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

  // every way in (#aclopen in the Page tab, the ribbon, the phone's sheet)
  // lands on the one Access & groups tab, and its coming forward loads it
  const aclOpen = () => toolOpen('access');
  const aclLoad = () => {
    // permGroups is populated by boot's deferred load. Only pay a request if
    // the pane was opened before that landed. Guard on permsLoaded, not the
    // array's length: a ship with zero groups is a real, load-complete
    // answer, and checking length alone paid a live round trip on every open
    // forever for exactly that ship. 66-share.js already made this call.
    if (!permsLoaded) loadPerms(); else renderAcl();
    loadBans();
    renderPublished();
  };

  // ── published pages: every address worth handing out ─────────────────────
  // Each shared page by its urb:// address and each clearweb page by its
  // https link, the very strings the Page tab gives (urbUrl and cwUrl,
  // 66-share.js), each with a copy button. Read off the tree's share modes,
  // which page-dump already carries: no request of its own. renderTree
  // repaints it while this tab is in front, so a page shared or made
  // private elsewhere comes and goes here too.
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
        // no ship name yet (or none to be had): no address, and nothing to copy
        if (!u) {
          const m = document.createElement('span');
          m.className = 'aclnote';
          m.textContent = n.path + ': ' + urbMissing();
          b.disabled = true;
          row.append(m, b);
          host.appendChild(row);
          continue;
        }
        // a clearweb link opens in a new window. A urb:// address opens in
        // the reader (/apps/lattice?url=), which leaves the editor, so a
        // plain click goes the way the ribbon's Browser does (leaveTo,
        // 24-tools.js): unsaved work is asked about first. A new-tab click
        // leaves nothing behind and goes as it is.
        const a = document.createElement('a');
        a.textContent = u;
        if (mode === 'clearweb') { a.href = u; a.target = '_blank'; a.rel = 'noopener'; }
        else {
          a.href = api + '?url=' + encodeURIComponent(u);
          a.onclick = (e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
            e.preventDefault();
            leaveTo(a.href);
          };
        }
        b.onclick = async () => {
          try { await navigator.clipboard.writeText(u); st('copied ' + u); }
          catch { st('could not copy ' + u, false); }
        };
        row.append(a, b);
        host.appendChild(row);
      }
    }
    if (!any) note('nothing is published. Share a page from its Page tab and it shows here.');
  }
  action({ id: 'published', name: 'Published pages', home: 'Ribbon › Access & groups',
    run: async () => { await aclOpen(); $('aclpub').scrollIntoView({ block: 'start' }); } });

  // suggest the grantable paths this client already knows about, so a grant is
  // a pick rather than a hand-typed ball path. Built from the tree we have.
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

  // the card's title bar: the group's name, and the button that removes it
  function aclHead(g) {
    const head = document.createElement('header');
    const b = document.createElement('b');
    b.textContent = g.name;
    const del = document.createElement('button');
    del.textContent = 'delete';
    del.className = 'acl-del';
    del.onclick = async () => {
      if (!(await askConfirm('delete group ' + g.name + ' and every grant it carries?', 'delete'))) return;
      const r = await fetch(api + '/share-group-del?name=' + encodeURIComponent(g.name),
        { method: 'POST' }).catch(() => null);
      // loadPerms repaints from the ship either way, so a delete that failed
      // and a group that came back on its own look identical. Say which it
      // was, the rule permSave and the ban handler already follow.
      if (!r || !r.ok) st('could not delete ' + g.name + await errText(r), false);
      loadPerms();
    };
    head.appendChild(b); head.appendChild(del);
    return head;
  }

  // who is in the group: the chips, and the row that adds one more
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

  // granting a path: one input, and the two buttons that say how far it goes
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

  // the grants this pane carries but will not let you edit
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

  // one card, one group. `disp` shortens a path against the whole pane.
  function aclCard(g, disp) {
    const card = document.createElement('div');
    card.className = 'aclcard';
    card.appendChild(aclHead(g));
    aclShips(card, g);
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
    // one disambiguation scope for the whole pane, so the same page shows
    // the same short name in every card
    const allPaths = permGroups.flatMap((x) => [...x.peek, ...x.make]);
    const disp = (v) => shortPath(v, allPaths);
    for (const g of permGroups) grid.appendChild(aclCard(g, disp));
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
        const r = await fetch(api + '/unban?ship=' + encodeURIComponent(w), { method: 'POST' })
          .catch(() => null);
        // announce the unban only once the ship has agreed to it
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
    // banning revokes every grant the ship holds right now, and unban does
    // not bring them back (the nexus is explicit about that) — a mistyped
    // ship name is a permanent loss with no online undo, so ask first the
    // way delete already does.
    if (!(await askConfirm('ban ' + w + '? this revokes every grant it holds, and unban will not restore them', 'ban'))) return;
    const r = await fetch(api + '/ban?ship=' + encodeURIComponent(w), { method: 'POST' })
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
  // ── comments inbox: <lat-comments> ───────────────────────────────────────
  // Comments arrive from OTHER ships, and until now the workspace had no view
  // of them. The reader rendered a thread per page, so finding out anyone had
  // replied meant visiting each published page. This is the owner's side: what
  // came in, across every page, newest first, with a way to remove one.
  //
  // Reuses the .aclwrap/.aclbar/.aclbody styles rather than growing a second
  // set that would drift from them. It shows in a tool tab (24-tools.js).
  customElements.define('lat-comments', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="cmwrap" hidden role="region" aria-label="comments">
  <div class="aclbar">
    <h2>Comments</h2>
    <span class="muted" id="cmsum"></span>
    <span class="grow"></span>
    <button id="cmreload" class="ico" title="reload from ship">&#8635;</button>
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
      if (!r.ok) { st('comments failed' + await errText(r), false); return; }
      d = await r.json();
    } catch { st('comments failed', false); return; }
    inbox = d.items || [];
    renderComments(d.total || inbox.length);
  }

  // The inbox by default. The Comments tab (76-outline.js) passes one
  // page's share of it, its own host and empty line, and its own reload,
  // and leaves out the page link, which would only point at itself.
  function renderComments(total, {
    host = $('cmlist'), items = inbox, sum = $('cmsum'), reload = loadComments,
    // say WHY it might be empty. Comments are opt-in per page, so "none yet"
    // and "never enabled anywhere" look identical and mean different things
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
        if (!(await askConfirm('remove this comment by ' + c.author + '?', 'remove'))) return;
        const r = await fetch(api + '/comment-del?page=' + encodeURIComponent(c.page) +
          '&id=' + encodeURIComponent(c.id), { method: 'POST' }).catch(() => null);
        if (!r || !r.ok) { st('remove failed' + await errText(r), false); return; }
        st('comment removed');
        reload();
      };
      head.appendChild(who); head.appendChild(del);
      card.appendChild(head);

      // the page it landed on, clickable. The point of an inbox is getting
      // to the thing being talked about
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

  // ── unread ───────────────────────────────────────────────────────────────
  // A comment from another ship used to land in total silence: the inbox is
  // pull-only, so the only way to learn anyone had said anything was to open
  // it and look. That makes the feature invisible in practice.
  //
  // "Seen" is a high-water mark, not a per-comment flag. The @da stamps the
  // items carry are NOT fixed-width — scot %da leaves month and day unpadded
  // (~2026.8.9 vs ~2026.10.1) — so a raw lexical compare misorders across
  // every 9->10 boundary and the badge goes silent for months at a time.
  // daKey pads the numeric fields into a genuinely sortable string; marks
  // stored by older builds compare fine because both sides go through it.
  const daKey = (w) => String(w || '').replace(/\d+/g, (d) => d.padStart(4, '0'));
  const seenKey = 'cmtSeen';
  const lastSeen = () => { try { return localStorage[seenKey] || ''; } catch { return ''; } };
  const markSeen = (when) => { try { if (when) localStorage[seenKey] = when; } catch {} };

  // on the ribbon's inbox button: the badge, and the count in its name, so
  // a screen reader hears it too (title and label stay identical)
  function paintUnread(n) {
    const b = $('rb-inbox');
    if (!b) return;
    if (n > 0) { b.dataset.n = n > 99 ? '99+' : String(n); b.classList.add('has-unread'); }
    else { delete b.dataset.n; b.classList.remove('has-unread'); }
    tip(b, n > 0 ? 'Comments inbox, ' + b.dataset.n + ' unread' : 'Comments inbox');
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
    unreadSeen = items.filter((c) => daKey(c.when) > daKey(mark)).length;
    stampSeen = stamp;
    paintUnread(unreadSeen);
  }

  const cmOpen = () => toolOpen('inbox');
  // the inbox's tab came forward (24-tools.js). Opening IS reading: mark
  // everything currently in the inbox as seen
  const cmLoad = () => {
    loadComments().then(() => {
      const newest = inbox.reduce(
        (a, c) => (daKey(c.when) > daKey(a) ? String(c.when) : a), lastSeen());
      markSeen(newest);
      // reading IS the recount: without dropping the cached stamp, the next
      // same-stamp fast path repaints the PRE-read number forever
      stampSeen = null;
      unreadSeen = 0;
      paintUnread(0);
    });
  };
  $('cmreload').onclick = loadComments;

// ── src/74-orrery.js ──────────────────────────────────────────────────────
  // ── send the open page to orrery (ui-app/orrery.js, docs/orrery.md) ──────
  // A section of the controls pane, shown only while orrery is installed and
  // a saved page is open: a folder, or a new page not saved yet, has nothing
  // for orrery to follow. Follows every target change through +showShare.
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
  // ── move / rename ────────────────────────────────────────────────────────
  // page-move does the whole thing server-side (copy + share carry-over +
  // delete, wikilink self-references rewritten) in ONE request. The old
  // client choreography was 3 round-trips per page plus one per folder.
  // Memories use the know-move route, which culls the source key outright.
  // Only the current body carries over, not the history: the new key's own
  // history starts fresh at rev 1.
  // rn: the realName() split of the new name. Its dname is ALWAYS sent: ''
  // (the typed name was a valid path) clears the one the move would
  // otherwise carry over; dnames names the folders the move creates.
  const moveReq = (from, to, rn) =>
    mutate(api + '/page-move?from=' + encodeURIComponent(from) +
      '&to=' + encodeURIComponent(to) + '&dname=' + encodeURIComponent((rn && rn.dname) || '') +
      (rn && rn.dnames ? '&dnames=' + encodeURIComponent(rn.dnames) : ''));
  // the server moves the WHOLE subtree (a page can parent nested pages, and
  // move-pages rewrites every rel under it). Renaming only the exact node
  // left those children pointing at paths that no longer exist, ghosts in
  // the tree until the next full loadTree. So the local tree gets the same
  // suffix-preserving remap, as does the offline queue's own move
  // reconciliation. Returns how many pages moved.
  const remapMoved = (from, to, rn) => {
    tabsRemap('page', from, to);       // and the tabs naming them (21-tabs.js)
    let moved = 0;
    for (const n of nodes)
      if (n.path === from || n.path.startsWith(from + '/')) {
        if (n.page) moved++;
        n.path = to + n.path.slice(from.length);
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
    //  the response, not a bare true: the caller's message must say when the
    //  move was queued offline, and only the response knows.
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
        // the server refused this name \u2014 loop back into askName seeded with
        // it, so the retry is an edit, not a full retype
        st('move failed' + await errText(r), false);
        seed = typed;
        continue;
      }
      const moved = remapMoved(oldPath, newPath, rn);
      if (current && (current === oldPath || current.startsWith(oldPath + '/')))
        current = newPath + current.slice(oldPath.length);
      snapTree();
      renderTree();
      st('moved ' + oldPath + ' \u2192 ' + newPath +
        (r.offline ? ' offline' : '') + ' (' + moved + ' pages)');
      if (current) openPage(current);
      else if (curFolder === oldPath) selectFolder(newPath);
      return;
    }
  }

// ── src/76-outline.js ─────────────────────────────────────────────────────
  // ── right pane: Outgoing, Outline, Comments, and what follows the document ─
  // The right pane's tabs are about the document in front. Outgoing and
  // Outline read its text, the rest fetch, and all of them repaint when the
  // document changes: setOpen (every open, tab switch and mode change goes
  // through it) fires 'input' on the name field, resetPanels runs on every
  // fresh paint of a page or memory, and the editor's render tells them the
  // text moved. A tab that does not apply to what is in front says so in
  // one line, and never hides: a tab strip that changes shape under the
  // pointer is worse than one that is sometimes empty.

  // The link targets the preview renderer (59-md.js) makes of a document,
  // deduped, in order. Read off its own output, so a link here is exactly a
  // link there: fences, images, unsafe schemes and escaping all come out the
  // same. A page link comes back as its page name, a urb:// link as itself.
  function outLinks(body, kind) {
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

  // The headings of a document, by the rules the same renderer uses: md
  // #..###### with a space, gmi #..### with one, nothing inside a fence.
  // `line` counts from 1.
  function outline(body, kind) {
    const out = [];
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

  // What is in front, as the pane sees it: a page (named or not yet), a
  // memory, a grub, or nothing it has tabs for (a folder, an empty editor
  // after a close, a tab kind with no document such as a tool).
  const rpDoc = () => {
    if (activeTab && !['page', 'know', 'grub'].includes(activeTab.kind)) return null;
    if (grubPath) return { kind: 'grub', key: grubPath };
    if (curFolder !== null) return null;
    return { kind: mode === 'know' ? 'know' : 'page', key: current };
  };
  // Outgoing and Outline need text a renderer reads. History needs a
  // document with revisions, so a saved page or memory. Backlinks and
  // Comments are about pages.
  const rpApplies = (id, d) => !!d && (
    id === 'out' || id === 'outline' ? d.kind !== 'grub'
      : id === 'hist' ? d.kind !== 'grub' && !!d.key
        : d.kind === 'page' && !!d.key);
  const RP_BODY = { out: 'outsec', outline: 'olsec', back: 'linksec', comments: 'rpcmsec', hist: 'histsec' };
  const rpText = () => (mode === 'know' ? 'md' : pkind.value);

  // which fetched tab holds which document ('page:a/b'). A tab whose entry
  // differs from what is in front loads when it is next seen.
  const rpLoaded = {};
  let rpTimer = 0;
  let rpForce = null;
  function rpPaint() {
    rpTimer = 0;
    const force = rpForce;
    rpForce = null;
    const d = rpDoc();
    const key = d && d.key ? d.kind + ':' + d.key : null;
    // the Page tab is the controls of the document underneath, which a tab
    // that is not a document (a tool) is not. A folder (d null) keeps them:
    // they act on it.
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
    // a link's comments are its owner's (paintLink, 65-ctl.js)
    $('cmtrow').hidden = !(d && d.kind === 'page' && d.key && !linkOf(d.key));
    // the post box follows the flag, which can land after the list did
    if (rpApplies('comments', d)) paintCmBox();
  }
  // Always deferred: the callers are mid-paint (setOpen comes before the
  // body lands), and some run while later files are still loading.
  function rpSoon(ms = 30) {
    clearTimeout(rpTimer);
    rpTimer = setTimeout(rpPaint, ms);
  }
  pname.addEventListener('input', () => rpSoon());
  // typing repaints Outgoing and Outline once it pauses
  rpHook = () => rpSoon(300);
  // a tab brought forward shows its document now, and a fetched one fresh
  document.addEventListener('lat-pane', (e) => {
    if (e.detail.side !== 'r') return;
    rpForce = e.detail.id;
    rpSoon(0);
  });
  rpSoon(0);

  // ── Outgoing ─────────────────────────────────────────────────────────────
  // A page target opens through the tab model, so Ctrl/Cmd and the middle
  // button open it in a new tab. A page not in the tree is muted: following
  // it creates it. A web or urb:// target is an ordinary link.
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

  // ── Outline ──────────────────────────────────────────────────────────────
  // A click puts the caret on that heading's line and brings it into view.
  // In Read the preview scrolls instead, to the heading of the same index.
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
    const lines = src.value.split('\n');
    let off = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
    src.focus();
    src.setSelectionRange(off, off);
    // the textarea soft-wraps, so this is near the line, not on it. A third
    // of the way down leaves room for the error of a few wrapped lines.
    const lh = parseFloat(getComputedStyle(src).lineHeight) || 20;
    src.scrollTop = Math.max(0, (line - 1) * lh - src.clientHeight / 3);
    sync();
  }

  // ── Comments ─────────────────────────────────────────────────────────────
  // This page's share of the inbox (73-comments.js), with remove as there,
  // and a box to post one as the owner. A post only lands while comments
  // are on for the page (the ship drops it otherwise), so the box says so
  // and stays shut while they are off.
  async function loadPageComments() {
    const host = $('rpcmlist');
    const want = current;
    paintCmBox();
    host.className = 'muted';
    host.textContent = 'loading…';
    let d = null;
    try {
      const r = await fetch(api + '/comments-inbox');
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
    // the route answers a form post with a redirect to the reader. Not
    // followed: landing is all this needs to know.
    const r = await fetch(api + '/comment?page=' + encodeURIComponent(page), {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'body=' + encodeURIComponent(body),
    }).catch(() => null);
    $('rpcmpost').disabled = false;
    if (!r || !(r.ok || r.type === 'opaqueredirect')) { st('comment failed' + await errText(r), false); return; }
    if (current === page) $('rpcmbody').value = '';
    st('comment posted');
    // the write is its own transaction behind the answer
    setTimeout(() => { if (current === page) { rpForce = 'comments'; rpSoon(0); } }, 1500);
  };

// ── src/77-history.js ─────────────────────────────────────────────────────
  // ── history + backlinks panels: <lat-history>, <lat-links> ───────────────
  // Defined here (before this file's own $-lookups). They upgrade inside
  // their right pane tabs (13-frame.js), which load them when shown and
  // when the document changes under them (76-outline.js, rpPaint).
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

  // ── backlinks: pages that wikilink [[this page]] ─────────────────────────
  // fetched ONLY while the Backlinks tab is in front. This and history were
  // two more ~2s round-trips paid on every page open whether or not anyone
  // looked.
  const linkList = $('linklist');
  async function loadBacklinks() {
    linkList.textContent = '';
    if (!current || mode === 'know') return;
    const want = current;
    let j = null;
    // a panel nobody can see is not worth a rejection: an unreachable ship
    // leaves the list empty, the same as a refused request already does
    try {
      const r = await fetch(api + '/page-backlinks?name=' + encodeURIComponent(want));
      if (!r.ok) return;
      j = await r.json();
    } catch { return; }
    // the document changed while this was in flight: its own load follows
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

  // A page or memory was painted fresh. rpPaint reloads whichever of these
  // tabs is in front if it was about another document, and the other one
  // when it is next shown. The same document painted again (the upgrade
  // after a quiet open) costs nothing. History covers memories too.
  // Backlinks stay pages-only, since a wikilink search over the vault is a
  // different feature nobody asked for (rpApplies).
  function resetPanels() {
    histView.hidden = true;
    rpSoon();
  }

  // ── version history (born keeps every save; autosave makes it dense) ────
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
    // same rules as loadBacklinks: an unreachable ship leaves the panel
    // empty, and an answer about a document no longer open is dropped
    try {
      const r = await fetch(mode === 'know'
        ? api + '/know-history?key=' + encodeURIComponent(want)
        : api + '/page-history?name=' + encodeURIComponent(want));
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
      // @da is always ship UTC. daToUnix (vault.js) runs the same fields
      // through Date.UTC for the export mtime; do the same here so a chip
      // reads in the viewer's own zone instead of bare, unlabeled ship time.
      const m = /^~(\d+)\.(\d+)\.(\d+)\.\.(\d+)\.(\d+)\.(\d+)/.exec(v.updated || '');
      const when = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
      const label = when && when.toLocaleString(undefined,
        { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      // label by timestamp, not the raw clay revision id. prune-hist thins
      // keystroke-scale autosaves, so the id skips (1, 2, 16) and the gaps
      // read as missing versions. The id lives on dataset.rev for restore.
      a.textContent = label || ('rev ' + v.rev);
      a.dataset.rev = v.rev;
      a.className = v.rev === viewingRev ? 'on' : '';
      a.onclick = () => openRev(v.rev, label);
      histList.appendChild(a);
    }
  }
  async function openRev(rev, lbl) {
    // guardDirty covers a dirty grub, page, or memory in one place (see
    // 20-state.js): it flushes what it can and only asks when the flush
    // still leaves something unsaved.
    if (!(await guardDirty())) return;
    let d = null;
    try {
      const r = await fetch(mode === 'know'
        ? api + '/know-read-at?key=' + encodeURIComponent(current) + '&rev=' + rev
        : api + '/page-source-at?name=' + encodeURIComponent(current) + '&rev=' + rev);
      if (!r.ok) {
        st('revision load failed' + await errText(r), false);
        // prune-hist coalesces revisions inside its window on every save, so
        // a chip the pane still lists can genuinely be gone. Resync the list
        // instead of leaving a chip that will fail forever.
        if (r.status === 404) loadHistory();
        return;
      }
      d = await r.json();
    } catch { st('revision load failed (network)', false); return; }
    viewingRev = rev;
    // restore under the REVISION's own kind. Memories carry no kind at all
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
      // the dedicated restore route re-imports the revision's OWN tags via
      // %import, so the tag set that rev actually held comes back with it
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
    // save() reports its own failures and leaves dirty SET on every path
    // that did not durably hold the body — do not paint success over that
    if (!dirty) st('restored that version as the newest revision');
    loadHistory();
  };

  $('mv').onclick = async () => {
    if (viewingRev !== null) { st('viewing rev ' + viewingRev + ' — use restore', false); return; }
    if (curFolder) { moveFolder(curFolder); return; }
    if (!current) { st('open something first', false); return; }
    let seed = current;
    for (;;) {
      const typed = await askName('move ' + (mode === 'know' ? 'memory' : 'page') + ' ' + current + ' to:',
        seed, 'move');
      if (!typed) return;
      const rn = realName(typed);
      const newName = rn.name;
      // same path with a display name is still a rename (My Page over my-page)
      if (newName === current && !(mode !== 'know' && rn.dname)) return;
      if (mode === 'know') {
        //  the memory this move is for. A tab switch during the round trip
        //  moves `current`, and only this memory is renamed or relabeled.
        const from = current;
        const r = await mutate(api + '/know-move?from=' + encodeURIComponent(from) +
          '&to=' + encodeURIComponent(newName));
        if (!(r.ok || r.offline)) {
          // the server refused this name — loop back into askName seeded with
          // it, so the retry is an edit, not a full retype
          st('move failed' + await errText(r), false);
          seed = newName;
          continue;
        }
        // the body is already in the editor. Rename in place, no refetch
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
      const from = current;
      const mv = await movePage(from, newName, rn);
      if (mv) {
        st('moved to ' + newName + (mv.offline ? ' offline' : ''));
        //  same rule as the memory move: only the page still in front
        //  reopens under its new name
        if (mode !== 'know' && !grubPath && current === from) openPage(newName);
        return;
      }
      // movePage already reported the cause — loop back into askName seeded
      // with the rejected name
      seed = typed;
    }
  };

// ── src/78-export.js ──────────────────────────────────────────────────────
  // ── vault: scheduled-backup hook ───────────────────────────────────────────
  // The tar writer/reader and the whole export/restore path moved to the shared,
  // standalone ui-app/vault.js (loaded before this bundle), so the editor, the
  // settings page and a scheduled backup all build the SAME archive. The manual
  // "export vault" / "restore vault" buttons moved to Settings; see +settings-html
  // and vault.js's mountSettings.
  //
  // What stays here is only what is editor-specific: teach vault.js this page's
  // status line and offline state, then expose the hook the desktop scheduler
  // reaches in with (it evals window.__latticeBackup on whatever workspace page
  // is showing, which is usually this editor).
  if (window.LatticeVault) {
    LatticeVault.configure({
      status: (m, ok) => st(m, ok),
      isDegraded: () => degraded || !!offCount,
    });
    if (window.__TAURI__) {
      window.__latticeBackup = (id) => LatticeVault.exportVault(id);
      // "back up now" clicked while the manager page was showing: no workspace
      // page existed to receive the eval, so Rust navigates here with
      // ?backup=<id> and the boot runs it (3s: let the tree land first).
      const pend = new URLSearchParams(location.search).get('backup');
      if (pend) {
        // the param is a one-shot instruction. A service-worker takeover or
        // an offline fallback reloads this page with its query intact, and
        // re-reading it would write a second archive.
        const q = new URLSearchParams(location.search);
        q.delete('backup');
        const rest = q.toString();
        history.replaceState(history.state, '',
          location.pathname + (rest ? '?' + rest : '') + location.hash);
        setTimeout(() => window.__latticeBackup(pend), 3000);
      }
    }
  }

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
  // The dump carries each page's share mode too. A results list that cannot
  // say which hits are published would show private notes and clearweb pages
  // looking identical, on a screen someone may be sharing. That badge is a
  // safety signal, so a tree that may not carry share modes (treeShares,
  // 30-tree.js) still asks /page-scopes rather than call a page private.
  //
  // It is the left pane's Search tab (13-frame.js renders <lat-search> into
  // that section), so results sit beside the document they open rather than
  // over it, and stay there for the next pick.
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

  // Loaded when the tab is shown, not per keystroke: the scopes and the
  // memories are two requests, and then every keystroke is local.
  let qScopes = null;          // path -> 'private' | 'urbit' | 'clearweb'
  let qKnow = [];              // [{key, body}]
  let qKnowFailed = false;     // /know-all never answered this visit
  let qLoading = null;         // in-flight load, shared
  let qAt = '';                // both beacons when both last loaded (bothAt)
  // never-loaded and load-failed are different states. qCtxAttempts counts
  // how many times qLoadContextOnce has actually run since the tab was shown,
  // capped at two: the open-time load and one retry. A failure short of that
  // cap is worth trying again; past it, every keystroke would otherwise fire
  // the same doomed pair of requests forever.
  let qCtxAttempts = 0;
  // last painted hits and their rows, so ArrowUp/Down + Enter can act on
  // what is actually on screen without rescanning
  let qResults = [];
  let qRows = [];
  let qSel = -1;
  //  Showing the tab starts this, and the first keystroke wants it too. The
  //  pier serialises, so letting both fire meant four queued requests and a
  //  wait long enough to look like a hang. One load, both await it.
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
    //  stamped only when BOTH landed, so a half-failed load is retried
    qAt = qScopes && !qKnowFailed ? at : '';
  }

  // non-overlapping occurrence count: split yields pieces-1 = matches. The
  // empty-needle guard stays, since split('') would count every character.
  const qCount = (hay, needle) => needle ? hay.split(needle).length - 1 : 0;
  // a line of context around the hit, the way grep shows it
  const qSnip = (body, at, len) => {
    const from = Math.max(0, at - 40);
    const to = Math.min(body.length, at + len + 40);
    return (from ? '…' : '') + body.slice(from, to).replace(/\s+/g, ' ') + (to < body.length ? '…' : '');
  };

  //  one hit builder for both corpora. A page and a memory differ only in
  //  where the key and the body come from, and in what the badge says.
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

  //  the scan is pure: it reads the corpora already in memory and returns the
  //  ranked hits plus how many pages it could not look inside.
  function qScan(q) {
    const out = [];
    let skipped = 0;
    for (const n of nodes) {
      if (!n.page) continue;
      // A body over the dump's inline cap is not here, only its size. Say so
      // rather than quietly returning a result set that is missing pages.
      if (typeof n.body !== 'string') { skipped += 1; continue; }
      // NOT defaulted to 'private'. If the exposure lookup failed, or the
      // page is newer than it, calling it private would be a false safety
      // signal on a clearweb page: exactly the misread this badge exists to
      // prevent. Unknown says unknown.
      const h = qHit(n.path, n.body, q, (qScopes && qScopes.get(n.path)) || 'unknown', false);
      if (h) out.push(h);
    }
    for (const k of qKnow) {
      const h = qHit(String(k.key || '').replace(/^\/+/, ''),
        String(k.body || ''), q, 'knowledge', true);
      if (h) out.push(h);
    }
    // a name match is what you meant more often than a body match, then
    // whichever mentions it most
    out.sort((a, b) => (b.inPath - a.inPath) || (b.hits - a.hits) || a.key.localeCompare(b.key));
    return { out, skipped };
  }

  // opening a hit is the same move whether the mouse clicked it or Enter
  // picked it off the highlighted row
  const qOpenResult = (h, ev) => openIn(h.know ? 'know' : 'page', h.key, { ev });

  // the highlighted row alone, no rebuild: an inline background rather than
  // a class, since the app's .on styling is defined per-component and this
  // list has none of its own yet
  function qHighlight() {
    qRows.forEach((a, i) => { a.style.background = i === qSel ? 'var(--surface)' : ''; });
  }

  //  the summary line and the list. Names and bodies are content, so every
  //  string here goes in through textContent.
  function qPaint(host, sum, out, skipped) {
    const parts = [];
    if (out.length) parts.push(out.length + ' result' + (out.length === 1 ? '' : 's'));
    if (skipped) parts.push(skipped + ' large page(s) not scanned');
    if (qKnowFailed) parts.push('memories not searched');
    sum.textContent = parts.join(' · ');
    host.textContent = '';
    // a fresh result set starts with nothing highlighted
    qSel = -1;
    qRows = [];
    if (!out.length) {
      qResults = [];
      host.className = 'aclempty';
      // nodes starts empty and fills once the page-dump lands, seconds away
      // on a cold load. Zero hits against an empty corpus is not the same
      // claim as zero hits against the real one.
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
    // qScopes stays null both before the first load and after a failed one,
    // so gate on the attempt count instead: one retry, then search on with
    // scopes unknown rather than firing the same pair of requests every
    // keystroke a slow or unreachable pier ever gets typed at.
    if (!qScopes && qCtxAttempts < 2) {
      //  the exposure map and the memories are fetched once per open, and on a
      //  slow pier that is seconds. Say so, rather than showing an empty list
      //  that reads as "no results".
      host.className = 'aclempty';
      host.textContent = 'searching\u2026';
      await qLoadContext();
      if (mine !== qSeq) return;
    }
    const { out, skipped } = qScan(q);
    qPaint(host, sum, out, skipped);
  }

  // qPrime: what showing the tab owes, however it was shown (Ctrl+K, the
  // tab button, the phone sheet). The exposure map and the memories are
  // refetched only when a beacon moved since they loaded (90-sync.js), not
  // on every visit.
  const qPrime = () => {
    if (streamLive && qAt && qAt === bothAt()) return;
    qScopes = null;                          // refresh exposure
    qCtxAttempts = 0;                        // this visit gets its own retry
    qLoadContext();
  };
  document.addEventListener('lat-pane', (e) => {
    if (e.detail.side === 'l' && e.detail.id === 'search') qPrime();
  });
  // the query stays in the box between visits; selected, so typing replaces it
  const qOpen = () => {
    paneOpen('l', true);
    paneTab('l', 'search');
    const i = $('qinput');
    i.focus();
    i.select();
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
    // the omnibar's pattern: arrows move a highlighted row, Enter opens it.
    // With nothing highlighted, Enter falls through to its old job of
    // re-running the scan.
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

  // CAPTURE phase on window, so nothing downstream can swallow it. Vim mode's
  // handler is capture-phase on the textarea and consumes normal-mode keys
  // whole; being ahead of it is more robust than listing exemptions there.
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      e.stopPropagation();
      qOpen();
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
  // badge it stays up rather than living in the scrolling status line. The
  // ribbon's Sync conflicts button (24-tools.js) shows only while there are
  // any, with their count.
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
        if (!(await askConfirm('delete ' + path + '? Open it first if you need its text.', 'delete'))) return;
        const r = await mutate(api + '/page-del?name=' + encodeURIComponent(path));
        if (!r.ok) { st('delete failed' + await errText(r), false); return; }
        dropTreeNodes(path);
        snapTree();
        renderConflicts();
        renderConfBadge();
        renderTree();
        st(r.offline ? 'resolved ' + path + ' offline' : 'resolved ' + path);
      };
      head.appendChild(del);
      card.appendChild(head);
      host.appendChild(card);
    }
  }

  // its tab's coming forward renders it (24-tools.js)
  const cfOpen = () => toolOpen('conflicts');

// ── src/85-layout.js ──────────────────────────────────────────────────────
  // ── layout toggles ────────────────────────────────────────────────────────
  const ws = $('ws');
  // soft-wrap is the default (long lines running off-screen are unusable on
  // mobile). The toggle still turns it off, and a saved preference wins.
  if (!('appWrap' in localStorage)) localStorage.appWrap = '1';
  const applyToggles = () => {
    paintPanes();   // the side panes and their corner toggles (13-frame.js)
    ws.classList.toggle('wrap', localStorage.appWrap === '1');
    // Edit or Read, per tab (23-tabhead.js)
    applyRead();
    // keep the vim indicator in step with the view: it reads PREVIEW in
    // preview-only. setInd is exposed by 27-vim.js (it lives in that file's
    // own IIFE); guard in case that file is absent. A no-op when vim is off.
    if (window.latVimSetInd) window.latVimSetInd();
  };
  const flip = (k) => { localStorage[k] = localStorage[k] === '1' ? '0' : '1'; applyToggles(); };
  // A throw in this boot-time layout pass must NOT halt the rest of app boot:
  // the initial tree load and navigation wiring run in a later file (90-sync),
  // so an uncaught error here blanks the whole app (that was the setInd bug).
  // Contain it — a broken layout widget is survivable; a dead tree is not.
  try { applyToggles(); } catch (e) { console.error('[lattice] layout init failed', e); }
  // Settings > Editor writes the wrap default from its own document (the
  // Settings tab is a frame), and this window hears it as a storage event,
  // the same way 05-prefs.js hears the font
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === 'appWrap') try { applyToggles(); } catch {}
  });

  // The phone's old one-pane switcher and its full-screen mode are gone
  // (the drawers in 97-mobar.js replaced them). Their stored state goes too.
  try { localStorage.removeItem('appMv'); localStorage.removeItem('appFull'); } catch {}

  // ── pane resize: drag a boundary, double-click it to reset ───────────────
  // Widths live in CSS custom properties on #ws (see .psplit in the shell
  // css), in px. The left pane's handle measures from the ribbon's edge, so
  // the stored width is the pane's own.
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
    wire('ph1', 'tree', (x) => {
      panes.tree = Math.round(lim(x - $('ribbon').getBoundingClientRect().right, 130, 480));
    });
    wire('ph3', 'ctl', (x) => { panes.ctl = Math.round(lim(innerWidth - x, 190, 520)); });
  }

  // ── ?diag=1: a swipe readout for scroll bugs reported from phones ───────
  // On with ?diag=1, off with ?diag=0. The setting is kept, and an installed
  // PWA shares this storage with the browser, so turning it on in a Chrome
  // tab shows it in the app too. After each touch it names what scrolled and
  // by how much, and every scroller with room to move: a swipe latches to
  // the innermost one that can move, however little. Read-only, so it
  // cannot change the gesture it reports. Temporary: out once it has done
  // its job, like the last one.
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
      // the ship no longer has what this fetch is FOR (the staleness checks
      // above already ruled out "the user moved on" as the explanation), so
      // it was deleted elsewhere. Pages only: memories are meant to come
      // back on the next save (know-save's own doc calls re-saving a
      // deleted key a restore), so an autosave recreating one there is by
      // design, not this bug. A page has no such route. Keep the buffer,
      // never destroy what was typed, but stop autosave from writing it
      // back over the delete: it guards on `!current`, so clear that and
      // reopen the name field the way a brand-new page gets one.
      if (mode !== 'know') {
        const doomed = current;
        current = null;
        pname.readOnly = false;
        // the tree row and the page cache still remember this page from
        // before the delete. Left alone, the still-highlighted row (or a
        // wikilink, or a search hit) repaints the dead body from cache with
        // zero network calls, the exact resurrection this branch exists to
        // stop. Clear them the way the explicit delete path does (65-ctl.js).
        dropTreeNodes(doomed);
        pageCache.delete(doomed);
        snapTree();
        renderTree();
        resetPanels();
        st('this page was deleted elsewhere — save to recreate it', false);
      }
      return;
    }
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
      if (typeof d.comments === 'boolean') cmtShow(current, d.comments);
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
    // Files and Knowledge both stay painted in their tabs, so neither is
    // skipped for the other: the one the front document works on always
    // reloads, the other when its beacon moved since it loaded
    if (mode !== 'know' || !revFresh(treeAt)) loadTree();
    if (mode === 'know' || (knowLive() && !knowFresh(knowAt))) loadKnow();
    refreshOpen();
    // a catch-up call, not the primary path: the stream now wakes the badge
    // directly on its own /comments event (see commentBumped below). This
    // covers the tab that was HIDDEN while a comment landed, since the SSE
    // loop pauses entirely on document.hidden and only reconnects here, on
    // focus. Cheap either way: it counts, it does not render, and it is
    // skipped entirely while the pane is open.
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
  // comments never bump /rev (apply-comment stamps only /beacon/comments), so
  // a foreign comment used to reach the badge only by accident, on whatever
  // next refreshAll a focus or poll happened to trigger. Give it the same
  // debounced path bumped() gives /rev, straight to the badge check.
  let cmBeaconTimer = null;
  const commentBumped = () => {
    clearTimeout(cmBeaconTimer);
    cmBeaconTimer = setTimeout(() => {
      if ($('cmwrap') && $('cmwrap').hidden) refreshCommentBadge();
    }, 300);
  };
  let lastRev = '';
  try { lastRev = localStorage.latBeaconRev || ''; } catch {}
  const noteRev = (rev) => {
    if (!rev) return;
    lastRev = rev;
    try { localStorage.latBeaconRev = rev; } catch {}
  };
  // whether a listing fetched when the beacon stood at `at` is still the
  // ship's truth. Every write on the ship bumps /rev, so while a stream is
  // registered an unmoved rev means nothing changed. With the stream down
  // nothing moves lastRev at all, so nothing counts as fresh then.
  const revFresh = (at) => streamLive && !!at && at === lastRev;
  // memories have their own beacon, /beacon/know (a memory write never
  // bumps /rev), with the same bookkeeping
  let lastKnow = '';
  try { lastKnow = localStorage.latBeaconKnow || ''; } catch {}
  const noteKnow = (rev) => {
    if (!rev) return;
    lastKnow = rev;
    try { localStorage.latBeaconKnow = rev; } catch {}
  };
  const knowFresh = (at) => streamLive && !!at && at === lastKnow;
  // a load that spans pages and memories (ctrl-K) is fresh while neither moved
  const bothAt = () => lastRev + '|' + lastKnow;
  let dropStream = null;
  // consecutive attempts that failed. A stream that registers, then lives
  // a minute or carries a live bump, and then ends is the NORMAL cycle: the
  // keep closes itself after ~80s (measured against ~ricsul-bilwyt), so
  // every open editor reconnects about once a minute and must do so
  // promptly. A stream that registers and breaks sooner is a failure: a
  // saturated ricsul breaks streams mid-body ("invalid chunked response"),
  // and treating that as the normal cycle reconnected every 1.5 to 4.5 s
  // into the load, 179 times in one afternoon from one client.
  let fail = 0;
  const streamFail = (fail, registered, livedMs, bumpedLive) =>
    (registered && (livedMs >= 60000 || bumpedLive)) ? 0 : Math.min(fail + 1, 5);
  (async () => {
    for (;;) {
      // a HIDDEN editor holds no stream: vere is HTTP/1.1 and the browser
      // caps the origin at six connections, so parked tabs' never-ending
      // streams starved every live request (and tripped false offline mode
      // at six open tabs). The registration rev-compare on reconnect —
      // plus the visibilitychange refreshAll below — covers the gap.
      if (document.hidden) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      // did this attempt get as far as the ship's registration event, when,
      // and did it carry a live bump after it?
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
            // this keep streams the whole /beacon directory: events arrive
            // as "old /rev", "old /comments", "upd /rev", ... — the name
            // carries the grub's sub-path. /rev is the content beacon and
            // drives lastRev below; folding a comment bump into that same
            // bookkeeping corrupted lastRev and fired spurious refreshes, so
            // /comments gets its own path straight to commentBumped instead,
            // never touching lastRev. (Historical note: the pre-raw
            // EventSource listened for a literal 'upd' event, which never
            // existed — live refresh was ALWAYS the 30s poll.)
            // /know: a memory changed. A listing loaded into the Knowledge
            // tab (knowLive) refreshes. One never loaded only needs the moved
            // beacon, which marks it stale for when it is first shown.
            if (name.slice(-6) === ' /know') {
              if (name.slice(0, 3) === 'old') {
                echoes.know.n = 0;
                if (lastKnow && data && data !== lastKnow && knowLive()) bumped();
                noteKnow(data);
                continue;
              }
              noteKnow(data);
              if (echoes.know.n > 0) { echoes.know.n--; continue; }
              if (Date.now() < echoes.know.until) continue;
              if (knowLive()) bumped();
              continue;
            }
            if (name.slice(-5) !== ' /rev') {
              // registration ("old /comments") just reports the stamp as it
              // already stood, nothing to react to. A live bump is the
              // event worth waking the badge for.
              if (name.slice(-10) === ' /comments' && name.slice(0, 3) !== 'old') commentBumped();
              continue;
            }
            if (name.slice(0, 3) === 'old') {
              // registration. The stream is authoritative from HERE on;
              // a rev that moved since we last looked is a missed change.
              // Echoes still pending were emitted BEFORE this point and
              // will never arrive as upd — left counted, each would
              // swallow one real remote bump later.
              echoes.rev.n = 0;
              streamLive = true;
              registered = true;
              registeredAt = Date.now();
              if (lastRev && data && data !== lastRev) bumped();
              noteRev(data);
              continue;
            }
            // a live bump. Our own save bumps the beacon too: refetching
            // tree + source to learn what this client just wrote was ~4s
            // of pier time per save, so our own expected echoes are
            // consumed by count (see echoes, 20-state.js).
            bumpedLive = true;
            noteRev(data);
            if (echoes.rev.n > 0) { echoes.rev.n--; continue; }
            if (Date.now() < echoes.rev.until) continue;
            bumped();
          }
        }
      } catch {}
      // stream severed: pier restart or proxy hiccup. The rev comparison at
      // the NEXT registration covers whatever happens in this gap.
      //
      // An attempt that registered and lived (+streamFail above) is the keep
      // expiring on schedule, so go straight back and reset the count. Any
      // other attempt failed: never registered (ship down, proxy refusing,
      // 502) or broke soon after. Retrying that every 3s forever is how one
      // outage becomes a steady drum on a pier that is already struggling.
      // Double up to 30s.
      //
      // Jitter BOTH cases. A pier restart drops every client at the same
      // instant, and tabs opened together expire their keeps together, so a
      // fixed delay brings them all back on the same tick. Half to one and a
      // half of the delay spreads them out and costs nothing when it is one
      // tab. (Reconnect itself is cheap by design: registration replays the
      // current rev and the client does nothing unless it moved.)
      streamLive = false;
      fail = streamFail(fail, registered, registered ? Date.now() - registeredAt : 0, bumpedLive);
      const base = Math.min(3000 * (1 << Math.max(0, fail - 1)), 30000);
      const wait = Math.min(Math.round(base * (0.5 + Math.random())), 30000);
      await new Promise((r) => setTimeout(r, wait));
    }
  })();
  // coming back to the tab/window is the moment staleness shows. Catch it
  // directly. The 30s poll exists for a stream that is DOWN — while one is
  // registered it would have said so, and polling anyway cost one pier
  // request per open editor per 30s, forever (the same clock-vs-stream
  // trust the mount fixed in #160).
  //
  // Both events go through bumped()'s debounce: un-hiding a tab fires
  // visibilitychange AND focus, and refreshAll has no in-flight guard, so
  // each pair was two full tree-and-page refreshes. And while the stream
  // is live it has already reported any change, so a focus refresh is a
  // floor, not news: at most one per 30s, however often the window is
  // clicked back into. An un-hidden tab dropped its stream, so it is not
  // live and always refreshes.
  //
  // Except around our own writes. The stream can merge two quick bumps into
  // one event, so an echo count still owed after one of ours swallows the
  // next real bump: a page another device made right after our autosave
  // never appeared (ui-boot's "created during a save" case). Only our own
  // writes create that debt, so within 30s of one a focus always refreshes,
  // the floor that catches it.
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
  //  the poll covers a DOWN stream — but a hidden tab's stream is down on
  //  purpose, and polling for it would spend the pier request the parking
  //  just saved
  setInterval(() => { if (!streamLive && !document.hidden) refreshOpen(); }, 30000);

// ── src/95-know.js ────────────────────────────────────────────────────────
  // ── knowledge: <lat-know>, the memories and the editor's memory mode ────
  // The Knowledge tab lists the private memory store as a tree, filtered by
  // tag chips, with its own toolbar. `mode` is the editor's state for the
  // document tab in front (21-tabs.js): a memory tab sets it to 'know', so
  // read, edit, save, tag and delete go to the memory routes. Nothing else
  // switches it any more, and the listing never depends on it. (`mode`
  // itself is declared in 20-state.js, since the files tree reads it.)
  customElements.define('lat-know', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<aside class="tree" id="knowpane">
  <div class="ptool" role="toolbar" aria-label="Knowledge">
    ${sbtn('id="knew" data-action="knew"', 'plus', 'New memory')}
    ${sbtn('id="ktidy" data-action="ktidy"', 'tidy', 'Tidy memories')}
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
  // folded by default and remembered, like the other layout choices
  const tagSec = $('tagsec'), tagSum = $('tagsh');
  tagSec.open = localStorage.knowTagsOpen === '1';
  tagSec.addEventListener('toggle', () => { localStorage.knowTagsOpen = tagSec.open ? '1' : '0'; });

  // the memory beacon the last applied know-list was fetched at (knowFresh)
  let knowAt = '';
  async function loadKnow() {
    const gen = knowGen;
    const at = lastKnow;
    let d = null;
    // resolves either way, like loadTree: the drain and the mode switch both
    // call this without a .catch, and a rejection there would take the rest of
    // their work with it.
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
    // folded, the heading still says what the tree is filtered by, so a
    // hidden filter can never silently narrow it
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
  // one knowKeys entry by (normalized) key. Keys may carry a leading slash
  const knowEntry = (key) =>
    knowKeys.find((x) => x.key.replace(/^\//, '') === key);

  // false when the open failed and nothing was painted, so the tab model
  // (21-tabs.js) can tell a failure from an open a later one superseded
  async function openKnow(key) {
    // guardDirty covers a dirty grub, page, or memory in one place (see
    // 20-state.js): it flushes what it can and only asks when the flush
    // still leaves something unsaved.
    if (!(await guardDirty())) return false;
    // the same sequence openPage keeps: a later open of anything supersedes
    // this one, so a slow answer cannot paint a memory over the page (or
    // the other memory) opened after it
    const my = ++openSeq;
    if (mode !== 'know') setMode('know');
    // a queued edit outranks the ship's copy, same rule as pages
    const q = await offGet('know:' + key);
    let d = null;
    if (q) d = { body: q.body, tags: (knowEntry(key) || { tags: [] }).tags, updated: 'queued offline' };
    else {
      let r = null;
      try { r = await fetch(api + '/know-read?key=' + encodeURIComponent(key)); } catch {}
      if (my !== openSeq) return;
      if (!r || !r.ok) { st('open failed' + (r ? await errText(r) : ' — offline'), false); return false; }
      d = await r.json();
    }
    if (my !== openSeq) return;
    applyKnow(key, d);
    return true;
  }
  // paint a memory that is already in hand: openKnow's answer, or a tab's
  // own unsaved buffer coming back to the front (21-tabs.js)
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
    if (!r.ok) { st('tag failed' + await errText(r), false); return; }
    $('ktag').value = '';
    knowGen++;
    const k = knowEntry(current);
    if (k && !k.tags.includes(t)) k.tags.push(t);
    renderKnowTags(k ? k.tags : [t]);
    renderKnowChips();
  };

  const knowField = () => pname.value.trim().replace(/^\/+|\/+$/g, '');
  //  the editor still shows memory `key`: its own, or the new one the name
  //  field names (the rule save() keeps for a page create, 35-pages.js)
  const knowHere = (key) => mode === 'know' && !grubPath &&
    (current === key || (current === null && knowField() === key));
  // `create`: New memory writes the key before anything is typed, so an
  // empty body is sent as a newline (as a new page is) rather than refused
  async function saveKnow(create) {
    const key = knowField();
    if (!key) { st('key required', false); return; }
    if (!validName(key)) {
      st('bad key — lowercase letters, digits, and - . _ ~ (no spaces)', false);
      return;
    }
    if (!src.value && !create) { st('empty body', false); return; }
    if (viewingRev !== null) { st('viewing a revision — use restore', false); return; }
    // the pier serializes every write behind one shared `saving` flag, know
    // or page (see save()/autosave()/saveGrub()). Without this guard,
    // guardDirty's flush against a memory whose autosave was already mid-
    // flight fired a second, fully concurrent POST to the same /know-save key.
    //  queued for this memory: it runs only if the editor still shows it,
    //  and a create runs even on a clean buffer, as a page create does
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
    //  the editor may have moved during the round trip (a page opened, New
    //  memory again). Only the memory still shown takes the key and its
    //  tab, never whatever is in front now.
    const claim = () => {
      if (!knowHere(key)) return;
      current = key;
      tabFollow();             // a new memory's tab is named now (21-tabs.js)
      pname.readOnly = true;
      if (src.value === sent) dirty = false;
    };
    if (w.gone) {
      //  if the queue would not take it, it is NOT saved: leave the editor
      //  dirty and the key still editable, so the text under the cursor is not
      //  presented as stored. Same rule the page paths enforce (35-pages.js),
      //  and enqueueKnow has already said why it refused.
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
    if (!(await askConfirm('delete memory ' + current + '? (soft-delete, restorable)', 'delete'))) return;
    const doomed = current;
    const r = await mutate(api + '/know-delete?key=' + encodeURIComponent(doomed));
    if (!r.ok) { st('delete failed' + await errText(r), false); return; }
    // a delete reachable from inside a revision view (mode='know' skips the
    // viewingRev guard the pages path enforces) must not leave the editor
    // behind it read-only forever. Exit ONLY on success: exiting up front
    // left a declined confirm holding the old revision's body, editable and
    // uncued, one keystroke from autosaving history over the live memory.
    // An aborted delete keeps the revision view exactly as it was.
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

  // The editor's mode, set by what the front tab opens: openKnow and the
  // know tab kind to 'know', openPage and the page and grub kinds back to
  // 'pages'. Each of those has already passed guardDirty, so this does not
  // ask again. It resets the editor to a blank document of that mode; the
  // open that called it then paints its document.
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
    // both listings are always painted in their own tabs. Refetch the one
    // this mode works on only when the beacon says it moved (revFresh,
    // knowFresh in 90-sync.js), never to learn nothing.
    if (m === 'know') { if (!knowFresh(knowAt)) loadKnow(); }
    else if (!revFresh(treeAt)) loadTree();
    st(m === 'know' ? 'knowledge' : 'pages');
  }

  // ── the Knowledge tab: lazy listing ─────────────────────────────────────
  // Fetched the first time the tab is seen, and again when the memory
  // beacon has moved since (knowFresh). Memories are one request the editor
  // does not otherwise need, so a session that never looks never pays it.
  const knowShow = () => { if (!knowHave || !knowFresh(knowAt)) loadKnow(); };
  // whether the memory listing is worth keeping current: in memory mode, or
  // once it has been loaded and is sitting in its tab (90-sync.js, the drain)
  const knowLive = () => mode === 'know' || knowHave;
  document.addEventListener('lat-pane', (e) => {
    if (e.detail.side === 'l' && e.detail.id === 'know') knowShow();
  });
  if (paneShows('l', 'know')) knowShow();

  // ── toolbar ─────────────────────────────────────────────────────────────
  // New memory: the page create dialog, its kind fixed at md (a memory has
  // no other), then a fresh memory tab named with the key and written at
  // once, the way a new page is (newFile, 35-pages.js). The dialog comes
  // first, so a cancel leaves the front tab exactly as it was.
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
    // the key must be free, and the ship is the one to ask: knowKeys is
    // empty until the lazy list lands, or if it failed, and /know-save has
    // no create-only form, so a write here would put a newline over an
    // existing memory. A key that exists opens instead; a check that cannot
    // complete creates nothing.
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
  // Tidy: the memory review (/know?lint=1) as a tool tab (24-tools.js)
  $('ktidy').onclick = () => toolOpen('frame:/apps/lattice/know?lint=1');
  // Trash: the soft-deleted memories (GET /know-trash), each with Restore
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
  // Naming the new page is the same dialog everywhere (newFile, 35-pages.js).
  //
  // The flag is set by the desktop build that HAS the menu (commands.rs, an
  // initialization_script), not inferred from __TAURI__. This UI ships from
  // the ship and the menu ships in the binary, so they update independently:
  // testing for the desktop alone would hide these on an older build with no
  // menubar behind them and make every one of these commands unreachable.
  //
  // (The window's light/dark, set_theme, is ui-app/theme.js's job: a theme
  // can force it, and the reader pages need it too.)
  if (window.__TAURI__ && window.__LATTICE_FILE_MENU__) {
    for (const id of ['newfile', 'newfolder', 'newtmpl', 'upfiles', 'updir', 'save']) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    // The create and upload group is now empty, and an empty flex row still
    // draws its gap: a blank band in the toolbar that reads as a rendering
    // fault. Hide a group only when everything in it went, so one that keeps
    // a button (a later one added to it) still shows.
    for (const row of document.querySelectorAll('#tree .newbtns')) {
      if ([...row.children].every((c) => c.hidden)) row.hidden = true;
    }
    // The palette indexes every action, so these stay listed, homed in the
    // File menu. A hidden button would drop them (palUsable), and running
    // one clicks it, which is exactly what the menu item does.
    for (const a of ACTIONS) {
      if (!['newfile', 'newfolder', 'newtmpl', 'upfiles', 'updir'].includes(a.id)) continue;
      a.home = 'File menu';
      a.when = () => true;
    }
  }

// ── src/97-mobar.js ───────────────────────────────────────────────────────
  // ── phone: drawers and the bottom bar ────────────────────────────────────
  // At phone width (the 820px block) the side panes are drawers over the
  // document. Every way into a pane opens its drawer (paneOpen, 13-frame.js:
  // the corner toggles, a pane tab's action, search), and so does a swipe in
  // from that edge. The scrim, Escape or opening a document shuts them. The
  // ribbon rides at the top of the left drawer by CSS alone, so its buttons
  // stay the one set they are.
  //
  // The bottom bar holds what a thumb reaches for most: a new page, search,
  // today's brief and the open tabs. Like the drawers it is built always and
  // shown only by the 820px block, so a resize across the breakpoint just
  // works, with no load-time isMobile branching to go stale.
  {
    const drawn = () => ws.classList.contains('ldraw') || ws.classList.contains('rdraw');
    const scrim = document.createElement('div');
    scrim.id = 'scrim';
    scrim.onclick = drawersClose;
    ws.append(scrim);
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawn()) drawersClose(); });
    // across the breakpoint the drawers start shut, and the corner toggles
    // repaint for the layout that is now showing
    matchMedia('(max-width: 820px)').addEventListener('change', drawersClose);

    // the edge swipe: it starts within EDGE px of a screen edge and travels
    // EDGE px inward, more across than down. Never while text in the editor
    // is selected, where dragging a handle to the edge means the selection,
    // and never from the tab strip, where a sideways drag scrolls the tabs.
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

    // the open-tabs sheet: one row per tab, the tab in front marked. A row
    // switches to its tab; its x closes it, asking first as the strip's does.
    const sheet = document.createElement('div');
    sheet.id = 'mtsheet';
    sheet.className = 'mtsheet';
    sheet.setAttribute('role', 'menu');
    sheet.setAttribute('aria-label', 'Open tabs');
    sheet.hidden = true;
    const sheetPaint = () => {
      sheet.textContent = '';
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

    // the bottom bar. Each button is its own home in the palette, listed
    // only while the bar is on screen.
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
    // the Files toolbar's new page does the same: newFile paints over the
    // editor, so what is unsaved there goes through guardDirty first
    mitem('mb-new', 'plus', 'New page', async () => { if (await guardDirty()) newFile(''); });
    mitem('mb-search', 'search', 'Search', () => qOpen());
    mitem('mb-brief', 'cal', "Today's brief", (ev) => openBrief(ev));
    const tabsw = mitem('mtabsw', 'tabs', 'Open tabs', () => {
      if (sheet.hidden) sheetPaint();
      sheet.hidden = !sheet.hidden;
    });
    ws.append(mbar, sheet);
    // tapping anywhere else puts the sheet away
    document.addEventListener('click', (e) => {
      if (!sheet.hidden && !sheet.contains(e.target) && !tabsw.contains(e.target)) sheet.hidden = true;
    });
    // the button carries the tab count, read off the strip it summarises
    const count = () => { tabsw.dataset.n = String(tabs.length); };
    count();
    new MutationObserver(count).observe(tabList, { childList: true });

    // the unread badge lives on the ribbon's inbox, which a phone shows
    // only with the left drawer open; mirror it onto that drawer's toggle
    const mirror = () => {
      const n = $('rb-inbox').dataset.n;
      if (n) $('treet').dataset.n = n; else delete $('treet').dataset.n;
    };
    mirror();
    new MutationObserver(mirror).observe($('rb-inbox'), { attributes: true, attributeFilter: ['data-n'] });
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
        if (knowLive()) loadKnow();
        st('legacy import completed');
        return;
      }
      // 504/502 is the reverse proxy giving up, not the ship failing. The
      // import keeps running server-side and is usually PARTLY done. Say what
      // landed, and name the cause, because the fix is a proxy setting.
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
    // only latch when the SERVER says it finished. A partial run deliberately
    // leaves its marker unwritten so the offer returns and can be retried
    if (res.complete) localStorage.latLegacy = 'done';
    else delete sessionStorage.latLegacyAsked;
    knowGen++;
    st('imported ' + res.imported + ' memories from the old agent');
    // the import can bring pages too, so Files refreshes as it always did
    if (knowLive()) loadKnow();
    loadTree();
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
  // `name` is the page the front tab names, null for a new page. Only a
  // `fresh` tab list (nothing saved, so a first run or a corrupt one) may
  // resume the snapshot without a name: a restored new-page tab is a new page.
  function bootSnap(name, fresh) {
    let p = null;
    try { p = JSON.parse(localStorage.appPage || 'null'); } catch {}
    if (!p || !p.name) return false;
    // No name means a bare launch, above all the PWA, whose start_url can
    // never carry one. Resume the snapshot page instead of landing on an
    // empty editor. "opens where I left off" is what an installed app means.
    // A name that does not match the snapshot still defers to the network.
    if (name ? p.name !== name : !fresh) return false;
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
  // The tabs come back first (21-tabs.js) and boot shows the front one. A
  // page has the snapshot-first path below; every other kind shows through
  // the tab model, with the tree and the panels loading beside it.
  const { tab: bootTab, fresh: bootFresh } = tabsBoot();
  if (bootTab.kind !== 'page') {
    loadTree().then(() => { legacyCheck(); loadPanels(); });
    tabShowBoot(bootTab);
  } else {
    // a folder in the address (?into=, a reload while one was selected)
    // outranks the tab's page, as it did before tabs
    const into = qs.get('into');
    const name = into && !qs.get('name') ? null : bootTab.key || null;
    const painted = bootSnap(name, bootFresh && !into);
    bootTree();
    // what the snapshot painted, if anything. The baseline for "did the USER
    // do something while the dump was in flight?"
    const bootCurrent = current;
    // and what the name field said: a new page named in the dialog has no
    // `current` until its create lands, but it is the user's all the same
    const bootShown = pname.value;
    loadTree().then(() => {
      // The tree paints from localStorage at 0ms, so it is clickable long
      // before this resolves. Anything boot does by default would then land on
      // top of the user's own action, opening a page and having it close a
      // second later, which is exactly what the trailing newFile('') did.
      // Compare against bootCurrent, not against null. A snapshot-painted page
      // is not a user action and still wants its refreshOpen reconcile.
      // everTyped, not dirty. A keystroke followed by an autosave clears dirty
      // before a slow dump lands, and this branch then repainted the editor
      // from the dump's PRE-edit copy. Typing is a user action whether or not
      // it has since been saved. Going to another tab is a user action too.
      const touched = current !== bootCurrent || curFolder !== null || dirty || everTyped
        || activeTab !== bootTab || pname.value !== bootShown;
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
