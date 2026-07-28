::  guestbook — a public form feeding a programmable page.
::
::  Anyone can sign it from the clearweb page; each submission arrives as a
::  command (see +form-of / +form-html in /lib/lattice-pg). The page keeps the
::  signed entries in its own data by carrying prior <li> items forward, and
::  escapes every submission before rendering it.
::
::  Setup: save as a hoon page, then
::    POST /page-share?name=guestbook&mode=clearweb
::    POST /page-forms?name=guestbook&on=1
::
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
::  prior entries: the <li> run between the list markers in our own last html
=/  prev=tape
  ?~  dat  ""
  =/  old=tape  (trip ;;(@t u.dat))
  =/  a=(unit @ud)  (find "<ul>" old)
  ?~  a  ""
  =/  rest=tape  (slag (add u.a 4) old)
  =/  b=(unit @ud)  (find "</ul>" rest)
  ?~(b "" (scag u.b rest))
::  a submission is "entry=<text>" (urlencoded form body); take the value
=/  entry=tape
  ?~  cmd  ""
  =/  raw=tape  (trip u.cmd)
  =/  eq=(unit @ud)  (find "=" raw)
  ?~(eq raw (slag +(u.eq) raw))
=/  item=tape
  ?:  =("" entry)  ""
  :(weld "<li>" (trip (esc (crip entry))) "</li>")
%-  html  %-  crip
;:  weld
  "<h1>Guestbook</h1>"
  (form-html /guestbook "sign")
  "<ul>"  item  prev  "</ul>"
==
