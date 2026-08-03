::  note. The command text IS the note. A dep tick keeps the current value.
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
?~  cmd  same
(text u.cmd)
