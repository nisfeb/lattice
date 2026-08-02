  // ── state ────────────────────────────────────────────────────────────────
  let current = null;      // name of the open page, null = unsaved new page
  let dirty = false;       // unsaved local edits — auto-refresh never clobbers them
  let viewingRev = null;   // non-null: a read-only historical revision is shown
  let curKind = null;      // the OPEN page's server kind; 'index' has no select
                           // option, so pkind.value would silently convert it
  let curRev = 0;          // the open page's server revision (offline baseRev)
  let curFolder = null;    // selected folder path — right-pane ops target it
  let folderCtx = '';      // folder uploads land in (last into / open page's dir)
  let nodes = [];          // last page-tree
  let saving = false;      // a save round-trip is in flight — never overlap them:
  let savePending = false; // the pier serializes, so a second save just queues
                           // 3.7s of stale-body work behind the first
  let echoUntil = 0;       // our own save bumps the beacon; ignore that echo or
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
  // 30s poll). Bumped on every local mutation; stale responses are dropped.
  let treeGen = 0, knowGen = 0;
  // persistTree: save the tree WITHOUT bumping the generation. The counter
  // exists so a STRUCTURAL local patch (a page created, moved, deleted) is not
  // overwritten by a list fetch that was issued before it. A body-only update
  // changes no structure, so bumping for one just discards a legitimate
  // in-flight refresh — which silently lost pages created while an autosave
  // was in flight.
  const persistTree = () => {
    // IDB, not localStorage (phase 3): the tree carries every page BODY via
    // page-dump, so a growing vault was marching toward the ~5MB quota — and
    // stringifying the whole tree on every save was main-thread work paid at
    // the worst time. The structured clone goes straight in. The PAGE
    // snapshot (appPage) stays in localStorage on purpose: it is small and
    // synchronous, which is what keeps resume painting at 0ms.
    kvPut('tree', nodes);
  };
  // rendered page-source answers, by name. The tree dump already carries every
  // body, so this only adds what the dump lacks — `share` and the rendered
  // `html` — which makes re-opening a page cost ZERO requests instead of a
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

  // every client-initiated write bumps the change beacon; hold the echo window
  // open while the request is in flight (a folder move pokes the writer many
  // times) plus a short tail, so the SSE handler never refetches what this
  // client just did itself.
  async function mutate(url, opts) {
    // Phase 1 queues page SAVES only. Deletes, moves, shares, folders: their
    // ordering dependencies are where offline systems get genuinely hard, so
    // they refuse honestly instead of pretending (design doc, Phasing).
    if (degraded || offCount) {
      st('offline — edits are queued, but this change needs the ship', false);
      return { ok: false, status: 'offline', json: async () => ({ error: 'offline' }) };
    }
    echoUntil = Date.now() + 60000;
    try { return await fetch(url, opts || { method: 'POST' }); }
    finally { echoUntil = Date.now() + 4000; }
  }

  const collapsed = () => {
    try { return JSON.parse(localStorage.appColl || '[]'); } catch { return []; }
  };
  const setCollapsed = (c) => { localStorage.appColl = JSON.stringify(c); };
