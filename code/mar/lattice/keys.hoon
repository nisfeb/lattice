::  mar/lattice/keys: the agent keys (+keys:ky): salted hashes, never a
::  secret. Kept at /keys, outside /pub, so no other ship can read it.
::
/<  ky  /lib/lattice-keys.hoon
|_  ks=keys:ky
++  grad  %noun
++  grow
  |%
  ++  noun  ks
  --
++  grab
  |%
  ++  noun  keys:ky
  --
--
