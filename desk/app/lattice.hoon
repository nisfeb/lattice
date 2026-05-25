::  /app/lattice - cross-ship gemtext publishing
::
/-  *lattice
/+  default-agent, dbug, verb, *lattice
::
|%
+$  versioned-state  $%(state-0 state-1 state-2 state-3)
+$  card  card:agent:gall
::
::  -- helper gates --
::
++  base-path
  |=  =bowl:gall
  ^-  path
  /(scot %p our.bowl)/[q.byk.bowl]/(scot %da now.bowl)
::
++  list-gmi
  |=  =bowl:gall
  ^-  (set path)
  =/  base  (base-path bowl)
  ::  content lives under /pub (NOT /lib — that's for the desk's source hoon
  ::  libraries; mixing user gmi files in would pollute the source tree).
  (walk-dir base /pub *(set path))
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
++  watch-clay-card
  |=  =bowl:gall
  ^-  card
  ::  Watch the desk revision (%w), which advances on EVERY commit — including
  ::  pure content mutations. (%next %z /lib only re-fired on structural changes,
  ::  so content edits weren't re-published.)
  ::  wire name is a stable internal label — do NOT rename it, or an in-flight
  ::  %next watch from a previous version orphans across upgrade (the old wire
  ::  fires into the default handler and the watch is never re-armed).
  [%pass /clay/lib %arvo %c %warp our.bowl q.byk.bowl `[%next %w [%da now.bowl] /]]
::
++  file-hash
  |=  [=bowl:gall pax=path]
  ^-  @uvH
  (sham .^(@t %cx (welp (base-path bowl) pax)))
::
::  the reserved publication spur a remote ship probes to discover whether we
::  publish (and to list our files). Not derived from a /lib file.
++  manifest-spur  `path`/manifest
::
::  +manifest-cards: (re)grow the discovery manifest only when the file set
::  changes. Returns the cards + the new manifest hash. [prev] is the last hash.
++  manifest-cards
  |=  [=bowl:gall prev=@uvH]
  ^-  [(list card) @uvH]
  =/  body=@t  (generate-index (list-gmi bowl))
  =/  h=@uvH   (sham body)
  ?:  =(h prev)  [~ prev]
  [~[[%pass /grow %grow manifest-spur gmi+body]] h]
::
++  publish-card
  |=  [=bowl:gall pax=path]
  ^-  card
  =/  body=@t    .^(@t %cx (welp (base-path bowl) pax))
  =/  spur=path  (snip (slag 1 pax))   ::  drop /pub prefix and trailing /gmi
  [%pass /grow %grow spur gmi+body]
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
++  sync-cards
  |=  [=bowl:gall prev=(map path @uvH)]
  ^-  [(list card) (map path @uvH)]
  =/  current=(set path)  (list-gmi bowl)
  =/  cur=(list path)  ~(tap in current)
  ::  hash every current file once
  =/  next=(map path @uvH)
    %-  ~(gas by *(map path @uvH))
    (turn cur |=(p=path [p (file-hash bowl p)]))
  ::  to-grow: new files, or files whose content hash changed
  =/  to-grow=(list path)
    %+  skim  cur
    |=  p=path
    ?~  o=(~(get by prev) p)  &
    !=(u.o (~(got by next) p))
  ::  to-remove: previously-published paths no longer present
  =/  to-remove=(list path)
    ~(tap in (~(dif in ~(key by prev)) current))
  =/  grows=(list card)  (turn to-grow |=(p=path (publish-card bowl p)))
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
++  read-local
  |=  [=bowl:gall eyre-id=@ta pax=path]
  ^-  (list card)
  =/  base  (base-path bowl)
  ?:  =(~ pax)
    ::  empty path = home page: authored pub/index.gmi if present, else generated
    =/  index-path=path  /pub/index/gmi
    ?:  .^(? %cu (welp base index-path))
      =/  body=@t  .^(@t %cx (welp base index-path))
      (respond-json-cards eyre-id 200 (mark-and-body 'gmi' body))
    (respond-json-cards eyre-id 200 (mark-and-body 'gmi' (generate-index (list-gmi bowl))))
  ::  non-empty path
  =/  full=path  :(welp /pub pax /gmi)
  ?.  .^(? %cu (welp base full))
    (respond-json-cards eyre-id 404 '{"error":"not found"}')
  =/  body=@t  .^(@t %cx (welp base full))
  (respond-json-cards eyre-id 200 (mark-and-body 'gmi' body))
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
++  walk-keen-card
  |=  [eyre-id=@ta rev=@ud =ship spur=path]
  ^-  card
  [%pass /walk/[eyre-id] %arvo %a %keen ~ ship (keen-path (scot %ud rev) spur)]
::
++  walk-yawn-card
  |=  [eyre-id=@ta rev=@ud =ship spur=path]
  ^-  card
  [%pass /walk/[eyre-id] %arvo %a %yawn ship (keen-path (scot %ud rev) spur)]
::
++  walk-wait-card
  |=  [eyre-id=@ta at=@da]
  ^-  card
  [%pass /walkto/[eyre-id] %arvo %b %wait at]
::
++  walk-rest-card
  |=  [eyre-id=@ta at=@da]
  ^-  card
  [%pass /walkto/[eyre-id] %arvo %b %rest at]
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
  |=  =bowl:gall
  ^-  @t
  %-  en:json:html
  %-  pairs:enjs:format
  :_  ~
  :-  'files'
  :-  %a
  %+  turn  ~(tap in (list-gmi bowl))
  |=  pax=path
  ::  /pub/notes/2026/intro/gmi → "notes/2026/intro"
  s+(crip (slag 1 (spud (snip (slag 1 pax)))))
::
::  +write-card: commit a gmi file to our own desk's Clay (%ins new / %mut existing)
++  write-card
  |=  [=bowl:gall full=path content=@t]
  ^-  card
  =/  =miso:clay
    ?:  .^(? %cu (welp (base-path bowl) full))
      [%mut gmi+!>(content)]
    [%ins gmi+!>(content)]
  [%pass /clay-save %arvo %c %info q.byk.bowl [%& ~[[full miso]]]]
::
++  delete-card
  |=  [=bowl:gall full=path]
  ^-  card
  [%pass /clay-save %arvo %c %info q.byk.bowl [%& ~[[full [%del ~]]]]]
::
::  +contacts-json: the ships in our %contacts rolodex as {"ships":[...]}.
::  Crash-safe (mule): {"ships":[]} when %contacts is absent or empty.
++  contacts-json
  |=  =bowl:gall
  ^-  @t
  =/  res
    %-  mule
    |.  ^-  json
    .^  json  %gx
      (welp /(scot %p our.bowl)/contacts/(scot %da now.bowl) /v1/all/json)
    ==
  =/  ships=(list @t)
    ?.  ?=(%& -.res)  ~
    ?.  ?=([%o *] p.res)  ~
    ~(tap in ~(key by p.p.res))
  %-  en:json:html
  (pairs:enjs:format ~[['ships' a+(turn ships |=(s=@t s+s))]])
::
++  handle-http
  |=  [=bowl:gall eyre-id=@ta =inbound-request:eyre st=state-3]
  ^-  [(list card) state-3]
  ::  SECURITY: Eyre forwards ALL matching HTTP requests to us, authenticated or
  ::  not, and leaves enforcement to the agent. This is the owner's control plane
  ::  (mutates Clay, drives keens); public reads happen via remote scry, not here.
  ::  Require a valid ship session for everything.
  ?.  authenticated.inbound-request
    [(respond-json-cards eyre-id 403 '{"error":"unauthorized"}') st]
  =/  meth=@tas  method.request.inbound-request
  =/  action=@t  (req-action inbound-request)
  ::  GET /apps/lattice (the docket tile's site) — redirect a browser to the
  ::  project page (the real UI is the native app, not a web tile).
  ?:  &(=(meth %'GET') =(action 'lattice'))
    [(respond-redirect-cards eyre-id 'https://github.com/nisfeb/lattice') st]
  ::  GET /apps/lattice/list — the published file tree
  ?:  &(=(meth %'GET') =(action 'list'))
    [(respond-json-cards eyre-id 200 (list-files-json bowl)) st]
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
    =/  content=@t
      ?~(body.request.inbound-request '' q.u.body.request.inbound-request)
    :_  st
    [(write-card bowl p.pp content) (respond-json-cards eyre-id 200 '{"ok":true}')]
  ::  POST /apps/lattice/delete?path=<rel>
  ?:  &(=(meth %'POST') =(action 'delete'))
    ?~  rel=(query-param inbound-request 'path')
      [(respond-json-cards eyre-id 400 '{"error":"missing path"}') st]
    =/  pp=(each path tang)  (mule |.((pub-path u.rel)))
    ?:  ?=(%| -.pp)
      [(respond-json-cards eyre-id 400 '{"error":"invalid path"}') st]
    :_  st
    [(delete-card bowl p.pp) (respond-json-cards eyre-id 200 '{"ok":true}')]
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
    [(read-local bowl eyre-id path.u.parsed) st]
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
  ::  Cold-route tolerant: a generous initial deadline, tightened once walking.
  =/  at=@da  (add now.bowl ~s10)
  =.  fetches.st  (~(put by fetches.st) eyre-id [shp spr 0 '' '' at])
  [~[(walk-keen-card eyre-id 1 shp spr) (walk-wait-card eyre-id at)] st]
--
::
%-  agent:dbug
%+  verb  |
=|  state-3
=*  state  -
^-  agent:gall
|_  =bowl:gall
+*  this  .
    def   ~(. (default-agent this %|) bowl)
::
++  on-init
  ^-  (quip card _this)
  ::  on-init runs on first install and after a nuke. A nuke wipes gall's
  ::  publication CONTENT (only the revision counter persists), so we must
  ::  re-grow everything to republish — the resulting revision bump is
  ::  unavoidable. (A normal code upgrade runs on-load instead and keeps
  ::  `published`, so it does NOT re-grow.)
  =^  pub-cards  published.state  (sync-cards bowl *(map path @uvH))
  =^  man-cards  manifest.state  (manifest-cards bowl `@uvH`0)
  :_  this
  :*  (watch-clay-card bowl)
      (bind-eyre-card bowl)
      (weld pub-cards man-cards)
  ==
::
++  on-save  !>(state)
::
++  on-load
  |=  ole=vase
  ^-  (quip card _this)
  =/  old=versioned-state  !<(versioned-state ole)
  ?-  -.old
    %3  `this(state old)
    %2  `this(state [%3 published.old pending.old subs.old fetches.old `@uvH`0])
    %1  `this(state [%3 published.old pending.old subs.old ~ `@uvH`0])
    %0  `this(state [%3 published.old pending.old ~ ~ `@uvH`0])
  ==
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
    =/  files=(set ^path)  (list-gmi bowl)
    :^  ~  ~  %json
    !>  ^-  json
    %-  pairs:enjs:format
    :~  ['count' (numb:enjs:format ~(wyt in files))]
        :-  'paths'
        :-  %a
        %+  turn  ~(tap in files)
        |=(p=^path s+(spat p))
    ==
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
      [%clay %lib ~]
    =^  pub-cards  published.state  (sync-cards bowl published.state)
    =^  man-cards  manifest.state  (manifest-cards bowl manifest.state)
    [[(watch-clay-card bowl) (weld pub-cards man-cards)] this]
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
      [%walk @ta ~]
    ::  a revision in a walk-to-latest fetch resolved (or returned no value).
    ?>  ?=([%ames %sage *] sign-arvo)
    =/  eid=@ta  i.t.wire
    ?~  fet=(~(get by fetches.state) eid)
      ::  the walk already finished (timer fired) — a late sage, ignore.
      `this
    =/  gag  q.sage.sign-arvo
    ?@  gag
      ::  no value at the probed rev → the best so far is the latest. Answer it.
      =.  fetches.state  (~(del by fetches.state) eid)
      =/  resp=(list card)
        ?:  =(0 rev.u.fet)  (respond-json-cards eid 404 '{"error":"not found"}')
        (respond-json-cards eid 200 (mark-and-body mark.u.fet body.u.fet))
      [[(walk-rest-card eid deadline.u.fet) resp] this]
    ?^  q.gag
      ::  malformed (non-cord) value from the peer — answer best-so-far, stop.
      =.  fetches.state  (~(del by fetches.state) eid)
      =/  resp=(list card)
        ?:  =(0 rev.u.fet)  (respond-json-cards eid 502 '{"error":"malformed remote value"}')
        (respond-json-cards eid 200 (mark-and-body mark.u.fet body.u.fet))
      [[(walk-rest-card eid deadline.u.fet) resp] this]
    ::  resolved rev (rev.u.fet+1): record content, probe the next, slide deadline
    =/  got=@ud   +(rev.u.fet)
    =/  body=@t   ;;(@t q.gag)
    ?:  (gte got walk-max)
      ::  runaway walk (a peer answering every revision) — stop and return the
      ::  highest rev we reached rather than looping forever.
      =.  fetches.state  (~(del by fetches.state) eid)
      :_  this
      [(walk-rest-card eid deadline.u.fet) (respond-json-cards eid 200 (mark-and-body p.gag body))]
    =/  nat=@da   (add now.bowl ~s2)
    =.  fetches.state
      (~(put by fetches.state) eid [ship.u.fet spur.u.fet got p.gag body nat])
    :_  this
    :~  (walk-rest-card eid deadline.u.fet)
        (walk-wait-card eid nat)
        (walk-keen-card eid +(got) ship.u.fet spur.u.fet)
    ==
  ::
      [%walkto @ta ~]
    ::  the walk stalled (next rev is pending) → answer with the best rev seen
    ::  and cancel the still-pending keen.
    ?>  ?=([%behn %wake *] sign-arvo)
    =/  eid=@ta  i.t.wire
    ?~  fet=(~(get by fetches.state) eid)  `this
    =.  fetches.state  (~(del by fetches.state) eid)
    =/  resp=(list card)
      ?:  =(0 rev.u.fet)  (respond-json-cards eid 504 '{"error":"no response from peer"}')
      (respond-json-cards eid 200 (mark-and-body mark.u.fet body.u.fet))
    :_  this
    [(walk-yawn-card eid +(rev.u.fet) ship.u.fet spur.u.fet) resp]
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
  ==
::
++  on-fail  on-fail:def
--
