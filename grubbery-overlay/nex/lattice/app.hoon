::  nex/lattice/app: the grubbery-native %lattice application nexus.
::  (rev: post-review hardening batch 2 — trash integrity, catalog cleanup)
::
::  Lattice is now a nexus, not a gall agent. The tree it owns:
::    /main.sig            the action WRITER — takes %know-action / %pub-action
::                         pokes and serialises every mutation (avoids index races)
::    /know/vault/<key>/entry   one know-entry grub per key (private)
::    /know/trash          derived trash index
::    /pub/vault/<spur>    published page grubs (public)
::    /pub/index           derived page index (parity hash)
::    /ui/main.sig         binds /apps/lattice; dispatches to per-request fibers
::    /ui/requests/<id>    one ephemeral fiber per in-flight HTTP request
::    /ui/views/page.html  the web reader grub
::    /cat, /sub, /crawler.sig  catalog + follows + sweep (steps 4/5)
::
::  pub and know are the SAME kind of grub (both gain=%.y). They differ only in
::  permission: /pub is whitelisted in grubbery's `public` usergroup peek set
::  (foreign-readable), /know is private by omission (foreign access is deny-by-
::  default). The public/private split is a weir concern, not a schema split.
::  Vault layout uses the fixed `entry` leaf under each key-dir so /a and /a/b
::  can both be entries (see lattice-know).
::
/<  lk   /lib/lattice-know.hoon
/<  lp   /lib/lattice-pub.hoon
/<  ast  /lib/obelisk-ast.hoon
/<  cat  /lib/catalog.hoon
=<  ^-  nexus:nexus
    |%
    ++  on-load
      |=  =ball:tarball
      ^-  bole:tarball
      =/  =ver:loader  (get-ver:loader ball)
      ?+  ver  !!
          ?(~ [~ %0])
        ::  Every persistent path needs a covering row — spin rebuilds the
        ::  bole from scratch and DROPS anything uncovered. The %fall %| over
        ::  /know/vault copies the whole existing subtree, so dynamically
        ::  created entries survive reload.
        %+  spin:loader  ball
        :~  (ver-row:loader 0)
            [%fall %& [/ %'main.sig'] [[/ %sig] ~]]
            [%fall %| /know/vault empty-dir:loader]
            [%fall %| /know/trash-vault empty-dir:loader]
            [%fall %& [/know %trash] [[/lattice %know-index] *know-index:lk]]
            [%fall %| /pub/vault empty-dir:loader]
            [%fall %& [/pub %index] [[/lattice %pub-index] *pub-index:lp]]
        ::  HTTP front-end: ui/main.sig binds /apps/lattice and dispatches each
        ::  request into a per-request fiber under ui/requests. The web reader is
        ::  rendered dynamically per request (no static page grub).
            [%fall %& [/ui %'main.sig'] [[/ %sig] ~]]
            [%fall %| /ui/requests empty-dir:loader]
        ::  cat/ = catalog crawler state + derived index; sub/ = follows (one grub
        ::  per followed url); crawler.sig = the long-lived sweep fiber.
        ::  cat/obelisk.sig = the serializing obelisk OWNER (finding #1): every
        ::  obelisk query routes through it, so only ONE is ever in flight against
        ::  the single shared /server sub (no cross-caller result contamination).
        ::  cat/obk-out/ holds one ephemeral result grub per in-flight caller.
            [%fall %& [/cat %'obelisk.sig'] [[/ %sig] ~]]
            [%fall %| /cat/obk-out empty-dir:loader]
        ::  /sub/follows: the crawler's follow set (ships to sweep). A covering
        ::  file row (not an empty-dir) so the set survives reload.
            [%fall %& [/sub %follows] [[/lattice %sub-follows] *follows:lp]]
        ::  /sub/pages/: one grub per live per-file subscription. Each grub's
        ::  on-file spawns a keep fiber that re-indexes that remote page whenever
        ::  the peer edits it. /sub + /unsub make/cull these grubs.
            [%fall %| /sub/pages empty-dir:loader]
            [%fall %& [/ %'crawler.sig'] [[/ %sig] ~]]
        ==
      ==
    ::
    ++  on-file
      |=  [=rail:tarball =blot:tarball]
      ^-  spool:fiber:nexus
      |=  =prod:fiber:nexus
      =/  m  (fiber:fiber:nexus ,~)
      ^-  process:fiber:nexus
      ?+    rail  stay:m
          [~ %'main.sig']
        ;<  ~     bind:m  (rise-wait:io prod "%lattice writer failed")
        ;<  here=rail:tarball  bind:m  get-here-abs:io
        =/  root=path  path.here
        ::  open /pub to foreign readers (idempotent, union-not-clobber). know/
        ::  needs nothing — foreign access is deny-by-default.
        ;<  ~  bind:m  (ensure-pub-weir root)
        |-
        ;<  =sage:tarball  bind:m  take-poke:io
        ;<  now=@da  bind:m  bowl-now
        ?:  =([/lattice %know-action] p.sage)
          ;<  ~  bind:m  (apply root now !<(know-action:lk q.sage))
          $
        ?:  =([/lattice %pub-action] p.sage)
          ;<  ~  bind:m  (apply-pub root now !<(pub-action:lp q.sage))
          $
        ?:  =([/lattice %sub-action] p.sage)
          ;<  ~  bind:m  (apply-sub root !<(sub-action:lp q.sage))
          $
        ~&  [%lattice-bad-mark p.sage]
        $
      ::  /ui/main.sig: bind the HTTP endpoint and dispatch each request into a
      ::  per-request fiber under /ui/requests (same pattern as counter).
          [[%ui ~] %'main.sig']
        ;<  ~  bind:m  (rise-wait:io prod "%lattice /ui/main: failed")
        ;<  ~  bind:m  (bind-http:io [~ /apps/lattice])
        (http-dispatch:io %lattice)
      ::  /ui/requests/*: one ephemeral fiber per in-flight HTTP request.
          [[%ui %requests ~] @]
        ;<  ~  bind:m  (rise-wait:io prod "%lattice /ui/requests: failed")
        (handle-request name.rail)
      ::  /sub/pages/*: one live per-file subscription. keep the peer's page grub
      ::  and re-index it into the catalog on every change — so an edit lands now
      ::  instead of waiting for the ~h6 crawler sweep. The keep is re-established
      ::  from the stored page-sub on reload; culling the grub (via /unsub) tears
      ::  down the fiber and its keep (delete -> sub-wipe).
          [[%sub %pages ~] @]
        ;<  ~  bind:m  (rise-wait:io prod "%lattice /sub/pages: failed")
        ;<  ps=page-sub:lp  bind:m  (get-state-as:io ,page-sub:lp)
        =/  rel=path  (page-rel pax.ps)
        ::  keep the page's gmi FILE — that is the node the publisher GAINS (apply-pub
        ::  gains the gmi grub, not its parent dir), so a keep on the file gets the
        ::  publisher's %news on every edit. Keeping the parent dir would subscribe to
        ::  an un-gained node and never fire.
        =/  road=road:tarball
          (remote-road [%& %& (weld (weld app-base /pub/vault) rel) %gmi] ship.ps)
        ::  arm the keep BEFORE the initial index. keep:io's initial bond wave
        ::  is consumed either way, so with the keep armed first a peer edit
        ::  during the (slow: remote body/index peeks + owner round-trips)
        ::  initial index always fires a real second wave — the index's inner
        ::  takes %skip it, grubbery re-offers skipped inputs at the next bind,
        ::  and the loop's take below consumes it and re-indexes. Indexing
        ::  first opened a multi-second window where an edit fired no wave at
        ::  all and was never re-indexed (a page-sub is not a follow, so no
        ::  ~h6 sweep corrects it). Cost: the first index now waits for the
        ::  (remote) keep handshake — a peer too slow to ack the keep would
        ::  have timed out the index's body peek anyway.
        ;<  *  bind:m  (keep:io /page road ~)
        ;<  ~  bind:m  (index-remote-page ship.ps rel)
        |-
        ::  take-news-or-wake-drain, not take-news: index-remote-page's early-
        ::  resolving obelisk/peek send-waits leave uncancellable timers armed, and a
        ::  timed-out remote peek's late %peek/%veto still arrives; plain take-news
        ::  would %skip those and pile them in this long-lived fiber's skip queue
        ::  forever. -drain consumes both. A %wake is just drained; only a real %news
        ::  re-indexes.
        ;<  nw=news-or-wake:io  bind:m  (take-news-or-wake-drain /page)
        ?-  -.nw
            %wake  $
            %news
          ;<  ~  bind:m  (index-remote-page ship.ps rel)
          $
        ==
      ::  /crawler.sig: periodic catalog sweep. Each tick re-indexes our own
      ::  published pages into obelisk (runs immediately on start, then every
      ::  interval). ponytail: full re-scan per tick (fine for a personal store);
      ::  peer sweep over /sub follows (peek-remote per publisher) and an
      ::  incremental change-watch layer on here once follows exist. Interval
      ::  hardcoded ~h6 — add /cat/config.json if it ever needs tuning.
          [~ %'crawler.sig']
        ::  each tick: re-index our own pub pages, then sweep followed peers.
        ;<  ~  bind:m  (rise-wait:io prod "%lattice /crawler: failed")
        |-
        ;<  *       bind:m  catalog-scan-self
        ;<  our=@p  bind:m  bowl-our
        ;<  now=@da  bind:m  bowl-now
        ;<  *       bind:m  (catalog-scan-peers our now)
        ::  drain stray timer-wakes while sleeping (finding #13) — a plain sleep
        ::  would let this sweep's early-resolved obelisk/peek timers accumulate.
        ;<  ~  bind:m  (sleep-draining ~h6)
        $
      ::  /cat/obelisk.sig: the serializing obelisk OWNER (finding #1). Owns the
      ::  single /server sub; takes %obk-req pokes one at a time, runs the query
      ::  (obelisk-run-one), and writes the result to the caller's grub — so no two
      ::  obelisk round-trips are ever interleaved on the shared sub.
          [[%cat ~] %'obelisk.sig']
        ;<  ~  bind:m  (rise-wait:io prod "%lattice obelisk owner: failed")
        ::  ensure the result-grub dir exists once, so per-query put-files land.
        ;<  ~  bind:m  (ensure-dirs (weld app-base /cat) /obk-out)
        ::  clear any orphaned result grubs from a prior run (finding #6).
        ;<  ~  bind:m  (sweep-obk-out (weld app-base /cat/obk-out))
        |-
        ;<  =sage:tarball  bind:m  take-poke:io
        ::  obelisk-run-one arms a 15s wait per call and can't cancel it, so a
        ::  finished query's timer fires here as a [/ %timer-wake] poke — ignore it.
        ?:  =([/ %timer-wake] p.sage)  $
        ?.  =([/lattice %obk-req] p.sage)
          ~&([%lattice-obk-bad-req p.sage] $)
        =/  req=obk-req:ast  !<(obk-req:ast q.sage)
        ;<  res=(each (list cmd-result:ast) tang)  bind:m
          (obelisk-run-one db.req urql.req)
        ;<  ~  bind:m
          (put-file [%& %& res-pax.req res-nom.req] [/lattice %obk-res] res)
        $
      ==
    --
|%
::  +srv: HTTP response door — the road from a /ui/requests/* fiber up to
::  /ui/main.sig, through which all responses are sent (so the dispatcher can
::  cancel orphaned connections). Identical layout to counter.
::
++  srv  ~(. http-res:io [%| 1 %& ~ %'main.sig'])
::  +handle-request: serve one HTTP request. ponytail: the full ~50-route
::  contract lands in step 3; this scaffold proves the request-fiber path —
::  owner-auth, then serve the web reader at the root and 404 (JSON) the rest.
::
++  handle-request
  |=  eyre-id=@ta
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  [src=@p req=inbound-request:eyre]  bind:m
    (get-state-as:io ,[src=@p inbound-request:eyre])
  ;<  our=@p  bind:m  bowl-our
  ::  every route is owner-only (lattice is a personal store). Unauthenticated /
  ::  foreign requests carry src != our -> 403.
  ?.  =(src our)
    ::  JSON error, like every other route (was a bare text 'Forbidden').
    (send-err eyre-id 403 'forbidden')
  =/  parsed  (parse-url:http-utils url.request.req)
  ::  drop the /apps/lattice prefix; the remainder is the route.
  =/  suffix=path  (slag 2 site.parsed)
  =/  args=(map @t @t)  (malt args.parsed)
  ::  root: the web reader (Landscape tile). ?url=urb://ship/rel renders that
  ::  page; no url renders the home index of our published pages. ponytail:
  ::  compact gemtext->HTML (headings/links/quotes/lists/pre); the full reader's
  ::  link-resolution + bookmark sync can follow.
  ?~  suffix
    ::  ?view=bookmarks: the bookmarks reader shell (client-JS fills #bmlist).
    ?:  =(`'bookmarks' (~(get by args) 'view'))
      (send-html eyre-id (render-page "Bookmarks" "" "<h1>Bookmarks</h1><div id=\"bmlist\"></div>"))
    =/  raw=(unit @t)  (~(get by args) 'url')
    ?~  raw
      ::  authored home first: if the user published an /index page, serve it;
      ::  else the generated listing. Both keep /pub/index so a publish/delete/
      ::  edit auto-refreshes the open reader.
      ;<  home=(unit @t)  bind:m  (read-page-body our /index)
      ?~  home
        ;<  ix=pub-index:lp  bind:m  (read-pub-index [%| 2 %& /pub %index])
        (send-html eyre-id (render-page "" (keep-url "pub/index") (home-index-html our ix)))
      (send-html eyre-id (render-page "" (keep-url "pub/index") (render-gmi u.home)))
    =/  pu=(unit [=ship =path])  (parse-urb-url u.raw)
    ?~  pu  (send-html eyre-id (render-page (trip u.raw) "" "<p class=\"err\">bad urb:// url</p>"))
    ;<  body=(unit @t)  bind:m  (read-page-body ship.u.pu path.u.pu)
    ?~  body
      (send-html eyre-id (render-page (trip u.raw) "" "<p class=\"err\">not published here</p>"))
    ::  own pages get a live reader (keep /pub/index — its per-page hash changes on
    ::  every edit); remote pages stay static (can't keep a peer's grub).
    =/  rk=tape  ?:(=(ship.u.pu our) (keep-url "pub/index") "")
    (send-html eyre-id (render-page (trip u.raw) rk (render-gmi u.body)))
  ::  dispatch on [method action]. ponytail: read-know-map peeks the whole vault
  ::  per request — fine for a personal store. Writes poke the single writer
  ::  fiber (serialised) and respond ok; the writer logs no-op cases (missing key
  ::  etc.) rather than 404 — precise per-route error codes can follow if a client
  ::  needs them.
  =/  meth=@tas  method.request.req
  ?+    [meth (rear suffix)]
    (send-err eyre-id 404 'not found')
  ::  ── reads (GET) ──
      [%'GET' %list]
    ;<  ix=pub-index:lp  bind:m  (read-pub-index [%| 2 %& /pub %index])
    (send-json eyre-id (pub-list-json ix))
  ::
      [%'GET' %know-list]
    ;<  es=(map path know-entry:lk)  bind:m  read-know-map
    (send-json eyre-id (know-list-json es))
  ::
      [%'GET' %know-all]
    ;<  es=(map path know-entry:lk)  bind:m  read-know-map
    (send-json eyre-id (know-all-json es))
  ::
      [%'GET' %know-tags]
    ;<  es=(map path know-entry:lk)  bind:m  read-know-map
    (send-json eyre-id (know-tags-json es))
  ::
  ::  MCP tool discovery: an external MCP server GETs this to learn the
  ::  knowledge-store tools, then drives each via its own know-* HTTP route.
  ::  Reproduces the retired agent's /mcp/tools scry; execution moved to HTTP,
  ::  so the tool defs carry no khan thread-builder — just name/desc/schema.
      [%'GET' %mcp-tools]
    (send-json eyre-id mcp-tools-json)
  ::
      [%'GET' %know-trash]
    ;<  tx=know-index:lk  bind:m  (read-index [%| 2 %& /know %trash])
    (send-json eyre-id (index-list-json tx))
  ::
      [%'GET' %know-explore]
    =/  tags=(set @t)  (parse-tags (~(gut by args) 'tags' ''))
    ::  default 'any' (OR); only 'all' -> AND.
    =/  all=?  =('all' (~(gut by args) 'match' 'any'))
    =/  q=@t  (~(gut by args) 'q' '')
    ;<  es=(map path know-entry:lk)  bind:m  read-know-map
    (send-json eyre-id (know-list-json (filter-explore es tags all q)))
  ::
      [%'GET' %know-read]
    =/  ko=(unit path)  (know-key (~(gut by args) 'key' ''))
    ?~  ko  (send-err eyre-id 400 'bad key')
    ;<  es=(map path know-entry:lk)  bind:m  read-know-map
    =/  e=(unit know-entry:lk)  (~(get by es) u.ko)
    ?~  e  (send-err eyre-id 404 'not found')
    (send-json eyre-id (know-entry-json u.ko u.e))
  ::
      [%'GET' %fetch]
    ::  read a published page. url=urb://~ship/rel. Own pages peek the local pub
    ::  vault; remote pages use grubbery peek-remote (clean break: the peer must
    ::  run the grubbery-native lattice — old %grow spurs are not read). case=~
    ::  gets the latest gained content, so there's no walk-to-latest.
    =/  raw=(unit @t)  (~(get by args) 'url')
    ?~  raw  (send-err eyre-id 400 'missing url param')
    =/  pu=(unit [=ship =path])  (parse-urb-url u.raw)
    ?~  pu  (send-err eyre-id 400 'bad urb:// url')
    ;<  body=(unit @t)  bind:m  (read-page-body ship.u.pu path.u.pu)
    ?^  body  (send-json eyre-id (mark-body-json 'gmi' u.body))
    ::  /manifest discovery fallback: the retired agent auto-published a manifest
    ::  at this reserved spur, and the client still probes urb://<ship>/manifest
    ::  to badge publishers (publishes()) + list their files. The grubbery-native
    ::  store keeps no manifest grub, so synthesize one from the ship's pub index
    ::  instead. An unreachable/denied index stays a 404, so a non-lattice ship
    ::  never badges as a publisher; a page the user really published at
    ::  /manifest was already served above.
    ?.  =(/manifest path.u.pu)  (send-err eyre-id 404 'not found')
    ;<  mix=(unit pub-index:lp)  bind:m  (read-pub-index-any ship.u.pu)
    ?~  mix  (send-err eyre-id 404 'not found')
    (send-json eyre-id (mark-body-json 'gmi' (manifest-gmi u.mix)))
  ::  ── cross-ship browse (federated read-only tree reader) ──
  ::  list ANY grubbery ship's directory (not just lattice peers): ship=~x&path=/y.
  ::  SHALLOW (one level) so a huge/hostile remote tree can't balloon memory;
  ::  children past browse-fan-cap are dropped with `truncated`. Owner-only (the
  ::  request handler already gates src=our) — never an open proxy. A denied
  ::  (un-granted weir) or unreachable peer reads as 504, same as a timeout. No path
  ::  = the ship's root (its app list).
      [%'GET' %browse]
    =/  shp-t=(unit @t)  (~(get by args) 'ship')
    ?~  shp-t  (send-err eyre-id 400 'missing ship')
    =/  shp=(unit @p)  (slaw %p u.shp-t)
    ?~  shp  (send-err eyre-id 400 'bad ship')
    =/  pp=(each path tang)  (mule |.((stab (~(gut by args) 'path' '/'))))
    ?:  ?=(%| -.pp)  (send-err eyre-id 400 'bad path')
    =/  dir-road=road:tarball  [%& %| p.pp]
    ;<  our=@p  bind:m  bowl-our
    ?:  =(u.shp our)
      ;<  sn=seen:nexus  bind:m  (peek-shallow:io dir-road ~)
      ?.  ?=([%& %ball *] sn)  (send-err eyre-id 404 'not a directory')
      (send-json eyre-id (browse-json u.shp p.pp ball.p.sn))
    ;<  ms=(unit seen:nexus)  bind:m  (peek-remote-shallow-wait dir-road u.shp)
    ?~  ms  (send-err eyre-id 504 'unreachable or denied')
    ?.  ?=([%& %ball *] u.ms)  (send-err eyre-id 404 'not a directory')
    (send-json eyre-id (browse-json u.shp p.pp ball.p.u.ms))
  ::  read ANY grubbery ship's file: ship=~x&path=/apps/foo/bar/name. The last path
  ::  element is the file leaf. Body as JSON (text only; a non-cord body is 415).
      [%'GET' %browse-file]
    =/  shp-t=(unit @t)  (~(get by args) 'ship')
    ?~  shp-t  (send-err eyre-id 400 'missing ship')
    =/  shp=(unit @p)  (slaw %p u.shp-t)
    ?~  shp  (send-err eyre-id 400 'bad ship')
    =/  pt=(unit @t)  (~(get by args) 'path')
    ?~  pt  (send-err eyre-id 400 'missing path')
    =/  pp=(each path tang)  (mule |.((stab u.pt)))
    ?:  ?=(%| -.pp)  (send-err eyre-id 400 'bad path')
    ::  =(~ ...) not ?=(~ ...): ?= narrows p.pp to a lest, and scag casts its result
    ::  to the input type (^+), so the possibly-empty dir would nest-fail — the same
    ::  footgun key-to-rail documents. Split via lent/scag/snag on the un-narrowed path.
    ?:  =(~ p.pp)  (send-err eyre-id 400 'empty path')
    =/  n=@ud  (dec (lent p.pp))
    =/  file-road=road:tarball  [%& %& (scag n p.pp) (snag n p.pp)]
    ;<  our=@p  bind:m  bowl-our
    ?:  =(u.shp our)
      ;<  sn=seen:nexus  bind:m  (peek:io file-road ~)
      (browse-file-respond eyre-id sn)
    ;<  ms=(unit seen:nexus)  bind:m  (peek-remote-wait file-road u.shp)
    ?~  ms  (send-err eyre-id 504 'unreachable or denied')
    (browse-file-respond eyre-id u.ms)
  ::  ── obelisk bridge (catalog; step 5) ──
  ::  run a urQL write/DDL against %obelisk. GET /obelisk-exec?db=<db>&q=<urql>.
  ::  ponytail: GET for easy curl-testing the bridge; the real crawler drives this
  ::  arm internally and search reads via obelisk-query.
      [%'GET' %obelisk-exec]
    =/  db=@tas  (~(gut by args) 'db' 'sys')
    =/  q=(unit @t)  (~(get by args) 'q')
    ?~  q  (send-err eyre-id 400 'missing q param')
    ::  route through obelisk-query (the serializing obelisk owner), NOT raw
    ::  obelisk-exec: a direct poke's result fact lands on the shared /server sub,
    ::  where a concurrent owner-routed query could misread it as its own result.
    ;<  res=(each (list cmd-result:ast) tang)  bind:m  (obelisk-query db (trip u.q))
    ?:  ?=(%| -.res)  (send-obelisk eyre-id res)
    (send-ok eyre-id)
  ::
      [%'GET' %obelisk-query]
    =/  db=@tas  (~(gut by args) 'db' 'sys')
    =/  q=(unit @t)  (~(get by args) 'q')
    ?~  q  (send-err eyre-id 400 'missing q param')
    ;<  res=(each (list cmd-result:ast) tang)  bind:m  (obelisk-query db (trip u.q))
    (send-obelisk eyre-id res)
  ::  ── catalog routes (step 5) ──
      [%'GET' %catalog-init]
    ;<  ~  bind:m  catalog-init
    (send-ok eyre-id)
  ::
      [%'GET' %catalog-scan-self]
    ;<  cnt=@ud  bind:m  catalog-scan-self
    (send-json eyre-id (pairs:enjs:format ~[['indexed' (numb:enjs:format cnt)]]))
  ::
      [%'GET' %catalog-list]
    ;<  cl=(each (list cmd-result:ast) tang)  bind:m  (obelisk-query catalog-db catalog-list-urql:cat)
    (send-obelisk eyre-id cl)
  ::
      [%'GET' %catalog-search]
    =/  term=(unit @t)  (~(get by args) 'term')
    ?~  term  (send-err eyre-id 400 'missing term param')
    =/  nt=(unit @t)  (catalog-normalize-term:cat (trip u.term))
    ::  a non-indexable term (too short / stop word) matches nothing — return an
    ::  empty result (200), NOT a 400, so a client fanning out one call per query
    ::  word doesn't error on a common stop word. Same flat obelisk shape (and
    ::  the same column set) the old agent hardcoded for this case.
    ?~  nt
      %+  send-json  eyre-id
      %-  pairs:enjs:format
      :~  ['ok' b+&]
          ['columns' a+(turn ~['source' 'publisher' 'path' 'tf'] |=(c=@t s+c))]
          ['rows' a+~]
      ==
    =/  urql=tape  (catalog-search-urql:cat (trip u.nt))
    ;<  cs=(each (list cmd-result:ast) tang)  bind:m  (obelisk-query catalog-db urql)
    (send-obelisk eyre-id cs)
  ::
      [%'GET' %catalog-query]
    =/  cq=(unit @t)  (~(get by args) 'q')
    ?~  cq  (send-err eyre-id 400 'missing q param')
    ;<  cr=(each (list cmd-result:ast) tang)  bind:m  (obelisk-query catalog-db (trip u.cq))
    (send-obelisk eyre-id cr)
  ::  filtered catalog listing. category/publisher/source all optional; a present
  ::  but unparseable @p is a 400 (not silently dropped to "match all").
      [%'GET' %catalog-explore]
    =/  ct=tape  (trip (~(gut by args) 'category' ''))
    =/  pp=(unit @t)  (~(get by args) 'publisher')
    =/  sp=(unit @t)  (~(get by args) 'source')
    =/  pub=(unit @p)  ?~(pp ~ (slaw %p u.pp))
    =/  src=(unit @p)  ?~(sp ~ (slaw %p u.sp))
    ?:  &(?=(^ pp) ?=(~ pub))  (send-err eyre-id 400 'bad publisher')
    ?:  &(?=(^ sp) ?=(~ src))  (send-err eyre-id 400 'bad source')
    =/  pubt=tape  ?~(pub "" (trip (scot %p u.pub)))
    =/  srct=tape  ?~(src "" (trip (scot %p u.src)))
    ;<  cx=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db (catalog-explore-urql:cat ct pubt srct))
    (send-obelisk eyre-id cx)
  ::  one full catalog row by its url (urb://<pub>/<catalog-path>).
      [%'GET' %catalog-fetch]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url param')
    ;<  cf=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db (catalog-fetch-urql:cat (trip u.url)))
    (send-obelisk eyre-id cf)
  ::  backlinks: which pages link TO `url`. `url` is matched VERBATIM against the
  ::  authored link target (what the author wrote after `=> ` — e.g. urb://~pub/x
  ::  or /x), not a normalized catalog url. Returns (source, publisher, path) +
  ::  label + is-internal; the client joins the keys back to catalog-pages rows.
      [%'GET' %catalog-backlinks]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url param')
    ;<  cb=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db (catalog-backlinks-urql:cat (trip u.url)))
    (send-obelisk eyre-id cb)
  ::  table of contents: one page's headings in order. url is the catalog url
  ::  (urb://<pub>/pub/<spur>/gmi); source is always us (the crawler).
      [%'GET' %catalog-toc]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url param')
    =/  pu=(unit [=ship =path])  (parse-urb-url u.url)
    ?~  pu  (send-err eyre-id 400 'bad urb:// url')
    ;<  our=@p  bind:m  bowl-our
    ;<  ct=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db (catalog-toc-urql:cat our ship.u.pu (trip (spat path.u.pu))))
    (send-obelisk eyre-id ct)
  ::  page keys carrying a tag.
      [%'GET' %catalog-by-tag]
    =/  tag=(unit @t)  (~(get by args) 'tag')
    ?~  tag  (send-err eyre-id 400 'missing tag param')
    ::  case-fold the query tag: the analyzer stores catalog tags lowercased
    ::  (collect-tag-tokens), and obelisk equality is exact, so an uppercase
    ::  query would never match. Matches the norm-tag/normalize-term convention.
    ;<  cb=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db (catalog-by-tag-urql:cat (cass (trip u.tag))))
    (send-obelisk eyre-id cb)
  ::  per-page classification metadata (source/publisher/path/summary).
      [%'GET' %catalog-meta]
    ;<  cm=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db catalog-meta-list-urql:cat)
    (send-obelisk eyre-id cm)
  ::  the classifier worklist: OUR unclassified pages, newest first.
      [%'GET' %catalog-pending]
    ;<  cp=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db catalog-pending-list-urql:cat)
    (send-obelisk eyre-id cp)
  ::  the live (crawler-derived) category vocabulary.
      [%'GET' %catalog-vocab]
    ;<  cv=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db catalog-vocab-urql:cat)
    (send-obelisk eyre-id cv)
  ::  candidate ships to follow. grubbery has no gall SCRY (only watch/poke), so
  ::  the %contacts book can't be read here; crawler targets are set explicitly
  ::  via /follow instead. Route kept for contract shape; ponytail: bridge via a
  ::  %contacts gall-watch if a live list is needed.
      [%'GET' %contacts]
    (send-json eyre-id (pairs:enjs:format ~[['ships' a+~]]))
  ::  ── follows (crawler targets) ──
      [%'GET' %follows]
    ;<  fs=follows:lp  bind:m  read-follows
    (send-json eyre-id a+(turn ~(tap in fs) |=(s=@p s+(scot %p s))))
  ::  ── live per-file subscriptions ──
      [%'GET' %subs]
    ;<  ss=(list page-sub:lp)  bind:m  read-subs
    %+  send-json  eyre-id
    :-  %a
    %+  turn  ss
    |=  ps=page-sub:lp
    (pairs:enjs:format ~[['ship' s+(scot %p ship.ps)] ['path' s+(spat pax.ps)]])
  ::  ── live update streams (keep-SSE discovery) ──
  ::  hand the client grubbery's native keep endpoints for our subscribable grubs,
  ::  so it can live-subscribe instead of polling /know-list, /list, /follows. Each
  ::  is an SSE stream (Accept: text/event-stream) whose frames are
  ::  'event: <old|add|upd|del> <name>' + 'data: <json>' — skip the initial `old`
  ::  snapshot, then on add/upd upsert <name> with its data, on del drop it. know
  ::  and pub are DIRECTORY subscriptions (one frame per changed entry/page);
  ::  follows is the single follow-set grub.
      [%'GET' %streams]
    =/  base=tape  "/grubbery/api/keep/apps/lattice.lattice_app/"
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  :-  'streams'
        %-  pairs:enjs:format
        :~  ['know' s+(crip (weld base "know/vault?blot=/json"))]
            ['pub' s+(crip (weld base "pub/vault?blot=/json"))]
            ['follows' s+(crip (weld base "sub/follows?blot=/json"))]
        ==
        :-  'protocol'
        :-  %s
        =-  (crip -)
        ;:  weld
          "SSE; send Accept: text/event-stream. Each frame is "
          "'event: <old|add|upd|del> <name>' then 'data: <json>'. "
          "Skip the initial 'old' snapshot frames; on add/upd upsert "
          "<name> with data, on del remove it."
        ==
    ==
  ::  ── pub writes (POST) ──
      [%'POST' %save]
    =/  rel=(unit @t)  (~(get by args) 'path')
    ?~  rel  (send-err eyre-id 400 'missing path')
    ::  reject an EMPTY path value (?path=): pub-path('') is /pub/gmi, a degenerate
    ::  key the reader maps back to /index — so it would mis-index and be unreadable.
    ?:  =('' u.rel)  (send-err eyre-id 400 'missing path')
    =/  pp=(each path tang)  (mule |.((pub-path u.rel)))
    ?:  ?=(%| -.pp)  (send-err eyre-id 400 'invalid path')
    =/  bod=@t  (req-body req)
    ?:  =('' bod)  (send-err eyre-id 400 'missing body')
    ;<  ~  bind:m  (poke-pub [%save-page (spat p.pp) bod])
    (send-ok eyre-id)
  ::
      [%'POST' %delete]
    =/  rel=(unit @t)  (~(get by args) 'path')
    ?~  rel  (send-err eyre-id 400 'missing path')
    =/  pp=(each path tang)  (mule |.((pub-path u.rel)))
    ?:  ?=(%| -.pp)  (send-err eyre-id 400 'invalid path')
    ;<  ~  bind:m  (poke-pub [%del-page (spat p.pp)])
    ::  also sweep the page's catalog rows (source=publisher=our) so a deleted
    ::  page leaves no orphaned term postings / ghost search hits. Driven here (in
    ::  the request fiber) not the writer, so the obelisk round-trip can't stall
    ::  the single writer.
    ;<  our=@p  bind:m  bowl-our
    ;<  ~  bind:m  (catalog-run catalog-db (catalog-page-delete-urql:cat our our p.pp))
    (send-ok eyre-id)
  ::  ── pub version history ──
  ::  every published page is a firm grub, so grubbery keeps every prior revision.
  ::  list a page's revisions (rev = the opaque grub revision id, with its date —
  ::  key the UI on the date, revs are not contiguous). read-at + restore ONLY ever
  ::  pass a rev that came from this list: peek-at -> resolve-case BAILS the whole
  ::  event on a missing case, so an unvalidated number would crash the request.
      [%'GET' %pub-history]
    =/  raw=(unit @t)  (~(get by args) 'path')
    ?~  raw  (send-err eyre-id 400 'missing path')
    =/  ro=(unit road:tarball)  (pub-road u.raw)
    ?~  ro  (send-err eyre-id 400 'invalid path')
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io u.ro [%numb ~ ~])
    ?:  ?=(%| -.pe)  (send-err eyre-id 404 'no history')
    =/  revs=(list [ud=@ud da=@da])
      %+  sort  (turn p.pe |=([c=cass:clay *] [ud.c da.c]))
      |=  [a=[ud=@ud da=@da] b=[ud=@ud da=@da]]
      (lth ud.a ud.b)
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  ['path' s+u.raw]
        :-  'revisions'
        :-  %a
        %+  turn  revs
        |=  [ud=@ud da=@da]
        (pairs:enjs:format ~[['rev' (numb:enjs:format ud)] ['updated' s+(scot %da da)]])
    ==
  ::  a page's body AS OF a revision. rev must be one returned by /pub-history.
      [%'GET' %pub-read-at]
    =/  raw=(unit @t)  (~(get by args) 'path')
    ?~  raw  (send-err eyre-id 400 'missing path')
    =/  rv=(unit @t)  (~(get by args) 'rev')
    ?~  rv  (send-err eyre-id 400 'missing rev')
    =/  rev=(unit @ud)  (slaw %ud u.rv)
    ?~  rev  (send-err eyre-id 400 'bad rev')
    =/  ro=(unit road:tarball)  (pub-road u.raw)
    ?~  ro  (send-err eyre-id 400 'invalid path')
    ::  validate the rev against real history before peek-at (which bails on a miss).
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io u.ro [%numb ~ ~])
    ?:  ?=(%| -.pe)  (send-err eyre-id 404 'no history')
    ?.  (lien p.pe |=([c=cass:clay *] =(ud.c u.rev)))
      (send-err eyre-id 404 'no such revision')
    ;<  sn=seen:nexus  bind:m  (peek-at:io u.ro ~ [%ud u.rev])
    ?.  ?=([%& %file *] sn)  (send-err eyre-id 404 'not found')
    =/  body=@t  !<(@t (need-vase:tarball sang.p.sn))
    %+  send-json  eyre-id
    (pairs:enjs:format ~[['body' s+body] ['rev' (numb:enjs:format u.rev)] ['mark' s+'gmi']])
  ::  restore a prior revision: read its body, then re-save through the writer so it
  ::  lands as a fresh firm revision (index + gain stay consistent). Non-destructive
  ::  — the current body is itself retained in history.
      [%'POST' %pub-restore-rev]
    =/  raw=(unit @t)  (~(get by args) 'path')
    ?~  raw  (send-err eyre-id 400 'missing path')
    =/  rv=(unit @t)  (~(get by args) 'rev')
    ?~  rv  (send-err eyre-id 400 'missing rev')
    =/  rev=(unit @ud)  (slaw %ud u.rv)
    ?~  rev  (send-err eyre-id 400 'bad rev')
    =/  ro=(unit road:tarball)  (pub-road u.raw)
    ?~  ro  (send-err eyre-id 400 'invalid path')
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io u.ro [%numb ~ ~])
    ?:  ?=(%| -.pe)  (send-err eyre-id 404 'no history')
    ?.  (lien p.pe |=([c=cass:clay *] =(ud.c u.rev)))
      (send-err eyre-id 404 'no such revision')
    ;<  sn=seen:nexus  bind:m  (peek-at:io u.ro ~ [%ud u.rev])
    ?.  ?=([%& %file *] sn)  (send-err eyre-id 404 'not found')
    =/  body=@t  !<(@t (need-vase:tarball sang.p.sn))
    =/  pp=(each path tang)  (mule |.((pub-path u.raw)))
    ?:  ?=(%| -.pp)  (send-err eyre-id 400 'invalid path')
    ;<  ~  bind:m  (poke-pub [%save-page (spat p.pp) body])
    (send-ok eyre-id)
  ::  prune a page's history to the newest `keep` revisions (default 10, floor 1).
  ::  Destructive + irreversible, same contract as /know-prune: %lose [%pick ...]
  ::  drops the picked old revisions and decrements silo refs; the live rev is never
  ::  dropped (keep>=1 keeps the newest, and the top cass is excluded from the drop
  ::  set). Request-fiber + explicit cass set — no writer serialization, no open
  ::  range. Shrinks what /pub-history lists; /pub-read-at on a dropped rev 404s.
      [%'POST' %pub-prune]
    =/  raw=(unit @t)  (~(get by args) 'path')
    ?~  raw  (send-err eyre-id 400 'missing path')
    =/  keep=(unit @ud)
      =/  kp=(unit @t)  (~(get by args) 'keep')
      ?~  kp  `10
      =/  k=(unit @ud)  (slaw %ud u.kp)
      ?~(k ~ `(max 1 u.k))
    ?~  keep  (send-err eyre-id 400 'bad keep')
    =/  ro=(unit road:tarball)  (pub-road u.raw)
    ?~  ro  (send-err eyre-id 400 'invalid path')
    ;<  ex=?  bind:m  (peek-exists:io u.ro)
    ?.  ex  (send-err eyre-id 404 'not found')
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io u.ro [%numb ~ ~])
    ?:  ?=(%| -.pe)  (send-err eyre-id 500 'peep failed')
    =/  revs=(list cass:clay)
      %+  sort  (turn p.pe |=([c=cass:clay *] c))
      |=([a=cass:clay b=cass:clay] (lth ud.a ud.b))
    =/  ntot=@ud  (lent revs)
    ?:  (lte ntot u.keep)
      (send-json eyre-id (pairs:enjs:format ~[['dropped' (numb:enjs:format 0)] ['kept' (numb:enjs:format ntot)]]))
    =/  top=cass:clay  (rear revs)
    =/  drop-set=(set cass:clay)  (~(del in (sy (scag (sub ntot u.keep) revs))) top)
    ?:  =(~ drop-set)
      (send-json eyre-id (pairs:enjs:format ~[['dropped' (numb:enjs:format 0)] ['kept' (numb:enjs:format ntot)]]))
    ;<  ~  bind:m  (lose:io u.ro [%pick drop-set])
    =/  nd=@ud  ~(wyt in drop-set)
    (send-json eyre-id (pairs:enjs:format ~[['dropped' (numb:enjs:format nd)] ['kept' (numb:enjs:format (sub ntot nd))]]))
  ::  ── know version history ──
  ::  every know entry is a firm grub, so grubbery keeps its prior revisions. A live
  ::  key's history is under /know/vault; a deleted key's is under /know/trash-vault
  ::  (see know-hist-road). read-at + restore only ever pass a rev returned here.
      [%'GET' %know-history]
    =/  raw=(unit @t)  (~(get by args) 'key')
    ?~  raw  (send-err eyre-id 400 'missing key')
    ;<  hr=(unit [road=road:tarball trashed=?])  bind:m  (know-hist-road u.raw)
    ?~  hr  (send-err eyre-id 404 'not found')
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io road.u.hr [%numb ~ ~])
    ?:  ?=(%| -.pe)  (send-err eyre-id 404 'no history')
    =/  revs=(list [ud=@ud da=@da])
      %+  sort  (turn p.pe |=([c=cass:clay *] [ud.c da.c]))
      |=  [a=[ud=@ud da=@da] b=[ud=@ud da=@da]]
      (lth ud.a ud.b)
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  ['key' s+u.raw]
        ['trashed' b+trashed.u.hr]
        :-  'revisions'
        :-  %a
        %+  turn  revs
        |=  [ud=@ud da=@da]
        (pairs:enjs:format ~[['rev' (numb:enjs:format ud)] ['updated' s+(scot %da da)]])
    ==
  ::  a know entry's full content (body/tags/updated) AS OF a revision.
      [%'GET' %know-read-at]
    =/  raw=(unit @t)  (~(get by args) 'key')
    ?~  raw  (send-err eyre-id 400 'missing key')
    =/  rv=(unit @t)  (~(get by args) 'rev')
    ?~  rv  (send-err eyre-id 400 'missing rev')
    =/  rev=(unit @ud)  (slaw %ud u.rv)
    ?~  rev  (send-err eyre-id 400 'bad rev')
    =/  ko=(unit path)  (know-key u.raw)
    ?~  ko  (send-err eyre-id 400 'invalid key')
    ;<  hr=(unit [road=road:tarball trashed=?])  bind:m  (know-hist-road u.raw)
    ?~  hr  (send-err eyre-id 404 'not found')
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io road.u.hr [%numb ~ ~])
    ?:  ?=(%| -.pe)  (send-err eyre-id 404 'no history')
    ?.  (lien p.pe |=([c=cass:clay *] =(ud.c u.rev)))
      (send-err eyre-id 404 'no such revision')
    ;<  sn=seen:nexus  bind:m  (peek-at:io road.u.hr ~ [%ud u.rev])
    ?.  ?=([%& %file *] sn)  (send-err eyre-id 404 'not found')
    =/  e=know-entry:lk  !<(know-entry:lk (need-vase:tarball sang.p.sn))
    (send-json eyre-id (know-entry-json u.ko e))
  ::  restore a prior revision: re-save it live via %import (preserves tags/vector),
  ::  stamped updated=now so it sorts fresh in know-list (matches pub-restore). Works
  ::  for a trashed key too — %import revives it live. Non-destructive: the current
  ::  body stays in history.
      [%'POST' %know-restore-rev]
    =/  raw=(unit @t)  (~(get by args) 'key')
    ?~  raw  (send-err eyre-id 400 'missing key')
    =/  rv=(unit @t)  (~(get by args) 'rev')
    ?~  rv  (send-err eyre-id 400 'missing rev')
    =/  rev=(unit @ud)  (slaw %ud u.rv)
    ?~  rev  (send-err eyre-id 400 'bad rev')
    =/  ko=(unit path)  (know-key u.raw)
    ?~  ko  (send-err eyre-id 400 'invalid key')
    ;<  hr=(unit [road=road:tarball trashed=?])  bind:m  (know-hist-road u.raw)
    ?~  hr  (send-err eyre-id 404 'not found')
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io road.u.hr [%numb ~ ~])
    ?:  ?=(%| -.pe)  (send-err eyre-id 404 'no history')
    ?.  (lien p.pe |=([c=cass:clay *] =(ud.c u.rev)))
      (send-err eyre-id 404 'no such revision')
    ;<  sn=seen:nexus  bind:m  (peek-at:io road.u.hr ~ [%ud u.rev])
    ?.  ?=([%& %file *] sn)  (send-err eyre-id 404 'not found')
    =/  e=know-entry:lk  !<(know-entry:lk (need-vase:tarball sang.p.sn))
    ;<  now=@da  bind:m  bowl-now
    ;<  ~  bind:m  (poke-know [%import (spat u.ko) e(updated now)])
    (send-ok eyre-id)
  ::  prune a live key's history to the newest `keep` revisions (default 10, floor
  ::  1). DESTRUCTIVE + IRREVERSIBLE: %lose hard-drops the picked revisions and
  ::  decrements silo refs (shared content lobes survive by refcount). The current
  ::  body is NEVER dropped — two guards: keep>=1 leaves the newest in the kept
  ::  segment, and the top cass is explicitly removed from the drop set. Uses %pick
  ::  (an explicit cass set), never an open %numb/%date range, so even a concurrent
  ::  write can't widen the drop into the live rev. Runs in the request fiber (prune
  ::  touches only old revs, not the know-index, so no writer serialization needed);
  ::  a lose failure 500s this one request, it can't park the writer. Trashed keys
  ::  are out of scope — targets the live vault only.
      [%'POST' %know-prune]
    =/  raw=(unit @t)  (~(get by args) 'key')
    ?~  raw  (send-err eyre-id 400 'missing key')
    =/  keep=(unit @ud)
      =/  kp=(unit @t)  (~(get by args) 'keep')
      ?~  kp  `10
      =/  k=(unit @ud)  (slaw %ud u.kp)
      ?~(k ~ `(max 1 u.k))
    ?~  keep  (send-err eyre-id 400 'bad keep')
    =/  ko=(unit path)  (know-key u.raw)
    ?~  ko  (send-err eyre-id 400 'invalid key')
    =/  road=road:tarball  (entry-road (weld app-base /know/vault) u.ko)
    ;<  live=(unit know-entry:lk)  bind:m  (read-entry road)
    ?~  live  (send-err eyre-id 404 'not found')
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io road [%numb ~ ~])
    ?:  ?=(%| -.pe)  (send-err eyre-id 500 'peep failed')
    =/  revs=(list cass:clay)
      %+  sort  (turn p.pe |=([c=cass:clay *] c))
      |=([a=cass:clay b=cass:clay] (lth ud.a ud.b))
    =/  ntot=@ud  (lent revs)
    ?:  (lte ntot u.keep)
      (send-json eyre-id (pairs:enjs:format ~[['dropped' (numb:enjs:format 0)] ['kept' (numb:enjs:format ntot)]]))
    =/  top=cass:clay  (rear revs)
    =/  drop-set=(set cass:clay)  (~(del in (sy (scag (sub ntot u.keep) revs))) top)
    ?:  =(~ drop-set)
      (send-json eyre-id (pairs:enjs:format ~[['dropped' (numb:enjs:format 0)] ['kept' (numb:enjs:format ntot)]]))
    ;<  ~  bind:m  (lose:io road [%pick drop-set])
    =/  nd=@ud  ~(wyt in drop-set)
    (send-json eyre-id (pairs:enjs:format ~[['dropped' (numb:enjs:format nd)] ['kept' (numb:enjs:format (sub ntot nd))]]))
  ::  ── follow writes (POST) ──
      [%'POST' %follow]
    =/  shp=(unit @t)  (~(get by args) 'ship')
    ?~  shp  (send-err eyre-id 400 'missing ship')
    =/  who=(unit @p)  (slaw %p u.shp)
    ?~  who  (send-err eyre-id 400 'bad ship')
    ;<  ~  bind:m  (poke-sub [%follow u.who])
    (send-ok eyre-id)
  ::
      [%'POST' %unfollow]
    =/  shp=(unit @t)  (~(get by args) 'ship')
    ?~  shp  (send-err eyre-id 400 'missing ship')
    =/  who=(unit @p)  (slaw %p u.shp)
    ?~  who  (send-err eyre-id 400 'bad ship')
    ;<  ~  bind:m  (poke-sub [%unfollow u.who])
    (send-ok eyre-id)
  ::  ── per-file subscribe writes (POST) ── url=urb://<ship>/<path> keeps that one
  ::  page live: the crawler re-indexes it the moment the peer edits it, instead of
  ::  waiting for the ~h6 sweep. /unsub tears the keep down.
      [%'POST' %sub]
    =/  raw=(unit @t)  (~(get by args) 'url')
    ?~  raw  (send-err eyre-id 400 'missing url param')
    =/  pu=(unit [=ship =path])  (parse-urb-url u.raw)
    ?~  pu  (send-err eyre-id 400 'bad urb:// url')
    ;<  our=@p  bind:m  bowl-our
    ?:  =(ship.u.pu our)  (send-err eyre-id 400 'cannot subscribe to own ship')
    ;<  ~  bind:m  (poke-sub [%sub-page ship.u.pu path.u.pu])
    (send-ok eyre-id)
  ::
      [%'POST' %unsub]
    =/  raw=(unit @t)  (~(get by args) 'url')
    ?~  raw  (send-err eyre-id 400 'missing url param')
    =/  pu=(unit [=ship =path])  (parse-urb-url u.raw)
    ?~  pu  (send-err eyre-id 400 'bad urb:// url')
    ;<  ~  bind:m  (poke-sub [%unsub-page ship.u.pu path.u.pu])
    (send-ok eyre-id)
  ::  ── catalog classify (POST) ──
  ::  write a classification onto one of OUR catalog rows. url=urb://<pub>/<path>
  ::  (the catalog url form), category required, cat-source defaults 'manual',
  ::  confidence accepts "0.7" or the full native @rs ".0.7" (unparseable -> .0).
      [%'POST' %catalog-classify]
    =/  raw=(unit @t)  (~(get by args) 'url')
    ?~  raw  (send-err eyre-id 400 'missing url param')
    =/  cat-v=(unit @t)  (~(get by args) 'category')
    ?~  cat-v  (send-err eyre-id 400 'missing category param')
    =/  pu=(unit [=ship =path])  (parse-urb-url u.raw)
    ?~  pu  (send-err eyre-id 400 'bad urb:// url')
    =/  csrc=@t  (~(gut by args) 'cat-source' 'manual')
    =/  conf=@rs
      =/  c=(unit @t)  (~(get by args) 'confidence')
      ?~  c  .0
      =/  ct=tape  (trip u.c)
      ::  @rs literals put the aura dot FIRST: 0.7 is `.0.7`, NOT `.7` (=7.0).
      ::  So PREPEND the aura dot to a plain decimal ("0.7" -> ".0.7"), but leave a
      ::  full native literal (".0.7") alone — else "..0.7" fails to parse and the
      ::  documented native form silently coerces to .0.
      =/  lit=tape  ?:(?=([%'.' *] ct) ct ['.' ct])
      =/  v=@rs  ?~(r=(slaw %rs (crip lit)) .0 u.r)
      ::  clamp to [0,1] — shorthand like ".7" parses as 7.0 per @rs literal rules,
      ::  and confidence is a probability; an out-of-range value would corrupt
      ::  the stored/displayed value in catalog-pages.confidence. A NaN (".nan"
      ::  parses fine) makes every rs comparison %.n, so it would slip past the
      ::  range test — collapse it to .0 first (equ:rs v v is %.n only for NaN).
      ?:  !(equ:rs v v)  .0
      ?:((lth:rs v .0) .0 ?:((gth:rs v .1) .1 v))
    ;<  our=@p  bind:m  bowl-our
    ;<  ~  bind:m
      (catalog-run catalog-db (catalog-classify-urql:cat our ship.u.pu path.u.pu u.cat-v csrc conf))
    (send-ok eyre-id)
  ::  ── catalog crawl triggers (POST) ──
  ::  scan ONE publisher on demand: synchronous (bounded by remote-timeout),
  ::  returns the indexed count.
      [%'POST' %catalog-scan]
    =/  raw=(unit @t)  (~(get by args) 'ship')
    ?~  raw  (send-err eyre-id 400 'missing ship param')
    =/  pub=(unit @p)  (slaw %p u.raw)
    ?~  pub  (send-err eyre-id 400 'bad ship')
    ;<  our=@p  bind:m  bowl-our
    ?:  =(u.pub our)  (send-err eyre-id 400 'cannot crawl own ship')
    ;<  now=@da  bind:m  bowl-now
    ;<  n=@ud  bind:m  (catalog-scan-peer our u.pub now)
    (send-json eyre-id (pairs:enjs:format ~[['indexed' (numb:enjs:format n)]]))
  ::  sweep everything now: our own pages + every followed peer. Respond FIRST
  ::  ({"ok":true}, the old agent's fire-and-forget contract — the client's 10s
  ::  read timeout can't outlast a real sweep), THEN run the sweep in this same
  ::  request fiber. Safe: a completed %simple response deletes the connection's
  ::  conns entry in grubbery, so eyre's later leave takes the no-binding branch
  ::  and no %handle-http-cancel can reach the dispatcher to cull this fiber
  ::  mid-sweep (grubbery handle-eyre-action %send / on-leave %http-response).
      [%'POST' %catalog-sweep]
    ;<  ~  bind:m  (send-ok eyre-id)
    ;<  *  bind:m  catalog-scan-self
    ;<  our=@p   bind:m  bowl-our
    ;<  now=@da  bind:m  bowl-now
    ;<  *  bind:m  (catalog-scan-peers our now)
    (pure:m ~)
  ::  arbitrary urQL passthrough (body = the query), run against the lattice db.
  ::  Owner-only like all routes.
      [%'POST' %know-query]
    =/  urql=@t  (req-body req)
    ;<  kq=(each (list cmd-result:ast) tang)  bind:m  (obelisk-query catalog-db (trip urql))
    (send-obelisk eyre-id kq)
  ::  rebuild the obelisk knowledge index from the live vault (Explore pane's
  ::  Reindex). Ack-blocking but the client treats it fire-and-forget; 502 only
  ::  when obelisk is absent.
      [%'POST' %know-reindex]
    ;<  ~  bind:m  know-reindex
    (send-ok eyre-id)
  ::  bulk import: body = a /know-all export; lands each entry VERBATIM (tags +
  ::  original updated preserved) via %import. Owner-only.
      [%'POST' %know-import]
    =/  jon=(unit json)  (de:json:html (req-body req))
    ?~  jon  (send-err eyre-id 400 'bad json')
    =/  parsed=(each (list [@t know-entry:lk]) tang)  (mule |.((parse-import u.jon)))
    ?:  ?=(%| -.parsed)  (send-err eyre-id 400 'bad import shape')
    ::  reject the whole batch if any key is unparseable as a path — the writer
    ::  would otherwise skip those entries (silent partial import).
    ?:  (lien p.parsed |=([k=@t *] ?=(~ (know-key k))))
      (send-err eyre-id 400 'invalid key in import')
    ;<  n=@ud  bind:m  (import-know-loop p.parsed 0)
    (send-json eyre-id (pairs:enjs:format ~[['imported' (numb:enjs:format n)]]))
  ::  ── know writes (POST) ──
  ::  keys are normalised via know-key (prepends a leading /) before poking; the
  ::  writer does a bare (stab key) which needs the leading slash, so an
  ::  un-normalised "a/b" would misparse and silently create a junk dir.
      [%'POST' %know-save]
    =/  k=(unit @t)  (~(get by args) 'key')
    ?~  k  (send-err eyre-id 400 'missing key')
    =/  ko=(unit path)  (know-key u.k)
    ?~  ko  (send-err eyre-id 400 'invalid key')
    ::  a bodyless POST must not silently blank an existing note (merge-save would
    ::  overwrite body with '' while keeping tags). Require a body, like /save.
    =/  bod=@t  (req-body req)
    ?:  =('' bod)  (send-err eyre-id 400 'missing body')
    ;<  ~  bind:m  (poke-know [%save (spat u.ko) bod])
    (send-ok eyre-id)
  ::
      [%'POST' %know-delete]
    =/  k=(unit @t)  (~(get by args) 'key')
    ?~  k  (send-err eyre-id 400 'missing key')
    =/  ko=(unit path)  (know-key u.k)
    ?~  ko  (send-err eyre-id 400 'invalid key')
    ;<  ~  bind:m  (poke-know [%del (spat u.ko)])
    (send-ok eyre-id)
  ::
      [%'POST' %know-restore]
    =/  k=(unit @t)  (~(get by args) 'key')
    ?~  k  (send-err eyre-id 400 'missing key')
    =/  ko=(unit path)  (know-key u.k)
    ?~  ko  (send-err eyre-id 400 'invalid key')
    ;<  ~  bind:m  (poke-know [%restore (spat u.ko)])
    (send-ok eyre-id)
  ::
      [%'POST' %know-tag]
    =/  k=(unit @t)  (~(get by args) 'key')
    =/  tg=(unit @t)  (~(get by args) 'tag')
    ?:  |(?=(~ k) ?=(~ tg))  (send-err eyre-id 400 'missing key or tag')
    =/  ko=(unit path)  (know-key u.k)
    ?~  ko  (send-err eyre-id 400 'invalid key')
    ;<  ~  bind:m  (poke-know [%tag (spat u.ko) u.tg])
    (send-ok eyre-id)
  ::
      [%'POST' %know-untag]
    =/  k=(unit @t)  (~(get by args) 'key')
    =/  tg=(unit @t)  (~(get by args) 'tag')
    ?:  |(?=(~ k) ?=(~ tg))  (send-err eyre-id 400 'missing key or tag')
    =/  ko=(unit path)  (know-key u.k)
    ?~  ko  (send-err eyre-id 400 'invalid key')
    ;<  ~  bind:m  (poke-know [%untag (spat u.ko) u.tg])
    (send-ok eyre-id)
  ::
      [%'POST' %know-move]
    =/  fr=(unit @t)  (~(get by args) 'from')
    =/  to=(unit @t)  (~(get by args) 'to')
    ?:  |(?=(~ fr) ?=(~ to))  (send-err eyre-id 400 'missing from or to')
    =/  fko=(unit path)  (know-key u.fr)
    =/  tko=(unit path)  (know-key u.to)
    ?:  |(?=(~ fko) ?=(~ tko))  (send-err eyre-id 400 'invalid from or to')
    ::  old-agent status contract: 404 if `from` is absent, 409 if `to` is already
    ::  live. The writer independently guards against clobber (returns a no-op),
    ::  but the route surfaces the right code — and closes the read/poke TOCTOU
    ::  since the serialized writer re-checks authoritatively.
    ;<  es=(map path know-entry:lk)  bind:m  read-know-map
    ?.  (~(has by es) u.fko)  (send-err eyre-id 404 'from not found')
    ?:  (~(has by es) u.tko)  (send-err eyre-id 409 'to already exists')
    ;<  ~  bind:m  (poke-know [%move (spat u.fko) (spat u.tko)])
    (send-ok eyre-id)
  ::
      [%'POST' %know-publish]
    =/  k=(unit @t)  (~(get by args) 'key')
    ?~  k  (send-err eyre-id 400 'missing key')
    =/  ko=(unit path)  (know-key u.k)
    ?~  ko  (send-err eyre-id 400 'invalid key')
    ;<  es=(map path know-entry:lk)  bind:m  read-know-map
    =/  e=(unit know-entry:lk)  (~(get by es) u.ko)
    ?~  e  (send-err eyre-id 404 'not found')
    =/  prel=@t  (~(gut by args) 'path' u.k)
    =/  pp=(each path tang)  (mule |.((pub-path prel)))
    ?:  ?=(%| -.pp)  (send-err eyre-id 400 'invalid path')
    ;<  ~  bind:m  (poke-pub [%save-page (spat p.pp) body.u.e])
    (send-ok eyre-id)
  ==
::  +poke-know / +poke-pub: poke the single writer fiber (root /main.sig) with a
::  typed action; grubbery vales the noun through the action marc. The writer
::  serialises all mutations, so concurrent requests can't race the index.
::
++  poke-know
  |=  act=know-action:lk
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (poke:io [%| 2 %& ~ %'main.sig'] [[/lattice %know-action] act])
++  poke-pub
  |=  act=pub-action:lp
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (poke:io [%| 2 %& ~ %'main.sig'] [[/lattice %pub-action] act])
++  poke-sub
  |=  act=sub-action:lp
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (poke:io [%| 2 %& ~ %'main.sig'] [[/lattice %sub-action] act])
::  +parse-import: decode a /know-all export ({items:[{key,body,updated,tags}]})
::  into [key entry] pairs for a verbatim %import. Mirrors know-entry-json's shape;
::  vector is not exported (a derived embedding) so it lands ~.
++  import-item
  |=  jon=json
  ^-  [@t know-entry:lk]
  =+  ^-  [key=@t body=@t updated=@da tags=(set @t)]
    %.  jon
    %-  ot:dejs:format
    :~  key+so:dejs:format
        body+so:dejs:format
        updated+(cu:dejs:format |=(a=@t `@da`(slav %da a)) so:dejs:format)
        tags+(as:dejs:format so:dejs:format)
    ==
  ::  normalize imported tags to match the /know-tag write path (case-folded),
  ::  so imported entries stay reachable via explore.
  [key body updated (~(run in tags) norm-tag) ~]
++  parse-import
  |=  jon=json
  ^-  (list [@t know-entry:lk])
  ((ot:dejs:format items+(ar:dejs:format import-item) ~) jon)
::  +import-know-loop: poke %import per entry. poke:io waits for the writer's ack,
::  so this is serial+synchronous — every entry is applied before the next.
++  import-know-loop
  |=  [items=(list [key=@t entry=know-entry:lk]) cnt=@ud]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ?~  items  (pure:m cnt)
  ;<  ~  bind:m  (poke-know [%import key.i.items entry.i.items])
  (import-know-loop t.items (add cnt 1))
::  +obelisk-exec: run one urQL script against %obelisk (write path — INSERT/DDL
::  for the catalog). Fire-and-forget: obelisk wraps queries in a mule and always
::  positive-acks; the real per-query result comes on its /server subscription
::  (see obelisk-query). ~ = delivered, `tang = gall could not deliver (obelisk
::  missing). db is the default database the script runs against.
::
++  obelisk-exec
  |=  [db=@tas urql=tape]
  =/  m  (fiber:fiber:nexus ,(unit tang))
  ^-  form:m
  ::  guard: a LOCAL gall-poke makes grubbery resolve the target's mark with a
  ::  %gd scry that BAILS when the agent isn't installed — bailing the whole
  ::  event, which rolls back an in-progress nexus reload. gall-poke-or-nack
  ::  can't catch that (the crash precedes the poke-ack). So confirm obelisk is
  ::  running first via %gu, which answers %.n instead of bailing, and report it
  ::  missing rather than poking a dead agent.
  ;<  up=?  bind:m  (typed-scry:io ? %loob /gu/obelisk/$)
  ?.  up  (pure:m `~[leaf+"obelisk not installed"])
  (gall-poke-or-nack-safe %obelisk [%obelisk-action [%tape db urql]])
::  +obelisk-sub-base: the grubbery tree dir where obelisk's /server fact is
::  materialized by a %gall-watch subscription (grubbery gall-sub-dir). The
::  result lands at .../data, the live flag at .../live.
::
++  obelisk-sub-base
  |=  our=@p
  ^-  path
  /sys/gall/subs/(scot %p our)/obelisk/server
::  +obelisk-live: is the obelisk /server subscription established (watch-ack'd)?
::
++  obelisk-live
  |=  our=@p
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  =/  road=road:tarball  [%& %& (obelisk-sub-base our) %live]
  ;<  ex=?  bind:m  (peek-exists:io road)
  ?.  ex  (pure:m %.n)
  ;<  =seen:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%& %file *] seen)  (pure:m %.n)
  (pure:m !<(? (need-vase:tarball sang.p.seen)))
::  +obelisk-ensure-sub: make sure we're subscribed to obelisk /server before a
::  query. obelisk kicks all /server subscribers after each result, so grubbery
::  auto-resubscribes — this waits for the (re)subscription to go live, poking a
::  fresh %gall-watch only if none is in flight.
::
++  obelisk-ensure-sub
  |=  our=@p
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  live=?  bind:m  (obelisk-live our)
  ?:  live  (pure:m ~)
  =/  road=road:tarball  [%& %& (obelisk-sub-base our) %live]
  ;<  ex=?  bind:m  (peek-exists:io road)
  ::  never subscribed -> poke %gall-watch; else a resub is already in flight.
  ;<  ~  bind:m
    ?:  ex  (pure:m ~)
    (gall-poke-or-nack-drop %grubbery [%gall-watch [our %obelisk /server]])
  (obelisk-wait-live our 40)
++  gall-poke-or-nack-drop
  |=  [=dude:gall =page]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  *  bind:m  (gall-poke-or-nack-safe dude page)
  (pure:m ~)
++  obelisk-wait-live
  |=  [our=@p n=@ud]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?:  =(0 n)  (pure:m ~)
  ;<  live=?  bind:m  (obelisk-live our)
  ?:  live  (pure:m ~)
  ;<  ~  bind:m  (sleep-safe (div ~s1 10))
  (obelisk-wait-live our (dec n))
::  +obelisk-run-one: run one urQL SELECT (or any script) against %obelisk and
::  return its result. obelisk answers on its /server subscription (no scries),
::  which grubbery materializes at .../data. We keep that grub, poke, take the
::  result wave, then read + clam it. Called ONLY by the obelisk owner fiber
::  (/cat/obelisk.sig), which guarantees one-in-flight; callers reach it via
::  +obelisk-query -> owner poke. See finding #1.
::
++  obelisk-run-one
  |=  [db=@tas urql=tape]
  =/  m  (fiber:fiber:nexus ,(each (list cmd-result:ast) tang))
  ^-  form:m
  ::  short-circuit when obelisk isn't installed: skip the sub/keep/poke churn
  ::  (which would otherwise stall 4s in obelisk-ensure-sub waiting for a sub
  ::  that can never go live) and return the missing-agent error directly. Same
  ::  %gu liveness check obelisk-exec uses. See obelisk-exec for why this matters.
  ;<  up=?  bind:m  (typed-scry:io ? %loob /gu/obelisk/$)
  ?.  up  (pure:m [%| ~[leaf+"obelisk not installed"]])
  ;<  our=@p  bind:m  bowl-our
  =/  data-road=road:tarball  [%& %& (obelisk-sub-base our) %data]
  ;<  ~           bind:m  (obelisk-ensure-sub our)
  ::  clear any stale result first: save-file suppresses no-op writes, so an
  ::  identical result to last time would never fire a wave (fiber would hang).
  ::  Culling guarantees the next fact is a fresh create -> always a wave.
  ;<  *           bind:m  (cull-soft:io data-road)
  ::  keep the data grub (initial wave consumed), then poke; the fact write fires
  ::  the next wave. keep before poke so we can't miss the fact.
  ;<  *           bind:m  (keep:io /obelisk-q data-road ~)
  ;<  err=(unit tang)  bind:m  (obelisk-exec db urql)
  ?^  err
    ;<  ~  bind:m  (drop:io /obelisk-q data-road)
    (pure:m [%| u.err])
  ::  wait for the result wave, but arm a 15s timer so a down/unresponsive obelisk
  ::  returns an error rather than hanging the request fiber forever.
  ;<  now=@da     bind:m  bowl-now
  =/  until=@da   (add now ~s15)
  ;<  ~           bind:m  (send-wait:io until)
  ::  match ONLY our own timer (take-news-or-wake-until), not any stale wake left
  ::  by a prior query in this fiber — see finding #5.
  ;<  nw=news-or-wake:io  bind:m  (take-news-or-wake-until /obelisk-q until)
  ;<  ~           bind:m  (drop:io /obelisk-q data-road)
  ?:  ?=(%wake -.nw)
    (pure:m [%| ~[leaf+"obelisk: query timed out (agent down?)"]])
  ;<  res=(each (list cmd-result:ast) tang)  bind:m  (obelisk-read-data data-road)
  ::  settle: obelisk kicks /server right after the fact; let grubbery process
  ::  that kick + auto-resub (live n->y) so a back-to-back query's ensure-sub
  ::  sees a stable sub rather than a stale live=y that's about to be torn down.
  ::  ponytail: fixed 0.5s; the real fix is a dedicated obelisk fiber serialising
  ::  queries through one long-lived sub (build if crawl throughput needs it).
  ::  KNOWN LIMIT (finding #2): the shared /server fact carries no query id, so if
  ::  obelisk takes >15s (this call times out) and then delivers that late result
  ::  during the NEXT query's wait, the next caller reads the stale rows. Needs a
  ::  nonce echoed in the urQL + verified on read-back, or the dedicated-sub redesign
  ::  above. Cannot happen on a responsive local obelisk (results land in ms); only
  ::  under a wedged obelisk with concurrent catalog callers.
  ;<  ~           bind:m  (sleep-safe (div ~s1 2))
  (pure:m res)
::  +obelisk-query: caller-facing entry (request fibers + crawler). Pokes the
::  obelisk owner (/cat/obelisk.sig) with the query + a unique result-grub rail,
::  keeps that grub, and waits for the owner to write the answer there. Routing
::  every query through the one owner serialises access to the shared /server sub,
::  so concurrent callers never read each other's results (finding #1). Absolute
::  roads so it resolves identically from depth-2 request fibers and the depth-0
::  crawler.
::
::  KNOWN LIMIT (review: unbounded born growth): every query mints a fresh
::  unique-nonce rail, and grubbery never reclaims a rail's born hist skeleton —
::  delete only appends a tomb ("NOT born - it's a high-water mark"), and %lose
::  (drop-hist) rewrites matched entries as tombs IN PLACE, appending a fresh
::  wavefront when the top matches, so no dart shrinks it (verified against
::  drop-hist; adding %lose to these culls would reclaim nothing and grow the
::  hist by one entry per call). Content lobes ARE reclaimed — the result grub
::  is %temp, so cull's tomb-temp drops its ject ref — leaving ~one rail + two
::  tombed hist entries of permanent skeleton per query. The nonce cannot be
::  pooled or reused per caller: after a 30s owner timeout the owner may still
::  write the OLD query's result to that rail, and a reused name would deliver
::  it to the NEXT query's keep — cross-query contamination, the class of bug
::  this owner routing exists to prevent. ponytail: ceiling is slow monotonic
::  born growth (order 100s of bytes per obelisk round-trip; ~1.2k rails/day
::  per 100 pages crawled on the ~h6 tick). Real fix is a fiber-to-fiber
::  poke-back — the owner pokes the result straight to the caller's grub, no
::  result rail at all — which needs a take-poke path in every waiting caller.
::
++  obelisk-query
  |=  [db=@tas urql=tape]
  =/  m  (fiber:fiber:nexus ,(each (list cmd-result:ast) tang))
  ^-  form:m
  ;<  rw=wire  bind:m  (nonce:io /obk-res)
  =/  nom=@ta  (rear rw)
  =/  res-dir=path  (weld app-base /cat/obk-out)
  =/  res-road=road:tarball  [%& %& res-dir nom]
  ::  keep our (fresh, unique-nonce) result grub BEFORE poking, so the owner's
  ::  create-wave can't be missed. No pre-cull: the name is unique so nothing stale
  ::  exists, and culling a never-existent grub just spams grubbery's "no grub" log.
  ;<  *  bind:m  (keep:io rw res-road ~)
  ;<  ~  bind:m  (poke-obk [db urql res-dir nom])
  ;<  now=@da  bind:m  bowl-now
  ::  the owner runs its own 15s obelisk wait; add margin for a queued owner.
  =/  until=@da  (add now ~s30)
  ;<  ~  bind:m  (send-wait:io until)
  ;<  nw=news-or-wake:io  bind:m  (take-news-or-wake-until rw until)
  ;<  ~  bind:m  (drop:io rw res-road)
  ?:  ?=(%wake -.nw)
    ;<  *  bind:m  (cull-soft:io res-road)
    (pure:m [%| ~[leaf+"obelisk: owner timed out"]])
  ;<  res=(each (list cmd-result:ast) tang)  bind:m  (obk-read-res res-road)
  ;<  *  bind:m  (cull-soft:io res-road)
  (pure:m res)
::  +poke-obk: poke the obelisk owner with a query request. Absolute road so it
::  works from any caller depth (request fiber or crawler).
::
++  poke-obk
  |=  req=obk-req:ast
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (poke:io [%& %& (weld app-base /cat) %'obelisk.sig'] [[/lattice %obk-req] req])
::  +sweep-obk-out: cull every result grub currently under /cat/obk-out. Run once
::  at owner startup: any grub sitting there is orphaned (finding #6) — a caller
::  that timed out (30s) or disconnected before the owner wrote its result, so the
::  owner re-created a grub nobody culls. Callers are ephemeral, so at owner (re)start
::  nothing there is live. ponytail: startup sweep bounds the CONTENT leak (live
::  orphans' lobes); the culled rails' born hist skeletons are permanent either way
::  — see obelisk-query's KNOWN LIMIT. On a fast local obelisk callers get their
::  wave in ms and never orphan, so steady-state orphan growth is ~0. Upgrade to a
::  fiber-to-fiber poke-back (no shared grub) if it ever matters.
++  sweep-obk-out
  |=  base=path
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io [%& %| base] ~)
  ?.  ?=([%& %ball *] seen)  (pure:m ~)
  ::  result grubs are flat FILES at this node, so they live in contents.u.fil —
  ::  NOT in dir (which holds only child *directories*, always empty here). Reading
  ::  dir made the sweep a permanent no-op. Mirror collect-entries / read-know-map.
  =/  names=(list @ta)
    ?~  fil.ball.p.seen  ~
    (turn ~(tap by contents.u.fil.ball.p.seen) |=([s=@ta *] s))
  |-
  ?~  names  (pure:m ~)
  ;<  *  bind:m  (cull-soft:io [%& %& base i.names])
  $(names t.names)
::  +sleep-draining: sleep for `for`, but consume the stray inputs that land during
::  the window (finding #13) instead of skipping+retaining them: both [/ %timer-wake]
::  pokes AND the late %peek/%veto of a peek-remote-wait that already timed out.
::  Early-resolving obelisk-query / peek-remote-wait calls in this fiber leave their
::  send-wait timers armed (fiberio has no timer-cancel) and their peeks outstanding;
::  a plain +sleep (take-wake with a fixed `until`) skips those non-matching inputs,
::  so they pile up in the crawler's skip queue forever. Here we arm one deadline,
::  then take-wake-drain ANY of them in a loop, ending only once the clock reaches the
::  deadline — so each stray is consumed as it fires rather than accumulating.
++  sleep-draining
  |=  for=@dr
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  now=@da  bind:m  bowl-now
  =/  wake-at=@da  (add now for)
  ;<  ~  bind:m  (send-wait:io wake-at)
  |-
  ;<  ~  bind:m  take-wake-drain
  ;<  chk=@da  bind:m  bowl-now
  ?:  (gte chk wake-at)  (pure:m ~)
  $
::  +obk-read-res: read the owner's result grub (a local %& vase via obk-res mark).
::
++  obk-read-res
  |=  res-road=road:tarball
  =/  m  (fiber:fiber:nexus ,(each (list cmd-result:ast) tang))
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io res-road ~)
  ?.  ?=([%& %file *] seen)
    (pure:m [%| ~[leaf+"obelisk: no result grub"]])
  =/  parsed  (mule |.(!<((each (list cmd-result:ast) tang) (need-vase:tarball sang.p.seen))))
  ?:  ?=(%| -.parsed)  (pure:m [%| p.parsed])
  (pure:m p.parsed)
::  +obelisk-read-data: read the materialized /server fact grub. grubbery has no
::  marc:tarball for %noun (gub/mar/noun is a clay mark), so the fact is stored
::  page-wrapped as [%noun <each-noun>]; unwrap that (or accept a bare each if a
::  marc ever validates it) and clam to obelisk's result type.
::
++  obelisk-read-data
  |=  data-road=road:tarball
  =/  m  (fiber:fiber:nexus ,(each (list cmd-result:ast) tang))
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io data-road ~)
  ?.  ?=([%& %file *] seen)
    (pure:m [%| ~[leaf+"obelisk: no result grub"]])
  =/  raw=*  q:(need-vase:tarball sang.p.seen)
  =/  en=*  ?:(&(?=(^ raw) =(%noun -.raw)) +.raw raw)
  =/  parsed  (mule |.(;;((each (list cmd-result:ast) tang) en)))
  ?:  ?=(%| -.parsed)  (pure:m [%| p.parsed])
  (pure:m p.parsed)
::  +obelisk-json: render an obelisk result (or error) as JSON — the retired
::  gall agent's FLAT-OBJECT contract, which the Kotlin client's catalog reads
::  and the ship's MCP tools parse: success is {ok:true, action, relation,
::  count, columns:[names], rows:[[cell,..]]} (rows are ORDERED ARRAYS, column
::  order from the result-set's first vector); error is {ok:false, error}.
::  Ported from the old lib's +ob-results-json (client contract, byte-for-byte).
::
++  obelisk-json
  |=  res=(each (list cmd-result:ast) tang)
  ^-  json
  ?:  ?=(%| -.res)
    (obelisk-err-json (obelisk-tang-text p.res))
  =/  results=(list result:ast)  (zing (turn p.res |=(cr=cmd-result:ast +.cr)))
  =/  action=@t  ''
  =/  relation=@t  ''
  =/  count=(unit @ud)  ~
  =/  vecs=(list vector:ast)  ~
  |-
  ?^  results
    %=  $
      results   t.results
      action    ?:(?=(%action -.i.results) action.i.results action)
      relation  ?:(?=(%relation -.i.results) relation.i.results relation)
      count     ?:(?=(%vector-count -.i.results) `count.i.results count)
      vecs      ?:(?=(%result-set -.i.results) set.i.results vecs)
    ==
  =/  cols=(list @t)
    ?~  vecs  ~
    (turn `(lest vector-cell:ast)`+.i.vecs |=(c=vector-cell:ast p.c))
  =/  rows=(list json)
    %+  turn  vecs
    |=  v=vector:ast
    ^-  json
    a+(turn `(lest vector-cell:ast)`+.v |=(c=vector-cell:ast s+(obelisk-cell-cord q.c)))
  %-  pairs:enjs:format
  :~  ['ok' b+&]
      ['action' s+action]
      ['relation' s+relation]
      ['count' (numb:enjs:format ?~(count (lent vecs) u.count))]
      ['columns' a+(turn cols |=(c=@t s+c))]
      ['rows' a+rows]
  ==
::  +obelisk-cell-cord: render one typed cell for display. Text auras (t/ta/tas)
::  hold the cord verbatim; scot would re-escape it ('Urbit Basics' ->
::  ~~~55.rbit...). Emit the raw cord for those; scot the rest (@p/@ud/@da/@rs)
::  so their aura syntax survives.
++  obelisk-cell-cord
  |=  d=dime
  ^-  @t
  ?:  |(=('t' p.d) =('ta' p.d) =('tas' p.d))
    q.d
  (scot d)
::  +obelisk-err-json / +obelisk-tang-text: the old agent's {ok:false, error}
::  envelope and its tang -> cord rendering. No per-tank separator, so the
::  single-leaf 'obelisk not installed' stays EXACT — the client's obelisk
::  presence probe string-matches that text.
++  obelisk-err-json
  |=  msg=@t
  ^-  json
  (pairs:enjs:format ~[['ok' b+|] ['error' s+msg]])
++  obelisk-tang-text
  |=  =tang
  ^-  @t
  (crip (zing (turn tang |=(=tank ~(ram re tank)))))
::  +send-obelisk: answer a route with an obelisk query result under the OLD
::  agent's status contract: 503 when obelisk is absent, 504 when the query or
::  the owner timed out, 502 when the transport broke mid-flight (result grub
::  missing), and 200 otherwise — including obelisk's own urQL error, which
::  rides the 200 {ok:false, error} envelope exactly as the old agent's
::  obelisk-result-json did. Transport failures are matched by their exact tang
::  texts (all minted in this file: obelisk-run-one, obelisk-query, obk-read-res
::  and obelisk-read-data); an unrecognized tang is obelisk's own query error.
++  send-obelisk
  |=  [eyre-id=@ta res=(each (list cmd-result:ast) tang)]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?:  ?=(%& -.res)  (send-json eyre-id (obelisk-json res))
  =/  txt=@t  (obelisk-tang-text p.res)
  ?:  =('obelisk not installed' txt)  (send-err eyre-id 503 txt)
  ?:  =('obelisk: owner timed out' txt)  (send-err eyre-id 504 txt)
  ?:  =('obelisk: query timed out (agent down?)' txt)  (send-err eyre-id 504 txt)
  ?:  =('obelisk: no result grub' txt)  (send-err eyre-id 502 txt)
  (send-json eyre-id (obelisk-err-json txt))
::  +obelisk-col-cords: pull one column's raw dime values (as cords) out of a
::  query result, across every result-set row. Used by the ghost-row reconcile
::  to read back the `path` column. A `%| error` result yields the empty set, so
::  callers treat "obelisk unreachable" as "nothing stored" (safe no-op).
++  obelisk-col-cords
  |=  [res=(each (list cmd-result:ast) tang) col=@tas]
  ^-  (set @t)
  ?.  ?=([%& *] res)  ~
  =/  results=(list result:ast)  (zing (turn p.res |=(cr=cmd-result:ast +.cr)))
  =|  out=(set @t)
  |-  ^-  (set @t)
  ?~  results  out
  ?.  ?=([%result-set *] i.results)
    $(results t.results)
  =.  out  (obelisk-col-rows out col set.i.results)
  $(results t.results)
++  obelisk-col-rows
  |=  [out=(set @t) col=@tas rows=(list vector:ast)]
  ^-  (set @t)
  ?~  rows  out
  =/  cells=(list vector-cell:ast)  +.i.rows
  =.  out
    |-  ^-  (set @t)
    ?~  cells  out
    ?:  =(col p.i.cells)  (~(put in out) `@t`q.q.i.cells)
    $(cells t.cells)
  $(rows t.rows)
++  catalog-db  `@tas`%lattice
::  +catalog-run: run one urQL statement against the catalog db, waiting for it
::  to actually execute. Uses obelisk-query (not obelisk-exec) even for writes:
::  obelisk kicks its /server subscribers after every poke, so with a live sub
::  a fire-and-forget obelisk-exec in a SEQUENCE races the kick/resub cycle and
::  silently drops statements. obelisk-query re-establishes the sub per call, so
::  sequential writes land reliably. ponytail: ceiling is one round-trip per
::  statement; batch into fewer scripts if crawl throughput ever demands it.
::
::  KNOWN LIMIT (finding #13): the (each ... tang) result is discarded, so callers
::  (catalog-classify, catalog-init, the /save+/delete sweeps) send {"ok":true}
::  even when the obelisk write no-ops (e.g. classifying a URL absent from
::  catalog-pages) or errors. Catalog writes are best-effort indexing; surface the
::  result (502 on %|) here if a client ever needs a real applied/failed signal.
++  catalog-run
  |=  [db=@tas urql=tape]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  *  bind:m  (obelisk-query db urql)
  (pure:m ~)
::  +catalog-init: create the lattice database, then each catalog table as its OWN
::  poke (per catalog-create-list's contract — the joined catalog-create-urql would
::  abort at the first already-existing table and never create the rest). Each
::  catalog-run is a distinct obelisk event via obelisk-query (which re-establishes
::  the sub per call), so there's no kick/resub race, and a re-run idempotently
::  repairs a partial/evolved schema: existing tables error harmlessly (the ack is
::  swallowed), missing ones get created.
::
++  catalog-init
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  ~  bind:m  (catalog-run %sys (weld "CREATE DATABASE " (trip catalog-db)))
  (catalog-create-loop catalog-create-list:cat)
++  catalog-create-loop
  |=  stmts=(list tape)
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?~  stmts  (pure:m ~)
  ;<  ~  bind:m  (catalog-run catalog-db i.stmts)
  (catalog-create-loop t.stmts)
::  +know-reindex: rebuild the obelisk knowledge index from the live vault. Ensure
::  the db + knowledge/tags tables exist (create errors swallowed, like catalog-init),
::  then TRUNCATE + re-INSERT every entry in one write. Driven by POST /know-reindex
::  (the Explore pane's Reindex button); the index is stale between reindexes.
::
++  know-reindex
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  entries=(map path know-entry:lk)  bind:m  read-know-map
  ;<  ~  bind:m  (catalog-run %sys (weld "CREATE DATABASE " (trip catalog-db)))
  ;<  ~  bind:m  (catalog-create-loop know-index-create-list:cat)
  =/  rows=(list [item=@t updated=@da tags=(list @t)])
    %+  turn  ~(tap by entries)
    |=  [key=path e=know-entry:lk]
    [(spat key) updated.e ~(tap in tags.e)]
  ::  populate via catalog-run (obelisk-query -> the serializing obelisk owner), NOT
  ::  raw obelisk-exec: a direct poke's result fact lands on the shared /server sub,
  ::  where a concurrent owner-routed query could misread it as its own result.
  (catalog-run catalog-db (know-index-populate-urql:cat rows))
::  +catalog-index-page: analyze one page body and write its catalog rows — the
::  two-poke page upsert (ensure INSERT + content refresh) plus the term index.
::  pat is the content-map key (/pub/.../gmi); the url is derived inside the urQL
::  gens. pages is the publisher's full key set (for internal-link detection).
::
::  +body-cap: max page bytes fed to the analyzer. Peer pages are UNTRUSTED — a
::  hostile publisher could serve a huge body to burn crawl CPU. end truncates to
::  the low body-cap bytes (a no-op for a smaller body); analysis is lossy anyway.
::
++  body-cap  ^-(@ud 1.048.576)
::  +manifest-max: max pages indexed from ONE followed peer per sweep. A hostile
::  publisher could advertise an unbounded /pub/index; each page costs a 30s remote
::  peek + 3 obelisk pokes, so cap the fan-out. Own pages (scan-self) are trusted
::  and uncapped.
++  manifest-max  ^-(@ud 1.024)
++  catalog-index-page
  |=  [src=@p pub=@p pat=path now=@da body=@t pages=(set path)]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  a  (catalog-analyze:cat (end [3 body-cap] body))
  ::  KNOWN GAP (finding #8): these are 3 separate owner pokes, not one obelisk
  ::  event, so a concurrent /delete of this same page can interleave and leave
  ::  orphaned catalog-terms rows (ghost hits). Upgrade: fold ensure+refresh+terms
  ::  into ONE urQL script (like catalog-init) so a page's write is atomic at the
  ::  owner. Narrow race (concurrent index+delete of the SAME page); left for now.
  ;<  ~  bind:m  (catalog-run catalog-db (catalog-page-ensure-urql:cat src pub pat now a))
  ;<  ~  bind:m  (catalog-run catalog-db (catalog-page-refresh-urql:cat src pub pat now a pages))
  (catalog-run catalog-db (catalog-page-terms-urql:cat src pub pat a))
::  +index-remote-page: re-index ONE remote page into the catalog on demand — the
::  live-subscription counterpart of the crawler's per-page work. A /sub/pages keep
::  fiber calls this whenever the peer edits the page (and once on subscribe), so
::  the change lands immediately instead of waiting for the ~h6 sweep. rel is the
::  normalized vault spur. Reads the peer's body + full index (for internal-link
::  detection), then writes the page's catalog rows. No-op if the page is
::  gone/unreachable, or if obelisk is absent (the obelisk-run-one guard swallows).
::
++  index-remote-page
  |=  [pub=@p rel=path]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  our=@p   bind:m  bowl-our
  ;<  now=@da  bind:m  bowl-now
  ;<  body=(unit @t)  bind:m  (read-page-body pub rel)
  ?~  body  (pure:m ~)
  ;<  u-ix=(unit pub-index:lp)  bind:m  (read-pub-index-remote pub)
  =/  ix=pub-index:lp  (fall u-ix *pub-index:lp)
  =/  pat=path  (weld /pub (snoc rel %gmi))
  (catalog-index-page our pub pat now u.body ~(key by ix))
::  +catalog-scan-self: index every one of OUR OWN published pages into the
::  catalog (source = publisher = our). The local, peer-free slice of the crawler
::  — proves the analyze -> obelisk pipeline end to end. Returns the count indexed.
::
++  catalog-scan-self
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  our=@p       bind:m  bowl-our
  ;<  now=@da      bind:m  bowl-now
  ::  ABSOLUTE road via app-base, not a drop-N relative road: scan-self runs from
  ::  both the depth-2 /ui/requests fiber AND the depth-0 /crawler.sig fiber, so a
  ::  relative road would resolve differently per caller.
  ;<  ix=pub-index:lp  bind:m  (read-pub-index [%& %& (weld app-base /pub) %index])
  =/  pages=(set path)  ~(key by ix)
  (catalog-scan-loop our now ~(tap in pages) pages 0)
++  catalog-scan-loop
  |=  [our=@p now=@da keys=(list path) pages=(set path) cnt=@ud]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ?~  keys  (pure:m cnt)
  =/  stripped=path  (strip-pub:lp i.keys)
  ?~  stripped  (catalog-scan-loop our now t.keys pages cnt)
  ::  content key /pub/a/gmi -> vault rel /a (strip leading pub, trailing gmi)
  =/  rel=path  (snip `path`stripped)
  ;<  body=(unit @t)  bind:m  (read-page-body our rel)
  ?~  body  (catalog-scan-loop our now t.keys pages cnt)
  ;<  ~  bind:m  (catalog-index-page our our i.keys now u.body pages)
  (catalog-scan-loop our now t.keys pages (add cnt 1))
::  +catalog-scan-peers: sweep every followed publisher into the catalog. source
::  = our (the crawler ship), publisher = them. Needs peers/follows to exercise;
::  a no-op until /follow is used. ponytail: full re-crawl per tick; per-follow
::  since-cursors and a hash-diff skip layer on here once catalog size warrants.
::  ponytail: peek-remote blocks on take-peek, so an unreachable follow stalls
::  the sweep (self-scan already ran, so own pages stay fresh) — same limitation
::  as /fetch. Only follow live lattice peers; a per-peer timeout is a later layer.
::
++  catalog-scan-peers
  |=  [our=@p now=@da]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  fs=follows:lp  bind:m  read-follows
  (catalog-scan-peers-loop our now ~(tap in fs) 0)
++  catalog-scan-peers-loop
  |=  [our=@p now=@da ships=(list @p) cnt=@ud]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ?~  ships  (pure:m cnt)
  ;<  n=@ud  bind:m  (catalog-scan-peer our i.ships now)
  (catalog-scan-peers-loop our now t.ships (add cnt n))
::  +catalog-scan-peer: index one peer's published pages via peek-remote.
::  After indexing the peer's CURRENT manifest, +catalog-reconcile-peer sweeps
::  the rows we stored on a PRIOR sweep for pages the peer has since UNPUBLISHED
::  — otherwise their catalog-pages/terms/headings/links/tags/meta rows linger as
::  stale search hits that 404 on read (finding #5). Runs every ~h6 crawler tick.
++  catalog-scan-peer
  |=  [our=@p pub=@p now=@da]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  u-ix=(unit pub-index:lp)  bind:m  (read-pub-index-remote pub)
  ::  unreachable / malformed / vetoed peer -> ~ (NOT a genuine empty index). Index
  ::  and reconcile NOTHING: reconciling against an empty set deletes every stored
  ::  row for a merely-offline peer (a reachable-but-empty peer yields `~ *pub-index
  ::  and reconciles correctly, dropping the pages it really unpublished).
  ?~  u-ix  (pure:m 0)
  ::  drop keys whose knots don't reparse. An untrusted peer can serve a path with a
  ::  byte outside the knot charset (uppercase/space/control); it survives the clam,
  ::  then stores lossily (false-ghosts a live page on reconcile) and crashes +stab.
  ::  Keep only canonical keys (rush-guarded) so poison never enters the index.
  =/  ix=pub-index:lp
    (~(gas by *pub-index:lp) (skim ~(tap by u.u-ix) |=([k=path *] ?=(^ (rush (spat k) stap)))))
  =/  pages=(set path)  ~(key by ix)
  ::  cap the indexed fan-out per peer (untrusted); pages stays full for
  ::  internal-link detection. ponytail: index the first manifest-max keys;
  ::  add per-peer cursoring if a real follow legitimately exceeds it.
  ::  RESIDUAL (review-3): this caps the expensive per-page work (peek + pokes),
  ::  but read-pub-index-remote already clammed the peer's ENTIRE index into `ix`,
  ::  so a hostile publisher can still force a transient allocation ~ its index
  ::  size. Bounding that needs a byte-cap at the peek/clam boundary; deferred with
  ::  the rest of the peer path until /follow is exercised.
  =/  keys=(list path)  (scag manifest-max ~(tap in pages))
  ::  bound this peer's page sweep by peer-budget (see +peer-budget) so one staller
  ::  can't monopolize the tick; deadline is fresh-now + budget, not the sweep's now.
  ;<  t0=@da    bind:m  bowl-now
  ;<  cnt=@ud   bind:m  (catalog-scan-peer-loop our pub now keys pages (add t0 peer-budget) 0)
  ;<  ~         bind:m  (catalog-reconcile-peer our pub pages)
  (pure:m cnt)
::  +catalog-reconcile-peer: drop catalog rows for pages this publisher no longer
::  lists. SELECT the stored `path`s for (source=our, publisher=pub), diff against
::  the current manifest `pages`, and delete each dropped key from every table.
::  Compares against the FULL `pages` (not the manifest-max-capped index slice) so
::  a page beyond the cap is never mistaken for unpublished. On an unreachable
::  obelisk the SELECT errors -> empty stored -> no deletes (safe no-op).
++  catalog-reconcile-peer
  |=  [our=@p pub=@p pages=(set path)]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  qr=(each (list cmd-result:ast) tang)  bind:m
    (obelisk-query catalog-db (catalog-peer-paths-urql:cat our pub))
  =/  stored=(set @t)   (obelisk-col-cords qr %path)
  ::  catalog-pages.path stores (spat content-key); compare on the same cords.
  =/  current=(set @t)  (silt (turn ~(tap in pages) |=(p=path (spat p))))
  =/  ghosts=(list @t)  ~(tap in (~(dif in stored) current))
  (catalog-reconcile-loop our pub ghosts)
++  catalog-reconcile-loop
  |=  [our=@p pub=@p ghosts=(list @t)]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?~  ghosts  (pure:m ~)
  ::  ghosts are stored cords; a row written before ingest-filtering (a malicious
  ::  peer, pre-upgrade) can hold an unparseable knot that would crash +stab and the
  ::  sweep fiber. rush-guard: skip+log an unparseable ghost rather than crash.
  =/  pp=(unit path)  (rush i.ghosts stap)
  ?~  pp
    ~&  [%lattice-reconcile-bad-ghost i.ghosts]
    (catalog-reconcile-loop our pub t.ghosts)
  ;<  ~  bind:m
    (catalog-run catalog-db (catalog-page-delete-urql:cat our pub u.pp))
  (catalog-reconcile-loop our pub t.ghosts)
++  catalog-scan-peer-loop
  |=  [our=@p pub=@p now=@da keys=(list path) pages=(set path) deadline=@da cnt=@ud]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ?~  keys  (pure:m cnt)
  ::  per-peer wall-clock budget (finding F): bail once spent so a peer stalling its
  ::  page peeks can't starve later peers. Overshoots by at most one remote-timeout
  ::  (the check is between peeks). ponytail: total worst case = follows*peer-budget;
  ::  add per-peer cursoring if a LEGIT peer's page set can't finish in one budget.
  ;<  clk=@da  bind:m  bowl-now
  ?:  (gte clk deadline)  ~&([%lattice-peer-budget-spent pub cnt] (pure:m cnt))
  =/  stripped=path  (strip-pub:lp i.keys)
  ?~  stripped  (catalog-scan-peer-loop our pub now t.keys pages deadline cnt)
  ;<  body=(unit @t)  bind:m  (read-page-body pub (snip `path`stripped))
  ?~  body  (catalog-scan-peer-loop our pub now t.keys pages deadline cnt)
  ;<  ~  bind:m  (catalog-index-page our pub i.keys now u.body pages)
  (catalog-scan-peer-loop our pub now t.keys pages deadline (add cnt 1))
::  +pub-path: a relative publish path ("notes/intro") -> content-map key
::  (/pub/notes/intro/gmi). Ported from /lib/lattice.
::
++  pub-path
  |=  rel=@t
  ^-  path
  ::  normalize to exactly ONE leading slash: a `rel` that already carries one
  ::  (e.g. a /know-list key `/a/b` handed straight to /know-publish) would else
  ::  weld to "//a/b", which +stab parses as an EMPTY leading knot -> the page is
  ::  gained at a junk path that diverges from the natural relative form.
  =/  raw=tape   (trip rel)
  =/  bare=tape  ?~(raw raw ?:(=('/' i.raw) t.raw raw))
  :(welp /pub (stab (crip (weld "/" bare))) /gmi)
::  +pub-road: the ABSOLUTE vault road of a published page's gmi grub, from a raw
::  url path. Built exactly as apply-pub writes it (pub-path -> key-to-rail), so
::  history reads land on the same grub. ~ if the path is unparseable/degenerate.
::  Used by the version-history routes to peep/peek-at a page's prior revisions.
::
++  pub-road
  |=  raw=@t
  ^-  (unit road:tarball)
  =/  pp=(each path tang)  (mule |.((pub-path raw)))
  ?:  ?=(%| -.pp)  ~
  =/  vr=(unit vrail:lp)  (key-to-rail:lp (weld app-base /pub/vault) p.pp)
  ?~  vr  ~
  `[%& %& pax.u.vr nom.u.vr]
::  +know-hist-road: the ABSOLUTE road of a know key's entry grub, for reading its
::  revision history. A live key's grub is under /know/vault; a DELETED key was
::  MOVED to /know/trash-vault (%del moves the grub, it doesn't tomb in place), so
::  its history lives there instead — resolve live-first, then trash. peep + peek-at
::  MUST use the same road: a rev from one road's history bails peek-at on the other.
::  ~ if the key is unparseable or exists in neither vault. The `trashed` flag lets
::  the UI label a deleted key's (shallow, one-snapshot) history.
::
++  know-hist-road
  |=  raw=@t
  =/  m  (fiber:fiber:nexus ,(unit [road=road:tarball trashed=?]))
  ^-  form:m
  =/  ko=(unit path)  (know-key raw)
  ?~  ko  (pure:m ~)
  =/  live=road:tarball   (entry-road (weld app-base /know/vault) u.ko)
  =/  trash=road:tarball  (entry-road (weld app-base /know/trash-vault) u.ko)
  ;<  el=(unit know-entry:lk)  bind:m  (read-entry live)
  ?^  el  (pure:m `[live %.n])
  ;<  et=(unit know-entry:lk)  bind:m  (read-entry trash)
  ?^  et  (pure:m `[trash %.y])
  (pure:m ~)
::  +req-body: the request body as a cord ('' if none).
::
++  req-body
  |=  req=inbound-request:eyre
  ^-  @t
  ?~  body.request.req  ''
  q.u.body.request.req
::  +send-ok: the {"ok":true} write response.
::
++  send-ok
  |=  eyre-id=@ta
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (send-json eyre-id (pairs:enjs:format ~[['ok' b+&]]))
::  +send-json / +send-err: response helpers through the srv door.
::
++  send-json
  |=  [eyre-id=@ta jon=json]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  %+  send-simple:srv  eyre-id
  :-  [200 ['content-type' 'application/json']~]
  `(as-octs:mimes:html (en:json:html jon))
++  send-err
  |=  [eyre-id=@ta code=@ud msg=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  %+  send-simple:srv  eyre-id
  :-  [code ['content-type' 'application/json']~]
  `(as-octs:mimes:html (en:json:html (pairs:enjs:format ~[['error' s+msg]])))
::  +read-know-map: peek the whole know vault into a (map path know-entry).
::
++  read-know-map
  =/  m  (fiber:fiber:nexus ,(map path know-entry:lk))
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io [%| 2 %| /know/vault] ~)
  ?.  ?=([%& %ball *] seen)  (pure:m ~)
  (pure:m (collect-entries ~ ball.p.seen))
::  ── JSON renderers (ported from /lib/lattice; client contract, byte-for-byte) ──
::
++  tags-json
  |=  tags=(set @t)
  ^-  [@t json]
  :-  'tags'
  :-  %a
  (turn (sort ~(tap in tags) aor) |=(t=@t s+t))
++  know-entry-json
  |=  [kp=path e=know-entry:lk]
  ^-  json
  %-  pairs:enjs:format
  :~  ['key' s+(spat kp)]
      ['body' s+body.e]
      ['updated' s+(scot %da updated.e)]
      (tags-json tags.e)
  ==
::  +mcp-tools-json: the knowledge-store MCP tool catalog served at GET /mcp-tools.
::  Static name/description/input-schema per tool (all params are strings); an MCP
::  server discovers these and drives each via its matching know-* HTTP route. The
::  six tools mirror the retired agent's /mcp/tools scry.
::
++  mcp-tools-json
  ^-  json
  =/  tools=(list [nom=@t des=@t params=(list [pn=@t pd=@t]) reqd=(list @t)])
    :~  ['know-list' 'List the ship knowledge items (keys + metadata, no bodies).' ~ ~]
        ['know-tags' 'List the tag vocabulary with per-tag item counts.' ~ ~]
        :*  'know-explore'  'Filter knowledge items by tag and/or a body-substring query; returns matching keys + metadata + tags (no bodies).'
            :~  ['tags' 'comma-separated tags to filter by (optional)']
                ['match' 'any (OR, the default) or all (AND) across the given tags']
                ['q' 'substring to match within item bodies (optional)']
            ==
            ~
        ==
        :*  'know-read'  'Read one knowledge item (body + tags) by key, e.g. /projects/x.'
            ~[['key' 'item key/path, e.g. /projects/x']]  ~['key']
        ==
        :*  'know-save'  'Create or overwrite a knowledge item.'
            ~[['key' 'item key/path'] ['body' 'item body text']]  ~['key' 'body']
        ==
        :*  'know-delete'  'Soft-delete a knowledge item (recoverable from trash).'
            ~[['key' 'item key/path']]  ~['key']
        ==
    ==
  =-  (pairs:enjs:format ~[['tools' a+-]])
  ^-  (list json)
  %+  turn  tools
  |=  [nom=@t des=@t params=(list [pn=@t pd=@t]) reqd=(list @t)]
  ^-  json
  =/  props=(map @t json)
    %-  malt
    %+  turn  params
    |=  [pn=@t pd=@t]
    ^-  [@t json]
    [pn (pairs:enjs:format ~[['type' s+'string'] ['description' s+pd]])]
  =/  schema=json
    %-  pairs:enjs:format
    :~  ['type' s+'object']
        ['properties' o+props]
        ['required' a+(turn reqd |=(r=@t s+r))]
    ==
  (pairs:enjs:format ~[['name' s+nom] ['description' s+des] ['inputSchema' schema]])
::
++  know-list-json
  |=  es=(map path know-entry:lk)
  ^-  json
  %-  pairs:enjs:format
  :~  ['count' (numb:enjs:format ~(wyt by es))]
      :-  'keys'
      :-  %a
      %+  turn  ~(tap by es)
      |=  [kp=path e=know-entry:lk]
      %-  pairs:enjs:format
      :~  ['key' s+(spat kp)]
          ['updated' s+(scot %da updated.e)]
          ['bytes' (numb:enjs:format (met 3 body.e))]
          (tags-json tags.e)
      ==
  ==
++  know-all-json
  |=  es=(map path know-entry:lk)
  ^-  json
  %-  pairs:enjs:format
  :_  ~
  :-  'items'
  :-  %a
  %+  turn  ~(tap by es)
  |=([kp=path e=know-entry:lk] (know-entry-json kp e))
++  know-tags-json
  |=  es=(map path know-entry:lk)
  ^-  json
  =/  all=(list @t)  (zing (turn ~(val by es) |=(e=know-entry:lk ~(tap in tags.e))))
  =/  counts=(map @t @ud)
    %+  roll  all
    |=  [t=@t acc=(map @t @ud)]
    (~(put by acc) t +((~(gut by acc) t 0)))
  %-  pairs:enjs:format
  :~  ['count' (numb:enjs:format ~(wyt by counts))]
      :-  'tags'
      :-  %a
      %+  turn
        %+  sort  ~(tap by counts)
        |=  [[a=@t x=@ud] [b=@t y=@ud]]
        ?:(=(x y) (aor a b) (gth x y))
      |=  [t=@t n=@ud]
      (pairs:enjs:format ~[['tag' s+t] ['count' (numb:enjs:format n)]])
  ==
::  +index-list-json: a derived index (trash) in the know-list shape (no bodies).
::
++  index-list-json
  |=  ix=know-index:lk
  ^-  json
  %-  pairs:enjs:format
  :~  ['count' (numb:enjs:format ~(wyt by ix))]
      :-  'keys'
      :-  %a
      %+  turn  ~(tap by ix)
      |=  [kp=path r=index-entry:lk]
      %-  pairs:enjs:format
      :~  ['key' s+(spat kp)]
          ['updated' s+(scot %da updated.r)]
          ['bytes' (numb:enjs:format bytes.r)]
          (tags-json tags.r)
      ==
  ==
::  +pub-list-json: published page keys as {files:[...]}. /pub/notes/intro/gmi ->
::  "notes/intro" (strip leading `pub` and the trailing gmi leaf).
::
++  pub-list-json
  |=  ix=pub-index:lp
  ^-  json
  %-  pairs:enjs:format
  :_  ~
  :-  'files'
  :-  %a
  %+  turn  ~(tap by ix)
  |=  [pax=path *]
  s+(crip (slag 1 (spud (snip (slag 1 pax)))))
::  ── explore filter (ported from /lib/lattice) ──
::
++  norm-tag  |=(t=@t `@t`(crip (cass (trip t))))
++  split-on
  |=  [sep=@tD t=tape]
  ^-  (list tape)
  =|  acc=(list tape)
  =|  cur=tape
  |-  ^-  (list tape)
  ?~  t
    %+  skip  (flop ?~(cur acc [(flop cur) acc]))
    |=(s=tape =(~ s))
  ?:  =(sep i.t)
    $(t t.t, cur ~, acc ?~(cur acc [(flop cur) acc]))
  $(t t.t, cur [i.t cur])
++  parse-tags
  |=  raw=@t
  ^-  (set @t)
  (sy (turn (split-on ',' (trip raw)) |=(s=tape (norm-tag (crip s)))))
++  matches-explore
  |=  [kp=path e=know-entry:lk tags=(set @t) all=? q=tape]
  ^-  ?
  ?&  ?|  =(~ tags)
          ?:  all
            (levy ~(tap in tags) |=(t=@t (~(has in tags.e) t)))
          (lien ~(tap in tags) |=(t=@t (~(has in tags.e) t)))
      ==
      ?|  =(~ q)
          ?|  !=(~ (find q (cass (trip (spat kp)))))
              !=(~ (find q (cass (trip body.e))))
          ==
      ==
  ==
++  filter-explore
  |=  [es=(map path know-entry:lk) tags=(set @t) all=? q=@t]
  ^-  (map path know-entry:lk)
  =/  ql=tape  (cass (trip q))
  %-  malt
  %+  skim  ~(tap by es)
  |=  [kp=path e=know-entry:lk]
  (matches-explore kp e tags all ql)
::  +know-key: parse a client key ("projects/x") to a path, ~ if invalid.
::
++  know-key
  |=  k=@t
  ^-  (unit path)
  =/  t=tape  (trip k)
  =/  full=tape  ?:(?=([%'/' *] t) t ['/' t])
  =/  res  (mule |.((stab (crip full))))
  ::  reject the empty key ('' -> stab '/' -> empty path), which would otherwise
  ::  wrap as a valid unit and pass the routes' ?~ ko guard.
  ?:(?=(%& -.res) ?~(p.res ~ `p.res) ~)
::  +app-base: the nexus's absolute tree path (its app dir, fixed by root.hoon).
::  Needed to build remote roads for peek-remote (rewritten to /sys/ames/ships/…).
::
++  app-base  `path`/apps/'lattice.lattice_app'
::  +mark-body-json: the {mark, body} fetch response shape (client contract).
::
++  mark-body-json
  |=  [mark=@t body=@t]
  ^-  json
  (pairs:enjs:format ~[['mark' s+mark] ['body' s+body]])
::  +manifest-gmi: the discovery-manifest body — a generated gemtext index of a
::  ship's published pages, served by /fetch's /manifest fallback. Ported from
::  the old lib's +generate-index (the body the retired agent GREW at the
::  reserved /manifest spur), keyed off the pub index instead of the content map.
::
++  manifest-gmi
  |=  ix=pub-index:lp
  ^-  @t
  =/  lines=(list @t)
    %+  turn  ~(tap in ~(key by ix))
    |=  pax=path
    ::  /pub/notes/2026/intro/gmi -> "=> /notes/2026/intro  notes/2026/intro"
    =/  inner=path  (snip (slag 1 pax))
    =/  shown=tape  (spud inner)
    (crip "=> {shown}  {(slag 1 shown)}")
  =/  header=(list @t)
    ~['# Index' '' 'Files published on this ship:' '']
  (of-wain:format (welp header lines))
::  +parse-urb-url: "urb://~ship/rel" -> [ship rel-path]. ~ on a malformed url
::  (ported from /lib/lattice; +stab is mule-guarded against bad knots).
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
::  +remote-timeout: how long a remote peek waits before giving up. A dead or
::  offline peer would otherwise block the fiber forever (peek-remote -> take-peek
::  never resolves) — hanging /fetch and stalling the crawler's peer sweep.
::
++  remote-timeout  ^-(@dr ~s30)
::  +peer-budget: wall-clock a single peer's page sweep may consume before we bail
::  and move on. Without it, a peer that lists manifest-max pages but stalls each
::  page peek (up to remote-timeout) could burn manifest-max * remote-timeout (~8.5h)
::  and starve every later peer in the sequential sweep. A healthy peer answers in
::  ms so this never bites; a staller is capped and re-scanned next tick.
::
++  peer-budget  ^-(@dr ~m30)
::  +remote-road: rewrite an absolute road into its /sys/ames mirror on `shp`, so
::  a %peek dart routes to that ship. Mirrors peek-remote's own rewrite (kept
::  local so peek-remote-wait doesn't fork fiberio just to add a deadline).
::
++  remote-road
  |=  [=road:tarball shp=@p]
  ^-  road:tarball
  ?-  -.road
    %|  road
    %&
      =/  prefix=path  /sys/ames/ships/[(scot %p shp)]/root
      ?-  -.p.road
        %&  [%& %& (weld prefix path.p.p.road) name.p.p.road]
        %|  [%& %| (weld prefix p.p.road)]
      ==
  ==
::  +peek-remote-wait: peek a remote road, but give up after remote-timeout. ~ on
::  timeout or veto; `seen otherwise. This is peek-remote (nonce + %peek dart +
::  take-peek) with a concurrent timer, resolving on whichever lands first.
::
++  peek-remote-wait
  |=  [=road:tarball shp=@p]
  =/  m  (fiber:fiber:nexus ,(unit seen:nexus))
  ^-  form:m
  ;<  now=@da  bind:m  bowl-now
  =/  until=@da  (add now remote-timeout)
  ;<  pw=wire  bind:m  (nonce:io /peek)
  ;<  ~  bind:m  (send-dart:io %node pw (remote-road road shp) %peek ~ ~ %.y)
  ;<  ~  bind:m  (send-wait:io until)
  (take-peek-or-wake pw until)
::  +peek-remote-shallow-wait: peek-remote-wait but deep=%.n — one directory level
::  (files here + subdir names, no recursion). Used by the cross-ship browser: a
::  deep (%.y) peek of a foreign DIR would materialize its whole subtree, so a huge
::  or hostile tree could balloon memory before any render cap. Shallow bounds the
::  pull to one level per request. (A file peek is unaffected — one node either way.)
::
++  peek-remote-shallow-wait
  |=  [=road:tarball shp=@p]
  =/  m  (fiber:fiber:nexus ,(unit seen:nexus))
  ^-  form:m
  ;<  now=@da  bind:m  bowl-now
  =/  until=@da  (add now remote-timeout)
  ;<  pw=wire  bind:m  (nonce:io /peek)
  ;<  ~  bind:m  (send-dart:io %node pw (remote-road road shp) %peek ~ ~ %.n)
  ;<  ~  bind:m  (send-wait:io until)
  (take-peek-or-wake pw until)
::  +take-peek-or-wake: resolve on the matching %peek response OR our timer wake.
::  Sibling of take-news-or-wake; a %veto counts as give-up (~), like a timeout.
::
++  take-peek-or-wake
  |=  [pwire=wire until=@da]
  =/  m  (fiber:fiber:nexus ,(unit seen:nexus))
  ^-  form:m
  |=  input:fiber:nexus
  :+  ~  q.state
  ?+  in  [%skip ~]
      ~  [%wait ~]
      ::  a veto gives up (~) like a timeout, but ONLY for OUR peek's dart — gate on
      ::  its wire, like the %peek branch, so a veto of some other dart can't resolve
      ::  the peek we're actually awaiting. peek-remote-wait always sends a %node dart,
      ::  so match that shape (wire sits at a consistent axis only within one branch).
      [~ %veto %node * * *]
    ?.  =(pwire wire.dart.u.in)  [%skip ~]
    [%done ~]
      [~ %peek * *]
    ?.  =(pwire wire.u.in)  [%skip ~]
    [%done `seen.u.in]
      [~ %poke * *]
    ?.  =([/ %timer-wake] p.sage.u.in)  [%skip ~]
    =/  wak=path  !<(path q.sage.u.in)
    ?.  ?&(?=([%wait @ ~] wak) =(until (slav %da i.t.wak)))  [%skip ~]
    [%done ~]
  ==
::  +bowl-our / +bowl-now: read our/now from /sys/bowl like get-our:io / get-time:io,
::  but the take MARK-FILTERS the bowl reply — a stray poke (a queued %obk-req,
::  %know-action, etc. buffered while this fiber was mid-work) is %skip'd back to the
::  owning loop instead of being stolen. fiberio's get-our/get-time use a plain
::  take-poke, so in a busy fiber (obelisk owner, crawler, writer) they grab a
::  neighbour's message and nest-fail (-need.@p / -need.@da). The one grubbery peek
::  turned into a poke-service means every our/now read must filter like this.
::
++  bowl-our
  =/  m  (fiber:fiber:nexus ,ship)
  ^-  form:m
  ;<  ~  bind:m  (poke:io &+&+[/sys/bowl %'main.sig'] [[/ %bowl-req] %our])
  |=  input:fiber:nexus
  :+  ~  q.state
  ?+  in  [%skip ~]
      ~  [%wait ~]
      [~ %poke * *]
    ?.  =([/ %ship] p.sage.u.in)  [%skip ~]
    [%done !<(ship q.sage.u.in)]
  ==
++  bowl-now
  =/  m  (fiber:fiber:nexus ,@da)
  ^-  form:m
  ;<  ~  bind:m  (poke:io &+&+[/sys/bowl %'main.sig'] [[/ %bowl-req] %now])
  |=  input:fiber:nexus
  :+  ~  q.state
  ?+  in  [%skip ~]
      ~  [%wait ~]
      [~ %poke * *]
    ?.  =([/ %time] p.sage.u.in)  [%skip ~]
    [%done !<(@da q.sage.u.in)]
  ==
::  +gall-poke-or-nack-safe / +sleep-safe: fiberio's gall-poke-or-nack and sleep,
::  but sourcing our/now from bowl-our/bowl-now (mark-filtered) instead of fiberio's
::  get-our/get-time (unfiltered take-poke). fiberio's own poke-ack / timer-wake
::  takes ARE mark-filtered — only their internal get-our/get-time steal a queued
::  poke in a busy fiber. The obelisk owner and crawler run these while an %obk-req
::  is buffered, so the stolen poke nest-fails (-need.@p / -need.@da). These local
::  copies keep the correct outer take and swap only the our/now read. No %veto
::  branch: /sys/gall and /sys/bowl are own-ship runtime grubs (no weir, no veto).
::
++  gall-poke-or-nack-safe
  |=  [=dude:gall =page]
  =/  m  (fiber:fiber:nexus ,(unit tang))
  ^-  form:m
  ;<  our=@p  bind:m  bowl-our
  ;<  ~  bind:m
    (poke:io &+&+[/sys/gall %'main.sig'] [[/ %gall-poke] [[our dude] page]])
  |=  input:fiber:nexus
  :+  ~  q.state
  ?+  in  [%skip ~]
      ~  [%wait ~]
      [~ %poke * *]
    ?.  =([/ %poke-ack] p.sage.u.in)  [%skip ~]
    [%done !<((unit tang) q.sage.u.in)]
  ==
++  sleep-safe
  |=  for=@dr
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  now=@da  bind:m  bowl-now
  (wait:io (add now for))
::  +take-news-or-wake-until: like fiberio's take-news-or-wake, but the timer-wake
::  branch matches ONLY our own `until` timer (mirrors take-peek-or-wake). fiberio's
::  version matches ANY %timer-wake, so a stale timer left armed by an earlier
::  obelisk-query in the SAME long-lived fiber (the crawler runs many in sequence)
::  would spuriously abort a later query. Checking until makes a stale wake skip.
::
++  take-news-or-wake-until
  |=  [news-wire=wire until=@da]
  =/  m  (fiber:fiber:nexus ,news-or-wake:io)
  ^-  form:m
  |=  input:fiber:nexus
  :+  ~  q.state
  ?+  in  [%skip ~]
      ~  [%wait ~]
      [~ %news * *]
    ?.  =(news-wire wire.u.in)  [%skip ~]
    [%done %news wave.u.in]
      [~ %poke * *]
    ?.  =([/ %timer-wake] p.sage.u.in)  [%skip ~]
    =/  wak=path  !<(path q.sage.u.in)
    ?.  ?&(?=([%wait @ ~] wak) =(until (slav %da i.t.wak)))  [%skip ~]
    [%done %wake ~]
  ==
::  +take-wake-drain: like fiberio's take-wake ~, but also DRAINS a stray remote
::  %peek/%veto — the late response of a peek-remote-wait that already timed out in
::  this fiber (fiberio has no dart-cancel, so an abandoned peek's answer still
::  arrives). fiberio's take-wake %skips a stray %peek (piling it in the skip queue
::  forever) and CRASHES on a stray %veto; here both are consumed. Used by the
::  crawler's sleep-draining loop, which re-checks the clock after each drain.
++  take-wake-drain
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  |=  input:fiber:nexus
  :+  ~  q.state
  ?+  in  [%skip ~]
      ~  [%wait ~]
      [~ %poke * *]  ?:(=([/ %timer-wake] p.sage.u.in) [%done ~] [%skip ~])
      [~ %peek * *]  [%done ~]
      [~ %veto *]    [%done ~]
  ==
::  +take-news-or-wake-drain: take-news-or-wake that ALSO drains a stray remote
::  %peek/%veto (as a %wake), so a /sub keep loop clears the late peeks its
::  index-remote-page calls leave behind instead of piling them forever. A real
::  %news on news-wire still re-indexes; anything else is skipped.
++  take-news-or-wake-drain
  |=  news-wire=wire
  =/  m  (fiber:fiber:nexus ,news-or-wake:io)
  ^-  form:m
  |=  input:fiber:nexus
  :+  ~  q.state
  ?+  in  [%skip ~]
      ~  [%wait ~]
      [~ %news * *]
    ?.  =(news-wire wire.u.in)  [%skip ~]
    [%done %news wave.u.in]
      [~ %poke * *]
    ?.  =([/ %timer-wake] p.sage.u.in)  [%skip ~]
    [%done %wake ~]
      [~ %peek * *]  [%done %wake ~]
      ::  drain a STALE peek's veto (a stray from a timed-out remote peek), but NOT a
      ::  veto of THIS loop's own keep (news-wire) — that means the subscription died,
      ::  and swallowing it as a keepalive would hide the failure. Gate on the dart
      ::  wire like take-peek-or-wake; both are %node darts, told apart by wire.
      [~ %veto %node * * *]
    ?:  =(news-wire wire.dart.u.in)  [%skip ~]
    [%done %wake ~]
  ==
::  +page-rel: normalize a fetch/subscribe spur to the vault-relative page path.
::  The home spur (empty) is the authored /index page (so urb://~ship/ resolves).
::  A catalog url form (/pub/<spur>/gmi round-tripped from a search result) is
::  stripped back to /<spur>. A plain vault spur is untouched (idempotent). Shared
::  by read-page-body and the /sub keep fiber so the keep road, the read, and the
::  catalog key all derive from the SAME normalized spur.
::
++  page-rel
  |=  rel=path
  ^-  path
  ?:  ?=(~ rel)  /index
  ?.  ?&(=(%pub i.rel) =(%gmi (rear rel)))  rel
  (snip (strip-pub:lp rel))
::  +read-page-body: the gemtext of a published page, shared by /fetch and the
::  web reader. Own pages peek the local pub vault; remote pages use the bounded
::  peek-remote-wait (~ if absent, unreachable, or slow past remote-timeout).
::
++  read-page-body
  |=  [shp=@p rel=path]
  =/  m  (fiber:fiber:nexus ,(unit @t))
  ^-  form:m
  ::  tolerate a catalog-row url form: catalog stores url as urb://<pub>/pub/<spur>/gmi
  ::  (the content-map key), so a client that round-trips a /catalog-* result into
  ::  /fetch or the reader passes rel=/pub/<spur>/gmi. Strip the leading pub +
  ::  trailing gmi back to the vault-relative /<spur> /fetch expects. A plain vault
  ::  rel (no leading pub / no trailing gmi) is untouched. ponytail: a page literally
  ::  published as "pub/…/gmi" would be mis-normalized — accepted, that key is absurd.
  =/  rel=path  (page-rel rel)
  ;<  our=@p  bind:m  bowl-our
  ::  own pages: ABSOLUTE road via app-base (the nexus's fixed tree path), so this
  ::  resolves the same from the depth-2 request fiber and the depth-0 crawler.
  =/  road=road:tarball
    [%& %& (weld (weld app-base /pub/vault) rel) %gmi]
  ?:  =(shp our)
    ;<  =seen:nexus  bind:m  (peek:io road ~)
    ?.  ?=([%& %file *] seen)  (pure:m ~)
    (pure:m `!<(@t (need-vase:tarball sang.p.seen)))
  ;<  ms=(unit seen:nexus)  bind:m  (peek-remote-wait road shp)
  ?~  ms  (pure:m ~)
  ?.  ?=([%& %file *] u.ms)  (pure:m ~)
  ::  CROSS-SHIP peek content is a boom (raw noun), NOT a vase — need-vase would
  ::  crash. Extract via sang-noun and clam in a mule so a malformed/hostile peer
  ::  body yields ~ (clean 404) instead of a crash.
  =/  res=(each @t tang)  (mule |.(;;(@t (sang-noun:tarball sang.p.u.ms))))
  ?:  ?=(%| -.res)  (pure:m ~)
  (pure:m `p.res)
::  +browse-json: render one directory level of a foreign (or own) grubbery tree as
::  a JSON listing — subdirs first, then files. Each file carries its mark leaf. Both
::  lists are capped at browse-fan-cap and `truncated` is set if either overflowed,
::  so a hostile ship can't make the RESPONSE unbounded (the shallow peek already
::  bounds the fetch). Names are the raw @ta segments; the client rebuilds child
::  paths as <path>/<name>.
::
++  browse-fan-cap  ^-(@ud 1.024)
++  browse-json
  |=  [shp=@p pax=path b=ball:tarball]
  ^-  json
  =/  files=(list [nom=@ta con=[=sang:tarball gain=? bang=(unit tang)]])
    ?~(fil.b ~ ~(tap by contents.u.fil.b))
  =/  dirs=(list [nom=@ta kid=ball:tarball])  ~(tap by dir.b)
  =/  dir-kids=(list json)
    %+  turn  (scag browse-fan-cap dirs)
    |=  [nom=@ta *]
    (pairs:enjs:format ~[['name' s+nom] ['type' s+'dir']])
  =/  file-kids=(list json)
    %+  turn  (scag browse-fan-cap files)
    |=  [nom=@ta con=[=sang:tarball gain=? bang=(unit tang)]]
    (pairs:enjs:format ~[['name' s+nom] ['type' s+'file'] ['mark' s+name.p.sang.con]])
  =/  truncated=?
    |((gth (lent files) browse-fan-cap) (gth (lent dirs) browse-fan-cap))
  %-  pairs:enjs:format
  :~  ['ship' s+(scot %p shp)]
      ['path' s+(spat pax)]
      ['truncated' b+truncated]
      ['children' a+(weld dir-kids file-kids)]
  ==
::  +browse-file-respond: send one foreign/own file's body as JSON. Cross-ship
::  content is a boom (raw noun), so clam to @t in a mule — a non-text file (or a
::  hostile non-cord body) is a clean 415, never a crash.
::
++  browse-file-respond
  |=  [eyre-id=@ta sn=seen:nexus]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?.  ?=([%& %file *] sn)  (send-err eyre-id 404 'not a file')
  =/  res=(each @t tang)  (mule |.(;;(@t (sang-noun:tarball sang.p.sn))))
  ?:  ?=(%| -.res)  (send-err eyre-id 415 'not text')
  (send-json eyre-id (pairs:enjs:format ~[['body' s+p.res] ['mark' s+name.p.sang.p.sn]]))
::  +send-html: a 200 text/html response.
::
++  send-html
  |=  [eyre-id=@ta htm=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  %+  send-simple:srv  eyre-id
  :-  [200 ['content-type' 'text/html']~]
  `(as-octs:mimes:html htm)
::  +esc: HTML-escape a tape. +has-prefix: tape prefix test.
::
++  esc
  |=  t=tape
  ^-  tape
  %-  zing
  %+  turn  t
  |=  c=@tD
  ?+  c  ~[c]
    %'&'  "&amp;"
    %'<'  "&lt;"
    %'>'  "&gt;"
    %'"'  "&quot;"
  ==
++  has-prefix  |=([pre=tape t=tape] =(pre (scag (lent pre) t)))
::  +ltrim: drop leading spaces from a tape (gemtext allows extra whitespace
::  after the "=> " sigil; the analyzer already strips it, render-gmi must too).
::
++  ltrim
  |=  a=tape
  ^-  tape
  ?~  a  a
  ?:(=(' ' i.a) $(a t.a) a)
::  +render-gmi: gemtext body -> HTML fragment (compact: headings, => links,
::  lists, blockquotes, ``` pre, paragraphs). urb:// links route back through
::  the reader; other links render as their description text only.
::
++  render-gmi
  |=  body=@t
  ^-  tape
  =/  lines=(list @t)  (to-wain:format body)
  =|  out=tape
  =/  pre=?  |
  =|  prebuf=(list @t)
  |-  ^-  tape
  ?~  lines
    ?:  pre  :(weld out "<pre>" (esc (trip (of-wain:format (flop prebuf)))) "</pre>")
    out
  =/  ln=tape  (trip i.lines)
  ?:  pre
    ?.  =("```" ln)  $(lines t.lines, prebuf [i.lines prebuf])
    %=  $
      lines   t.lines
      pre     |
      prebuf  ~
      out     :(weld out "<pre>" (esc (trip (of-wain:format (flop prebuf)))) "</pre>")
    ==
  ?:  =("```" ln)  $(lines t.lines, pre &, prebuf ~)
  ?:  (has-prefix "### " ln)  $(lines t.lines, out :(weld out "<h3>" (esc (slag 4 ln)) "</h3>"))
  ?:  (has-prefix "## " ln)   $(lines t.lines, out :(weld out "<h2>" (esc (slag 3 ln)) "</h2>"))
  ?:  (has-prefix "# " ln)    $(lines t.lines, out :(weld out "<h1>" (esc (slag 2 ln)) "</h1>"))
  ?:  (has-prefix "=> " ln)
    =/  rest=tape  (ltrim (slag 3 ln))
    =/  sp=(unit @ud)  (find " " rest)
    =/  raw=tape   ?~(sp rest (scag u.sp rest))
    =/  desc=tape  (ltrim ?~(sp rest (slag +(u.sp) rest)))
    =/  anchor=tape
      ?:  =("urb://" (scag 6 raw))
        :(weld "<a href=\"/apps/lattice?url=" (esc raw) "\">" (esc desc) "</a>")
      ?:  |(=("http://" (scag 7 raw)) =("https://" (scag 8 raw)))
        :(weld "<a href=\"" (esc raw) "\" target=\"_blank\" rel=\"noopener noreferrer\">" (esc desc) "</a>")
      (esc desc)
    $(lines t.lines, out :(weld out "<p>" anchor "</p>"))
  ?:  (has-prefix "> " ln)
    $(lines t.lines, out :(weld out "<blockquote>" (esc (slag 2 ln)) "</blockquote>"))
  ?:  =("" ln)  $(lines t.lines)
  $(lines t.lines, out :(weld out "<p>" (esc ln) "</p>"))
::  +home-index-html: the home page — a list of our published page links.
::
++  home-index-html
  |=  [our=@p ix=pub-index:lp]
  ^-  tape
  =/  ship=tape  (scow %p our)
  =/  keys=(list path)  ~(tap in ~(key by ix))
  ?~  keys  "<p>No published pages yet.</p>"
  %-  zing
  :-  "<h1>lattice</h1>"
  %+  turn  keys
  |=  pax=path
  =/  rel=tape  (slag 1 (spud (snip (slag 1 pax))))
  :(weld "<p><a href=\"/apps/lattice?url=urb://" ship "/" rel "\">" rel "</a></p>")
::  +web-css: minimal reader styling (single-quoted cord so braces are literal).
::
++  web-css
  ^-  tape
  %-  trip
  '*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,sans-serif;color:#111;background:#fafafa}@media(prefers-color-scheme:dark){body{color:#e6e6e6;background:#1a1a1a}}.bar{display:flex;gap:6px;padding:8px;border-bottom:1px solid #8884}.bar input{flex:1;padding:6px 8px;font:inherit;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit}main{max-width:46rem;margin:0 auto;padding:16px;overflow-wrap:anywhere}a{color:#1a6ed8}.err{color:#c0392b}blockquote{margin:.6rem 0;padding-left:1rem;border-left:3px solid #8886;color:#8a8a8a}pre{background:#8881;padding:10px;overflow-x:auto;border-radius:6px;white-space:pre}'
::  +render-page: wrap an HTML fragment in the reader chrome (address bar + CSS).
::
++  render-page
  |=  [current=tape keep=tape inner=tape]
  ^-  @t
  %-  crip
  ;:  weld
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
    "<title>lattice</title><style>"  web-css  "</style></head><body>"
    "<form class=\"bar\" action=\"/apps/lattice\" method=\"get\">"
    "<input name=\"url\" value=\""  (esc current)  "\" autocomplete=\"off\" placeholder=\"urb://~ship/path\">"
    "<button type=\"submit\">Go</button></form><main>"  inner  "</main>"
    (sse-script keep)  "</body></html>"
  ==
::  +keep-url: grubbery's native keep-SSE endpoint for one of our grubs.
::
++  keep-url
  |=  sub=tape
  ^-  tape
  (weld "/grubbery/api/keep/apps/lattice.lattice_app/" sub)
::  +sse-script: reactive live-view client JS. Streams grubbery's
::  keep-SSE for `keep`, skips the initial `old` snapshot events, and reloads on
::  any subsequent change — so an open reader / home index upgrades a stale first
::  paint and shows live edits (the /updates live channel). "" -> no script
::  (remote pages, error shells). Built from single-quote cords so the JS braces
::  stay literal (only \\ needs escaping); mirrors counter.hoon's SSE parse loop.
::
++  sse-script
  |=  keep=tape
  ^-  tape
  ?~  keep  ""
  ;:  weld
    (trip '<script>(function(){var K="')
    keep
    %-  trip
    '";async function c(){try{var r=await fetch(K+"?blot=/txt",{headers:{Accept:"text/event-stream"}});var R=r.body.getReader();var d=new TextDecoder();var b="";while(true){var x=await R.read();if(x.done)break;b+=d.decode(x.value,{stream:true});var ps=b.split("\\n\\n");b=ps.pop();for(var i=0;i<ps.length;i++){if(!ps[i].trim())continue;var ev="";var ls=ps[i].split("\\n");for(var j=0;j<ls.length;j++){if(ls[j].indexOf("event: ")===0)ev=ls[j].slice(7)}if(!ev)continue;if(ev.slice(0,3)==="old")continue;location.reload();return}}}catch(x){}setTimeout(c,3000)}c()})();</script>'
  ==
::  +lattice-page: placeholder web reader (replaced by the live SSE view in
::  step 6).
::
++  lattice-page
  ^-  manx
  ;html
    ;head
      ;title: lattice
      ;meta(charset "utf-8");
      ;meta(name "viewport", content "width=device-width, initial-scale=1");
    ==
    ;body
      ;h1: lattice
      ;p: grubbery-native lattice - web reader coming online.
    ==
  ==
::  +ensure-pub-weir: whitelist <root>/pub in the grubbery `public` usergroup's
::  peek set, so any foreign ship may peek/keep published pages. UNION, never
::  overwrite — the public group is global (shared by every grubbery app), so we
::  add our road without clobbering others'. know/ is private by omission
::  (foreign access is deny-by-default; see the weir audit). Idempotent: re-runs
::  on every writer (re)start, no-ops once our road is present. Skips quietly if
::  no public group exists yet (no peer has ever connected) — it re-applies the
::  next time the writer starts after a peer shows up.
::
++  ensure-pub-weir
  |=  root=path
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  gdir=road:tarball  [%& %| /sys/ames/usergroups/public]
  ;<  ok=?  bind:m  (peek-exists:io gdir)
  ?.  ok  ~&([%lattice-no-public-group ~] (pure:m ~))
  =/  wroad=road:tarball  [%& %& [/sys/ames/usergroups/public %'how.weir']]
  =/  pubdir=road:tarball  [%& %| (weld root /pub)]
  ::  KNOWN RACE (finding #12): how.weir is the GLOBAL public usergroup weir shared
  ::  by every grubbery app. This read-modify-write straddles a fiber yield, so two
  ::  apps starting their writers concurrently can each read the same stale weir and
  ::  clobber the other's road. Self-heals on the next writer (re)start (idempotent
  ::  re-add), and on a personal ship concurrent app-writer starts are near-zero.
  ::  Proper fix needs a grubbery-side atomic add-road op; left as-is (low, healing).
  ;<  cur=weir:nexus  bind:m  (read-weir wroad)
  =/  new=weir:nexus  cur(peek (~(put in peek.cur) pubdir))
  ?:  =(new cur)  (pure:m ~)
  (put-file wroad [/ %weir] new)
::  +read-weir: peek a how.weir grub. Empty (deny-all) default if absent.
::
++  read-weir
  |=  road=road:tarball
  =/  m  (fiber:fiber:nexus ,weir:nexus)
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%& %file *] seen)  (pure:m *weir:nexus)
  (pure:m !<(weir:nexus (need-vase:tarball sang.p.seen)))
::  +apply: dispatch one knowledge action. root is the nexus dir (/lattice).
::
++  apply
  |=  [root=path now=@da act=know-action:lk]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  vbase=path  (weld root /know/vault)
  ::  trash-vault: deleted entry grubs MOVE here (not culled) so restore is a
  ::  plain move-back — robust, no born-history/cass recovery. /know/trash is the
  ::  derived metadata index over it.
  =/  tvbase=path  (weld root /know/trash-vault)
  =/  tx=road:tarball  [%& %& (weld root /know) %trash]
  ?-    -.act
      %save
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab; skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    ::  a bodyless %save must not silently blank an existing note (merge-save keeps
    ::  the tags but wipes the body). The /know-save route guards this; guard it here
    ::  too so the direct know-action poke can't bypass it. skip+log, like a bad key.
    ?:  =('' body.act)  ~&([%lattice-save-empty-body key] (pure:m ~))
    =/  road=road:tarball  (entry-road vbase key)
    ;<  old=(unit know-entry:lk)  bind:m  (read-entry road)
    ::  reviving a soft-deleted key: %del culled the live grub, so `old` is ~ and
    ::  a fresh merge-save would drop the tags+vector the trashed copy still holds.
    ::  Read the trash-vault entry too and fall back to it, so a re-save recovers
    ::  them (the trash tomb is then cleared below, as for any re-save).
    ;<  tomb=(unit know-entry:lk)  bind:m  (read-entry (entry-road tvbase key))
    =/  e=know-entry:lk  (merge-save:lk ?^(old old tomb) body.act now)
    ;<  ~  bind:m  (ensure-dirs vbase key)
    ;<  ~  bind:m  (put-file road [/lattice %know-entry] e)
    ;<  ~  bind:m  (gain:io road %.y)
    ::  a re-saved key leaves trash; cull the orphaned trash-vault GRUB (not just
    ::  the index row) so a later %restore can't resurrect the stale tomb over the
    ::  live entry.
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    ?.  (~(has by trash) key)  (pure:m ~)
    ;<  *  bind:m  (cull-soft:io (entry-road tvbase key))
    (put-file tx [/lattice %know-index] (~(del by trash) key))
  ::
      %del
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab; skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    =/  road=road:tarball  (entry-road vbase key)
    =/  troad=road:tarball  (entry-road tvbase key)
    ;<  old=(unit know-entry:lk)  bind:m  (read-entry road)
    ?~  old  ~&([%lattice-del-missing key] (pure:m ~))
    ::  MOVE to the trash vault: write the trash copy first (duplicate-on-crash,
    ::  never lose), then cull the live grub, then swing the index rows.
    ;<  ~  bind:m  (ensure-dirs tvbase key)
    ;<  ~  bind:m  (put-file troad [/lattice %know-entry] u.old)
    ;<  ~  bind:m  (gain:io troad %.y)
    ;<  ~  bind:m  (cull:io road)
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    (put-file tx [/lattice %know-index] (~(put by trash) key (to-index-entry:lk u.old)))
  ::
      %tag    (retag root key.act tag.act %.y)
      %untag  (retag root key.act tag.act %.n)
  ::
      %move
    ::  guard both keys: %move is reachable un-normalized via the direct grubbery
    ::  poke API (mar know-action), bypassing the route's know-key check — a bad
    ::  key would crash+park the single writer and swallow the next mutation.
    =/  fko=(unit path)  (know-key from.act)
    =/  tko=(unit path)  (know-key to.act)
    ?~  fko  ~&([%lattice-move-bad-key from.act] (pure:m ~))
    ?~  tko  ~&([%lattice-move-bad-key to.act] (pure:m ~))
    =/  fk=path  u.fko
    =/  tk=path  u.tko
    =/  froad=road:tarball  (entry-road vbase fk)
    =/  troad=road:tarball  (entry-road vbase tk)
    ;<  old=(unit know-entry:lk)  bind:m  (read-entry froad)
    ?~  old  ~&([%lattice-move-missing fk] (pure:m ~))
    ::  refuse to clobber a LIVE target (the route pre-checks and 409s; this is
    ::  defense-in-depth against silent overwrite/data-loss).
    ;<  liv=(unit know-entry:lk)  bind:m  (read-entry troad)
    ?^  liv  ~&([%lattice-move-target-exists tk] (pure:m ~))
    ::  make target first (duplicate-on-crash, never lose), cull source after.
    ;<  ~  bind:m  (ensure-dirs vbase tk)
    ;<  ~  bind:m  (put-file troad [/lattice %know-entry] u.old)
    ;<  ~  bind:m  (gain:io troad %.y)
    ;<  ~  bind:m  (cull:io froad)
    ::  if the target key was previously trashed, cull the orphan trash grub +
    ::  row so a later %restore can't resurrect it over the moved-in entry.
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    ?.  (~(has by trash) tk)  (pure:m ~)
    ;<  *  bind:m  (cull-soft:io (entry-road tvbase tk))
    (put-file tx [/lattice %know-index] (~(del by trash) tk))
  ::
      %restore
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab; skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    =/  road=road:tarball  (entry-road vbase key)
    =/  troad=road:tarball  (entry-road tvbase key)
    ;<  old=(unit know-entry:lk)  bind:m  (read-entry troad)
    ?~  old  ~&([%lattice-restore-missing key] (pure:m ~))
    ::  refuse to resurrect over a LIVE entry — the save/move/import writers already
    ::  cull the trash grub when a key goes live again, so this can't normally fire;
    ::  it's the last guard against a stale tomb clobbering live data.
    ;<  live=(unit know-entry:lk)  bind:m  (read-entry road)
    ?^  live  ~&([%lattice-restore-target-live key] (pure:m ~))
    ::  MOVE back from the trash vault: write the live grub, then cull the trash
    ::  copy, then swing the index rows.
    ;<  ~  bind:m  (ensure-dirs vbase key)
    ;<  ~  bind:m  (put-file road [/lattice %know-entry] u.old)
    ;<  ~  bind:m  (gain:io road %.y)
    ;<  ~  bind:m  (cull:io troad)
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    (put-file tx [/lattice %know-index] (~(del by trash) key))
  ::
      %import
    ::  write a live entry VERBATIM (preserve updated/tags/vector) — an import,
    ::  not a user edit, so no merge-save now-stamp. Mirror of %save minus the
    ::  body merge; index row derives from the entry's own metadata.
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab; skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    =/  road=road:tarball  (entry-road vbase key)
    ;<  ~  bind:m  (ensure-dirs vbase key)
    ;<  ~  bind:m  (put-file road [/lattice %know-entry] entry.act)
    ;<  ~  bind:m  (gain:io road %.y)
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    ?.  (~(has by trash) key)  (pure:m ~)
    ;<  *  bind:m  (cull-soft:io (entry-road tvbase key))
    (put-file tx [/lattice %know-index] (~(del by trash) key))
  ::
      %import-trashed
    ::  land a trashed entry straight into the trash vault (import of an
    ::  already-deleted entry). No live grub, no cull dance — just write + index.
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab; skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    =/  troad=road:tarball  (entry-road tvbase key)
    ;<  ~  bind:m  (ensure-dirs tvbase key)
    ;<  ~  bind:m  (put-file troad [/lattice %know-entry] entry.act)
    ;<  ~  bind:m  (gain:io troad %.y)
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    (put-file tx [/lattice %know-index] (~(put by trash) key (to-index-entry:lk entry.act)))
  ==
::  +apply-pub: dispatch one public-page action. Mirror of +apply but for the
::  /pub vault: a page is just a body, so save-page upserts and del-page culls,
::  with no trash/restore. The derived /pub/index row carries the parity hash.
::
++  apply-pub
  |=  [root=path now=@da act=pub-action:lp]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  vbase=path  (weld root /pub/vault)
  =/  px=road:tarball  [%& %& (weld root /pub) %index]
  ?-    -.act
      %save-page
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab; skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    =/  or=(unit vrail:lp)  (key-to-rail:lp vbase key)
    ?~  or  ~&([%lattice-pub-bad-key key] (pure:m ~))
    =/  road=road:tarball  [%& %& pax.u.or nom.u.or]
    ;<  ~  bind:m  (ensure-dirs vbase (slag (lent vbase) pax.u.or))
    ;<  ~  bind:m  (put-file road [/lattice %page] body.act)
    ;<  ~  bind:m  (gain:io road %.y)
    ;<  ix=pub-index:lp  bind:m  (read-pub-index px)
    (put-file px [/lattice %pub-index] (~(put by ix) key (to-pub-row:lp body.act now)))
  ::
      %del-page
    ::  guard the key parse: a bad imported key (space, uppercase, no leading /)
    ::  would crash this single writer fiber, and rise-wait would then swallow the
    ::  NEXT mutation as a strange-restart. know-key mule-guards the stab; skip+log
    ::  instead of crashing. The route also pre-validates, so this is belt-and-braces.
    =/  ko=(unit path)  (know-key key.act)
    ?~  ko  ~&([%lattice-import-bad-key key.act] (pure:m ~))
    =/  key=path  u.ko
    =/  or=(unit vrail:lp)  (key-to-rail:lp vbase key)
    ?~  or  ~&([%lattice-pub-bad-key key] (pure:m ~))
    =/  road=road:tarball  [%& %& pax.u.or nom.u.or]
    ;<  exists=?  bind:m  (peek-exists:io road)
    ?.  exists  ~&([%lattice-pub-del-missing key] (pure:m ~))
    ::  cull tombs the grub (gain=%.y keeps the body in born history); drop its
    ::  index row so it's no longer live. No trash row — pages have no restore.
    ;<  ~  bind:m  (cull:io road)
    ;<  ix=pub-index:lp  bind:m  (read-pub-index px)
    (put-file px [/lattice %pub-index] (~(del by ix) key))
  ==
::  +read-pub-index: peek the /pub/index grub. Empty if absent.
::
++  read-pub-index
  |=  road=road:tarball
  =/  m  (fiber:fiber:nexus ,pub-index:lp)
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%& %file *] seen)  (pure:m *pub-index:lp)
  (pure:m !<(pub-index:lp (need-vase:tarball sang.p.seen)))
::  +read-pub-index-remote: a peer's /pub/index via peek-remote (clean break —
::  the peer must run the grubbery-native lattice at the same app-base).
::
++  read-pub-index-remote
  |=  shp=@p
  =/  m  (fiber:fiber:nexus ,(unit pub-index:lp))
  ^-  form:m
  ;<  ms=(unit seen:nexus)  bind:m
    (peek-remote-wait [%& %& (weld app-base /pub) %index] shp)
  ::  ~ means the read FAILED (timeout / not-a-file / bad clam) — distinct from a
  ::  reachable peer with a genuinely empty index (`~ *pub-index). Callers use the
  ::  difference: reconcile must NOT run on a failure (it would delete every row).
  ?~  ms  (pure:m ~)
  ?.  ?=([%& %file *] u.ms)  (pure:m ~)
  ::  CROSS-SHIP peek content is a boom (raw noun), not a vase — need-vase would
  ::  crash the crawler. Extract via sang-noun and clam in a mule so a malformed
  ::  or hostile peer index yields ~ (treated as unreachable) instead of crashing.
  =/  res=(each pub-index:lp tang)
    (mule |.(;;(pub-index:lp (sang-noun:tarball sang.p.u.ms))))
  ?:(?=(%| -.res) (pure:m ~) (pure:m `p.res))
::  +read-pub-index-any: a ship's pub index — local peek for our own ship, the
::  bounded remote peek for a peer. ~ = unreachable/denied/absent (a reachable
::  but empty peer yields `~ *pub-index). Used by /fetch's manifest fallback.
::
++  read-pub-index-any
  |=  shp=@p
  =/  m  (fiber:fiber:nexus ,(unit pub-index:lp))
  ^-  form:m
  ;<  our=@p  bind:m  bowl-our
  ?.  =(shp our)  (read-pub-index-remote shp)
  ;<  ix=pub-index:lp  bind:m  (read-pub-index [%& %& (weld app-base /pub) %index])
  (pure:m `ix)
::  +read-follows: the crawler's follow set. ABSOLUTE road (app-base) so it reads
::  the same from the depth-2 request fiber and the depth-0 crawler fiber.
::
++  read-follows
  =/  m  (fiber:fiber:nexus ,follows:lp)
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io [%& %& (weld app-base /sub) %follows] ~)
  ?.  ?=([%& %file *] seen)  (pure:m *follows:lp)
  (pure:m !<(follows:lp (need-vase:tarball sang.p.seen)))
::  +read-subs: every live per-file subscription. Peeks /sub/pages as a ball and
::  reads each page-sub grub out of the dir node's contents (booms skipped).
::
++  read-subs
  =/  m  (fiber:fiber:nexus ,(list page-sub:lp))
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io [%& %| (weld app-base /sub/pages)] ~)
  ?.  ?=([%& %ball *] seen)  (pure:m ~)
  =/  b=ball:tarball  ball.p.seen
  ?~  fil.b  (pure:m ~)
  =/  cs=(list [@ta [=sang:tarball gain=? bang=(unit tang)]])
    ~(tap by contents.u.fil.b)
  =|  out=(list page-sub:lp)
  |-  ^-  form:m
  ?~  cs  (pure:m (flop out))
  ?:  (is-boom:tarball sang.i.cs)  $(cs t.cs)
  $(cs t.cs, out [!<(page-sub:lp (need-vase:tarball sang.i.cs)) out])
::  +apply-sub: mutate the crawler's subscriptions. Runs in the writer fiber
::  (serialised), so concurrent /follow + /sub requests don't race. %follow /
::  %unfollow read-modify-write the follow set; %sub-page / %unsub-page make/cull
::  a per-page grub under /sub/pages/ (whose on-file fiber owns the live keep).
::
++  apply-sub
  |=  [root=path act=sub-action:lp]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?:  ?=(?(%follow %unfollow) -.act)
    ;<  fs=follows:lp  bind:m  read-follows
    =/  fs2=follows:lp
      ?-  -.act
        %follow    (~(put in fs) ship.act)
        %unfollow  (~(del in fs) ship.act)
      ==
    (put-file [%& %& (weld root /sub) %follows] [/lattice %sub-follows] fs2)
  ::  a page grub's name is a deterministic hash of [ship pax], so /unsub culls the
  ::  exact grub /sub created (and re-subscribing is an idempotent over).
  =/  nom=@ta  (scot %uv (sham page-sub.act))
  =/  road=road:tarball  [%& %& (weld root /sub/pages) nom]
  ?:  ?=(%sub-page -.act)
    (put-file road [/lattice %sub-page] page-sub.act)
  ::  %unsub-page: cull only if present, so a stray /unsub can't veto-crash the writer.
  ;<  exists=?  bind:m  (peek-exists:io road)
  ?.  exists  (pure:m ~)
  (cull:io road)
::  +retag: %tag / %untag — touch the entry's tag set + refresh its index row.
::
++  retag
  |=  [root=path key-t=@t tag=@t add=?]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  vbase=path  (weld root /know/vault)
  ::  guard the key: %tag/%untag are reachable un-normalized via the direct
  ::  grubbery poke API (mar know-action) — a bad key crashes+parks the writer.
  =/  ko=(unit path)  (know-key key-t)
  ?~  ko  ~&([%lattice-tag-bad-key key-t] (pure:m ~))
  =/  key=path  u.ko
  =/  road=road:tarball  (entry-road vbase key)
  ;<  old=(unit know-entry:lk)  bind:m  (read-entry road)
  ?~  old  ~&([%lattice-tag-missing key] (pure:m ~))
  ::  case-fold the tag at the write boundary so explore (which normalizes the
  ::  query tag, +norm-tag) and the tag cloud agree — a stored 'Rust' would be
  ::  unreachable by an explore for 'rust'/'Rust' otherwise.
  =/  ftag=@t  (norm-tag tag)
  =/  e=know-entry:lk
    ?:  add  (add-tag:lk u.old ftag)
    ::  untag: drop BOTH the folded tag and the raw one — an entry tagged before
    ::  the case-fold landed stored it un-folded (e.g. 'Rust'), so a folded-only
    ::  del would leave it permanently unremovable.
    (del-tag:lk (del-tag:lk u.old ftag) tag)
  (put-file road [/lattice %know-entry] e)
::  +entry-road: absolute road to a key's entry grub.
::
++  entry-road
  |=  [vbase=path key=path]
  ^-  road:tarball
  =/  vr=vrail:lk  (key-to-rail:lk vbase key)
  [%& %& pax.vr nom.vr]
::  +read-entry: peek a vault grub. ~ if absent/tombstoned.
::
++  read-entry
  |=  road=road:tarball
  =/  m  (fiber:fiber:nexus ,(unit know-entry:lk))
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%& %file *] seen)  (pure:m ~)
  (pure:m `!<(know-entry:lk (need-vase:tarball sang.p.seen)))
::  +read-index: peek an index grub. Empty if absent.
::
++  read-index
  |=  road=road:tarball
  =/  m  (fiber:fiber:nexus ,know-index:lk)
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%& %file *] seen)  (pure:m *know-index:lk)
  (pure:m !<(know-index:lk (need-vase:tarball sang.p.seen)))
::  +put-file: create-or-overwrite a grub (over = %make force=%.y).
::
++  put-file
  |=  [road=road:tarball =blot:tarball noun=*]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  exists=?  bind:m  (peek-exists:io road)
  ?:  exists  (over:io road [blot noun])
  (make:io road |+[[blot noun] ~])
::  +ensure-dirs: make each cumulative dir base/seg1, base/seg1/seg2 ... so a
::  deep key's entry has a parent. ponytail: empty key-dirs are left behind on
::  delete — add pruning if the tree clutters.
::
++  ensure-dirs
  |=  [base=path segs=path]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?~  segs  (pure:m ~)
  =/  dir=path  (weld base /[i.segs])
  =/  road=road:tarball  [%& %| dir]
  ;<  exists=?  bind:m  (peek-exists:io road)
  ;<  ~  bind:m  ?:(exists (pure:m ~) (make:io road &+empty-dir:loader))
  $(base dir, segs t.segs)
::  +collect-entries: walk a vault ball, harvesting one know-entry per `entry`
::  grub. base = accumulated key path of the current node. Booms/non-entry
::  dirs are skipped, so this yields exactly the live keys.
::
++  collect-entries
  |=  [base=path b=ball:tarball]
  ^-  (map path know-entry:lk)
  =/  acc=(map path know-entry:lk)
    ?~  fil.b  ~
    =/  got  (~(get by contents.u.fil.b) entry-leaf:lk)
    ?~  got  ~
    ?:  (is-boom:tarball sang.u.got)  ~
    (my [base !<(know-entry:lk (need-vase:tarball sang.u.got))] ~)
  =/  kids=(list [seg=@ta kid=ball:tarball])  ~(tap by dir.b)
  |-
  ?~  kids  acc
  =.  acc  (~(uni by acc) (collect-entries (snoc base seg.i.kids) kid.i.kids))
  $(kids t.kids)
--
