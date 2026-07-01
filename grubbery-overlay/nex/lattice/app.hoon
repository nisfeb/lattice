::  nex/lattice/app: the grubbery-native %lattice application nexus.
::  (rev: post-review hardening batch 2 — trash integrity, catalog cleanup)
::
::  Lattice is now a nexus, not a gall agent. The tree it owns:
::    /main.sig            the action WRITER — takes %know-action / %pub-action
::                         pokes and serialises every mutation (avoids index races)
::    /know/vault/<key>/entry   one know-entry grub per key (private)
::    /know/index, /know/trash  derived live + trash indexes
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
            [%fall %& [/know %index] [[/lattice %know-index] *know-index:lk]]
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
        ;<  now=@da  bind:m  get-time:io
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
        ;<  our=@p  bind:m  get-our:io
        ;<  now=@da  bind:m  get-time:io
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
  ;<  our=@p  bind:m  get-our:io
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
      ;<  ix=pub-index:lp  bind:m  (read-pub-index [%| 2 %& /pub %index])
      ::  live home index: keep /pub/index so a publish/delete/edit auto-refreshes.
      (send-html eyre-id (render-page "" (keep-url "pub/index") (home-index-html our ix)))
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
  ::  per request — fine for a personal store.
  ::  KNOWN REDUNDANCY (finding #12): the writer also maintains /know/index on every
  ::  mutation, but NO serving route reads it — list/tags/explore all peek the vault
  ::  via read-know-map (the trash + pub indexes ARE read; the live know one is not).
  ::  It is dead read-modify-write amplification, and %reindex repairs drift no read
  ::  can observe. Next time this writer is touched, either DROP /know/index+%reindex
  ::  or serve list/tags/explore FROM it (skips the full-vault peek at scale). Left
  ::  as-is now: refactoring a verified write path for a personal-store nit isn't
  ::  worth the churn. Writes poke the single writer fiber (serialised) and
  ::  respond ok; the writer logs no-op cases (missing key etc.) rather than 404 —
  ::  precise per-route error codes can follow if a client needs them.
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
      [%'GET' %know-trash]
    ;<  tx=know-index:lk  bind:m  (read-index [%| 2 %& /know %trash])
    (send-json eyre-id (index-list-json tx))
  ::
      [%'GET' %know-explore]
    =/  tags=(set @t)  (parse-tags (~(gut by args) 'tags' ''))
    ::  default 'any' (OR) to match the old agent's contract; only 'all' -> AND.
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
    ?~  body  (send-err eyre-id 404 'not found')
    (send-json eyre-id (mark-body-json 'gmi' u.body))
  ::  ── obelisk bridge (catalog; step 5) ──
  ::  run a urQL write/DDL against %obelisk. GET /obelisk-exec?db=<db>&q=<urql>.
  ::  ponytail: GET for easy curl-testing the bridge; the real crawler drives this
  ::  arm internally and search reads via obelisk-query.
      [%'GET' %obelisk-exec]
    =/  db=@tas  (~(gut by args) 'db' 'sys')
    =/  q=(unit @t)  (~(get by args) 'q')
    ?~  q  (send-err eyre-id 400 'missing q param')
    ;<  err=(unit tang)  bind:m  (obelisk-exec db (trip u.q))
    ?~  err  (send-ok eyre-id)
    (send-err eyre-id 502 'obelisk did not ack (agent missing?)')
  ::
      [%'GET' %obelisk-query]
    =/  db=@tas  (~(gut by args) 'db' 'sys')
    =/  q=(unit @t)  (~(get by args) 'q')
    ?~  q  (send-err eyre-id 400 'missing q param')
    ;<  res=(each (list cmd-result:ast) tang)  bind:m  (obelisk-query db (trip u.q))
    (send-json eyre-id (obelisk-json res))
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
    (send-json eyre-id (obelisk-json cl))
  ::
      [%'GET' %catalog-search]
    =/  term=(unit @t)  (~(get by args) 'term')
    ?~  term  (send-err eyre-id 400 'missing term param')
    =/  nt=(unit @t)  (catalog-normalize-term:cat (trip u.term))
    ::  a non-indexable term (too short / stop word) matches nothing — return an
    ::  empty result (200), NOT a 400, so a client fanning out one call per query
    ::  word doesn't error on a common stop word (parity with the old agent).
    ?~  nt  (send-json eyre-id a+~[(pairs:enjs:format ~[['rows' a+~]])])
    =/  urql=tape  (catalog-search-urql:cat (trip u.nt))
    ;<  cs=(each (list cmd-result:ast) tang)  bind:m  (obelisk-query catalog-db urql)
    (send-json eyre-id (obelisk-json cs))
  ::
      [%'GET' %catalog-query]
    =/  cq=(unit @t)  (~(get by args) 'q')
    ?~  cq  (send-err eyre-id 400 'missing q param')
    ;<  cr=(each (list cmd-result:ast) tang)  bind:m  (obelisk-query catalog-db (trip u.cq))
    (send-json eyre-id (obelisk-json cr))
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
    (send-json eyre-id (obelisk-json cx))
  ::  one full catalog row by its url (urb://<pub>/<catalog-path>).
      [%'GET' %catalog-fetch]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url param')
    ;<  cf=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db (catalog-fetch-urql:cat (trip u.url)))
    (send-json eyre-id (obelisk-json cf))
  ::  page keys carrying a tag.
      [%'GET' %catalog-by-tag]
    =/  tag=(unit @t)  (~(get by args) 'tag')
    ?~  tag  (send-err eyre-id 400 'missing tag param')
    ::  case-fold the query tag: the analyzer stores catalog tags lowercased
    ::  (collect-tag-tokens), and obelisk equality is exact, so an uppercase
    ::  query would never match. Matches the norm-tag/normalize-term convention.
    ;<  cb=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db (catalog-by-tag-urql:cat (cass (trip u.tag))))
    (send-json eyre-id (obelisk-json cb))
  ::  per-page classification metadata (source/publisher/path/summary).
      [%'GET' %catalog-meta]
    ;<  cm=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db catalog-meta-list-urql:cat)
    (send-json eyre-id (obelisk-json cm))
  ::  the classifier worklist: OUR unclassified pages, newest first.
      [%'GET' %catalog-pending]
    ;<  cp=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db catalog-pending-list-urql:cat)
    (send-json eyre-id (obelisk-json cp))
  ::  the live (crawler-derived) category vocabulary.
      [%'GET' %catalog-vocab]
    ;<  cv=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db catalog-vocab-urql:cat)
    (send-json eyre-id (obelisk-json cv))
  ::  candidate ships to follow. The old app scried the %contacts book (%gx);
  ::  grubbery has no gall SCRY (only watch/poke), so there's no native book read,
  ::  and crawler targets are now explicit via /follow. Route kept for contract
  ::  shape; ponytail: bridge via a %contacts gall-watch if a live list is needed.
      [%'GET' %contacts]
    (send-json eyre-id (pairs:enjs:format ~[['ships' a+~]]))
  ::  ── follows (crawler targets) ──
      [%'GET' %follows]
    ;<  fs=follows:lp  bind:m  read-follows
    (send-json eyre-id a+(turn ~(tap in fs) |=(s=@p s+(scot %p s))))
  ::  ── pub writes (POST) ──
      [%'POST' %save]
    =/  rel=(unit @t)  (~(get by args) 'path')
    ?~  rel  (send-err eyre-id 400 'missing path')
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
    ;<  our=@p  bind:m  get-our:io
    ;<  ~  bind:m  (catalog-run catalog-db (catalog-page-delete-urql:cat our our p.pp))
    (send-ok eyre-id)
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
      ::  ranking/display when scot'd back into catalog-pages.confidence.
      ?:((lth:rs v .0) .0 ?:((gth:rs v .1) .1 v))
    ;<  our=@p  bind:m  get-our:io
    ;<  ~  bind:m
      (catalog-run catalog-db (catalog-classify-urql:cat our ship.u.pu path.u.pu u.cat-v csrc conf))
    (send-ok eyre-id)
  ::  ── catalog crawl triggers (POST) ──
  ::  scan ONE publisher on demand. Unlike the old fire-and-forget crawl, this is
  ::  synchronous (bounded by remote-timeout) and returns the indexed count.
      [%'POST' %catalog-scan]
    =/  raw=(unit @t)  (~(get by args) 'ship')
    ?~  raw  (send-err eyre-id 400 'missing ship param')
    =/  pub=(unit @p)  (slaw %p u.raw)
    ?~  pub  (send-err eyre-id 400 'bad ship')
    ;<  our=@p  bind:m  get-our:io
    ?:  =(u.pub our)  (send-err eyre-id 400 'cannot crawl own ship')
    ;<  now=@da  bind:m  get-time:io
    ;<  n=@ud  bind:m  (catalog-scan-peer our u.pub now)
    (send-json eyre-id (pairs:enjs:format ~[['indexed' (numb:enjs:format n)]]))
  ::  sweep everything now: our own pages + every followed peer (synchronous).
      [%'POST' %catalog-sweep]
    ;<  self=@ud  bind:m  catalog-scan-self
    ;<  our=@p   bind:m  get-our:io
    ;<  now=@da  bind:m  get-time:io
    ;<  peers=@ud  bind:m  (catalog-scan-peers our now)
    (send-json eyre-id (pairs:enjs:format ~[['indexed' (numb:enjs:format (add self peers))]]))
  ::  arbitrary urQL passthrough (body = the query), run against the lattice db.
  ::  Mirrors the old /know-query obelisk escape hatch; owner-only like all routes.
      [%'POST' %know-query]
    =/  urql=@t  (req-body req)
    ;<  kq=(each (list cmd-result:ast) tang)  bind:m  (obelisk-query catalog-db (trip urql))
    (send-json eyre-id (obelisk-json kq))
  ::  bulk import for migration: body = a /know-all export; lands each entry
  ::  VERBATIM (tags + original updated preserved) via %import. Owner-only.
      [%'POST' %know-import]
    =/  jon=(unit json)  (de:json:html (req-body req))
    ?~  jon  (send-err eyre-id 400 'bad json')
    =/  parsed=(each (list [@t know-entry:lk]) tang)  (mule |.((parse-import u.jon)))
    ?:  ?=(%| -.parsed)  (send-err eyre-id 400 'bad import shape')
    ::  reject the whole batch if any key is unparseable as a path — the writer
    ::  would otherwise skip those entries (silent partial import during migration).
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
      [%'POST' %know-reindex]
    ;<  ~  bind:m  (poke-know [%reindex ~])
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
  ::  so migrated entries stay reachable via explore.
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
  (gall-poke-or-nack:io %obelisk [%obelisk-action [%tape db urql]])
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
  ;<  *  bind:m  (gall-poke-or-nack:io dude page)
  (pure:m ~)
++  obelisk-wait-live
  |=  [our=@p n=@ud]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?:  =(0 n)  (pure:m ~)
  ;<  live=?  bind:m  (obelisk-live our)
  ?:  live  (pure:m ~)
  ;<  ~  bind:m  (sleep:io (div ~s1 10))
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
  ;<  our=@p  bind:m  get-our:io
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
  ;<  now=@da     bind:m  get-time:io
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
  ;<  ~           bind:m  (sleep:io (div ~s1 2))
  (pure:m res)
::  +obelisk-query: caller-facing entry (request fibers + crawler). Pokes the
::  obelisk owner (/cat/obelisk.sig) with the query + a unique result-grub rail,
::  keeps that grub, and waits for the owner to write the answer there. Routing
::  every query through the one owner serialises access to the shared /server sub,
::  so concurrent callers never read each other's results (finding #1). Absolute
::  roads so it resolves identically from depth-2 request fibers and the depth-0
::  crawler.
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
  ;<  now=@da  bind:m  get-time:io
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
::  nothing there is live. ponytail: startup sweep bounds the leak; on a fast local
::  obelisk callers get their wave in ms and never orphan, so steady-state growth is
::  ~0. Upgrade to a fiber-to-fiber poke-back (no shared grub) if it ever matters.
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
::  +sleep-draining: sleep for `for`, but consume the stray [/ %timer-wake] pokes
::  that fire during the window (finding #13) instead of skipping+retaining them.
::  Early-resolving obelisk-query / peek-remote-wait calls in this fiber leave their
::  send-wait timers armed (fiberio has no timer-cancel); a plain +sleep (take-wake
::  with a fixed `until`) skips those non-matching wakes, so they pile up in the
::  crawler's skip queue forever. Here we arm one deadline, then take ANY wake
::  (take-wake ~) in a loop, ending only once the clock reaches the deadline — so
::  each stray is consumed as it fires rather than accumulating.
++  sleep-draining
  |=  for=@dr
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  now=@da  bind:m  get-time:io
  =/  wake-at=@da  (add now for)
  ;<  ~  bind:m  (send-wait:io wake-at)
  |-
  ;<  ~  bind:m  (take-wake:io ~)
  ;<  chk=@da  bind:m  get-time:io
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
::  +obelisk-json: render an obelisk result (or error) as JSON. Rows become
::  objects keyed by column name; dime values scot'd by aura.
::
++  obelisk-json
  |=  res=(each (list cmd-result:ast) tang)
  ^-  json
  ?:  ?=(%| -.res)
    (frond:enjs:format 'error' s+(crip (zing (turn p.res |=(=tank ~(ram re tank))))))
  =/  results=(list result:ast)  (zing (turn p.res |=(cr=cmd-result:ast +.cr)))
  :-  %a
  %+  turn  results
  |=  r=result:ast
  ^-  json
  ?-  -.r
    %action         (frond:enjs:format 'action' s+action.r)
    %relation       (frond:enjs:format 'relation' s+relation.r)
    %message        (frond:enjs:format 'message' s+msg.r)
    %vector-count   (frond:enjs:format 'count' (numb:enjs:format count.r))
    %server-time    (frond:enjs:format 'server-time' s+(scot %da date.r))
    %security-time  (frond:enjs:format 'security-time' s+(scot %da date.r))
    %schema-time    (frond:enjs:format 'schema-time' s+(scot %da date.r))
    %data-time      (frond:enjs:format 'data-time' s+(scot %da date.r))
    %result-set     (frond:enjs:format 'rows' a+(turn set.r obelisk-row-json))
  ==
++  obelisk-row-json
  |=  v=vector:ast
  ^-  json
  %-  pairs:enjs:format
  %+  turn  `(lest vector-cell:ast)`+.v
  |=  c=vector-cell:ast
  ^-  [@t json]
  ::  text auras (t/ta/tas) hold the cord verbatim; scot would re-escape it
  ::  ('Urbit Basics' -> ~~~55.rbit...). Emit the raw cord for those; scot the
  ::  rest (@p/@ud/@da/@rs) so their aura syntax survives.
  =/  aura=@ta  p.q.c
  :-  p.c
  ?:  |(=('t' aura) =('ta' aura) =('tas' aura))
    s+q.q.c
  s+(scot aura q.q.c)
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
::  +catalog-init: create the lattice database, then all catalog-* tables in ONE
::  atomic urQL script. Single script (not 8 pokes) because obelisk's kick after
::  every poke races back-to-back statements in one fiber; one script is one
::  obelisk event. ponytail: on a fresh db all 8 create; re-run on an existing
::  db aborts at the first (dup) table harmlessly, but WON'T repair a partially
::  created schema — drop+init for a clean rebuild.
::
++  catalog-init
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  ~  bind:m  (catalog-run %sys (weld "CREATE DATABASE " (trip catalog-db)))
  (catalog-run catalog-db catalog-create-urql:cat)
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
::  +catalog-scan-self: index every one of OUR OWN published pages into the
::  catalog (source = publisher = our). The local, peer-free slice of the crawler
::  — proves the analyze -> obelisk pipeline end to end. Returns the count indexed.
::
++  catalog-scan-self
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  our=@p       bind:m  get-our:io
  ;<  now=@da      bind:m  get-time:io
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
::  KNOWN GAP (finding #5): this indexes the peer's CURRENT /pub/index but never
::  reconciles against rows we stored on a prior sweep, so a page the peer
::  UNPUBLISHES leaves ghost rows in catalog-pages/terms/headings/links/tags/meta
::  forever (stale search hits that 404 on read). The self-delete path already has
::  the tool: catalog-page-delete-urql. To close this, before/after the index loop
::  SELECT the stored content-keys for (source=our, publisher=pub) [add a
::  `FROM catalog-pages WHERE source=.. AND publisher=.. SELECT path;` gen, run it
::  via obelisk-query], diff against `pages`, and emit catalog-page-delete-urql for
::  each dropped path. NOTE: this IS production-reachable — /follow is a live owner
::  route and catalog-scan-peers runs on every ~h6 crawler tick — so once any peer
::  is followed and unpublishes a page, ghost rows accumulate. Deferred (not
::  unreachable) only so the reconcile can be verified against a real
::  publish->unpublish before shipping untested query+diff into the crawler.
++  catalog-scan-peer
  |=  [our=@p pub=@p now=@da]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  ix=pub-index:lp  bind:m  (read-pub-index-remote pub)
  =/  pages=(set path)  ~(key by ix)
  ::  cap the indexed fan-out per peer (untrusted); pages stays full for
  ::  internal-link detection. ponytail: index the first manifest-max keys;
  ::  add per-peer cursoring if a real follow legitimately exceeds it.
  =/  keys=(list path)  (scag manifest-max ~(tap in pages))
  (catalog-scan-peer-loop our pub now keys pages 0)
++  catalog-scan-peer-loop
  |=  [our=@p pub=@p now=@da keys=(list path) pages=(set path) cnt=@ud]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ?~  keys  (pure:m cnt)
  =/  stripped=path  (strip-pub:lp i.keys)
  ?~  stripped  (catalog-scan-peer-loop our pub now t.keys pages cnt)
  ;<  body=(unit @t)  bind:m  (read-page-body pub (snip `path`stripped))
  ?~  body  (catalog-scan-peer-loop our pub now t.keys pages cnt)
  ;<  ~  bind:m  (catalog-index-page our pub i.keys now u.body pages)
  (catalog-scan-peer-loop our pub now t.keys pages (add cnt 1))
::  +pub-path: a relative publish path ("notes/intro") -> content-map key
::  (/pub/notes/intro/gmi). Ported from /lib/lattice.
::
++  pub-path
  |=  rel=@t
  ^-  path
  :(welp /pub (stab (crip (weld "/" (trip rel)))) /gmi)
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
  ?:(?=(%& -.res) `p.res ~)
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
  ;<  now=@da  bind:m  get-time:io
  =/  until=@da  (add now remote-timeout)
  ;<  pw=wire  bind:m  (nonce:io /peek)
  ;<  ~  bind:m  (send-dart:io %node pw (remote-road road shp) %peek ~ ~ %.y)
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
      [~ %veto *]  [%done ~]
      [~ %peek * *]
    ?.  =(pwire wire.u.in)  [%skip ~]
    [%done `seen.u.in]
      [~ %poke * *]
    ?.  =([/ %timer-wake] p.sage.u.in)  [%skip ~]
    =/  wak=path  !<(path q.sage.u.in)
    ?.  ?&(?=([%wait @ ~] wak) =(until (slav %da i.t.wak)))  [%skip ~]
    [%done ~]
  ==
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
  =/  rel=path
    ?.  ?&(?=(^ rel) =(%pub i.rel) =(%gmi (rear rel)))  rel
    (snip (strip-pub:lp rel))
  ;<  our=@p  bind:m  get-our:io
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
    =/  rest=tape  (slag 3 ln)
    =/  sp=(unit @ud)  (find " " rest)
    =/  raw=tape   ?~(sp rest (scag u.sp rest))
    =/  desc=tape  ?~(sp rest (slag +(u.sp) rest))
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
::  +sse-script: reactive live-view client JS (finding #19). Streams grubbery's
::  keep-SSE for `keep`, skips the initial `old` snapshot events, and reloads on
::  any subsequent change — so an open reader / home index upgrades a stale first
::  paint and shows live edits (the old agent's /updates channel). "" -> no script
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
  =/  ix=road:tarball  [%& %& (weld root /know) %index]
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
    =/  road=road:tarball  (entry-road vbase key)
    ;<  old=(unit know-entry:lk)  bind:m  (read-entry road)
    =/  e=know-entry:lk  (merge-save:lk old body.act now)
    ;<  ~  bind:m  (ensure-dirs vbase key)
    ;<  ~  bind:m  (put-file road [/lattice %know-entry] e)
    ;<  ~  bind:m  (gain:io road %.y)
    ;<  idx=know-index:lk  bind:m  (read-index ix)
    ;<  ~  bind:m
      (put-file ix [/lattice %know-index] (~(put by idx) key (to-index-entry:lk e)))
    ::  a re-saved key leaves trash; cull the orphaned trash-vault GRUB (not just
    ::  the index row) so a later %restore can't resurrect the stale tomb over the
    ::  live entry.
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    ?.  (~(has by trash) key)  (pure:m ~)
    ;<  ~  bind:m  (cull:io (entry-road tvbase key))
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
    ;<  idx=know-index:lk  bind:m  (read-index ix)
    ;<  ~  bind:m  (put-file ix [/lattice %know-index] (~(del by idx) key))
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
    ;<  idx=know-index:lk  bind:m  (read-index ix)
    =.  idx  (~(put by (~(del by idx) fk)) tk (to-index-entry:lk u.old))
    ;<  ~  bind:m  (put-file ix [/lattice %know-index] idx)
    ::  if the target key was previously trashed, cull the orphan trash grub +
    ::  row so a later %restore can't resurrect it over the moved-in entry.
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    ?.  (~(has by trash) tk)  (pure:m ~)
    ;<  ~  bind:m  (cull:io (entry-road tvbase tk))
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
    ;<  ~  bind:m  (put-file tx [/lattice %know-index] (~(del by trash) key))
    ;<  idx=know-index:lk  bind:m  (read-index ix)
    (put-file ix [/lattice %know-index] (~(put by idx) key (to-index-entry:lk u.old)))
  ::
      %import
    ::  write a live entry VERBATIM (preserve updated/tags/vector) — migration,
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
    ;<  idx=know-index:lk  bind:m  (read-index ix)
    ;<  ~  bind:m
      (put-file ix [/lattice %know-index] (~(put by idx) key (to-index-entry:lk entry.act)))
    ;<  trash=know-index:lk  bind:m  (read-index tx)
    ?.  (~(has by trash) key)  (pure:m ~)
    ;<  ~  bind:m  (cull:io (entry-road tvbase key))
    (put-file tx [/lattice %know-index] (~(del by trash) key))
  ::
      %import-trashed
    ::  land a trashed entry straight into the trash vault (migration of an
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
  ::
      %reindex
    ::  rebuild the live index from the vault ball — repairs drift if the
    ::  derived index ever diverges from the source-of-truth entry grubs.
    ;<  =seen:nexus  bind:m  (peek:io [%& %| vbase] ~)
    ?.  ?=([%& %ball *] seen)  ~&([%lattice-reindex-no-vault ~] (pure:m ~))
    =/  entries=(map path know-entry:lk)  (collect-entries ~ ball.p.seen)
    (put-file ix [/lattice %know-index] (derive-index:lk entries))
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
  =/  m  (fiber:fiber:nexus ,pub-index:lp)
  ^-  form:m
  ;<  ms=(unit seen:nexus)  bind:m
    (peek-remote-wait [%& %& (weld app-base /pub) %index] shp)
  ?~  ms  (pure:m *pub-index:lp)
  ?.  ?=([%& %file *] u.ms)  (pure:m *pub-index:lp)
  ::  CROSS-SHIP peek content is a boom (raw noun), not a vase — need-vase would
  ::  crash the crawler. Extract via sang-noun and clam in a mule so a malformed
  ::  or hostile peer index yields an empty index instead of crashing the sweep.
  =/  res=(each pub-index:lp tang)
    (mule |.(;;(pub-index:lp (sang-noun:tarball sang.p.u.ms))))
  ?:(?=(%| -.res) (pure:m *pub-index:lp) (pure:m p.res))
::  +read-follows: the crawler's follow set. ABSOLUTE road (app-base) so it reads
::  the same from the depth-2 request fiber and the depth-0 crawler fiber.
::
++  read-follows
  =/  m  (fiber:fiber:nexus ,follows:lp)
  ^-  form:m
  ;<  =seen:nexus  bind:m  (peek:io [%& %& (weld app-base /sub) %follows] ~)
  ?.  ?=([%& %file *] seen)  (pure:m *follows:lp)
  (pure:m !<(follows:lp (need-vase:tarball sang.p.seen)))
::  +apply-sub: follow/unfollow — read-modify-write the follow set. Runs in the
::  writer fiber (serialised), so concurrent /follow requests don't race.
::
++  apply-sub
  |=  [root=path act=sub-action:lp]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  fs=follows:lp  bind:m  read-follows
  =/  fs2=follows:lp
    ?-  -.act
      %follow    (~(put in fs) ship.act)
      %unfollow  (~(del in fs) ship.act)
    ==
  (put-file [%& %& (weld root /sub) %follows] [/lattice %sub-follows] fs2)
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
  ;<  ~  bind:m  (put-file road [/lattice %know-entry] e)
  =/  ix=road:tarball  [%& %& (weld root /know) %index]
  ;<  idx=know-index:lk  bind:m  (read-index ix)
  (put-file ix [/lattice %know-index] (~(put by idx) key (to-index-entry:lk e)))
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
