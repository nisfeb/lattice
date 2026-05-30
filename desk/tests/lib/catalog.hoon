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
++  test-creates-all-eight-tables
  =/  s=tape  catalog-create-urql
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-pages" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-headings" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-links" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-tags" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-manifests" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-pending" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-terms" s))))
    (expect-eq !>(&) !>(!=(~ (find "CREATE TABLE catalog-meta" s))))
  ==
::
::  One semicolon per CREATE TABLE statement -- catches a missing terminator
::  before obelisk's parser does. Eight tables (added catalog-terms +
::  catalog-meta for the lexical index + author metadata).
++  test-eight-semicolons
  =/  s=tape  catalog-create-urql
  =/  sc=@ud
    =|  n=@ud
    |-
    ?~  s  n
    ?:(=(';' i.s) $(s t.s, n +(n)) $(s t.s))
  (expect-eq !>(`@ud`8) !>(sc))
::
::  +catalog-create-list is ONE create per element. Regression guard for the
::  in-place-upgrade bug: the agent pokes each CREATE separately, because a
::  joined CREATE poke aborts at the first already-existing table (CREATE on an
::  existing table ERRORS) and never creates the ones after it — which silently
::  dropped catalog-terms/catalog-meta on an upgraded ship.
++  test-create-list-one-create-per-statement
  =/  lst=(list tape)  catalog-create-list
  ;:  weld
    (expect-eq !>(`@ud`8) !>((lent lst)))
    ::  each element holds exactly one statement terminator
    (expect-eq !>(&) !>((levy lst |=(t=tape =(`@ud`1 (substr-count t ";"))))))
    ::  the joined form equals catalog-create-urql (what the tests assert on)
    (expect-eq !>(catalog-create-urql) !>(`tape`(zing lst)))
  ==
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
      terms=~
      author-category=''
      summary=''
  ==
::
::  ── +catalog-page-ensure-urql / +catalog-page-refresh-urql ──────────
::
::  The page row is written by a two-poke upsert (see the lib): an
::  ensure-INSERT (create-if-absent, harmless dup) + a refresh-UPDATE
::  (content-only, so a re-crawl can't clobber a classification) that also
::  DELETE+re-INSERTs the child rows. These pin both halves.
::
::  empty pages set for gates that take one — is-internal of a urb:// link
::  doesn't consult the set (relative resolution is tested via +link-internal).
++  no-pages  ^-((set path) ~)
::
::  ensure: a SINGLE INSERT INTO catalog-pages, every column, sentinel
::  classification. No UPDATE, no DELETE — it's create-if-absent.
++  test-ensure-urql-single-insert
  =/  s=tape  (catalog-page-ensure-urql ~zod ~tyr /a/b ~2026.1.1 fixture-analysis)
  =/  cols=tape
    "(source, publisher, path, url, title, fetched, hash, category, cat-source, confidence, word-count, body-lines)"
  ;:  weld
    (expect-eq !>(`@ud`1) !>((substr-count s "INSERT INTO catalog-pages")))
    (expect-eq !>(~) !>((find "UPDATE " s)))
    (expect-eq !>(~) !>((find "DELETE " s)))
    ::  every column in design order
    (expect-eq !>(&) !>(!=(~ (find cols s))))
    ::  sentinel classification ('' / '' / .0)
    (expect-eq !>(&) !>(!=(~ (find ", '', '', .0, " s))))
    ::  bare @p literals (not quoted cords)
    (expect-eq !>(&) !>(!=(~ (find "(~zod, ~tyr, " s))))
    (expect-eq !>(~) !>((find "('~zod', '~tyr', " s)))
  ==
::
::  ensure backslash-escapes a quote in the title before the VALUES clause.
++  test-ensure-urql-escapes-quote-in-title
  =/  a=analysis
    :*  title='it\'s a trap'
        headings=`(list heading)`~  links=`(list link)`~  tags=`(list @t)`~
        hash=(sham 'x')  word-count=0  body-lines=0
        terms=~  author-category=''  summary=''
    ==
  =/  s=tape  (catalog-page-ensure-urql ~zod ~tyr /a ~2026.1.1 a)
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "'it\\'s a trap'" s))))
    (expect-eq !>(~) !>((find "'it's a trap'" s)))
  ==
::
::  refresh: an UPDATE of catalog-pages that names ONLY content columns —
::  never category/cat-source/confidence. THIS is what preserves a
::  classification across a periodic re-crawl; the single most important
::  invariant of the whole upsert. It must also NOT INSERT a page row.
++  test-refresh-urql-update-omits-classification
  =/  s=tape  (catalog-page-refresh-urql ~zod ~tyr /a/b ~2026.1.1 fixture-analysis no-pages)
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "UPDATE catalog-pages SET " s))))
    (expect-eq !>(&) !>(!=(~ (find "title = '" s))))
    (expect-eq !>(&) !>(!=(~ (find "word-count = " s))))
    ::  classification columns ABSENT from the entire refresh tape
    (expect-eq !>(~) !>((find "category = " s)))
    (expect-eq !>(~) !>((find "cat-source = " s)))
    (expect-eq !>(~) !>((find "confidence = " s)))
    ::  refresh never re-inserts the page row (ensure owns that)
    (expect-eq !>(~) !>((find "INSERT INTO catalog-pages" s)))
  ==
::
::  refresh fully replaces child rows: every child DELETE precedes its
::  INSERTs (and there is NO catalog-pages DELETE — the row persists).
++  test-refresh-urql-child-deletes-precede-inserts
  =/  s=tape  (catalog-page-refresh-urql ~zod ~tyr /a/b ~2026.1.1 fixture-analysis no-pages)
  =/  d-head=(unit @ud)  (find "DELETE FROM catalog-headings" s)
  =/  d-link=(unit @ud)  (find "DELETE FROM catalog-links" s)
  =/  d-tag=(unit @ud)   (find "DELETE FROM catalog-tags" s)
  =/  i-head=(unit @ud)  (find "INSERT INTO catalog-headings" s)
  =/  i-link=(unit @ud)  (find "INSERT INTO catalog-links" s)
  =/  i-tag=(unit @ud)   (find "INSERT INTO catalog-tags" s)
  ?~  d-head  (expect-eq !>(&) !>(|))
  ?~  d-link  (expect-eq !>(&) !>(|))
  ?~  d-tag   (expect-eq !>(&) !>(|))
  ?~  i-head  (expect-eq !>(&) !>(|))
  ?~  i-link  (expect-eq !>(&) !>(|))
  ?~  i-tag   (expect-eq !>(&) !>(|))
  ;:  weld
    (expect-eq !>(~) !>((find "DELETE FROM catalog-pages" s)))
    (expect-eq !>(&) !>((lth u.d-head u.i-head)))
    (expect-eq !>(&) !>((lth u.d-link u.i-link)))
    (expect-eq !>(&) !>((lth u.d-tag u.i-tag)))
  ==
::
::  refresh child-row count parity (fixture: 2 headings, 2 links, 2 tags).
++  test-refresh-urql-count-parity
  =/  s=tape  (catalog-page-refresh-urql ~zod ~tyr /a/b ~2026.1.1 fixture-analysis no-pages)
  ;:  weld
    (expect-eq !>(`@ud`2) !>((substr-count s "INSERT INTO catalog-headings")))
    (expect-eq !>(`@ud`2) !>((substr-count s "INSERT INTO catalog-links")))
    (expect-eq !>(`@ud`2) !>((substr-count s "INSERT INTO catalog-tags")))
  ==
::
::  is-internal in refresh output: the fixture's urb:// link → 1, https → 0
::  (with an empty pages set — urb:// doesn't need set membership).
++  test-refresh-urql-is-internal
  =/  s=tape  (catalog-page-refresh-urql ~zod ~tyr /a/b ~2026.1.1 fixture-analysis no-pages)
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "'urb://~zod/x', 'X-page', 1)" s))))
    (expect-eq !>(&) !>(!=(~ (find "'https://e.com', 'web', 0)" s))))
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
::  ── +link-internal (the is-internal resolver) ──────────────────────
::  urb:// is always internal; a /-rooted spur is internal iff it's in the
::  publisher's manifest set; foreign schemes and dangling relative links
::  are external; bad knot syntax is external (not a crash).
++  test-link-internal-urb
  (expect-eq !>(&) !>((link-internal "urb://~zod/x" *(set path))))
::
++  test-link-internal-relative-in-set
  =/  pages=(set path)  (silt ~[/notes/world /blog/intro])
  (expect-eq !>(&) !>((link-internal "/notes/world" pages)))
::
::  the regression this fixes: a relative link to a page the publisher
::  DOES publish must be internal (the old urb://-only heuristic missed it).
++  test-link-internal-relative-not-in-set
  =/  pages=(set path)  (silt ~[/notes/world])
  (expect-eq !>(|) !>((link-internal "/nope" pages)))
::
++  test-link-internal-http-external
  =/  pages=(set path)  (silt ~[/notes/world])
  (expect-eq !>(|) !>((link-internal "https://urbit.org" pages)))
::
++  test-link-internal-bad-syntax
  ::  /-rooted but illegal knot (embedded space) → external, mule-guarded.
  (expect-eq !>(|) !>((link-internal "/has space" *(set path))))
::
::  ── +catalog-page-delete-urql ───────────────────────────────────────
::
::  Deletes from all SEVEN catalog tables that hold per-page rows (pages,
::  headings, links, tags, pending, terms, meta). Drop or rename a table →
::  this fails. catalog-terms + catalog-meta were added with the lexical
::  index + author metadata; leaving them out orphans postings/summaries.
++  test-page-delete-urql-all-tables
  =/  s=tape  (catalog-page-delete-urql ~zod ~tyr /a/b)
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-pages" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-headings" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-links" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-tags" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-pending" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-terms" s))))
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-meta" s))))
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
::  Lock the behavior — escapes ' and \, and replaces control bytes (< 32)
::  with spaces so a raw newline/CR can't abort an obelisk poke.
++  test-urq-esc-quote
  (expect-eq !>(`tape`['i' 'n' '\\' '\'' 't' ~]) !>((urq-esc "in't")))
::
++  test-urq-esc-backslash
  (expect-eq !>(`tape`['a' '\\' '\\' 'b' ~]) !>((urq-esc "a\\b")))
::
++  test-urq-esc-plain
  (expect-eq !>("hello") !>((urq-esc "hello")))
::
::  control bytes — newline (10), CR (13), tab (9) — become spaces, so a
::  multi-line manifest or a CRLF-authored page can't terminate a literal early.
++  test-urq-esc-strips-control
  ;:  weld
    (expect-eq !>(`tape`['a' ' ' 'b' ~]) !>((urq-esc `tape`['a' `@tD`10 'b' ~])))
    (expect-eq !>(`tape`['a' ' ' 'b' ~]) !>((urq-esc `tape`['a' `@tD`13 'b' ~])))
    (expect-eq !>(`tape`['x' ' ' 'y' ~]) !>((urq-esc `tape`['x' `@tD`9 'y' ~])))
    ::  a CRLF pair collapses to two spaces; ' is still escaped alongside
    (expect-eq !>(`tape`[' ' ' ' '\\' '\'' ~]) !>((urq-esc `tape`[`@tD`13 `@tD`10 '\'' ~])))
  ==
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
::  Duplicate `=> /x` lines collapse to one spur (first-occurrence order).
::  Critical: the crawler keys walks by (now, publisher, spur), so duplicate
::  spurs spawned in one event would collide to one eid and orphan a keen.
++  test-parse-manifest-dedupes
  =/  body=@t
    '=> /a  a\0a=> /b  b\0a=> /a  a-again\0a=> /c  c\0a=> /b  b-again\0a'
  =/  want=(list path)  ~[/a /b /c]
  (expect-eq !>(want) !>((parse-manifest body)))
::
::  +dedupe-paths directly: empty, no-dups, all-dups, order preservation.
++  test-dedupe-paths
  ;:  weld
    (expect-eq !>(`(list path)`~) !>((dedupe-paths ~)))
    (expect-eq !>(`(list path)`~[/a /b /c]) !>((dedupe-paths ~[/a /b /c])))
    (expect-eq !>(`(list path)`~[/a]) !>((dedupe-paths ~[/a /a /a])))
    (expect-eq !>(`(list path)`~[/x /y /z]) !>((dedupe-paths ~[/x /y /x /z /y /x])))
  ==
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
::  ════════════════════════════════════════════════════════════════════
::  Classifier pipeline generators.
::  ════════════════════════════════════════════════════════════════════
::
::  +catalog-pending-list-urql: the worklist filters category = '' and orders
::  newest-first; obelisk has no LIMIT so none is emitted.
++  test-pending-list-urql-shape
  =/  s=tape  catalog-pending-list-urql
  ;:  weld
    ::  FROM-first, filters the unclassified sentinel, at the very start.
    (expect-eq !>(`(unit @ud)`[~ 0]) !>((find "FROM catalog-pages WHERE category = ''" s)))
    (expect-eq !>(&) !>(!=(~ (find "ORDER BY fetched DESC;" s))))
    (expect-eq !>(~) !>((find "LIMIT" s)))
  ==
::
::  +catalog-classify-urql: a pure UPDATE naming ONLY the classification
::  columns (never content), keyed on (source, publisher, path). @rs
::  confidence is emitted via +scot %rs as a `.85`-style float literal.
++  test-classify-urql-shape
  =/  s=tape  (catalog-classify-urql ~tyr ~zod /blog/intro 'essay' 'llm' .85)
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "UPDATE catalog-pages SET category = 'essay'" s))))
    (expect-eq !>(&) !>(!=(~ (find "cat-source = 'llm'" s))))
    (expect-eq !>(&) !>(!=(~ (find "confidence = .85" s))))
    (expect-eq !>(&) !>(!=(~ (find "WHERE source = ~tyr AND publisher = ~zod AND path = '/blog/intro'" s))))
    ::  must NOT touch content columns
    (expect-eq !>(~) !>((find "title = " s)))
    (expect-eq !>(~) !>((find "url = " s)))
  ==
::
::  classify escapes a quote in the category cord (injection safety).
++  test-classify-urql-escapes-quote
  =/  s=tape  (catalog-classify-urql ~tyr ~zod /a 'a\'b' 'llm' .0)
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "category = 'a\\'b'" s))))
    (expect-eq !>(~) !>((find "category = 'a'b'" s)))
  ==
::
::  +catalog-vocab-urql: every page's category column, FROM-first, no
::  DISTINCT (obelisk has none — the caller dedupes).
++  test-vocab-urql-shape
  =/  s=tape  catalog-vocab-urql
  ;:  weld
    (expect-eq !>(&) !>(=("FROM catalog-pages WHERE cat-source != 'author' SELECT category;" s)))
    ::  author-declared categories are excluded so a crawled peer can't seed the
    ::  shared taxonomy the classifier reuses to label other pages.
    (expect-eq !>(&) !>(!=(~ (find "cat-source != 'author'" s))))
    (expect-eq !>(~) !>((find "DISTINCT" s)))
  ==
::
::  +catalog-join-and: 0 / 1 / many conjuncts.
++  test-join-and
  ;:  weld
    (expect-eq !>("") !>((catalog-join-and ~)))
    (expect-eq !>("a = 1") !>((catalog-join-and ~["a = 1"])))
    (expect-eq !>("a = 1 AND b = 2 AND c = 3") !>((catalog-join-and ~["a = 1" "b = 2" "c = 3"])))
  ==
::
::  +sweep-publishers: UNION of follow ships and contacts, unique, minus self.
++  test-sweep-publishers
  =/  empty=(map [=ship spur=path] @ud)  ~
  =/  subs=(map [=ship spur=path] @ud)
    %-  malt
    ^-  (list [[=ship spur=path] @ud])
    :~  [[~zod /notes/a] 0]
        [[~zod /notes/b] 0]
        [[~bus /blog] 0]
        [[~nec /x] 0]
    ==
  ::  contacts: ~dev is a contact we don't follow; ~zod is both; ~nec is self.
  =/  contacts=(set @p)  (sy ~[~dev ~zod ~nec])
  =/  got=(list @p)  (sweep-publishers subs contacts ~nec)
  ;:  weld
    ::  no follows, no contacts → empty
    (expect-eq !>(`(list @p)`~) !>((sweep-publishers empty *(set @p) ~nec)))
    ::  union {~zod,~bus,~nec}(follows) ∪ {~dev,~zod,~nec}(contacts) minus ~nec
    ::  = {~zod,~bus,~dev} — 3 ships, ~zod deduped, self dropped
    (expect-eq !>(`@ud`3) !>((lent got)))
    (expect-eq !>(&) !>((lien got |=(p=@p =(p ~zod)))))
    (expect-eq !>(&) !>((lien got |=(p=@p =(p ~bus)))))
    ::  ~dev is crawled even though it is only a CONTACT, never followed
    (expect-eq !>(&) !>((lien got |=(p=@p =(p ~dev)))))
    (expect-eq !>(|) !>((lien got |=(p=@p =(p ~nec)))))
    ::  a contact-only set with no follows still yields the contacts (minus self)
    (expect-eq !>(`@ud`2) !>((lent (sweep-publishers empty (sy ~[~dev ~bus ~nec]) ~nec))))
  ==
::
::  ── +catalog-page-terms-urql (inverted index, feature B) ─────────────
::  DELETE-then-INSERT replace: one DELETE clears the page's prior postings,
::  one INSERT per (term, tf). NO body text is emitted — only the postings.
++  fixture-terms-analysis
  ^-  analysis
  :*  title='Hello world'
      headings=`(list heading)`~  links=`(list link)`~  tags=`(list @t)`~
      hash=(sham 'x')  word-count=0  body-lines=0
      terms=~[['lattice' 3] ['catalog' 1]]
      author-category=''  summary=''
  ==
++  test-terms-urql-delete-then-insert
  =/  s=tape  (catalog-page-terms-urql ~zod ~tyr /a/b fixture-terms-analysis)
  =/  d=(unit @ud)  (find "DELETE FROM catalog-terms" s)
  =/  i=(unit @ud)  (find "INSERT INTO catalog-terms" s)
  ?~  d  (expect-eq !>(&) !>(|))
  ?~  i  (expect-eq !>(&) !>(|))
  ;:  weld
    ::  the DELETE precedes the INSERTs (clears the slate so no dup-key abort)
    (expect-eq !>(&) !>((lth u.d u.i)))
    ::  one INSERT per posting (the fixture has 2)
    (expect-eq !>(`@ud`2) !>((substr-count s "INSERT INTO catalog-terms")))
    ::  the (term, tf) values land
    (expect-eq !>(&) !>(!=(~ (find "'lattice', 3)" s))))
    (expect-eq !>(&) !>(!=(~ (find "'catalog', 1)" s))))
  ==
::  empty terms → only the DELETE (clear stale), no INSERT.
++  test-terms-urql-empty
  =/  s=tape  (catalog-page-terms-urql ~zod ~tyr /a/b fixture-analysis)
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-terms" s))))
    (expect-eq !>(~) !>((find "INSERT INTO catalog-terms" s)))
  ==
::
::  ── +catalog-search-urql ──
++  test-search-urql-shape
  =/  s=tape  (catalog-search-urql "lattice")
  (expect-eq !>(&) !>(=("FROM catalog-terms WHERE term = 'lattice' SELECT source, publisher, path, tf;" s)))
++  test-search-urql-escapes-quote
  =/  s=tape  (catalog-search-urql "it's")
  (expect-eq !>(&) !>(!=(~ (find "term = 'it\\'s'" s))))
::  +catalog-meta-list-urql: the author-summary reader (feature A read surface).
++  test-meta-list-urql-shape
  =/  s=tape  catalog-meta-list-urql
  (expect-eq !>(&) !>(=("FROM catalog-meta SELECT source, publisher, path, summary;" s)))
::
::  ── refresh: author-declared category + summary (feature A) ──────────
::  author-category is adopted via an UPDATE GUARDED by `category = ''` (so a
::  re-sweep never clobbers an llm/manual label); summary writes to catalog-meta.
++  fixture-authored-analysis
  ^-  analysis
  :*  title='Hello world'
      headings=`(list heading)`~  links=`(list link)`~  tags=`(list @t)`~
      hash=(sham 'x')  word-count=0  body-lines=0
      terms=~  author-category='notes'  summary='A blurb'
  ==
++  test-refresh-urql-author-category
  =/  s=tape  (catalog-page-refresh-urql ~zod ~tyr /a/b ~2026.1.1 fixture-authored-analysis no-pages)
  ;:  weld
    (expect-eq !>(&) !>(!=(~ (find "category = 'notes', cat-source = 'author'" s))))
    ::  the unclassified-only guard — never overwrites an existing classification
    (expect-eq !>(&) !>(!=(~ (find "AND category = '';" s))))
    ::  summary written to catalog-meta (after its DELETE)
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-meta" s))))
    (expect-eq !>(&) !>(!=(~ (find "INSERT INTO catalog-meta" s))))
    (expect-eq !>(&) !>(!=(~ (find "'A blurb')" s))))
  ==
::  no author metadata → refresh writes NO classification + no meta INSERT
::  (additive: the authored path only appears when the page declares it).
++  test-refresh-urql-no-author-metadata
  =/  s=tape  (catalog-page-refresh-urql ~zod ~tyr /a/b ~2026.1.1 fixture-analysis no-pages)
  ;:  weld
    (expect-eq !>(~) !>((find "cat-source = 'author'" s)))
    (expect-eq !>(~) !>((find "INSERT INTO catalog-meta" s)))
    ::  but the catalog-meta DELETE always runs (clears any stale summary)
    (expect-eq !>(&) !>(!=(~ (find "DELETE FROM catalog-meta" s))))
  ==
--
