::  /lib/lattice-pg — the page standard library.
::
::  A page's code compiles with this core as its subject, so these arms (and,
::  beneath them, the full hoon/zuse stack) are in scope, and the gate returns
::  a +result. The evaluator (nex/lattice/app.hoon) reads that result: it
::  stores +dat as the page's data grub, rendering it per +show; re-runs the
::  page when a +dep changes or after a +wake delay; and sends each +poke as a
::  command to another page.
::
|%
::  +$  view-mode: how a page's data renders in its web view (own pages only;
::  a peer's page data is always escaped when browsed remotely).
::    %text  escaped text (default)   %html  raw HTML — your OWN page's markup
::    %gmi   gemtext rendered to HTML  %noun  opaque value, shown escaped
::
+$  view-mode  ?(%text %html %gmi %md %js %css %noun)
::  +$  result: what a page gate produces.
::
+$  result
  $:  dat=(unit *)                    ::  new data value (~ = no change)
      dep=(list path)                 ::  dependencies (absolute grub paths)
      show=view-mode                  ::  how to render dat
      wake=(unit @dr)                 ::  re-run me after this delay (a timer)
      pokes=(list [name=@ta txt=@t])  ::  commands to send to other pages
  ==
::  constructors — name the render mode, pass the value:
::
++  text  |=(t=@t `result`[`t ~ %text ~ ~])   ::  data is escaped text
++  html  |=(h=@t `result`[`h ~ %html ~ ~])   ::  data is raw HTML (your own)
++  gmi   |=(g=@t `result`[`g ~ %gmi ~ ~])    ::  data is gemtext
++  md    |=(m=@t `result`[`m ~ %md ~ ~])     ::  data is markdown
++  js    |=(j=@t `result`[`j ~ %js ~ ~])     ::  data is raw javascript (asset)
++  css   |=(c=@t `result`[`c ~ %css ~ ~])    ::  data is raw css (asset)
++  raw   |=(n=* `result`[`n ~ %noun ~ ~])    ::  data is an opaque noun
++  same  ^-(result [~ ~ %text ~ ~])          ::  no change to data
::  modifiers — chain onto a result:
::
++  needs  |=([r=result d=(list path)] r(dep d))       ::  set dependencies
++  every  |=([r=result d=@dr] r(wake `d))             ::  re-run every d
++  sends  |=([r=result p=(list [@ta @t])] r(pokes p)) ::  poke pages
::  composition — name another OWN page in a `needs` list to depend on it:
::    data-of  its raw data value      view-of  its rendered view (html @t)
::  A view-dep re-runs this page whenever the named page's data or render mode
::  changes, and its rendered html arrives in `deps` (pull it out with +shown).
::
++  data-of  |=(name=@ta ^-(path /apps/'lattice.lattice_app'/page/[name]/data))
++  view-of  |=(name=@ta ^-(path /apps/'lattice.lattice_app'/page/[name]/view))
::  +shown: the rendered html fragment of a view-dep, by page name ('' until
::  the first run that resolves it). Use it to lay out embedded page views.
::
++  shown
  |=  [deps=(list [path *]) name=@ta]
  ^-  @t
  =/  p=path  (view-of name)
  |-  ^-  @t
  ?~  deps  ''
  ?:  =(p -.i.deps)  (fall (mole |.(;;(@t +.i.deps))) '')
  $(deps t.deps)
::  composition over a DIRECTORY — name a folder in a `needs` list to depend on
::  its whole subtree. The dep resolves to a +tree listing: every page/folder
::  under it (paths RELATIVE to the folder), so a page can walk a structured
::  tree — build a nav/index, a feed, a dashboard. Re-runs when the tree changes.
::    dir-of  the dep path for a folder      tree-in  its listing, from `deps`
::
+$  entry  [pax=path page=?]  ::  a listed node: a page (%.y) or a folder (%.n)
++  dir-of  |=(rel=path ^-(path (weld /apps/'lattice.lattice_app'/page rel)))
::  +pub-of: the PUBLIC (clearweb) url of a page, by its slash path — link
::  between published pages with it so a logged-out visitor can navigate (the
::  /x explorer path is owner-gated). The page must itself be shared %clearweb.
::
++  pub-of  |=(rel=path ^-(tape (weld "/apps/lattice/c" (spud rel))))
++  tree-in
  |=  [deps=(list [path *]) rel=path]
  ^-  (list entry)
  =/  p=path  (dir-of rel)
  |-  ^-  (list entry)
  ?~  deps  ~
  ?:  =(p -.i.deps)  (fall (mole |.(;;((list entry) +.i.deps))) ~)
  $(deps t.deps)
::  +esc: HTML-escape a cord — use it on any dynamic value you weld into html.
::
++  esc
  |=  t=@t
  ^-  @t
  %-  crip
  %-  zing
  %+  turn  (trip t)
  |=  c=@tD
  ?+  c  ~[c]
    %'&'  "&amp;"
    %'<'  "&lt;"
    %'>'  "&gt;"
    %'"'  "&quot;"
  ==
--
