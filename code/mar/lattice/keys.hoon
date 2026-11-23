::  mar/lattice/keys: the agent keys (+keys:ky): salted hashes, never a
::  secret. Kept at /keys, outside /pub, so no other ship can read it.
::  Carried as a bare noun on purpose: +upgrade-keys:ky owns schema
::  versioning on read across storage eras, so older /keys grubs never
::  fail mark clamming on deploy.
::
|_  ks=*
++  grad  %noun
++  grow
  |%
  ++  noun  ks
  --
++  grab
  |%
  ++  noun  *
  --
--
