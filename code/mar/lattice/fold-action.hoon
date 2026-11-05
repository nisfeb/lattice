::  mar/lattice/fold-action: a followed folder's change, poked at the
::  writer by the follow routes (+handle-folder). Noun only: the routes
::  read the folder and hand the writer the rows, so no client sends it.
::
/<  ls  /lib/lattice-share.hoon
|_  act=fold-action:ls
++  grad  %noun
++  grow
  |%
  ++  noun  act
  --
++  grab
  |%
  ++  noun  fold-action:ls
  --
--
