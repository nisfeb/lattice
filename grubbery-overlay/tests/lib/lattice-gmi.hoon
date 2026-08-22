::  Unit tests for /lib/lattice-gmi (gemtext -> HTML). Run via run-tests.
::
::  Two of these are regressions, and both shipped. Lists rendered as
::  paragraphs with the asterisk still in them, and a fence carrying a
::  language inverted the block so the rest of the document was swallowed
::  into a <pre>. The renderer lived inline in the nexus with no tests,
::  which is why nobody knew.
::
/+  *test, gmi=lattice-gmi
|%
++  r    render-gmi:gmi
++  has  |=([n=tape h=tape] ^-(? ?=(^ (find n h))))
++  yes  |=(c=? (expect-eq !>(&) !>(c)))
++  no   |=(c=? (expect-eq !>(|) !>(c)))
::  headings
++  test-h1        (yes (has "<h1>Title</h1>" (r '# Title')))
++  test-h2        (yes (has "<h2>Sub</h2>" (r '## Sub')))
++  test-h3        (yes (has "<h3>Deep</h3>" (r '### Deep')))
::  the spec makes the space optional, and #Title read as a paragraph
++  test-h1-tight  (yes (has "<h1>Title</h1>" (r '#Title')))
++  test-h3-tight  (yes (has "<h3>Deep</h3>" (r '###Deep')))
::  REGRESSION: a bullet rendered as <p>* item</p>, asterisk and all
++  test-list      (yes (has "<li>item</li>" (r '* item')))
++  test-list-ul   (yes (has "<ul>" (r '* item')))
++  test-list-close  (yes (has "</ul>" (r '* item')))
++  test-list-no-star  (no (has "<p>* item</p>" (r '* item')))
::  a run of bullets is ONE list, not one list each
++  test-list-run
  =/  out  (r '* one\0a* two')
  (yes ?&((has "<li>one</li>" out) (has "<li>two</li>" out) =(~ (find "<ul><li>two" out))))
::  and it closes when the list ends, before whatever follows
++  test-list-then-para
  =/  out  (r '* one\0aafter')
  (yes ?&((has "</ul>" out) (has "<p>after</p>" out)))
::  REGRESSION: ```hoon did not open a block, so the CLOSING fence opened one
::  and everything after it vanished into a <pre>
++  test-fence-alt
  =/  out  (r '```hoon\0a(add 2 2)\0a```\0aafter')
  (yes ?&((has "<pre>" out) (has "(add 2 2)" out) (has "<p>after</p>" out)))
++  test-fence-alt-not-para  (no (has "<p>```hoon</p>" (r '```hoon\0ax\0a```')))
++  test-fence-plain  (yes (has "<pre>x</pre>" (r '```\0ax\0a```')))
::  fence content is escaped, never live markup
++  test-fence-escapes  (yes (has "&lt;script&gt;" (r '```\0a<script>\0a```')))
::  links
++  test-link-urb
  (yes (has "href=\"/apps/lattice?url=urb://~zod/x\"" (r '=> urb://~zod/x text')))
++  test-link-http
  (yes (has "rel=\"noopener noreferrer\"" (r '=> https://example.com site')))
::  a bare link shows its url rather than rendering an empty, unclickable <a>
++  test-link-bare  (yes (has ">https://example.com</a>" (r '=> https://example.com')))
::  an unknown scheme is text, never an href. The scheme list IS the allowlist.
++  test-link-scheme  (no (has "<a href" (r '=> javascript:alert(1) x')))
++  test-link-scheme-text  (yes (has "x" (r '=> javascript:alert(1) x')))
::  quotes and paragraphs
++  test-quote     (yes (has "<blockquote>said</blockquote>" (r '> said')))
++  test-para      (yes (has "<p>words</p>" (r 'words')))
++  test-escapes   (yes (has "&lt;b&gt;" (r '<b>')))
::  a \0d from a CRLF document is not content and must not reach the output
++  test-crlf      (yes (has "<h1>Title</h1>" (r '# Title\0d\0amore')))
++  test-crlf-para  (yes (has "<p>more</p>" (r '# Title\0d\0amore\0d')))
--
