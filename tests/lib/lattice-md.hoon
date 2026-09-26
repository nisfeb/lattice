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
++  test-image      (yes (has "<img src=\"http://x\"" (r '![a](http://x)')))
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
++  test-wiki-nolabel
  (yes (has "[a/b](/w/a/b)" (wl "[[a/b]]" "/w/")))
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
--
