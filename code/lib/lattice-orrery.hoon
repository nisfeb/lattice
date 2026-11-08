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
::  +journal-merge: the re-mirrored page `new` keeps what the owner did to
::  the page `old`. A task line ticked in `old` that carries a [T<n>] tag
::  is ticked in `new` when `new` has the very same line unticked (same
::  tag, text and indent: a remade brief may give a tag to another task).
::  Lines from a `## Notes` heading to the end of `old` are carried after
::  `new` when `new` has no such heading. Other edits to the brief's own
::  lines are replaced by orrery's text. CRLF on either side is read as LF.
++  journal-merge
  |=  [old=@t new=@t]
  ^-  @t
  =/  ol=(list tape)  (turn (lines-of (trip old)) un-cr)
  =/  nl=(list tape)  (turn (lines-of (trip new)) un-cr)
  =/  ticked=(set tape)
    %-  silt
    %+  murn  ol
    |=  l=tape
    ^-  (unit tape)
    =/  at=(unit @ud)  (task-at l)
    ?~  at  ~
    ?:  |(=(' ' (snag u.at l)) !(has-tag l))  ~
    `(snap l u.at ' ')
  =/  merged=(list tape)
    %+  turn  nl
    |=  l=tape
    ^-  tape
    =/  at=(unit @ud)  (task-at l)
    ?~  at  l
    ?.  &(=(' ' (snag u.at l)) (~(has in ticked) l))  l
    (snap l u.at 'x')
  =/  notes=(list tape)  (notes-of ol)
  =?  merged  &(?=(^ notes) =(~ (notes-of nl)))
    (weld merged [*tape notes])
  (crip (join-lines merged))
::  +journal-fold: the page the pass writes for day `day` when `old` is
::  already at its name. The pass's own page starts with its title line
::  (# <head>, <day>, as +journal-body makes it): that one is remade by
::  +journal-merge. Any other page is the owner's, and none of its text
::  is replaced: the brief goes under a `## <head>, <day>` heading as a
::  quote block, appended when the page has no such heading, and only
::  that quote block is rewritten when it has one (ticks carried by
::  +journal-merge). The quote block ends at its first line without a
::  leading >, so whatever the owner wrote after it stays.
++  journal-fold
  |=  [head=tape day=@t old=@t text=@t]
  ^-  @t
  =/  title=tape  :(weld "# " head ", " (trip day))
  =/  ol=(list tape)  (turn (lines-of (trip old)) un-cr)
  ?:  &(?=(^ ol) =(title (rtrim i.ol)))
    (journal-merge old (journal-body head day text))
  =/  qs=(list tape)
    %+  turn  (turn (lines-of (brief-link-rewrite (trip text))) un-cr)
    |=(l=tape ?~(l ">" (weld "> " l)))
  (journal-into ol (weld "#" title) qs)
::  +journal-into: owner's lines `ol` with the quoted brief `qs` under
::  heading `hd` (see +journal-fold).
++  journal-into
  |=  [ol=(list tape) hd=tape qs=(list tape)]
  ^-  @t
  =/  at=(unit @ud)  (find ~[hd] (turn ol rtrim))
  ?~  at
    =/  own=(list tape)  (flop (drop-blank (flop ol)))
    =/  blk=(list tape)  [hd *tape qs]
    (crip (join-lines ?~(own blk (weld own [*tape blk]))))
  =/  body=(list tape)  (drop-blank (slag +(u.at) ol))
  =/  n=@ud  (quote-run body)
  =/  was=@t  (crip (join-lines (scag n body)))
  =/  now=(list tape)
    (lines-of (trip (journal-merge was (crip (join-lines qs)))))
  %-  crip
  %-  join-lines
  ;:(weld (scag u.at ol) [hd *tape now] (slag n body))
::  +quote-run: how many leading lines of `ls` start with >.
++  quote-run
  |=  ls=(list tape)
  ^-  @ud
  ?~  ls  0
  ?.  ?=([%'>' *] i.ls)  0
  +($(ls t.ls))
::  +drop-blank: `ls` without its leading blank lines.
++  drop-blank
  |=  ls=(list tape)
  ^-  (list tape)
  ?~  ls  ~
  ?.  =(~ (trim-sp i.ls))  ls
  $(ls t.ls)
++  rtrim  |=(l=tape ^-(tape (flop (trim-sp (flop l)))))
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
::  +notes-of: the lines from the first `## Notes` heading on, or ~.
++  notes-of
  |=  ls=(list tape)
  ^-  (list tape)
  ?~  ls  ~
  ?:  =("## Notes" (flop (trim-sp (flop i.ls))))  ls
  $(ls t.ls)
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
