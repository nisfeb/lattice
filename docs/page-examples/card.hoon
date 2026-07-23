::  card — a page whose data IS html (view mode %html via `html`). The command
::  sets the card text; `esc` keeps it safe. Renders a real styled box in the
::  page view and on the clearweb surface.
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
=/  msg=@t  ?~(cmd 'send a command to set my text' u.cmd)
%-  html
%-  crip
;:  weld
  "<div style=\"padding:1rem;border:2px solid #1a6ed8;border-radius:8px;max-width:24rem\">"
  "<h2>Card</h2><p>"  (trip (esc msg))  "</p></div>"
==
