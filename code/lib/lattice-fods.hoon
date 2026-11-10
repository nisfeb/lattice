::  /lib/lattice-fods: flat ODS (a .fods page body) on the ship.
::
::  A spreadsheet page holds LibreOffice Calc's flat XML. +fods-text is
::  its words for search, +fods-title the page title, and +fods-html
::  each sheet as a safe HTML table for the reader, the preview and the
::  published views. The XML is read by /lib/lattice-fodt's scanner
::  (+scan, +tree), so the same refusals hold: no DTD, no entity
::  declaration, at most 2 MB, at most 256 deep, and every entry point
::  runs under +mule, so a hostile document gives the note, never a
::  crash.
::
::  No formula is evaluated. A cell shows the text Calc cached in its
::  text:p children, and table:formula is never read.
::
::  The HTML is built, never copied. The tags are div, h3, table, tbody,
::  tr, td, p and br, the only attributes are colspan, rowspan and two
::  fixed strings, and every sheet name and cell text is escaped.
::
::  REPEATS. Calc writes runs: table:number-rows-repeated can be 1048576
::  and table:number-columns-repeated 16384, and a sheet is padded with
::  empty runs to those sizes. A run is never expanded past what is
::  shown. A row element is rendered once and its tape reused, a sheet
::  shows at most +max-rows rows and +max-cols columns, a document
::  +max-sheets sheets, and the whole output is at most +max-out bytes
::  of rows. Empty rows and columns after the last cell with text are
::  not shown at all. What is cut is counted in a note.
::
::  Not shown: hidden sheets, rows and columns, covered cells, comments,
::  drawings, charts, macros and settings. Search reads hidden sheets
::  too: it is the owner's.
::
/<  lf  /lib/lattice-fodt.hoon
|%
+$  node  node:lf
+$  attr  attr:lf
::  a cell: covered by a merge, or its escaped text, whether it holds a
::  number, and its spans
+$  cell  $%([%cov ~] [%td html=tape num=? cs=@ud rs=@ud])
::  `n` cells alike, and `n` rows alike. `used` is one past the row's
::  last column with text, 0 when it has none.
+$  run  [n=@ud c=cell]
+$  row  [n=@ud used=@ud hid=? cells=(list run)]
++  max-size    max-size:lf
++  max-rows    500
++  max-cols    50
++  max-sheets  20
++  max-out     ^~((mul 2 (bex 20)))
::  a repeat or span count is read up to this, more than any sheet has
++  max-rep     ^~((bex 28))
++  note-html  "<p class=\"fods-note\">page too large or not previewable</p>"
::  +html-pres: how every +fods-html output starts, the sheets or the
::  note, as +html-pres:lf is for a Writer document
++  html-pres  `(list @t)`~['<div class="fods">' '<p class="fods-note">']
++  note
  |=  t=tape
  ^-  tape
  :(weld "<p class=\"fods-note\">" t "</p>")
::
::  +rep: a count attribute, 1 when absent, zero or not a number
++  rep
  |=  [n=@t as=(list attr)]
  ^-  @ud
  =/  v  (ga:lf n as)
  ?~  v  1
  ?:  (gth (lent u.v) 12)  max-rep
  =/  r  (rush (crip u.v) dem)
  ?~  r  1
  ?:  =(0 u.r)  1
  (min u.r max-rep)
::  +hidden: a row or a column Calc hides or filters out
++  hidden
  |=  as=(list attr)
  ^-  ?
  =/  v  (ga:lf 'table:visibility' as)
  ?~  v  |
  |(=("collapse" u.v) =("filter" u.v))
::  +numeric: a cell whose value is a number, shown right-aligned
++  numeric
  |=  as=(list attr)
  ^-  ?
  =/  v  (ga:lf 'office:value-type' as)
  ?~  v  |
  ?|  =("float" u.v)  =("percentage" u.v)  =("currency" u.v)
      =("date" u.v)  =("time" u.v)
  ==
++  row-groups
  ^~  ^-  (set @t)
  (silt `(list @t)`~['table:table-header-rows' 'table:table-rows' 'table:table-row-group'])
++  col-groups
  ^~  ^-  (set @t)
  %-  silt
  ^-  (list @t)
  :~  'table:table-header-columns'  'table:table-columns'
      'table:table-column-group'
  ==
::
::  +sheets-of: the table:table elements of office:body >
::  office:spreadsheet, ~ when the document is not a spreadsheet
++  sheets-of
  |=  d=(unit node)
  ^-  (unit (list node))
  ?~  d  ~
  ?.  ?=(%e -.u.d)  ~
  =/  b  (kid:lf 'office:body' k.u.d)
  ?~  b  ~
  ?.  ?=(%e -.u.b)  ~
  =/  s  (kid:lf 'office:spreadsheet' k.u.b)
  ?~  s  ~
  ?.  ?=(%e -.u.s)  ~
  :-  ~
  %+  skim  `(list node)`k.u.s
  |=(k=node &(?=(%e -.k) =('table:table' n.k)))
::  +sheet-name: a sheet's table:name
++  sheet-name
  |=  k=node
  ^-  tape
  ?.  ?=(%e -.k)  ~
  (fall (ga:lf 'table:name' a.k) ~)
::
::  +cell-text: a cell's cached text: its own text:p children, one line
::  each. A comment (office:annotation) and a drawing have text:p of
::  their own, further down, and are not read.
++  cell-text
  |=  ks=(list node)
  ^-  tape
  =|  out=(list tape)
  |-  ^-  tape
  ?~  ks  (trim:lf (join:lf "\0a" (flop out)))
  =*  k  i.ks
  ?.  &(?=(%e -.k) =('text:p' n.k))  $(ks t.ks)
  $(ks t.ks, out [(zing (flop (itext:lf k.k ~))) out])
::  +esb: HTML escaping, with a line end as <br>
++  esb
  |=  t=tape
  ^-  tape
  =|  acc=tape
  |-  ^-  tape
  ?~  t  (flop acc)
  =*  c  i.t
  ?:  =(10 c)   $(t t.t, acc (weld ">rb<" acc))
  ?:  =('&' c)  $(t t.t, acc (weld ";pma&" acc))
  ?:  =('<' c)  $(t t.t, acc (weld ";tl&" acc))
  ?:  =('>' c)  $(t t.t, acc (weld ";tg&" acc))
  ?:  =('"' c)  $(t t.t, acc (weld ";touq&" acc))
  $(t t.t, acc [c acc])
::
::  +fods-text: the sheet names and the cells' text, one line per row
::  with tabs between its cells, for search. A run counts once.
++  fods-text
  |=  f=@t
  ^-  @t
  =/  r  (mule |.((text-of (doc-of:lf f))))
  ?:(?=(%& -.r) p.r '')
::  +fods-title: dc:title when set, else the first sheet's name
++  fods-title
  |=  f=@t
  ^-  (unit @t)
  =/  r  (mule |.((title-of (doc-of:lf f))))
  ?:(?=(%& -.r) p.r ~)
::  +fods-html: the sheets as safe HTML, or the note when refused
++  fods-html
  |=  f=@t
  ^-  tape
  ?:  (gth (met 3 f) max-size)  note-html
  =/  r  (mule |.((html-of (doc-of:lf f))))
  ?:(?=(%& -.r) p.r note-html)
::  +fods-all: the HTML, the text and the title from ONE parse, for the
::  ship's render cache, as +fodt-all:lf is
++  fods-all
  |=  f=@t
  ^-  [html=tape text=@t title=(unit @t)]
  ?:  (gth (met 3 f) max-size)  [note-html '' ~]
  =/  d  (mule |.((doc-of:lf f)))
  ?:  ?=(%| -.d)  [note-html '' ~]
  =/  h  (mule |.((html-of p.d)))
  =/  t  (mule |.((text-of p.d)))
  =/  l  (mule |.((title-of p.d)))
  :+  ?:(?=(%& -.h) p.h note-html)
    ?:(?=(%& -.t) p.t '')
  ?:(?=(%& -.l) p.l ~)
::
++  text-of
  |=  d=(unit node)
  ^-  @t
  =/  ss  (sheets-of d)
  ?~  ss  ''
  =/  ts=(list node)  u.ss
  =|  out=(list tape)
  |-  ^-  @t
  ?~  ts  (crip (join:lf "\0a" (flop out)))
  =*  k  i.ts
  ?.  ?=(%e -.k)  $(ts t.ts)
  =/  nm=tape  (sheet-name k)
  =?  out  ?=(^ nm)  [nm out]
  $(ts t.ts, out (row-lines k.k out))
::  +row-lines: a line for each row with text under `ks`, newest first
++  row-lines
  |=  [ks=(list node) out=(list tape)]
  ^-  (list tape)
  ?~  ks  out
  =*  k  i.ks
  ?.  ?=(%e -.k)  $(ks t.ks)
  ?:  (~(has in row-groups) n.k)  $(ks t.ks, out (row-lines k.k out))
  ?.  =('table:table-row' n.k)  $(ks t.ks)
  =/  l=tape  (row-line k.k)
  ?~  l  $(ks t.ks)
  $(ks t.ks, out [l out])
++  row-line
  |=  ks=(list node)
  ^-  tape
  =|  out=(list tape)
  |-  ^-  tape
  ?~  ks  (join:lf "\09" (flop out))
  =*  k  i.ks
  ?.  &(?=(%e -.k) =('table:table-cell' n.k))  $(ks t.ks)
  =/  t=tape  (cell-text k.k)
  ?~  t  $(ks t.ks)
  $(ks t.ks, out [t out])
::
++  title-of
  |=  d=(unit node)
  ^-  (unit @t)
  ?~  d  ~
  ?.  ?=(%e -.u.d)  ~
  =/  dt=tape
    =/  m  (kid:lf 'office:meta' k.u.d)
    ?~  m  ~
    ?.  ?=(%e -.u.m)  ~
    =/  t  (kid:lf 'dc:title' k.u.m)
    ?~  t  ~
    ?.  ?=(%e -.u.t)  ~
    (trim:lf (zing (flop (itext:lf k.u.t ~))))
  ?^  dt  `(crip dt)
  =/  ss  (sheets-of d)
  ?~  ss  ~
  ?~  u.ss  ~
  =/  nm=tape  (trim:lf (sheet-name i.u.ss))
  ?~(nm ~ `(crip nm))
::
::  +hid-tabs: the names of the table styles that hide their sheet
::  (table:display="false"), from office:document's children
++  hid-tabs
  |=  ks=(list node)
  ^-  (set @t)
  =|  hid=(set @t)
  |-  ^-  (set @t)
  ?~  ks  hid
  =*  k  i.ks
  ?.  ?&  ?=(%e -.k)
          |(=('office:automatic-styles' n.k) =('office:styles' n.k))
      ==
    $(ks t.ks)
  $(ks t.ks, hid (hid-styles k.k hid))
++  hid-styles
  |=  [ks=(list node) hid=(set @t)]
  ^-  (set @t)
  ?~  ks  hid
  =*  k  i.ks
  ?.  &(?=(%e -.k) =('style:style' n.k))  $(ks t.ks)
  ?.  =(`"table" (ga:lf 'style:family' a.k))  $(ks t.ks)
  =/  nm  (ga:lf 'style:name' a.k)
  ?~  nm  $(ks t.ks)
  =/  p  (kid:lf 'style:table-properties' k.k)
  ?~  p  $(ks t.ks)
  ?.  ?=(%e -.u.p)  $(ks t.ks)
  ?.  =(`"false" (ga:lf 'table:display' a.u.p))  $(ks t.ks)
  $(ks t.ks, hid (~(put in hid) (crip u.nm)))
++  tab-hidden
  |=  [k=node hid=(set @t)]
  ^-  ?
  ?.  ?=(%e -.k)  &
  =/  s  (ga:lf 'table:style-name' a.k)
  ?~  s  |
  (~(has in hid) (crip u.s))
::  +hid-cols: the hidden columns among the first +max-cols, from a
::  sheet's children
++  hid-cols
  |=  ks=(list node)
  ^-  (set @ud)
  hid:(hid-walk ks 0 ~)
++  hid-walk
  |=  [ks=(list node) col=@ud hid=(set @ud)]
  ^-  [col=@ud hid=(set @ud)]
  ?~  ks  [col hid]
  ?:  (gte col max-cols)  [col hid]
  =*  k  i.ks
  ?.  ?=(%e -.k)  $(ks t.ks)
  ?:  (~(has in col-groups) n.k)
    =/  r  (hid-walk k.k col hid)
    $(ks t.ks, col col.r, hid hid.r)
  ?.  =('table:table-column' n.k)  $(ks t.ks)
  =/  end=@ud  (min max-cols (add col (rep 'table:number-columns-repeated' a.k)))
  ?.  (hidden a.k)  $(ks t.ks, col end)
  $(ks t.ks, col end, hid (~(gas in hid) (gulf col (dec end))))
::
::  +rows-of: the rows under `ks` in document order, newest first,
::  through the row groups. Each is read once, whatever it repeats.
++  rows-of
  |=  [ks=(list node) out=(list row)]
  ^-  (list row)
  ?~  ks  out
  =*  k  i.ks
  ?.  ?=(%e -.k)  $(ks t.ks)
  ?:  =('table:table-row' n.k)  $(ks t.ks, out [(row-of a.k k.k) out])
  ?:  (~(has in row-groups) n.k)  $(ks t.ks, out (rows-of k.k out))
  $(ks t.ks)
::  +row-of: a row's runs of cells. Only the runs that start inside the
::  first +max-cols columns are kept; `used` counts them all.
++  row-of
  |=  [as=(list attr) ks=(list node)]
  ^-  row
  =|  [col=@ud used=@ud cells=(list run)]
  |-  ^-  row
  ?~  ks
    [(rep 'table:number-rows-repeated' as) used (hidden as) (flop cells)]
  =*  k  i.ks
  ?.  ?=(%e -.k)  $(ks t.ks)
  =/  cov=?  =('table:covered-table-cell' n.k)
  ?.  |(cov =('table:table-cell' n.k))  $(ks t.ks)
  =/  n=@ud  (rep 'table:number-columns-repeated' a.k)
  =/  end=@ud  (add col n)
  =/  keep=?  (lth col max-cols)
  ?:  cov
    $(ks t.ks, col end, cells ?.(keep cells [[n %cov ~] cells]))
  =/  t=tape  (cell-text k.k)
  =/  c=cell
    :*  %td  (esb t)  (numeric a.k)
        (rep 'table:number-columns-spanned' a.k)
        (rep 'table:number-rows-spanned' a.k)
    ==
  %=  $
    ks     t.ks
    col    end
    used   ?~(t used end)
    cells  ?.(keep cells [[n c] cells])
  ==
::  +extent: one past the last row with text, and one past the last
::  column with text. Sums of runs, nothing expanded.
++  extent
  |=  rs=(list row)
  ^-  [nr=@ud uc=@ud]
  =|  [pos=@ud nr=@ud uc=@ud]
  |-  ^-  [nr=@ud uc=@ud]
  ?~  rs  [nr uc]
  =/  end=@ud  (add pos n.i.rs)
  ?:  =(0 used.i.rs)  $(rs t.rs, pos end)
  $(rs t.rs, pos end, nr end, uc (max uc used.i.rs))
::
::  +td: a cell with `room` columns left in its row. A span is clamped
::  to what is shown.
++  td
  |=  [c=cell room=@ud]
  ^-  tape
  ?:  ?=(%cov -.c)  ~
  ;:  weld
    "<td"
    `tape`?.((gth cs.c 1) ~ :(weld " colspan=\"" (a-co:co (min cs.c room)) "\""))
    `tape`?.((gth rs.c 1) ~ :(weld " rowspan=\"" (a-co:co (min rs.c max-rows)) "\""))
    `tape`?.(num.c ~ " style=\"text-align:right\"")
    ">"
    html.c
    "</td>"
  ==
::  +row-html: a row as `w` columns: its cells, then empty ones. A
::  covered cell and a hidden column give nothing.
++  row-html
  |=  [cs=(list run) w=@ud hc=(set @ud)]
  ^-  tape
  =|  col=@ud
  =/  out=(list tape)  ~["<tr>"]
  |-  ^-  tape
  ?:  (gte col w)  (zing (flop ["</tr>" out]))
  ?~  cs
    $(col +(col), out ?:((~(has in hc) col) out ["<td></td>" out]))
  ?:  =(0 n.i.cs)  $(cs t.cs)
  =.  out
    ?:  (~(has in hc) col)  out
    [(td c.i.cs (sub w col)) out]
  $(col +(col), cs [i.cs(n (dec n.i.cs)) t.cs])
::
::  +html-of: +fods-html of a parsed document
++  html-of
  |=  d=(unit node)
  ^-  tape
  =/  ss  (sheets-of d)
  ?~  ss  note-html
  ?~  d  note-html
  ?.  ?=(%e -.u.d)  note-html
  =/  hid=(set @t)  (hid-tabs k.u.d)
  =/  all=(list node)  (skip `(list node)`u.ss |=(k=node (tab-hidden k hid)))
  =/  ts=(list node)  (scag max-sheets all)
  =/  more=@ud  (sub (lent all) (lent ts))
  =/  out=(list tape)  ~["<div class=\"fods\">"]
  =/  left=@ud  max-out
  |-  ^-  tape
  ?~  ts
    =?  out  (gth more 0)
      [(note (weld (a-co:co more) " more sheets not shown")) out]
    (zing (flop ["</div>" out]))
  =/  r  (sheet-html i.ts left out)
  $(ts t.ts, left left.r, out out.r)
::  +sheet-html: a sheet's name and its table onto `out` (newest
::  first), within `left` bytes of rows, and what is left of them
++  sheet-html
  |=  [k=node left=@ud out=(list tape)]
  ^-  [left=@ud out=(list tape)]
  ?.  ?=(%e -.k)  [left out]
  =.  out  [:(weld "<h3>" (esc:lf (sheet-name k)) "</h3>") out]
  =/  rs=(list row)  (skip (flop (rows-of k.k ~)) |=(r=row hid.r))
  =/  ex=[nr=@ud uc=@ud]  (extent rs)
  ?:  |(=(0 nr.ex) =(0 uc.ex))  [left [(note "empty sheet") out]]
  =/  w=@ud  (min uc.ex max-cols)
  =/  lim=@ud  (min nr.ex max-rows)
  =/  hc=(set @ud)  (hid-cols k.k)
  =.  out  ["<table><tbody>" out]
  =|  pos=@ud
  =/  full=?  |
  |-  ^-  [left=@ud out=(list tape)]
  =/  end=?  ?~(rs & |(full (gte pos lim)))
  ?:  end
    =.  out  ["</tbody></table>" out]
    =/  ns=(list tape)
      ;:  weld
        `(list tape)`?.(full ~ ~["output limit reached"])
        ^-  (list tape)
        ?.  (gth nr.ex pos)  ~
        ~[(weld (a-co:co (sub nr.ex pos)) " more rows not shown")]
        ^-  (list tape)
        ?.  (gth uc.ex w)  ~
        ~[(weld (a-co:co (sub uc.ex w)) " more columns not shown")]
      ==
    ?~  ns  [left out]
    [left [(note (join:lf ", " ns)) out]]
  ?~  rs  [left out]
  =/  t=tape  (row-html cells.i.rs w hc)
  =/  len=@ud  (lent t)
  =/  cnt=@ud  (min n.i.rs (sub lim pos))
  =/  can=@ud  (div left len)
  =?  full  (lth can cnt)  &
  =.  cnt  (min cnt can)
  %=  $
    rs    t.rs
    pos   (add pos cnt)
    left  (sub left (mul cnt len))
    out   (weld (reap cnt t) out)
  ==
--
