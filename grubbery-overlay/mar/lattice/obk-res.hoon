::  mar/lattice/obk-res: an obelisk query result written to the caller's
::  polling grub. Carried as a bare noun: the result type lives in the
::  core's obelisk-ast lib, which marc imports cannot reach (they
::  resolve at the clay /lib root only), and the reader mole-clams the
::  noun to the real type anyway, so a typed marc here adds a build
::  dependency without adding safety.
::
|_  res=*
++  grad  %noun
++  grow
  |%
  ++  noun  res
  --
++  grab
  |%
  ++  noun  *
  --
--
