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
/<  lu   /lib/lattice-urls.hoon
/<  pg   /lib/lattice-pg.hoon
/<  gfm  /lib/lattice-md.hoon
/<  tpl  /lib/lattice-templates.hoon
/<  lkv  /lib/lattice-know-view.hoon
::  imports resolve relative to THIS file's dir (/nex/lattice), not /nex —
::  guestbook writes `guestbook/icon.svg` only because its source sits AT /nex.
/<  icon  icon.svg
/<  pjs  prism.js
/<  uih  ui-app/index.html
/<  uij  ui-app/app.js
/<  lc   /lib/lattice-comment.hoon
/<  lb   /lib/lattice-bookmark.hoon
/<  lcl  /lib/lattice-clip.hoon
=<  ^-  nexus:nexus
    |%
    ++  on-load
      |=  =ball:tarball
      ^-  bole:tarball
      ::  Every persistent path needs a covering row — spin rebuilds the
      ::  bole from scratch and DROPS anything uncovered. The %fall %| over
      ::  /know/vault copies the whole existing subtree, so dynamically
      ::  created entries survive reload. Versioning is the manifest row
      ::  (grubbery's loader has no read-side ver gate — matches obelisk).
      %+  spin:loader  ball
      :~  (manifest:loader 0)
        ::  tile.json: the launcher (tiles nexus) lists only apps that carry
        ::  one — without it lattice is invisible in the grubbery home UI.
        ::  %over so the tile stays current across reloads.
            :^  %over  %&  [/ %'tile.json']
            :-  [/ %json]
            %-  pairs:enjs:format
            :~  title+s+'Lattice'
                info+s+'Pages, knowledge & catalog'
                color+s+'#4a7c59'
                ::  the tiles icon route matches the app SLUG (name before the
                ::  first dot), not the folder name.
                image+s+'/grubbery/tiles/icon/lattice'
                href+s+'/apps/lattice'
            ==
            [%over %& [/ %'icon.svg'] [[/ %mime] icon]]
            [%over %& [/ %'prism.js'] [[/ %mime] pjs]]
        ::  the lattice-hosted UI (docs/ui-migration/PLAN.md): real files in
        ::  ui-app/, laid as grubs, served at /apps/lattice/app — the core
        ::  stays lean (assets in cords wedge every request fiber).
        ::  css is inlined in index.html (every asset request costs ~2s on the
        ::  serialized pier, so the shell ships as one document + one script).
            [%over %& [/app %'index.html'] [[/ %mime] uih]]
            [%over %& [/app %'app.js'] [[/ %mime] uij]]
            [%fall %& [/ %'main.sig'] [[/ %sig] ~]]
        ::  /legacy: the retired-agent marker lives here (see +legacy-mark-road)
            [%fall %| /legacy empty-dir:loader]
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
        ::  /comments/<page>/<id>: one grub per page comment (Urbit-ships-only).
        ::  Page content stays under /page (owner-only weir); comments are the one
        ::  area other ships may append to (via the public inbox fiber, added with
        ::  the cross-ship path). The owner writer (main.sig) also writes here.
            [%fall %| /comments empty-dir:loader]
        ::  /bookmarks: the browser's saved-page list (newest first). A covering
        ::  file row (like /sub/follows) so it survives reload.
            [%fall %& [/ %bookmarks] [[/lattice %bookmarks] *bookmarks:lb]]
        ::  /rev: a tiny change beacon bumped on every writer mutation. Open web
        ::  readers keep-SSE this one small grub (no-blot) and reload on any change
        ::  — a lightweight live-update signal that doesn't stream a page's heavy
        ::  compiled grub, and works where grubbery's ?blot=/txt keep does not.
            [%fall %& [/beacon %rev] [[/ %json] (numb:enjs:format 0)]]
            [%fall %& [/ %'crawler.sig'] [[/ %sig] ~]]
        ::  /fs.sig: a lick (unix-socket) port exposing the filesystem ops to a
        ::  local FUSE client (lattice-fs) — the native-transport twin of the
        ::  HTTP page-tree/page-source/page-save routes.
            [%fall %& [/ %'fs.sig'] [[/ %sig] ~]]
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
        ;<  ~  bind:m  (apply-action root now sage)
        ::  bump the change beacon so open readers live-reload (see +bump-rev).
        ;<  ~  bind:m  (bump-rev now)
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
          (remote-road [%& %& (weld (weld app-base:lu /pub/vault) rel) %gmi] ship.ps)
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
      ::  /fs.sig: the lick (local IPC) port for the FUSE client. The serve-loop
      ::  is generic — +lick-serve:io (fiberio) spins the socket, decodes each
      ::  [verb path query body] frame, and spits back [status body]. The only
      ::  lattice-specific part is the +fs-op handler. Auth is filesystem-presence:
      ::  the socket lives in the pier.
          [~ %'fs.sig']
        ;<  ~  bind:m  (rise-wait:io prod "%lattice fs port: failed")
        (lick-serve:io fs-port fs-op)
      ::  /cat/obelisk.sig: the serializing obelisk OWNER (finding #1). Owns the
      ::  single /server sub; takes %obk-req pokes one at a time, runs the query
      ::  (obelisk-run-one), and writes the result to the caller's grub — so no two
      ::  obelisk round-trips are ever interleaved on the shared sub.
          [[%cat ~] %'obelisk.sig']
        ;<  ~  bind:m  (rise-wait:io prod "%lattice obelisk owner: failed")
        ::  ensure the result-grub dir exists once, so per-query put-files land.
        ;<  ~  bind:m  (ensure-dirs (weld app-base:lu /cat) /obk-out)
        ::  clear any orphaned result grubs from a prior run (finding #6).
        ;<  ~  bind:m  (sweep-obk-out (weld app-base:lu /cat/obk-out))
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
  ::  public form submissions: POST /f/<page>. The ONLY unauthenticated WRITE,
  ::  and it is opt-in twice over — the page must be %clearweb AND carry a
  ::  /forms-on flag (owner-set). The body becomes one command to that page,
  ::  with poke budget 0 so a submission can never start a poke chain. The
  ::  gate is +serve-form; nothing else public can write.
  ?:  &(?=([%f ^] suffix) =(%'POST' method.request.req))
    (serve-form eyre-id t.suffix (req-body req))
  ::  PWA assets: also unauthenticated. Browsers fetch the manifest and the
  ::  apple-touch-icon WITHOUT credentials (only Chrome honors
  ::  crossorigin=use-credentials, iOS never sends cookies for icons) — behind
  ::  the owner gate they 403 and the install silently degrades to a bookmark
  ::  with no standalone display. Nothing here is private: the app's name,
  ::  colors, icons, and a generic caching worker.
  ?:  &(=(%'GET' method.request.req) =(`path`[%'manifest.webmanifest' ~] suffix))
    (send-typed eyre-id 'application/manifest+json' 'no-cache' manifest-json)
  ?:  &(=(%'GET' method.request.req) =(`path`[%'sw.js' ~] suffix))
    (send-sw eyre-id sw-js)
  ?:  &(=(%'GET' method.request.req) =(`path`[%'icon.svg' ~] suffix))
    (send-typed eyre-id 'image/svg+xml' 'public, max-age=86400' icon-svg)
  ?:  &(=(%'GET' method.request.req) =(`path`[%'apple-touch-icon.png' ~] suffix))
    (send-png eyre-id apple-icon-b64)
  ?:  &(=(%'GET' method.request.req) =(`path`[%'icon-192.png' ~] suffix))
    (send-png eyre-id icon-192-b64)
  ?:  &(=(%'GET' method.request.req) =(`path`[%'icon-512.png' ~] suffix))
    (send-png eyre-id icon-512-b64)
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
  ::  /know[/<key…>]: the private knowledge view — browse the memory store in
  ::  the reader. Owner-only like every non-clearweb route (gated above).
  ?:  &(?=([%know *] suffix) =(%'GET' method.request.req))
    (serve-know eyre-id t.suffix args)
  ::  /app[/asset]: the lattice-hosted UI (grub-served; see ui-app/).
  ?:  &(?=([%app *] suffix) =(%'GET' method.request.req))
    (serve-ui eyre-id t.suffix)
  ::  root: the web reader (Landscape tile). ?url=urb://ship/rel renders that
  ::  page; no url renders the home index of our published pages. ponytail:
  ::  compact gemtext->HTML (headings/links/quotes/lists/pre); the full reader's
  ::  link-resolution + bookmark sync can follow.
  ?~  suffix
    =/  raw=(unit @t)  (~(get by args) 'url')
    ?~  raw
      ::  authored home first: if the user published an /index page, serve it;
      ::  else the generated listing. Both keep /pub/index so a publish/delete/
      ::  edit auto-refreshes the open reader.
      ;<  home=(unit @t)  bind:m  (read-page-body our our /index)
      ?~  home
        ;<  recent=(list [pax=path prev=@t])  bind:m  (read-recent 10)
        ;<  bms=bookmarks:lb  bind:m  read-bookmarks
        ;<  kes=(map path know-entry:lk)  bind:m  read-know-map
        (send-view eyre-id (render-page (weld "urb://" (scow %p our)) (keep-url "beacon/rev") (home-index-html our recent bms (know-quick-html:lkv kes 6))))
      (send-view eyre-id (render-page (weld "urb://" (scow %p our)) (keep-url "beacon/rev") (render-gmi u.home)))
    =/  ref=(unit referent:lu)  (de-urb:lu u.raw)
    ::  omnibar: input that isn't a urb:// address is a SEARCH query — serve a
    ::  results page that queries the obelisk content catalog (client-side, via
    ::  the /catalog-search JSON api, which is built for exactly this fan-out).
    ?~  ref  (send-html eyre-id (render-page (trip u.raw) "" (search-results-html u.raw our)))
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
      ;<  body=(unit @t)  bind:m  (read-page-body our ship.u.ref rel.u.ref)
      =/  canon=tape  (trip (en-urb:lu ship.u.ref (weld pub-prefix:lu rel.u.ref)))
      ?~  body
        (send-view eyre-id (render-page canon "" "<p class=\"err\">not published here</p>"))
      ::  own pages get a live reader (keep /pub/index — its per-page hash changes
      ::  on every edit); remote pages stay static (can't keep a peer's grub).
      =/  rk=tape  ?:(=(ship.u.ref our) (keep-url "beacon/rev") "")
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
    ::  peek just the one entry grub — hydrating the whole vault to serve a
    ::  single memory made this route degrade linearly with the store's size.
    ;<  kn=view:nexus  bind:m
      (peek:io [%| 2 %& (weld /know/vault u.ko) entry-leaf:lk] ~)
    ?.  ?=([%file *] kn)  (send-err eyre-id 404 'not found')
    ?:  (is-boom:tarball sang.kn)  (send-err eyre-id 404 'not found')
    =/  e=(unit know-entry:lk)
      (mole |.(!<(know-entry:lk (need-vase:tarball sang.kn))))
    ?~  e  (send-err eyre-id 404 'not found')
    (send-json eyre-id (know-entry-json u.ko u.e))
  ::
  ::  page-source: raw editable source + kind + revision for one page, so a
  ::  filesystem client (lattice-fs) never parses the wrap envelope. Mirrors what
  ::  /edit computes: unwrap the code grub server-side, report the derived kind.
  ::  err is read separately via /x/<our>/…/page/<name>/err?data (as the editor
  ::  does), so this stays a single peek.
      [%'GET' %page-source]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ;<  r=(each json [code=@ud msg=@t])  bind:m
      (fs-source-result u.name =('1' (~(gut by args) 'render' '0')))
    ?-  -.r
      %&  (send-json eyre-id p.r)
      %|  (send-err eyre-id code.p.r msg.p.r)
    ==
  ::  page-history: every stored revision of a page, newest first. The /page
  ::  code grub's born history is permanent (%firm), and autosave makes it
  ::  dense — version history for free, no extra storage machinery.
      [%'GET' %page-history]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  pdir=path  (weld app-base:lu (weld /page (pax-of u.name)))
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io [%& %& pdir %code] [%numb ~ ~])
    ?:  ?=(%| -.pe)  (send-err eyre-id 404 'no history')
    =/  revs=(list [ud=@ud da=@da])
      %+  sort  (turn p.pe |=([c=cass:clay *] [ud.c da.c]))
      |=([a=[ud=@ud da=@da] b=[ud=@ud da=@da]] (gth ud.a ud.b))
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  ['name' s+u.name]
        :-  'revisions'
        :-  %a
        %+  turn  revs
        |=  [ud=@ud da=@da]
        (pairs:enjs:format ~[['rev' (numb:enjs:format ud)] ['updated' s+(scot %da da)]])
    ==
  ::  page-source-at: a page's source AS OF a revision. Read-only view;
  ::  restoring = the client re-saves the old body as a fresh revision, so
  ::  nothing is ever destroyed. The rev is validated against real history
  ::  first because peek-at bails outright on a miss.
      ::  NB: numeric URL params parse with +dim:ag, NOT +slaw %ud — slaw wants
      ::  hoon's dotted numeral syntax (1.000), so every rev >= 1000 silently
      ::  failed to parse and 400'd. With autosave, revision numbers pass 1000
      ::  within a few sessions.
      [%'GET' %page-source-at]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  rv=(unit @ud)  (rush (~(gut by args) 'rev' '') dim:ag)
    ?~  rv  (send-err eyre-id 400 'bad rev')
    =/  pdir=path  (weld app-base:lu (weld /page (pax-of u.name)))
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io [%& %& pdir %code] [%numb ~ ~])
    ?:  ?=(%| -.pe)  (send-err eyre-id 404 'no history')
    ?.  (lien p.pe |=([c=cass:clay *] =(ud.c u.rv)))
      (send-err eyre-id 404 'no such revision')
    ;<  sn=view:nexus  bind:m  (peek-at:io [%& %& pdir %code] ~ [%ud u.rv])
    ?.  ?=([%file *] sn)  (send-err eyre-id 404 'not found')
    =/  src=@t  (fall (mole |.(;;(@t (sang-noun:tarball sang.sn)))) '')
    =/  un=(unit [builder=@tas body=@t])  (unwrap-content src)
    =/  kind=@tas  ?~(un %hoon builder.u.un)
    =/  body=@t  ?~(un src body.u.un)
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  ['body' s+body]  ['kind' s+kind]
        ['rev' (numb:enjs:format u.rv)]
    ==
  ::  page-backlinks: every page whose body wikilinks [[name]]. ONE deep peek
  ::  (the ball already carries every code grub), then a local scan per page —
  ::  no external index, so it works even where obelisk doesn't; no per-page
  ::  darts, so it stays flat as pages accumulate.
      [%'GET' %page-backlinks]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  needle=tape  :(weld "[[" (trip u.name) "]]")
    ;<  sn=view:nexus  bind:m  (peek:io [%& %| (weld app-base:lu /page)] ~)
    ?.  ?=([%ball *] sn)
      (send-json eyre-id (pairs:enjs:format ~[['links' a+~]]))
    =/  pages=(list [pax=path when=@da code=@t])  (recent-walk ball.sn wave.sn ~)
    ::  sorted by path like the old walk; murn preserves input order
    =/  srt=(list [pax=path when=@da code=@t])
      (sort pages |=([a=[pax=path *] b=[pax=path *]] (aor pax.a pax.b)))
    =/  links=(list json)
      %+  murn  srt
      |=  [pax=path when=@da code=@t]
      ^-  (unit json)
      =/  un=(unit [builder=@tas body=@t])  (unwrap-content code)
      =/  bod=@t  ?~(un code body.u.un)
      ?~  (find needle (trip bod))  ~
      `[%s (crip (pax-str pax))]
    (send-json eyre-id (pairs:enjs:format ~[['links' a+links]]))
  ::
  ::  page-errors: a page's latest evaluator error as plain text ('' = clean).
  ::  The lattice-fs nvim glue reads this to populate the quickfix list.
      [%'GET' %page-errors]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ;<  t=@t  bind:m  (fs-err-text u.name)
    (send-typed eyre-id 'text/plain' 'no-cache' t)
  ::
  ::  page-tree: the whole /page tree in one call, each page carrying kind+size+
  ::  mtime so a client can build `<name>.<ext>` filenames without N fetches.
  ::  Browse can't help (every code grub's mark is `page`, kind-blind). Walks
  ::  read-tree, then per-page peeks the code grub (the read-recent pattern):
  ::  O(pages) local peeks, one HTTP round-trip.
      [%'GET' %page-tree]
    ;<  j=json  bind:m  fs-tree-json
    (send-json eyre-id j)
  ::
  ::  page-dump: page-tree PLUS every page's body inline, in ONE deep peek — warms
  ::  a filesystem client's whole read-cache so rg/grep run from RAM. Heavier than
  ::  page-tree; shape-only clients keep using page-tree.
      [%'GET' %page-dump]
    ;<  j=json  bind:m  fs-dump-json
    (send-json eyre-id j)
  ::
      [%'GET' %fetch]
    ::  read a published page. url=urb://~ship/rel. Own pages peek the local pub
    ::  vault; remote pages use grubbery peek-remote (clean break: the peer must
    ::  run the grubbery-native lattice — old %grow spurs are not read). case=~
    ::  gets the latest gained content, so there's no walk-to-latest.
    =/  raw=(unit @t)  (~(get by args) 'url')
    ?~  raw  (send-err eyre-id 400 'missing url param')
    =/  pu=(unit [=ship =path])  (parse-urb-url:lu u.raw)
    ?~  pu  (send-err eyre-id 400 'bad urb:// url')
    ;<  body=(unit @t)  bind:m  (read-page-body our ship.u.pu path.u.pu)
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
      ;<  sn=view:nexus  bind:m  (peek-shallow:io dir-road ~)
      ?.  ?=([%ball *] sn)  (send-err eyre-id 404 'not a directory')
      (send-json eyre-id (browse-json u.shp p.pp ball.sn))
    ;<  ms=(unit view:nexus)  bind:m  (peek-remote-shallow-wait dir-road u.shp)
    ?~  ms  (send-err eyre-id 504 'unreachable or denied')
    ?.  ?=([%ball *] u.ms)  (send-err eyre-id 404 'not a directory')
    (send-json eyre-id (browse-json u.shp p.pp ball.u.ms))
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
      ;<  sn=view:nexus  bind:m  (peek:io file-road ~)
      (browse-file-respond eyre-id sn)
    ;<  ms=(unit view:nexus)  bind:m  (peek-remote-wait file-road u.shp)
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
    =/  pu=(unit [=ship =path])  (parse-urb-url:lu u.url)
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
      [%'GET' %'prism.js']
    ;<  pv=view:nexus  bind:m  (peek:io [%& %& app-base:lu %'prism.js'] ~)
    ?.  ?=([%file *] pv)  (send-err eyre-id 404 'not found')
    =/  res=(each mime tang)  (mule |.(!<(mime (need-vase:tarball sang.pv))))
    ?:  ?=(%| -.res)  (send-err eyre-id 500 'bad asset')
    %+  send-simple:srv  eyre-id
    :-  [200 ~[['content-type' 'text/javascript'] ['cache-control' 'private, max-age=3600']]]
    `q.p.res
      [%'GET' %'manifest.webmanifest']
    (send-typed eyre-id 'application/manifest+json' 'no-cache' manifest-json)
      [%'GET' %'sw.js']
    (send-sw eyre-id sw-js)
      [%'GET' %'icon.svg']
    (send-typed eyre-id 'image/svg+xml' 'public, max-age=86400' icon-svg)
      [%'GET' %'apple-touch-icon.png']
    (send-png eyre-id apple-icon-b64)
      [%'GET' %edit]
    ::  the editor moved to the lattice-hosted app (ui-app/). Preserve deep
    ::  links: ?name= opens the page, ?into= starts a new file in a folder;
    ::  kind/newfolder are app-internal now.
    =/  name=(unit @t)  (~(get by args) 'name')
    =/  into=(unit @t)  (~(get by args) 'into')
    =/  target=tape
      ?^  name  (weld "/apps/lattice/app?name=" (trip u.name))
      ?^  into  (weld "/apps/lattice/app?into=" (trip u.into))
      "/apps/lattice/app"
    (send-redirect eyre-id target)
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
    ::  page (the editor's new-page mode sends it; caught by review). Only the
    ::  new=1 path pays the existence peek — a plain overwrite (every autosave)
    ::  never used the answer.
    ;<  ex=?  bind:m
      ?.  (~(has by args) 'new')  (pure:(fiber:fiber:nexus ,?) %.n)
      (peek-exists:io [%& %& (weld app-base:lu (weld /page (pax-of u.name))) %code])
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
    (send-html eyre-id (render-bare (preview-inner ptype body)))
      [%'POST' %page-cmd]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    ::  404 a command to a nonexistent page (the writer guards too, but this
    ::  gives the client real feedback instead of a fire-and-forget 200).
    ;<  ex=?  bind:m  (peek-exists:io [%& %& (weld app-base:lu (weld /page (pax-of u.name))) %code])
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
  ::  page-move: server-side move/rename of a page or a whole folder subtree.
  ::  Replaces the old client choreography (page-source + page-save + page-del
  ::  per page, folder-new per folder — 3N+M round-trips at ~2s each) with one
  ::  request. Share modes carry over; wikilink self-references are rewritten
  ::  the same way template instantiation rewrites its root.
      [%'POST' %page-move]
    =/  from=(unit @t)  (~(get by args) 'from')
    =/  to=(unit @t)    (~(get by args) 'to')
    ?~  from  (send-err eyre-id 400 'missing from')
    ?~  to    (send-err eyre-id 400 'missing to')
    ?.  &((valid-name u.from) (valid-name u.to))  (send-err eyre-id 400 'bad name')
    ?:  =(u.from u.to)  (send-err eyre-id 400 'same name')
    =/  pf=path  (pax-of u.from)
    =/  pt=path  (pax-of u.to)
    ?:  &((gth (lent pt) (lent pf)) =(pf `path`(scag (lent pf) `path`pt)))
      (send-err eyre-id 400 'cannot move under itself')
    ;<  n=(unit @ud)  bind:m  (move-pages pf pt)
    ?~  n  (send-err eyre-id 404 'no such page or folder')
    (send-json eyre-id (pairs:enjs:format ~[['moved' (numb:enjs:format u.n)]]))
      [%'POST' %page-share]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    =/  mode=share-mode:le
      ?+  (~(gut by args) 'mode' 'private')  %private
        %shared    %shared
        %clearweb  %clearweb
      ==
    ;<  ex=?  bind:m  (peek-exists:io [%& %& (weld app-base:lu (weld /page (pax-of u.name))) %code])
    ?.  ex  (send-err eyre-id 404 'no such page')
    ;<  ~  bind:m  (poke-eval [%share (pax-of u.name) mode])
    ?.  (~(has by args) 'web')  (send-ok eyre-id)
    %+  send-see-other  eyre-id
    :(weld "/apps/lattice/x/" (scow %p our) "/apps/lattice.lattice_app/page/" (trip u.name) "/")
      ::  owner: turn PUBLIC FORM submissions on/off at a page or folder. Same
      ::  nearest-flag-wins shape as comments. Off by default: a page is only
      ::  publicly writable when the owner says so AND it is clearweb.
      [%'POST' %page-forms]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    ::  cap=0 (default) means no absolute limit; gap is in SECONDS, 0 = none.
    =/  cap=@ud  (fall (rush (~(gut by args) 'cap' '0') dim:ag) 0)
    =/  gaps=@ud  (fall (rush (~(gut by args) 'gap' '0') dim:ag) 0)
    ;<  ~  bind:m
      %-  poke-eval
      :^  %forms  (pax-of u.name)  =('1' (~(gut by args) 'on' '0'))
      [cap (mul gaps ~s1)]
    (send-ok eyre-id)
      ::  owner: a page's form limits and how much of the cap is used.
      [%'GET' %page-forms]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    ;<  on=?             bind:m  (forms-on (pax-of u.name))
    ;<  cfg=form-cfg:le  bind:m  (read-form-cfg (pax-of u.name))
    ;<  use=form-use:le  bind:m  (read-form-use (pax-of u.name))
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  ['on' b+on]
        ['cap' (numb:enjs:format cap.cfg)]
        ['gap' (numb:enjs:format (div gap.cfg ~s1))]
        ['count' (numb:enjs:format count.use)]
        ['remaining' (numb:enjs:format ?:(=(0 cap.cfg) 0 (sub cap.cfg (min count.use cap.cfg))))]
    ==
      ::  owner: zero a page's submission counter (a cap you cannot reset is a
      ::  one-shot switch, not a limit).
      [%'POST' %page-forms-reset]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    ;<  ~  bind:m  (poke-eval [%form-reset (pax-of u.name)])
    (send-ok eyre-id)
      ::  owner: turn comments on/off at a page or folder (on=1 / on=0). The
      ::  nearest flag at/above a page decides, so a folder toggles a whole site.
      [%'POST' %page-comments]
    =/  name=(unit @t)  (~(get by args) 'name')
    ?~  name  (send-err eyre-id 400 'missing name')
    ?.  (valid-name u.name)  (send-err eyre-id 400 'bad name')
    ;<  ex=?  bind:m  (peek-exists:io [%& %| (weld app-base:lu (weld /page (pax-of u.name)))])
    ?.  ex  (send-err eyre-id 404 'no such page or folder')
    ;<  ~  bind:m  (poke-eval [%comments (pax-of u.name) =('1' (~(gut by args) 'on' '0'))])
    (send-ok eyre-id)
      ::  owner commenting on their OWN page (author = us). Other ships comment
      ::  through the public inbox fiber. body is the raw POST body.
      [%'POST' %comment]
    =/  page=(unit @t)  (~(get by args) 'page')
    ?~  page  (send-err eyre-id 400 'missing page')
    ?.  (valid-name u.page)  (send-err eyre-id 400 'bad page')
    ::  the box POSTs a form (body=<urlencoded>); parse it like page-cmd does.
    =/  fargs=(map @t @t)
      (malt args:(parse-url:http-utils (crip (weld "/?" (trip (req-body req))))))
    =/  body=@t  (~(gut by fargs) 'body' '')
    ?:  =('' body)  (send-err eyre-id 400 'missing body')
    ;<  ~  bind:m  (poke-comment [(pax-of u.page) body])
    ::  303 back to the page (target=_top on the box), so it reloads with the new
    ::  comment. The write is a separate transaction, so a stale reload just needs
    ::  a refresh — acceptable, like page-cmd.
    %+  send-see-other  eyre-id
    :(weld "/apps/lattice/x/" (scow %p our) "/apps/lattice.lattice_app/page/" (trip u.page) "/")
      ::  bookmark the current browser url (title defaults to the url). Newest
      ::  first, deduped by url. Shown under Browser on the home page.
      [%'POST' %bookmark]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url')
    =/  title=@t  (~(gut by args) 'title' u.url)
    ;<  ~  bind:m  (poke-bookmark [%add u.url title])
    (send-ok eyre-id)
      [%'POST' %unbookmark]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url')
    ;<  ~  bind:m  (poke-bookmark [%del u.url])
    (send-ok eyre-id)
  ::  ── /clip: archive a clearweb page AS a lattice page ───────────────────
  ::  A bookmark stores a link; this stores the page. The ship fetches the url
  ::  itself over iris, converts the html to markdown, and writes a normal
  ::  private page under clips/ — editable, searchable and shareable like any
  ::  other, because it IS any other.
  ::
  ::  GET, not POST, because the whole point is that a bookmarklet reaches it
  ::  by top-level navigation: eyre's session cookie carries no SameSite
  ::  attribute, so a navigation sends it where a cross-site POST would not.
  ::  That does leave it CSRF-reachable (an <img src=…/clip?url=> on a hostile
  ::  page would archive a page of the attacker's choosing), which is noise in
  ::  the owner's own tree, not disclosure — the fetched body never travels
  ::  back to the attacker. +http-url is the real boundary: it keeps `file:`
  ::  and friends away from iris on both the initial url and the redirect.
      [%'GET' %clip]
    =/  url=(unit @t)  (~(get by args) 'url')
    ?~  url  (send-err eyre-id 400 'missing url')
    ?.  (http-url u.url)  (send-err eyre-id 400 'url must be http:// or https://')
    ;<  got=(unit @t)  bind:m  (fetch-url u.url)
    ?~  got  (send-err eyre-id 502 'could not fetch that page')
    =/  ttl=@t  (fall (page-title:lcl u.got) u.url)
    ;<  free=(unit path)  bind:m  (clip-free (clip-slug u.url))
    ?~  free  (send-err eyre-id 409 'that url is already archived 10 times')
    ;<  now=@da  bind:m  bowl-now
    =/  dt  (yore now)
    =/  pad  |=(n=@ud ^-(tape ?:((lth n 10) ['0' (a-co:co n)] (a-co:co n))))
    =/  day=tape  :(weld (a-co:co y.dt) "-" (pad m.dt) "-" (pad d.t.dt))
    ::  provenance header: where it came from and when. An archive with no
    ::  source url is just an unattributed copy of someone else's writing.
    =/  nl=tape  (trip '\0a')
    =/  body=@t
      %-  crip
      ;:  weld
        "# "  (trip ttl)  nl  nl
        "*archived from <"  (trip u.url)  "> on "  day  "*"  nl  nl
        "---"  nl  nl
        (trip (to-md:lcl u.got))
      ==
    ;<  ~  bind:m  (poke-eval [%make u.free (wrap-content %gmi body)])
    ::  private by default — deliberately. Archiving someone else's page and
    ::  republishing it to the clearweb in one click is not a default anyone
    ::  should get by accident; the share control is one click away.
    =/  nom=tape  (pax-str u.free)
    %+  send-html  eyre-id
    %^  render-page  ""  ""
    ;:  weld
      "<h1>Archived</h1>"
      "<p>"  (esc (trip ttl))  "</p>"
      "<p class=\"muted\">saved privately as <code>"  (esc nom)  "</code></p>"
      "<p><a href=\"/apps/lattice/app\">open in the editor</a></p>"
    ==
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
      [%'POST' %template-del]
    =/  nm=(unit @t)  (~(get by args) 'name')
    ?~  nm  (send-err eyre-id 400 'missing name')
    ?.  ((sane %tas) u.nm)  (send-err eyre-id 400 'bad name')
    ;<  ~  bind:m  (poke-eval [%tmpl-del `@tas`u.nm])
    (send-ok eyre-id)
      ::  what templates exist, so a client can offer them by name.
      [%'GET' %template-list]
    ;<  sn=view:nexus  bind:m  (peek:io [%& %| (weld app-base:lu /template)] ~)
    =/  names=(list @ta)
      ?.  ?=([%ball *] sn)  ~
      (turn ~(tap by dir.ball.sn) |=([nom=@ta *] nom))
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  :-  'templates'
        a+(turn (sort names aor) |=(n=@ta s+`@t`n))
    ==
      [%'POST' %template-new]
    ::  instantiate a template into a new page-tree: template=<term>, name=<path>.
    =/  tmpl=(unit @t)  (~(get by args) 'template')
    =/  nm=(unit @t)    (~(get by args) 'name')
    ?~  tmpl  (send-err eyre-id 400 'missing template')
    ?~  nm    (send-err eyre-id 400 'missing name')
    ?.  ((sane %tas) u.tmpl)  (send-err eyre-id 400 'bad template')
    ?.  (valid-name u.nm)     (send-err eyre-id 400 'bad name')
    ;<  ex=?  bind:m
      (peek-exists:io [%& %& (weld app-base:lu (weld /page (pax-of u.nm))) %code])
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
    =/  rev=(unit @ud)  (rush u.rv dim:ag)
    ?~  rev  (send-err eyre-id 400 'bad rev')
    =/  ro=(unit road:tarball)  (pub-road u.raw)
    ?~  ro  (send-err eyre-id 400 'invalid path')
    ::  validate the rev against real history before peek-at (which bails on a miss).
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io u.ro [%numb ~ ~])
    ?:  ?=(%| -.pe)  (send-err eyre-id 404 'no history')
    ?.  (lien p.pe |=([c=cass:clay *] =(ud.c u.rev)))
      (send-err eyre-id 404 'no such revision')
    ;<  sn=view:nexus  bind:m  (peek-at:io u.ro ~ [%ud u.rev])
    ?.  ?=([%file *] sn)  (send-err eyre-id 404 'not found')
    =/  body=@t  !<(@t (need-vase:tarball sang.sn))
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
    =/  rev=(unit @ud)  (rush u.rv dim:ag)
    ?~  rev  (send-err eyre-id 400 'bad rev')
    =/  ro=(unit road:tarball)  (pub-road u.raw)
    ?~  ro  (send-err eyre-id 400 'invalid path')
    ;<  pe=(each (list [c=cass:clay s=sage:tarball]) tang)  bind:m
      (peep:io u.ro [%numb ~ ~])
    ?:  ?=(%| -.pe)  (send-err eyre-id 404 'no history')
    ?.  (lien p.pe |=([c=cass:clay *] =(ud.c u.rev)))
      (send-err eyre-id 404 'no such revision')
    ;<  sn=view:nexus  bind:m  (peek-at:io u.ro ~ [%ud u.rev])
    ?.  ?=([%file *] sn)  (send-err eyre-id 404 'not found')
    =/  body=@t  !<(@t (need-vase:tarball sang.sn))
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
      =/  k=(unit @ud)  (rush u.kp dim:ag)
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
    =/  rev=(unit @ud)  (rush u.rv dim:ag)
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
    ;<  sn=view:nexus  bind:m  (peek-at:io road.u.hr ~ [%ud u.rev])
    ?.  ?=([%file *] sn)  (send-err eyre-id 404 'not found')
    =/  e=know-entry:lk  !<(know-entry:lk (need-vase:tarball sang.sn))
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
    =/  rev=(unit @ud)  (rush u.rv dim:ag)
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
    ;<  sn=view:nexus  bind:m  (peek-at:io road.u.hr ~ [%ud u.rev])
    ?.  ?=([%file *] sn)  (send-err eyre-id 404 'not found')
    =/  e=know-entry:lk  !<(know-entry:lk (need-vase:tarball sang.sn))
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
      =/  k=(unit @ud)  (rush u.kp dim:ag)
      ?~(k ~ `(max 1 u.k))
    ?~  keep  (send-err eyre-id 400 'bad keep')
    =/  ko=(unit path)  (know-key u.raw)
    ?~  ko  (send-err eyre-id 400 'invalid key')
    =/  road=road:tarball  (entry-road (weld app-base:lu /know/vault) u.ko)
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
    =/  pu=(unit [=ship =path])  (parse-urb-url:lu u.raw)
    ?~  pu  (send-err eyre-id 400 'bad urb:// url')
    ?:  =(ship.u.pu our)  (send-err eyre-id 400 'cannot subscribe to own ship')
    ;<  ~  bind:m  (poke-sub [%sub-page ship.u.pu path.u.pu])
    (send-ok eyre-id)
  ::
      [%'POST' %unsub]
    =/  raw=(unit @t)  (~(get by args) 'url')
    ?~  raw  (send-err eyre-id 400 'missing url param')
    =/  pu=(unit [=ship =path])  (parse-urb-url:lu u.raw)
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
    =/  pu=(unit [=ship =path])  (parse-urb-url:lu u.raw)
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
      [%'GET' %settings]
    (send-html eyre-id (render-page "" "" settings-html))
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
  ::  ── editing arbitrary grubs (write apps in the editor) ──────────────────
  ::  grub-source: any grub's editable text. `editable` is false for a binary
  ::  or opaque grub — the client shows it read-only rather than offering a save
  ::  that would corrupt it.
      [%'GET' %grub-source]
    =/  raw=(unit @t)  (~(get by args) 'path')
    ?~  raw  (send-err eyre-id 400 'missing path')
    =/  ro=(unit [rod=road:tarball nom=@ta])  (grub-road u.raw)
    ?~  ro  (send-err eyre-id 400 'invalid path')
    ;<  vn=view:nexus  bind:m  (peek:io rod.u.ro ~)
    ?.  ?=([%file *] vn)  (send-err eyre-id 404 'no such grub')
    =/  txt=(unit @t)  (grub-text sang.vn)
    =/  blot=tape  (spud (rail-to-path:tarball p.sang.vn))
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  ['path' s+u.raw]
        ['blot' s+(crip blot)]
        ['editable' b+?=(^ txt)]
        ['text' s+(fall txt '')]
    ==
  ::  grub-save: overwrite an existing grub, or create one with new=1. The
  ::  extension picks the mark; conversion happens before the write, so bad
  ::  source is a 400 and the stored grub is untouched.
      [%'POST' %grub-save]
    =/  raw=(unit @t)  (~(get by args) 'path')
    ?~  raw  (send-err eyre-id 400 'missing path')
    =/  ro=(unit [rod=road:tarball nom=@ta])  (grub-road u.raw)
    ?~  ro  (send-err eyre-id 400 'invalid path')
    =/  fresh=?  =('1' (~(gut by args) 'new' '0'))
    ::  a full peek, not peek-exists: an overwrite needs the grub's CURRENT blot
    ::  (and content-type, if it is a mime grub) so the save cannot retype it.
    ;<  vn=view:nexus  bind:m  (peek:io rod.u.ro ~)
    =/  ex=?  ?=([%file *] vn)
    ?:  &(fresh ex)      (send-err eyre-id 409 'already exists')
    ?:  &(!fresh !ex)    (send-err eyre-id 404 'no such grub')
    =/  body=@t  (req-body req)
    ;<  bk=(each bask:tarball tang)  bind:m
      ?.  ?=([%file *] vn)
        ::  new file: nothing to preserve, so the extension picks the mark
        (grub-bask nom.u.ro body)
      (grub-bask-into p.sang.vn (grub-mime-type sang.vn) body)
    ?:  ?=(%| -.bk)
      ::  the mark rejected the source. Report it so the editor can show it; the
      ::  grub still holds its previous content.
      ::  +obelisk-tang-text is a generic tang -> cord despite the name.
      (send-err eyre-id 400 (obelisk-tang-text p.bk))
    ;<  ~  bind:m
      ?:  ex  (over:io rod.u.ro p.bk)
      (make:io rod.u.ro |+[p.bk ~])
    (send-ok eyre-id)
  ::  grub-folder: create a directory — how a NEW app starts, since an app is
  ::  just a folder of grubs under /apps.
      [%'POST' %grub-folder]
    =/  raw=(unit @t)  (~(get by args) 'path')
    ?~  raw  (send-err eyre-id 400 'missing path')
    =/  pp=(each path tang)  (mule |.((stab u.raw)))
    ?:  ?=(%| -.pp)  (send-err eyre-id 400 'invalid path')
    ?~  p.pp  (send-err eyre-id 400 'invalid path')
    ;<  ex=?  bind:m  (peek-exists:io [%& %| p.pp])
    ?:  ex  (send-err eyre-id 409 'already exists')
    ::  +ensure-dirs walks the whole chain, so a new app's nested folders come
    ::  up in one call and it is idempotent if a parent already exists.
    ;<  ~  bind:m  (ensure-dirs ~ p.pp)
    (send-ok eyre-id)
  ::  ── unified search (the omnibar's private half) ─────────────────────────
  ::  content-search: own pages + knowledge entries carrying `term`, each row
  ::  labelled with the visibility recorded at index time. Same JSON shape as
  ::  /catalog-search so the omnibar can fan out over both identically.
  ::
  ::  Owner-gated like every route below the gate — which is what makes it safe
  ::  to return private rows at all. The results page is served from the root
  ::  route, also behind the gate; the only unauthenticated surfaces (clearweb
  ::  /c/, public form POST /f/, PWA assets) dispatch above it.
      [%'GET' %content-search]
    =/  term=(unit @t)  (~(get by args) 'term')
    ?~  term  (send-err eyre-id 400 'missing term param')
    =/  nt=(unit @t)  (catalog-normalize-term:cat (trip u.term))
    ::  a non-indexable term (too short / stop word) matches nothing — 200 with
    ::  no rows, NOT a 400, so a client fanning out one call per query word
    ::  doesn't error on a common stop word. Mirrors /catalog-search.
    ?~  nt
      %+  send-json  eyre-id
      %-  pairs:enjs:format
      :~  ['ok' b+&]
          ['columns' a+(turn ~['scope' 'key' 'tf'] |=(c=@t s+c))]
          ['rows' a+~]
      ==
    ;<  cs=(each (list cmd-result:ast) tang)  bind:m
      (obelisk-query catalog-db (content-search-urql:cat (trip u.nt)))
    (send-obelisk eyre-id cs)
  ::  search-reindex: rebuild content-terms from the live tree + know vault.
  ::  Blocking (the client treats it fire-and-forget), like /know-reindex.
      [%'POST' %search-reindex]
    ;<  ok=?  bind:m  content-reindex
    ?.  ok
      (send-err eyre-id 502 'obelisk is not answering — nothing was indexed')
    (send-ok eyre-id)
  ::  ── legacy agent migration (see the +legacy-live block) ────────────────
  ::  legacy-status: should the UI offer to import from a retired %lattice
  ::  gall agent? One %gu liveness scry and nothing else — see below. The
  ::  client asks once per browser session and never again once resolved.
      [%'GET' %legacy-status]
    ;<  done=?  bind:m  legacy-resolved
    ?:  done
      (send-json eyre-id (pairs:enjs:format ~[['prompt' b+|] ['reason' s+'resolved']]))
    ::  %gu ONLY. This route runs on the editor's boot path, and a %gx against
    ::  an agent whose version lacks the arm does not fail gracefully — it
    ::  unwinds the Arvo event. Liveness is the one thing %gu can answer
    ::  safely, so the counts (and every peek that could bail) move behind the
    ::  user's explicit click in /legacy-migrate.
    ;<  up=?  bind:m  legacy-live
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  ['prompt' b+up]
        ['reason' s+?:(up 'agent-present' 'absent')]
    ==
  ::  legacy-migrate: copy the retired agent's knowledge in. Entries whose key
  ::  ALREADY exists here are SKIPPED, never overwritten — the live store is
  ::  always the newer one, and a legacy body must never revert an edit made
  ::  since. That also makes a re-run harmless.
      [%'POST' %legacy-migrate]
    ;<  done=?  bind:m  legacy-resolved
    ?:  done  (send-err eyre-id 409 'already resolved')
    ;<  up=?  bind:m  legacy-live
    ?.  up  (send-err eyre-id 404 'no legacy agent')
    ;<  aj=json  bind:m  (legacy-peek /gx/lattice/know/all/json)
    =/  parsed=(each (list [@t know-entry:lk]) tang)  (mule |.((parse-import aj)))
    ?:  ?=(%| -.parsed)  (send-err eyre-id 502 'bad legacy export shape')
    ::  FAIL CLOSED. +read-know-map maps ANY unreadable view onto the empty
    ::  map, which is indistinguishable from a legitimately empty store — and
    ::  "empty" would mean every legacy entry imports over live data. Use the
    ::  unit-returning read so a genuine read FAILURE refuses the import, while
    ::  a real (readable) empty store still migrates normally.
    ;<  esu=(unit (map path know-entry:lk))  bind:m  read-know-vault-safe
    ?~  esu  (send-err eyre-id 503 'local store unreadable; import refused')
    =/  es=(map path know-entry:lk)  u.esu
    ::  skip anything we already hold LIVE or in TRASH — importing over a
    ::  soft-deleted key would resurrect what the user deleted here.
    ;<  tx=know-index:lk  bind:m  (read-index [%| 2 %& /know %trash])
    =/  fresh=(list [@t know-entry:lk])
      %+  skim  p.parsed
      |=  [k=@t *]
      =/  ko=(unit path)  (know-key k)
      ?~(ko %.n ?!(|((~(has by es) u.ko) (~(has by tx) u.ko))))
    ;<  n=@ud  bind:m  (import-know-loop fresh 0)
    ::  ── pages ────────────────────────────────────────────────────────────
    ::  Scoped to the rels the agent itself reports. ~ means we could not read
    ::  its page list at all: treat that as UNKNOWN, never as "no pages", or
    ::  the completion dialog would clear an agent that still holds the only
    ::  copy of them.
    ;<  prels=(unit (list path))  bind:m  legacy-page-rels
    =/  want=(list path)  ?~(prels ~ u.prels)
    ::  never let a legacy body land on a page we already have: %save-page is
    ::  an unconditional upsert in the writer, so a name collision would
    ::  overwrite the user's own published body. Drop collisions before
    ::  triggering and report them as left-behind.
    ;<  live-pages=(list path)  bind:m  (page-sources-present want)
    ::  A legacy name can also collide with a page this nexus published but
    ::  never had a source for (POST /save, know-publish). %save-page is an
    ::  unconditional upsert, so triggering would overwrite the user's body.
    ::  Anything ALREADY in the vault is therefore off limits — unless a prior
    ::  run of this migration is what put it there.
    ;<  prior=(list path)  bind:m  legacy-triggered
    ;<  in-vault=(list path)  bind:m  (vault-present want)
    =/  has  |=([l=(list path) r=path] (lien l |=(x=path =(x r))))
    =/  theirs=(list path)
      (skip in-vault |=(r=path (has prior r)))
    =/  fresh-pages=(list path)
      %+  skip  want
      |=(r=path |((has live-pages r) (has theirs r)))
    =/  nil  (fiber:fiber:nexus ,~)
    ::  read the bodies directly (see +legacy-page-bodies) and write each one
    ::  as a normal page. No poke, no waiting on another agent's cards, and no
    ::  window in which arrivals can be missed: what we read is what we write.
    ;<  bodies=(unit (list [rel=path body=@t]))  bind:m
      ?:  =(~ fresh-pages)
        (pure:(fiber:fiber:nexus ,(unit (list [rel=path body=@t]))) `~)
      legacy-page-bodies
    ;<  ~  bind:m
      ?:  =(~ fresh-pages)  (pure:nil ~)
      (poke-eval [%legacy-pages (weld prior fresh-pages)])
    ;<  promoted=@ud  bind:m
      ?~  bodies  (pure:(fiber:fiber:nexus ,@ud) 0)
      (write-legacy-pages (skim u.bodies |=([r=path *] (has fresh-pages r))) 0)
    ::  ONLY claim the migration is finished when nothing is left behind. A
    ::  short count leaves the marker UNWRITTEN so the offer returns and the
    ::  user can retry — the knowledge import is idempotent (skip-existing),
    ::  so a retry costs nothing and finishes the pages.
    =/  page-total=@ud  (lent want)
    ::  "complete" means: we could read the page list, and every page we were
    ::  allowed to move actually landed AND was promoted. Collisions count as
    ::  NOT complete — those pages stay only in the old agent, so the agent
    ::  must not be cleared for retirement.
    =/  done=?
      ?&  ?=(^ prels)
          ?=(^ bodies)
          =(promoted (lent fresh-pages))
          =(0 (lent live-pages))
          =(0 (lent theirs))
      ==
    ;<  ~  bind:m  ?:(done (poke-eval [%legacy-seen n]) (pure:nil ~))
    %+  send-json  eyre-id
    %-  pairs:enjs:format
    :~  ['imported' (numb:enjs:format n)]
        ['skipped' (numb:enjs:format (sub (lent p.parsed) (lent fresh)))]
        ['pages' (numb:enjs:format page-total)]
        ['pagesImported' (numb:enjs:format promoted)]
        ['pagesCollided' (numb:enjs:format (add (lent live-pages) (lent theirs)))]
        ::  why the trigger failed, when it did — the difference between
        ::  "no pages arrived" and knowing the poke was refused
        :-  'pageError'
        ?~  bodies  s+'could not read the old agent\'s pages'
        ~
        ['pagesKnown' b+?=(^ prels)]
        ['complete' b+done]
    ==
  ::  legacy-dismiss: the user declined. Same marker as a completed import, so
  ::  the prompt never returns.
      [%'POST' %legacy-dismiss]
    ;<  ~  bind:m  (poke-eval [%legacy-seen 0])
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
::  ── legacy %lattice gall agent (pre-grubbery) ─────────────────────────────
::  A ship that ran the standalone agent before the nexus may still have it
::  installed, holding knowledge the nexus never saw. We offer a one-time
::  in-app import rather than migrating silently: the entries are the user's,
::  and which store they want them in is their call.
::
::  DETECTION IS %gu, NEVER a bare %gx. A %gx against an absent agent BAILS,
::  and a bail here crashes the whole Arvo event (the same trap documented on
::  +obelisk-exec). %gu answers %.n instead. So: liveness first, peek second.
::
++  legacy-live
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  (typed-scry:io ? %loob /gu/lattice/$)
::  +legacy-peek: read one of the retired agent's export arms. ONLY call this
::  behind a +legacy-live check.
++  legacy-peek
  |=  pax=path
  =/  m  (fiber:fiber:nexus ,json)
  ^-  form:m
  (typed-scry:io json %json pax)
::  +legacy-mark: the "done with the old agent" marker. Its EXISTENCE is the
::  whole signal (the body is detail for humans), so the read is a peek-exists
::  and can never mis-parse. Written on a completed import AND on an explicit
::  dismissal, so neither path ever prompts again.
++  legacy-mark-road  ^-(road:tarball [%& %& (weld app-base:lu /legacy) %state])
++  legacy-resolved
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  (peek-exists:io legacy-mark-road)
::  +legacy-pages: how many PAGES the retired agent still holds. This import
::  moves knowledge only — the old agent exposes no arm for page BODIES
::  (%published and %live-list give paths and hashes, nothing more) — so pages
::  stay behind. We count them because a user who retires the agent while pages
::  remain loses them permanently, and the completion dialog has to say so.
::  Called ONLY from /legacy-migrate, never on the boot path: like every %gx it
::  can bail on an agent whose version lacks the arm, so it stays behind the
::  user's explicit click.
++  legacy-pages
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  pj=json  bind:m  (legacy-peek /gx/lattice/live-list/json)
  =/  r=(each @ud tang)
    (mule |.(((ot:dejs:format count+ni:dejs:format ~) pj)))
  (pure:m ?:(?=(%| -.r) 0 p.r))
::  ── legacy PAGE migration ─────────────────────────────────────────────────
::  The retired agent exposes no scry arm for page BODIES, and %grow'n content
::  is not served on %gx (both verified). It does still carry its phase-1
::  endpoint POST /pub-migrate, which emits one `%save-page` poke per page at
::  this nexus's writer — a native pub-action, so bodies land in /pub/vault.
::  That endpoint is HTTP-only and grubbery shadows /apps/lattice, so we hand
::  the agent the request as a poke.
::
::  EVERYTHING here is scoped to the page paths the agent itself reports. An
::  earlier draft promoted the whole vault and derived its counts from it,
::  which conflated the user's OWN published pages with legacy arrivals and
::  could report success while pages were still only in the old agent.
::
::  +legacy-key-rel: a legacy content key ('/pub/index/gmi') -> the nexus page
::  rel (/index). ~ for anything that is not that shape.
++  legacy-key-rel
  |=  k=@t
  ^-  (unit path)
  =/  pu=(unit path)  (mole |.(`path`(stab k)))
  ?~  pu  ~
  ?.  ?=([%pub *] u.pu)  ~
  ?~  t.u.pu  ~
  ::  re-widen after the ?~: scag/rear are wet gates and mull-grow against the
  ::  narrowed (non-null) type, which is a nest-fail at the call site.
  =/  r=path  `path`t.u.pu
  ?.  =(%gmi (rear r))  ~
  ?:  =(1 (lent r))  ~
  `(scag (dec (lent r)) r)
::  +legacy-page-rels: the pages the retired agent holds, as nexus rels. A
::  shape mismatch yields ~, which callers MUST treat as "unknown", never as
::  "none" — reporting zero pages is what would wrongly clear the agent for
::  uninstall.
++  legacy-page-rels
  =/  m  (fiber:fiber:nexus ,(unit (list path)))
  ^-  form:m
  ;<  pj=json  bind:m  (legacy-peek /gx/lattice/live-list/json)
  =/  r=(each (list @t) tang)
    (mule |.(((ot:dejs:format paths+(ar:dejs:format so:dejs:format) ~) pj)))
  ?:  ?=(%| -.r)  (pure:m ~)
  (pure:m `(murn p.r legacy-key-rel))
::  +legacy-triggered: page rels a previous run already triggered. These are
::  known to be migration-origin, so a vault entry for one of them is ours to
::  promote rather than a pre-existing page of the user's to protect.
++  legacy-triggered
  =/  m  (fiber:fiber:nexus ,(list path))
  ^-  form:m
  ;<  sn=view:nexus  bind:m
    (peek:io [%& %& (weld app-base:lu /legacy) %pages] ~)
  ?.  ?=([%file *] sn)  (pure:m ~)
  =/  j=(unit json)  (mole |.(;;(json (sang-noun:tarball sang.sn))))
  ?~  j  (pure:m ~)
  =/  r=(each (list @t) tang)  (mule |.(((ar:dejs:format so:dejs:format) u.j)))
  ?:  ?=(%| -.r)  (pure:m ~)
  (pure:m (murn p.r |=(c=@t (mole |.(`path`(stab c))))))
::  +legacy-page-bodies: the retired agent's page bodies, by SCRY.
::
::  The deployed agents carry a `[%x %content ~]` peek that dumps the content
::  map as {spat-key: gemtext} — the temporary migration arm from the original
::  cutover. That is the same %gx mechanism the knowledge import uses, and it
::  needs nothing from the agent beyond a read.
::
::  This replaces an earlier design that poked the agent's own /pub-migrate
::  endpoint. That endpoint does not exist in the deployed version (state-10
::  has no pub-migrate at all), so the poke was delivered, matched no route,
::  404'd, emitted nothing, and acked positively — a silent no-op that cost a
::  long debugging cycle. Read what the agent actually exposes.
::
++  legacy-page-bodies
  =/  m  (fiber:fiber:nexus ,(unit (list [rel=path body=@t])))
  ^-  form:m
  ;<  cj=json  bind:m  (legacy-peek /gx/lattice/content/json)
  =/  r=(each (map @t @t) tang)
    (mule |.(((om:dejs:format so:dejs:format) cj)))
  ?:  ?=(%| -.r)  (pure:m ~)
  %-  pure:m
  :-  ~
  %+  murn  ~(tap by p.r)
  |=  [k=@t v=@t]
  ^-  (unit [path @t])
  =/  ko=(unit path)  (legacy-key-rel k)
  ?~  ko  ~
  ?:  =('' v)  ~
  `[u.ko v]
::  +await-vault: wait for `rels` to appear in the vault, checking every 2s up
::  to `tries`. Replaces a fixed sleep: the arrivals are one writer
::  transaction per page, so the time needed scales with page count, and a
::  fixed window would strand the tail.
++  await-vault
  |=  [rels=(list path) tries=@ud]
  =/  m  (fiber:fiber:nexus ,(list path))
  ^-  form:m
  |-  ^-  form:m
  ;<  here=(list path)  bind:m  (vault-present rels)
  ?:  =((lent here) (lent rels))  (pure:m here)
  ?:  =(0 tries)  (pure:m here)
  ;<  ~  bind:m  (sleep:io ~s2)
  $(tries (dec tries))
::  +vault-present: which of `rels` currently have a vault body.
++  vault-present
  |=  rels=(list path)
  =/  m  (fiber:fiber:nexus ,(list path))
  ^-  form:m
  ?~  rels  (pure:m ~)
  ;<  ex=?  bind:m
    (peek-exists:io [%& %& (weld (weld app-base:lu /pub/vault) i.rels) %gmi])
  ;<  rest=(list path)  bind:m  $(rels t.rels)
  (pure:m ?:(ex [i.rels rest] rest))
::  +page-sources-present: which of `rels` already exist as editable pages.
::  Used to refuse a legacy page whose name collides with one of ours, since
::  the writer's %save-page is an unconditional upsert.
++  page-sources-present
  |=  rels=(list path)
  =/  m  (fiber:fiber:nexus ,(list path))
  ^-  form:m
  ?~  rels  (pure:m ~)
  ;<  ex=?  bind:m
    (peek-exists:io [%& %& (weld app-base:lu (weld /page i.rels)) %code])
  ;<  rest=(list path)  bind:m  $(rels t.rels)
  (pure:m ?:(ex [i.rels rest] rest))
::  +write-legacy-pages: create an editable page per legacy body. Skips any
::  rel that already has a source — the collision guard runs before this, but
::  the check is cheap and this must never overwrite a page of the user's.
++  write-legacy-pages
  |=  [items=(list [rel=path body=@t]) made=@ud]
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ?~  items  (pure:m made)
  =/  pdir=path  (weld app-base:lu (weld /page rel.i.items))
  ;<  ex=?  bind:m  (peek-exists:io [%& %& pdir %code])
  ?:  ex  $(items t.items)
  ::  the editable source…
  ;<  ~  bind:m  (poke-eval [%make rel.i.items (wrap-content %gmi body.i.items)])
  ::  …AND publish it. These pages were PUBLISHED in the old agent — that is
  ::  what made the urb:// links between them resolve. Creating only the source
  ::  leaves the vault empty, so every internal link 404s and the pages look
  ::  migrated but broken. %save-page writes the vault grub and gains it,
  ::  restoring exactly the visibility they already had.
  ;<  ~  bind:m
    (poke-pub [%save-page (spat (pub-path (crip (pax-str rel.i.items)))) body.i.items])
  $(items t.items, made +(made))
::  +promote-pages: create an editable /page source for each named rel that
::  has a vault body and no source yet. SCOPED to the rels passed in - never
::  walks the whole vault, so it can neither resurrect a page the user deleted
::  nor manufacture pages from their own published-only content.
++  promote-pages
  |=  rels=(list path)
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  =|  made=@ud
  |-  ^-  form:m
  ?~  rels  (pure:m made)
  =/  pdir=path  (weld app-base:lu (weld /page i.rels))
  ;<  ex=?  bind:m  (peek-exists:io [%& %& pdir %code])
  ?:  ex  $(rels t.rels)
  ;<  vn=view:nexus  bind:m
    (peek:io [%& %& (weld (weld app-base:lu /pub/vault) i.rels) %gmi] ~)
  ?.  ?=([%file *] vn)  $(rels t.rels)
  =/  body=@t  (fall (mole |.(;;(@t (sang-noun:tarball sang.vn)))) '')
  ?:  =('' body)  $(rels t.rels)
  ;<  ~  bind:m  (poke-eval [%make i.rels (wrap-content %gmi body)])
  $(rels t.rels, made +(made))
::  ── editing arbitrary grubs (write apps in the lattice editor) ─────────
::
::  The editor's own pages are /page/<rel>/code grubs. These arms let it open
::  and save ANY grub in the ball, so an app's html/js/css/hoon can be written
::  here instead of uploaded.
::
::  The write is the delicate part. `over` handed a mime bask does NOT reliably
::  convert to the target blot: with no warm tube it silently REPLACES the
::  grub's blot with /mime. Verified on a scratch grub — writing hoon source
::  over a /hoon grub left `[mark: /mime]`, after which every later save was
::  refused ("blot differs"), so a single typo permanently changed the file's
::  type and locked out the fix. So the conversion is done HERE, explicitly:
::  fetch the extension's tube, apply it inside +mule, and only write once it
::  has produced a value. A tube failure (unparseable hoon) becomes a 400 with
::  the error and leaves the grub untouched — which also avoids `over`'s other
::  trap, that a failed dart fails the whole request fiber and grubbery emits
::  no response for it, hanging the browser.
::
::  +grub-road: a ball path -> the road of the grub at it, plus its filename
::  (the caller needs the name to pick a mark, and digging it back out of a
::  road means three `p.`s through two `each`es). ~ for the root or a path
::  `stab` cannot parse.
++  grub-road
  |=  raw=@t
  ^-  (unit [rod=road:tarball nom=@ta])
  ::  accept both `/apps/x/y` and `apps/x/y` — +stab needs the leading slash,
  ::  and a hand-typed or link-built path is easy to get wrong either way.
  ::  NOT (cat 3 '/' raw): `cat` is the face of the imported catalog library,
  ::  which shadows the stdlib gate — the same collision `lk` caused before.
  ::  +end takes an explicit bite here, as it does everywhere else in this file.
  =/  abs=@t  ?:(=('/' (end [3 1] raw)) raw (crip ['/' (trip raw)]))
  =/  pp=(each path tang)  (mule |.((stab abs)))
  ?:  ?=(%| -.pp)  ~
  ?~  p.pp  ~
  =/  p=path  `path`p.pp
  =/  nom=@ta  (rear p)
  `[[%& %& (snip p) nom] nom]
::  +grub-ext: a filename's extension, '' when it has none. Used to pick the
::  mark to convert into, the same rule the explorer's upload uses.
++  grub-ext
  |=  nom=@ta
  ^-  @ta
  =/  t=tape  (flop (trip nom))
  =/  pre=tape
    |-  ^-  tape
    ?~  t  ~
    ?:  =('.' i.t)  ~
    [i.t $(t t.t)]
  ::  no dot at all -> no extension (flop consumed the whole name)
  ?:  =((lent pre) (met 3 nom))  ''
  (crip (flop pre))
::  +grub-text: a grub's editable text, or ~ when it has none. A cord grub
::  (hoon, md, css, js — the %hoon mark stores SOURCE, not an AST) reads
::  directly; a mime grub goes through +mime-text, which refuses binary.
++  grub-text
  |=  =sang:tarball
  ^-  (unit @t)
  =/  nn=*  (sang-noun:tarball sang)
  =/  c=(each @t tang)  (mule |.(;;(@t nn)))
  ?:  ?=(%& -.c)  `p.c
  =/  mm=(each mime tang)  (mule |.(;;(mime nn)))
  ?.  ?=(%& -.mm)  ~
  (mime-text p.p.mm q.p.mm)
::  +grub-mime-type: a mime grub's content-type, ~ if it is not a mime grub.
::  Needed so an overwrite can put the type back exactly as it was.
++  grub-mime-type
  |=  =sang:tarball
  ^-  (unit path)
  =/  mm=(each mime tang)  (mule |.(;;(mime (sang-noun:tarball sang))))
  ?.  ?=(%& -.mm)  ~
  `p.p.mm
::  +grub-bask-into: text -> a bask carrying `dst`, the blot the grub ALREADY
::  has. An overwrite must not change a file's type: the existing calendar.html
::  is a /mime grub, while a freshly created .html gets the `html` mark, so
::  deciding the blot from the extension would silently retype another app's
::  file on the first save. A mime grub also keeps its own content-type rather
::  than being reset to text/plain.
++  grub-bask-into
  |=  [dst=blot:tarball orig=(unit path) body=@t]
  =/  m  (fiber:fiber:nexus ,(each bask:tarball tang))
  ^-  form:m
  ?:  =([/ %mime] dst)
    =/  mt=path  (fall orig /text/plain)
    (pure:m [%& [/ %mime] [mt (as-octs:mimes:html body)]])
  =/  mim=mime  [/text/plain (as-octs:mimes:html body)]
  ;<  tu=(unit tube:clay)  bind:m
    (get-tube:io [%& %| /code] [[/ %mime] dst])
  ?~  tu
    =/  d=tape  (spud (rail-to-path:tarball dst))
    (pure:m [%| ~[leaf+(weld "no mime -> " d) leaf+"conversion available"]])
  =/  out=(each vase tang)  (mule |.((u.tu !>(mim))))
  ?:  ?=(%| -.out)  (pure:m [%| p.out])
  (pure:m [%& dst q.p.out])
::  +grub-bask: text -> a bask carrying the right blot for `nom`'s extension.
::  Only for a NEW file, where there is no existing blot to preserve.
::  %| is a conversion failure (bad hoon), reported to the caller verbatim.
::  An extension with no mark stores as mime, which is correct for a plain
::  asset and is also what the explorer's upload does.
++  grub-bask
  |=  [nom=@ta body=@t]
  =/  m  (fiber:fiber:nexus ,(each bask:tarball tang))
  ^-  form:m
  =/  mim=mime  [/text/plain (as-octs:mimes:html body)]
  =/  ext=@ta  (grub-ext nom)
  ?:  =('' ext)  (pure:m [%& [/ %mime] mim])
  ;<  tu=(unit tube:clay)  bind:m
    (get-tube:io [%& %| /code] [[/ %mime] [/ ext]])
  ?~  tu  (pure:m [%& [/ %mime] mim])
  =/  out=(each vase tang)  (mule |.((u.tu !>(mim))))
  ?:  ?=(%| -.out)  (pure:m [%| p.out])
  (pure:m [%& [/ ext] q.p.out])
::  ── web archiving (the /clip bookmarklet) ──────────────────────────────
::  +fetch-url: GET a clearweb url through iris, following at most one redirect.
::  Returns ~ on ANY failure (dead host, non-200, empty body) rather than
::  bailing: a request fiber that crashes leaves the browser hanging on a dead
::  connection, so every failure has to come back as a value the route can 502.
++  fetch-url
  |=  url=@t
  =/  m  (fiber:fiber:nexus ,(unit @t))
  ^-  form:m
  =/  hed  ^-((list [@t @t]) ~[['User-Agent' 'lattice-clip']])
  ;<  ~  bind:m  (send-request:io [%'GET' url hed ~])
  ;<  res=client-response:iris  bind:m  take-client-response:io
  ?.  ?=(%finished -.res)  (pure:m ~)
  =/  status=@ud  status-code.response-header.res
  ?:  ?|(=(status 301) =(status 302) =(status 307) =(status 308))
    =/  loc=(unit @t)
      (~(get by (malt headers.response-header.res)) 'location')
    ?~  loc  (pure:m ~)
    ?.  (http-url u.loc)  (pure:m ~)
    ;<  ~  bind:m  (send-request:io [%'GET' u.loc hed ~])
    ;<  r2=client-response:iris  bind:m  take-client-response:io
    ?.  ?=(%finished -.r2)  (pure:m ~)
    ?.  =(200 status-code.response-header.r2)  (pure:m ~)
    ?~  full-file.r2  (pure:m ~)
    (pure:m `q.data.u.full-file.r2)
  ?.  =(200 status)  (pure:m ~)
  ?~  full-file.res  (pure:m ~)
  (pure:m `q.data.u.full-file.res)
::  +http-url: is this an http(s) url? The ship fetches whatever /clip is
::  handed, so this is the trust boundary — it keeps `file:`, `data:` and any
::  other iris-reachable scheme out, and it also gates the redirect target
::  (an http redirect to file:/// would otherwise walk right past the check).
++  http-url
  |=  url=@t
  ^-  ?
  =/  t=tape  (cass (trip url))
  ?|  =("http://" (scag 7 t))
      =("https://" (scag 8 t))
  ==
::  +clip-slug: url -> a filename-safe slug. Host + path, lowercased, every run
::  of non-alphanumerics collapsed to a single hyphen.
++  clip-slug
  |=  url=@t
  ^-  @t
  =/  t=tape  (cass (trip url))
  =.  t  ?:(=("http://" (scag 7 t)) (slag 7 t) t)
  =.  t  ?:(=("https://" (scag 8 t)) (slag 8 t) t)
  ::  cap the INPUT rather than counting output — a long query string can't
  ::  produce an unusable page name, and there is no length counter to keep.
  =.  t  (scag 60 t)
  ::  one pass, accumulating REVERSED — never weld onto a growing tape.
  ::  `dash` starts set so leading separators are dropped; a trailing hyphen
  ::  is popped at the end.
  =/  acc=tape  ~
  =/  dash=?  &
  |-  ^-  @t
  ?~  t
    =/  fin=tape  ?:(&(dash ?=(^ acc)) `tape`t.acc acc)
    =/  out=tape  (flop fin)
    ?~(out 'clip' (crip `tape`out))
  =/  c=@tD  i.t
  ?:  ?|(?&((gte c 'a') (lte c 'z')) ?&((gte c '0') (lte c '9')))
    $(t t.t, acc [c acc], dash |)
  ?:  dash  $(t t.t)
  $(t t.t, acc ['-' acc], dash &)
::  +clip-free: first unused page rel under clips/ for this slug. Never
::  overwrites an existing archive — a re-clip of the same url lands beside the
::  old one. Gives up after -9 rather than looping forever.
++  clip-free
  |=  slug=@t
  =/  m  (fiber:fiber:nexus ,(unit path))
  ^-  form:m
  =|  n=@ud
  |-  ^-  form:m
  ?:  (gth n 9)  (pure:m ~)
  =/  nom=@t  ?:(=(0 n) slug (crip :(weld (trip slug) "-" (a-co:co +(n)))))
  =/  rel=path  ~[%clips nom]
  ;<  ex=?  bind:m  (peek-exists:io [%& %& (weld app-base:lu (weld /page rel)) %code])
  ?.  ex  (pure:m `rel)
  $(n +(n))
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
::  +apply-action: the writer's action dispatch, split out of the take-poke loop
::  so every mutation runs through one place (and is followed by a +bump-rev).
::
++  apply-action
  |=  [root=path now=@da =sage:tarball]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?:  =([/lattice %know-action] p.sage)
    (apply root now !<(know-action:lk q.sage))
  ?:  =([/lattice %pub-action] p.sage)
    (apply-pub root now !<(pub-action:lp q.sage))
  ?:  =([/lattice %sub-action] p.sage)
    (apply-sub root !<(sub-action:lp q.sage))
  ?:  =([/lattice %eval-action] p.sage)
    (apply-eval root now !<(eval-action:le q.sage))
  ::  the owner commenting on their own page: author is us. (Other ships comment
  ::  via the public inbox fiber, not this owner-only writer.)
  ?:  =([/lattice %comment-action] p.sage)
    ;<  our=@p  bind:m  bowl-our
    (apply-comment root our now !<(comment-action:lc q.sage))
  ?:  =([/lattice %bookmark-action] p.sage)
    (apply-bookmark root !<(bookmark-action:lb q.sage))
  ~&([%lattice-bad-mark p.sage] (pure:m ~))
::  +bump-rev: write `now` to the /rev change beacon. A distinct value each call
::  (bowl-now is monotonic) guarantees a keep-SSE news event fires, so every open
::  reader watching /rev live-reloads. Cheap: /rev is one json number, not a page.
::
++  bump-rev
  |=  now=@da
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ::  the beacon must be NESTED (under /beacon): grubbery's keep-SSE does not
  ::  stream a grub at the nexus root (verified — /rev and /bookmarks keeps stay
  ::  silent; nested grubs like /pub/index stream fine). Gain is not required.
  (put-file [%& %& (weld app-base:lu /beacon) %rev] [/ %json] (numb:enjs:format `@ud`now))
::  +poke-eval: send an eval-action to the writer (serialized like all writes).
::
++  poke-eval
  |=  act=eval-action:le
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (poke:io [%| 2 %& ~ %'main.sig'] [[/lattice %eval-action] act])
::  +poke-comment: hand a comment to the owner writer (author = us). The public
::  inbox fiber pokes apply-comment directly with the sender ship instead.
::
++  poke-comment
  |=  act=comment-action:lc
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (poke:io [%| 2 %& ~ %'main.sig'] [[/lattice %comment-action] act])
::  +poke-bookmark: add/remove a browser bookmark via the owner writer.
::
++  poke-bookmark
  |=  act=bookmark-action:lb
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (poke:io [%| 2 %& ~ %'main.sig'] [[/lattice %bookmark-action] act])
::  +apply-eval: page create/command/delete, in the writer fiber.
::
++  apply-eval
  |=  [root=path now=@da act=eval-action:le]
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
      %legacy-pages
    ::  remember which page rels THIS migration triggered. Provenance matters:
    ::  a legacy page name may collide with a page the nexus published itself,
    ::  and only this record distinguishes "we put it in the vault" from "it
    ::  was already the user's".
    %^  put-file  [%& %& (weld root /legacy) %pages]  [/ %json]
    a+(turn rels.act |=(r=path s+(crip (pax-str r))))
      %legacy-seen
    ::  one marker for both outcomes (imported N, or dismissed with 0): its
    ::  existence is what silences the prompt. See +legacy-mark-road.
    %^  put-file  [%& %& (weld root /legacy) %state]  [/ %json]
    (pairs:enjs:format ~[['imported' (numb:enjs:format imported.act)]])
      %tmpl-del
    ::  delete a template — cull its subtree. A shipped template comes back on
    ::  the next writer start (ensure-shipped-templates), which is intended.
    =/  tdir=path  (weld root (weld /template /[name.act]))
    ;<  ex=?  bind:m  (peek-exists:io [%& %| tdir])
    ?.  ex  (pure:m ~)
    ;<  *  bind:m  (cull-soft:io [%& %| tdir])
    (pure:m ~)
      %cmd
    =/  pdir=path  (weld root (weld /page pax.act))
    ::  authoritative existence guard: no code grub -> no page (and no
    ::  evaluator fiber), so writing a cmd grub would orphan it inside a
    ::  possibly-culled dir and swallow the command (caught by review). The
    ::  route also 404s, but this closes the create-then-poke race.
    ;<  cx=?  bind:m  (peek-exists:io [%& %& pdir %code])
    ?.  cx  (pure:m ~)
    ;<  sn=view:nexus  bind:m  (peek:io [%& %& pdir %cmd] ~)
    =/  cur=eval-cmd:le
      ?.  ?=([%file *] sn)  [0 '' 0]
      (fall (mole |.(;;(eval-cmd:le (sang-noun:tarball sang.sn)))) [0 '' 0])
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
    ::  cull tombs the CURRENT revision but leaves every stored %firm one, so
    ::  a deleted page's bodies stayed readable via page-history and could be
    ::  resurrected onto the next page created with the same name. Drop them
    ::  first. (A folder delete culls the subtree; each page's own delete
    ::  prunes its own history, so this covers the page case exactly.)
    ::  keep=0 drops everything, so the window is irrelevant here
    ;<  ~  bind:m  (prune-hist [%& %& pdir %code] 0 ~s0)
    ;<  ~  bind:m  (prune-hist [%& %& pdir %data] 0 ~s0)
    ;<  *  bind:m  (cull-soft:io [%& %| pdir])
    (pure:m ~)
      %share
    (apply-share root now pax.act mode.act)
      %share-tree
    ::  publish/unpublish a whole subtree: apply the mode to every PAGE under
    ::  pax (folders have no /data grub, so skip them). Idempotent, so
    ::  re-publishing is safe; a %private sweep revokes each page's weir too.
    =/  base=path  (weld root (weld /page pax.act))
    ;<  dn=view:nexus  bind:m  (peek:io [%& %| base] ~)
    ?.  ?=([%ball *] dn)  (pure:m ~)
    =/  rels=(list path)
      %+  murn  (collect-tree ball.dn ~)
      |=([pax=path page=?] ?:(page `pax ~))
    |-  ^-  form:m
    ?~  rels  (pure:m ~)
    ;<  ~  bind:m  (apply-share root now (weld pax.act i.rels) mode.act)
    $(rels t.rels)
      %mkdir
    ::  create an empty folder (and any missing parents). ensure-dirs is
    ::  idempotent, so mkdir over an existing page/folder is a harmless no-op.
    (ensure-dirs (weld root /page) pax.act)
      %comments
    ::  set the comments on/off flag at pax (a page or folder). The nearest flag
    ::  at/above a page decides, so this enables/disables a whole subtree or one
    ::  page. Owner-only (an eval-action), unlike the public comment-add path.
    =/  fdir=path  (weld root (weld /page pax.act))
    ;<  ex=?  bind:m  (peek-exists:io [%& %| fdir])
    ?.  ex  (pure:m ~)
    (put-file [%& %& fdir %comment-on] [/lattice %comment-flag] on.act)
      %forms
    ::  set the public-form flag at pax. Same nearest-flag-wins shape as
    ::  %comments, and equally owner-only: this is the switch that makes a
    ::  clearweb page publicly writable, so it is never implicit.
    =/  fdir=path  (weld root (weld /page pax.act))
    ;<  ex=?  bind:m  (peek-exists:io [%& %| fdir])
    ?.  ex  (pure:m ~)
    ;<  ~  bind:m  (put-file [%& %& fdir %forms-on] [/lattice %comment-flag] on.act)
    (put-file [%& %& fdir %forms-cfg] [/lattice %eval-data] `form-cfg:le`[cap.act gap.act])
      %form-hit
    ::  one accepted public submission: bump the tally. Runs in the writer so
    ::  concurrent submissions serialize (the cap check itself happens in the
    ::  request fiber, so a burst can overshoot by the number in flight).
    =/  fdir=path  (weld root (weld /page pax.act))
    ;<  ex=?  bind:m  (peek-exists:io [%& %| fdir])
    ?.  ex  (pure:m ~)
    ;<  u=form-use:le  bind:m  (read-form-use pax.act)
    (put-file [%& %& fdir %forms-use] [/lattice %eval-data] `form-use:le`[+(count.u) now.act])
      %form-reset
    =/  fdir=path  (weld root (weld /page pax.act))
    ;<  ex=?  bind:m  (peek-exists:io [%& %| fdir])
    ?.  ex  (pure:m ~)
    (put-file [%& %& fdir %forms-use] [/lattice %eval-data] `form-use:le`[0 *@da])
  ==
::  +apply-comment: store one comment under /comments/<page>/<id>. `author` is us
::  (owner writer) or the poking ship (public inbox) — NEVER from the payload,
::  which can't be trusted. Rejected unless the page path is sane and has comments
::  enabled; the body is required and length-capped. Bodies are stored raw and
::  HTML-escaped at render time (they are other ships' text).
::
++  apply-comment
  |=  [root=path author=@p now=@da act=comment-action:lc]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?:  =('' body.act)  (pure:m ~)
  ::  reject an empty page path (levy is vacuously true on ~) so a comment can't
  ::  land loose in the /comments root. Value-eq, not ?=, so page.act keeps its
  ::  general `path` type (a ?= refinement makes the levy below mull-grow).
  ?:  =(~ page.act)  (pure:m ~)
  ?.  (levy page.act |=(s=@ta &(!=(%$ s) ((sane %ta) s))))  (pure:m ~)
  ;<  on=?  bind:m  (comments-on page.act)
  ?.  on  (pure:m ~)
  =/  body=@t
    ?:((gth (met 3 body.act) max-body:lc) (end [3 max-body:lc] body.act) body.act)
  =/  =comment:lc  [author now body]
  =/  id=@ta  (scot %uv (sham comment))
  =/  cbase=path  (weld root /comments)
  ;<  ~  bind:m  (ensure-dirs cbase page.act)
  (put-file [%& %& (weld cbase page.act) id] [/lattice %comment] comment)
::  +comments-on: is `page` comments-enabled? The nearest `comment-on` flag grub
::  AT or ABOVE it in /page wins (like find-theme); absent everywhere = off. One
::  flag on a site folder enables all its pages; a page can override its own.
::
++  comments-on
  |=  page=path
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  |-  ^-  form:m
  =/  fdir=path  (weld app-base:lu (weld /page page))
  ;<  seen=view:nexus  bind:m  (peek:io [%& %& fdir %comment-on] ~)
  ?:  ?=([%file *] seen)
    (pure:m (fall (mole |.(;;(? (sang-noun:tarball sang.seen)))) %.n))
  ?~  page  (pure:m %.n)
  $(page (snip `path`page))
::  +apply-bookmark: add (prepend, dedup by url, cap) or delete a bookmark. Runs
::  in the writer since it read-modify-writes the single /bookmarks grub.
::
++  apply-bookmark
  |=  [root=path act=bookmark-action:lb]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  cur=bookmarks:lb  bind:m  read-bookmarks
  =/  new=bookmarks:lb
    ?-  -.act
        %add
      ::  cast the prepend to the general list type — scag on a lest (non-empty
      ::  list) mull-grows.
      =/  kept=bookmarks:lb  (skip cur |=(b=bookmark:lb =(url.b url.bookmark.act)))
      (scag cap:lb `bookmarks:lb`[bookmark.act kept])
        %del  (skip cur |=(b=bookmark:lb =(url.b url.act)))
    ==
  (put-file [%& %& root %bookmarks] [/lattice %bookmarks] new)
::  +read-bookmarks: the stored bookmark list (newest first; ~ if none yet).
::
++  read-bookmarks
  =/  m  (fiber:fiber:nexus ,bookmarks:lb)
  ^-  form:m
  ;<  seen=view:nexus  bind:m  (peek:io [%& %& app-base:lu %bookmarks] ~)
  ?.  ?=([%file *] seen)  (pure:m ~)
  (pure:m (fall (mole |.(!<(bookmarks:lb (need-vase:tarball sang.seen)))) ~))
::  +read-recent: the up-to-`n` most-recently-edited pages, [path preview]. mtime
::  is each code grub's latest revision date (cass.da), read per page — O(pages)
::  peeks on a home load, fine for a personal ship; add an index if it ever bites.
::
++  read-recent
  |=  n=@ud
  =/  m  (fiber:fiber:nexus ,(list [pax=path prev=@t]))
  ^-  form:m
  ::  ONE deep peek: the ball carries every code grub and the wave every cass.
  ::  The old shape listed the names then re-peeked each page — O(pages)
  ::  serialized darts on every home load, just to pick the newest n.
  ;<  sn=view:nexus  bind:m  (peek:io [%& %| (weld app-base:lu /page)] ~)
  ?.  ?=([%ball *] sn)  (pure:m ~)
  =/  sorted=(list [pax=path when=@da code=@t])
    %+  sort  (recent-walk ball.sn wave.sn ~)
    |=  [a=[pax=path when=@da code=@t] b=[pax=path when=@da code=@t]]
    (gth when.a when.b)
  %-  pure:m
  %+  turn  `(list [pax=path when=@da code=@t])`(scag n sorted)
  |=([pax=path when=@da code=@t] [pax (preview-of code)])
::  +recent-walk: every page's [path mtime code] straight from a deep-peek
::  ball+wave, no per-page darts (same technique as +tree-walk/+dump-walk).
++  recent-walk
  |=  [b=ball:tarball w=wave:nexus rel=path]
  ^-  (list [pax=path when=@da code=@t])
  =/  fils  ?~(fil.b ~ contents.u.fil.b)
  =/  wfil=(map @ta cass:clay)  ?~(fil.w ~ file.u.fil.w)
  =/  kids=(list [pax=path when=@da code=@t])
    %-  zing
    %+  turn  ~(tap by dir.b)
    |=  [nom=@ta kb=ball:tarball]
    (recent-walk kb (fall (~(get by dir.w) nom) *wave:nexus) (weld rel /[nom]))
  ?.  (~(has by fils) %code)  kids
  =/  cd  (~(got by fils) %code)
  =/  cs=cass:clay  (fall (~(get by wfil) %code) *cass:clay)
  :_  kids
  [rel da.cs (fall (mole |.(;;(@t (sang-noun:tarball sang.cd)))) '')]
::  +preview-of: a one-line, ~140-char plaintext preview of a page's source —
::  leading markdown '#'/spaces dropped, whitespace flattened to single spaces.
::
++  preview-of
  |=  code=@t
  ^-  @t
  ::  a content page (md/css/js/gmi/text) stores its raw body wrapped in a builder
  ::  gate; unwrap it so the preview is the actual content, not the hoon wrapper
  ::  (a raw hoon builder has nothing to unwrap — preview its source as-is).
  =/  raw=@t
    =/  un=(unit [builder=@tas body=@t])  (unwrap-content code)
    ?~(un code body.u.un)
  =/  in=tape  (trip raw)
  =.  in  |-(?~(in in ?:(?=(?(%'#' %' ') i.in) $(in t.in) in)))
  =/  flat=tape  (turn (scag 200 in) |=(c=@tD ?:((lte c ' ') ' ' c)))
  (crip (scag 140 flat))
::  +apply-share: set one page's sharing preset — the shared body of the %share
::  and %share-tree eval-actions, so per-page and per-tree can't drift. weir road
::  first (covers the grub before it exists), then gain the current data if any
::  (the evaluator re-gains on each later write). Idempotent.
::
::  +apply-share: set a page's sharing preset, and make BOTH surfaces match it.
::
::  %private   — on neither: no vault copy (so no ship can read it over ames),
::               data grub un-gained, no /c/ route.
::  %shared    — vault copy published + gained, so peers resolve urb://…/<name>.
::  %clearweb  — the same, PLUS the unauthenticated /c/ route.
::
::  Setting the preset used to touch only the data grub's gain/weir, which is
::  not the surface anyone browses: urb:// resolves through /pub/vault. So a
::  clearweb page was reachable on the web and 404 over ames, and a page could
::  sit in the vault (readable by any ship, since ensure-pub-weir opens /pub)
::  while still labelled private. Drive the vault from the preset instead.
++  apply-share
  |=  [root=path now=@da rel=path mode=share-mode:le]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  pdir=path  (weld root (weld /page rel))
  ;<  cx=?  bind:m  (peek-exists:io [%& %& pdir %code])
  ?.  cx  (pure:m ~)
  =/  data-road=road:tarball  [%& %& pdir %data]
  =/  pub=?  !=(%private mode)
  ;<  ~  bind:m  (share-weir data-road pub)
  ;<  dx=?  bind:m  (peek-exists:io data-road)
  ;<  ~  bind:m  ?:(dx (gain:io data-road pub) (pure:m ~))
  ;<  ~  bind:m  (put-file [%& %& pdir %share] [/lattice %eval-data] mode)
  =/  key=@t  (spat (pub-path (crip (pax-str rel))))
  ?.  pub  (apply-pub root now [%del-page key])
  ::  publish the page's own output. A page whose data is not a cord (a
  ::  computed noun) has no gemtext form, so it keeps its preset without a
  ::  vault copy rather than publishing something meaningless.
  ;<  dn=view:nexus  bind:m  (peek:io data-road ~)
  ?.  ?=([%file *] dn)  (pure:m ~)
  =/  body=(unit @t)  (mole |.(;;(@t (sang-noun:tarball sang.dn))))
  ?~  body  (pure:m ~)
  (apply-pub root now [%save-page key u.body])
::  +make-page: create a page at `pax` under /page with the given code — the
::  shared body of the %make action and template instantiation. cmd + deps
::  first (the code grub's fiber reads both at spawn), then the code.
::
::  +history-keep / +know-keep / +data-keep: revisions retained per grub.
::  Autosave writes one revision per typing pause, so every GAINED grub needs
::  a ceiling or the pier archives every keystroke forever.
::    page source / know entries — the user-facing history surfaces, so deep
::    enough to undo a bad session.
::    page data — recomputed on every command, dependency wave, timer tick and
::    public form submission, with NO history UI. Keep only enough to debug.
++  history-keep  50
++  know-keep     50
++  data-keep     3
::  +history-window: two revisions closer together than this are keystroke-scale
::  intermediates, not history — the trail behind the head gets collapsed so the
::  KEPT revisions stay roughly this far apart. Nothing is ever lost from the
::  document: every save still writes, and the head is always current; only the
::  superseded intermediates go.
::
::  A count-only cap was not enough. Editing through the lattice-fs mount turns
::  one editor save into several write() calls (the kernel picks the chunking,
::  not us), each a %make and each a revision — so all 50 slots filled in
::  seconds and "history" spanned under a minute. Throttling here rather than in
::  the editor's debounce covers every writer: browser, fs mount, MCP, raw API.
++  history-window  ~m5
::  +prune-hist: drop a grub's revision tail past `keep`.
::
::  Uses +born (metadata only: cass + tags + tombstone flag) rather than +peep,
::  which hydrates every stored BODY just to count them — on a 50-revision page
::  that is 50 full documents read per save. Tombstones are filtered so the
::  count matches what +peep-based callers and page-history report.
::
++  prune-hist
  |=  [road=road:tarball keep=@ud window=@dr]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  bo=(each (list [=cass:clay tags=(set @t) tomb=?]) tang)  bind:m  (born:io road)
  ?:  ?=(%| -.bo)  (pure:m ~)
  ::  live revisions, NEWEST FIRST — both passes below want that order, and one
  ::  +born read feeds both so a save costs no extra dart than it used to.
  =/  live=(list cass:clay)
    %+  sort
      %+  murn  p.bo
      |=  [c=cass:clay tags=(set @t) tomb=?]
      ^-  (unit cass:clay)
      ?:(tomb ~ `c)
    |=([a=cass:clay b=cass:clay] (gth ud.a ud.b))
  ::  keep=0 means drop the lot (used by delete). Guard it explicitly: the
  ::  general path below computes (dec keep), and dec 0 crashes — which would
  ::  have taken the writer down on every page delete.
  ?:  =(0 keep)
    ?~  live  (pure:m ~)
    (lose:io road [%numb ~ ~])
  ::  ── time coalesce ──
  ::  live is [head, prev, anchor, ...]. Drop `prev` when it sits inside one
  ::  window of `anchor`, i.e. it is an intermediate between two kept points.
  ::
  ::  Comparing prev against the HEAD instead is the obvious version and it is
  ::  wrong: the thing compared against is replaced on every save, so a long
  ::  continuous editing session would collapse to a single revision and you
  ::  could never step back. Anchoring on the revision BEFORE prev keeps one
  ::  revision per window no matter how fast the writes arrive.
  =/  victim=(unit cass:clay)
    ?.  ?=([* * * *] live)  ~
    =/  prev=cass:clay    i.t.live
    =/  anchor=cass:clay  i.t.t.live
    ?:  (lth (sub da.prev da.anchor) window)  `prev
    ~
  ;<  ~  bind:m
    ?~  victim  (pure:m ~)
    (lose:io road [%pick (sy ~[u.victim])])
  ::  count cap, as a backstop, over what the coalesce left behind
  =/  kept=(list cass:clay)
    ?~  victim  live
    (skip live |=(c=cass:clay =(ud.c ud.u.victim)))
  ?:  (lte (lent kept) keep)  (pure:m ~)
  =/  cut=@ud  ud:(snag (dec keep) kept)
  ?:  =(0 cut)  (pure:m ~)
  (lose:io road [%numb ~ `(dec cut)])
++  make-page
  |=  [root=path pax=path src=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  pdir=path  (weld root (weld /page pax))
  ::  ONE existence probe. An overwrite (code present) already has its dirs,
  ::  cmd and deps from creation — the old per-save re-probing of each was
  ::  3+ wasted darts on every autosave. A half-created page (crash between
  ::  scaffold and code) just re-runs the scaffold: put-file is idempotent.
  ;<  ex=?  bind:m  (peek-exists:io [%& %& pdir %code])
  ;<  ~  bind:m
    ?:  ex  (pure:m ~)
    ;<  ~  bind:m  (ensure-dirs (weld root /page) pax)
    ;<  ~  bind:m  (put-file [%& %& pdir %cmd] [/lattice %eval-cmd] `eval-cmd:le`[0 '' 0])
    (put-file [%& %& pdir %deps] [/lattice %eval-deps] `(list path)`~)
  ;<  ~  bind:m  (put-file [%& %& pdir %code] [/lattice %page] src)
  ::  gain the code grub so every save is a kept %firm revision — that is
  ::  what page-history / page-source-at read. Privacy is unchanged: gain
  ::  makes a grub namespace-addressable but cross-ship reads stay weir-gated
  ::  deny-all, the same model the know vault uses (every private entry
  ::  gained, for exactly this history).
  ;<  ~  bind:m  (gain:io [%& %& pdir %code] %.y)
  (prune-hist [%& %& pdir %code] history-keep history-window)
::  +rewrite-root: replace the path-prefix `from` with `to` in code, only where
::  `from` ends at a path boundary (/ ) space " ] , or end) — so a short root
::  can't clobber a longer path that merely starts with it.
::
++  rewrite-root
  |=  [hay=tape from=tape to=tape]
  ^-  tape
  ?~  from  hay
  ::  `bef` carries the char immediately preceding `hay` in the original code, so
  ::  the recursion doesn't mistake a mid-path match at the head of `aft` for a
  ::  path start (else '/site/site' would rewrite both segments).
  =/  bef=(unit @t)  ~
  |-  ^-  tape
  =/  i  (find from hay)
  ?~  i  hay
  =/  pre=tape  (scag u.i hay)
  =/  aft=tape  (slag (add u.i (lent from)) hay)
  ::  a path literal ends at end-of-code, any whitespace/control (space, TAB,
  ::  NEWLINE, CR — all <= ' '), or a structural close/open ( ) ( [ ] " , ).
  =/  bnd=?
    ?~  aft  %.y
    ?|((lte i.aft ' ') ?=(?(%'/' %')' %'(' %'[' %']' %'"' %',') i.aft))
  ::  `from` starts with '/', so the match always lands on a '/'; but that '/'
  ::  must be the START of a path literal, not a separator mid-path. So require a
  ::  boundary BEFORE it too — start-of-code, whitespace/control, or a structural
  ::  open ( [ " , — else '/data/site' (or the 2nd seg of '/site/site') would be
  ::  clobbered. Path-segment chars and '/' before => reject (mid-path match).
  =/  pc=(unit @t)  ?~(pre bef `(rear pre))
  =/  pbnd=?
    ?~  pc  %.y
    ?|((lte u.pc ' ') ?=(?(%'(' %'[' %'"' %',') u.pc))
  =/  out=tape  (weld pre ?:(&(bnd pbnd) to from))
  %+  weld  out
  $(hay aft, bef ?~(out bef `(rear out)))
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
  ;<  dn=view:nexus  bind:m  (peek:io [%& %| src-root] ~)
  ?.  ?=([%ball *] dn)  (pure:m ~)
  =/  rels=(list path)
    %+  murn  (collect-tree ball.dn ~)
    |=([pax=path page=?] ?:(page `pax ~))
  |-  ^-  form:m
  ?~  rels  (pure:m ~)
  ;<  cn=view:nexus  bind:m  (peek:io [%& %& (weld src-root i.rels) %code] ~)
  =/  code=@t
    ?.  ?=([%file *] cn)  ''
    (fall (mole |.(;;(@t (sang-noun:tarball sang.cn)))) '')
  =/  newcode=@t  (crip (rewrite-root (trip code) from-str to-str))
  ;<  ~  bind:m
    ?:  live
      (make-page root (weld rel.dst i.rels) newcode)
    =/  ddir=path  (weld root (weld /[base.dst] (weld rel.dst i.rels)))
    ;<  ~  bind:m  (ensure-dirs (weld root /[base.dst]) (weld rel.dst i.rels))
    (put-file [%& %& ddir %code] [/lattice %page] newcode)
  $(rels t.rels)
::  +rewrite-wikilinks: rewrite [[from]] and [[from/...]] references in code
::  text to the new name — the bare-name form wikilinks use (+rewrite-root
::  only covers /slash-prefixed hoon path literals). Boundary-checked so a
::  [[fromX]] page is never clobbered by a move of [[from]].
::
++  rewrite-wikilinks
  |=  [hay=tape from=tape to=tape]
  ^-  tape
  ?~  from  hay
  =/  ndl=tape  (weld "[[" from)
  =/  nl=@ud  (lent ndl)
  |-  ^-  tape
  =/  i  (find ndl hay)
  ?~  i  hay
  =/  pre=tape  (scag u.i hay)
  =/  aft=tape  (slag (add u.i nl) hay)
  ?.  ?|(?=(~ aft) =(']' i.aft) =('/' i.aft))
    (weld (weld pre ndl) $(hay aft))
  (weld (weld pre (weld "[[" to)) $(hay aft))
::  +move-pages: move a page or a whole folder subtree under /page from src to
::  dst. Copies each page's code (share mode carried over, wikilink
::  self-references rewritten like template instantiation rewrites its root),
::  then deletes the source. Runs in a REQUEST fiber with one writer poke per
::  action — the same reasoning as +instantiate-template: a batch make in one
::  writer transaction arms dep-keeps that never establish. Returns ~ when
::  nothing exists at src; `count is the number of pages moved (0 = an empty
::  folder, still a successful move).
::
++  move-pages
  |=  [from=path to=path]
  =/  m  (fiber:fiber:nexus ,(unit @ud))
  ^-  form:m
  =/  sdir=path  (weld app-base:lu (weld /page from))
  =/  from-str=tape   (spud from)
  =/  to-str=tape     (spud to)
  =/  from-bare=tape  (pax-str from)
  =/  to-bare=tape    (pax-str to)
  ;<  dn=view:nexus  bind:m  (peek:io [%& %| sdir] ~)
  ?.  ?=([%ball *] dn)  (pure:m ~)
  =/  all=(list [pax=path page=?])  (collect-tree ball.dn ~)
  =/  dirs=(list path)
    (sort (murn all |=([pax=path page=?] ?:(page ~ `pax))) aor)
  =/  rels=(list path)
    (sort (murn all |=([pax=path page=?] ?:(page `pax ~))) aor)
  ::  structure first, parents before children — preserves empty subfolders
  =/  todo=(list eval-action:le)
    [[%mkdir to] (turn dirs |=(p=path `eval-action:le`[%mkdir (weld to p)]))]
  =/  count=@ud  0
  |-  ^-  form:m
  ?^  todo
    ;<  ~  bind:m  (poke-eval i.todo)
    $(todo t.todo)
  ?~  rels
    ;<  ~  bind:m  (poke-eval [%del from])
    (pure:m `count)
  =/  pdir=path  (weld sdir i.rels)
  ;<  cn=view:nexus  bind:m  (peek:io [%& %& pdir %code] ~)
  =/  code=@t
    ?.  ?=([%file *] cn)  ''
    (fall (mole |.(;;(@t (sang-noun:tarball sang.cn)))) '')
  ;<  mode=share-mode:le  bind:m  (read-share pdir)
  =/  dst=path  (weld to i.rels)
  =/  newcode=@t
    %-  crip
    %^  rewrite-wikilinks
        (rewrite-root (trip code) from-str to-str)
      from-bare
    to-bare
  =/  acts=(list eval-action:le)
    :-  [%make dst newcode]
    ?:(=(%private mode) ~ [%share dst mode]~)
  $(todo acts, rels t.rels, count +(count))
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
  =/  troot=path    (weld app-base:lu (weld /template /[name]))
  =/  from-str=tape  (spud /[name])
  =/  to-str=tape    (spud to)
  ;<  dn=view:nexus  bind:m  (peek:io [%& %| troot] ~)
  ?.  ?=([%ball *] dn)  (pure:m ~)
  =/  rels=(list path)
    %+  sort
      %+  murn  (collect-tree ball.dn ~)
      |=([pax=path page=?] ?:(page `pax ~))
    aor
  |-  ^-  form:m
  ?~  rels  (pure:m ~)
  ;<  cn=view:nexus  bind:m  (peek:io [%& %& (weld troot i.rels) %code] ~)
  =/  code=@t
    ?.  ?=([%file *] cn)  ''
    (fall (mole |.(;;(@t (sang-noun:tarball sang.cn)))) '')
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
  ::  flatten every shipped template into one [<name>/<rel> kind body] list, so
  ::  adding a template is a one-line change in /lib/lattice-templates.
  =/  pages=(list [prel=path kind=@tas body=@t])
    %-  zing
    %+  turn  shipped:tpl
    |=  [nm=@tas ps=(list [rel=path kind=@tas body=@t])]
    ^-  (list [path @tas @t])
    %+  turn  ps
    |=  [rel=path kind=@tas body=@t]
    ^-  [path @tas @t]
    [(weld /[nm] rel) kind body]
  |-  ^-  form:m
  ?~  pages  (pure:m ~)
  =/  prel=path  prel.i.pages
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
::  +public-grp: the public usergroup's storage dir. Grubbery names usergroup
::  dirs with a `.grp` suffix (+grp-storage-path in app/grubbery.hoon) — a
::  FOURTH framework drift past seen->view, loader ver->manifest and
::  bowl->bowl.sig. We wrote to /usergroups/public, which does not exist, so
::  the peek-exists guard below failed and EVERY share grant silently no-opped:
::  cross-ship reads of shared/clearweb pages were denied. Clearweb over HTTP
::  was unaffected, which is why it went unnoticed.
::
++  public-grp  ^-(path /sys/ames/usergroups/'public.grp')
++  share-weir
  |=  [road=road:tarball add=?]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  gdir=road:tarball  [%& %| public-grp]
  ;<  ok=?  bind:m  (peek-exists:io gdir)
  ?.  ok  (pure:m ~)
  =/  wroad=road:tarball  [%& %& [public-grp %'how.weir']]
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
  ;<  sn=view:nexus  bind:m  (peek:io [%& %| (weld root /page)] ~)
  ?.  ?=([%ball *] sn)  (pure:m ~)
  =/  rels=(list path)
    %+  murn  (collect-tree ball.sn ~)
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
  ;<  sn=view:nexus  bind:m  (peek:io [%& %& pdir %share] ~)
  ?.  ?=([%file *] sn)  (pure:m %private)
  (pure:m (fall (mole |.(;;(share-mode:le (sang-noun:tarball sang.sn)))) %private))
::  +read-show-mode: a page's render mode grub, %text if absent/malformed.
::
++  read-show-mode
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,view-mode:pg)
  ^-  form:m
  ;<  sn=view:nexus  bind:m  (peek:io [%& %& pdir %show] ~)
  ?.  ?=([%file *] sn)  (pure:m %text)
  (pure:m (fall (mole |.(;;(view-mode:pg (sang-noun:tarball sang.sn)))) %text))
::  +read-wake: the timer request eval-run recorded (~ = no timer). eval-run
::  writes it rather than returning it so its fiber payload stays ,~ (the loop
::  reads it here). /wake is not on the /ev wire, so writing it is no self-wave.
::
++  read-wake
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,(unit @dr))
  ^-  form:m
  ;<  sn=view:nexus  bind:m  (peek:io [%& %& pdir %wake] ~)
  ?.  ?=([%file *] sn)  (pure:m ~)
  (pure:m (fall (mole |.(;;((unit @dr) (sang-noun:tarball sang.sn)))) ~))
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
  ;<  sn=view:nexus  bind:m  (peek:io [%& %& pdir %cmd] ~)
  ?.  ?=([%file *] sn)  (pure:m [0 '' 0])
  (pure:m (fall (mole |.(;;(eval-cmd:le (sang-noun:tarball sang.sn)))) [0 '' 0]))
::  +read-eval-seen / +write-eval-seen: the last-PROCESSED command seq, stored
::  as a bare @ud (reusing the eval-data marc — it's a noun grub). /seen is
::  never kept, so writing it wakes no fiber. Absent -> 0.
::
++  read-eval-seen
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,@ud)
  ^-  form:m
  ;<  sn=view:nexus  bind:m  (peek:io [%& %& pdir %seen] ~)
  ?.  ?=([%file *] sn)  (pure:m 0)
  (pure:m (fall (mole |.(;;(@ud (sang-noun:tarball sang.sn)))) 0))
++  write-eval-seen
  |=  [pdir=path seq=@ud]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (put-file [%& %& pdir %seen] [/lattice %eval-data] seq)
++  read-eval-deps
  |=  pdir=path
  =/  m  (fiber:fiber:nexus ,(list path))
  ^-  form:m
  ;<  sn=view:nexus  bind:m  (peek:io [%& %& pdir %deps] ~)
  ?.  ?=([%file *] sn)  (pure:m ~)
  (pure:m (fall (mole |.(;;((list path) (sang-noun:tarball sang.sn)))) ~))
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
  ?.  =(`path`[i.pax i.t.pax ~] app-base:lu)  ~
  `(weld app-base:lu /page/[i.t.t.t.pax])
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
  ;<  fsn=view:nexus  bind:m  (peek:io file-road ~)
  ?:  ?=([%file *] fsn)
    ;<  *  bind:m  (keep:io /ev file-road ~)
    $(deps t.deps, armed (~(put in armed) i.deps))
  ::  not a file: a DIRECTORY dep keeps on the dir road so a child add/remove
  ::  re-runs us. If it is neither (a not-yet-created grub), keep the file road
  ::  so a later write of that grub still fires. Mirrors read-dep-vals.
  ;<  dsn=view:nexus  bind:m  (peek:io [%& %| i.deps] ~)
  =/  keep-road=road:tarball  ?:(?=([%ball *] dsn) [%& %| i.deps] file-road)
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
    ;<  dsn=view:nexus       bind:m  (peek:io [%& %& u.src %data] ~)
    ;<  vmode=view-mode:pg   bind:m  (read-show-mode u.src)
    ;<  rest=(list [path *])  bind:m  (read-dep-vals t.deps)
    =/  frag=@t
      ?.  ?=([%file *] dsn)  ''
      ::  a composed view fragment is rendered ONCE at eval time and stored in
      ::  the composing page's data, then served on both surfaces — so no base
      ::  is universally right. /c/ is the useful one: composition (dashboards,
      ::  indexes) is what gets published. Wikilinks inside an embedded
      ::  fragment therefore always point at the public surface.
      (crip (render-shown sang.dsn vmode "/apps/lattice/c/"))
    (pure:m [[i.deps frag] rest])
  =/  n=@ud  (dec (lent i.deps))
  ;<  sn=view:nexus  bind:m  (peek:io [%& %& (scag n i.deps) (snag n i.deps)] ~)
  ?:  ?=([%file *] sn)
    ::  a file grub -> its raw noun.
    ;<  rest=(list [path *])  bind:m  (read-dep-vals t.deps)
    (pure:m [[i.deps (sang-noun:tarball sang.sn)] rest])
  ::  not a file -> a DIRECTORY dep resolves to its tree listing (a
  ::  (list [pax=path page=?]) of pages+folders under it, paths relative to the
  ::  dir), so a page can enumerate a structured subtree. ~ if it is neither.
  ;<  dn=view:nexus  bind:m  (peek:io [%& %| i.deps] ~)
  ;<  rest=(list [path *])  bind:m  (read-dep-vals t.deps)
  =/  val=*  ?.(?=([%ball *] dn) ~ (collect-tree ball.dn ~))
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
  ;<  dsn=view:nexus  bind:m  (peek:io [%& %& pdir %data] ~)
  =/  dat=(unit *)
    ?.(?=([%file *] dsn) ~ `(sang-noun:tarball sang.dsn))
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
    ;<  ~  bind:m  (gain:io [%& %& pdir %data] %.y)
    ::  a gained data grub keeps EVERY recompute forever otherwise: a timer
    ::  page, or a public form anyone can submit to, would grow the pier
    ::  without bound. Data has no history UI, so keep only a debugging tail.
    ::  data has no history UI and keep=3 already; no window needed
    (prune-hist [%& %& pdir %data] data-keep ~s0)
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
  ;<  seen=view:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%file *] seen)  (pure:m %.n)
  (pure:m !<(? (need-vase:tarball sang.seen)))
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
  =/  res-dir=path  (weld app-base:lu /cat/obk-out)
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
  (poke:io [%& %& (weld app-base:lu /cat) %'obelisk.sig'] [[/lattice %obk-req] req])
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
  ;<  seen=view:nexus  bind:m  (peek:io [%& %| base] ~)
  ?.  ?=([%ball *] seen)  (pure:m ~)
  ::  result grubs are flat FILES at this node, so they live in contents.u.fil —
  ::  NOT in dir (which holds only child *directories*, always empty here). Reading
  ::  dir made the sweep a permanent no-op. Mirror collect-entries / read-know-map.
  =/  names=(list @ta)
    ?~  fil.ball.seen  ~
    (turn ~(tap by contents.u.fil.ball.seen) |=([s=@ta *] s))
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
  ;<  seen=view:nexus  bind:m  (peek:io res-road ~)
  ?.  ?=([%file *] seen)
    (pure:m [%| ~[leaf+"obelisk: no result grub"]])
  =/  parsed  (mule |.(!<((each (list cmd-result:ast) tang) (need-vase:tarball sang.seen))))
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
  ;<  seen=view:nexus  bind:m  (peek:io data-road ~)
  ?.  ?=([%file *] seen)
    (pure:m [%| ~[leaf+"obelisk: no result grub"]])
  =/  raw=*  q:(need-vase:tarball sang.seen)
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
  ;<  body=(unit @t)  bind:m  (read-page-body our pub rel)
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
  ;<  ix=pub-index:lp  bind:m  (read-pub-index [%& %& (weld app-base:lu /pub) %index])
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
  ;<  body=(unit @t)  bind:m  (read-page-body our our rel)
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
  ;<  body=(unit @t)  bind:m  (read-page-body our pub (snip `path`stripped))
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
  =/  vr=(unit vrail:lp)  (key-to-rail:lp (weld app-base:lu /pub/vault) p.pp)
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
  =/  live=road:tarball   (entry-road (weld app-base:lu /know/vault) u.ko)
  =/  trash=road:tarball  (entry-road (weld app-base:lu /know/trash-vault) u.ko)
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
::
::  ── lattice-fs shared handler (HTTP routes + lick port both call these) ──
::
::  The filesystem client speaks ONE request shape, `[verb path query body]`,
::  and gets back `[status body]` (HTTP-style code + a cord). The HTTP routes
::  and the /fs.sig lick port are thin adapters over the same arms below, so a
::  single Rust client works over either transport with identical semantics.
::
::  +fs-tree-json: the whole /page tree as JSON (GET /page-tree + lick
::  %page-tree), from ONE deep peek. The ball already carries every code AND
::  share grub (and the wave every grub's cass), so the old shape — deep peek,
::  discard the ball, then TWO more darts per page (code re-peek + read-share)
::  — was pure waste that degraded the route linearly as pages accumulate.
::  Walk in place, exactly like +fs-dump-json.
++  fs-tree-json
  =/  m  (fiber:fiber:nexus ,json)
  ^-  form:m
  ;<  sn=view:nexus  bind:m  (peek:io [%& %| (weld app-base:lu /page)] ~)
  ?.  ?=([%ball *] sn)  (pure:m (pairs:enjs:format ~[['nodes' a+~]]))
  =/  nodes=(list [pax=path j=json])  (tree-walk ball.sn wave.sn ~)
  =/  srt  (sort nodes |=([a=[pax=path *] b=[pax=path *]] (aor pax.a pax.b)))
  (pure:m (pairs:enjs:format ~[['nodes' a+(turn srt |=([* j=json] j))]]))
::  +tree-walk: +dump-walk's twin without bodies — path+kind+size+rev+mtime+
::  share per page, folders as bare nodes. share comes from the /share grub in
::  the same ball (absent -> %private, the same rule as +read-share).
::  +index-walk: every page in the ball as [rel body share], from the SAME single
::  deep peek +tree-walk uses. That ball already carries each page's code and
::  share grub, so indexing the whole tree costs one dart, not two per page.
::  Folders and body-less nodes are skipped; an absent /share grub means
::  %private, the same rule as +read-share.
++  index-walk
  |=  [b=ball:tarball rel=path]
  ^-  (list [rel=path body=@t shr=share-mode:le])
  =/  fils  ?~(fil.b ~ contents.u.fil.b)
  =/  kids=(list [rel=path body=@t shr=share-mode:le])
    %-  zing
    %+  turn  ~(tap by dir.b)
    |=  [nom=@ta kb=ball:tarball]
    (index-walk kb (weld rel /[nom]))
  ?~  rel  kids
  ?.  (~(has by fils) %code)  kids
  =/  cd  (~(got by fils) %code)
  =/  src=@t  (fall (mole |.(;;(@t (sang-noun:tarball sang.cd)))) '')
  =/  sd  (~(get by fils) %share)
  =/  shr=share-mode:le
    ?~  sd  %private
    (fall (mole |.(;;(share-mode:le (sang-noun:tarball sang.u.sd)))) %private)
  =/  un=(unit [builder=@tas body=@t])  (unwrap-content src)
  =/  body=@t  ?~(un src body.u.un)
  :_  kids
  [rel body shr]
::  +scope-of: a page's share preset -> the label a search result carries.
::  %shared is reported as %urbit, not "public": those pages ARE reachable by
::  any ship that knows the address but invisible to a browser, and collapsing
::  the two into one badge would misrepresent where the content is exposed.
++  scope-of
  |=  shr=share-mode:le
  ^-  @t
  ?-  shr
    %clearweb  'clearweb'
    %shared    'urbit'
    %private   'private'
  ==
::  +content-reindex: rebuild content-terms from the live tree + know vault.
::  Two reads total (one deep page peek, one know-map read), then a single
::  TRUNCATE+INSERT.
::
::  Returns whether obelisk actually ACCEPTED the write. The populate deliberately
::  goes through +obelisk-query rather than +catalog-run: catalog-run discards the
::  result, so on a ship with no obelisk installed this arm completed "fine" and
::  the settings button reported "your pages and notes are searchable" having
::  written nothing at all. A reindex that indexed nothing must not report success.
++  content-reindex
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  ;<  sn=view:nexus  bind:m  (peek:io [%& %| (weld app-base:lu /page)] ~)
  =/  pages=(list [rel=path body=@t shr=share-mode:le])
    ?.  ?=([%ball *] sn)  ~
    (index-walk ball.sn ~)
  ;<  entries=(map path know-entry:lk)  bind:m  read-know-map
  =/  page-rows=(list [scope=@t key=@t terms=(list [term=@t tf=@ud])])
    %+  turn  pages
    |=  [rel=path body=@t shr=share-mode:le]
    :+  (scope-of shr)  (crip (pax-str rel))
    ::  same cap the crawler applies to a page body before analysis
    %+  top-terms:cat  term-max:cat
    (index-terms:cat *(map @t @ud) (trip (end [3 body-cap] body)))
  =/  know-rows=(list [scope=@t key=@t terms=(list [term=@t tf=@ud])])
    %+  turn  ~(tap by entries)
    |=  [key=path e=know-entry:lk]
    :+  'knowledge'  (spat key)
    %+  top-terms:cat  term-max:cat
    (index-terms:cat *(map @t @ud) (trip (end [3 body-cap] body.e)))
  ;<  ~  bind:m  (catalog-run %sys (weld "CREATE DATABASE " (trip catalog-db)))
  ;<  ~  bind:m  (catalog-create-loop content-index-create-list:cat)
  ;<  r=(each (list cmd-result:ast) tang)  bind:m
    %+  obelisk-query  catalog-db
    (content-index-populate-urql:cat (weld page-rows know-rows))
  (pure:m ?=(%& -.r))
++  tree-walk
  |=  [b=ball:tarball w=wave:nexus rel=path]
  ^-  (list [pax=path j=json])
  =/  fils  ?~(fil.b ~ contents.u.fil.b)
  =/  wfil=(map @ta cass:clay)  ?~(fil.w ~ file.u.fil.w)
  =/  kids=(list [pax=path j=json])
    %-  zing
    %+  turn  ~(tap by dir.b)
    |=  [nom=@ta kb=ball:tarball]
    =/  kw=wave:nexus  (fall (~(get by dir.w) nom) *wave:nexus)
    (tree-walk kb kw (weld rel /[nom]))
  ?.  (~(has by fils) %code)
    ?~  rel  kids
    :_  kids
    :-  rel
    (pairs:enjs:format ~[['path' s+(crip (pax-str rel))] ['page' b+|]])
  =/  cd  (~(got by fils) %code)
  =/  cs=cass:clay  (fall (~(get by wfil) %code) *cass:clay)
  =/  src=@t  (fall (mole |.(;;(@t (sang-noun:tarball sang.cd)))) '')
  =/  sd  (~(get by fils) %share)
  =/  shr=share-mode:le
    ?~  sd  %private
    (fall (mole |.(;;(share-mode:le (sang-noun:tarball sang.u.sd)))) %private)
  =/  un=(unit [builder=@tas body=@t])  (unwrap-content src)
  =/  gen=?  =((make-folder-index rel) src)
  =/  kind=@tas  ?:(gen %index ?~(un %hoon builder.u.un))
  =/  body=@t  ?~(un src body.u.un)
  :_  kids
  :-  rel
  %-  pairs:enjs:format
  :~  ['path' s+(crip (pax-str rel))]  ['page' b+&]  ['kind' s+kind]
      ['size' (numb:enjs:format (met 3 body))]
      ['rev' (numb:enjs:format ud.cs)]
      ['mtime' s+(scot %da da.cs)]
      ['share' s+shr]
  ==
::  [page-dump deploy marker DPMARK7]
::  +fs-dump-json: page-tree PLUS every page's body, in ONE deep peek. +read-tree
::  does this exact peek then discards the ball and re-peeks each %code grub (see
::  +fs-tree-json); here we KEEP the ball and read every sang in place. The ball's
::  lump.contents carries the typed sang per grub (tarball: contents map), and the
::  parallel wave carries rev+mtime per grub (nexus: wave). One HTTP round-trip,
::  O(pages) local peeks — warms a filesystem client's whole read-cache so
::  rg/grep never touch the network again.
::  +dump-inline-max: bodies larger than this (256 KB) are NOT inlined in
::  page-dump — the client fetches them on demand via page-source. Keeps one
::  warm dump bounded per file, so a few big pages can't balloon the payload
::  or the client's RAM cache. The node still carries an accurate `size`.
++  dump-inline-max  ^~((mul 256 1.024))
++  fs-dump-json
  =/  m  (fiber:fiber:nexus ,json)
  ^-  form:m
  ;<  sn=view:nexus  bind:m  (peek:io [%& %| (weld app-base:lu /page)] ~)
  ?.  ?=([%ball *] sn)  (pure:m (pairs:enjs:format ~[['nodes' a+~]]))
  =/  nodes=(list [pax=path j=json])  (dump-walk ball.sn wave.sn ~)
  =/  srt  (sort nodes |=([a=[pax=path *] b=[pax=path *]] (aor pax.a pax.b)))
  =/  js=(list json)  (turn srt |=([* j=json] j))
  (pure:m (pairs:enjs:format ~[['nodes' a+js]]))
::  +dump-walk: recurse ball+wave in lockstep (mirrors +collect-tree). A dir with a
::  %code grub is a page → emit path+kind+body+size+rev+mtime, body pulled straight
::  from the ball's sang (no re-peek); any other non-root dir is a folder. cass
::  (rev/mtime) comes from the parallel wave under the same @ta key. Each body is
::  mole/;;-fenced so a boom (broken-mark) grub yields '' instead of crashing.
++  dump-walk
  |=  [b=ball:tarball w=wave:nexus rel=path]
  ^-  (list [pax=path j=json])
  =/  fils  ?~(fil.b ~ contents.u.fil.b)
  =/  wfil=(map @ta cass:clay)  ?~(fil.w ~ file.u.fil.w)
  =/  kids=(list [pax=path j=json])
    %-  zing
    %+  turn  ~(tap by dir.b)
    |=  [nom=@ta kb=ball:tarball]
    =/  kw=wave:nexus  (fall (~(get by dir.w) nom) *wave:nexus)
    (dump-walk kb kw (weld rel /[nom]))
  ?.  (~(has by fils) %code)
    ?~  rel  kids
    :_  kids
    :-  rel
    (pairs:enjs:format ~[['path' s+(crip (pax-str rel))] ['page' b+|]])
  =/  cd  (~(got by fils) %code)
  =/  cs=cass:clay  (fall (~(get by wfil) %code) *cass:clay)
  =/  src=@t  (fall (mole |.(;;(@t (sang-noun:tarball sang.cd)))) '')
  =/  un=(unit [builder=@tas body=@t])  (unwrap-content src)
  =/  gen=?  =((make-folder-index rel) src)
  =/  kind=@tas  ?:(gen %index ?~(un %hoon builder.u.un))
  =/  body=@t  ?~(un src body.u.un)
  =/  bsize=@ud  (met 3 body)
  ::  omit the body inline for oversized pages (see +dump-inline-max); `size`
  ::  stays accurate so FUSE st_size is right and the client reads on demand.
  =/  head=(list [@t json])
    :~  ['path' s+(crip (pax-str rel))]  ['page' b+&]  ['kind' s+kind]  ==
  =/  body-row=(list [@t json])
    ?:((gth bsize dump-inline-max) ~ ~[['body' s+body]])
  =/  tail=(list [@t json])
    :~  ['size' (numb:enjs:format bsize)]
        ['rev' (numb:enjs:format ud.cs)]
        ['mtime' s+(scot %da da.cs)]
    ==
  :_  kids
  :-  rel
  (pairs:enjs:format :(weld head body-row tail))
::  +fs-source-result: a page's source as (each json [code msg]) — the json on
::  %&, an HTTP-style [code msg] error on %|.
++  fs-source-result
  |=  [name=@t render=?]
  =/  m  (fiber:fiber:nexus ,(each json [code=@ud msg=@t]))
  ^-  form:m
  ?.  (valid-name name)  (pure:m [%| 400 'bad name'])
  =/  pax=path  (pax-of name)
  =/  pdir=path  (weld app-base:lu (weld /page pax))
  ;<  cn=view:nexus  bind:m  (peek:io [%& %& pdir %code] ~)
  ?.  ?=([%file *] cn)  (pure:m [%| 404 'no such page'])
  ;<  mode=share-mode:le  bind:m  (read-share pdir)
  =/  src=@t  (fall (mole |.(;;(@t (sang-noun:tarball sang.cn)))) '')
  =/  un=(unit [builder=@tas body=@t])  (unwrap-content src)
  =/  gen=?  =((make-folder-index pax) src)
  =/  kind=@tas  ?:(gen %index ?~(un %hoon builder.u.un))
  =/  body=@t  ?~(un src body.u.un)
  ::  render=1 (the editor's page open): include the rendered preview, so
  ::  opening a page is ONE request instead of page-source + page-preview.
  =/  html-row=(list [@t json])
    ?.  &(render |((~(has in content-builders) kind) =(%index kind)))  ~
    ~[['html' s+(render-bare (preview-inner kind body))]]
  %-  pure:m
  :-  %&
  %-  pairs:enjs:format
  %+  weld
    ::  the cast homogenizes the row literal — weld is wet, and a bare :~ of
    ::  mixed [@t json-case] cells mull-grows against the first row's type
    ^-  (list [@t json])
    :~  ['kind' s+kind]  ['body' s+body]
        ['size' (numb:enjs:format (met 3 body))]
        ['rev' (numb:enjs:format ud.cass.cn)]
        ['mtime' s+(scot %da da.cass.cn)]
        ['share' s+mode]
    ==
  html-row
::  +fs-err-text: a page's latest evaluator error ('' = clean or no such page).
++  fs-err-text
  |=  name=@t
  =/  m  (fiber:fiber:nexus ,@t)
  ^-  form:m
  ?.  (valid-name name)  (pure:m '')
  =/  pdir=path  (weld app-base:lu (weld /page (pax-of name)))
  ;<  en=view:nexus  bind:m  (peek:io [%& %& pdir %err] ~)
  ?.  ?=([%file *] en)  (pure:m '')
  (pure:m (fall (mole |.(;;(@t (sang-noun:tarball sang.en)))) ''))
::  +fs-poke-eval: poke the writer (main.sig) with an eval-action. Called from the
::  /fs.sig fiber, which sits at the app root as a sibling of main.sig — so the
::  road is a fixed up-0 (unlike +poke-eval's up-2 from /ui/requests).
++  fs-poke-eval
  |=  act=eval-action:le
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (poke:io [%| 0 %& ~ %'main.sig'] [[/lattice %eval-action] act])
::  +fs-save: create/overwrite a page (POST /page-save + lick %page-save).
::  Mirrors the HTTP route: index generates its own body; a content type wraps
::  the body; ?new rejects an existing page with 409.
++  fs-save
  |=  [name=@t ptype=@tas new=? raw=@t]
  =/  m  (fiber:fiber:nexus ,[status=@ud rbody=@t])
  ^-  form:m
  ?.  (valid-name name)  (pure:m [400 'bad name'])
  =/  is-index=?  =(%index ptype)
  ?:  &(?!(is-index) =('' raw))  (pure:m [400 'missing body'])
  =/  src=@t
    ?:  is-index  (make-folder-index (pax-of name))
    ?:((~(has in content-builders) ptype) (wrap-content ptype raw) raw)
  ;<  ex=?  bind:m
    (peek-exists:io [%& %& (weld app-base:lu (weld /page (pax-of name))) %code])
  ?:  &(new ex)  (pure:m [409 'page exists'])
  ;<  ~  bind:m  (fs-poke-eval [%make (pax-of name) src])
  (pure:m [200 ''])
::  +fs-mkdir / +fs-del: folder create / page-or-folder delete.
++  fs-mkdir
  |=  name=@t
  =/  m  (fiber:fiber:nexus ,[status=@ud rbody=@t])
  ^-  form:m
  ?.  (valid-name name)  (pure:m [400 'bad name'])
  ;<  ~  bind:m  (fs-poke-eval [%mkdir (pax-of name)])
  (pure:m [200 ''])
++  fs-del
  |=  name=@t
  =/  m  (fiber:fiber:nexus ,[status=@ud rbody=@t])
  ^-  form:m
  ?.  (valid-name name)  (pure:m [400 'bad name'])
  ;<  ~  bind:m  (fs-poke-eval [%del (pax-of name)])
  (pure:m [200 ''])
::  +fs-op: the shared request dispatcher. `path`'s last segment selects the op;
::  `query` is "k=v&k=v" (raw, page names are @ta so need no url-decode). Returns
::  [status body] — for the lick port to spit, and for the HTTP routes to send.
++  fs-op
  |=  [verb=@t path=@t query=@t body=@t]
  =/  m  (fiber:fiber:nexus ,[status=@ud rbody=@t])
  ^-  form:m
  =/  q=(map @t @t)  (parse-q query)
  =/  act=@tas  (fall (mole |.(`@tas`(rear (stab path)))) %$)
  ?+    act  (pure:m [404 'no such op'])
      %page-tree
    ;<  j=json  bind:m  fs-tree-json
    (pure:m [200 (en:json:html j)])
      %page-dump
    ;<  j=json  bind:m  fs-dump-json
    (pure:m [200 (en:json:html j)])
      %page-source
    =/  name=(unit @t)  (~(get by q) 'name')
    ?~  name  (pure:m [400 'missing name'])
    ;<  r=(each json [code=@ud msg=@t])  bind:m  (fs-source-result u.name %.n)
    ?-  -.r
      %&  (pure:m [200 (en:json:html p.r)])
      %|  (pure:m [code.p.r msg.p.r])
    ==
      %page-errors
    =/  name=(unit @t)  (~(get by q) 'name')
    ?~  name  (pure:m [400 'missing name'])
    ;<  t=@t  bind:m  (fs-err-text u.name)
    (pure:m [200 t])
      %page-save
    =/  name=(unit @t)  (~(get by q) 'name')
    ?~  name  (pure:m [400 'missing name'])
    =/  ptype=@tas  `@tas`(~(gut by q) 'type' 'hoon')
    (fs-save u.name ptype (~(has by q) 'new') body)
      %folder-new
    =/  name=(unit @t)  (~(get by q) 'name')
    ?~  name  (pure:m [400 'missing name'])
    (fs-mkdir u.name)
      %page-del
    =/  name=(unit @t)  (~(get by q) 'name')
    ?~  name  (pure:m [400 'missing name'])
    (fs-del u.name)
  ==
::  +fs-port: the lick unix-socket port; vere serves it at the pier path
::  .urb/dev/grubbery/lattice/fs.
++  fs-port  ^-  path  /lattice/fs
::  +fs-split-on: split a tape on a delimiter char, dropping the delimiter.
++  fs-split-on
  |=  [t=tape c=@tD]
  ^-  (list tape)
  =/  i=(unit @ud)  (find ~[c] t)
  ?~  i  ~[t]
  [(scag u.i t) $(t (slag +(u.i) t))]
::  +parse-q: "a=1&b=2" -> a map (values NOT url-decoded; the lick client sends
::  page names raw and they are @ta, so contain no & or =).
++  parse-q
  |=  q=@t
  ^-  (map @t @t)
  ?:  =('' q)  ~
  %-  malt
  %+  turn  (fs-split-on (trip q) '&')
  |=  p=tape
  ^-  [@t @t]
  =/  i=(unit @ud)  (find "=" p)
  ?~  i  [(crip p) '']
  [(crip (scag u.i p)) (crip (slag +(u.i) p))]
::  +read-know-map: peek the whole know vault into a (map path know-entry).
::
++  read-know-map
  =/  m  (fiber:fiber:nexus ,(map path know-entry:lk))
  ^-  form:m
  ;<  seen=view:nexus  bind:m  (peek:io [%| 2 %| /know/vault] ~)
  ?.  ?=([%ball *] seen)  (pure:m ~)
  (pure:m (collect-entries ~ ball.seen))
::  +read-know-vault-safe: +read-know-map, but distinguishing "the vault is
::  empty" from "the vault could not be read" (~). Callers that would OVERWRITE
::  based on absence must use this one — see the legacy import.
++  read-know-vault-safe
  =/  m  (fiber:fiber:nexus ,(unit (map path know-entry:lk)))
  ^-  form:m
  ;<  seen=view:nexus  bind:m  (peek:io [%| 2 %| /know/vault] ~)
  ?.  ?=([%ball *] seen)  (pure:m ~)
  (pure:m `(collect-entries ~ ball.seen))
::  +serve-ui: stream a ui-app asset grub. MIME from the (whitelisted) name;
::  anything unknown 404s. Assets are grubs so the request-fiber core stays
::  small — never serve big blobs from core constants.
::
++  serve-ui
  |=  [eyre-id=@ta rest=path]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  nam=@ta  ?~(rest %'index.html' i.rest)
  =/  ct=(unit @t)
    ?:  =(%'index.html' nam)  `'text/html'
    ?:  =(%'app.js' nam)      `'text/javascript'
    ~
  ?~  ct  (send-err eyre-id 404 'not found')
  ;<  pv=view:nexus  bind:m  (peek:io [%& %& (weld app-base:lu /app) nam] ~)
  ?.  ?=([%file *] pv)  (send-err eyre-id 404 'not found')
  =/  res=(each mime tang)  (mule |.(!<(mime (need-vase:tarball sang.pv))))
  ?:  ?=(%| -.res)  (send-err eyre-id 500 'bad asset')
  %+  send-simple:srv  eyre-id
  :-  [200 ~[['content-type' u.ct] ['cache-control' 'no-cache']]]
  `q.p.res
::  +serve-know: the private knowledge view (builders in /lib/lattice-know-view).
::  The keep on /beacon/rev live-reloads an open view whenever the writer
::  mutates the store, so a memory saved by a session appears without a refresh.
::
++  serve-know
  |=  [eyre-id=@ta rest=path args=(map @t @t)]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ;<  es=(map path know-entry:lk)  bind:m  read-know-map
  ::  tolerate accidental double slashes (/know//feedback): drop empty segments.
  =.  rest  (skip rest |=(s=@ta =('' s)))
  ?~  rest
    =/  tsel=(unit @t)  (~(get by args) 'tag')
    ?^  tsel
      (send-view eyre-id (render-page "know" (keep-url "beacon/rev") (know-flat-html:lkv es u.tsel)))
    (send-view eyre-id (render-page "know" (keep-url "beacon/rev") (know-dir-html:lkv es ~ ~ (tag-chips:lkv es ''))))
  =/  page=(unit tape)  (know-node-html:lkv es `path`rest)
  ?~  page
    (send-view eyre-id (render-page "know" "" "<p class=\"err\">no such entry</p>"))
  (send-view eyre-id (render-page (weld "know" (spud rest)) (keep-url "beacon/rev") u.page))
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
  ::  reject the empty key ('' -> stab '/' -> empty path), which would otherwise
  ::  wrap as a valid unit and pass the routes' ?~ ko guard.
  ?:(?=(%& -.res) ?~(p.res ~ `p.res) ~)
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
  =/  m  (fiber:fiber:nexus ,(unit view:nexus))
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
  =/  m  (fiber:fiber:nexus ,(unit view:nexus))
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
  =/  m  (fiber:fiber:nexus ,(unit view:nexus))
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
    [%done `view.u.in]
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
  ;<  ~  bind:m  (poke:io &+&+[/sys %'bowl.sig'] [[/ %bowl-req] %our])
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
  ;<  ~  bind:m  (poke:io &+&+[/sys %'bowl.sig'] [[/ %bowl-req] %now])
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
  |=  [our=@p shp=@p rel=path]
  =/  m  (fiber:fiber:nexus ,(unit @t))
  ^-  form:m
  ::  `our` is a parameter, not a bowl-our bind — callers already hold it (the
  ::  owner gate's src, or their own binding), and the /sys/bowl round trip
  ::  cost ~0.2s on every reader view for a value that never changes.
  ::  tolerate a catalog-row url form: catalog stores url as urb://<pub>/pub/<spur>/gmi
  ::  (the content-map key), so a client that round-trips a /catalog-* result into
  ::  /fetch or the reader passes rel=/pub/<spur>/gmi. Strip the leading pub +
  ::  trailing gmi back to the vault-relative /<spur> /fetch expects. A plain vault
  ::  rel (no leading pub / no trailing gmi) is untouched. ponytail: a page literally
  ::  published as "pub/…/gmi" would be mis-normalized — accepted, that key is absurd.
  =/  rel=path  (page-rel rel)
  ::  own pages: ABSOLUTE road via app-base (the nexus's fixed tree path), so this
  ::  resolves the same from the depth-2 request fiber and the depth-0 crawler.
  =/  road=road:tarball
    [%& %& (weld (weld app-base:lu /pub/vault) rel) %gmi]
  ?:  =(shp our)
    ;<  seen=view:nexus  bind:m  (peek:io road ~)
    ?.  ?=([%file *] seen)  (pure:m ~)
    (pure:m `!<(@t (need-vase:tarball sang.seen)))
  ;<  ms=(unit view:nexus)  bind:m  (peek-remote-wait road shp)
  ?~  ms  (pure:m ~)
  ?.  ?=([%file *] u.ms)  (pure:m ~)
  ::  CROSS-SHIP peek content is a boom (raw noun), NOT a vase — need-vase would
  ::  crash. Extract via sang-noun and clam in a mule so a malformed/hostile peer
  ::  body yields ~ (clean 404) instead of a crash.
  =/  res=(each @t tang)  (mule |.(;;(@t (sang-noun:tarball sang.u.ms))))
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
  =/  canon=tape  (trip (en-urb:lu u.shp pax))
  =/  dir-road=road:tarball  [%& %| pax]
  ?~  pax
    ::  ship root: always a directory
    ?.  slashed  (send-redirect eyre-id (weld base "/"))
    ?:  =(u.shp our)
      ;<  dn=view:nexus  bind:m  (peek-shallow:io dir-road ~)
      ?.  ?=([%ball *] dn)  (send-err eyre-id 404 'not found')
      (send-view eyre-id (render-page canon "" (explore-dir-html u.shp pax ball.dn)))
    ;<  md=(unit view:nexus)  bind:m  (peek-remote-shallow-wait dir-road u.shp)
    ?~  md  (send-err eyre-id 504 'unreachable or denied')
    ?.  ?=([%ball *] u.md)  (send-err eyre-id 404 'not found')
    (send-view eyre-id (render-page canon "" (explore-dir-html u.shp pax ball.u.md)))
  =/  file-road=road:tarball  [%& %& (snip `path`pax) (rear pax)]
  ?:  =(u.shp our)
    ?:  slashed
      ;<  dn=view:nexus  bind:m  (peek-shallow:io dir-road ~)
      ?:  ?=([%ball *] dn)
        ::  our own /page/<name>/ dir -> the live page view (data + command
        ::  form + SSE), unless ?raw asks for the plain grub listing. A page has
        ::  a /code grub; a plain folder does not, so a folder just browses.
        =/  pn=(unit @t)  (page-dir-name pax)
        =/  fils=(map @ta [=sang:tarball gain=? bang=(unit tang)])
          ?~(fil.ball.dn ~ contents.u.fil.ball.dn)
        ?:  |(?=(~ pn) ?!((~(has by fils) %code)) (~(has by args) 'raw'))
          (send-view eyre-id (render-page canon "" (explore-dir-html u.shp pax ball.dn)))
        (render-page-view eyre-id u.shp pax u.pn ball.dn (~(has by args) 'embed') %.y)
      ;<  fn=view:nexus  bind:m  (peek:io file-road ~)
      ?.  ?=([%file *] fn)  (send-err eyre-id 404 'not found')
      ?:  want-raw  (send-raw eyre-id sang.fn %.y)
      (send-view eyre-id (render-page canon "" (explore-file-html u.shp pax sang.fn %.y)))
    ;<  fn=view:nexus  bind:m  (peek:io file-road ~)
    ?:  ?=([%file *] fn)
      ?:  want-raw  (send-raw eyre-id sang.fn %.y)
      (send-view eyre-id (render-page canon "" (explore-file-html u.shp pax sang.fn %.y)))
    ;<  dn=view:nexus  bind:m  (peek-shallow:io dir-road ~)
    ?.  ?=([%ball *] dn)  (send-err eyre-id 404 'not found')
    (send-redirect eyre-id (weld base "/"))
  ?:  slashed
    ;<  md=(unit view:nexus)  bind:m  (peek-remote-shallow-wait dir-road u.shp)
    ?~  md  (send-err eyre-id 504 'unreachable or denied')
    ?:  ?=([%ball *] u.md)
      ::  a peer's /page/<name>/ dir renders as the clearweb-style page — sandboxed
      ::  (untrusted html/js), unthemed, read-only — unless ?raw asks for the plain
      ::  grub listing. A plain folder (no /code grub) still browses as a listing.
      =/  pn=(unit @t)  (page-dir-name pax)
      =/  fils=(map @ta [=sang:tarball gain=? bang=(unit tang)])
        ?~(fil.ball.u.md ~ contents.u.fil.ball.u.md)
      ?:  |(?=(~ pn) ?!((~(has by fils) %code)) (~(has by args) 'raw'))
        (send-view eyre-id (render-page canon "" (explore-dir-html u.shp pax ball.u.md)))
      (render-page-view eyre-id u.shp pax u.pn ball.u.md %.n %.n)
    ;<  mf=(unit view:nexus)  bind:m  (peek-remote-wait file-road u.shp)
    ?~  mf  (send-err eyre-id 504 'unreachable or denied')
    ?.  ?=([%file *] u.mf)  (send-err eyre-id 404 'not found')
    ?:  want-raw  (send-raw eyre-id sang.u.mf %.n)
    (send-view eyre-id (render-page canon "" (explore-file-html u.shp pax sang.u.mf %.n)))
  ;<  mf=(unit view:nexus)  bind:m  (peek-remote-wait file-road u.shp)
  ?~  mf  (send-err eyre-id 504 'unreachable or denied')
  ?:  ?=([%file *] u.mf)
    ?:  want-raw  (send-raw eyre-id sang.u.mf %.n)
    (send-view eyre-id (render-page canon "" (explore-file-html u.shp pax sang.u.mf %.n)))
  ;<  md=(unit view:nexus)  bind:m  (peek-remote-shallow-wait dir-road u.shp)
  ?~  md  (send-err eyre-id 504 'unreachable or denied')
  ?.  ?=([%ball *] u.md)  (send-err eyre-id 404 'not found')
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
  ?.  =(`path`[i.pax i.t.pax ~] app-base:lu)  ~
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
  ::  local=%.n: a PEER's page (browsed over ames) — rendered in a SANDBOXED frame
  ::  (its html/js is untrusted), no theme peek (that would read OUR tree), no Edit
  ::  button, no live keep. local=%.y: our own page, fully themed + editable + live.
  |=  [eyre-id=@ta shp=@p pax=path name=@t b=ball:tarball embed=? local=?]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  =/  fils=(map @ta [=sang:tarball gain=? bang=(unit tang)])
    ?~(fil.b ~ contents.u.fil.b)
  =/  grub  |=(nom=@ta ^-((unit sang:tarball) =/(v (~(get by fils) nom) ?~(v ~ `sang.u.v))))
  =/  vmode=view-mode:pg
    =/  sw=(unit sang:tarball)  (grub %show)
    ?~  sw  %text
    (fall (mole |.(;;(view-mode:pg (sang-noun:tarball u.sw)))) %text)
  =/  err=@t
    =/  ce=(unit sang:tarball)  (grub %err)
    ?~  ce  ''
    (fall (mole |.(;;(@t (sang-noun:tarball u.ce)))) '')
  =/  cd=(unit sang:tarball)  (grub %data)
  ::  own lean SSE (no ?blot=/txt): a page dir's noun grubs render huge under
  ::  /txt on the initial snapshot, and the reload script reads only event
  ::  names, never the payload — so keep="" to render-* and append a blot-free
  ::  stream here.
  =/  keep=tape  (keep-url "beacon/rev")
  ?:  embed
    ::  bare preview: just the rendered data (+ any error) and the live stream.
    =/  data-html=tape  ?~(cd "<p>no data yet</p>" (render-shown u.cd vmode "/apps/lattice/app?name="))
    =/  errh=tape  ?:(=('' err) "" :(weld "<pre class=\"err\">" (esc (trip err)) "</pre>"))
    (send-html eyre-id (render-bare :(weld errh "<section class=\"data\">" data-html "</section>" (page-sse-script keep))))
  ::  standalone browser view: the page rendered exactly as it would publish. For
  ::  our own page the nearest theme is inlined (owner-gated, so it need not be
  ::  clearweb-shared) and it gets an Edit button + live-reload; a peer's page is
  ::  sandboxed and unthemed. No sharing/command controls — those live in the
  ::  editor. `rel` strips the app-base/page/ prefix to the page-relative path that
  ::  find-theme-css/clearweb-doc expect (the same shape serve-clearweb passes).
  =/  rel=path  (slag 3 pax)
  ;<  head=tape  bind:m  (browser-head local vmode rel)
  ::  comments live in OUR tree, so only show them on OUR OWN pages — a peer's
  ::  page at a path that collides with one of ours must NOT surface our comments
  ::  or toggle. (Reading a peer's own comments waits for the cross-ship path.)
  ;<  ocon=?  bind:m  (comments-on rel)
  =/  con=?  &(local ocon)
  ::  our own view also gets a comment box (posts to /comment as us). A peer's box
  ::  — which posts to OUR nexus, which then pokes the peer — comes with the
  ::  cross-ship path.
  =/  box=tape
    ?.  con  ""
    ;:  weld
      "<form class=\"cbox\" method=\"post\" target=\"_top\" action=\"/apps/lattice/comment?page="
      (trip name)
      "\"><textarea name=\"body\" placeholder=\"Comment as "
      (scow %p shp)
      "\" required></textarea><button type=\"submit\">Post</button></form>"
    ==
  ;<  extra=tape  bind:m  (render-comments rel con box)
  ::  cap a hostile PEER's data (own data is trusted): a big cord, OR any non-cord
  ::  noun (page-data-html would pretty-print it unbounded). Bounds the render
  ::  doubling + response, like explore-file-html's 1MB preview cap.
  =/  toobig=?
    ?:  local  %.n
    ?~  cd  %.n
    =/  r=(each @t tang)  (mule |.(;;(@t (sang-noun:tarball u.cd))))
    ?|(?=(%| -.r) (gth (met 3 p.r) (bex 20)))
  =/  doc=@t
    ?:  toobig  (render-clearweb (pax-str rel) head "<p>page too large or not previewable</p>")
    ?~  cd  (render-clearweb (pax-str rel) head "<p>no data yet</p>")
    ::  our own page view links into the editor; a peer's page keeps the
    ::  public form (we cannot link into their editor).
    %-  clearweb-doc
    :*  rel  u.cd  vmode  head  ?!(?=(%html vmode))  ~  extra
        ?:(local "/apps/lattice/app?name=" "/apps/lattice/c/")
    ==
  %-  send-html
  :-  eyre-id
  %^    render-browser-page
      (trip (en-urb:lu shp pax))
    doc
  [?:(local `name ~) ?!(local) ?:(local keep "")]
::  +preview-inner: the rendered-preview HTML fragment for a page kind — the
::  single renderer behind POST /page-preview AND page-source?render=1, so the
::  editor preview can never drift from the reader. Wikilinkify only runs for
::  the markdown paths (it reads [[...]] syntax the other kinds do not have).
::
++  preview-inner
  |=  [ptype=@tas body=@t]
  ^-  tape
  ?+  ptype  (render-md:gfm (crip (wikilinkify (trip body) "/apps/lattice/app?name=")))
    %md    (render-md:gfm (crip (wikilinkify (trip body) "/apps/lattice/app?name=")))
    %gmi   (render-gmi body)
    %html  (trip body)
    %text  :(weld "<pre>" (esc (trip body)) "</pre>")
    %js    :(weld "<pre><code class=\"language-javascript\">" (esc (trip body)) "</code></pre>")
    %css   :(weld "<pre><code class=\"language-css\">" (esc (trip body)) "</code></pre>")
    %index  "<div style=\"color:#8a8a8a;text-align:center;padding:2rem\"><p><b>Folder index</b></p><p>Lists the pages in this page's folder automatically, once you name it (e.g. blog/index) and save. Live as pages come and go.</p></div>"
  ==
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
  =/  pdir=path  (weld app-base:lu (weld /page pax))
  ;<  dsn=view:nexus  bind:m  (peek:io [%& %& pdir %data] ~)
  ?.  ?=([%file *] dsn)  (send-err eyre-id 404 'not found')
  ;<  vmode=view-mode:pg  bind:m  (read-show-mode pdir)
  =/  res=(each @t tang)  (mule |.(;;(@t (sang-noun:tarball sang.dsn))))
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
  =/  tdir=path  (weld app-base:lu (weld /page (weld anc /theme)))
  ;<  mode=share-mode:le  bind:m  (read-share tdir)
  ;<  show=view-mode:pg   bind:m  (read-show-mode tdir)
  ?:  &(?=(%clearweb mode) ?=(%css show))  (pure:m `anc)
  ?~  anc  (pure:m ~)
  $(anc (snip `path`anc))
::  +clearweb-doc: the standalone chrome-less document for a page — theme in the
::  <head>, body per view-mode. %html inlines raw (owns its own layout); a
::  md/gmi/text/noun body is wrapped in <main class="page"> (with an optional home
::  link) when `wrap`; css/js show as a code block. `head` is the caller's theme
::  <head> (a <link>, inline <style>, or the default reader css). Shared by
::  serve-clearweb (/c/, links a shared theme) and the browser page view (owner-
::  gated, inlines any theme). On PEER data it is only ever rendered inside a
::  sandboxed frame — the sandbox, not escaping, is what neutralizes hostile html.
::
++  clearweb-doc
  |=  [pax=path =sang:tarball vmode=view-mode:pg head=tape wrap=? home=(unit tape) extra=tape base=tape]
  ^-  @t
  ::  `extra` (a rendered comment thread + optional box) is appended after the
  ::  page content — inside the themed wrapper for md/gmi/text, or after the raw
  ::  body for %html.
  ::  `base` is the wikilink target root: /c/ on the public surface, the editor
  ::  on an owner view. Hardcoding /c/ here made every wikilink on the owner's
  ::  own page view dead, since pages are private by default.
  =/  inner=tape  (weld (render-shown sang vmode base) extra)
  =/  body=tape
    ?:  ?=(%html vmode)  inner
    ?.  wrap  inner
    =/  hlink=tape
      ?~  home  ""
      :(weld "<p class=\"home\"><a href=\"" (esc u.home) "\">&larr; home</a></p>")
    :(weld "<main class=\"page\">" hlink inner "</main>")
  (render-clearweb (pax-str pax) head body)
::  +render-comments: the comment thread for `page` (page-relative path) as escaped
::  html, oldest first. `box` is an optional trailing comment form (browser views
::  only). "" when the page has no comments and no box. Read here (a peek) rather
::  than in the pure +clearweb-doc; the result is passed in as its `extra`.
::
++  render-comments
  |=  [page=path on=? box=tape]
  =/  m  (fiber:fiber:nexus ,tape)
  ^-  form:m
  ?.  on  (pure:m "")
  ;<  seen=view:nexus  bind:m  (peek:io [%& %| (weld app-base:lu (weld /comments page))] ~)
  =/  cs=(list comment:lc)
    ?.  ?=([%ball *] seen)  ~
    =/  b=ball:tarball  ball.seen
    =/  fils=(map @ta [=sang:tarball gain=? bang=(unit tang)])
      ?~(fil.b ~ contents.u.fil.b)
    %+  murn  ~(val by fils)
    |=  [s=sang:tarball gain=? bang=(unit tang)]
    ^-  (unit comment:lc)
    (mole |.(;;(comment:lc (sang-noun:tarball s))))
  =/  sorted=(list comment:lc)
    (sort cs |=([a=comment:lc b=comment:lc] (lth when.a when.b)))
  ?:  &(?=(~ sorted) =("" box))  (pure:m "")
  =/  thread=tape
    ?~  sorted  ""
    ;:  weld
      "<section class=\"comments\"><h3>"  (a-co:co (lent sorted))
      ?:(=(1 (lent sorted)) " comment</h3>" " comments</h3>")
      ^-  tape
      (zing (turn sorted comment-html))
      "</section>"
    ==
  ::  single-quote cord: a double-quote tape would interpolate the css { } braces.
  %-  pure:m
  ;:  weld
    %-  trip
    '<style>.comments{margin-top:2rem;border-top:1px solid #8886;padding-top:1rem}.comment{margin:.7rem 0;padding:.5rem .8rem;background:#8881;border-radius:8px}.cmeta{margin:0;font-size:.85em;opacity:.7}.cbody{margin:.2rem 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.cbox{margin-top:1rem;display:flex;gap:6px}.cbox textarea{flex:1;min-height:3rem;font:inherit;padding:6px;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit}.cbox button{padding:0 14px;font:inherit;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit;cursor:pointer}</style>'
    thread
    box
  ==
::  +comment-html: one stored comment as escaped html (author + body).
::
++  comment-html
  |=  c=comment:lc
  ^-  tape
  ;:  weld
    "<article class=\"comment\"><p class=\"cmeta\">"  (scow %p author.c)
    "</p><p class=\"cbody\">"  (esc (trip body.c))  "</p></article>"
  ==
::  +find-theme-css: the nearest `theme` css page AT/ABOVE pax's parent, as inline
::  css text — for the owner-gated browser view, which (unlike /c/) themes a page
::  whose theme need not be clearweb-shared, so it inlines rather than links. ~ if
::  none up to the root. A nearer theme whose data is unreadable is skipped.
::
++  find-theme-css
  |=  pax=path
  =/  m  (fiber:fiber:nexus ,(unit @t))
  ^-  form:m
  =/  anc=path  (snip `path`pax)
  |-  ^-  form:m
  =/  tdir=path  (weld app-base:lu (weld /page (weld anc /theme)))
  ;<  show=view-mode:pg  bind:m  (read-show-mode tdir)
  ?:  ?=(%css show)
    ;<  dsn=view:nexus  bind:m  (peek:io [%& %& tdir %data] ~)
    =/  css=(unit @t)
      ?.  ?=([%file *] dsn)  ~
      =/  r=(each @t tang)  (mule |.(;;(@t (sang-noun:tarball sang.dsn))))
      ?:(?=(%& -.r) `p.r ~)
    ?^  css  (pure:m css)
    ?~  anc  (pure:m ~)
    $(anc (snip `path`anc))
  ?~  anc  (pure:m ~)
  $(anc (snip `path`anc))
::  +browser-head: the <head> theme content for the browser page view. Our own
::  page (local) inlines its nearest theme; a peer's page skips the theme peek
::  (that would read OUR tree) and falls back to the default reader css. Its own
::  monad type so it can produce a tape (render-page-view's monad returns ~).
::
++  browser-head
  |=  [local=? vmode=view-mode:pg rel=path]
  =/  m  (fiber:fiber:nexus ,tape)
  ^-  form:m
  =/  dflt=tape  ?:(?=(%html vmode) "" :(weld "<style>" web-css "</style>"))
  ?.  local  (pure:m dflt)
  ;<  tcss=(unit @t)  bind:m  (find-theme-css rel)
  (pure:m ?^(tcss :(weld "<style>" (trip u.tcss) "</style>") dflt))
::  +serve-clearweb: the public read of a %clearweb page. Read-only, data grub
::  only — a non-clearweb (or absent) page is a flat 404 so private siblings
::  never leak existence. No SSE (an anon keep would 403 anyway).
::
::  +forms-on: is public form submission enabled at or above this page? Same
::  nearest-flag-wins walk as +comments-on, so a folder opts in a whole site.
::
++  forms-on
  |=  page=path
  =/  m  (fiber:fiber:nexus ,?)
  ^-  form:m
  |-  ^-  form:m
  =/  fdir=path  (weld app-base:lu (weld /page page))
  ;<  seen=view:nexus  bind:m  (peek:io [%& %& fdir %forms-on] ~)
  ?:  ?=([%file *] seen)
    (pure:m (fall (mole |.(;;(? (sang-noun:tarball sang.seen)))) %.n))
  ?~  page  (pure:m %.n)
  $(page (snip `path`page))
::  +read-form-cfg: a page's form limits, nearest-wins up the tree (like the
::  on/off flag), so a folder can set the policy for a whole site.
::
++  read-form-cfg
  |=  page=path
  =/  m  (fiber:fiber:nexus ,form-cfg:le)
  ^-  form:m
  |-  ^-  form:m
  =/  fdir=path  (weld app-base:lu (weld /page page))
  ;<  seen=view:nexus  bind:m  (peek:io [%& %& fdir %'forms-cfg'] ~)
  ?:  ?=([%file *] seen)
    (pure:m (fall (mole |.(;;(form-cfg:le (sang-noun:tarball sang.seen)))) [0 *@dr]))
  ?~  page  (pure:m [0 *@dr])
  $(page (snip `path`page))
::  +read-form-use: a page's submission tally. EXACT — never inherited.
::
++  read-form-use
  |=  page=path
  =/  m  (fiber:fiber:nexus ,form-use:le)
  ^-  form:m
  =/  fdir=path  (weld app-base:lu (weld /page page))
  ;<  seen=view:nexus  bind:m  (peek:io [%& %& fdir %'forms-use'] ~)
  ?.  ?=([%file *] seen)  (pure:m [0 *@da])
  (pure:m (fall (mole |.(;;(form-use:le (sang-noun:tarball sang.seen)))) [0 *@da]))
::  +serve-form: accept a public form POST for a page and deliver it as a
::  command. Requires clearweb + forms-on; the body is capped, and the reply
::  is a redirect back to the page so a plain <form> works with no JS.
::
++  serve-form
  |=  [eyre-id=@ta pax=path body=@t]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?.  (levy pax |=(seg=@ta &(!=(%$ seg) ((sane %ta) seg))))
    (send-err eyre-id 404 'not found')
  =/  pdir=path  (weld app-base:lu (weld /page pax))
  ;<  mode=share-mode:le  bind:m  (read-share pdir)
  ?.  ?=(%clearweb mode)  (send-err eyre-id 404 'not found')
  ;<  on=?  bind:m  (forms-on pax)
  ?.  on  (send-err eyre-id 403 'forms not enabled')
  ;<  ex=?  bind:m  (peek-exists:io [%& %& pdir %code])
  ?.  ex  (send-err eyre-id 404 'not found')
  ?:  (gth (met 3 body) form-body-max)  (send-err eyre-id 413 'too large')
  ::  the two owner-set limits. Both are checked HERE rather than in the writer
  ::  so a refused submission gets an honest 429 instead of a 303 that pretends
  ::  it landed; the cost is that a simultaneous burst can overshoot the cap by
  ::  the number of requests in flight.
  ;<  cfg=form-cfg:le  bind:m  (read-form-cfg pax)
  ;<  use=form-use:le  bind:m  (read-form-use pax)
  ;<  now=@da  bind:m  bowl-now
  ?:  &(?!(=(0 cap.cfg)) (gte count.use cap.cfg))
    (send-err eyre-id 429 'submission limit reached')
  ::  cooldown. Guard the subtraction: a clock adjustment could leave `last` in
  ::  the future, and (sub now last) would underflow and crash the fiber.
  =/  since=@dr  ?:((gth last.use now) *@dr (sub now last.use))
  ?:  &(?!(=(*@dr gap.cfg)) (lth since gap.cfg))
    (send-err eyre-id 429 'too soon, try again shortly')
  ;<  ~  bind:m  (poke-eval [%cmd pax body 0])
  ;<  ~  bind:m  (poke-eval [%form-hit pax now])
  %+  send-see-other  eyre-id
  :(weld "/apps/lattice/c" (spud pax))
::  +form-body-max: cap on a public submission (8 KB). A public write surface
::  needs a size bound; the page's own gate decides what the text means.
::
++  form-body-max  ^~((mul 8 1.024))
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
  =/  pdir=path  (weld app-base:lu (weld /page pax))
  ;<  mode=share-mode:le  bind:m  (read-share pdir)
  ?.  ?=(%clearweb mode)  (send-err eyre-id 404 'not found')
  ;<  dsn=view:nexus  bind:m  (peek:io [%& %& pdir %data] ~)
  ;<  vmode=view-mode:pg  bind:m  (read-show-mode pdir)
  ?.  ?=([%file *] dsn)
    (send-html eyre-id (render-clearweb (pax-str pax) "" "<p>no data</p>"))
  ::  css/js serve RAW (a public page links them as a stylesheet/script, so they
  ::  must NOT go through render-shown's <pre><code> wrap); everything else
  ::  renders per its view-mode into a bare, chrome-less standalone document.
  ?:  ?=(?(%css %js) vmode)
    =/  res=(each @t tang)  (mule |.(;;(@t (sang-noun:tarball sang.dsn))))
    ?:  ?=(%| -.res)  (send-err eyre-id 415 'not servable')
    (send-typed eyre-id (mime-of vmode) 'no-cache' p.res)
  ::  Every rendered/html page auto-wears the nearest `theme` css up the folder
  ::  tree, LINKED IN THE HEAD (render-blocking -> no white flash on nav, browser-
  ::  cached across the site). A rendered page (md/gmi/text/noun) also gets a
  ::  "page" wrapper + a home link; %html owns its own body layout. With no theme,
  ::  %html gets nothing (it owns its styling) and md/gmi/text get the reader css.
  ;<  tf=(unit path)  bind:m  (find-theme pax)
  =/  head=tape
    ?^  tf  :(weld "<link rel=\"stylesheet\" href=\"/apps/lattice/c" (spud (weld u.tf /theme)) "\">")
    ?:(?=(%html vmode) "" :(weld "<style>" web-css "</style>"))
  =/  home=(unit tape)
    ?~(tf ~ `(weld "/apps/lattice/c" (spud (weld u.tf /index))))
  ::  a public clearweb visitor is anonymous (no ship), so the thread is read-only
  ::  here — no comment box (box=""). Commenting happens from a ship's browser.
  ;<  con=?    bind:m  (comments-on pax)
  ;<  cmts=tape  bind:m  (render-comments pax con "")
  %+  send-html  eyre-id
  (clearweb-doc pax sang.dsn vmode head ?=(^ tf) home cmts "/apps/lattice/c/")
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
::  +wikilinkify: rewrite [[page-name]] into a standard markdown link
::  [page-name](<base>page-name) BEFORE rendering, so wikilinks work on every
::  md surface. Only path-ish names rewrite (a-z 0-9 - / . _ ~); anything
::  else passes through untouched. `base` is the surface's link root: the
::  editor for owner views, /c/ for clearweb.
::
++  wiki-name-len
  |=  t=tape
  ^-  @ud
  =|  n=@ud
  |-  ^-  @ud
  ?~  t  n
  ?.  ?|  &((gte i.t 'a') (lte i.t 'z'))
          &((gte i.t '0') (lte i.t '9'))
          =(i.t '-')  =(i.t '/')  =(i.t '.')  =(i.t '_')  =(i.t '~')
      ==
    n
  $(t t.t, n +(n))
++  wikilinkify
  |=  [t=tape base=tape]
  ^-  tape
  |-  ^-  tape
  ?~  t  ~
  ::  code is verbatim: skip a ``` fence or a ` span whole, so a wikilink
  ::  inside a code sample stays literal text. Without this there was no way
  ::  to SHOW [[x]] in a document — including documenting this syntax.
  ?:  =("```" (scag 3 `tape`t))
    =/  aft=tape  (slag 3 `tape`t)
    =/  end=(unit @ud)  (find "```" aft)
    ?~  end  t
    =/  n=@ud  (add u.end 3)
    (weld (scag 3 `tape`t) (weld (scag n aft) $(t (slag n aft))))
  ?:  =('`' i.t)
    =/  aft=tape  (slag 1 `tape`t)
    =/  end=(unit @ud)  (find "`" aft)
    ?~  end  [i.t $(t t.t)]
    =/  n=@ud  (add u.end 1)
    (weld "`" (weld (scag n aft) $(t (slag n aft))))
  ?.  =("[[" (scag 2 `tape`t))  [i.t $(t t.t)]
  ::  scan ONLY the legal-charset run, then require "]]" immediately after, so a
  ::  candidate costs the length of its name. The previous version searched the
  ::  whole remaining document for "]]" at every "[[" and, on a miss, dropped a
  ::  single character and searched again — quadratic. A body of repeated "[["
  ::  with no closer took ~6.5s at 40KB and, through the render route, wedged
  ::  the ship for hours from an UNAUTHENTICATED page view. This version is flat
  ::  (~0.5s at 100KB) and byte-identical on every edge case tested.
  =/  aft=tape  (slag 2 `tape`t)
  =/  n=@ud  (wiki-name-len aft)
  ?:  =(0 n)  [i.t $(t t.t)]
  ?.  =("]]" (scag 2 (slag n aft)))  [i.t $(t t.t)]
  =/  name=tape  (scag n aft)
  =/  rest=tape  (slag (add n 2) aft)
  =/  tail=tape  $(t rest)
  :(weld "[" name "](" base name ")" tail)
++  render-shown
  |=  [=sang:tarball mode=view-mode:pg base=tape]
  ^-  tape
  =/  nn=*  (sang-noun:tarball sang)
  =/  cr=(each @t tang)  (mule |.(;;(@t nn)))
  ?:  ?=(%| -.cr)  (page-data-html sang)
  ?-  mode
    %text  :(weld "<pre>" (esc (trip p.cr)) "</pre>")
    %html  (trip p.cr)
    %gmi   (render-gmi p.cr)
    %md    =/  wl=@t  (crip (wikilinkify (trip p.cr) base))
           (render-md:gfm wl)
    %js    :(weld "<pre><code class=\"language-javascript\">" (esc (trip p.cr)) "</code></pre>")
    %css   :(weld "<pre><code class=\"language-css\">" (esc (trip p.cr)) "</code></pre>")
    %noun  (page-data-html sang)
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
    ::  a %json grub holds a json NOUN. Re-encode it rather than calling it
    ::  opaque — and check this BEFORE the octs shape, because some json nouns
    ::  coincidentally nest as [@ud @] and were reported as "binary grub".
    ?:  =(%json mk)
      =/  jr=(each json tang)  (mule |.(;;(json nn)))
      ?:  ?=(%& -.jr)
        :(weld "<pre>" (esc (trip (en:json:html p.jr))) "</pre>")
      "<p>malformed json grub &middot; <a href=\"?data\">open raw</a></p>"
    =/  octs-res=(each [p=@ud q=@] tang)  (mule |.(;;([p=@ud q=@] nn)))
    ?:  ?=(%& -.octs-res)
      :(weld "<p>binary grub (" (a-co:co p.p.octs-res) " bytes)</p>")
    ::  %mime grubs are an app's own assets (html/css/js/images). Show them as
    ::  what they are rather than "opaque noun": HTML in a FRAME, never inlined
    ::  — inlining would run the asset's scripts in our origin with the owner's
    ::  session. Foreign frames get no scripts at all.
    =/  mime-res=(each mime tang)  (mule |.(;;(mime nn)))
    ?:  ?=(%& -.mime-res)
      =/  mt=path  p.p.mime-res
      =/  n=@ud   p.q.p.mime-res
      ?:  ?=([%text %html *] mt)
        %+  weld
          ::  OUR OWN asset: same-origin, so the app can authenticate its own
          ::  data fetches and actually work — without it the frame gets an
          ::  opaque origin, requests go out cookieless, and e.g. a calendar
          ::  renders its chrome with no events. This is our own installed
          ::  code, already running on this ship, so it is not new exposure.
          ::  A FOREIGN asset stays fully sandboxed: no scripts at all.
          ?:  local  "<iframe class=\"rawf\" src=\"?data\" sandbox=\"allow-scripts allow-forms allow-same-origin allow-popups\"></iframe>"
          "<iframe class=\"rawf\" src=\"?data\" sandbox=\"\"></iframe>"
        :(weld "<p class=\"muted\">" (spud mt) " &middot; " (a-co:co n) " bytes &middot; <a href=\"?data\">open raw</a></p>")
      ::  <img> renders svg WITHOUT executing its scripts, so it is safe for
      ::  foreign content too — unlike an inline <svg> or an iframe.
      ?:  ?=([%image *] mt)
        :(weld "<p><img src=\"?data\" alt=\"\"></p>" (mime-note mt n))
      ?:  ?=([%audio *] mt)
        :(weld "<p><audio controls src=\"?data\"></audio></p>" (mime-note mt n))
      ?:  ?=([%video *] mt)
        :(weld "<p><video controls class=\"rawf\" src=\"?data\"></video></p>" (mime-note mt n))
      ?:  ?=([%application %pdf *] mt)
        :(weld "<iframe class=\"rawf\" src=\"?data\" sandbox=\"\"></iframe>" (mime-note mt n))
      ::  text-ish assets (css, js, json, markdown, plain) are the bulk of an
      ::  app's tree — show the CONTENT, not just a size and a link.
      =/  txt=(unit @t)  (mime-text mt q.p.mime-res)
      ?^  txt
        %+  weld
          ?+  mt  :(weld "<pre>" (esc (trip u.txt)) "</pre>")
            [%text %markdown *]  (render-md:gfm u.txt)
            [%text %gemini *]    (render-gmi u.txt)
          ==
        (mime-note mt n)
      :(weld "<p>" (mime-note mt n) "</p>")
    "<p>opaque noun grub (not raw-servable)</p>"
  ::  edit link: only for OUR ball (a peer's grubs are not ours to write) and
  ::  only when the grub has recoverable text — a binary or opaque grub would
  ::  be destroyed by a text round-trip, so it gets no edit affordance at all.
  =/  editable=?  &(local ?=(^ (grub-text sang)))
  =/  edit-link=tape
    ?.  editable  ""
    ::  +spud, not +pax-str: the route parses this with +stab, which requires the
    ::  leading slash. pax-str omits it, so every edit link 400'd.
    :(weld " &middot; <a href=\"/apps/lattice/app?grub=" (esc (spud pax)) "\">edit</a>")
  ;:  weld
    (explore-crumbs shp pax)
    "<div class=\"meta\">mark "  (esc (trip mk))
    " &middot; <a href=\"?data\">raw</a>"  edit-link  "</div>"
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
  ::  a %mime grub carries its OWN type ([mite octs]) — an app's asset, e.g.
  ::  calendar.html. Serve it with that type so it renders as itself instead of
  ::  falling through to 415. Foreign grubs keep the inert-download headers
  ::  above: the type comes from the grub, so it is attacker-controlled too.
  =/  mime-res=(each mime tang)  (mule |.(;;(mime nn)))
  ?:  ?=(%& -.mime-res)
    ?:  (gth p.q.p.mime-res (bex 24))
      (send-err eyre-id 413 'too large')
    =/  mheads=(list [@t @t])
      ?.  local  heads
      ['content-type' (mite-type p.p.mime-res)]~
    (send-simple:srv eyre-id [[200 mheads] `q.p.mime-res])
  ::  %json: re-encode the noun so ?data yields actual JSON text
  ?:  =(%json mk)
    =/  jr=(each json tang)  (mule |.(;;(json nn)))
    ?:  ?=(%| -.jr)  (send-err eyre-id 415 'malformed json')
    (send-simple:srv eyre-id [[200 heads] `(as-octs:mimes:html (en:json:html p.jr))])
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
::  +mime-note: the "what this is" line under a rendered mime grub.
++  mime-note
  |=  [mt=path n=@ud]
  ^-  tape
  :(weld "<p class=\"muted\">" (spud mt) " &middot; " (a-co:co n) " bytes &middot; <a href=\"?data\">open raw</a></p>")
::  +mime-text: a mime grub's body as text, when the type is textual. ~ for
::  binary types, so the caller can fall back to a size line. Capped so a
::  multi-MB asset cannot double into one response through esc+weld.
++  mime-text
  |=  [mt=path oc=octs]
  ^-  (unit @t)
  ?.  ?|  ?=([%text *] mt)
          ?=([%application %json *] mt)
          ?=([%application %javascript *] mt)
          ?=([%application %'x-javascript' *] mt)
      ==
    ~
  ?:  (gth p.oc (bex 20))  ~
  `q.oc
::  +mite-type: a mime grub's own mite (/text/html) -> 'text/html'. Empty
::  mite falls back to octet-stream rather than guessing.
++  mite-type
  |=  mt=path
  ^-  @t
  ?~  mt  'application/octet-stream'
  =/  segs=(list tape)  (turn `(list @ta)`mt trip)
  (crip (zing (join "/" segs)))
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
  |=  [eyre-id=@ta sn=view:nexus]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  ?.  ?=([%file *] sn)  (send-err eyre-id 404 'not a file')
  =/  res=(each @t tang)  (mule |.(;;(@t (sang-noun:tarball sang.sn))))
  ?:  ?=(%| -.res)  (send-err eyre-id 415 'not text')
  (send-json eyre-id (pairs:enjs:format ~[['body' s+p.res] ['mark' s+name.p.sang.sn]]))
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
  '{"id":"/apps/lattice","name":"Lattice","short_name":"Lattice","description":"Programmable pages and markdown notes on Urbit.","start_url":"/apps/lattice","scope":"/apps/lattice","display":"standalone","theme_color":"#1a6ed8","background_color":"#fafafa","icons":[{"src":"/apps/lattice/icon-192.png","sizes":"192x192","type":"image/png","purpose":"any"},{"src":"/apps/lattice/icon-512.png","sizes":"512x512","type":"image/png","purpose":"any"},{"src":"/apps/lattice/icon-512.png","sizes":"512x512","type":"image/png","purpose":"maskable"},{"src":"/apps/lattice/icon.svg","sizes":"any","type":"image/svg+xml","purpose":"any"}]}'
++  icon-svg
  ^-  @t
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#1a6ed8"/><g stroke="#ffffff" stroke-width="14" stroke-linecap="round" fill="#ffffff"><line x1="140" y1="140" x2="372" y2="140"/><line x1="140" y1="256" x2="372" y2="256"/><line x1="140" y1="372" x2="372" y2="372"/><line x1="140" y1="140" x2="140" y2="372"/><line x1="256" y1="140" x2="256" y2="372"/><line x1="372" y1="140" x2="372" y2="372"/><line x1="140" y1="140" x2="372" y2="372"/><line x1="372" y1="140" x2="140" y2="372"/><circle cx="140" cy="140" r="26"/><circle cx="256" cy="140" r="26"/><circle cx="372" cy="140" r="26"/><circle cx="140" cy="256" r="26"/><circle cx="256" cy="256" r="30"/><circle cx="372" cy="256" r="26"/><circle cx="140" cy="372" r="26"/><circle cx="256" cy="372" r="26"/><circle cx="372" cy="372" r="26"/></g></svg>'
::  the service worker: stale-while-revalidate for the app SHELL (editor HTML,
::  app.js, prism, icons, manifest) — a warm boot serves every asset from the
::  SW cache at 0ms and refreshes it in the background, so it is at most one
::  load behind a deploy. The /app HTML is cached by pathname, so ?name= deep
::  links share one entry. API routes stay network-only: every one is
::  auth-gated and dynamic, and a stale authed response must never be served.
::  No precache — a logged-out install would 403 and abort.
::
++  sw-js
  ^-  @t
  'var V="lattice-v3";var SHELL=["/apps/lattice/app","/apps/lattice/app/app.js","/apps/lattice/prism.js","/apps/lattice/icon.svg","/apps/lattice/manifest.webmanifest","/apps/lattice/icon-192.png","/apps/lattice/icon-512.png"];self.addEventListener("install",function(e){self.skipWaiting()});self.addEventListener("activate",function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==V}).map(function(k){return caches.delete(k)}))}).then(function(){return self.clients.claim()}))});self.addEventListener("fetch",function(e){var q=e.request;var u=new URL(q.url);if(q.method!=="GET"||u.origin!==self.location.origin||u.pathname.indexOf("/apps/lattice")!==0){return}if(SHELL.indexOf(u.pathname)>=0){e.respondWith(caches.open(V).then(function(c){return fetch(q).then(function(r){if(r&&r.ok){c.put(u.pathname,r.clone())}return r}).catch(function(){return c.match(u.pathname).then(function(hit){return hit||new Response("offline",{status:503})})})}));return}e.respondWith(fetch(q).catch(function(){if(q.mode==="navigate"){return new Response(`<!doctype html><meta name=viewport content="width=device-width"><body style="font:16px system-ui;padding:2rem;color:#888">offline - reconnect to reach lattice</body>`,{status:503,headers:{"content-type":"text/html"}})}return new Response("offline",{status:503})}))});self.addEventListener("message",function(e){if(e.data==="skipWaiting")self.skipWaiting()});'
++  icon-192-b64
  ^-  @t
  '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'
++  icon-512-b64
  ^-  @t
  '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'
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
  '<link rel="manifest" href="/apps/lattice/manifest.webmanifest" crossorigin="use-credentials"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#1a6ed8"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1a1a1a"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="Lattice"><link rel="apple-touch-icon" href="/apps/lattice/apple-touch-icon.png"><link rel="icon" href="/apps/lattice/icon.svg" type="image/svg+xml">'
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
::  output accumulates as a list of per-line chunks zinged once at the end —
::  welding each line onto one growing tape re-copied the whole document per
::  line (quadratic in document size, the same class as the fixed wikilinkify
::  quadratic, on the unauthenticated reader path).
++  render-gmi
  |=  body=@t
  ^-  tape
  =/  lines=(list @t)  (to-wain:format body)
  =|  acc=(list tape)
  =/  pre=?  |
  =|  prebuf=(list @t)
  |-  ^-  tape
  ?~  lines
    ?:  pre
      %-  zing  %-  flop
      [:(weld "<pre>" (esc (trip (of-wain:format (flop prebuf)))) "</pre>") acc]
    (zing (flop acc))
  =/  ln=tape  (trip i.lines)
  ?:  pre
    ?.  =("```" ln)  $(lines t.lines, prebuf [i.lines prebuf])
    %=  $
      lines   t.lines
      pre     |
      prebuf  ~
      acc     [:(weld "<pre>" (esc (trip (of-wain:format (flop prebuf)))) "</pre>") acc]
    ==
  ?:  =("```" ln)  $(lines t.lines, pre &, prebuf ~)
  ?:  (has-prefix "### " ln)  $(lines t.lines, acc [:(weld "<h3>" (esc (slag 4 ln)) "</h3>") acc])
  ?:  (has-prefix "## " ln)   $(lines t.lines, acc [:(weld "<h2>" (esc (slag 3 ln)) "</h2>") acc])
  ?:  (has-prefix "# " ln)    $(lines t.lines, acc [:(weld "<h1>" (esc (slag 2 ln)) "</h1>") acc])
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
    $(lines t.lines, acc [:(weld "<p>" anchor "</p>") acc])
  ?:  (has-prefix "> " ln)
    $(lines t.lines, acc [:(weld "<blockquote>" (esc (slag 2 ln)) "</blockquote>") acc])
  ?:  =("" ln)  $(lines t.lines)
  $(lines t.lines, acc [:(weld "<p>" (esc ln) "</p>") acc])
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
  =/  dec=(unit tape)  (unesc-content mid)
  ?~  dec  ~
  `[`@tas`(crip builder) (crip u.dec)]
::  +unesc-content: decode +wrap-content's escaping directly — a linear scan
::  instead of the old ream+slap (a full hoon parse + eval per page read,
::  which every page-tree/page-dump/home request paid per page). The scheme
::  is exactly what +wrap-content emits: \\ -> backslash, \' -> quote,
::  \XX -> hex byte (controls). Anything else malformed yields ~, and the
::  caller treats the page as raw hoon — same as a failed parse did.
++  unesc-content
  |=  ec=tape
  ^-  (unit tape)
  =|  out=tape
  |-  ^-  (unit tape)
  ?~  ec  `(flop out)
  ?.  =('\\' i.ec)  $(ec t.ec, out [i.ec out])
  ?~  t.ec  ~
  ?:  =('\\' i.t.ec)  $(ec t.t.ec, out ['\\' out])
  ?:  =('\'' i.t.ec)  $(ec t.t.ec, out ['\'' out])
  ?~  t.t.ec  ~
  =/  h1=(unit @)  (de-hex i.t.ec)
  =/  h2=(unit @)  (de-hex i.t.t.ec)
  ?~  h1  ~
  ?~  h2  ~
  $(ec t.t.t.ec, out [`@tD`(add (mul 16 u.h1) u.h2) out])
++  de-hex
  |=  c=@tD
  ^-  (unit @)
  ?:  &((gte c '0') (lte c '9'))  `(sub c '0')
  ?:  &((gte c 'a') (lte c 'f'))  `(add 10 (sub c 'a'))
  ~
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
  ;<  sn=view:nexus  bind:m  (peek:io [%& %| (weld app-base:lu /page)] ~)
  ?.  ?=([%ball *] sn)  (pure:m ~)
  %-  pure:m
  %+  sort  (collect-tree ball.sn ~)
  |=([a=[pax=path page=?] b=[pax=path page=?]] (aor pax.a pax.b))
::  +read-page-names: just the page paths (folders dropped) — the home landing
::  lists what you can open. (+read-template-names was removed with the home
::  redesign, which no longer lists templates.)
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
::  +home-css: styling for the landing (nav cards + lists).
::
++  home-css
  ^-  tape
  %-  trip
  '<style>*{scrollbar-width:thin;scrollbar-color:#8887 transparent}::-webkit-scrollbar{width:11px;height:11px}::-webkit-scrollbar-thumb{background:#8886;border-radius:6px;border:3px solid transparent;background-clip:content-box}::-webkit-scrollbar-track{background:transparent}.muted{color:#8a8a8a}h1{margin:.2rem 0}.apps{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:14px;margin:1.2rem 0}.appcard{display:flex;flex-direction:column;gap:5px;padding:20px;border:1px solid #8886;border-radius:12px;text-decoration:none;color:inherit;background:#8881}.appcard:hover{border-color:#1a6ed8}.appcard .ico{font-size:1.7rem;line-height:1}.appcard strong{font-size:1.2rem}.appcard .d{color:#8a8a8a;font-size:.9rem}.quick{display:flex;flex-wrap:wrap;gap:8px;margin:.5rem 0 .3rem}.quick a{padding:6px 12px;border:1px solid #8886;border-radius:8px;text-decoration:none;color:inherit;background:#8881;font-size:.9rem}.quick a:hover{border-color:#1a6ed8}ul.pglist{list-style:none;padding:0;margin:.4rem 0}ul.pglist li{padding:11px 2px;border-bottom:1px solid #8883;display:flex;justify-content:space-between;align-items:center;gap:12px}ul.pglist a{padding:4px 2px}h2{font-size:1rem;color:#8a8a8a;margin:1.4rem 0 .2rem;text-transform:uppercase;letter-spacing:.03em}.apps{align-items:start}.col{display:flex;flex-direction:column}.qh{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:#8a8a8a;margin:1.1rem 0 .2rem;font-weight:600}ul.qlist{list-style:none;padding:0;margin:0}ul.qlist li{border-bottom:1px solid #8883}ul.qlist a{display:block;padding:9px 6px;text-decoration:none;color:inherit;border-radius:6px}ul.qlist a:hover{background:#8881}.qname{display:block;font-weight:500;color:#1a6ed8}.qprev{display:block;font-size:.84rem;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:.05rem}</style>'
::  +search-results-html: the omnibar search results page. A heading + a #results
::  div filled by client JS that fans out ONE /catalog-search call per query word
::  (obelisk has no OR/LIKE, so the client unions the per-term hits and ranks by
::  words-matched then tf), and links each hit to the reader. Built with the DOM
::  API (textContent) so catalog text is XSS-safe; single-quote cord so the JS
::  braces stay literal (no ' or \ inside). Obelisk down -> a graceful message.
::
::  +search-results-html: the omnibar results page. Fans out over BOTH indexes
::  per query word — /content-search (our pages + knowledge, scope recorded at
::  index time) and /catalog-search (the crawler's, for peers) — and labels every
::  hit with where it lives. Catalog rows published by US are dropped: they are
::  in content-terms already with a truthful clearweb/urbit badge, and keeping
::  both would double every own-page hit.
::
::  The badge is load-bearing, not decoration. These results mix content that is
::  on the open web with private notes, on a screen the owner may be sharing, so
::  each row states its exposure: clearweb (open web), urbit (other ships only),
::  private (nobody), knowledge (private note), or the peer's @p.
::
::  `our` is interpolated because the client needs it to recognise its own rows.
++  search-results-html
  |=  [q=@t our=@p]
  ^-  tape
  ;:  weld
    "<h1>Search</h1>"
    "<p class=\"muted\">Results for &ldquo;"  (esc (trip q))  "&rdquo; across your pages, notes and followed peers.</p>"
    "<div id=\"results\" class=\"muted\">Searching&hellip;</div>"
    :(weld "<script>var OUR=\"" (scow %p our) "\";</script>")
    %-  trip
    '<style>.qbadge{display:inline-block;padding:1px 7px;margin-right:.5em;border-radius:999px;border:1px solid #8886;font-size:.75rem;vertical-align:middle;white-space:nowrap}.qbadge.clearweb{border-color:#1a6ed8;color:#1a6ed8}.qbadge.urbit{border-color:#7a5af8;color:#7a5af8}.qbadge.private{border-color:#8a8a8a;color:#8a8a8a}.qbadge.knowledge{border-color:#0a9a6a;color:#0a9a6a}.qbadge.peer{border-color:#c07000;color:#c07000}</style>'
    ::  one fan-out per query word over BOTH indexes; see the arm comment. The
    ::  minified source lives in scratch as search.js — it is checked with
    ::  `node --check` before being pasted here, and contains no single quote or
    ::  backslash so it needs no cord escaping.
    %-  trip
    '<script>(function(){var p=new URLSearchParams(location.search);var q=(p.get("url")||"").trim();var out=document.getElementById("results");if(!q){out.textContent="";return}var words=q.toLowerCase().split(/[^a-z0-9]+/).filter(function(w){return w.length>=2});if(!words.length){out.textContent="Type at least one search word (2+ letters).";return}function get(u){return fetch(u).then(function(r){return r.ok?r.json():{rows:[]}}).catch(function(){return{rows:[]}})}var calls=[];words.forEach(function(w){calls.push(get("/apps/lattice/content-search?term="+encodeURIComponent(w)).then(function(j){return{kind:"own",j:j}}));calls.push(get("/apps/lattice/catalog-search?term="+encodeURIComponent(w)).then(function(j){return{kind:"cat",j:j}}));});Promise.all(calls).then(function(res){var hits={};function bump(scope,key,tf){var k=scope+"|"+key;if(!hits[k])hits[k]={scope:scope,key:key,terms:0,tf:0};hits[k].terms++;hits[k].tf+=tf;}res.forEach(function(r){var c=r.j.columns||[];var rows=r.j.rows||[];if(r.kind==="own"){var si=c.indexOf("scope"),ki=c.indexOf("key"),ti=c.indexOf("tf");rows.forEach(function(row){var s=row[si],k=row[ki];if(!s||!k)return;bump(s,k,parseInt(row[ti],10)||0);});}else{var pi=c.indexOf("publisher"),xi=c.indexOf("path"),ti2=c.indexOf("tf");rows.forEach(function(row){var pub=row[pi],path=row[xi];if(!pub||!path)return;if(pub===OUR)return;bump(pub,path,parseInt(row[ti2],10)||0);});}});var list=Object.keys(hits).map(function(k){return hits[k]});list.sort(function(a,b){return b.terms-a.terms||b.tf-a.tf});out.textContent="";out.className="";if(!list.length){out.className="muted";out.textContent="Nothing matches that.";return}var ul=document.createElement("ul");ul.className="qlist";list.slice(0,50).forEach(function(h){var peer=h.scope.charAt(0)==="~";var cls=peer?"peer":h.scope;var href;if(peer){href="/apps/lattice?url="+encodeURIComponent("urb://"+h.scope+"/"+h.key)}else if(h.scope==="knowledge"){href="/apps/lattice/app?view=know&name="+encodeURIComponent(h.key)}else if(h.scope==="private"){href="/apps/lattice/app?name="+encodeURIComponent(h.key)}else{href="/apps/lattice?url="+encodeURIComponent("urb://"+OUR+"/"+h.key)}var li=document.createElement("li");var a=document.createElement("a");a.href=href;var b=document.createElement("span");b.className="qbadge "+cls;b.textContent=peer?h.scope:h.scope;var n=document.createElement("span");n.className="qname";n.textContent=h.key;var s=document.createElement("span");s.className="qprev";s.textContent=h.terms+(h.terms>1?" terms":" term")+", tf "+h.tf;a.appendChild(b);a.appendChild(n);a.appendChild(s);li.appendChild(a);ul.appendChild(li);});out.appendChild(ul);}).catch(function(){out.className="muted";out.textContent="Search is unavailable (obelisk not responding).";});})();</script>'
  ==
::  +settings-html: the settings page. One maintenance action so far — a manual
::  content-catalog sweep. The crawler auto-sweeps every ~6h (and a followed
::  peer's edits index live), but a newly published page isn't searchable until
::  the next sweep, so this forces one now. POSTs /catalog-sweep, which acks
::  immediately and (re)indexes in the background. Single-quote cords so the css
::  and js braces stay literal (no ' or \ inside).
::
++  settings-html
  ^-  tape
  ;:  weld
    %-  trip
    '<style>.btn{padding:8px 16px;font:inherit;border:1px solid #8886;border-radius:8px;background:transparent;color:inherit;cursor:pointer}.btn:hover{border-color:#1a6ed8}.btn:disabled{opacity:.5;cursor:default}</style>'
    "<h1>Settings</h1>"
    "<h2>Content catalog</h2>"
    "<p class=\"muted\">Published pages are indexed for search automatically about every 6 hours (and a followed peer's edits index live). Sweep now to (re)index all of your published pages and followed peers immediately &mdash; e.g. after publishing something you want searchable right away.</p>"
    "<p><button type=\"button\" id=\"sweep\" class=\"btn\">Sweep catalog now</button> <span id=\"swst\" class=\"muted\"></span></p>"
    "<h2>Search index</h2>"
    "<p class=\"muted\">The omnibar searches your published pages, your private page sources and your knowledge entries, labelling each result with where it lives. That private half is rebuilt on demand rather than continuously, so reindex after a batch of edits to make them findable.</p>"
    "<p><button type=\"button\" id=\"sreidx\" class=\"btn\">Reindex my content</button> <span id=\"srst\" class=\"muted\"></span></p>"
    %-  trip
    '<script>(function(){var b=document.getElementById("sreidx");var s=document.getElementById("srst");b.onclick=function(){b.disabled=true;s.textContent="reindexing...";fetch("/apps/lattice/search-reindex",{method:"POST"}).then(function(r){s.textContent=r.ok?"done - your pages and notes are searchable.":"failed ("+r.status+")";b.disabled=false}).catch(function(){s.textContent="failed (network error)";b.disabled=false})}})();</script>'
    "<h2>Archive a web page</h2>"
    "<p class=\"muted\">Drag this to your bookmarks bar. On any web page, click it and your ship fetches that page, converts it to markdown and files it privately under <code>clips/</code> &mdash; a real lattice page you can edit, search and share.</p>"
    "<p><a id=\"clipbm\" class=\"btn\" href=\"#\">Clip to lattice</a></p>"
    %-  trip
    '<script>(function(){var b=document.getElementById("sweep");var s=document.getElementById("swst");b.onclick=function(){b.disabled=true;s.textContent="sweeping...";fetch("/apps/lattice/catalog-sweep",{method:"POST"}).then(function(r){s.textContent=r.ok?"started — pages are being (re)indexed in the background.":"failed ("+r.status+")";b.disabled=false}).catch(function(){s.textContent="failed (network error)";b.disabled=false})}})();</script>'
    ::  the bookmarklet href is built client-side because settings-html has no
    ::  idea what host the browser reached us on (ship domain, localhost, a
    ::  reverse proxy) — location.origin is the only thing that knows.
    %-  trip
    '<script>(function(){var a=document.getElementById("clipbm");a.href="javascript:(function(){location.href=\'"+location.origin+"/apps/lattice/clip?url=\'+encodeURIComponent(location.href)})()";a.onclick=function(e){e.preventDefault()}})();</script>'
  ==
::  +home-index-html: the landing page. Always shows navigation (Pages,
::  Explorer) plus a live list of your programmable pages and any published
::  pages — so an empty store is still a way in, not a dead end.
::
++  home-index-html
  |=  [our=@p recent=(list [pax=path prev=@t]) bms=bookmarks:lb know=tape]
  ^-  tape
  =/  ship=tape  (scow %p our)
  =/  tree=tape  :(weld "/apps/lattice/x/" ship "/")
  ::  under Editor: the 10 most recently edited pages — name + a preview, each
  ::  linking straight into the editor.
  =/  recent-list=tape
    ?~  recent  "<p class=\"muted\">No pages yet.</p>"
    %-  zing
    ;:  weld
      `(list tape)`~["<ul class=\"qlist\">"]
      %+  turn  recent
      |=  [pax=path prev=@t]
      =/  pt=tape  (pax-str pax)
      ;:  weld
        "<li><a href=\"/apps/lattice/app?name="  (esc pt)  "\">"
        "<span class=\"qname\">"  (esc pt)  "</span>"
        ?:  =('' prev)  ""
        :(weld "<span class=\"qprev\">" (esc (trip prev)) "</span>")
        "</a></li>"
      ==
      `(list tape)`~["</ul>"]
    ==
  ::  under Browser: the last 10 bookmarks — the title opens the saved url via the
  ::  reader (which resolves the urb:// address back to the /x view).
  =/  bm-list=tape
    ?~  bms
      "<p class=\"muted\">No bookmarks yet &mdash; open a page in the Browser and hit &#9734;.</p>"
    %-  zing
    ;:  weld
      `(list tape)`~["<ul class=\"qlist\">"]
      %+  turn  bms
      |=  b=bookmark:lb
      ;:  weld
        "<li><a href=\"/apps/lattice?url="  (esc (trip url.b))  "\">"
        "<span class=\"qname\">"  (esc (trip title.b))  "</span>"
        "</a></li>"
      ==
      `(list tape)`~["</ul>"]
    ==
  ;:  weld
    home-css
    "<h1>Lattice</h1>"
    "<p class=\"muted\">Programmable pages &amp; published notes &middot; "  ship
    " &middot; <a href=\"/apps/lattice/settings\">settings</a></p>"
    ::  two columns: each app card with its quick links below it.
    "<div class=\"apps\">"
    "<div class=\"col\">"
    "<a class=\"appcard\" href=\"/apps/lattice/app\"><span class=\"ico\">&#9998;</span><strong>Editor</strong><span class=\"d\">Create, organize, and edit your pages, notes, and files in a tree.</span></a>"
    "<h3 class=\"qh\">Recent</h3>"
    recent-list
    "</div>"
    :(weld "<div class=\"col\"><a class=\"appcard\" href=\"" tree "\"><span class=\"ico\">&#127760;</span><strong>Browser</strong><span class=\"d\">Read and explore content &mdash; your published pages and other ships via urb://.</span></a>")
    "<h3 class=\"qh\">Bookmarks</h3>"
    bm-list
    "</div>"
    "<div class=\"col\">"
    "<a class=\"appcard\" href=\"/apps/lattice/know\"><span class=\"ico\">&#128218;</span><strong>Knowledge</strong><span class=\"d\">The private memory store &mdash; tagged notes your assistant recalls and saves.</span></a>"
    "<h3 class=\"qh\">Recent memories</h3>"
    know
    "</div>"
    "</div>"
  ==
::  +web-css: minimal reader styling (single-quoted cord so braces are literal).
::
++  web-css
  ^-  tape
  %+  weld  know-css
  %-  trip
  '*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:#8887 transparent}::-webkit-scrollbar{width:11px;height:11px}::-webkit-scrollbar-thumb{background:#8886;border-radius:6px;border:3px solid transparent;background-clip:content-box}::-webkit-scrollbar-thumb:hover{background:#888a;background-clip:content-box}::-webkit-scrollbar-track{background:transparent}html{background:#fafafa}body{margin:0;font:16px/1.6 system-ui,sans-serif;color:#111;background:#fafafa}@media(prefers-color-scheme:dark){html{background:#1a1a1a}body{color:#e6e6e6;background:#1a1a1a}}.bar{display:flex;gap:6px;padding:8px;border-bottom:1px solid #8884}.bar a.home{display:flex;align-items:center;padding:0 12px;font-size:1.2rem;border:1px solid #8886;border-radius:6px;text-decoration:none;color:inherit}.bar a.home:hover{border-color:#1a6ed8}.bar a.nav{display:flex;align-items:center;padding:0 11px;font-size:1.05rem;border:1px solid #8886;border-radius:6px;text-decoration:none;color:inherit;white-space:nowrap}.bar a.nav:hover{border-color:#1a6ed8}.rawf{width:100%;height:70vh;border:1px solid #8886;border-radius:6px;background:#fff}.muted{color:#8a8a8a;font-size:.9em}.bar input{flex:1;padding:6px 8px;font:inherit;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit}.bar button{padding:0 14px;font:inherit;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.bar button:hover{border-color:#1a6ed8}main{max-width:46rem;margin:0 auto;padding:16px;overflow-wrap:anywhere}a{color:#1a6ed8}.err{color:#c0392b}blockquote{margin:.6rem 0;padding-left:1rem;border-left:3px solid #8886;color:#8a8a8a}pre{background:#8881;padding:10px;overflow-x:auto;border-radius:6px;white-space:pre}code{background:#8881;padding:.1em .3em;border-radius:4px;font-size:.9em}pre code{background:0;padding:0}table{border-collapse:collapse;margin:.7rem 0;display:block;overflow-x:auto;max-width:100%}th,td{border:1px solid #8887;padding:6px 11px}th{background:#8881;font-weight:600;text-align:left}img{max-width:100%;height:auto}del{opacity:.7}ul,ol{padding-left:1.5rem}li{margin:.15rem 0}sup.fnref{font-size:.72em}sup.fnref a{text-decoration:none}hr.fn-sep{margin-top:2rem}.footnotes{font-size:.88em;color:#8a8a8a}.footnotes li{margin:.25rem 0}.bar{padding-left:max(8px,env(safe-area-inset-left));padding-right:max(8px,env(safe-area-inset-right))}main{padding-left:max(16px,env(safe-area-inset-left));padding-right:max(16px,env(safe-area-inset-right))}@media(max-width:520px){.bar{flex-wrap:wrap}.bar input{flex:1 1 100%;order:3}main{padding-top:12px;padding-bottom:12px}}'
::  +know-css: styles for the knowledge view (single-quote cord: braces literal).
::
++  know-css
  ^-  tape
  %-  trip
  '.muted{color:#8a8a8a}.quick{display:flex;flex-wrap:wrap;gap:8px;margin:.5rem 0 .3rem}.quick a{padding:6px 12px;border:1px solid #8886;border-radius:8px;text-decoration:none;color:inherit;background:#8881;font-size:.9rem}.quick a:hover{border-color:#1a6ed8}.quick a.on{border-color:#1a6ed8;color:#1a6ed8}ul.qlist{list-style:none;padding:0;margin:.4rem 0}ul.qlist li{border-bottom:1px solid #8883;margin:0}ul.qlist a{display:block;padding:9px 6px;text-decoration:none;color:inherit;border-radius:6px}ul.qlist a:hover{background:#8881}.qname{display:block;font-weight:500;color:#1a6ed8}.qprev{display:block;font-size:.84rem;color:#8a8a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:.05rem}.know-body{white-space:pre-wrap}'
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
    ::  an authored /index takes over the home view, and the generated home was
    ::  the ONLY way to the editor, browser and knowledge — so carry them here.
    "<a class=\"nav\" href=\"/apps/lattice/app\" title=\"editor\">&#9998;</a>"
    "<a class=\"nav\" href=\"/apps/lattice/know\" title=\"knowledge\">&#9670;</a>"
    ::  settings lives here and NOT only on the home index: an authored /index
    ::  replaces that whole view, which is exactly what orphaned the settings
    ::  page (and the editor link before it). The bar survives an authored home,
    ::  so anything that must stay reachable belongs in it.
    "<a class=\"nav\" href=\"/apps/lattice/settings\" title=\"settings\">&#9881;</a>"
    "<input name=\"url\" value=\""  (esc current)  "\" autocomplete=\"off\" placeholder=\"urb:// address or search the catalog\">"
    "<button type=\"submit\">Go</button></form><main>"  inner  "</main>"
    (sse-script keep)  sw-register-script  "</body></html>"
  ==
::  +render-browser-page: the browser's page view — the address bar (+ an Edit
::  button when `edit` names an editable own page) above the page rendered in a
::  viewport-filling iframe, so the page's theme owns its whole document (no
::  collision with the chrome css) and looks as it would on the clear web.
::  `sandbox` locks the frame (no scripts/same-origin) for untrusted peer content;
::  `keep` is the data-grub SSE url ("" = none) so an owner edit live-reloads the
::  view. The clearweb-parity replacement for the old dev page-view chrome.
::
++  render-browser-page
  |=  [current=tape doc=@t edit=(unit @t) sandbox=? keep=tape]
  ^-  @t
  =/  editbtn=tape
    ?~  edit  ""
    :(weld "<a class=\"eb\" href=\"/apps/lattice/app?name=" (trip u.edit) "\">&#9998; edit</a>")
  %-  crip
  ;:  weld
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
    pwa-head
    "<title>lattice</title><style>"  web-css
    (trip 'html,body{height:100%}body.bp{display:flex;flex-direction:column;margin:0}.bp main{max-width:none;margin:0;padding:0;flex:1;display:flex}.bp .pf{flex:1;width:100%;border:0}.bar .eb,.bar .bm{display:flex;align-items:center;gap:.3em;padding:0 12px;border:1px solid #8886;border-radius:6px;text-decoration:none;color:inherit;white-space:nowrap;background:transparent;cursor:pointer;font-size:1rem}.bar .eb:hover,.bar .bm:hover{border-color:#1a6ed8}')
    "</style></head><body class=\"bp\">"
    "<form class=\"bar\" action=\"/apps/lattice\" method=\"get\">"
    "<a class=\"home\" href=\"/apps/lattice\" title=\"lattice home\">&#8962;</a>"
    "<input name=\"url\" value=\""  (esc current)  "\" autocomplete=\"off\" placeholder=\"urb:// address or search the catalog\">"
    editbtn
    "<button type=\"button\" class=\"bm\" title=\"Bookmark this page\">&#9734;</button>"
    "<button type=\"submit\">Go</button></form>"
    "<main><iframe class=\"pf\""  ?:(sandbox " sandbox=\"\"" "")
    " srcdoc=\""  (esc (trip doc))  "\"></iframe></main>"
    ::  bookmark button: POST the address-bar url to /bookmark (owner-gated, same
    ::  origin). single-quote cord so the js braces stay literal.
    %-  trip
    '<script>(function(){var b=document.querySelector(".bm");if(!b)return;b.onclick=function(){var u=document.querySelector(".bar input").value;if(!u)return;fetch("/apps/lattice/bookmark?url="+encodeURIComponent(u)+"&title="+encodeURIComponent(u),{method:"POST"}).then(function(r){if(r.ok){b.innerHTML="&#9733;";b.title="Bookmarked"}})}})();</script>'
    (page-sse-script keep)  sw-register-script  "</body></html>"
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
    '";async function c(){try{var r=await fetch(K,{headers:{Accept:"text/event-stream"}});var R=r.body.getReader();var d=new TextDecoder();var b="";while(true){var x=await R.read();if(x.done)break;b+=d.decode(x.value,{stream:true});var ps=b.split("\\n\\n");b=ps.pop();for(var i=0;i<ps.length;i++){if(!ps[i].trim())continue;var ev="";var ls=ps[i].split("\\n");for(var j=0;j<ls.length;j++){if(ls[j].indexOf("event: ")===0)ev=ls[j].slice(7)}if(!ev)continue;if(ev.slice(0,3)==="old")continue;location.reload();return}}}catch(x){}setTimeout(c,3000)}c()})();</script>'
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
  =/  gdir=road:tarball  [%& %| public-grp]
  ;<  ok=?  bind:m  (peek-exists:io gdir)
  ?.  ok  ~&([%lattice-no-public-group ~] (pure:m ~))
  =/  wroad=road:tarball  [%& %& [public-grp %'how.weir']]
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
  ;<  seen=view:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%file *] seen)  (pure:m *weir:nexus)
  (pure:m !<(weir:nexus (need-vase:tarball sang.seen)))
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
    ::  memories are gained too, and autosave saves one revision per typing
    ::  pause — the same ceiling pages get, or the vault grows forever.
    ::  know entries are a user-facing history surface too, so same window
    ;<  ~  bind:m  (prune-hist road know-keep history-window)
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
  ;<  seen=view:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%file *] seen)  (pure:m *pub-index:lp)
  (pure:m !<(pub-index:lp (need-vase:tarball sang.seen)))
::  +read-pub-index-remote: a peer's /pub/index via peek-remote (clean break —
::  the peer must run the grubbery-native lattice at the same app-base).
::
++  read-pub-index-remote
  |=  shp=@p
  =/  m  (fiber:fiber:nexus ,(unit pub-index:lp))
  ^-  form:m
  ;<  ms=(unit view:nexus)  bind:m
    (peek-remote-wait [%& %& (weld app-base:lu /pub) %index] shp)
  ::  ~ means the read FAILED (timeout / not-a-file / bad clam) — distinct from a
  ::  reachable peer with a genuinely empty index (`~ *pub-index). Callers use the
  ::  difference: reconcile must NOT run on a failure (it would delete every row).
  ?~  ms  (pure:m ~)
  ?.  ?=([%file *] u.ms)  (pure:m ~)
  ::  CROSS-SHIP peek content is a boom (raw noun), not a vase — need-vase would
  ::  crash the crawler. Extract via sang-noun and clam in a mule so a malformed
  ::  or hostile peer index yields ~ (treated as unreachable) instead of crashing.
  =/  res=(each pub-index:lp tang)
    (mule |.(;;(pub-index:lp (sang-noun:tarball sang.u.ms))))
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
  ;<  ix=pub-index:lp  bind:m  (read-pub-index [%& %& (weld app-base:lu /pub) %index])
  (pure:m `ix)
::  +read-follows: the crawler's follow set. ABSOLUTE road (app-base) so it reads
::  the same from the depth-2 request fiber and the depth-0 crawler fiber.
::
++  read-follows
  =/  m  (fiber:fiber:nexus ,follows:lp)
  ^-  form:m
  ;<  seen=view:nexus  bind:m  (peek:io [%& %& (weld app-base:lu /sub) %follows] ~)
  ?.  ?=([%file *] seen)  (pure:m *follows:lp)
  (pure:m !<(follows:lp (need-vase:tarball sang.seen)))
::  +read-subs: every live per-file subscription. Peeks /sub/pages as a ball and
::  reads each page-sub grub out of the dir node's contents (booms skipped).
::
++  read-subs
  =/  m  (fiber:fiber:nexus ,(list page-sub:lp))
  ^-  form:m
  ;<  seen=view:nexus  bind:m  (peek:io [%& %| (weld app-base:lu /sub/pages)] ~)
  ?.  ?=([%ball *] seen)  (pure:m ~)
  =/  b=ball:tarball  ball.seen
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
  ;<  seen=view:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%file *] seen)  (pure:m ~)
  (pure:m `!<(know-entry:lk (need-vase:tarball sang.seen)))
::  +read-index: peek an index grub. Empty if absent.
::
++  read-index
  |=  road=road:tarball
  =/  m  (fiber:fiber:nexus ,know-index:lk)
  ^-  form:m
  ;<  seen=view:nexus  bind:m  (peek:io road ~)
  ?.  ?=([%file *] seen)  (pure:m *know-index:lk)
  (pure:m !<(know-index:lk (need-vase:tarball sang.seen)))
::  +put-file: create-or-overwrite a grub (over = %make force=%.y).
::
::  +put-file: one dart, no probe — %over's %make-with-force creates when the
::  rail is missing and overwrites when it exists (grubbery skips its exists
::  check entirely under force), so the old peek-exists round-trip before
::  every single write was pure waste on the hottest path in the app.
++  put-file
  |=  [road=road:tarball =blot:tarball noun=*]
  =/  m  (fiber:fiber:nexus ,~)
  ^-  form:m
  (over:io road [blot noun])
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
