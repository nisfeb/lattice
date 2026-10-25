::  lattice-orrery: pure helpers for the orrery read side. Standalone.
::
|%
::  +brief-link-rewrite: [seg/seg] becomes [[seg/seg]]. A token with no
::  slash, an already doubled link and a markdown link [t](url) are kept.
++  brief-link-rewrite
  |=  t=tape
  ^-  tape
  ?~  t  ~
  ?.  =('[' i.t)  [i.t $(t t.t)]
  ?:  &(?=(^ t.t) =('[' i.t.t))
    ::  doubled link: copy through its first close bracket untouched
    =/  r=tape  t.t.t
    =/  e=(unit @ud)  (find "]" r)
    ?~  e  ['[' '[' $(t r)]
    :(weld "[[" (scag +(u.e) r) $(t (slag +(u.e) r)))
  =/  e=(unit @ud)  (find "]" t.t)
  ?~  e  ['[' $(t t.t)]
  =/  x=tape  (scag u.e t.t)
  =/  after=tape  (slag +(u.e) t.t)
  ?:  |(?=(~ (find "/" x)) ?=(^ (find "[" x)) ?=([%'(' *] after))
    ['[' $(t t.t)]
  :(weld "[[" x "]]" $(t after))
::  +journal-body: the journal page for a brief, links made wikilinks.
++  journal-body
  |=  [head=tape day=@t text=@t]
  ^-  @t
  %-  crip
  :(weld "# " head ", " (trip day) "\0a\0a" (brief-link-rewrite (trip text)))
::  +fresh-world: is orrery's at (YYYY-MM-DDTHH:MM:SSZ) within win of now.
::  Malformed is stale. A time after now (clock skew) is fresh.
++  fresh-world
  |=  [at=@t now=@da win=@dr]
  ^-  ?
  =/  p
    %+  rush  at
    ;~  plug
      ;~(sfix dem hep)
      ;~(sfix dem hep)
      dem
      ;~(pfix (just 'T') dem)
      ;~(pfix col dem)
      ;~(pfix col ;~(sfix dem (just 'Z')))
    ==
  ?~  p  |
  =/  [y=@ud mo=@ud d=@ud h=@ud mi=@ud s=@ud]  u.p
  ?.  &((gte mo 1) (lte mo 12) (gte d 1) (lte d 31) (gth y 0) (lth h 24) (lth mi 60) (lth s 60))  |
  =/  then=@da  (year [[& y] mo [d h mi s ~]])
  ?:  (gth then now)  &
  (lth (sub now then) win)
--
