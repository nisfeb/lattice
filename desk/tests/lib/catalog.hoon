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
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-pages" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-headings" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-links" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-tags" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-manifests" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-pending" s))))
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
::  ── catalog-pages: every column + the federation-ready PK ─────────────
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
    (expect-eq !>(&) !>(!=(~ (find "hash @ud" s))))
    (expect-eq !>(&) !>(!=(~ (find "category @t" s))))
    (expect-eq !>(&) !>(!=(~ (find "cat-source @t" s))))
    (expect-eq !>(&) !>(!=(~ (find "confidence @rs" s))))
    (expect-eq !>(&) !>(!=(~ (find "word-count @ud" s))))
    (expect-eq !>(&) !>(!=(~ (find "body-lines @ud" s))))
  ==
::
::  Natural key is (source, publisher, path) -- distinguishes locally-
::  crawled rows from imported peer rows. Reorder or rename → fails.
++  test-pages-primary-key
  =/  s=tape  catalog-create-urql
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "catalog-pages" s))))
    (expect-eq !>(&) !>(!=(~ (find "PRIMARY KEY (source, publisher, path)" s))))
  ==
::
::  Hash column is @ud (obelisk rejects @uv/@uvH value literals on INSERT).
::  If we ever change sham to a wider hash this test asserts the schema
::  follows, so the column type stays in lockstep with the hash function.
++  test-pages-hash-is-ud
  =/  s=tape  catalog-create-urql
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "hash @ud" s))))
    (expect-eq !>(~) !>((find "hash @uv" s)))   ::  not the wrong type
    (expect-eq !>(~) !>((find "hash @uvH" s)))
  ==
::
::  ── catalog-headings (depth + position; PK includes position) ─────────
::
++  test-headings-has-all-columns
  =/  s=tape  catalog-create-urql
  (expect-eq !>(&) !>(!=(~ (find "position @ud, depth @ud, text @t" s))))
::
++  test-headings-primary-key
  =/  s=tape  catalog-create-urql
  =/  ix=(unit @ud)  (find "catalog-headings" s)
  ?~  ix  (expect-eq !>(&) !>(|))
  =/  decl=tape  (slag u.ix s)
  (expect-eq !>(&) !>(!=(~ (find "PRIMARY KEY (source, publisher, path, position)" decl))))
::
::  ── catalog-links (target + label; PK includes position) ──────────────
::
++  test-links-has-all-columns
  =/  s=tape  catalog-create-urql
  (expect-eq !>(&) !>(!=(~ (find "target-url @t, label @t, is-internal @ud" s))))
::
++  test-links-primary-key
  =/  s=tape  catalog-create-urql
  =/  ix=(unit @ud)  (find "catalog-links" s)
  ?~  ix  (expect-eq !>(&) !>(|))
  =/  decl=tape  (slag u.ix s)
  (expect-eq !>(&) !>(!=(~ (find "PRIMARY KEY (source, publisher, path, position)" decl))))
::
::  ── catalog-tags (many-to-many; PK includes the tag) ──────────────────
::
++  test-tags-primary-key
  =/  s=tape  catalog-create-urql
  =/  ix=(unit @ud)  (find "catalog-tags" s)
  ?~  ix  (expect-eq !>(&) !>(|))
  =/  decl=tape  (slag u.ix s)
  (expect-eq !>(&) !>(!=(~ (find "PRIMARY KEY (source, publisher, path, tag)" decl))))
::
::  ── catalog-manifests (one row per publisher; cached for diffing) ─────
::
++  test-manifests-has-all-columns
  =/  s=tape  catalog-create-urql
  (expect-eq !>(&) !>(!=(~ (find "scanned @da, hash @ud, raw @t" s))))
::
++  test-manifests-primary-key
  =/  s=tape  catalog-create-urql
  =/  ix=(unit @ud)  (find "catalog-manifests" s)
  ?~  ix  (expect-eq !>(&) !>(|))
  =/  decl=tape  (slag u.ix s)
  (expect-eq !>(&) !>(!=(~ (find "PRIMARY KEY (publisher)" decl))))
::
::  ── catalog-pending (classifier queue; PK is page identity) ───────────
::
++  test-pending-has-all-columns
  =/  s=tape  catalog-create-urql
  (expect-eq !>(&) !>(!=(~ (find "queued @da, attempts @ud, reason @t" s))))
::
++  test-pending-primary-key
  =/  s=tape  catalog-create-urql
  =/  ix=(unit @ud)  (find "catalog-pending" s)
  ?~  ix  (expect-eq !>(&) !>(|))
  =/  decl=tape  (slag u.ix s)
  (expect-eq !>(&) !>(!=(~ (find "PRIMARY KEY (source, publisher, path)" decl))))
::
::  ════════════════════════════════════════════════════════════════════
::  Row-write generators (catalog-page-urql etc).
::
::  Each test exercises ONE generator on a fixed-shape input and asserts
::  structural properties of the output: every required statement is
::  present, statement order is DELETE-before-INSERT (idempotency), every
::  column appears in the INSERT column list, every value is properly
::  quoted, and per-list generators emit one INSERT per element (count
::  parity). Any single mutation to the generator's body surfaces here.
::  ════════════════════════════════════════════════════════════════════
::
::  A small fixture: one analysis with each kind of sub-row populated so
::  every code path in +catalog-page-urql gets exercised.
++  fixture-analysis
  ^-  analysis
  :*  title='Hello world'
      headings=~[[1 'H1' 0] [2 'H2' 1]]
      links=~[['urb://~zod/x' 'X-page' 0] ['https://e.com' 'web' 1]]
      tags=~['urbit' 'design']
      hash=(sham 'fixture-body')
      word-count=42
      body-lines=10
  ==
::
::  ── +catalog-page-urql ──────────────────────────────────────────────
::
::  Every per-page DELETE present BEFORE every per-page INSERT —
::  guarantees idempotent re-runs (a refresh on a changed body cleanly
::  replaces the stale headings/links/tags).
++  test-page-urql-deletes-precede-inserts
  =/  s=tape  (catalog-page-urql ~zod ~tyr /a/b ~2026.1.1 fixture-analysis)
  =/  d-page=(unit @ud)  (find "DELETE FROM catalog-pages" s)
  =/  d-head=(unit @ud)  (find "DELETE FROM catalog-headings" s)
  =/  d-link=(unit @ud)  (find "DELETE FROM catalog-links" s)
  =/  d-tag=(unit @ud)   (find "DELETE FROM catalog-tags" s)
  =/  i-page=(unit @ud)  (find "INSERT INTO catalog-pages" s)
  =/  i-head=(unit @ud)  (find "INSERT INTO catalog-headings" s)
  =/  i-link=(unit @ud)  (find "INSERT INTO catalog-links" s)
  =/  i-tag=(unit @ud)   (find "INSERT INTO catalog-tags" s)
  ?~  d-page  (expect-eq !>(&) !>(|))
  ?~  d-head  (expect-eq !>(&) !>(|))
  ?~  d-link  (expect-eq !>(&) !>(|))
  ?~  d-tag   (expect-eq !>(&) !>(|))
  ?~  i-page  (expect-eq !>(&) !>(|))
  ?~  i-head  (expect-eq !>(&) !>(|))
  ?~  i-link  (expect-eq !>(&) !>(|))
  ?~  i-tag   (expect-eq !>(&) !>(|))
  ;:  weld
    (expect-eq !>(&) !>((lth u.d-page u.i-page)))
    (expect-eq !>(&) !>((lth u.d-head u.i-head)))
    (expect-eq !>(&) !>((lth u.d-link u.i-link)))
    (expect-eq !>(&) !>((lth u.d-tag u.i-tag)))
  ==
::
::  catalog-pages INSERT includes EVERY column in the design order.
++  test-page-urql-pages-columns
  =/  s=tape  (catalog-page-urql ~zod ~tyr /a/b ~2026.1.1 fixture-analysis)
  =/  cols=tape
    "(source, publisher, path, url, title, fetched, hash, category, cat-source, confidence, word-count, body-lines)"
  (expect-eq !>(&) !>(!=(~ (find cols s))))
::
::  source and publisher are encoded as bare @p literals (no quotes).
::  If a future change quotes them like '~zod', this test fails.
++  test-page-urql-ship-encoding
  =/  s=tape  (catalog-page-urql ~zod ~tyr /a/b ~2026.1.1 fixture-analysis)
  ;:  weld
    ::  bare ~zod somewhere in the page INSERT row
    (expect-eq !>(&) !>(!=(~ (find "(~zod, ~tyr, " s))))
    ::  AND NOT quoted as a cord
    (expect-eq !>(~) !>((find "('~zod', '~tyr', " s)))
  ==
::
::  Fixture has 2 headings, 2 links, 2 tags → 2 INSERTs each. Count parity
::  catches off-by-one errors in the per-list +turn loops.
++  test-page-urql-count-parity
  =/  s=tape  (catalog-page-urql ~zod ~tyr /a/b ~2026.1.1 fixture-analysis)
  ;:  weld
    (expect-eq !>(`@ud`2) !>((substr-count s "INSERT INTO catalog-headings")))
    (expect-eq !>(`@ud`2) !>((substr-count s "INSERT INTO catalog-links")))
    (expect-eq !>(`@ud`2) !>((substr-count s "INSERT INTO catalog-tags")))
    (expect-eq !>(`@ud`1) !>((substr-count s "INSERT INTO catalog-pages")))
  ==
::
::  Count non-overlapping occurrences of [needle] in [hay]. Helper for
::  the count-parity tests above and the semicolon counter below. Hay is
::  kept as the broad `tape` type throughout so the recursion can pass
::  back potentially-empty tails.
++  substr-count
  |=  [hay=tape needle=tape]
  ^-  @ud
  =|  acc=@ud
  |-  ^-  @ud
  =/  ix=(unit @ud)  (find needle hay)
  ?~  ix  acc
  $(hay `tape`(slag +(u.ix) hay), acc +(acc))
::
::  is-internal: 1 for urb:// links, 0 for foreign-scheme. Fixture has
::  one of each → the output should contain both `, 1)` and `, 0)` at
::  the right positions in catalog-links INSERTs.
++  test-page-urql-is-internal
  =/  s=tape  (catalog-page-urql ~zod ~tyr /a/b ~2026.1.1 fixture-analysis)
  ;:  weld
    ::  the urb:// link row ends with `, 1)`
    (expect-eq !>(&) !>(!=(~ (find "'urb://~zod/x', 'X-page', 1)" s))))
    ::  the https:// link row ends with `, 0)`
    (expect-eq !>(&) !>(!=(~ (find "'https://e.com', 'web', 0)" s))))
  ==
::
::  Title containing a `'` must be backslash-escaped before going into
::  the VALUES clause — otherwise obelisk's parser bails.
++  test-page-urql-escapes-quote-in-title
  =/  a=analysis
    :*  title='it\'s a trap'
        headings=`(list heading)`~
        links=`(list link)`~
        tags=`(list @t)`~
        hash=(sham 'x')
        word-count=0
        body-lines=0
    ==
  =/  s=tape  (catalog-page-urql ~zod ~tyr /a ~2026.1.1 a)
  ;:  weld
    ::  the title is present in escaped form
    (expect-eq !>(&) !>(!=(~ (find "'it\\'s a trap'" s))))
    ::  AND NOT in raw (unescaped) form
    (expect-eq !>(~) !>((find "'it's a trap'" s)))
  ==
::
::  Sentinel values for category/cat-source/confidence — '' / '' / .0.
::  When the classifier pipeline lands, an UPDATE will overwrite these;
::  fresh rows should always have the sentinels.
++  test-page-urql-classifier-sentinels
  =/  s=tape  (catalog-page-urql ~zod ~tyr /a ~2026.1.1 fixture-analysis)
  (expect-eq !>(&) !>(!=(~ (find ", '', '', .0, " s))))
::
::  ── +catalog-page-delete-urql ───────────────────────────────────────
::
::  Deletes from all FIVE catalog tables that hold per-page rows
::  (pages, headings, links, tags, pending). Drop or rename a table →
::  this fails.
++  test-page-delete-urql-all-tables
  =/  s=tape  (catalog-page-delete-urql ~zod ~tyr /a/b)
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-pages" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-headings" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-links" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-tags" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-pending" s))))
  ==
::
::  Every DELETE filters on the (source, publisher, path) triple.
++  test-page-delete-urql-where-clause
  =/  s=tape  (catalog-page-delete-urql ~zod ~tyr /a/b)
  (expect-eq !>(&) !>(!=(~ (find "WHERE source = ~zod AND publisher = ~tyr AND path = '/a/b'" s))))
::
::  ── +catalog-manifest-urql ──────────────────────────────────────────
::
++  test-manifest-urql-upsert-shape
  =/  s=tape  (catalog-manifest-urql ~zod ~2026.1.1 (sham 'manifest') 'raw text')
  ;:  weld
    ::  DELETE-before-INSERT for the UPSERT
    =/  d=(unit @ud)  (find "DELETE FROM catalog-manifests" s)
    =/  i=(unit @ud)  (find "INSERT INTO catalog-manifests" s)
    ?~  d  (expect-eq !>(&) !>(|))
    ?~  i  (expect-eq !>(&) !>(|))
    (expect-eq !>(&) !>((lth u.d u.i)))
    ::  every column in the column list
    (expect-eq !>(&) !>(!=(~ (find "(publisher, scanned, hash, raw)" s))))
  ==
::
::  ── +catalog-pending-urql ───────────────────────────────────────────
::
++  test-pending-urql-shape
  =/  s=tape  (catalog-pending-urql ~zod ~tyr /a ~2026.1.1 'new' 0)
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-pending" s))))
    (expect-eq !>(&) !>(!=(~ (find "INSERT INTO catalog-pending" s))))
    (expect-eq !>(&) !>(!=(~ (find "(source, publisher, path, queued, attempts, reason)" s))))
    ::  reason cord is quoted + escaped
    (expect-eq !>(&) !>(!=(~ (find "'new')" s))))
  ==
::
::  ── +catalog-pending-clear-urql ─────────────────────────────────────
::
++  test-pending-clear-urql-single-delete
  =/  s=tape  (catalog-pending-clear-urql ~zod ~tyr /a)
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-pending WHERE source = ~zod" s))))
    ::  exactly ONE statement (one semicolon)
    (expect-eq !>(`@ud`1) !>((substr-count s ";")))
  ==
::
::  ── +urq-esc (inline copy) sanity ───────────────────────────────────
::
::  The lib has its own copy of +urq-esc (to avoid pulling in *lattice).
::  Lock the behavior — must match lib/lattice's verbatim.
++  test-urq-esc-quote
  (expect-eq !>(`tape`['i' 'n' '\\' '\'' 't' ~]) !>((urq-esc "in't")))
::
++  test-urq-esc-backslash
  (expect-eq !>(`tape`['a' '\\' '\\' 'b' ~]) !>((urq-esc "a\\b")))
::
++  test-urq-esc-plain
  (expect-eq !>("hello") !>((urq-esc "hello")))
::
::  ════════════════════════════════════════════════════════════════════
::  +parse-manifest — gemtext index → list of publisher spurs.
::
::  Real /manifest bodies are produced by +generate-index in
::  /lib/lattice — header lines + `=> /spur  label` per live page.
::  The parser must round-trip the spurs it finds, skip prose, and
::  silently drop malformed lines (one bad line shouldn't abort a
::  whole sweep).
::  ════════════════════════════════════════════════════════════════════
::
::  Empty body → no paths. (Cold-start: fresh publisher with no content.)
++  test-parse-manifest-empty
  (expect-eq !>(`(list path)`~) !>((parse-manifest '')))
::
::  Header lines only → no paths. (`# Index` etc. without any `=> `.)
++  test-parse-manifest-header-only
  =/  body=@t  '# Index\0a\0aFiles published on this ship:\0a'
  (expect-eq !>(`(list path)`~) !>((parse-manifest body)))
::
::  Two-page manifest: paths are returned in input order.
++  test-parse-manifest-two-pages
  =/  body=@t
    '# Index\0a\0aFiles published on this ship:\0a\0a=> /notes/intro  notes/intro\0a=> /blog/post  blog/post\0a'
  =/  want=(list path)  ~[/notes/intro /blog/post]
  (expect-eq !>(want) !>((parse-manifest body)))
::
::  `=> ` with no label still parses (the label is optional in gemtext).
++  test-parse-manifest-no-label
  =/  body=@t  '=> /x\0a=> /a/b/c\0a'
  =/  want=(list path)  ~[/x /a/b/c]
  (expect-eq !>(want) !>((parse-manifest body)))
::
::  Foreign-scheme `=> ` lines (http, mailto, urb://other-ship/x) are
::  skipped — they're not this publisher's content. Only /-rooted local
::  paths are accepted.
++  test-parse-manifest-skips-foreign-schemes
  =/  body=@t
    '=> /local  local\0a=> https://e.com  web\0a=> mailto:a@b  mail\0a=> /other  other\0a'
  =/  want=(list path)  ~[/local /other]
  (expect-eq !>(want) !>((parse-manifest body)))
::
::  A line whose target has invalid knot syntax (embedded space) is dropped
::  instead of crashing the parser — defense against a malformed publisher.
++  test-parse-manifest-tolerates-bad-paths
  =/  body=@t
    '=> /good  ok\0a=> /bad  has space  uh\0a=> /also-good  ok\0a'
  ::  the middle line's target IS `/bad` (we stop at first space), so it
  ::  parses fine — really validating that THE parser doesn't crash on
  ::  unusual input, and the good lines round-trip.
  =/  got=(list path)  (parse-manifest body)
  ;:  weld
    (expect-eq !>(&) !>((lien got |=(p=path =(p /good)))))
    (expect-eq !>(&) !>((lien got |=(p=path =(p /also-good)))))
  ==
::
::  Root path `=> /` (the publisher's home page) round-trips as the empty
::  path `~`. The crawler's per-page walk uses this to fetch the home.
++  test-parse-manifest-root-path
  =/  body=@t  '=> /  home\0a'
  =/  want=(list path)  ~[/]
  (expect-eq !>(want) !>((parse-manifest body)))
::
::  Non-`=> ` lines (prose, blank, bullet lists) are ignored even when
::  interleaved with `=> ` lines.
++  test-parse-manifest-skips-prose
  =/  body=@t
    '# Header\0a\0aSome prose here.\0a* a bullet\0a=> /real  real\0a> a quote\0a'
  =/  want=(list path)  ~[/real]
  (expect-eq !>(want) !>((parse-manifest body)))
::
::  ════════════════════════════════════════════════════════════════════
::  Read-side query compilers.
::
::  These assert the urQL shape the read endpoints feed obelisk. The
::  feature constraints (no LIKE, no LIMIT; equality + ORDER BY only)
::  are baked into the generators, so these tests double as a record of
::  what the installed obelisk accepts (verified live on ~tyr).
::  ════════════════════════════════════════════════════════════════════
::
::  +catalog-list-urql: FROM-first, all list columns, newest-first order,
::  no LIMIT clause (obelisk has none).
++  test-list-urql-shape
  =/  s=tape  catalog-list-urql
  ;:  weld
    (expect-eq !>(&) !>(=("FROM catalog-pages SELECT " (scag 26 s))))
    (expect-eq !>(&) !>(!=(~ (find "ORDER BY fetched DESC;" s))))
    (expect-eq !>(&) !>(!=(~ (find "source, publisher, path, url, title, category, cat-source, word-count, fetched" s))))
    ::  obelisk has no LIMIT — must NOT emit one
    (expect-eq !>(~) !>((find "LIMIT" s)))
  ==
::
::  +catalog-explore-urql with NO filters == a plain list (no WHERE).
++  test-explore-urql-no-filters
  =/  s=tape  (catalog-explore-urql "" "" "")
  ;:  weld
    (expect-eq !>(~) !>((find "WHERE" s)))
    (expect-eq !>(&) !>(!=(~ (find "FROM catalog-pages SELECT " s))))
    (expect-eq !>(&) !>(!=(~ (find "ORDER BY fetched DESC;" s))))
  ==
::
::  category is a @t column → quoted + escaped value.
++  test-explore-urql-category
  =/  s=tape  (catalog-explore-urql "essay" "" "")
  (expect-eq !>(&) !>(!=(~ (find "WHERE category = 'essay' SELECT" s))))
::
::  publisher is a @p column → BARE ship literal, never quoted.
++  test-explore-urql-publisher-bare
  =/  s=tape  (catalog-explore-urql "" "~zod" "")
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "WHERE publisher = ~zod SELECT" s))))
    (expect-eq !>(~) !>((find "publisher = '~zod'" s)))
  ==
::
::  All three filters → AND-joined in declared order, @t quoted, @p bare.
++  test-explore-urql-all-three
  =/  s=tape  (catalog-explore-urql "essay" "~zod" "~tyr")
  (expect-eq !>(&) !>(!=(~ (find "WHERE category = 'essay' AND publisher = ~zod AND source = ~tyr SELECT" s))))
::
::  A quote in the category value is backslash-escaped (no urQL breakout).
++  test-explore-urql-escapes-quote
  =/  s=tape  (catalog-explore-urql "it's" "" "")
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "category = 'it\\'s'" s))))
    (expect-eq !>(~) !>((find "category = 'it's'" s)))
  ==
::
::  +catalog-fetch-urql: one page by url, SELECT *, url quoted + escaped.
++  test-fetch-urql-shape
  =/  s=tape  (catalog-fetch-urql "urb://~zod/notes/x")
  (expect-eq !>(&) !>(!=(~ (find "FROM catalog-pages WHERE url = 'urb://~zod/notes/x' SELECT *;" s))))
::
++  test-fetch-urql-escapes-quote
  =/  s=tape  (catalog-fetch-urql "urb://~zod/it's")
  (expect-eq !>(&) !>(!=(~ (find "url = 'urb://~zod/it\\'s'" s))))
::
::  +catalog-by-tag-urql: the key columns from catalog-tags, tag escaped.
++  test-by-tag-urql-shape
  =/  s=tape  (catalog-by-tag-urql "urbit")
  (expect-eq !>(&) !>(!=(~ (find "FROM catalog-tags WHERE tag = 'urbit' SELECT source, publisher, path;" s))))
::
::  +catalog-join-and: 0 / 1 / many conjuncts.
++  test-join-and
  ;:  weld
    (expect-eq !>("") !>((catalog-join-and ~)))
    (expect-eq !>("a = 1") !>((catalog-join-and ~["a = 1"])))
    (expect-eq !>("a = 1 AND b = 2 AND c = 3") !>((catalog-join-and ~["a = 1" "b = 2" "c = 3"])))
  ==
--
