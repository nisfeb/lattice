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
    try { return await fetch(url, opts || { method: 'POST' }); }
    finally { echoUntil = Date.now() + 4000; }
  }

  const collapsed = () => {
    try { return JSON.parse(localStorage.appColl || '[]'); } catch { return []; }
  };
  const setCollapsed = (c) => { localStorage.appColl = JSON.stringify(c); };
