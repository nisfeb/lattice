::  Property tests for /lib/lattice-fodt (the flat ODT scanner and renderer).
::
::  A shared or edit-shared fodt page is XML a peer wrote, rendered on this
::  ship for the reader and the published views. The example tests next
::  door cover the shapes somebody thought of; these cover token soup.
::
::  Properties:
::    F1  +fodt-html is TOTAL and never emits script, an iframe, a handler
::        attribute or a live link to a refused scheme
::    F2  +fodt-text and +fodt-title are TOTAL
::    F3  a refused scheme behind any leading byte never becomes a link
::    F4  a hostile style value never reaches the CSS
::
::  Token soup is mostly not well-formed, so it mostly tests F1 and F2 on
::  the note path. F3 and F4 use targeted generators whose documents are
::  well-formed, so the renderer runs and a refutation is attributable.
::
::  +mong reports a crash inside the lib as a refutation. It cannot catch
::  a loop, and the scanner is a single linear pass, so there is none.
::
/+  *test, quiz=lattice-quiz, fz=lattice-fuzz, fo=lattice-fodt
|%
++  chk  ~(check quiz `@uv`0xf0.d7ee 96)
::
::  +gen-fodt: a document skeleton with soup in its automatic styles and
::  in its body
++  gen-fodt
  |=  [size=@ud rng=_og]
  ^-  @t
  =^  sty  rng  (soup:fz fodt-style-pool:fz (min size 60) rng)
  =^  bod  rng  (soup:fz fodt-pool:fz (min size frag-max:fz) rng)
  %-  crip
  ;:  weld
    "<office:document><office:automatic-styles>"
    sty
    "</office:automatic-styles><office:body><office:text>"
    bod
    "</office:text></office:body></office:document>"
  ==
::
++  test-prop-html-safe
  =/  fate=vase
    !>
    |=  f=@t
    ^-  ?
    =/  o=tape  (cass (fodt-html:fo f))
    ?&  !(has-sub:fz "<script" o)
        !(has-sub:fz "<iframe" o)
        !(has-sub:fz "<img" o)
        !(has-sub:fz "onerror=\"" o)
        !(has-sub:fz "href=\"javascript" o)
        !(has-sub:fz "href=\" " o)
        !(has-sub:fz "href=\"vnd." o)
        !(has-sub:fz "href=\"data:" o)
        !(has-sub:fz "href=\"file:" o)
    ==
  (expect !>((chk fate `gen-fodt `cord-alts:fz)))
::
++  test-prop-text-and-title-total
  =/  fate=vase
    !>
    |=  f=@t
    ^-  ?
    =/  t=@t  (fodt-text:fo f)
    =/  h=(unit @t)  (fodt-title:fo f)
    &
  (expect !>((chk fate `gen-fodt `cord-alts:fz)))
::
::  +gen-evil-link: a well-formed link to a refused scheme, with a leading
::  byte a browser ignores in front of it
++  gen-evil-link
  |=  [size=@ud rng=_og]
  ^-  @t
  =^  lead  rng  (pick:fz lead-pool:fz rng)
  =^  sch   rng
    %+  pick:fz
      :~  "javascript:"  "JaVaScRiPt:"  "vnd.sun.star.script:"  "macro:"
          ".uno:"  "data:"  "file:"  "jav&#x61;script&#58;"  "&#106;avascript:"
      ==
    rng
  %-  crip
  ;:  weld
    "<office:document><office:body><office:text><text:p>"
    "<text:a xlink:href=\""  lead  sch  "x\">zzlink</text:a>"
    "</text:p></office:text></office:body></office:document>"
  ==
++  test-prop-refused-schemes-are-text
  =/  fate=vase
    !>
    |=  f=@t
    ^-  ?
    =/  o=tape  (fodt-html:fo f)
    ?&  (has-sub:fz "<p>zzlink</p>" o)
        !(has-sub:fz "<a " o)
    ==
  (expect !>((chk fate `gen-evil-link `cord-alts:fz)))
::
::  +gen-evil-style: a span whose text style carries a hostile value in
::  one property
++  gen-evil-style
  |=  [size=@ud rng=_og]
  ^-  @t
  =^  prop  rng
    %+  pick:fz
      :~  "fo:color"  "fo:background-color"  "fo:font-family"  "fo:font-size"
          "fo:letter-spacing"  "fo:margin-left"  "style:font-name"
          "fo:line-height"  "fo:text-indent"
      ==
    rng
  =^  val  rng
    %+  pick:fz
      :~  "red;background:url(zz)"  "url(javascript:zz)"  "12pt;width:expression(zz)"
          "#fff;behavior:url(zz)"  "1px&lt;/style&gt;&lt;script&gt;zz"
          "x}&lt;/style&gt;"  "&apos;a&apos;;background:url(zz)"
          "1cm/**/;background:url(zz)"  "#c9211e\\;url(zz)"
          ::  seven bytes after a #, the length a colour has
          "#url(z)"  "#zz;a:b"
      ==
    rng
  %-  crip
  ;:  weld
    "<office:document><office:automatic-styles><style:style style:name=\"T1\" style:family=\"text\"><style:text-properties "
    prop  "=\""  val  "\"/></style:style></office:automatic-styles>"
    "<office:body><office:text><text:p><text:span text:style-name=\"T1\">zzspan</text:span></text:p></office:text></office:body></office:document>"
  ==
++  test-prop-hostile-style-values-dropped
  =/  fate=vase
    !>
    |=  f=@t
    ^-  ?
    =/  o=tape  (fodt-html:fo f)
    ?&  (has-sub:fz "zzspan" o)
        !(has-sub:fz "url(" o)
        !(has-sub:fz "expression" o)
        !(has-sub:fz "behavior" o)
        !(has-sub:fz "<script" o)
        !(has-sub:fz "</style" o)
        !(has-sub:fz "zz;" o)
        !(has-sub:fz "zz)" o)
    ==
  (expect !>((chk fate `gen-evil-style `cord-alts:fz)))
--
