::  /lib/lattice-bookmark — browser bookmarks: a saved page url + title. Newest
::  first (add prepends and dedups by url), so the list order IS the recency the
::  home page shows. Owner-only, like everything the writer stores.
::
|%
+$  bookmark   [url=@t title=@t]
+$  bookmarks  (list bookmark)
+$  bookmark-action  $%([%add =bookmark] [%del url=@t])
::  +cap: keep at most this many bookmarks (oldest dropped).
::
++  cap  ^-(@ud 100)
--
