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
::  +form-of: the public submission URL for a page — POST here from a plain
::  <form> on a clearweb page and the body arrives as a command to that page.
::  Requires the owner to have enabled forms (page-forms) on the page or a
::  folder above it; the page's own gate decides what the submission means.
::  A submission carries poke budget 0, so it can never start a poke chain.
::
++  form-of  |=(rel=path ^-(tape (weld "/apps/lattice/f" (spud rel))))
::  +form-html: a ready-made single-field form posting to +form-of. `label`
::  is the button text. Drop it into an html page body:
::    (weld "<h1>Guestbook</h1>" (form-html /guestbook "sign"))
::
++  form-html
  |=  [rel=path label=tape]
  ^-  tape
  ;:  weld
    "<form method=\"post\" action=\""  (form-of rel)  "\" class=\"lattice-form\">"
    "<input name=\"entry\" autocomplete=\"off\" required>"
    "<button type=\"submit\">"  label  "</button>"
    "</form>"
  ==
++  tree-in
  |=  [deps=(list [path *]) rel=path]
  ^-  (list entry)
  =/  p=path  (dir-of rel)
  |-  ^-  (list entry)
  ?~  deps  ~
  ?:  =(p -.i.deps)  (fall (mole |.(;;((list entry) +.i.deps))) ~)
  $(deps t.deps)
::  +folder-index: a ready-made builder BODY — list every page in `dir` as a nav
::  of links (skipping the conventional `index` page itself, so a folder's index
::  can live inside it). It depends on `dir`, so it stays live as pages come and
::  go. This is the whole "auto-index": a page whose gate is only
::    (folder-index deps /my/folder)
::  lists /my/folder with no other code. The clearweb serving layer themes it.
::
++  folder-index
  |=  [deps=(list [path *]) dir=path]
  ^-  result
  =/  title=tape  ?~(dir "index" (trip (rear `path`dir)))
  =/  items=(list entry)
    %+  skim  (tree-in deps dir)
    |=(e=entry &(page.e ?!(=(/index pax.e))))
  =/  cards=tape
    %-  zing
    %+  turn  items
    |=  e=entry
    ;:  weld
      "<li><a href=\""  (pub-of (weld dir pax.e))  "\">"  (slag 1 (spud pax.e))  "</a></li>"
    ==
  =/  body=@t
    %-  crip
    ;:  weld
      "<div class=\"site\"><header><h1>"  title  "</h1></header><ul class=\"nav\">"
      cards  "</ul></div>"
    ==
  (needs (html body) ~[(dir-of dir)])
::  +guestbook: a ready-made builder BODY — a public page anyone can sign,
::  same shape as +folder-index. A page whose whole gate is
::    (guestbook cmd dat /my/page "Guestbook")
::  renders its own form, folds each submission into its own data, and escapes
::  every submission before showing it.
::
::  `rel` is the page's OWN path: the form posts back to it. The logic lives
::  here rather than being copied into each page so a fix reaches every
::  guestbook, and so your page stays three lines you can actually read.
::
::  Submissions only arrive once the OWNER opts the page in — it must be
::  shared %clearweb and have public forms enabled (page-forms), with whatever
::  cap and cooldown you set. Until then this renders as an inert form.
::
++  guestbook
  |=  [cmd=(unit @t) dat=(unit *) rel=path title=tape]
  ^-  result
  ::  prior entries: the <li> run between our own last render's list markers.
  ::  The page's data IS its state — there is no store to keep in sync.
  =/  prev=tape
    ?~  dat  ""
    =/  old=tape  (trip ;;(@t u.dat))
    =/  a=(unit @ud)  (find "<ul>" old)
    ?~  a  ""
    =/  rest=tape  (slag (add u.a 4) old)
    =/  b=(unit @ud)  (find "</ul>" rest)
    ?~(b "" (scag u.b rest))
  ::  a submission arrives as the form body, "entry=<text>"
  =/  entry=tape
    ?~  cmd  ""
    =/  raw=tape  (trip u.cmd)
    =/  eq=(unit @ud)  (find "=" raw)
    ?~(eq raw (slag +(u.eq) raw))
  ::  esc EVERY submission: this is untrusted, unauthenticated public input
  =/  item=tape
    ?:  =("" entry)  ""
    :(weld "<li>" (trip (esc (crip entry))) "</li>")
  =/  body=@t
    %-  crip
    ;:  weld
      "<div class=\"page\"><h1>"  title  "</h1>"
      (form-html rel "sign")
      "<ul class=\"guestbook\">"  item  prev  "</ul></div>"
    ==
  (html body)
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
