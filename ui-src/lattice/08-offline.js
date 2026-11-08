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
  // This window, for the ship (?by=, so the history prune never folds one
  // window's revision into another's) and for the queue: a queued record
  // names the window that queued it, and carries a sequence number from
  // this window's own counter. Order and identity come from those, never
  // from the wall clock, which can step back.
  const winId = Math.random().toString(36).slice(2, 10);
  let offSeqN = 0;
  const offSeq = () => ++offSeqN;
  const qStamp = () => { const n = offSeq(); return { id: winId + '-' + n, win: winId, seq: n }; };
  // the most one save sends. A proxy in front of the ship may refuse less
  // (a 413); this is the line past which the client refuses up front.
  const SAVE_MAX = 25 * 1024 * 1024;
  const bodyBytes = (b) => {
    const t = String(b || '');
    return t.length * 3 < SAVE_MAX ? t.length : new TextEncoder().encode(t).length;
  };
  const tooBig = (b) => bodyBytes(b) > SAVE_MAX;
  const TOO_BIG = 'NOT saved: this page is over the 25 MB one save can send. Split it into '
    + 'smaller pages, or copy the text somewhere safe.';
  let offCount = 0;          // queued page edits, drives the status text
  let offbadge = null;       // assigned by <lat-statusbar> (13-frame.js)
  // a whole-tree job (a folder share or delete) holds the writer, and a save
  // made meanwhile waits for it past its timeout. That is not offline: the
  // save lands when the job ends, so the queue holds it and says so.
  let jobWait = false;
  const JOB_NOTE = 'a folder job is running, your save will land when it finishes';
  const NOT_SAVED = 'NOT SAVED — this device cannot store offline edits. Copy your text '
    + 'somewhere safe before closing this page.';
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
  //  A replay sent q, and q landed. The queue is keyed by name, so a newer
  //  edit of the same page queued while q flew (a live save that timed out
  //  behind the replay) sits under the same key: deleting by name dropped
  //  it. Only the exact record sent goes. A newer one is kept, and the
  //  drain runs again for it.
  const sameRec = (a, b) => (a.id || b.id ? a.id === b.id : a.queuedAt === b.queuedAt && a.body === b.body);
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
    //  the create it rode on has landed, so the newer text is a plain edit
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
  //  delete `q.name` only while the stored record is still q, in one
  //  transaction
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
  // it leaves the queue only when the ship refuses it in a way a retry
  // cannot fix (a bad request, a missing target, a conflict, a body too
  // large), and then only once its body is kept elsewhere (keepSafe).
  // Anything else keeps it queued. That covers no response, any 5xx, an
  // expired login (401, 403), a timeout (408) and rate limiting (429).
  const REPLAY_DROP = [400, 404, 409, 410, 413, 422];
  const replayDrop = (r) => !!r && REPLAY_DROP.includes(r.status);

  // the job the writer is in the middle of, null when none (GET /tree-job).
  // Asked only after a save timed out, so an unreachable ship costs 5s more.
  const treeJob = async () => {
    try {
      const r = await tfetch(api + '/tree-job', {}, 5000);
      if (r && r.ok) return (await r.json()).job || null;
    } catch {}
    return null;
  };
  // a save timed out behind a job: hold the queue (not degraded, the ship is
  // answering) and send it once the job is over
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
  // after a failed save: the ship is away, said at once, unless a job is
  // already known to hold the writer. The first failure asks /tree-job in
  // the background and turns "offline" into the job's note when one runs;
  // once degraded, nothing is asked. -> whether a job is known
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
  // a whole-tree job the ship gave up on (a resume that kept failing) is
  // said once, a while after boot: a folder delete dropped part way leaves
  // some of its pages published, and nothing else would show it
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
  // a save of `name` sent at `at` landed: a queued edit of it from before
  // then is older text, and replayed it would overwrite the newer save
  //  Only a record THIS window queued, from before the save (its sequence
  //  number below `seq`), and only that exact record: another window's
  //  queued edit is that window's text, which this save never saw.
  async function dropQueued(name, seq) {
    let q = null;
    try { q = await offGet(name); } catch {}
    if (q && !q.isNew && q.win === winId && q.seq < seq) await offDone(q);
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

  // queue one page's edit and make it the visible truth everywhere a read
  // could come from: the render cache, the tree dump body, the boot snapshot.
  // Returns whether the edit is actually safe. The old version returned
  // nothing and said "saved offline" unconditionally, including when the
  // queue write had silently failed, which is the worst thing this file can
  // do: the editor then cleared its dirty flag and the work was gone with the
  // UI reporting success. If the queue cannot take it, say so and say it in
  // the words that matter, because there is nowhere else the edit now lives.
  //  `rev`: the revision the edit was made on, when it is not the open
  //  page's (a parked tab's, saveParked in 35-pages.js)
  async function enqueueSave(name, kind, body, isNew, rn, rev = curRev) {
    // the queue coalesces by name, and the 2s autosave calls this WITHOUT
    // the create flag — overwriting a queued create as a plain edit would
    // route the replay around the 409 create protection and let an offline
    // "new page" clobber one made online meanwhile. Once a create, always
    // a create, until it drains. The display name rides with the create
    // the same way.
    let prev = null;
    try { prev = await offGet(name); } catch {}
    //  behind a job the timed-out writes still land, so a base would only
    //  flag our own text as a conflict: no base claim, as a live save
    //  so does a replay: the editor's rev is from before the replayed text
    if (tooBig(body)) { st(TOO_BIG, false); return false; }
    const queued = await offPut({ name, kind, body, baseRev: jobWait || replaying ? 0 : rev || 0,
      isNew: !!isNew || !!(prev && prev.isNew), queuedAt: Date.now(), ...qStamp(),
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
    // truthy either way: 'job' tells the editor which words to show
    return job ? 'job' : true;
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
  //  The rewrite page-move makes in each page it moves (+rewrite-root in
  //  app.hoon, then +rewrite-wikilinks in lattice-md), for a queued save
  //  rebased onto the move: without it the replay put the old links back.
  //  A path literal /from at path boundaries, then [[from followed by
  //  nothing, ], / or |.
  function rwRoot(hay, from, to) {
    let out = '', bef = null;
    for (;;) {
      const i = hay.indexOf(from);
      if (i < 0) return out + hay;
      const pre = hay.slice(0, i), aft = hay.slice(i + from.length);
      const bnd = !aft || aft[0] <= ' ' || '/)([]",'.includes(aft[0]);
      const pc = pre ? pre[pre.length - 1] : bef;
      const seg = pre + (bnd && (pc === null || pc <= ' ' || '([",'.includes(pc)) ? to : from);
      out += seg;
      if (seg) bef = seg[seg.length - 1];
      hay = aft;
    }
  }
  function rwWiki(hay, from, to) {
    const ndl = '[[' + from;
    let out = '';
    for (;;) {
      const i = hay.indexOf(ndl);
      if (i < 0) return out + hay;
      const nx = hay[i + ndl.length];
      out += hay.slice(0, i) + (nx === undefined || ']/|'.includes(nx) ? '[[' + to : ndl);
      hay = hay.slice(i + ndl.length);
    }
  }
  const moveBody = (b, from, to) => (from ? rwWiki(rwRoot(b, '/' + from, '/' + to), from, to) : b);
  async function enqueueOp(rec) {
    const stamp = qStamp();
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
          //  the body gets the move's link rewrite, and names the move it
          //  rides on (`via`): it waits for that move, and is kept aside
          //  rather than written at the new name if the move is refused
          await offPut({ ...q, name: rec.to + q.name.slice(rec.from.length), baseRev: 0,
            body: moveBody(q.body || '', rec.from, rec.to), via: stamp.id, from: q.name });
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
    await opPut({ ...rec, queuedAt: Date.now(), ...stamp });
    setDegraded(true);
    st(({ del: 'deleted', mkdir: 'folder created' }[rec.op] || 'moved')
      + ' offline — ' + offCount + ' waiting to sync');
  }

  // know memories share the queue under a 'know:' prefix. Page names cannot
  // contain a colon, so the two namespaces cannot collide in the one store.
  // No baseRev: memories are last-write-wins (no CAS, no conflicts/ pages),
  // matching what know-save itself does.
  async function enqueueKnow(key, body) {
    const queued = await offPut({ name: 'know:' + key, kind: 'know', body, queuedAt: Date.now(), ...qStamp() });
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
    //  not while a job holds the writer: the replay would only queue behind
    //  it, after the writes it timed out on (waitJob replays once it ends)
    if (replaying || jobWait) return;
    replaying = true;
    srcFlight.clear();    // replayed writes: no open read from before is shared
    sensForget();         // and a replayed move or delete culls flags
    offKept = false;
    //  one drain across every window of this origin: two windows share the
    //  one queue, and two drains at once sent the same records twice, the
    //  second claiming a base the first had moved past (a made-up conflict)
    const drain = () => drainQueue(proven);
    try {
      if (navigator.locks) await navigator.locks.request('lat-drain', { ifAvailable: true }, (l) => (l ? drain() : null));
      else await drain();
    } finally { replaying = false; }
    //  a newer edit outlived its replayed older copy: send it now
    if (offKept && !degraded) setTimeout(() => replayQueue(true), 0);
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

  // ── refused, stuck and kept records ─────────────────────────────────────
  // A queued record is the user's only copy, so no refusal deletes it
  // unkept. A body the ship refuses (a 409 or any of 400, 404, 410, 422) is
  // written as a page of its own under conflicts/, under a name never used
  // before. One too large to send (413, or past SAVE_MAX before sending),
  // or one even that copy is refused for, goes to this device's recovery
  // store, and the bar above the editor offers it back. A record the ship
  // keeps answering with a 5xx is STUCK at the third try: it stays queued,
  // no longer holds up the rest, and the same bar offers to retry or clear.
  //  the ship's conflict-name flattening (lattice-pg), injective: a/b and
  //  a-b keep different copies
  const cfEnc = (n) => n.replace(/~/g, '~~').replace(/-/g, '~d').replace(/\//g, '-');
  const keptName = (tag, name) => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return 'conflicts/' + tag + '-' + cfEnc(name) + '-' + d.getFullYear() + p(d.getMonth() + 1)
      + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  };
  //  the body as a page of its own at `base`, or the first free -2, -3:
  //  a create, so no kept copy is ever written over. -> its name, false
  //  when the ship did not answer, null when it refused
  const keepAside = async (q, base) => {
    for (let i = 1; i < 30; i++) {
      const alt = base + (i > 1 ? '-' + i : '');
      let r = null;
      try {
        r = await tfetch(api + '/page-save?name=' + encodeURIComponent(alt) + '&type='
          + (q.kind === 'know' ? 'md' : q.kind) + '&new=1', { method: 'POST', body: q.body || '\n' }, 20000);
      } catch {}
      if (r && r.ok) return alt;
      if (shipGone(r)) return false;
      if (r.status !== 409) return null;
    }
    return null;
  };
  const RECOVER = 'recover:';
  const recoverPut = async (q, why) => {
    const s = await idbStore('kv', 'readwrite');
    if (!s) return false;
    try {
      return await offOk(s.put({ k: RECOVER + (q.id || q.name + '@' + q.queuedAt),
        v: { name: q.name, kind: q.kind, body: q.body || '', why, at: Date.now() } }));
    } catch { return false; }
  };
  const recoverAll = async () => {
    const s = await idbStore('kv', 'readonly');
    const all = (s && await offReq(s.getAll())) || [];
    return all.filter((r) => typeof r.k === 'string' && r.k.startsWith(RECOVER));
  };
  //  a refused body kept somewhere. true once it is, and the record may
  //  go; false leaves it queued and stops the drain
  async function keepSafe(q, why, tag, conflicts) {
    if (why !== 413 && !tooBig(q.body)) {
      const alt = await keepAside(q, keptName('offline-' + tag, q.name));
      if (alt === false) return false;
      if (alt) {
        conflicts.push(alt);
        st('offline ' + tag + ' refused (' + why + '): ' + q.name + ', your version is kept at ' + alt, false);
        return true;
      }
    }
    if (!await recoverPut(q, why)) return false;
    st('offline ' + tag + ' of ' + q.name + ' could not be sent (' + (why === 413 ? 'too large' : why)
      + '). It is kept on this device, in the bar above the editor', false);
    stuckRender();
    return true;
  }
  const stuckTries = new Map();     // record id -> 5xx answers this session
  const stuckRec = new Map();       // record id -> the record, once stuck
  const recId = (q) => (q.op && q._k !== undefined ? 'op' + q._k : q.id || q.name + '@' + q.queuedAt);
  const isStuck = (q) => stuckRec.has(recId(q));
  //  a 5xx, counted: -> true when that made it stuck
  function failTry(q) {
    const k = recId(q), n = (stuckTries.get(k) || 0) + 1;
    stuckTries.set(k, n);
    if (n < 3) return false;
    stuckRec.set(k, q);
    stuckRender();
    return true;
  }
  const stuckBar = document.createElement('div');
  stuckBar.className = 'lnkcf';
  stuckBar.id = 'qstuck';
  stuckBar.hidden = true;
  stuckBar.setAttribute('role', 'alert');
  const stuckRow = (text, btns) => {
    const row = document.createElement('div');
    row.textContent = text;
    for (const [label, fn] of btns) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.onclick = fn;
      row.append(' ', b);
    }
    stuckBar.append(row);
  };
  async function stuckRender() {
    const d = $('docarea');
    if (d && !stuckBar.isConnected) d.before(stuckBar);
    const recs = await recoverAll();
    stuckBar.textContent = '';
    for (const [k, q] of stuckRec) {
      stuckRow('stuck in the queue: ' + (q.op ? q.op + ' ' + (q.name || q.from) : 'save of ' + q.name), [
        ['Retry', () => { stuckRec.delete(k); stuckTries.delete(k); stuckRender(); replayQueue(true); }],
        //  a save's text goes to this device's store first: clearing drops
        //  the queue's copy, never the only one
        ['Clear', async () => {
          if (!q.op && !await recoverPut(q, 'cleared')) { st('could not keep a copy, so nothing was cleared', false); return; }
          if (q.op) await opDel(q._k); else await offDone(q);
          stuckRec.delete(k);
          stuckRender();
        }]]);
    }
    for (const r of recs) {
      stuckRow('kept on this device, not on the ship: ' + r.v.name + ' (' + r.v.why + ')', [
        ['Download', () => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([r.v.body], { type: 'text/plain' }));
          a.download = r.v.name.replace(/[/:]/g, '-') + '.' + (r.v.kind === 'know' ? 'md' : r.v.kind || 'txt');
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }],
        ['Discard', async () => {
          if (!(await askDanger('Discard the kept copy of ' + r.v.name + '? It is not on the ship.', 'discard'))) return;
          const s = await idbStore('kv', 'readwrite');
          if (s) await offReq(s.delete(r.k));
          stuckRender();
        }]]);
    }
    stuckBar.hidden = !stuckBar.childNodes.length;
  }
  setTimeout(stuckRender, 0);
  //  what to do with a write the ship answered `r`: 'ok', 'refused' (keep
  //  it aside), 'skip' (stuck, pass it by) or 'stop' (the ship is away, or
  //  a retry may yet land: the drain ends and the rest stays queued)
  const verdict = (q, r) => (r && r.ok ? 'ok' : replayDrop(r) ? 'refused'
    : r && !shipGone(r) && r.status >= 500 && failTry(q) ? 'skip' : 'stop');

  // Structural ops go FIRST, in the order they were made. Their effect on
  // the pending saves was already applied when they were queued, so a save
  // landing afterwards is always a save the user still wants, under the name
  // they want it under.
  //
  // An op the ship REJECTS (see replayDrop) is dropped, not retried. It
  // means the intent was already satisfied some other way: deleting a page
  // that only ever existed in this queue, or moving one whose source the
  // queue never sent. No content lives in an op, but a refused MOVE has
  // saves riding on it (`via`, enqueueOp): those are kept aside, never
  // written at a name the move did not make. One the ship keeps failing on
  // is stuck and passed by; anything else keeps it queued and stops.
  async function drainOps(ops, saves, conflicts) {
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
      const v = verdict(o, r);
      if (v === 'skip') continue;
      if (v === 'stop') return false;
      if (v === 'refused') {
        st('offline ' + o.op + ' no longer applies: ' + (o.name || o.from) + ' (skipped)', false);
        for (const q of saves) {
          if (!o.id || q.via !== o.id) continue;
          if (!await keepSafe({ ...q, name: q.from || q.name }, r.status, 'edit', conflicts)) return false;
          await offDone(q);
        }
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
      if (tooBig(q.body)) one = { status: 413 };
      else {
        try {
          one = await tfetch(api + '/page-save?name=' + encodeURIComponent(q.name) +
            '&type=' + q.kind + '&new=1' + dnameQ(q),
            { method: 'POST', body: q.body || '\n' }, 20000);
        } catch {}
      }
      const v = verdict(q, one);
      if (v === 'skip') continue;
      if (v === 'stop') return false;
      // 409: the name is taken on the ship. The 409 may be OUR OWN earlier
      // attempt: tfetch's abort stops the wait, not the write, so a
      // timed-out create can land ship-side and 409 its own replay. Only a
      // body other than ours there is a collision, kept aside like any
      // other refusal. Overwriting is the one thing a create must never do.
      if (v === 'refused' && one.status === 409) {
        try {
          const sr = await tfetch(api + '/page-source?name=' +
            encodeURIComponent(q.name), {}, 20000);
          if (sr && sr.ok && ((await sr.json()).body || '') === (q.body || '\n')) {
            await offDone(q);
            continue;
          }
        } catch {}
      }
      if (v === 'refused' && !await keepSafe(q, one.status, 'create', conflicts)) return false;
      await offDone(q);
    }
    return true;
  }

  // Drain through page-save-batch, in parts of at most 50 records and
  // BATCH_MAX bytes, so one request never carries more than a proxy in
  // front of the ship takes. The batch is all-or-nothing, right for
  // uploads, wrong for replay: a rejected part falls back to per-item
  // saves so a bad record is isolated and kept aside (review gap 3).
  const BATCH_MAX = 4 * 1024 * 1024;
  async function drainEdits(edits, conflicts) {
    const parts = [];
    let cur = [], bytes = 0;
    for (const q of edits) {
      const b = bodyBytes(q.body);
      if (cur.length && (cur.length >= 50 || bytes + b > BATCH_MAX)) { parts.push(cur); cur = []; bytes = 0; }
      cur.push(q);
      bytes += b;
    }
    if (cur.length) parts.push(cur);
    for (const part of parts) {
      let r = null;
      //  a part of one record too large to send is that record's 413
      if (part.length > 1 || !tooBig(part[0].body)) {
        try {
          r = await tfetch(api + '/page-save-batch?report=1', {
            method: 'POST',
            body: JSON.stringify(part.map((q) =>
              ({ name: q.name, type: q.kind, body: q.body || '\n', base: q.baseRev || 0 }))),
          }, 120000);
        } catch {}
      } else r = { status: 413 };
      if (r && r.ok) {
        // per-item verdicts: an edit whose base the ship moved past still
        // APPLIED (it is the newest revision), but the overwritten revision
        // is named so it can be recovered from history. Apply-and-flag,
        // never silently drop either side
        try {
          for (const it of ((await r.json()).items || []))
            if (it.conflicted) conflicts.push(it.kept || it.name);
        } catch {}
        for (const q of part) await offDone(q);
        continue;
      }
      //  a 5xx from the batch may be one poisoned record, so retry per item
      //  to isolate it. No response, an outage, a lapsed login or a rate
      //  limit would fail the same way per item, so stop and keep them all.
      if (!(r && !shipGone(r) && (r.status >= 500 || replayDrop(r)))) return false;
      for (const q of part) {
        let one = null;
        if (tooBig(q.body)) one = { status: 413 };
        else {
          try {
            one = await tfetch(api + '/page-save?name=' + encodeURIComponent(q.name) +
              '&type=' + q.kind + '&base=' + (q.baseRev || 0) + '&by=' + (q.win || winId),
              { method: 'POST', body: q.body || '\n' }, 20000);
          } catch {}
        }
        const v = verdict(q, one);
        if (v === 'skip') continue;
        if (v === 'stop') return false;
        if (v === 'ok') {
          try {
            const j = await one.json();
            if (j.conflicted) conflicts.push(j.kept || q.name);
          } catch {}
        // refused as stale or as nothing-goes-there (a link's host moved
        // on, a link where a page was), or as a bad or too large body: the
        // body is the user's only copy, so it is kept first
        } else if (!await keepSafe(q, one.status, 'edit', conflicts)) return false;
        await offDone(q);
      }
    }
    return true;
  }

  // memories drain per-item. There is no know batch route, and last-write-
  // wins means a plain re-save with no verdict to collect
  async function drainKnows(knows, conflicts) {
    for (const q of knows) {
      let one = null;
      if (tooBig(q.body)) one = { status: 413 };
      else {
        try {
          one = await tfetch(api + '/know-save?key=' + encodeURIComponent(q.name.slice(5)),
            { method: 'POST', body: q.body || '\n' }, 20000);
        } catch {}
      }
      const v = verdict(q, one);
      if (v === 'skip') continue;
      if (v === 'stop') return false;
      if (v === 'refused' && !await keepSafe(q, one.status, 'memory', conflicts)) return false;
      await offDone(q);
    }
    return true;
  }

  async function drainQueue(proven) {
    const ops = (await opAll()).filter((o) => !isStuck(o));
    const first = (await offAll()).filter((q) => !isStuck(q));
    if (!first.length && !ops.length) return;
    // a proven-live caller already has a round-trip that answered, so the
    // ship being gone is disproved before the first phase even runs. Clear
    // the badge now instead of leaving it amber for a drain that is, by
    // then, just bookkeeping.
    if (proven && degraded) { degraded = false; renderOffline(); }
    const total = first.length + ops.length;
    stWork('syncing ' + total + ' offline edit' + (total === 1 ? '' : 's') + '…');
    const conflicts = [];
    //  ORDER IS THE CONTRACT: ops, then creates, then edits, then memories.
    //  && short-circuits, so the first phase that loses the ship stops the
    //  drain and leaves the rest of the queue untouched for the next replay.
    //  The saves are read again after the ops: a refused move kept some
    //  aside, and a save riding on a move still queued (stuck) waits for it.
    let knows = [];
    const saves = async () => {
      const wait = new Set((await opAll()).map((o) => o.id).filter(Boolean));
      return (await offAll()).filter((q) => !isStuck(q) && !(q.via && wait.has(q.via)));
    };
    const landed = await drainOps(ops, first, conflicts)
      && await (async () => {
        const whole = await saves();
        const all = whole.filter((q) => q.kind !== 'know');
        knows = whole.filter((q) => q.kind === 'know');
        return await drainCreates(all.filter((q) => q.isNew), conflicts)
          && await drainEdits(all.filter((q) => !q.isNew), conflicts)
          && await drainKnows(knows, conflicts);
      })();
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
