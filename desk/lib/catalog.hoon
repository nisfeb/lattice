::  /lib/catalog — urQL schema + row-write generators for the lattice
::  content catalog.
::
::  The catalog is a federation-ready index of network content discovered
::  by crawling publishers' /manifest endpoints and listening to per-ship
::  /catalog update streams. It lives in %obelisk alongside the existing
::  `knowledge`/`tags` tables (in the same `lattice` database), with a
::  `catalog-*` prefix to keep the namespace clean.
::
::  See /docs/catalog.md for the design rationale, the pull-based
::  classifier pipeline that fills `category`/`tags` over time, and the
::  federation plan that lights up `source != our` rows in v2.
::
::  These gates are pure — they emit urQL strings the agent pokes into
::  %obelisk via the existing `%obelisk-action` `[%tape2 %lattice _]`
::  envelope (see +obelisk-poke / +obelisk-create-urql in /app/lattice
::  + /lib/lattice for the precedent). The crawler that calls these
::  lands in a follow-up PR; this lib stays bowl-independent so the
::  generators are unit-testable in isolation.
::
/+  *catalog-analyzer
|%
::  +catalog-create-urql: (re)create the catalog tables. CREATE TABLE is
::  atomic in obelisk and fails harmlessly if a table already exists, so
::  this is safe to poke at every agent boot — matching the existing
::  +obelisk-create-urql pattern for the knowledge/tags tables.
::
::  Natural keys throughout. `source` is the @p that vouches for the row:
::  `our` for content this ship crawled itself, another @p for catalog
::  rows imported from a peer's /catalog-query in the federation v2 plan
::  — so a single `(publisher, path)` can have multiple rows, one per
::  vouching source. Identical `hash` from independent sources is
::  cross-corroboration and a future ranking signal.
::
::  Column-by-column notes:
::    catalog-pages.category   — '' (empty cord) until classified.
::    catalog-pages.cat-source — '' | 'rule' | 'llm' | 'rule-fallback' |
::                               'manual' | 'imported' | 'author'. '' = not
::                               yet classified; the classifier pipeline (or,
::                               for 'author', the crawler reading a page's
::                               `%meta category:` line) writes a non-empty
::                               value. 'author' is applied only while a page
::                               is still unclassified, so it never clobbers
::                               a 'manual'/'llm' label (see refresh-urql).
::    catalog-pages.confidence — 0.0 when no confidence value is set;
::                               the LLM path writes 0.0-1.0.
::    catalog-pages.hash       — `sham` over the body cord. Hoon-side it
::                               stays @uvH (sham's return); the urQL column
::                               is typed @ud and the value encoded via
::                               +scot %ud, because obelisk's urQL accepts
::                               neither a @uv column literal nor a `0v…`
::                               value on INSERT — only @ud round-trips
::                               losslessly through both. The hash is used
::                               only for equality (skip-if-unchanged), so
::                               the decimal aura is immaterial.
::    catalog-links.is-internal — 1 if target-url starts with "urb://"
::                                (other-ship link); 0 for foreign-scheme
::                                links (http(s)/mailto/etc).
::    catalog-manifests        — caches each publisher's last /manifest
::                                hash for sweep diffing without re-fetch.
::    catalog-pending          — the classifier queue. `reason` is one
::                                of 'new' | 'changed' | 'requested' |
::                                'low-confidence'.
::
++  catalog-create-urql
  ^-  tape
  %-  zing
  :~  "CREATE TABLE catalog-pages (source @p, publisher @p, path @t, url @t, title @t, fetched @da, hash @ud, category @t, cat-source @t, confidence @rs, word-count @ud, body-lines @ud) PRIMARY KEY (source, publisher, path);"
      "CREATE TABLE catalog-headings (source @p, publisher @p, path @t, position @ud, depth @ud, text @t) PRIMARY KEY (source, publisher, path, position);"
      "CREATE TABLE catalog-links (source @p, publisher @p, path @t, position @ud, target-url @t, label @t, is-internal @ud) PRIMARY KEY (source, publisher, path, position);"
      "CREATE TABLE catalog-tags (source @p, publisher @p, path @t, tag @t) PRIMARY KEY (source, publisher, path, tag);"
      "CREATE TABLE catalog-manifests (publisher @p, scanned @da, hash @ud, raw @t) PRIMARY KEY (publisher);"
      "CREATE TABLE catalog-pending (source @p, publisher @p, path @t, queued @da, attempts @ud, reason @t) PRIMARY KEY (source, publisher, path);"
      ::  inverted index (feature B): one row per (page, content term). `tf` is
      ::  the in-page term frequency. NO body text — a lossy, order-free
      ::  bag-of-words; the page can't be reconstructed from these postings.
      ::  Replaced wholesale per page on re-crawl (DELETE-then-INSERT).
      "CREATE TABLE catalog-terms (source @p, publisher @p, path @t, term @t, tf @ud) PRIMARY KEY (source, publisher, path, term);"
      ::  author-declared metadata (feature A): a per-page summary an author
      ::  supplies via a `%meta summary:` line. (author-declared CATEGORY is
      ::  written straight onto catalog-pages.category, so it has no column
      ::  here.) Refreshed every crawl; one row per page when a summary exists.
      "CREATE TABLE catalog-meta (source @p, publisher @p, path @t, summary @t) PRIMARY KEY (source, publisher, path);"
  ==
::
::  ── page writes: the two-poke upsert ───────────────────────────────
::
::  A catalog page is written by TWO separate obelisk pokes, NOT one, so
::  that re-crawling a page during a periodic sweep PRESERVES whatever
::  classification (category / cat-source / confidence) the classifier set
::  on it. The split is forced by obelisk's primitives (all verified live):
::    - INSERT on an existing PRIMARY KEY ERRORS ("cannot add duplicate
::      key") — it never replaces an existing row;
::    - UPDATE on an absent row is a clean no-op;
::    - any parse/crud error ABORTS the whole multi-statement poke.
::  So the two operations CAN'T share one poke: the ensure-INSERT would
::  abort the refresh-UPDATE on every already-indexed page. As separate
::  pokes — in EITHER order — the end state is correct:
::    +catalog-page-ensure-urql  — INSERT the row with REAL content and
::      SENTINEL classification ('' / '' / .0). Succeeds for a new page;
::      fails harmlessly (dup-key, no state change) for one already in the
::      catalog. This is what puts a fresh page into the classifier
::      worklist (category = '').
::    +catalog-page-refresh-urql — UPDATE only the CONTENT columns (never
::      category/cat-source/confidence) so a re-crawl can't clobber a
::      classification; then DELETE+re-INSERT the page's headings/links/
::      tags (pure derived content, safe to fully replace).
::  Brand-new page: ensure inserts it (real content, sentinel class),
::  refresh re-sets the same content + writes children. Existing page:
::  ensure no-ops (dup), refresh refreshes content (class preserved) +
::  replaces children. The crawler emits BOTH pokes per page.
::
++  catalog-page-ensure-urql
  |=  [src=@p pub=@p pat=path now=@da =analysis]
  ^-  tape
  =/  st=tape    (trip (scot %p src))
  =/  pt=tape    (trip (scot %p pub))
  =/  pk=tape    (trip (spat pat))
  =/  ek=tape    (urq-esc pk)
  =/  url=tape   :(weld "urb://" pt pk)
  =/  ue=tape    (urq-esc url)
  =/  fet=tape   (trip (scot %da now))
  =/  hsh=tape   (trip (scot %ud hash.analysis))
  =/  ttl=tape   (urq-esc (trip title.analysis))
  =/  wc=tape    (trip (scot %ud word-count.analysis))
  =/  bl=tape    (trip (scot %ud body-lines.analysis))
  %-  zing
  :~  "INSERT INTO catalog-pages (source, publisher, path, url, title, fetched, hash, category, cat-source, confidence, word-count, body-lines) VALUES ("
      st  ", "  pt  ", '"  ek  "', '"  ue  "', '"  ttl  "', "
      fet  ", "  hsh  ", '', '', .0, "  wc  ", "  bl  ");"
  ==
::
++  catalog-page-refresh-urql
  |=  [src=@p pub=@p pat=path now=@da =analysis pages=(set path)]
  ^-  tape
  =/  st=tape    (trip (scot %p src))
  =/  pt=tape    (trip (scot %p pub))
  =/  pk=tape    (trip (spat pat))
  =/  ek=tape    (urq-esc pk)
  =/  url=tape   :(weld "urb://" pt pk)
  =/  ue=tape    (urq-esc url)
  =/  fet=tape   (trip (scot %da now))
  =/  hsh=tape   (trip (scot %ud hash.analysis))
  =/  ttl=tape   (urq-esc (trip title.analysis))
  =/  wc=tape    (trip (scot %ud word-count.analysis))
  =/  bl=tape    (trip (scot %ud body-lines.analysis))
  ::  WHERE clause shared by the content UPDATE and every child DELETE.
  =/  where=tape
    :(weld " WHERE source = " st " AND publisher = " pt " AND path = '" ek "';")
  ::  UPDATE only content columns — category/cat-source/confidence are NOT
  ::  named, so an existing classification survives the re-crawl. No-op if
  ::  the row is absent (a brand-new page is created by the ensure-INSERT).
  =/  update=tape
    %-  zing
    :~  "UPDATE catalog-pages SET url = '"  ue  "', title = '"  ttl
        "', fetched = "  fet  ", hash = "  hsh
        ", word-count = "  wc  ", body-lines = "  bl  where
    ==
  =/  deletes=tape
    %-  zing
    :~  (weld "DELETE FROM catalog-headings" where)
        (weld "DELETE FROM catalog-links" where)
        (weld "DELETE FROM catalog-tags" where)
        (weld "DELETE FROM catalog-meta" where)
    ==
  =/  heading-inserts=tape
    %-  zing
    %+  turn  headings.analysis
    |=  h=heading
    ^-  tape
    =/  ht=tape  (urq-esc (trip text.h))
    =/  d=tape   (trip (scot %ud depth.h))
    =/  p=tape   (trip (scot %ud position.h))
    %-  zing
    :~  "INSERT INTO catalog-headings (source, publisher, path, position, depth, text) VALUES ("
        st  ", "  pt  ", '"  ek  "', "  p  ", "  d  ", '"  ht  "');"
    ==
  =/  link-inserts=tape
    %-  zing
    %+  turn  links.analysis
    |=  l=link
    ^-  tape
    =/  tt=tape  (urq-esc (trip target.l))
    =/  lt=tape  (urq-esc (trip label.l))
    =/  p=tape   (trip (scot %ud position.l))
    =/  intr=tape
      ?:((link-internal (trip target.l) pages) "1" "0")
    %-  zing
    :~  "INSERT INTO catalog-links (source, publisher, path, position, target-url, label, is-internal) VALUES ("
        st  ", "  pt  ", '"  ek  "', "  p  ", '"  tt  "', '"  lt  "', "  intr  ");"
    ==
  =/  tag-inserts=tape
    %-  zing
    %+  turn  tags.analysis
    |=  t=@t
    ^-  tape
    =/  tg=tape  (urq-esc (trip t))
    %-  zing
    :~  "INSERT INTO catalog-tags (source, publisher, path, tag) VALUES ("
        st  ", "  pt  ", '"  ek  "', '"  tg  "');"
    ==
  ::  feature A — adopt the author's `%meta category:` ONLY while the page is
  ::  still unclassified: the WHERE carries `category = ''`, so this no-ops once
  ::  any classifier (llm/manual) has set a label, and re-applies on re-crawl
  ::  for a page still on the worklist. Empty tape when no category was declared.
  =/  acat=tape  (urq-esc (trip author-category.analysis))
  =/  author-update=tape
    ?:  =('' author-category.analysis)  ""
    %-  zing
    :~  "UPDATE catalog-pages SET category = '"  acat
        "', cat-source = 'author', confidence = .1"
        " WHERE source = "  st  " AND publisher = "  pt
        " AND path = '"  ek  "' AND category = '';"
    ==
  ::  feature A — the author summary (content, refreshed every crawl). Its
  ::  DELETE is in `deletes` above; INSERT only when a summary was declared.
  =/  meta-insert=tape
    ?:  =('' summary.analysis)  ""
    =/  sm=tape  (urq-esc (trip summary.analysis))
    %-  zing
    :~  "INSERT INTO catalog-meta (source, publisher, path, summary) VALUES ("
        st  ", "  pt  ", '"  ek  "', '"  sm  "');"
    ==
  :(weld update author-update deletes heading-inserts link-inserts tag-inserts meta-insert)
::
::  +link-internal: does a link target point into the network / to a known
::  page on this publisher? Replaces the old "starts with urb://" heuristic,
::  which marked every RELATIVE intra-ship link — the common case in real
::  gemtext — as external (live crawl of ~zod showed is-internal=0 on every
::  /-rooted link). A target is internal iff it is an explicit `urb://` link
::  OR a /-rooted spur that resolves to a path in `pages` (the publisher's
::  current manifest set, threaded in by the crawler). Foreign schemes
::  (http(s), mailto, …) and dangling relative links (not in the manifest)
::  are external. Bad knot syntax is treated as external (mule-guarded).
++  link-internal
  |=  [target=tape pages=(set path)]
  ^-  ?
  ?:  (has-prefix "urb://" target)  &
  ?.  ?=(^ target)  |
  ?.  =('/' i.target)  |
  =/  parsed=(each path tang)  (mule |.((stab (crip target))))
  ?:  ?=(%| -.parsed)  |
  (~(has in pages) p.parsed)
::
::  +catalog-page-delete-urql: remove every row for one page across all
::  five catalog tables. Used when the crawler observes a path drop out
::  of a publisher's /manifest. Idempotent — DELETE WHERE on absent rows
::  is a no-op.
::
++  catalog-page-delete-urql
  |=  [src=@p pub=@p pat=path]
  ^-  tape
  =/  st=tape  (trip (scot %p src))
  =/  pt=tape  (trip (scot %p pub))
  =/  ek=tape  (urq-esc (trip (spat pat)))
  =/  where=tape
    :(weld " WHERE source = " st " AND publisher = " pt " AND path = '" ek "';")
  %-  zing
  :~  (weld "DELETE FROM catalog-pages" where)
      (weld "DELETE FROM catalog-headings" where)
      (weld "DELETE FROM catalog-links" where)
      (weld "DELETE FROM catalog-tags" where)
      (weld "DELETE FROM catalog-pending" where)
      ::  the inverted-index postings + author summary for this page MUST be
      ::  swept too, else a page that drops out of a publisher's manifest leaves
      ::  orphaned term rows → "ghost" search hits to a page no longer in
      ::  catalog-pages. (Bug found in the design review; fixed here.)
      (weld "DELETE FROM catalog-terms" where)
      (weld "DELETE FROM catalog-meta" where)
  ==
::
::  +catalog-page-terms-urql: replace one page's inverted-index postings. A
::  DELETE-then-INSERT in a SINGLE poke (like +catalog-manifest-urql) — the
::  leading DELETE clears the prior crawl's postings so the INSERTs can't hit a
::  duplicate key (which would abort the poke). Emitted as its OWN obelisk poke,
::  separate from the page ensure/refresh, so a pathological term aborts only
::  the index write, never the page row. NO body text is stored — only the
::  derived (term, tf) postings, an order-free bag-of-words.
++  catalog-page-terms-urql
  |=  [src=@p pub=@p pat=path =analysis]
  ^-  tape
  =/  st=tape   (trip (scot %p src))
  =/  pt=tape   (trip (scot %p pub))
  =/  ek=tape   (urq-esc (trip (spat pat)))
  =/  where=tape
    :(weld " WHERE source = " st " AND publisher = " pt " AND path = '" ek "';")
  =/  inserts=tape
    %-  zing
    %+  turn  terms.analysis
    |=  tm=term
    ^-  tape
    =/  tx=tape  (urq-esc (trip term.tm))
    =/  f=tape   (trip (scot %ud tf.tm))
    %-  zing
    :~  "INSERT INTO catalog-terms (source, publisher, path, term, tf) VALUES ("
        st  ", "  pt  ", '"  ek  "', '"  tx  "', "  f  ");"
    ==
  (weld (weld "DELETE FROM catalog-terms" where) inserts)
::
::  +catalog-manifest-urql: refresh the cached manifest snapshot for one
::  publisher. Two-statement UPSERT (DELETE then INSERT) since obelisk's
::  urQL has no ON CONFLICT clause. Idempotent.
::
++  catalog-manifest-urql
  |=  [pub=@p now=@da hsh=@uvH raw=@t]
  ^-  tape
  =/  pt=tape    (trip (scot %p pub))
  =/  scan=tape  (trip (scot %da now))
  =/  h=tape     (trip (scot %ud hsh))
  ::  `raw` is a multi-line gemtext manifest — its newlines/control bytes are
  ::  neutralized to spaces by +urq-esc (which all @t values flow through), so
  ::  this INSERT can't parse-abort on a raw newline.
  =/  r=tape     (urq-esc (trip raw))
  %-  zing
  :~  "DELETE FROM catalog-manifests WHERE publisher = "  pt  ";"
      "INSERT INTO catalog-manifests (publisher, scanned, hash, raw) VALUES ("
      pt  ", "  scan  ", "  h  ", '"  r  "');"
  ==
::
::  +catalog-pending-urql: enqueue one page for classification. Idempotent
::  via DELETE-then-INSERT — a second queue request for the same key
::  replaces the prior row (e.g. bumps `attempts` or updates `reason`).
::
++  catalog-pending-urql
  |=  [src=@p pub=@p pat=path now=@da reason=@t attempts=@ud]
  ^-  tape
  =/  st=tape   (trip (scot %p src))
  =/  pt=tape   (trip (scot %p pub))
  =/  ek=tape   (urq-esc (trip (spat pat)))
  =/  q=tape    (trip (scot %da now))
  =/  a=tape    (trip (scot %ud attempts))
  =/  r=tape    (urq-esc (trip reason))
  =/  where=tape
    :(weld " WHERE source = " st " AND publisher = " pt " AND path = '" ek "';")
  %-  zing
  :~  (weld "DELETE FROM catalog-pending" where)
      "INSERT INTO catalog-pending (source, publisher, path, queued, attempts, reason) VALUES ("
      st  ", "  pt  ", '"  ek  "', "  q  ", "  a  ", '"  r  "');"
  ==
::
::  +catalog-pending-clear-urql: pop one page off the pending queue.
::  Called after a successful classification (or a manual dismissal).
::  Idempotent — no-op on absent rows.
::
++  catalog-pending-clear-urql
  |=  [src=@p pub=@p pat=path]
  ^-  tape
  =/  st=tape  (trip (scot %p src))
  =/  pt=tape  (trip (scot %p pub))
  =/  ek=tape  (urq-esc (trip (spat pat)))
  :(weld "DELETE FROM catalog-pending WHERE source = " st " AND publisher = " pt " AND path = '" ek "';")
::
::  +parse-manifest: extract published page spurs from a /manifest gemtext
::  body. The publisher's +generate-index emits `=> /spur  label` lines for
::  every live publication; this is the inverse. Malformed lines (bad path
::  syntax, foreign-scheme URL) are silently dropped so one bad line can't
::  abort a whole sweep.
::
::  Returns the spur paths the publisher offers, each ready to walk
::  individually via remote scry. The crawler iterates the result and
::  schedules a per-page %keen for each, analyzing each body in turn.
::
++  parse-manifest
  |=  body=@t
  ^-  (list path)
  =/  lines=(list @t)  (to-wain:format body)
  ::  dedupe (first-occurrence order): a manifest with duplicate `=> /x`
  ::  lines must not yield duplicate spurs. The crawler keys in-flight walks
  ::  by (now, publisher, spur); duplicates spawned in one event would
  ::  collide to a single eid, leaving an orphaned keen + behn timer. Dedup
  ::  here removes that whole class of collision/leak at the source.
  %-  dedupe-paths
  %+  murn  lines
  |=  ln=@t
  ^-  (unit path)
  =/  t=tape  (trip ln)
  ?.  (has-prefix "=> " t)  ~
  =/  rest=tape  (ltrim (slag 3 t))
  ::  the target ends at the first whitespace (the label, if any, follows)
  =/  sp=(unit @ud)  (find " " rest)
  =/  target=tape  ?~(sp rest (scag u.sp rest))
  ::  only accept /-rooted local paths; foreign-scheme links (http, mailto,
  ::  urb://other-ship/x) aren't this publisher's content — skip them.
  ?.  &(?=(^ target) =('/' i.target))  ~
  ::  +stab crashes on invalid knot syntax (spaces, control bytes, empty
  ::  segments) — wrap in mule so a bad line is a no-op rather than a sweep
  ::  failure.
  =/  parsed=(each path tang)
    %-  mule
    |.((stab (crip target)))
  ?:(?=(%& -.parsed) `p.parsed ~)
::
::  +sweep-publishers: the set of publisher ships to crawl in a sweep. The
::  UNION of (a) the ships we follow per-file (`subs`, keyed by [ship spur])
::  and (b) every ship in our %contacts book (`contacts`). The catalog
::  indexes everyone in the contact book even if we don't follow any of their
::  files — so search covers contacts, not just follows. Our own ship is
::  dropped (can't crawl yourself). Order is unspecified (set tap); the sweep
::  queue processes them sequentially. Typed with stdlib shapes only (@p,
::  path) so this lib stays free of /+ *lattice — the agent scrys %contacts
::  and passes the ship set in.
++  sweep-publishers
  |=  [subs=(map [=ship spur=path] last=@ud) contacts=(set @p) our=@p]
  ^-  (list @p)
  =/  follow-ships=(set @p)
    %-  ~(gas in *(set @p))
    %+  turn  ~(tap in ~(key by subs))
    |=([s=ship *] s)
  ~(tap in (~(del in (~(uni in follow-ships) contacts)) our))
::
::  +dedupe-paths: drop duplicate paths, preserving first-occurrence order.
::  (A set would lose order; the catalog doesn't strictly need order, but
::  stable output keeps tests and the crawl deterministic.)
++  dedupe-paths
  |=  paths=(list path)
  ^-  (list path)
  =|  seen=(set path)
  =|  out=(list path)
  |-  ^-  (list path)
  ?~  paths  (flop out)
  ?:  (~(has in seen) i.paths)  $(paths t.paths)
  $(paths t.paths, seen (~(put in seen) i.paths), out [i.paths out])
::
::  ════════════════════════════════════════════════════════════════════
::  Read-side query compilers.
::
::  These build SELECT urQL for the catalog read HTTP endpoints. The
::  lattice agent runs them through the same async obelisk bridge as
::  /know-query (poke %obelisk-action, await the result %fact). Obelisk's
::  urQL is FROM-first and — verified live against the installed obelisk —
::  supports equality + comparison WHERE, AND-conjunction, and ORDER BY,
::  but NOT LIKE, LIMIT, or COUNT. So:
::    - filtering is equality-only (category / publisher / source);
::    - free-text substring search is the CALLER's job, over the
::      /catalog-list result (obelisk has no LIKE);
::    - there's no row cap server-side (no LIMIT) — callers paginate.
::
::  @t values are single-quoted + +urq-esc'd (injection-safe). @p values
::  (publisher, source) are emitted as BARE ship literals — obelisk's
::  crud layer type-checks `publisher = ~zod`, and rejects a quoted
::  `'~zod'`. Endpoints MUST pre-validate @p params via +slaw %p and pass
::  the canonical (scot %p) form, so only well-formed ship literals reach
::  the bare interpolation.
::  ════════════════════════════════════════════════════════════════════
::
::  The column set every page-row query returns. Body/headings/links are
::  NOT here — they're per-page detail fetched via +catalog-fetch-urql.
++  catalog-list-cols
  ^-  tape
  "source, publisher, path, url, title, category, cat-source, word-count, fetched"
::
::  +catalog-list-urql: every catalog page, newest first. No LIMIT in
::  obelisk's urQL; callers paginate client-side.
++  catalog-list-urql
  ^-  tape
  ;:  weld
    "FROM catalog-pages SELECT "  catalog-list-cols  " ORDER BY fetched DESC;"
  ==
::
::  +catalog-explore-urql: filter pages by any combination of category /
::  publisher / source, AND-ed. Each arg is a tape; "" drops that filter.
::  `category` is a @t column (quoted + escaped); `publisher` and `source`
::  are @p columns (bare ship literal — caller pre-validates via slaw %p).
::  No filters → identical to +catalog-list-urql.
++  catalog-explore-urql
  |=  [category=tape publisher=tape source=tape]
  ^-  tape
  =/  fields=(list [col=tape typ=?(%t %p) val=tape])
    :~  ["category" %t category]
        ["publisher" %p publisher]
        ["source" %p source]
    ==
  =/  clauses=(list tape)
    %+  murn  fields
    |=  [col=tape typ=?(%t %p) val=tape]
    ^-  (unit tape)
    ?:  =("" val)  ~
    ?-  typ
      %t  `:(weld col " = '" (urq-esc val) "'")
      %p  `:(weld col " = " val)
    ==
  =/  where=tape
    ?~  clauses  ""
    (weld " WHERE " (catalog-join-and clauses))
  ;:  weld
    "FROM catalog-pages"  where  " SELECT "
    catalog-list-cols  " ORDER BY fetched DESC;"
  ==
::
::  +catalog-fetch-urql: the full row for one page, by its urb:// url.
++  catalog-fetch-urql
  |=  url=tape
  ^-  tape
  :(weld "FROM catalog-pages WHERE url = '" (urq-esc url) "' SELECT *;")
::
::  +catalog-by-tag-urql: the (source, publisher, path) of every page
::  carrying `tag`. Queries the catalog-tags table; the caller resolves
::  the keys to full rows via +catalog-fetch-urql (tag is in a separate
::  table from pages, and obelisk's single-equality JOIN ON can't express
::  the composite (source, publisher, path) key cleanly).
++  catalog-by-tag-urql
  |=  tag=tape
  ^-  tape
  :(weld "FROM catalog-tags WHERE tag = '" (urq-esc tag) "' SELECT source, publisher, path;")
::
::  +catalog-search-urql: the (source, publisher, path) + in-page frequency of
::  every page whose body contains `term` (feature B). One equality WHERE —
::  obelisk has no LIKE / IN / OR — so a multi-word query is N sequential
::  single-term calls the CLIENT fans out, then ranks (TF-IDF, df = posting-row
::  count) + joins the keys back to catalog-pages rows. Same key-then-resolve
::  shape as +catalog-by-tag-urql. `term` must be pre-normalized by the caller
::  (lower-cased, punctuation-trimmed) to match the stored postings.
++  catalog-search-urql
  |=  term=tape
  ^-  tape
  :(weld "FROM catalog-terms WHERE term = '" (urq-esc term) "' SELECT source, publisher, path, tf;")
::
::  ════════════════════════════════════════════════════════════════════
::  Classifier pipeline.
::
::  The classifier is an external LLM (driven via MCP/HTTP) that reads the
::  worklist + the existing taxonomy, decides a category for each page, and
::  writes it back. obelisk can't be read from an MCP thread (no scry, the
::  bridge is async), so the two READ helpers below are served by HTTP
::  endpoints the classifier calls directly; the WRITE is exposed both as an
::  HTTP endpoint and a poke action so an MCP tool can drive it.
::  ════════════════════════════════════════════════════════════════════
::
::  +catalog-pending-list-urql: the worklist — every page not yet classified
::  (category = ''), newest first. obelisk has no LIMIT, so the classifier
::  takes a batch off the front and paginates client-side. This is a
::  COMPUTED worklist, not a queue table: a fresh crawl INSERTs category=''
::  (page appears here); +catalog-classify-urql sets a category (page drops
::  off); the two-poke upsert preserves the category across re-sweeps (an
::  already-classified page never reappears). No catalog-pending TABLE write
::  is needed for the 'new' case — that table is reserved for future
::  explicit-requeue reasons ('changed' / 'requested' / 'low-confidence').
++  catalog-pending-list-urql
  ^-  tape
  ;:  weld
    "FROM catalog-pages WHERE category = '' SELECT "
    "source, publisher, path, url, title, word-count, fetched"
    " ORDER BY fetched DESC;"
  ==
::
::  +catalog-classify-urql: write a classification onto one page. A pure
::  multi-column UPDATE (verified live) that names ONLY the classification
::  columns, never content — so it composes cleanly with the crawler's
::  content refresh in any interleaving. `cat-source` is the provenance
::  ('llm' | 'rule' | 'manual' | 'imported'); `confidence` is 0.0-1.0 (@rs,
::  emitted via +scot %rs — obelisk parses the `.85` float syntax). Targets
::  exactly one row via the (source, publisher, path) natural key.
++  catalog-classify-urql
  |=  [src=@p pub=@p pat=path category=@t cat-source=@t confidence=@rs]
  ^-  tape
  =/  st=tape   (trip (scot %p src))
  =/  pt=tape   (trip (scot %p pub))
  =/  ek=tape   (urq-esc (trip (spat pat)))
  =/  cat=tape  (urq-esc (trip category))
  =/  cs=tape   (urq-esc (trip cat-source))
  =/  cf=tape   (trip (scot %rs confidence))
  ;:  weld
    "UPDATE catalog-pages SET category = '"  cat
    "', cat-source = '"  cs  "', confidence = "  cf
    " WHERE source = "  st  " AND publisher = "  pt
    " AND path = '"  ek  "';"
  ==
::
::  +catalog-vocab-urql: the existing category vocabulary — the category
::  column of every page. obelisk has no DISTINCT/GROUP BY (verified live),
::  so this returns one row per page and the CALLER dedupes + drops the ''
::  (unclassified) sentinel. The classifier reads this to reuse established
::  categories instead of coining near-duplicates (the "let users/LLMs
::  bootstrap their own taxonomy without bias" goal — we suggest the live
::  vocabulary, we don't impose a fixed enum).
++  catalog-vocab-urql
  ^-  tape
  "FROM catalog-pages SELECT category;"
::
::  +catalog-join-and: join WHERE conjuncts with " AND ". "" for empties.
++  catalog-join-and
  |=  clauses=(list tape)
  ^-  tape
  ?~  clauses  ""
  ?~  t.clauses  i.clauses
  :(weld i.clauses " AND " $(clauses t.clauses))
::
::  +urq-esc: make an arbitrary tape safe inside an obelisk single-quoted
::  string literal. Backslash-escapes ' and \, AND replaces every control byte
::  (< 32: newline, CR, tab, …) with a space — obelisk's urQL string lexer can
::  terminate a literal at a raw control byte, aborting the whole poke, so any
::  @t that might carry one (a multi-line manifest body, a CRLF-authored page's
::  heading/title/link/tag) must be neutralized. Centralizing it here means
::  every generator (page rows, manifest, classify, fetch, explore) is safe.
::  (A superset of /lib/lattice's +urq-esc, whose knowledge values are
::  single-token and so never hit the control-byte case.)
++  urq-esc
  |=  s=tape
  ^-  tape
  %-  zing
  %+  turn  s
  |=  c=@tD
  ^-  tape
  ?:  (lth c 32)  ~[' ']            :: control byte -> space (lexer-safe)
  ?:  =(c 39)  ~[`@tD`92 `@tD`39]   :: ' -> \'
  ?:  =(c 92)  ~[`@tD`92 `@tD`92]   :: \ -> \\
  ~[c]
--
