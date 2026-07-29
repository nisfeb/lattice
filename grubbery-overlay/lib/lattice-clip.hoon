::  lattice-clip: html -> markdown, so a clearweb page can be archived as an
::  ordinary lattice page. Used by the /clip route in nex/lattice/app.hoon.
::
::  Two arms matter: +to-md converts a document, +page-title pulls its <title>
::  to name the archive.
::
::  Shape of the thing: ONE linear pass. Output accumulates REVERSED through
::  +emit and is flopped once at the end — welding onto a growing tape is the
::  quadratic that has wedged this ship before, so +emit is deliberately the
::  only way to append and it never touches more than the short literal it is
::  given. Forward scans (a closing tag, a comment terminator, a quoted
::  attribute value) each consume the input they skip, so they cannot be
::  re-run over the same ground, and the input is capped up front regardless.
::
::  This is a converter, not a parser: malformed html must degrade into
::  imperfect markdown, never bail. Every "can't happen" branch has a value.
::
|%
::  +cap: nothing here reads more input than this. A hostile or merely
::  enormous page truncates; it never runs away.
++  cap  2.000.000
++  nl  ^-(tape ~[`@tD`10])
::  +emit: append `s` to the reversed accumulator. The ONLY append.
++  emit  |=([acc=tape s=tape] ^-(tape (weld (flop s) acc)))
::  +brk: a line break, carrying the blockquote marker when we are inside one
::  — markdown needs '>' on every line of a quote, not just the first.
++  brk  |=(q=? ^-(tape ?:(q (weld nl "> ") nl)))
::
::  +to-md: document -> markdown.
++  to-md
  |=  html=@t
  ^-  @t
  =/  t=tape  (scag cap (trip html))
  =/  out=tape  (squeeze (walk (region t)))
  (crip out)
::
::  +page-title: the <title>, entity-decoded and whitespace-collapsed.
++  page-title
  |=  html=@t
  ^-  (unit @t)
  =/  raw=tape  (scag cap (trip html))
  =/  low=tape  (cass raw)
  =/  o=(unit @ud)  (find "<title" low)
  ?~  o  ~
  =/  g=(unit @ud)  (find ">" `tape`(slag u.o low))
  ?~  g  ~
  =/  beg=@ud  (add u.o +(u.g))
  =/  e=(unit @ud)  (find "</title" `tape`(slag beg low))
  ?~  e  ~
  ::  slice the ORIGINAL, not the lowercased copy — the title keeps its case.
  =/  txt=tape  (scag u.e `tape`(slag beg raw))
  =/  out=tape  (squeeze (unent txt))
  ?~(out ~ `(crip `tape`out))
::
::  +region: the article body. <main> or <article> when present — that IS the
::  content and everything around it is site chrome — else <body>, else the
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
::  tag's own '>'. Tags are matched case-insensitively; the text keeps its case.
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
::  +drop-tag: tags whose CONTENT goes with them — executable, or page chrome
::  that is not the article. Everything else keeps its text.
++  drop-tag
  |=  n=tape
  ^-  ?
  ?=  $?  %script  %style  %head  %noscript  %svg  %iframe
          %form    %nav    %footer  %aside   %template  %button
      ==
  (crip n)
::
::  +tag: at a '<', split off the tag — lowercased name, whether it closes,
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
::  +attr: an attribute's value. Quoted or bare; the name is matched
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
  ::  unquoted value: walk `vv`, not `v` — v is already narrowed non-empty by
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
++  safe-url
  |=  u=tape
  ^-  ?
  =/  l=tape  (cass u)
  ?&  !=("javascript:" (scag 11 l))
      !=("data:" (scag 5 l))
      ?=(^ u)
  ==
::
::  +walk: the pass.
::    acc  output, REVERSED
::    pre  inside <pre> — verbatim, no whitespace collapsing
::    quo  inside <blockquote> — every line break carries '> '
::    sp   whitespace was seen and not yet emitted; this is how runs of
::         spaces and newlines collapse without a second pass
::    lnk  ~ when not in a link (or the link was dropped); [~ url] when we
::         have emitted '[' and owe a '](url)'
++  walk
  |=  t=tape
  ^-  tape
  =|  acc=tape
  ::  These MUST be =/ with an explicit |, not =|. The bunt of `?` is %.y, so
  ::  `=| pre=?` starts pre TRUE — which made the "inside <pre>" guard swallow
  ::  every tag but <pre> itself, put a blockquote marker on every line, and
  ::  route all text down the verbatim path. One character, whole converter.
  =/  pre=?  |
  =/  quo=?  |
  =/  sp=?   |
  =|  lnk=(unit tape)
  |-  ^-  tape
  ?~  t  (flop acc)
  ::  `?~` above narrows t to a non-empty tape, and a WET gate (scag/slag/find)
  ::  handed that narrowed type mull-grows. Re-widen ONCE here and pass `tt` to
  ::  every wet gate below — casting their result instead does nothing, because
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
    ::  an entity is text, so it flushes any pending space like any other char
    ::  — and so does a BARE ampersand, which is why the flush is computed
    ::  before the branch. Doing it only on the entity path turned "Tom & Jerry"
    ::  into "Tom& Jerry".
    =/  a2=tape  ?:(&(sp ?=(^ acc)) (emit acc " ") acc)
    =/  d=(unit [c=tape rest=tape])  (unent-one (slag 1 tt))
    ?~  d  $(t t.t, acc (emit a2 "&"), sp |)
    ::  an entity that decodes to a plain space (&nbsp;) is whitespace like any
    ::  other — hand it to the collapser instead of emitting it verbatim, or an
    ::  &nbsp; stacks on top of the literal spaces around it.
    ?:  =(" " c.u.d)  $(t rest.u.d, sp &)
    $(t rest.u.d, acc (emit a2 c.u.d), sp |)
  ?:  =('<' c)
    =/  g  (tag tt)
    ?~  nam.g
      ::  a '<' that never closes is prose, not markup
      $(t t.t, acc (emit acc "<"), sp |)
    =/  n=tape  nam.g
    ::  drop the tag AND its content
    ?:  &(!cls.g (drop-tag n))
      =/  e=(unit @ud)  (find (weld "</" n) (cass `tape`rest.g))
      ?~  e  (flop acc)
      =/  aft=tape  (slag u.e `tape`rest.g)
      =/  g2=(unit @ud)  (find ">" aft)
      ?~  g2  (flop acc)
      $(t (slag +(u.g2) aft), sp &)
    ::  inside <pre> only </pre> means anything; other tags are shown as text
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
    ::  `flu` rather than `acc`; dropping the space glued "with **bold**" into
    ::  "with**bold**". Closing markers deliberately do NOT flush — the space
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
::  +block: does this tag end a line? NOT %li — a closing </li> would then add
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
::  is a bare ampersand — which is common in prose and must stay literal.
++  unent-one
  |=  t=tape
  ^-  (unit [c=tape rest=tape])
  ::  an entity name is short; anything longer is a stray '&'
  =/  e=(unit @ud)  (find ";" (scag 12 t))
  ?~  e  ~
  =/  nam=tape  (scag u.e t)
  =/  rest=tape  (slag +(u.e) t)
  ?~  nam  ~
  ::  widened copy for the wet gates below — see the note in +walk
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
  ?:  =(0 u.n)  ~
  `[(trip (tuft `@c`u.n)) rest]
::
::  +parse-num: digits -> number, base 10 or 16. ~ on any non-digit, so a
::  malformed entity stays literal rather than decoding to garbage.
++  parse-num
  |=  [t=tape hex=?]
  ^-  (unit @ud)
  ::  empty is not a number. Loop over a WIDENED copy: the guard above narrows
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
  ::  cap the value: a codepoint past plane 16 is not a codepoint
  ?:  (gth acc 200.000)  ~
  $(ds t.ds, acc (add (mul acc ?:(hex 16 10)) u.d))
::
::  +squeeze: tidy the finished markdown — drop spaces before a line break,
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
    ::  leading newlines never make it in; 3+ collapse to 2.
    ::  `$` is this trap — the a2 loop above is a closed =/ expression, so
    ::  `^$` here would reach the GATE and its =| would wipe acc.
    ?:  ?~(a2 & (gte runs 2))
      $(t t.t, acc a2)
    $(t t.t, acc [c a2], runs +(runs))
  ?:  &(=(' ' c) ?=(~ acc))
    $(t t.t)
  $(t t.t, acc [c acc], runs 0)
--
