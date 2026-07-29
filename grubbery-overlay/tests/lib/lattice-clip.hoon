::  Unit tests for /lib/lattice-clip (HTML -> Markdown). Run via the run-tests
::  MCP tool.
::
/+  *test, clip=lattice-clip
|%
++  m    to-md:clip
++  has  |=([n=tape h=@t] ^-(? ?=(^ (find n (trip h)))))
++  yes  |=(c=? (expect-eq !>(&) !>(c)))
++  no   |=(c=? (expect-eq !>(|) !>(c)))
::  headings
++  test-h1  (yes (has "# The Heading" (m '<h1>The Heading</h1>')))
++  test-h3  (yes (has "### Sub" (m '<h3>Sub</h3>')))
++  test-h6  (yes (has "###### Deep" (m '<h6>Deep</h6>')))
::  inline emphasis
++  test-strong  (yes (has "**b**" (m '<p><strong>b</strong></p>')))
++  test-b       (yes (has "**b**" (m '<p><b>b</b></p>')))
++  test-em      (yes (has "*i*" (m '<p><em>i</em></p>')))
++  test-code    (yes (has "`c`" (m '<p><code>c</code></p>')))
::  links: kept, and the dangerous schemes stripped to bare text
++  test-link
  (yes (has "[text](https://example.com/x)" (m '<a href="https://example.com/x">text</a>')))
++  test-link-js-dropped
  (no (has "javascript:" (m '<a href="javascript:alert(1)">click</a>')))
++  test-link-js-keeps-text
  (yes (has "click" (m '<a href="javascript:alert(1)">click</a>')))
++  test-link-data-dropped
  (no (has "DATA:" (m '<a href="DATA:text/html,x">click</a>')))
++  test-link-relative-kept
  (yes (has "[t](/rel/path)" (m '<a href="/rel/path">t</a>')))
::  images
++  test-img      (yes (has "![a picture](/pic.png)" (m '<img src="/pic.png" alt="a picture">')))
++  test-img-js   (no (has "![" (m '<img src="javascript:x" alt="a">')))
::  lists and quotes
++  test-li       (yes (has "- first" (m '<ul><li>first</li><li>second</li></ul>')))
++  test-quote    (yes (has "> quoted" (m '<blockquote>quoted</blockquote>')))
::  a multi-line blockquote needs '>' on EVERY line, not just the first
++  test-quote-multiline
  (yes (has "> two" (m '<blockquote><p>one</p><p>two</p></blockquote>')))
::  pre is verbatim, and fenced
++  test-pre-fence  (yes (has "```" (m '<pre>code</pre>')))
++  test-pre-verbatim
  (yes (has "a  b" (m '<pre>a  b</pre>')))
::  entities
++  test-ent-amp    (yes (has "&" (m '<p>&amp;</p>')))
++  test-ent-lt     (yes (has "<" (m '<p>&lt;tag&gt;</p>')))
++  test-ent-quot   (yes (has "\"q\"" (m '<p>&quot;q&quot;</p>')))
++  test-ent-num    (yes (has "A" (m '<p>&#65;</p>')))
++  test-ent-hex    (yes (has "A" (m '<p>&#x41;</p>')))
++  test-ent-named-utf8  (yes (has "—" (m '<p>&mdash;</p>')))
::  a bare ampersand is prose and stays literal
++  test-bare-amp   (yes (has "Tom & Jerry" (m '<p>Tom & Jerry</p>')))
::  a pending space belongs BEFORE an inline marker, not swallowed by it
++  test-space-before-strong
  (yes (has "with **bold**" (m '<p>with <strong>bold</strong></p>')))
++  test-space-before-em
  (yes (has "and *it*" (m '<p>and <em>it</em></p>')))
++  test-space-before-code
  (yes (has "run `x`" (m '<p>run <code>x</code></p>')))
++  test-space-before-link
  (yes (has "an [t](/u)" (m '<p>an <a href="/u">t</a></p>')))
::  &nbsp; collapses with the whitespace around it rather than stacking
++  test-nbsp-collapses
  (no (has "a   b" (m '<p>a &nbsp; b</p>')))
::  a tight list: no blank line between items (that renders as a loose list)
++  test-list-tight
  (no (has "one\0a\0a- two" (m '<ul><li>one</li><li>two</li></ul>')))
::  boilerplate: tag AND content go
++  test-script-gone  (no (has "alert" (m '<p>keep</p><script>alert(1)</script>')))
++  test-style-gone   (no (has "color" (m '<p>keep</p><style>b{color:red}</style>')))
++  test-nav-gone     (no (has "skipme" (m '<nav>skipme</nav><p>keep</p>')))
++  test-footer-gone  (no (has "dropme" (m '<p>keep</p><footer>dropme</footer>')))
++  test-comment-gone  (no (has "hidden" (m '<p>keep</p><!-- hidden -->')))
++  test-keeps-body   (yes (has "keep" (m '<p>keep</p><script>alert(1)</script>')))
::  <main>/<article> win over the surrounding chrome
++  test-article-only
  (no (has "chrome" (m '<body><div>chrome</div><article><p>real</p></article></body>')))
++  test-article-content
  (yes (has "real" (m '<body><div>chrome</div><article><p>real</p></article></body>')))
::  unknown tags drop but keep their text
++  test-unknown-tag  (yes (has "inner" (m '<span class="x">inner</span>')))
::  titles
++  test-title      (yes =('Test Article & Friends' (need (page-title:clip '<title>Test Article &amp; Friends</title>'))))
::  ?= narrows a WING, so the unit has to be bound before it is tested —
::  ?=(~ (call ...)) does not build.
++  test-title-none
  =/  r  (page-title:clip '<p>no title here</p>')
  (yes ?=(~ r))
::  malformed input must degrade, never crash
++  test-unclosed-tag   (yes (has "bold forever" (m '<p>x <b>bold forever')))
++  test-stray-lt       (yes (has "5" (m '<p>5 < 6</p>')))
++  test-unclosed-quote  (yes (has "t" (m '<a href="broken>t</a>')))
++  test-empty          (yes =('' (m '')))
::  whitespace: runs collapse, blank lines cap at one
++  test-collapse-spaces  (yes (has "a b" (m '<p>a     b</p>')))
++  test-no-triple-blank  (no (has "\0a\0a\0a" (m '<p>a</p><p>b</p><p>c</p>')))
::  a large document must not blow up quadratically — 2000 paragraphs
++  test-large
  =/  big=@t  (crip (zing (reap 2.000 "<p>paragraph text here</p>")))
  (yes (gth (met 3 (m big)) 10.000))
--
