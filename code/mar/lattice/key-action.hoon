::  mar/lattice/key-action: an agent-key change poked at the writer, so a
::  mint, a revoke and a last-use stamp never race. Noun only: no HTTP
::  client drives it directly.
::
/<  ky  /lib/lattice-keys.hoon
|_  act=key-action:ky
++  grad  %noun
++  grow
  |%
  ++  noun  act
  --
++  grab
  |%
  ++  noun  key-action:ky
  --
--
