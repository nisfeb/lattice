::  /lib/lattice-gmi, a gemtext -> HTML renderer (server-side).
::
::  Lifted out of the nexus so it can be tested. Its sibling render-md has
::  lived in a lib with a test suite since it was written; this one sat inline
::  in app.hoon with neither, and had shipped two bugs that a single test would
::  have caught. See tests/lib/lattice-gmi.
::
::  One way, on purpose. There is a fuller gemtext library in the wild
::  (tinnus-napbus/docs-app) that parses to a typed AST, encodes back, and
::  merges through clay. This does none of that because the reader only ever
::  needs cord in, HTML out. What it does have that a general library cannot:
::  urb:// links route back through the reader rather than off the ship.
::
::  No imports, deliberately, and for the reason lattice-know states about
::  itself: this file has to compile BOTH in a plain desk /lib, where the
::  tests can reach it, and in grubbery's gub/lib, where the nexus wraps it.
::  A cross-lib import satisfies one of those and fails the other.
::
::  So esc is a copy of the one in lattice-md rather than a reference to it.
::  That is the price of being testable at all. They escape the same four
::  characters and must keep doing so: change one, change the other.
|%
++  esc
  |=  t=tape
  ^-  tape
  %-  zing
  %+  turn  t
  |=  c=@tD
  ?+  c  ~[c]
    %'&'  "&amp;"
    %'<'  "&lt;"
    %'>'  "&gt;"
    %'"'  "&quot;"
  ==
++  has-prefix  |=([pre=tape t=tape] =(pre (scag (lent pre) t)))
::  +ltrim: drop leading spaces. gemtext allows extra whitespace after a
::  sigil ("=> ", "* ", "#"), and it is never content.
++  ltrim
  |=  a=tape
  ^-  tape
  ?~  a  a
  ?:(=(' ' i.a) $(a t.a) a)
::  +strip-cr: drop one trailing carriage return.
::
::    to-wain splits on \0a alone, so every line of a CRLF document arrives
::    carrying a \0d. It is not content, and left in place it lands inside the
::    escaped text and inside hrefs.
++  strip-cr
  |=  a=tape
  ^-  tape
  =/  n=@ud  (lent a)
  ?:  =(0 n)  a
  ?.  =('\0d' (snag (dec n) a))  a
  (scag (dec n) a)
::  +render-gmi: gemtext body -> HTML fragment.
::
::    Handles headings, => links, * lists, > quotes, ``` blocks and
::    paragraphs. urb:// links route back through the reader; http(s) opens
::    in a new tab; anything else renders as its description text alone,
::    never as an href, because the scheme list is the allowlist.
::
::    Output accumulates as a list of per-line chunks zinged once at the end.
::    Welding each line onto one growing tape re-copied the whole document per
::    line, quadratic in document size, on the unauthenticated reader path.
++  render-gmi
  |=  body=@t
  ^-  tape
  =/  lines=(list @t)  (to-wain:format body)
  =|  acc=(list tape)
  =/  pre=?  |
  =/  lst=?  |
  =|  prebuf=(list @t)
  |-  ^-  tape
  ?~  lines
    ::  close whatever is still open. An unterminated fence still renders as
    ::  a block, because dropping the text would be worse than a missing tag.
    =?  acc  lst  ["</ul>" acc]
    ?:  pre
      %-  zing  %-  flop
      [:(weld "<pre>" (esc (trip (of-wain:format (flop prebuf)))) "</pre>") acc]
    (zing (flop acc))
  =/  ln=tape  (strip-cr (trip i.lines))
  ?:  pre
    ::  a closing fence is ``` and whatever follows it. Matching the whole
    ::  line meant ```hoon never opened a block, so the CLOSING fence opened
    ::  one instead and swallowed the rest of the document into it.
    ?.  (has-prefix "```" ln)  $(lines t.lines, prebuf [i.lines prebuf])
    %=  $
      lines   t.lines
      pre     |
      prebuf  ~
      acc     [:(weld "<pre>" (esc (trip (of-wain:format (flop prebuf)))) "</pre>") acc]
    ==
  ::  any line that is not a bullet closes an open list, before anything else
  ::  decides what that line is. The same line is then re-read below.
  ?:  &(lst !(has-prefix "* " ln))
    $(lst |, acc ["</ul>" acc])
  ::  the alt text after an opening fence names a language. Nothing here uses
  ::  it, but it must not be mistaken for content.
  ?:  (has-prefix "```" ln)  $(lines t.lines, pre &, prebuf ~)
  ::  headings take optional whitespace after the hashes, so #Heading is one.
  ?:  (has-prefix "###" ln)  $(lines t.lines, acc [:(weld "<h3>" (esc (ltrim (slag 3 ln))) "</h3>") acc])
  ?:  (has-prefix "##" ln)   $(lines t.lines, acc [:(weld "<h2>" (esc (ltrim (slag 2 ln))) "</h2>") acc])
  ?:  (has-prefix "#" ln)    $(lines t.lines, acc [:(weld "<h1>" (esc (ltrim (slag 1 ln))) "</h1>") acc])
  ::  a list item, and the <ul> that opens on the first of a run
  ?:  (has-prefix "* " ln)
    =/  item=tape  :(weld "<li>" (esc (ltrim (slag 2 ln))) "</li>")
    ?:  lst  $(lines t.lines, acc [item acc])
    $(lines t.lines, lst &, acc [item "<ul>" acc])
  ?:  (has-prefix "=> " ln)
    =/  rest=tape  (ltrim (slag 3 ln))
    =/  sp=(unit @ud)  (find " " rest)
    =/  raw=tape   ?~(sp rest (scag u.sp rest))
    =/  dsc=tape   (ltrim ?~(sp rest (slag +(u.sp) rest)))
    ::  a link with no description shows its url. An empty <a> is unclickable
    ::  and invisible, which is the one thing a link must never be.
    =/  desc=tape  ?:(=(~ dsc) raw dsc)
    =/  anchor=tape
      ?:  =("urb://" (scag 6 raw))
        :(weld "<a href=\"/apps/lattice?url=" (esc raw) "\">" (esc desc) "</a>")
      ?:  |(=("http://" (scag 7 raw)) =("https://" (scag 8 raw)))
        :(weld "<a href=\"" (esc raw) "\" target=\"_blank\" rel=\"noopener noreferrer\">" (esc desc) "</a>")
      (esc desc)
    $(lines t.lines, acc [:(weld "<p>" anchor "</p>") acc])
  ?:  (has-prefix "> " ln)
    $(lines t.lines, acc [:(weld "<blockquote>" (esc (ltrim (slag 2 ln))) "</blockquote>") acc])
  ?:  =("" ln)  $(lines t.lines)
  $(lines t.lines, acc [:(weld "<p>" (esc ln) "</p>") acc])
--
