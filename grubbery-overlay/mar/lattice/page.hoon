::  mar/lattice/page: one stored public page (a gemtext body), stored as the
::  bare cord. The vault grub the pub writer maintains.
::
/<  lp  /lib/lattice-pub.hoon
|_  p=page:lp
++  grad  %noun
++  grow
  |%
  ++  noun  p
  --
++  grab
  |%
  ++  noun  page:lp
  --
--
