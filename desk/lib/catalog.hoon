::  /lib/catalog — urQL schema + row-write generators for the lattice
::  content catalog.
::
::  The catalog is a federation-ready index of network content discovered
::  by crawling publishers' /manifest endpoints and listening to per-ship
::  /catalog update streams. It lives in %obelisk alongside the existing
::  `knowledge`/`tags` tables (in the same `lattice` database), with a
::  `catalog_*` prefix to keep the namespace clean.
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
::    catalog_pages.category   — '' (empty cord) until classified.
::    catalog_pages.cat_source — '' | 'rule' | 'llm' | 'rule-fallback' |
::                               'manual' | 'imported'. '' = not yet
::                               classified; the classifier pipeline
::                               writes one of the non-empty values.
::    catalog_pages.confidence — 0.0 when no confidence value is set;
::                               the LLM path writes 0.0-1.0.
::    catalog_pages.hash       — `sham` over the body cord (128-bit @uvH,
::                               matching state.manifest's hash type so
::                               the schemas stay congruent). Lets the
::                               crawler skip re-analyzing on no-change.
::    catalog_links.is_internal — 1 if target_url starts with "urb://"
::                                (other-ship link); 0 for foreign-scheme
::                                links (http(s)/mailto/etc).
::    catalog_manifests        — caches each publisher's last /manifest
::                                hash for sweep diffing without re-fetch.
::    catalog_pending          — the classifier queue. `reason` is one
::                                of 'new' | 'changed' | 'requested' |
::                                'low-confidence'.
::
++  catalog-create-urql
  ^-  tape
  %-  zing
  :~  "CREATE TABLE catalog_pages (source @p, publisher @p, path @t, url @t, title @t, fetched @da, hash @uvH, category @t, cat_source @t, confidence @rs, word_count @ud, body_lines @ud) PRIMARY KEY (source, publisher, path);"
      "CREATE TABLE catalog_headings (source @p, publisher @p, path @t, position @ud, depth @ud, text @t) PRIMARY KEY (source, publisher, path, position);"
      "CREATE TABLE catalog_links (source @p, publisher @p, path @t, position @ud, target_url @t, label @t, is_internal @ud) PRIMARY KEY (source, publisher, path, position);"
      "CREATE TABLE catalog_tags (source @p, publisher @p, path @t, tag @t) PRIMARY KEY (source, publisher, path, tag);"
      "CREATE TABLE catalog_manifests (publisher @p, scanned @da, hash @uvH, raw @t) PRIMARY KEY (publisher);"
      "CREATE TABLE catalog_pending (source @p, publisher @p, path @t, queued @da, attempts @ud, reason @t) PRIMARY KEY (source, publisher, path);"
  ==
::
::  +catalog-page-urql: (re)write all the rows for one catalog page from
::  an analyzer output. Idempotent — DELETEs any prior rows for the same
::  `(source, publisher, path)` before INSERTing, so the crawler doesn't
::  need to dedupe and a refresh on a changed body cleanly replaces the
::  stale headings/links/tags.
::
::  `category`, `cat_source`, and `confidence` start at their sentinel
::  values (`''` / `''` / `.0`). The classifier pipeline fills them via
::  a separate UPDATE in a follow-up PR.
::
::  `is_internal` is set to 1 when a link target starts with `urb://`
::  (best-effort heuristic — distinguishes intra-network links from
::  http(s)/mailto/etc without a cross-table lookup); the proper resolve
::  against `catalog_pages` is a future-PR refinement.
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
  =/  hsh=tape   (trip (scot %uv hash.analysis))
  =/  ttl=tape   (urq-esc (trip title.analysis))
  =/  wc=tape    (trip (scot %ud word-count.analysis))
  =/  bl=tape    (trip (scot %ud body-lines.analysis))
  ::  Reusable WHERE clause; applies to every per-page DELETE.
  =/  where=tape
    :(weld " WHERE source = " st " AND publisher = " pt " AND path = '" ek "';")
  =/  deletes=tape
    %-  zing
    :~  (weld "DELETE FROM catalog_pages" where)
        (weld "DELETE FROM catalog_headings" where)
        (weld "DELETE FROM catalog_links" where)
        (weld "DELETE FROM catalog_tags" where)
    ==
  =/  page-insert=tape
    %-  zing
    :~  "INSERT INTO catalog_pages (source, publisher, path, url, title, fetched, hash, category, cat_source, confidence, word_count, body_lines) VALUES ("
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
    :~  "INSERT INTO catalog_headings (source, publisher, path, position, depth, text) VALUES ("
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
    :~  "INSERT INTO catalog_links (source, publisher, path, position, target_url, label, is_internal) VALUES ("
        st  ", "  pt  ", '"  ek  "', "  p  ", '"  tt  "', '"  lt  "', "  intr  ");"
    ==
  =/  tag-inserts=tape
    %-  zing
    %+  turn  tags.analysis
    |=  t=@t
    ^-  tape
    =/  tg=tape  (urq-esc (trip t))
    %-  zing
    :~  "INSERT INTO catalog_tags (source, publisher, path, tag) VALUES ("
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
  :~  (weld "DELETE FROM catalog_pages" where)
      (weld "DELETE FROM catalog_headings" where)
      (weld "DELETE FROM catalog_links" where)
      (weld "DELETE FROM catalog_tags" where)
      (weld "DELETE FROM catalog_pending" where)
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
  =/  h=tape     (trip (scot %uv hsh))
  =/  r=tape     (urq-esc (trip raw))
  %-  zing
  :~  "DELETE FROM catalog_manifests WHERE publisher = "  pt  ";"
      "INSERT INTO catalog_manifests (publisher, scanned, hash, raw) VALUES ("
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
  :~  (weld "DELETE FROM catalog_pending" where)
      "INSERT INTO catalog_pending (source, publisher, path, queued, attempts, reason) VALUES ("
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
  :(weld "DELETE FROM catalog_pending WHERE source = " st " AND publisher = " pt " AND path = '" ek "';")
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
