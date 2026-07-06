::  /lib/catalog-analyzer — gemtext → catalog row data.
::
::  Pure structural extraction over a fetched page body. The analyzer
::  identifies title, headings (with depth + position), outbound links
::  (with labels + position), explicit `#tag` lines, content hash, word
::  count, and line count. Stateless and bowl-independent so this lib
::  runs identically in /tests and in the live crawler.
::
::  Mirrors the line-by-line parsing idiom from +web-render in
::  /lib/lattice (has-prefix on `### ` / `## ` / `# ` / `=> `), inlined
::  here so this lib carries no /+ dependency. See /docs/catalog.md for
::  the catalog design and the four-stage pipeline this analyzer sits
::  in.
::
|%
::  +$  analysis: the result of analyzing one body. The crawler attaches
::  publisher/source/path/url/fetched at the row-write step — none of
::  those are derivable from the body itself.
::
+$  analysis
  $:  title=@t                ::  first heading, fallback first non-blank, '' if neither
      headings=(list heading)
      links=(list link)
      tags=(list @t)
      hash=@uvH               ::  sham over the raw body cord
      word-count=@ud
      body-lines=@ud
      terms=(list term)       ::  inverted-index postings: (term, tf), capped + ranked
      author-category=@t      ::  `%meta category:` value, '' if none declared
      summary=@t              ::  `%meta summary:` value, '' if none declared
  ==
+$  heading  [depth=@ud text=@t position=@ud]
+$  link     [target=@t label=@t position=@ud]
+$  term     [term=@t tf=@ud]   ::  one posting: a content word + its in-page frequency
::
::  Per-page caps on extracted rows. A hostile page body (e.g. a megabyte
::  of "# x\n") would otherwise yield one catalog-* INSERT per line — a
::  single page amplifying into a huge urQL poke. These bound the analysis
::  output (first-N by document order), so the row fan-out per page is
::  bounded the way +manifest-max bounds the page fan-out per publisher.
::  The crawler additionally caps the raw body size before analyzing.
++  heading-max  ^-(@ud 512)
++  link-max     ^-(@ud 1.024)
++  tag-max      ^-(@ud 128)
::  Per-page cap on inverted-index postings. A page's body is tokenized into a
::  term->frequency map; we keep only the top-`term-max` terms by frequency
::  (ties broken by term order, for determinism). This bounds the per-page
::  obelisk fan-out the same way the caps above do, AND is one of the three
::  lossy stages (with stop-word/min-length filtering and dedup-to-count) that
::  make the index a non-reversible bag-of-words rather than a body copy.
++  term-max     ^-(@ud 512)
::  Upper bound on a SINGLE term's byte length, and on the author-declared
::  category/summary. A hostile page with one giant space-free run would
::  otherwise store a multi-KB "term"; real search words are short. Bytes, not
::  codepoints — a crude DoS guard that keeps any one value bounded.
++  term-len-max  ^-(@ud 64)
++  summary-max   ^-(@ud 280)
::
::  +analyze: single-pass fold over the body's lines.
::
::  Order of prefix checks matters — `### ` must be tested BEFORE `## `,
::  which must be tested BEFORE `# `, so "### Foo" isn't accidentally
::  picked up as a level-1 heading with text "## Foo".
::
::  Headings/links/tags are built in reverse and flopped at assembly to
::  keep this O(n) instead of O(n²) with snoc.
::
::  Title rule: if any heading is present, title = text of the FIRST
::  heading. Otherwise, title = the first non-blank line (trimmed).
::  Otherwise '' (empty body, all blanks).
::
++  analyze
  |=  body=@t
  ^-  analysis
  ::  strip a trailing CR per line: to-wain splits on LF only, but CRLF is the
  ::  Gemini line terminator, so without this the CR rides into every heading /
  ::  tag / link-target token and urq-esc turns it into a trailing space that
  ::  breaks exact-match tag + backlink lookups (terms are spared by trim-punct).
  =/  lines=(list @t)  (turn (to-wain:format body) drop-cr)
  =/  total-lines=@ud  (lent lines)
  =|  rev-headings=(list heading)
  =|  rev-links=(list link)
  =|  rev-tags=(list @t)
  =/  first-non-blank=@t  ''
  =/  word-count=@ud  0
  ::  inverted-index accumulator: content word -> in-page frequency. Folded on
  ::  the SAME body lines that feed +count-words, so the term index is a near-
  ::  free byproduct of the word-count pass — the body is never re-traversed and
  ::  never persisted; only the derived (term, tf) postings are.
  =|  term-freqs=(map @t @ud)
  ::  author-declared metadata (feature A), from `%meta key: value` preamble.
  =/  author-cat=@t  ''
  =/  summ=@t  ''
  =/  pos=@ud  0
  |-
  ?~  lines
    ::  cap each list (first-N by document order) so one hostile page can't
    ::  fan out into an unbounded urQL poke. Title is taken before the cap so
    ::  a page with only headings still gets its (first) heading as title.
    =/  headings=(list heading)  (scag heading-max (flop rev-headings))
    =/  links=(list link)        (scag link-max (flop rev-links))
    =/  tags=(list @t)           (scag tag-max (flop rev-tags))
    =/  title=@t
      ?^  headings  text.i.headings
      first-non-blank
    ::  rank the term map by frequency and keep the top `term-max` (lossy cap).
    =/  terms=(list term)  (top-terms term-max term-freqs)
    [title headings links tags (sham body) word-count total-lines terms author-cat summ]
  =/  ln=tape  (trip i.lines)
  ::  ── author metadata: `%meta <key>: <value>` preamble ──
  ::  Tested FIRST so a `%meta` line is never mistaken for a heading, never
  ::  becomes the title, and never enters the term index or word-count.
  ::  `%meta ` collides with no existing prefix, so unmarked pages are
  ::  unaffected. Unknown keys are dropped (a no-op preamble line, not an error).
  =/  meta=(unit [key=tape value=tape])  (parse-meta-line ln)
  ?^  meta
    ?:  =("category" key.u.meta)
      $(lines t.lines, pos +(pos), author-cat (crip (scag term-len-max (trim-both value.u.meta))))
    ?:  =("summary" key.u.meta)
      $(lines t.lines, pos +(pos), summ (crip (scag summary-max (trim-both value.u.meta))))
    $(lines t.lines, pos +(pos))
  ::  title fallback = the first non-blank NON-META line (trimmed). Set here, before
  ::  the heading/link/tag/plain branches, so a heading-less page whose body is only
  ::  `=>` link lines or `#tag` lines still gets a title instead of ''. A heading, if
  ::  present, still takes precedence at assembly.
  =/  fnb-line=tape  (ltrim ln)
  =?  first-non-blank  &(=('' first-non-blank) ?=(^ fnb-line))  (crip fnb-line)
  ::  ── headings (longest-prefix-first, capped at depth 3) ──
  ?:  (has-prefix "### " ln)
    =/  text=tape  (slag 4 ln)
    =/  ct=@t      (crip text)
    %=  $
      lines         t.lines
      pos           +(pos)
      rev-headings  [[3 ct pos] rev-headings]
    ==
  ?:  (has-prefix "## " ln)
    =/  text=tape  (slag 3 ln)
    =/  ct=@t      (crip text)
    %=  $
      lines         t.lines
      pos           +(pos)
      rev-headings  [[2 ct pos] rev-headings]
    ==
  ?:  (has-prefix "# " ln)
    =/  text=tape  (slag 2 ln)
    =/  ct=@t      (crip text)
    %=  $
      lines         t.lines
      pos           +(pos)
      rev-headings  [[1 ct pos] rev-headings]
    ==
  ::  ── outbound link: `=> <target>[<whitespace><label>]` ──
  ?:  (has-prefix "=> " ln)
    =/  rest=tape   (ltrim (slag 3 ln))
    =/  sp          (find " " rest)
    =/  target=@t   ?~(sp (crip rest) (crip (scag u.sp rest)))
    =/  label=@t    ?~(sp '' (crip (ltrim (slag +(u.sp) rest))))
    %=  $
      lines       t.lines
      pos         +(pos)
      rev-links   [[target label pos] rev-links]
      word-count  (add word-count (count-words rest))
      term-freqs  (index-terms term-freqs rest)
    ==
  ::  ── tag-only line: every whitespace-separated token must be `#word`.
  ::  Lines like `Hello #tag` are body text (tags must be exclusive on the
  ::  line, mirroring the social-media convention). Heading lines `# Foo`
  ::  are already handled above because they have `# ` (hash+space).
  =/  tags-here=(unit (list @t))  (parse-tag-line ln)
  ?^  tags-here
    %=  $
      lines     t.lines
      pos       +(pos)
      rev-tags  (weld (flop u.tags-here) rev-tags)
    ==
  ::  ── plain body line ── (first-non-blank already set above)
  =/  trimmed=tape  (ltrim ln)
  ?:  =("" trimmed)
    $(lines t.lines, pos +(pos))
  %=  $
    lines             t.lines
    pos               +(pos)
    word-count        (add word-count (count-words trimmed))
    term-freqs        (index-terms term-freqs trimmed)
  ==
::
::  +parse-tag-line: `~[tag1 tag2 …]` if the line is composed entirely of
::  `#word` tokens (whitespace-separated, `#` followed by at least one
::  non-space character). `~` otherwise — including empty / whitespace
::  lines. Tags lose their leading `#` and are lower-cased.
::
++  parse-tag-line
  |=  ln=tape
  ^-  (unit (list @t))
  =/  toks=(list tape)  (split-space (ltrim ln))
  ?~  toks  ~                            ::  no tokens → not a tag line
  (collect-tag-tokens toks ~)
::
::  Validate-and-collect helper. Recursing through a fresh gate parameter
::  avoids the outer +?~ narrowing leaking into the recursion's type, which
::  would make the empty-toks branch look unreachable (mint-vain) inside
::  the loop. Tags accumulate in reverse and are flopped on success.
++  collect-tag-tokens
  |=  [toks=(list tape) acc=(list @t)]
  ^-  (unit (list @t))
  ?~  toks  `(flop acc)
  ?.  &(?=(^ i.toks) =('#' i.i.toks) ?=(^ t.i.toks))  ~
  $(toks t.toks, acc [(crip (cass t.i.toks)) acc])
::
::  +split-space: split a tape on runs of spaces; empty segments dropped.
::  In-order; no flop needed at the caller.
::
++  split-space
  |=  t=tape
  ^-  (list tape)
  =|  out=(list tape)
  =|  cur=tape
  |-  ^-  (list tape)
  ?~  t
    ?:  =(~ cur)  (flop out)
    (flop [(flop cur) out])
  ?:  =(' ' i.t)
    ?:  =(~ cur)  $(t t.t)
    $(t t.t, cur ~, out [(flop cur) out])
  $(t t.t, cur [i.t cur])
::
::  +count-words: whitespace-separated tokens. Good enough for ranking
::  and excerpt sizing; not lexically perfect.
::
++  count-words
  |=  t=tape
  ^-  @ud
  (lent (split-space t))
::
::  +has-prefix: does [t] start with [p]?  (Inlined from /lib/lattice
::  so this lib has no /+ dependency.)
++  has-prefix
  |=  [p=tape t=tape]
  ^-  ?
  ?:  (lth (lent t) (lent p))  |
  =(p (scag (lent p) t))
::
::  +ltrim: drop leading spaces.  (Inlined from /lib/lattice.)
++  ltrim
  |=  t=tape
  ^-  tape
  ?~  t  ~
  ?:(=(' ' i.t) $(t t.t) t)
::  +drop-cr: strip a single trailing carriage return (byte 13) left by +to-wain
::  on a CRLF-terminated line. Line-ending normalization, applied once per line so
::  every downstream token extractor sees clean content.
++  drop-cr
  |=  t=@t
  ^-  @t
  =/  len=@ud  (met 3 t)
  ?:  =(0 len)  t
  =/  last=@ud  (dec len)
  ?:(=(13 (cut 3 [last 1] t)) (end [3 last] t) t)
::
::  ── inverted-index tokenization (feature B) ───────────────────────────
::
::  +parse-meta-line: `[key value]` if [ln] is a `%meta <key>: <value>`
::  preamble line, `~` otherwise. The key is lower-cased + left-trimmed; the
::  value is returned raw (the caller trims). A line without `%meta ` or
::  without a `:` is not metadata.
++  parse-meta-line
  |=  ln=tape
  ^-  (unit [key=tape value=tape])
  ?.  (has-prefix "%meta " ln)  ~
  =/  rest=tape  (slag 6 ln)
  =/  cl=(unit @ud)  (find ":" rest)
  ?~  cl  ~
  =/  key=tape    (cass (ltrim (scag u.cl rest)))
  =/  value=tape  (slag +(u.cl) rest)
  `[key value]
::
::  +index-terms: fold every content word in [t] into the frequency map [m].
::  Dropped tokens (too short / stop word) never enter the map; surviving
::  tokens bump their count. This is the dedup-to-count (bag-of-words) stage.
++  index-terms
  |=  [m=(map @t @ud) t=tape]
  ^-  (map @t @ud)
  =/  toks=(list tape)  (split-space t)
  |-  ^-  (map @t @ud)
  ?~  toks  m
  =/  nt=(unit @t)  (normalize-term i.toks)
  ?~  nt  $(toks t.toks)
  $(toks t.toks, m (~(put by m) u.nt +((~(gut by m) u.nt 0))))
::
::  +normalize-term: lower-case a raw token, strip leading/trailing
::  punctuation, and drop it (~) if shorter than 3 chars or a stop word.
::  Interior punctuation is kept, so `~ricsul-bilwyt` and hyphenated words
::  survive as a searcher would type them.
++  normalize-term
  |=  tok=tape
  ^-  (unit @t)
  =/  trimmed=tape  (trim-punct (cass tok))
  ?:  (lth (lent trimmed) 3)  ~
  ?:  (gth (lent trimmed) term-len-max)  ~      ::  drop adversarial giant tokens
  =/  c=@t  (crip trimmed)
  ?:  (~(has in stop-words) c)  ~
  `c
::
::  +trim-punct: drop non-alphanumeric characters from BOTH ends of a tape
::  (leading via +trim-leading, trailing via flop/trim-leading/flop).
++  trim-punct
  |=  t=tape
  ^-  tape
  (flop (trim-leading (flop (trim-leading t))))
::  +trim-both: drop leading AND trailing spaces (for %meta key/value cleanup;
::  unlike +trim-punct it only strips spaces, keeping interior/edge punctuation
::  like 'C++' intact).
++  trim-both
  |=  t=tape
  ^-  tape
  (flop (ltrim (flop (ltrim t))))
::  +trim-leading: drop leading non-alphanumeric characters.
++  trim-leading
  |=  t=tape
  ^-  tape
  ?~  t  ~
  ?:  (is-alnum i.t)  t
  $(t t.t)
::  +is-alnum: is [c] an ASCII letter or digit?
++  is-alnum
  |=  c=@tD
  ^-  ?
  ?|  &((gte c '0') (lte c '9'))
      &((gte c 'a') (lte c 'z'))
      &((gte c 'A') (lte c 'Z'))
  ==
::
::  +top-terms: the [n] highest-frequency postings from [m], frequency-
::  descending, ties broken by term order so the output is deterministic
::  (and so the top-N cap selects the same terms every crawl).
++  top-terms
  |=  [n=@ud m=(map @t @ud)]
  ^-  (list term)
  %+  scag  n
  %+  sort  ~(tap by m)
  |=  [a=[t=@t f=@ud] b=[t=@t f=@ud]]
  ^-  ?
  ?:  =(f.a f.b)  (lth t.a t.b)
  (gth f.a f.b)
::
::  +stop-words: a small fixed set of high-frequency English function words
::  (3+ chars — shorter ones are already dropped by the min-length filter)
::  excluded from the term index. Deliberately small + fixed so the analyzer
::  stays pure and unit-testable; content words (man/new/old/…) are NOT here.
++  stop-words
  ^-  (set @t)
  %-  ~(gas in *(set @t))
  ^-  (list @t)
  :~  'the'  'and'  'for'  'are'  'but'  'not'  'you'  'all'  'any'
      'can'  'has'  'had'  'her'  'was'  'one'  'our'  'out'  'his'
      'how'  'now'  'see'  'two'  'way'  'who'  'did'  'its'  'let'
      'say'  'she'  'too'  'use'  'that'  'this'  'with'  'have'  'from'
      'they'  'will'  'would'  'there'  'their'  'what'  'which'  'when'
      'make'  'like'  'time'  'just'  'him'  'know'  'take'  'into'
      'your'  'good'  'some'  'could'  'them'  'than'  'then'  'were'
      'been'  'more'  'also'  'such'  'only'  'over'  'most'  'other'
      'these'  'about'  'where'  'after'  'before'  'between'  'because'
  ==
--
