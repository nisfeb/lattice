::  mar/lattice/mirror-cursor: the reconciler's per-source memory
::  (docs/obelisk-mirror.md section 5).
::
/<  lm  /lib/lattice-mirror.hoon
|_  cur=mirror-cursor:lm
++  grad  %noun
++  grow
  |%
  ++  noun  cur
  --
++  grab
  |%
  ++  noun  mirror-cursor:lm
  --
--
