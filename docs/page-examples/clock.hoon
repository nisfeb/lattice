::  clock: data is the time of the last command (pages have no timer yet).
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  [dat=(unit *) dep=(list path)]
[`(scot %da now) ~]
