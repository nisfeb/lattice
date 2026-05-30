::  /app/lattice - cross-ship gemtext publishing
::
/-  *lattice
/+  default-agent, dbug, verb, *lattice, *catalog, *catalog-analyzer
::
|%
+$  versioned-state  $%(state-0 state-1 state-2 state-3 state-4 state-5 state-6 state-7 state-8 state-9 state-10)
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
::  +obelisk-poke: poke the (optional) %obelisk index agent with one urQL script
::  (database %lattice). Fire-and-forget — obelisk has no scries; we don't await.
++  obelisk-poke
  |=  [=bowl:gall urql=tape]
  ^-  card
  [%pass /obelisk %agent [our.bowl %obelisk] %poke %obelisk-action !>([%tape2 %lattice urql])]
::  Explore-pane async query bridge. obelisk has no scries: we watch its /server
::  (wire /oqw/[eid]), poke the urQL (wire /oqp/[eid]), and answer the held HTTP
::  request when the result %fact lands. Only one query runs at a time, so the
::  next fact on /oqw is unambiguously this query's. /oqt/[eid] is the timeout.
++  obelisk-watch-card
  |=  [=bowl:gall eid=@ta]
  ^-  card
  [%pass /oqw/[eid] %agent [our.bowl %obelisk] %watch /server]
++  obelisk-qpoke-card
  |=  [=bowl:gall eid=@ta urql=tape]
  ^-  card
  [%pass /oqp/[eid] %agent [our.bowl %obelisk] %poke %obelisk-action !>([%tape2 %lattice urql])]
++  obelisk-leave-card
  |=  [=bowl:gall eid=@ta]
  ^-  card
  [%pass /oqw/[eid] %agent [our.bowl %obelisk] %leave ~]
++  obelisk-qwait-card
  |=  [eid=@ta at=@da]
  ^-  card
  [%pass /oqt/[eid] %arvo %b %wait at]
++  obelisk-qrest-card
  |=  [eid=@ta at=@da]
  ^-  card
  [%pass /oqt/[eid] %arvo %b %rest at]
::  +kick-obelisk-query: start one async obelisk query — hold the HTTP
::  request (by eyre-id in oquery), watch obelisk /server, poke the urQL,
::  arm a timeout. The result %fact is answered in on-agent (generic JSON
::  decode via +obelisk-result-json), so EVERY caller — /know-query and
::  the catalog read endpoints — shares one code path and one in-flight
::  slot. 429 if a query is already running; 400 on empty urQL.
++  kick-obelisk-query
  |=  [=bowl:gall eyre-id=@ta urql=tape st=state-10]
  ^-  [(list card) state-10]
  ?.  =(~ oquery.st)
    [(respond-json-cards eyre-id 429 '{"error":"a query is already running"}') st]
  ?:  =(~ urql)
    [(respond-json-cards eyre-id 400 '{"error":"empty query"}') st]
  =/  at=@da  (add now.bowl ~s30)
  =.  oquery.st  `[eyre-id at]
  :_  st
  :~  (obelisk-watch-card bowl eyre-id)
      (obelisk-qpoke-card bowl eyre-id urql)
      (obelisk-qwait-card eyre-id at)
  ==
::  +know-mutate: apply a know-action to the store AND emit its incremental
::  obelisk mirror poke. The mirror is fire-and-forget (empty urQL → no card),
::  so the knowledge store behaves identically whether or not %obelisk is
::  installed. Shared by the HTTP CRUD endpoints and the %lattice-know poke.
++  know-mutate
  |=  [=bowl:gall act=know-action st=state-10]
  ^-  (quip card state-10)
  =/  new=state-10  (do-know now.bowl act st)
  =/  urql=tape  (mirror-urql act new)
  :_  new
  ?~(urql ~ [(obelisk-poke bowl urql)]~)
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
::  +manifest-max: the most page walks one scan will spawn from a single
::  publisher's manifest. Bounds breadth the way walk-max bounds depth — a
::  hostile (or huge) publisher advertising a giant manifest must not make
::  us arm an unbounded number of simultaneous keens + behn timers + state
::  entries. Truncation past this is logged (see +cat-finalize), not silent.
::  A bounded work-queue (K page walks in flight, draining the rest) is the
::  proper long-term shape; this cap is the v1 blast-radius guard.
++  manifest-max  ^-(@ud 1.024)
::  +body-max: the largest page body (bytes) the crawler will analyze + index.
::  A hostile publisher could serve a multi-megabyte page; analyzing + poking
::  it as one obelisk row (plus per-line heading/link rows) would be a heavy,
::  unbounded operation. Oversized pages are skipped + logged, not truncated
::  (a clean skip beats a mid-line cut). 1 MiB is generous for gemtext.
++  body-max  ^-(@ud 1.048.576)
::  +sweep-interval: how often the periodic auto-sweep re-crawls every
::  followed publisher. Generous — content moves slowly and a sweep is a
::  lot of remote scry. The Behn timer on /catalog-sweep carries this.
++  sweep-interval  ^-(@dr ~h6)
::  +arm-sweep-card: (re)arm the periodic-sweep Behn timer for time [at].
++  arm-sweep-card
  |=  at=@da
  ^-  card
  [%pass /catalog-sweep %arvo %b %wait at]
::  +sweep-contacts: the ship set from our %contacts BOOK (the contacts we
::  explicitly added — /v1/book, not the full /v1/all rolodex). Crash-safe via
::  +mule: empty set if %contacts is absent/empty. Book keys are ship patps as
::  @t; +slaw %p validates each (murn drops anything malformed). The sweep
::  unions this with the per-file follows so the catalog indexes every contact,
::  not just publishers we follow.
++  sweep-contacts
  |=  =bowl:gall
  ^-  (set @p)
  =/  res
    %-  mule
    |.  ^-  json
    .^  json  %gx
      (welp /(scot %p our.bowl)/contacts/(scot %da now.bowl) /v1/book/json)
    ==
  ?.  ?=(%& -.res)  ~
  ?.  ?=([%o *] p.res)  ~
  %-  ~(gas in *(set @p))
  %+  murn  ~(tap in ~(key by p.p.res))
  |=(k=@t ^-((unit @p) (slaw %p k)))
::
::  +begin-sweep: start a sweep cycle — enqueue every contact + followed
::  publisher and kick off the first one's manifest walk; the sequential driver
::  in +cat-conclude advances to the next as each publisher's tree drains.
::  No-op if a sweep is already in progress (walks in flight or a non-empty
::  queue) or there are no publishers. Does NOT touch the timer (caller manages).
++  begin-sweep
  |=  [=bowl:gall st=state-10]
  ^-  [(list card) state-10]
  ::  No-op only if a SWEEP is already in progress — a non-empty queue, or a
  ::  %sweep walk in flight. A one-off manual /catalog-scan (origin %scan) must
  ::  NOT block the periodic sweep (else a long scan defers a whole cycle); the
  ::  origin tag is what lets a scan and a sweep coexist. (use !=(~ …), not
  ::  ?=(^ …): the latter narrows sweep-queue.st to empty for the rest of the
  ::  gate, blocking the reassignment below.)
  ?:  ?|  !=(~ sweep-queue.st)
          (lien ~(val by catalog-walks.st) |=(w=catalog-walk ?=(%sweep origin.w)))
      ==
    [~ st]
  ::  Exclude any publisher currently being %scan-crawled from THIS cycle so it
  ::  isn't double-crawled — it was just freshly indexed by the scan anyway.
  ::  (Queued publishers can't start being scanned mid-sweep: the /catalog-scan
  ::  guard rejects a scan of a sweep-queued publisher, so the advance is safe.)
  =/  busy=(set @p)
    %-  ~(gas in *(set @p))
    (turn ~(val by catalog-walks.st) |=(w=catalog-walk publisher.w))
  =/  pubs=(list @p)
    (skip (sweep-publishers subs.st (sweep-contacts bowl) our.bowl) ~(has in busy))
  ?~  pubs  [~ st]
  =/  start  (start-catalog-scan now.bowl i.pubs %sweep)
  =.  catalog-walks.st  (~(put by catalog-walks.st) eid.walk.start cw.walk.start)
  =.  sweep-queue.st  t.pubs
  [cards.start st]
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
::  ──  catalog walk cards  ─────────────────────────────────────────────
::  Same walk-to-latest pattern as the interactive cards above, but on a
::  distinct wire family (/cat-walk and /cat-wait) so the routing logic
::  for catalog walks stays independent of interactive HTTP fetches.
::  No fmt parameter — catalog walks always produce obelisk pokes, never
::  an HTTP response.
::
++  cat-walk-keen-card
  |=  [eid=@ta rev=@ud pub=@p spur=path]
  ^-  card
  [%pass /cat-walk/[eid] %arvo %a %keen ~ pub (keen-path (scot %ud rev) spur)]
::
++  cat-walk-yawn-card
  |=  [eid=@ta rev=@ud pub=@p spur=path]
  ^-  card
  [%pass /cat-walk/[eid] %arvo %a %yawn pub (keen-path (scot %ud rev) spur)]
::
++  cat-walk-wait-card
  |=  [eid=@ta at=@da]
  ^-  card
  [%pass /cat-wait/[eid] %arvo %b %wait at]
::
++  cat-walk-rest-card
  |=  [eid=@ta at=@da]
  ^-  card
  [%pass /cat-wait/[eid] %arvo %b %rest at]
::
::  +cat-mint-eid: synthesize a collision-resistant per-walk id from the
::  bowl's `now` + the (publisher, spur) being walked. Two simultaneous
::  scans of the same (publisher, spur) at the same tick collide and the
::  later one replaces the earlier; in practice now changes per call.
++  cat-mint-eid
  |=  [now=@da pub=@p spur=path]
  ^-  @ta
  (scot %uv (sham now pub spur))
::
::  +start-catalog-scan: kick off a publisher's manifest walk. Returns the
::  walk entry to install + the cards (keen rev 1 + arm the deadline).
::  Shared by the catalog-scan HTTP endpoint (origin %scan) and the sweep
::  driver (origin %sweep). Only %sweep walks advance the sweep-queue.
++  start-catalog-scan
  |=  [now=@da pub=@p origin=?(%scan %sweep)]
  ^-  [walk=[eid=@ta cw=catalog-walk] cards=(list card)]
  =/  eid=@ta   (cat-mint-eid now pub /manifest)
  =/  at=@da    (add now ~s30)
  =/  cw=catalog-walk  [%manifest pub /manifest 0 '' '' at origin]
  :-  [eid cw]
  :~  (cat-walk-keen-card eid 1 pub /manifest)
      (cat-walk-wait-card eid at)
  ==
::
::  +cat-finalize: one catalog walk completed (timeout or no-value at the
::  next rev). Routes the result by action:
::    %manifest → parse the body as gemtext, return per-page walks +
::                cards to start them. The caller installs the walks in
::                state and emits the cards.
::    %page     → run the body through +analyze, build the per-page urQL
::                via +catalog-page-urql, return a single obelisk poke.
::  Returns ([cards new-walks-to-install]). A finalize on a zero-rev walk
::  (peer never responded) yields nothing — the publisher is unreachable
::  this sweep.
::
++  cat-finalize
  |=  [=bowl:gall cw=catalog-walk old-paths=(set path)]
  ^-  $:  cards=(list card)
          walks=(list [eid=@ta walk=catalog-walk])
          paths=(unit (set path))
      ==
  ?:  =(0 rev.cw)  [~ ~ ~]
  ?-  action.cw
      %manifest
    ::  +parse-manifest dedupes; cap the breadth and LOG if we truncated, so a
    ::  giant manifest can't fan out into unbounded keens/timers/state.
    =/  all-paths=(list path)  (parse-manifest body.cw)
    =/  over-cap=?  (gth (lent all-paths) manifest-max)
    ~?  over-cap
      [%catalog-manifest-truncated publisher=publisher.cw seen=(lent all-paths) cap=manifest-max]
    =/  paths=(list path)  (scag manifest-max all-paths)
    =/  new-set=(set path)  (silt paths)
    =/  walks=(list [eid=@ta walk=catalog-walk])
      %+  turn  paths
      |=  p=path
      :-  (cat-mint-eid now.bowl publisher.cw p)
      [%page publisher.cw p 0 '' '' (add now.bowl ~s30) origin.cw]
    =/  spawn-cards=(list card)
      %-  zing
      %+  turn  walks
      |=  w=[eid=@ta walk=catalog-walk]
      :~  (cat-walk-keen-card eid.w 1 publisher.walk.w spur.walk.w)
          (cat-walk-wait-card eid.w deadline.walk.w)
      ==
    ::  Record this publisher's manifest snapshot in obelisk (publisher,
    ::  scanned, hash, raw). Durable + queryable; complements the in-state
    ::  path-set cache returned below (which drives the diff + is-internal).
    =/  write-card=card
      %+  obelisk-poke  bowl
      (catalog-manifest-urql publisher.cw now.bowl (sham body.cw) body.cw)
    ::  Empty parse (rev>0 but no `=> ` lines yielded a valid spur) is treated
    ::  as a transient / unparseable fetch — NOT "the publisher deleted
    ::  everything". A remote scry can serve a stale-empty revision, and a
    ::  manifest-format change would parse to nothing; either would otherwise
    ::  make the diff below wipe the publisher's WHOLE catalog. So on an empty
    ::  parse we skip the diff AND leave the path-set cache untouched (paths=~),
    ::  so a recovered manifest next sweep still diffs against the last-good
    ::  set. (A publisher that genuinely empties keeps slightly-stale rows
    ::  until it republishes something — an acceptable trade for not nuking a
    ::  whole catalog on one bad fetch.)
    ?~  paths
      [~[write-card] ~ ~]
    ::  manifest-diff deletion: any page in the PRIOR manifest set (old-paths)
    ::  that is gone from the new set has dropped out of the publisher's index
    ::  — delete its catalog rows (pages/headings/links/tags/pending). On the
    ::  first crawl old-paths is empty, so this is a no-op. Bounded by the prior
    ::  set size (itself <= manifest-max).
    ::
    ::  BUT skip the diff entirely when the manifest was TRUNCATED (over-cap):
    ::  new-set is then only the first manifest-max spurs, so a page beyond the
    ::  cap — still live — would diff as "vanished" and have its rows (and any
    ::  classification) wrongly deleted. With >manifest-max pages the retained
    ::  window can also churn at the boundary between sweeps as the publisher's
    ::  page set changes, repeatedly deleting live pages. Treating an over-cap
    ::  manifest as authoritative-incomplete (no deletes) is the safe choice;
    ::  the cost is that a genuinely-removed page on a >cap publisher keeps
    ::  stale rows. We still spawn page walks + cache new-set (for is-internal).
    =/  delete-cards=(list card)
      ?:  over-cap  ~
      %+  turn  ~(tap in (~(dif in old-paths) new-set))
      |=  p=path
      (obelisk-poke bowl (catalog-page-delete-urql our.bowl publisher.cw p))
    :+  :(weld ~[write-card] delete-cards spawn-cards)
      walks
    `new-set
  ::
      %page
    ::  An oversized page can't be safely analyzed/indexed — a hostile publisher
    ::  must not turn one page into a giant obelisk poke. PURGE any rows it has
    ::  from a prior (smaller) crawl so search can't keep returning stale
    ::  postings/content for a body we can no longer index; a never-seen
    ::  oversized page just no-ops the DELETE.
    ?:  (gth (met 3 body.cw) body-max)
      ~&  [%catalog-page-too-large publisher=publisher.cw spur=spur.cw bytes=(met 3 body.cw)]
      :+  ~[(obelisk-poke bowl (catalog-page-delete-urql our.bowl publisher.cw spur.cw))]
        ~
      ~
    =/  =analysis  (analyze body.cw)
    ::  Two-poke upsert (see +catalog-page-ensure-urql / -refresh-urql): the
    ::  ensure-INSERT is harmless-on-conflict, the refresh-UPDATE touches only
    ::  content — so a periodic re-crawl never clobbers a classification.
    ::  old-paths here is the publisher's CURRENT manifest set (stored when its
    ::  manifest finalized, before these page walks), used to resolve which
    ::  links are internal.
    =/  ensure=tape  (catalog-page-ensure-urql our.bowl publisher.cw spur.cw now.bowl analysis)
    =/  refresh=tape
      (catalog-page-refresh-urql our.bowl publisher.cw spur.cw now.bowl analysis old-paths)
    ::  third poke: the inverted-index postings (feature B). Its OWN poke (not
    ::  welded to ensure/refresh) so a bad term aborts only the index write —
    ::  the page row + classification, already written above, are untouched. The
    ::  body (body.cw) is read only by +analyze and is dropped with the walk; no
    ::  body text reaches obelisk, only the derived (term, tf) postings.
    =/  terms=tape  (catalog-page-terms-urql our.bowl publisher.cw spur.cw analysis)
    :+  ~[(obelisk-poke bowl ensure) (obelisk-poke bowl refresh) (obelisk-poke bowl terms)]
      ~
    ~
  ==
::  +cat-conclude: finish ONE catalog walk — drop it from the in-flight
::  map, run +cat-finalize, and merge any page-walks it spawned BACK INTO
::  the live map. Returns the finalize cards + the updated map; the caller
::  prepends its own timer card (rest on a resolved finish, yawn on a
::  deadline). Use +gas, NOT +roll seeded from `acc=_catalog-walks.state`
::  — that seeds from the bunt (empty map) and would wipe every OTHER
::  in-flight walk on each finalize (so in a multi-page crawl the pages
::  wipe each other and only one survives).
++  cat-conclude
  |=  $:  =bowl:gall
          eid=@ta
          cw=catalog-walk
          walks=(map @ta catalog-walk)
          queue=(list @p)
          pubpaths=(map @p (set path))
      ==
  ^-  $:  cards=(list card)
          walks=(map @ta catalog-walk)
          queue=(list @p)
          pubpaths=(map @p (set path))
      ==
  ::  old-paths = the publisher's last-known manifest set (empty if never
  ::  crawled). A %manifest finalize diffs against it (delete vanished) and
  ::  returns the new set; a %page finalize reads it to mark internal links.
  =/  old-paths=(set path)  (~(gut by pubpaths) publisher.cw ~)
  =/  fin  (cat-finalize bowl cw old-paths)
  ::  store the publisher's refreshed manifest set (manifest finalize only;
  ::  paths.fin is ~ for a page finalize, leaving the cache untouched).
  =/  pubpaths2=(map @p (set path))
    ?~  paths.fin  pubpaths
    (~(put by pubpaths) publisher.cw u.paths.fin)
  ::  drop this walk, merge any page-walks it spawned into the live map
  ::  (gas, not roll — see the comment on the original bug).
  =/  walks2=(map @ta catalog-walk)  (~(gas by (~(del by walks) eid)) walks.fin)
  ::  A %scan walk (one-off manual /catalog-scan) must NEVER advance the
  ::  sweep-queue: otherwise a manual scan of an unrelated publisher, finishing
  ::  mid-sweep, would pop the next sweep publisher early and run two publishers
  ::  concurrently (breaking the sequential one-publisher load bound). Only a
  ::  %sweep walk's drain advances the queue. (The /catalog-scan guard already
  ::  prevents a manual scan from targeting a walking/queued sweep publisher, so
  ::  %scan and %sweep walks never share a publisher.)
  ?:  =(%scan origin.cw)
    [cards.fin walks2 queue pubpaths2]
  ::  sequential sweep advance: if this %sweep walk's publisher now has NO walks
  ::  left (its whole tree drained), start the next queued publisher. Page
  ::  walks the manifest just spawned are already in walks2, so a publisher
  ::  mid-tree still shows walks and we don't advance early.
  ?:  (lien ~(val by walks2) |=(w=catalog-walk =(publisher.w publisher.cw)))
    [cards.fin walks2 queue pubpaths2]
  ?~  queue  [cards.fin walks2 ~ pubpaths2]
  =/  nxt  (start-catalog-scan now.bowl i.queue %sweep)
  :*  (weld cards.fin cards.nxt)
      (~(put by walks2) eid.walk.nxt cw.walk.nxt)
      t.queue
      pubpaths2
  ==
::
::  +catalog-classify-cards: build the obelisk poke that writes a
::  classification onto one of OUR catalog rows. Shared by the HTTP
::  /catalog-classify endpoint and the %lattice-catalog poke action (the
::  MCP path), so both validate + emit identically. The row key is
::  (source = our, publisher + path from the url). Returns ~ if the url
::  isn't a well-formed urb:// link (the caller turns that into a 400 /
::  ignored poke). The UPDATE itself no-ops on a url that matches no row.
++  catalog-classify-cards
  |=  [=bowl:gall url=@t category=@t cat-source=@t confidence=@rs]
  ^-  (list card)
  ?~  parsed=(parse-urb-url url)  ~
  =/  urql=tape
    %:  catalog-classify-urql
      our.bowl  ship.u.parsed  path.u.parsed  category  cat-source  confidence
    ==
  ~[(obelisk-poke bowl urql)]
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
  |=  [=bowl:gall eyre-id=@ta =inbound-request:eyre st=state-10]
  ^-  [(list card) state-10]
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
    ::  require a body — a bodyless POST must not silently blank the page.
    ?~  body.request.inbound-request
      [(respond-json-cards eyre-id 400 '{"error":"missing body"}') st]
    =/  body=@t  q.u.body.request.inbound-request
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
  ::  GET /apps/lattice/know-all — live items WITH bodies + tags (for backup).
  ?:  &(=(meth %'GET') =(action 'know-all'))
    [(respond-json-cards eyre-id 200 (en:json:html (know-all-json know.st))) st]
  ::  GET /apps/lattice/know-read?key=<key> — one item with its body
  ::  GET /apps/lattice/know-tags — the tag vocabulary + counts (facet data)
  ?:  &(=(meth %'GET') =(action 'know-tags'))
    [(respond-json-cards eyre-id 200 (en:json:html (know-tags-json know.st))) st]
  ::  GET /apps/lattice/know-explore?tags=a,b&match=all|any&q=text — faceted
  ::  filter over the live store. tags = comma-separated; match defaults to
  ::  "any"; q = case-insensitive substring of the key or body. Returns the
  ::  know-list shape. Served from state — independent of %obelisk.
  ?:  &(=(meth %'GET') =(action 'know-explore'))
    =/  tags=(set @t)  (parse-tags (fall (query-param inbound-request 'tags') ''))
    =/  all=?  =('all' (fall (query-param inbound-request 'match') 'any'))
    =/  q=@t   (fall (query-param inbound-request 'q') '')
    =/  hits=(map path know-entry)  (know-explore know.st tags all q)
    [(respond-json-cards eyre-id 200 (en:json:html (know-list-json hits))) st]
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
    ::  require a body — a bodyless POST must not silently blank an existing note.
    ?~  body.request.inbound-request
      [(respond-json-cards eyre-id 400 '{"error":"missing body"}') st]
    =/  body=@t  q.u.body.request.inbound-request
    =^  mcards=(list card)  st  (know-mutate bowl [%save u.k body] st)
    [(weld (respond-json-cards eyre-id 200 '{"ok":true}') mcards) st]
  ::  POST /apps/lattice/know-delete?key=<key>  (soft → trash)
  ?:  &(=(meth %'POST') =(action 'know-delete'))
    ?~  k=(query-param inbound-request 'key')
      [(respond-json-cards eyre-id 400 '{"error":"missing key"}') st]
    =^  mcards=(list card)  st  (know-mutate bowl [%del u.k] st)
    [(weld (respond-json-cards eyre-id 200 '{"ok":true}') mcards) st]
  ::  POST /apps/lattice/know-restore?key=<key>
  ?:  &(=(meth %'POST') =(action 'know-restore'))
    ?~  k=(query-param inbound-request 'key')
      [(respond-json-cards eyre-id 400 '{"error":"missing key"}') st]
    =^  mcards=(list card)  st  (know-mutate bowl [%restore u.k] st)
    [(weld (respond-json-cards eyre-id 200 '{"ok":true}') mcards) st]
  ::  POST /apps/lattice/know-tag?key=<key>&tag=<tag>  — add a cross-cutting tag
  ?:  &(=(meth %'POST') =(action 'know-tag'))
    ?~  k=(query-param inbound-request 'key')
      [(respond-json-cards eyre-id 400 '{"error":"missing key"}') st]
    ?~  t=(query-param inbound-request 'tag')
      [(respond-json-cards eyre-id 400 '{"error":"missing tag"}') st]
    =^  mcards=(list card)  st  (know-mutate bowl [%tag u.k u.t] st)
    [(weld (respond-json-cards eyre-id 200 '{"ok":true}') mcards) st]
  ::  POST /apps/lattice/know-untag?key=<key>&tag=<tag>  — remove a tag
  ?:  &(=(meth %'POST') =(action 'know-untag'))
    ?~  k=(query-param inbound-request 'key')
      [(respond-json-cards eyre-id 400 '{"error":"missing key"}') st]
    ?~  t=(query-param inbound-request 'tag')
      [(respond-json-cards eyre-id 400 '{"error":"missing tag"}') st]
    =^  mcards=(list card)  st  (know-mutate bowl [%untag u.k u.t] st)
    [(weld (respond-json-cards eyre-id 200 '{"ok":true}') mcards) st]
  ::  POST /apps/lattice/know-reindex — (re)build the obelisk index from state.
  ::  No-op (ok:false) if %obelisk isn't installed; the store works without it.
  ?:  &(=(meth %'POST') =(action 'know-reindex'))
    =/  cards=(list card)
      :~  (obelisk-poke bowl obelisk-create-urql)
          (obelisk-poke bowl (obelisk-populate-urql know.st))
      ==
    [(weld (respond-json-cards eyre-id 200 '{"ok":true}') cards) st]
  ::  POST /apps/lattice/know-query  body=<urQL> — run one urQL query against the
  ::  obelisk index and return {ok, action, relation, count, columns, rows}. ASYNC:
  ::  hold this request (by eyre-id), watch obelisk /server + poke the query, and
  ::  answer from on-agent when the result %fact arrives. Only one at a time.
  ?:  &(=(meth %'POST') =(action 'know-query'))
    =/  urql=tape
      ?~(body.request.inbound-request "" (trip q.u.body.request.inbound-request))
    (kick-obelisk-query bowl eyre-id urql st)
  ::  ── catalog reads (owner-only, via the same async obelisk bridge) ──
  ::  All compile to urQL in /lib/catalog and run through +kick-obelisk-query,
  ::  so the result JSON shape matches /know-query (ok, columns, rows).
  ::  GET /apps/lattice/catalog-list — every catalog page, newest first.
  ?:  &(=(meth %'GET') =(action 'catalog-list'))
    (kick-obelisk-query bowl eyre-id catalog-list-urql st)
  ::  GET /apps/lattice/catalog-explore?category=&publisher=&source=
  ::  Equality filters, AND-ed; any omitted. publisher/source are @p — we
  ::  +slaw-validate them and pass the canonical scot form so only a
  ::  well-formed ship literal reaches the (bare, unquoted) interpolation.
  ?:  &(=(meth %'GET') =(action 'catalog-explore'))
    =/  cat=tape  ?~(c=(query-param inbound-request 'category') "" (trip u.c))
    =/  pp=(unit @t)  (query-param inbound-request 'publisher')
    =/  sp=(unit @t)  (query-param inbound-request 'source')
    =/  pub=(unit @p)  ?~(pp ~ (slaw %p u.pp))
    =/  src=(unit @p)  ?~(sp ~ (slaw %p u.sp))
    ::  a present-but-unparseable @p filter is a 400 — NOT silently dropped to
    ::  "" (which +catalog-explore-urql treats as "filter absent" and would
    ::  return the FULL catalog, a broader result than the caller expressed).
    ?:  &(?=(^ pp) ?=(~ pub))
      [(respond-json-cards eyre-id 400 '{"error":"bad publisher"}') st]
    ?:  &(?=(^ sp) ?=(~ src))
      [(respond-json-cards eyre-id 400 '{"error":"bad source"}') st]
    =/  pubt=tape  ?~(pub "" (trip (scot %p u.pub)))
    =/  srct=tape  ?~(src "" (trip (scot %p u.src)))
    (kick-obelisk-query bowl eyre-id (catalog-explore-urql cat pubt srct) st)
  ::  GET /apps/lattice/catalog-fetch?url=urb://~ship/path — one full row.
  ?:  &(=(meth %'GET') =(action 'catalog-fetch'))
    ?~  url=(query-param inbound-request 'url')
      [(respond-json-cards eyre-id 400 '{"error":"missing url param"}') st]
    (kick-obelisk-query bowl eyre-id (catalog-fetch-urql (trip u.url)) st)
  ::  GET /apps/lattice/catalog-by-tag?tag=<tag> — page keys carrying tag.
  ?:  &(=(meth %'GET') =(action 'catalog-by-tag'))
    ?~  tag=(query-param inbound-request 'tag')
      [(respond-json-cards eyre-id 400 '{"error":"missing tag param"}') st]
    (kick-obelisk-query bowl eyre-id (catalog-by-tag-urql (trip u.tag)) st)
  ::  GET /apps/lattice/catalog-search?term=<term> — page keys + in-page tf
  ::  for one body term (feature B). The client normalizes each query word,
  ::  fans out one call per word, then ranks (TF-IDF) + joins to catalog rows.
  ?:  &(=(meth %'GET') =(action 'catalog-search'))
    ?~  term=(query-param inbound-request 'term')
      [(respond-json-cards eyre-id 400 '{"error":"missing term param"}') st]
    ::  Normalize the query term with the SAME +normalize-term the crawler used
    ::  to build the index, so the client can never drift from the stored
    ::  postings. A non-indexable term (too short / a stop word) matches nothing
    ::  — return an empty result in the obelisk JSON shape, no query.
    =/  norm=(unit @t)  (normalize-term (trip u.term))
    ?~  norm
      :_  st
      (respond-json-cards eyre-id 200 '{"ok":true,"columns":["source","publisher","path","tf"],"rows":[]}')
    (kick-obelisk-query bowl eyre-id (catalog-search-urql (trip u.norm)) st)
  ::  GET /apps/lattice/catalog-meta — author-declared summaries (source,
  ::  publisher, path, summary); the client joins these onto the loaded rows.
  ?:  &(=(meth %'GET') =(action 'catalog-meta'))
    (kick-obelisk-query bowl eyre-id catalog-meta-list-urql st)
  ::  ── classifier pipeline (owner-only) ──
  ::  GET /apps/lattice/catalog-pending — the worklist: pages not yet
  ::  classified (category = ''), newest first. The LLM classifier reads a
  ::  batch off the front.
  ?:  &(=(meth %'GET') =(action 'catalog-pending'))
    (kick-obelisk-query bowl eyre-id catalog-pending-list-urql st)
  ::  GET /apps/lattice/catalog-vocab — the live category vocabulary (one row
  ::  per page; caller dedupes + drops ''). Read this to reuse categories.
  ?:  &(=(meth %'GET') =(action 'catalog-vocab'))
    (kick-obelisk-query bowl eyre-id catalog-vocab-urql st)
  ::  POST /apps/lattice/catalog-classify?url=urb://~pub/path&category=<c>
  ::    [&cat-source=<s>][&confidence=<f>]
  ::  Write a classification onto one of OUR catalog rows (source = our). A
  ::  fire-and-forget obelisk UPDATE + immediate 200 (the same shape as
  ::  /catalog-scan); the result isn't needed by the caller. cat-source
  ::  defaults to 'manual', confidence to .0. Idempotent: a url that matches
  ::  no row is a clean no-op (UPDATE on absent).
  ?:  &(=(meth %'POST') =(action 'catalog-classify'))
    ?~  raw=(query-param inbound-request 'url')
      [(respond-json-cards eyre-id 400 '{"error":"missing url param"}') st]
    ?~  cat=(query-param inbound-request 'category')
      [(respond-json-cards eyre-id 400 '{"error":"missing category param"}') st]
    =/  csrc=@t  ?~(s=(query-param inbound-request 'cat-source') 'manual' u.s)
    ::  confidence: accept the common "0.7" decimal as well as Hoon's native
    ::  @rs `.7` syntax (leading zero omitted). Anything unparseable → .0.
    =/  conf=@rs
      ?~  c=(query-param inbound-request 'confidence')  .0
      =/  ct=tape  (trip u.c)
      =/  norm=tape  ?:(=("0." (scag 2 ct)) (slag 1 ct) ct)
      ?~(r=(slaw %rs (crip norm)) .0 u.r)
    =/  cards=(list card)  (catalog-classify-cards bowl u.raw u.cat csrc conf)
    ?~  cards
      [(respond-json-cards eyre-id 400 '{"error":"bad urb:// url"}') st]
    :_  st
    (weld cards (respond-json-cards eyre-id 200 '{"ok":true}'))
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
  ::  POST /apps/lattice/catalog-scan?ship=~publisher — kick off a one-shot
  ::  crawl of one publisher: walk /manifest, parse the result, walk every
  ::  spur it lists, analyze each body, poke %obelisk with the catalog row
  ::  inserts. Replies 200 immediately; the crawl runs in the background.
  ?:  &(=(meth %'POST') =(action 'catalog-scan'))
    ?~  raw=(query-param inbound-request 'ship')
      [(respond-json-cards eyre-id 400 '{"error":"missing ship param"}') st]
    ?~  pub=(slaw %p u.raw)
      [(respond-json-cards eyre-id 400 '{"error":"bad ship"}') st]
    ?:  =(u.pub our.bowl)
      [(respond-json-cards eyre-id 400 '{"error":"cannot crawl own ship"}') st]
    ::  in-flight guard: if any walk (manifest or page) for this publisher is
    ::  already running, OR it is queued in an in-progress sweep, don't start a
    ::  second tree — a repeated scan (UI double-click, or deliberate
    ::  amplification) would otherwise spawn a parallel fan-out, and a scan of a
    ::  sweep-queued publisher would be double-crawled when the sweep reaches it
    ::  (the two trees mint different eids from different `now`, so the walk map
    ::  doesn't de-dup them). Idempotent: report success, the pending crawl stands.
    ?:  ?|  (lien ~(val by catalog-walks.st) |=(w=catalog-walk =(publisher.w u.pub)))
            (lien sweep-queue.st |=(p=@p =(p u.pub)))
        ==
      [(respond-json-cards eyre-id 200 '{"ok":true,"note":"scan already in progress"}') st]
    =/  start  (start-catalog-scan now.bowl u.pub %scan)
    =.  catalog-walks.st  (~(put by catalog-walks.st) eid.walk.start cw.walk.start)
    :_  st
    (weld cards.start (respond-json-cards eyre-id 200 '{"ok":true}'))
  ::  POST /apps/lattice/catalog-sweep — refresh EVERY followed publisher's
  ::  catalog now (the same cycle the periodic timer runs). Sequential: starts
  ::  the first publisher, queues the rest; each finishes before the next.
  ::  No-op (with a note) if a sweep is already in progress.
  ?:  &(=(meth %'POST') =(action 'catalog-sweep'))
    =^  cards  st  (begin-sweep bowl st)
    [(weld cards (respond-json-cards eyre-id 200 '{"ok":true}')) st]
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
=|  state-10
=*  state  -
^-  agent:gall
|_  =bowl:gall
+*  this  .
    def   ~(. (default-agent this %|) bowl)
::
++  on-init
  ^-  (quip card _this)
  ::  Fresh install: no content yet. Grow the (empty) discovery manifest + home
  ::  so a remote probe resolves them instead of pending. Also poke %obelisk
  ::  with the schema -- harmless if %obelisk is not installed (the poke just
  ::  dies); idempotent if the tables already exist.
  =^  man-cards  manifest.state  (manifest-cards content.state `@uvH`0)
  =^  home-cs    home.state      (home-cards content.state `@uvH`0)
  ::  arm the first periodic catalog sweep.
  =/  sweep-at=@da  (add now.bowl sweep-interval)
  =.  catalog-sweep.state  `sweep-at
  ::  Poke the obelisk schema: obelisk-create-urql FIRST (it has the
  ::  `CREATE DATABASE lattice` the catalog tables need; on an existing db that
  ::  statement harmlessly aborts its own poke), then each +catalog-create-list
  ::  table as its OWN poke — a joined CREATE poke aborts at the first existing
  ::  table and never creates the rest (see the note on +catalog-create-list).
  :_  this
  ;:  weld
    ~[(bind-eyre-card bowl) (obelisk-poke bowl obelisk-create-urql)]
    (turn catalog-create-list |=(u=tape (obelisk-poke bowl u)))
    ~[(arm-sweep-card sweep-at)]
    (weld man-cards home-cs)
  ==
::
++  on-save  !>(state)
::
++  on-load
  |=  ole=vase
  ^-  (quip card _this)
  =/  old=versioned-state  !<(versioned-state ole)
  ::  Every reload pokes %obelisk with the schema so the catalog + knowledge
  ::  tables self-bootstrap whenever lattice loads with %obelisk present (no
  ::  manual /know-reindex needed). obelisk-create-urql goes FIRST: it carries
  ::  the `CREATE DATABASE lattice` the catalog tables require, and on a ship
  ::  where the db already exists that statement aborts its OWN (separate) poke
  ::  harmlessly. Each catalog CREATE TABLE is poked SEPARATELY (not joined):
  ::  CREATE on an existing table errors + aborts its poke, so a joined poke
  ::  would abort at the first existing table and never create the rest (which
  ::  silently dropped catalog-terms/catalog-meta on an in-place upgrade).
  ::  Harmless if %obelisk isn't installed (the pokes just die).
  =/  schema-cards=(list card)
    :-  (obelisk-poke bowl obelisk-create-urql)
    (turn catalog-create-list |=(u=tape (obelisk-poke bowl u)))
  ::  Boot cards: the schema pokes, plus — on ANY upgrade INTO the catalog state
  ::  (from a released ship, ≤ %9) — arm the periodic sweep. state-10 is the
  ::  first version with the sweep machinery, so only a %10 → %10 reload already
  ::  has the Behn timer in flight (it survives agent reload and the fire-handler
  ::  re-arms it); arming again would stack a duplicate. So we skip the arm ONLY
  ::  for the %10 reload.
  =/  armed=?  ?=(%10 -.old)
  =/  boot-cards=(list card)
    ?:  armed  schema-cards
    (weld schema-cards ~[(arm-sweep-card (add now.bowl sweep-interval))])
  ::  When we arm the sweep here (an upgrade, armed=.n), record the deadline in
  ::  state too, so catalog-sweep matches the in-flight timer instead of staying
  ::  ~ ("none armed") until the first fire. No-op for the %10 reload (its state
  ::  already holds the live deadline).
  =/  ready
    |=  s=state-10
    ^-  state-10
    ?:  armed  s
    s(catalog-sweep `(add now.bowl sweep-interval))
  ::  %10 → %10 reload: state unchanged (catalog feature already running).
  ?:  ?=(%10 -.old)
    :_  this(state old)
    boot-cards
  ::  %9 → %10: the single catalog migration (carry all + 4 empty catalog slots).
  ?:  ?=(%9 -.old)
    :_  this(state (ready (migrate-9-10 old)))
    boot-cards
  ::  %8 → %10: add the obelisk-query slot (8→9), then 9→10.
  ?:  ?=(%8 -.old)
    :_  this(state (ready (migrate-9-10 (migrate-8-9 old))))
    boot-cards
  ::  %7 → %10: give every knowledge entry empty tags + reserved vector,
  ::  then chain up.
  ?:  ?=(%7 -.old)
    =/  up=$-(know-entry-7 know-entry)  |=(e=know-entry-7 [body.e updated.e ~ ~])
    =/  s9=state-9
      :*  %9  content.old  published.old  pending.old  subs.old  fetches.old
          manifest.old  home.old  browse.old
          (~(run by know.old) up)  (~(run by trash.old) up)  ~
      ==
    :_  this(state (ready (migrate-9-10 s9)))
    boot-cards
  ::  %6 → %10: add the empty private knowledge store, then chain up.
  ?:  ?=(%6 -.old)
    =/  s9=state-9
      :*  %9  content.old  published.old  pending.old  subs.old  fetches.old
          manifest.old  home.old  browse.old  ~  ~  ~
      ==
    :_  this(state (ready (migrate-9-10 s9)))
    boot-cards
  ::  Versions 0-5 stored published content in Clay /pub. Pull it into state,
  ::  then delete /pub from the desk + drop the clay watch, so the desk stops
  ::  carrying the content (and installs stop shipping the publisher's pages).
  ::  Finally, migrate the resulting state-9 up to state-10.
  =/  content=(map path @t)  (migrate-content bowl)
  =/  files=(set path)       ~(key by content)
  =/  cards=(list card)      (clear-pub-cards bowl files)
  =/  new=state-9
    ?-  -.old
      %5  [%9 content published.old pending.old subs.old fetches.old manifest.old home.old browse.old ~ ~ ~]
      %4  [%9 content published.old pending.old subs.old fetches.old manifest.old home.old ~ ~ ~ ~]
      %3  [%9 content published.old pending.old subs.old fetches.old manifest.old `@uvH`0 ~ ~ ~ ~]
      %2  [%9 content published.old pending.old subs.old fetches.old `@uvH`0 `@uvH`0 ~ ~ ~ ~]
      %1  [%9 content published.old pending.old subs.old ~ `@uvH`0 `@uvH`0 ~ ~ ~ ~]
      %0  [%9 content published.old pending.old ~ ~ `@uvH`0 `@uvH`0 ~ ~ ~ ~]
    ==
  :_  this(state (ready (migrate-9-10 new)))
  (weld cards boot-cards)
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
    =^  cards  state  (know-mutate bowl act state)
    [cards this]
  ::
  ::  programmatic catalog writes (the LLM classifier via MCP). src==our is
  ::  enforced above. Reads stay on HTTP (obelisk is async); this is the one
  ::  catalog WRITE an MCP tool can drive — a fire-and-forget classification.
      %lattice-catalog
    =+  !<(act=catalog-action q.cage)
    ?-  -.act
        %classify
      :_  this
      (catalog-classify-cards bowl url.act category.act cat-source.act confidence.act)
    ==
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
      [%x %know %tags ~]   ``json+!>((know-tags-json know.state))
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
::  on-agent: the only gall subscription we keep is the Explore-pane obelisk
::  query (wire /oqw = the /server watch, /oqp = the urQL poke). Everything else
::  (mirror pokes on /obelisk, etc.) is fire-and-forget and ignored. The oquery
::  guard means a signal for a stale/finished query is a no-op.
++  on-agent
  |=  [=wire =sign:agent:gall]
  ^-  (quip card _this)
  ?.  ?=([?(%oqw %oqp) @ta ~] wire)  `this
  ::  copy into `cur` and refine that, so oquery.state stays assignable to ~.
  =/  cur  oquery.state
  ?~  cur  `this
  =/  eid=@ta  i.t.wire
  ?.  =(eid eid.u.cur)  `this
  =/  clear=card  (obelisk-qrest-card eid deadline.u.cur)
  ::  +finish: clear the in-flight query, rest the timer, optionally LEAVE the
  ::  /server subscription (only when it's still open — the poke-nack path; on a
  ::  %fact/%kick obelisk already kicked us, and a nacked %watch never subscribed).
  =/  finish
    |=  [leave=? status=@ud body=@t]
    ^-  (quip card _this)
    =.  oquery.state  ~
    =/  pre=(list card)  ?:(leave ~[clear (obelisk-leave-card bowl eid)] ~[clear])
    [(weld pre (respond-json-cards eid status body)) this]
  ?-  i.wire
      %oqw
    ?+  -.sign  `this
        %watch-ack
      ?~  p.sign  `this   :: subscribed OK — await the result fact
      (finish | 503 '{"error":"obelisk not installed"}')
    ::
        %fact
      (finish | 200 (en:json:html (obelisk-result-json q.q.cage.sign)))
    ::
        %kick
      (finish | 502 '{"error":"obelisk closed the connection"}')
    ==
  ::
      %oqp
    ?.  ?=(%poke-ack -.sign)  `this
    ?~  p.sign  `this   :: poke accepted — the fact arrives on /oqw
    (finish & 503 '{"error":"obelisk rejected the query poke"}')
  ==
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
      [%oqt @ta ~]
    ::  the obelisk query deadline fired. If the result already arrived, oquery is
    ::  cleared and this is a no-op; otherwise answer the held request with 504.
    ?>  ?=([%behn %wake *] sign-arvo)
    =/  eid=@ta  i.t.wire
    ::  copy into `cur` and refine that, so oquery.state stays assignable to ~.
    =/  cur  oquery.state
    ?~  cur  `this
    ?.  =(eid eid.u.cur)  `this
    =.  oquery.state  ~
    ::  leave the /server watch we opened — obelisk never kicked us, so it'd leak.
    :_  this
    :-  (obelisk-leave-card bowl eid)
    (respond-json-cards eid 504 '{"error":"obelisk query timed out"}')
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
      [%cat-walk @ta ~]
    ::  one revision of a catalog walk resolved (or returned no value). Same
    ::  walk-to-latest pattern as /walk above, but routes to obelisk on
    ::  finalize instead of an HTTP response.
    ?>  ?=([%ames %sage *] sign-arvo)
    =/  eid=@ta  i.t.wire
    ?~  cw=(~(get by catalog-walks.state) eid)  `this
    =/  gag  q.sage.sign-arvo
    ?@  gag
      ::  no value at probed rev → finalize with the best so far.
      =/  cc  (cat-conclude bowl eid u.cw catalog-walks.state sweep-queue.state catalog-pubpaths.state)
      =.  catalog-walks.state  walks.cc
      =.  sweep-queue.state  queue.cc
      =.  catalog-pubpaths.state  pubpaths.cc
      :_  this
      [(cat-walk-rest-card eid deadline.u.cw) cards.cc]
    ?^  q.gag
      ::  malformed remote value — finalize with best so far.
      =/  cc  (cat-conclude bowl eid u.cw catalog-walks.state sweep-queue.state catalog-pubpaths.state)
      =.  catalog-walks.state  walks.cc
      =.  sweep-queue.state  queue.cc
      =.  catalog-pubpaths.state  pubpaths.cc
      :_  this
      [(cat-walk-rest-card eid deadline.u.cw) cards.cc]
    ::  resolved rev (rev+1): record content, probe next, slide deadline.
    =/  got=@ud   +(rev.u.cw)
    =/  body=@t   ;;(@t q.gag)
    ::  Oversized-body guard. body-max is otherwise only checked at +cat-finalize
    ::  (%page), i.e. AFTER the body is already sitting in catalog-walks.state —
    ::  and one publisher's manifest fans out up to manifest-max concurrent page
    ::  walks, so without this a hostile/large publisher serving big bodies would
    ::  balloon the agent's persisted state with up to ~manifest-max oversized
    ::  cords before any finalize culls them. Stop the walk here WITHOUT storing
    ::  the body (rest the deadline + conclude on the best prior rev). Covers the
    ::  manifest walk too (same branch), so an oversized manifest body is never
    ::  stored/parsed either.
    ?:  (gth (met 3 body) body-max)
      ~&  [%catalog-walk-body-too-large action=action.u.cw publisher=publisher.u.cw spur=spur.u.cw bytes=(met 3 body)]
      =/  cc  (cat-conclude bowl eid u.cw catalog-walks.state sweep-queue.state catalog-pubpaths.state)
      =.  catalog-walks.state  walks.cc
      =.  sweep-queue.state  queue.cc
      =.  catalog-pubpaths.state  pubpaths.cc
      :_  this
      [(cat-walk-rest-card eid deadline.u.cw) cards.cc]
    ?:  (gte got walk-max)
      ::  runaway walk — finalize with what we have (the rev we just got).
      =/  u-cw=catalog-walk  u.cw(rev got, mark p.gag, body body)
      =/  cc  (cat-conclude bowl eid u-cw catalog-walks.state sweep-queue.state catalog-pubpaths.state)
      =.  catalog-walks.state  walks.cc
      =.  sweep-queue.state  queue.cc
      =.  catalog-pubpaths.state  pubpaths.cc
      :_  this
      [(cat-walk-rest-card eid deadline.u.cw) cards.cc]
    =/  nat=@da   (add now.bowl ~s2)
    =.  catalog-walks.state
      %+  ~(put by catalog-walks.state)  eid
      [action.u.cw publisher.u.cw spur.u.cw got p.gag body nat origin.u.cw]
    :_  this
    :*  (cat-walk-rest-card eid deadline.u.cw)
        (cat-walk-wait-card eid nat)
        ~[(cat-walk-keen-card eid +(got) publisher.u.cw spur.u.cw)]
    ==
  ::
      [%cat-wait @ta ~]
    ::  catalog walk deadline fired → finalize with the best rev seen, and
    ::  yawn the still-pending keen on /cat-walk.
    ?>  ?=([%behn %wake *] sign-arvo)
    =/  eid=@ta  i.t.wire
    ?~  cw=(~(get by catalog-walks.state) eid)  `this
    =/  yawn=card
      (cat-walk-yawn-card eid +(rev.u.cw) publisher.u.cw spur.u.cw)
    =/  cc  (cat-conclude bowl eid u.cw catalog-walks.state sweep-queue.state catalog-pubpaths.state)
    =.  catalog-walks.state  walks.cc
    =.  sweep-queue.state  queue.cc
    =.  catalog-pubpaths.state  pubpaths.cc
    [[yawn cards.cc] this]
  ::
      [%catalog-sweep ~]
    ::  the periodic sweep timer fired → begin a sweep cycle (no-op if one is
    ::  already running or there are no follows) and re-arm for next interval.
    ?>  ?=([%behn %wake *] sign-arvo)
    =^  cards  state  (begin-sweep bowl state)
    =/  at=@da  (add now.bowl sweep-interval)
    =.  catalog-sweep.state  `at
    [(snoc cards (arm-sweep-card at)) this]
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
