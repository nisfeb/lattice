::  /lib/lattice-pg, the page standard library.
::
::  A page's code compiles with this core as its subject, so these arms (and,
::  beneath them, the full hoon/zuse stack) are in scope, and the gate returns
::  a +result. The evaluator (nex/lattice/app.hoon) reads that result. It
::  stores +dat as the page's data grub, rendering it per +show. It re-runs the
::  page when a +dep changes or after a +wake delay, and sends each +poke as a
::  command to another page.
::
|%
::  +$  view-mode: how a page's data renders in its web view (own pages only,
::  since a peer's page data is always escaped when browsed remotely).
::    %text  escaped text (default)   %html  raw HTML, your OWN page's markup
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
::  constructors. Name the render mode, pass the value:
::
++  text  |=(t=@t `result`[`t ~ %text ~ ~])   ::  data is escaped text
++  html  |=(h=@t `result`[`h ~ %html ~ ~])   ::  data is raw HTML (your own)
++  gmi   |=(g=@t `result`[`g ~ %gmi ~ ~])    ::  data is gemtext
++  md    |=(m=@t `result`[`m ~ %md ~ ~])     ::  data is markdown
++  js    |=(j=@t `result`[`j ~ %js ~ ~])     ::  data is raw javascript (asset)
++  css   |=(c=@t `result`[`c ~ %css ~ ~])    ::  data is raw css (asset)
::  LaTeX source. It renders as escaped text, because the ship has no TeX
::  and is not getting one: conversion happens in the desktop client, which
::  writes the result back as an ordinary html page.
++  tex   |=(t=@t `result`[`t ~ %text ~ ~])   ::  data is LaTeX source
++  raw   |=(n=* `result`[`n ~ %noun ~ ~])    ::  data is an opaque noun
++  same  ^-(result [~ ~ %text ~ ~])          ::  no change to data
::  modifiers. Chain onto a result:
::
++  needs  |=([r=result d=(list path)] r(dep d))       ::  set dependencies
++  every  |=([r=result d=@dr] r(wake `d))             ::  re-run every d
++  sends  |=([r=result p=(list [@ta @t])] r(pokes p)) ::  poke pages
::  composition. Name another OWN page in a `needs` list to depend on it:
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
::  composition over a DIRECTORY. Name a folder in a `needs` list to depend on
::  its whole subtree. The dep resolves to a +tree listing: every page/folder
::  under it (paths RELATIVE to the folder), so a page can walk a structured
::  tree. Build a nav/index, a feed, a dashboard. Re-runs when the tree changes.
::    dir-of  the dep path for a folder      tree-in  its listing, from `deps`
::
+$  entry  [pax=path page=?]  ::  a listed node: a page (%.y) or a folder (%.n)
++  dir-of  |=(rel=path ^-(path (weld /apps/'lattice.lattice_app'/page rel)))
::  +pub-of: the PUBLIC (clearweb) url of a page, by its slash path. Link
::  between published pages with it so a logged-out visitor can navigate (the
::  /x explorer path is owner-gated). The page must itself be shared %clearweb.
::
++  pub-of  |=(rel=path ^-(tape (weld "/apps/lattice/c" (spud rel))))
::  +form-of: the public submission URL for a page. POST here from a plain
::  <form> on a clearweb page and the body arrives as a command to that page.
::  Requires the owner to have enabled forms (page-forms) on the page or a
::  folder above it. The page's own gate decides what the submission means.
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
::  +folder-index: a ready-made builder BODY. It lists every page in `dir` as a
::  nav of links (skipping the conventional `index` page itself, so a folder's
::  index can live inside it). It depends on `dir`, so it stays live as pages
::  come and go. This is the whole "auto-index": a page whose gate is only
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
::  +guestbook: a ready-made builder BODY, a public page anyone can sign,
::  same shape as +folder-index. A page whose whole gate is
::    (guestbook cmd dat /my/page "Guestbook")
::  renders its own form, folds each submission into its own data, and escapes
::  every submission before showing it.
::
::  `rel` is the page's OWN path. The form posts back to it. The logic lives
::  here rather than being copied into each page so a fix reaches every
::  guestbook, and so your page stays three lines you can actually read.
::
::  Submissions only arrive once the OWNER opts the page in. It must be
::  shared %clearweb and have public forms enabled (page-forms), with whatever
::  cap and cooldown you set. Until then this renders as an inert form.
::
++  guestbook
  |=  [cmd=(unit @t) dat=(unit *) rel=path title=tape]
  ^-  result
  ::  prior entries: the <li> run between our own last render's list markers.
  ::  The page's data IS its state. There is no store to keep in sync.
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
  ::  esc EVERY submission. This is untrusted, unauthenticated public input
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
::  A map needs a bounding box, which means arithmetic on coordinates. But
::  +live-location deliberately never parses them as floating point, because
::  round-tripping a position through a float is a silent way to move it.
::  Fixed-point integers add and subtract exactly.
::
++  deg-micro
  |=  t=tape
  ^-  (unit @sd)
  ::  scag/slag rather than snag. They are total, so no ?~ refinement has to
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
::  you. The PUBLIC form channel is deliberately NOT used, because anyone being
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
::  means precision is the sender's decision. Round before you send if you want
::  to share the city and not the building. A page cannot un-know a precise
::  fix it was given.
::
::  No map tiles. Embedding a tile provider would tell that provider where you
::  are every time anyone views the page. The viewer gets a link they can
::  choose to open instead.
::
++  live-location
  |=  [cmd=(unit @t) dat=(unit *) now=@da rel=path title=tape]
  ^-  result
  =/  marker  "<!--loc "
  ::  prior state from our own last render (the page's data IS its render):
  ::  lat|lon|acc|until|trail, trail = "lat,lon;lat,lon;..." newest first.
  ::  Older pages wrote 4 fields. Every access below is length-guarded so an
  ::  update never crashes a page that predates the trail.
  =/  prev=tape
    ?~  dat  ""
    =/  old=tape  (trip ;;(@t u.dat))
    =/  a=(unit @ud)  (find marker old)
    ?~  a  ""
    =/  rest=tape  (slag (add u.a (lent marker)) old)
    =/  b=(unit @ud)  (find "-->" rest)
    ?~(b "" (scag u.b rest))
  =/  fields=(list tape)  (split-on prev '|')
  =/  had=?  (gte (lent fields) 4)
  =/  old-lat=tape    ?:(had (snag 0 fields) "")
  =/  old-lon=tape    ?:(had (snag 1 fields) "")
  =/  old-acc=tape    ?:(had (snag 2 fields) "")
  =/  old-until=tape  ?:(had (snag 3 fields) "")
  =/  old-trail=tape  ?:((gte (lent fields) 5) (snag 4 fields) "")
  ::  join a list of tapes with ";", the inverse of split-on for the trail
  =/  rejoin
    |=  ps=(list tape)
    ^-  tape
    ?~  ps  ""
    |-  ^-  tape
    ?~  t.ps  i.ps
    (weld i.ps (weld ";" $(ps t.ps)))
  ::  a coordinate is digits, a minus and a dot. Nothing else reaches the page
  =/  coordy
    |=  t=tape
    ^-  ?
    ?&  !=(0 (lent t))
        (lte (lent t) 24)
        %+  levy  t
        |=(c=@tD |(&((gte c '0') (lte c '9')) =(c '-') =(c '.')))
    ==
  =/  raw=tape  ?~(cmd "" (trip u.cmd))
  ::  the command arrives as a form body ("cmd=<text>"). Take the value
  =/  arg=tape
    =/  eq=(unit @ud)  (find "=" raw)
    ?~(eq raw (slag +(u.eq) raw))
  =/  parts=(list tape)  (split-on arg ',')
  =/  next=(list tape)
    ?:  =("stop" arg)  ~
    ?.  ?&  (gte (lent parts) 2)
            (coordy (snag 0 parts))
            (coordy (snag 1 parts))
        ==
      ::  no (or unparseable) command: state unchanged
      ?.  had  ~
      ~[old-lat old-lon old-acc old-until old-trail]
    =/  nlat=tape  (snag 0 parts)
    =/  nlon=tape  (snag 1 parts)
    =/  acc=tape   ?:((gte (lent parts) 3) (snag 2 parts) "")
    =/  mins=@ud
      ?.  (gte (lent parts) 4)  60
      =/  n=(unit @ud)  (rush (crip (snag 3 parts)) dem:ag)
      ?~(n 60 ?:((gth u.n 1.440) 1.440 ?:(=(0 u.n) 60 u.n)))
    ::  THE TRAIL: each update files the position it replaces, newest first,
    ::  capped, consecutive duplicates dropped. It lives in the same state
    ::  field as everything else, so stop/expiry erase it with the rest. A
    ::  history of where you were is exactly as sensitive as where you are.
    =/  trail2=tape
      ?.  had  ""
      ?:  &(=(old-lat nlat) =(old-lon nlon))  old-trail
      ?:  =("" old-lat)  old-trail
      =/  entry=tape  :(weld old-lat "," old-lon)
      =/  joined=tape  ?:(=("" old-trail) entry :(weld entry ";" old-trail))
      (rejoin (scag 12 (split-on joined ';')))
    ~[nlat nlon acc (scow %da (add now (mul mins ~m1))) trail2]
  ::  live only while inside the window. An expired share renders NOTHING
  =/  live=?
    ?.  (gte (lent next) 4)  %.n
    =/  u=(unit @da)  (slaw %da (crip (snag 3 next)))
    ?~(u %.n (lth now u.u))
  =/  until=tape  ?:(live (snag 3 next) "")
  =/  trail=tape  ?:(&(live (gte (lent next) 5)) (snag 4 next) "")
  =/  now-t=tape  (scow %da now)
  ::  THE MAP + TRAIL. The privacy trade of the embed stands as documented.
  ::  Every viewer's browser asks openstreetmap.org for tiles at these
  ::  coordinates. The trail is drawn by US as an SVG overlay aligned to the
  ::  same bbox. Past positions are never sent to the tile host at all.
  ::  Empty unless live, so an expired share renders no iframe and no trail.
  =/  map-html=tape
    ?.  live  ""
    =/  mlat=(unit @sd)  (deg-micro (snag 0 next))
    =/  mlon=(unit @sd)  (deg-micro (snag 1 next))
    ?:  |(?=(~ mlat) ?=(~ mlon))  ""
    =/  span=@sd  (sun:si 8.000)          ::  ~0.008deg, roughly a mile
    =/  lonw=@sd  (dif:si u.mlon span)
    =/  latn=@sd  (sum:si u.mlat span)
    =/  bbox=tape
      ;:  weld
        (micro-deg lonw)  ","
        (micro-deg (dif:si u.mlat span))  ","
        (micro-deg (sum:si u.mlon span))  ","
        (micro-deg latn)
      ==
    ::  signed microdegree offset -> percent across the bbox (16.000 wide)
    =/  pct
      |=  d=@sd
      ^-  (unit @ud)
      =/  o  (old:si d)
      ?.  -.o  ~
      =/  p=@ud  (div +.o 160)
      ?:((gth p 100) ~ `p)
    =/  bits=[pl=tape cs=tape]
      =/  pts=(list tape)  ?:(=("" trail) ~ (split-on trail ';'))
      =/  pl=tape  "50,50"
      =/  cs=tape  ""
      |-  ^-  [tape tape]
      ?~  pts  [pl cs]
      =/  xy=(list tape)  (split-on i.pts ',')
      ?.  =(2 (lent xy))  $(pts t.pts)
      =/  py=(unit @sd)  (deg-micro (snag 0 xy))
      =/  px=(unit @sd)  (deg-micro (snag 1 xy))
      ?:  |(?=(~ px) ?=(~ py))  $(pts t.pts)
      =/  xo=(unit @ud)  (pct (dif:si u.px lonw))
      =/  yo=(unit @ud)  (pct (dif:si latn u.py))
      ?:  |(?=(~ xo) ?=(~ yo))  $(pts t.pts)
      =/  xs=tape  (num-tape u.xo)
      =/  ys=tape  (num-tape u.yo)
      %=  $
        pts  t.pts
        pl   :(weld pl " " xs "," ys)
        cs   :(weld cs "<circle cx=\"" xs "\" cy=\"" ys "\" r=\"1.4\"/>")
      ==
    ::  subtle by construction: low opacity, thin line, no labels. A shape of
    ::  where you have been, not a second dataset
    =/  overlay=tape
      ?:  =("" cs.bits)  ""
      ;:  weld
        "<svg viewBox=\"0 0 100 100\" preserveAspectRatio=\"none\" "
        "style=\"position:absolute;inset:0;width:100%;height:100%;pointer-events:none\">"
        "<polyline fill=\"none\" stroke=\"#4a7c59\" stroke-opacity=\".3\" stroke-width=\".8\" points=\""
        pl.bits
        "\"/><g fill=\"#4a7c59\" fill-opacity=\".4\">"  cs.bits  "</g></svg>"
      ==
    ;:  weld
      "<div style=\"position:relative\">"
      "<iframe title=\"map\" loading=\"lazy\" referrerpolicy=\"no-referrer\" "
      "style=\"width:100%;height:320px;border:1px solid #8886;border-radius:8px;display:block\" "
      "src=\"https://www.openstreetmap.org/export/embed.html?bbox="
      (trip (esc (crip bbox)))
      "&amp;layer=mapnik&amp;marker="
      (trip (esc (crip (snag 0 next))))  ","  (trip (esc (crip (snag 1 next))))
      "\"></iframe>"
      overlay
      "</div>"
    ==
  ::  the swappable view: everything a WATCHER needs, wrapped in markers so the
  ::  poll below can replace it in place. In place matters twice over. A
  ::  location.reload() would flicker the map for viewers AND kill the sharing
  ::  tab's watch/heartbeat timers, silently ending the broadcast.
  =/  view-html=tape
    ?.  live
      ;:  weld
        "<p class=\"muted\">No position is being broadcast right now.</p>"
        "<p class=\"muted\">Sharing this page controls who can SEE it; "
        "a position is started with the button below.</p>"
      ==
    ;:  weld
      "<p><b>"  (trip (esc (crip (snag 0 next))))  ", "
                (trip (esc (crip (snag 1 next))))  "</b></p>"
      ?:  =("" (snag 2 next))  ""
      :(weld "<p class=\"muted\">accurate to about " (trip (esc (crip (snag 2 next)))) " m</p>")
      "<p class=\"muted\">broadcasting until "  (trip (esc (crip until)))  "</p>"
      map-html
      "<p><a rel=\"noreferrer noopener\" href=\"https://www.openstreetmap.org/?mlat="
      (trip (esc (crip (snag 0 next))))  "&amp;mlon="  (trip (esc (crip (snag 1 next))))
      "\">open in a map</a></p>"
      "<p class=\"muted\" id=\"locupd\">updated "  now-t  "</p>"
    ==
  ::  +loc-control: the buttons that send positions. Sharing IS live now:
  ::  one press posts immediately, then keeps posting, on significant
  ::  movement (throttled) and on a heartbeat, until the chosen window ends,
  ::  as long as the tab stays open. The old "keep updating" checkbox
  ::  described a browser event that fires only on movement and updated
  ::  nobody's view. "share for an hour" now means what it says.
  ::
  ::  Every post carries the REMAINING minutes, so the deadline is fixed at
  ::  press-time + duration rather than sliding forward with each update.
  ::
  ::  Hidden by default and revealed by an authed probe. /page-cmd is
  ::  owner-gated anyway, but a clearweb viewer should see a status page, not
  ::  buttons that 403. One page serves both roles.
  ::
  ::  The script is a single-quoted CORD, not a tape (hoon interpolates {...}
  ::  in tapes). It uses only double quotes internally, and the page name
  ::  arrives via data-page so the cord stays fully static.
  =/  loc-control=tape
    ;:  weld
      "<div id=\"locctl\" data-page=\""  (trip (esc (crip (slag 1 (spud rel)))))  "\" "
      "style=\"display:none;margin:.8rem 0;gap:8px;align-items:center;flex-wrap:wrap\">"
      "<button id=\"locgo\">share my location</button>"
      "<select id=\"locmins\">"
      "<option value=\"15\">15 min</option>"
      "<option value=\"60\" selected>1 hour</option>"
      "<option value=\"480\">8 hours</option>"
      "</select>"
      "<label><input type=\"checkbox\" id=\"loccoarse\"> coarse (~1 km)</label>"
      "<button id=\"locstop\">stop</button>"
      "<span id=\"locmsg\" class=\"muted\"></span>"
      "</div>"
      "<script>"
      %-  trip
      '''
      (function(){
      var el=document.getElementById("locctl");
      if(!el)return;
      var P=el.getAttribute("data-page");
      var m=document.getElementById("locmsg");
      var api="/apps/lattice";
      fetch(api+"/legacy-status").then(function(r){if(r.ok)el.style.display="flex"}).catch(function(){});
      function post(c){return fetch(api+"/page-cmd?name="+encodeURIComponent(P),{method:"POST",body:"cmd="+encodeURIComponent(c)})}
      var endAt=null,beat=null,watch=null,latest=null,lastPost=0;
      function fx(n){return document.getElementById("loccoarse").checked?n.toFixed(2):n.toFixed(5)}
      function remaining(){return Math.max(1,Math.ceil((endAt-Date.now())/60000))}
      function sendLatest(){
      if(!latest)return;
      lastPost=Date.now();
      post(fx(latest.coords.latitude)+","+fx(latest.coords.longitude)+","+Math.round(latest.coords.accuracy)+","+remaining()).then(function(){setTimeout(refresh,4000)});
      }
      function stopLive(msg){
      if(beat)clearInterval(beat);
      if(watch!==null)navigator.geolocation.clearWatch(watch);
      beat=null;watch=null;endAt=null;m.textContent=msg||"";
      }
      document.getElementById("locgo").onclick=function(){
      m.textContent="getting position...";
      stopLive("");
      endAt=Date.now()+60000*parseInt(document.getElementById("locmins").value,10);
      navigator.geolocation.getCurrentPosition(function(p){
      latest=p;sendLatest();
      m.textContent="sharing - updates while this tab stays open";
      watch=navigator.geolocation.watchPosition(function(q){
      var moved=Math.abs(q.coords.latitude-latest.coords.latitude)+Math.abs(q.coords.longitude-latest.coords.longitude)>0.0003;
      latest=q;
      if(moved&&Date.now()-lastPost>20000)sendLatest();
      },function(){},{enableHighAccuracy:true});
      beat=setInterval(function(){
      if(Date.now()>endAt){stopLive("sharing window ended");return}
      sendLatest();
      },60000);
      },function(e){m.textContent="location error: "+e.message},{enableHighAccuracy:true,timeout:15000});
      };
      document.getElementById("locstop").onclick=function(){stopLive();post("stop").then(function(){setTimeout(refresh,3000)})};
      var lastStripped=null;
      function refresh(){
      fetch(location.href,{cache:"no-store"}).then(function(r){return r.text()}).then(function(t){
      var a=t.indexOf("<!--view-->"),b=t.indexOf("<!--/view-->");
      if(a<0||b<0)return;
      var v=t.slice(a+11,b);
      var vs=v.replace(/updated [^<]*/,"");
      var cur=document.getElementById("locview");
      if(!cur)return;
      if(vs===lastStripped){
      var mm=v.match(/updated [^<]*/);
      var e=document.getElementById("locupd");
      if(mm&&e)e.textContent=mm[0];
      return}
      lastStripped=vs;
      cur.innerHTML=v;
      }).catch(function(){})
      }
      setInterval(refresh,30000);
      })();
      '''
      "</script>"
    ==
  =/  body=@t
    %-  crip
    ;:  weld
      "<div class=\"page\"><h1>"  title  "</h1>"
      "<div id=\"locview\"><!--view-->"  view-html  "<!--/view--></div>"
      loc-control
      ::  machine-readable state for the next run, live only. Writing it past
      ::  expiry once leaked coordinates into a "not sharing" page's source.
      "<!--loc "
      ?:  |(!live (lth (lent next) 4))  ""
      ;:  weld
        (snag 0 next)  "|"  (snag 1 next)  "|"  (snag 2 next)  "|"  (snag 3 next)
        "|"  trail
      ==
      "-->"
      "</div>"
    ==
  ::  re-run when the window closes so the page goes dark by itself
  =/  r=result  (html body)
  ?.  live  r
  =/  u=(unit @da)  (slaw %da (crip until))
  ?~  u  r
  (every r `@dr`(sub u.u now))
::  +esc: HTML-escape a cord. Use it on any dynamic value you weld into html.
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
