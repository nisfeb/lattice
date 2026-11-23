::  Unit tests for /lib/lattice-md (GFM -> HTML). Run via the run-tests MCP tool.
::
/+  *test, md=lattice-md
|%
++  r    render-md:md
++  has  |=([n=tape h=tape] ^-(? ?=(^ (find n h))))
++  yes  |=(c=? (expect-eq !>(&) !>(c)))
::  headings
++  test-h1     (yes (has "<h1>H1</h1>" (r '# H1')))
++  test-h6     (yes (has "<h6>H6</h6>" (r '###### H6')))
++  test-setext-h1  (yes (has "<h1>" (r 'Title\0a=====')))
++  test-setext-h2  (yes (has "<h2>" (r 'Title\0a-----')))
::  emphasis
++  test-bold-star   (yes (has "<strong>b</strong>" (r '**b**')))
++  test-bold-under  (yes (has "<strong>b</strong>" (r '__b__')))
++  test-em-star     (yes (has "<em>i</em>" (r '*i*')))
++  test-em-under    (yes (has "<em>i</em>" (r '_i_')))
++  test-bolditalic  (yes (has "<strong><em>x</em></strong>" (r '***x***')))
++  test-strike      (yes (has "<del>s</del>" (r '~~s~~')))
::  code
++  test-code-inline  (yes (has "<code>c</code>" (r '`c`')))
++  test-fence-lang   (yes (has "language-js" (r '```js\0avar x=1;\0a```')))
++  test-fence-esc    (yes (has "&lt;b&gt;" (r '```\0a<b>\0a```')))
::  lists
++  test-ul       (yes (has "<ul>" (r '- a\0a- b')))
++  test-ul-star  (yes (has "<ul>" (r '* a\0a* b')))
++  test-ul-plus  (yes (has "<ul>" (r '+ a\0a+ b')))
++  test-ol       (yes (has "<ol>" (r '1. a\0a2. b')))
++  test-task-x   (yes (has "checked" (r '- [x] done')))
++  test-task-o   (yes ?!((has "checked" (r '- [ ] todo'))))
++  test-nested   (yes (has "<ul><li>a<ul>" (r '- a\0a  - b')))
++  test-list-switch  (yes (has "</ul><ol>" (r '- a\0a1. b')))
::  tables
++  test-table       (yes (has "<table>" (r '| a | b |\0a|---|---|\0a| 1 | 2 |')))
++  test-table-th    (yes (has "<th>a</th>" (r '| a | b |\0a|---|---|\0a| 1 | 2 |')))
++  test-table-td    (yes (has "<td>1</td>" (r '| a | b |\0a|---|---|\0a| 1 | 2 |')))
++  test-table-align  (yes (has "text-align:center" (r '| a |\0a|:-:|\0a| 1 |')))
::  blockquote
++  test-quote        (yes (has "<blockquote>" (r '> q')))
++  test-quote-nested  (yes (has "</blockquote></blockquote>" (r '> a\0a> > b')))
::  rules
++  test-hr-dash   (yes (has "<hr>" (r '---')))
++  test-hr-star   (yes (has "<hr>" (r '***')))
++  test-hr-under  (yes (has "<hr>" (r '___')))
::  links + images
++  test-link       (yes (has "<a href=\"http://x\"" (r '[t](http://x)')))
++  test-link-title  (yes (has "title=\"T\"" (r '[t](http://x "T")')))
++  test-link-ref   (yes (has "<a href=\"http://z\"" (r '[t][k]\0a\0a[k]: http://z')))
++  test-image      (yes (has "<img src=\"/x.png\"" (r '![a](/x.png)')))
::  a remote image is a link to it by default, an <img> only `outside`
++  test-image-remote-shut
  =/  o=tape  (r '![a](http://x)')
  ;:  weld
    (yes ?!((has "<img" o)))
    (yes (has "<a href=\"http://x\"" o))
    (yes ?!((has "<img" (r '![a](HTTPS://x)'))))
    (yes ?!((has "<img" (r '![a][k]\0a\0a[k]: https://z'))))
  ==
++  test-image-remote-outside
  (yes (has "<img src=\"http://x\"" (~(render-md md &) '![a](http://x)')))
::  a protocol-relative url is another host: neither a link nor an image
++  test-safe-protocol-relative
  ;:  weld
    (yes ?!((safe-url:md "//evil.example/p.png")))
    (yes ?!((safe-url:md "/\\evil.example")))
    (yes ?!((safe-url:md "\\\\evil.example")))
    (yes ?!((safe-url:md "/\09/evil.example")))
    (yes ?!((safe-url:md " //evil.example")))
    (yes ?!((has "evil" (r '![a](//evil.example/p.png)'))))
    (yes ?!((has "href" (r '[a](//evil.example/)'))))
    (yes (safe-url:md "/apps/lattice"))
    (yes (safe-url:md "a/b"))
    (yes (safe-url:md "#x"))
  ==
++  test-autolink   (yes (has "<a href=\"http://x\"" (r '<http://x>')))
::  escapes + safety
++  test-escape     (yes ?!((has "<em>" (r '\\*x\\*'))))
++  test-safe-js    (yes ?!((has "<a href" (r '[t](javascript:alert(1))'))))
++  test-html-esc   (yes (has "&lt;script&gt;" (r 'a <script> b')))
++  test-foot-ref   (yes (has "<sup" (r 'x[^a] y\0a\0a[^a]: a note')))
++  test-foot-num   (yes (has ">1</a>" (r 'x[^a] y\0a\0a[^a]: a note')))
++  test-foot-list  (yes (has "class=\"footnotes\"" (r 'x[^a] y\0a\0a[^a]: a note')))
::  wikilinks
++  wl  |=([t=tape base=tape] (wikilinkify:md t base))
::  a bare [[path]] shows only its last segment (the filename), not the whole
::  path; the link target is still the full path.
++  test-wiki-nolabel
  (yes (has "[b](/w/a/b)" (wl "[[a/b]]" "/w/")))
++  test-wiki-nolabel-bare
  (yes (has "[x](/w/x)" (wl "[[x]]" "/w/")))
++  test-wiki-nolabel-deep
  (yes (has "[c](/w/a/b/c)" (wl "[[a/b/c]]" "/w/")))
++  test-wiki-nolabel-trailing
  (yes (has "[a](/w/a/)" (wl "[[a/]]" "/w/")))
++  test-wiki-label
  (yes (has "[Some Label](/w/a/b)" (wl "[[a/b|Some Label]]" "/w/")))
++  test-wiki-escape
  (yes (has "[[a/b|x]]" (wl "`[[a/b|x]]`" "/w/")))
::  ordered markers: 0 and 9 are digits, and a marker needs digits and text
::  (hoon-mutate, 2026-09-26)
++  test-ol-zero  (yes (has "<ol>" (r '0. a')))
++  test-ol-nine  (yes (has "<ol>" (r '9. a')))
++  test-ol-letter-not-digit  (yes !(has "<ol>" (r 'a. b')))
++  test-ol-needs-digits  (yes !(has "<ol>" (r '. a')))
++  test-ol-bare-number   (yes !(has "<ol>" (r '12')))
::  one case per clause (hoon-mutate, 2026-09-26)
::  an image needs "![": a lone '!' leaves the links after it alone
++  test-bang-then-link  (yes (has "<a href=\"/u\"" (r '!x [a](/u)')))
::  a tab indents a nested list like spaces do
++  test-nested-tab  (yes (has "<ul><li>a<ul>" (r '- a\0a\09- b')))
::  a footnote ref needs both '[' and '^'
++  test-foot-needs-bracket  (yes !(has "<sup" (r 'x^a] y\0a\0a[^a]: n')))
::  the mutant reads the id 2 bytes on, so [xa] is what would pass for [^a]
++  test-foot-needs-caret    (yes !(has "<sup" (r '[xa] y\0a\0a[^a]: n')))
::  list markers: text alone is no bullet, ')' ends a number, and digits
::  need a '.' or ')'
++  test-no-bullet   (yes !(has "<ul>" (r 'a b')))
++  test-ol-paren    (yes (has "<ol>" (r '1) a')))
++  test-ol-needs-dot  (yes !(has "<ol>" (r '12x y')))
::  a blank line inside a list keeps one list; an unindented line ends it
++  test-list-loose  (yes (has "</li><li>b" (r '- a\0a\0a- b')))
++  test-list-ends   (yes (has "<p>next</p>" (r '- a\0anext')))
::  tables: outer pipes are optional, an escape is not a pipe, an empty
::  separator cell or a bare "|" row doesn't crash, alignment is per side,
::  and a line with no pipe ends the table
++  test-table-bare-pipes
  =/  h=tape  (r 'a | b\0a--|--\0a1 | 2')
  (yes &((has "<th>a</th>" h) (has "<th>b</th>" h) (has "<td>2</td>" h)))
++  test-table-escaped-pipe  (yes (has "<th>a*b</th>" (r '| a\\*b |\0a|---|\0a| x |')))
++  test-table-empty-sep     (yes (has "<table>" (r '| a | b |\0a|---| |\0a| 1 | 2 |')))
++  test-table-bare-row      (yes (has "<table>" (r '| a |\0a|---|\0a|')))
++  test-table-right  (yes (has "text-align:right" (r '| a |\0a|--:|\0a| 1 |')))
++  test-table-left   (yes (has "text-align:left" (r '| a |\0a|:--|\0a| 1 |')))
++  test-table-ends   (yes (has "<p>after</p>" (r '| a |\0a|---|\0a| 1 |\0aafter')))
::  a quote takes only its '>' lines
++  test-quote-ends  (yes (has "</blockquote><p>after</p>" (r '> q\0a\0aafter')))
::  a wiki name runs over both ends of each range
++  test-wiki-name-edges  (yes (has "[az09](/w/az09)" (wl "[[az09]]" "/w/")))
::  a space is below '0' and not a name byte
++  test-wiki-name-space  (yes (has "[[a b]]" (wl "[[a b]]" "/w/")))
::  backlink-hit: plain and labelled wikilinks count, a longer name does not
++  test-backlink-plain  (yes (backlink-hit:md "a/b" "see [[a/b]] here"))
++  test-backlink-label  (yes (backlink-hit:md "a/b" "see [[a/b|Sarah]] here"))
++  test-backlink-miss   (yes !(backlink-hit:md "a/b" "see [[a/bc]] here"))
++  test-backlink-none   (yes !(backlink-hit:md "a/b" "no links"))
::
::  shapes that were quadratic: each renders in about a second now, and the
::  text around them still renders right
++  test-nested-brackets-bounded
  =/  t=@t  (crip (weld (reap 6.000 '[') (reap 6.000 ']')))
  (yes (has "[[[" (r t)))
++  test-link-after-a-capped-scan
  =/  t=@t  (crip :(weld "[" (reap 3.000 'a') "] then [x](http://u.example)"))
  (yes (has "<a href=\"http://u.example\"" (r t)))
++  test-link-after-deep-nesting
  (yes (has "<a href=\"http://u.example\"" (r '[[[a]]] then [x](http://u.example)')))
++  test-many-label-openers
  =/  t=tape  (zing (reap 8.000 "[[a|b "))
  (expect-eq !>(t) !>((wl t "/")))
++  test-label-after-many-openers
  =/  o=tape  (zing (reap 8.000 "[[a|b "))
  =/  t=tape  (weld o "]] [[c|d]]")
  (yes (has "[d](/c)" (wl t "/")))
++  test-spaced-quote-depth
  =/  q=tape  (zing (reap 4.000 "> "))
  =/  t=@t  (crip (weld q "x"))
  (expect-eq !>(32) !>((lent (fand "<blockquote>" (r t)))))
::  +rewrite-wikilinks: a move rewrites [[from]], [[from/x]] and the
::  labelled [[from|label]], and leaves [[fromx]] alone
++  test-rewrite-wikilinks
  =/  rw  |=(h=tape (rewrite-wikilinks:md h "a/b" "c/d"))
  ;:  weld
    (expect-eq !>("see [[c/d]]") !>((rw "see [[a/b]]")))
    (expect-eq !>("[[c/d/x]]") !>((rw "[[a/b/x]]")))
    (expect-eq !>("[[c/d|the b page]]") !>((rw "[[a/b|the b page]]")))
    (expect-eq !>("[[a/bc]] [[c/d]]") !>((rw "[[a/bc]] [[a/b]]")))
    (expect-eq !>("[[c/d") !>((rw "[[a/b")))
  ==
::  a line of seven or more hashes is no heading. It is a paragraph, and
::  the render ends
++  test-seven-hashes
  ;:  weld
    (expect-eq !>("<p>#######</p>") !>((r '#######')))
    (expect-eq !>("<p>####### x</p>") !>((r '####### x')))
    (expect-eq !>("<p>a ####### x</p><p>b</p>") !>((r 'a\0a####### x\0a\0ab')))
  ==
::  the block loop always makes progress. Every character that can start
::  a block, alone and repeated, bare and mixed with spaces, renders to
::  an end, on one line and on two.
++  test-hostile-lines-end
  =/  cs=tape  "#>-*_+=|`~[]!<1.):\\ \09"
  =/  ns=(list @ud)  ~[1 3 6 7 8]
  =/  lines=(list tape)
    %-  zing
    ^-  (list (list tape))
    %+  turn  cs
    |=  c=@tD
    ^-  (list tape)
    %-  zing
    ^-  (list (list tape))
    %+  turn  ns
    |=  n=@ud
    ^-  (list tape)
    =/  run=tape  (reap n c)
    :~  run
        (weld " " run)
        (weld run " x")
        (zing (reap n `tape`~[c ' ']))
        (weld run "x")
    ==
  =/  ok=?
    %+  levy  lines
    |=  a=tape
    ?&  (gte (lent (r (crip a))) 0)
        (gte (lent (r (crip (weld a "\0a---")))) 0)
        (gte (lent (r (crip (weld "x\0a" a)))) 0)
    ==
  (yes ok)
::  a heading needs a space or a tab after its hashes, as the browser
::  preview and the outline have it. A hashtag, an issue number or a
::  shebang at the start of a line is text.
++  test-heading-needs-space
  ;:  weld
    (expect-eq !>("<p>#tag line</p>") !>((r '#tag line')))
    (expect-eq !>("<p>#123</p>") !>((r '#123')))
    (expect-eq !>("<p>#!/bin/sh</p>") !>((r '#!/bin/sh')))
    (expect-eq !>("<p>######x</p>") !>((r '######x')))
    (expect-eq !>("<p>#</p>") !>((r '#')))
    (expect-eq !>("<h1></h1>") !>((r '# ')))
    (expect-eq !>("<h2>t</h2>") !>((r '##\09t')))
    (expect-eq !>("<h3>t</h3>") !>((r '  ### t ###')))
    ::  a line of text is not cut at a hashtag line under it
    (expect-eq !>("<p>a #tag</p>") !>((r 'a\0a#tag')))
    (expect-eq !>("<p>a</p><h1>h</h1>") !>((r 'a\0a# h')))
  ==
::  a body with CRLF line ends renders as the same body with LF
++  test-crlf
  ;:  weld
    (expect-eq !>("<p>a</p><p>b</p>") !>((r 'a\0d\0a\0d\0ab')))
    (expect-eq !>((r '| a |\0a|---|\0a| 1 |')) !>((r '| a |\0d\0a|---|\0d\0a| 1 |\0d\0a')))
    (expect-eq !>("<hr>") !>((r '---\0d')))
    (expect-eq !>("<h1>T</h1>") !>((r 'T\0d\0a===\0d')))
    (expect-eq !>((r '- a\0a- b')) !>((r '- a\0d\0a- b\0d\0a')))
    (expect-eq !>((r '```\0ax\0a```\0ay')) !>((r '```\0d\0ax\0d\0a```\0d\0ay\0d\0a')))
    (expect-eq !>("<h2>h</h2>") !>((r '## h\0d')))
    ::  only the one CR that ends a line goes
    (expect-eq !>("<p>a\0db</p>") !>((r 'a\0db')))
  ==
::  two spaces at the end of a line are a line break, a real one. Text
::  that spells a tag is still text.
++  test-hard-break
  ;:  weld
    (expect-eq !>("<p>a<br>b</p>") !>((r 'a  \0ab')))
    (expect-eq !>("<p>a<br>b c<br>d</p>") !>((r 'a  \0ab\0ac   \0ad')))
    (expect-eq !>("<p>a b</p>") !>((r 'a\0ab')))
    (expect-eq !>("<p>a b</p>") !>((r 'a \0ab')))
    (expect-eq !>("<p>a</p>") !>((r 'a  ')))
    (expect-eq !>("<p>a &lt;br&gt; b</p>") !>((r 'a <br> b')))
    (expect-eq !>("<p><em>a<br>b</em></p>") !>((r '*a  \0ab*')))
    (expect-eq !>("<p><a href=\"/u\" target=\"_blank\" rel=\"noopener noreferrer\">a<br>b</a></p>") !>((r '[a  \0ab](/u)')))
    (expect-eq !>("<p>a\\<br>b</p>") !>((r 'a\\  \0ab')))
  ==
::  code is verbatim: a line inside a fence is never a reference or a
::  footnote definition, and a footnote mark in code is not rewritten
++  test-defs-not-in-code
  =/  lnk=tape  "<a href=\"/u\""
  ;:  weld
    (expect-eq !>("<pre><code>[k]: v\0a</code></pre>") !>((r '```\0a[k]: v\0a```')))
    (expect-eq !>("<pre><code>[^1]: note\0a</code></pre>") !>((r '~~~\0a[^1]: note\0a~~~')))
    (yes (has "<code>[^a] in code\0a</code>" (r 'x[^a]\0a\0a```\0a[^a] in code\0a```\0a\0a[^a]: note')))
    (yes (has "<sup" (r 'x[^a]\0a\0a```\0a[^a] in code\0a```\0a\0a[^a]: note')))
    (yes (has "<code>[^a]</code> and <sup" (r 'see `[^a]` and [^a]\0a\0a[^a]: n')))
    (yes (has "<code>[^a]</code> and <sup" (r 'see ``[^a]`` and [^a]\0a\0a[^a]: n')))
    ::  a definition after a closed fence still counts
    (yes (has lnk (r '```\0ax\0a```\0a[t][k]\0a\0a[k]: /u')))
    ::  a fence in a quote: its lines are code, and it ends with the quote
    (yes (has "[k]: v" (r '> ```\0a> [k]: v\0a> ```\0a\0a[t][k]\0a\0a[k]: /u')))
    (yes (has lnk (r '> ```\0a> [k]: v\0a> ```\0a\0a[t][k]\0a\0a[k]: /u')))
    (yes (has lnk (r '> ```\0a> code\0a\0a[t][k]\0a\0a[k]: /u')))
    ::  a quoted fence line does not close a fence outside the quote
    (yes (has "[k]: v" (r '```\0a> ```\0a[k]: v\0a```')))
  ==
::  a reference definition has a one-word destination and at most a
::  quoted title. A line of prose that starts with a bracketed label
::  is a paragraph.
++  test-ref-def-shape
  ;:  weld
    (expect-eq !>("<p>[10:02]: called Bob</p>") !>((r '[10:02]: called Bob')))
    (expect-eq !>("<p>[TODO]: fix the importer</p>") !>((r '[TODO]: fix the importer')))
    (expect-eq !>("<p>[k]: /u trailing</p>") !>((r '[k]: /u trailing')))
    (expect-eq !>("") !>((r '[k]: /u')))
    (expect-eq !>("") !>((r '[k]: /u "T"')))
    (expect-eq !>("") !>((r '[k]:   /u   "T"')))
    (yes (has "href=\"/u\" title=\"T\"" (r '[t][k]\0a\0a[k]: /u "T"')))
  ==
::  an unclosed '[' before a link does not turn the link into text. The
::  scan from the stray bracket fails only because the link's own ']'
::  closed the link's '[', which says nothing about the rest.
++  test-link-after-stray-bracket
  =/  lnk=tape  "<a href=\"/u\" target=\"_blank\" rel=\"noopener noreferrer\">b</a>"
  ;:  weld
    (expect-eq !>(:(weld "<p>[ a " lnk "</p>")) !>((r '[ a [b](/u)')))
    (expect-eq !>(:(weld "<p>range [0, 1) see " lnk "</p>")) !>((r 'range [0, 1) see [b](/u)')))
    (expect-eq !>(:(weld "<p>[ a " lnk " and " lnk "</p>")) !>((r '[ a [b](/u) and [b](/u)')))
    (yes (has "<img src=\"/x.png\"" (r '[ a ![i](/x.png)')))
    (yes (has "<img src=\"/x.png\"" (r '![ a ![i](/x.png)')))
    (yes (has "<td>[ a <a href=\"/u\"" (r '| h |\0a|---|\0a| [ a [b](/u) |')))
    ::  with no ']' at all the text is unchanged
    (expect-eq !>("<p>[ a [ b</p>") !>((r '[ a [ b')))
  ==
::  an underscore inside a word is an underscore
++  test-underscore-in-word
  ;:  weld
    (expect-eq !>("<p>a_b_c</p>") !>((r 'a_b_c')))
    (expect-eq !>("<p>set max_size and min_size</p>") !>((r 'set max_size and min_size')))
    (expect-eq !>("<p>a__b__c</p>") !>((r 'a__b__c')))
    (expect-eq !>("<p>x _a_b</p>") !>((r 'x _a_b')))
    (expect-eq !>("<p>x __a__b</p>") !>((r 'x __a__b')))
    (expect-eq !>("<p><em>a_b</em></p>") !>((r '_a_b_')))
    (expect-eq !>("<p><em>max_size</em></p>") !>((r '_max_size_')))
    (expect-eq !>("<p><strong>a__b</strong></p>") !>((r '__a__b__')))
    (expect-eq !>("<p><em>a__b</em></p>") !>((r '_a__b_')))
    (expect-eq !>("<p>9_a_</p>") !>((r '9_a_')))
    ::  at a word boundary it is still emphasis
    (expect-eq !>("<p>x <em>a</em> y</p>") !>((r 'x _a_ y')))
    (expect-eq !>("<p>(<em>a</em>)</p>") !>((r '(_a_)')))
    (expect-eq !>("<p><em>a b</em>.</p>") !>((r '_a b_.')))
    (expect-eq !>("<p>x <strong>a</strong>, y</p>") !>((r 'x __a__, y')))
    (expect-eq !>("<p><strong>a_b</strong></p>") !>((r '**a_b**')))
    (expect-eq !>("<p><em>snake_case</em> here</p>") !>((r '*snake_case* here')))
  ==
::  a list item or a quote above a rule is not a heading
++  test-setext-not-over-list-or-quote
  ;:  weld
    (expect-eq !>("<ul><li>item</li></ul><hr>") !>((r '- item\0a---')))
    (expect-eq !>("<ol><li>item</li></ol><hr>") !>((r '1. item\0a---')))
    (expect-eq !>("<blockquote><p>q</p></blockquote><hr>") !>((r '> q\0a---')))
    (expect-eq !>("<h2>Title</h2>") !>((r 'Title\0a---')))
  ==
::  openers with no closer: "[a](" with no ')' and "[^" with no ']'
::  each cost a full capped scan, minutes for a page a peer can send.
::  The scan now stops at the next opener, and a real link or footnote
::  among them still renders.
++  test-open-parens-bounded
  =/  o=tape  (zing (reap 30.000 "[a]("))
  =/  h=tape  (r (crip :(weld o " [x](/u) " o)))
  (yes (has "[a]( <a href=\"/u\"" h))
++  test-open-footnotes-bounded
  =/  o=tape  (zing (reap 30.000 "[^"))
  =/  h=tape  (r (crip :(weld o "[^a] " o "\0a\0a[^a]: n")))
  (yes (has "[^<sup class=\"fnref\">" h))
::  a link's ( ) tail ends at the first ')'. The start of another link
::  is not part of a destination.
++  test-paren-stops-at-opener
  ;:  weld
    (expect-eq !>("<p>[a](x <a href=\"/u\" target=\"_blank\" rel=\"noopener noreferrer\">b</a></p>") !>((r '[a](x [b](/u)')))
    (yes (has "<a href=\"/p?a[]=1\"" (r '[t](/p?a[]=1)')))
    (yes (has "<a href=\"/p\" title=\"T\"" (r '[t](/p "T")')))
    (yes (has "<img src=\"/i.png\"" (r '![a](x ![b](/i.png)')))
  ==
::  an image on this host with a query is a request to a route, made
::  with the reader's session when the page is drawn. It is a link, not
::  an <img>, with or without `outside`. A plain path and the raw view
::  of a file (?data) still draw.
++  test-image-no-route
  =/  clip=@t  '![x](/apps/lattice/clip?url=https://evil.example/t?id=1)'
  =/  o=tape  (r clip)
  ;:  weld
    (yes !(has "<img" o))
    (yes (has "<a href=\"/apps/lattice/clip?url=https://evil.example/t?id=1\"" o))
    (yes !(has "<img" (~(render-md md &) clip)))
    (yes !(has "<img" (r '![x](clip?url=https://evil.example/)')))
    (yes !(has "<img" (r '![x](/apps/lattice?url=urb://~zod/p)')))
    (yes !(has "<img" (r '![x]( /apps/lattice/fetch?url=http://e.example)')))
    (yes !(has "<img" (r '![x][k]\0a\0a[k]: /apps/lattice/share?text=http://e.example')))
    (yes !(has "<img" (r '![x](/a.png?data&url=http://e.example)')))
    (yes !(has "<img" (r '![x](/a.png?data=1)')))
    (yes (has "<img src=\"/pic.png\"" (r '![x](/pic.png)')))
    (yes (has "<img src=\"a/b.png\"" (r '![x](a/b.png)')))
    (yes (has "<img src=\"/apps/lattice/x/~zod/p/pic.png?data\"" (r '![x](/apps/lattice/x/~zod/p/pic.png?data)')))
    ::  a remote image the reader chose to load keeps its query
    (yes (has "<img src=\"https://x.example/i.png?w=2\"" (~(render-md md &) '![a](https://x.example/i.png?w=2)')))
  ==
::  a line that only looks like a fence, in a list item or a table row,
::  opens no code block: the footnotes and reference links below it are
::  read. A definition +rb never sees (it is taken out first) does not
::  change which lines are code.
++  test-fence-look-in-blocks
  =/  lnk=tape  "<a href=\"/u\""
  ;:  weld
    (yes (has "<sup" (r 'p[^1]\0a\0a- item\0a  ```sh npm i```\0a\0apara [t][r]\0a\0a[^1]: note\0a[r]: /u')))
    (yes (has lnk (r 'p[^1]\0a\0a- item\0a  ```sh npm i```\0a\0apara [t][r]\0a\0a[^1]: note\0a[r]: /u')))
    (yes (has "<sup" (r 'p[^1]\0a\0a- item\0a  ```not closed\0a\0apara [^1]\0a\0a[^1]: note')))
    (yes (has "<sup" (r 'p[^1]\0a\0a1. a\0a   ```\0a   x\0a\0a2. b[^1]\0a\0a[^1]: note')))
    (yes (has "<sup" (r 'a | b\0a--|--\0a``` | [^1]\0a\0ap[^1]\0a\0a[^1]: note')))
    (yes (has "<sup" (r 'x[^1]\0a\0a- item\0a[r]: /u\0a  ```sh\0a\0apara[^1]\0a\0a[^1]: note')))
    ::  a real fence is still code, at the top and in a quote
    (yes (has "<code>[^1]: no\0a</code>" (r 'p[^1]\0a\0a```\0a[^1]: no\0a```\0a\0a[^1]: note')))
    (yes (has "<sup" (r 'p[^1]\0a\0a```\0a[^1]: no\0a```\0a\0a[^1]: note')))
    (yes (has "[^1]: no" (r 'p[^1]\0a\0a> ```\0a> [^1]: no\0a> ```\0a\0a[^1]: note')))
    (yes (has "<sup" (r 'p[^1]\0a\0a> ```\0a> [^1]: no\0a> ```\0a\0a[^1]: note')))
    ::  an unclosed fence is code to the end
    (yes (has "<code>unclosed\0a\0a[^1]: note" (r 'p[^1]\0a\0a```\0aunclosed\0a\0a[^1]: note')))
  ==
::  a link's address may be as long as 4,096 characters, as in the
::  browser's preview. A reference label too.
++  test-long-link
  =/  u=tape  (weld "https://x.example/" (reap 3.000 'a'))
  =/  lnk=tape  (weld "<a href=\"" u)
  ;:  weld
    (yes (has lnk (r (crip :(weld "[t](" u ")")))))
    =/  i=tape  :(weld "/" (reap 3.000 'a') ".png")
    (yes (has (weld "<img src=\"" i) (r (crip :(weld "![t](" i ")")))))
    (yes (has lnk (r (crip :(weld "[t][" (reap 1.000 'k') "]\0a\0a[" (reap 1.000 'k') "]: " u)))))
    ::  past the cap it is text, as in the browser
    (yes !(has "<a href" (r (crip :(weld "[t](https://x.example/" (reap 5.000 'a') ")")))))
  ==
::  the ( ) of a link holds at most 4,096 characters of the source, a title
::  and the & of a query counted as written (the browser's preview counts
::  the same: scripts/ui-md.mjs)
++  test-link-cap-counts-source
  =/  at
    |=  [n=@ud tail=tape]
    ^-  tape
    (r (crip :(weld "[a](https://e.com/" (reap (sub n (add 14 (lent tail))) 'p') tail ")")))
  ;:  weld
    (yes (has "<a href=\"https://e.com/" (at 4.096 "")))
    (yes !(has "<a href" (at 4.097 "")))
    (yes (has "<a href=\"https://e.com/" (at 4.096 " \"t\"")))
    (yes !(has "<a href" (at 4.097 " \"t\"")))
    (yes (has "<a href=\"https://e.com/" (at 4.096 "?q=1&q=1&q=1")))
    (yes !(has "<a href" (at 4.097 "?q=1&q=1&q=1")))
  ==
::  a reference label's scan stops where another link starts, as the
::  ( ) scan does: a run of "[a][" costs one pass
++  test-open-refs-bounded
  =/  o=tape  (zing (reap 30.000 "[a]["))
  =/  h=tape  (r (crip :(weld o " [x][k] " o "\0a\0a[k]: /u")))
  (yes (has "<a href=\"/u\"" h))
::  a fenced block's lines are the block's to the byte: a line of more
::  than 32 quote marks in one is not cut, at the top or in a quote. A
::  quote outside a fence is still cut at 32.
++  test-fence-keeps-quote-marks
  =/  q=tape  (reap 40 '>')
  =/  gt=tape  (zing (reap 40 "&gt;"))
  ;:  weld
    (yes (has (weld "<code>" gt) (r (crip :(weld "```\0a" q " x\0a```")))))
    (yes (has (weld "<code>" gt) (r (crip :(weld "> ```\0a> " q " x\0a> ```")))))
    (yes (has (weld "<code>" gt) (r (crip :(weld "~~~\0a" q "\0a" q "\0a~~~")))))
    (expect-eq !>(32) !>((lent (fand "<blockquote>" (r (crip (weld q " x")))))))
  ==
::  +take-list joins many continuation lines in order without quadratic weld
++  test-list-continuations
  =/  conts=tape  (zing (reap 200 "\0a  more"))
  =/  h=tape  (r (crip :(weld "- first" conts "\0a- second")))
  ;:  weld
    (yes (has "<ul><li>first more more" h))
    (yes (has "</li><li>second</li></ul>" h))
  ==
::  +take-ref stops at '[' inside an unclosed reference label
++  test-take-ref-stop-open-bracket
  =/  refs=refm:md  (my ~[["k" ["/u" ""]]])
  ;:  weld
    (expect-eq !>(~) !>((take-ref:md "[a[b]" "lbl" refs)))
    (expect !>(?=(^ (take-ref:md "[k]rest" "lbl" refs))))
  ==
--
