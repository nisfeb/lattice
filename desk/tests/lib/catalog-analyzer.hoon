::  Unit tests for /lib/catalog-analyzer.  Run with:
::    -test %/tests/lib/catalog-analyzer ~   (or the run-tests MCP tool)
::
::  All tests pass a body cord through +analyze and assert on individual
::  fields of the resulting analysis, which gives better failure messages
::  than comparing whole structures and isolates regressions to the
::  exact fold step that broke.
::
/+  *test, *catalog-analyzer
|%
::  ── empties / boundary ─────────────────────────────────────────────────
::
++  test-empty-body
  =/  a=analysis  (analyze '')
  ;:  weld
    (expect-eq !>(`@t`'') !>(title.a))
    (expect-eq !>(~) !>(headings.a))
    (expect-eq !>(~) !>(links.a))
    (expect-eq !>(~) !>(tags.a))
    (expect-eq !>(`@ud`0) !>(word-count.a))
    ::  hash is deterministic but value-opaque; we only assert it equals
    ::  sham '' on this exact cord, locking the hash function choice.
    (expect-eq !>(`@uvH`(sham '')) !>(hash.a))
  ==
::
++  test-blank-lines-only
  =/  a=analysis  (analyze '\0a\0a')
  ;:  weld
    (expect-eq !>(`@t`'') !>(title.a))
    (expect-eq !>(~) !>(headings.a))
    (expect-eq !>(`@ud`0) !>(word-count.a))
  ==
::
::  ── title resolution ───────────────────────────────────────────────────
::
::  A heading anywhere in the document beats a body line, even if the
::  body line comes first.
++  test-title-from-heading
  =/  a=analysis  (analyze '# Hello world')
  (expect-eq !>(`@t`'Hello world') !>(title.a))
::
++  test-title-heading-beats-body
  =/  a=analysis  (analyze 'A body line first\0a# The Real Title')
  (expect-eq !>(`@t`'The Real Title') !>(title.a))
::
++  test-title-falls-back-to-first-non-blank
  =/  a=analysis  (analyze '\0a\0aJust some prose')
  (expect-eq !>(`@t`'Just some prose') !>(title.a))
::
++  test-title-first-heading-wins-over-later-headings
  =/  a=analysis  (analyze '# First\0a## Second\0a### Third')
  (expect-eq !>(`@t`'First') !>(title.a))
::
::  ── heading extraction ────────────────────────────────────────────────
::
++  test-headings-three-depths
  =/  a=analysis  (analyze '# H1\0a## H2\0a### H3')
  =/  want=(list heading)  ~[[1 'H1' 0] [2 'H2' 1] [3 'H3' 2]]
  (expect-eq !>(want) !>(headings.a))
::
::  Four+ hashes (gemtext doesn't define depth-4+) are NOT headings.
::  They fall through to body so the analyzer doesn't silently invent
::  a convention the spec doesn't support.
++  test-four-hashes-not-a-heading
  =/  a=analysis  (analyze '#### Deeper')
  ;:  weld
    (expect-eq !>(~) !>(headings.a))
    ::  becomes a body line — title falls back to it
    (expect-eq !>(`@t`'#### Deeper') !>(title.a))
  ==
::
::  Position counter advances per LINE, not per heading — so a heading
::  on document line 3 carries position=3, regardless of how many
::  headings preceded it.
++  test-position-tracks-document-line
  =/  a=analysis  (analyze 'one\0atwo\0a# Heading on line 2')
  =/  want=(list heading)  ~[[1 'Heading on line 2' 2]]
  (expect-eq !>(want) !>(headings.a))
::
::  ── link extraction ───────────────────────────────────────────────────
::
++  test-link-with-label
  =/  a=analysis  (analyze '=> urb://~zod/foo  Foo Page')
  =/  want=(list link)  ~[['urb://~zod/foo' 'Foo Page' 0]]
  (expect-eq !>(want) !>(links.a))
::
++  test-link-without-label
  =/  a=analysis  (analyze '=> urb://~zod/bar')
  =/  want=(list link)  ~[['urb://~zod/bar' '' 0]]
  (expect-eq !>(want) !>(links.a))
::
++  test-link-tolerates-extra-spaces
  =/  a=analysis  (analyze '=>    https://example.com   Example')
  =/  want=(list link)  ~[['https://example.com' 'Example' 0]]
  (expect-eq !>(want) !>(links.a))
::
++  test-multiple-links-preserve-order
  =/  a=analysis
    %-  analyze
    '=> urb://~zod/a  A\0a=> urb://~zod/b  B\0a=> urb://~zod/c  C'
  =/  want=(list link)
    ~[['urb://~zod/a' 'A' 0] ['urb://~zod/b' 'B' 1] ['urb://~zod/c' 'C' 2]]
  (expect-eq !>(want) !>(links.a))
::
::  ── tag extraction ────────────────────────────────────────────────────
::
::  `#tag` (no space after the hash) is a tag — distinct from a heading
::  `# tag` (hash + space). Multi-tag lines are accepted; tags lose the
::  `#` prefix and are lower-cased.
++  test-tag-line-multiple
  =/  a=analysis  (analyze '#foo #BAR #baz')
  (expect-eq !>(`(list @t)`~['foo' 'bar' 'baz']) !>(tags.a))
::
::  Tags must be EXCLUSIVE on the line — `Hello #tag` is body text, not
::  a tag line. Keeps inline references from polluting the index.
++  test-tag-mixed-with-body-rejected
  =/  a=analysis  (analyze 'Hello #tag')
  ;:  weld
    (expect-eq !>(~) !>(tags.a))
    (expect-eq !>(`@t`'Hello #tag') !>(title.a))
  ==
::
++  test-tag-vs-heading-disambiguation
  =/  a=analysis  (analyze '#foo\0a# foo')
  =/  want-tags=(list @t)      ~['foo']
  =/  want-headings=(list heading)  ~[[1 'foo' 1]]
  ;:  weld
    ::  #foo (no space) → tag 'foo'
    (expect-eq !>(want-tags) !>(tags.a))
    ::  # foo (space) → heading 'foo' at line 1 (line 0 was the #foo tag line)
    (expect-eq !>(want-headings) !>(headings.a))
  ==
::
::  Bare `#` (no word) is not a tag — fall through to body text.
++  test-bare-hash-is-not-a-tag
  =/  a=analysis  (analyze '#')
  ;:  weld
    (expect-eq !>(~) !>(tags.a))
    (expect-eq !>(`@t`'#') !>(title.a))
  ==
::
::  ── hash + counts ─────────────────────────────────────────────────────
::
++  test-hash-deterministic
  =/  a=analysis  (analyze 'identical body')
  =/  b=analysis  (analyze 'identical body')
  (expect-eq !>(hash.a) !>(hash.b))
::
++  test-hash-differs-on-change
  =/  a=analysis  (analyze 'body one')
  =/  b=analysis  (analyze 'body two')
  (expect-eq !>(&) !>(!=(hash.a hash.b)))
::
++  test-word-count-prose
  =/  a=analysis  (analyze 'one two three four five')
  (expect-eq !>(`@ud`5) !>(word-count.a))
::
++  test-word-count-multiline
  =/  a=analysis  (analyze 'one two\0athree four\0afive')
  (expect-eq !>(`@ud`5) !>(word-count.a))
::
::  Headings themselves don't add to word-count — we count BODY prose
::  (title/heading text is metadata). Link target+label DO count (their
::  text is content the reader sees).
++  test-word-count-excludes-headings
  =/  a=analysis  (analyze '# Heading text here\0abody text')
  (expect-eq !>(`@ud`2) !>(word-count.a))
::
::  ── helpers (small but easy to break) ─────────────────────────────────
::
++  test-split-space
  ;:  weld
    (expect-eq !>(~["one" "two" "three"]) !>((split-space "one two three")))
    (expect-eq !>(~["a" "b"]) !>((split-space "  a   b   ")))
    (expect-eq !>(~) !>((split-space "")))
    (expect-eq !>(~) !>((split-space "   ")))
  ==
::
++  test-parse-tag-line
  ;:  weld
    (expect-eq !>(`(list @t)`~['foo' 'bar']) !>((need (parse-tag-line "#foo #bar"))))
    (expect-eq !>(~) !>((parse-tag-line "Hello #tag")))
    (expect-eq !>(~) !>((parse-tag-line "")))
    (expect-eq !>(~) !>((parse-tag-line "#")))
  ==
::
::  ── per-page row caps (DoS guard) ───────────────────────────────────────
::  A hostile page body of N heading/link/tag lines must not yield N rows.
::  Each list is capped at its *-max; a body just over the cap clamps to it.
++  test-analyze-caps-headings
  =/  body=@t  (rap 3 (reap +(heading-max) '# h\0a'))
  (expect-eq !>(heading-max) !>((lent headings:(analyze body))))
::
++  test-analyze-caps-links
  =/  body=@t  (rap 3 (reap +(link-max) '=> /x  l\0a'))
  (expect-eq !>(link-max) !>((lent links:(analyze body))))
::
++  test-analyze-caps-tags
  =/  body=@t  (rap 3 (reap +(tag-max) '#t\0a'))
  (expect-eq !>(tag-max) !>((lent tags:(analyze body))))
::
::  Under the cap, nothing is dropped (the cap doesn't truncate normal pages).
++  test-analyze-under-cap-intact
  =/  body=@t  '# a\0a## b\0a### c\0a'
  (expect-eq !>(`@ud`3) !>((lent headings:(analyze body))))
::
::  ── inverted-index term extraction (feature B) ──────────────────────────
::  Body words → lower-cased, edge-punctuation-stripped, <3-char + stop words
::  dropped, deduped to a per-term frequency (tf).
++  test-terms-basic
  =/  a=analysis  (analyze 'Lattice catalog catalog search')
  =/  m=(map @t @ud)  (~(gas by *(map @t @ud)) terms.a)
  ;:  weld
    (expect-eq !>(`@ud`1) !>((~(got by m) 'lattice')))  ::  lower-cased
    (expect-eq !>(`@ud`2) !>((~(got by m) 'catalog')))  ::  deduped to tf
    (expect-eq !>(`@ud`1) !>((~(got by m) 'search')))
  ==
::  stop words ('the') and <3-char tokens ('is','on') never enter the index.
++  test-terms-drops-stop-and-short
  =/  a=analysis  (analyze 'the cat is on the mat')
  =/  m=(map @t @ud)  (~(gas by *(map @t @ud)) terms.a)
  ;:  weld
    (expect-eq !>(~) !>((~(get by m) 'the')))
    (expect-eq !>(~) !>((~(get by m) 'is')))
    (expect-eq !>(~) !>((~(get by m) 'on')))
    (expect-eq !>(`@ud`1) !>((~(got by m) 'cat')))
    (expect-eq !>(`@ud`1) !>((~(got by m) 'mat')))
  ==
::  edge punctuation is trimmed; interior kept (so '~ricsul-bilwyt' survives).
++  test-terms-trims-punctuation
  =/  a=analysis  (analyze '(hello), world. ~ricsul-bilwyt')
  =/  m=(map @t @ud)  (~(gas by *(map @t @ud)) terms.a)
  ;:  weld
    (expect-eq !>(`@ud`1) !>((~(got by m) 'hello')))
    (expect-eq !>(`@ud`1) !>((~(got by m) 'world')))
    (expect-eq !>(`@ud`1) !>((~(got by m) 'ricsul-bilwyt')))
  ==
::  the term index is capped at term-max distinct terms (DoS / poke-size guard).
++  test-terms-cap
  =/  body=tape
    =/  i=@ud  0
    =|  acc=tape
    |-  ^-  tape
    ?:  (gth i term-max)  acc                  ::  term-max+1 DISTINCT words
    $(i +(i), acc :(weld acc "wrd" (scow %ud i) " "))
  (expect-eq !>(term-max) !>((lent terms:(analyze (crip body)))))
::
::  ── author metadata: `%meta` preamble (feature A) ──────────────────────
++  test-meta-category
  =/  a=analysis  (analyze '%meta category: notes\0a# Title\0abody words here')
  ;:  weld
    (expect-eq !>('notes') !>(author-category.a))
    (expect-eq !>('Title') !>(title.a))  ::  %meta line is NOT the title
  ==
++  test-meta-summary
  =/  a=analysis  (analyze '%meta summary: A short blurb.\0a# T\0abody')
  (expect-eq !>('A short blurb.') !>(summary.a))
::  a %meta line is excluded from the term index (metadata, not prose).
++  test-meta-not-indexed
  =/  a=analysis  (analyze '%meta category: zzztopic\0abody text')
  =/  m=(map @t @ud)  (~(gas by *(map @t @ud)) terms.a)
  ;:  weld
    (expect-eq !>('zzztopic') !>(author-category.a))
    (expect-eq !>(~) !>((~(get by m) 'zzztopic')))
    (expect-eq !>(~) !>((~(get by m) 'category')))
    (expect-eq !>(`@ud`1) !>((~(got by m) 'body')))  ::  real body word indexed
  ==
::  no %meta → author-category/summary stay empty (backward compatible).
++  test-meta-absent
  =/  a=analysis  (analyze '# Title\0aplain body')
  ;:  weld
    (expect-eq !>('') !>(author-category.a))
    (expect-eq !>('') !>(summary.a))
  ==
::  +parse-meta-line directly: only `%meta key: value` matches.
++  test-parse-meta-line
  ;:  weld
    (expect-eq !>("category") !>(key:(need (parse-meta-line "%meta category: notes"))))
    (expect-eq !>(" notes") !>(value:(need (parse-meta-line "%meta category: notes"))))
    (expect-eq !>(~) !>((parse-meta-line "not meta")))
    (expect-eq !>(~) !>((parse-meta-line "%meta nocolon")))
  ==
::  a single oversized token (no spaces) is dropped from the index — guards a
::  hostile page from storing a multi-KB "term" (defeats the bag-of-words cap).
++  test-terms-max-length
  =/  big=@t  (rap 3 (reap 70 'x'))             ::  70 bytes > term-len-max (64)
  (expect-eq !>(~) !>(terms:(analyze big)))
::  %meta values are both-ends-trimmed and byte-capped.
++  test-meta-trims-and-caps
  =/  a=analysis  (analyze '%meta category:   notes  ')
  =/  long=@t  (rap 3 (weld ~['%meta summary: '] (reap 400 'z')))
  =/  b=analysis  (analyze long)
  ;:  weld
    (expect-eq !>('notes') !>(author-category.a))     ::  surrounding spaces gone
    (expect-eq !>(summary-max) !>((met 3 summary.b)))  ::  capped at 280 bytes
  ==
--
