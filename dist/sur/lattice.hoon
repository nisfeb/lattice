::  /sur/lattice - structures for %lattice
::
|%
+$  state-0
  $:  %0
      published=(map path @uvH)         ::  /lib path → content hash (sham)
      pending=(map @ta [=ship =path])    ::  eyre-id → in-flight remote fetch
  ==
::  state-1 adds subscriptions: a followed remote file and the last revision
::  seen, so the follow-loop keens `last+1` (pends until the next %grow).
+$  state-1
  $:  %1
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
  ==
::  state-2 adds `fetches`: in-flight walk-to-latest fetches. Remote scry has no
::  "latest" query, so a no-rev fetch keens rev 1,2,3… (recording the highest
::  resolved content) until the next rev pends; a behn timer (deadline) fires
::  when the walk stalls, and we answer with the best revision seen.
+$  state-2
  $:  %2
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
  ==
::  state-3 adds `manifest`: the hash of the last-grown discovery manifest (a
::  publication at a reserved spur listing this ship's files). Growing it only
::  when the file set changes lets a remote ship probe `urb://ship/<manifest>`
::  to discover whether the ship publishes — there's no other "does this ship
::  publish" query. 0 = never grown.
+$  state-3
  $:  %3
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
      manifest=@uvH
  ==
::  state-4 adds `home`: the hash of the last-grown home page, grown at the
::  *empty* spur. A remote `urb://~ship/` keens the empty spur, and nothing else
::  publishes there (files live at /index, /manifest, /shared/…), so without
::  this the home keen pends forever → "no response from peer". 0 = never grown.
+$  state-4
  $:  %4
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
      manifest=@uvH
      home=@uvH
  ==
::  state-5 adds `browse`: a single transient watch on the remote page the user
::  is currently viewing. After a no-rev fetch answers (best-so-far), we keep
::  keening upward from there and push each newer revision to /updates — so a
::  raced/stale first paint silently upgrades to the latest, and live edits
::  appear while viewing. `rev` is the highest rev pushed; the open keen is
::  rev+1. Replaced on each new browse, not persisted across upgrades.
+$  state-5
  $:  %5
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
      manifest=@uvH
      home=@uvH
      browse=(unit [=ship spur=path rev=@ud])
  ==
::  state-6 moves published CONTENT out of Clay /pub into agent state
::  (`content`: full /pub/<spur>/gmi path → gemtext body). Files committed to a
::  desk ARE that desk's distributable, so keeping pages in /pub meant
::  `|install`ing the agent from a publisher copied the publisher's pages onto
::  every installer. Agent state is per-ship and never part of a desk install,
::  so content no longer rides along. The %5→%6 migration pulls any existing
::  /pub into state and deletes it from the desk so the desk stops carrying it.
+$  state-6
  $:  %6
      content=(map path @t)
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
      manifest=@uvH
      home=@uvH
      browse=(unit [=ship spur=path rev=@ud])
  ==
::  state-7 adds a PRIVATE knowledge store for programmatic agents (via the
::  %mcp server). `know` is keyed by a path-like key (/projects/x/notes) → an
::  entry. It is NEVER grown/published — unlike `content`, it is not remotely
::  scryable, only readable by the owner (local on-peek / authenticated Eyre).
::  `trash` holds soft-deleted entries: agent deletes are recoverable (restore),
::  and permanent purge is not exposed to agents.
::  a reserved embedding slot for future semantic search. Vectors are computed
::  off-ship (Urbit can't embed) and only comparable within one [model dim].
+$  know-vector
  $:  model=@t
      dim=@ud
      vec=(list @rd)
  ==
::  historical entry shape (state-7) — kept so on-load can migrate it.
+$  know-entry-7
  $:  body=@t
      updated=@da
  ==
::  current entry: adds cross-cutting `tags` (LLM-assigned, normalized for matching)
::  and a reserved `vector` (unused for now — see state-8 / the knowledge index).
+$  know-entry
  $:  body=@t
      updated=@da
      tags=(set @t)
      vector=(unit know-vector)
  ==
::  programmatic knowledge actions (poked to lattice by on-ship agents/MCP):
::  save = create/overwrite (preserves existing tags); del = soft-delete
::  (recoverable); restore = undo; move = rename a live entry's key (preserving
::  body/tags/vector); tag/untag = add/remove a cross-cutting label.
::  Permanent purge is deliberately NOT here — agents can't destroy knowledge.
+$  know-action
  $%  [%save key=@t body=@t]
      [%del key=@t]
      [%restore key=@t]
      [%move from=@t to=@t]
      [%tag key=@t tag=@t]
      [%untag key=@t tag=@t]
  ==
::  programmatic catalog actions (poked to lattice by the LLM classifier via
::  MCP). The catalog's READS are HTTP endpoints (obelisk has no scry, so an
::  MCP thread can't query it), but a WRITE is a fire-and-forget poke an MCP
::  tool can drive:
::    classify — set category/cat-source/confidence on one of OUR rows,
::               identified by its urb:// url. Mirrors the HTTP
::               /catalog-classify endpoint exactly.
+$  catalog-action
  $%  [%classify url=@t category=@t cat-source=@t confidence=@rs]
  ==
+$  state-7
  $:  %7
      content=(map path @t)
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
      manifest=@uvH
      home=@uvH
      browse=(unit [=ship spur=path rev=@ud])
      know=(map path know-entry-7)
      trash=(map path know-entry-7)
  ==
::  state-8 adds tags (+ a reserved embedding) to knowledge entries, for the
::  index/explorer. Only the know/trash entry shape changes vs state-7.
+$  state-8
  $:  %8
      content=(map path @t)
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
      manifest=@uvH
      home=@uvH
      browse=(unit [=ship spur=path rev=@ud])
      know=(map path know-entry)
      trash=(map path know-entry)
  ==
::  state-9 adds `oquery` — the single in-flight obelisk query (the Explore pane's
::  urQL runner). obelisk has no scries, so a query is async: we hold the HTTP
::  request here (by eyre-id) while we poke obelisk and await its result %fact.
::  deadline = the armed behn timeout. Only one query runs at a time.
+$  state-9
  $:  %9
      content=(map path @t)
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
      manifest=@uvH
      home=@uvH
      browse=(unit [=ship spur=path rev=@ud])
      know=(map path know-entry)
      trash=(map path know-entry)
      oquery=(unit [eid=@ta deadline=@da])
  ==
::  state-10: the content catalog. Adds everything the crawler + classifier
::  need, in ONE state version — the catalog feature has never shipped, so a
::  released ship (state-9) migrates straight to here; there are no
::  intermediate catalog states in production. (During development the catalog
::  grew across states 10-13 as each step was tested on the fakes; those were
::  collapsed into this single state before release so production sees one
::  migration, not four.) The catalog ROWS (pages/headings/links/tags/manifests/
::  pending) live in %obelisk under the `catalog-*` tables (see /lib/catalog and
::  /docs/catalog.md); the fields here are the agent-driving state:
::    catalog-sweep    — next periodic manifest-sweep deadline (~ = none armed).
::    catalog-walks    — in-flight catalog walk-to-latest tree, keyed by a
::                       synthesized eyre-id (sham(now,publisher,spur)). A scan
::                       is a root /manifest walk that spawns per-page walks;
::                       wires /cat-walk/<eid> (keen) + /cat-wait/<eid> (behn).
::    sweep-queue      — publishers still to crawl this auto-sweep cycle. The
::                       sweep runs SEQUENTIALLY: start one publisher, advance
::                       only when its walk tree drains, so peak concurrency is
::                       one publisher's pages (<= manifest-max), not
::                       follows * manifest-max.
::    catalog-pubpaths — per-publisher cache of the current manifest path set.
::                       Drives manifest-diff deletion (next sweep diffs new vs
::                       stored, DELETEs vanished pages) and link is-internal
::                       (a /-rooted link is internal iff it's a page the
::                       publisher publishes). Bounded by follows * manifest-max.
+$  state-10
  $:  %10
      content=(map path @t)
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
      manifest=@uvH
      home=@uvH
      browse=(unit [=ship spur=path rev=@ud])
      know=(map path know-entry)
      trash=(map path know-entry)
      oquery=(unit [eid=@ta deadline=@da])
      catalog-sweep=(unit @da)
      catalog-walks=(map @ta catalog-walk)
      sweep-queue=(list @p)
      catalog-pubpaths=(map @p (set path))
  ==
::  where the private knowledge vault is read/written from. %state = the in-agent
::  know/trash maps (the only behavior through 0.6.x). %grubbery = the grubbery
::  %lattice nexus (post-cutover). The flag is the migration switch; at %state
::  the grubbery adapter is dead code and behavior is bit-identical to state-10.
+$  know-where  ?(%state %grubbery)
::  state-11: adds the know-where cutover flag. Everything else is byte-identical
::  to state-10; the know/trash maps stay populated through the soak (state-11)
::  and are only dropped in state-12, after grubbery proves itself.
+$  state-11
  $:  %11
      content=(map path @t)
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
      manifest=@uvH
      home=@uvH
      browse=(unit [=ship spur=path rev=@ud])
      know=(map path know-entry)
      trash=(map path know-entry)
      oquery=(unit [eid=@ta deadline=@da])
      catalog-sweep=(unit @da)
      catalog-walks=(map @ta catalog-walk)
      sweep-queue=(list @p)
      catalog-pubpaths=(map @p (set path))
      know-where=know-where
  ==
::  state-12: adds the pub-where flag — the public-page analog of know-where.
::  %state = serve/store published pages from the in-agent content map (all
::  behavior through phase-1). %grubbery = the content map mirrors into the
::  grubbery %lattice nexus /pub vault, HTTP reads serve from it, and %grow
::  serving stays map-sourced (the content map is dual-written, never abandoned).
::  Everything else is byte-identical to state-11.
+$  pub-where  know-where
+$  state-12
  $:  %12
      content=(map path @t)
      published=(map path @uvH)
      pending=(map @ta [=ship =path])
      subs=(map [=ship spur=path] last=@ud)
      fetches=(map @ta walk)
      manifest=@uvH
      home=@uvH
      browse=(unit [=ship spur=path rev=@ud])
      know=(map path know-entry)
      trash=(map path know-entry)
      oquery=(unit [eid=@ta deadline=@da])
      catalog-sweep=(unit @da)
      catalog-walks=(map @ta catalog-walk)
      sweep-queue=(list @p)
      catalog-pubpaths=(map @p (set path))
      know-where=know-where
      pub-where=pub-where
  ==
::  +$ catalog-walk: one in-flight catalog walk-to-latest. Mirrors +$ walk
::  but with action and publisher (vs ship) so the same walk-to-latest
::  state machine can serve both manifest discovery and per-page fetches.
::    action — %manifest = walking the publisher's /manifest spur, will
::             parse the body as gemtext and spawn page walks on finalize.
::           — %page     = walking one specific publication, will analyze
::             the body and poke obelisk on finalize.
::    publisher — the @p we're fetching from.
::    spur — the path we're fetching (/manifest, or /notes/intro etc).
::    rev — highest revision resolved so far (0 = none yet).
::    deadline — the armed Behn timeout for this walk (slid as new revs
::               resolve, matching the interactive walk pattern).
::    origin — %sweep (started by the periodic/manual sweep, drives the
::             sequential sweep-queue) or %scan (a one-off manual
::             /catalog-scan, must NOT advance the sweep). Page walks
::             inherit their manifest walk's origin.
+$  catalog-walk
  $:  action=?(%manifest %page)
      publisher=@p
      spur=path
      rev=@ud
      mark=@t
      body=@t
      deadline=@da
      origin=?(%scan %sweep)
  ==
::  one in-flight walk-to-latest fetch (keyed by eyre-id).
::  rev = highest revision resolved so far (0 = none yet); deadline = the armed
::  behn timer's wake time (tracked so progress can %rest + re-arm it).
+$  walk
  $:  =ship
      spur=path
      rev=@ud
      mark=@t
      body=@t
      deadline=@da
  ==
::  obelisk result decoding (Explore pane). obelisk gives query results as a
::  bare %noun fact of shape [%.y (list ob-cmd-result)] (success) or [%.n tang]
::  (error). These mirror obelisk's sur/ast.hoon result tree — just the subset
::  the Explore table needs. We clam the raw noun to these inside a +mule, so
::  lattice stays decoupled from obelisk's source and a shape change degrades to
::  an error rather than a crash.
+$  ob-dime    [p=@tas q=@]               :: a typed atom: aura + value
+$  ob-cell    [p=@tas q=ob-dime]         :: column name + typed value
+$  ob-vector  [%vector (lest ob-cell)]   :: one row (non-empty list of cells)
+$  ob-result
  $%  [%action action=@t]
      [%relation relation=@t]
      [%message msg=@t]
      [%vector-count count=@ud]
      [%server-time date=@da]
      [%security-time date=@da]
      [%schema-time date=@da]
      [%data-time date=@da]
      [%result-set (list ob-vector)]
  ==
+$  ob-cmd-result  [%results (list ob-result)]
--
