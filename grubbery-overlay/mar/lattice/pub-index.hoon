::  mar/lattice/pub-index: the derived public-page index grub (key -> meta, no
::  bodies). Lets the agent learn the published key set + parity hashes in one
::  always-present scry, without reading every page.
::
/<  lp  /lib/lattice-pub.hoon
=,  format
|_  ix=pub-index:lp
++  grad  %noun
++  grow
  |%
  ++  noun  ix
  ++  json
    ^-  ^json
    %-  pairs:enjs
    %+  turn  ~(tap by ix)
    |=  [k=path v=pub-row:lp]
    ^-  [@t ^json]
    :-  (spat k)
    %-  pairs:enjs
    :~  ['updated' s+(scot %da updated.v)]
        ['bytes' (numb:enjs bytes.v)]
        ['hash' s+(scot %uv hash.v)]
    ==
  --
++  grab
  |%
  ++  noun  pub-index:lp
  --
--
