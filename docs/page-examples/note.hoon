::  note: the command text IS the note; a dep tick keeps the current value.
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  [dat=(unit *) dep=(list path)]
?~  cmd  [dat ~]
[`u.cmd ~]
