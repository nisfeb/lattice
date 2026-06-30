::  mar/lattice/know-entry: one stored knowledge entry (the vault grub).
::  Payload is byte-identical to /sur/lattice's know-entry, so the bytes the
::  nexus stores equal what the %lattice agent stores today.
::
/<  lk  /lib/lattice-know.hoon
=,  format
|_  e=know-entry:lk
++  grad  %noun
++  grow
  |%
  ++  noun  e
  ++  json
    ^-  ^json
    %-  pairs:enjs
    :~  body+s+body.e
        updated+(numb:enjs `@`updated.e)
        tags+a+(turn ~(tap in tags.e) |=(t=@t s+t))
    ==
  --
++  grab
  |%
  ++  noun  know-entry:lk
  --
--
