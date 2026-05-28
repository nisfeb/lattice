::  Unit tests for /lib/catalog.  Run with:
::    -test /=lattice=/tests/lib/catalog ~
::
::  These are mutation-resistant structural tests on +catalog-create-urql's
::  output -- any single deletion or rename of a table, column, type, or
::  primary key in the generator surfaces as a failing assertion below.
::
::  The substring assertions are tight enough to catch typos
::  (e.g. `confidence @ud` instead of `confidence @rs`, or
::  `PRIMARY KEY (publisher, source, path)` instead of the natural order)
::  without being so brittle that a whitespace tweak breaks them.
::
/+  *test, *catalog
|%
::  ── tables present (drop or rename a table → these fail) ──────────────
::
++  test-creates-all-six-tables
  =/  s=tape  catalog-create-urql
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog_pages" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog_headings" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog_links" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog_tags" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog_manifests" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog_pending" s))))
  ==
::
::  One semicolon per CREATE TABLE statement -- catches a missing terminator
::  before obelisk's parser does.
++  test-six-semicolons
  =/  s=tape  catalog-create-urql
  =/  sc=@ud
    =|  n=@ud
    |-
    ?~  s  n
    ?:(=(';' i.s) $(s t.s, n +(n)) $(s t.s))
  (expect-eq !>(`@ud`6) !>(sc))
::
::  Generator is deterministic -- two calls yield identical tapes.
++  test-deterministic
  (expect-eq !>(catalog-create-urql) !>(catalog-create-urql))
::
::  Output is pure printable bytes -- no nulls that would break the obelisk
::  poke envelope's @t encoding.
++  test-no-null-bytes
  =/  s=tape  catalog-create-urql
  =/  has-null=?
    |-
    ?~  s  |
    ?:(=(`@tD`0 i.s) & $(s t.s))
  (expect-eq !>(|) !>(has-null))
::
::  ── catalog_pages: every column + the federation-ready PK ─────────────
::
++  test-pages-has-all-columns
  =/  s=tape  catalog-create-urql
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "source @p" s))))
    (expect-eq !>(&) !>(!=(~ (find "publisher @p" s))))
    (expect-eq !>(&) !>(!=(~ (find "path @t" s))))
    (expect-eq !>(&) !>(!=(~ (find "url @t" s))))
    (expect-eq !>(&) !>(!=(~ (find "title @t" s))))
    (expect-eq !>(&) !>(!=(~ (find "fetched @da" s))))
    (expect-eq !>(&) !>(!=(~ (find "hash @uvH" s))))
    (expect-eq !>(&) !>(!=(~ (find "category @t" s))))
    (expect-eq !>(&) !>(!=(~ (find "cat_source @t" s))))
    (expect-eq !>(&) !>(!=(~ (find "confidence @rs" s))))
    (expect-eq !>(&) !>(!=(~ (find "word_count @ud" s))))
    (expect-eq !>(&) !>(!=(~ (find "body_lines @ud" s))))
  ==
::
::  Natural key is (source, publisher, path) -- distinguishes locally-
::  crawled rows from imported peer rows. Reorder or rename → fails.
++  test-pages-primary-key
  =/  s=tape  catalog-create-urql
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "catalog_pages" s))))
    (expect-eq !>(&) !>(!=(~ (find "PRIMARY KEY (source, publisher, path)" s))))
  ==
::
::  Hash type is @uvH -- matches +sham's return and state.manifest's type.
::  If we ever change sham to a wider hash this test asserts the schema
::  follows, so the column type stays in lockstep with the hash function.
++  test-pages-hash-is-uvh
  =/  s=tape  catalog-create-urql
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "hash @uvH" s))))
    (expect-eq !>(~) !>((find "hash @uvJ" s)))   ::  not the wrong type
    (expect-eq !>(~) !>((find "hash @uvK" s)))
  ==
::
::  ── catalog_headings (depth + position; PK includes position) ─────────
::
++  test-headings-has-all-columns
  =/  s=tape  catalog-create-urql
  (expect-eq !>(&) !>(!=(~ (find "position @ud, depth @ud, text @t" s))))
::
++  test-headings-primary-key
  =/  s=tape  catalog-create-urql
  =/  ix=(unit @ud)  (find "catalog_headings" s)
  ?~  ix  (expect-eq !>(&) !>(|))
  =/  decl=tape  (slag u.ix s)
  (expect-eq !>(&) !>(!=(~ (find "PRIMARY KEY (source, publisher, path, position)" decl))))
::
::  ── catalog_links (target + label; PK includes position) ──────────────
::
++  test-links-has-all-columns
  =/  s=tape  catalog-create-urql
  (expect-eq !>(&) !>(!=(~ (find "target_url @t, label @t, is_internal @ud" s))))
::
++  test-links-primary-key
  =/  s=tape  catalog-create-urql
  =/  ix=(unit @ud)  (find "catalog_links" s)
  ?~  ix  (expect-eq !>(&) !>(|))
  =/  decl=tape  (slag u.ix s)
  (expect-eq !>(&) !>(!=(~ (find "PRIMARY KEY (source, publisher, path, position)" decl))))
::
::  ── catalog_tags (many-to-many; PK includes the tag) ──────────────────
::
++  test-tags-primary-key
  =/  s=tape  catalog-create-urql
  =/  ix=(unit @ud)  (find "catalog_tags" s)
  ?~  ix  (expect-eq !>(&) !>(|))
  =/  decl=tape  (slag u.ix s)
  (expect-eq !>(&) !>(!=(~ (find "PRIMARY KEY (source, publisher, path, tag)" decl))))
::
::  ── catalog_manifests (one row per publisher; cached for diffing) ─────
::
++  test-manifests-has-all-columns
  =/  s=tape  catalog-create-urql
  (expect-eq !>(&) !>(!=(~ (find "scanned @da, hash @uvH, raw @t" s))))
::
++  test-manifests-primary-key
  =/  s=tape  catalog-create-urql
  =/  ix=(unit @ud)  (find "catalog_manifests" s)
  ?~  ix  (expect-eq !>(&) !>(|))
  =/  decl=tape  (slag u.ix s)
  (expect-eq !>(&) !>(!=(~ (find "PRIMARY KEY (publisher)" decl))))
::
::  ── catalog_pending (classifier queue; PK is page identity) ───────────
::
++  test-pending-has-all-columns
  =/  s=tape  catalog-create-urql
  (expect-eq !>(&) !>(!=(~ (find "queued @da, attempts @ud, reason @t" s))))
::
++  test-pending-primary-key
  =/  s=tape  catalog-create-urql
  =/  ix=(unit @ud)  (find "catalog_pending" s)
  ?~  ix  (expect-eq !>(&) !>(|))
  =/  decl=tape  (slag u.ix s)
  (expect-eq !>(&) !>(!=(~ (find "PRIMARY KEY (source, publisher, path)" decl))))
--
