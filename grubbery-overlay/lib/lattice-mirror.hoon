::  lattice-mirror: urQL generation for the obelisk commons mirror.
::
::  Pure functions only, no grubbery imports, so desk-level tests can
::  reach this lib. The design lives in docs/obelisk-mirror.md. The
::  target is %obelisk the DESK (distributed by ~dister-nomryg-nilref),
::  never grubbery's vendored copy of the engine. The engine facts these
::  builders encode were verified against that desk while the first
::  catalog was built:
::    - identifiers are @tas, so kebab-case only
::    - table names ride bare in statements. The database travels in the
::      poke envelope beside the script, not in the table reference
::    - INSERT on an existing primary key errors and never replaces;
::      UPDATE on an absent row is a clean no-op (the two-poke upsert)
::    - a parse or crud error aborts its whole multi-statement poke
::    - CREATE DATABASE and CREATE TABLE both error on an existing
::      target, so every create rides its OWN poke with the error
::      expected and swallowed. A joined create script aborts at the
::      first existing table and never creates the ones after it
::    - a @da literal with a zero-padded day is SILENTLY dropped, so
::      dates go through +urq-da
::    - no @uv literals: sham hashes ride as @ud decimals
::    - JOIN accepts a single equality only, which is why every table
::      keyed by a pair carries a synthetic sham key
::
|%
::  the database every lattice mirror statement runs against, passed in
::  the poke envelope beside the script.
++  mirror-db  `@tas`%lattice
::  +urq-esc: neutralize a tape for a single-quoted urQL @t literal.
::  Control bytes and backslashes become spaces, a quote becomes \'.
::  Salvaged verbatim from the removed catalog-analyzer, where the
::  comment records the lexer behavior that forces each rule.
::
++  urq-esc
  |=  s=tape
  ^-  tape
  %-  zing
  %+  turn  s
  |=  c=@tD
  ^-  tape
  ?:  (lth c 32)  ~[' ']
  ?:  =(c 127)  ~[' ']
  ?:  =(c 92)  ~[' ']
  ?:  =(c 39)  ~[`@tD`92 `@tD`39]
  ~[c]
::  +nopad / +urq-da: a @da literal the engine will actually accept.
::  scot zero-pads the day and the parser silently drops such a row.
::  Salvaged verbatim from the removed lib/catalog.
::
++  nopad
  |=  s=tape
  ^-  tape
  ?.  ?=([@ @ ~] s)  s
  ?.  =('0' i.s)  s
  t.s
++  urq-da
  |=  when=@da
  ^-  tape
  =/  t=tape  (trip (scot %da when))
  ?.  (gte (lent t) 11)  t
  ?.  ?&(=('.' (snag 5 t)) =('.' (snag 8 t)))  t
  ;:  weld
    (scag 5 t)  "."  (nopad (swag [6 2] t))
    "."  (nopad (swag [9 2] t))  (slag 11 t)
  ==
::  literal encoders. Text goes through urq-esc and gains its quotes
::  here, so a builder can never emit an unescaped or unquoted @t.
::
++  lit-t
  |=  t=tape
  ^-  tape
  :(weld "'" (urq-esc t) "'")
++  lit-cord  |=(c=@t (lit-t (trip c)))
++  lit-p    |=(s=@p (trip (scot %p s)))
++  lit-ud   |=(n=@ud (trip (scot %ud n)))
::  +doc-id: the frozen document identity (docs/obelisk-mirror.md
::  section 3): sham of the [ship path] pair as a decimal.
::
++  doc-id
  |=  [s=@p pax=path]
  ^-  tape
  (lit-ud `@ud`(sham s pax))
::  +key-id: a synthetic key for a pair of text keys (know-tag rows).
::
++  key-id
  |=  [a=path b=@t]
  ^-  tape
  (lit-ud `@ud`(sham a b))
::  ── schema ──────────────────────────────────────────────────────────
::  ONE create per list element, and the caller pokes each element as
::  its OWN poke, expected-error swallowed. The removed catalog learned
::  this the hard way: a joined create script left later tables
::  uncreated on any ship where an earlier one already existed.
::
++  create-db-urql
  ^-  tape
  "CREATE DATABASE lattice;"
++  create-list
  ^-  (list tape)
  :~  "CREATE TABLE lattice-pages (doc-id @ud, pax @t, kind @t, title @t, updated @da, share @t, live @ud) PRIMARY KEY (doc-id);"
      "CREATE TABLE lattice-knows (know-key @t, updated @da, live @ud) PRIMARY KEY (know-key);"
      "CREATE TABLE lattice-know-tags (tag-id @ud, know-key @t, tag @t, live @ud) PRIMARY KEY (tag-id);"
      "CREATE TABLE lattice-follows (follow-id @ud, ship @p, live @ud) PRIMARY KEY (follow-id);"
      "CREATE TABLE lattice-visits (doc-id @ud, ship @p, pax @t, title @t, last @da, hits @ud) PRIMARY KEY (doc-id);"
      "CREATE TABLE lattice-docs (doc-id @ud, ship @p, pax @t, kind @t, title @t, seen-at @da, last-rev @ud) PRIMARY KEY (doc-id);"
  ==
::  per-table probes: one SELECT of the primary key column. An empty
::  table answers with an empty result set, a missing table errors, and
::  that difference is the wipe signal (failure mode 2). The
::  impossible-key WHERE bounds the probe to zero rows, and its literal
::  must match the column type or the probe itself would be the crud
::  error it is looking for.
::
++  probe-urqls
  ^-  (list tape)
  :~  (probe "lattice-pages" "doc-id" "0")
      (probe "lattice-knows" "know-key" "''")
      (probe "lattice-know-tags" "tag-id" "0")
      (probe "lattice-follows" "follow-id" "0")
      (probe "lattice-visits" "doc-id" "0")
      (probe "lattice-docs" "doc-id" "0")
  ==
++  probe
  |=  [table=tape col=tape zero=tape]
  ^-  tape
  :(weld "FROM " table " WHERE " col " = " zero " SELECT " col ";")
::  ── v1 cleanup ──────────────────────────────────────────────────────
::  Ships that ran the first catalog carry its dead tables in the same
::  lattice database. They are lattice's own prior output, unread since
::  the catalog removal and rebuildable by definition, and two of them
::  squat generic names (tags, knowledge) other commons apps may want.
::  These are RUNBOOK material, run by hand through POST /obelisk-query
::  on any ship that ran the first catalog. The automated version was
::  removed after it destabilized the reconciler.
::
++  v1-marker-urql
  ^-  tape
  (probe "catalog-pages" "path" "''")
++  v1-drop-list
  ^-  (list tape)
  %+  turn
    ^-  (list tape)
    :~  "catalog-pages"  "catalog-headings"  "catalog-links"
        "catalog-tags"  "catalog-manifests"  "catalog-pending"
        "catalog-terms"  "catalog-meta"  "knowledge"  "tags"
    ==
  |=  t=tape
  :(weld "DROP TABLE FORCE " t ";")
::  ── row types ───────────────────────────────────────────────────────
::  What the reconciler hands the builders. Auras stay hoon-native here;
::  encoding is the builders' job.
::
+$  page-row    [pax=path kind=@t title=@t updated=@da share=@t]
+$  know-row    [key=path updated=@da]
+$  tag-row     [key=path tag=@t]
+$  follow-row  [=ship ~]
+$  visit-row   [=ship pax=path title=@t last=@da hits=@ud]
::  ── upsert builders ─────────────────────────────────────────────────
::  Each curated row gets a matched UPDATE + INSERT pair derived from
::  one literal set, the pattern the removed catalog used to make
::  insert/update disagreement impossible. UPDATEs batch into one poke
::  (absent rows no-op). INSERTs ride one poke each with the duplicate
::  key error expected and swallowed by the caller.
::
++  page-lits
  |=  [our=@p r=page-row]
  ^-  [id=tape px=tape kd=tape tt=tape up=tape sh=tape]
  :*  (doc-id our pax.r)
      (lit-t (trip (spat pax.r)))
      (lit-cord kind.r)
      (lit-cord title.r)
      (urq-da updated.r)
      (lit-cord share.r)
  ==
++  page-update
  |=  [our=@p r=page-row]
  ^-  tape
  =+  (page-lits our r)
  %-  zing
  :~  "UPDATE lattice-pages SET pax = "  px  ", kind = "  kd
      ", title = "  tt  ", updated = "  up  ", share = "  sh
      ", live = 1 WHERE doc-id = "  id  ";"
  ==
++  page-insert
  |=  [our=@p r=page-row]
  ^-  tape
  =+  (page-lits our r)
  %-  zing
  :~  "INSERT INTO lattice-pages (doc-id, pax, kind, title, updated, share, live) VALUES ("
      id  ", "  px  ", "  kd  ", "  tt  ", "  up  ", "  sh  ", 1);"
  ==
++  page-dead
  |=  [our=@p pax=path]
  ^-  tape
  %-  zing
  :~  "UPDATE lattice-pages SET live = 0 WHERE doc-id = "
      (doc-id our pax)  ";"
  ==
::
++  know-lits
  |=  r=know-row
  ^-  [ky=tape up=tape]
  [(lit-t (trip (spat key.r))) (urq-da updated.r)]
++  know-update
  |=  r=know-row
  ^-  tape
  =+  (know-lits r)
  %-  zing
  :~  "UPDATE lattice-knows SET updated = "  up
      ", live = 1 WHERE know-key = "  ky  ";"
  ==
++  know-insert
  |=  r=know-row
  ^-  tape
  =+  (know-lits r)
  %-  zing
  :~  "INSERT INTO lattice-knows (know-key, updated, live) VALUES ("
      ky  ", "  up  ", 1);"
  ==
++  know-dead
  |=  key=path
  ^-  tape
  %-  zing
  :~  "UPDATE lattice-knows SET live = 0 WHERE know-key = "
      (lit-t (trip (spat key)))  ";"
  ==
::
++  tag-lits
  |=  r=tag-row
  ^-  [id=tape ky=tape tg=tape]
  :*  (key-id key.r tag.r)
      (lit-t (trip (spat key.r)))
      (lit-cord tag.r)
  ==
++  tag-update
  |=  r=tag-row
  ^-  tape
  =+  (tag-lits r)
  %-  zing
  :~  "UPDATE lattice-know-tags SET know-key = "  ky  ", tag = "  tg
      ", live = 1 WHERE tag-id = "  id  ";"
  ==
++  tag-insert
  |=  r=tag-row
  ^-  tape
  =+  (tag-lits r)
  %-  zing
  :~  "INSERT INTO lattice-know-tags (tag-id, know-key, tag, live) VALUES ("
      id  ", "  ky  ", "  tg  ", 1);"
  ==
++  tag-dead
  |=  r=tag-row
  ^-  tape
  %-  zing
  :~  "UPDATE lattice-know-tags SET live = 0 WHERE tag-id = "
      (key-id key.r tag.r)  ";"
  ==
::
++  follow-lits
  |=  r=follow-row
  ^-  [id=tape sp=tape]
  [(lit-ud `@ud`(sham ship.r ~)) (lit-p ship.r)]
++  follow-update
  |=  r=follow-row
  ^-  tape
  =+  (follow-lits r)
  %-  zing
  :~  "UPDATE lattice-follows SET ship = "  sp
      ", live = 1 WHERE follow-id = "  id  ";"
  ==
++  follow-insert
  |=  r=follow-row
  ^-  tape
  =+  (follow-lits r)
  %-  zing
  :~  "INSERT INTO lattice-follows (follow-id, ship, live) VALUES ("
      id  ", "  sp  ", 1);"
  ==
++  follow-dead
  |=  r=follow-row
  ^-  tape
  %-  zing
  :~  "UPDATE lattice-follows SET live = 0 WHERE follow-id = "
      (lit-ud `@ud`(sham ship.r ~))  ";"
  ==
::  visits mirror the history grub, which keeps ONE entry per url with
::  its last visit time and hit count (lib/lattice-history), so a visit
::  row is a doc-id-keyed upsert, not an append-only event. Rows whose
::  source entry has expired out of the history window persist under
::  the best-effort stance the doc gives the seen tables.
::
++  visit-lits
  |=  r=visit-row
  ^-  [id=tape sp=tape px=tape tt=tape ls=tape ht=tape]
  :*  (doc-id ship.r pax.r)
      (lit-p ship.r)
      (lit-t (trip (spat pax.r)))
      (lit-cord title.r)
      (urq-da last.r)
      (lit-ud hits.r)
  ==
++  visit-update
  |=  r=visit-row
  ^-  tape
  =+  (visit-lits r)
  %-  zing
  :~  "UPDATE lattice-visits SET title = "  tt  ", last = "  ls
      ", hits = "  ht  " WHERE doc-id = "  id  ";"
  ==
++  visit-insert
  |=  r=visit-row
  ^-  tape
  =+  (visit-lits r)
  %-  zing
  :~  "INSERT INTO lattice-visits (doc-id, ship, pax, title, last, hits) VALUES ("
      id  ", "  sp  ", "  px  ", "  tt  ", "  ls  ", "  ht  ");"
  ==
::  +batch: join statements into one multi-statement script. Every
::  builder already ends its statement with a semicolon, so this is a
::  plain concatenation with spacing. The caller owns the abort
::  semantics: one bad statement kills the whole poke, so only UPDATE
::  batches (absent rows no-op) ride through here.
::
++  batch
  |=  stmts=(list tape)
  ^-  tape
  ?~  stmts  ""
  =/  all=(list tape)  stmts
  (zing (join " " all))
::  ── reconciler state ────────────────────────────────────────────────
::  +mirror-cursor: the cursor grub's noun (docs/obelisk-mirror.md
::  section 5). beacon is the beacon value of the last completed pass.
::  The per-domain maps are content stamps, and for the curated domains
::  they double as the tombstone basis: a key present here and absent
::  from the source is a row to mark dead. visits keys by the history
::  entry's url cord, its source's own key.
::
+$  mirror-cursor
  $:  beacon=@ud
      pages=(map path @)
      knows=(map path @da)
      tags=(set [path @t])
      follows=(set @p)
      visits=(map @t @)
  ==
::  ── the desk's result vocabulary ────────────────────────────────────
::  These mirror jackfoxy/obelisk sur/obelisk-ast.hoon as SHIPPED, not
::  grubbery's vendored copy, which has drifted: the desk renamed
::  %relation to %relation-name and grew %relations and
::  %select-relation, and a clam through the stale union crashes on
::  every successful result. Arms the mirror never decodes carry
::  opaque payloads.
::
+$  obk-cell    [p=@tas q=dime]
+$  obk-vector  [%vector p=(lest obk-cell)]
+$  obk-result
  $%  [%action action=@t]
      [%relation-name name=@t]
      [%message msg=@t]
      [%vector-count count=@ud]
      [%server-time date=@da]
      [%security-time date=@da]
      [%schema-time date=@da]
      [%data-time date=@da]
      [%result-set p=(list obk-vector)]
      [%relations p=*]
      [%select-relation p=*]
  ==
+$  obk-cmd-result  [%results p=(list obk-result)]
+$  obk-out  (each (list obk-cmd-result) tang)
--
