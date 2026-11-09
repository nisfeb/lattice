::  mar/lattice/access-ask: the edit access inbox poke (+ask in
::  /lib/lattice-share). %ask and %nay from other ships, the rest from the
::  owner's own UI. The sender comes from the poke's transport, never
::  from this payload.
::
/<  ls  /lib/lattice-share.hoon
|_  act=ask:ls
++  grad  %noun
++  grow
  |%
  ++  noun  act
  --
++  grab
  |%
  ++  noun  ask:ls
  --
--
