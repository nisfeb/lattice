::  mar/lattice/banned: the banlist grub, ships this ship refuses (see
::  /lib/lattice-share). Sorted on the way out so the UI order is stable
::  rather than following set iteration.
::
/<  ls  /lib/lattice-share.hoon
=,  format
|_  bans=banned:ls
++  grad  %noun
++  grow
  |%
  ++  noun  bans
  ++  json
    ^-  ^json
    :-  %a
    %+  turn  (sort ~(tap in bans) lth)
    |=(w=@p s+(scot %p w))
  --
++  grab
  |%
  ++  noun  banned:ls
  --
--
