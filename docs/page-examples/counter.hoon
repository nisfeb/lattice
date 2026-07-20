::  counter — the "hello world" of pages. Command "inc" bumps the count.
::  data is the count as a cord; a dep tick (empty command) leaves it.
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  [dat=(unit *) dep=(list path)]
=/  n=@ud  ?~(dat 0 (fall (rush ;;(@t u.dat) dim:ag) 0))
=/  m=@ud  ?:(&(?=(^ cmd) =(u.cmd 'inc')) +(n) n)
[`(crip (a-co:co m)) ~]
