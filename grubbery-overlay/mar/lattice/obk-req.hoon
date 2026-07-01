::  mar/lattice/obk-req: a serialized obelisk-query request, poked at the obelisk
::  owner fiber (/cat/obelisk.sig). Noun grab for the internal self-poke.
::
/<  ast  /lib/obelisk-ast.hoon
|_  req=obk-req:ast
++  grad  %noun
++  grow
  |%
  ++  noun  req
  --
++  grab
  |%
  ++  noun  obk-req:ast
  --
--
