::  mar/lattice/sub-action: a follow/unfollow poked at the pub writer. The noun
::  grab carries the internal self-poke (+poke-sub), which is the only way this
::  mark is reached. There is no mime grab beside the json one, so unlike
::  know-action and pub-action this is NOT drivable from an HTTP body: add one
::  (copy know-action's) if a client ever needs to.
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
