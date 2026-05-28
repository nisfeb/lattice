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
::                               'manual' | 'imported'. '' = not yet
::                               classified; the classifier pipeline
::                               writes one of the non-empty values.
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
  ==
::
::  +catalog-page-urql: (re)write all the rows for one catalog page from
::  an analyzer output. Idempotent — DELETEs any prior rows for the same
::  `(source, publisher, path)` before INSERTing, so the crawler doesn't
::  need to dedupe and a refresh on a changed body cleanly replaces the
::  stale headings/links/tags.
::
::  `category`, `cat-source`, and `confidence` start at their sentinel
::  values (`''` / `''` / `.0`). The classifier pipeline fills them via
::  a separate UPDATE in a follow-up PR.
::
::  `is-internal` is set to 1 when a link target starts with `urb://`
::  (best-effort heuristic — distinguishes intra-network links from
::  http(s)/mailto/etc without a cross-table lookup); the proper resolve
::  against `catalog-pages` is a future-PR refinement.
::
++  catalog-page-urql
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
  ::  Reusable WHERE clause; applies to every per-page DELETE.
  =/  where=tape
    :(weld " WHERE source = " st " AND publisher = " pt " AND path = '" ek "';")
  =/  deletes=tape
    %-  zing
    :~  (weld "DELETE FROM catalog-pages" where)
        (weld "DELETE FROM catalog-headings" where)
        (weld "DELETE FROM catalog-links" where)
        (weld "DELETE FROM catalog-tags" where)
    ==
  =/  page-insert=tape
    %-  zing
    :~  "INSERT INTO catalog-pages (source, publisher, path, url, title, fetched, hash, category, cat-source, confidence, word-count, body-lines) VALUES ("
        st  ", "  pt  ", '"  ek  "', '"  ue  "', '"  ttl  "', "
        fet  ", "  hsh  ", '', '', .0, "  wc  ", "  bl  ");"
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
      ?:((has-prefix "urb://" (trip target.l)) "1" "0")
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
  :(weld deletes page-insert heading-inserts link-inserts tag-inserts)
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
  ==
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
::  +catalog-join-and: join WHERE conjuncts with " AND ". "" for empties.
++  catalog-join-and
  |=  clauses=(list tape)
  ^-  tape
  ?~  clauses  ""
  ?~  t.clauses  i.clauses
  :(weld i.clauses " AND " $(clauses t.clauses))
::
::  +urq-esc: backslash-escape ' and \ for obelisk's string-literal syntax.
::  Inlined from /lib/lattice so this lib has no /+ *lattice dependency
::  (would otherwise drag in state-10 and all the agent's deps). Behavior
::  matches +urq-esc in lib/lattice verbatim.
++  urq-esc
  |=  s=tape
  ^-  tape
  %-  zing
  %+  turn  s
  |=  c=@tD
  ^-  tape
  ?:  =(c 39)  ~[`@tD`92 `@tD`39]   :: ' -> \'
  ?:  =(c 92)  ~[`@tD`92 `@tD`92]   :: \ -> \\
  ~[c]
--
