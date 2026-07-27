::  lattice-know-view: HTML builders for the reader's private knowledge view
::  (/apps/lattice/know). A lib so changes compile-check via check_bin without
::  risking the nexus build.
::
::  COMPILER RULE (learned the hard way — three fuse-loops): never put a raw
::  zing/turn product in weld position next to tape literals; the literal's
::  constant-typed char chain mulled against the computed list type fuse-loops
::  the compiler. Pre-bind every such product to a `=/ x=tape` face (or route
::  it through a ^-tape-cast gate like +esc) BEFORE welding.
/<  lk  /lib/lattice-know.hoon
|%
++  esc
  |=  t=tape
  ^-  tape
  %-  zing
  %+  turn  t
  |=  c=@tD
  ?+  c  ~[c]
    %'&'  "&amp;"
    %'<'  "&lt;"
    %'>'  "&gt;"
    %'"'  "&quot;"
  ==
::  +da-short: ~2026.7.27..04.08.32..8c69 -> ~2026.7.27 (list-view dates).
++  da-short
  |=  d=@da
  ^-  tape
  =/  t=tape  (scow %da d)
  =/  i=(unit @ud)  (find ".." t)
  ?~(i t (scag u.i t))
::  +know-index-html: entry list, newest first, with tag-chip filtering.
++  know-index-html
  |=  [es=(map path know-entry:lk) tsel=(unit @t)]
  ^-  tape
  =/  sel=@t  (fall tsel '')
  =/  entries=(list (pair path know-entry:lk))
    %+  sort  ~(tap by es)
    |=  [a=(pair path know-entry:lk) b=(pair path know-entry:lk)]
    (gth updated.q.a updated.q.b)
  =/  all-tags=(list @t)
    =|  acc=(set @t)
    =/  l=(list (pair path know-entry:lk))  entries
    |-  ^-  (list @t)
    ?~  l  (sort ~(tap in acc) aor)
    $(l t.l, acc (~(uni in acc) tags.q.i.l))
  =/  shown=(list (pair path know-entry:lk))
    ?:  =('' sel)  entries
    =/  m=(list (pair path know-entry:lk))  entries
    |-  ^-  (list (pair path know-entry:lk))
    ?~  m  ~
    ?:  (~(has in tags.q.i.m) sel)
      [i.m $(m t.m)]
    $(m t.m)
  =/  tag-links=tape
    %-  zing
    %+  turn  all-tags
    |=  t=@t
    =/  on=tape  ?:(=(t sel) "on" "")
    =/  et=tape  (esc (trip t))
    ;:  weld
      "<a href=\"/apps/lattice/know?tag="  et  "\" class=\""  on
      "\">"  et  "</a>"
    ==
  =/  all-on=tape  ?:(=('' sel) "on" "")
  =/  chips=tape
    ;:  weld
      "<a href=\"/apps/lattice/know\" class=\""  all-on  "\">all</a>"
      tag-links
    ==
  =/  items=tape
    %-  zing
    %+  turn  shown
    |=  p=(pair path know-entry:lk)
    =/  href=tape  (spud p.p)
    =/  disp=tape  (esc (slag 1 (spud p.p)))
    =/  tl=tape
      %-  zing
      %+  turn  (sort ~(tap in tags.q.p) aor)
      |=(t=@t :(weld "#" (esc (trip t)) " "))
    =/  dt=tape  (da-short updated.q.p)
    ;:  weld
      "<li><a href=\"/apps/lattice/know"  href  "\">"  disp
      "</a><span class=\"kt\">"  tl  dt  "</span></li>"
    ==
  =/  cnt=tape  (scow %ud (lent shown))
  =/  what=tape  ?:(=('' sel) " entries" " tagged")
  ;:  weld
    "<section class=\"know\"><h1>knowledge</h1><p class=\"know-count\">"
    cnt  what
    "</p><nav class=\"know-chips\">"  chips  "</nav><ul class=\"know-list\">"
    items
    "</ul></section>"
  ==
::  +know-entry-html: one entry — key, updated, tag chips, escaped body.
++  know-entry-html
  |=  [kp=path e=know-entry:lk]
  ^-  tape
  =/  chips=tape
    %-  zing
    %+  turn  (sort ~(tap in tags.e) aor)
    |=  t=@t
    =/  et=tape  (esc (trip t))
    ;:  weld
      "<a href=\"/apps/lattice/know?tag="  et  "\">"  et  "</a>"
    ==
  =/  title=tape  (esc (slag 1 (spud kp)))
  =/  upd=tape  (esc (scow %da updated.e))
  =/  body=tape  (esc (trip body.e))
  ;:  weld
    "<section class=\"know\">"
    "<p><a href=\"/apps/lattice/know\">&#8592; knowledge</a></p>"
    "<h1>"  title  "</h1>"
    "<p class=\"know-meta\">updated "  upd  "</p>"
    "<nav class=\"know-chips\">"  chips  "</nav>"
    "<pre class=\"know-body\">"  body  "</pre>"
    "</section>"
  ==
--
