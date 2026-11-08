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
::  +journal-fold: the new brief `new` folded into the owner's page `own`,
::  for a journal page the owner edited since the mirror last wrote it.
::  All of the owner's text stays. Only lines carrying a [T<n>] tag move:
::  an owner line whose tag is in `new` takes the brief's line, keeping
::  the owner's tick when the task reads the same, and a tag `new` has
::  that the page lacks goes in before the page's Notes heading (any
::  level, any case), or at its end. Untagged lines of the brief are not
::  added: they would repeat the brief already on the page. CRLF on
::  either side is read as LF.
++  journal-fold
  |=  [own=@t new=@t]
  ^-  @t
  =/  ol=(list tape)  (turn (lines-of (trip own)) un-cr)
  =/  nl=(list tape)  (turn (lines-of (trip new)) un-cr)
  =/  tagged=(list [tag=tape l=tape])
    (murn nl |=(l=tape (bind (tag-of l) |=(t=tape [t l]))))
  =/  by-tag=(map tape tape)
    %-  ~(gas by *(map tape tape))
    (flop tagged)
  =/  had=(set tape)  (silt (murn ol tag-of))
  =/  out=(list tape)
    %+  turn  ol
    |=  l=tape
    ^-  tape
    =/  tg=(unit tape)  (tag-of l)
    ?~  tg  l
    =/  nw=(unit tape)  (~(get by by-tag) u.tg)
    ?~  nw  l
    (keep-tick l u.nw)
  =/  more=(list tape)
    %+  murn  tagged
    |=([t=tape l=tape] ?:((~(has in had) t) ~ `l))
  =/  more=(list tape)
    ::  one line per tag, the first the brief gives
    =|  seen=(set tape)
    |-  ^-  (list tape)
    ?~  more  ~
    =/  t=(unit tape)  (tag-of i.more)
    ?:  &(?=(^ t) (~(has in seen) u.t))  $(more t.more)
    [i.more $(more t.more, seen ?~(t seen (~(put in seen) u.t)))]
  ?~  more  (crip (join-lines out))
  =/  at=(unit @ud)  (notes-at out)
  ?~  at  (crip (join-lines (weld out more)))
  (crip (join-lines :(weld (scag u.at out) more (slag u.at out))))
::  +keep-tick: the brief's line `nw` for the owner's `ol`, ticked when
::  the owner ticked the very same task (same tag, text and indent)
++  keep-tick
  |=  [ol=tape nw=tape]
  ^-  tape
  =/  at=(unit @ud)  (task-at ol)
  ?~  at  nw
  ?:  =(' ' (snag u.at ol))  nw
  =/  bt=(unit @ud)  (task-at nw)
  ?~  bt  nw
  ?.  =((snap ol u.at ' ') (snap nw u.bt ' '))  nw
  (snap nw u.bt 'x')
::  +tag-of: the first [T<n>] tag on a line, as "T<n>"
++  tag-of
  |=  l=tape
  ^-  (unit tape)
  ?~  l  ~
  ?.  ?=([%'[' %'T' *] l)  $(l t.l)
  =/  r=tape  t.t.l
  =|  d=tape
  |-  ^-  (unit tape)
  ?~  r  ~
  ?:  (is-dig i.r)  $(r t.r, d [i.r d])
  ?:  &(?=(^ d) =(']' i.r))  `['T' (flop d)]
  ^$(l t.l)
::  +notes-head: is the line a Notes heading: one to six #, blanks, then
::  "notes" in any case, trailing blanks allowed
++  notes-head
  |=  l=tape
  ^-  ?
  =/  t=tape  (trim-sp l)
  =/  h=@ud  0
  |-  ^-  ?
  ?:  &(?=(^ t) =('#' i.t))  $(t t.t, h +(h))
  ?.  &((gte h 1) (lte h 6))  |
  ?~  t  |
  ?.  (is-sp i.t)  |
  =("notes" (cass (flop (trim-sp (flop (trim-sp t))))))
::  +notes-at: the index of the first Notes heading, ~ when there is none
++  notes-at
  |=  ls=(list tape)
  ^-  (unit @ud)
  =/  i=@ud  0
  |-  ^-  (unit @ud)
  ?~  ls  ~
  ?:  (notes-head i.ls)  `i
  $(ls t.ls, i +(i))
::  +lines-of: split on newlines; "" is one empty line.
++  lines-of
  |=  t=tape
  ^-  (list tape)
  =|  cur=tape
  =|  acc=(list tape)
  |-  ^-  (list tape)
  ?~  t  (flop [(flop cur) acc])
  ?:  =('\0a' i.t)  $(t t.t, acc [(flop cur) acc], cur ~)
  $(t t.t, cur [i.t cur])
++  join-lines
  |=  ls=(list tape)
  ^-  tape
  ?~  ls  ~
  ?~  t.ls  i.ls
  :(weld i.ls "\0a" $(ls t.ls))
++  un-cr
  |=  l=tape
  ^-  tape
  ?:  &(?=(^ l) =('\0d' (rear l)))  (snip `tape`l)
  l
++  trim-sp
  |=  t=tape
  ^-  tape
  ?~  t  t
  ?:  |(=(' ' i.t) =('\09' i.t))  $(t t.t)
  t
++  is-sp  |=(c=@tD |(=(' ' c) =('\09' c)))
++  is-dig  |=(c=@tD &((gte c '0') (lte c '9')))
::  +task-at: the index of a task line's box character, the shape
::  59-md.js's TASK_RE takes: quote marks and blanks, a - * + or 1. 1)
::  marker, blanks, then [ ] [x] or [X] and a blank. ~ for no task.
++  task-at
  |=  l=tape
  ^-  (unit @ud)
  =/  n=@ud  (lent l)
  =/  i=@ud  0
  =.  i  |-(?:(&((lth i n) |((is-sp (snag i l)) =('>' (snag i l)))) $(i +(i)) i))
  ?:  (gte i n)  ~
  =/  c=@tD  (snag i l)
  =/  j=@ud
    ?:  |(=('-' c) =('*' c) =('+' c))  +(i)
    =/  k=@ud  i
    =.  k  |-(?:(&((lth k n) (is-dig (snag k l))) $(k +(k)) k))
    ?:  |(=(k i) (gte k n))  n
    ?.  |(=('.' (snag k l)) =(')' (snag k l)))  n
    +(k)
  ?.  &((lth j n) (is-sp (snag j l)))  ~
  =.  j  |-(?:(&((lth j n) (is-sp (snag j l))) $(j +(j)) j))
  ?.  (lth (add j 3) n)  ~
  ?.  &(=('[' (snag j l)) =(']' (snag (add j 2) l)) (is-sp (snag (add j 3) l)))  ~
  =/  m=@tD  (snag +(j) l)
  ?.  |(=(' ' m) =('x' m) =('X' m))  ~
  `+(j)
::  +has-tag: does the line carry a [T<n>] tag (orrery's +todo-tags)?
++  has-tag
  |=  l=tape
  ^-  ?
  ?~  l  |
  ?:  ?&  ?=([%'[' %'T' *] l)
          =/  r=tape  t.t.l
          =/  d=@ud  0
          |-  ^-  ?
          ?~  r  |
          ?:  (is-dig i.r)  $(r t.r, d +(d))
          &((gth d 0) =(']' i.r))
      ==
    &
  $(l t.l)
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
