::  mar/lattice/know-batch: many know-actions in one writer poke, so POST
::  /know-save-batch costs one store read, one term-cache write and one
::  beacon bump however many memories it saves. Noun only: no HTTP client
::  drives it directly.
::
/<  lk  /lib/lattice-know.hoon
|_  acts=(list know-action:lk)
++  grad  %noun
++  grow
  |%
  ++  noun  acts
  --
++  grab
  |%
  ++  noun  (list know-action:lk)
  --
--
