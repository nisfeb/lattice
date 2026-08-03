::  /lib/lattice-fuzz: input generators for the %quiz property tests.
::
::  %quiz's default generator fills a sample from its TYPE. For a @t that means
::  `(rad:rng size)`, a uniformly random atom below `size`. Since size starts at
::  1 and grows about 9.5% per run, a 100-run check never generates a cord
::  longer than two or three bytes, and every byte is uniform noise. Uniform
::  noise never opens a tag, never closes one, and never spells `javascript:`,
::  so it finds nothing in a parser. Property testing a grammar needs a
::  generator that speaks the grammar badly, not one that speaks nothing.
::
::  So: token soup. Each pool is a bag of fragments drawn from the real syntax
::  plus its edge cases (unterminated tags, bare `&`, stray `<`, control bytes,
::  the exact strings a denylist looks for and near-misses of them). A sample is
::  `size` fragments concatenated. That produces well-formed documents, nearly
::  well-formed ones, and hostile ones, all from the same generator, and every
::  byte of it is a byte the parser has a branch for.
::
::  Import-free on purpose, exactly like the libs it generates input for, so
::  clay's ford can build it and the desk-level /tests can reach it.
::
|%
::  +frag-max: hard cap on fragments per sample, so a check that runs long
::  cannot hand the ship a megabyte. Average fragment is ~6 bytes, so this is
::  a few KB. The libs under test cap their own input far higher; the point of
::  this cap is that the TEST stays fast, not that the lib stays safe.
++  frag-max  ^-(@ud 400)
::
::  +pick: one fragment of a pool, plus the advanced rng. An empty pool yields
::  the empty tape rather than crashing, so a caller's pool typo shows up as a
::  boring test rather than a confusing one.
++  pick
  |=  [pool=(list tape) rng=_og]
  ^-  [tape _og]
  =/  wide=@ud  (lent pool)
  ?:  =(0 wide)  [~ rng]
  =^  n  rng  (rads:rng wide)
  [(snag n pool) rng]
::
::  +soup: `many` fragments drawn from `pool`, concatenated in draw order.
++  soup
  |=  [pool=(list tape) many=@ud rng=_og]
  ^-  [tape _og]
  =|  acc=(list tape)
  =/  n=@ud  many
  |-  ^-  [tape _og]
  ?:  =(0 n)  [(zing (flop acc)) rng]
  =^  frag  rng  (pick pool rng)
  $(n (dec n), acc [frag acc])
::
::  +brew: the norn shape %quiz wants. `size` fragments (capped) as one cord.
++  brew
  |=  [pool=(list tape) size=@ud rng=_og]
  ^-  @t
  (crip -:(soup pool (min size frag-max) rng))
::
::  ── shrinking ───────────────────────────────────────────────────────────────
::
::  +no-alts: an `alts` gate that refuses to shrink. %quiz's default shrinker
::  walks the sample's TYPE, and for a `path` (a list, so a %hold that unrolls
::  into a %fork of cells) it fans out combinatorially while producing knots
::  that are bit-shifted nonsense. Samples that are already small and already
::  readable are better reported as-is than "minimized" into noise.
++  no-alts  |=(sam=vase `(list vase)`~)
::
::  +cord-alts: an `alts` gate for a @t sample. %quiz's default shrinker treats
::  a cord as a number and tries `(div q 2)` and `(dec q)`, which bit-shifts
::  text into unprintable garbage: the counterexample it finally reports is
::  smaller but no longer says anything about the bug. Halving and end-trimming
::  the TAPE keeps the counterexample readable, which is the whole point of
::  shrinking. Every alternative is strictly shorter, so the search terminates.
++  cord-alts
  |=  sam=vase
  ^-  (list vase)
  =/  t=tape  (trip !<(@t sam))
  =/  n=@ud  (lent t)
  ?:  (lth n 2)  ~
  =/  h=@ud  (div n 2)
  :~  !>(`@t`(crip (scag h t)))
      !>(`@t`(crip (slag h t)))
      !>(`@t`(crip (scag (dec n) t)))
      !>(`@t`(crip (slag 1 t)))
  ==
::
::  ── pools ───────────────────────────────────────────────────────────────────
::
::  +html-pool: fragments for /lib/lattice-clip. Balanced tags, unbalanced
::  tags, the boilerplate tags whose CONTENT is dropped, region markers, entity
::  syntax both valid and broken, attribute syntax both quoted and not, and the
::  two schemes +safe-url denylists together with near-misses of them (leading
::  space, leading tab, mixed case) because a denylist is exactly the thing a
::  near-miss defeats.
++  html-pool
  ^-  (list tape)
  :~  "<p>"  "</p>"  "<div>"  "</div>"  "<b>"  "</b>"  "<em>"  "</em>"
      "<i>"  "</i>"  "<strong>"  "</strong>"  "<code>"  "</code>"
      "<pre>"  "</pre>"  "<blockquote>"  "</blockquote>"
      "<ul>"  "<ol>"  "<li>"  "</li>"  "</ul>"  "</ol>"
      "<h1>"  "</h1>"  "<h3>"  "</h3>"  "<h6>"  "</h6>"  "<h9>"
      "<br>"  "<hr>"  "<table>"  "<tr>"  "<td>"  "</td>"  "</tr>"
      "<script>"  "</script>"  "<style>"  "</style>"  "<nav>"  "</nav>"
      "<footer>"  "</footer>"  "<iframe>"  "<svg>"  "<form>"  "<button>"
      "<main>"  "</main>"  "<article>"  "</article>"  "<body>"  "</body>"
      "<head>"  "</head>"  "<title>"  "</title>"  "<noscript>"
      "<!--"  "-->"  "<!"  "<"  ">"  "</"  "/>"  "<p"  "< p>"
      "&"  "&amp;"  "&lt;"  "&gt;"  "&quot;"  "&apos;"  "&nbsp;"  "&mdash;"
      "&#"  "&#65;"  "&#x41;"  "&#x110000;"  "&#0;"  "&#;"  "&#xZZ;"  "&;"
      "&notarealentity;"  ";"
      "<a href=\""  "<a href='"  "<a href="  "<img src=\""  " alt=\""
      "\""  "'"  "="  " "  "\09"  "\0a"  "\0d"  "\01"
      "javascript:"  " javascript:"  "\09javascript:"  "JaVaScRiPt:"
      "data:"  " data:"  "DATA:text/html,"  "alert(1)"
      "http://example.com/x"  "https://a.b/c"  "/rel/path"  "#frag"
      "text"  "word "  "aaaaaaaa"  "  "  "\0a\0a\0a"
      "<span class=x>"  "</span>"  "<u>"  "</u>"  "<dl>"  "<dt>"  "<dd>"
  ==
::
::  +lead-pool: bytes to put IN FRONT of a URL scheme. Every one of these is a
::  byte a browser (and CommonMark's link-destination rule) ignores but a
::  fixed-offset (scag N) denylist does not. The empty tape is in here as the
::  control: with no leading byte the denylist must work.
++  lead-pool
  ^-  (list tape)
  :~  ""  " "  "  "  "\09"  "\0a"  "\0d"  "\01"  "\0c"  " \09"
  ==
::
::  +scheme-pool: the two schemes /lib/lattice-clip denylists, in several
::  spellings. Case is folded before the test, so mixed case alone must NOT
::  get through; it is here to prove the fold works and isolate the offset as
::  the actual defect.
++  scheme-pool
  ^-  (list tape)
  :~  "javascript:"  "JaVaScRiPt:"  "JAVASCRIPT:"
      "data:text/html,"  "DATA:text/html,"  "data:"
  ==
::
::  +gem-pool: fragments for /lib/catalog-analyzer. Gemtext line prefixes at
::  every depth including one past the cap, both line terminators (LF and
::  CRLF), the `%meta` preamble with known and unknown keys, tag lines valid
::  and invalid, and the bytes +urq-esc exists to neutralize (quote,
::  backslash, control) since that arm's whole job is urQL injection safety.
++  gem-pool
  ^-  (list tape)
  :~  "# "  "## "  "### "  "#### "  "#"  "# "  "  # "
      "=> "  "=>"  "=>  "  "=> gemini://a.b/c "  "=> /x"
      "#tag"  "#tag "  "# tag"  "#"  "##"  "#a #b"  "#a b"
      "%meta "  "%meta category: "  "%meta summary: "  "%meta bogus: "
      "%meta category"  "%metacategory: "  "%meta : "
      "\0a"  "\0d\0a"  "\0d"  "\09"  "\01"  "\0b"
      "word"  "the"  "and"  "a"  "aa"  "aaa"  " "  "  "
      "'"  "\\"  "\\'"  "''"  "\""  "`"  "%"  ":"  "-"  "."
      "~ricsul-bilwyt"  "C++"  "UPPER"  "MiXeD"
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      "title text"  "some longer body sentence here"
  ==
::
::  +url-pool: fragments for /lib/lattice-urls. Scheme prefixes correct and
::  near-correct, ship names valid and invalid, mount letters assigned and
::  unassigned, and path bytes @ta does not admit (space, uppercase, %) so the
::  +stab mule-guard actually gets exercised.
++  url-pool
  ^-  (list tape)
  :~  "urb://"  "urb:/"  "urb:"  "urb"  "://"  "https://"  ""
      "~zod"  "~nec"  "~bud"  "~marzod"  "~ricsul-bilwyt"  "~sampel-palnet"
      "~"  "~zzz"  "notaship"  "~zod~zod"  "~doznec"
      "/"  "//"  "///"  "/p"  "/n"  "/k"  "/t"  "/x"  "/b"  "/q"
      "p"  "n"  "k"  "t"  "x"  "foo"  "index"  "notes"  "2026"  "a.b"
      "a_b"  "a-b"  "A"  "%"  "."  ".."  " "  "\09"  "\0a"  "-"  "_"
      "apps"  "lattice.lattice_app"  "page"  "counter"  "know"  "vault"
      "pub"  "user"  "prefs"
  ==
::
::  ── path / ship generators (for the round-trip laws) ────────────────────────
::
::  +safe-knots: knots that +spud renders and +stab parses back unchanged. The
::  round-trip laws in /lib/lattice-urls can only hold over these.
++  safe-knots
  ^-  (list @ta)
  :~  'a'  'b'  'foo'  'bar'  'notes'  'index'  'x'  'p'  'n'  'k'  't'
      '2026'  'a.b'  'a_b'  'a-b'  'counter'  'lattice.lattice_app'  'q'
  ==
::
::  +wild-knots: knots that are perfectly legal @t VALUES but that @ta's
::  SYNTAX does not admit. +spud will happily render them; +stab cannot read
::  them back. Used to pin where the round-trip law stops holding.
++  wild-knots
  ^-  (list @ta)
  :~  'A'  ''  'a b'  'a/b'  '%'  'Foo'  '..'  'a+b'  'a?b'
  ==
::
++  pick-knot
  |=  [pool=(list @ta) rng=_og]
  ^-  [@ta _og]
  =/  wide=@ud  (lent pool)
  ?:  =(0 wide)  ['' rng]
  =^  n  rng  (rads:rng wide)
  [(snag n pool) rng]
::
::  +gen-path: up to `many` knots drawn from `pool`.
++  gen-path
  |=  [pool=(list @ta) many=@ud rng=_og]
  ^-  [path _og]
  =|  acc=path
  =/  n=@ud  many
  |-  ^-  [path _og]
  ?:  =(0 n)  [(flop acc) rng]
  =^  k  rng  (pick-knot pool rng)
  $(n (dec n), acc [k acc])
::
++  ships
  ^-  (list @p)
  :~  ~zod  ~nec  ~bud  ~wes  ~marzod  ~sampel-palnet  ~ricsul-bilwyt
  ==
::
++  pick-ship
  |=  rng=_og
  ^-  [@p _og]
  =^  n  rng  (rads:rng (lent ships))
  [(snag n ships) rng]
::
::  ── tape predicates the property tests share ────────────────────────────────
::
::  +has-sub: does `n` occur anywhere in `h`? +find is a prefix-free substring
::  search, so this is just its unit collapsed to a loobean. Case-sensitive;
::  callers case-fold first when they mean to.
++  has-sub
  |=  [n=tape h=tape]
  ^-  ?
  ?=(^ (find n h))
--
