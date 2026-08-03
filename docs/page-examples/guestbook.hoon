::  guestbook, a public page anyone can sign.
::
::  The whole page is one call. +guestbook in /lib/lattice-pg does the work
::  (renders the form, folds each submission into the page's own data, escapes
::  everything it shows). Pass the page's OWN path so the form posts back to it.
::
::  This is what the `guestbook` TEMPLATE creates for you, with the path filled
::  in: `POST /template-new?template=guestbook&name=<your-page>`.
::
::  Then two owner actions turn it on (never implicit). This is the only
::  public write surface:
::    POST /page-share?name=<your-page>&mode=clearweb
::    POST /page-forms?name=<your-page>&on=1&cap=200&gap=10
::  cap = total submissions accepted (0 = unlimited), gap = seconds between them.
::
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
(guestbook cmd dat /guestbook "Guestbook")
