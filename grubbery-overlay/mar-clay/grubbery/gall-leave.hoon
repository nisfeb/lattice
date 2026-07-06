::  gall-leave marc: lets a fiber ask %grubbery (via /sys/gall) to unsubscribe
::  from a gall agent. Mirrors gall-watch — grubbery's on-poke %gall-leave does
::  !<([ship agent path] vas). Without it the self-poke crashes %marc-not-found.
::
=<
|_  w=leave
++  grow
  |%
  ++  noun  w
  --
++  grab
  |%
  ++  noun  leave
  --
--
|%
+$  leave  [ship=@p agent=@tas =path]
--
