::  /lib/lattice-fodt: flat ODT (a .fodt page body) on the ship.
::
::  +scan is a bounded, non-validating XML tokenizer. +fodt-text is the
::  body text for search, +fodt-title the page title, and +fodt-html the
::  phase 1 subset as safe HTML for the reader, the preview and the
::  published views (spec, Server-side rendering).
::
::  No DTD is processed. A DOCTYPE with an internal subset and any
::  <!ENTITY are refused, and only the five XML entities and numeric
::  character references are decoded, so entity expansion and external
::  entities cannot happen. Input over 2 MB or nested deeper than 256 is
::  refused, and every entry point runs under +mule, so a hostile
::  document gives the "not previewable" note, never a crash.
::
::  The HTML is built, never copied. Elements come from a fixed list, text
::  is escaped, a link keeps only the schemes +safe-url allows, and a style
::  property becomes CSS only when its value parses (a number and a unit,
::  a #rrggbb colour, a keyword from a list, a font name of letters,
::  digits, spaces and hyphens). The CSS is written from the parsed value,
::  into style attributes, so no raw ODF string reaches the HTML and two
::  documents on one page cannot restyle each other.
::
/<  gfm  /lib/lattice-md.hoon
|%
+$  attr  [n=@t v=tape]
+$  token
  $%  [%open n=@t a=(list attr) e=?]
      [%close n=@t]
      [%text t=tape]
  ==
+$  node
  $%  [%e n=@t a=(list attr) k=(list node)]
      [%t t=tape]
  ==
+$  frame  [n=@t a=(list attr) k=(list node)]
::  a paragraph style, resolved: its CSS, quote (Quotations or a child
::  of it) and a page break before
+$  pstyle  [css=tape quote=? brk=?]
::  a text style, resolved: the marks, and the CSS the marks do not carry
+$  tstyle  [b=? i=? u=? s=? css=tape]
+$  sty  [par=(unit @t) pro=(map @t tape)]
+$  sheet
  $:  fonts=(map @t tape)
      styles=(map [@t @t] sty)
      defaults=(map @t (map @t tape))
      lists=(map @t (map @ud ?))
      layouts=(map @t (map @t tape))
      master=(unit @t)
  ==
+$  cache
  $:  pm=(map @t pstyle)
      pd=pstyle
      tm=(map @t tstyle)
      lists=(map @t (map @ud ?))
  ==
++  max-size   ^~((mul 2 (bex 20)))
++  max-depth  256
++  note-html  "<p class=\"fodt-note\">page too large or not previewable</p>"
::
::  +scan: the document as tokens, or why it is refused
++  scan
  |=  f=@t
  ^-  (each (list token) @t)
  ?:  (gth (met 3 f) max-size)  [%| 'too large']
  =/  r  (mule |.((scan-raw (trip f))))
  ?:  ?=(%& -.r)  p.r
  [%| 'not well-formed']
::  +scan-raw: one linear loop. A malformed tag crashes, and +scan's mule
::  turns that into a refusal.
++  scan-raw
  |=  s=tape
  ^-  (each (list token) @t)
  =|  out=(list token)
  =|  dep=@ud
  |-  ^-  (each (list token) @t)
  ?~  s  [%& (flop out)]
  ?.  =('<' i.s)
    =/  [t=tape r=tape]  (text-run s)
    $(s r, out [[%text t] out])
  =/  q=tape  t.s
  ?~  q  !!
  ?:  =('?' i.q)  $(s +:(split-at "?>" t.q))
  ?:  =('!' i.q)
    ?:  (pre "--" t.q)  $(s +:(split-at "-->" (sl 2 t.q)))
    ?:  (pre "[CDATA[" t.q)
      =/  [c=tape r=tape]  (split-at "]]>" (sl 7 t.q))
      $(s r, out [[%text c] out])
    ?:  (pre "DOCTYPE" t.q)
      =/  [d=tape r=tape]  (split-at ">" t.q)
      ?^  (find "[" d)  [%| 'a DOCTYPE with an internal subset']
      $(s r)
    ?:  (pre "ENTITY" t.q)  [%| 'an entity declaration']
    [%| 'a markup declaration']
  ?:  =('/' i.q)
    =/  [n=tape r=tape]  (split-at ">" t.q)
    $(s r, dep ?:(=(0 dep) 0 (dec dep)), out [[%close (crip (trim n))] out])
  =/  [n=@t as=(list attr) e=? r=tape]  (open-tag q)
  ?:  e  $(s r, out [[%open n as &] out])
  ?:  (gte dep max-depth)  [%| 'nested too deep']
  $(s r, dep +(dep), out [[%open n as |] out])
::
::  scag and slag are wet: on a ?~-refined tape they mull-grow, so these
::  dry ones take a plain tape
++  sc   |=([n=@ud t=tape] ^-(tape (scag n t)))
++  sl   |=([n=@ud t=tape] ^-(tape (slag n t)))
++  pre  |=([p=tape t=tape] =(p (sc (lent p) t)))
++  ws   |=(c=@ |(=(' ' c) =(9 c) =(10 c) =(13 c)))
++  trim
  |=  t=tape
  ^-  tape
  =.  t  |-(?~(t t ?:((ws i.t) $(t t.t) t)))
  =.  t  (flop t)
  =.  t  |-(?~(t t ?:((ws i.t) $(t t.t) t)))
  (flop t)
::  +join: tapes, oldest first, with `sep` between
++  join
  |=  [sep=tape l=(list tape)]
  ^-  tape
  =|  acc=(list tape)
  =.  l  (flop l)
  |-  ^-  tape
  ?~  l  (zing acc)
  $(l t.l, acc ?~(acc [i.l ~] [i.l sep acc]))
::  +split-at: the text before the first `d`, and the text after it
++  split-at
  |=  [d=tape s=tape]
  ^-  [tape tape]
  ?>  ?=(^ d)
  =|  acc=tape
  |-  ^-  [tape tape]
  ?~  s  ~|(%unterminated !!)
  ?:  &(=(i.d i.s) (pre d s))  [(flop acc) (sl (lent d) s)]
  $(s t.s, acc [i.s acc])
::  +text-run: character data up to the next <, entities decoded
++  text-run
  |=  s=tape
  ^-  [tape tape]
  =|  acc=tape
  |-  ^-  [tape tape]
  ?~  s  [(flop acc) ~]
  ?:  =('<' i.s)  [(flop acc) s]
  ?.  =('&' i.s)  $(s t.s, acc [i.s acc])
  =/  [d=tape r=tape]  (entity t.s)
  $(s r, acc (weld (flop d) acc))
::  +entity: after an &. The five XML entities and numeric references;
::  anything else stays as written, a literal &.
++  entity
  |=  s=tape
  ^-  [tape tape]
  =/  i=(unit @ud)  (find ";" (sc 12 s))
  ?~  i  ["&" s]
  =/  nm=tape  (sc u.i s)
  =/  r=tape  (sl +(u.i) s)
  ?:  =("lt" nm)  ["<" r]
  ?:  =("gt" nm)  [">" r]
  ?:  =("amp" nm)  ["&" r]
  ?:  =("quot" nm)  ["\"" r]
  ?:  =("apos" nm)  ["'" r]
  ?.  ?=([%'#' *] nm)  ["&" s]
  =/  cp=(unit @)  (char-ref t.nm)
  ?~  cp  ["&" s]
  [(trip (tuft u.cp)) r]
++  char-ref
  |=  t=tape
  ^-  (unit @)
  ?~  t  ~
  =/  v=(unit @)
    ?:  |(=('x' i.t) =('X' i.t))
      ?~  t.t  ~
      (rush (crip (cass t.t)) hex)
    (rush (crip t) dem)
  ?~  v  ~
  ?:  ?|  =(0 u.v)
          (gth u.v 0x10.ffff)
          &((gte u.v 0xd800) (lte u.v 0xdfff))
      ==
    ~
  v
::  +open-tag: after the <, the name, the attributes, self-closing or not
++  open-tag
  |=  q=tape
  ^-  [@t (list attr) ? tape]
  =/  [n=tape r=tape]  (name-run q)
  ?<  =(~ n)
  =|  as=(list attr)
  |-  ^-  [@t (list attr) ? tape]
  =.  r  |-(?~(r r ?:((ws i.r) $(r t.r) r)))
  ?~  r  ~|(%unterminated !!)
  ?:  =('>' i.r)  [(crip n) (flop as) | t.r]
  ?:  =('/' i.r)
    ?>  ?=([%'>' *] t.r)
    [(crip n) (flop as) & t.t.r]
  =/  [an=tape r2=tape]  (name-run r)
  ?<  =(~ an)
  =.  r2  |-(?~(r2 r2 ?:((ws i.r2) $(r2 t.r2) r2)))
  ?>  ?=([%'=' *] r2)
  =/  r4=tape  t.r2
  =.  r4  |-(?~(r4 r4 ?:((ws i.r4) $(r4 t.r4) r4)))
  ?>  ?=(^ r4)
  ?>  |(=('"' i.r4) =('\'' i.r4))
  =/  [v=tape r3=tape]  (attr-val i.r4 t.r4)
  $(r r3, as [[(crip an) v] as])
++  name-run
  |=  s=tape
  ^-  [tape tape]
  =|  acc=tape
  |-  ^-  [tape tape]
  ?~  s  [(flop acc) ~]
  =*  c  i.s
  ?:  |(=(32 c) =(10 c) =(9 c) =(13 c) =('=' c) =('>' c) =('/' c) =('<' c))
    [(flop acc) s]
  $(s t.s, acc [i.s acc])
++  attr-val
  |=  [qc=@ s=tape]
  ^-  [tape tape]
  =|  acc=tape
  |-  ^-  [tape tape]
  ?~  s  ~|(%unterminated !!)
  ?:  =(qc i.s)  [(flop acc) t.s]
  ?.  =('&' i.s)  $(s t.s, acc [i.s acc])
  =/  [d=tape r=tape]  (entity t.s)
  $(s r, acc (weld (flop d) acc))
::
::  +tree: tokens to elements, with an explicit stack (no recursion on
::  depth). A close tag with no open match is dropped; one that matches
::  further down closes what is above it. The stack is capped at
::  +max-depth here too: +scan counts every close tag, so unmatched
::  closes (<a></z><a></z>...) would let the real nesting grow past its
::  cap, and the +lien below would go quadratic. Over the cap it crashes,
::  and the callers' +mule gives the note.
++  tree
  |=  ts=(list token)
  ^-  (list node)
  =|  stk=(list frame)
  =|  top=(list node)
  =|  dep=@ud
  |-  ^-  (list node)
  ?~  ts
    ?~  stk  (flop top)
    =/  el=node  [%e n.i.stk a.i.stk (flop k.i.stk)]
    ?~  t.stk  (flop [el top])
    $(stk [i.t.stk(k [el k.i.t.stk]) t.t.stk])
  =*  t  i.ts
  ?-    -.t
      %text
    ?~  stk  $(ts t.ts)
    $(ts t.ts, stk [i.stk(k [[%t t.t] k.i.stk]) t.stk])
  ::
      %open
    ?.  e.t
      ?:  (gte dep max-depth)  ~|(%fodt-too-deep !!)
      $(ts t.ts, stk [[n.t a.t ~] stk], dep +(dep))
    =/  el=node  [%e n.t a.t ~]
    ?~  stk  $(ts t.ts, top [el top])
    $(ts t.ts, stk [i.stk(k [el k.i.stk]) t.stk])
  ::
      %close
    ?.  (lien stk |=(fr=frame =(n.fr n.t)))  $(ts t.ts)
    =/  [s2=(list frame) t2=(list node)]  (pop-to n.t stk top)
    $(ts t.ts, stk s2, top t2, dep (lent s2))
  ==
++  pop-to
  |=  [n=@t stk=(list frame) top=(list node)]
  ^-  [(list frame) (list node)]
  |-  ^-  [(list frame) (list node)]
  ?~  stk  [~ top]
  =/  el=node  [%e n.i.stk a.i.stk (flop k.i.stk)]
  ?~  t.stk  [~ [el top]]
  =/  s2=(list frame)  [i.t.stk(k [el k.i.t.stk]) t.t.stk]
  ?:  =(n n.i.stk)  [s2 top]
  $(stk s2)
::
::  helpers over nodes
++  ga
  |=  [n=@t as=(list attr)]
  ^-  (unit tape)
  ?~  as  ~
  ?:  =(n n.i.as)  `v.i.as
  $(as t.as)
++  kid
  |=  [n=@t ks=(list node)]
  ^-  (unit node)
  ?~  ks  ~
  ?:  &(?=(%e -.i.ks) =(n n.i.ks))  `i.ks
  $(ks t.ks)
::  +doc-of: the office:document element, ~ when refused or absent
++  doc-of
  |=  f=@t
  ^-  (unit node)
  =/  s  (scan f)
  ?:  ?=(%| -.s)  ~
  (kid 'office:document' (tree p.s))
::  +office-text: office:body > office:text, from office:document's kids
++  office-text
  |=  ks=(list node)
  ^-  (unit node)
  =/  b  (kid 'office:body' ks)
  ?~  b  ~
  ?>  ?=(%e -.u.b)
  (kid 'office:text' k.u.b)
::  +norm: ODF white space. Tab, CR and LF are spaces, and a run of spaces
::  is one (text:s carries the rest).
++  norm
  |=  t=tape
  ^-  tape
  =|  acc=tape
  =/  sp=?  |
  |-  ^-  tape
  ?~  t  (flop acc)
  ?.  |(=(32 i.t) =(10 i.t) =(9 i.t) =(13 i.t))  $(t t.t, sp |, acc [i.t acc])
  ?:  sp  $(t t.t)
  $(t t.t, sp &, acc [' ' acc])
::  +esn: +norm and HTML escaping in one pass, for a text node
++  esn
  |=  t=tape
  ^-  tape
  =|  acc=tape
  =/  sp=?  |
  |-  ^-  tape
  ?~  t  (flop acc)
  =*  c  i.t
  ?:  |(=(32 c) =(10 c) =(9 c) =(13 c))
    ?:  sp  $(t t.t)
    $(t t.t, sp &, acc [' ' acc])
  ?:  =('&' c)  $(t t.t, sp |, acc (weld ";pma&" acc))
  ?:  =('<' c)  $(t t.t, sp |, acc (weld ";tl&" acc))
  ?:  =('>' c)  $(t t.t, sp |, acc (weld ";tg&" acc))
  ?:  =('"' c)  $(t t.t, sp |, acc (weld ";touq&" acc))
  $(t t.t, sp |, acc [c acc])
::  +esc: HTML escaping, for attribute values and opaque text
++  esc
  |=  t=tape
  ^-  tape
  =|  acc=tape
  |-  ^-  tape
  ?~  t  (flop acc)
  =*  c  i.t
  ?:  =('&' c)  $(t t.t, acc (weld ";pma&" acc))
  ?:  =('<' c)  $(t t.t, acc (weld ";tl&" acc))
  ?:  =('>' c)  $(t t.t, acc (weld ";tg&" acc))
  ?:  =('"' c)  $(t t.t, acc (weld ";touq&" acc))
  $(t t.t, acc [c acc])
::  +count: text:s's text:c, 1 when absent, at most 100, so a 23-byte
::  element cannot become a kilobyte of spaces
++  count
  |=  as=(list attr)
  ^-  @ud
  =/  c  (ga 'text:c' as)
  ?~  c  1
  =/  n  (rush (crip u.c) dem)
  ?~  n  1
  (min u.n 100)
::  skipped entirely: never shown, never searched
++  skip-block
  |=  n=@t
  ^-  ?
  ?|  =('draw:' (end [3 5] n))
      (~(has in skip-blocks) n)
  ==
++  skip-blocks
  ^~  ^-  (set @t)
  %-  silt
  :~  'office:scripts'  'office:settings'  'office:binary-data'
      'office:forms'  'office:event-listeners'  'office:annotation'
      'text:tracked-changes'  'text:sequence-decls'  'text:variable-decls'
      'text:user-field-decls'  'text:dde-connection-decls'
      'table:named-expressions'  'table:table-column'  'table:table-columns'
      'table:table-column-group'  'table:table-header-columns'
      'text:section-source'  'text:soft-page-break'
  ==
++  skip-inline
  |=  n=@t
  ^-  ?
  ?|  =('draw:' (end [3 5] n))
      (~(has in skip-inlines) n)
  ==
++  skip-inlines
  ^~  ^-  (set @t)
  %-  silt
  :~  'office:annotation'  'office:annotation-end'  'office:event-listeners'
      'text:bookmark'  'text:bookmark-start'  'text:bookmark-end'
      'text:reference-mark'  'text:reference-mark-start'
      'text:reference-mark-end'  'text:change'  'text:change-start'
      'text:change-end'  'text:soft-page-break'  'text:toc-mark'
      'text:toc-mark-start'  'text:toc-mark-end'
      'text:alphabetical-index-mark'  'text:alphabetical-index-mark-start'
      'text:alphabetical-index-mark-end'  'text:user-index-mark'
      'text:user-index-mark-start'  'text:user-index-mark-end'
  ==
::  generated indexes: only their index body is shown
++  index-el
  |=  n=@t
  ^-  ?
  %-  ~(has in index-els)  n
++  index-els
  ^~  ^-  (set @t)
  %-  silt
  :~  'text:table-of-content'  'text:alphabetical-index'
      'text:illustration-index'  'text:table-index'  'text:object-index'
      'text:user-index'  'text:bibliography'
  ==
++  index-kids
  |=  k=node
  ^-  (list node)
  ?.  ?=(%e -.k)  ~
  =/  b  (kid 'text:index-body' k.k)
  ?~  b  ~
  ?.  ?=(%e -.u.b)  ~
  k.u.b
::  a footnote's marker: the text of its text:note-citation
++  cite-kids
  |=  k=node
  ^-  (list node)
  ?.  ?=(%e -.k)  ~
  =/  c  (kid 'text:note-citation' k.k)
  ?~  c  ~
  ?.  ?=(%e -.u.c)  ~
  k.u.c
::
::  +lines: the text of each paragraph and heading under `ks`, newest first
++  lines
  |=  [ks=(list node) out=(list tape)]
  ^-  (list tape)
  ?~  ks  out
  =*  k  i.ks
  ?:  ?=(%t -.k)  $(ks t.ks)
  ?:  (skip-block n.k)  $(ks t.ks)
  ?:  |(=('text:p' n.k) =('text:h' n.k))
    $(ks t.ks, out [(zing (flop (itext k.k ~))) out])
  ?:  (index-el n.k)  $(ks t.ks, out (lines (index-kids k) out))
  $(ks t.ks, out (lines k.k out))
::  +itext: inline text, as chunks newest first
++  itext
  |=  [ks=(list node) out=(list tape)]
  ^-  (list tape)
  ?~  ks  out
  =*  k  i.ks
  ?:  ?=(%t -.k)  $(ks t.ks, out [(norm t.k) out])
  ?:  (skip-inline n.k)  $(ks t.ks)
  ?:  =('text:s' n.k)  $(ks t.ks, out [(reap (count a.k) ' ') out])
  ?:  =('text:tab' n.k)  $(ks t.ks, out [~[`@tD`9] out])
  ?:  =('text:line-break' n.k)  $(ks t.ks, out [~[`@tD`10] out])
  ?:  =('text:note' n.k)  $(ks t.ks, out (itext (cite-kids k) out))
  $(ks t.ks, out (itext k.k out))
::
::  +fodt-text: the body text, one line per paragraph or heading, for
::  search. Styles, macros, settings, drawings and comments are not text.
++  fodt-text
  |=  f=@t
  ^-  @t
  =/  r  (mule |.((text-of (doc-of f))))
  ?:(?=(%& -.r) p.r '')
::
::  +fodt-title: dc:title when set, else the first heading's text
++  fodt-title
  |=  f=@t
  ^-  (unit @t)
  =/  r  (mule |.((title-of (doc-of f))))
  ?:(?=(%& -.r) p.r ~)
::
::  +fodt-all: the HTML, the text and the title from ONE parse, for the
::  ship's render cache. Each is what +fodt-html, +fodt-text and
::  +fodt-title answer, and a crash in one part spoils only that part.
::  The parse is most of the cost (+scan alone is 2.8 s of the 4.7 to
::  6.1 s +fodt-html takes on a 1.5 MB document), so the three together
::  cost about one render, not three.
++  fodt-all
  |=  f=@t
  ^-  [html=tape text=@t title=(unit @t)]
  ?:  (gth (met 3 f) max-size)  [note-html '' ~]
  =/  d  (mule |.((doc-of f)))
  ?:  ?=(%| -.d)  [note-html '' ~]
  =/  h  (mule |.((html-of p.d)))
  =/  t  (mule |.((text-of p.d)))
  =/  l  (mule |.((title-of p.d)))
  :+  ?:(?=(%& -.h) p.h note-html)
    ?:(?=(%& -.t) p.t '')
  ?:(?=(%& -.l) p.l ~)
::
::  +text-of: +fodt-text of a parsed document
++  text-of
  |=  d=(unit node)
  ^-  @t
  ?~  d  ''
  ?>  ?=(%e -.u.d)
  =/  b  (office-text k.u.d)
  ?~  b  ''
  ?>  ?=(%e -.u.b)
  (crip (join "\0a" (flop (lines k.u.b ~))))
::
::  +title-of: +fodt-title of a parsed document
++  title-of
  |=  d=(unit node)
  ^-  (unit @t)
  ?~  d  ~
  ?>  ?=(%e -.u.d)
  =/  dt=tape
    =/  m  (kid 'office:meta' k.u.d)
    ?~  m  ~
    ?>  ?=(%e -.u.m)
    =/  t  (kid 'dc:title' k.u.m)
    ?~  t  ~
    ?>  ?=(%e -.u.t)
    (trim (zing (flop (itext k.u.t ~))))
  ?^  dt  `(crip dt)
  =/  b  (office-text k.u.d)
  ?~  b  ~
  ?>  ?=(%e -.u.b)
  =/  h  (first-h k.u.b)
  ?~  h  ~
  =/  ht=tape  (trim (zing (flop (itext u.h ~))))
  ?~(ht ~ `(crip ht))
::  +first-h: the kids of the first text:h, depth first through blocks
++  first-h
  |=  ks=(list node)
  ^-  (unit (list node))
  ?~  ks  ~
  =*  k  i.ks
  ?:  ?=(%t -.k)  $(ks t.ks)
  ?:  =('text:h' n.k)  `k.k
  ?:  |((skip-block n.k) =('text:p' n.k))  $(ks t.ks)
  =/  in  (first-h k.k)
  ?^  in  in
  $(ks t.ks)
::
::  the style sheet: fonts, styles with their parents, defaults, list
::  styles and the page layout of the first master page
++  keep
  ^~  ^-  (set @t)
  %-  silt
  :~  'fo:font-size'  'style:font-name'  'fo:font-family'  'fo:font-weight'
      'fo:font-style'  'fo:color'  'fo:background-color'  'fo:margin-top'
      'fo:margin-bottom'  'fo:margin-left'  'fo:margin-right'
      'fo:text-indent'  'fo:line-height'  'fo:text-align'
      'style:text-underline-style'  'style:text-line-through-style'
      'fo:text-transform'  'fo:font-variant'  'fo:letter-spacing'
      'fo:break-before'
  ==
++  collect
  |=  ks=(list node)
  ^-  sheet
  =|  sh=sheet
  |-  ^-  sheet
  ?~  ks  sh
  =*  k  i.ks
  ?.  ?=(%e -.k)  $(ks t.ks)
  ?:  =('office:font-face-decls' n.k)
    $(ks t.ks, fonts.sh (fonts-of k.k fonts.sh))
  ?:  |(=('office:styles' n.k) =('office:automatic-styles' n.k))
    $(ks t.ks, sh (styles-of k.k sh))
  ?:  &(=('office:master-styles' n.k) ?=(~ master.sh))
    $(ks t.ks, master.sh (first-master k.k))
  $(ks t.ks)
++  first-master
  |=  ks=(list node)
  ^-  (unit @t)
  ?~  ks  ~
  =*  k  i.ks
  ?.  &(?=(%e -.k) =('style:master-page' n.k))  $(ks t.ks)
  (bind (ga 'style:page-layout-name' a.k) crip)
++  fonts-of
  |=  [ks=(list node) fo=(map @t tape)]
  ^-  (map @t tape)
  ?~  ks  fo
  =*  k  i.ks
  ?.  &(?=(%e -.k) =('style:font-face' n.k))  $(ks t.ks)
  =/  nm  (ga 'style:name' a.k)
  ?~  nm  $(ks t.ks)
  =/  fam=tape  (fall (ga 'svg:font-family' a.k) u.nm)
  =/  css  (fam-css fam (biff (ga 'style:font-family-generic' a.k) generic))
  ?~  css  $(ks t.ks)
  $(ks t.ks, fo (~(put by fo) (crip u.nm) u.css))
++  props-of
  |=  ks=(list node)
  ^-  (map @t tape)
  =|  p=(map @t tape)
  |-  ^-  (map @t tape)
  ?~  ks  p
  =/  as=(list attr)
    =*  k  i.ks
    ?.  ?&  ?=(%e -.k)
            |(=('style:paragraph-properties' n.k) =('style:text-properties' n.k))
        ==
      ~
    a.k
  $(ks t.ks, p (add-props p as &))
::  +add-props: attributes into a map, only the kept ones when `kp`
++  add-props
  |=  [p=(map @t tape) as=(list attr) kp=?]
  ^-  (map @t tape)
  ?~  as  p
  ?:  &(kp !(~(has in keep) n.i.as))  $(as t.as)
  $(as t.as, p (~(put by p) n.i.as v.i.as))
++  styles-of
  |=  [ks=(list node) sh=sheet]
  ^-  sheet
  ?~  ks  sh
  =*  k  i.ks
  ?.  ?=(%e -.k)  $(ks t.ks)
  ?:  =('style:style' n.k)
    =/  nm  (ga 'style:name' a.k)
    =/  fm  (ga 'style:family' a.k)
    ?:  |(?=(~ nm) ?=(~ fm))  $(ks t.ks)
    =/  s=sty  [(bind (ga 'style:parent-style-name' a.k) crip) (props-of k.k)]
    $(ks t.ks, styles.sh (~(put by styles.sh) [(crip u.fm) (crip u.nm)] s))
  ?:  =('style:default-style' n.k)
    =/  fm  (ga 'style:family' a.k)
    ?~  fm  $(ks t.ks)
    $(ks t.ks, defaults.sh (~(put by defaults.sh) (crip u.fm) (props-of k.k)))
  ?:  =('text:list-style' n.k)
    =/  nm  (ga 'style:name' a.k)
    ?~  nm  $(ks t.ks)
    $(ks t.ks, lists.sh (~(put by lists.sh) (crip u.nm) (levels k.k)))
  ?:  =('style:page-layout' n.k)
    =/  nm  (ga 'style:name' a.k)
    ?~  nm  $(ks t.ks)
    =/  pp  (kid 'style:page-layout-properties' k.k)
    ?~  pp  $(ks t.ks)
    ?>  ?=(%e -.u.pp)
    =/  m=(map @t tape)  (add-props ~ a.u.pp |)
    $(ks t.ks, layouts.sh (~(put by layouts.sh) (crip u.nm) m))
  $(ks t.ks)
::  +levels: list level to numbered (&) or bulleted (|)
++  levels
  |=  ks=(list node)
  ^-  (map @ud ?)
  =|  m=(map @ud ?)
  |-  ^-  (map @ud ?)
  ?~  ks  m
  =*  k  i.ks
  ?.  ?=(%e -.k)  $(ks t.ks)
  =/  lv  (biff (ga 'text:level' a.k) |=(v=tape (rush (crip v) dem)))
  ?~  lv  $(ks t.ks)
  $(ks t.ks, m (~(put by m) u.lv =('text:list-level-style-number' n.k)))
::  +resolve: a style's properties, through its parents (at most 16) and
::  its family's default style; the nearer one wins. Also whether
::  Quotations is in the chain.
++  resolve
  |=  [sh=sheet fam=@t nm=(unit @t)]
  ^-  [(map @t tape) ?]
  =|  chain=(list (map @t tape))
  =/  quo=?  |
  =|  n=@ud
  |-  ^-  [(map @t tape) ?]
  =/  s=(unit sty)  ?~(nm ~ (~(get by styles.sh) [fam u.nm]))
  ?:  |(?=(~ s) (gte n 16))
    =/  acc=(map @t tape)  (~(gut by defaults.sh) fam ~)
    :_  quo
    |-  ^-  (map @t tape)
    ?~  chain  acc
    $(chain t.chain, acc (~(uni by acc) i.chain))
  %=  $
    nm     par.u.s
    chain  [pro.u.s chain]
    quo    |(quo =(nm `'Quotations'))
    n      +(n)
  ==
++  build-cache
  |=  sh=sheet
  ^-  cache
  =/  pd=pstyle  (mk-pstyle sh ~)
  =/  [pm=(map @t pstyle) tm=(map @t tstyle)]
    %-  ~(rep by styles.sh)
    |=  [[[fm=@t nm=@t] s=sty] pm=(map @t pstyle) tm=(map @t tstyle)]
    ?:  =('paragraph' fm)  [(~(put by pm) nm (mk-pstyle sh `nm)) tm]
    ?:  =('text' fm)  [pm (~(put by tm) nm (mk-tstyle sh nm))]
    [pm tm]
  [pm pd tm lists.sh]
++  mk-pstyle
  |=  [sh=sheet nm=(unit @t)]
  ^-  pstyle
  =/  [p=(map @t tape) q=?]  (resolve sh 'paragraph' nm)
  :+  (css-of p fonts.sh &)
    q
  =((~(get by p) 'fo:break-before') `"page")
++  mk-tstyle
  |=  [sh=sheet nm=@t]
  ^-  tstyle
  =/  p=(map @t tape)  -:(resolve sh 'text' `nm)
  =/  w  (~(get by p) 'fo:font-weight')
  =/  i  (~(get by p) 'fo:font-style')
  =/  u  (~(get by p) 'style:text-underline-style')
  =/  s  (~(get by p) 'style:text-line-through-style')
  :*  ?=(^ (biff w weight))
      ?&(?=(^ i) |(=("italic" u.i) =("oblique" u.i)))
      ?&(?=(^ u) !=("none" u.u))
      ?&(?=(^ s) !=("none" u.s))
      (css-of p fonts.sh |)
  ==
::
::  CSS from parsed values only
::
::  +num: an optional -, digits, an optional . and digits. The number
::  rebuilt from its digits, and what follows it.
++  num
  |=  [v=tape neg=?]
  ^-  (unit [tape tape])
  ?:  (gth (lent v) 24)  ~
  =/  sg=?  ?=([%'-' *] v)
  ?:  &(sg !neg)  ~
  =/  w=tape  ?:(sg (sl 1 v) v)
  =/  [ip=tape r=tape]  (digits w)
  ?~  ip  ~
  ?.  ?=([%'.' *] r)  `[(weld `tape`?:(sg "-" "") ip) r]
  =/  [fp=tape r2=tape]  (digits t.r)
  ?~  fp  ~
  `[:(weld `tape`?:(sg "-" "") ip "." fp) r2]
++  digits
  |=  s=tape
  ^-  [tape tape]
  =|  acc=tape
  |-  ^-  [tape tape]
  ?~  s  [(flop acc) ~]
  ?.  &((gte i.s '0') (lte i.s '9'))  [(flop acc) s]
  $(s t.s, acc [i.s acc])
::  +len: a length (cm mm in pt pc px), or a percent when `pct`
++  len
  |=  [v=tape pct=? neg=?]
  ^-  (unit tape)
  =/  n  (num v neg)
  ?~  n  ~
  =/  u=(unit tape)
    =*  r  +.u.n
    ?:  =("cm" r)  `"cm"
    ?:  =("mm" r)  `"mm"
    ?:  =("in" r)  `"in"
    ?:  =("pt" r)  `"pt"
    ?:  =("pc" r)  `"pc"
    ?:  =("px" r)  `"px"
    ?:  &(pct =("%" r))  `"%"
    ~
  ?~  u  ~
  `(weld -.u.n u.u)
++  colour
  |=  v=tape
  ^-  (unit tape)
  ?.  &(=(7 (lent v)) ?=([%'#' *] v))  ~
  =/  h=tape  (cass t.v)
  ?.  (levy h |=(c=@ |(&((gte c '0') (lte c '9')) &((gte c 'a') (lte c 'f')))))
    ~
  `['#' h]
++  weight
  |=  v=tape
  ^-  (unit tape)
  ?:  =("bold" v)  `"bold"
  ?:  =("600" v)  `"600"
  ?:  =("700" v)  `"700"
  ?:  =("800" v)  `"800"
  ?:  =("900" v)  `"900"
  ~
++  generic
  |=  v=tape
  ^-  (unit tape)
  ?:  =("roman" v)  `"serif"
  ?:  =("swiss" v)  `"sans-serif"
  ?:  =("modern" v)  `"monospace"
  ?:  =("decorative" v)  `"fantasy"
  ?:  =("script" v)  `"cursive"
  ~
::  +fam-css: a font family list for one font name and its generic. The
::  name is the first in a list, unquoted, and must be letters, digits,
::  spaces and hyphens. LibreOffice's Liberation defaults get their usual
::  stand-ins.
++  fam-css
  |=  [v=tape gen=(unit tape)]
  ^-  (unit tape)
  =/  nm=tape
    =/  c  (find "," v)
    =/  f=tape  (trim ?~(c v (sc u.c v)))
    =?  f  ?=([?(%'\'' %'"') *] f)  (sl 1 f)
    =?  f  ?&(?=(^ f) |(=('\'' (rear f)) =('"' (rear f))))  (sc (dec (lent f)) f)
    f
  =/  ok=?
    ?&  ?=(^ nm)
        (lte (lent nm) 64)
        %+  levy  `tape`nm
        |=  c=@
        ?|  &((gte c 'a') (lte c 'z'))  &((gte c 'A') (lte c 'Z'))
            &((gte c '0') (lte c '9'))  =(' ' c)  =('-' c)
        ==
    ==
  ?.  ok  gen
  ?:  =("Liberation Serif" nm)
    `"'Liberation Serif','Times New Roman',Times,serif"
  ?:  =("Liberation Sans" nm)
    `"'Liberation Sans',Arial,Helvetica,sans-serif"
  ?:  =("Liberation Mono" nm)
    `"'Liberation Mono','Courier New',monospace"
  `:(weld "'" nm "'" `tape`?~(gen "" [',' u.gen]))
::  +css-of: resolved properties as CSS declarations. `all` also writes
::  weight, slant and decoration (a paragraph); a span carries those as
::  strong, em, u and s.
++  css-of
  |=  [p=(map @t tape) fo=(map @t tape) all=?]
  ^-  tape
  =|  o=(list tape)
  =/  g  |=(k=@t (~(get by p) k))
  =/  put
    |=  [o=(list tape) k=tape v=(unit tape)]
    ^-  (list tape)
    ?~(v o [:(weld k ":" u.v) o])
  =.  o  (put o "font-size" (biff (g 'fo:font-size') |=(v=tape (len v & |))))
  =.  o
    %^  put  o  "font-family"
    =/  fn  (g 'style:font-name')
    ?~  fn  (biff (g 'fo:font-family') |=(v=tape (fam-css v ~)))
    =/  hit  (~(get by fo) (crip u.fn))
    ?^(hit hit (fam-css u.fn ~))
  =?  o  all
    (put o "font-weight" (biff (g 'fo:font-weight') |=(v=tape ?:(=("normal" v) `"normal" (weight v)))))
  =?  o  all
    %^  put  o  "font-style"
    %+  biff  (g 'fo:font-style')
    |=  v=tape
    ?:  =("italic" v)  `"italic"
    ?:  =("oblique" v)  `"oblique"
    ?:  =("normal" v)  `"normal"
    ~
  =.  o  (put o "color" (biff (g 'fo:color') colour))
  =.  o
    %^  put  o  "background-color"
    (biff (g 'fo:background-color') |=(v=tape ?:(=("transparent" v) `"transparent" (colour v))))
  =.  o  (put o "margin-top" (biff (g 'fo:margin-top') |=(v=tape (len v & &))))
  =.  o  (put o "margin-bottom" (biff (g 'fo:margin-bottom') |=(v=tape (len v & &))))
  =.  o  (put o "margin-left" (biff (g 'fo:margin-left') |=(v=tape (len v & &))))
  =.  o  (put o "margin-right" (biff (g 'fo:margin-right') |=(v=tape (len v & &))))
  =.  o  (put o "text-indent" (biff (g 'fo:text-indent') |=(v=tape (len v & &))))
  =.  o
    %^  put  o  "line-height"
    (biff (g 'fo:line-height') |=(v=tape ?:(=("normal" v) `"normal" (len v & |))))
  =.  o
    %^  put  o  "text-align"
    %+  biff  (g 'fo:text-align')
    |=  v=tape
    ?:  |(=("start" v) =("left" v))  `"left"
    ?:  |(=("end" v) =("right" v))  `"right"
    ?:  =("center" v)  `"center"
    ?:  =("justify" v)  `"justify"
    ~
  =?  o  all
    =/  ul=?  =+(u=(g 'style:text-underline-style') &(?=(^ u) !=("none" u.u)))
    =/  lt=?  =+(s=(g 'style:text-line-through-style') &(?=(^ s) !=("none" u.s)))
    %^  put  o  "text-decoration"
    ?:  &(ul lt)  `"underline line-through"
    ?:  ul  `"underline"
    ?:  lt  `"line-through"
    ~
  =.  o
    %^  put  o  "text-transform"
    %+  biff  (g 'fo:text-transform')
    |=  v=tape
    ?:  =("uppercase" v)  `"uppercase"
    ?:  =("lowercase" v)  `"lowercase"
    ?:  =("capitalize" v)  `"capitalize"
    ?:  =("none" v)  `"none"
    ~
  =.  o
    %^  put  o  "font-variant"
    %+  biff  (g 'fo:font-variant')
    |=  v=tape
    ?:  =("small-caps" v)  `"small-caps"
    ?:  =("normal" v)  `"normal"
    ~
  =.  o
    %^  put  o  "letter-spacing"
    (biff (g 'fo:letter-spacing') |=(v=tape ?:(=("normal" v) `"normal" (len v | &))))
  (join ";" (flop o))
::  +page-open: the sheet, its width and margins from the first master
::  page's layout. overflow:auto clips the sheet: the grammar allows
::  negative margins and indents and any font size, and without the clip
::  a peer's page could lay text over lattice's own chrome.
++  page-open
  |=  sh=sheet
  ^-  tape
  =/  lay=(map @t tape)  ?~(master.sh ~ (~(gut by layouts.sh) u.master.sh ~))
  =/  l  |=(k=@t (biff (~(get by lay) k) |=(v=tape (len v | |))))
  =/  w  (l 'fo:page-width')
  =/  m  |=(k=@t (fall (l k) "0"))
  ;:  weld
    "<div class=\"fodt\" style=\"box-sizing:border-box;white-space:pre-wrap;"
    "overflow-wrap:break-word;overflow:auto;"
    `tape`?~(w "" :(weld "max-width:" u.w ";"))
    "padding:"  (m 'fo:margin-top')  " "  (m 'fo:margin-right')  " "
    (m 'fo:margin-bottom')  " "  (m 'fo:margin-left')
    "\">"
  ==
::
::  +fodt-html: the document as safe HTML, or the note when it is refused
++  fodt-html
  |=  f=@t
  ^-  tape
  ?:  (gth (met 3 f) max-size)  note-html
  =/  r  (mule |.((html-raw f)))
  ?:(?=(%& -.r) p.r note-html)
++  html-raw
  |=  f=@t
  ^-  tape
  (html-of (doc-of f))
::  +html-of: +fodt-html of a parsed document
++  html-of
  |=  d=(unit node)
  ^-  tape
  ?~  d  note-html
  ?>  ?=(%e -.u.d)
  =/  sh=sheet  (collect k.u.d)
  =/  b  (office-text k.u.d)
  ?~  b  note-html
  ?>  ?=(%e -.u.b)
  =/  out=(list tape)  ~[(page-open sh)]
  =.  out  (~(blocks rd (build-cache sh)) k.u.b [~ 0] out)
  (zing (flop ["</div>" out]))
::
::  +rd: the renderer, over the resolved styles. Output is a list of
::  chunks, newest first.
++  rd
  |_  c=cache
  +$  lst  [nm=(unit @t) lv=@ud]
  ++  pst
    |=  as=(list attr)
    ^-  pstyle
    =/  s  (ga 'text:style-name' as)
    ?~  s  pd.c
    (~(gut by pm.c) (crip u.s) pd.c)
  ++  tag
    |=  [t=tape css=tape]
    ^-  tape
    ?~  css  :(weld "<" t ">")
    :(weld "<" t " style=\"" (esc css) "\">")
  ++  blocks
    |=  [ks=(list node) l=lst out=(list tape)]
    ^-  (list tape)
    ?~  ks  out
    $(ks t.ks, out (block i.ks l out))
  ++  block
    |=  [k=node l=lst out=(list tape)]
    ^-  (list tape)
    ?:  ?=(%t -.k)  out
    =*  n  n.k
    ?:  (skip-block n)  out
    ?:  =('text:p' n)  (para k out)
    ?:  =('text:h' n)  (head k out)
    ?:  =('text:list' n)  (list-el k l out)
    ?:  =('table:table' n)  (table k out)
    ?:  =('text:section' n)  ["</div>" (blocks k.k l ["<div class=\"fodt-sec\">" out])]
    ?:  (index-el n)  (opaque (index-kids k) out)
    (opaque k.k out)
  ++  para
    |=  [k=node out=(list tape)]
    ^-  (list tape)
    ?>  ?=(%e -.k)
    =/  ps=pstyle  (pst a.k)
    =?  out  brk.ps  ["<hr class=\"fodt-pb\">" out]
    =/  t=tape  ?:(quote.ps "blockquote" "p")
    =.  out  [(tag t css.ps) out]
    =/  o2  (inlines k.k out)
    =?  o2  =(o2 out)  ["<br>" o2]
    [:(weld "</" t ">") o2]
  ++  head
    |=  [k=node out=(list tape)]
    ^-  (list tape)
    ?>  ?=(%e -.k)
    =/  lv=@ud
      =/  v  (biff (ga 'text:outline-level' a.k) |=(v=tape (rush (crip v) dem)))
      ?~(v 1 (max 1 (min 6 u.v)))
    =/  t=tape  ['h' (a-co:co lv)]
    =/  ps=pstyle  (pst a.k)
    =?  out  brk.ps  ["<hr class=\"fodt-pb\">" out]
    =.  out  [(tag t css.ps) out]
    [:(weld "</" t ">") (inlines k.k out)]
  ++  list-el
    |=  [k=node l=lst out=(list tape)]
    ^-  (list tape)
    ?>  ?=(%e -.k)
    =/  nm=(unit @t)
      =/  s  (ga 'text:style-name' a.k)
      ?~(s nm.l `(crip u.s))
    =/  lv=@ud  +(lv.l)
    =/  ol=?  ?~(nm | (~(gut by (~(gut by lists.c) u.nm ~)) (min lv 10) |))
    =/  t=tape  ?:(ol "ol" "ul")
    =.  out  [:(weld "<" t ">") out]
    =.  out  (items k.k [nm lv] out)
    [:(weld "</" t ">") out]
  ++  items
    |=  [ks=(list node) l=lst out=(list tape)]
    ^-  (list tape)
    ?~  ks  out
    =*  k  i.ks
    ?.  ?=(%e -.k)  $(ks t.ks)
    ?:  =('text:list-item' n.k)
      $(ks t.ks, out ["</li>" (blocks k.k l ["<li>" out])])
    ?:  =('text:list-header' n.k)
      $(ks t.ks, out ["</li>" (blocks k.k l ["<li style=\"list-style:none\">" out])])
    $(ks t.ks)
  ++  table
    |=  [k=node out=(list tape)]
    ^-  (list tape)
    ?>  ?=(%e -.k)
    =/  hd=(list node)
      =/  h  (kid 'table:table-header-rows' k.k)
      ?~(h ~ ?:(?=(%e -.u.h) k.u.h ~))
    =.  out  ["<table class=\"fodt-t\" style=\"border-collapse:collapse\">" out]
    =?  out  ?=(^ hd)  ["</thead>" (rows hd & ["<thead>" out])]
    =.  out  ["</tbody>" (rows (body-rows k.k) | ["<tbody>" out])]
    ["</table>" out]
  ::  +body-rows: the rows outside the header, through row groups
  ++  body-rows
    |=  ks=(list node)
    ^-  (list node)
    ?~  ks  ~
    =*  k  i.ks
    ?.  ?=(%e -.k)  $(ks t.ks)
    ?:  =('table:table-row' n.k)  [k $(ks t.ks)]
    ?:  |(=('table:table-rows' n.k) =('table:table-row-group' n.k))
      (weld (body-rows k.k) $(ks t.ks))
    $(ks t.ks)
  ++  rows
    |=  [ks=(list node) th=? out=(list tape)]
    ^-  (list tape)
    ?~  ks  out
    =*  k  i.ks
    ?.  &(?=(%e -.k) =('table:table-row' n.k))  $(ks t.ks)
    $(ks t.ks, out ["</tr>" (cells k.k th ["<tr>" out])])
  ++  cells
    |=  [ks=(list node) th=? out=(list tape)]
    ^-  (list tape)
    ?~  ks  out
    =*  k  i.ks
    ?.  &(?=(%e -.k) =('table:table-cell' n.k))  $(ks t.ks)
    =/  t=tape  ?:(th "th" "td")
    =/  sp
      |=  [n=@t h=tape]
      ^-  tape
      =/  v  (biff (ga n a.k) |=(v=tape (rush (crip v) dem)))
      ?~  v  ""
      ?:  (lte u.v 1)  ""
      :(weld " " h "=\"" (a-co:co (min u.v 1.000)) "\"")
    =.  out
      :_  out
      ;:  weld
        "<"  t
        (sp 'table:number-columns-spanned' "colspan")
        (sp 'table:number-rows-spanned' "rowspan")
        " style=\"border:1px solid #999;padding:2px 6px;vertical-align:top\">"
      ==
    $(ks t.ks, out [:(weld "</" t ">") (blocks k.k [~ 0] out)])
  ::  +opaque: a block lattice does not render, as its text in a muted
  ::  box, or nothing when it has none
  ++  opaque
    |=  [ks=(list node) out=(list tape)]
    ^-  (list tape)
    =/  ls=(list tape)
      %+  skip  (flop (lines ks ~))
      |=(t=tape =(~ (trim t)))
    ?~  ls  out
    =.  out  ["<div class=\"fodt-op\" style=\"color:#666;border:1px dashed #bbb;padding:4px 8px;margin:4px 0\">" out]
    =.  out
      =/  l=(list tape)  ls
      |-  ^-  (list tape)
      ?~  l  out
      =.  out  [(esc i.l) out]
      ?~  t.l  out
      $(l t.l, out ["<br>" out])
    ["</div>" out]
  ++  inlines
    |=  [ks=(list node) out=(list tape)]
    ^-  (list tape)
    ?~  ks  out
    $(ks t.ks, out (inline i.ks out))
  ++  inline
    |=  [k=node out=(list tape)]
    ^-  (list tape)
    ?:  ?=(%t -.k)  [(esn t.k) out]
    =*  n  n.k
    ?:  (skip-inline n)  out
    ?:  =('text:span' n)  (span k out)
    ?:  =('text:a' n)  (link k out)
    ?:  =('text:s' n)  [(reap (count a.k) ' ') out]
    ?:  =('text:tab' n)  [~[`@tD`9] out]
    ?:  =('text:line-break' n)  ["<br>" out]
    ?:  =('text:note' n)
      ["</sup>" (inlines (cite-kids k) ["<sup class=\"fodt-fn\">" out])]
    (inlines k.k out)
  ++  span
    |=  [k=node out=(list tape)]
    ^-  (list tape)
    ?>  ?=(%e -.k)
    =/  s  (ga 'text:style-name' a.k)
    =/  ts=(unit tstyle)  ?~(s ~ (~(get by tm.c) (crip u.s)))
    ?~  ts  (inlines k.k out)
    =/  op=(list [tape tape])
      ;:  weld
        ?:(b.u.ts ~[["<strong>" "</strong>"]] ~)
        ?:(i.u.ts ~[["<em>" "</em>"]] ~)
        ?:(u.u.ts ~[["<u>" "</u>"]] ~)
        ?:(s.u.ts ~[["<s>" "</s>"]] ~)
        ?~(css.u.ts ~ ~[[(tag "span" css.u.ts) "</span>"]])
      ==
    =.  out  |-(?~(op out $(op t.op, out [-.i.op out])))
    =.  out  (inlines k.k out)
    =/  cl  (flop op)
    |-(?~(cl out $(cl t.cl, out [+.i.cl out])))
  ++  link
    |=  [k=node out=(list tape)]
    ^-  (list tape)
    ?>  ?=(%e -.k)
    =/  h=tape  (fall (ga 'xlink:href' a.k) "")
    ?.  &(?=(^ h) (safe-url:gfm h))  (inlines k.k out)
    =/  ext=?  !=('#' i.h)
    =.  out
      :_  out
      ;:  weld
        "<a href=\""  (esc h)  "\""
        `tape`?:(ext " target=\"_blank\" rel=\"noopener noreferrer\"" "")
        ">"
      ==
    ["</a>" (inlines k.k out)]
  --
--
