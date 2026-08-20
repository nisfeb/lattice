::  /lib/lattice-urls, the urb:// address codec (docs/urls.md).
::
::  Pure and import-free, so clay's ford can build it and the round-trip laws
::  in /tests/lib/lattice-urls stay enforceable:
::    de-urb(en-urb(node)) == node          (round-trips to the same referent)
::    en-urb(de-urb(url))  == canon(url)    (idempotent text normalization)
::
::  The nexus (nex/lattice/app.hoon) imports this wholesale (/< *), so the
::  arms stay bare at every call site.
::
|%
::  +app-base: the nexus's absolute tree path (its app dir, fixed by root.hoon).
::  Needed to build remote roads for peek-remote (rewritten to /sys/ames/ships/…).
::
++  app-base  `path`/apps/'lattice.lattice_app'
::  +parse-urb-url: "urb://~ship/rel" -> [ship rel-path]. ~ on a malformed url
::  (+stab is mule-guarded against bad knots).
::
::  Legacy, and the split from +de-urb is deliberate. This one does NO mount
::  resolution: /p/, /n/, /k/ and /t/ come back as ordinary path segments. The
::  HTTP routes that take a url= param (fetch, catalog-toc, sub, unsub,
::  catalog-classify) want the spur exactly as authored, so they call this.
::  New callers want +de-urb.
::
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
  =/  pax=(each path tang)  (mule |.((stab (crip (slag u.slash rest)))))
  ?:(?=(%| -.pax) ~ `[u.shp p.pax])
::  ── urb:// address grammar v2 (docs/urls.md) ────────────────────────────────
::  The first path component selects a fixed, code-versioned MOUNT (p/n/k/t).
::  A multi-char first component is the frozen legacy pub form. Resolution is
::  a PURE function of the url text. No lookups, no viewer context, no
::  existence probes, so the same urb:// names the same referent from any
::  ship, any year (referential transparency). Aliasing exists (/t/<abs> can
::  name what /p/<name> names) but the canonicalizer +en-urb is pure too, and
::  every index keys on it.
::
++  page-prefix  ^-(path (weld app-base /page))
++  pub-prefix   ^-(path (weld app-base /pub/vault))
++  know-prefix  ^-(path (weld app-base /know/vault))
::  +referent: what a urb:// url resolves to. %pub reads gemtext (rel under the
::  pub vault); %tree names a grubbery node served by the explorer (absolute).
::
++  referent  $%([%pub =ship rel=path] [%tree =ship pax=path])
::  +strip-prefix: p with `base` removed, or ~ if p is not under base.
::
++  strip-prefix
  |=  [base=path p=path]
  ^-  (unit path)
  ?.  &((gte (lent p) (lent base)) =(base (scag (lent base) p)))  ~
  `(slag (lent base) p)
::  +de-urb: parse a urb:// url into its referent (~ if malformed). Pure.
::
++  de-urb
  |=  raw=@t
  ^-  (unit referent)
  =/  s=tape  (trip raw)
  ?.  =("urb://" (scag 6 s))  ~
  =/  rest=tape  (slag 6 s)
  =/  cut=(unit @ud)  (find "/" rest)
  =/  shp=(unit @p)  (slaw %p (crip ?~(cut rest (scag u.cut rest))))
  ?~  shp  ~
  ?~  cut  `[%pub u.shp /index]
  =/  ta=tape  (slag +(u.cut) rest)
  ?:  =("" ta)  `[%pub u.shp /index]
  =/  parsed=(each path tang)  (mule |.((stab (crip (weld "/" ta)))))
  ?:  ?=(%| -.parsed)  ~
  =/  segs=path  p.parsed
  ?~  segs  `[%pub u.shp /index]
  ?.  =(1 (met 3 i.segs))
    ::  multi-char first component -> frozen legacy pub form.
    `[%pub u.shp segs]
  ::  single-char first component -> a mount letter (else invalid: hard ~).
  ?+  i.segs  ~
    %p  `[%tree u.shp (weld page-prefix t.segs)]
    %n  `[%pub u.shp t.segs]
    %k  `[%tree u.shp (weld know-prefix t.segs)]
    %t  `[%tree u.shp t.segs]
  ==
::  +en-urb: the canonical urb:// url for a tree node (ship + ABSOLUTE path).
::  Inverse of +de-urb on referents: pages -> /p/, know -> /k/, published pages
::  -> the bare form (unless a single-char top segment forces /n/), anything
::  else -> the /t/ raw escape hatch. The ship root (~) is the raw-tree root.
::
++  en-urb
  |=  [shp=@p pax=path]
  ^-  @t
  =/  pre=tape  (weld "urb://" (scow %p shp))
  =/  seg  |=(rel=path ^-(tape ?~(rel "" (spud rel))))
  =/  mp=(unit path)  (strip-prefix page-prefix pax)
  ?^  mp  (crip :(weld pre "/p" (seg u.mp)))
  =/  mk=(unit path)  (strip-prefix know-prefix pax)
  ?^  mk  (crip :(weld pre "/k" (seg u.mk)))
  =/  mn=(unit path)  (strip-prefix pub-prefix pax)
  ?^  mn
    =/  rel=path  u.mn
    ?:  ?|(=(/index rel) ?=(~ rel))  (crip pre)
    ?:  =(1 (met 3 i.rel))  (crip :(weld pre "/n" (seg rel)))
    (crip :(weld pre (seg rel)))
  (crip :(weld pre "/t" (seg pax)))
--
