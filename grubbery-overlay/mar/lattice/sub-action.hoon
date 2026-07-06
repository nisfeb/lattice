::  mar/lattice/sub-action: a follow/unfollow poked at the pub writer. noun grab
::  for the internal self-poke; json grab lets an owner HTTP client drive it.
::
/<  lp  /lib/lattice-pub.hoon
=,  format
|_  act=sub-action:lp
++  grad  %noun
++  grow
  |%
  ++  noun  act
  --
++  grab
  |%
  ++  noun  sub-action:lp
  ++  json
    |=  jon=^json
    ^-  sub-action:lp
    %.  jon
    %-  of:dejs
    :~  follow+(ot:dejs ship+(su:dejs fed:ag) ~)
        unfollow+(ot:dejs ship+(su:dejs fed:ag) ~)
    ==
  --
--
