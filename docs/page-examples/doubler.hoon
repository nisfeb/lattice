::  doubler — a DERIVED page. `needs` declares the counter's data as a
::  dependency; when it changes, grubbery re-runs this page (empty command).
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
=/  tgt=path  /apps/[`@ta`'lattice.lattice_app']/page/counter/data
?~  deps  (needs same ~[tgt])                 ::  first run: just declare the dep
=/  v=@ud  (fall (rush ;;(@t +.i.deps) dim:ag) 0)
(needs (text (crip (a-co:co (mul 2 v)))) ~[tgt])
