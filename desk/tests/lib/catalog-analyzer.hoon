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
--
