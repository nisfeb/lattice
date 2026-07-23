::  site/index — a standalone static-site index, published to the clear web.
::
::  Everything lives under the /site folder, so ONE `%share-tree /site clearweb`
::  publishes the whole thing (and mode=private takes it all down). The builder
::  depends on the /site/content DIRECTORY, walks it with tree-in, and links
::  every page (and the script) with pub-of, the public /c/ url, so a logged-out
::  visitor can navigate (the /x explorer path is owner-gated). The theme is
::  applied automatically by the clearweb serving layer (nearest `theme` up the
::  tree), so the builder need not link it.
::
::  It emits an %html FRAGMENT: the public /c surface wraps it in a bare
::  standalone document (no lattice chrome), and the owner's /x view inlines the
::  same fragment — one stored representation, each surface owns its shell.
::
|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]
^-  result
=/  pages  (skim (tree-in deps /site/content) |=(e=entry page.e))
=/  cards=tape
  %-  zing
  %+  turn  pages
  |=  e=entry
  =/  name=tape  (slag 1 (spud pax.e))
  =/  url=tape   (pub-of (weld /site/content pax.e))
  ;:  weld
    "<li><a href=\""  url  "\"><b>"  name  "</b><span>read &rarr;</span></a></li>"
  ==
=/  body=@t
  %-  crip
  ;:  weld
    "<div class=\"site\"><header><h1>My Site</h1>"
    "<p>Built live from /site/content and published to the clear web.</p></header>"
    "<input class=\"filter\" placeholder=\"filter pages&hellip;\" autocomplete=\"off\">"
    "<ul class=\"nav\">"  cards  "</ul>"
    "<footer>Add a markdown page under /site/content and republish.</footer>"
    "</div>"
    "<script src=\""  (pub-of /site/app)  "\"></script>"
  ==
(needs (html body) ~[(dir-of /site/content)])
