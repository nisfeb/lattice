::  /app/lattice - cross-ship gemtext publishing
::
/-  *lattice
/+  default-agent, dbug, verb, *lattice
::
|%
+$  versioned-state  $%(state-0 state-1 state-2 state-3 state-4 state-5 state-6 state-7 state-8)
+$  card  card:agent:gall
::
::  -- helper gates --
::
::  +base-path / +walk-dir: read our own Clay desk. Used ONLY by the %5→%6
::  migration, which pulls the legacy /pub content into state before deleting it.
::  Published content now lives in state.content, not Clay (see state-6).
++  base-path
  |=  =bowl:gall
  ^-  path
  /(scot %p our.bowl)/[q.byk.bowl]/(scot %da now.bowl)
::
++  walk-dir
  |=  [base=path pre=path found=(set path)]
  ^-  (set path)
  =/  =arch  .^(arch %cy (welp base pre))
  =.  found
    ?.  ?=(^ fil.arch)  found
    ?.  =(%gmi (rear pre))  found
    (~(put in found) pre)
  =/  kids=(list @ta)  (turn ~(tap by dir.arch) head)
  |-  ^-  (set path)
  ?~  kids  found
  =.  found
    ^$(base base, pre (snoc pre i.kids), found found)
  $(kids t.kids)
::
::  +live-paths: the published file paths (full /pub/<spur>/gmi keys), from state.
++  live-paths
  |=  content=(map path @t)
  ^-  (set path)
  ~(key by content)
::
::  the reserved publication spur a remote ship probes to discover whether we
::  publish (and to list our files).
++  manifest-spur  `path`/manifest
::
::  +manifest-cards: (re)grow the discovery manifest only when the file set
::  changes. Returns the cards + the new manifest hash. [prev] is the last hash.
++  manifest-cards
  |=  [content=(map path @t) prev=@uvH]
  ^-  [(list card) @uvH]
  =/  body=@t  (generate-index (live-paths content))
  =/  h=@uvH   (sham body)
  ?:  =(h prev)  [~ prev]
  [~[[%pass /grow %grow manifest-spur gmi+body]] h]
::
++  publish-card
  |=  [pax=path body=@t]
  ^-  card
  =/  spur=path  (snip (slag 1 pax))   ::  drop /pub prefix and trailing /gmi
  [%pass /grow %grow spur gmi+body]
::
::  +home-body: the home page — authored /pub/index/gmi if present, else the
::  generated file index. Same content read-local serves for our own home.
++  home-body
  |=  content=(map path @t)
  ^-  @t
  =/  idx=path  /pub/index/gmi
  ?:  (~(has by content) idx)
    (~(got by content) idx)
  (generate-index (live-paths content))
::
::  +home-cards: (re)grow the home at the EMPTY spur when it changes, so a remote
::  `urb://~ship/` (which keens the empty spur) resolves instead of pending.
++  home-cards
  |=  [content=(map path @t) prev=@uvH]
  ^-  [(list card) @uvH]
  =/  body=@t  (home-body content)
  =/  h=@uvH   (sham body)
  ?:  =(h prev)  [~ prev]
  [~[[%pass /grow %grow `path`~ gmi+body]] h]
::
++  unpublish-card
  |=  [=bowl:gall pax=path]
  ^-  card
  =/  spur=path  (snip (slag 1 pax))
  ::  %cull/%tomb require a %ud case = the publication's latest version.
  ::  Scry it from gall (%gw) rather than tracking it, so removal stays
  ::  correct across nukes/re-inits (gall's farm outlives agent state).
  =/  cas=case
    .^  case  %gw
      (welp /(scot %p our.bowl)/lattice/(scot %da now.bowl)//1 spur)
    ==
  ?>  ?=(%ud -.cas)
  [%pass /tomb %cull [%ud p.cas] spur]
::
::  +sync-cards: diff the content map against the last-published hashes; grow
::  new/changed files, cull removed ones. Returns the cards + the new hashes.
++  sync-cards
  |=  [=bowl:gall content=(map path @t) prev=(map path @uvH)]
  ^-  [(list card) (map path @uvH)]
  =/  current=(set path)  (live-paths content)
  =/  cur=(list path)  ~(tap in current)
  ::  hash every current file once
  =/  next=(map path @uvH)
    %-  ~(gas by *(map path @uvH))
    (turn cur |=(p=path [p (sham (~(got by content) p))]))
  ::  to-grow: new files, or files whose content hash changed
  =/  to-grow=(list path)
    %+  skim  cur
    |=  p=path
    ?~  o=(~(get by prev) p)  &
    !=(u.o (~(got by next) p))
  ::  to-remove: previously-published paths no longer present
  =/  to-remove=(list path)
    ~(tap in (~(dif in ~(key by prev)) current))
  =/  grows=(list card)
    (turn to-grow |=(p=path (publish-card p (~(got by content) p))))
  =/  culls=(list card)  (turn to-remove |=(p=path (unpublish-card bowl p)))
  [(weld grows culls) next]
::
++  bind-eyre-card
  |=  =bowl:gall
  ^-  card
  [%pass /eyre/connect %arvo %e %connect [~ /apps/lattice] %lattice]
::
++  respond-json-cards
  |=  [eyre-id=@ta status=@ud body=@t]
  ^-  (list card)
  =/  pax=path  /http-response/[eyre-id]
  =/  hdr=response-header:http
    [status ['content-type' 'application/json']~]
  :~  [%give %fact ~[pax] %http-response-header !>(hdr)]
      [%give %fact ~[pax] %http-response-data !>(`(unit octs)`(some (as-octs:mimes:html body)))]
      [%give %kick ~[pax] ~]
  ==
::
::  +respond-redirect-cards: a 302 to [url]. The docket tile points at
::  /apps/lattice (a site docket); a browser hitting the base path is sent to
::  the project page rather than the JSON API's 400.
++  respond-redirect-cards
  |=  [eyre-id=@ta url=@t]
  ^-  (list card)
  =/  pax=path  /http-response/[eyre-id]
  =/  hdr=response-header:http  [302 ['location' url]~]
  :~  [%give %fact ~[pax] %http-response-header !>(hdr)]
      [%give %fact ~[pax] %http-response-data !>(`(unit octs)`~)]
      [%give %kick ~[pax] ~]
  ==
::
++  respond-html-cards
  |=  [eyre-id=@ta status=@ud body=@t]
  ^-  (list card)
  =/  pax=path  /http-response/[eyre-id]
  ::  CSP: restrict the page to our own origin. script/style are inline (our
  ::  design), but connect-src 'self' blunts exfiltration if anything ever did
  ::  inject — a script can't phone home to a third party.
  =/  csp=@t
    %-  crip
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'"
  =/  hdr=response-header:http
    [status ~[['content-type' 'text/html; charset=utf-8'] ['content-security-policy' csp]]]
  :~  [%give %fact ~[pax] %http-response-header !>(hdr)]
      [%give %fact ~[pax] %http-response-data !>(`(unit octs)`(some (as-octs:mimes:html body)))]
      [%give %kick ~[pax] ~]
  ==
::
::  +fetch-respond / +fetch-fail: answer a walk-to-latest fetch as HTML (web
::  reader, fmt=%html) or JSON (native client). [target] is the urb:// url shown.
++  fetch-respond
  |=  [fmt=@ta ourpatp=tape eyre-id=@ta target=tape mark=@t body=@t]
  ^-  (list card)
  ?:  =(%html fmt)  (respond-html-cards eyre-id 200 (render-doc ourpatp target body))
  (respond-json-cards eyre-id 200 (mark-and-body mark body))
::
++  fetch-fail
  |=  [fmt=@ta ourpatp=tape eyre-id=@ta target=tape status=@ud jerr=@t hmsg=tape]
  ^-  (list card)
  ?:  =(%html fmt)  (respond-html-cards eyre-id status (render-error-page ourpatp target hmsg))
  (respond-json-cards eyre-id status jerr)
::
++  read-local
  |=  [content=(map path @t) eyre-id=@ta pax=path]
  ^-  (list card)
  ?:  =(~ pax)
    ::  empty path = home page (same body we grow at the empty spur for remotes)
    (respond-json-cards eyre-id 200 (mark-and-body 'gmi' (home-body content)))
  ::  non-empty path
  =/  full=path  :(welp /pub pax /gmi)
  ?.  (~(has by content) full)
    (respond-json-cards eyre-id 404 '{"error":"not found"}')
  (respond-json-cards eyre-id 200 (mark-and-body 'gmi' (~(got by content) full)))
::
++  keen-card
  |=  [eyre-id=@ta cas=@ta =ship spur=path]
  ^-  card
  ::  Direct ames %keen task: [%keen sec=(unit [idx key]) spar].  Public = ~.
  ::  Response arrives as [%ames %tune spar roar] on wire /keen/<eyre-id>.
  ::  [cas] is the scotted case — %da now for the latest, %ud n for a revision.
  [%pass /keen/[eyre-id] %arvo %a %keen ~ ship (keen-path cas spur)]
::
::  hard ceiling on a walk-to-latest probe. Without it, a peer that answers
::  every %ud n keen within the sliding deadline keeps /walkto from ever firing
::  and the walk climbs revisions forever (a single browse of a hostile ship
::  becomes a perpetual keen loop). No real gemtext file has this many revs.
++  walk-max  ^-(@ud 1.000)
::
::  walk-to-latest cards: probe revisions on /walk/<eid>, with a behn deadline
::  on /walkto/<eid> that fires when the walk stalls (the next rev pends).
::  [fmt] (%json native | %html web reader) rides in the wire so on-arvo answers
::  the same walk in the format the caller asked for — no per-fetch state needed.
++  walk-keen-card
  |=  [fmt=@ta eyre-id=@ta rev=@ud =ship spur=path]
  ^-  card
  [%pass /walk/[fmt]/[eyre-id] %arvo %a %keen ~ ship (keen-path (scot %ud rev) spur)]
::
++  walk-yawn-card
  |=  [fmt=@ta eyre-id=@ta rev=@ud =ship spur=path]
  ^-  card
  [%pass /walk/[fmt]/[eyre-id] %arvo %a %yawn ship (keen-path (scot %ud rev) spur)]
::
++  walk-wait-card
  |=  [fmt=@ta eyre-id=@ta at=@da]
  ^-  card
  [%pass /walkto/[fmt]/[eyre-id] %arvo %b %wait at]
::
++  walk-rest-card
  |=  [fmt=@ta eyre-id=@ta at=@da]
  ^-  card
  [%pass /walkto/[fmt]/[eyre-id] %arvo %b %rest at]
::
::  browse-watch cards: after a no-rev fetch answers, keep keening upward on a
::  /browse wire so newer revs of the page being viewed stream to /updates. The
::  wire carries the awaited rev + ship + spur so a stale keen is recognised.
++  browse-keen-card
  |=  [=ship spur=path rev=@ud]
  ^-  card
  =/  wir=wire  :(welp /browse ~[(scot %ud rev)] ~[(scot %p ship)] spur)
  [%pass wir %arvo %a %keen ~ ship (keen-path (scot %ud rev) spur)]
::
++  browse-yawn-card
  |=  [=ship spur=path rev=@ud]
  ^-  card
  =/  wir=wire  :(welp /browse ~[(scot %ud rev)] ~[(scot %p ship)] spur)
  [%pass wir %arvo %a %yawn ship (keen-path (scot %ud rev) spur)]
::
::  +rebrowse: cancel any prior browse watch and start one on [ship spur] from
::  rev+1. Returns the cards + the new browse value.
++  rebrowse
  |=  [old=(unit [=ship spur=path rev=@ud]) shp=ship spr=path rev=@ud]
  ^-  [(list card) (unit [=ship spur=path rev=@ud])]
  =/  cancel=(list card)
    ?~  old  ~
    ~[(browse-yawn-card ship.u.old spur.u.old +(rev.u.old))]
  [(snoc cancel (browse-keen-card shp spr +(rev))) `[shp spr rev]]
::
::  +cancel-browse: yawn an active browse watch (e.g. when a new fetch starts).
++  cancel-browse
  |=  old=(unit [=ship spur=path rev=@ud])
  ^-  [(list card) (unit [=ship spur=path rev=@ud])]
  ?~  old  [~ ~]
  [~[(browse-yawn-card ship.u.old spur.u.old +(rev.u.old))] ~]
::
++  sage-cards
  |=  [eyre-id=@ta gag=gage:mess:ames]
  ^-  (list card)
  ::  gage = $@(~ page); ~ (atom) means the peer had no value, else [mark noun]
  ?@  gag
    (respond-json-cards eyre-id 404 '{"error":"remote ship has no value"}')
  ::  the peer fully controls this value; don't crash on a non-cord body.
  ?^  q.gag
    (respond-json-cards eyre-id 502 '{"error":"malformed remote value"}')
  (respond-json-cards eyre-id 200 (mark-and-body p.gag ;;(@t q.gag)))
::
::  +follow-card: keen revision [rev] of [ship]'s [spur] on a /follow wire.
::  The keen pends until that revision is published, so resolving it = a change.
::  [now] (the issue time) is encoded in the wire so on-arvo can tell a real
::  change (the keen pended) from silent catch-up (resolved immediately).
++  follow-card
  |=  [=ship spur=path rev=@ud now=@da]
  ^-  card
  =/  wir=wire  :(welp /follow ~[(scot %da now)] ~[(scot %ud rev)] ~[(scot %p ship)] spur)
  [%pass wir %arvo %a %keen ~ ship (keen-path (scot %ud rev) spur)]
::
::  +update-json: a followed-file change, pushed to subscribers on /updates
++  update-json
  |=  [=ship spur=path body=@t]
  ^-  json
  %-  pairs:enjs:format
  :~  ['ship' s+(scot %p ship)]
      ['path' s+(spat spur)]
      ['body' s+body]
  ==
::
++  list-files-json
  |=  content=(map path @t)
  ^-  @t
  %-  en:json:html
  %-  pairs:enjs:format
  :_  ~
  :-  'files'
  :-  %a
  %+  turn  ~(tap in (live-paths content))
  |=  pax=path
  ::  /pub/notes/2026/intro/gmi → "notes/2026/intro"
  s+(crip (slag 1 (spud (snip (slag 1 pax)))))
::
::  +contacts-json: the ships in our %contacts BOOK as {"ships":[...]} — i.e. the
::  contacts we've explicitly added, NOT the full rolodex (/v1/all includes every
::  peer we've ever seen, thousands of ships, which is useless to probe).
::  Crash-safe (mule): {"ships":[]} when %contacts is absent or empty.
++  contacts-json
  |=  =bowl:gall
  ^-  @t
  =/  res
    %-  mule
    |.  ^-  json
    .^  json  %gx
      (welp /(scot %p our.bowl)/contacts/(scot %da now.bowl) /v1/book/json)
    ==
  =/  ships=(list @t)
    ?.  ?=(%& -.res)  ~
    ?.  ?=([%o *] p.res)  ~
    ~(tap in ~(key by p.p.res))
  %-  en:json:html
  (pairs:enjs:format ~[['ships' a+(turn ships |=(s=@t s+s))]])
::
::  +migrate-content: pull legacy Clay /pub gmi files into a content map. Used by
::  the %5→%6 upgrade — afterwards /pub is deleted from the desk.
++  migrate-content
  |=  =bowl:gall
  ^-  (map path @t)
  =/  files=(set path)  (walk-dir (base-path bowl) /pub *(set path))
  %-  ~(gas by *(map path @t))
  %+  turn  ~(tap in files)
  |=  p=path
  [p .^(@t %cx (welp (base-path bowl) p))]
::
::  +clear-pub-cards: delete the legacy /pub files from Clay (so the desk no
::  longer carries them, and installs no longer ship them) and leave the old
::  clay-watch warp. Empty when there's nothing to clear.
++  clear-pub-cards
  |=  [=bowl:gall files=(set path)]
  ^-  (list card)
  =/  dels=(list [path miso:clay])
    %+  turn  ~(tap in files)
    |=(p=path [p [%del ~]])
  =/  cards=(list card)
    ::  drop the state-5 clay watch (/clay/lib %warp) — content no longer lives
    ::  in Clay, so we don't re-publish on commit anymore.
    ~[[%pass /clay/lib %arvo %c %warp our.bowl q.byk.bowl ~]]
  ?~  dels  cards
  [[%pass /clay-clear %arvo %c %info q.byk.bowl [%& dels]] cards]
::
++  handle-http
  |=  [=bowl:gall eyre-id=@ta =inbound-request:eyre st=state-8]
  ^-  [(list card) state-8]
  ::  SECURITY: Eyre forwards ALL matching HTTP requests to us, authenticated or
  ::  not, and leaves enforcement to the agent. This is the owner's control plane
  ::  (mutates state, drives keens); public reads happen via remote scry, not here.
  ::  Require a valid ship session for everything.
  ?.  authenticated.inbound-request
    [(respond-json-cards eyre-id 403 '{"error":"unauthorized"}') st]
  =/  meth=@tas  method.request.inbound-request
  =/  action=@t  (req-action inbound-request)
  ::  GET /apps/lattice[?url=urb://…] — the web reader (the Landscape tile). A
  ::  no-JS HTML page so you can browse from a browser without a native client.
  ::  Own pages render synchronously from state; remote pages walk-to-latest and
  ::  answer HTML when they resolve (fmt=%html in the walk wire).
  ?:  &(=(meth %'GET') =(action 'lattice'))
    =/  ourpatp=tape  (trip (scot %p our.bowl))
    ::  GET /apps/lattice?view=bookmarks — the bookmarks view (script-filled).
    ?:  =(`'bookmarks' (query-param inbound-request 'view'))
      [(respond-html-cards eyre-id 200 (render-bookmarks ourpatp)) st]
    =/  raw=(unit @t)  (query-param inbound-request 'url')
    =/  target=@t  ?~(raw (crip (urb-of our.bowl ~)) u.raw)
    ?~  parsed=(parse-urb-url target)
      [(respond-html-cards eyre-id 400 (render-error-page ourpatp (trip target) "not a urb:// address")) st]
    ?:  =(ship.u.parsed our.bowl)
      =/  pax=path  path.u.parsed
      ?:  =(~ pax)
        ::  own home → render with the subtle "try the native app" footer
        [(respond-html-cards eyre-id 200 (render-home ourpatp (trip target) (home-body content.st))) st]
      =/  full=path  :(welp /pub pax /gmi)
      ?.  (~(has by content.st) full)
        [(respond-html-cards eyre-id 404 (render-error-page ourpatp (trip target) "that page is not published here")) st]
      [(respond-html-cards eyre-id 200 (render-doc ourpatp (trip target) (~(got by content.st) full))) st]
    ::  remote → walk to latest, render HTML when it resolves
    =/  shp=ship  ship.u.parsed
    =/  spr=path  path.u.parsed
    =/  at=@da  (add now.bowl ~s30)
    =.  fetches.st  (~(put by fetches.st) eyre-id [shp spr 0 '' '' at])
    :_  st
    ~[(walk-keen-card %html eyre-id 1 shp spr) (walk-wait-card %html eyre-id at)]
  ::  GET /apps/lattice/list — the published file tree
  ?:  &(=(meth %'GET') =(action 'list'))
    [(respond-json-cards eyre-id 200 (list-files-json content.st)) st]
  ::  GET /apps/lattice/contacts — ship patps from our %contacts rolodex
  ?:  &(=(meth %'GET') =(action 'contacts'))
    [(respond-json-cards eyre-id 200 (contacts-json bowl)) st]
  ::  POST /apps/lattice/save?path=<rel>  body=<gmi text>
  ?:  &(=(meth %'POST') =(action 'save'))
    ?~  rel=(query-param inbound-request 'path')
      [(respond-json-cards eyre-id 400 '{"error":"missing path"}') st]
    ::  +pub-path parses user input with +stab — guard against an invalid path.
    =/  pp=(each path tang)  (mule |.((pub-path u.rel)))
    ?:  ?=(%| -.pp)
      [(respond-json-cards eyre-id 400 '{"error":"invalid path"}') st]
    =/  body=@t
      ?~(body.request.inbound-request '' q.u.body.request.inbound-request)
    =.  content.st  (~(put by content.st) p.pp body)
    =^  pub-cards  published.st  (sync-cards bowl content.st published.st)
    =^  man-cards  manifest.st   (manifest-cards content.st manifest.st)
    =^  home-cs    home.st       (home-cards content.st home.st)
    :_  st
    :(welp pub-cards man-cards home-cs (respond-json-cards eyre-id 200 '{"ok":true}'))
  ::  POST /apps/lattice/delete?path=<rel>
  ?:  &(=(meth %'POST') =(action 'delete'))
    ?~  rel=(query-param inbound-request 'path')
      [(respond-json-cards eyre-id 400 '{"error":"missing path"}') st]
    =/  pp=(each path tang)  (mule |.((pub-path u.rel)))
    ?:  ?=(%| -.pp)
      [(respond-json-cards eyre-id 400 '{"error":"invalid path"}') st]
    =.  content.st  (~(del by content.st) p.pp)
    =^  pub-cards  published.st  (sync-cards bowl content.st published.st)
    =^  man-cards  manifest.st   (manifest-cards content.st manifest.st)
    =^  home-cs    home.st       (home-cards content.st home.st)
    :_  st
    :(welp pub-cards man-cards home-cs (respond-json-cards eyre-id 200 '{"ok":true}'))
  ::  ── private knowledge store: CRUD for the app (mirrors do-know / the peek) ──
  ::  GET /apps/lattice/know-list  — live items (keys + metadata)
  ?:  &(=(meth %'GET') =(action 'know-list'))
    [(respond-json-cards eyre-id 200 (en:json:html (know-list-json know.st))) st]
  ::  GET /apps/lattice/know-trash — soft-deleted items
  ?:  &(=(meth %'GET') =(action 'know-trash'))
    [(respond-json-cards eyre-id 200 (en:json:html (know-list-json trash.st))) st]
  ::  GET /apps/lattice/know-read?key=<key> — one item with its body
  ?:  &(=(meth %'GET') =(action 'know-read'))
    ?~  k=(query-param inbound-request 'key')
      [(respond-json-cards eyre-id 400 '{"error":"missing key"}') st]
    ?~  kp=(know-key u.k)
      [(respond-json-cards eyre-id 400 '{"error":"invalid key"}') st]
    ?~  e=(~(get by know.st) u.kp)
      [(respond-json-cards eyre-id 404 '{"error":"not found"}') st]
    [(respond-json-cards eyre-id 200 (en:json:html (know-entry-json u.kp u.e))) st]
  ::  POST /apps/lattice/know-save?key=<key>  body=<text>
  ?:  &(=(meth %'POST') =(action 'know-save'))
    ?~  k=(query-param inbound-request 'key')
      [(respond-json-cards eyre-id 400 '{"error":"missing key"}') st]
    =/  body=@t
      ?~(body.request.inbound-request '' q.u.body.request.inbound-request)
    [(respond-json-cards eyre-id 200 '{"ok":true}') (do-know now.bowl [%save u.k body] st)]
  ::  POST /apps/lattice/know-delete?key=<key>  (soft → trash)
  ?:  &(=(meth %'POST') =(action 'know-delete'))
    ?~  k=(query-param inbound-request 'key')
      [(respond-json-cards eyre-id 400 '{"error":"missing key"}') st]
    [(respond-json-cards eyre-id 200 '{"ok":true}') (do-know now.bowl [%del u.k] st)]
  ::  POST /apps/lattice/know-restore?key=<key>
  ?:  &(=(meth %'POST') =(action 'know-restore'))
    ?~  k=(query-param inbound-request 'key')
      [(respond-json-cards eyre-id 400 '{"error":"missing key"}') st]
    [(respond-json-cards eyre-id 200 '{"ok":true}') (do-know now.bowl [%restore u.k] st)]
  ::  POST /apps/lattice/know-tag?key=<key>&tag=<tag>  — add a cross-cutting tag
  ?:  &(=(meth %'POST') =(action 'know-tag'))
    ?~  k=(query-param inbound-request 'key')
      [(respond-json-cards eyre-id 400 '{"error":"missing key"}') st]
    ?~  t=(query-param inbound-request 'tag')
      [(respond-json-cards eyre-id 400 '{"error":"missing tag"}') st]
    [(respond-json-cards eyre-id 200 '{"ok":true}') (do-know now.bowl [%tag u.k u.t] st)]
  ::  POST /apps/lattice/know-untag?key=<key>&tag=<tag>  — remove a tag
  ?:  &(=(meth %'POST') =(action 'know-untag'))
    ?~  k=(query-param inbound-request 'key')
      [(respond-json-cards eyre-id 400 '{"error":"missing key"}') st]
    ?~  t=(query-param inbound-request 'tag')
      [(respond-json-cards eyre-id 400 '{"error":"missing tag"}') st]
    [(respond-json-cards eyre-id 200 '{"ok":true}') (do-know now.bowl [%untag u.k u.t] st)]
  ::  POST /apps/lattice/know-publish?key=<key>[&path=<rel>] — copy a private
  ::  item into the PUBLISHED gemtext (grows it; default publish path = the key).
  ?:  &(=(meth %'POST') =(action 'know-publish'))
    ?~  k=(query-param inbound-request 'key')
      [(respond-json-cards eyre-id 400 '{"error":"missing key"}') st]
    ?~  kp=(know-key u.k)
      [(respond-json-cards eyre-id 400 '{"error":"invalid key"}') st]
    ?~  e=(~(get by know.st) u.kp)
      [(respond-json-cards eyre-id 404 '{"error":"not found"}') st]
    =/  prel=@t  ?~(p=(query-param inbound-request 'path') u.k u.p)
    =/  pp=(each path tang)  (mule |.((pub-path prel)))
    ?:  ?=(%| -.pp)
      [(respond-json-cards eyre-id 400 '{"error":"invalid path"}') st]
    =.  content.st  (~(put by content.st) p.pp body.u.e)
    =^  pub-cards  published.st  (sync-cards bowl content.st published.st)
    =^  man-cards  manifest.st   (manifest-cards content.st manifest.st)
    =^  home-cs    home.st       (home-cards content.st home.st)
    :_  st
    :(welp pub-cards man-cards home-cs (respond-json-cards eyre-id 200 '{"ok":true}'))
  ::  POST /apps/lattice/sub?url=urb://~ship/path — follow a remote file
  ?:  &(=(meth %'POST') =(action 'sub'))
    ?~  raw=(query-param inbound-request 'url')
      [(respond-json-cards eyre-id 400 '{"error":"missing url param"}') st]
    ?~  parsed=(parse-urb-url u.raw)
      [(respond-json-cards eyre-id 400 '{"error":"bad urb:// url"}') st]
    ?:  =(ship.u.parsed our.bowl)
      [(respond-json-cards eyre-id 400 '{"error":"cannot follow your own ship"}') st]
    =/  key  [ship.u.parsed path.u.parsed]
    ::  idempotent: re-subscribing (e.g. on each app login — the desk persists
    ::  subs and keeps following) must not reset the cursor or arm a duplicate keen
    ?:  (~(has by subs.st) key)
      [(respond-json-cards eyre-id 200 '{"ok":true}') st]
    =.  subs.st  (~(put by subs.st) key 0)
    :_  st
    [(follow-card ship.u.parsed path.u.parsed 1 now.bowl) (respond-json-cards eyre-id 200 '{"ok":true}')]
  ::  POST /apps/lattice/unsub?url=urb://~ship/path
  ?:  &(=(meth %'POST') =(action 'unsub'))
    ?~  raw=(query-param inbound-request 'url')
      [(respond-json-cards eyre-id 400 '{"error":"missing url param"}') st]
    ?~  parsed=(parse-urb-url u.raw)
      [(respond-json-cards eyre-id 400 '{"error":"bad urb:// url"}') st]
    =.  subs.st  (~(del by subs.st) [ship.u.parsed path.u.parsed])
    [(respond-json-cards eyre-id 200 '{"ok":true}') st]
  ::  GET /apps/lattice/fetch?url=urb://~ship/path  (default)
  ?~  raw=(query-param inbound-request 'url')
    [(respond-json-cards eyre-id 400 '{"error":"missing url param"}') st]
  ?~  parsed=(parse-urb-url u.raw)
    [(respond-json-cards eyre-id 400 '{"error":"bad urb:// url"}') st]
  ?:  =(ship.u.parsed our.bowl)
    [(read-local content.st eyre-id path.u.parsed) st]
  =/  shp=ship  ship.u.parsed
  =/  spr=path  path.u.parsed
  ::  &rev=N pins a specific publication revision (%ud N): one exact keen, with
  ::  a deadline so a never-resolving keen (unreachable peer) can't leak a
  ::  pending entry forever.
  ?^  r=(query-param inbound-request 'rev')
    =/  rev=@ud  ?~(n=(slaw %ud u.r) 1 u.n)
    =.  pending.st  (~(put by pending.st) eyre-id u.parsed)
    :_  st
    :~  (keen-card eyre-id (scot %ud rev) shp spr)
        [%pass /keento/[eyre-id] %arvo %b %wait (add now.bowl ~s30)]
    ==
  ::  no &rev → walk to the latest revision. Remote scry has no "latest" query,
  ::  so keen rev 1,2,3… (recording the highest that resolves) until the next
  ::  rev pends; the /walkto behn deadline then answers with the best seen.
  ::  Cold-route tolerant: ~s30 lets a first-contact remote scry (never-seen
  ::  peer — ames route still being established) resolve rev 1 before /walkto
  ::  fires with an empty "best seen". Once a rev resolves the deadline slides
  ::  to ~s2 per rev (see the %walk sage branch), so warm/local fetches stay
  ::  snappy; only the cold first hop waits the full window.
  ::  cancel any prior browse watch — we're navigating to a new page.
  =^  bcards  browse.st  (cancel-browse browse.st)
  =/  at=@da  (add now.bowl ~s30)
  =.  fetches.st  (~(put by fetches.st) eyre-id [shp spr 0 '' '' at])
  [:(welp bcards ~[(walk-keen-card %json eyre-id 1 shp spr) (walk-wait-card %json eyre-id at)]) st]
--
::
%-  agent:dbug
%+  verb  |
=|  state-8
=*  state  -
^-  agent:gall
|_  =bowl:gall
+*  this  .
    def   ~(. (default-agent this %|) bowl)
::
++  on-init
  ^-  (quip card _this)
  ::  Fresh install: no content yet. Grow the (empty) discovery manifest + home
  ::  so a remote probe resolves them instead of pending. Nothing else to grow.
  =^  man-cards  manifest.state  (manifest-cards content.state `@uvH`0)
  =^  home-cs    home.state      (home-cards content.state `@uvH`0)
  :_  this
  [(bind-eyre-card bowl) (weld man-cards home-cs)]
::
++  on-save  !>(state)
::
++  on-load
  |=  ole=vase
  ^-  (quip card _this)
  =/  old=versioned-state  !<(versioned-state ole)
  ?:  ?=(%8 -.old)  `this(state old)
  ::  %7 → %8: give every knowledge entry empty tags + a reserved (empty) vector.
  ?:  ?=(%7 -.old)
    =/  up=$-(know-entry-7 know-entry)  |=(e=know-entry-7 [body.e updated.e ~ ~])
    :-  ~
    %=  this  state
      :*  %8  content.old  published.old  pending.old  subs.old  fetches.old
          manifest.old  home.old  browse.old
          (~(run by know.old) up)  (~(run by trash.old) up)
      ==
    ==
  ::  %6 → %8: add the empty private knowledge store (know + trash).
  ?:  ?=(%6 -.old)
    :-  ~
    %=  this  state
      :*  %8  content.old  published.old  pending.old  subs.old  fetches.old
          manifest.old  home.old  browse.old  ~  ~
      ==
    ==
  ::  Versions 0-5 stored published content in Clay /pub. Pull it into state,
  ::  then delete /pub from the desk + drop the clay watch, so the desk stops
  ::  carrying the content (and installs stop shipping the publisher's pages).
  =/  content=(map path @t)  (migrate-content bowl)
  =/  files=(set path)       ~(key by content)
  =/  cards=(list card)      (clear-pub-cards bowl files)
  =/  new=state-8
    ?-  -.old
      %5  [%8 content published.old pending.old subs.old fetches.old manifest.old home.old browse.old ~ ~]
      %4  [%8 content published.old pending.old subs.old fetches.old manifest.old home.old ~ ~ ~]
      %3  [%8 content published.old pending.old subs.old fetches.old manifest.old `@uvH`0 ~ ~ ~]
      %2  [%8 content published.old pending.old subs.old fetches.old `@uvH`0 `@uvH`0 ~ ~ ~]
      %1  [%8 content published.old pending.old subs.old ~ `@uvH`0 `@uvH`0 ~ ~ ~]
      %0  [%8 content published.old pending.old ~ ~ `@uvH`0 `@uvH`0 ~ ~ ~]
    ==
  [cards this(state new)]
::
++  on-poke
  |=  =cage
  ^-  (quip card _this)
  ::  SECURITY: only our own ship may poke us. %handle-http-request comes from
  ::  Eyre (local). Without this gate any remote ship could poke a forged HTTP
  ::  request and write/delete our files or drive our network activity.
  ?.  =(src.bowl our.bowl)
    ~&(>>> "lattice: rejected remote poke from {<src.bowl>}" `this)
  ?+  p.cage  ~&(>> "lattice: ignored poke {<p.cage>}" `this)
      %handle-http-request
    =+  !<([eyre-id=@ta =inbound-request:eyre] q.cage)
    =^  cards  state  (handle-http bowl eyre-id inbound-request state)
    [cards this]
  ::
  ::  programmatic knowledge writes (on-ship agents / MCP). src==our already
  ::  enforced above, so only the owner's own automation can store/delete.
      %lattice-know
    =+  !<(act=know-action q.cage)
    `this(state (do-know now.bowl act state))
  ==
::
++  on-watch
  |=  =path
  ^-  (quip card _this)
  ::  SECURITY: /updates and /http-response are local-only (the app subscribes
  ::  via Eyre, src = our). Deny remote watchers — they would otherwise receive
  ::  our followed-file contents and our HTTP responses.
  ?.  =(src.bowl our.bowl)
    ~|(%lattice-no-remote-watch !!)
  ?+  path  (on-watch:def path)
      [%http-response *]  `this
      [%updates ~]  `this
  ==
::
++  on-leave  on-leave:def
::
++  on-peek
  |=  =path
  ^-  (unit (unit cage))
  ?+  path  ~
      [%x %published ~]
    :^  ~  ~  %json
    !>  ^-  json
    %-  pairs:enjs:format
    :~  ['count' (numb:enjs:format ~(wyt by published.state))]
        :-  'hashes'
        :-  %o
        %-  ~(gas by *(map @t json))
        %+  turn  ~(tap by published.state)
        |=([p=^path h=@uvH] [(spat p) s+(scot %uv h)])
    ==
  ::
      [%x %live-list ~]
    =/  files=(set ^path)  (live-paths content.state)
    :^  ~  ~  %json
    !>  ^-  json
    %-  pairs:enjs:format
    :~  ['count' (numb:enjs:format ~(wyt in files))]
        :-  'paths'
        :-  %a
        %+  turn  ~(tap in files)
        |=(p=^path s+(spat p))
    ==
  ::
  ::  ── private knowledge store (owner-only: on-peek is local / auth-gated) ──
  ::  scry via .../x/know/list/json, /x/know/all/json, /x/know/trash/json,
  ::  /x/know/read/<key…>/json
      [%x %know %list ~]   ``json+!>((know-list-json know.state))
      [%x %know %all ~]    ``json+!>((know-all-json know.state))
      [%x %know %trash ~]  ``json+!>((know-list-json trash.state))
      [%x %know %read *]
    =/  kp=^path  t.t.t.path
    ?~  e=(~(get by know.state) kp)
      ``json+!>(`json`(pairs:enjs:format ~[['error' s+'not found']]))
    ``json+!>((know-entry-json kp u.e))
  ==
::
::  lattice uses ames keens + eyre, not gall subscriptions, so no agent signs
::  are expected; ignore any quietly.
++  on-agent  |=([wire sign:agent:gall] `this)
::
++  on-arvo
  |=  [=wire =sign-arvo]
  ^-  (quip card _this)
  ?+  wire  ~&(>>> "lattice: unhandled arvo wire {<wire>}" `this)
      ::  legacy state-5 clay watch — left in on-load; ignore any stray fire.
      [%clay %lib ~]  `this
  ::
      [%eyre %connect ~]
    ?>  ?=([%eyre %bound *] sign-arvo)
    ::  only surface a problem — a rejected bind means /apps/lattice is taken
    ::  and the HTTP API won't work.
    ?:  accepted.sign-arvo  `this
    ~&(>>> "lattice: eyre bind /apps/lattice REJECTED — endpoint in use?" `this)
  ::
      [%keen @ta ~]
    ::  this kernel answers a %keen with %sage (sage = [spar gage]);
    ::  %tune is the older variant.
    ?>  ?=([%ames %sage *] sign-arvo)
    =/  eid=@ta  i.t.wire
    ::  no pending entry → a late %sage after the &rev deadline already answered;
    ::  ignore quietly.
    ?~  pend=(~(get by pending.state) eid)  `this
    =.  pending.state  (~(del by pending.state) eid)
    [(sage-cards eid q.sage.sign-arvo) this]
  ::
      [%keento @ta ~]
    ::  the &rev keen's deadline fired. If it already resolved, pending is gone
    ::  and this is a harmless no-op; otherwise clean up and answer the client.
    ?>  ?=([%behn %wake *] sign-arvo)
    =/  eid=@ta  i.t.wire
    ?~  (~(get by pending.state) eid)  `this
    =.  pending.state  (~(del by pending.state) eid)
    [(respond-json-cards eid 504 '{"error":"no response from peer"}') this]
  ::
      [%walk @ta @ta ~]
    ::  a revision in a walk-to-latest fetch resolved (or returned no value).
    ?>  ?=([%ames %sage *] sign-arvo)
    =/  fmt=@ta  i.t.wire
    =/  eid=@ta  i.t.t.wire
    ?~  fet=(~(get by fetches.state) eid)
      ::  the walk already finished (timer fired) — a late sage, ignore.
      `this
    =/  target=tape  (urb-of ship.u.fet spur.u.fet)
    =/  ourpatp=tape  (trip (scot %p our.bowl))
    =/  gag  q.sage.sign-arvo
    ?@  gag
      ::  no value at the probed rev → the best so far is the latest. Answer it.
      =.  fetches.state  (~(del by fetches.state) eid)
      =/  resp=(list card)
        ?:  =(0 rev.u.fet)  (fetch-fail fmt ourpatp eid target 404 '{"error":"not found"}' "not found")
        (fetch-respond fmt ourpatp eid target mark.u.fet body.u.fet)
      [[(walk-rest-card fmt eid deadline.u.fet) resp] this]
    ?^  q.gag
      ::  malformed (non-cord) value from the peer — answer best-so-far, stop.
      =.  fetches.state  (~(del by fetches.state) eid)
      =/  resp=(list card)
        ?:  =(0 rev.u.fet)  (fetch-fail fmt ourpatp eid target 502 '{"error":"malformed remote value"}' "malformed value from peer")
        (fetch-respond fmt ourpatp eid target mark.u.fet body.u.fet)
      [[(walk-rest-card fmt eid deadline.u.fet) resp] this]
    ::  resolved rev (rev.u.fet+1): record content, probe the next, slide deadline
    =/  got=@ud   +(rev.u.fet)
    =/  body=@t   ;;(@t q.gag)
    ?:  (gte got walk-max)
      ::  runaway walk (a peer answering every revision) — stop and return the
      ::  highest rev we reached rather than looping forever.
      =.  fetches.state  (~(del by fetches.state) eid)
      :_  this
      [(walk-rest-card fmt eid deadline.u.fet) (fetch-respond fmt ourpatp eid target p.gag body)]
    =/  nat=@da   (add now.bowl ~s2)
    =.  fetches.state
      (~(put by fetches.state) eid [ship.u.fet spur.u.fet got p.gag body nat])
    :_  this
    :~  (walk-rest-card fmt eid deadline.u.fet)
        (walk-wait-card fmt eid nat)
        (walk-keen-card fmt eid +(got) ship.u.fet spur.u.fet)
    ==
  ::
      [%walkto @ta @ta ~]
    ::  the walk stalled (next rev is pending) → answer with the best rev seen,
    ::  cancel the still-pending /walk keen, and (for the native client) hand off
    ::  to a /browse watch that keeps keening upward so newer revs stream in. The
    ::  web reader (fmt=%html) has no SSE consumer, so it just answers.
    ?>  ?=([%behn %wake *] sign-arvo)
    =/  fmt=@ta  i.t.wire
    =/  eid=@ta  i.t.t.wire
    ?~  fet=(~(get by fetches.state) eid)  `this
    =.  fetches.state  (~(del by fetches.state) eid)
    =/  target=tape  (urb-of ship.u.fet spur.u.fet)
    =/  ourpatp=tape  (trip (scot %p our.bowl))
    =/  yawn=card  (walk-yawn-card fmt eid +(rev.u.fet) ship.u.fet spur.u.fet)
    ?:  =(0 rev.u.fet)
      ::  nothing resolved → no peer; nothing to watch.
      :_  this
      [yawn (fetch-fail fmt ourpatp eid target 504 '{"error":"no response from peer"}' "no response from peer")]
    ?:  =(%html fmt)
      :_  this
      [yawn (fetch-respond fmt ourpatp eid target mark.u.fet body.u.fet)]
    =^  bcards  browse.state  (rebrowse browse.state ship.u.fet spur.u.fet rev.u.fet)
    :_  this
    :*  yawn
        (weld bcards (respond-json-cards eid 200 (mark-and-body mark.u.fet body.u.fet)))
    ==
  ::
      [%follow @ @ @ *]
    ::  a followed revision resolved → advance + re-arm the next rev. Only push
    ::  a fact if the keen actually pended (a real change); resolves that come
    ::  back fast are silent catch-up over already-published history.
    ?>  ?=([%ames %sage *] sign-arvo)
    ::  parse defensively: a stale keen (old wire format / cancelled sub) must
    ::  neither crash nor be mis-applied to the current cursor.
    ::  all the drops below are routine (unsub, duplicate/stale keens,
    ::  tombstoned or malformed peer values) — handle quietly, no console noise.
    ?~  missued=(slaw %da i.t.wire)        `this
    ?~  mrev=(slaw %ud i.t.t.wire)         `this
    ?~  mshp=(slaw %p i.t.t.t.wire)        `this
    =/  issued=@da  u.missued
    =/  rev=@ud     u.mrev
    =/  shp=ship    u.mshp
    =/  spur=path   t.t.t.t.wire
    ::  not (or no longer) subscribed → drop, don't re-arm.
    ?~  cur=(~(get by subs.state) [shp spur])  `this
    ::  resolved a revision we're no longer waiting for (stale/duplicate keen).
    ?.  =(rev +(u.cur))  `this
    =/  gag  q.sage.sign-arvo
    ::  no value (tombstoned) or a non-cord body → stop following this file
    ::  (don't re-arm the same rev — a bad value would hot-loop).
    ?@  gag  `this
    ?^  q.gag  `this
    =/  body=@t   ;;(@t q.gag)
    =/  seen=@ud  rev
    =.  subs.state  (~(put by subs.state) [shp spur] seen)
    =/  live=?  (gth (sub now.bowl issued) ~s10)
    =/  facts=(list card)
      ?.  live  ~
      ~[[%give %fact ~[/updates] %json !>((update-json shp spur body))]]
    :_  this
    ::  bound the follow loop like the walk: a peer answering every revision
    ::  instantly would otherwise spin it without end. Deliver the last fact
    ::  but stop re-arming past the ceiling (no real file has this many revs).
    ?:  (gte seen walk-max)  facts
    (welp facts ~[(follow-card shp spur +(seen) now.bowl)])
  ::
      [%browse @ @ *]
    ::  the browse watch on the page being viewed resolved a newer revision →
    ::  push it to /updates (so a stale first paint upgrades + live edits show)
    ::  and keen the next. Unlike /follow this pushes catch-up too (the user
    ::  needs the latest now), and is single-slot (state.browse).
    ?>  ?=([%ames %sage *] sign-arvo)
    ?~  marev=(slaw %ud i.t.wire)   `this
    ?~  mashp=(slaw %p i.t.t.wire)  `this
    =/  arev=@ud   u.marev
    =/  ashp=ship  u.mashp
    =/  aspur=path  t.t.t.wire
    ::  only act on the current watch's awaited keen; ignore stale/cancelled ones.
    ?~  cur=browse.state  `this
    ?.  =([ashp aspur] [ship.u.cur spur.u.cur])  `this
    ?.  =(arev +(rev.u.cur))  `this
    =/  gag  q.sage.sign-arvo
    ::  tombstoned / malformed value → stop watching (don't hot-loop).
    ?@  gag  `this(browse.state ~)
    ?^  q.gag  `this(browse.state ~)
    =/  body=@t  ;;(@t q.gag)
    ?:  (gte arev walk-max)
      ::  ceiling: deliver the last update but stop climbing.
      :_  this(browse.state ~)
      ~[[%give %fact ~[/updates] %json !>((update-json ashp aspur body))]]
    =.  browse.state  `[ashp aspur arev]
    :_  this
    :~  [%give %fact ~[/updates] %json !>((update-json ashp aspur body))]
        (browse-keen-card ashp aspur +(arev))
    ==
  ==
::
++  on-fail  on-fail:def
--
