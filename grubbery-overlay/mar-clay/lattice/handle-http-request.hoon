::  handle-http-request, in the shape the RETIRED %lattice gall agent expects.
::
::  Grubbery's own mark (gub/mar/handle-http-request.hoon) carries the newer
::  three-element [eyre-id ship request] payload. The retired agent unpacks two
::  elements (`!<([eyre-id=@ta =inbound-request:eyre] q.cage)`) and would
::  crash on the three-element noun.
::
::  Grubbery resolves a cross-desk poke mark from /mar/clay/<target-desk>/
::  before falling back to /mar/clay/base/, so this file applies ONLY to pokes
::  aimed at the %lattice desk and leaves grubbery's own mark untouched.
::
::  This exists so the nexus can hand the retired agent a synthetic (but
::  genuinely authenticated, src is our own ship) request for its built-in
::  /pub-migrate endpoint, which is the only surface that will emit its page
::  bodies. See +legacy-pub-migrate in nex/lattice/app.hoon.
::
|_  req=[@ta inbound-request:eyre]
++  grab
  |%
  ++  noun  ,[@ta inbound-request:eyre]
  --
++  grow
  |%
  ++  noun  req
  --
--
