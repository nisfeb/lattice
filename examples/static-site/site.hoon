::  /site — a static-site index built from the /content folder.
::
::  It depends on the /content DIRECTORY (dir-of), so tree-in hands it every
::  page under it. Drop a markdown page into /content and this index rebuilds
::  itself — no code change, no manual list. It links a css theme and a js
::  filter, both served as assets from other pages (/f/theme, /f/site-js).
::
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
=/  pages  (skim (tree-in deps /content) |=(e=entry page.e))
=/  cards=tape
  %-  zing
  %+  turn  pages
  |=  e=entry
  =/  rel=tape  (slag 1 (spud pax.e))
  ;:  weld
    "<li><a href=\"../content/"  rel  "/\"><b>"  rel  "</b>"
    "<span>read &rarr;</span></a></li>"
  ==
=/  body=@t
  %-  crip
  ;:  weld
    "<link rel=\"stylesheet\" href=\"/apps/lattice/f/theme\">"
    "<div class=\"site\"><header><h1>My Site</h1>"
    "<p>Built live from the /content folder via a directory dependency.</p>"
    "</header>"
    "<input class=\"filter\" placeholder=\"filter pages&hellip;\" autocomplete=\"off\">"
    "<ul class=\"nav\">"  cards  "</ul>"
    "<footer>Add a markdown page under /content and this index updates itself.</footer>"
    "</div>"
    "<script src=\"/apps/lattice/f/site-js\"></script>"
  ==
(needs (html body) ~[(dir-of /content)])
