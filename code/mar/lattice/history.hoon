::  mar/lattice/history: the stored browser-history grub (newest first).
::
/<  lh  /lib/lattice-history.hoon
=,  format
|_  hs=history:lh
++  grad  %noun
++  grow
  |%
  ++  noun  hs
  ++  json
    ^-  ^json
    :-  %a
    %+  turn  hs
    |=  v=visit:lh
    %-  pairs:enjs
    :~  url+s+url.v
        title+s+title.v
        last+s+(scot %da last.v)
        hits+(numb:enjs hits.v)
    ==
  --
++  grab
  |%
  ++  noun  history:lh
  --
--
