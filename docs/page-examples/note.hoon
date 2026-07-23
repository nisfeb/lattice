::  note — the command text IS the note; a dep tick keeps the current value.
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
?~  cmd  same
(text u.cmd)
