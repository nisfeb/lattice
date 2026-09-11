::  mar/lattice/know-index: the derived live/trash index grub (key -> meta,
::  no bodies). Drives know-list / know-tags / know-explore cheaply.
::
/<  lk  /lib/lattice-know.hoon
=,  format
|_  ix=know-index:lk
++  grad  %noun
++  grow
  |%
  ++  noun  ix
  ++  json
    ^-  ^json
    %-  pairs:enjs
    %+  turn  ~(tap by ix)
    |=  [k=path v=index-entry:lk]
    ^-  [@t ^json]
    :-  (spat k)
    %-  pairs:enjs
    =/  rows=(list [@t ^json])
      :~  ['updated' s+(scot %da updated.v)]
          ['bytes' (numb:enjs bytes.v)]
          ['tags' [%a (turn ~(tap in tags.v) |=(t=@t `^json`[%s t]))]]
      ==
    ?~  restore.v  rows
    (snoc rows ['restore' (numb:enjs u.restore.v)])
  --
++  grab
  |%
  ++  noun  know-index:lk
  --
--
