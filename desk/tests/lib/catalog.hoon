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
  =/  d-page=(unit @ud)  (find "DELETE FROM catalog_pages" s)
  =/  d-head=(unit @ud)  (find "DELETE FROM catalog_headings" s)
  =/  d-link=(unit @ud)  (find "DELETE FROM catalog_links" s)
  =/  d-tag=(unit @ud)   (find "DELETE FROM catalog_tags" s)
  =/  i-page=(unit @ud)  (find "INSERT INTO catalog_pages" s)
  =/  i-head=(unit @ud)  (find "INSERT INTO catalog_headings" s)
  =/  i-link=(unit @ud)  (find "INSERT INTO catalog_links" s)
  =/  i-tag=(unit @ud)   (find "INSERT INTO catalog_tags" s)
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
::  catalog_pages INSERT includes EVERY column in the design order.
++  test-page-urql-pages-columns
  =/  s=tape  (catalog-page-urql ~zod ~tyr /a/b ~2026.1.1 fixture-analysis)
  =/  cols=tape
    "(source, publisher, path, url, title, fetched, hash, category, cat_source, confidence, word_count, body_lines)"
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
    (expect-eq !>(`@ud`2) !>((substr-count s "INSERT INTO catalog_headings")))
    (expect-eq !>(`@ud`2) !>((substr-count s "INSERT INTO catalog_links")))
    (expect-eq !>(`@ud`2) !>((substr-count s "INSERT INTO catalog_tags")))
    (expect-eq !>(`@ud`1) !>((substr-count s "INSERT INTO catalog_pages")))
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
::  is_internal: 1 for urb:// links, 0 for foreign-scheme. Fixture has
::  one of each → the output should contain both `, 1)` and `, 0)` at
::  the right positions in catalog_links INSERTs.
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
::  Sentinel values for category/cat_source/confidence — '' / '' / .0.
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
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog_pages" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog_headings" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog_links" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog_tags" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog_pending" s))))
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
    =/  d=(unit @ud)  (find "DELETE FROM catalog_manifests" s)
    =/  i=(unit @ud)  (find "INSERT INTO catalog_manifests" s)
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
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog_pending" s))))
    (expect-eq !>(&) !>(!=(~ (find "INSERT INTO catalog_pending" s))))
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
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog_pending WHERE source = ~zod" s))))
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
--
