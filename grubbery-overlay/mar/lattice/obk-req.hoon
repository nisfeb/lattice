::  mar/lattice/obk-req: one obelisk query request poked at the writer
::  fiber, carrying the road where the caller polls for its result.
::  noun grab only, like every writer-action marc here.
::
/<  lm  /lib/lattice-mirror.hoon
|_  req=obk-req:lm
++  grad  %noun
++  grow
  |%
  ++  noun  req
  --
++  grab
  |%
  ++  noun  obk-req:lm
  --
--
