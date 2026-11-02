::  Unit tests for /lib/lattice-fodt: the flat ODT scanner, text, title
::  and the safe HTML renderer. One test per row of the spec's mapping
::  table that renders, then the security cases and the hostile corpus.
::
/+  *test, fo=lattice-fodt
|%
++  has  |=([n=tape h=tape] ^-(? ?=(^ (find n h))))
++  yes  |=(c=? (expect-eq !>(&) !>(c)))
++  no   |=(c=? (expect-eq !>(|) !>(c)))
++  hits
  |=  [n=tape h=tape]
  ^-  @ud
  =|  c=@ud
  |-  ^-  @ud
  =/  i  (find n h)
  ?~  i  c
  $(h (slag +(u.i) h), c +(c))
::  +doc: a document with these head parts and this body
++  doc
  |=  [sty=tape bod=tape]
  ^-  @t
  %-  crip
  ;:  weld
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\0a"
    "<office:document xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\">"
    sty
    "<office:body><office:text>"
    bod
    "</office:text></office:body></office:document>"
  ==
++  h   |=(bod=tape (fodt-html:fo (doc ~ bod)))
++  hs  |=([sty=tape bod=tape] (fodt-html:fo (doc sty bod)))
++  tx  |=(bod=tape (trip (fodt-text:fo (doc ~ bod))))
++  note  note-html:fo
::  a paragraph style and a text style, as automatic styles
++  auto
  |=  s=tape
  ^-  tape
  :(weld "<office:automatic-styles>" s "</office:automatic-styles>")
++  named
  |=  s=tape
  ^-  tape
  :(weld "<office:styles>" s "</office:styles>")
::
::  the mapping table
::
++  test-p
  (yes (has "<p>one</p>" (h "<text:p>one</text:p>")))
++  test-p-empty-keeps-its-line
  (yes (has "<p><br></p>" (h "<text:p/>")))
++  test-p-style-css
  %-  yes
  %+  has  "<p style=\"font-size:14pt;text-align:center\">c</p>"
  %+  hs
    %-  named
    "<style:style style:name=\"Big\" style:family=\"paragraph\"><style:paragraph-properties fo:text-align=\"center\"/><style:text-properties fo:font-size=\"14pt\"/></style:style>"
  "<text:p text:style-name=\"Big\">c</text:p>"
++  test-p-style-inherits
  ::  three levels and the default style; the nearer one wins
  =/  o=tape
    %+  hs
      ;:  weld
        "<office:styles><style:default-style style:family=\"paragraph\"><style:text-properties fo:color=\"#111111\" fo:font-size=\"10pt\"/></style:default-style>"
        "<style:style style:name=\"A\" style:family=\"paragraph\"><style:paragraph-properties fo:margin-left=\"1cm\"/><style:text-properties fo:font-size=\"11pt\"/></style:style>"
        "<style:style style:name=\"B\" style:family=\"paragraph\" style:parent-style-name=\"A\"><style:text-properties fo:font-size=\"12pt\"/></style:style>"
        "<style:style style:name=\"C\" style:family=\"paragraph\" style:parent-style-name=\"B\"><style:paragraph-properties fo:line-height=\"150%\"/></style:style></office:styles>"
      ==
    "<text:p text:style-name=\"C\">x</text:p>"
  ;:  weld
    (yes (has "font-size:12pt" o))
    (yes (has "color:#111111" o))
    (yes (has "margin-left:1cm" o))
    (yes (has "line-height:150%" o))
  ==
++  test-h-levels
  ;:  weld
    (yes (has "<h2>T</h2>" (h "<text:h text:outline-level=\"2\">T</text:h>")))
    (yes (has "<h6>D</h6>" (h "<text:h text:outline-level=\"6\">D</text:h>")))
    ::  7 to 10 stay headings at level 6
    (yes (has "<h6>N</h6>" (h "<text:h text:outline-level=\"9\">N</text:h>")))
    (yes (has "<h1>U</h1>" (h "<text:h>U</text:h>")))
  ==
++  test-quotations
  =/  sty=tape
    %-  named
    ;:  weld
      "<style:style style:name=\"Quotations\" style:family=\"paragraph\"><style:paragraph-properties fo:margin-left=\"1cm\"/></style:style>"
      "<style:style style:name=\"Q2\" style:family=\"paragraph\" style:parent-style-name=\"Quotations\"/>"
    ==
  ;:  weld
    (yes (has "<blockquote style=\"margin-left:1cm\">q</blockquote>" (hs sty "<text:p text:style-name=\"Quotations\">q</text:p>")))
    (yes (has "<blockquote style=\"margin-left:1cm\">c</blockquote>" (hs sty "<text:p text:style-name=\"Q2\">c</text:p>")))
  ==
++  test-page-break-before
  %-  yes
  %+  has  "<p>a</p><hr class=\"fodt-pb\"><p>b</p>"
  %+  hs
    (auto "<style:style style:name=\"P1\" style:family=\"paragraph\"><style:paragraph-properties fo:break-before=\"page\"/></style:style>")
  "<text:p>a</text:p><text:p text:style-name=\"P1\">b</text:p>"
++  test-list-bullet
  %-  yes
  %+  has  "<ul><li><p>a</p></li><li><p>b</p></li></ul>"
  (h "<text:list><text:list-item><text:p>a</text:p></text:list-item><text:list-item><text:p>b</text:p></text:list-item></text:list>")
++  test-list-numbered-and-nested
  =/  sty=tape
    %-  auto
    ;:  weld
      "<text:list-style style:name=\"L1\">"
      "<text:list-level-style-number text:level=\"1\" style:num-format=\"1\"/>"
      "<text:list-level-style-bullet text:level=\"2\" text:bullet-char=\"-\"/>"
      "</text:list-style>"
    ==
  =/  o=tape
    %+  hs  sty
    "<text:list text:style-name=\"L1\"><text:list-item><text:p>one</text:p><text:list><text:list-item><text:p>in</text:p></text:list-item></text:list></text:list-item></text:list>"
  (yes (has "<ol><li><p>one</p><ul><li><p>in</p></li></ul></li></ol>" o))
++  test-list-header
  %-  yes
  %+  has  "<li style=\"list-style:none\"><p>head</p></li>"
  (h "<text:list><text:list-header><text:p>head</text:p></text:list-header></text:list>")
++  test-table
  =/  o=tape
    %-  h
    ;:  weld
      "<table:table table:name=\"T\"><table:table-column table:number-columns-repeated=\"2\"/>"
      "<table:table-header-rows><table:table-row><table:table-cell><text:p>H1</text:p></table:table-cell><table:table-cell><text:p>H2</text:p></table:table-cell></table:table-row></table:table-header-rows>"
      "<table:table-row><table:table-cell table:number-columns-spanned=\"2\"><text:p>wide</text:p></table:table-cell><table:covered-table-cell/></table:table-row>"
      "<table:table-row><table:table-cell><text:p>a</text:p><text:p>b</text:p></table:table-cell><table:table-cell/></table:table-row>"
      "</table:table>"
    ==
  ;:  weld
    (yes (has "<table" o))
    (yes (has "<thead><tr><th " o))
    (yes (has "<p>H2</p></th></tr></thead><tbody>" o))
    (yes (has "<td colspan=\"2\" " o))
    (yes (has "<p>a</p><p>b</p></td>" o))
    ::  two body rows: the wide cell, then two cells; the covered one is gone
    (expect-eq !>(3) !>((hits "<td" o)))
    (yes (has "</tbody></table>" o))
  ==
++  test-section
  %-  yes
  %+  has  "<div class=\"fodt-sec\"><p>in</p></div>"
  (h "<text:section text:name=\"S\"><text:p>in</text:p></text:section>")
++  test-span-marks
  =/  sty=tape
    %-  auto
    "<style:style style:name=\"T1\" style:family=\"text\"><style:text-properties fo:font-weight=\"bold\" fo:font-style=\"italic\" style:text-underline-style=\"solid\" style:text-line-through-style=\"solid\"/></style:style>"
  %-  yes
  %+  has  "<strong><em><u><s>x</s></u></em></strong>"
  (hs sty "<text:p><text:span text:style-name=\"T1\">x</text:span></text:p>")
++  test-span-colour
  =/  sty=tape
    %-  auto
    "<style:style style:name=\"T2\" style:family=\"text\"><style:text-properties fo:color=\"#C9211E\" fo:background-color=\"#ffff00\"/></style:style>"
  %-  yes
  %+  has  "<span style=\"color:#c9211e;background-color:#ffff00\">r</span>"
  (hs sty "<text:p><text:span text:style-name=\"T2\">r</text:span></text:p>")
++  test-span-named-style
  =/  sty=tape
    %-  named
    "<style:style style:name=\"Emphasis\" style:family=\"text\"><style:text-properties fo:font-style=\"italic\"/></style:style>"
  %-  yes
  %+  has  "<em>e</em>"
  (hs sty "<text:p><text:span text:style-name=\"Emphasis\">e</text:span></text:p>")
++  test-link
  ;:  weld
    %-  yes
    %+  has  "<a href=\"https://example.org/?a=1&amp;b=2\" target=\"_blank\" rel=\"noopener noreferrer\">w</a>"
    (h "<text:p><text:a xlink:href=\"https://example.org/?a=1&amp;b=2\">w</text:a></text:p>")
    %-  yes
    %+  has  "<a href=\"#intro\">i</a>"
    (h "<text:p><text:a xlink:href=\"#intro\">i</text:a></text:p>")
    %-  yes
    %+  has  "<a href=\"mailto:a@b.c\""
    (h "<text:p><text:a xlink:href=\"mailto:a@b.c\">m</text:a></text:p>")
  ==
++  test-spaces-tabs-breaks
  =/  o=tape  (h "<text:p>a<text:s text:c=\"3\"/>b<text:tab/>c<text:line-break/>d<text:s/>e</text:p>")
  (yes (has "<p>a   b\09c<br>d e</p>" o))
++  test-spaces-are-capped
  (yes (has (weld "<p>a" (weld (reap 100 ' ') "b</p>")) (h "<text:p>a<text:s text:c=\"99999\"/>b</text:p>")))
++  test-soft-page-break-is-nothing
  (yes (has "<p>ab</p>" (h "<text:p>a<text:soft-page-break/>b</text:p>")))
++  test-opaque-inline
  =/  o=tape
    %-  h
    ;:  weld
      "<text:p>x<text:bookmark-start text:name=\"b\"/>y<text:bookmark-end text:name=\"b\"/>"
      "<text:note text:note-class=\"footnote\"><text:note-citation>1</text:note-citation><text:note-body><text:p>the note</text:p></text:note-body></text:note>"
      " on <text:date>2026-11-02</text:date><office:annotation><dc:creator>me</dc:creator><text:p>a comment</text:p></office:annotation></text:p>"
    ==
  ;:  weld
    (yes (has "<p>xy<sup class=\"fodt-fn\">1</sup> on 2026-11-02</p>" o))
    (no (has "the note" o))
    (no (has "a comment" o))
  ==
++  test-opaque-block
  =/  o=tape
    %-  h
    ;:  weld
      "<text:table-of-content text:name=\"TOC\"><text:table-of-content-source><text:index-title-template>Template</text:index-title-template></text:table-of-content-source>"
      "<text:index-body><text:p>Contents</text:p><text:p>Intro<text:tab/>1</text:p></text:index-body></text:table-of-content>"
      "<text:tracked-changes><text:changed-region><text:deletion><text:p>deleted words</text:p></text:deletion></text:changed-region></text:tracked-changes>"
      "<text:p>after</text:p>"
    ==
  ;:  weld
    (yes (has "<div class=\"fodt-op\" style=\"color:#666;border:1px dashed #bbb;padding:4px 8px;margin:4px 0\">Contents<br>Intro\091</div>" o))
    (no (has "Template" o))
    (no (has "deleted words" o))
    (yes (has "<p>after</p>" o))
  ==
++  test-page-shape
  =/  sty=tape
    ;:  weld
      "<office:automatic-styles><style:page-layout style:name=\"pm1\"><style:page-layout-properties fo:page-width=\"21.001cm\" fo:margin-top=\"2cm\" fo:margin-bottom=\"2cm\" fo:margin-left=\"2.5cm\" fo:margin-right=\"1.5cm\"/></style:page-layout></office:automatic-styles>"
      "<office:master-styles><style:master-page style:name=\"Standard\" style:page-layout-name=\"pm1\"/></office:master-styles>"
    ==
  %-  yes
  %+  has  "max-width:21.001cm;padding:2cm 1.5cm 2cm 2.5cm\">"
  (hs sty "<text:p>x</text:p>")
++  test-fonts
  =/  sty=tape
    ;:  weld
      "<office:font-face-decls><style:font-face style:name=\"Liberation Serif\" svg:font-family=\"&apos;Liberation Serif&apos;\" style:font-family-generic=\"roman\"/>"
      "<style:font-face style:name=\"Mono\" svg:font-family=\"&apos;DejaVu Sans Mono&apos;\" style:font-family-generic=\"modern\"/></office:font-face-decls>"
      "<office:styles><style:style style:name=\"S\" style:family=\"paragraph\"><style:text-properties style:font-name=\"Liberation Serif\"/></style:style>"
      "<style:style style:name=\"M\" style:family=\"paragraph\"><style:text-properties style:font-name=\"Mono\"/></style:style>"
      "<style:style style:name=\"N\" style:family=\"paragraph\"><style:text-properties fo:font-family=\"&apos;Comic Neue&apos;\"/></style:style></office:styles>"
    ==
  ;:  weld
    (yes (has "font-family:'Liberation Serif','Times New Roman',Times,serif" (hs sty "<text:p text:style-name=\"S\">x</text:p>")))
    (yes (has "font-family:'DejaVu Sans Mono',monospace" (hs sty "<text:p text:style-name=\"M\">x</text:p>")))
    (yes (has "font-family:'Comic Neue'\"" (hs sty "<text:p text:style-name=\"N\">x</text:p>")))
  ==
::
::  security
::
++  test-text-is-escaped
  =/  o=tape  (h "<text:p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; \"q\"</text:p>")
  ;:  weld
    (yes (has "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;" o))
    (no (has "<script" o))
  ==
++  test-style-url-gives-no-style
  =/  sty=tape
    %-  auto
    "<style:style style:name=\"P1\" style:family=\"paragraph\"><style:text-properties fo:color=\"url(javascript:x)\" fo:background-color=\"#fff;background:url(a)\" fo:font-family=\"x;background:url(a)\" fo:font-size=\"12pt;width:expression(1)\"/></style:style>"
  =/  o=tape  (hs sty "<text:p text:style-name=\"P1\">x</text:p>")
  ;:  weld
    (yes (has "<p>x</p>" o))
    (no (has "url(" o))
    (no (has "expression" o))
  ==
++  test-bad-links-are-text
  ;:  weld
    (yes (has "<p>run</p>" (h "<text:p><text:a xlink:href=\"javascript:alert(1)\">run</text:a></text:p>")))
    (yes (has "<p>macro</p>" (h "<text:p><text:a xlink:href=\"vnd.sun.star.script:Standard.M.Main?language=Basic&amp;location=document\">macro</text:a></text:p>")))
    (yes (has "<p>enc</p>" (h "<text:p><text:a xlink:href=\"jav&#x61;script&#58;x\">enc</text:a></text:p>")))
    (yes (has "<p>f</p>" (h "<text:p><text:a xlink:href=\"file:///etc/passwd\">f</text:a></text:p>")))
  ==
++  test-scripts-never-appear
  =/  f=@t
    %+  doc
      "<office:scripts><office:script script:language=\"ooo:Basic\"><ooo:libraries><ooo:library-embedded ooo:name=\"Standard\"><ooo:module ooo:name=\"M\"><ooo:source-code>Sub EvilMacro</ooo:source-code></ooo:module></ooo:library-embedded></ooo:libraries></office:script></office:scripts><office:settings><config:config-item>SecretSetting</config:config-item></office:settings>"
    "<text:p>body</text:p>"
  ;:  weld
    (no (has "EvilMacro" (fodt-html:fo f)))
    (no (has "EvilMacro" (trip (fodt-text:fo f))))
    (no (has "SecretSetting" (fodt-html:fo f)))
    (expect-eq !>('body') !>((fodt-text:fo f)))
  ==
++  test-doctype-gives-the-note
  =/  f=@t  '<?xml version="1.0"?>\0a<!DOCTYPE office:document [<!ENTITY e "boom">]>\0a<office:document><office:body><office:text><text:p>&e;</text:p></office:text></office:body></office:document>'
  ;:  weld
    (expect-eq !>(note) !>((fodt-html:fo f)))
    (expect-eq !>('') !>((fodt-text:fo f)))
    (expect-eq !>(~) !>((fodt-title:fo f)))
    (expect-eq !>(%|) !>(-:(scan:fo f)))
  ==
++  test-entity-declaration-refused
  (expect-eq !>([%| 'an entity declaration']) !>((scan:fo '<!ENTITY e "x"><office:document/>')))
++  test-bare-doctype-is-fine
  (yes (has "<p>ok</p>" (fodt-html:fo '<!DOCTYPE office:document><office:document><office:body><office:text><text:p>ok</text:p></office:text></office:body></office:document>')))
::  +deep: `n` nested spans in a paragraph
++  deep
  |=  n=@ud
  ^-  @t
  %+  doc  ~
  ;:  weld
    "<text:p>"
    `tape`(zing `(list tape)`(reap n "<text:span>"))
    "deep"
    `tape`(zing `(list tape)`(reap n "</text:span>"))
    "</text:p>"
  ==
++  test-depth-10000-gives-the-note
  ;:  weld
    (expect-eq !>(note) !>((fodt-html:fo (deep 10.000))))
    (expect-eq !>([%| 'nested too deep']) !>((scan:fo (deep 10.000))))
    (expect-eq !>('') !>((fodt-text:fo (deep 10.000))))
  ==
++  test-depth-200-renders
  (yes (has "deep" (fodt-html:fo (deep 200))))
++  test-over-2mb-gives-the-note
  =/  f=@t  (cat 3 (doc ~ "<text:p>x</text:p>") (bex (mul 8 (mul 2 (bex 20)))))
  ;:  weld
    (expect-eq !>(note) !>((fodt-html:fo f)))
    (expect-eq !>([%| 'too large']) !>((scan:fo f)))
  ==
++  test-malformed-gives-the-note
  ;:  weld
    (expect-eq !>(note) !>((fodt-html:fo '<office:document><office:body><office:text><text:p a=b>x')))
    (expect-eq !>(note) !>((fodt-html:fo '<office:document><text:p a="x')))
    (expect-eq !>(note) !>((fodt-html:fo 'not xml at all')))
  ==
++  test-entities
  =/  s  (scan:fo '<a>&lt;&#65;&#x42;&amp;&gt;&quot;&apos;&#x1F389;</a>')
  ?>  ?=(%& -.s)
  (expect-eq !>(`(list token:fo)`~[[%open 'a' ~ |] [%text "<AB&>\"'🎉"] [%close 'a']]) !>(p.s))
++  test-unknown-entity-stays-literal
  ;:  weld
    (yes (has "<p>&amp;xxe; &amp;#0; &amp;#xD800;</p>" (h "<text:p>&xxe; &#0; &#xD800;</text:p>")))
  ==
++  test-attributes
  =/  s  (scan:fo '<a x="1" y=\'&quot;2\'  z = "3"/>')
  ?>  ?=(%& -.s)
  (expect-eq !>(`(list token:fo)`~[[%open 'a' ~[['x' "1"] ['y' "\"2"] ['z' "3"]] &]]) !>(p.s))
::
::  text and title
::
++  test-text-whitespace
  ::  the body of corpus/12-whitespace.fodt
  =/  t=tape
    %-  tx
    ;:  weld
      "<text:sequence-decls><text:sequence-decl text:name=\"Text\"/></text:sequence-decls>\0a   "
      "<text:p text:style-name=\"Text_20_body\">Two spaces, three <text:s/>spaces, and ten <text:s text:c=\"8\"/>spaces.</text:p>\0a   "
      "<text:p text:style-name=\"Text_20_body\"><text:s/>A leading space.</text:p>\0a   "
      "<text:p text:style-name=\"Text_20_body\">Tab<text:tab/>separated<text:tab/><text:tab/>values.</text:p>\0a   "
      "<text:p text:style-name=\"Text_20_body\">Line one<text:line-break/>line two</text:p>\0a   "
      "<text:p text:style-name=\"Text_20_body\">Mixed <text:tab/> <text:s text:c=\"3\"/>whitespace.</text:p>"
    ==
  %+  expect-eq
    !>  ^-  tape
        ;:  weld
          "Two spaces, three  spaces, and ten         spaces.\0a"
          " A leading space.\0a"
          "Tab\09separated\09\09values.\0a"
          "Line one\0aline two\0a"
          "Mixed \09    whitespace."
        ==
  !>(t)
++  test-text-is-words-only
  =/  t=tape
    %-  trip
    %-  fodt-text:fo
    %+  doc
      (auto "<style:style style:name=\"P1\" style:family=\"paragraph\"><style:text-properties fo:color=\"#123456\"/></style:style>")
    "<text:h text:outline-level=\"1\">Title</text:h><text:p text:style-name=\"P1\">Body <text:span text:style-name=\"T1\">words</text:span></text:p>"
  ;:  weld
    (expect-eq !>("Title\0aBody words") !>(t))
    (no (has "style-name" t))
    (no (has "123456" t))
  ==
++  test-title-dc
  =/  f=@t
    %+  doc
      "<office:meta><dc:title>  The   Report </dc:title></office:meta>"
    "<text:h text:outline-level=\"1\">Heading</text:h>"
  (expect-eq !>(`'The Report') !>((fodt-title:fo f)))
++  test-title-first-heading
  =/  f=@t
    %+  doc  "<office:meta><dc:title></dc:title></office:meta>"
    "<text:p>intro</text:p><text:section><text:h text:outline-level=\"2\">First <text:span>one</text:span></text:h></text:section><text:h>Second</text:h>"
  (expect-eq !>(`'First one') !>((fodt-title:fo f)))
++  test-title-none
  (expect-eq !>(~) !>((fodt-title:fo (doc ~ "<text:p>no heading</text:p>"))))
::
::  the hostile corpus: each gives the note or safe output
::
++  test-hostile-entities
  ;:  weld
    (expect-eq !>(note) !>((fodt-html:fo f-billion-laughs)))
    (expect-eq !>(note) !>((fodt-html:fo f-doctype-entity)))
    (expect-eq !>(note) !>((fodt-html:fo f-external-entity)))
    (expect-eq !>('') !>((fodt-text:fo f-billion-laughs)))
  ==
++  test-hostile-script-iframe
  =/  o=tape  (fodt-html:fo f-script-iframe)
  ;:  weld
    (no (has "<script" o))
    (no (has "<iframe" o))
    (no (has "<img" o))
    (no (has "<svg" o))
    ::  the words onclick and onerror= are in its text, escaped
    (no (has "onclick=" o))
    (no (has "onerror=\"" o))
    (no (has "style=\"background" o))
    (no (has "url(" o))
    (yes (has "&lt;script&gt;window.__PWNED=1&lt;/script&gt;" o))
    (yes (has "A paragraph with an onclick and a style attribute." o))
  ==
++  test-hostile-style-injection
  =/  o=tape  (fodt-html:fo f-style-injection)
  ;:  weld
    ::  its text says "url(", but no style value carries one
    (no (has "url(h" o))
    (no (has "url(j" o))
    (no (has "url('" o))
    (no (has "url(x" o))
    (yes (has "<p style=\"font-family:serif\">A span" o))
    (no (has "expression" o))
    (no (has "<script" o))
    (no (has "</style" o))
    (no (has "<img" o))
    (no (has "behavior" o))
    (yes (has "A span with a hostile colour." o))
  ==
++  test-hostile-bad-links
  =/  o=tape  (fodt-html:fo f-bad-links)
  ;:  weld
    (no (has "javascript:" (cass o)))
    (no (has "file:" o))
    (no (has "data:" o))
    (no (has "vnd.sun.star.script" o))
    (no (has "macro:" o))
    (no (has ".uno:" o))
    (no (has "\" onmouseover" o))
    (yes (has "href=\"https://example.org/&quot; onmouseover=&quot;window.__PWNED=1\"" o))
    (expect-eq !>(2) !>((hits "<a " o)))
  ==
++  test-hostile-external-image
  =/  o=tape  (fodt-html:fo f-external-image)
  ;:  weld
    (no (has "evil.example" o))
    (no (has "file:" o))
    (no (has "<img" o))
    (yes (has "An image linked from another server." o))
    (yes (has "A linked section pointing at another server." o))
  ==
::  the hostile corpus files (tests/writer/corpus/hostile), as cords.
::  deep-nesting is built by +deep instead.
++  f-bad-links
  '<?xml version="1.0" encoding="UTF-8"?>\0a<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.4" office:mimetype="application/vnd.oasis.opendocument.text">\0a <office:body>\0a  <office:text>\0a   <text:p><text:a xlink:type="simple" xlink:href="javascript:window.__PWNED=1">javascript</text:a></text:p>\0a   <text:p><text:a xlink:type="simple" xlink:href="JaVaScRiPt:window.__PWNED=1">mixed case javascript</text:a></text:p>\0a   <text:p><text:a xlink:type="simple" xlink:href="jav&#x61;script&#58;window.__PWNED=1">entity-encoded javascript</text:a></text:p>\0a   <text:p><text:a xlink:type="simple" xlink:href=" &#9;javascript:window.__PWNED=1">javascript after whitespace</text:a></text:p>\0a   <text:p><text:a xlink:type="simple" xlink:href="file:///etc/passwd">file</text:a></text:p>\0a   <text:p><text:a xlink:type="simple" xlink:href="data:text/html;base64,PHNjcmlwdD53aW5kb3cuX19QV05FRD0xPC9zY3JpcHQ+">data</text:a></text:p>\0a   <text:p><text:a xlink:type="simple" xlink:href="vnd.sun.star.script:Standard.Module1.Main?language=Basic&amp;location=document">macro</text:a></text:p>\0a   <text:p><text:a xlink:type="simple" xlink:href="macro:///Standard.Module1.Main">macro scheme</text:a></text:p>\0a   <text:p><text:a xlink:type="simple" xlink:href=".uno:About">uno command</text:a></text:p>\0a   <text:p><text:a xlink:type="simple" xlink:href="https://example.org/&quot; onmouseover=&quot;window.__PWNED=1">quote break-out</text:a></text:p>\0a   <text:p><text:a xlink:type="simple" xlink:href="https://example.org/" office:target-frame-name="_top" xlink:show="replace">frame target</text:a></text:p>\0a  </office:text>\0a </office:body>\0a</office:document>\0a'
++  f-billion-laughs
  '<?xml version="1.0" encoding="UTF-8"?>\0a<!DOCTYPE office:document [\0a <!ENTITY lol "lol">\0a <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">\0a <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">\0a <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">\0a <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">\0a <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">\0a <!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">\0a <!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;">\0a <!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;">\0a <!ENTITY lol9 "&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;">\0a]>\0a<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.4" office:mimetype="application/vnd.oasis.opendocument.text">\0a <office:body>\0a  <office:text>\0a   <text:p>&lol9;</text:p>\0a  </office:text>\0a </office:body>\0a</office:document>\0a'
++  f-doctype-entity
  '<?xml version="1.0" encoding="UTF-8"?>\0a<!DOCTYPE office:document [\0a <!ENTITY greeting "this text came from an internal entity">\0a]>\0a<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.4" office:mimetype="application/vnd.oasis.opendocument.text">\0a <office:body>\0a  <office:text>\0a   <text:p>Before. &greeting; After.</text:p>\0a  </office:text>\0a </office:body>\0a</office:document>\0a'
++  f-external-entity
  '<?xml version="1.0" encoding="UTF-8"?>\0a<!DOCTYPE office:document [\0a <!ENTITY xxe SYSTEM "file:///etc/passwd">\0a <!ENTITY remote SYSTEM "https://evil.example/xxe.txt">\0a]>\0a<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.4" office:mimetype="application/vnd.oasis.opendocument.text">\0a <office:body>\0a  <office:text>\0a   <text:p>Local: &xxe;</text:p>\0a   <text:p>Remote: &remote;</text:p>\0a  </office:text>\0a </office:body>\0a</office:document>\0a'
++  f-external-image
  '<?xml version="1.0" encoding="UTF-8"?>\0a<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.4" office:mimetype="application/vnd.oasis.opendocument.text">\0a <office:body>\0a  <office:text>\0a   <text:p><draw:frame draw:name="Image1" text:anchor-type="as-char" svg:width="1cm" svg:height="1cm"><draw:image xlink:href="https://evil.example/track.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>An image linked from another server.</text:p>\0a   <text:p><draw:frame draw:name="Image2" text:anchor-type="as-char" svg:width="1cm" svg:height="1cm"><draw:image xlink:href="file:///etc/hostname" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>An image linked from the local disk.</text:p>\0a   <text:section text:name="Remote"><text:section-source xlink:href="https://evil.example/section.fodt" xlink:type="simple"/><text:p>A linked section pointing at another server.</text:p></text:section>\0a  </office:text>\0a </office:body>\0a</office:document>\0a'
++  f-script-iframe
  '<?xml version="1.0" encoding="UTF-8"?>\0a<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.4" office:mimetype="application/vnd.oasis.opendocument.text">\0a <office:body>\0a  <office:text>\0a   <script xmlns="http://www.w3.org/1999/xhtml">window.__PWNED=1</script>\0a   <text:p>Text, then an inline script: <html:script xmlns:html="http://www.w3.org/1999/xhtml">window.__PWNED=1</html:script> and text.</text:p>\0a   <iframe xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example/frame.html"></iframe>\0a   <text:p>An element with a handler: <html:img xmlns:html="http://www.w3.org/1999/xhtml" src="x" onerror="window.__PWNED=1"/></text:p>\0a   <text:p onclick="window.__PWNED=1" style="background:url(https://evil.example/p.png)">A paragraph with an onclick and a style attribute.</text:p>\0a   <text:p>Escaped markup in text: &lt;script&gt;window.__PWNED=1&lt;/script&gt; &lt;img src=x onerror=window.__PWNED=1&gt;</text:p>\0a   <svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>window.__PWNED=1</svg:script></svg:svg>\0a  </office:text>\0a </office:body>\0a</office:document>\0a'
++  f-style-injection
  '<?xml version="1.0" encoding="UTF-8"?>\0a<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.4" office:mimetype="application/vnd.oasis.opendocument.text">\0a <office:font-face-decls>\0a  <style:font-face style:name="Evil" svg:font-family="&apos;x&apos;;}&lt;/style&gt;&lt;script&gt;window.__PWNED=1&lt;/script&gt;" style:font-family-generic="roman"/>\0a </office:font-face-decls>\0a <office:styles>\0a  <style:style style:name="Evil_20_Para" style:display-name="Evil &lt;/style&gt;&lt;script&gt;window.__PWNED=1&lt;/script&gt;" style:family="paragraph">\0a   <style:paragraph-properties fo:background-color="#fff;background:url(https://evil.example/bg.png)" fo:margin-left="1cm;behavior:url(x.htc)"/>\0a   <style:text-properties style:font-name="Evil" fo:color="red;background-image:url(&apos;https://evil.example/c.png&apos;)" fo:font-family="x}&lt;/style&gt;&lt;img src=x onerror=window.__PWNED=1&gt;" fo:font-size="12pt;width:expression(window.__PWNED=1)"/>\0a  </style:style>\0a </office:styles>\0a <office:automatic-styles>\0a  <style:style style:name="T1" style:family="text">\0a   <style:text-properties fo:color="url(javascript:window.__PWNED=1)" fo:letter-spacing="1px&lt;/style&gt;"/>\0a  </style:style>\0a </office:automatic-styles>\0a <office:body>\0a  <office:text>\0a   <text:p text:style-name="Evil_20_Para">A paragraph whose style values carry url( and a closing style tag.</text:p>\0a   <text:p text:style-name="Evil_20_Para"><text:span text:style-name="T1">A span with a hostile colour.</text:span></text:p>\0a   <text:p text:style-name="&lt;/style&gt;&lt;script&gt;window.__PWNED=1&lt;/script&gt;">A style name that is markup.</text:p>\0a  </office:text>\0a </office:body>\0a</office:document>\0a'
--
