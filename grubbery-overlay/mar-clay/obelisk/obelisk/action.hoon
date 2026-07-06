::  obelisk-action marc: lets the lattice nexus poke %obelisk through grubbery's
::  /sys/gall bridge. handle-gall-poke (grubbery agent) looks up a marc under
::  gub/mar/clay/[desk]/[mark-segments] to build the poke vase; without it the
::  poke crashes %marc-not-found. Segments of `obelisk-action` resolve here
::  (/mar/clay/obelisk/obelisk/action).
::
::  ponytail: only the %tape* variants lattice drives; %commands needs the full
::  urQL AST. A %tape-only subset still nests under obelisk's own `action` union,
::  so obelisk's !<(action vase) accepts the built vase. `action` is a named mold
::  (grab.noun references it, like base/json's ^json) — an inline $% there fails
::  grubbery's marc wrap.
::
=<
|_  axn=action
++  grow
  |%
  ++  noun  axn
  --
++  grab
  |%
  ++  noun  action
  --
--
|%
+$  action
  $%  [%tape default-database=@tas urql=tape]
      [%tape-print default-database=@tas urql=tape]
      [%parse default-database=@tas urql=tape]
  ==
--
