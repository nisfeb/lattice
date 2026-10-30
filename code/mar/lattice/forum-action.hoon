::  mar/lattice/forum-action: a forum action, poked at a board's host by
::  any ship (see /lib/lattice-forum-types). Who sent it comes from the
::  poke's transport, never from this payload.
::
/<  ft  /lib/lattice-forum-types.hoon
|_  act=action:ft
++  grad  %noun
++  grow
  |%
  ++  noun  act
  --
++  grab
  |%
  ++  noun  action:ft
  --
--
