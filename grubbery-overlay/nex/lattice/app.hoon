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
/<  le   /lib/lattice-eval.hoon
/<  pg   /lib/lattice-pg.hoon
/<  gfm  /lib/lattice-md.hoon
/<  tpl  /lib/lattice-templates.hoon
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
        ::  /page/: programmable pages (docs/platform.md step 2). One dir per
        ::  page; the code grub's on-file fiber is the evaluator.
            [%fall %| /page empty-dir:loader]
        ::  /template/: reusable page-tree templates (inert code grubs, never
        ::  evaluated — no [%page ...] on-file match). Covered so saved and
        ::  shipped templates survive reload, like /page and /know/vault.
            [%fall %| /template empty-dir:loader]
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
        ::  re-grant every shared page's data road (self-heal, like ensure-pub-weir):
        ::  a page shared before the public usergroup existed skipped the grant;
        ::  this re-applies it on the next writer start once the group is present.
        ;<  ~  bind:m  (heal-share-weirs root)
        ::  lay down the built-in page-tree templates (idempotent; skips if the
        ::  user already has them). Users instantiate a copy under /page.
        ;<  ~  bind:m  (ensure-shipped-templates root)
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
        ?:  =([/lattice %eval-action] p.sage)
          ;<  ~  bind:m  (apply-eval root !<(eval-action:le q.sage))
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
      ::  /page/<name>/code: the page evaluator (docs/platform.md step 2). The
      ::  fiber owns the page's code grub: compile the source (a gate) against
      ::  the hoon stdlib, run it on commands (cmd grub, seq-bumped) and on
      ::  dependency waves, write the product to the data grub. A compile or
      ::  run crash writes err and keeps the last good data — a broken page
      ::  never kills the fiber (mule everything). ponytail: dep keeps are
      ::  armed and never dropped (a removed dep still ticks; save-file's
      ::  no-op suppression bounds it); page code gets the hoon stdlib only
      ::  (..add) and returns NO darts yet — the capped-authority %sand
      ::  plumbing lands with darts (platform decision). A divergent dep
      ::  cycle spins; a converging one terminates via no-op suppression.
          [[%page @ *] %code]
        ;<  ~  bind:m  (rise-wait:io prod "%lattice /page eval: failed")
        ;<  here=rail:tarball  bind:m  get-here-abs:io
        =/  pdir=path  path.here
        ::  one wire for everything: code (self), cmd inbox, deps grub, and
        ::  each declared dep target. Any change wakes the loop.
        ;<  *  bind:m  (keep:io /ev [%& %& pdir %code] ~)
        ;<  *  bind:m  (keep:io /ev [%& %& pdir %cmd] ~)
        ;<  *  bind:m  (keep:io /ev [%& %& pdir %deps] ~)
        ::  `last` = last-PROCESSED cmd seq, persisted in the /seen grub (NOT
        ::  inferred from the current cmd grub). A page-save on a compile-broken
        ::  page respawns this fiber (put-file over /code), which re-inits `last`
        ::  from /seen — so a command sent while broken (seq past /seen) still
        ::  runs once the fix compiles, while a plain reload never replays an
        ::  already-run command (both caught by review).
        ;<  last=@ud  bind:m  (read-eval-seen pdir)
        =/  armed=(set path)  ~
        =/  held=@t  '=='
        =/  bild=(each vase tang)  [%| `tang`~[leaf+"not compiled"]]
        ::  gen counts RAPID consecutive dep-tick reruns. A dep cycle or an
        ::  always-changing page reruns as fast as the event loop allows and
        ::  would livelock it; a legit reactive page reruns only when an
        ::  upstream actually changes, spaced out in time. So gen accumulates
        ::  only while reruns land closer together than `rerun-gap`, and resets
        ::  on a command or a slow (legit) gap — capping runaways without ever
        ::  parking a page that merely reacts to many updates over time. gen and
        ::  last-now live in this fiber's loop across every wave.
        =/  gen=@ud  0
        =/  last-now=@da  `@da`0
        |-
        ;<  src=@t  bind:m  (get-state-as:io ,@t)
        =?  bild  !=(src held)
          ::  compile the page against the page stdlib (pg): its builders
          ::  (text/html/needs/every/sends/esc) and the +result mold are in
          ::  scope at the top, the full hoon/zuse stack beneath.
          (mule |.((slap !>(pg) (ream src))))
        =.  held  src
        ?:  ?=(%| -.bild)
          ;<  ~  bind:m
            (put-file [%& %& pdir %err] [/lattice %page] (render-tang 'compile failed:' p.bild))
          ;<  *  bind:m  (take-news-or-wake-drain /ev)
          $
        ;<  deps=(list path)  bind:m  (read-eval-deps pdir)
        ;<  na=(set path)  bind:m  (arm-eval-deps armed deps)
        =.  armed  na
        ;<  cur=eval-cmd:le  bind:m  (read-eval-cmd pdir)
        =/  fresh=?  (gth seq.cur last)
        ;<  now=@da  bind:m  bowl-now
        ::  rapid = this rerun landed within `rerun-gap` of the previous one (a
        ::  runaway burst — a DEPENDENCY cycle or an always-changing page reruns
        ::  as fast as the loop allows). gen accumulates while rapid and resets
        ::  on a settled gap. (Page-to-page POKE cycles are too slow per hop for
        ::  this window — those are bounded by the poke budget instead.)
        =/  rapid=?  &(!=(`@da`0 last-now) (lth (sub now last-now) rerun-gap))
        =.  gen  ?:(rapid +(gen) 0)
        =.  last-now  now
        ?:  (gth gen recompute-cap)
          ::  a sustained rapid rerun burst — a cycle or an always-changing page.
          ::  Stop producing data (that is what wakes our dependents), write err,
          ::  and park until a command (or a settled gap) resets gen.
          =/  msg=@t
            'recompute limit hit (dependency cycle or always-changing page?); send a command to resume'
          ;<  ~  bind:m  (put-file [%& %& pdir %err] [/lattice %page] msg)
          ;<  *  bind:m  (take-news-or-wake-drain /ev)
          $
        =/  cmd=(unit @t)  ?:(fresh `txt.cur ~)
        ::  poke budget for this run: a command carries one (a page reached via
        ::  a poke got a decremented budget); a dep/timer tick starts fresh.
        =/  run-bud=@ud  ?:(fresh bud.cur poke-budget-max)
        ;<  ~  bind:m  (eval-run pdir p.bild cmd deps run-bud)
        ::  eval-run recorded any timer request in the /wake grub (clamped, or ~
        ::  if the page asked for no timer or its run failed); read it back.
        ;<  wake=(unit @dr)  bind:m  (read-wake pdir)
        ::  persist the processed seq only when a command actually ran (a dep
        ::  tick leaves seq unchanged). /seen is not kept, so this fires no wave.
        =?  last  fresh  seq.cur
        ;<  ~  bind:m  ?:(fresh (write-eval-seen pdir seq.cur) (pure:m ~))
        ::  wait for a dependency/command wave — or, if the page asked for a
        ::  timer (`every`), for that timer, whichever comes first. Using
        ::  -until keyed on this timer means an earlier stale timer is drained,
        ::  so timers don't pile up across reruns.
        ?~  wake
          ;<  *  bind:m  (take-news-or-wake-drain /ev)
          $
        ::  anchor the timer to a FRESH now, read AFTER eval-run. The `now` above
        ::  was captured before the (possibly slow) run; if the run took longer
        ::  than u.wake, `(add now u.wake)` is already in the PAST, so behn fires
        ::  immediately => zero real idle => a 100%-pinned tight loop (the timer
        ::  can't outrun its own eval). Re-reading now guarantees >= u.wake
        ::  (>= rerun-gap ~s1) of real idle between the end of one run and the
        ::  next, so a heavy timer page stays responsive instead of pinning the
        ::  loop. (Same bowl-now -> send-wait pattern used by the sub/pub loops.)
        ;<  arm-now=@da  bind:m  bowl-now
        =/  until=@da  (add arm-now u.wake)
        ;<  ~  bind:m  (send-wait:io until)
        ;<  *  bind:m  (take-news-or-wake-until /ev until)
        $
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
  =/  parsed  (parse-url:http-utils url.request.req)
  ::  drop the /apps/lattice prefix; the remainder is the route.
  =/  suffix=path  (slag 2 site.parsed)
  =/  args=(map @t @t)  (malt args.parsed)
  ::  clearweb: the ONLY unauthenticated surface. GET /c/<name> serves a
  ::  clearweb-tagged page's DATA, read-only — no tree nav, no code, no
  ::  sibling grubs, no command form. Everything else requires the owner.
  ?:  &(?=([%c ^] suffix) =(%'GET' method.request.req))
    (serve-clearweb eyre-id t.suffix)
  ::  owner gate. Eyre stamps a request authenticated to our web login with
  ::  src=our, so `authenticated` (already in hand, synchronous) IS the src==our
  ::  check — reading `our` via a /sys/bowl round trip (bowl-our) just to compare
  ::  cost ~0.2s on EVERY request. Gate on the flag; `our` is then simply `src`.
  ?.  authenticated.req
    ::  JSON error, like every other route (was a bare text 'Forbidden').
    (send-err eyre-id 403 'forbidden')
  =/  our=@p  src
  ::  /x/<ship>/<path...>: the server-rendered tree explorer (docs/platform.md,
  ::  build step 1). Consumes the rest of the path, so it dispatches before the
  ::  (rear suffix) route table below.
  ?:  &(?=([%x *] suffix) =(%'GET' method.request.req))
    (explore eyre-id our t.suffix args url.request.req)
  ::  /f/<name>: serve a file's raw data as an asset, Content-Type from its
  ::  render mode (js -> text/javascript, css -> text/css, ...), so an html file
  ::  can import a js/css file by URL. Owner-gated (fetched with the session).
  ?:  &(?=([%f ^] suffix) =(%'GET' method.request.req))
    (serve-asset eyre-id t.suffix)
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
        ;<  pages=(list path)  bind:m  read-page-names
        ;<  tmpls=(list @ta)   bind:m  read-template-names
        ;<  ix=pub-index:lp    bind:m  (read-pub-index [%| 2 %& /pub %index])
        (send-view eyre-id (render-page (weld "urb://" (scow %p our)) (keep-url "pub/index") (home-index-html our pages tmpls ix)))
      (send-view eyre-id (render-page (weld "urb://" (scow %p our)) (keep-url "pub/index") (render-gmi u.home)))
    =/  ref=(unit referent)  (de-urb u.raw)
    ?~  ref  (send-html eyre-id (render-page (trip u.raw) "" "<p class=\"err\">bad urb:// url</p>"))
    ?-  -.u.ref
        %tree
      ::  redirect to the /x explorer projection, which renders the node and
      ::  shows its canonical urb:// address. Preserve a trailing slash so a page
      ::  dir goes straight to its live view (no extra dir-slash redirect).
      =/  s=tape  (trip u.raw)
      =/  slash=tape  ?:(&(?=(^ s) =('/' (rear s))) "/" "")
      (send-redirect eyre-id :(weld "/apps/lattice/x/" (scow %p ship.u.ref) (spud pax.u.ref) slash))
    ::
        %pub
      ;<  body=(unit @t)  bind:m  (read-page-body ship.u.ref rel.u.ref)
      =/  canon=tape  (trip (en-urb ship.u.ref (weld pub-prefix rel.u.ref)))
      ?~  body
        (send-view eyre-id (render-page canon "" "<p class=\"err\">not published here</p>"))
      ::  own pages get a live reader (keep /pub/index — its per-page hash changes
      ::  on every edit); remote pages stay static (can't keep a peer's grub).
      =/  rk=tape  ?:(=(ship.u.ref our) (keep-url "pub/index") "")
      (send-view eyre-id (render-page canon rk (render-gmi u.body)))
    ==
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
  ::  ── programmable pages (docs/platform.md step 2) ──
      [%'GET' %'manifest.webmanifest']
    (send-typed eyre-id 'application/manifest+json' 'no-cache' manifest-json)
      [%'GET' %'sw.js']
    (send-sw eyre-id sw-js)
      [%'GET' %'icon.svg']
    (send-typed eyre-id 'image/svg+xml' 'public, max-age=86400' icon-svg)
      [%'GET' %'apple-touch-icon.png']
    (send-png eyre-id apple-icon-b64)
      [%'GET' %edit]
    ::  the in-browser editor workspace (tree | code | preview | controls).
    ::  No name -> new-page mode. The page list feeds the tree sidebar.
    =/  name=(unit @t)  (~(get by args) 'name')
    ;<  tree=(list [pax=path page=?])  bind:m  read-tree
    ?~  name
      ::  ?kind=<md|gmi|html|text|js|css> opens a new typed file; else a hoon page.
      ::  ?into=<folder> pre-fills the name field so the new file lands in it.
      ::  ?newfolder opens the in-editor "new folder" mode (name field, no code).
      =/  kind=@tas  (kind-of (~(gut by args) 'kind' 'hoon'))
      =/  into=@t  (~(gut by args) 'into' '')
      =/  nfolder=?  (~(has by args) 'newfolder')
      (send-html eyre-id (edit-html our ~ '' tree %private '' kind into nfolder))
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  pdir=path  (weld app-base (weld /page (pax-of u.name)))
    ;<  dn=seen:nexus  bind:m  (peek-shallow:io [%& %| pdir] ~)
    ?.  ?=([%& %ball *] dn)  (send-err eyre-id 404 'no such page')
    =/  fils=(map @ta [=sang:tarball gain=? bang=(unit tang)])
      ?~(fil.ball.p.dn ~ contents.u.fil.ball.p.dn)
    ?.  (~(has by fils) %code)  (send-err eyre-id 404 'no such page')
    =/  rd  |=(nom=@ta ^-(@t =/(v (~(get by fils) nom) ?~(v '' (fall (mole |.(;;(@t (sang-noun:tarball sang.u.v)))) '')))))
    =/  src=@t  (rd %code)
    =/  err=@t  (rd %err)
    ::  a typed file round-trips: if /code matches the content envelope, edit the
    ::  raw body (not the generated hoon) and open in that type's mode.
    =/  un=(unit [builder=@tas body=@t])  (unwrap-content src)
    =/  kind=@tas  ?~(un %hoon builder.u.un)
    =/  disp=@t  ?~(un src body.u.un)
    =/  mode=share-mode:le
      =/  v  (~(get by fils) %share)
      ?~  v  %private
      (fall (mole |.(;;(share-mode:le (sang-noun:tarball sang.u.v)))) %private)
    (send-html eyre-id (edit-html our [~ `@ta`u.name] disp tree mode err kind '' %.n))
      [%'POST' %page-save]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  raw=@t  (req-body req)
    ::  ?type=index: no body — the code is generated from the page's own path
    ::  (it lists its own folder). Otherwise a body is required.
    =/  ptype=@tas  `@tas`(~(gut by args) 'type' 'hoon')
    =/  is-index=?  =(%index ptype)
    ?:  &(?!(is-index) =('' raw))  (send-err eyre-id 400 'missing body')
    ::  ?type=<builder>: the body is raw content, not hoon. Wrap it in
    ::  `... (BUILDER 'content')` so the whole pipeline runs unchanged; edit
    ::  reopens it via unwrap-content. Absent/unknown type -> raw hoon.
    =/  src=@t
      ?:  is-index  (make-folder-index (pax-of u.name))
      ?:((~(has in content-builders) ptype) (wrap-content ptype raw) raw)
    ::  ?new=1: create-only — 409 instead of silently overwriting an existing
    ::  page (the editor's new-page mode sends it; caught by review).
    ;<  ex=?  bind:m
      (peek-exists:io [%& %& (weld app-base (weld /page (pax-of u.name))) %code])
    ?:  &((~(has by args) 'new') ex)  (send-err eyre-id 409 'page exists')
    ;<  ~  bind:m  (poke-eval [%make (pax-of u.name) src])
    (send-ok eyre-id)
      [%'POST' %folder-new]
    ::  create an empty folder (nested ok, e.g. "a/b"). The tree shows it and
    ::  ?into= drops new files inside. Idempotent over an existing page/folder.
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    ;<  ~  bind:m  (poke-eval [%mkdir (pax-of u.name)])
    (send-ok eyre-id)
      [%'POST' %page-preview]
    ::  live markdown preview: render the POSTed body with the real render-md
    ::  (the source-of-truth renderer, so no client/server drift) and return a
    ::  bare HTML doc. Non-persisting — nothing is written, so the editor can
    ::  preview a note as it is typed, before any save. Owner-gated like all
    ::  non-clearweb routes.
    =/  body=@t  (req-body req)
    =/  ptype=@tas  `@tas`(~(gut by args) 'type' 'md')
    =/  inner=tape
      ?+  ptype  (render-md:gfm body)
        %md    (render-md:gfm body)
        %gmi   (render-gmi body)
        %html  (trip body)
        %text  :(weld "<pre>" (esc (trip body)) "</pre>")
        %js    :(weld "<pre><code class=\"language-javascript\">" (esc (trip body)) "</code></pre>")
        %css   :(weld "<pre><code class=\"language-css\">" (esc (trip body)) "</code></pre>")
        %index  "<div style=\"color:#8a8a8a;text-align:center;padding:2rem\"><p><b>Folder index</b></p><p>Lists the pages in this page's folder automatically, once you name it (e.g. blog/index) and save. Live as pages come and go.</p></div>"
      ==
    (send-html eyre-id (render-bare inner))
      [%'POST' %page-cmd]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    ::  404 a command to a nonexistent page (the writer guards too, but this
    ::  gives the client real feedback instead of a fire-and-forget 200).
    ;<  ex=?  bind:m  (peek-exists:io [%& %& (weld app-base (weld /page (pax-of u.name))) %code])
    ?.  ex  (send-err eyre-id 404 'no such page')
    ::  a browser form POSTs cmd in the (form-urlencoded) body; parse it as a
    ::  query (same k=v&k=v grammar). Query cmd is the fallback for programmatic
    ::  callers. name/web stay in the action-url query.
    =/  form=(map @t @t)
      (malt args:(parse-url:http-utils (crip (weld "/?" (trip (req-body req))))))
    =/  txt=@t  (~(gut by form) 'cmd' (~(gut by args) 'cmd' ''))
    ::  a user command starts a fresh poke budget.
    ;<  ~  bind:m  (poke-eval [%cmd (pax-of u.name) txt poke-budget-max])
    ::  web=1 (a page-view form submit) -> 303 back to the page so the browser
    ::  lands on the live view; the JSON ok stays for programmatic callers.
    ?.  (~(has by args) 'web')  (send-ok eyre-id)
    %+  send-see-other  eyre-id
    :(weld "/apps/lattice/x/" (scow %p our) "/apps/lattice.lattice_app/page/" (trip u.name) "/")
      [%'POST' %page-del]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    ;<  ~  bind:m  (poke-eval [%del (pax-of u.name)])
    (send-ok eyre-id)
      [%'POST' %page-share]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  mode=share-mode:le
      ?+  (~(gut by args) 'mode' 'private')  %private
        %shared    %shared
        %clearweb  %clearweb
      ==
    ;<  ex=?  bind:m  (peek-exists:io [%& %& (weld app-base (weld /page (pax-of u.name))) %code])
    ?.  ex  (send-err eyre-id 404 'no such page')
    ;<  ~  bind:m  (poke-eval [%share (pax-of u.name) mode])
    ?.  (~(has by args) 'web')  (send-ok eyre-id)
    %+  send-see-other  eyre-id
    :(weld "/apps/lattice/x/" (scow %p our) "/apps/lattice.lattice_app/page/" (trip u.name) "/")
      [%'POST' %page-share-tree]
    ::  publish/unpublish a whole subtree at once: set `mode` on every page
    ::  under a folder. name is the folder path; mode=clearweb publishes a site,
    ::  mode=private takes it all down.
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  mode=share-mode:le
      ?+  (~(gut by args) 'mode' 'private')  %private
        %shared    %shared
        %clearweb  %clearweb
      ==
    ;<  ~  bind:m  (poke-eval [%share-tree (pax-of u.name) mode])
    (send-ok eyre-id)
      [%'POST' %template-save]
    ::  save a page-tree as a reusable template: from=<page path>, name=<term>.
    =/  from=(unit @t)  (~(get by args) 'from')
    =/  nm=(unit @t)    (~(get by args) 'name')
    ?~  from  (send-err eyre-id 400 'missing from')
    ?~  nm    (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.from)  (send-err eyre-id 400 'bad from')
    ?.  ((sane %tas) u.nm)   (send-err eyre-id 400 'bad template name')
    ;<  ~  bind:m  (poke-eval [%tmpl-save (pax-of u.from) `@tas`u.nm])
    (send-ok eyre-id)
      [%'POST' %template-new]
    ::  instantiate a template into a new page-tree: template=<term>, name=<path>.
    =/  tmpl=(unit @t)  (~(get by args) 'template')
    =/  nm=(unit @t)    (~(get by args) 'name')
    ?~  tmpl  (send-err eyre-id 400 'missing template')
    ?~  nm    (send-err eyre-id 400 'missing name')
    ?.  ((sane %tas) u.tmpl)  (send-err eyre-id 400 'bad template')
    ?.  (valid-name u.nm)     (send-err eyre-id 400 'bad name')
    ;<  ex=?  bind:m
      (peek-exists:io [%& %& (weld app-base (weld /page (pax-of u.nm))) %code])
    ?:  ex  (send-err eyre-id 409 'a page by that name exists')
    ;<  ~  bind:m  (instantiate-template `@tas`u.tmpl (pax-of u.nm))
    (send-ok eyre-id)
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
::  +render-tang: a compile/run-error tang as the readable multi-line text
::  dojo would print — NOT a raw [i=[%palm ...]] noun dump. The page is
::  compiled via (slap !>(pg) (ream src)), so slap stamps its own call site
::  (nex/lattice/app.hoon:<...>) into the trace; those lines are noise to a
::  page author, so we drop them and keep the actual error (`-find.cmd`,
::  `syntax error`, `nest-fail`). Falls back to the raw trace if filtering
::  would leave nothing.
++  render-tang
  |=  [lab=@t =tang]
  ^-  @t
  =/  rendered=wall  (zing (turn tang |=(=tank (~(win re tank) 0 78))))
  =/  kept=wall  (skip rendered |=(l=tape ?=(^ (find "app.hoon" l))))
  =/  out=wall  [(trip lab) ?~(kept rendered kept)]
  (crip (of-wall:format out))
::  +poke-eval: send an eval-action to the writer (serialized like all writes).
::
++  poke-eval
  |=  act=eval-action:le
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (poke:io [%| 2 %& ~ %'main.sig'] [[/lattice %eval-action] act])
::  +apply-eval: page create/command/delete, in the writer fiber.
::
++  apply-eval
  |=  [root=path act=eval-action:le]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ::  name.act only resolves after ?- narrows the fork (%del is a 2-cell,
  ::  the others 3-cells — the face sits at different axes).
  ?-  -.act
      %make
    (make-page root pax.act src.act)
      %tmpl-save
    ::  save a page-tree as a template: copy every page's CODE under
    ::  /template/<name>, rewriting its own root path to the template root, and
    ::  leave it inert (code grub only — templates are never evaluated).
    ::  (Instantiation is +instantiate-template — one make PER page, not a batch.)
    (copy-tree root [%page from.act] [%template /[name.act]] %.n)
      %cmd
    =/  pdir=path  (weld root (weld /page pax.act))
    ::  authoritative existence guard: no code grub -> no page (and no
    ::  evaluator fiber), so writing a cmd grub would orphan it inside a
    ::  possibly-culled dir and swallow the command (caught by review). The
    ::  route also 404s, but this closes the create-then-poke race.
    ;<  cx=?  bind:m  (peek-exists:io [%& %& pdir %code])
    ?.  cx  (pure:m ~)
    ;<  sn=seen:nexus  bind:m  (peek:io [%& %& pdir %cmd] ~)
    =/  cur=eval-cmd:le
      ?.  ?=([%& %file *] sn)  [0 '' 0]
      (fall (mole |.(;;(eval-cmd:le (sang-noun:tarball sang.p.sn)))) [0 '' 0])
    (put-file [%& %& pdir %cmd] [/lattice %eval-cmd] `eval-cmd:le`[+(seq.cur) txt.act bud.act])
      %del
    ::  cull-soft on an absent dir veto-crashes the writer (as apply-sub's
    ::  %unsub-page guards against) — no-op a delete of a gone page. Also
    ::  drop the data road from the public weir so a deleted page leaves no
    ::  dangling grant.
    =/  pdir=path  (weld root (weld /page pax.act))
    ;<  ex=?  bind:m  (peek-exists:io [%& %| pdir])
    ?.  ex  (pure:m ~)
    ;<  ~  bind:m  (share-weir [%& %& pdir %data] %.n)
    ;<  *  bind:m  (cull-soft:io [%& %| pdir])
    (pure:m ~)
      %share
    (apply-share (weld root (weld /page pax.act)) mode.act)
      %share-tree
    ::  publish/unpublish a whole subtree: apply the mode to every PAGE under
    ::  pax (folders have no /data grub, so skip them). Idempotent, so
    ::  re-publishing is safe; a %private sweep revokes each page's weir too.
    =/  base=path  (weld root (weld /page pax.act))
    ;<  dn=seen:nexus  bind:m  (peek:io [%& %| base] ~)
    ?.  ?=([%& %ball *] dn)  (pure:m ~)
    =/  rels=(list path)
      %+  murn  (collect-tree ball.p.dn ~)
      |=([pax=path page=?] ?:(page `pax ~))
    |-  ^-  form:m
    ?~  rels  (pure:m ~)
    ;<  ~  bind:m  (apply-share (weld base i.rels) mode.act)
    $(rels t.rels)
      %mkdir
    ::  create an empty folder (and any missing parents). ensure-dirs is
    ::  idempotent, so mkdir over an existing page/folder is a harmless no-op.
    (ensure-dirs (weld root /page) pax.act)
  ==
::  +apply-share: set one page's sharing preset — the shared body of the %share
::  and %share-tree eval-actions, so per-page and per-tree can't drift. weir road
::  first (covers the grub before it exists), then gain the current data if any
::  (the evaluator re-gains on each later write). Idempotent.
::
++  apply-share
  |=  [pdir=path mode=share-mode:le]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  cx=?  bind:m  (peek-exists:io [%& %& pdir %code])
  ?.  cx  (pure:m ~)
  =/  data-road=road:tarball  [%& %& pdir %data]
  =/  pub=?  !=(%private mode)
  ;<  ~  bind:m  (share-weir data-road pub)
  ;<  dx=?  bind:m  (peek-exists:io data-road)
  ;<  ~  bind:m  ?:(dx (gain:io data-road pub) (pure:m ~))
  (put-file [%& %& pdir %share] [/lattice %eval-data] mode)
::  +make-page: create a page at `pax` under /page with the given code — the
::  shared body of the %make action and template instantiation. cmd + deps
::  first (the code grub's fiber reads both at spawn), then the code.
::
++  make-page
  |=  [root=path pax=path src=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  pdir=path  (weld root (weld /page pax))
  ;<  ~  bind:m  (ensure-dirs (weld root /page) pax)
  ;<  ex=?  bind:m  (peek-exists:io [%& %& pdir %cmd])
  ;<  ~  bind:m
    ?:  ex  (pure:m ~)
    (put-file [%& %& pdir %cmd] [/lattice %eval-cmd] `eval-cmd:le`[0 '' 0])
  ;<  ex=?  bind:m  (peek-exists:io [%& %& pdir %deps])
  ;<  ~  bind:m
    ?:  ex  (pure:m ~)
    (put-file [%& %& pdir %deps] [/lattice %eval-deps] `(list path)`~)
  (put-file [%& %& pdir %code] [/lattice %page] src)
::  +rewrite-root: replace the path-prefix `from` with `to` in code, only where
::  `from` ends at a path boundary (/ ) space " ] , or end) — so a short root
::  can't clobber a longer path that merely starts with it.
::
++  rewrite-root
  |=  [hay=tape from=tape to=tape]
  ^-  tape
  ?~  from  hay
  =/  i  (find from hay)
  ?~  i  hay
  =/  aft=tape  (slag (add u.i (lent from)) hay)
  ::  a path literal ends at end-of-code, any whitespace/control (space, TAB,
  ::  NEWLINE, CR — all <= ' '), or a structural close/open ( ) ( [ ] " , ).
  =/  bnd=?
    ?~  aft  %.y
    ?|((lte i.aft ' ') ?=(?(%'/' %')' %'(' %'[' %']' %'"' %',') i.aft))
  %+  weld  (scag u.i hay)
  %+  weld  ?:(bnd to from)
  $(hay aft)
::  +copy-tree: copy every PAGE under src (a [base rel] like [%page /mysite] or
::  [%template /site]) to dst, rewriting the source root path to the dest root in
::  each page's code. live=%.y -> dest is under /page and each page is MADE
::  (evaluated); %.n -> an inert code grub (a template).
::
++  copy-tree
  |=  [root=path src=[base=@tas rel=path] dst=[base=@tas rel=path] live=?]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  src-root=path  (weld root (weld /[base.src] rel.src))
  =/  from-str=tape  (spud rel.src)
  =/  to-str=tape    (spud rel.dst)
  ;<  dn=seen:nexus  bind:m  (peek:io [%& %| src-root] ~)
  ?.  ?=([%& %ball *] dn)  (pure:m ~)
  =/  rels=(list path)
    %+  murn  (collect-tree ball.p.dn ~)
    |=([pax=path page=?] ?:(page `pax ~))
  |-  ^-  form:m
  ?~  rels  (pure:m ~)
  ;<  cn=seen:nexus  bind:m  (peek:io [%& %& (weld src-root i.rels) %code] ~)
  =/  code=@t
    ?.  ?=([%& %file *] cn)  ''
    (fall (mole |.(;;(@t (sang-noun:tarball sang.p.cn)))) '')
  =/  newcode=@t  (crip (rewrite-root (trip code) from-str to-str))
  ;<  ~  bind:m
    ?:  live
      (make-page root (weld rel.dst i.rels) newcode)
    =/  ddir=path  (weld root (weld /[base.dst] (weld rel.dst i.rels)))
    ;<  ~  bind:m  (ensure-dirs (weld root /[base.dst]) (weld rel.dst i.rels))
    (put-file [%& %& ddir %code] [/lattice %page] newcode)
  $(rels t.rels)
::  +instantiate-template: create a live page-tree from a template. Runs in a
::  REQUEST fiber and pokes one %make PER page (a separate writer transaction
::  each), in sorted order — so every page commits before the next and its
::  evaluator spawns against a settled tree. This is why it is NOT a batch
::  writer action: pages made in one transaction arm dep-keeps that never
::  establish (the tree isn't committed yet), leaving the copies non-reactive.
::
++  instantiate-template
  |=  [name=@tas to=path]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  troot=path    (weld app-base (weld /template /[name]))
  =/  from-str=tape  (spud /[name])
  =/  to-str=tape    (spud to)
  ;<  dn=seen:nexus  bind:m  (peek:io [%& %| troot] ~)
  ?.  ?=([%& %ball *] dn)  (pure:m ~)
  =/  rels=(list path)
    %+  sort
      %+  murn  (collect-tree ball.p.dn ~)
      |=([pax=path page=?] ?:(page `pax ~))
    aor
  |-  ^-  form:m
  ?~  rels  (pure:m ~)
  ;<  cn=seen:nexus  bind:m  (peek:io [%& %& (weld troot i.rels) %code] ~)
  =/  code=@t
    ?.  ?=([%& %file *] cn)  ''
    (fall (mole |.(;;(@t (sang-noun:tarball sang.p.cn)))) '')
  =/  newcode=@t  (crip (rewrite-root (trip code) from-str to-str))
  ;<  ~  bind:m  (poke-eval [%make (weld to i.rels) newcode])
  $(rels t.rels)
::  +page-code: the stored hoon code for a page of a given kind — an index-type
::  page's generated auto-index, a content builder's wrapped body, else raw hoon.
::  Shared by page-save and template laydown.
::
++  page-code
  |=  [pax=path kind=@tas body=@t]
  ^-  @t
  ?:  =(%index kind)  (make-folder-index pax)
  ?:((~(has in content-builders) kind) (wrap-content kind body) body)
::  +ensure-shipped-templates: on writer start, lay down the built-in templates
::  under /template/ if absent (idempotent, never overwrites — a user can edit
::  or replace them). Writes inert code grubs; the tree is covered by an on-load
::  row so it survives reload.
::
++  ensure-shipped-templates
  |=  root=path
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  pages=(list [rel=path kind=@tas body=@t])  site:tpl
  |-  ^-  form:m
  ?~  pages  (pure:m ~)
  =/  prel=path  (weld /site rel.i.pages)
  =/  pdir=path  (weld root (weld /template prel))
  ::  per-page: skip a page that already exists (never overwrite a user edit;
  ::  and a laydown interrupted after some pages completes on the next start),
  ::  else write it.
  ;<  ex=?  bind:m  (peek-exists:io [%& %& pdir %code])
  ?:  ex  $(pages t.pages)
  =/  code=@t  (page-code prel kind.i.pages body.i.pages)
  ;<  ~  bind:m  (ensure-dirs (weld root /template) prel)
  ;<  ~  bind:m  (put-file [%& %& pdir %code] [/lattice %page] code)
  $(pages t.pages)
::  +share-weir: add/remove a grub's road in the public usergroup's peek
::  weir — the same grant ensure-pub-weir uses for /pub. Absent group -> no-op.
::  (same read-modify-write race as ensure-pub-weir, finding #12; self-heals.)
::
++  share-weir
  |=  [road=road:tarball add=?]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  gdir=road:tarball  [%& %| /sys/ames/usergroups/public]
  ;<  ok=?  bind:m  (peek-exists:io gdir)
  ?.  ok  (pure:m ~)
  =/  wroad=road:tarball  [%& %& [/sys/ames/usergroups/public %'how.weir']]
  ;<  cur=weir:nexus  bind:m  (read-weir wroad)
  =/  new=weir:nexus
    ?:  add  cur(peek (~(put in peek.cur) road))
    cur(peek (~(del in peek.cur) road))
  ?:  =(new cur)  (pure:m ~)
  (put-file wroad [/ %weir] new)
::  +heal-share-weirs: on writer start, re-add every shared/clearweb page's
::  data road to the public weir. Makes +share-weir self-healing (a page
::  shared before the public usergroup existed gets its grant on the next
::  writer start once a peer has connected), matching +ensure-pub-weir.
::
++  heal-share-weirs
  |=  root=path
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ::  DEEP peek + recursive walk so NESTED clearweb pages re-heal too (a shallow
  ::  top-level walk would leave a nested public page ungranted after restart).
  ;<  sn=seen:nexus  bind:m  (peek:io [%& %| (weld root /page)] ~)
  ?.  ?=([%& %ball *] sn)  (pure:m ~)
  =/  rels=(list path)
    %+  murn  (collect-tree ball.p.sn ~)
    |=([pax=path page=?] ?:(page `pax ~))
  |-  ^-  form:m
  ?~  rels  (pure:m ~)
  =/  pp=path  (weld (weld root /page) i.rels)
  ;<  mode=share-mode:le  bind:m  (read-share pp)
  ;<  ~  bind:m
    ?:  =(%private mode)  (pure:m ~)
    (share-weir [%& %& pp %data] %.y)
  $(rels t.rels)
::  +read-share: a page's sharing preset grub, %private if absent/malformed.
::
++  read-share
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,share-mode:le)
  ^-  form:m
  ;<  sn=seen:nexus  bind:m  (peek:io [%& %& pdir %share] ~)
  ?.  ?=([%& %file *] sn)  (pure:m %private)
  (pure:m (fall (mole |.(;;(share-mode:le (sang-noun:tarball sang.p.sn)))) %private))
::  +read-show-mode: a page's render mode grub, %text if absent/malformed.
::
++  read-show-mode
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,view-mode:pg)
  ^-  form:m
  ;<  sn=seen:nexus  bind:m  (peek:io [%& %& pdir %show] ~)
  ?.  ?=([%& %file *] sn)  (pure:m %text)
  (pure:m (fall (mole |.(;;(view-mode:pg (sang-noun:tarball sang.p.sn)))) %text))
::  +read-wake: the timer request eval-run recorded (~ = no timer). eval-run
::  writes it rather than returning it so its fiber payload stays ,~ (the loop
::  reads it here). /wake is not on the /ev wire, so writing it is no self-wave.
::
++  read-wake
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,(unit @dr))
  ^-  form:m
  ;<  sn=seen:nexus  bind:m  (peek:io [%& %& pdir %wake] ~)
  ?.  ?=([%& %file *] sn)  (pure:m ~)
  (pure:m (fall (mole |.(;;((unit @dr) (sang-noun:tarball sang.p.sn)))) ~))
::  +read-eval-cmd / +read-eval-deps: tolerant grub reads (absent or
::  malformed -> the zero value; a page never crashes its evaluator).
::
::  +recompute-cap: max RAPID consecutive reruns before the evaluator parks a
::  page (cycle / runaway guard). Only reruns closer together than +rerun-gap
::  count, so a legit page reacting to spaced-out updates never hits it; 32 is
::  far above any real reactive chain and keeps the runaway burst short.
::
++  recompute-cap  ^-(@ud 32)
::  +rerun-gap: reruns landing closer than this are "rapid" (part of a runaway
::  burst) and accumulate; a larger gap is a legit update and resets the count.
::
++  rerun-gap  ^-(@dr ~s1)
::  +poke-cap: max page-to-page pokes one run may emit (flood guard).
::
++  poke-cap  ^-(@ud 16)
::  +poke-budget-max: max depth of a page-to-page poke chain. A user/dep/timer
::  trigger starts a run with this budget; each poke it emits carries budget-1,
::  so any chain — a cycle included — terminates after this many hops,
::  independent of timing (poke round-trips are too slow for the rate cap).
::
++  poke-budget-max  ^-(@ud 8)
++  read-eval-cmd
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,eval-cmd:le)
  ^-  form:m
  ;<  sn=seen:nexus  bind:m  (peek:io [%& %& pdir %cmd] ~)
  ?.  ?=([%& %file *] sn)  (pure:m [0 '' 0])
  (pure:m (fall (mole |.(;;(eval-cmd:le (sang-noun:tarball sang.p.sn)))) [0 '' 0]))
::  +read-eval-seen / +write-eval-seen: the last-PROCESSED command seq, stored
::  as a bare @ud (reusing the eval-data marc — it's a noun grub). /seen is
::  never kept, so writing it wakes no fiber. Absent -> 0.
::
++  read-eval-seen
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  sn=seen:nexus  bind:m  (peek:io [%& %& pdir %seen] ~)
  ?.  ?=([%& %file *] sn)  (pure:m 0)
  (pure:m (fall (mole |.(;;(@ud (sang-noun:tarball sang.p.sn)))) 0))
++  write-eval-seen
  |=  [pdir=path seq=@ud]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (put-file [%& %& pdir %seen] [/lattice %eval-data] seq)
++  read-eval-deps
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,(list path))
  ^-  form:m
  ;<  sn=seen:nexus  bind:m  (peek:io [%& %& pdir %deps] ~)
  ?.  ?=([%& %file *] sn)  (pure:m ~)
  (pure:m (fall (mole |.(;;((list path) (sang-noun:tarball sang.p.sn)))) ~))
::  +view-src: if a dep path is a VIEW dependency on one of our OWN pages
::  (/apps/lattice.lattice_app/page/<name>/view), the source page's dir; else ~.
::  A view-dep resolves to the source page's RENDERED html rather than its raw
::  data (composition, docs/pages.md). Own-tree only by construction — a foreign
::  path never matches, so a peer's markup is never rendered into our origin.
::
++  view-src
  |=  pax=path
  ^-  (unit path)
  ?.  ?=([@ @ %page @ %view ~] pax)  ~
  ?.  =(`path`[i.pax i.t.pax ~] app-base)  ~
  `(weld app-base /page/[i.t.t.t.pax])
::  +arm-eval-deps: keep any dep target not yet armed (one wire, /ev). Deps
::  name FILE paths; the last segment is the grub name. A view-dep instead
::  keeps on the source page's data+show grubs (re-render me when it changes).
::
++  arm-eval-deps
  |=  [armed=(set path) deps=(list path)]
  =/  m  (fiber:fiber:nexus ,(set path))
  ^-  form:m
  ?~  deps  (pure:m armed)
  ?:  (~(has in armed) i.deps)  $(deps t.deps)
  ?:  =(~ i.deps)  $(deps t.deps)
  =/  src=(unit path)  (view-src i.deps)
  ?^  src
    ;<  *  bind:m  (keep:io /ev [%& %& u.src %data] ~)
    ;<  *  bind:m  (keep:io /ev [%& %& u.src %show] ~)
    $(deps t.deps, armed (~(put in armed) i.deps))
  =/  n=@ud  (dec (lent i.deps))
  =/  file-road=road:tarball  [%& %& (scag n i.deps) (snag n i.deps)]
  ;<  fsn=seen:nexus  bind:m  (peek:io file-road ~)
  ?:  ?=([%& %file *] fsn)
    ;<  *  bind:m  (keep:io /ev file-road ~)
    $(deps t.deps, armed (~(put in armed) i.deps))
  ::  not a file: a DIRECTORY dep keeps on the dir road so a child add/remove
  ::  re-runs us. If it is neither (a not-yet-created grub), keep the file road
  ::  so a later write of that grub still fires. Mirrors read-dep-vals.
  ;<  dsn=seen:nexus  bind:m  (peek:io [%& %| i.deps] ~)
  =/  keep-road=road:tarball  ?:(?=([%& %ball *] dsn) [%& %| i.deps] file-road)
  ;<  *  bind:m  (keep:io /ev keep-road ~)
  $(deps t.deps, armed (~(put in armed) i.deps))
::  +read-dep-vals: resolve each dep to its current value. A data dep gives the
::  grub's raw noun (~ if absent); a VIEW dep gives the source page's RENDERED
::  html fragment as a @t (composition — the fragment is welded into this page's
::  own html). render-shown runs on our OWN page data only (view-src is own-tree).
::
++  read-dep-vals
  |=  deps=(list path)
  =/  m  (fiber:fiber:nexus ,(list [path *]))
  ^-  form:m
  ?~  deps  (pure:m ~)
  ?:  =(~ i.deps)  $(deps t.deps)
  =/  src=(unit path)  (view-src i.deps)
  ?^  src
    ;<  dsn=seen:nexus       bind:m  (peek:io [%& %& u.src %data] ~)
    ;<  vmode=view-mode:pg   bind:m  (read-show-mode u.src)
    ;<  rest=(list [path *])  bind:m  (read-dep-vals t.deps)
    =/  frag=@t
      ?.  ?=([%& %file *] dsn)  ''
      (crip (render-shown sang.p.dsn vmode))
    (pure:m [[i.deps frag] rest])
  =/  n=@ud  (dec (lent i.deps))
  ;<  sn=seen:nexus  bind:m  (peek:io [%& %& (scag n i.deps) (snag n i.deps)] ~)
  ?:  ?=([%& %file *] sn)
    ::  a file grub -> its raw noun.
    ;<  rest=(list [path *])  bind:m  (read-dep-vals t.deps)
    (pure:m [[i.deps (sang-noun:tarball sang.p.sn)] rest])
  ::  not a file -> a DIRECTORY dep resolves to its tree listing (a
  ::  (list [pax=path page=?]) of pages+folders under it, paths relative to the
  ::  dir), so a page can enumerate a structured subtree. ~ if it is neither.
  ;<  dn=seen:nexus  bind:m  (peek:io [%& %| i.deps] ~)
  ;<  rest=(list [path *])  bind:m  (read-dep-vals t.deps)
  =/  val=*  ?.(?=([%& %ball *] dn) ~ (collect-tree ball.p.dn ~))
  (pure:m [[i.deps val] rest])
::  +eval-run: one run of a compiled page — build the env vase (typed via
::  slop, so the gate's declared sample nest-checks), slam inside mule,
::  land the product. dat=~ means no change; a changed dep list is
::  persisted (the deps grub is on the /ev wire, so the loop re-arms).
::
++  eval-run
  |=  [pdir=path bild=vase cmd=(unit @t) deps=(list path) bud=@ud]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  now=@da  bind:m  bowl-now
  ;<  dsn=seen:nexus  bind:m  (peek:io [%& %& pdir %data] ~)
  =/  dat=(unit *)
    ?.(?=([%& %file *] dsn) ~ `(sang-noun:tarball sang.p.dsn))
  ;<  dvs=(list [path *])  bind:m  (read-dep-vals deps)
  =/  env=vase
    ;:  slop
      !>(`(unit @t)`cmd)
      !>(`(unit *)`dat)
      !>(`@da`now)
      !>(`(list [path *])`dvs)
    ==
  =/  res=(each result:pg tang)
    %-  mule  |.
    ;;(result:pg q:(slam bild env))
  ?:  ?=(%| -.res)
    ;<  ~  bind:m  (put-file [%& %& pdir %err] [/lattice %page] (render-tang 'run failed:' p.res))
    ::  a broken run stops any timer.
    (put-file [%& %& pdir %wake] [/lattice %eval-data] `(unit @dr)`~)
  ;<  ~  bind:m  (put-file [%& %& pdir %err] [/lattice %page] '')
  ;<  ~  bind:m
    ?~  dat.p.res  (pure:m ~)
    ;<  ~  bind:m  (put-file [%& %& pdir %data] [/lattice %eval-data] u.dat.p.res)
    ::  record the render mode next to the data (read by the page view).
    ;<  ~  bind:m  (put-file [%& %& pdir %show] [/lattice %eval-data] show.p.res)
    ::  a shared page's data must stay gained across recomputes — gain is
    ::  per-revision (like apply-pub re-gaining on every save).
    ;<  mode=share-mode:le  bind:m  (read-share pdir)
    ?:  =(%private mode)  (pure:m ~)
    (gain:io [%& %& pdir %data] %.y)
  ::  send this run's page-to-page pokes with the run's remaining budget
  ::  (capped per run so one page can't flood the writer).
  ;<  ~  bind:m  (emit-pokes bud (scag poke-cap pokes.p.res))
  ;<  ~  bind:m
    ?:  =(dep.p.res deps)  (pure:m ~)
    (put-file [%& %& pdir %deps] [/lattice %eval-deps] dep.p.res)
  ::  record the timer request for the loop to arm, clamped so it can't rerun
  ::  faster than the rate window (~ = no timer). The loop reads /wake after
  ::  this run; /wake is not on the /ev wire, so writing it is not a self-wave.
  =/  wake=(unit @dr)  ?~(wake.p.res ~ `(max u.wake.p.res rerun-gap))
  (put-file [%& %& pdir %wake] [/lattice %eval-data] wake)
::  +emit-pokes: deliver each [page-name command] to the writer (which bumps
::  that page's cmd grub), carrying a DECREMENTED budget so a poke chain (or
::  cycle) terminates at a fixed depth. bud=0 drops them — the chain ends. A
::  poke to a nonexistent page is a safe no-op (apply-eval %cmd guards on the
::  code grub existing).
::
++  emit-pokes
  |=  [bud=@ud pokes=(list [name=@ta txt=@t])]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?:  =(0 bud)  (pure:m ~)
  ?~  pokes  (pure:m ~)
  ;<  ~  bind:m  (poke-eval [%cmd ~[name.i.pokes] txt.i.pokes (dec bud)])
  $(pokes t.pokes)
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
::  ── urb:// address grammar v2 (docs/urls.md) ────────────────────────────────
::  The first path component selects a fixed, code-versioned MOUNT (p/n/k/t); a
::  multi-char first component is the frozen legacy pub form. Resolution is a
::  PURE function of the url text — no lookups, no viewer context, no existence
::  probes — so the same urb:// names the same referent from any ship, any year
::  (referential transparency). Aliasing exists (/t/<abs> can name what /p/<name>
::  names) but the canonicalizer +en-urb is pure too, and every index keys on it.
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
::  +explore: GET /x/<ship>/<path...> — the server-rendered tree explorer
::  (docs/platform.md, build step 1). Directories render as listings with
::  relative child links; trailing slash is forced on directory urls (hawk
::  convention — relative hrefs resolve against the listing). Files render
::  mark-aware; ?data serves the raw body with a mark-derived content-type.
::  Own tree peeks locally; a foreign ship's gained tree via remote peek.
::  Owner-only like every route (clearweb projection is build step 4).
::  No trailing slash -> try file first (the common case for leaf urls), then
::  dir + redirect; trailing slash -> dir first. Remote: an unreachable ship is
::  504 on the FIRST wait (a ~ result means no answer, not wrong-kind), so the
::  fallback attempt only runs when the ship answered with the wrong node kind.
::
++  explore
  ::  `our` is threaded from handle-request — bowl-our is a full /sys/bowl round
  ::  trip (~0.2s) and the caller already paid it, so re-fetching it here doubled
  ::  the cost of every explorer/page request.
  |=  [eyre-id=@ta our=@p rest=path args=(map @t @t) raw-url=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ::  a trailing '/' parses as a trailing EMPTY knot (smeg matches ''), which
  ::  would send every slashed dir url down the peek path as a child literally
  ::  named '' -> 404 (caught by review). Trim trailing empties up front —
  ::  `slashed` below still records that the url named a directory.
  =/  rest=path
    |-  ^-  path
    ?:  &(?=(^ rest) =('' (rear `path`rest)))
      $(rest (snip `path`rest))
    rest
  ?~  rest
    (send-redirect eyre-id :(weld "/apps/lattice/x/" (scow %p our) "/"))
  =/  shp=(unit @p)  (slaw %p i.rest)
  ?~  shp  (send-err eyre-id 400 'bad ship')
  =/  pax=path  t.rest
  =/  base=tape  (url-path-part raw-url)
  =/  slashed=?  &(?=(^ base) =('/' (rear base)))
  =/  want-raw=?  (~(has by args) 'data')
  ::  the canonical urb:// address for this node — shown in the chrome bar so any
  ::  view is copy-shareable (the browser url stays the /x projection).
  =/  canon=tape  (trip (en-urb u.shp pax))
  =/  dir-road=road:tarball  [%& %| pax]
  ?~  pax
    ::  ship root: always a directory
    ?.  slashed  (send-redirect eyre-id (weld base "/"))
    ?:  =(u.shp our)
      ;<  dn=seen:nexus  bind:m  (peek-shallow:io dir-road ~)
      ?.  ?=([%& %ball *] dn)  (send-err eyre-id 404 'not found')
      (send-view eyre-id (render-page canon "" (explore-dir-html u.shp pax ball.p.dn)))
    ;<  md=(unit seen:nexus)  bind:m  (peek-remote-shallow-wait dir-road u.shp)
    ?~  md  (send-err eyre-id 504 'unreachable or denied')
    ?.  ?=([%& %ball *] u.md)  (send-err eyre-id 404 'not found')
    (send-view eyre-id (render-page canon "" (explore-dir-html u.shp pax ball.p.u.md)))
  =/  file-road=road:tarball  [%& %& (snip `path`pax) (rear pax)]
  ?:  =(u.shp our)
    ?:  slashed
      ;<  dn=seen:nexus  bind:m  (peek-shallow:io dir-road ~)
      ?:  ?=([%& %ball *] dn)
        ::  our own /page/<name>/ dir -> the live page view (data + command
        ::  form + SSE), unless ?raw asks for the plain grub listing. A page has
        ::  a /code grub; a plain folder does not, so a folder just browses.
        =/  pn=(unit @t)  (page-dir-name pax)
        =/  fils=(map @ta [=sang:tarball gain=? bang=(unit tang)])
          ?~(fil.ball.p.dn ~ contents.u.fil.ball.p.dn)
        ?:  |(?=(~ pn) ?!((~(has by fils) %code)) (~(has by args) 'raw'))
          (send-view eyre-id (render-page canon "" (explore-dir-html u.shp pax ball.p.dn)))
        (render-page-view eyre-id u.shp pax u.pn ball.p.dn (~(has by args) 'embed'))
      ;<  fn=seen:nexus  bind:m  (peek:io file-road ~)
      ?.  ?=([%& %file *] fn)  (send-err eyre-id 404 'not found')
      ?:  want-raw  (send-raw eyre-id sang.p.fn %.y)
      (send-view eyre-id (render-page canon "" (explore-file-html u.shp pax sang.p.fn %.y)))
    ;<  fn=seen:nexus  bind:m  (peek:io file-road ~)
    ?:  ?=([%& %file *] fn)
      ?:  want-raw  (send-raw eyre-id sang.p.fn %.y)
      (send-view eyre-id (render-page canon "" (explore-file-html u.shp pax sang.p.fn %.y)))
    ;<  dn=seen:nexus  bind:m  (peek-shallow:io dir-road ~)
    ?.  ?=([%& %ball *] dn)  (send-err eyre-id 404 'not found')
    (send-redirect eyre-id (weld base "/"))
  ?:  slashed
    ;<  md=(unit seen:nexus)  bind:m  (peek-remote-shallow-wait dir-road u.shp)
    ?~  md  (send-err eyre-id 504 'unreachable or denied')
    ?:  ?=([%& %ball *] u.md)
      (send-view eyre-id (render-page canon "" (explore-dir-html u.shp pax ball.p.u.md)))
    ;<  mf=(unit seen:nexus)  bind:m  (peek-remote-wait file-road u.shp)
    ?~  mf  (send-err eyre-id 504 'unreachable or denied')
    ?.  ?=([%& %file *] u.mf)  (send-err eyre-id 404 'not found')
    ?:  want-raw  (send-raw eyre-id sang.p.u.mf %.n)
    (send-view eyre-id (render-page canon "" (explore-file-html u.shp pax sang.p.u.mf %.n)))
  ;<  mf=(unit seen:nexus)  bind:m  (peek-remote-wait file-road u.shp)
  ?~  mf  (send-err eyre-id 504 'unreachable or denied')
  ?:  ?=([%& %file *] u.mf)
    ?:  want-raw  (send-raw eyre-id sang.p.u.mf %.n)
    (send-view eyre-id (render-page canon "" (explore-file-html u.shp pax sang.p.u.mf %.n)))
  ;<  md=(unit seen:nexus)  bind:m  (peek-remote-shallow-wait dir-road u.shp)
  ?~  md  (send-err eyre-id 504 'unreachable or denied')
  ?.  ?=([%& %ball *] u.md)  (send-err eyre-id 404 'not found')
  (send-redirect eyre-id (weld base "/"))
::  +url-path-part: the path portion of a raw request url (strip ?query).
::
++  url-path-part
  |=  raw=@t
  ^-  tape
  =/  t=tape  (trip raw)
  =/  q=(unit @ud)  (find "?" t)
  ?~(q t (scag u.q t))
::  +send-redirect: a 301 to `to` (used to force trailing slashes on dirs).
::
++  send-redirect
  |=  [eyre-id=@ta to=tape]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  %+  send-simple:srv  eyre-id
  [[301 ['location' (crip to)]~] ~]
::  +send-see-other: a 303 (POST -> GET redirect, for form command submits).
::
++  send-see-other
  |=  [eyre-id=@ta to=tape]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  %+  send-simple:srv  eyre-id
  [[303 ['location' (crip to)]~] ~]
::  +page-dir-name: is `pax` under our own /page/ tree? -> the slash-joined
::  name (e.g. 'projects/plan'). app-base ++ /page ++ >=1 seg, at any depth;
::  the caller checks for a /code grub to tell a page from a plain folder.
::
++  page-dir-name
  |=  pax=path
  ^-  (unit @t)
  ?.  ?=([@ @ %page @ *] pax)  ~
  ?.  =(`path`[i.pax i.t.pax ~] app-base)  ~
  `(crip (pax-str `path`t.t.t.pax))
::  +render-page-view: the live view of one of our programmable pages —
::  rendered data + any error + a command form, with keep-SSE on the data
::  grub so a command from ANY browser reloads every open view (step 3).
::
++  render-page-view
  ::  `b` is the page dir's ball, ALREADY peeked by the caller (explore) to detect
  ::  the page dir — reuse it instead of peeking the same dir again. The ball
  ::  carries every grub's contents, so data+err+share+show all come from it with
  ::  zero further round-trips.
  ::  embed=%.y (?embed): the bare rendered data + SSE, no chrome/crumbs/controls
  ::  — for the editor's live-preview iframe. Otherwise the full standalone view.
  |=  [eyre-id=@ta shp=@p pax=path name=@t b=ball:tarball embed=?]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  fils=(map @ta [=sang:tarball gain=? bang=(unit tang)])
    ?~(fil.b ~ contents.u.fil.b)
  =/  grub  |=(nom=@ta ^-((unit sang:tarball) =/(v (~(get by fils) nom) ?~(v ~ `sang.u.v))))
  =/  mode=share-mode:le
    =/  sh=(unit sang:tarball)  (grub %share)
    ?~  sh  %private
    (fall (mole |.(;;(share-mode:le (sang-noun:tarball u.sh)))) %private)
  =/  vmode=view-mode:pg
    =/  sw=(unit sang:tarball)  (grub %show)
    ?~  sw  %text
    (fall (mole |.(;;(view-mode:pg (sang-noun:tarball u.sw)))) %text)
  =/  err=@t
    =/  ce=(unit sang:tarball)  (grub %err)
    ?~  ce  ''
    (fall (mole |.(;;(@t (sang-noun:tarball u.ce)))) '')
  =/  data-html=tape
    =/  cd=(unit sang:tarball)  (grub %data)
    ?~  cd  "<p>no data yet</p>"
    (render-shown u.cd vmode)
  ::  own lean SSE (no ?blot=/txt): a page dir's noun grubs render huge under
  ::  /txt on the initial snapshot, and the reload script reads only event
  ::  names, never the payload — so keep="" to render-page and append a
  ::  blot-free stream here.
  =/  keep=tape  (keep-url :(weld "page/" (trip name) "/data"))
  ?:  embed
    ::  bare preview: just the rendered data (+ any error) and the live stream.
    =/  errh=tape  ?:(=('' err) "" :(weld "<pre class=\"err\">" (esc (trip err)) "</pre>"))
    (send-html eyre-id (render-bare :(weld errh "<section class=\"data\">" data-html "</section>" (page-sse-script keep))))
  =/  inner=tape
    (weld (page-view-html shp pax name err data-html mode) (page-sse-script keep))
  (send-html eyre-id (render-page (trip (en-urb shp pax)) "" inner))
::  +render-bare: a minimal HTML doc (shared reader CSS, no address-bar chrome) —
::  for the editor preview iframe, which supplies its own layout.
::
++  render-bare
  |=  inner=tape
  ^-  @t
  %-  crip
  ;:  weld
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
    "<style>"  web-css  (trip 'body{margin:0;padding:14px}')  "</style></head><body>"
    inner
    ::  a srcdoc preview has no URL of its own, so a bare #anchor (footnote) link
    ::  would resolve against the PARENT (the editor) and load it into the frame.
    ::  Intercept in-page # links and scroll within the frame instead.
    (trip '<script>document.addEventListener("click",function(e){var a=e.target.closest("a");if(a){var h=a.getAttribute("href");if(h&&h.charAt(0)==="#"){e.preventDefault();var el=document.getElementById(h.slice(1));if(el)el.scrollIntoView()}}})</script>')
    "</body></html>"
  ==
::  +render-clearweb: the standalone public shell for a %clearweb page — a bare
::  html document, NO lattice chrome. `head` is raw <head> content (the theme
::  <link> or a <style>), placed in the HEAD so it is render-blocking: the page
::  paints WITH its background and never flashes white on navigation. A
::  color-scheme meta makes even the pre-CSS canvas follow the OS theme. The
::  public mirror of +render-page (the owner's authenticated explorer chrome).
::
++  render-clearweb
  |=  [title=tape head=tape inner=tape]
  ^-  @t
  %-  crip
  ;:  weld
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
    "<meta name=\"color-scheme\" content=\"light dark\">"
    "<title>"  (esc title)  "</title>"
    head
    "</head><body>"  inner  "</body></html>"
  ==
::  +serve-asset: serve a file's raw /data grub with a Content-Type from its
::  render mode (js/css/html/md/gmi), so an html file can import it by URL.
::
++  serve-asset
  |=  [eyre-id=@ta pax=path]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?.  (levy pax |=(seg=@ta ((sane %ta) seg)))  (send-err eyre-id 404 'not found')
  =/  pdir=path  (weld app-base (weld /page pax))
  ;<  dsn=seen:nexus  bind:m  (peek:io [%& %& pdir %data] ~)
  ?.  ?=([%& %file *] dsn)  (send-err eyre-id 404 'not found')
  ;<  vmode=view-mode:pg  bind:m  (read-show-mode pdir)
  =/  res=(each @t tang)  (mule |.(;;(@t (sang-noun:tarball sang.p.dsn))))
  ?:  ?=(%| -.res)  (send-err eyre-id 415 'not servable')
  (send-typed eyre-id (mime-of vmode) 'no-cache' p.res)
::  +find-theme: the nearest folder AT or ABOVE pax's parent holding a clearweb
::  css `theme` page — so a rendered clearweb page auto-inherits a site theme
::  (nearest wins; a subfolder theme overrides). ~ if none up to the root.
::  ponytail: a few peeks per rendered request; the theme link is then browser-
::  cached across the site. Add a cache here only if it ever measures hot.
::
++  find-theme
  |=  pax=path
  =/  m  (fiber:fiber:nexus ,(unit path))
  ^-  form:m
  =/  anc=path  (snip `path`pax)
  |-  ^-  form:m
  =/  tdir=path  (weld app-base (weld /page (weld anc /theme)))
  ;<  mode=share-mode:le  bind:m  (read-share tdir)
  ;<  show=view-mode:pg   bind:m  (read-show-mode tdir)
  ?:  &(?=(%clearweb mode) ?=(%css show))  (pure:m `anc)
  ?~  anc  (pure:m ~)
  $(anc (snip `path`anc))
::  +serve-clearweb: the public read of a %clearweb page. Read-only, data grub
::  only — a non-clearweb (or absent) page is a flat 404 so private siblings
::  never leak existence. No SSE (an anon keep would 403 anyway).
::
++  serve-clearweb
  |=  [eyre-id=@ta pax=path]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ::  same per-segment gate as name-pax/serve-asset: non-empty %ta knots only,
  ::  so a trailing '/' ('' segment) and '.'/'..' 404 — no traversal, no folder
  ::  listing. (The route's [%c ^] already rejects a bare /c/.) The per-leaf
  ::  %clearweb check below is the only public/private gate.
  ?.  (levy pax |=(seg=@ta &(!=(%$ seg) ((sane %ta) seg))))
    (send-err eyre-id 404 'not found')
  =/  pdir=path  (weld app-base (weld /page pax))
  ;<  mode=share-mode:le  bind:m  (read-share pdir)
  ?.  ?=(%clearweb mode)  (send-err eyre-id 404 'not found')
  ;<  dsn=seen:nexus  bind:m  (peek:io [%& %& pdir %data] ~)
  ;<  vmode=view-mode:pg  bind:m  (read-show-mode pdir)
  ?.  ?=([%& %file *] dsn)
    (send-html eyre-id (render-clearweb (pax-str pax) "" "<p>no data</p>"))
  ::  css/js serve RAW (a public page links them as a stylesheet/script, so they
  ::  must NOT go through render-shown's <pre><code> wrap); everything else
  ::  renders per its view-mode into a bare, chrome-less standalone document.
  ?:  ?=(?(%css %js) vmode)
    =/  res=(each @t tang)  (mule |.(;;(@t (sang-noun:tarball sang.p.dsn))))
    ?:  ?=(%| -.res)  (send-err eyre-id 415 'not servable')
    (send-typed eyre-id (mime-of vmode) 'no-cache' p.res)
  =/  inner=tape  (render-shown sang.p.dsn vmode)
  ::  Every rendered/html page auto-wears the nearest `theme` css up the folder
  ::  tree, LINKED IN THE HEAD (render-blocking -> no white flash on nav, browser-
  ::  cached across the site). A rendered page (md/gmi/text/noun) also gets a
  ::  "page" wrapper + a home link; %html owns its own body layout. With no theme,
  ::  %html gets nothing (it owns its styling) and md/gmi/text get the reader css.
  ;<  tf=(unit path)  bind:m  (find-theme pax)
  =/  head=tape
    ?^  tf  :(weld "<link rel=\"stylesheet\" href=\"/apps/lattice/c" (spud (weld u.tf /theme)) "\">")
    ?:(?=(%html vmode) "" :(weld "<style>" web-css "</style>"))
  =/  body=tape
    ?:  ?=(%html vmode)  inner
    ?~  tf  inner
    ;:  weld
      "<main class=\"page\"><p class=\"home\"><a href=\"/apps/lattice/c"
      (spud (weld u.tf /index))  "\">&larr; home</a></p>"
      inner
      "</main>"
    ==
  (send-html eyre-id (render-clearweb (pax-str pax) head body))
::  +page-data-html: render a page's data grub. A cord shows as text; any
::  other noun as its literal (a page's data mark is a bare noun).
::
++  page-data-html
  |=  =sang:tarball
  ^-  tape
  =/  nn=*  (sang-noun:tarball sang)
  =/  cord-res=(each @t tang)  (mule |.(;;(@t nn)))
  ?:  ?=(%& -.cord-res)
    :(weld "<pre>" (esc (trip p.cord-res)) "</pre>")
  :(weld "<pre>" (esc "{<nn>}") "</pre>")
::  +render-shown: render an OWN page's data grub per its render mode. %html
::  inlines raw — safe because this is only ever called on OUR OWN page data
::  (render-page-view / serve-clearweb); a peer's page data is escaped by the
::  explorer, never routed here. A non-cord value falls back to a noun literal.
::
++  render-shown
  |=  [=sang:tarball mode=view-mode:pg]
  ^-  tape
  =/  nn=*  (sang-noun:tarball sang)
  =/  cr=(each @t tang)  (mule |.(;;(@t nn)))
  ?:  ?=(%| -.cr)  (page-data-html sang)
  ?-  mode
    %text  :(weld "<pre>" (esc (trip p.cr)) "</pre>")
    %html  (trip p.cr)
    %gmi   (render-gmi p.cr)
    %md    (render-md:gfm p.cr)
    %js    :(weld "<pre><code class=\"language-javascript\">" (esc (trip p.cr)) "</code></pre>")
    %css   :(weld "<pre><code class=\"language-css\">" (esc (trip p.cr)) "</code></pre>")
    %noun  (page-data-html sang)
  ==
::  +page-view-html: crumbs, error, data, and a command form (POSTs page-cmd
::  with web=1 so the route 303s back here). ?raw links to the grub listing.
::
++  page-view-html
  |=  [shp=@p pax=path name=@t err=@t data-html=tape mode=share-mode:le]
  ^-  tape
  =/  post=tape  :(weld "/apps/lattice/page-cmd?name=" (trip name) "&web=1")
  ;:  weld
    (explore-crumbs shp pax)
    ?:  =('' err)  ""
    :(weld "<pre class=\"err\">" (esc (trip err)) "</pre>")
    "<section class=\"data\">"
    data-html
    "</section>"
    "<form class=\"cmd\" method=\"post\" action=\""
    (esc post)
    "\"><input name=\"cmd\" placeholder=\"command\" autocomplete=\"off\">"
    "<button type=\"submit\">send</button></form>"
    (share-controls-html name mode)
    "<p><a href=\"/apps/lattice/edit?name="  (trip name)
    "\">edit code</a> &middot; <a href=\"?raw\">raw grubs</a></p>"
  ==
::  +share-controls-html: the current sharing preset + one button per preset
::  (each a tiny form POSTing page-share). A clearweb page also shows its
::  public URL.
::
++  share-controls-html
  |=  [name=@t mode=share-mode:le]
  ^-  tape
  =/  btn
    |=  [m=@tas label=tape]
    ^-  tape
    =/  cur=?  =(m mode)
    ;:  weld
      "<form class=\"share\" method=\"post\" action=\"/apps/lattice/page-share?name="
      (trip name)  "&mode="  (trip m)  "&web=1\"><button"
      ?:(cur " disabled" "")  ">"  label  "</button></form>"
    ==
  ;:  weld
    "<div class=\"sharing\"><span>sharing: "  (trip mode)  "</span> "
    (btn %private "private")
    (btn %shared "shared")
    (btn %clearweb "clearweb")
    ?.  ?=(%clearweb mode)  ""
    :(weld "<p>public: <a href=\"/apps/lattice/c/" (trip name) "\">/apps/lattice/c/" (trip name) "</a></p>")
    "</div>"
  ==
::  +page-sse-script: like +sse-script but WITHOUT ?blot=/txt — the page dir's
::  noun grubs are megabytes under /txt on connect, and this only needs the
::  event names to reload. Same reload-on-any-non-old-event loop otherwise.
::
++  page-sse-script
  |=  keep=tape
  ^-  tape
  ?~  keep  ""
  ;:  weld
    (trip '<script>(function(){var K="')
    keep
    %-  trip
    '";async function c(){try{var r=await fetch(K,{headers:{Accept:"text/event-stream"}});var R=r.body.getReader();var d=new TextDecoder();var b="";while(true){var x=await R.read();if(x.done)break;b+=d.decode(x.value,{stream:true});var ps=b.split("\\n\\n");b=ps.pop();for(var i=0;i<ps.length;i++){if(!ps[i].trim())continue;var ev="";var ls=ps[i].split("\\n");for(var j=0;j<ls.length;j++){if(ls[j].indexOf("event: ")===0)ev=ls[j].slice(7)}if(!ev)continue;if(ev.slice(0,3)==="old")continue;location.reload();return}}}catch(x){}setTimeout(c,3000)}c()})();</script>'
  ==
::  +explore-crumbs: breadcrumb nav — absolute hrefs from the ship root down,
::  each with a trailing slash. The leaf is linked too (self-link; harmless).
::
++  explore-crumbs
  |=  [shp=@p pax=path]
  ^-  tape
  =/  base=tape  (weld "/apps/lattice/x/" (scow %p shp))
  =/  out=tape
    ;:  weld
      "<nav class=\"crumbs\"><a href=\""
      base
      "/\">"
      (esc (scow %p shp))
      "</a>"
    ==
  =/  cur=tape  base
  |-  ^-  tape
  ?~  pax  (weld out "</nav>")
  =.  cur  :(weld cur "/" (trip i.pax))
  ::  esc the href too — remote segment names are attacker-chosen text.
  =.  out  :(weld out " / <a href=\"" (esc cur) "/\">" (esc (trip i.pax)) "</a>")
  $(pax t.pax)
::  +explore-dir-html: one directory level as HTML — subdirs first, then files
::  with their marks. Child hrefs are RELATIVE (dirs get a trailing slash), so
::  they resolve against the forced-trailing-slash listing url. Capped at
::  browse-fan-cap like browse-json, for the same unbounded-response reason.
::
++  explore-dir-html
  |=  [shp=@p pax=path b=ball:tarball]
  ^-  tape
  =/  dirs=(list @ta)  (sort (turn ~(tap by dir.b) head) aor)
  =/  files=(list [nom=@ta mk=@tas])
    %+  sort
      ?~  fil.b  ~
      %+  turn  ~(tap by contents.u.fil.b)
      |=  [nom=@ta con=[=sang:tarball gain=? bang=(unit tang)]]
      [nom name.p.sang.con]
    |=([a=[nom=@ta mk=@tas] b=[nom=@ta mk=@tas]] (aor nom.a nom.b))
  =/  truncated=?
    |((gth (lent dirs) browse-fan-cap) (gth (lent files) browse-fan-cap))
  ;:  weld
    (explore-crumbs shp pax)
    "<ul class=\"tree\">"
    ::  ^- tape on each zing: welding zing's uncast recursive product
    ::  fuse-loops the compiler (caught by review; see +esc for the idiom).
    ^-  tape
    %-  zing
    %+  turn  (scag browse-fan-cap dirs)
    |=  n=@ta
    =/  nm=tape  (esc (trip n))
    :(weld "<li><a href=\"" nm "/\">" nm "/</a></li>")
    ^-  tape
    %-  zing
    %+  turn  (scag browse-fan-cap files)
    |=  [nom=@ta mk=@tas]
    =/  nm=tape  (esc (trip nom))
    ;:  weld
      "<li><a href=\""  nm  "\">"  nm  "</a>"
      " <span class=\"mark\">"  (esc (trip mk))  "</span></li>"
    ==
    "</ul>"
    ?.(truncated "" "<p class=\"err\">listing truncated</p>")
  ==
::  +explore-file-html: one file, mark-aware. Cord bodies: gemtext renders,
::  html inlines as-is (hawk's model — data is its own ui; this surface is
::  owner-only until the clearweb step), everything else is an escaped <pre>.
::  Non-cord bodies: octs get a byte count + raw link; opaque nouns just the
::  mark. ?data is always offered for cord/octs bodies.
::
++  explore-file-html
  |=  [shp=@p pax=path =sang:tarball local=?]
  ^-  tape
  =/  mk=@tas  name.p.sang
  =/  nn=*  (sang-noun:tarball sang)
  =/  cord-res=(each @t tang)  (mule |.(;;(@t nn)))
  =/  body=tape
    ?:  ?=(%& -.cord-res)
      ::  cap the rendered preview: esc+weld would double a multi-MB body into
      ::  one response. ponytail: peek already loaded it; this bounds the render
      ::  doubling, and ?data still serves the full bytes.
      ?:  (gth (met 3 p.cord-res) (bex 20))
        "<p>file too large to preview &mdash; <a href=\"?data\">view raw</a></p>"
      ::  %page is the lattice pub blot ([/lattice %page]) — gemtext bodies.
      ::  %html inlines RAW — but only for our OWN grubs (local): a foreign
      ::  ship's %html body is attacker-controlled, so escape it (stored XSS
      ::  in the owner's browser otherwise; caught by review).
      ?+  mk  :(weld "<pre>" (esc (trip p.cord-res)) "</pre>")
        ?(%gmi %gemtext %page)  (render-gmi p.cord-res)
        %html
      ?:  local  (trip p.cord-res)
      :(weld "<pre>" (esc (trip p.cord-res)) "</pre>")
      ==
    =/  octs-res=(each [p=@ud q=@] tang)  (mule |.(;;([p=@ud q=@] nn)))
    ?:  ?=(%& -.octs-res)
      :(weld "<p>binary grub (" (a-co:co p.p.octs-res) " bytes)</p>")
    "<p>opaque noun grub (not raw-servable)</p>"
  ;:  weld
    (explore-crumbs shp pax)
    "<div class=\"meta\">mark "  (esc (trip mk))
    " &middot; <a href=\"?data\">raw</a></div>"
    body
  ==
::  +send-raw: ?data — the file body verbatim with a mark-derived content-type.
::  Cords ship as their bytes; octs ship as-is; anything else is 415.
::
++  send-raw
  |=  [eyre-id=@ta =sang:tarball local=?]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  mk=@tas  name.p.sang
  =/  nn=*  (sang-noun:tarball sang)
  ::  a FOREIGN grub's bytes are attacker-controlled: serving them with an
  ::  active content-type (html/svg/js) executes the peer's markup in our own
  ::  origin (residual XSS the round-1 inline-render fix missed). Only our OWN
  ::  grubs get a mark-derived type; anything foreign is forced to an inert
  ::  download (octet-stream + attachment + nosniff).
  =/  heads=(list [@t @t])
    ?:  local  ['content-type' (mark-mime mk)]~
    :~  ['content-type' 'application/octet-stream']
        ['content-disposition' 'attachment']
        ['x-content-type-options' 'nosniff']
    ==
  =/  cord-res=(each @t tang)  (mule |.(;;(@t nn)))
  ?:  ?=(%& -.cord-res)
    (send-simple:srv eyre-id [[200 heads] `(as-octs:mimes:html p.cord-res)])
  =/  octs-res=(each [p=@ud q=@] tang)  (mule |.(;;([p=@ud q=@] nn)))
  ?:  ?=(%& -.octs-res)
    ::  p is remote-attested (a boom carries the peer's raw noun) — a hostile
    ::  length would become our content-length. Cap it: real octs may pad p
    ::  past (met 3 q) for trailing zeros, but not by 16MiB (caught by review).
    ?:  (gth p.p.octs-res (bex 24))
      (send-err eyre-id 413 'too large')
    (send-simple:srv eyre-id [[200 heads] `p.octs-res])
  (send-err eyre-id 415 'not raw-servable')
::  +mark-mime: content-type for ?data by mark leaf. Unknown marks default to
::  text/plain — cords are overwhelmingly text, and octs of unknown mark are
::  rare enough not to earn octet-stream plumbing yet.
::
++  mark-mime
  |=  mk=@tas
  ^-  @t
  ?+  mk  'text/plain'
    %json          'application/json'
    ?(%html %htm)  'text/html'
    %gmi           'text/gemini'
    ?(%md %markdown)  'text/markdown'
    %css           'text/css'
    %js            'text/javascript'
    %png           'image/png'
    ?(%jpg %jpeg)  'image/jpeg'
    %gif           'image/gif'
    %webp          'image/webp'
    %svg           'image/svg+xml'
  ==
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
::  +send-view: like +send-html but with a short private cache, for READ-ONLY
::  navigable surfaces (home, tree explorer). A repeat visit inside the window is
::  served from the browser cache instantly (like the back button's bfcache) —
::  the ~0.7s grubbery render is skipped. Safe here because these surfaces have
::  no command/save flow whose result must appear immediately, and any live SSE
::  reload revalidates (browsers bypass max-age on reload), so real changes still
::  land fresh. NOT used for page views (command form) or the editor (save flow).
::
++  send-view
  |=  [eyre-id=@ta htm=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  %+  send-simple:srv  eyre-id
  :-  [200 ~[['content-type' 'text/html'] ['cache-control' 'private, max-age=5']]]
  `(as-octs:mimes:html htm)
::  ── PWA (installable app) ──────────────────────────────────────────────────
::  Content-Type is an explicit header cord here (not mark-derived), so a
::  manifest and a service worker are served with correct MIME by hand. All PWA
::  routes sit AFTER the owner gate, so they're owner-only — the browser fetches
::  them same-origin with the session cookie, which is the right posture for a
::  private app (install is offered only inside an authed session).
::
++  send-typed
  |=  [eyre-id=@ta ct=@t cc=@t body=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  %+  send-simple:srv  eyre-id
  :-  [200 ~[['content-type' ct] ['cache-control' cc]]]
  `(as-octs:mimes:html body)
::  the service worker: extra Service-Worker-Allowed so its scope can be the
::  whole /apps/lattice prefix (it is served from .../sw.js, default scope
::  .../), and no-cache so an updated worker propagates.
::
++  send-sw
  |=  [eyre-id=@ta body=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  %+  send-simple:srv  eyre-id
  :_  `(as-octs:mimes:html body)
  :-  200
  :~  ['content-type' 'text/javascript']
      ['cache-control' 'no-cache']
      ['service-worker-allowed' '/apps/lattice']
  ==
::  a PNG from an embedded base64 constant (iOS apple-touch-icon must be a real
::  raster; it ignores SVG + the manifest icons array).
::
++  send-png
  |=  [eyre-id=@ta b64=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  %+  send-simple:srv  eyre-id
  :_  (de:base64:mimes:html b64)
  [200 ~[['content-type' 'image/png'] ['cache-control' 'public, max-age=604800']]]
::  scope + start_url both /apps/lattice (no trailing-slash mismatch). One SVG
::  icon covers Android/desktop install; iOS uses the apple-touch-icon PNG.
::
++  manifest-json
  ^-  @t
  '{"id":"/apps/lattice","name":"Lattice","short_name":"Lattice","description":"Programmable pages and markdown notes on Urbit.","start_url":"/apps/lattice","scope":"/apps/lattice","display":"standalone","theme_color":"#1a6ed8","background_color":"#fafafa","icons":[{"src":"/apps/lattice/icon.svg","sizes":"any","type":"image/svg+xml","purpose":"any"},{"src":"/apps/lattice/icon.svg","sizes":"any","type":"image/svg+xml","purpose":"maskable"}]}'
++  icon-svg
  ^-  @t
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#1a6ed8"/><g stroke="#ffffff" stroke-width="14" stroke-linecap="round" fill="#ffffff"><line x1="140" y1="140" x2="372" y2="140"/><line x1="140" y1="256" x2="372" y2="256"/><line x1="140" y1="372" x2="372" y2="372"/><line x1="140" y1="140" x2="140" y2="372"/><line x1="256" y1="140" x2="256" y2="372"/><line x1="372" y1="140" x2="372" y2="372"/><line x1="140" y1="140" x2="372" y2="372"/><line x1="372" y1="140" x2="140" y2="372"/><circle cx="140" cy="140" r="26"/><circle cx="256" cy="140" r="26"/><circle cx="372" cy="140" r="26"/><circle cx="140" cy="256" r="26"/><circle cx="256" cy="256" r="30"/><circle cx="372" cy="256" r="26"/><circle cx="140" cy="372" r="26"/><circle cx="256" cy="372" r="26"/><circle cx="372" cy="372" r="26"/></g></svg>'
::  minimal service worker: only job is installability + a SAFE fetch strategy
::  for an auth-gated, dynamic app. It does NOT precache (every route is
::  auth-gated, so a logged-out install would 403 and abort). Static shell
::  (icon/manifest) is cache-on-first-hit; everything else is network-first and
::  never cached, so a stale authed page is never served offline.
::
++  sw-js
  ^-  @t
  'var V="lattice-v1";self.addEventListener("install",function(e){self.skipWaiting()});self.addEventListener("activate",function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==V}).map(function(k){return caches.delete(k)}))}).then(function(){return self.clients.claim()}))});self.addEventListener("fetch",function(e){var q=e.request;var u=new URL(q.url);if(q.method!=="GET"||u.origin!==self.location.origin||u.pathname.indexOf("/apps/lattice")!==0){return}if(u.pathname==="/apps/lattice/icon.svg"||u.pathname==="/apps/lattice/manifest.webmanifest"){e.respondWith(caches.open(V).then(function(c){return c.match(q).then(function(hit){return hit||fetch(q).then(function(r){c.put(q,r.clone());return r})})}));return}e.respondWith(fetch(q).catch(function(){if(q.mode==="navigate"){return new Response(`<!doctype html><meta name=viewport content="width=device-width"><body style="font:16px system-ui;padding:2rem;color:#888">offline - reconnect to reach lattice</body>`,{status:503,headers:{"content-type":"text/html"}})}return new Response("offline",{status:503})}))});self.addEventListener("message",function(e){if(e.data==="skipWaiting")self.skipWaiting()});'
++  apple-icon-b64
  ^-  @t
  'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAABmJLR0QA/wD/AP+gvaeTAAARvUlEQVR4nO2deXQT94HHfxqd1mnZlm1kGRsXHAIBHINDuI80IaTBQOJsGgo0oVy7S0iy7b4FmjR9OUjfa7ZbQptwJXSBpWzAJJhuCG4WQ4Mhj8sOBHAcB2NsWZaEJcs6rGM0s8/r91zZ+CdrfqNrRr/Pn0LDT575zMzv/P4E+o0NAIMZCmLITzEYLAcmHPjJgYGC5cBAwXJgoGA5MFCwHBgoWA4MFCwHBgqWAwMFy4GBguXAQMFyYKBgOTBQsBwYKFgODBQsBwYKlgMDBcuBgYLlwEDBcmCgYDkwULAcGChYDgwULAcGCpYDAwXLgYGC5cBAwXJgoGA5MFCwHBgoWA4MFCwHBgqWAwMFy4GBguXAQBGBpEEpJUbnSrJVIoWU6HCQ7fZAS2cgPkXrVKJCnThH3Xs2zN3kbWvA6iTjU3RBplivFedqRG4fZXGSTR1+l48CyUHi5SAEYMlkdUWZevoYuVgoCP2nZqv/xFXXnjN2syMml0ouIVbMSC8vVU3KlwlCSqZp8PUdb1Wdc19tV48/JpcqRyNaPUf7xCRlYZYk9HM/SZ9r8hy50H3sSjdFg8QiSGzU5JRRae88kzMuTxrmOx4/teOUfdvJTjKqZ6uiTP3Lcl32/z8tYJgd5NtV1spL3VEsV0QIXnk8c908bZok3Dv9utG35bD5UnMPSBxC1dQNiSr7uYc1u1bpczXDPL3EQsG00fLJo2RfXHf7AlHwQ0QIfr00e0u5TiEdpsqllBELJ6k0cuGX37rpaJipkQv3rs57dqpm0DPyXrLVoooydYeD/KbNB1JNjn+YqvndslwhMcw56qcgSzLrPvnRS04yyPYqbX0m5/lZ2si/X1qYpteKT15zsSxXKhb89z/nT/1BWoTfFxKCBROUZgd5LUF+JEaOsqK03av0kZvRR45GpNeKP7/K6iKtmq19eUEm06MeMMg6XcGv73jZFL1t+Yh59yuYHjVnrOLLRo+pK04V5AQ3ZQkB2FqRM+xzdUgqytTTRsuRi9apRJuezEI7dku5LkslRC56ZrF86WQ1woESkeCdZ3IY3keclWPJZHX4Gmh4flmuQz72pQUZw9YzYCilxMZHGT9y+tm8CP1nP2CQlpeiiMU9OZ4uY/V3Plgg+0H2gOZfhIgIwRJ2p3jpFLUQ6YSNyZGUjJSxKfrpKWr+93OoZMSMMejvhT7Wzdcer3MyPWqcXqpVoL8XAAAZCuGq2doGE+PqYfmDbC/tzGK5UkrEuX8s3v0cJQWy//mXgniWyBue+PcWljXiZH+t5IbtdMKEoa93n89yyMJ2C2LCIEetSiMT7/Is3Qlor/MDc2wGmMIQ7yeV0RaFgdZmq/+6kXGtME8rfrCAVZMBAHDldk878/6o8XnSUTqUFlYobdE4dUktR0tnoNnqZ3mmXqu01Nx0Mz0qUymse3M0Wlu0jyAFfrrLaHMHAUMeGa/Yt9YAWPC9xd8adzkSUAM4wa7/29lD1X7nQTiw0xW8yG6Q88ItD4IZAICzjR6nl0rgSeOMHHvO2D0sJkl8UGPzk4hjb9urO1kNjlQjHu4L0LtqbMjlun3Uh2fsIBXkMDvIHacQ/9QgRZ+oZ9z91c/pBvfpBsbvoz5O3XB/+S3KE6uPqivOIOp8lA9O2RJSkU9Mw/L3J++euoFykYSEYP96Q36GGLnoDftMCLMP22yBVw6akAvVp4v2rTMwHYXu42/furdXoz91uCdHkAIb9pvqWlD6+wwZ4iMv5iP7YXcHV+02MmoWdjjIn+4y3nUGkc048uLIgiyUH1zX4l23tz26U+A4MNnHF6ArL3XnacWRjNCSFE2ETPJUpwkfn6g8ec3V3YNSd7nrCn56xflQkXxE+vCNtcu3e378flvL3UAUzQgO/HNgHL7gWLO33eOjU3GaYJACn191nW/qGZMrhV0nZw+17a+dWw5b5o9TpMuF0fLD7aMOfeW400k+YJCq04YejWu1BX5VaXn9qMWF2tAY0ow2W2Dp7+9YncGJBplUPLQidS3eF/eb9pyxB6kUnmDcT1G2ZO1c7YoZ6f2fNFv9r1Vaar/z9LVNRvSe6PxBc7XbbIGK7a1sOgAIASgpSNv0o6wZxX8fK65t9LzzF+vXd7xsHucwM/p/sEQkmFksf+Op7NBen31nu3afsd+y+EESkCwjHbcs/k8vD5jkfbPdV3PT3d9qNXWRFdtbb9/1R7H+AQCg6N5Oz0FNmNMN7rqW2JrRtwrh1A33zfYBXb3HrnQniRlJJEckxMiPqKOPwAxOwCU5OOGHni9mcE+OJPdDzyMzOClH0vqh55cZXJUjCf3Q884MDsuRVH7o+WgGt+VIEj/0PDWD83Ik3A89f83ggxwJ9EPPazN4IkdC/NDz3Qz+yBFnP/QpYAav5IibH/rUMINvcsTBD33KmMFDOWLqhz6VzOCnHDHyQ59iZvBWjsj9KM6VbPhhxvLpf59kBAD4yfT0DT/MGJMjSWUzkkgOIQHGGwasVdRrxZlKYez8KCmQHd6QX7N51OZFukFXvTBLvHmR7vSWUVWvjHyoKC12ZmSphHrtgP92fJ6UzZo8vk0T1KlELy3IWFKqvjdZJUiBi80926s7kRebwOYXun2UXBLJJF9A08Dlo1QyIrpmzB2r2PhYZllR2r3LFezu4CeXu9+rtsUtRTlJ5Xhhlnbzoqxhc7pON7hfOmBCXhwwpB/ItLEzQ6cSbVueO2fsMLGCbh+19bj1T192gcSRsNnnIkLwm2dzX16QKRENf/8WZkkWlajONnruulD8cHmpE1ddj01Qhs5fT4gZY/XSwxvyJ+YPv9hfIhI8Mk6ZoxHV3IxOPi4CCXu/vb5U95Npmsi/b8gQ//mfDJGsNAlT/2C5mtnlo9iYka0WHVhnMDBpLi2fnv7a4mwAUkmOijL1qtkMMoT7yFaLdr2gR07kzNWIlOzCcRQSArmOLCTA3jV5CHKvmatFCzDlpBxyCYGcJVpamPZ0GYPnTSivLs6OpAYaBoEAPQW1okyDnDb56mJd+BT9GJGAIlfOTA+/V0F4frEwE+HhUZwreTji0PEwTB8jHx3S/xEhhAD8fCF6wG2uRrRiBuItwTE5FpWo2Bxu6O2iYHyZF0xgVWgoj09QAoaUFqblDezPiPNJ40bsk04lmsQuyxcAsOnJrDMMez6eezhqd95z0zRMWw9zh2u4DktJQVqWSojcmOeGHIU6McsXPwBgxhg5+xhkZAqzJFtYBJmjQQh6y73r7OF1SO1wW+9gYOTE/dTFW45E9efwARrwXA4zDqnlzqmL95PqtjVA070dBmyo/c7DtEK6bFp6IVLw0r00W/1//soBmDB3rGI6u0oSRfeWC/gth9VJfn3HW8IuSfid41ameWICdtvhhHLwvOP9/2WW4PZVU0/VKyMBC+pbejqRxpU41s9RxXyrlFBabQGEnSWqv4layOtJ5jsB1rX0GO2BBJ40zsixv7aLTcb7u5/dRcjcaezwn29CTxHtp7bR8z3z5B2KBu+eQM/H7XCQB84xe5FxVQ6Pn3q7yop27OXbPUdRtwB+q8rKsq1E0+Dt44i/vPKiox4pWhMA8OYxa4w2xk7GUdnKS917mOc1W7rJtR+1I0d1WRwky22w3D7KhvriD1LghT1GhB1Ad9XYB6Wl8X8+xxufWg6cYzDNqdUWeO79tg7U91HfPNBBs/2YopQRbOavW7rJ5TvaGO2Msb+2660qC0i1mWA0Db647u50BaeOlg87GezUDffKnW3Is2zYZAgPIhr5uN1jRwy//YrTS71+1PK7zzsT2G2Y+AnGWSrhxkczl05RZww1wfjCLc+26k42ifRDmuHyUYqIJxg7fUG1TBjdCcaz71NsfCzjoSL5vXPNbe7g0Uvd71V3xr/tmnRy9CEkwMoZ6W9V5PR/Ut/Ss2Inys43oYRZVZChFL5argvfN3WpuefNY1ajPRCLfNy+vUj3r8sLnYHw6hHzvtquxAYX95Msw2BBqjeVNvST9i4ydma02gKttsAzf2gdnSNZMEG5bJom9No3W/0HzztOXnP1t1ortrcO8qNv/QtLP2zuYHsXWRKylerNdl+SmJFEi5qiToQrkZrM/j9+Yfuvgb0IfX2g34f0ZyRDvlT84accsVijZko9P3goR+xWL5pSzA++yRHrFc+mVPKDV3LEZy28KWX84I8c8UxJMKWGHzyRI/75GaYU8IMPciQqWcXEdz84L0diM3dMvPaD23IkQxqTib9+cFiOZDCD335wVY7kMYPHfnBSjmQzg69+cE+O5DSDl35wTI5kNoN/fnBJjuQ3g2d+JIscY3Ikg5KvxuVJ549T9O/2HiMzCAGYMipt7v0D8jPm3q+YXDhEQmh0/ZCKBY+MV4zLk4Z+Z+lkNUJyEG+nCc4slm9epIPlZTm91M4a2/Erzn3rDNE1Q0j05nT9fGEmLHPHaA+8e6LzyAUH8mKIIfNP22yBFTuNT5Yo183PgAXY1d/xbj1urW2MwiosrsohEwt+++Pcp6YMH5UXpGjhwBuZpRm5GtGHP8uLZMlufYv3Zx8akZdEDOnHvX/OkFRe6v7XQx2+AJ1ycmjkwoPrDWgrqtknxR5cb4g8C8XsIJd90NZgGjDFNT75yfUt3mU72hyeYArVOUSEYOfz+oSYkaEQfrQ6j1FKTo5G9J9r87JUwijWPyKkpEC24/kRIjbVH87J8fKCzFn3oeRVBCl6xQ701U0AgD+sHFGQybjJYMgQ/8eyEciFmrrIlTuNQaTKS98KF5AicuRoROvnM44v7kNICJ5gEbo4d6xi2ER6GPPHKWbfhx4KuLhUFUk9Y0j+8ZEMNsmtXJJjzRwtmzze9fMyIsnSH5KNj6EnxYLewxHvYKlYsHYe+t0vlxCr5yDeThyTY+EkxiGvoajSiJnFKK+kLJVwyihWIcYPFcnRss9nFstZruFeOJHVSUMj3g+rgkwx+31P3ngq+9mpjNsOeVoxy02QhAT409q8djvjZu0DA3u6ECjKluRniOPcERxvOfKi0X88SicZdpV6jCgtSCsNWb0YTwxxlyPer5WEVKz4QQ7vQ2oTEl/ED9zsYokQwCG1nMHC+5Dapg6/n6SR26J9HDjX9Zd6xtGL4/TSXy1huyXWrz+xIPSjlz+oWjZtwNa1TPGTdJOZ7yG1Lh91rsnDcouJnTX2W8zzHs9/1/Pio5n3blAaOZ2u4Ed/syPkZ5i6SJZynG308P+1AgA4coFVNl5dixfBDAAASdGfsIvl++RyN1qySpPZX888WDeUIxdTI4f02JXuG0bEEU4AAHKGKQDgvWob8v3n9FLvVaMHzW5FDTAFAFxr8x5PkQRjigabD5sDQZRRqMMXHGyCiK1OEvkivV1lZZPgVtvoqUSK1/WT9OaPzcgTjrgXNdneRRrt5OMMu4SvtnrXfNROsnvz1t/xZqsZbyV26CvHbz+7y6pgAE7ddM8qlo9IZ9YNuOlj81+/Qd+tnZM5pDeMPqOdnHe/IsKxyjMN7ud3G92+KNxBNTfdSplwcmGk4yy7T9tfqzSzzwMNUuCzq64J+dKCyAYQ/CT9i0PmQwy37+CDHACA60bf2UbPhHxZ+G5Tj5/aVt256WOzN0oT5mganG5wN1sDpYVpyrDjYR0O8t8+Nu84ZYtWUqwvQB+77KRouqRAJhaGuyuutXnX7TV9cT1qmz1wcoIxIQDlpeqnp6hnFg+OMv7e4j9x1fXhGXuM+n/SJMTy6ZrFpepJI2Whzy+K7k1BrapzHjjniFGXbrZatHqOduFEZVH2gKeIn6TPNnqOXHQcr3MmpJ6RXHL0o5ASY3Ik2WqRQkqYugJGOxm3caZMpbAou7fovhmjtyx+lhGokZOfIc7Tikaki90+ytxNNpn98e/P4IAcmGQjWRY1YZIQLAcGCpYDAwXLgYGC5cBAwXJgoGA5MFCwHBgoWA4MFCwHBgqWAwMFy4GBguXAQMFyYKBgOTBQsBwYKFgODBQsBwYKlgMDBcuBgYLlwEDBcmCgYDkwULAcGChYDgwULAcGCpYDAwXLgYGC5cBAwXJgoGA5MFCwHBgoWA4MFCwHBgqWAwMFy4EBMP4PMeLu8glB6VIAAAAASUVORK5CYII='
::  +pwa-head: the <head> tags that make the app installable (manifest link,
::  theme-color, apple meta + icon). NOT added to render-bare (the preview
::  iframe is an inner document). +sw-register-script registers the worker.
::
++  pwa-head
  ^-  tape
  %-  trip
  '<link rel="manifest" href="/apps/lattice/manifest.webmanifest"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#1a6ed8"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1a1a1a"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="Lattice"><link rel="apple-touch-icon" href="/apps/lattice/apple-touch-icon.png"><link rel="icon" href="/apps/lattice/icon.svg" type="image/svg+xml">'
++  sw-register-script
  ^-  tape
  %-  trip
  '<script>if("serviceWorker"in navigator){navigator.serviceWorker.register("/apps/lattice/sw.js",{scope:"/apps/lattice"}).then(function(r){r.addEventListener("updatefound",function(){var w=r.installing;if(w)w.addEventListener("statechange",function(){if(w.state==="installed"&&navigator.serviceWorker.controller)w.postMessage("skipWaiting")})})}).catch(function(x){})}</script>'
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
::  +md-envelope: the exact page-source shell a markdown note is stored in.
::  The evaluator only knows Hoon gates, so a note IS a gate returning (md '...'):
::  wrap-md escapes the prose into a single-quote cord and drops it in here;
::  unwrap-md matches this shell to recover the prose for editing. Keep the two
::  in lockstep with this string.
::
++  content-env-pre  "|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]  ^-  result  ("
::  +make-folder-index: the generated code for an `index`-type page — a gate
::  whose whole body is `(folder-index deps /its/folder)`. The folder is the
::  page's OWN parent (snip its path), so creating an index page in a folder
::  auto-lists that folder with no hoon written by the user.
::
++  make-folder-index
  |=  pax=path
  ^-  @t
  (crip :(weld content-env-pre "folder-index deps " (spud (snip `path`pax)) ")"))
::  +wrap-content: raw body -> a page gate `... (BUILDER 'body')`. builder is a
::  pg constructor (md/gmi/html/text/js/css). Escapes body for a single-quote
::  hoon cord: \ -> \\, ' -> \', control bytes -> \0a hex.
::
++  wrap-content
  |=  [builder=@tas body=@t]
  ^-  @t
  =/  hx  |=(n=@ ^-(@tD ?:((lth n 10) (add '0' n) (add 87 n))))
  =/  ec=tape
    %-  zing
    %+  turn  (trip body)
    |=  c=@tD
    ^-  tape
    ?:  =(c 92)  "\\\\"
    ?:  =(c 39)  ~[`@tD`92 `@tD`39]
    ?:  (lth c 32)  ;:(weld "\\" ~[(hx (div c 16))] ~[(hx (mod c 16))])
    ~[c]
  (crip ;:(weld content-env-pre (trip builder) " '" ec "')"))
::  +unwrap-content: page source -> [builder body] if it matches the content
::  envelope, else ~ (a hand-written hoon page). Backward compatible with old
::  (md '...') notes. Fenced so a malformed body can't crash a read.
::
++  unwrap-content
  |=  src=@t
  ^-  (unit [builder=@tas body=@t])
  =/  s=tape  (trip src)
  ?.  (has-prefix content-env-pre s)  ~
  =/  aft=tape  (slag (lent content-env-pre) s)
  =/  sp  (find " '" aft)
  ?~  sp  ~
  =/  builder=tape  (scag u.sp aft)
  =/  rest=tape  (slag (add u.sp 2) aft)
  =/  ls=@ud  (lent rest)
  ?.  (gte ls 2)  ~
  ?.  =("')" (slag (sub ls 2) rest))  ~
  =/  mid=tape  (scag (sub ls 2) rest)
  =/  quoted=@t  (crip :(weld "'" mid "'"))
  =/  r  (mule |.(;;(@t q:(slap !>(0) (ream quoted)))))
  ?.  ?=(%& -.r)  ~
  `[`@tas`(crip builder) p.r]
::  +content-builders: the pg constructors an editor file wraps its body in.
::  md/gmi/html render to a view; text/js/css are shown as code + served raw.
::
++  content-builders  `(set @tas)`(sy ~[%md %gmi %html %text %js %css])
::  +name-pax: a ?name= value (slash-separated, e.g. notes/todo) -> a validated
::  page path under /page, or ~. Each segment must be a non-empty @ta knot.
::
++  name-pax
  |=  n=@t
  ^-  (unit path)
  =/  r  (mule |.(`path`(stab (crip (weld "/" (trip n))))))
  ?.  ?=(%& -.r)  ~
  ?~  p.r  ~
  ?.  (levy `path`p.r |=(seg=@ta &(!=(%$ seg) ((sane %ta) seg))))  ~
  `p.r
++  valid-name  |=(n=@t ^-(? ?=(^ (name-pax n))))
++  pax-of  |=(n=@t ^-(path (need (name-pax n))))
::  +pax-str: a page path -> its slash-separated string (no leading slash).
++  pax-str  |=(px=path ^-(tape ?~(px "" (slag 1 (trip (spat px))))))
::  +kind-of: a ?kind= param -> a valid editor kind (a content builder or %hoon).
++  kind-of  |=(k=@t ^-(@tas ?:(|((~(has in content-builders) `@tas`k) =(%index k)) `@tas`k %hoon)))
::  +mime-of: the Content-Type an asset file (/f/<name>) is served with.
++  mime-of
  |=  builder=@tas
  ^-  @t
  ?+  builder  'text/plain; charset=utf-8'
    %js    'text/javascript; charset=utf-8'
    %css   'text/css; charset=utf-8'
    %html  'text/html; charset=utf-8'
    %md    'text/markdown; charset=utf-8'
    %gmi   'text/gemini; charset=utf-8'
  ==
::  +read-tree: every node under /page (sorted) as [path page=?] — page=%.y is a
::  programmable page (a dir with a /code grub), page=%.n a plain folder (incl.
::  empty ones, made by +folder-new). Feeds the editor's nested tree sidebar.
::
++  read-tree
  =/  m  (fiber:fiber:nexus ,(list [pax=path page=?]))
  ^-  form:m
  ;<  sn=seen:nexus  bind:m  (peek:io [%& %| (weld app-base /page)] ~)
  ?.  ?=([%& %ball *] sn)  (pure:m ~)
  %-  pure:m
  %+  sort  (collect-tree ball.p.sn ~)
  |=([a=[pax=path page=?] b=[pax=path page=?]] (aor pax.a pax.b))
::  +read-template-names: the top-level template names under /template (the
::  things you can New-from-template). Sorted; ~ if none.
::
++  read-template-names
  =/  m  (fiber:fiber:nexus ,(list @ta))
  ^-  form:m
  ;<  sn=seen:nexus  bind:m  (peek-shallow:io [%& %| (weld app-base /template)] ~)
  ?.  ?=([%& %ball *] sn)  (pure:m ~)
  (pure:m (sort (turn ~(tap by dir.ball.p.sn) head) aor))
::  +read-page-names: just the page paths (folders dropped) — the home landing
::  lists what you can open.
::
++  read-page-names
  =/  m  (fiber:fiber:nexus ,(list path))
  ^-  form:m
  ;<  tree=(list [pax=path page=?])  bind:m  read-tree
  (pure:m (murn tree |=([pax=path page=?] ?:(page `pax ~))))
::  +collect-tree: walk a page-tree ball. A dir with a /code grub IS a page; any
::  other non-root dir is a folder. Recurse through pages too (a page can also be
::  a parent of nested pages). Paths are relative to /page.
::
++  collect-tree
  |=  [b=ball:tarball rel=path]
  ^-  (list [pax=path page=?])
  =/  fils  ?~(fil.b ~ contents.u.fil.b)
  =/  kids=(list [pax=path page=?])
    %-  zing
    %+  turn  ~(tap by dir.b)
    |=  [nom=@ta kid=ball:tarball]
    (collect-tree kid (weld rel /[nom]))
  ?:  (~(has by fils) %code)  [[rel &] kids]
  ?~  rel  kids
  [[rel |] kids]
::  +edit-css / +edit-js / +edit-html: the in-browser page editor. Code pane +
::  live preview (the page's own view in an iframe — it live-reloads itself via
::  its SSE, so a successful save renders immediately). The editor page itself
::  has NO auto-reload (that would eat unsaved edits): save goes through
::  fetch(), and the compile result is read back from the /err grub. name=~ is
::  new-page mode: a name field and a starter template, no preview yet.
::
++  edit-css
  ^-  tape
  %-  trip
  '<style>*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:#8887 transparent}::-webkit-scrollbar{width:11px;height:11px}::-webkit-scrollbar-thumb{background:#8886;border-radius:6px;border:3px solid transparent;background-clip:content-box}::-webkit-scrollbar-thumb:hover{background:#888a;background-clip:content-box}::-webkit-scrollbar-track{background:transparent}body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#111;background:#fafafa;height:100vh;overflow:hidden}@media(prefers-color-scheme:dark){body{color:#e6e6e6;background:#1a1a1a}}a{color:#1a6ed8}.ws{display:grid;grid-template-columns:210px minmax(0,1.15fr) minmax(0,1fr) 300px;grid-template-rows:auto 1fr;height:100vh}.ws.nt{grid-template-columns:0 minmax(0,1.15fr) minmax(0,1fr) 300px}.ws.nc{grid-template-columns:210px minmax(0,1.15fr) minmax(0,1fr) 0}.ws.nt.nc{grid-template-columns:0 minmax(0,1.15fr) minmax(0,1fr) 0}.bar{grid-column:1/-1;grid-row:1;display:flex;gap:8px;align-items:center;padding:7px 10px;border-bottom:1px solid #8884}.bar .grow{flex:1}.bar button,.bar input,.bar a,.bar select{font:inherit;padding:5px 9px;border:1px solid #8886;border-radius:6px;background:#8881;color:inherit;text-decoration:none;cursor:pointer}.bar select{color-scheme:light dark}.bar select option{background:#fafafa;color:#111}@media(prefers-color-scheme:dark){.bar select option{background:#242424;color:#e6e6e6}}.bar input{cursor:text}.bar button:hover,.bar a:hover{border-color:#1a6ed8}.bar .ico{padding:5px 8px}.bar b{padding:0 4px}#st{border:0;background:0;font-size:.85rem;padding:0}.tree{grid-column:1;grid-row:2;overflow:auto;padding:10px;border-right:1px solid #8884}.ctl{grid-column:4;grid-row:2;overflow:auto;padding:10px;border-left:1px solid #8884}.ws.nt .tree,.ws.nc .ctl{display:none}.tree a{display:block;padding:5px 8px;border-radius:6px;text-decoration:none;color:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tree a:hover{background:#8881}.tree a.cur{background:#1a6ed822;color:#1a6ed8;font-weight:600}.tree .newbtns{display:flex;gap:6px;margin-bottom:8px}.tree .nf{flex:1;text-align:center;padding:5px 8px;font:inherit;font-weight:600;font-size:.82rem;border:1px solid #8886;border-radius:6px;background:#8881;color:inherit;cursor:pointer;text-decoration:none}.tree .nf:hover{border-color:#1a6ed8}.tree .fld{display:flex;align-items:center;gap:2px;padding:5px 8px;white-space:nowrap;color:#8a8a8a;font-weight:600}.tree .fld .ftog{display:flex;align-items:center;gap:4px;flex:1;min-width:0;cursor:pointer;overflow:hidden;text-overflow:ellipsis}.tree .fld .cx{display:inline-block;width:.9em;font-size:.7rem;color:#8a8a8a;flex:none;user-select:none}.tree .fld .addf{margin-left:auto;color:#1a6ed8;text-decoration:none;font-weight:700;padding:0 6px;border-radius:4px;flex:none}.tree .fld .addf:hover{background:#1a6ed822}.tree .sec{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:#8a8a8a;margin:12px 4px 4px}#src{grid-column:2;grid-row:2;width:100%;height:100%;resize:none;border:0;border-right:1px solid #8884;font:13px/1.55 ui-monospace,Menlo,monospace;padding:12px;background:transparent;color:inherit;white-space:pre;overflow:auto;tab-size:2}.ws.wrap #src{white-space:pre-wrap;overflow-wrap:break-word}.prev,.prev-empty{grid-column:3;grid-row:2;width:100%;height:100%;border:0}.prev{background:#fafafa}@media(prefers-color-scheme:dark){.prev{background:#1a1a1a}}.prev-empty{display:flex;align-items:center;justify-content:center;color:#8a8a8a;text-align:center;padding:2rem}.ctl h3{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:#8a8a8a;margin:14px 0 5px}.ctl h3:first-child{margin-top:0}.ctl .err{color:#c0392b;white-space:pre-wrap;font:11px/1.4 ui-monospace,monospace;max-height:9rem;overflow:auto}.ctl .ok{color:#27ae60;font-size:.85rem}.ctl .row{display:flex;gap:6px}.ctl input{flex:1;font:inherit;padding:6px 8px;border:1px solid #8886;border-radius:6px;background:#8881;color:inherit;min-width:0}.ctl button{font:inherit;padding:6px 10px;border:1px solid #8886;border-radius:6px;background:#8881;color:inherit;cursor:pointer}.ctl button:hover{border-color:#1a6ed8}.share{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px}.share button.on{border-color:#1a6ed8;color:#1a6ed8}.del{margin-top:18px;color:#c0392b;border-color:#c0392b55!important;width:100%}.mtabs{display:none;grid-column:1;grid-row:2}@media(max-width:820px){body{overflow:auto;height:auto}.ws,.ws.nt,.ws.nc{grid-template-columns:1fr!important;grid-template-rows:auto auto 1fr!important;height:auto;min-height:100vh}.bar{grid-column:1;flex-wrap:wrap;padding-left:max(10px,env(safe-area-inset-left));padding-right:max(10px,env(safe-area-inset-right))}.bar .grow{display:none}.bar button,.bar a,.bar input{min-height:44px}.bar .ico{min-width:44px}#tt,#ct{display:none}.mtabs{display:flex;border-bottom:1px solid #8884}.mtabs button{flex:1;padding:11px;border:0;background:0;color:inherit;font:inherit;border-bottom:2px solid transparent;cursor:pointer}.mtabs button.on{border-bottom-color:#1a6ed8;color:#1a6ed8;font-weight:600}.tree,#src,.prev,.prev-empty,.ctl{grid-column:1;grid-row:3;border:0;display:none}.ws[data-mv=tree] .tree{display:block}.ws[data-mv=code] #src{display:block}.ws[data-mv=prev] .prev{display:block}.ws[data-mv=prev] .prev-empty{display:flex}.ws[data-mv=ctl] .ctl{display:block}#src{min-height:68vh;font-size:16px}.prev,.prev-empty{min-height:68vh}.ctl input{font-size:16px}.ctl,#src{padding-bottom:max(12px,env(safe-area-inset-bottom))}}</style>'
::  the starter template a new page opens with.
::
++  edit-template
  ^-  tape
  %-  trip
  '|=  [cmd=(unit @t) dat=(unit *) now=@da deps=(list [path *])]\0a^-  result\0a(text \'hello\')\0a'
::  the starter a new markdown NOTE opens with (raw markdown, not hoon).
::
++  md-template
  ^-  tape
  %-  trip
  '# My note\0a\0aStart writing in markdown. Use **bold**, *italic*, lists, and [links](https://urbit.org). The preview updates as you type.\0a'
::  +starter-for: the starter body a new file of the given kind opens with.
::
++  starter-for
  |=  kind=@tas
  ^-  tape
  ?+  kind  edit-template
    %md    md-template
    %gmi   (trip '# Gemtext\0a\0aLines are text. A link line starts with => :\0a=> https://urbit.org  Urbit\0a')
    %html  (trip '<h1>Hello</h1>\0a<p>Raw HTML — style it, script it, import assets.</p>\0a<!-- import a js file you made: <script src="/apps/lattice/f/app"></script> -->\0a')
    %text  (trip 'Plain text, shown exactly as typed.\0a')
    %js    (trip '// A JavaScript asset. Import it into an html file with:\0a//   <script src="/apps/lattice/f/NAME"></script>\0aconsole.log("hello from lattice");\0a')
    %css   (trip '/* A CSS asset. Import it into an html file with:\0a   <link rel="stylesheet" href="/apps/lattice/f/NAME"> */\0abody { font-family: system-ui, sans-serif; }\0a')
    %index  (trip 'This page lists the pages in its own folder, automatically.\0a\0aName it like  blog/index  and save — the text here is ignored; the\0alisting is generated from the folder and stays live as pages come and go.\0a')
  ==
::  +share-btn: one sharing preset button (JS wires the click), marked .on if current.
::
++  share-btn
  |=  [m=@tas label=tape cur=share-mode:le]
  ^-  tape
  ;:  weld
    "<button data-m=\""  (trip m)  "\""  ?:(=(m cur) " class=\"on\"" "")  ">"  label  "</button>"
  ==
::  +edit-html: the editor WORKSPACE (a full-viewport doc, no address-bar chrome).
::  Toggleable tree sidebar (left), code (centre), live preview iframe (right),
::  toggleable controls panel (far right: status, command, sharing, delete).
::
++  edit-html
  |=  $:  our=@p  name=(unit @ta)  src=@t  tree=(list [pax=path page=?])
          mode=share-mode:le  err=@t  kind=@tas  into=@t  nfolder=?
      ==
  ^-  @t
  =/  ship=tape  (scow %p our)
  =/  nm=tape  ?~(name "" (trip u.name))
  =/  view=tape  :(weld "/apps/lattice/x/" ship "/apps/lattice.lattice_app/page/" nm "/")
  ::  ct: a content file (its body is wrapped on save). wrap: soft-wrap prose.
  =/  ct=?  !=(%hoon kind)
  =/  wrap=?  |(=(%md kind) =(%gmi kind) =(%text kind))
  ::  new file opens on a per-kind starter; an existing file shows its body
  ::  (raw content for a typed file, via unwrap-content). Escaped for the textarea.
  =/  code=tape  ?~(name (esc (starter-for kind)) (esc (trip src)))
  ::  ?into=<folder>: the new file lands in that folder (prefilled name, and the
  ::  type-picker reload keeps the folder). into is a valid-name path, so safe raw.
  =/  into-q=tape  ?~(into "" (weld "&into=" (trip into)))
  =/  prefill=tape  ?:(=('' into) "" (esc (weld (trip into) "/")))
  ::  the nested file tree: folders (incl. empty ones) with their files indented.
  =/  tree-html=tape
    %-  zing
    ;:  weld
      `(list tape)`~["<div class=\"newbtns\"><a class=\"nf\" href=\"/apps/lattice/edit?newfolder=1\">+ folder</a><a class=\"nf\" href=\"/apps/lattice/edit\">+ file</a></div><div class=\"sec\">files</div>"]
      %+  turn  tree
      |=  [px=path page=?]
      =/  segs=(list @ta)  px
      =/  depth=@ud  ?~(segs 0 (dec (lent `(list @ta)`segs)))
      =/  leaf=tape  ?~(segs "" (trip (rear `(list @ta)`segs)))
      =/  full=tape  (pax-str px)
      =/  pad=tape  (a-co:co (add 8 (mul depth 14)))
      ?:  page
        ;:  weld
          "<a class=\"pg"  ?:(=(nm full) " cur" "")  "\" data-path=\""  full
          "\" style=\"padding-left:"  pad  "px\" href=\"/apps/lattice/edit?name="
          full  "\">"  (esc leaf)  "</a>"
        ==
      ;:  weld
        "<div class=\"fld\" data-path=\""  full  "\" style=\"padding-left:"  pad
        "px\"><span class=\"ftog\"><span class=\"cx\">&#9662;</span> &#128193; "
        (esc leaf)  "</span>"
        "<a class=\"addf\" title=\"new file here\" href=\"/apps/lattice/edit?into="
        full  "\">+</a></div>"
      ==
      `(list tape)`~[:(weld "<div class=\"sec\">tree</div><a href=\"/apps/lattice/x/" ship "/apps/lattice.lattice_app/page/\">browse pages &rarr;</a>")]
    ==
  ::  new-mode bar: the folder-name field (folder mode) or a type picker (its
  ::  reload keeps ?into=) + the prefilled file-name field.
  =/  new-bar=tape
    ?^  name  ""
    ?:  nfolder
      :(weld "<input id=\"pname\" value=\"" prefill "\" placeholder=\"folder name (a/b for nested)\" autocomplete=\"off\" autofocus>")
    =/  kinds=(list [@tas tape])
      ~[[%md "markdown"] [%gmi "gemtext"] [%html "html"] [%text "text"] [%js "javascript"] [%css "css"] [%index "folder index"] [%hoon "hoon page"]]
    =/  opts=tape
      %-  zing
      %+  turn  kinds
      |=  [k=@tas lbl=tape]
      ;:  weld  "<option value=\""  (trip k)  "\""  ?:(=(k kind) " selected" "")  ">"  lbl  "</option>"  ==
    ;:  weld
      "<select id=\"kpick\" onchange=\"if(this.value)location.href='/apps/lattice/edit?kind='+this.value+'"
      into-q  "'\">"  opts  "</select>"
      "<input id=\"pname\" value=\""  prefill  "\" placeholder=\"name or folder/name\" autocomplete=\"off\" autofocus>"
    ==
  ::  main-panes: folder mode shows a hint; else the code textarea + live preview.
  =/  main-panes=tape
    ?:  nfolder
      "<div class=\"prev-empty\" style=\"grid-column:2/4;grid-row:2\"><p>Name your folder above, then hit <b>create folder</b>.<br>You can add files inside it from the tree.</p></div>"
    ;:  weld
      "<textarea id=\"src\" spellcheck=\"false\">"  code  "</textarea>"
      ?:  ct  "<iframe class=\"prev\" id=\"prev\"></iframe>"
      ?~  name  "<div class=\"prev-empty\">live preview appears here once saved</div>"
      :(weld "<iframe class=\"prev\" id=\"prev\" src=\"" view "?embed\"></iframe>")
    ==
  =/  ctl-html=tape
    ?:  nfolder
      "<p style=\"color:#8a8a8a\">A folder has no settings. Create it, then add files inside it.</p>"
    ?~  name
      "<p style=\"color:#8a8a8a\">Save this page, then command &amp; sharing controls appear here.</p>"
    ;:  weld
      "<h3>status</h3>"
      ?:  =('' err)  "<div class=\"ok\" id=\"cerr\">compiled ok</div>"
      :(weld "<div class=\"err\" id=\"cerr\">" (esc (trip err)) "</div>")
      ?:(ct "" "<h3>command</h3><div class=\"row\"><input id=\"cmd\" placeholder=\"command\"><button id=\"csend\">send</button></div>")
      "<h3>sharing</h3><div class=\"share\">"
      (share-btn %private "private" mode)
      (share-btn %shared "shared" mode)
      (share-btn %clearweb "clearweb" mode)
      "</div><div id=\"cwurl\">"
      ?.  ?=(%clearweb mode)  ""
      :(weld "<p>public: <a href=\"/apps/lattice/c/" nm "\" target=\"_blank\">/c/" nm "</a></p>")
      "</div>"
      "<h3>grubs</h3><a href=\""  view  "?raw\" target=\"_blank\">raw grubs &rarr;</a>"
      "<button class=\"del\" id=\"del\">delete page</button>"
    ==
  %-  crip
  ;:  weld
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
    pwa-head
    "<title>edit"  ?~(name "" (weld " - " nm))  "</title>"  edit-css  "</head><body>"
    :(weld "<div class=\"ws" ?:(wrap " wrap" "") "\" id=\"ws\" data-mv=\"code\"><div class=\"bar\">")
    "<button class=\"ico\" id=\"tt\" title=\"toggle tree\">&#9776;</button>"
    ?^(name :(weld "<b>" (esc nm) "</b>") "")
    new-bar
    ?:(nfolder "<button id=\"save\">create folder</button>" "<button id=\"save\">save</button>")
    "<span id=\"st\"></span><span class=\"grow\"></span>"
    ?~(name "" :(weld "<a href=\"" view "\" target=\"_blank\">open &#8599;</a>"))
    "<button class=\"ico\" id=\"ct\" title=\"toggle panel\">&#9881;</button>"
    "<a href=\"/apps/lattice\">home</a></div>"
    ::  mobile-only tab bar (hidden on desktop): one pane at a time so the
    ::  on-screen keyboard never hides the preview. JS flips ws[data-mv].
    "<div class=\"mtabs\"><button data-mv=\"code\" class=\"on\">Code</button><button data-mv=\"prev\">Preview</button><button data-mv=\"tree\">Pages</button><button data-mv=\"ctl\">Panel</button></div>"
    "<div class=\"tree\">"  tree-html  "</div>"
    ::  folder mode shows a hint; else code textarea + live preview (md drives it
    ::  via srcdoc, live as you type; hoon uses the ?embed server view).
    main-panes
    "<div class=\"ctl\">"  ctl-html  "</div></div>"
    (edit-js nm view kind nfolder)
    sw-register-script
    "</body></html>"
  ==
::  +edit-js: the editor client — toggles (localStorage), tab, ctrl/cmd-S, save +
::  compile-check, and AJAX command/sharing/delete that reload the preview in
::  place. Single-quote cord: uses double-quotes and backticks only (no ' or \).
::
++  edit-js
  |=  [nm=tape view=tape kind=@tas nfolder=?]
  ^-  tape
  ;:  weld
    (trip '<script>(function(){var NAME="')
    nm
    (trip '";var KIND="')
    (trip kind)
    (trip '";var MKDIR=')
    ?:(nfolder "true" "false")
    (trip ';var CONTENT=KIND!=="hoon";var V="')
    view
    %-  trip
    '";var $=function(i){return document.getElementById(i)};var ws=$("ws");function ap(){ws.classList.toggle("nt",localStorage.edNT==="1");ws.classList.toggle("nc",localStorage.edNC==="1")}ap();$("tt").onclick=function(){localStorage.edNT=localStorage.edNT==="1"?"0":"1";ap()};$("ct").onclick=function(){localStorage.edNC=localStorage.edNC==="1"?"0":"1";ap()};var pn=$("pname");if(pn&&pn.value){var pl=pn.value.length;pn.focus();pn.setSelectionRange(pl,pl)}function trApply(){var c=[];try{c=JSON.parse(localStorage.edColl||"[]")}catch(e){}var rs=document.querySelectorAll(".tree [data-path]");for(var i=0;i<rs.length;i++){var p=rs[i].getAttribute("data-path");var hide=false;for(var j=0;j<c.length;j++){if(p.indexOf(c[j]+"/")===0){hide=true;break}}rs[i].style.display=hide?"none":"";if(rs[i].className.indexOf("fld")>=0){var cx=rs[i].querySelector(".cx");if(cx)cx.innerHTML=c.indexOf(p)>=0?"&#9656;":"&#9662;"}}}var ftgs=document.querySelectorAll(".tree .fld .ftog");for(var fi=0;fi<ftgs.length;fi++){ftgs[fi].onclick=function(){var p=this.parentNode.getAttribute("data-path");var c=[];try{c=JSON.parse(localStorage.edColl||"[]")}catch(e){}var k=c.indexOf(p);if(k>=0)c.splice(k,1);else c.push(p);localStorage.edColl=JSON.stringify(c);trApply()}}trApply();var mt=document.querySelectorAll(".mtabs button");for(var mi=0;mi<mt.length;mi++){mt[mi].onclick=function(){var v=this.getAttribute("data-mv");ws.setAttribute("data-mv",v);for(var mj=0;mj<mt.length;mj++){mt[mj].className=mt[mj].getAttribute("data-mv")===v?"on":""}if(v==="prev")prev()}}var st=function(t,ok){var s=$("st");s.textContent=t;s.style.color=ok?"#27ae60":"#c0392b"};var ta=$("src");if(ta){ta.addEventListener("keydown",function(e){if(e.key==="Tab"){e.preventDefault();var s=ta.selectionStart;ta.value=ta.value.slice(0,s)+"  "+ta.value.slice(ta.selectionEnd);ta.selectionStart=ta.selectionEnd=s+2}})}var prev=function(){var p=$("prev");if(!p)return;if(CONTENT){fetch("/apps/lattice/page-preview?type="+KIND,{method:"POST",body:ta.value}).then(function(r){return r.text()}).then(function(h){p.srcdoc=h}).catch(function(x){})}else{p.src=p.src}};if(CONTENT){var tmr;ta.addEventListener("input",function(){clearTimeout(tmr);tmr=setTimeout(prev,400)});prev()}var chk=async function(){if(!NAME)return;var t="";try{t=await (await fetch(V+"err?data")).text()}catch(x){}var c=$("cerr");if(t){st("error",false);if(c){c.textContent=t;c.className="err"}}else{st(CONTENT?"saved":"compiled ok",true);if(c){c.textContent="compiled ok";c.className="ok"}prev()}};$("save").onclick=async function(){var name=NAME||($("pname")?$("pname").value.trim():"");if(!name){st("name required",false);return}if(MKDIR){st("creating...",true);var rf=await fetch("/apps/lattice/folder-new?name="+encodeURIComponent(name),{method:"POST"});if(!rf.ok){st("create failed "+rf.status,false);return}location="/apps/lattice/edit?into="+encodeURIComponent(name);return}st("saving...",true);var r=await fetch("/apps/lattice/page-save?name="+encodeURIComponent(name)+(NAME?"":"&new=1")+(CONTENT?"&type="+KIND:""),{method:"POST",body:ta.value});if(r.status===409){st("that page already exists",false);return}if(!r.ok){st("save failed "+r.status,false);return}if(!NAME){location="/apps/lattice/edit?name="+encodeURIComponent(name)+(CONTENT?"&kind="+KIND:"");return}st(CONTENT?"saved":"compiling...",true);setTimeout(chk,800);setTimeout(chk,2000)};window.addEventListener("keydown",function(e){if((e.metaKey||e.ctrlKey)&&e.key==="s"){e.preventDefault();$("save").onclick()}});var cs=$("csend");if(cs){var run=async function(){var c=$("cmd").value;if(!c)return;await fetch("/apps/lattice/page-cmd?name="+encodeURIComponent(NAME),{method:"POST",body:"cmd="+encodeURIComponent(c)});$("cmd").value="";setTimeout(prev,600)};cs.onclick=run;$("cmd").addEventListener("keydown",function(e){if(e.key==="Enter")run()})}document.querySelectorAll(".share button").forEach(function(b){b.onclick=async function(){var m=b.getAttribute("data-m");await fetch("/apps/lattice/page-share?name="+encodeURIComponent(NAME)+"&mode="+m,{method:"POST"});document.querySelectorAll(".share button").forEach(function(x){x.className=x.getAttribute("data-m")===m?"on":""});$("cwurl").innerHTML=m==="clearweb"?`<p>public: <a href="/apps/lattice/c/${NAME}" target="_blank">/c/${NAME}</a></p>`:"";setTimeout(prev,500)}});var d=$("del");if(d){d.onclick=async function(){if(!confirm("delete "+NAME+"?"))return;await fetch("/apps/lattice/page-del?name="+encodeURIComponent(NAME),{method:"POST"});location="/apps/lattice"}}})();</script>'
  ==
::  +home-css: styling for the landing (nav cards + lists).
::
++  home-css
  ^-  tape
  %-  trip
  '<style>*{scrollbar-width:thin;scrollbar-color:#8887 transparent}::-webkit-scrollbar{width:11px;height:11px}::-webkit-scrollbar-thumb{background:#8886;border-radius:6px;border:3px solid transparent;background-clip:content-box}::-webkit-scrollbar-track{background:transparent}.muted{color:#8a8a8a}h1{margin:.2rem 0}.apps{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:14px;margin:1.2rem 0}.appcard{display:flex;flex-direction:column;gap:5px;padding:20px;border:1px solid #8886;border-radius:12px;text-decoration:none;color:inherit;background:#8881}.appcard:hover{border-color:#1a6ed8}.appcard .ico{font-size:1.7rem;line-height:1}.appcard strong{font-size:1.2rem}.appcard .d{color:#8a8a8a;font-size:.9rem}.quick{display:flex;flex-wrap:wrap;gap:8px;margin:.5rem 0 .3rem}.quick a{padding:6px 12px;border:1px solid #8886;border-radius:8px;text-decoration:none;color:inherit;background:#8881;font-size:.9rem}.quick a:hover{border-color:#1a6ed8}ul.pglist{list-style:none;padding:0;margin:.4rem 0}ul.pglist li{padding:11px 2px;border-bottom:1px solid #8883;display:flex;justify-content:space-between;align-items:center;gap:12px}ul.pglist a{padding:4px 2px}h2{font-size:1rem;color:#8a8a8a;margin:1.4rem 0 .2rem;text-transform:uppercase;letter-spacing:.03em}</style>'
::  +home-index-html: the landing page. Always shows navigation (Pages,
::  Explorer) plus a live list of your programmable pages and any published
::  pages — so an empty store is still a way in, not a dead end.
::
++  home-index-html
  |=  [our=@p pages=(list path) tmpls=(list @ta) ix=pub-index:lp]
  ^-  tape
  =/  ship=tape  (scow %p our)
  =/  base=tape  :(weld "/apps/lattice/x/" ship "/apps/lattice.lattice_app/page/")
  =/  tree=tape  :(weld "/apps/lattice/x/" ship "/")
  ::  New-from-template: a chip per template; JS prompts for a name, POSTs
  ::  /template-new (slow — one page per writer round-trip), then opens the new
  ::  site. No chip if there are no templates.
  =/  tmpl-section=tape
    ?~  tmpls  ""
    %-  zing
    ;:  weld
      `(list tape)`~["<h2>Start from a template</h2><div class=\"quick\">"]
      %+  turn  tmpls
      |=(t=@ta :(weld "<a href=\"#\" class=\"tmpl\" data-t=\"" (trip t) "\">" (trip t) " &rarr;</a>"))
      `(list tape)`~["</div><span id=\"tstat\" class=\"muted\"></span>"]
    ==
  ::  single-quote cords: double-quote tapes interpolate {...}, which would eat
  ::  the JS braces. So build the script from single-quote cords (no ' or \).
  =/  tmpl-script=tape
    ?~  tmpls  ""
    ;:  weld
      %-  trip
      '<script>document.querySelectorAll(".tmpl").forEach(function(a){a.onclick=async function(e){e.preventDefault();var t=a.getAttribute("data-t");var n=prompt("Name for your new "+t+":",t);if(!n)return;n=n.trim();if(!n)return;var s=document.getElementById("tstat");s.textContent="creating "+n+"... (this can take a moment)";var r=await fetch("/apps/lattice/template-new?template="+encodeURIComponent(t)+"&name="+encodeURIComponent(n),{method:"POST"});if(r.status===409){s.textContent=n+" already exists";return}if(!r.ok){s.textContent="failed ("+r.status+")";return}location="/apps/lattice/x/'
      ship
      (trip '/apps/lattice.lattice_app/page/"+n+"/index/"}})</script>')
    ==
  =/  page-list=tape
    ?~  pages  "<p class=\"muted\">No pages yet — open <b>Pages</b> above to make one.</p>"
    %-  zing
    ;:  weld
      `(list tape)`~["<ul class=\"pglist\">"]
      %+  turn  pages
      |=  px=path
      =/  pt=tape  (pax-str px)
      ;:  weld
        "<li><a href=\""  base  pt  "/\">"  (esc pt)  "</a>"
        " <a class=\"muted\" href=\"/apps/lattice/edit?name="  pt
        "\">edit</a></li>"
      ==
      `(list tape)`~["</ul>"]
    ==
  =/  pub-keys=(list path)  ~(tap in ~(key by ix))
  =/  pub-list=tape
    ?~  pub-keys  "<p class=\"muted\">Nothing published yet.</p>"
    %-  zing
    ;:  weld
      `(list tape)`~["<ul class=\"pglist\">"]
      %+  turn  pub-keys
      |=  pax=path
      =/  rel=tape  (slag 1 (spud (snip (slag 1 pax))))
      :(weld "<li><a href=\"/apps/lattice?url=urb://" ship "/" rel "\">" (esc rel) "</a></li>")
      `(list tape)`~["</ul>"]
    ==
  ;:  weld
    home-css
    "<h1>Lattice</h1>"
    "<p class=\"muted\">Programmable pages &amp; published notes &middot; "  ship  "</p>"
    ::  the two apps: author on the left, read/browse on the right.
    "<div class=\"apps\">"
    "<a class=\"appcard\" href=\"/apps/lattice/edit\"><span class=\"ico\">&#9998;</span><strong>Editor</strong><span class=\"d\">Create, organize, and edit your pages, notes, and files in a tree.</span></a>"
    :(weld "<a class=\"appcard\" href=\"" tree "\"><span class=\"ico\">&#127760;</span><strong>Browser</strong><span class=\"d\">Read and explore content &mdash; your published pages and other ships via urb://.</span></a>")
    "</div>"
    ::  editor section: quick-create + your programmable pages.
    "<h2>Editor</h2>"
    "<div class=\"quick\"><a href=\"/apps/lattice/edit?kind=md\">+ note</a><a href=\"/apps/lattice/edit\">+ page</a><a href=\"/apps/lattice/edit?newfolder=1\">+ folder</a></div>"
    page-list
    ::  start-from-a-template (whole page-trees, e.g. a static site).
    tmpl-section
    tmpl-script
    ::  browser section: browse the tree, visit peers, read what's published.
    "<h2>Browser</h2>"
    :(weld "<div class=\"quick\"><a href=\"" tree "\">Browse your tree &rarr;</a></div>")
    "<p class=\"muted\">Enter a <b>urb://~ship/path</b> in the bar above to visit another ship.</p>"
    pub-list
  ==
::  +web-css: minimal reader styling (single-quoted cord so braces are literal).
::
++  web-css
  ^-  tape
  %-  trip
  '*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:#8887 transparent}::-webkit-scrollbar{width:11px;height:11px}::-webkit-scrollbar-thumb{background:#8886;border-radius:6px;border:3px solid transparent;background-clip:content-box}::-webkit-scrollbar-thumb:hover{background:#888a;background-clip:content-box}::-webkit-scrollbar-track{background:transparent}html{background:#fafafa}body{margin:0;font:16px/1.6 system-ui,sans-serif;color:#111;background:#fafafa}@media(prefers-color-scheme:dark){html{background:#1a1a1a}body{color:#e6e6e6;background:#1a1a1a}}.bar{display:flex;gap:6px;padding:8px;border-bottom:1px solid #8884}.bar a.home{display:flex;align-items:center;padding:0 12px;font-size:1.2rem;border:1px solid #8886;border-radius:6px;text-decoration:none;color:inherit}.bar a.home:hover{border-color:#1a6ed8}.bar input{flex:1;padding:6px 8px;font:inherit;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit}main{max-width:46rem;margin:0 auto;padding:16px;overflow-wrap:anywhere}a{color:#1a6ed8}.err{color:#c0392b}blockquote{margin:.6rem 0;padding-left:1rem;border-left:3px solid #8886;color:#8a8a8a}pre{background:#8881;padding:10px;overflow-x:auto;border-radius:6px;white-space:pre}code{background:#8881;padding:.1em .3em;border-radius:4px;font-size:.9em}pre code{background:0;padding:0}table{border-collapse:collapse;margin:.7rem 0;display:block;overflow-x:auto;max-width:100%}th,td{border:1px solid #8887;padding:6px 11px}th{background:#8881;font-weight:600;text-align:left}img{max-width:100%;height:auto}del{opacity:.7}ul,ol{padding-left:1.5rem}li{margin:.15rem 0}sup.fnref{font-size:.72em}sup.fnref a{text-decoration:none}hr.fn-sep{margin-top:2rem}.footnotes{font-size:.88em;color:#8a8a8a}.footnotes li{margin:.25rem 0}.bar{padding-left:max(8px,env(safe-area-inset-left));padding-right:max(8px,env(safe-area-inset-right))}main{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right))}@media(max-width:520px){.bar{flex-wrap:wrap}.bar input{flex:1 1 100%;order:3}main{padding-top:12px;padding-bottom:12px}}'
::  +render-page: wrap an HTML fragment in the reader chrome (address bar + CSS).
::
++  render-page
  |=  [current=tape keep=tape inner=tape]
  ^-  @t
  %-  crip
  ;:  weld
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
    pwa-head
    "<title>lattice</title><style>"  web-css  "</style></head><body>"
    "<form class=\"bar\" action=\"/apps/lattice\" method=\"get\">"
    "<a class=\"home\" href=\"/apps/lattice\" title=\"lattice home\">&#8962;</a>"
    "<input name=\"url\" value=\""  (esc current)  "\" autocomplete=\"off\" placeholder=\"urb://~ship/path\">"
    "<button type=\"submit\">Go</button></form><main>"  inner  "</main>"
    (sse-script keep)  sw-register-script  "</body></html>"
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
    ::  a top-level single-char pub name would shadow a urb:// mount letter
    ::  (p/n/k/t and the rest of the reserved 1-char space), so its bare
    ::  canonical url could never resolve back to it. Refuse it — the whole
    ::  single-char first-component space stays reserved to the protocol forever.
    ?:  ?&(?=([@ ~] key) =(1 (met 3 i.key)))
      ~&([%lattice-pub-name-reserved key] (pure:m ~))
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
