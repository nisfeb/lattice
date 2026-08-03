::  mar/lattice/shared: the "shared with me" grub, notices received from
::  other ships, newest first, capped (see /lib/lattice-share).
::
/<  ls  /lib/lattice-share.hoon
=,  format
|_  sh=shared:ls
++  grad  %noun
++  grow
  |%
  ++  noun  sh
  ++  json
    ^-  ^json
    :-  %a
    %+  turn  sh
    |=  e=entry:ls
    %-  pairs:enjs
    :~  host+s+(scot %p host.e)
        path+s+(spat pax.e)
        mode+s+mode.e
        when+s+(scot %da when.e)
    ==
  --
++  grab
  |%
  ++  noun  shared:ls
  --
--
