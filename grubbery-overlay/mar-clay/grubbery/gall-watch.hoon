::  gall-watch marc: lets a fiber ask %grubbery (via /sys/gall) to subscribe to a
::  gall agent. grubbery's on-poke %gall-watch does !<([ship agent path] vas);
::  this builds that vase. Without it, the self-poke crashes %marc-not-found.
::  Segments of `gall-watch` resolve here (/mar/clay/grubbery/gall-watch).
::
=<
|_  w=watch
++  grow
  |%
  ++  noun  w
  --
++  grab
  |%
  ++  noun  watch
  --
--
|%
+$  watch  [ship=@p agent=@tas =path]
--
