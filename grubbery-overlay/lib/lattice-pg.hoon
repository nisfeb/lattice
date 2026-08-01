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
::  +split-on: split a tape on a character. Small, but three page builders
::  wanted it and each had its own copy.
::
++  split-on
  |=  [t=tape c=@tD]
  ^-  (list tape)
  |-  ^-  (list tape)
  =/  i=(unit @ud)  (find ~[c] t)
  ?~  i  ~[t]
  [(scag u.i t) $(t (slag +(u.i) t))]
::  +deg-micro / +micro-deg: a decimal degree as SIGNED MICRODEGREES.
::
::  A map needs a bounding box, which means arithmetic on coordinates — but
::  +live-location deliberately never parses them as floating point, because
::  round-tripping a position through a float is a silent way to change it.
::  Fixed-point integers add and subtract exactly, so the number that comes
::  back out is the number that went in.
::
::  +num-tape / +tape-num: plain base-10 digits, both ways.
::
::  NOT +scow and NOT rush/dem. `(scow %ud 500.700)` renders "500.700" WITH dot
::  separators, which silently broke the zero-padding below, and dem refused
::  the zero-padded fractions this needs. Hoon's number syntax is for hoon
::  source, not for decimal degrees.
::
++  num-tape
  |=  n=@ud
  ^-  tape
  ?:  =(0 n)  "0"
  =|  out=tape
  |-  ^-  tape
  ?:  =(0 n)  out
  $(n (div n 10), out [(add '0' (mod n 10)) out])
::
++  tape-num
  |=  t=tape
  ^-  (unit @ud)
  ?:  =("" t)  ~
  =|  acc=@ud
  |-  ^-  (unit @ud)
  ?~  t  `acc
  ?.  &((gte i.t '0') (lte i.t '9'))  ~
  $(t t.t, acc (add (mul acc 10) (sub i.t '0')))
::  +deg-micro / +micro-deg: a decimal degree as SIGNED MICRODEGREES.
::
::  A map needs a bounding box, which means arithmetic on coordinates — but
::  +live-location deliberately never parses them as floating point, because
::  round-tripping a position through a float is a silent way to move it.
::  Fixed-point integers add and subtract exactly.
::
++  deg-micro
  |=  t=tape
  ^-  (unit @sd)
  ::  scag/slag rather than snag: they are total, so no ?~ refinement has to
  ::  survive into a wet gate (snag on a refined tape mull-grows here).
  ?:  =("" t)  ~
  =/  neg=?  =("-" (scag 1 t))
  =/  b=tape  ?:(neg (slag 1 t) t)
  =/  ps=(list tape)  (split-on b '.')
  ?.  |(=(1 (lent ps)) =(2 (lent ps)))  ~
  =/  whole=(unit @ud)  (tape-num (scag 1.000 (snag 0 ps)))
  ?~  whole  ~
  =/  frac=tape
    ?:  =(1 (lent ps))  "000000"
    =/  f=tape  (scag 6 (snag 1 ps))
    (weld f (reap (sub 6 (lent f)) '0'))
  =/  fr=(unit @ud)  (tape-num frac)
  ?~  fr  ~
  =/  mag=@ud  (add (mul u.whole 1.000.000) u.fr)
  `?:(neg (new:si | mag) (sun:si mag))
::
++  micro-deg
  |=  m=@sd
  ^-  tape
  =/  o  (old:si m)
  =/  mag=@ud  +.o
  =/  frac=tape  (num-tape (mod mag 1.000.000))
  ;:  weld
    ?:(-.o "" "-")
    (num-tape (div mag 1.000.000))
    "."
    (weld (reap (sub 6 (lent frac)) '0') frac)
  ==
::  +live-location: a page that shares where you are, for a bounded time.
::
::  Owner-only input. The command channel (POST /page-cmd) is authenticated as
::  you; the PUBLIC form channel is deliberately NOT used, because anyone being
::  able to post a location to your page is the whole threat model.
::
::  Commands:
::    <lat>,<lon>              share for the default window
::    <lat>,<lon>,<acc-m>      ...with an accuracy radius in metres
::    <lat>,<lon>,<acc>,<min>  ...for <min> minutes instead
::    stop                     clear it now
::
::  EXPIRY IS THE POINT. Live location that you have to remember to switch off
::  is the kind that leaks, so a share always carries a deadline and the page
::  refuses to render coordinates past it. `wake` re-runs the page when the
::  window closes, so it goes dark on its own rather than at whoever next
::  happens to load it.
::
::  Coordinates are stored and shown VERBATIM, never parsed as numbers. That
::  means precision is the sender's decision: round before you send if you want
::  to share the city and not the building. A page cannot un-know a precise
::  fix it was given.
::
::  No map tiles. Embedding a tile provider would tell that provider where you
::  are every time anyone views the page; the viewer gets a link they can
::  choose to open instead.
::
++  live-location
  |=  [cmd=(unit @t) dat=(unit *) now=@da rel=path title=tape]
  ^-  result
  =/  marker  "<!--loc "
  ::  prior state: our own last render carries it in a comment (the page's data
  ::  IS its render, same as +guestbook).
  =/  prev=tape
    ?~  dat  ""
    =/  old=tape  (trip ;;(@t u.dat))
    =/  a=(unit @ud)  (find marker old)
    ?~  a  ""
    =/  rest=tape  (slag (add u.a (lent marker)) old)
    =/  b=(unit @ud)  (find "-->" rest)
    ?~(b "" (scag u.b rest))
  ::  a coordinate is digits, a minus and a dot — nothing else reaches the page
  =/  coordy
    |=  t=tape
    ^-  ?
    ?&  !=(0 (lent t))
        (lte (lent t) 24)
        %+  levy  t
        |=(c=@tD |(&((gte c '0') (lte c '9')) =(c '-') =(c '.')))
    ==
  =/  raw=tape  ?~(cmd "" (trip u.cmd))
  ::  the command arrives as a form body ("cmd=<text>"); take the value
  =/  arg=tape
    =/  eq=(unit @ud)  (find "=" raw)
    ?~(eq raw (slag +(u.eq) raw))
  =/  parts=(list tape)  (split-on arg ',')
  ::  state is lat|lon|acc|until, all as text
  =/  old=(list tape)  (split-on prev '|')
  =/  now-t=tape  (scow %da now)
  =/  next=(list tape)
    ?:  =("stop" arg)  ~
    ?.  ?&  (gte (lent parts) 2)
            (coordy (snag 0 parts))
            (coordy (snag 1 parts))
        ==
      old                                  ::  unparseable: change nothing
    =/  acc=tape   ?:((gte (lent parts) 3) (snag 2 parts) "")
    =/  mins=@ud
      ?.  (gte (lent parts) 4)  60
      =/  n=(unit @ud)  (rush (crip (snag 3 parts)) dem:ag)
      ?~(n 60 ?:((gth u.n 1.440) 1.440 ?:(=(0 u.n) 60 u.n)))
    :~  (snag 0 parts)
        (snag 1 parts)
        acc
        (scow %da (add now (mul mins ~m1)))
    ==
  ::  live only while inside the window — an expired share renders NOTHING
  =/  live=?
    ?.  =(4 (lent next))  %.n
    =/  u=(unit @da)  (slaw %da (crip (snag 3 next)))
    ?~(u %.n (lth now u.u))
  =/  until=tape  ?:(live (snag 3 next) "")
  ::  THE MAP. Know the trade before publishing this page: an embedded map
  ::  means every viewer's browser asks openstreetmap.org for tiles at these
  ::  coordinates, so the tile host learns the position (and each viewer's IP)
  ::  whenever the page is opened. The bare link below leaks nothing until
  ::  someone clicks it. Both are here; the map because it was asked for.
  ::
  ::  Empty unless live, so an expired share renders no iframe at all —
  ::  nothing to load, nothing to leak.
  =/  map-html=tape
    ?.  live  ""
    =/  mlat=(unit @sd)  (deg-micro (snag 0 next))
    =/  mlon=(unit @sd)  (deg-micro (snag 1 next))
    ?:  |(?=(~ mlat) ?=(~ mlon))  ""
    =/  span=@sd  (sun:si 8.000)          ::  ~0.008deg, roughly a mile
    =/  bbox=tape
      ;:  weld
        (micro-deg (dif:si u.mlon span))  ","
        (micro-deg (dif:si u.mlat span))  ","
        (micro-deg (sum:si u.mlon span))  ","
        (micro-deg (sum:si u.mlat span))
      ==
    ;:  weld
      "<iframe title=\"map\" loading=\"lazy\" referrerpolicy=\"no-referrer\" "
      "style=\"width:100%;height:320px;border:1px solid #8886;border-radius:8px\" "
      "src=\"https://www.openstreetmap.org/export/embed.html?bbox="
      (trip (esc (crip bbox)))
      "&amp;layer=mapnik&amp;marker="
      (trip (esc (crip (snag 0 next))))  ","  (trip (esc (crip (snag 1 next))))
      "\"></iframe>"
    ==
  ::  +loc-control: the buttons that actually send a position.
  ::
  ::  This page had no way to update itself from the app — it was driven only
  ::  by POST /page-cmd, i.e. by curl. A page that shares your location should
  ::  have a button that shares your location.
  ::
  ::  The script is a single-quoted CORD, not a tape: hoon interpolates {...}
  ::  inside a double-quoted tape, so JS braces cannot live in one. It also
  ::  uses only double quotes internally, since the cord delimiter is the
  ::  single quote. The page name is passed via data-page rather than being
  ::  spliced into the script, which keeps the cord entirely static.
  ::
  ::  NB: the control renders for anyone viewing the page. /page-cmd is
  ::  owner-authenticated, so a visitor pressing it gets a 403 rather than
  ::  moving your position — but it is worth knowing it is visible if you
  ::  publish the page.
  =/  loc-control=tape
    ;:  weld
      "<div id=\"locctl\" data-page=\""  (trip (esc (crip (slag 1 (spud rel)))))  "\" "
      "style=\"margin:.8rem 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap\">"
      "<button id=\"locgo\">share my location</button>"
      "<select id=\"locmins\">"
      "<option value=\"15\">15 min</option>"
      "<option value=\"60\" selected>1 hour</option>"
      "<option value=\"480\">8 hours</option>"
      "</select>"
      "<label><input type=\"checkbox\" id=\"loccoarse\"> coarse (~1 km)</label>"
      "<label><input type=\"checkbox\" id=\"loclive\"> keep updating</label>"
      "<button id=\"locstop\">stop</button>"
      "<span id=\"locmsg\" class=\"muted\"></span>"
      "</div>"
      "<script>"
      %-  trip
      '''
      (function(){
      var el=document.getElementById("locctl");
      var P=el.getAttribute("data-page");
      var m=document.getElementById("locmsg");
      function post(c){return fetch("/apps/lattice/page-cmd?name="+encodeURIComponent(P),{method:"POST",body:"cmd="+encodeURIComponent(c)});}
      function fx(n){return document.getElementById("loccoarse").checked?n.toFixed(2):n.toFixed(5);}
      function send(p){return post(fx(p.coords.latitude)+","+fx(p.coords.longitude)+","+Math.round(p.coords.accuracy)+","+document.getElementById("locmins").value);}
      function fail(e){m.textContent="location error: "+e.message;}
      document.getElementById("locgo").onclick=function(){
      m.textContent="getting position...";
      navigator.geolocation.getCurrentPosition(function(p){send(p).then(function(){location.reload();});},fail,{enableHighAccuracy:true,timeout:15000});};
      document.getElementById("locstop").onclick=function(){post("stop").then(function(){location.reload();});};
      var w=null;
      document.getElementById("loclive").onchange=function(e){
      if(e.target.checked){m.textContent="updating live";w=navigator.geolocation.watchPosition(function(p){send(p);},fail,{enableHighAccuracy:true});}
      else{if(w!==null)navigator.geolocation.clearWatch(w);w=null;m.textContent="";}};
      })();
      '''
      "</script>"
    ==
  =/  body=@t
    %-  crip
    ;:  weld
      "<div class=\"page\"><h1>"  title  "</h1>"
      ?.  live
        ;:  weld
          "<p class=\"muted\">No position is being broadcast right now.</p>"
          ::  "sharing" already means page ACLs here, and using it for this
          ::  sent someone to the share controls to fix a page that needed a
          ::  command instead. Name the two things differently and say which
          ::  one this is.
          "<p class=\"muted\">Sharing this page controls who can SEE it; "
          "a position is started by posting a command to it.</p>"
        ==
      ;:  weld
        "<p><b>"  (trip (esc (crip (snag 0 next))))  ", "
                  (trip (esc (crip (snag 1 next))))  "</b></p>"
        ?:  =("" (snag 2 next))  ""
        :(weld "<p class=\"muted\">accurate to about " (trip (esc (crip (snag 2 next)))) " m</p>")
        "<p class=\"muted\">broadcasting until "  (trip (esc (crip until)))  "</p>"
      ;:  weld
        map-html
        "<p><a rel=\"noreferrer noopener\" href=\"https://www.openstreetmap.org/?mlat="
        (trip (esc (crip (snag 0 next))))  "&amp;mlon="  (trip (esc (crip (snag 1 next))))
        "\">open in a map</a></p>"
        ==
      ==
      loc-control
      ::  Machine-readable state for the next run — but ONLY while the share
      ::  is live. Carrying it past expiry meant the page said "not sharing"
      ::  while the coordinates sat in an HTML comment for anyone who viewed
      ::  source: exactly the leak the deadline exists to prevent. Expired
      ::  state is dead state, so it is not written at all.
      "<!--loc "
      ?:  |(=(~ next) !live)  ""
      ;:  weld
        (snag 0 next)  "|"  (snag 1 next)  "|"  (snag 2 next)  "|"  (snag 3 next)
      ==
      "-->"
      "<p class=\"muted\">updated "  now-t  "</p></div>"
    ==
  ::  re-run when the window closes so the page goes dark by itself
  =/  r=result  (html body)
  ?.  live  r
  =/  u=(unit @da)  (slaw %da (crip until))
  ?~  u  r
  (every r `@dr`(sub u.u now))
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
