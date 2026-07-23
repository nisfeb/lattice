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
--
