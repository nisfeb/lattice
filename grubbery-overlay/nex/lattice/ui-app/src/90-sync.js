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
