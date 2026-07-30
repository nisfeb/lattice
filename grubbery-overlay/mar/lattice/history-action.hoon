::  mar/lattice/history-action: a history poke payload — record a visit, forget
::  one url, or clear the lot.
::
/<  lh  /lib/lattice-history.hoon
|_  a=history-action:lh
++  grad  %noun
++  grow
  |%
  ++  noun  a
  --
++  grab
  |%
  ++  noun  history-action:lh
  --
--
