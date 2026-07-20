::  doubler — a DERIVED page. It declares the counter's data grub as a
::  dependency; whenever the counter changes, grubbery re-runs this page
::  (empty command) and it recomputes. No polling: the wave drives it.
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  [dat=(unit *) dep=(list path)]
=/  tgt=path  /apps/[`@ta`'lattice.lattice_app']/page/counter/data
?~  deps  [~ ~[tgt]]                       ::  first run: declare the dep
=/  v=@ud  (fall (rush ;;(@t +.i.deps) dim:ag) 0)
[`(crip (a-co:co (mul 2 v))) ~[tgt]]
