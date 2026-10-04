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
::  +$  scope: memory and pages each none, read or write; web is reading
::  other ships' published pages; sensitive is clearance for memories
::  marked sensitive. Publishing, sharing, bans, permissions, settings and
::  the keys themselves are never in a scope.
+$  scope  [memory=level pages=level web=? sensitive=?]
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
::  the row before clearance (lattice 45). +upgrade reads either.
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
++  upgrade
  |=  n=*
  ^-  keys
  =/  new=(unit keys)  (mole |.(;;(keys n)))
  ?^  new  u.new
  =/  old=(unit (map @t key-row-0))  (mole |.(;;((map @t key-row-0) n)))
  ?~  old  ~
  %-  ~(run by u.old)
  |=  k=key-row-0
  ^-  key-row
  [id.k name.k by.k [memory.scope.k pages.scope.k web.scope.k %.n] salt.k hash.k made.k used.k ~]
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
    [%'POST' %know-verify]    `[%memory %write]
    [%'POST' %know-supersede]  `[%memory %write]
    [%'POST' %know-tag]       `[%memory %write]
    [%'POST' %know-untag]     `[%memory %write]
    [%'GET' %page-search]     `[%pages %read]
    [%'GET' %page-source]     `[%pages %read]
    [%'GET' %page-backlinks]  `[%pages %read]
    [%'GET' %page-tree]       `[%pages %read]
    [%'POST' %page-save]      `[%pages %write]
    [%'GET' %fetch]           `[%web %read]
  ==
++  allows
  |=  [s=scope area=?(%memory %pages %web) lvl=?(%read %write)]
  ^-  ?
  ?-  area
    %web     web.s
    %memory  (level-ok memory.s lvl)
    %pages   (level-ok pages.s lvl)
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
::  ==  JSON
++  de-level
  |=  j=(unit json)
  ^-  level
  ?.  ?=([~ %s *] j)  %none
  ?:  =('write' p.u.j)  %write
  ?:  =('read' p.u.j)  %read
  %none
::  +de-mint: {name, by, scope: {memory, pages, web}} -> the request, or why
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
  =/  web=?  ?=([~ %b %.y] (~(get by sc) 'web'))
  =/  sen=?  ?=([~ %b %.y] (~(get by sc) 'sensitive'))
  &+[p.u.name p.u.who [(de-level (~(get by sc) 'memory')) (de-level (~(get by sc) 'pages')) web sen]]
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
  %-  pairs:enjs:format
  :~  ['memory' s+memory.s]
      ['pages' s+pages.s]
      ['web' b+web.s]
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
