::  mar/lattice/obk-res: an obelisk-query result the owner fiber writes to a
::  caller's result grub. Noun grab — the caller reads it back with need-vase.
::
/<  ast  /lib/obelisk-ast.hoon
|_  res=(each (list cmd-result:ast) tang)
++  grad  %noun
++  grow
  |%
  ++  noun  res
  --
++  grab
  |%
  ++  noun  (each (list cmd-result:ast) tang)
  --
--
