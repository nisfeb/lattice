::  mar/lattice/share-notice: the shares-inbox poke — %add from any ship,
::  %del from the owner's own UI. Sender identity comes from the poke's
::  transport, never from this payload.
::
/<  ls  /lib/lattice-share.hoon
|_  act=action:ls
++  grad  %noun
++  grow
  |%
  ++  noun  act
  --
++  grab
  |%
  ++  noun  action:ls
  --
--
