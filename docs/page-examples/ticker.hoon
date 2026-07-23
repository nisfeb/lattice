::  ticker — a self-updating clock. `every` re-runs this page on a timer (here
::  every 2s); each run stamps the current time. No command, no dependency —
::  the page drives itself. (Timers are clamped to >= 1s so they can't runaway.)
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
(every (text (scot %da now)) ~s2)
