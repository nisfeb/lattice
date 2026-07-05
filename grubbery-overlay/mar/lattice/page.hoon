::  mar/lattice/page: one stored public page (a gemtext body), stored as the
::  bare cord. The vault grub the pub writer maintains.
::
/<  lp  /lib/lattice-pub.hoon
|_  p=page:lp
++  grad  %noun
++  grow
  |%
  ++  noun  p
  ::  json: the gemtext body as a JSON string, so keep-SSE (?blot=/json) streams a
  ::  clean page body instead of a jammed noun.
  ++  json  s+p
  --
++  grab
  |%
  ++  noun  page:lp
  --
--
