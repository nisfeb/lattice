::  counter — commands and state. "inc" bumps the count; data is text.
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
=/  n=@ud  ?~(dat 0 (fall (rush ;;(@t u.dat) dim:ag) 0))
=/  m=@ud  ?:(&(?=(^ cmd) =(u.cmd 'inc')) +(n) n)
(text (crip (a-co:co m)))
