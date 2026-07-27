::  lattice-know-view: HTML builders for the reader's private knowledge view
::  (/apps/lattice/know). Keys are path-like, so the view browses them as a
::  DIRECTORY TREE (like the /x explorer): folders first, entries at their own
::  level, breadcrumbs up top. ?tag= switches to a flat filtered list.
::
::  COMPILER RULE: never put a raw zing/turn product in weld position next to
::  tape literals (fuse-loop) — pre-bind every computed tape to a face first.
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
++  da-short
  |=  d=@da
  ^-  tape
  =/  t=tape  (scow %da d)
  =/  i=(unit @ud)  (find ".." t)
  ?~(i t (scag u.i t))
++  preview
  |=  t=tape
  ^-  tape
  =/  nl=(unit @ud)  (find "\0a" t)
  =/  one=tape  ?~(nl t (scag u.nl t))
  ?.  (gth (lent one) 90)  one
  (weld (scag 90 one) "&hellip;")
++  recent-know
  |=  [es=(map path know-entry:lk) n=@ud]
  ^-  (list (pair path know-entry:lk))
  %+  scag  n
  %+  sort  ~(tap by es)
  |=  [a=(pair path know-entry:lk) b=(pair path know-entry:lk)]
  (gth updated.q.a updated.q.b)
::  +know-quick-html: the home page's "Recent memories" qlist.
++  know-quick-html
  |=  [es=(map path know-entry:lk) n=@ud]
  ^-  tape
  =/  entries=(list (pair path know-entry:lk))  (recent-know es n)
  ?~  entries  "<p class=\"muted\">No memories yet.</p>"
  =/  items=tape  (ent-rows entries)
  :(weld "<ul class=\"qlist\">" items "</ul>")
::  +ent-rows: entry rows in house qlist style (key, tags+date+preview line).
++  ent-rows
  |=  entries=(list (pair path know-entry:lk))
  ^-  tape
  %-  zing
  %+  turn  entries
  |=  p=(pair path know-entry:lk)
  =/  href=tape  (spud p.p)
  =/  disp=tape  (esc (slag 1 (spud p.p)))
  =/  tl=tape
    %-  zing
    %+  turn  (sort ~(tap in tags.q.p) aor)
    |=(t=@t :(weld "#" (esc (trip t)) " "))
  =/  sep=tape  ?:(=("" tl) "" "&middot; ")
  =/  dt=tape  (da-short updated.q.p)
  =/  prev=tape  (esc (preview (trip body.q.p)))
  ;:  weld
    "<li><a href=\"/apps/lattice/know"  href  "\">"
    "<span class=\"qname\">"  disp  "</span>"
    "<span class=\"qprev\">"  tl  sep  dt  " &middot; "  prev  "</span>"
    "</a></li>"
  ==
::  +tag-chips: .quick pill row over the whole store's tag vocabulary.
++  tag-chips
  |=  [es=(map path know-entry:lk) sel=@t]
  ^-  tape
  =/  all-tags=(list @t)
    =|  acc=(set @t)
    =/  l=(list (pair path know-entry:lk))  ~(tap by es)
    |-  ^-  (list @t)
    ?~  l  (sort ~(tap in acc) aor)
    $(l t.l, acc (~(uni in acc) tags.q.i.l))
  =/  links=tape
    %-  zing
    %+  turn  all-tags
    |=  t=@t
    =/  on=tape  ?:(=(t sel) " class=\"on\"" "")
    =/  et=tape  (esc (trip t))
    ;:  weld
      "<a href=\"/apps/lattice/know?tag="  et  "\""  on  ">#"  et  "</a>"
    ==
  =/  all-on=tape  ?:(=('' sel) " class=\"on\"" "")
  ;:  weld
    "<div class=\"quick\"><a href=\"/apps/lattice/know\""  all-on  ">all</a>"
    links
    "</div>"
  ==
::  +kids-of: one level of the tree at `at` — child folders (with entry counts)
::  and the entries that live exactly at this level.
++  kids-of
  |=  [es=(map path know-entry:lk) at=path]
  ^-  [dirs=(list (pair @ta @ud)) ents=(list (pair path know-entry:lk))]
  =/  n=@ud  (lent at)
  =|  dm=(map @ta @ud)
  =|  ents=(list (pair path know-entry:lk))
  =/  l=(list (pair path know-entry:lk))  ~(tap by es)
  |-
  ?~  l
    :_  ents
    %+  sort  ~(tap by dm)
    |=([a=(pair @ta @ud) b=(pair @ta @ud)] (aor p.a p.b))
  =/  kp=path  p.i.l
  ?.  &((gth (lent kp) n) =(at (scag n kp)))
    $(l t.l)
  ?:  =((lent kp) +(n))
    $(l t.l, ents [i.l ents])
  =/  seg=@ta  (snag n kp)
  $(l t.l, dm (~(put by dm) seg +((~(gut by dm) seg 0))))
::  +crumb: breadcrumb "knowledge / feedback / furum", each level a link.
++  crumb
  |=  at=path
  ^-  tape
  =/  acc=tape  "<a href=\"/apps/lattice/know\">knowledge</a>"
  =/  base=tape  "/apps/lattice/know"
  =/  l=path  at
  |-  ^-  tape
  ?~  l  acc
  =/  seg=tape  (trip i.l)
  =/  nbase=tape  :(weld base "/" seg)
  =/  eseg=tape  (esc seg)
  =/  nacc=tape  :(weld acc " / <a href=\"" nbase "\">" eseg "</a>")
  $(l t.l, acc nacc, base nbase)
::  +know-dir-html: the directory view at `at` — the node's own entry (if one
::  lives at this exact key) above child folders, then child entries.
++  know-dir-html
  |=  [es=(map path know-entry:lk) at=path node=(unit know-entry:lk) chips=tape]
  ^-  tape
  =/  [dirs=(list (pair @ta @ud)) ents=(list (pair path know-entry:lk))]
    (kids-of es at)
  =/  sorted=(list (pair path know-entry:lk))
    %+  sort  ents
    |=  [a=(pair path know-entry:lk) b=(pair path know-entry:lk)]
    (gth updated.q.a updated.q.b)
  =/  bc=tape  ?~(at "" (crumb at))
  =/  bc-row=tape  ?:(=("" bc) "" :(weld "<p class=\"muted\">" bc "</p>"))
  =/  title=tape  ?~(at "Knowledge" (esc (trip (rear at))))
  =/  own=tape
    ?~  node  ""
    =/  upd=tape  (esc (scow %da updated.u.node))
    =/  body=tape  (esc (trip body.u.node))
    ;:  weld
      "<p class=\"muted\">updated "  upd  "</p>"
      "<pre class=\"know-body\">"  body  "</pre>"
    ==
  =/  dir-items=tape
    %-  zing
    %+  turn  dirs
    |=  d=(pair @ta @ud)
    =/  seg=tape  (trip p.d)
    =/  href=tape  :(weld "/apps/lattice/know" (spud at) "/" seg)
    =/  eseg=tape  (esc seg)
    =/  cnt=tape  (scow %ud q.d)
    ;:  weld
      "<li><a href=\""  href  "\">"
      "<span class=\"qname\">&#128193; "  eseg  "/</span>"
      "<span class=\"qprev\">"  cnt  " entries</span>"
      "</a></li>"
    ==
  =/  ent-items=tape  (ent-rows sorted)
  =/  listing=tape
    ?:  &(=("" dir-items) =("" ent-items))  ""
    :(weld "<ul class=\"qlist\">" dir-items ent-items "</ul>")
  ;:  weld
    bc-row
    "<h1>"  title  "</h1>"
    own
    chips
    listing
  ==
::  +know-flat-html: the flat ?tag= filtered list (all levels at once).
++  know-flat-html
  |=  [es=(map path know-entry:lk) sel=@t]
  ^-  tape
  =/  shown=(list (pair path know-entry:lk))
    =/  m=(list (pair path know-entry:lk))  ~(tap by es)
    |-  ^-  (list (pair path know-entry:lk))
    ?~  m  ~
    ?:  (~(has in tags.q.i.m) sel)
      [i.m $(m t.m)]
    $(m t.m)
  =/  sorted=(list (pair path know-entry:lk))
    %+  sort  shown
    |=  [a=(pair path know-entry:lk) b=(pair path know-entry:lk)]
    (gth updated.q.a updated.q.b)
  =/  chips=tape  (tag-chips es sel)
  =/  items=tape  (ent-rows sorted)
  =/  cnt=tape  (scow %ud (lent sorted))
  ;:  weld
    "<p class=\"muted\"><a href=\"/apps/lattice/know\">knowledge</a></p>"
    "<h1>#"  (esc (trip sel))  "</h1>"
    "<p class=\"muted\">"  cnt  " tagged</p>"
    chips
    "<ul class=\"qlist\">"  items  "</ul>"
  ==
::  +know-entry-html: a leaf entry page.
++  know-entry-html
  |=  [kp=path e=know-entry:lk]
  ^-  tape
  =/  chips=tape
    %-  zing
    %+  turn  (sort ~(tap in tags.e) aor)
    |=  t=@t
    =/  et=tape  (esc (trip t))
    ;:  weld
      "<a href=\"/apps/lattice/know?tag="  et  "\">#"  et  "</a>"
    ==
  =/  chip-row=tape  ?:(=("" chips) "" :(weld "<div class=\"quick\">" chips "</div>"))
  =/  bc=tape  (crumb (snip `path`kp))
  =/  title=tape  (esc (trip (rear kp)))
  =/  upd=tape  (esc (scow %da updated.e))
  =/  body=tape  (esc (trip body.e))
  ;:  weld
    "<p class=\"muted\">"  bc  "</p>"
    "<h1>"  title  "</h1>"
    "<p class=\"muted\">updated "  upd  "</p>"
    chip-row
    "<pre class=\"know-body\">"  body  "</pre>"
  ==
::  +know-node-html: dispatch for /know/<path> — entry page for a childless
::  key, directory view when children exist (own entry shown above), ~ = 404.
++  know-node-html
  |=  [es=(map path know-entry:lk) at=path]
  ^-  (unit tape)
  =/  e=(unit know-entry:lk)  (~(get by es) at)
  =/  [dirs=(list (pair @ta @ud)) ents=(list (pair path know-entry:lk))]
    (kids-of es at)
  ?:  &(?=(~ dirs) ?=(~ ents))
    ?~  e  ~
    `(know-entry-html at u.e)
  `(know-dir-html es at e "")
--
