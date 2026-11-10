::  Unit tests for /lib/lattice-fods: a flat ODS page's text, title and
::  safe HTML tables. A normal sheet, the repeats and their clamps, merged
::  cells, several sheets, what is hidden or skipped, hostile markup and
::  the refusals. The last arms hold the files of tests/sheet/ship as
::  cords (tests/sheet/ship/embed.py writes them).
::
/+  *test, fs=lattice-fods
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
::  +doc: a spreadsheet document with these head parts and these sheets
++  doc
  |=  [hed=tape bod=tape]
  ^-  @t
  %-  crip
  ;:  weld
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\0a"
    "<office:document xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" office:mimetype=\"application/vnd.oasis.opendocument.spreadsheet\">"
    hed
    "<office:body><office:spreadsheet>"
    bod
    "</office:spreadsheet></office:body></office:document>"
  ==
::  a sheet, a row, a text cell, a number cell, an element with attributes
++  tab
  |=  [nm=tape rows=tape]
  ^-  tape
  :(weld "<table:table table:name=\"" nm "\">" rows "</table:table>")
++  tr  |=(c=tape `tape`:(weld "<table:table-row>" c "</table:table-row>"))
++  tc
  |=  t=tape
  ^-  tape
  :(weld "<table:table-cell office:value-type=\"string\"><text:p>" t "</text:p></table:table-cell>")
++  nc
  |=  [ty=tape t=tape]
  ^-  tape
  :(weld "<table:table-cell office:value-type=\"" ty "\"><text:p>" t "</text:p></table:table-cell>")
++  el
  |=  [n=tape as=tape k=tape]
  ^-  tape
  :(weld "<" n " " as ">" k "</" n ">")
++  h   |=(bod=tape (fods-html:fs (doc ~ bod)))
++  tx  |=(bod=tape (trip (fods-text:fs (doc ~ bod))))
++  note  note-html:fs
::  the 16384 column, 1048576 row sheet of "x"
++  bomb
  ^-  tape
  %+  tab  "B"
  %^  el  "table:table-row"  "table:number-rows-repeated=\"1048576\""
  (el "table:table-cell" "table:number-columns-repeated=\"16384\"" "<text:p>x</text:p>")
::
::  a normal sheet
::
++  test-sheet
  %+  expect-eq
    !>  "<div class=\"fods\"><h3>S</h3><table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td style=\"text-align:right\">3</td></tr></tbody></table></div>"
  !>  (h (tab "S" (weld (tr (weld (tc "a") (tc "b"))) (tr (weld (tc "c") (nc "float" "3"))))))
++  test-numbers-right-aligned
  =/  o=tape
    %-  h
    %+  tab  "S"
    %-  tr
    ;:  weld
      (nc "float" "1")  (nc "percentage" "2%")  (nc "currency" "$3")
      (nc "date" "2026-11-10")  (nc "time" "09:00")  (nc "boolean" "TRUE")
      (nc "string" "s")  (nc "zz" "z")
    ==
  ;:  weld
    (expect-eq !>(5) !>((hits "<td style=\"text-align:right\">" o)))
    (yes (has "<td>TRUE</td><td>s</td><td>z</td>" o))
  ==
++  test-formula-is-never-read
  =/  o=tape
    %-  h
    %+  tab  "S"
    (tr "<table:table-cell table:formula=\"of:=[.B2]*[.C2]\" office:value-type=\"float\" office:value=\"3\"><text:p>3</text:p></table:table-cell><table:table-cell table:formula=\"of:=WEBSERVICE(&quot;http://evil.example&quot;)\" office:value-type=\"string\"/>")
  ;:  weld
    (yes (has "<td style=\"text-align:right\">3</td>" o))
    (no (has "of:" o))
    (no (has "B2" o))
    (no (has "evil" o))
  ==
++  test-cell-lines-and-space
  =/  o=tape
    %-  h
    %+  tab  "S"
    (tr "<table:table-cell><text:p>one</text:p><text:p>two<text:line-break/>three<text:s text:c=\"3\"/>x<text:span>bold</text:span></text:p></table:table-cell>")
  (yes (has "<td>one<br>two<br>three   xbold</td>" o))
++  test-empty-sheet
  ;:  weld
    (expect-eq !>("<div class=\"fods\"><h3>S</h3><p class=\"fods-note\">empty sheet</p></div>") !>((h (tab "S" ~))))
    (yes (has "empty sheet" (h (tab "S" (tr "<table:table-cell/>")))))
    (expect-eq !>("<div class=\"fods\"></div>") !>((h ~)))
  ==
::
::  repeats and clamps
::
++  test-repeated-cells-and-rows
  =/  o=tape
    %-  h
    %+  tab  "S"
    %^  el  "table:table-row"  "table:number-rows-repeated=\"3\""
    (el "table:table-cell" "table:number-columns-repeated=\"2\"" "<text:p>x</text:p>")
  ;:  weld
    (expect-eq !>(3) !>((hits "<tr><td>x</td><td>x</td></tr>" o)))
    (no (has "not shown" o))
  ==
::  LibreOffice pads a sheet to its full size with empty runs: they
::  render as nothing
++  test-padding-renders-as-nothing
  =/  o=tape
    %-  h
    %+  tab  "S"
    ;:  weld
      "<table:table-column table:number-columns-repeated=\"16384\"/>"
      (tr (weld (tc "a") "<table:table-cell table:number-columns-repeated=\"16383\"/>"))
      "<table:table-row table:number-rows-repeated=\"1048575\"><table:table-cell table:number-columns-repeated=\"16384\"/></table:table-row>"
    ==
  (expect-eq !>("<div class=\"fods\"><h3>S</h3><table><tbody><tr><td>a</td></tr></tbody></table></div>") !>(o))
++  test-bomb-is-clamped
  =/  o=tape  (h bomb)
  ;:  weld
    (expect-eq !>(500) !>((hits "<tr>" o)))
    (expect-eq !>(25.000) !>((hits "<td>x</td>" o)))
    (yes (lth (lent o) 300.000))
    (yes (has "<p class=\"fods-note\">1048076 more rows not shown, 16334 more columns not shown</p>" o))
  ==
++  test-bomb-text-counts-a-run-once
  (expect-eq !>("B\0ax") !>((tx bomb)))
::  thirty such sheets: twenty are taken, and the output cap stops them
++  test-bomb-in-every-sheet
  =/  o=tape  (h (zing (reap 30 bomb)))
  ;:  weld
    (yes (lth (lent o) (add max-out:fs 10.000)))
    (yes (has "output limit reached" o))
    (yes (has "10 more sheets not shown" o))
    (expect-eq !>(20) !>((hits "<h3>B</h3>" o)))
  ==
++  test-empty-run-before-data
  =/  o=tape
    %-  h
    %+  tab  "S"
    %+  weld
      "<table:table-row table:number-rows-repeated=\"1000000\"><table:table-cell/></table:table-row>"
    (tr (tc "late"))
  ;:  weld
    (expect-eq !>(500) !>((hits "<tr><td></td></tr>" o)))
    (no (has "late" o))
    (yes (has "999501 more rows not shown" o))
  ==
++  test-absurd-counts
  =/  o=tape
    %-  h
    %+  tab  "S"
    ;:  weld
      "<table:table-row table:number-rows-repeated=\"99999999999999999999999999999999\"><table:table-cell table:number-columns-repeated=\"-5\"><text:p>a</text:p></table:table-cell></table:table-row>"
      "<table:table-row table:number-rows-repeated=\"0\"><table:table-cell table:number-columns-repeated=\"abc\"><text:p>b</text:p></table:table-cell></table:table-row>"
    ==
  ;:  weld
    (expect-eq !>(500) !>((hits "<tr><td>a</td></tr>" o)))
    (yes (has "more rows not shown" o))
  ==
++  test-rep
  ;:  weld
    (expect-eq !>(1) !>((rep:fs 'n' ~)))
    (expect-eq !>(7) !>((rep:fs 'n' ~[['n' "7"]])))
    (expect-eq !>(1) !>((rep:fs 'n' ~[['n' "0"]])))
    (expect-eq !>(1) !>((rep:fs 'n' ~[['n' "x"]])))
    (expect-eq !>(max-rep:fs) !>((rep:fs 'n' ~[['n' "9999999999999999"]])))
    (expect-eq !>(max-rep:fs) !>((rep:fs 'n' ~[['n' "999999999999"]])))
  ==
::
::  merged cells
::
++  test-merged-cells
  =/  o=tape
    %-  h
    %+  tab  "S"
    ;:  weld
      (tr (weld "<table:table-cell table:number-columns-spanned=\"2\" table:number-rows-spanned=\"2\"><text:p>m</text:p></table:table-cell><table:covered-table-cell/>" (tc "c")))
      (tr (weld "<table:covered-table-cell table:number-columns-repeated=\"2\"><text:p>under</text:p></table:covered-table-cell>" (tc "d")))
    ==
  ;:  weld
    (yes (has "<tr><td colspan=\"2\" rowspan=\"2\">m</td><td>c</td></tr><tr><td>d</td></tr>" o))
    (no (has "under" o))
    (expect-eq !>("S\0ad") !>((tx (tab "S" (tr (weld "<table:covered-table-cell><text:p>under</text:p></table:covered-table-cell>" (tc "d")))))))
  ==
++  test-spans-are-clamped
  =/  o=tape
    %-  h
    %+  tab  "S"
    (tr (weld (tc "a") "<table:table-cell table:number-columns-spanned=\"99999999\" table:number-rows-spanned=\"99999999\"><text:p>m</text:p></table:table-cell>"))
  (yes (has "<td>a</td><td colspan=\"1\" rowspan=\"500\">m</td>" o))
::
::  several sheets, and what is hidden
::
++  test-several-sheets
  =/  b=tape  (weld (tab "One" (tr (tc "a"))) (tab "Two" (tr (weld (tc "b") (tc "c")))))
  =/  o=tape  (h b)
  ;:  weld
    (yes (has "<h3>One</h3><table><tbody><tr><td>a</td></tr></tbody></table><h3>Two</h3>" o))
    (expect-eq !>("One\0aa\0aTwo\0ab\09c") !>((tx b)))
  ==
++  test-hidden-sheet-row-and-column
  =/  f=@t
    %+  doc
      "<office:automatic-styles><style:style style:name=\"ta1\" style:family=\"table\"><style:table-properties table:display=\"true\"/></style:style><style:style style:name=\"ta2\" style:family=\"table\"><style:table-properties table:display=\"false\"/></style:style></office:automatic-styles>"
    ;:  weld
      %^  el  "table:table"  "table:name=\"Seen\" table:style-name=\"ta1\""
      ;:  weld
        "<table:table-column/><table:table-column table:visibility=\"collapse\"/><table:table-column/>"
        (tr :(weld (tc "a") (tc "hidcol") (tc "c")))
        (el "table:table-row" "table:visibility=\"filter\"" (tc "hidrow"))
      ==
      (el "table:table" "table:name=\"Secret\" table:style-name=\"ta2\"" (tr (tc "hidsheet")))
    ==
  =/  o=tape  (fods-html:fs f)
  ::  the hiding style among the named styles, and a style of another
  ::  family with the same name as a shown sheet's
  =/  g=@t
    %+  doc
      "<office:styles><style:style style:name=\"h\" style:family=\"table\"><style:table-properties table:display=\"false\"/></style:style><style:style style:name=\"s\" style:family=\"table-row\"><style:table-properties table:display=\"false\"/></style:style></office:styles>"
    ;:  weld
      (el "table:table" "table:name=\"Gone\" table:style-name=\"h\"" (tr (tc "x")))
      (el "table:table" "table:name=\"Here\" table:style-name=\"s\"" (tr (tc "y")))
    ==
  ;:  weld
    (yes (has "<tr><td>a</td><td>c</td></tr>" o))
    (no (has "hid" o))
    (no (has "Secret" o))
    ::  search is the owner's: it reads them
    (yes (has "hidsheet" (trip (fods-text:fs f))))
    (expect-eq !>("<div class=\"fods\"><h3>Here</h3><table><tbody><tr><td>y</td></tr></tbody></table></div>") !>((fods-html:fs g)))
  ==
::  hidden columns past the last one shown change nothing
++  test-hidden-columns-past-the-cap
  =/  o=tape
    %-  h
    %+  tab  "S"
    ;:  weld
      "<table:table-column table:number-columns-repeated=\"49\"/>"
      `tape`(zing (reap 4 "<table:table-column table:visibility=\"collapse\"/>"))
      "<table:table-column table:number-columns-repeated=\"16000\" table:visibility=\"collapse\"/>"
      (tr (el "table:table-cell" "table:number-columns-repeated=\"60\"" "<text:p>x</text:p>"))
    ==
  ;:  weld
    (expect-eq !>(49) !>((hits "<td>x</td>" o)))
    (yes (has "10 more columns not shown" o))
  ==
++  test-skipped-parts
  =/  f=@t
    %+  doc
      "<office:scripts><office:script><ooo:source-code>Sub EvilMacro</ooo:source-code></office:script></office:scripts><office:settings><config:config-item>SecretSetting</config:config-item></office:settings>"
    %+  tab  "S"
    ;:  weld
      "<table:shapes><draw:frame><draw:text-box><text:p>ShapeText</text:p></draw:text-box></draw:frame></table:shapes>"
      (tr "<table:table-cell><office:annotation><text:p>NoteText</text:p></office:annotation><draw:frame><draw:image><office:binary-data>QmluYXJ5</office:binary-data></draw:image></draw:frame><text:p>kept<draw:frame><text:p>InFrame</text:p></draw:frame></text:p></table:table-cell>")
    ==
  =/  o=tape  (fods-html:fs f)
  =/  t=tape  (trip (fods-text:fs f))
  ;:  weld
    (yes (has "<td>kept</td>" o))
    (expect-eq !>("S\0akept") !>(t))
    (no (has "EvilMacro" o))
    (no (has "SecretSetting" o))
    (no (has "ShapeText" o))
    (no (has "NoteText" o))
    (no (has "QmluYXJ5" o))
    (no (has "InFrame" o))
  ==
::
::  hostile markup comes out escaped
::
++  test-hostile-cell-text
  =/  o=tape
    %-  h
    %+  tab  "S"
    %-  tr
    ;:  weld
      (tc "&lt;script&gt;alert(1)&lt;/script&gt;")
      (tc "&lt;img src=x onerror=&quot;alert(2)&quot;&gt; &amp;amp; &#60;b&#x3e;")
      (tc "<script>alert(3)</script><b onclick=\"x\">in</b>")
      "<table:table-cell><text:p><![CDATA[<iframe src=x>]]></text:p></table:table-cell>"
    ==
  ;:  weld
    (yes (has "<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>" o))
    (yes (has "<td>&lt;img src=x onerror=&quot;alert(2)&quot;&gt; &amp;amp; &lt;b&gt;</td>" o))
    (yes (has "<td>alert(3)in</td>" o))
    (yes (has "<td>&lt;iframe src=x&gt;</td>" o))
    (no (has "<script" o))
    (no (has "<img" o))
    (no (has "<iframe" o))
    (no (has "<b" o))
    (no (has "onclick" o))
  ==
++  test-hostile-sheet-name
  =/  o=tape
    (h (tab "&lt;/h3&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot; onload=&quot;x" (tr (tc "a"))))
  ;:  weld
    (yes (has "<h3>&lt;/h3&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot; onload=&quot;x</h3>" o))
    (no (has "<script" o))
    (expect-eq !>(1) !>((hits "</h3>" o)))
  ==
++  test-hostile-attributes-never-copied
  =/  o=tape
    %-  h
    %+  tab  "S"
    (tr "<table:table-cell table:style-name=\"zzstyle\" office:value-type=\"zztype\" office:string-value=\"zzvalue\" onclick=\"zzclick\" table:number-columns-spanned=\"2zz\"><text:p>t</text:p></table:table-cell>")
  ;:  weld
    (yes (has "<tr><td>t</td></tr>" o))
    (no (has "zz" o))
  ==
::
::  refusals
::
++  test-not-a-spreadsheet
  ;:  weld
    (expect-eq !>(note) !>((fods-html:fs '<office:document><office:body><office:text><text:p>a Writer document</text:p></office:text></office:body></office:document>')))
    (expect-eq !>('') !>((fods-text:fs '<office:document><office:body><office:text><text:p>w</text:p></office:text></office:body></office:document>')))
    (expect-eq !>(note) !>((fods-html:fs 'just text')))
    (expect-eq !>(note) !>((fods-html:fs '')))
    (expect-eq !>(note) !>((fods-html:fs '<office:document><office:body><office:spreadsheet><table:table')))
    (expect-eq !>(note) !>((fods-html:fs '<html><body><table><tr><td>x</td></tr></table></body></html>')))
  ==
++  test-doctype-and-entity-refused
  =/  f=@t  '<?xml version="1.0"?>\0a<!DOCTYPE office:document [<!ENTITY e "boom">]>\0a<office:document><office:body><office:spreadsheet><table:table table:name="S"><table:table-row><table:table-cell><text:p>&e;</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document>'
  =/  g=@t  '<!ENTITY e SYSTEM "file:///etc/passwd"><office:document><office:body><office:spreadsheet><table:table table:name="S"/></office:spreadsheet></office:body></office:document>'
  ;:  weld
    (expect-eq !>(note) !>((fods-html:fs f)))
    (expect-eq !>('') !>((fods-text:fs f)))
    (expect-eq !>(~) !>((fods-title:fs f)))
    (expect-eq !>([note '' ~]) !>((fods-all:fs f)))
    (expect-eq !>(note) !>((fods-html:fs g)))
    (expect-eq !>(~) !>((fods-title:fs g)))
  ==
++  test-unknown-entity-stays-text
  (yes (has "<td>&amp;e; &amp;xxe;</td>" (h (tab "S" (tr (tc "&e; &xxe;"))))))
++  test-too-large
  =/  f=@t  (crip (reap (add 1 max-size:fs) 'a'))
  ::  a document of exactly the cap is read
  =/  d=@t  (doc ~ (tab "S" (tr (tc "edge"))))
  =/  e=@t  (cat 3 d (crip (reap (sub max-size:fs (met 3 d)) ' ')))
  ;:  weld
    (expect-eq !>(note) !>((fods-html:fs f)))
    (expect-eq !>([note '' ~]) !>((fods-all:fs f)))
    (expect-eq !>(max-size:fs) !>((met 3 e)))
    (yes (has "<td>edge</td>" (fods-html:fs e)))
    (yes (has "<td>edge</td>" html:(fods-all:fs e)))
  ==
++  test-too-deep
  =/  op=tape  (zing (reap 300 "<text:span>"))
  =/  cl=tape  (zing (reap 300 "</text:span>"))
  =/  f=@t
    %+  doc  ~
    %+  tab  "S"
    (tr :(weld "<table:table-cell><text:p>" op "x" cl "</text:p></table:table-cell>"))
  ;:  weld
    (expect-eq !>(note) !>((fods-html:fs f)))
    ::  and nested as deep as the scanner takes, it still renders
    (yes (has "<td>x</td>" (h (tab "S" (tr :(weld "<table:table-cell><text:p>" (scag 2.200 op) "x" (scag 2.400 cl) "</text:p></table:table-cell>"))))))
  ==
::  the reader tells a fods render from other html by its first bytes
++  test-html-pres
  =/  pre  |=(o=tape (lien html-pres:fs |=(p=@t =((trip p) (scag (met 3 p) o)))))
  ;:  weld
    (yes (pre (h (tab "S" (tr (tc "a"))))))
    (yes (pre (h ~)))
    (yes (pre (fods-html:fs 'nothing')))
    (no (pre "<div class=\"fodsx\">"))
    (no (pre "<div class=\"fodt\" style=\""))
  ==
::
::  title, text and the one-parse entry point
::
++  test-title
  =/  b=tape  (weld (tab " First " (tr (tc "a"))) (tab "Second" ~))
  ;:  weld
    (expect-eq !>(`(unit @t)``'First') !>((fods-title:fs (doc ~ b))))
    (expect-eq !>(`(unit @t)``'A <b> title') !>((fods-title:fs (doc "<office:meta><dc:title> A &lt;b&gt; title </dc:title></office:meta>" b))))
    (expect-eq !>(`(unit @t)``'First') !>((fods-title:fs (doc "<office:meta><dc:title> </dc:title></office:meta>" b))))
    (expect-eq !>(`(unit @t)`~) !>((fods-title:fs (doc ~ ~))))
    (expect-eq !>(`(unit @t)`~) !>((fods-title:fs (doc ~ (tab "" ~)))))
  ==
++  test-text
  =/  b=tape
    %+  tab  "S"
    ;:  weld
      (tr :(weld (tc "a") "<table:table-cell/>" (tc "b")))
      (tr "<table:table-cell table:number-columns-repeated=\"9\"/>")
      "<table:table-header-rows>"  (tr (tc "head"))  "</table:table-header-rows>"
      "<table:table-row-group>"  (tr (tc "grouped"))  "</table:table-row-group>"
    ==
  (expect-eq !>("S\0aa\09b\0ahead\0agrouped") !>((tx b)))
++  test-row-groups-render
  =/  o=tape
    %-  h
    %+  tab  "S"
    ;:  weld
      "<table:table-header-rows>"  (tr (tc "head"))  "</table:table-header-rows>"
      "<table:table-row-group><table:table-rows>"  (tr (tc "in"))  "</table:table-rows></table:table-row-group>"
    ==
  (yes (has "<tr><td>head</td></tr><tr><td>in</td></tr>" o))
++  test-all-is-the-three
  =/  f=@t  (doc "<office:meta><dc:title>T</dc:title></office:meta>" (tab "S" (tr (weld (tc "a") (nc "float" "2")))))
  (expect-eq !>([(fods-html:fs f) (fods-text:fs f) (fods-title:fs f)]) !>((fods-all:fs f)))
::
::  a file LibreOffice 26.8 wrote (tests/sheet/ship/01-budget.fods): two
::  shown sheets and a hidden one, formulas, a merge across and a merge
::  down
::
++  test-libreoffice-file
  =/  a  (fods-all:fs f-budget)
  =/  o=tape  html.a
  =/  t=tape  (trip text.a)
  ;:  weld
    (expect-eq !>(`(unit @t)``'Fruit budget') !>(title.a))
    (yes (has "<div class=\"fods\"><h3>Stock</h3><table><tbody><tr><td colspan=\"4\">Fruit &amp; veg &lt;2026&gt;</td></tr>" o))
    (yes (has "<tr><td>item</td><td>qty</td><td>price</td><td>total</td></tr>" o))
    (yes (has "<tr><td>apple</td><td style=\"text-align:right\">3</td><td style=\"text-align:right\">1.5</td><td style=\"text-align:right\">4.5</td></tr>" o))
    (yes (has "<tr><td rowspan=\"2\">sum</td><td></td><td></td><td style=\"text-align:right\">8.5</td></tr>" o))
    (yes (has "<tr><td>two lines<br>in a cell</td><td></td><td></td></tr></tbody></table><h3>Notes</h3>" o))
    (expect-eq !>(6) !>((hits "<tr>" (scag (need (find "<h3>Notes" o)) o))))
    (expect-eq !>(2) !>((hits "<h3>" o)))
    (no (has "Secret" o))
    (no (has "hidden words" o))
    (no (has "of:=" o))
    (no (has "not shown" o))
    (yes (has "Stock\0aFruit & veg <2026>\0aitem\09qty\09price\09total\0aapple\093\091.5\094.5" t))
    (yes (has "Secret\0ahidden words" t))
    (no (has "SUM" t))
  ==
++  test-hostile-file
  =/  o=tape  (fods-html:fs f-hostile)
  ;:  weld
    (yes (has "<h3>&lt;img src=x onerror=alert(1)&gt;</h3>" o))
    (yes (has "<td>&lt;script&gt;alert(document.cookie)&lt;/script&gt;</td>" o))
    (yes (has "1048076 more rows not shown" o))
    (yes (lth (lent o) 300.000))
    (no (has "<script" o))
    (no (has "<img" o))
    (no (has "EvilMacro" o))
    (no (has "javascript:" o))
  ==
::
::  the files of tests/sheet/ship, as cords (embed.py)
::
++  f-budget
  '<?xml version="1.0" encoding="UTF-8"?>\0a\0a<office:document xmlns:grddl="http://www.w3.org/2003/g/data-view#" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xforms="http://www.w3.org/2002/xforms" xmlns:dom="http://www.w3.org/2001/xml-events" xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" xmlns:form="urn:oasis:names:tc:opendocument:xmlns:form:1.0" xmlns:math="http://www.w3.org/1998/Math/MathML" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:field="urn:openoffice:names:experimental:ooo-ms-interop:xmlns:field:1.0" xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:ooo="http://openoffice.org/2004/office" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" xmlns:ooow="http://openoffice.org/2004/writer" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:drawooo="http://openoffice.org/2010/draw" xmlns:oooc="http://openoffice.org/2004/calc" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" xmlns:tableooo="http://openoffice.org/2009/table" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:dr3d="urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0" xmlns:rpt="http://openoffice.org/2005/report" xmlns:css3t="http://www.w3.org/TR/css3-text/" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:formx="urn:openoffice:names:experimental:ooxml-odf-interop:xmlns:form:1.0" xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0" office:version="1.4" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">\0a <office:meta><dc:title>Fruit budget</dc:title><meta:document-statistic meta:table-count="3" meta:cell-count="18" meta:object-count="0"/><meta:generator>LibreOffice/26.8.0.3$Linux_X86_64 LibreOffice_project/680$Build-3</meta:generator></office:meta>\0a <office:settings>\0a  <config:config-item-set config:name="ooo:view-settings">\0a   <config:config-item config:name="VisibleAreaTop" config:type="int">0</config:config-item>\0a   <config:config-item config:name="VisibleAreaLeft" config:type="int">0</config:config-item>\0a   <config:config-item config:name="VisibleAreaWidth" config:type="int">9031</config:config-item>\0a   <config:config-item config:name="VisibleAreaHeight" config:type="int">3099</config:config-item>\0a  </config:config-item-set>\0a  <config:config-item-set config:name="ooo:configuration-settings">\0a   <config:config-item config:name="AllowPrintJobCancel" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="ApplyUserData" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="AutoCalculate" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="CharacterCompressionType" config:type="short">0</config:config-item>\0a   <config:config-item config:name="EmbedAsianScriptFonts" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="EmbedComplexScriptFonts" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="EmbedFonts" config:type="boolean">false</config:config-item>\0a   <config:config-item config:name="EmbedLatinScriptFonts" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="EmbedOnlyUsedFonts" config:type="boolean">false</config:config-item>\0a   <config:config-item config:name="GridColor" config:type="int">12632256</config:config-item>\0a   <config:config-item config:name="HasColumnRowHeaders" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="HasSheetTabs" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="ImagePreferredDPI" config:type="int">0</config:config-item>\0a   <config:config-item config:name="IsDocumentShared" config:type="boolean">false</config:config-item>\0a   <config:config-item config:name="IsKernAsianPunctuation" config:type="boolean">false</config:config-item>\0a   <config:config-item config:name="IsOutlineSymbolsSet" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="IsRasterAxisSynchronized" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="IsSnapToRaster" config:type="boolean">false</config:config-item>\0a   <config:config-item config:name="LinkUpdateMode" config:type="short">3</config:config-item>\0a   <config:config-item config:name="LoadReadonly" config:type="boolean">false</config:config-item>\0a   <config:config-item config:name="ModifyPasswordHash" config:type="int">0</config:config-item>\0a   <config:config-item config:name="PrinterName" config:type="string"/>\0a   <config:config-item config:name="PrinterPaperFromSetup" config:type="boolean">false</config:config-item>\0a   <config:config-item config:name="PrinterSetup" config:type="base64Binary"/>\0a   <config:config-item config:name="RasterIsVisible" config:type="boolean">false</config:config-item>\0a   <config:config-item config:name="RasterResolutionX" config:type="int">1270</config:config-item>\0a   <config:config-item config:name="RasterResolutionY" config:type="int">1270</config:config-item>\0a   <config:config-item config:name="RasterSubdivisionX" config:type="int">1</config:config-item>\0a   <config:config-item config:name="RasterSubdivisionY" config:type="int">1</config:config-item>\0a   <config:config-item config:name="SaveThumbnail" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="SaveVersionOnClose" config:type="boolean">false</config:config-item>\0a   <config:config-item config:name="ShowFormulasMarks" config:type="boolean">false</config:config-item>\0a   <config:config-item config:name="ShowGrid" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="ShowNoteAuthor" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="ShowNotes" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="ShowPageBreaks" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="ShowZeroValues" config:type="boolean">true</config:config-item>\0a   <config:config-item config:name="SyntaxStringRef" config:type="short">7</config:config-item>\0a   <config:config-item config:name="UpdateFromTemplate" config:type="boolean">true</config:config-item>\0a   <config:config-item-map-named config:name="ScriptConfiguration">\0a    <config:config-item-map-entry config:name="Stock">\0a     <config:config-item config:name="CodeName" config:type="string">Sheet1</config:config-item>\0a    </config:config-item-map-entry>\0a    <config:config-item-map-entry config:name="Notes">\0a     <config:config-item config:name="CodeName" config:type="string">Notes</config:config-item>\0a    </config:config-item-map-entry>\0a    <config:config-item-map-entry config:name="Secret">\0a     <config:config-item config:name="CodeName" config:type="string">Secret</config:config-item>\0a    </config:config-item-map-entry>\0a   </config:config-item-map-named>\0a  </config:config-item-set>\0a </office:settings>\0a <office:scripts>\0a  <office:script script:language="ooo:Basic">\0a   <ooo:libraries xmlns:ooo="http://openoffice.org/2004/office" xmlns:xlink="http://www.w3.org/1999/xlink"/>\0a  </office:script>\0a </office:scripts>\0a <office:font-face-decls>\0a  <style:font-face style:name="Droid Sans Fallback" svg:font-family="&apos;Droid Sans Fallback&apos;" style:font-family-generic="system" style:font-pitch="variable"/>\0a  <style:font-face style:name="Liberation Sans" svg:font-family="&apos;Liberation Sans&apos;" style:font-family-generic="swiss" style:font-pitch="variable"/>\0a  <style:font-face style:name="Noto Sans" svg:font-family="&apos;Noto Sans&apos;" style:font-family-generic="system" style:font-pitch="variable"/>\0a </office:font-face-decls>\0a <office:styles>\0a  <style:default-style style:family="table-cell">\0a   <style:table-cell-properties fo:wrap-option="no-wrap"/>\0a   <style:paragraph-properties style:tab-stop-distance="0.5in"/>\0a   <style:text-properties style:font-name="Liberation Sans" fo:font-size="10pt" fo:language="en" fo:country="US" style:font-name-asian="Droid Sans Fallback" style:font-size-asian="10pt" style:language-asian="zh" style:country-asian="CN" style:font-name-complex="Noto Sans" style:font-size-complex="10pt" style:language-complex="hi" style:country-complex="IN"/>\0a  </style:default-style>\0a  <style:default-style style:family="graphic">\0a   <style:graphic-properties svg:stroke-color="#3465a4" draw:fill-color="#729fcf" fo:wrap-option="no-wrap" draw:shadow-offset-x="0.1181in" draw:shadow-offset-y="0.1181in" style:writing-mode="page"/>\0a   <style:paragraph-properties style:text-autospace="ideograph-alpha" style:punctuation-wrap="simple" style:line-break="strict" style:font-independent-line-spacing="false">\0a    <style:tab-stops/>\0a   </style:paragraph-properties>\0a   <style:text-properties style:use-window-font-color="true" loext:opacity="0%" fo:font-family="&apos;Liberation Serif&apos;" style:font-family-generic="roman" style:font-pitch="variable" fo:font-size="12pt" fo:language="en" fo:country="US" style:letter-kerning="true" style:font-family-asian="&apos;DejaVu Sans&apos;" style:font-family-generic-asian="system" style:font-pitch-asian="variable" style:font-size-asian="12pt" style:language-asian="zh" style:country-asian="CN" style:font-name-complex="Noto Sans" style:font-size-complex="12pt" style:language-complex="hi" style:country-complex="IN"/>\0a  </style:default-style>\0a  <style:style style:name="Default" style:family="graphic"/>\0a  <style:style style:name="Note" style:family="graphic" style:parent-style-name="Default">\0a   <style:graphic-properties draw:stroke="solid" draw:marker-start="Arrowheads_20_1" draw:marker-start-width="0.0787in" draw:marker-start-center="false" draw:fill="solid" draw:fill-color="#ffffc0" draw:auto-grow-height="true" draw:auto-grow-width="false" fo:padding-top="0.0394in" fo:padding-bottom="0.0394in" fo:padding-left="0.0394in" fo:padding-right="0.0394in" draw:shadow="visible" draw:shadow-offset-x="0.0394in" draw:shadow-offset-y="0.0394in"/>\0a   <style:text-properties style:font-name="Liberation Sans" fo:font-family="&apos;Liberation Sans&apos;" style:font-family-generic="swiss" style:font-pitch="variable" fo:font-size="10pt" style:font-name-asian="Droid Sans Fallback" style:font-family-asian="&apos;Droid Sans Fallback&apos;" style:font-family-generic-asian="system" style:font-pitch-asian="variable" style:font-size-asian="10pt" style:font-name-complex="Noto Sans" style:font-family-complex="&apos;Noto Sans&apos;" style:font-family-generic-complex="system" style:font-pitch-complex="variable" style:font-size-complex="10pt"/>\0a  </style:style>\0a  <number:number-style style:name="N0">\0a   <number:number number:min-integer-digits="1"/>\0a  </number:number-style>\0a  <style:style style:name="Default" style:family="table-cell"/>\0a  <style:style style:name="Heading" style:family="table-cell" style:parent-style-name="Default">\0a   <style:table-cell-properties fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:font-size="24pt" fo:font-style="normal" fo:font-weight="bold" style:font-size-asian="24pt" style:font-style-asian="normal" style:font-weight-asian="bold" style:font-size-complex="24pt" style:font-style-complex="normal" style:font-weight-complex="bold"/>\0a  </style:style>\0a  <style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="table-cell" style:parent-style-name="Heading">\0a   <style:table-cell-properties fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:font-size="18pt" style:font-size-asian="18pt" style:font-size-complex="18pt"/>\0a  </style:style>\0a  <style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="table-cell" style:parent-style-name="Heading">\0a   <style:table-cell-properties fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:font-size="12pt" style:font-size-asian="12pt" style:font-size-complex="12pt"/>\0a  </style:style>\0a  <style:style style:name="Text" style:family="table-cell" style:parent-style-name="Default">\0a   <style:table-cell-properties fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a  </style:style>\0a  <style:style style:name="Note" style:family="table-cell" style:parent-style-name="Text">\0a   <style:table-cell-properties fo:background-color="#ffffcc" style:diagonal-bl-tr="none" style:diagonal-tl-br="none" fo:wrap-option="no-wrap" fo:border="0.74pt solid #808080" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:color="#333333"/>\0a  </style:style>\0a  <style:style style:name="Footnote" style:family="table-cell" style:parent-style-name="Text">\0a   <style:table-cell-properties fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:color="#808080" fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"/>\0a  </style:style>\0a  <style:style style:name="Hyperlink" style:family="table-cell" style:parent-style-name="Text">\0a   <style:table-cell-properties fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:color="#0000ee" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="#0000ee"/>\0a  </style:style>\0a  <style:style style:name="Status" style:family="table-cell" style:parent-style-name="Default">\0a   <style:table-cell-properties fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a  </style:style>\0a  <style:style style:name="Good" style:family="table-cell" style:parent-style-name="Status">\0a   <style:table-cell-properties fo:background-color="#ccffcc" fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:color="#006600"/>\0a  </style:style>\0a  <style:style style:name="Neutral" style:family="table-cell" style:parent-style-name="Status">\0a   <style:table-cell-properties fo:background-color="#ffffcc" fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:color="#996600"/>\0a  </style:style>\0a  <style:style style:name="Bad" style:family="table-cell" style:parent-style-name="Status">\0a   <style:table-cell-properties fo:background-color="#ffcccc" fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:color="#cc0000"/>\0a  </style:style>\0a  <style:style style:name="Warning" style:family="table-cell" style:parent-style-name="Status">\0a   <style:table-cell-properties fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:color="#cc0000"/>\0a  </style:style>\0a  <style:style style:name="Error" style:family="table-cell" style:parent-style-name="Status">\0a   <style:table-cell-properties fo:background-color="#cc0000" fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:color="#ffffff" fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"/>\0a  </style:style>\0a  <style:style style:name="Accent" style:family="table-cell" style:parent-style-name="Default">\0a   <style:table-cell-properties fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"/>\0a  </style:style>\0a  <style:style style:name="Accent_20_1" style:display-name="Accent 1" style:family="table-cell" style:parent-style-name="Accent">\0a   <style:table-cell-properties fo:background-color="#000000" fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:color="#ffffff"/>\0a  </style:style>\0a  <style:style style:name="Accent_20_2" style:display-name="Accent 2" style:family="table-cell" style:parent-style-name="Accent">\0a   <style:table-cell-properties fo:background-color="#808080" fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:color="#ffffff"/>\0a  </style:style>\0a  <style:style style:name="Accent_20_3" style:display-name="Accent 3" style:family="table-cell" style:parent-style-name="Accent">\0a   <style:table-cell-properties fo:background-color="#dddddd" fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a  </style:style>\0a  <style:style style:name="Result" style:family="table-cell" style:parent-style-name="Default">\0a   <style:table-cell-properties fo:wrap-option="no-wrap" style:shrink-to-fit="false"/>\0a   <style:text-properties fo:font-style="italic" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color" fo:font-weight="bold" style:font-style-asian="italic" style:font-weight-asian="bold" style:font-style-complex="italic" style:font-weight-complex="bold"/>\0a  </style:style>\0a  <draw:marker draw:name="Arrowheads_20_1" draw:display-name="Arrowheads 1" svg:viewBox="0 0 20 30" svg:d="M10 0l-10 30h20z"/>\0a  <loext:theme loext:name="Office">\0a   <loext:theme-colors loext:name="LibreOffice">\0a    <loext:color loext:name="dark1" loext:color="#000000"/>\0a    <loext:color loext:name="light1" loext:color="#ffffff"/>\0a    <loext:color loext:name="dark2" loext:color="#000000"/>\0a    <loext:color loext:name="light2" loext:color="#ffffff"/>\0a    <loext:color loext:name="accent1" loext:color="#18a303"/>\0a    <loext:color loext:name="accent2" loext:color="#0369a3"/>\0a    <loext:color loext:name="accent3" loext:color="#a33e03"/>\0a    <loext:color loext:name="accent4" loext:color="#8e03a3"/>\0a    <loext:color loext:name="accent5" loext:color="#c99c00"/>\0a    <loext:color loext:name="accent6" loext:color="#c9211e"/>\0a    <loext:color loext:name="hyperlink" loext:color="#0000ee"/>\0a    <loext:color loext:name="followed-hyperlink" loext:color="#551a8b"/>\0a   </loext:theme-colors>\0a  </loext:theme>\0a </office:styles>\0a <office:automatic-styles>\0a  <style:style style:name="co1" style:family="table-column">\0a   <style:table-column-properties fo:break-before="auto" style:column-width="0.889in"/>\0a  </style:style>\0a  <style:style style:name="ro1" style:family="table-row">\0a   <style:table-row-properties style:row-height="0.178in" fo:break-before="auto" style:use-optimal-row-height="true"/>\0a  </style:style>\0a  <style:style style:name="ro2" style:family="table-row">\0a   <style:table-row-properties style:row-height="0.3311in" fo:break-before="auto" style:use-optimal-row-height="true"/>\0a  </style:style>\0a  <style:style style:name="ta1" style:family="table" style:master-page-name="Default">\0a   <style:table-properties table:display="true" style:writing-mode="lr-tb"/>\0a  </style:style>\0a  <style:style style:name="ta2" style:family="table" style:master-page-name="Default">\0a   <style:table-properties table:display="false" style:writing-mode="lr-tb"/>\0a  </style:style>\0a  <number:number-style style:name="N2">\0a   <number:number number:decimal-places="2" number:min-decimal-places="2" number:min-integer-digits="1"/>\0a  </number:number-style>\0a  <style:page-layout style:name="pm1">\0a   <style:page-layout-properties style:writing-mode="lr-tb"/>\0a   <style:header-style>\0a    <style:header-footer-properties fo:min-height="0.2953in" fo:margin-left="0in" fo:margin-right="0in" fo:margin-bottom="0.0984in"/>\0a   </style:header-style>\0a   <style:footer-style>\0a    <style:header-footer-properties fo:min-height="0.2953in" fo:margin-left="0in" fo:margin-right="0in" fo:margin-top="0.0984in"/>\0a   </style:footer-style>\0a  </style:page-layout>\0a  <style:page-layout style:name="pm2">\0a   <style:page-layout-properties style:writing-mode="lr-tb"/>\0a   <style:header-style>\0a    <style:header-footer-properties fo:min-height="0.2953in" fo:margin-left="0in" fo:margin-right="0in" fo:margin-bottom="0.0984in" fo:border="1.5pt solid #000000" fo:padding="0.0071in" fo:background-color="#c0c0c0">\0a     <style:background-image/>\0a    </style:header-footer-properties>\0a   </style:header-style>\0a   <style:footer-style>\0a    <style:header-footer-properties fo:min-height="0.2953in" fo:margin-left="0in" fo:margin-right="0in" fo:margin-top="0.0984in" fo:border="1.5pt solid #000000" fo:padding="0.0071in" fo:background-color="#c0c0c0">\0a     <style:background-image/>\0a    </style:header-footer-properties>\0a   </style:footer-style>\0a  </style:page-layout>\0a </office:automatic-styles>\0a <office:master-styles>\0a  <style:master-page style:name="Default" style:page-layout-name="pm1">\0a   <style:header>\0a    <text:p><text:sheet-name>???</text:sheet-name></text:p>\0a   </style:header>\0a   <style:header-left style:display="false"/>\0a   <style:header-first style:display="false"/>\0a   <style:footer>\0a    <text:p>Page <text:page-number>1</text:page-number></text:p>\0a   </style:footer>\0a   <style:footer-left style:display="false"/>\0a   <style:footer-first style:display="false"/>\0a  </style:master-page>\0a  <style:master-page style:name="Report" style:page-layout-name="pm2">\0a   <style:header>\0a    <style:region-left>\0a     <text:p><text:sheet-name>???</text:sheet-name><text:s/>(<text:title>???</text:title>)</text:p>\0a    </style:region-left>\0a    <style:region-right>\0a     <text:p><text:date style:data-style-name="N2" text:date-value="2026-11-10">00/00/0000</text:date>, <text:time>00:00:00</text:time></text:p>\0a    </style:region-right>\0a   </style:header>\0a   <style:header-left style:display="false"/>\0a   <style:header-first style:display="false"/>\0a   <style:footer>\0a    <text:p>Page <text:page-number>1</text:page-number><text:s/>/ <text:page-count>99</text:page-count></text:p>\0a   </style:footer>\0a   <style:footer-left style:display="false"/>\0a   <style:footer-first style:display="false"/>\0a  </style:master-page>\0a </office:master-styles>\0a <office:body>\0a  <office:spreadsheet>\0a   <table:table table:name="Stock" table:style-name="ta1">\0a    <table:table-column table:style-name="co1" table:number-columns-repeated="4" table:default-cell-style-name="Default"/>\0a    <table:table-row table:style-name="ro1">\0a     <table:table-cell office:value-type="string" calcext:value-type="string" table:number-columns-spanned="4" table:number-rows-spanned="1">\0a      <text:p>Fruit &amp; veg &lt;2026&gt;</text:p>\0a     </table:table-cell>\0a     <table:covered-table-cell table:number-columns-repeated="3"/>\0a    </table:table-row>\0a    <table:table-row table:style-name="ro1">\0a     <table:table-cell office:value-type="string" calcext:value-type="string">\0a      <text:p>item</text:p>\0a     </table:table-cell>\0a     <table:table-cell office:value-type="string" calcext:value-type="string">\0a      <text:p>qty</text:p>\0a     </table:table-cell>\0a     <table:table-cell office:value-type="string" calcext:value-type="string">\0a      <text:p>price</text:p>\0a     </table:table-cell>\0a     <table:table-cell office:value-type="string" calcext:value-type="string">\0a      <text:p>total</text:p>\0a     </table:table-cell>\0a    </table:table-row>\0a    <table:table-row table:style-name="ro1">\0a     <table:table-cell office:value-type="string" calcext:value-type="string">\0a      <text:p>apple</text:p>\0a     </table:table-cell>\0a     <table:table-cell office:value-type="float" office:value="3" calcext:value-type="float">\0a      <text:p>3</text:p>\0a     </table:table-cell>\0a     <table:table-cell office:value-type="float" office:value="1.5" calcext:value-type="float">\0a      <text:p>1.5</text:p>\0a     </table:table-cell>\0a     <table:table-cell table:formula="of:=[.B3]*[.C3]" office:value-type="float" office:value="4.5" calcext:value-type="float">\0a      <text:p>4.5</text:p>\0a     </table:table-cell>\0a    </table:table-row>\0a    <table:table-row table:style-name="ro1">\0a     <table:table-cell office:value-type="string" calcext:value-type="string">\0a      <text:p>pear</text:p>\0a     </table:table-cell>\0a     <table:table-cell table:number-columns-repeated="2" office:value-type="float" office:value="2" calcext:value-type="float">\0a      <text:p>2</text:p>\0a     </table:table-cell>\0a     <table:table-cell table:formula="of:=[.B4]*[.C4]" office:value-type="float" office:value="4" calcext:value-type="float">\0a      <text:p>4</text:p>\0a     </table:table-cell>\0a    </table:table-row>\0a    <table:table-row table:style-name="ro1">\0a     <table:table-cell office:value-type="string" calcext:value-type="string" table:number-columns-spanned="1" table:number-rows-spanned="2">\0a      <text:p>sum</text:p>\0a     </table:table-cell>\0a     <table:table-cell table:number-columns-repeated="2"/>\0a     <table:table-cell table:formula="of:=SUM([.D3:.D4])" office:value-type="float" office:value="8.5" calcext:value-type="float">\0a      <text:p>8.5</text:p>\0a     </table:table-cell>\0a    </table:table-row>\0a    <table:table-row table:style-name="ro2">\0a     <table:covered-table-cell/>\0a     <table:table-cell office:value-type="string" calcext:value-type="string"><text:p>two lines</text:p><text:p>in a cell</text:p>\0a     </table:table-cell>\0a     <table:table-cell table:number-columns-repeated="2"/>\0a    </table:table-row>\0a   </table:table>\0a   <table:table table:name="Notes" table:style-name="ta1">\0a    <table:table-column table:style-name="co1" table:default-cell-style-name="Default"/>\0a    <table:table-row table:style-name="ro1">\0a     <table:table-cell office:value-type="string" calcext:value-type="string">\0a      <text:p>second sheet</text:p>\0a     </table:table-cell>\0a    </table:table-row>\0a   </table:table>\0a   <table:table table:name="Secret" table:style-name="ta2">\0a    <table:table-column table:style-name="co1" table:default-cell-style-name="Default"/>\0a    <table:table-row table:style-name="ro1">\0a     <table:table-cell office:value-type="string" calcext:value-type="string">\0a      <text:p>hidden words</text:p>\0a     </table:table-cell>\0a    </table:table-row>\0a   </table:table>\0a   <table:named-expressions/>\0a  </office:spreadsheet>\0a </office:body>\0a</office:document>'
++  f-hostile
  '<?xml version="1.0" encoding="UTF-8"?>\0a<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:ooo="http://openoffice.org/2004/office" xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">\0a <office:scripts>\0a  <office:script script:language="ooo:Basic">\0a   <ooo:libraries><ooo:library-embedded ooo:name="Standard"><ooo:module ooo:name="M"><ooo:source-code>Sub EvilMacro\0a Shell("calc.exe")\0aEnd Sub</ooo:source-code></ooo:module></ooo:library-embedded></ooo:libraries>\0a  </office:script>\0a </office:scripts>\0a <office:body>\0a  <office:spreadsheet>\0a   <table:table table:name="&lt;img src=x onerror=alert(1)&gt;">\0a    <table:table-column table:number-columns-repeated="16384"/>\0a    <table:table-row>\0a     <table:table-cell office:value-type="string"><text:p>&lt;script&gt;alert(document.cookie)&lt;/script&gt;</text:p></table:table-cell>\0a     <table:table-cell office:value-type="string"><text:p><text:a xlink:href="javascript:alert(1)">a link</text:a></text:p></table:table-cell>\0a     <table:table-cell table:formula="of:=WEBSERVICE(&quot;http://evil.example/&quot;)" office:value-type="string"><text:p>cached</text:p></table:table-cell>\0a     <table:table-cell><office:annotation><text:p>a comment</text:p></office:annotation><draw:frame><draw:image xlink:href="http://evil.example/x.png"/></draw:frame></table:table-cell>\0a    </table:table-row>\0a    <table:table-row table:number-rows-repeated="1048575">\0a     <table:table-cell table:number-columns-repeated="16384" office:value-type="string"><text:p>x</text:p></table:table-cell>\0a    </table:table-row>\0a   </table:table>\0a  </office:spreadsheet>\0a </office:body>\0a</office:document>\0a'
--
