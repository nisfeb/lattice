::  /lib/lattice-bookmark — browser bookmarks: a saved page url + title. Newest
::  first (add prepends and dedups by url), so the list order IS the recency the
::  home page shows. Owner-only, like everything the writer stores.
::
|%
::  folder='' means unfiled — where the star button files things; the marks
::  page is where they get organized.
+$  bookmark   [url=@t title=@t folder=@t]
+$  bookmarks  (list bookmark)
+$  bookmark-action
  $%  [%add =bookmark]
      [%del url=@t]
      [%move url=@t folder=@t]
  ==
::  +cap: keep at most this many bookmarks (oldest dropped). Raised from 100
::  when folders arrived — an organized list grows past a flat one.
::
++  cap  ^-(@ud 500)
--
