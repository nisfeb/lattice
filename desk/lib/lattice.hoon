::  /lib/lattice — pure helpers for the %lattice agent.
::
::  These are the bowl/scry-independent gates, split out of /app/lattice so they
::  can be unit-tested in /tests/lib/lattice without a running agent.
::
|%
::  +parse-urb-url: "urb://~ship/a/b" → [~ship /a/b]; bare ship → [~ship /]
++  parse-urb-url
  |=  raw=@t
  ^-  (unit [=ship =path])
  =/  s=tape  (trip raw)
  ?.  =("urb://" (scag 6 s))  ~
  =/  rest=tape  (slag 6 s)
  =/  slash=(unit @ud)  (find "/" rest)
  ?~  slash
    ?~  shp=(slaw %p (crip rest))  ~
    `[u.shp ~]
  ?~  shp=(slaw %p (crip (scag u.slash rest)))  ~
  ::  the path portion is user input; +stab crashes on an invalid knot (spaces,
  ::  unicode, empty segments), so parse it crash-safely and reject on failure.
  =/  pax=(each path tang)  (mule |.((stab (crip (slag u.slash rest)))))
  ?:(?=(%| -.pax) ~ `[u.shp p.pax])
::
::  +pub-path: /pub/<rel>/gmi from a relative @t like "notes/2026/intro".
::  Content lives under /pub, separate from the desk's /lib source libraries.
++  pub-path
  |=  rel=@t
  ^-  path
  :(welp /pub (stab (crip (weld "/" (trip rel)))) /gmi)
::
::  +req-action: the last path segment of a request url (fetch|list|save|delete)
++  req-action
  |=  req=inbound-request:eyre
  ^-  @t
  =/  parsed  (rush url.request.req ;~(plug apat:de-purl:html yque:de-purl:html))
  ?~  parsed  ''
  =/  site=(list @t)  q.-.u.parsed
  ?~  site  ''
  (rear site)
::
::  +query-param: url-decoded value of a query parameter, if present
++  query-param
  |=  [req=inbound-request:eyre key=@t]
  ^-  (unit @t)
  =/  parsed  (rush url.request.req ;~(plug apat:de-purl:html yque:de-purl:html))
  ?~  parsed  ~
  =/  hit  (skim `quay:eyre`+.u.parsed |=([k=@t v=@t] =(k key)))
  ?~  hit  ~
  =/  dec=(unit tape)  (de-urlt:html (trip q.i.hit))
  ?~(dec ~ `(crip u.dec))
::
::  +keen-path: ames remote-scry spar path for a publication revision.
::  Format: /g/x/<case>/lattice//1/<spur> — [cas] is the already-scotted case
::  segment (the FIRST segment), and the trailing `1` is a fixed marker gall
::  requires ([%'1' *]). [cas] is `(scot %ud n)` to address a specific revision
::  (revision-following pends until that revision publishes) or `(scot %da d)`
::  to address the latest revision as of a date (used for one-shot fetches —
::  remote scry only serves the latest revision, not arbitrary old ones).
++  keen-path
  |=  [cas=@ta spur=path]
  ^-  path
  :(welp /g/x ~[cas] /lattice ~[''] ~['1'] spur)
::
::  +mark-and-body: {"mark":..,"body":..} JSON for the fetch response
++  mark-and-body
  |=  [mark=@t body=@t]
  ^-  @t
  %-  en:json:html
  %-  pairs:enjs:format
  :~  ['mark' s+mark]
      ['body' s+body]
  ==
::
::  +generate-index: a gemtext index page listing the published file paths
++  generate-index
  |=  paths=(set path)
  ^-  @t
  =/  lines=(list @t)
    %+  turn  ~(tap in paths)
    |=  pax=path
    ::  /lib/notes/2026/intro/gmi → "=> /notes/2026/intro  notes/2026/intro"
    =/  inner=path  (snip (slag 1 pax))
    =/  shown=tape  (spud inner)
    (crip "=> {shown}  {(slag 1 shown)}")
  =/  header=(list @t)
    ~['# Index' '' 'Files published on this ship:' '']
  (of-wain:format (welp header lines))
--
