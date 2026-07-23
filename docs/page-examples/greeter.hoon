::  greeter — a command as input. No command -> "hello, world".
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
=/  who=@t  ?~(cmd 'world' u.cmd)
(text (cat 3 'hello, ' who))
