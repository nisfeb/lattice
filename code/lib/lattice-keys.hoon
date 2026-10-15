::  /lib/lattice-keys: agent keys, on orrery's design (orrery docs/keys.md).
::
::  A key is a token for one client that does not hold the owner's cookie:
::  a name, the identity it writes as (by), and a scope. The owner mints it
::  and sees the secret once; the ship keeps only a salted hash. Requests
::  carry it as `Authorization: Bearer <id>.<secret>`, and lattice checks it
::  in its own request gate, the way orrery and calendar check theirs.
::
::  The bearer, hash and id helpers are orrery's (code/lib/orrery.hoon) so a
::  client speaks one wire format to both apps.
::
|%
+$  level  ?(%none %read %write)
::  +$  paths: the path sets a scope can restrict to
+$  paths   [read=(set path) write=(set path)]
::  +$  pages-scope: none/read/write for all pages, or a specific path set
+$  pages-scope  $%([%all lvl=level] [%some =paths])
::  +$  web-scope: off, all ships, or a per-ship path set
+$  web-scope    $%([%off ~] [%all ~] [%some ships=(map @p paths)])
::  +$  scope: memory and pages each none/read/write; web controls
::  reading other ships' published pages; sensitive is clearance for
::  memories marked sensitive; origin pins the key to one ship when set.
::  Publishing, sharing, bans, permissions, settings and the keys
::  themselves are never in a scope.
+$  scope
  $:  memory=level
      pages=pages-scope
      web=web-scope
      sensitive=?
      origin=(unit @p)
  ==
::  taint: when the key last received sensitive text. For +taint-for after
::  it, everything the key writes is sensitive too (+tainted).
+$  key-row
  $:  id=@t
      name=@t
      by=@t
      =scope
      salt=@t
      hash=@t
      made=@da
      used=(unit @da)
      taint=(unit @da)
  ==
+$  keys  (map @t key-row)
::  the row before clearance (lattice 45). +upgrade-keys reads any era.
+$  key-row-0
  $:  id=@t
      name=@t
      by=@t
      scope=[memory=level pages=level web=?]
      salt=@t
      hash=@t
      made=@da
      used=(unit @da)
  ==
::  the row after clearance (lattice 45) but before scoped molds (this task).
+$  key-row-1
  $:  id=@t
      name=@t
      by=@t
      scope=[memory=level pages=level web=? sensitive=?]
      salt=@t
      hash=@t
      made=@da
      used=(unit @da)
      taint=(unit @da)
  ==
::  +upgrade: read any prior scope noun and return the new scope shape.
::  Old flat scope was [memory=level pages=level web=? sensitive=?]; map
::  pages=level to [%all level], web=& to [%all ~], web=| to [%off ~],
::  carry sensitive, set origin=~. If already the new shape, pass through.
++  upgrade
  |=  old=*
  ^-  scope
  ::  try the new shape first (pass-through for already-migrated scopes)
  =/  new=(unit scope)  (mole |.(;;(scope old)))
  ?^  new  u.new
  ::  otherwise read as old flat 4-field shape [memory pages web sensitive]
  =/  o  ;;([memory=level pages=* web=* sensitive=?] old)
  =/  pgs=pages-scope
    ?@(pages.o [%all ;;(level pages.o)] ;;(pages-scope pages.o))
  =/  wsc=web-scope
    ?@(web.o ?:(;;(? web.o) [%all ~] [%off ~]) ;;(web-scope web.o))
  [memory.o pgs wsc sensitive.o ~]
::  +upgrade-keys: read any stored keys noun and return current keys.
::  Handles three storage eras: current keys, post-clearance (key-row-1)
::  and pre-clearance (key-row-0).
++  upgrade-keys
  |=  n=*
  ^-  keys
  =/  new=(unit keys)  (mole |.(;;(keys n)))
  ?^  new  u.new
  =/  v1=(unit (map @t key-row-1))  (mole |.(;;((map @t key-row-1) n)))
  ?^  v1
    %-  ~(run by u.v1)
    |=  k=key-row-1
    ^-  key-row
    :*  id.k  name.k  by.k
        (upgrade [memory.scope.k pages.scope.k web.scope.k sensitive.scope.k])
        salt.k  hash.k  made.k  used.k  taint.k
    ==
  =/  v0=(unit (map @t key-row-0))  (mole |.(;;((map @t key-row-0) n)))
  ?~  v0  ~
  %-  ~(run by u.v0)
  |=  k=key-row-0
  ^-  key-row
  :*  id.k  name.k  by.k
      (upgrade [memory.scope.k pages.scope.k web.scope.k |])
      salt.k  hash.k  made.k  used.k  ~
  ==
::  +taint-for: how long a key that received sensitive text writes only
::  sensitive things. A session's length, roughly.
++  taint-for  ~h12
++  tainted
  |=  [k=key-row now=@da]
  ^-  ?
  ?~  taint.k  |
  (lth now (add u.taint.k taint-for))
::  +$  key-action: the writer's, so mint, revoke and last-use stamps never
::  race each other
+$  key-action
  $%  [%add row=key-row]
      [%del id=@t]
      [%touch id=@t when=@da]
      [%taint id=@t when=@da]
  ==
++  max-keys  50
::  +hash-token: a salted sha-256 as text
++  hash-token
  |=  [salt=@t secret=@t]
  ^-  @t
  (scot %ux (shax (rap 3 salt ':' secret ~)))
++  key-ok
  |=  [k=key-row secret=@t]
  ^-  ?
  =(hash.k (hash-token salt.k secret))
::  +parse-bearer: "Bearer <id>.<secret>" to the pair, or ~. The scheme is
::  case-insensitive; the id ends at the first dot.
++  parse-bearer
  |=  h=@t
  ^-  (unit [id=@t secret=@t])
  =/  t=tape  (trip h)
  ?.  (gte (lent t) 8)  ~
  ?.  =("bearer " (cass (scag 7 t)))  ~
  =/  tok=tape
    =/  raw=tape  (slag 7 t)
    |-  ?:(?=([%' ' *] raw) $(raw t.raw) raw)
  =/  at=(unit @ud)  (find "." tok)
  ?~  at  ~
  =/  id=tape  (scag u.at tok)
  =/  secret=tape  (slag +(u.at) tok)
  ?:  |(=(0 (lent id)) =(0 (lent secret)))  ~
  `[(crip id) (crip secret)]
::  +secret-of, +id-of: base-32 text from disjoint slices of entropy
++  secret-of
  |=  eny=@
  ^-  @t
  (pad-left (skip (slag 2 (trip (scot %uv (end [3 15] eny)))) |=(c=@t =('.' c))) 20)
++  id-of
  |=  eny=@
  ^-  @t
  (pad-left (skip (slag 2 (trip (scot %uv (end [3 5] eny)))) |=(c=@t =('.' c))) 6)
++  pad-left
  |=  [t=tape n=@ud]
  ^-  @t
  =/  len=@ud  (lent t)
  ?:  (gte len n)  (crip t)
  (crip (weld (reap (sub n len) '0') t))
::  +touch-due: last use is stamped at most hourly
++  touch-due
  |=  [used=(unit @da) now=@da]
  ^-  ?
  ?~  used  &
  !(lth now (add u.used ~h1))
::  +wants: what a route needs from a key, or ~ when no key may take it.
::  Everything not listed is the owner's.
++  wants
  |=  [meth=@t route=@ta]
  ^-  (unit [area=?(%memory %pages %web) lvl=?(%read %write)])
  ?+  [meth route]  ~
    [%'GET' %know-search]     `[%memory %read]
    [%'GET' %know-recall]     `[%memory %read]
    [%'GET' %know-index]      `[%memory %read]
    [%'GET' %know-read]       `[%memory %read]
    [%'GET' %know-list]       `[%memory %read]
    [%'GET' %know-explore]    `[%memory %read]
    [%'GET' %know-tags]       `[%memory %read]
    [%'GET' %know-history]    `[%memory %read]
    [%'GET' %know-read-at]    `[%memory %read]
    [%'GET' %know-lint]       `[%memory %read]
    [%'POST' %know-save]      `[%memory %write]
    [%'POST' %know-save-batch]  `[%memory %write]
    [%'POST' %know-verify]    `[%memory %write]
    [%'POST' %know-supersede]  `[%memory %write]
    [%'POST' %know-tag]       `[%memory %write]
    [%'POST' %know-untag]     `[%memory %write]
    [%'GET' %page-search]     `[%pages %read]
    [%'GET' %page-source]     `[%pages %read]
    [%'GET' %page-backlinks]  `[%pages %read]
    [%'GET' %page-history]    `[%pages %read]
    [%'GET' %page-tree]       `[%pages %read]
    [%'POST' %page-save]      `[%pages %write]
    [%'POST' %page-save-batch]  `[%pages %write]
    [%'GET' %fetch]           `[%web %read]
    [%'GET' %browse]          `[%web %read]
    [%'GET' %browse-file]     `[%web %read]
    [%'POST' %remote-save]    `[%web %write]
  ==
++  allows
  |=  [s=scope area=?(%memory %pages %web) lvl=?(%read %write)]
  ^-  ?
  ?-  area
    %web
      ?-  web.s
        [%off ~]   |
        [%all ~]   &
        [%some *]  &
      ==
    %memory  (level-ok memory.s lvl)
    %pages
      ?-  pages.s
        [%all *]   (level-ok lvl.pages.s lvl)
        [%some *]  (level-ok %write lvl)
      ==
  ==
++  level-ok
  |=  [have=level want=?(%read %write)]
  ^-  ?
  ?-  want
    %read   !=(%none have)
    %write  =(%write have)
  ==
::  +may: may this key take this route? A route is one segment.
++  may
  |=  [k=key-row meth=@t suffix=path]
  ^-  ?
  ?.  ?=([@ ~] suffix)  |
  =/  n  (wants meth i.suffix)
  ?~  n  |
  (allows scope.k area.u.n lvl.u.n)
::  +under: is grant a segment-prefix of target?  /a/b matches /a/b (exact)
::  and /a/b/c (subtree) but not /a/bc (different segment) or /a (parent).
++  under
  |=  [grant=path target=path]
  ^-  ?
  =/  n  (lent grant)
  &((lte n (lent target)) =(grant (scag n target)))
::  +may-path: may key k access target path at level lvl?
::  %local consults pages-scope; [%ship p] consults the web-scope entry for p.
::  %all delegates to level-ok; %some tests target against the relevant set.
::  Broad web %all is read-only across ships; write is never granted that way.
::  read-set and write-set are independent: granting write does NOT imply read.
++  may-path
  |=  [k=key-row realm=?(%local [%ship @p]) target=path lvl=?(%read %write)]
  ^-  ?
  =/  check
    |=  =paths
    (lien ~(tap in ?:(=(%write lvl) write.paths read.paths)) |=(g=path (under g target)))
  ?-    realm
      %local
    ?-  -.pages.scope.k
      %all   (level-ok lvl.pages.scope.k lvl)
      %some  (check paths.pages.scope.k)
    ==
      [%ship *]
    ?-  -.web.scope.k
      %off   |
      %all   =(%read lvl)
      %some
        =/  e  (~(get by ships.web.scope.k) +.realm)
        ?~(e | (check u.e))
    ==
  ==
::  +page-type-ok: may a key save a page of this ?type=? Only the kinds
::  that render escaped. Hoon would run with lattice's own authority, and
::  html or js would run in the owner's browser. An absent type is hoon.
++  page-type-ok
  |=  t=@t
  ^-  ?
  (~(has in (silt `(list @t)`~['md' 'gmi' 'text' 'tex' 'css' 'index'])) t)
::  ==  JSON
++  de-level
  |=  j=(unit json)
  ^-  level
  ?.  ?=([~ %s *] j)  %none
  ?:  =('write' p.u.j)  %write
  ?:  =('read' p.u.j)  %read
  %none
::  +de-mint: {name, by, scope: {memory, pages, web}} -> the request, or why
::  pages accepts the old flat string ("read"/"write"/"none") for back-compat,
::  and the new nested objects: {"all":"read"|"write"} or
::  {"some":{"read":[path,...],"write":[path,...]}}.
::  web accepts the old bool (true=all, false=off) for back-compat, and the new
::  objects: {"off":null}, {"all":null}, or {"some":{...}} (some=all for now).
++  de-mint
  |=  j=json
  ^-  (each [name=@t by=@t =scope] @t)
  ?.  ?=([%o *] j)  |+'expected an object'
  =/  name=(unit json)  (~(get by p.j) 'name')
  =/  who=(unit json)  (~(get by p.j) 'by')
  ?.  ?=([~ %s @] name)  |+'name: a string, 1 to 200 bytes'
  ?.  ?=([~ %s @] who)  |+'by: a string, 1 to 64 bytes'
  ?.  &((gth (met 3 p.u.name) 0) (lte (met 3 p.u.name) 200))  |+'name: 1 to 200 bytes'
  ?.  &((gth (met 3 p.u.who) 0) (lte (met 3 p.u.who) 64))  |+'by: 1 to 64 bytes'
  ::  by lands in memory front matter as author, one line of it
  ?.  (levy (trip p.u.who) by-char)  |+'by: letters, digits, - _ . only'
  =/  sc=(map @t json)
    =/  s=(unit json)  (~(get by p.j) 'scope')
    ?.(?=([~ %o *] s) ~ p.u.s)
  =/  sen=?  ?=([~ %b %.y] (~(get by sc) 'sensitive'))
  ::  parse a JSON array of path strings into a (set path). Bad entries skipped.
  =/  de-paths
    |=  j=(unit json)
    ^-  (set path)
    ?.  ?=([~ %a *] j)  ~
    %-  ~(gas in *(set path))
    %+  murn  p.u.j
    |=  jj=json
    ?.  ?=([%s @] jj)  ~
    (mole |.((stab p.jj)))
  ::  parse pages: string (old flat) or object (new nested)
  =/  pgsj=(unit json)  (~(get by sc) 'pages')
  =/  pgs=pages-scope
    ?+  pgsj  [%all %none]
      [~ %s @]  [%all (de-level pgsj)]
      [~ %o *]
        =/  pm=(map @t json)  p.u.pgsj
        =/  all=(unit json)  (~(get by pm) 'all')
        =/  som=(unit json)  (~(get by pm) 'some')
        ?^  all  [%all (de-level all)]
        ?~  som  [%all %none]
        ?.  ?=([%o *] u.som)  [%all %none]
        =/  sm=(map @t json)  p.u.som
        [%some (de-paths (~(get by sm) 'read')) (de-paths (~(get by sm) 'write'))]
    ==
  ::  parse web: bool (old flat) or object (new nested)
  =/  webj=(unit json)  (~(get by sc) 'web')
  =/  wsc=web-scope
    ?+  webj  [%off ~]
      [~ %b %.y]  [%all ~]
      [~ %b %.n]  [%off ~]
      [~ %o *]
        =/  wm=(map @t json)  p.u.webj
        ?:  (~(has by wm) 'all')  [%all ~]
        =/  som=(unit json)  (~(get by wm) 'some')
        ?~  som  [%off ~]
        ?.  ?=([%o *] u.som)  [%off ~]
        ::  parse {"~bus":{"read":[...],"write":[...]},...}
        ::  into (map @p paths). Skip unparseable ship keys silently.
        =/  ships=(map @p paths)
          %-  ~(gas by *(map @p paths))
          %+  murn  ~(tap by p.u.som)
          |=  [shp-t=@t shp-j=json]
          ^-  (unit [@p paths])
          =/  sp=(unit @p)  (slaw %p shp-t)
          ?~  sp  ~
          ?.  ?=([%o *] shp-j)  ~
          =/  sm=(map @t json)  p.shp-j
          `[u.sp (de-paths (~(get by sm) 'read')) (de-paths (~(get by sm) 'write'))]
        [%some ships]
    ==
  &+[p.u.name p.u.who [(de-level (~(get by sc) 'memory')) pgs wsc sen ~]]
++  by-char
  |=  c=@t
  ^-  ?
  ?|  &((gte c 'a') (lte c 'z'))
      &((gte c 'A') (lte c 'Z'))
      &((gte c '0') (lte c '9'))
      =('-' c)  =('_' c)  =('.' c)
  ==
++  en-scope
  |=  s=scope
  ^-  json
  ::  a (set path) as a JSON array of path strings, in a stable order
  =/  en-set
    |=  ps=(set path)
    ^-  json
    :-  %a
    %+  turn  (sort ~(tap in ps) aor)
    |=(p=path s+(spat p))
  =/  en-paths
    |=  ps=paths
    ^-  json
    (pairs:enjs:format ~[['read' (en-set read.ps)] ['write' (en-set write.ps)]])
  ::  same shapes +de-mint reads
  =/  pgs=json
    ?-  pages.s
      [%all *]   (pairs:enjs:format ~[['all' s+lvl.pages.s]])
      [%some *]  (pairs:enjs:format ~[['some' (en-paths paths.pages.s)]])
    ==
  =/  wsc=json
    ?-  web.s
      [%off ~]   (pairs:enjs:format ~[['off' ~]])
      [%all ~]   (pairs:enjs:format ~[['all' ~]])
      [%some *]
        %+  frond:enjs:format  'some'
        %-  pairs:enjs:format
        %+  turn  ~(tap by ships.web.s)
        |=([w=@p ps=paths] [(scot %p w) (en-paths ps)])
    ==
  %-  pairs:enjs:format
  :~  ['memory' s+memory.s]
      ['pages' pgs]
      ['web' wsc]
      ['sensitive' b+sensitive.s]
  ==
::  +en-view: a key as the owner sees it: never the salt or the hash.
::  tainted_until only while the key is tainted.
++  en-view
  |=  [k=key-row now=@da]
  ^-  json
  %-  pairs:enjs:format
  :~  ['id' s+id.k]
      ['name' s+name.k]
      ['by' s+by.k]
      ['scope' (en-scope scope.k)]
      ['made' s+(scot %da made.k)]
      ['used' ?~(used.k ~ s+(scot %da (sub u.used.k (mod u.used.k ~h1))))]
      :-  'tainted_until'
      ?.  (tainted k now)  ~
      ?~  taint.k  ~
      =/  until=@da  (add u.taint.k taint-for)
      s+(scot %da (sub until (mod until ~m1)))
  ==
--
