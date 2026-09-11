::  /lib/lattice-history, browser history: pages visited in the reader, newest
::  first. Sibling of /lib/lattice-bookmark. A bookmark is a page you chose to
::  keep, a visit is one you merely saw.
::
::  Entries EXPIRE. History that never forgets is a liability, not a feature.
::  It accumulates every idle page view forever and turns a personal store into
::  a surveillance log of its owner. Anything older than +ttl falls out.
::
|%
::  +visit: one url, with the title it had and how often it has been opened.
::  `last` is the most recent visit, which is both the sort key and what +ttl is
::  measured against.
+$  visit    [url=@t title=@t last=@da hits=@ud]
+$  history  (list visit)
+$  history-action
  $%  [%visit url=@t title=@t]   ::  record (or bump) a visit
      [%forget url=@t]           ::  drop one entry
      [%clear ~]                 ::  drop the lot
  ==
::  +ttl: how long a visit is remembered. Two weeks.
++  ttl  ^-(@dr ~d14)
::  +cap: a hard ceiling regardless of age, so a burst of browsing cannot grow
::  the grub without bound before the ttl catches up.
++  cap  ^-(@ud 500)
::  +fresh: is this visit still within the ttl at `now`?
::
::  The clock guard is load-bearing. `last` can legitimately sit in the FUTURE
::  after a clock adjustment or a restore, and (sub now last) on @da underflows
::  rather than going negative. That would crash the writer on every page
::  view. A future-dated entry is treated as fresh.
++  fresh
  |=  [now=@da v=visit]
  ^-  ?
  ?:  (gth last.v now)  &
  (lth (sub now last.v) ttl)
--
