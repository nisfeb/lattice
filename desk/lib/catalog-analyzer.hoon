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
  ==
+$  heading  [depth=@ud text=@t position=@ud]
+$  link     [target=@t label=@t position=@ud]
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
  =/  lines=(list @t)  (to-wain:format body)
  =/  total-lines=@ud  (lent lines)
  =|  rev-headings=(list heading)
  =|  rev-links=(list link)
  =|  rev-tags=(list @t)
  =/  first-non-blank=@t  ''
  =/  word-count=@ud  0
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
    [title headings links tags (sham body) word-count total-lines]
  =/  ln=tape  (trip i.lines)
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
  ::  ── plain body line ──
  =/  trimmed=tape  (ltrim ln)
  ?:  =("" trimmed)
    $(lines t.lines, pos +(pos))
  =/  fnb=@t  ?:(=('' first-non-blank) (crip trimmed) first-non-blank)
  %=  $
    lines             t.lines
    pos               +(pos)
    first-non-blank   fnb
    word-count        (add word-count (count-words trimmed))
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
--
