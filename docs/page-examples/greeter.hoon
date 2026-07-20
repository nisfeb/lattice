::  greeter: the command is a name; data becomes "hello, <name>".
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  [dat=(unit *) dep=(list path)]
=/  who=@t  ?~(cmd 'world' u.cmd)
[`(cat 3 'hello, ' who) ~]
