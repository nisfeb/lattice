::  mar/lattice/page: one stored public page (a gemtext body). The vault grub
::  the %lattice agent dual-writes and reads back at pub-where=%grubbery. Stored
::  as the bare cord, byte-identical to the content-map value.
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
