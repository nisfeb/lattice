::  lattice-clip: html -> markdown, so a clearweb page can be archived as an
::  ordinary lattice page. Used by the /clip route in nex/lattice/app.hoon.
::
::  Two arms matter: +to-md converts a document, +page-title pulls its <title>
::  to name the archive.
::
::  Shape of the thing: ONE linear pass. Output accumulates REVERSED through
::  +emit and is flopped once at the end. Welding onto a growing tape is the
::  quadratic that has wedged this ship before, so +emit is deliberately the
::  only way to append and it never touches more than the short literal it is
::  given. Forward scans (a closing tag, a comment terminator, a quoted
::  attribute value) each consume the input they skip, so they cannot be
::  re-run over the same ground, and the input is capped up front regardless.
::
::  This is a converter, not a parser. Malformed html must degrade into
::  imperfect markdown, never bail. Every "can't happen" branch has a value.
::
|%
::  +cap: nothing here reads more input than this. A hostile or merely
::  enormous page truncates. It never runs away.
++  cap  2.000.000
++  nl  ^-(tape ~[`@tD`10])
::  +emit: append `s` to the reversed accumulator. The ONLY append.
++  emit  |=([acc=tape s=tape] ^-(tape (weld (flop s) acc)))
::  +brk: a line break, carrying the blockquote marker when we are inside one.
::  Markdown needs '>' on every line of a quote, not just the first.
++  brk  |=(q=? ^-(tape ?:(q (weld nl "> ") nl)))
::
::  +to-md: document -> markdown.
++  to-md
  |=  html=@t
  ^-  @t
  ::  cut the atom, then trip: a tape is many times the bytes, so tripping
  ::  a huge body first expanded all of it before the cap applied
  =/  t=tape  (trip (end [3 cap] html))
  =/  out=tape  (squeeze (walk (region t)))
  (crip out)
::
::  +page-title: the <title>, entity-decoded and whitespace-collapsed.
++  page-title
  |=  html=@t
  ^-  (unit @t)
  =/  raw=tape  (trip (end [3 cap] html))
  =/  low=tape  (cass raw)
  =/  o=(unit @ud)  (find "<title" low)
  ?~  o  ~
  =/  g=(unit @ud)  (find ">" `tape`(slag u.o low))
  ?~  g  ~
  =/  beg=@ud  (add u.o +(u.g))
  =/  e=(unit @ud)  (find "</title" `tape`(slag beg low))
  ?~  e  ~
  ::  slice the ORIGINAL, not the lowercased copy. The title keeps its case.
  =/  txt=tape  (scag u.e `tape`(slag beg raw))
  =/  out=tape  (squeeze (unent txt))
  ?~(out ~ `(crip `tape`out))
::
::  +region: the article body. <main> or <article> when present (that IS the
::  content and everything around it is site chrome), else <body>, else the
::  whole input.
++  region
  |=  t=tape
  ^-  tape
  =/  m=(unit tape)  (between t "<main" "</main")
  ?^  m  u.m
  =/  a=(unit tape)  (between t "<article" "</article")
  ?^  a  u.a
  =/  b=(unit tape)  (between t "<body" "</body")
  ?^  b  u.b
  t
::
::  +between: text inside the first open..close pair, starting after the open
::  tag's own '>'. Tags are matched case-insensitively. The text keeps its case.
++  between
  |=  [t=tape open=tape close=tape]
  ^-  (unit tape)
  =/  low=tape  (cass t)
  =/  o=(unit @ud)  (find open low)
  ?~  o  ~
  =/  g=(unit @ud)  (find ">" `tape`(slag u.o low))
  ?~  g  ~
  =/  beg=@ud  (add u.o +(u.g))
  =/  e=(unit @ud)  (find close `tape`(slag beg low))
  ?~  e  ~
  `(scag u.e `tape`(slag beg t))
::
::  +drop-tag: tags whose CONTENT goes with them. Executable, or page chrome
::  that is not the article. Everything else keeps its text.
++  drop-tag
  |=  n=tape
  ^-  ?
  ?=  $?  %script  %style  %head  %noscript  %svg  %iframe
          %form    %nav    %footer  %aside   %template  %button
      ==
  (crip n)
::
::  +tag: at a '<', split off the tag: lowercased name, whether it closes,
::  the raw attribute text, and the input after the '>'. An unterminated '<'
::  (malformed html, or a stray '<' in prose) comes back with an empty name so
::  the caller can emit it as literal text instead of eating the rest.
++  tag
  |=  t=tape
  ^-  [nam=tape cls=? att=tape rest=tape]
  =/  in=tape  (slag 1 t)
  =/  cls=?  &(?=(^ in) =('/' i.in))
  =.  in  ?:(cls `tape`(slag 1 in) in)
  =/  e=(unit @ud)  (find ">" in)
  ?~  e  [~ | ~ ~]
  =/  raw=tape  (scag u.e in)
  =/  rest=tape  (slag +(u.e) in)
  =/  nam=tape
    |-  ^-  tape
    ?~  raw  ~
    ?:  ?|(=(' ' i.raw) =(`@tD`9 i.raw) =(`@tD`10 i.raw) =('/' i.raw))  ~
    [i.raw $(raw t.raw)]
  [(cass nam) cls (slag (lent nam) raw) rest]
::
::  +tag-start: may a tag name begin here?
++  tag-start
  |=  t=tape
  ^-  ?
  ?~  t  |
  =/  c=@tD  i.t
  ?|  &((gte c 'a') (lte c 'z'))
      &((gte c 'A') (lte c 'Z'))
      =('!' c)
      =('?' c)
  ==
::
::  +find-ci: where `pat` (lowercase) first occurs in `hay`, matched without
::  regard to case. It stops at the first match, so a walk that resumes
::  after it never scans the same bytes twice.
++  find-ci
  |=  [pat=tape hay=tape]
  ^-  (unit @ud)
  =/  n=@ud  0
  |-  ^-  (unit @ud)
  ?~  hay  ~
  =/  h=tape  hay
  =/  p=tape  pat
  =/  hit=?
    |-  ^-  ?
    ?~  p  &
    ?~  h  |
    ?.  =(i.p ?:(&((gte i.h 'A') (lte i.h 'Z')) (add i.h 32) i.h))  |
    $(p t.p, h t.h)
  ?:  hit  `n
  $(hay t.hay, n +(n))
::
::  +attr: an attribute's value. Quoted or bare. The name is matched
::  case-insensitively but the value keeps its case (urls are case-sensitive).
++  attr
  |=  [att=tape key=tape]
  ^-  tape
  =/  pat=tape  (weld key "=")
  =/  o=(unit @ud)  (find pat (cass att))
  ?~  o  ~
  =/  v=tape  (slag (add u.o (lent pat)) att)
  ?~  v  ~
  =/  vv=tape  `tape`v
  =/  q=@tD  i.v
  ?:  |(=('"' q) =(`@tD`39 q))
    =/  r=tape  (slag 1 vv)
    |-  ^-  tape
    ?~  r  ~
    ?:  =(q i.r)  ~
    [i.r $(r t.r)]
  ::  unquoted value: walk `vv`, not `v`. v is already narrowed non-empty by
  ::  the check above, so a second ?~ on it is a vain branch.
  =/  b=tape  vv
  |-  ^-  tape
  ?~  b  ~
  ?:  |(=(' ' i.b) =('>' i.b))  ~
  [i.b $(b t.b)]
::
::  +safe-url: keep `javascript:` and `data:` out of the archive. They cannot
::  execute in rendered markdown, but they are never useful in an archive and
::  a stored one is a trap waiting for whoever opens the source later.
::  A browser resolves a url AFTER stripping leading whitespace and control
::  bytes, so " javascript:x" and "\09javascript:x" are live links to it. The
::  check used to compare at a FIXED offset, so any such byte slid the scheme
::  out of the window and the url was archived as a live link. Strip first,
::  then test. Found by a generated leading-byte x scheme sweep.
::
::  /lib/lattice-md's +safe-url is an ALLOWLIST and fails closed on the same
::  input, which is why this was defence in depth rather than a live hole:
::  clipped markdown renders through that allowlist. Two checks, one threat,
::  opposite defaults. This one is now the stricter of the two.
++  safe-url
  |=  u=tape
  ^-  ?
  =/  l=tape  (cass (lead-strip u))
  ?&  !=("javascript:" (scag 11 l))
      !=("data:" (scag 5 l))
      !=("vbscript:" (scag 9 l))
      ?=(^ u)
  ==
::  +lead-strip: drop leading whitespace and C0 control bytes, the ones a
::  browser discards before it decides what scheme a url has.
++  lead-strip
  |=  t=tape
  ^-  tape
  ?~  t  t
  ?:  (lth `@`i.t 33)  $(t t.t)
  t
::
::  +walk: the pass.
::    acc  output, REVERSED
::    pre  inside <pre>, verbatim, no whitespace collapsing
::    quo  inside <blockquote>, every line break carries '> '
::    sp   whitespace was seen and not yet emitted. This is how runs of
::         spaces and newlines collapse without a second pass
::    lnk  ~ when not in a link (or the link was dropped). [~ url] when we
::         have emitted '[' and owe a '](url)'
++  walk
  |=  t=tape
  ^-  tape
  =|  acc=tape
  ::  These MUST be =/ with an explicit |, not =|. The bunt of `?` is %.y, so
  ::  `=| pre=?` starts pre TRUE. That made the "inside <pre>" guard swallow
  ::  every tag but <pre> itself, put a blockquote marker on every line, and
  ::  route all text down the verbatim path. One character, whole converter.
  =/  pre=?  |
  =/  quo=?  |
  =/  sp=?   |
  ::  ng: no '>' is left in the input, so no later '<' can open a tag
  =/  ng=?   |
  =|  lnk=(unit tape)
  |-  ^-  tape
  ?~  t  (flop acc)
  ::  `?~` above narrows t to a non-empty tape, and a WET gate (scag/slag/find)
  ::  handed that narrowed type mull-grows. Re-widen ONCE here and pass `tt` to
  ::  every wet gate below. Casting their result instead does nothing, because
  ::  the mull happens on the argument.
  =/  tt=tape  `tape`t
  =/  c=@tD  i.t
  ::  comment: skip to '-->'. Unterminated, the rest of the document is
  ::  inside it, so we are done.
  ?:  &(=('<' c) =("!--" (scag 3 (slag 1 tt))))
    =/  e=(unit @ud)  (find "-->" (slag 4 tt))
    ?~  e  (flop acc)
    $(t (slag (add 7 u.e) tt))
  ?:  =('&' c)
    ::  an entity is text, so it flushes any pending space like any other char.
    ::  So does a BARE ampersand, which is why the flush is computed
    ::  before the branch. Doing it only on the entity path turned "Tom & Jerry"
    ::  into "Tom& Jerry".
    =/  a2=tape  ?:(&(sp ?=(^ acc)) (emit acc " ") acc)
    =/  d=(unit [c=tape rest=tape])  (unent-one (slag 1 tt))
    ?~  d  $(t t.t, acc (emit a2 "&"), sp |)
    ::  an entity that decodes to a plain space (&nbsp;) is whitespace like any
    ::  other. Hand it to the collapser instead of emitting it verbatim, or an
    ::  &nbsp; stacks on top of the literal spaces around it.
    ?:  =(" " c.u.d)  $(t rest.u.d, sp &)
    $(t rest.u.d, acc (emit a2 c.u.d), sp |)
  ?:  =('<' c)
    ::  a '<' opens a tag only before a letter, '!' or '?' (after a '/' for
    ::  a closing tag). Any other '<' is prose, and so is every '<' once no
    ::  '>' is left: looking for one again at each '<' made a page of them
    ::  quadratic (security audit run-1).
    ::  a literal '<' is text, so it flushes a pending space as '&' does
    =/  lt=tape  (emit ?:(&(sp ?=(^ acc)) (emit acc " ") acc) "<")
    =/  nx=tape  (slag 1 tt)
    ?:  |(ng !(tag-start ?:(=("/" (scag 1 nx)) (slag 1 nx) nx)))
      $(t t.t, acc lt, sp |)
    =/  g  (tag tt)
    ?~  nam.g
      ::  a '<' that never closes is prose, not markup, and no '>' follows
      $(t t.t, acc lt, sp |, ng &)
    =/  n=tape  nam.g
    ::  drop the tag AND its content
    ?:  &(!cls.g (drop-tag n))
      ::  scan for the closer without lowercasing the whole remainder,
      ::  which every dropped tag used to do (+find-ci)
      =/  e=(unit @ud)  (find-ci (weld "</" n) rest.g)
      ?~  e  (flop acc)
      =/  aft=tape  (slag u.e `tape`rest.g)
      =/  g2=(unit @ud)  (find ">" aft)
      ?~  g2  (flop acc)
      $(t (slag +(u.g2) aft), sp &)
    ::  inside <pre> only </pre> means anything. Other tags are shown as text
    ?:  &(pre !=("pre" n))
      $(t rest.g)
    =/  r=tape  rest.g
    ?:  cls.g
      ::  ── closing tags ──
      ?:  =("pre" n)
        $(t r, pre |, acc (emit acc (weld nl "```")), sp |)
      ?:  =("a" n)
        ?~  lnk  $(t r)
        $(t r, lnk ~, acc (emit acc :(weld "](" u.lnk ")")), sp |)
      ?:  =("blockquote" n)
        $(t r, quo |, acc (emit acc nl), sp |)
      ?:  |(=("strong" n) =("b" n))
        $(t r, acc (emit acc "**"), sp |)
      ?:  |(=("em" n) =("i" n))
        $(t r, acc (emit acc "*"), sp |)
      ?:  =("code" n)
        $(t r, acc (emit acc "`"), sp |)
      ?:  (block n)
        $(t r, acc (emit acc (brk quo)), sp |)
      $(t r)
    ::  ── opening tags ──
    ::  An inline marker is TEXT, so a pending space belongs BEFORE it, exactly
    ::  as it would before a letter. Every branch that opens inline markup uses
    ::  `flu` rather than `acc`. Dropping the space glued "with **bold**" into
    ::  "with**bold**". Closing markers deliberately do NOT flush. The space
    ::  belongs after the marker there, and the following text emits it.
    =/  flu=tape  ?:(&(sp ?=(^ acc)) (emit acc " ") acc)
    ?:  =("pre" n)
      $(t r, pre &, acc (emit acc :(weld (brk quo) "```" nl)), sp |)
    ?:  =("br" n)
      $(t r, acc (emit acc (brk quo)), sp |)
    ?:  =("hr" n)
      $(t r, acc (emit acc :(weld (brk quo) "---" (brk quo))), sp |)
    ?:  =("blockquote" n)
      $(t r, quo &, acc (emit acc :(weld nl nl "> ")), sp |)
    ?:  =("li" n)
      $(t r, acc (emit acc (weld (brk quo) "- ")), sp |)
    ?:  =("img" n)
      =/  src=tape  (attr att.g "src")
      ?.  (safe-url src)  $(t r)
      $(t r, acc (emit acc :(weld "![" (attr att.g "alt") "](" src ")")), sp |)
    ?:  =("a" n)
      =/  href=tape  (attr att.g "href")
      ::  an unsafe or missing href keeps the link TEXT and drops the link
      ?.  (safe-url href)  $(t r, lnk ~)
      $(t r, lnk `href, acc (emit flu "["), sp |)
    ?:  |(=("strong" n) =("b" n))
      $(t r, acc (emit flu "**"), sp |)
    ?:  |(=("em" n) =("i" n))
      $(t r, acc (emit flu "*"), sp |)
    ?:  =("code" n)
      $(t r, acc (emit flu "`"), sp |)
    ?:  |(=("td" n) =("th" n))
      $(t r, acc (emit acc "  "), sp |)
    =/  h=(unit @ud)  (head-level n)
    ?^  h
      =/  hs=tape  (reap u.h '#')
      $(t r, acc (emit acc :(weld nl nl hs " ")), sp |)
    ?:  (block n)
      $(t r, acc (emit acc (weld (brk quo) (brk quo))), sp |)
    ::  unknown tag: drop the tag, keep the text
    $(t r)
  ::  ── text ──
  ?:  pre
    $(t t.t, acc (emit acc ~[c]))
  ?:  |(=(' ' c) =(`@tD`9 c) =(`@tD`10 c) =(`@tD`13 c))
    $(t t.t, sp &)
  =/  a2=tape  ?:(&(sp ?=(^ acc)) (emit acc " ") acc)
  $(t t.t, acc (emit a2 ~[c]), sp |)
::
::  +block: does this tag end a line?
::  +block: does this tag end a line? NOT %li. A closing </li> would then add
::  a break on top of the one the next <li> already emits, and the blank line
::  between items makes markdown render a loose list (every item wrapped in a
::  paragraph). The <li> OPEN is handled before this is consulted.
++  block
  |=  n=tape
  ^-  ?
  ?=  $?  %p  %div  %ul  %ol  %section  %tr  %table  %tbody
          %h1  %h2  %h3  %h4  %h5  %h6  %dl  %dt  %dd  %figure
      ==
  (crip n)
::
::  +head-level: h1..h6 -> 1..6.
++  head-level
  |=  n=tape
  ^-  (unit @ud)
  ?.  ?=([@ @ ~] n)  ~
  ?.  =('h' i.n)  ~
  =/  d=@tD  i.t.n
  ?.  &((gte d '1') (lte d '6'))  ~
  `(sub d '0')
::
::  +unent: decode every entity in a tape.
++  unent
  |=  t=tape
  ^-  tape
  =|  acc=tape
  |-  ^-  tape
  ?~  t  (flop acc)
  =/  tt=tape  `tape`t
  ?.  =('&' i.t)  $(t t.t, acc [i.t acc])
  =/  d=(unit [c=tape rest=tape])  (unent-one (slag 1 tt))
  ?~  d  $(t t.t, acc ['&' acc])
  $(t rest.u.d, acc (emit acc c.u.d))
::
::  +unent-one: at the character AFTER an '&', decode one entity. ~ when this
::  is a bare ampersand, which is common in prose and must stay literal.
++  unent-one
  |=  t=tape
  ^-  (unit [c=tape rest=tape])
  ::  an entity name is short. Anything longer is a stray '&'
  =/  e=(unit @ud)  (find ";" (scag 12 t))
  ?~  e  ~
  =/  nam=tape  (scag u.e t)
  =/  rest=tape  (slag +(u.e) t)
  ?~  nam  ~
  ::  widened copy for the wet gates below (see the note in +walk)
  =/  nn=tape  `tape`nam
  ?.  =('#' i.nam)
    =/  c=tape
      ?+  (crip (cass nn))  ~
        %amp   "&"
        %lt    "<"
        %gt    ">"
        %quot  "\""
        %apos  ~[`@tD`39]
        %nbsp  " "
        %mdash  "—"
        %ndash  "–"
        %hellip  "…"
        %rsquo  "’"
        %lsquo  "‘"
        %ldquo  "“"
        %rdquo  "”"
      ==
    ?~(c ~ `[c rest])
  ::  numeric: &#NN; or &#xHH;
  =/  ds=tape  (slag 1 nn)
  ?~  ds  ~
  =/  dd=tape  `tape`ds
  =/  hex=?  |(=('x' i.ds) =('X' i.ds))
  =/  gs=tape  ?:(hex (slag 1 dd) dd)
  =/  n=(unit @ud)  (parse-num gs hex)
  ?~  n  ~
  ::  0 and anything past the last codepoint (U+10FFFF) stay literal.
  ::  +parse-num's cap only bounds the work, and let up to ~2.000.009 through
  ?:  |(=(0 u.n) (gth u.n 0x10.ffff))  ~
  `[(trip (tuft `@c`u.n)) rest]
::
::  +parse-num: digits -> number, base 10 or 16. ~ on any non-digit, so a
::  malformed entity stays literal rather than decoding to garbage.
++  parse-num
  |=  [t=tape hex=?]
  ^-  (unit @ud)
  ::  empty is not a number. Loop over a WIDENED copy. The guard above narrows
  ::  t, and a trap that re-tests the narrowed face is a vain branch.
  ?~  t  ~
  =/  ds=tape  `tape`t
  =/  acc=@ud  0
  |-  ^-  (unit @ud)
  ?~  ds  `acc
  =/  c=@tD  i.ds
  =/  d=(unit @ud)
    ?:  &((gte c '0') (lte c '9'))  `(sub c '0')
    ?.  hex  ~
    ?:  &((gte c 'a') (lte c 'f'))  `(add 10 (sub c 'a'))
    ?:  &((gte c 'A') (lte c 'F'))  `(add 10 (sub c 'A'))
    ~
  ?~  d  ~
  ::  cap the value. A codepoint past plane 16 is not a codepoint
  ?:  (gth acc 200.000)  ~
  $(ds t.ds, acc (add (mul acc ?:(hex 16 10)) u.d))
::
::  +squeeze: tidy the finished markdown. Drop spaces before a line break,
::  collapse 3+ newlines to a blank line, trim both ends. One linear pass,
::  again accumulating reversed.
++  squeeze
  |=  t=tape
  ^-  tape
  =|  acc=tape
  =/  runs=@ud  0
  |-  ^-  tape
  ?~  t
    ::  trim the trailing whitespace we accumulated
    =/  fin=tape
      |-  ^-  tape
      ?~  acc  ~
      ?:  |(=(' ' i.acc) =(`@tD`10 i.acc))  $(acc t.acc)
      acc
    (flop fin)
  =/  c=@tD  i.t
  ?:  =(`@tD`10 c)
    ::  strip any spaces already emitted before this break
    =/  a2=tape
      |-  ^-  tape
      ?~  acc  ~
      ?:  =(' ' i.acc)  $(acc t.acc)
      acc
    ::  leading newlines never make it in. 3+ collapse to 2.
    ::  `$` is this trap. The a2 loop above is a closed =/ expression, so
    ::  `^$` here would reach the GATE and its =| would wipe acc.
    ?:  ?~(a2 & (gte runs 2))
      $(t t.t, acc a2)
    $(t t.t, acc [c a2], runs +(runs))
  ?:  &(=(' ' c) ?=(~ acc))
    $(t t.t)
  $(t t.t, acc [c acc], runs 0)
::
::  ── which urls the ship may fetch ─────────────────────────────────────
::  /clip and /share make the SHIP send a GET to a url someone handed it.
::  Left open, that reaches what only the ship can reach: its own ports, the
::  LAN, a cloud metadata service. +fetchable refuses an http(s) url whose
::  host names one of those as a literal. Each hop of a redirect is checked
::  again by the caller.
::
::  DNS rebinding stays open. Iris resolves names itself, so a public name
::  whose record points at 127.0.0.1 passes here. Only literals are caught.
::
::  The host is read the way the fetcher reads it, and anything this parser
::  does not fully understand is refused: userinfo (`@`), percent escapes,
::  backslashes, zone ids and non-ascii hosts never pass.
++  fetchable
  |=  url=@t
  ^-  ?
  =/  h=(unit [v6=? h=tape])  (url-host url)
  ?~  h  |
  !(local-host u.h)
::  +url-host: the host of an http(s) url, lowercased, and whether it was a
::  bracketed IPv6 literal. ~ for any other scheme, an empty host, or an
::  authority holding a character outside [a-z0-9.-_:[]].
++  url-host
  |=  url=@t
  ^-  (unit [v6=? h=tape])
  =/  t=tape  (cass (trip url))
  =/  r=(unit tape)
    ?:  =("http://" (scag 7 t))  `(slag 7 t)
    ?:  =("https://" (scag 8 t))  `(slag 8 t)
    ~
  ?~  r  ~
  ::  the authority runs to the first / ? or #. Capped, since no real host
  ::  is longer than 253 bytes.
  =/  au=(unit tape)
    =/  s=tape  u.r
    =|  acc=tape
    |-  ^-  (unit tape)
    ?:  (gth (lent acc) 300)  ~
    ?~  s  `(flop acc)
    ?:  |(=('/' i.s) =('?' i.s) =('#' i.s))  `(flop acc)
    $(s t.s, acc [i.s acc])
  ?~  au  ~
  ?.  (levy u.au host-char)  ~
  ?:  =("[" (scag 1 u.au))
    =/  e=(unit @ud)  (find "]" u.au)
    ?~  e  ~
    ?.  (port-ok (slag +(u.e) u.au))  ~
    `[& (slag 1 (scag u.e u.au))]
  =/  c=(unit @ud)  (find ":" u.au)
  =/  h=tape  ?~(c u.au (scag u.c u.au))
  ?.  (port-ok ?~(c ~ (slag u.c u.au)))  ~
  ?:  |(=(~ h) ?=(^ (find "[" h)) ?=(^ (find "]" h)))  ~
  `[| h]
::  +host-char: may this byte appear in an authority we accept?
++  host-char
  |=  c=@tD
  ^-  ?
  ?|  &((gte c 'a') (lte c 'z'))
      (is-dig c)
      =('.' c)  =('-' c)  =('_' c)  =(':' c)  =('[' c)  =(']' c)
  ==
++  is-dig  |=(c=@tD &((gte c '0') (lte c '9')))
::  +port-ok: what follows the host is nothing, or `:` and digits.
++  port-ok
  |=  t=tape
  ^-  ?
  ?~  t  &
  &(=(':' i.t) (levy t.t is-dig))
::  +local-host: does this host name the ship itself or a private network?
::  A name is local when it has one label (a LAN or search-domain name), or
::  is localhost, or ends in .localhost, .local or .internal. An all-number
::  host is read as an address, the way inet_aton reads one, so 127.1,
::  2130706433 and 0x7f000001 are all loopback. A host that is all numbers
::  but no address, or has an empty label, is refused.
++  local-host
  |=  [v6=? h=tape]
  ^-  ?
  ?:  v6
    =/  a=(unit @)  (ip6 h)
    ?~(a & (local-6 u.a))
  ::  one trailing dot is the same name, written absolute
  =/  n=tape  ?:(=("." (scag 1 (flop h))) (snip h) h)
  =/  ls=(list tape)  (split-on n '.')
  ?:  (lien ls |=(l=tape ?=(~ l)))  &
  =/  a=(unit (unit @))  (ip4 ls)
  ?^  a  ?~(u.a & (local-4 u.u.a))
  ?|  =(1 (lent ls))
      (ends-with n ".localhost")
      (ends-with n ".local")
      (ends-with n ".internal")
  ==
::  +local-4: 0/8, 10/8, 127/8, 100.64/10 (CGNAT), 169.254/16 (link-local,
::  where cloud metadata lives), 172.16/12, 192.168/16, and 224/3
::  (multicast and reserved).
++  local-4
  |=  a=@
  ^-  ?
  =/  o1=@  (rsh [3 3] a)
  =/  o2=@  (cut 3 [2 1] a)
  ?|  =(0 o1)  =(10 o1)  =(127 o1)
      (gte o1 224)
      &(=(100 o1) (gte o2 64) (lte o2 127))
      &(=(169 o1) =(254 o2))
      &(=(172 o1) (gte o2 16) (lte o2 31))
      &(=(192 o1) =(168 o2))
  ==
::  +local-6: :: and ::1, fc00::/7 (unique local), fe80::/10 (link-local),
::  fec0::/10 (old site-local), ff00::/8 (multicast), and an IPv4 address
::  carried in ::/96, ::ffff:0:0/96 (mapped) or 64:ff9b::/96 (NAT64) when
::  that address is local.
++  local-6
  |=  a=@
  ^-  ?
  =/  hi=@  (rsh [5 1] a)
  ?|  (lte a 1)
      =(0x7e (rsh [0 121] a))
      =(0x3fa (rsh [0 118] a))
      =(0x3fb (rsh [0 118] a))
      =(0xff (rsh [3 15] a))
      ?&  |(=(0 hi) =(0xffff hi) =(0x64.ff9b.0000.0000.0000.0000 hi))
          (local-4 (cut 5 [0 1] a))
      ==
  ==
::  +ip4: a dotted host read as inet_aton reads it. ~ when some label is not
::  a number, so the host is a name. [~ ~] when every label is a number but
::  together they are no address. [~ ~ a] otherwise. 1 to 4 parts: every
::  part but the last is a byte, and the last fills the remaining bytes.
++  ip4
  |=  ls=(list tape)
  ^-  (unit (unit @))
  ?.  (levy ls ip-numeric)  ~
  :-  ~
  =/  vs=(list @)  (murn ls ip-part)
  =/  n=@ud  (lent vs)
  ?.  =(n (lent ls))  ~
  ?:  |(=(0 n) (gth n 4))  ~
  =/  la=@  (rear vs)
  ?.  (levy (snip vs) |=(x=@ (lte x 255)))  ~
  ?:  (gte la (bex (mul 8 (sub 5 n))))  ~
  =/  hi=@  (roll (snip vs) |=([x=@ acc=@] (add (lsh 3 acc) x)))
  `(add (lsh [3 (sub 5 n)] hi) la)
::  +ip-numeric: a label inet_aton would take as a number: digits, or 0x and
::  hex digits.
++  ip-numeric
  |=  t=tape
  ^-  ?
  ?:  =("0x" (scag 2 t))
    (levy (slag 2 t) |=(c=@tD |((is-dig c) &((gte c 'a') (lte c 'f')))))
  &(!=(~ t) (levy t is-dig))
::  +ip-part: one inet_aton part. 0x is hex, a leading 0 is octal, else
::  decimal. ~ on a digit the base does not have. 12 bytes at most, so no
::  part grows without bound.
++  ip-part
  |=  t=tape
  ^-  (unit @)
  ?:  (gth (lent t) 12)  ~
  =/  b=@ud
    ?:  =("0x" (scag 2 t))  16
    ?:  &(=("0" (scag 1 t)) (gth (lent t) 1))  8
    10
  =/  ds=tape
    ?:  =(16 b)  (slag 2 t)
    ?:  =(8 b)  (slag 1 t)
    t
  =|  acc=@
  |-  ^-  (unit @)
  ?~  ds  `acc
  =/  c=@  i.ds
  =/  d=@
    ?:  (is-dig c)  (sub c '0')
    ?:  &((gte c 'a') (lte c 'f'))  (add 10 (sub c 'a'))
    99
  ?:  (gte d b)  ~
  $(ds t.ds, acc (add (mul acc b) d))
::  +ip6: an IPv6 literal (inside the brackets) as a 128-bit atom, ~ when it
::  is not one. One `::` at most. A dotted IPv4 tail is allowed last.
++  ip6
  |=  h=tape
  ^-  (unit @)
  =/  i=(unit @ud)  (find "::" h)
  =/  ws=(unit (list @))
    ?~  i  (ip6-words h &)
    =/  r=tape  (slag (add 2 u.i) h)
    ?^  (find "::" r)  ~
    =/  lw=(unit (list @))  (ip6-words (scag u.i h) |)
    =/  rw=(unit (list @))  (ip6-words r &)
    ?~  lw  ~
    ?~  rw  ~
    =/  k=@ud  (add (lent u.lw) (lent u.rw))
    ?:  (gth k 7)  ~
    `:(weld u.lw (reap (sub 8 k) `@`0) u.rw)
  ?~  ws  ~
  ?.  =(8 (lent u.ws))  ~
  `(roll u.ws |=([w=@ acc=@] (add (lsh 4 acc) w)))
::  +ip6-words: colon-separated hex groups -> 16-bit words. end: this run
::  ends the address, so its last group may be a dotted IPv4 (two words).
::  An empty run has no words.
++  ip6-words
  |=  [t=tape end=?]
  ^-  (unit (list @))
  ?~  t  `~
  =/  gs=(list tape)  (split-on t ':')
  =|  out=(list @)
  |-  ^-  (unit (list @))
  ?~  gs  `(flop out)
  ?:  &(end ?=(~ t.gs) ?=(^ (find "." i.gs)))
    =/  v=(unit @)  (ip-quad i.gs)
    ?~  v  ~
    `(flop [(cut 4 [0 1] u.v) (cut 4 [1 1] u.v) out])
  ?:  |(=(~ i.gs) (gth (lent i.gs) 4))  ~
  ?.  (levy i.gs |=(c=@tD |((is-dig c) &((gte c 'a') (lte c 'f')))))  ~
  $(gs t.gs, out [(scan i.gs hex) out])
::  +ip-quad: a strict dotted quad, four decimal bytes.
++  ip-quad
  |=  t=tape
  ^-  (unit @)
  =/  ls=(list tape)  (split-on t '.')
  ?.  =(4 (lent ls))  ~
  ?.  %+  levy  ls
      |=  l=tape
      ?&  !=(~ l)
          (lte (lent l) 3)
          (levy l is-dig)
          (lte (scan l dem) 255)
      ==
    ~
  `(roll ls |=([l=tape acc=@] (add (lsh 3 acc) (scan l dem))))
::  +split-on: a tape cut at every c. "" gives one empty piece.
++  split-on
  |=  [t=tape c=@tD]
  ^-  (list tape)
  =|  cur=tape
  =|  out=(list tape)
  |-  ^-  (list tape)
  ?~  t  (flop [(flop cur) out])
  ?:  =(c i.t)  $(t t.t, cur ~, out [(flop cur) out])
  $(t t.t, cur [i.t cur])
::  +ends-with: does t end in s?
++  ends-with
  |=  [t=tape s=tape]
  ^-  ?
  ?:  (lth (lent t) (lent s))  |
  =(s (slag (sub (lent t) (lent s)) t))
--
