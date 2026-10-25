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
::  exact: "&" is also inside an undecoded "&amp;"
++  test-ent-amp    (yes =('&' (m '<p>&amp;</p>')))
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
::  ?= narrows a WING, so the unit has to be bound before it is tested.
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
::  a large document must not blow up quadratically. 2000 paragraphs
++  test-large
  =/  big=@t  (crip (zing (reap 2.000 "<p>paragraph text here</p>")))
  (yes (gth (met 3 (m big)) 10.000))
::  one case per clause: each of these alone was dropped by a mutant and
::  every test still passed (hoon-mutate, 2026-09-26)
++  test-i  (yes (has "a *x* b" (m '<p>a <i>x</i> b</p>')))
++  test-td  (yes (has "a  b" (m '<table><tr><td>a</td><td>b</td></tr></table>')))
++  test-th  (yes (has "a  b" (m '<table><tr><th>a</th><th>b</th></tr></table>')))
++  test-ws-tab  (yes (has "a b" (m '<p>a\09b</p>')))
++  test-ws-nl   (yes (has "a b" (m '<p>a\0ab</p>')))
++  test-ws-cr   (yes (has "a b" (m '<p>a\0db</p>')))
::  a tag name ends at a tab, a newline or a '/', as well as a space
++  test-tag-tab    (yes (has "[t](/u)" (m '<a\09href="/u">t</a>')))
++  test-tag-nl     (yes (has "[t](/u)" (m '<a\0ahref="/u">t</a>')))
++  test-tag-slash  (no (has "ab" (m '<p>a<br/>b</p>')))
::  attribute values: single-quoted, and bare up to the next space
++  test-attr-single  (yes (has "[t](/u)" (m '<a href=\'/u\'>t</a>')))
++  test-attr-bare    (yes (has "[t](/u)" (m '<a href=/u title=x>t</a>')))
::  no url is no link, and vbscript: is as dead as javascript:
++  test-link-no-href  (no (has "[" (m '<a>t</a>')))
++  test-img-no-src    (no (has "![" (m '<img alt="a">')))
++  test-link-vbscript  (no (has "vbscript:" (m '<a href="vbscript:x">t</a>')))
::  a comment opens only at '<'
++  test-bang-dash-prose  (yes (has "a!--b" (m '<p>a!--b--></p>')))
::  a stray closing </script> drops nothing after it
++  test-stray-close-script  (yes (has "after" (m '<p>keep</script> after</p>')))
::  </pre> ends verbatim mode, so markup after it counts again
++  test-pre-closes  (yes (has "**y**" (m '<pre>x</pre><p>after <b>y</b></p>')))
::  no pending space, no space before the marker
++  test-no-space-before-strong  (yes (has "a**x**" (m '<p>a<b>x</b></p>')))
::  h<non-digit> is not a heading, and must not crash
++  test-h-bang  (yes (has "x" (m '<h!>x</h!>')))
++  test-h7      (no (has "#" (m '<h7>x</h7>')))
::  numeric entities: every digit range's edges, and an upper-case X
++  test-ent-hex-upper-x  (yes (has "A" (m '<p>&#X41;</p>')))
++  test-ent-num-edges    (yes (has "Z" (m '<p>&#90;</p>')))
++  test-ent-hex-a  (yes (has "j" (m '<p>&#x6a;</p>')))
++  test-ent-hex-f  (yes (has "o" (m '<p>&#x6f;</p>')))
++  test-ent-hex-big-a  (yes (has "J" (m '<p>&#x4A;</p>')))
++  test-ent-hex-big-f  (yes (has "O" (m '<p>&#x4F;</p>')))
::  the last codepoint decodes; one past it stays literal
::  (U+10FFFF is F4 8F BF BF in UTF-8)
++  test-ent-max       (yes =((tuft `@c`0x10.ffff) (m '<p>&#1114111;</p>')))
++  test-ent-past-max  (yes (has "&#1114112;" (m '<p>&#1114112;</p>')))
::  &#0; is not a character: it stays literal, it does not vanish
++  test-ent-zero  (yes (has "&#0;" (m '<p>&#0;</p>')))
::  the output is trimmed at the end: no trailing newline or space
++  test-trim-end-nl     (yes =('a' (m '<p>a</p>')))
++  test-trim-end-space  (yes =('a' (m '<p>a</p><td></td>')))
::  +fetchable: the hosts a clip may and may not fetch (LATTICE-013)
++  f  fetchable:clip
++  test-fetch-pub-name  (yes (f 'https://example.com/x'))
++  test-fetch-pub-port  (yes (f 'http://example.com:8080/a?b=1'))
++  test-fetch-pub-at-in-path  (yes (f 'https://medium.com/@someone/post'))
++  test-fetch-pub-v4  (yes (f 'http://8.8.8.8/'))
++  test-fetch-pub-v4-decimal  (yes (f 'http://134744072/'))
++  test-fetch-pub-172-32  (yes (f 'http://172.32.0.1/'))
++  test-fetch-pub-100-128  (yes (f 'http://100.128.0.1/'))
++  test-fetch-pub-v6  (yes (f 'http://[2001:db8::1]/'))
++  test-fetch-pub-v6-mapped  (yes (f 'http://[::ffff:8.8.8.8]/'))
++  test-fetch-pub-query  (yes (f 'https://example.com?q=1'))
++  test-fetch-pub-local-word  (yes (f 'https://local.example.com/'))
++  test-nofetch-ftp  (no (f 'ftp://example.com/'))
++  test-nofetch-file  (no (f 'file:///etc/passwd'))
++  test-nofetch-empty-host  (no (f 'http:///x'))
++  test-nofetch-localhost  (no (f 'http://localhost/'))
++  test-nofetch-localhost-caps  (no (f 'HTTP://LOCALHOST:80/'))
++  test-nofetch-localhost-dot  (no (f 'http://localhost./'))
++  test-nofetch-sub-localhost  (no (f 'http://a.localhost/'))
++  test-nofetch-dot-local  (no (f 'http://nas.local/'))
++  test-nofetch-dot-internal  (no (f 'http://db.internal/'))
++  test-nofetch-one-label  (no (f 'http://router/'))
++  test-nofetch-zero  (no (f 'http://0.0.0.0/'))
++  test-nofetch-loop  (no (f 'http://127.0.0.1/'))
++  test-nofetch-loop-short  (no (f 'http://127.1/'))
++  test-nofetch-loop-decimal  (no (f 'http://2130706433/'))
++  test-nofetch-loop-hex  (no (f 'http://0x7f000001/'))
++  test-nofetch-loop-octal  (no (f 'http://0177.0.0.1/'))
++  test-nofetch-ten  (no (f 'http://10.1.2.3/'))
++  test-nofetch-172-16  (no (f 'http://172.16.0.1/'))
++  test-nofetch-172-31  (no (f 'http://172.31.255.255/'))
++  test-nofetch-192-168  (no (f 'http://192.168.1.1:8080/'))
++  test-nofetch-metadata  (no (f 'http://169.254.169.254/latest/meta-data/'))
++  test-nofetch-cgnat  (no (f 'http://100.64.0.1/'))
++  test-nofetch-cgnat-top  (no (f 'http://100.127.255.255/'))
++  test-nofetch-five-parts  (no (f 'http://1.2.3.4.5/'))
++  test-nofetch-empty-label  (no (f 'http://a..b/'))
++  test-nofetch-v6-loop  (no (f 'http://[::1]/'))
++  test-nofetch-v6-any  (no (f 'http://[::]/'))
++  test-nofetch-v6-ula  (no (f 'http://[fc00::1]/'))
++  test-nofetch-v6-ula-fd  (no (f 'http://[fd12:3456::1]/'))
++  test-nofetch-v6-link  (no (f 'http://[fe80::1]/'))
++  test-nofetch-v6-zone  (no (f 'http://[fe80::1%25eth0]/'))
++  test-nofetch-v6-mapped  (no (f 'http://[::ffff:127.0.0.1]/'))
++  test-nofetch-v6-mapped-hex  (no (f 'http://[::ffff:7f00:1]/'))
++  test-nofetch-v6-mapped-ten  (no (f 'http://[::ffff:10.0.0.1]/'))
++  test-nofetch-v6-full-loop  (no (f 'http://[0:0:0:0:0:0:0:1]/'))
++  test-nofetch-v6-junk  (no (f 'http://[1::2::3]/'))
++  test-nofetch-userinfo  (no (f 'http://example.com@127.0.0.1/'))
++  test-nofetch-userinfo-public  (no (f 'http://user@example.com/'))
++  test-nofetch-backslash  (no (f 'http://127.0.0.1\\@example.com/'))
++  test-nofetch-percent  (no (f 'http://%31%32%37.0.0.1/'))
++  test-nofetch-no-path  (no (f 'http://169.254.169.254'))
++  test-nofetch-bad-port  (no (f 'http://example.com:80x/'))
++  test-nofetch-v6-nat64  (no (f 'http://[64:ff9b::7f00:1]/'))
::
::  hostile pages that were quadratic: each must come back in about a
::  second, not a minute. 64 KB of dropped tags, of '<' with no '>', and of
::  '<' before a non-letter. The outputs pin that the text is still right.
++  test-many-dropped-tags
  =/  t=@t  (crip (zing (reap 6.000 "<svg></svg>")))
  (no (has "svg" (m (cat 3 t '<p>after</p>'))))
++  test-many-dropped-tags-keep-text
  =/  t=@t  (crip (zing (reap 6.000 "<NAV>x</nav>")))
  (yes (has "after" (m (cat 3 t '<p>after</p>'))))
++  test-many-open-angles
  =/  t=@t  (crip (reap 64.000 '<'))
  (expect-eq !>(64.000) !>((met 3 (m t))))
++  test-angles-before-a-non-letter
  =/  t=@t  (crip (zing (reap 16.000 "a <1 ")))
  (yes (has "a <1 a <1" (m (cat 3 t '>'))))
++  test-angle-before-space-is-text  (yes (has "1 < 2" (m '<p>1 < 2</p>')))
--
